import net from 'node:net';
import {createLogger} from './log.mjs';

const MINUTE_MS = 60 * 1000;

// Limits can be set for SCOPES; usage is tracked (for reporting) for all of TRACKED_SCOPES
const SCOPES = ['ip', 'block', 'global'];
const TRACKED_SCOPES = ['ip', 'block', 'asn', 'global'];
const METRICS = ['requests', 'units', 'search'];
const WINDOWS = ['minute', 'day'];

const DEFAULT_LIMITS = {
    ip: {
        requests: {minute: 152},
        units: {day: 20000},
        search: {minute: 20, day: 500},
    },
    block: {
        requests: {minute: 600},
        units: {day: 60000},
        search: {minute: 50, day: 1500},
    },
    global: {
        units: {minute: 9500, day: 950000},
        search: {minute: 190, day: 18000},
    },
};

/**
 * Reads LIMIT_<SCOPE>_<METRIC>_<WINDOW> variables (e.g. LIMIT_IP_UNITS_DAY) over DEFAULT_LIMITS.
 * Empty or unset uses the default, 0 disables that limit.
 */
export function limitsFromEnv(env) {
    const limits = {};
    for (const scope of SCOPES) {
        for (const metric of METRICS) {
            for (const window of WINDOWS) {
                const name = `LIMIT_${scope}_${metric}_${window}`.toUpperCase();
                let value = DEFAULT_LIMITS[scope]?.[metric]?.[window];
                if (env[name] !== undefined && env[name] !== '') {
                    value = Number(env[name]);
                    if (!Number.isFinite(value) || value < 0) {
                        throw new Error(`Invalid env variable ${name}=${env[name]}, expected a number >= 0`);
                    }
                }
                if (value > 0) {
                    ((limits[scope] ??= {})[metric] ??= {})[window] = value;
                }
            }
        }
    }
    return limits;
}

/** Strips the ::ffff: prefix Node uses for IPv4 clients on a dual-stack socket. */
export function normalizeIp(rawIp) {
    const ip = rawIp || 'unknown';
    return ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
}

/** The keys usage is tracked by: the IP, its /24 block, and (optionally) its network id from an ASN lookup. */
export function subjectFor(rawIp, asn = null) {
    const ip = normalizeIp(rawIp);
    const block = net.isIPv4(ip) ? ip.split('.').slice(0, 3).join('.') + '.0/24' : ip;
    return {ip, block, asn};
}

const pacificDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'America/Los_Angeles'});
let dayCache = {second: -1, day: ''};

/** The Pacific date (YYYY-MM-DD) daily limits belong to; they reset at midnight Pacific like YouTube's quota. */
export function pacificDay(now = Date.now()) {
    const second = Math.floor(now / 1000);
    if (second !== dayCache.second) {
        dayCache = {second, day: pacificDate.format(now)};
    }
    return dayCache.day;
}

/**
 * Usage per scope and metric, in a sliding one-minute window and a daily window.
 * onLimit (optional) receives {scope, id, metric, window, used, limit, dryRun} the first time a key goes over a
 * limit in each window.
 */
