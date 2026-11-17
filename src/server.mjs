import http from 'node:http';
import {join} from 'node:path';
import express from 'express';
import cors from 'cors';
import {createAsnDatabase} from './asn.mjs';
import {createBlocklist, EXPIRY_DAYS, normalizeEntry} from './blocklist.mjs';
import {loadConfig, ROOT_DIR} from './config.mjs';
import {createDistinctTracker, createLimiter, normalizeIp, subjectFor} from './limits.mjs';
import {loggerFromEnv} from './log.mjs';
import {createPersistence} from './persistence.mjs';
import {createScriptDetector} from './signals.mjs';
import {buildMonitorStats, createMonitorRouter} from './monitor/router.mjs';
import {createProxy} from './proxy/cache.mjs';
import {createV1Router} from './proxy/v1.mjs';
import {createV3Router} from './proxy/v3.mjs';
import {createStats} from './stats.mjs';

const log = loggerFromEnv();

process.on('uncaughtException', error => {
    log.error('uncaught exception, exiting', {error});
    process.exit(1);
});
process.on('unhandledRejection', reason => {
    log.error('unhandled promise rejection, exiting', {error: reason});
    process.exit(1);
});

let config;
try {
    config = loadConfig(process.env, log);
} catch (error) {
    log.error('invalid configuration, exiting', {error: error.message});
    process.exit(1);
}
// Effective settings, so a deploy can be checked against its env vars. Secrets and the monitor path are left out.
log.info('config', {
    port: config.port,
    corsWhitelist: config.corsWhitelist,
    apiKeySet: Boolean(config.apiV3Key),
    allowedPaths: config.allowedPaths,
    allowedParams: config.allowedParams,
    cacheTtlSec: config.cacheTtlSec,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    innertubeClientVersion: config.innertubeClientVersion,
    dryRun: config.limitDryRun,
    distinct: config.distinctParam
        ? {param: config.distinctParam, minRequests: config.distinctMinRequests, maxRatio: config.distinctMaxRatio}
        : false,
    scriptSignals: {expectedParams: config.scriptExpectedParams, extraUaPatterns: config.scriptUaPatterns.length},
    asnLookup: config.asnLookup ? config.asnDataDir : false,
    postgres: config.postgres
        ? {host: config.postgres.connection.host, schema: config.postgres.schema, intervalSec: config.postgres.intervalSec,
            retentionDays: config.postgres.retentionDays}
        : false,
    monitor: config.monitorEnabled,
    logLevel: process.env.LOG_LEVEL || 'info',
    logFormat: process.env.LOG_FORMAT || 'text',
});
log.info('limits', {limits: config.limits});


const stats = createStats();
const limiter = createLimiter({limits: config.limits, dryRun: config.limitDryRun, onLimit: stats.recordEvent, log});
const distinctTracker = config.distinctParam ? createDistinctTracker({
    minRequests: config.distinctMinRequests,
    maxRatio: config.distinctMaxRatio,
    dryRun: config.limitDryRun,
    onLimit: stats.recordEvent,
    log,
}) : null;
const asnDb = config.asnLookup ? createAsnDatabase({dataDir: config.asnDataDir, log}) : null;
asnDb?.start();
const proxy = createProxy({cacheTtlSec: config.cacheTtlSec, limiter, stats, log});
// The blocklist is stored in Postgres, so it's only available with persistence
const blocklist = config.postgres ? createBlocklist() : null;
const persistence = config.postgres
    ? createPersistence({...config.postgres, limiter, distinctTracker, stats, blocklist, log})
    : null;

const blocklistApi = persistence && {
    list: () => blocklist.list().map(entry => ({...entry, network: asnDb?.describe(entry.value) ?? null})),
    async add({kind, value, note, expiry}) {
        const entry = await persistence.addBlock({
            kind,
            value: normalizeEntry(kind, value),
            note: String(note ?? '').slice(0, 200),
            expiresAt: expiry === 'permanent' ? null : Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000,
        });
        return {...entry, network: asnDb?.describe(entry.value) ?? null};
    },
    remove: id => persistence.removeBlock(id),
};
const scriptDetector = createScriptDetector({
    corsWhitelist: config.corsWhitelist,
    expectedParams: config.scriptExpectedParams,
    extraUaPatterns: config.scriptUaPatterns,
});

