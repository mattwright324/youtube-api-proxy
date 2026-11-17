const MINUTE_MS = 60 * 1000;

const HISTORY_FIELDS = ['requests', 'served', 'blocked', 'scripted', 'cacheHits', 'upstream', 'units', 'search', 'errors'];

const MAX_USER_AGENTS = 500;
const MAX_USER_AGENT_LENGTH = 200;
const OTHER_USER_AGENTS = '(other user agents)';

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

export function createStats({
                                historyMinutes = 24 * 60,
                                maxEvents = 300,
                                maxErrors = 100,
                                maxLatencySamples = 1000
                            } = {}) {
    const startedAt = Date.now();
    const history = [];         // one bucket per minute, oldest first, gaps filled with zeros
    const events = [];          // limit events, oldest first
    const recentErrors = [];    // upstream errors, oldest first
    const latencies = [];       // recent upstream durations in ms
    const errorCounts = new Map();      // `${status}|${reason}` -> count
    const blockedReasons = new Map();   // limit that blocked the request -> count
    const signalCounts = new Map();     // script signal -> count
    let requestCount = 0;               // since start, the denominator for signal percentages
    const userAgents = new Map();       // user agent -> {requests, scripted}
    const endpoints = new Map();        // endpoint -> {upstream, cached, errors, units, search, unitsSaved, searchSaved}

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

    function endpoint(name) {
        let entry = endpoints.get(name);
        if (!entry) {
            entry = {upstream: 0, cached: 0, errors: 0, units: 0, search: 0, unitsSaved: 0, searchSaved: 0};
            endpoints.set(name, entry);
        }
        return entry;
    }

    /** Totals across all endpoints since the process started. */
    function totals() {
        const sum = {upstream: 0, cached: 0, errors: 0, units: 0, search: 0, unitsSaved: 0, searchSaved: 0};
        for (const e of endpoints.values()) {
            for (const key of Object.keys(sum)) sum[key] += e[key];
        }
        return sum;
    }

    function recordError(name, status, reason, detail) {
        bucket().errors += 1;
        endpoint(name).errors += 1;
        const key = `${status}|${reason}`;
        errorCounts.set(key, (errorCounts.get(key) || 0) + 1);
        pushCapped(recentErrors, {time: Date.now(), endpoint: name, status, reason, detail}, maxErrors);
    }

    return {
        recordRequest() {
            bucket().requests += 1;
            requestCount += 1;
        },
        recordServed() {
            bucket().served += 1;
        },
        /** reason: which limit blocked it, e.g. 'requests', 'units', 'search', 'distinct'. */
        recordBlocked(reason) {
            bucket().blocked += 1;
            blockedReasons.set(reason, (blockedReasons.get(reason) || 0) + 1);
        },
        /**
         * Records a request's script signals (see signals.mjs) and its user agent. signals is empty for browser-like requests.
         */
        recordClient(userAgent, signals) {
            if (signals.length) {
                bucket().scripted += 1;
                for (const signal of signals) signalCounts.set(signal, (signalCounts.get(signal) || 0) + 1);
            }
            let key = (userAgent || '').slice(0, MAX_USER_AGENT_LENGTH) || '(none)';
            if (!userAgents.has(key) && userAgents.size >= MAX_USER_AGENTS) key = OTHER_USER_AGENTS;
            const entry = userAgents.get(key) || {requests: 0, scripted: 0};
            entry.requests += 1;
            if (signals.length) entry.scripted += 1;
            userAgents.set(key, entry);
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
            pushCapped(events, {time: Date.now(), ...event}, maxEvents);
        },
        totals,
        /** A random recent upstream duration, or null when there are none yet. */
        sampleLatency() {
            const recent = latencies.slice(-200);
            return recent.length ? recent[Math.floor(Math.random() * recent.length)] : null;
        },
        snapshot(now = Date.now(), topUserAgents = 100) {
            bucket(now);
            const sorted = [...latencies].sort((a, b) => a - b);
            return {
                startedAt,
                totals: totals(),
                blockedReasons: Object.fromEntries(blockedReasons),
                requestCount,
                signalCounts: Object.fromEntries(signalCounts),
                userAgents: [...userAgents]
                    .map(([userAgent, e]) => ({userAgent, ...e}))
                    .sort((a, b) => b.requests - a.requests)
                    .slice(0, topUserAgents),
                userAgentsTracked: userAgents.size,
                history: history.map(b => ({...b})),
                events: [...events].reverse(),
                upstream: {
                    latency: {
                        samples: sorted.length,
                        p50: percentile(sorted, 0.5),
                        p90: percentile(sorted, 0.9),
                        p99: percentile(sorted, 0.99),
                        max: sorted.length ? sorted[sorted.length - 1] : null,
                    },
                    errors: [...errorCounts].map(([key, count]) => {
                        const [status, reason] = key.split('|');
                        return {status: Number(status), reason, count};
                    }).sort((a, b) => b.count - a.count),
                    recentErrors: [...recentErrors].reverse(),
                    endpoints: [...endpoints].map(([name, e]) => ({endpoint: name, ...e}))
                        .sort((a, b) => (b.upstream + b.cached) - (a.upstream + a.cached)),
                },
            };
        },
    };
}
