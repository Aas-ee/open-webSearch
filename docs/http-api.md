# Local Daemon HTTP API

This document describes the current user-facing HTTP API exposed by the local `open-websearch` daemon.

The daemon is a separate process from MCP HTTP mode. `MODE=http node build/index.js` exposes `GET /health`, `/mcp`, `/sse`, and `/messages` on port `3000`; it does not expose `POST /search`. The endpoints below exist only after starting `node build/index.js serve` (port `3210` by default).

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
      "effectiveSearchMode": "request",
      "playwrightAvailable": false,
      "playwrightUnavailableReason": "Playwright client cannot be loaded (attempts: playwright: Cannot find module 'playwright')",
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
  "limit": 5,
  "engines": ["startpage", "bing", "sogou", "hackernews"],
  "searchMode": "playwright",
  "aggregationMode": "deep",
  "perEngineLimit": 5,
  "ranking": "rrf",
  "engineWeights": {
    "bing": 1.2,
    "startpage": 1,
    "sogou": 0.8
  },
  "dedupe": true
}
```

Notes:
- `query` is required
- `limit` is optional, integer `1-50`, default `10`; it caps the final returned results
- `engines` is optional
- `searchMode` is optional: `request`, `auto`, or `playwright`
- `searchMode` currently only affects Bing; other engines ignore it
- `aggregationMode` is optional: `fast`, `balanced`, or `deep`
  - `fast` preserves the previous distributed candidate budget
  - `balanced` asks each engine for a slightly wider candidate pool
  - `deep` asks each engine for up to `limit` candidates unless `perEngineLimit` is set
- `perEngineLimit` is optional, integer `1-50`; it controls how many candidates each engine may return before final aggregation
- `ranking` is optional: `engine-order` or `rrf`; `balanced` and `deep` default to `rrf`, while `fast` defaults to `engine-order`
- `engineWeights` is optional, object mapping engine names to positive numbers; weights affect RRF scoring
- `dedupe` is optional, boolean, default `true`; when enabled, URLs are normalized and duplicate pages are merged
- if `engines` is omitted, the daemon uses its configured default engine
- when the effective mode is `playwright` but the Playwright configuration is invalid, the daemon returns `status: "error"` with `error.code: "browser_unavailable"`
- every successful search response includes `retrievedAt`, the UTC ISO-8601 time when aggregation completed
- every valid HTTP(S) result URL receives a normalized `sourceDomain`; the legacy `source` field is preserved unchanged
- parsers may include the source page's `dateText`; `publishedAt` is included only when machine-readable date evidence can be normalized confidently, and is otherwise omitted
- aggregated results preserve the original result fields and may include `engines` plus `score`

For Bing's `zh-CN` result page, publication metadata follows these conservative rules:

- dedicated result date nodes and machine-readable zoned `datetime` attributes take precedence
- a snippet fallback is accepted only when the date is at the beginning and immediately followed by `·` or `•`; dates elsewhere in the snippet are ignored
- supported absolute prefixes are `YYYY年M月D日` and `YYYY-MM-DD`; date-only values use Bing `zh-CN` time (`UTC+08:00`)
- supported relative values are numeric days, hours, or minutes in Chinese (`6 天之前`) or English (`3 hours ago`), calculated from the response's single `retrievedAt`
- invalid calendar dates, future timestamps, timezone-less datetimes, unknown formats, and missing evidence never produce `publishedAt`; a trustworthy but unparseable `dateText` may remain for auditing

Response excerpt:

```json
{
  "status": "ok",
  "data": {
    "query": "open web search",
    "engines": ["bing"],
    "retrievedAt": "2026-08-18T08:30:00.000Z",
    "totalResults": 1,
    "results": [
      {
        "title": "Example",
        "url": "https://www.example.com/news/1",
        "description": "...",
        "source": "example.comhttps://www.example.com",
        "sourceDomain": "www.example.com",
        "dateText": "2026-08-18",
        "publishedAt": "2026-08-18T00:00:00.000Z",
        "engine": "bing"
      }
    ],
    "partialFailures": []
  },
  "error": null,
  "hint": null
}
```

Example:

```bash
curl --noproxy '*' -X POST http://127.0.0.1:3210/search \
  -H "Content-Type: application/json" \
  -d '{"query":"open web search","limit":5,"engines":["duckduckgo","bing","startpage"],"aggregationMode":"deep","perEngineLimit":5,"ranking":"rrf","engineWeights":{"bing":1.2},"dedupe":true}'
```

### `POST /fetch-web`

Request body:

```json
{
  "url": "https://awiki.ai",
  "maxChars": 30000,
  "renderMode": "auto",
  "readability": false,
  "includeLinks": false
}
```

Notes:
- `url` is required
- `maxChars` is optional, integer `1000-200000`, default `30000`
- `renderMode` is optional: `request` uses HTTP only, `auto` (default) uses request with browser fallback, and `browser` renders directly with Playwright
- `readability` and `includeLinks` are optional booleans; `includeLinks` applies to successful Readability output
- `browser` returns a clear error if Playwright or its configured browser target is unavailable
- returns the full structured web-fetch payload

Example:

```bash
curl --noproxy '*' -X POST http://127.0.0.1:3210/fetch-web \
  -H "Content-Type: application/json" \
  -d '{"url":"https://awiki.ai","maxChars":3000,"renderMode":"browser"}'
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
