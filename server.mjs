'use strict';

import express from 'express';

const app = express();
import http from 'http';

const server = http.createServer(app);
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import cors from 'cors';

app.use(cors({origin: process.env.CORS_WHITELIST.split(",")}));
app.options('*', cors());
app.set("trust proxy", 1);

app.use(express.static('public'))
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

import {rateLimit} from 'express-rate-limit';

const limiter = rateLimit({
    windowMs: Number(process.env.LIMIT_WINDOW_MS) || 60000,
    limit: Number(process.env.LIMIT_COUNT) || 152,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: "Exceeded usage limit, try again in a few minutes",
    handler: (req, res, next, options) => {
        if (req.rateLimit.used === req.rateLimit.limit + 1) {
            console.log("WARN Rate-limited", req.ip)
        }
        res.status(options.statusCode).send(options.message);
    }
});
app.use(limiter);

import NodeCache from "node-cache";

const requestCache = new NodeCache({stdTTL: Number(process.env.CACHE_TTL_SEC) || 300, checkperiod: 5})

// import { Innertube } from "youtubei.js";
// const innertube = await Innertube.create();

// https://developers.google.com/youtube/v3/determine_quota_cost
const quotaCosts = {
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
    search: 100,
    subscriptions: 1,
    videoAbuseReportReasons: 1,
    videoCategories: 1,
    videos: 1,
}

const debugStats = {
    v3: {
        apiCalls: 0,
        apiQuotaUsed: 0,
        cachedCalls: 0,
        cacheQuotaSaved: 0,
    },
    v1: {
        resolved: 0,
        resolve_cached: 0,
    }
}

function addDebugCount(apiMethod, cached) {
    if (!quotaCosts[apiMethod]) {
        console.warn("WARN", apiMethod, 'unsupported debug type')
        return
    }

    const callCost = quotaCosts[apiMethod];
    if (cached) {
        debugStats.v3.cachedCalls += 1;
        debugStats.v3.cacheQuotaSaved += callCost;
    } else {
        debugStats.v3.apiCalls += 1;
        debugStats.v3.apiQuotaUsed += callCost;
    }
}

setInterval(() => {
    console.log("DEBUG Quota Stats", JSON.stringify(debugStats))
},60 * 1000)

const vanityRegexes = [
    // Vanity @
    /(?:http[s]?:\/\/)?(?:\w+\.)?youtube.com\/@([^\/?]+)(?:\?.*)?/i,
    // Vanity user
    /(?:http[s]?:\/\/)?(?:\w+\.)?youtube.com\/user\/([\w_-]+)(?:\?.*)?/i,
    // Vanity custom
    /(?:http[s]?:\/\/)?(?:\w+\.)?youtube.com\/c\/([^\/?]+)(?:\?.*)?/i,
    /(?:http[s]?:\/\/)?(?:\w+\.)?youtube.com\/([^\/?]+)(?:\?.*)?/i
]
// Proxy for vanity url resolving
app.get('/v1/resolve_url', async (req, res) => {
    try {
        const channelUrl = req.query.url;
        if (!channelUrl) {
            return res.status(400).send({message: '"url" query parameter is required'})
        }

        let matched = false
        for (let i = 0; i < vanityRegexes.length; i++) {
            const pattern = vanityRegexes[i];
            const result = pattern.exec(channelUrl);
            if (result) {
                matched = true;
            }
        }
        if (!matched) {
            console.log('WARN Request 400 /v1/resolve_url?url=', channelUrl, 'did not match formats')
            return res.status(400).send({message: '"url" is not an expected vanity url format'})
        }

        const CACHE_KEY = "/v1/resolve_url?url=" + channelUrl;
        let cached = requestCache.get(CACHE_KEY);
        if (cached) {
            debugStats.v1.resolve_cached += 1;
            return res.status(cached.status).send(cached.json)
        }

        const response = await fetch("https://youtubei.googleapis.com/youtubei/v1/navigation/resolve_url?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8", {
            method: 'POST',
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                context: {
                    client: {
                        clientName: "ANDROID",
                        clientVersion: "19.09.37",
                        hl: "en",
                    }
                },
                "url": channelUrl
            })
        });
        const responseJson = await response.json();

        const isVanityUrl = responseJson?.endpoint?.commandMetadata?.resolveUrlCommandMetadata?.isVanityUrl;
        const channelId = responseJson?.endpoint?.browseEndpoint?.browseId
        const resultJson = {isVanityUrl: isVanityUrl, channelId: channelId};

        if (response.status !== 200) {
            console.log("WARN Request failed", response.status, CACHE_KEY);
        }

        debugStats.v1.resolved += 1;

        requestCache.set(CACHE_KEY, {status: response.status, json: resultJson});
        res.status(response.status).send(resultJson);
    } catch (e) {
        console.error("ERROR 500", req.originalUrl, e);
        res.status(500).send({message: 'A problem occurred'})
    }
});

const allowed = {
    paths: process.env.API_ALLOWED_PATHS.split(','),
    params: process.env.API_ALLOWED_PARAMS.split(','),
}
// Proxy for GET requests
app.get('/v3/*', async (req, res) => {
    try {
        const REQUEST_PATH = req.path.slice('/v3/'.length)
        if (!allowed.paths.includes('*')) {
            if (!allowed.paths.includes(REQUEST_PATH)) {
                console.log('WARN Request 403 path', REQUEST_PATH, 'disallowed')
                return res.status(403).send({message: 'Request path disallowed'})
            }
        }

        if (!allowed.params.includes('*')) {
            for (const param in req.query) {
                if (!allowed.params.includes(param)) {
                    delete req.query[param];
                }
            }
        }

        const CACHE_KEY = REQUEST_PATH + "?" + new URLSearchParams(req.query).toString().replaceAll("%2C", ",")
        // https://cloud.google.com/apis/docs/capping-api-usage details on quotaUser attribute
        if (!req.ip) {
            // This shouldn't happen but defaulting value just in case
            console.log('WARN User request "unknown"', req.originalUrl)
        }
        const REQUEST_PARAMS = Object.assign(req.query, {key: process.env.API_V3_KEY, quotaUser: req.ip || 'unknown'})
        const REQUEST_URL = "https://www.googleapis.com/youtube/v3/" + REQUEST_PATH + "?" + new URLSearchParams(REQUEST_PARAMS).toString()

        let cached = requestCache.get(CACHE_KEY);
        if (cached) {
            addDebugCount(REQUEST_PATH, true);
            return res.status(cached.status).send(cached.json)
        }

        const response = await fetch(REQUEST_URL, {method: 'GET'});
        const resultJson = await response.json();

        if (response.status !== 200) {
            // https://developers.google.com/youtube/v3/docs/errors
            const errorStatus = "status=" + (resultJson?.error?.status || "");
            const errorDetail = "reason=" + (resultJson?.error?.errors?.[0]?.reason || "");

            console.log("WARN Request failed", response.status, errorStatus, errorDetail, CACHE_KEY)
        }

        addDebugCount(REQUEST_PATH, false)

        requestCache.set(CACHE_KEY, {status: response.status, json: resultJson});
        res.status(response.status).send(resultJson)
    } catch (e) {
        console.error("ERROR 500", req.originalUrl, e);
        res.status(500).send({message: 'A problem occurred'})
    }
});

server.listen(process.env.PORT || 3000, () => {
    console.log('INFO Listening on *:3000');
});
