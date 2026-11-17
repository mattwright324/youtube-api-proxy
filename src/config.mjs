import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {limitsFromEnv} from './limits.mjs';
import {DEFAULT_CLIENT_VERSION} from './proxy/v1.mjs';

/** Project root, so paths don't depend on the directory the process was started from. */
export const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function optionalList(env, name) {
    return (env[name] || '').split(',').map(value => value.trim()).filter(Boolean);
}

function requireList(env, name) {
    const value = env[name];
    if (value === undefined) {
        throw new Error(`Missing required env variable ${name} (see .env.template)`);
    }
    return value.split(',');
}

export function loadConfig(env = process.env, log) {
    const config = {
        port: env.PORT === undefined || env.PORT === '' ? 3000 : Number(env.PORT),
        corsWhitelist: requireList(env, 'CORS_WHITELIST'),
        limits: limitsFromEnv(env),
        limitDryRun: env.LIMIT_DRY_RUN === 'true',
        distinctParam: env.LIMIT_DISTINCT_PARAM || '',
        distinctMinRequests: Number(env.LIMIT_DISTINCT_MIN_REQUESTS) || 1000,
        distinctMaxRatio: Number(env.LIMIT_DISTINCT_MAX_RATIO) || 0.5,
        cacheTtlSec: Number(env.CACHE_TTL_SEC) || 300,
        upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS) || 10000,
        innertubeClientVersion: env.INNERTUBE_CLIENT_VERSION || DEFAULT_CLIENT_VERSION,
        apiV3Key: env.API_V3_KEY,
        allowedPaths: requireList(env, 'API_ALLOWED_PATHS'),
        allowedParams: requireList(env, 'API_ALLOWED_PARAMS'),
        monitorPath: env.MONITOR_PATH || '',
        monitorUser: env.MONITOR_USER || '',
        monitorPassword: env.MONITOR_PASSWORD || '',
        scriptExpectedParams: optionalList(env, 'SCRIPT_EXPECTED_PARAMS'),
        scriptUaPatterns: optionalList(env, 'SCRIPT_UA_PATTERNS'),
        // Postgres persistence, enabled when PG_HOST is set
        postgres: env.PG_HOST ? {
            connection: {
                host: env.PG_HOST,
                port: Number(env.PG_PORT) || 5432,
                user: env.PG_USER,
                password: env.PG_PASS,
                database: env.PG_DBNAME,
            },
            schema: env.PG_SCHEMA || 'public',
            prefix: env.PG_TABLE_PREFIX || 'proxy_',
            intervalSec: Math.max(10, Number(env.PERSIST_INTERVAL_SEC) || 60),
            retentionDays: Math.max(7, Number(env.RETENTION_DAYS) || 30),
        } : null,
        asnLookup: env.ASN_LOOKUP !== 'false',
        // Relative paths (e.g. ./data) are resolved from the project root, not the working directory
        asnDataDir: resolve(ROOT_DIR, env.ASN_DATA_DIR || 'data'),
    };

    if (config.monitorPath) {
        if (!/^\/[\w\-\/]+$/.test(config.monitorPath) || /^\/(v1|v3|vendor)(\/|$)/.test(config.monitorPath)) {
            throw new Error('MONITOR_PATH must look like /some-path and not use /v1, /v3 or /vendor');
        }
        if (!config.monitorUser || !config.monitorPassword) {
            log.warn('monitor disabled: MONITOR_PATH is set but MONITOR_USER/MONITOR_PASSWORD are not');
        }
    }
    config.monitorEnabled = Boolean(config.monitorPath && config.monitorUser && config.monitorPassword);

    // WEB client versions look like 2.20261116.00.00
    if (!/^\d+\.\d{8}\.\d{2}\.\d{2}$/.test(config.innertubeClientVersion)) {
        log.warn('INNERTUBE_CLIENT_VERSION does not look like a WEB client version (e.g. 2.20261116.00.00)',
            {value: config.innertubeClientVersion});
    }
    if (config.postgres && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.postgres.schema)) {
        throw new Error(`PG_SCHEMA "${config.postgres.schema}" must be a plain schema name (letters, digits, underscores)`);
    }
    if (!config.apiV3Key) {
        log.warn('API_V3_KEY is not set, /v3 requests will fail');
    }
    for (const name of ['LIMIT_COUNT', 'LIMIT_WINDOW_MS']) {
        if (env[name]) log.warn(`${name} is no longer used, see the LIMIT_<SCOPE>_<METRIC>_<WINDOW> settings in .env.template`);
    }
    return config;
}
