import {pacificDay} from './limits.mjs';

const MINUTE_MS = 60 * 1000;

// requests = served + blocked
export const HISTORY_FIELDS = ['requests', 'served', 'blocked', 'scripted', 'cacheHits', 'upstream', 'units', 'search', 'errors'];

const MAX_USER_AGENTS = 500;
const MAX_USER_AGENT_LENGTH = 200;
const OTHER_USER_AGENTS = '(other user agents)';
const ENDPOINT_FIELDS = ['upstream', 'cached', 'errors', 'units', 'search', 'unitsSaved', 'searchSaved'];

function emptyBucket(t) {
    const bucket = {t};
    for (const field of HISTORY_FIELDS) bucket[field] = 0;
    return bucket;
}

function pushCapped(list, item, max) {
    list.push(item);
    if (list.length > max) list.shift();
}

function percentile(sorted, p) {
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

const increment = (map, key, amount = 1) => map.set(key, (map.get(key) || 0) + amount);

/** Totals for one Pacific day: reset at midnight like the daily limits. */
function emptyDaily(day) {
    return {
        day,
        requestCount: 0,
        blockedReasons: new Map(),  // limit that blocked the request -> count
        signalCounts: new Map(),    // script signal -> count
        userAgents: new Map(),      // user agent -> {requests, scripted}
        endpoints: new Map(),       // endpoint -> {upstream, cached, errors, units, search, unitsSaved, searchSaved}
        errorCounts: new Map(),     // `${status}|${reason}` -> count
        dirty: false,
    };
}

/** Flattens a day's totals into {day, kind, key, value} rows for saving. */
function dailyRows(daily) {
    const rows = [{day: daily.day, kind: 'requests', key: '', value: daily.requestCount}];
    for (const [key, value] of daily.blockedReasons) rows.push({day: daily.day, kind: 'blocked', key, value});
    for (const [key, value] of daily.signalCounts) rows.push({day: daily.day, kind: 'signal', key, value});
    for (const [key, value] of daily.errorCounts) rows.push({day: daily.day, kind: 'error', key, value});
    for (const [key, e] of daily.userAgents) {
        rows.push({day: daily.day, kind: 'ua.requests', key, value: e.requests});
        rows.push({day: daily.day, kind: 'ua.scripted', key, value: e.scripted});
    }
    for (const [key, e] of daily.endpoints) {
        for (const field of ENDPOINT_FIELDS) rows.push({day: daily.day, kind: `endpoint.${field}`, key, value: e[field]});
    }
    return rows;
}

export function createStats({historyMinutes = 24 * 60, maxEvents = 300, maxErrors = 100, maxLatencySamples = 1000} = {}) {
    const startedAt = Date.now();
    const history = [];         // one bucket per minute, oldest first, gaps filled with zeros
    const events = [];          // limit events, oldest first
    const recentErrors = [];    // upstream errors, oldest first
    const latencies = [];       // recent upstream durations in ms
    let daily = emptyDaily(pacificDay());

    // For exportChanges: what has been saved already
    let exportedMinute = 0;     // the minute that was current at the last export (it may have changed since)
    let eventSeq = 0;
    let exportedEventSeq = 0;
    let pendingDays = [];       // previous days' totals not yet exported when the day rolled over

    function bucket(now = Date.now()) {
        const t = now - now % MINUTE_MS;
        let last = history[history.length - 1];
        if (!last || last.t !== t) {
            // Fill skipped minutes so the history stays continuous
            let next = last ? Math.max(last.t + MINUTE_MS, t - (historyMinutes - 1) * MINUTE_MS) : t;
            for (; next <= t; next += MINUTE_MS) {
                pushCapped(history, emptyBucket(next), historyMinutes);
            }
            last = history[history.length - 1];
        }
        return last;
    }

    /** Today's totals, starting a new day at midnight Pacific. Marked as changed for the next export. */
    function today(now = Date.now(), {touch = true} = {}) {
        const day = pacificDay(now);
        if (day !== daily.day) {
            if (daily.dirty) pendingDays.push(daily);
            daily = emptyDaily(day);
        }
        if (touch) daily.dirty = true;
        return daily;
    }

    function endpoint(name) {
        const endpoints = today().endpoints;
        let entry = endpoints.get(name);
        if (!entry) {
            entry = Object.fromEntries(ENDPOINT_FIELDS.map(field => [field, 0]));
            endpoints.set(name, entry);
        }
        return entry;
    }

    /** Totals across all endpoints today. */
    function totals() {
        const sum = Object.fromEntries(ENDPOINT_FIELDS.map(field => [field, 0]));
        for (const e of today(Date.now(), {touch: false}).endpoints.values()) {
            for (const key of ENDPOINT_FIELDS) sum[key] += e[key];
        }
        return sum;
    }

    function recordError(name, status, reason, detail) {
        bucket().errors += 1;
        endpoint(name).errors += 1;
        increment(today().errorCounts, `${status}|${reason}`);
        pushCapped(recentErrors, {time: Date.now(), endpoint: name, status, reason, detail}, maxErrors);
    }

    return {
        recordRequest() {
            bucket().requests += 1;
            today().requestCount += 1;
        },
        recordServed() {
            bucket().served += 1;
        },
        /** reason: which limit blocked it, e.g. 'requests', 'units', 'search', 'distinct'. */
        recordBlocked(reason) {
            bucket().blocked += 1;
            increment(today().blockedReasons, reason);
        },
        /**
         * Records a request's script signals (see signals.mjs) and its user agent. signals is empty for browser-like requests.
         */
        recordClient(userAgent, signals) {
            const day = today();
            if (signals.length) {
                bucket().scripted += 1;
                for (const signal of signals) increment(day.signalCounts, signal);
            }
            let key = (userAgent || '').slice(0, MAX_USER_AGENT_LENGTH) || '(none)';
            if (!day.userAgents.has(key) && day.userAgents.size >= MAX_USER_AGENTS) key = OTHER_USER_AGENTS;
            const entry = day.userAgents.get(key) || {requests: 0, scripted: 0};
            entry.requests += 1;
            if (signals.length) entry.scripted += 1;
            day.userAgents.set(key, entry);
        },
        /** quota (optional): what the call would have cost upstream, counted as saved by the cache. */
        recordCacheHit(name, quota) {
            bucket().cacheHits += 1;
            const e = endpoint(name);
            e.cached += 1;
            if (quota) {
                e[`${quota.metric}Saved`] += quota.cost;
            }
        },
        /**
         * quota: {metric: 'units'|'search', cost} for v3 calls, undefined otherwise.
         */
        recordUpstream(name, {ms, status, reason, detail, quota}) {
            const b = bucket();
            const e = endpoint(name);
            b.upstream += 1;
            e.upstream += 1;
            if (quota) {
                b[quota.metric] += quota.cost;
                e[quota.metric] += quota.cost;
            }
            pushCapped(latencies, ms, maxLatencySamples);
            if (status !== 200) {
                recordError(name, status, reason || '', detail);
            }
        },
        recordFailure(name, reason, detail) {
            recordError(name, reason === 'timeout' ? 504 : 500, reason, detail);
        },
        recordEvent(event) {
            pushCapped(events, {time: Date.now(), seq: ++eventSeq, ...event}, maxEvents);
        },
        totals,
        /** A random recent upstream duration, or null when there are none yet. */
        sampleLatency() {
            const recent = latencies.slice(-200);
            return recent.length ? recent[Math.floor(Math.random() * recent.length)] : null;
        },

        /**
         * What changed since the last call, for saving:
         *   minutes:  per-minute buckets that may have changed ({t, ...HISTORY_FIELDS})
         *   events:   limit events not yet exported
         *   counters: today's (and any finished day's) totals as {day, kind, key, value} rows, when they changed
         */
        exportChanges(now = Date.now()) {
            const current = bucket(now);
            const minutes = history.filter(b => b.t >= exportedMinute).map(b => ({...b}));
            exportedMinute = current.t;

            const newEvents = events.filter(e => e.seq > exportedEventSeq);
            exportedEventSeq = eventSeq;

            const counters = [];
            for (const finished of pendingDays) counters.push(...dailyRows(finished));
            pendingDays = [];
            const day = today(now, {touch: false});
            if (day.dirty) {
                counters.push(...dailyRows(day));
                day.dirty = false;
            }
            return {minutes, events: newEvents, counters};
        },

        /**
         * Restores saved state at startup: minutes within the history window, the most recent events, and today's totals.
         * Values already counted since start are kept when larger.
         */
        importState({minutes = [], events: savedEvents = [], counters = []}, now = Date.now()) {
            const current = bucket(now).t;
            const windowStart = current - (historyMinutes - 1) * MINUTE_MS;
            const saved = new Map(minutes.filter(m => m.t >= windowStart && m.t <= current).map(m => [m.t, m]));
            const existing = new Map(history.map(b => [b.t, b]));
            const first = Math.min(current, ...saved.keys());
            history.length = 0;
            for (let t = first; t <= current; t += MINUTE_MS) {
                const b = existing.get(t) || emptyBucket(t);
                const s = saved.get(t);
                if (s) for (const field of HISTORY_FIELDS) b[field] = Math.max(b[field], Number(s[field]) || 0);
                history.push(b);
            }
            exportedMinute = 0;

            const restoredEvents = savedEvents.slice(-maxEvents).map(e => ({...e, seq: 0}));
            events.unshift(...restoredEvents);
            events.splice(0, Math.max(0, events.length - maxEvents));

            const day = today(now, {touch: false});
            for (const row of counters) {
                if (row.day !== day.day) continue;
                const value = Number(row.value);
                const [kind, field] = row.kind.split('.');
                if (kind === 'requests') day.requestCount = Math.max(day.requestCount, value);
                else if (kind === 'blocked') day.blockedReasons.set(row.key, Math.max(day.blockedReasons.get(row.key) || 0, value));
                else if (kind === 'signal') day.signalCounts.set(row.key, Math.max(day.signalCounts.get(row.key) || 0, value));
                else if (kind === 'error') day.errorCounts.set(row.key, Math.max(day.errorCounts.get(row.key) || 0, value));
                else if (kind === 'ua') {
                    const entry = day.userAgents.get(row.key) || {requests: 0, scripted: 0};
                    entry[field] = Math.max(entry[field], value);
                    day.userAgents.set(row.key, entry);
                } else if (kind === 'endpoint' && ENDPOINT_FIELDS.includes(field)) {
                    const entry = day.endpoints.get(row.key) || Object.fromEntries(ENDPOINT_FIELDS.map(f => [f, 0]));
                    entry[field] = Math.max(entry[field], value);
                    day.endpoints.set(row.key, entry);
                }
            }
            return {minutes: saved.size, events: restoredEvents.length, counters: counters.filter(r => r.day === day.day).length};
        },

        snapshot(now = Date.now(), topUserAgents = 100) {
            bucket(now);
            const day = today(now, {touch: false});
            const sorted = [...latencies].sort((a, b) => a - b);
            return {
                startedAt,
                day: day.day,
                totals: totals(),
                blockedReasons: Object.fromEntries(day.blockedReasons),
                requestCount: day.requestCount,
                signalCounts: Object.fromEntries(day.signalCounts),
                userAgents: [...day.userAgents]
                    .map(([userAgent, e]) => ({userAgent, ...e}))
                    .sort((a, b) => b.requests - a.requests)
                    .slice(0, topUserAgents),
                userAgentsTracked: day.userAgents.size,
                history: history.map(b => ({...b})),
                events: [...events].reverse().map(({seq, ...e}) => e),
                upstream: {
                    latency: {
                        samples: sorted.length,
                        p50: percentile(sorted, 0.5),
                        p90: percentile(sorted, 0.9),
                        p99: percentile(sorted, 0.99),
                        max: sorted.length ? sorted[sorted.length - 1] : null,
                    },
                    errors: [...day.errorCounts].map(([key, count]) => {
                        const [status, reason] = key.split('|');
                        return {status: Number(status), reason, count};
                    }).sort((a, b) => b.count - a.count),
                    recentErrors: [...recentErrors].reverse(),
                    endpoints: [...day.endpoints].map(([name, e]) => ({endpoint: name, ...e}))
                        .sort((a, b) => (b.upstream + b.cached) - (a.upstream + a.cached)),
                },
            };
        },
    };
}