setInterval(() => {
    limiter.prune();
    distinctTracker?.prune();
}, 60 * 1000).unref();


const app = express();
app.set('trust proxy', 1);

app.use(cors({origin: config.corsWhitelist}));
app.options('*', cors());

app.use(express.static(join(ROOT_DIR, 'public')));
app.use('/vendor/bootstrap', express.static(join(ROOT_DIR, 'node_modules/bootstrap/dist')));

const monitorSources = {config, limiter, distinctTracker, stats, proxy, asnDb, scriptDetector, persistence, blocklistApi};
if (config.monitorEnabled) {
    // Mounted before the usage limits so viewing it doesn't count against your own IP
    app.use(config.monitorPath, createMonitorRouter({
        user: config.monitorUser,
        password: config.monitorPassword,
        getStats: n => buildMonitorStats(monitorSources, n),
        blocklistApi,
        getHistory: persistence ? days => persistence.history(days) : null,
        log,
    }));
    log.info('monitor enabled');
}

// Usage limits for everything below
app.use((req, res, next) => {
    const asn = asnDb?.lookup(normalizeIp(req.ip));
    req.subject = subjectFor(req.ip, asn ? `AS${asn.asn}` : null);

    // Blocklisted: rejected before anything else and only counted as denied, so it stays out of every other statistic
    if (blocklist?.match(req.subject)) {
        stats.recordDenied();
        return proxy.sendDenied(res);
    }

    stats.recordRequest();

    // Classified before the limits so limited requests are counted too
    const signals = scriptDetector.classify(req);
    stats.recordClient(req.get('user-agent'), signals);
    if (signals.length) {
        limiter.record(req.subject, 'scripted');
    }

    const distinctValue = distinctTracker && req.query[config.distinctParam];
    if (distinctTracker && distinctTracker.observe(req.subject, distinctValue ? String(distinctValue) : '')) {
        return proxy.sendQuotaExceeded(req, res, 'distinct');
    }
    if (limiter.consume(req.subject, 'requests', 1)) {
        return proxy.sendQuotaExceeded(req, res, 'requests');
    }
    // Counted as served once the response finishes without being limited further along (e.g. quota limits)
    res.on('finish', () => {
        if (!res.locals.blocked) {
            stats.recordServed();
            limiter.record(req.subject, 'served');
        }
    });
    next();
});

app.use('/v1', createV1Router({
    proxy,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    clientVersion: config.innertubeClientVersion,
    log,
}));
app.use('/v3', createV3Router({
    proxy,
    apiKey: config.apiV3Key,
    allowedPaths: config.allowedPaths,
    allowedParams: config.allowedParams,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    log,
}));

// Errors thrown outside the proxy helper (middleware, routes, bad URLs) end up here instead of Express's
// default handler, which prints an unformatted stack and sends an HTML page
app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || error.statusCode || 500;
    if (status >= 500) {
        log.error('unhandled error', {url: req.originalUrl, ip: req.subject?.ip ?? req.ip, error});
        return res.status(500).send({message: 'A problem occurred'});
    }
    log.warn('bad request', {status, url: req.originalUrl, ip: req.subject?.ip ?? req.ip, error: error.message});
    res.status(status).send({message: 'Bad request'});
});

// Restore saved state before accepting requests, so today's limits and counts carry over a restart
await persistence?.start();

const server = http.createServer(app).listen(config.port, () => {
    log.info('listening', {port: server.address().port});
});

// CapRover sends SIGTERM on every redeploy: stop accepting connections, let in-flight requests finish, then exit
const SHUTDOWN_TIMEOUT_MS = 10 * 1000;

function shutdown(signal) {
    log.info('shutting down', {signal});
    server.close(async () => {
        await persistence?.stop();
        log.info('stopped');
        process.exit(0);
    });
    // Keep-alive connections become idle as their last request finishes; close them so shutdown doesn't wait for them
    server.closeIdleConnections();
    setInterval(() => server.closeIdleConnections(), 250).unref();
    setTimeout(() => {
        log.warn('requests still open at shutdown timeout, exiting', {timeoutMs: SHUTDOWN_TIMEOUT_MS});
        process.exit(0);
    }, SHUTDOWN_TIMEOUT_MS).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
