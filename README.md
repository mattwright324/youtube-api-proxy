# YouTube API Proxy

Self-host a user rate-limited YouTube API proxy (must provide your own key for v3).
Requests to V3 make use of the requester's IP as the `quotaUser` parameter so you can enforce your project's
`Queries per minute per user` limit.

```
GET https://ytapi.example.com/v1/resolve_url?url=https://www.youtube.com/@VanityUrl
    -> POST https://youtubei.googleapis.com/youtubei/v1/navigation/resolve_url

GET https://ytapi.example.com/v3/videos?part=snippet&id=dQw4w9WgXcQ 
    -> GET https://www.googleapis.com/youtube/v3/videos?part=snippet&id=dQw4w9WgXcQ
```

## Build

Make a copy of `.env.template` as your `.env` and fill in missing properties.
Check the YouTube API section below to get your own API key and determine allowed paths & parameters.

Make sure dependencies are installed then run

```shell
$ npm install
$ npm run start
```

- http://localhost:3000
- http://localhost:3000/v1/resolve_url?url=https://www.youtube.com/@RickAstleyVEVO
- http://localhost:3000/v3/videos?part=snippet&id=dQw4w9WgXcQ
- http://localhost:3000/v3/videoCategories?part=snippet&regionCode=US

## YouTube API

A YouTube API key is required in your `.env` API_V3_KEY property.

- https://console.cloud.google.com/apis/dashboard
- https://developers.google.com/youtube/v3/getting-started
- https://developers.google.com/youtube/v3/docs
