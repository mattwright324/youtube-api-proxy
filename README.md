# YouTube API Proxy

Self-host a user rate-limited YouTube API proxy (must provide your own key for v3).

```
GET https://ytapi.example.com/v1/resolve_url?url=https://www.youtube.com/@VanityUrl
    -> POST https://youtubei.googleapis.com/youtubei/v1/navigation/resolve_url

GET https://ytapi.example.com/v3/videos?part=snippet&id=dQw4w9WgXcQ 
    -> GET https://www.googleapis.com/youtube/v3/videos?part=snippet&id=dQw4w9WgXcQ
```
