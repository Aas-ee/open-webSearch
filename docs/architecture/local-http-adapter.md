# Local HTTP Adapter Contract

This document defines the current localhost HTTP contract exposed by the local daemon.

## Decision

Daemon v1 uses localhost HTTP.

Reasons:
- cross-platform
- easy to debug
- easy to probe from CLI and skill flows
- simple health and smoke checks

Not in v1:
- Unix sockets
- named pipes

## Runtime model

The local HTTP adapter should sit on top of the same shared runtime used by the MCP adapter.

There should be one runtime container and two protocol front doors:
- MCP
- local HTTP

## Binding model

Recommended default:
- bind to `127.0.0.1`
- use a configurable port

This adapter is for local use and local automation, not public exposure.

## Route contract

## Health and status

- `GET /health`
  - liveness only
  - success payload:
    - `data.daemon = "running"`
- `GET /status`
  - daemon state
  - runtime readiness
  - activation state
  - version
  - daemon base URL
  - available operations
  - config summary

Current `GET /status` success payload includes:
- `daemon`
- `runtime`
- `activation`
- `version`
- `capabilities`
- `baseUrl`
- `configSummary`

## Operations

- `POST /search`
- `POST /fetch-web`
- `POST /fetch-csdn`
- `POST /fetch-juejin`
- `POST /fetch-github-readme`
- `POST /fetch-linuxdo`

## Optional future routes

- `POST /reload`
- `POST /shutdown`

These should not block v1.

## Response model

Routes should reuse the same logical envelope planned for CLI JSON output:
- `status`
- `data`
- `error`
- `hint`

CLI should be a thin client over these routes.

## Validation states

The contract currently distinguishes:
- `daemon = running`
- `runtime = ready`
- `activation = active`

Future states may extend this, but should not silently change the meaning of the current fields.

This is necessary so CLI and skill flows can say:
- `capability active`
- `setup completed, activation pending`
- `setup incomplete or failed`

## Serve and status commands

Current command relationship:
- `open-websearch serve`
  - starts the local HTTP adapter
  - stays in the foreground until interrupted
- `open-websearch status`
  - checks `/status`
- action commands like `search` or `fetch-web`
  - call local HTTP routes
  - may use `--spawn` to start the daemon explicitly

## Capability naming note

Current daemon capability names are CLI/HTTP-oriented:
- `search`
- `fetch-web`
- `fetch-csdn`
- `fetch-juejin`
- `fetch-github-readme`
- `fetch-linuxdo`

This is intentionally not the same naming layer as MCP tool names.
The mapping question should be treated as a compatibility decision, not changed casually.
