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
            console.log("Cached", cached.status, CACHE_KEY)
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
            console.log("Request", response.status, CACHE_KEY)
        }

        requestCache.set(CACHE_KEY, {status: response.status, json: resultJson});
        res.status(response.status).send(resultJson);
    } catch (e) {
        console.error(e)
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
        const REQUEST_PARAMS = Object.assign(req.query, {key: process.env.API_V3_KEY, quotaUser: req.ip})
        const REQUEST_URL = "https://www.googleapis.com/youtube/v3/" + REQUEST_PATH + "?" + new URLSearchParams(REQUEST_PARAMS).toString()

        let cached = requestCache.get(CACHE_KEY);
        if (cached) {
            console.log("Cached", cached.status, CACHE_KEY)
            return res.status(cached.status).send(cached.json)
        }

        const response = await fetch(REQUEST_URL, {method: 'GET'});
        const resultJson = await response.json();

        if (response.status !== 200) {
            console.log("Request", response.status, CACHE_KEY)
        }

        requestCache.set(CACHE_KEY, {status: response.status, json: resultJson});
        res.status(response.status).send(resultJson)
    } catch (e) {
        console.error(e)
        res.status(500).send({message: 'A problem occurred'})
    }
});

server.listen(process.env.PORT || 3000, () => {
    console.log('listening on *:3000');
});
