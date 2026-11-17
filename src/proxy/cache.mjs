// Response cache shared by the proxy routes, plus the response sent when a usage limit blocks a request.

import NodeCache from 'node-cache';
import {createLogger} from '../log.mjs';

// Limits respond in YouTube's own quota error format so existing client error handling works unchanged
const QUOTA_EXCEEDED = {
    error: {
        code: 403,
        message: 'The request cannot be completed because you have exceeded your <a href="/youtube/v3/getting-started#quota">quota</a>.',
        errors: [{
            message: 'The request cannot be completed because you have exceeded your <a href="/youtube/v3/getting-started#quota">quota</a>.',
            domain: 'youtube.quota',
            reason: 'quotaExceeded',
        }],
    },
};

// 403s can be specific to a quotaUser (e.g. userRateLimitExceeded) so they shouldn't be shared via cache
function isCacheable(status) {
    return status !== 403;
}

export function createProxy({cacheTtlSec, limiter, stats, log = createLogger()}) {
    const requestCache = new NodeCache({stdTTL: cacheTtlSec, checkperiod: 5});

    /**
     * Sends the quota error for a blocked request. reason is the limit that blocked it:
     * 'requests', 'units', 'search' or 'distinct'.
     * Paced like a recent upstream round trip, so clients retrying in a tight loop don't get an instant answer each time.
     */
    function sendQuotaExceeded(req, res, reason) {
        res.locals.blocked = true;
        stats.recordBlocked(reason);
        limiter.record(req.subject, 'blocked');
        const delay = stats.sampleLatency() ?? 100 + Math.random() * 150;
        setTimeout(() => res.status(403).send(QUOTA_EXCEEDED), delay);
    }

    function sendError(req, res, endpoint, e) {
        if (e?.name === 'TimeoutError') {
            log.warn('upstream timeout', {endpoint, url: req.originalUrl});
            return res.status(504).send({message: 'Upstream request timed out'});
        }
        log.error('request failed', {endpoint, url: req.originalUrl, error: e});
        res.status(500).send({message: 'A problem occurred'});
    }

    /**
     * Serves from cache when possible, otherwise calls fetchUpstream() which must resolve to {status, json, reason?}.
     * quota ({metric, cost}, optional) is charged against the caller's limits on a cache miss before going upstream.
     */
    async function cachedProxy(req, res, {endpoint, cacheKey, fetchUpstream, quota}) {
        try {
            const cached = requestCache.get(cacheKey);
            if (cached) {
                stats.recordCacheHit(endpoint, quota);
                return res.status(cached.status).send(cached.json);
            }

            if (quota && limiter.consume(req.subject, quota.metric, quota.cost)) {
                return sendQuotaExceeded(req, res, quota.metric);
            }

            const started = Date.now();
            const {status, json, reason} = await fetchUpstream();
            stats.recordUpstream(endpoint, {ms: Date.now() - started, status, reason, detail: cacheKey, quota});
            if (isCacheable(status)) {
                requestCache.set(cacheKey, {status, json});
            }
            res.status(status).send(json);
        } catch (e) {
            stats.recordFailure(endpoint, e?.name === 'TimeoutError' ? 'timeout' : 'exception', cacheKey);
            sendError(req, res, endpoint, e);
        }
    }

    return {
        cachedProxy,
        sendQuotaExceeded,
        cacheStats: () => ({...requestCache.getStats(), ttlSec: cacheTtlSec}),
    };
}
