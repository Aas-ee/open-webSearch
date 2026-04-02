# CLI and Daemon Machine Contract

This document defines the current machine-readable contract for the CLI control surface and its interaction with the local daemon.

## Goals

- stable enough for skill consumption
- simple enough for humans to inspect
- consistent across commands
- explicit about fallback and activation behavior

## Commands in scope

- `open-websearch search`
- `open-websearch fetch-web`
- `open-websearch fetch-csdn`
- `open-websearch fetch-juejin`
- `open-websearch fetch-linuxdo`
- `open-websearch fetch-github-readme`
- `open-websearch status`
- `open-websearch serve`

## Output modes

- default: human-readable
- `--json`: machine-readable and stable

Skill-facing integrations should rely on `--json`, not the human-readable format.

## Exit code contract

- `0`
  - command succeeded
- `1`
  - command failed with a structured error or validation failure
- `130`
  - shell-level interruption such as `SIGINT` during a parent shell smoke; do not treat this as a command-specific application code

`serve` is special:
- the command stays in the foreground after startup
- it exits only after `SIGINT` or `SIGTERM`
- successful shutdown resolves with application exit code `0`

## Common envelope

Successful output:

```json
{
  "status": "ok",
  "data": {},
  "error": null,
  "hint": null
}
```

Failed output:

```json
{
  "status": "error",
  "data": null,
  "error": {
    "code": "daemon_unavailable",
    "message": "Local open-websearch service is not running",
    "retryable": true,
    "details": {}
  },
  "hint": "Run `open-websearch serve` or retry with --spawn"
}
```

The common fields are:
- `status`
  - `ok` or `error`
- `data`
  - command-specific success payload, otherwise `null`
- `error`
  - machine-readable error object, otherwise `null`
- `hint`
  - optional next step for users or skill flows

## Core error codes currently used

- `invalid_arguments`
- `validation_failed`
- `not_found`
- `engine_error`
- `daemon_unavailable`

These are the codes a skill or plugin integration should expect first.

## Search command

Example:

```json
{
  "status": "ok",
  "data": {
    "query": "open web search",
    "engines": ["startpage"],
    "totalResults": 5,
    "results": [
      {
        "title": "Example",
        "url": "https://example.com",
        "description": "Example description",
        "source": "example.com",
        "engine": "startpage"
      }
    ],
    "partialFailures": []
  },
  "error": null,
  "hint": null
}
```

Notes:
- default engine resolution follows runtime/config defaults
- `searchMode` may be provided per request and currently only affects Bing
- if a local daemon is reachable, CLI may satisfy the request through daemon HTTP
- if the daemon is unavailable and no explicit daemon target was requested, CLI may fall back to direct runtime execution

## Fetch command

### Example: `fetch-web`

```json
{
  "status": "ok",
  "data": {
    "url": "https://example.com",
    "title": "Example",
    "content": "...",
    "truncated": false
  },
  "error": null,
  "hint": null
}
```

`fetch-web` returns the full structured payload from the web fetch service, including fields such as:
- `url`
- `finalUrl`
- `contentType`
- `title`
- `retrievalMethod`
- `truncated`
- `content`

### Example: article and README fetch commands

This shape applies to:
- `fetch-github-readme`
- `fetch-csdn`
- `fetch-juejin`
- `fetch-linuxdo`

```json
{
  "status": "ok",
  "data": {
    "url": "https://github.com/nodejs/node",
    "content": "# Node.js\n..."
  },
  "error": null,
  "hint": null
}
```

These commands do not currently promise the same payload shape as `fetch-web`.

## Status command

Example:

```json
{
  "status": "ok",
  "data": {
    "daemon": "running",
    "runtime": "ready",
    "activation": "active",
    "version": "2.x.x",
    "baseUrl": "http://127.0.0.1:3210",
    "capabilities": [
      "search",
      "fetch-web",
      "fetch-csdn",
      "fetch-juejin",
      "fetch-github-readme",
      "fetch-linuxdo"
    ],
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

Notes:
- `status` must treat `/status` as an envelope, not as an always-success payload
- in non-JSON mode, CLI prints a human-readable status summary on success
- in non-JSON mode, CLI prints error message and hint on an error envelope

## CLI daemon interaction rules

Default behavior:
- action commands first try the local daemon
- if the daemon is unavailable and no explicit daemon target was requested, CLI falls back to direct runtime execution
- `status` never falls back to direct runtime; it always probes the daemon

Explicit daemon behavior:
- `--daemon-url`
  - forces CLI to target the specified daemon URL
  - if unreachable, CLI returns `daemon_unavailable`
  - no silent fallback to direct runtime
- `--spawn`
  - only applies when the daemon is unreachable
  - attempts to start a local daemon for the requested local daemon URL
  - waits for health before retrying once
  - is intentionally explicit; CLI does not silently spawn by default

CLI search arguments also support:
- `--search-mode request|auto|playwright`
  - request-level override
  - currently only affects Bing

## Serve and status lifecycle

- `open-websearch serve`
  - starts the local daemon in the foreground
  - prints the daemon base URL
  - remains alive until `SIGINT` or `SIGTERM`
  - closes the daemon cleanly before exit
- `open-websearch status`
  - probes `/status`
  - returns success or a structured daemon error envelope

## Testing notes

The following command groups are part of the current contract verification surface:
- `npm run test:cli`
- `npm run test:local-daemon`
- `npm run test:mcp-adapter`

Network-sensitive tests are separate from this contract:
- `test:startpage` may depend on outbound connectivity or local proxy settings
- direct Startpage access may time out in restricted environments; a verified workaround is `USE_PROXY=true PROXY_URL=http://127.0.0.1:7890 npm run test:startpage`
- live web tests should be treated as environment-sensitive verification, not as pure contract checks
