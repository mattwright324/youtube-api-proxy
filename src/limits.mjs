import net from 'node:net';
import {createLogger} from './log.mjs';

const MINUTE_MS = 60 * 1000;

// Scopes that can have limits, and every scope usage is tracked for
export const SCOPES = ['ip', 'block', 'global'];
export const TRACKED_SCOPES = ['ip', 'block', 'asn', 'global'];
export const METRICS = ['requests', 'units', 'search'];
export const WINDOWS = ['minute', 'day'];

// Starting points only: tune them using the "DEBUG Limit Stats" log lines
export const DEFAULT_LIMITS = {
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

// ---------------------------------------------------------------------------
// IP grouping
// ---------------------------------------------------------------------------

/** Strips the ::ffff: prefix Node uses for IPv4 clients on a dual-stack socket. */
export function normalizeIp(rawIp) {
    const ip = rawIp || 'unknown';
    return ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
}

/**
 * Groups a client IP into the keys the limiter uses: ip = the address, block = its /24.
 * asn (optional) is the network id from an ASN lookup, tracked for reporting only.
 */
export function subjectFor(rawIp, asn = null) {
    const ip = normalizeIp(rawIp);
    const block = net.isIPv4(ip) ? ip.split('.').slice(0, 3).join('.') + '.0/24' : ip;
    return {ip, block, asn};
}

// ---------------------------------------------------------------------------
// Limiter
// ---------------------------------------------------------------------------

const pacificDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'America/Los_Angeles'});
let dayCache = {second: -1, key: ''};

/** The current Pacific date (YYYY-MM-DD), which is when daily limits reset. */
export function pacificDay(now = Date.now()) {
    return dayKey(now);
}

function dayKey(now) {
    const second = Math.floor(now / 1000);
    if (second !== dayCache.second) {
        dayCache = {second, key: pacificDate.format(now)};
    }
    return dayCache.key;
}

function topN(list, n) {
    return list
        .sort((a, b) => b.dayCount - a.dayCount)
        .slice(0, n)
        .map(entry => [entry.id, entry.dayCount]);
}

/**
 * onLimit (optional) receives {scope, id, metric, window, used, limit, dryRun} the first time a key
 * goes over a limit in each window, alongside the log line.
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
        const day = dayKey(now);
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
                day: dayKey(now), dayCount: 0,
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
        log.warn('limit exceeded', {
            scope: entry.scope, id: entry.id, metric: entry.metric, window, used: Math.round(used), limit,
            dryRun: dryRun || undefined,
        });
        onLimit?.({
            scope: entry.scope,
            id: entry.id,
            metric: entry.metric,
            window,
            used: Math.round(used),
            limit,
            dryRun
        });
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

    /**
     * Daily counts that changed since the last call, as {day, scope, id, metric, count} rows (count is the day's total).
     * Used to save state; see persistence.mjs.
     */
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
        const today = dayKey(now);
        let restored = 0;
        for (const row of rows) {
            if (row.day !== today) continue;
            const entry = getEntry(row.scope, row.id, row.metric, now);
            entry.dayCount = Math.max(entry.dayCount, Number(row.count));
            restored++;
        }
        return restored;
    }

    /**
     * Records usage if it fits within every scope's limits. Returns true when the request should be rejected.
     * Rejected requests still count against the caller's own IP request counter so hammering keeps it blocked,
     * but they don't use up the shared block/global budgets.
     */
    function consume(subject, metric, amount = 1, now = Date.now()) {
        const violation = findViolation(subject, metric, amount, now);
        if (violation && !dryRun) {
            if (metric === 'requests') {
                add(getEntry('ip', subject.ip, metric, now), amount);
            }
            return true;
        }
        for (const scope of TRACKED_SCOPES) {
            const id = idFor(subject, scope);
            if (id != null) {
                add(getEntry(scope, id, metric, now), amount);
            }
        }
        return false;
    }

    /**
     * Counts usage for reporting only (e.g. 'served', 'blocked'), with no limit checks, in every tracked scope.
     */
    function record(subject, metric, amount = 1, now = Date.now()) {
        for (const scope of TRACKED_SCOPES) {
            const id = idFor(subject, scope);
            if (id != null) {
                add(getEntry(scope, id, metric, now), amount);
            }
        }
    }

    /** {minute, day} usage for one key, or zeros when it has none. */
    function usage(scope, id, metric, now = Date.now()) {
        const entry = entries.get(`${scope}|${id}|${metric}`);
        if (!entry) return {minute: 0, day: 0};
        roll(entry, now);
        return {minute: Math.round(minuteUsage(entry, now)), day: entry.dayCount};
    }

    /**
     * Drops idle entries and summarizes today's usage: global totals plus the top consumers per scope.
     * Compact form: [id, today]. Detailed form: {id, minute, day} rows, the top n by today plus the top n
     * by the last minute, so a new burst shows up even before its daily total is high.
     */
    /** Drops entries with no usage in the current or previous minute and none today. Call periodically. */
    function prune(now = Date.now()) {
        for (const [key, entry] of entries) {
            roll(entry, now);
            if (entry.currMinute === 0 && entry.prevMinute === 0 && entry.dayCount === 0) {
                entries.delete(key);
            }
        }
    }

    function snapshot(now = Date.now(), n = 5, detailed = false) {
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
        for (const scope of Object.keys(lists)) {
            top[scope] = {};
            for (const [metric, list] of Object.entries(lists[scope])) {
                if (!detailed) {
                    top[scope][metric] = topN(list, n);
                    continue;
                }
                const rows = list.map(entry => ({
                    id: entry.id,
                    minute: Math.round(minuteUsage(entry, now)),
                    day: entry.dayCount
                }));
                const byDay = [...rows].sort((a, b) => b.day - a.day).slice(0, n);
                const byMinute = rows.sort((a, b) => b.minute - a.minute).slice(0, n);
                top[scope][metric] = [...new Set([...byDay, ...byMinute])];
            }
        }
        return {dryRun, day: dayKey(now), tracked: entries.size, global, top};
    }

    return {consume, record, usage, snapshot, prune, exportChanges, importCounts};
}