export function createLimiter({limits, dryRun = false, log = createLogger(), onLimit}) {
    // `${scope}|${id}|${metric}` -> usage entry
    const entries = new Map();
    // Daily counts that changed but were reset by the day rolling over before being exported
    let pendingRollover = [];

    // null when the subject has no id for a scope (e.g. no ASN data), so that scope is skipped
    function idFor(subject, scope) {
        return scope === 'global' ? '*' : subject[scope] ?? null;
    }

    function roll(entry, now) {
        const minuteStart = now - now % MINUTE_MS;
        if (minuteStart !== entry.minuteStart) {
            entry.prevMinute = minuteStart - entry.minuteStart === MINUTE_MS ? entry.currMinute : 0;
            entry.currMinute = 0;
            entry.minuteStart = minuteStart;
        }
        const day = pacificDay(now);
        if (day !== entry.day) {
            if (entry.dirty) {
                pendingRollover.push({day: entry.day, scope: entry.scope, id: entry.id, metric: entry.metric, count: entry.dayCount});
                entry.dirty = false;
            }
            entry.day = day;
            entry.dayCount = 0;
        }
    }

    function getEntry(scope, id, metric, now) {
        const key = `${scope}|${id}|${metric}`;
        let entry = entries.get(key);
        if (!entry) {
            entry = {
                scope, id, metric,
                minuteStart: now - now % MINUTE_MS, currMinute: 0, prevMinute: 0,
                day: pacificDay(now), dayCount: 0,
                warnedMinute: -1, warnedDay: '',
            };
            entries.set(key, entry);
        }
        roll(entry, now);
        return entry;
    }

    // Sliding window estimate: previous minute weighted by how much of it still overlaps the last 60s
    function minuteUsage(entry, now) {
        const overlap = 1 - (now - entry.minuteStart) / MINUTE_MS;
        return entry.prevMinute * overlap + entry.currMinute;
    }

    function warnOnce(entry, window, used, limit) {
        if (window === 'minute') {
            if (entry.warnedMinute === entry.minuteStart) return;
            entry.warnedMinute = entry.minuteStart;
        } else {
            if (entry.warnedDay === entry.day) return;
            entry.warnedDay = entry.day;
        }
        const event = {scope: entry.scope, id: entry.id, metric: entry.metric, window, used: Math.round(used), limit, dryRun};
        log.warn('limit exceeded', {...event, dryRun: dryRun || undefined});
        onLimit?.(event);
    }

    function findViolation(subject, metric, amount, now) {
        for (const scope of SCOPES) {
            const limit = limits[scope]?.[metric];
            if (!limit) continue;

            const entry = getEntry(scope, idFor(subject, scope), metric, now);
            const used = {minute: minuteUsage(entry, now), day: entry.dayCount};
            for (const window of WINDOWS) {
                if (limit[window] && used[window] + amount > limit[window]) {
                    warnOnce(entry, window, used[window], limit[window]);
                    return {scope, window};
                }
            }
        }
        return null;
    }

    function add(entry, amount) {
        entry.currMinute += amount;
        entry.dayCount += amount;
        entry.dirty = true;
    }

    function addToAllScopes(subject, metric, amount, now) {
        for (const scope of TRACKED_SCOPES) {
            const id = idFor(subject, scope);
            if (id != null) add(getEntry(scope, id, metric, now), amount);
        }
    }

    /**
     * Records usage if it fits within every scope's limits. Returns true when the request should be rejected.
     * Rejected requests still count against the caller's own IP request counter so hammering keeps it limited,
     * but they don't use up the shared block/global budgets.
     */
    function consume(subject, metric, amount = 1, now = Date.now()) {
        if (findViolation(subject, metric, amount, now) && !dryRun) {
            if (metric === 'requests') add(getEntry('ip', subject.ip, metric, now), amount);
            return true;
        }
        addToAllScopes(subject, metric, amount, now);
        return false;
    }

    /** Counts usage for reporting only (e.g. 'served', 'blocked'), with no limit checks. */
    function record(subject, metric, amount = 1, now = Date.now()) {
        addToAllScopes(subject, metric, amount, now);
    }

    /** {minute, day} usage for one key, or zeros when it has none. */
    function usage(scope, id, metric, now = Date.now()) {
        const entry = entries.get(`${scope}|${id}|${metric}`);
        if (!entry) return {minute: 0, day: 0};
        roll(entry, now);
        return {minute: Math.round(minuteUsage(entry, now)), day: entry.dayCount};
    }

    /** Drops entries with no usage in the current or previous minute and none today. Call periodically. */
    function prune(now = Date.now()) {
        for (const [key, entry] of entries) {
            roll(entry, now);
            if (entry.currMinute === 0 && entry.prevMinute === 0 && entry.dayCount === 0) {
                entries.delete(key);
            }
        }
    }

    /**
     * Today's global totals plus the top consumers per scope and metric as {id, minute, day} rows: the top n by today
     * plus the top n by the last minute, so a new burst shows up even before its daily total is high.
     */
    function snapshot(now = Date.now(), n = 100) {
        prune(now);
        const global = {};
        const lists = {ip: {}, block: {}, asn: {}};
        for (const entry of entries.values()) {
            if (entry.scope === 'global') {
                global[entry.metric] = {minute: Math.round(minuteUsage(entry, now)), day: entry.dayCount};
            } else {
                (lists[entry.scope][entry.metric] ??= []).push(entry);
            }
        }

        const top = {};
        for (const [scope, metrics] of Object.entries(lists)) {
            top[scope] = {};
            for (const [metric, list] of Object.entries(metrics)) {
                const rows = list.map(entry => ({id: entry.id, minute: Math.round(minuteUsage(entry, now)), day: entry.dayCount}));
                const byDay = [...rows].sort((a, b) => b.day - a.day).slice(0, n);
                const byMinute = rows.sort((a, b) => b.minute - a.minute).slice(0, n);
                top[scope][metric] = [...new Set([...byDay, ...byMinute])];
            }
        }
        return {day: pacificDay(now), tracked: entries.size, global, top};
    }

    /** Daily counts that changed since the last call, as {day, scope, id, metric, count} rows, for saving. */
    function exportChanges(now = Date.now()) {
        const rows = pendingRollover;
        pendingRollover = [];
        for (const entry of entries.values()) {
            roll(entry, now);
            if (entry.dirty) {
                rows.push({day: entry.day, scope: entry.scope, id: entry.id, metric: entry.metric, count: entry.dayCount});
                entry.dirty = false;
            }
        }
        return rows;
    }

    /** Restores today's daily counts from saved {day, scope, id, metric, count} rows. Other days are ignored. */
    function importCounts(rows, now = Date.now()) {
        const today = pacificDay(now);
        let restored = 0;
        for (const row of rows) {
            if (row.day !== today) continue;
            const entry = getEntry(row.scope, row.id, row.metric, now);
            entry.dayCount = Math.max(entry.dayCount, Number(row.count));
            restored++;
        }
        return restored;
    }

    return {consume, record, usage, snapshot, prune, exportChanges, importCounts};
}

