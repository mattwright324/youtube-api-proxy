// Basic auth protected monitoring page. Only mounted when MONITOR_PATH, MONITOR_USER and MONITOR_PASSWORD are set.

import crypto from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {createLogger} from '../log.mjs';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ui');

const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

// Compares digests so both sides have equal length and the comparison time doesn't depend on the input
function safeEqual(a, b) {
    const digest = value => crypto.createHash('sha256').update(value).digest();
    return crypto.timingSafeEqual(digest(a), digest(b));
}

function parseBasicAuth(header) {
    const match = /^Basic\s+(.+)$/i.exec(header || '');
    if (!match) return null;
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return separator < 0 ? null : {user: decoded.slice(0, separator), password: decoded.slice(separator + 1)};
}

/**
 * Builds the data shown on the page, with top lists of up to n rows.
 * asnDb and distinctTracker are optional (null when disabled).
 */
export function buildMonitorStats({
                                      config,
                                      limiter,
                                      distinctTracker,
                                      stats,
                                      proxy,
                                      asnDb,
                                      scriptDetector
                                  }, n, now = Date.now()) {
    // Global rows (id '*') get no network field
    const withNetwork = rows => rows.map(row => (row.id === '*' || !asnDb ? row : {
        ...row,
        network: asnDb.describe(row.id)
    }));

    const limiterStats = limiter.snapshot(now, n, true);
    // Each row also gets today's served and blocked counts for that key
    for (const [scopeName, scope] of Object.entries(limiterStats.top)) {
        for (const metric of Object.keys(scope)) {
            scope[metric] = withNetwork(scope[metric]).map(row => ({
                ...row,
                servedDay: limiter.usage(scopeName, row.id, 'served', now).day,
                blockedDay: limiter.usage(scopeName, row.id, 'blocked', now).day,
                scriptedDay: limiter.usage(scopeName, row.id, 'scripted', now).day,
            }));
        }
    }
    const distinctTop = distinctTracker?.snapshot(now, n, true);
    const usage = stats.snapshot(now);
    return {
        now,
        dryRun: config.limitDryRun,
        limits: config.limits,
        limiter: limiterStats,
        distinct: distinctTracker ? {
            param: config.distinctParam,
            minRequests: config.distinctMinRequests,
            maxRatio: config.distinctMaxRatio,
            top: {ip: withNetwork(distinctTop.ip), block: withNetwork(distinctTop.block)},
        } : null,
        ...usage,
        events: withNetwork(usage.events),
        asn: asnDb ? asnDb.status() : null,
        scriptSignals: scriptDetector?.settings ?? null,
        cache: proxy.cacheStats(),
    };
}

/**
 * getStats(n) must return the JSON-serializable data shown on the page, with top lists of up to n rows.
 */
export function createMonitorRouter({user, password, getStats, log = createLogger()}) {
    const failures = new Map(); // ip -> {count, until}
    const loggedIn = new Set();  // IPs that have logged in since start, so polling doesn't log every request
    const router = express.Router();

    router.use((req, res, next) => {
        res.set('X-Robots-Tag', 'noindex, nofollow');
        res.set('Cache-Control', 'no-store');

        const now = Date.now();
        const record = failures.get(req.ip);
        if (record && record.until <= now) {
            failures.delete(req.ip);
        }
        const locked = record && record.until > now && record.count >= MAX_FAILURES;

        const credentials = parseBasicAuth(req.get('authorization'));
        // Both comparisons always run so a wrong user and a wrong password take the same time
        const userOk = credentials && safeEqual(credentials.user, user);
        const passwordOk = credentials && safeEqual(credentials.password, password);
        if (!locked && userOk && passwordOk) {
            failures.delete(req.ip);
            if (!loggedIn.has(req.ip)) {
                loggedIn.add(req.ip);
                log.info('monitor login', {ip: req.ip});
            }
            return next();
        }

        if (credentials && !locked) {
            const current = failures.get(req.ip) || {count: 0, until: 0};
            current.count += 1;
            current.until = now + LOCKOUT_MS;
            failures.set(req.ip, current);
            // The attempted username isn't logged, since people sometimes type a password into that field
            log.warn('monitor login failed', {ip: req.ip, attempt: current.count, maxAttempts: MAX_FAILURES});
            if (current.count === MAX_FAILURES) {
                log.warn('monitor login locked', {ip: req.ip, minutes: LOCKOUT_MS / 60000});
            }
        }
        res.set('WWW-Authenticate', 'Basic realm="monitor", charset="UTF-8"');
        res.status(401).send('Authentication required');
    });

    // Relative links on the page need the trailing slash
    router.get('/', (req, res, next) => {
        if (!req.originalUrl.split('?')[0].endsWith('/')) {
            return res.redirect(301, req.originalUrl.split('?')[0] + '/');
        }
        next();
    });

    router.get('/api/stats', (req, res) => {
        const n = Math.min(Math.max(Number(req.query.n) || 100, 1), 1000);
        res.json(getStats(n));
    });

    router.use(express.static(UI_DIR));

    return router;
}
