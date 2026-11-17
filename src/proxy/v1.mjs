// /v1/* -> YouTube's internal (innertube) API, for data the Data API doesn't provide. No API quota is used.
//   GET /v1/resolve_url?url=  -> POST youtubei/v1/navigation/resolve_url (vanity channel URL to channel id)
//   GET /v1/player?id=        -> POST youtubei/v1/player (video metadata)

import express from 'express';
import {createLogger} from '../log.mjs';

const INNERTUBE_URL = 'https://youtubei.googleapis.com/youtubei/v1/';
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

export const DEFAULT_CLIENT_VERSION = '2.20261116.00.00';

const vanityRegexes = [
    // Vanity @
    /(?:http[s]?:\/\/)?(?:\w+\.)?youtube.com\/@([^\/?]+)(?:\?.*)?/i,
    // Vanity user
    /(?:http[s]?:\/\/)?(?:\w+\.)?youtube.com\/user\/([\w_-]+)(?:\?.*)?/i,
    // Vanity custom
    /(?:http[s]?:\/\/)?(?:\w+\.)?youtube.com\/c\/([^\/?]+)(?:\?.*)?/i,
    /(?:http[s]?:\/\/)?(?:\w+\.)?youtube.com\/([^\/?]+)(?:\?.*)?/i,
];

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// Parts of the player response passed on to clients; tracking, ad and framework fields are dropped
const PLAYER_FIELDS = ['playabilityStatus', 'videoDetails', 'microformat', 'captions'];

export function createV1Router({
                                   proxy,
                                   upstreamTimeoutMs,
                                   clientVersion = DEFAULT_CLIENT_VERSION,
                                   log = createLogger()
                               }) {
    const router = express.Router();
    const client = {clientName: 'WEB', clientVersion, hl: 'en'};

    /** POSTs to an innertube endpoint and returns {status, json}, logging non-200 responses. */
    async function innertube(path, body, endpoint, cacheKey) {
        const response = await fetch(`${INNERTUBE_URL}${path}?key=${INNERTUBE_KEY}`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({context: {client}, ...body}),
            signal: AbortSignal.timeout(upstreamTimeoutMs),
        });
        const json = await response.json();
        if (response.status !== 200) {
            log.warn('upstream failed', {endpoint, status: response.status, key: cacheKey});
        }
        return {status: response.status, json};
    }

    router.get('/resolve_url', (req, res) => {
        const channelUrl = req.query.url;
        if (!channelUrl) {
            log.warn('url missing', {endpoint: 'v1/resolve_url', ip: req.subject?.ip});
            return res.status(400).send({message: '"url" query parameter is required'});
        }
        if (!vanityRegexes.some(pattern => pattern.test(channelUrl))) {
            log.warn('url not a vanity format', {endpoint: 'v1/resolve_url', ip: req.subject?.ip, url: channelUrl});
            return res.status(400).send({message: '"url" is not an expected vanity url format'});
        }

        const cacheKey = '/v1/resolve_url?url=' + channelUrl;
        return proxy.cachedProxy(req, res, {
            endpoint: 'v1/resolve_url',
            cacheKey,
            fetchUpstream: async () => {
                const {
                    status,
                    json
                } = await innertube('navigation/resolve_url', {url: channelUrl}, 'v1/resolve_url', cacheKey);
                return {
                    status,
                    json: {
                        isVanityUrl: json?.endpoint?.commandMetadata?.resolveUrlCommandMetadata?.isVanityUrl,
                        channelId: json?.endpoint?.browseEndpoint?.browseId,
                    },
                };
            },
        });
    });

    // Video metadata. YouTube answers 200 even for unavailable videos; playabilityStatus.status says why
    // (e.g. ERROR "This video is unavailable"). No streaming data is returned.
    router.get('/player', (req, res) => {
        const videoId = req.query.id;
        if (!videoId) {
            log.warn('id missing', {endpoint: 'v1/player', ip: req.subject?.ip});
            return res.status(400).send({message: '"id" query parameter is required'});
        }
        if (typeof videoId !== 'string' || !VIDEO_ID.test(videoId)) {
            log.warn('id not a video id', {endpoint: 'v1/player', ip: req.subject?.ip, id: String(videoId)});
            return res.status(400).send({message: '"id" is not a valid video id'});
        }

        const cacheKey = '/v1/player?id=' + videoId;
        return proxy.cachedProxy(req, res, {
            endpoint: 'v1/player',
            cacheKey,
            fetchUpstream: async () => {
                const {status, json} = await innertube('player', {videoId}, 'v1/player', cacheKey);
                const result = {};
                for (const field of PLAYER_FIELDS) {
                    if (json?.[field] !== undefined) result[field] = json[field];
                }
                return {status, json: result};
            },
        });
    });

    return router;
}