// ---------------------------------------------------------------------------
// Distinct value ratio
// ---------------------------------------------------------------------------

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
 * Tracks how many distinct values of one request parameter each IP and IP block sends per day.
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

    /**
     * Records one request and its parameter value ('' when missing). Returns true when the request should be rejected.
     */
    function observe(subject, value, now = Date.now()) {
        const day = dayKey(now);
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
                log.warn('limit exceeded', {
                    scope, id: entry.id, metric: 'distinct', window: 'day', used: `${distinct}/${entry.requests}`,
                    limit: maxRatio, dryRun: dryRun || undefined,
                });
                onLimit?.({
                    scope, id: entry.id, metric: 'distinct', window: 'day',
                    used: `${distinct}/${entry.requests}`, limit: maxRatio, dryRun
                });
                reject = true;
            }
        }
        return reject && !dryRun;
    }

    /**
     * Drops entries from previous days and lists the scopes with the highest distinct counts today.
     * Compact form: [id, distinct, requests, 'limited'?]. Detailed form: {id, distinct, requests, limited} rows.
     */
    /** Drops entries from previous days. Call periodically. */
    function prune(now = Date.now()) {
        const day = dayKey(now);
        for (const [key, entry] of entries) {
            if (entry.day !== day) entries.delete(key);
        }
    }

    function snapshot(now = Date.now(), n = 5, detailed = false) {
        prune(now);
        const lists = {ip: [], block: []};
        for (const entry of entries.values()) {
            const distinct = entry.values ? entry.values.size : entry.distinct;
            lists[entry.scope].push({id: entry.id, distinct, requests: entry.requests, limited: entry.limited});
        }
        const top = {};
        for (const [scope, list] of Object.entries(lists)) {
            const sorted = list.sort((a, b) => b.distinct - a.distinct).slice(0, n);
            top[scope] = detailed
                ? sorted
                : sorted.map(x => [x.id, x.distinct, x.requests, ...(x.limited ? ['limited'] : [])]);
        }
        return top;
    }

    /** Entries that changed since the last call, as {day, scope, id, requests, distinct, limited} rows. */
    function exportChanges(now = Date.now()) {
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
        const today = dayKey(now);
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
