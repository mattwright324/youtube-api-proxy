import express from 'express';
import {createLogger} from '../log.mjs';

// https://developers.google.com/youtube/v3/determine_quota_cost
// search is not listed here: search.list now uses its own quota bucket (counted per query) instead of costing 100 units
export const QUOTA_COSTS = {
    activities: 1,
    captions: 50,
    channels: 1,
    channelSections: 1,
    comments: 1,
    commentThreads: 1,
    guideCategories: 1,
    i18nLanguages: 1,
    i18nRegions: 1,
    members: 1,
    membershipsLevels: 1,
    playlistItems: 1,
    playlists: 1,
    subscriptions: 1,
    videoAbuseReportReasons: 1,
    videoCategories: 1,
    videos: 1,
};

// Errors that mean the server's own API key can't be used (an outage for every user, not one bad request).
// YouTube puts some in errors[].reason and Google puts others in an ErrorInfo detail.
const KEY_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded', 'keyInvalid', 'keyExpired', 'accessNotConfigured', 'ipRefererBlocked']);
const KEY_DETAIL_REASONS = /^(API_KEY_\w+|SERVICE_DISABLED|CONSUMER_INVALID)$/;
const KEY_PROBLEM_LOG_INTERVAL_MS = 60 * 1000;

/** Router to mount at /v3. */
export function createV3Router({proxy, apiKey, allowedPaths, allowedParams, upstreamTimeoutMs, log = createLogger()}) {
    const router = express.Router();
    const allowAllPaths = allowedPaths.includes('*');
    const allowAllParams = allowedParams.includes('*');

    // Key problems repeat on every request during an outage, so they're logged at most once a minute per reason
    const keyProblems = new Map(); // reason -> {loggedAt, repeats}
    function logKeyProblem(problem, fields) {
        const now = Date.now();
        const entry = keyProblems.get(problem);
        if (entry && now - entry.loggedAt < KEY_PROBLEM_LOG_INTERVAL_MS) {
            entry.repeats++;
            return;
        }
        log.error('api key problem', {problem, ...fields, repeatsSinceLastLog: entry?.repeats || undefined});
        keyProblems.set(problem, {loggedAt: now, repeats: 0});
    }

    router.get('/*', (req, res) => {
        const requestPath = req.path.slice(1);
        if (!allowAllPaths && !allowedPaths.includes(requestPath)) {
            // Logged as a warning: requests for paths that aren't allowed can mean someone probing the configuration
            log.warn('path not allowed', {path: requestPath, ip: req.subject?.ip});
            return res.status(403).send({message: 'Request path disallowed'});
        }

        const query = allowAllParams
            ? {...req.query}
            : Object.fromEntries(Object.entries(req.query).filter(([param]) => allowedParams.includes(param)));

        // Sorted so the same request with params in a different order shares one cache entry
        const sortedQuery = new URLSearchParams(query);
        sortedQuery.sort();
        const cacheKey = requestPath + '?' + sortedQuery.toString().replaceAll('%2C', ',');
        return proxy.cachedProxy(req, res, {
            endpoint: 'v3/' + requestPath,
            cacheKey,
            quota: requestPath === 'search'
                ? {metric: 'search', cost: 1}
                : {metric: 'units', cost: QUOTA_COSTS[requestPath] || 1},
            fetchUpstream: async () => {
                // https://cloud.google.com/apis/docs/capping-api-usage details on quotaUser attribute
                if (!req.ip) {
                    // This shouldn't happen but defaulting value just in case
                    log.warn('client ip unknown', {url: req.originalUrl});
                }
                const params = new URLSearchParams({...query, key: apiKey, quotaUser: req.subject.ip});
                const response = await fetch('https://www.googleapis.com/youtube/v3/' + requestPath + '?' + params, {
                    method: 'GET',
                    signal: AbortSignal.timeout(upstreamTimeoutMs),
                });
                const resultJson = await response.json();
                const reason = resultJson?.error?.errors?.[0]?.reason || '';

                if (response.status !== 200) {
                    // https://developers.google.com/youtube/v3/docs/errors
                    const detailReason = resultJson?.error?.details?.find(d => d['@type']?.endsWith('ErrorInfo'))?.reason;
                    const fields = {
                        endpoint: 'v3/' + requestPath, status: response.status,
                        errorStatus: resultJson?.error?.status || undefined, reason: reason || undefined,
                        detailReason, key: cacheKey,
                    };
                    if (KEY_REASONS.has(reason) || KEY_DETAIL_REASONS.test(detailReason || '')) {
                        logKeyProblem(detailReason || reason, fields);
                    } else {
                        log.warn('upstream failed', fields);
                    }
                }

                return {status: response.status, json: resultJson, reason};
            },
        });
    });

    return router;
}
