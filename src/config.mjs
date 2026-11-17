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

/** log: a logger from log.mjs, used for configuration warnings. */
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
    if (!config.apiV3Key) {
        log.warn('API_V3_KEY is not set, /v3 requests will fail');
    }
    // Legacy settings from before express-rate-limit was replaced
    if (env.LIMIT_COUNT && !env.LIMIT_IP_REQUESTS_MINUTE) {
        config.limits.ip ??= {};
        config.limits.ip.requests = {...config.limits.ip.requests, minute: Number(env.LIMIT_COUNT)};
    }
    if (env.LIMIT_WINDOW_MS) {
        log.warn('LIMIT_WINDOW_MS is no longer used, limits now use fixed minute and day windows');
    }
    return config;
}