// 32-bit FNV-1a, so only small numbers are stored per value instead of the strings themselves
function hash(value) {
    let h = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        h ^= value.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/**
 * Tracks how many distinct values of one request parameter each IP and /24 block sends per day.
 * A missing or blank parameter counts as one more value. Once a scope has sent at least minRequests requests
 * and the ratio of distinct values to requests reaches maxRatio, every request from that scope is limited
 * for the rest of the day.
 */
export function createDistinctTracker({minRequests, maxRatio, dryRun = false, log = createLogger(), onLimit}) {
    // `${scope}|${id}` -> {scope, id, day, requests, values: Set|null, limited, distinct?, dirty?}
    const entries = new Map();
    let pendingRollover = [];

    const exportRow = entry => ({
        day: entry.day, scope: entry.scope, id: entry.id, requests: entry.requests,
        distinct: entry.values ? entry.values.size : entry.distinct || 0, limited: entry.limited,
    });

    function getEntry(scope, id, day) {
        const key = `${scope}|${id}`;
        let entry = entries.get(key);
        if (!entry || entry.day !== day) {
            if (entry?.dirty) pendingRollover.push(exportRow(entry));
            entry = {scope, id, day, requests: 0, values: new Set(), limited: false};
            entries.set(key, entry);
        }
        return entry;
    }

    /** Records one request and its parameter value ('' when missing). Returns true when the request should be rejected. */
    function observe(subject, value, now = Date.now()) {
        const day = pacificDay(now);
        let reject = false;
        for (const scope of ['ip', 'block']) {
            const entry = getEntry(scope, subject[scope], day);
            if (entry.limited) {
                reject = true;
                continue;
            }
            entry.requests += 1;
            entry.values.add(hash(value));
            entry.dirty = true;
            const distinct = entry.values.size;
            if (entry.requests >= minRequests && distinct / entry.requests >= maxRatio) {
                entry.limited = true;
                entry.values = null;
                entry.distinct = distinct;
                const event = {scope, id: entry.id, metric: 'distinct', window: 'day', used: `${distinct}/${entry.requests}`, limit: maxRatio, dryRun};
                log.warn('limit exceeded', {...event, dryRun: dryRun || undefined});
                onLimit?.(event);
                reject = true;
            }
        }
        return reject && !dryRun;
    }

    /** Drops entries from previous days. Call periodically. */
    function prune(now = Date.now()) {
        const day = pacificDay(now);
        for (const [key, entry] of entries) {
            if (entry.day !== day) entries.delete(key);
        }
    }

    /** The scopes with the most distinct values today, as {id, distinct, requests, limited} rows. */
    function snapshot(now = Date.now(), n = 100) {
        prune(now);
        const lists = {ip: [], block: []};
        for (const entry of entries.values()) {
            const distinct = entry.values ? entry.values.size : entry.distinct;
            lists[entry.scope].push({id: entry.id, distinct, requests: entry.requests, limited: entry.limited});
        }
        return Object.fromEntries(Object.entries(lists).map(([scope, list]) =>
            [scope, list.sort((a, b) => b.distinct - a.distinct).slice(0, n)]));
    }

    /** Entries that changed since the last call, as {day, scope, id, requests, distinct, limited} rows. */
    function exportChanges() {
        const rows = pendingRollover;
        pendingRollover = [];
        for (const entry of entries.values()) {
            if (entry.dirty) {
                rows.push(exportRow(entry));
                entry.dirty = false;
            }
        }
        return rows;
    }

    /**
     * Restores today's limited scopes from saved rows, so a restart doesn't lift them. The seen values aren't saved,
     * so scopes that weren't limited start counting again.
     */
    function importLimited(rows, now = Date.now()) {
        const today = pacificDay(now);
        let restored = 0;
        for (const row of rows) {
            if (row.day !== today || !row.limited) continue;
            entries.set(`${row.scope}|${row.id}`, {
                scope: row.scope, id: row.id, day: today, requests: Number(row.requests), values: null,
                distinct: Number(row.distinct), limited: true,
            });
            restored++;
        }
        return restored;
    }

    return {observe, snapshot, prune, exportChanges, importLimited};
}
