'use strict';

import express from 'express';

const app = express();
import http from 'http';

const server = http.createServer(app);
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const nodeBtoa = (b) => Buffer.from(b).toString('base64');

import cors from 'cors';

app.use(cors({origin: process.env.CORS_WHITELIST.split(",")}));
app.options('*', cors());
app.set("trust proxy", 1);

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

import {rateLimit} from 'express-rate-limit';

const limiter = rateLimit({
    windowMs: Number(process.env.LIMIT_WINDOW_MS),
    limit: Number(process.env.LIMIT_COUNT),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: "Exceeded usage limit, try again in a few minutes"
});
app.use(limiter);

import NodeCache from "node-cache";

const requestCache = new NodeCache({stdTTL: 300, checkperiod: 5})

// import { Innertube } from "youtubei.js";
// const innertube = await Innertube.create();

// https://developers.google.com/youtube/v3/determine_quota_cost
const quotaCosts = {
    videos: 1,
    channels: 1,
    playlists: 1,
    playlistItems: 1,
    search: 100,
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
        console.warn(apiMethod, 'unsupported debug type')
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

setInterval(() => {console.log("Debug stats", debugStats)},60 * 1000)

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
            console.log('Request 400 /v1/resolve_url?url=', channelUrl, 'did not match formats')
            return res.status(400).send({message: '"url" is not an expected vanity url format'})
        }

        const CACHE_KEY = "/v1/resolve_url?url=" + channelUrl;
        let cached = requestCache.get(CACHE_KEY);
        if (cached) {
            // console.log("Cached", cached.status, CACHE_KEY)
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
            console.log("Request failed", response.status, CACHE_KEY);
        }

        debugStats.v1.resolved += 1;

        requestCache.set(CACHE_KEY, {status: response.status, json: resultJson});
        res.status(response.status).send(resultJson);
    } catch (e) {
        console.error("Error 500", req.originalUrl, e);
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
        if (!allowed.paths.includes(REQUEST_PATH)) {
            console.log('Request 403 path', REQUEST_PATH, 'disallowed')
            return res.status(403).send({message: 'Request path disallowed'})
        }
        for (const param in req.query) {
            if (!allowed.params.includes(param)) {
                delete req.query[param];
            }
        }
        const CACHE_KEY = REQUEST_PATH + "?" + new URLSearchParams(req.query).toString().replaceAll("%2C", ",")
        // https://cloud.google.com/apis/docs/capping-api-usage details on quotaUser attribute
        const QUOTA_USER = nodeBtoa(req.ip || 'unknown')
        if (!req.ip) {
            // This shouldn't happen but defaulting value just in case
            console.log('User request "unknown"', req.originalUrl)
        }
        const REQUEST_PARAMS = Object.assign(req.query, {key: process.env.API_V3_KEY, quotaUser: QUOTA_USER})
        const REQUEST_URL = "https://www.googleapis.com/youtube/v3/" + REQUEST_PATH + "?" + new URLSearchParams(REQUEST_PARAMS).toString()

        let cached = requestCache.get(CACHE_KEY);
        if (cached) {
            addDebugCount(REQUEST_PATH, true);
            return res.status(cached.status).send(cached.json)
        }

        const response = await fetch(REQUEST_URL, {method: 'GET'});
        const resultJson = await response.json();

        if (response.status !== 200) {
            console.log("Request failed", response.status, CACHE_KEY)
        }

        addDebugCount(REQUEST_PATH, false)

        requestCache.set(CACHE_KEY, {status: response.status, json: resultJson});
        res.status(response.status).send(resultJson)
    } catch (e) {
        console.error("Error 500", req.originalUrl, e);
        res.status(500).send({message: 'A problem occurred'})
    }
});

server.listen(process.env.PORT || 3000, () => {
    console.log('listening on *:3000');
});
