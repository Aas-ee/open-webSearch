# Local Daemon HTTP API

This document describes the current user-facing HTTP API exposed by the local `open-websearch` daemon.

This API is intended for:
- local scripts
- local tooling
- skill or plugin integrations

It is not a public internet API. The daemon binds to `127.0.0.1` by default.

## Start and check

Start the daemon:

```bash
npm run serve
```

Or choose a port:

```bash
node build/index.js serve --port 3211
```

Check status through the CLI:

```bash
npm run status -- --json
npm run status -- --base-url http://127.0.0.1:3211 --json
```

When calling localhost directly, bypass any shell proxy settings:

```bash
curl --noproxy '*' http://127.0.0.1:3210/health
```

## Common response envelope

Success:

```json
{
  "status": "ok",
  "data": {},
  "error": null,
  "hint": null
}
```

Error:

```json
{
  "status": "error",
  "data": null,
  "error": {
    "code": "validation_failed",
    "message": "Use a valid URL"
  },
  "hint": "Retry with a supported input"
}
```

## Endpoints

### `GET /health`

Liveness only.

Example:

```bash
curl --noproxy '*' http://127.0.0.1:3210/health
```

Example response:

```json
{
  "status": "ok",
  "data": {
    "daemon": "running"
  },
  "error": null,
  "hint": null
}
```

### `GET /status`

Returns daemon state, runtime readiness, activation state, version, supported operations, and config summary.

Example:

```bash
curl --noproxy '*' http://127.0.0.1:3210/status
```

Example response:

```json
{
  "status": "ok",
  "data": {
    "daemon": "running",
    "runtime": "ready",
    "activation": "active",
    "version": "2.x.x",
    "capabilities": [
      "search",
      "fetch-web",
      "fetch-csdn",
      "fetch-juejin",
      "fetch-github-readme",
      "fetch-linuxdo"
    ],
    "baseUrl": "http://127.0.0.1:3210",
    "configSummary": {
      "defaultSearchEngine": "bing",
      "allowedSearchEngines": [],
      "searchMode": "request",
      "useProxy": false,
      "fetchWebAllowInsecureTls": false
    }
  },
  "error": null,
  "hint": null
}
```

### `POST /search`

Request body:

```json
{
  "query": "open web search",
  "limit": 3,
  "engines": ["startpage", "bing"],
  "searchMode": "playwright"
}
```

Notes:
- `query` is required
- `limit` is optional, integer `1-50`, default `10`
- `engines` is optional
- `searchMode` is optional: `request`, `auto`, or `playwright`
- `searchMode` currently only affects Bing; other engines ignore it
- if `engines` is omitted, the daemon uses its configured default engine

Example:

```bash
curl --noproxy '*' -X POST http://127.0.0.1:3210/search \
  -H "Content-Type: application/json" \
  -d '{"query":"open web search","limit":3,"engines":["bing"],"searchMode":"playwright"}'
```

### `POST /fetch-web`

Request body:

```json
{
  "url": "https://awiki.ai",
  "maxChars": 30000
}
```

Notes:
- `url` is required
- `maxChars` is optional, integer `1000-200000`, default `30000`
- returns the full structured web-fetch payload

Example:

```bash
curl --noproxy '*' -X POST http://127.0.0.1:3210/fetch-web \
  -H "Content-Type: application/json" \
  -d '{"url":"https://awiki.ai","maxChars":3000}'
```

### `POST /fetch-github-readme`

Request body:

```json
{
  "url": "https://github.com/Aas-ee/open-webSearch"
}
```

Example:

```bash
curl --noproxy '*' -X POST http://127.0.0.1:3210/fetch-github-readme \
  -H "Content-Type: application/json" \
  -d '{"url":"https://github.com/Aas-ee/open-webSearch"}'
```

Success payload shape:

```json
{
  "status": "ok",
  "data": {
    "url": "https://github.com/Aas-ee/open-webSearch",
    "content": "# README\n..."
  },
  "error": null,
  "hint": null
}
```

### `POST /fetch-csdn`

Request body:

```json
{
  "url": "https://blog.csdn.net/..."
}
```

Example:

```bash
curl --noproxy '*' -X POST http://127.0.0.1:3210/fetch-csdn \
  -H "Content-Type: application/json" \
  -d '{"url":"https://blog.csdn.net/weixin_45801664/article/details/149000138"}'
```

### `POST /fetch-juejin`

Request body:

```json
{
  "url": "https://juejin.cn/post/..."
}
```

Example:

```bash
curl --noproxy '*' -X POST http://127.0.0.1:3210/fetch-juejin \
  -H "Content-Type: application/json" \
  -d '{"url":"https://juejin.cn/post/7514613876334721075"}'
```

### `POST /fetch-linuxdo`

Request body:

```json
{
  "url": "https://linux.do/t/topic/123.json"
}
```

Example:

```bash
curl --noproxy '*' -X POST http://127.0.0.1:3210/fetch-linuxdo \
  -H "Content-Type: application/json" \
  -d '{"url":"https://linux.do/t/topic/123.json"}'
```

## Notes

- The local daemon is separate from the MCP HTTP endpoints such as `/mcp` and `/sse`.
- `--daemon-url` and `--spawn` are CLI options, not HTTP request parameters.
- Search latency mostly depends on the selected engine and network conditions, not localhost HTTP overhead.
- Startpage connectivity may depend on outbound network conditions or local proxy availability.
