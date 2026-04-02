# Open WebSearch Architecture Overview

This document defines the corrected evolution path for `open-websearch` as a combined MCP + CLI + daemon product.

## Target shape

```text
                +----------------------+
                |   Core APIs          |
                | search/fetch/validate|
                +----------+-----------+
                           |
                +----------v-----------+
                | Shared Runtime /     |
                | Service Container    |
                | config/state/cache   |
                | browser lifecycle    |
                +-----+-----------+----+
                      |           |
          +-----------v--+     +--v----------------+
          | MCP Adapter  |     | Local HTTP Adapter|
          | stdio/http   |     | localhost service |
          +-----------+--+     +--+----------------+
                      |           |
                  MCP clients     | localhost HTTP
                                  |
                         +--------v--------+
                         | CLI Control     |
                         | search/fetch/...|
                         | serve/status    |
                         +--------+--------+
                                  |
                    skill prefers CLI/daemon, keeps MCP compatibility
```

## Product principles

- `core` owns business behavior.
- `shared runtime` owns initialization, configuration, and reusable state.
- MCP and local HTTP are transport adapters over the same runtime.
- CLI is a control surface, not a second business implementation.
- Skill should prefer the low-friction path later, but MCP remains a first-class standard capability layer.

## Current code pressure points

- [src/tools/setupTools.ts](/mnt/d/env/webstorm/webstromproject/open-websearch/src/tools/setupTools.ts) currently mixes:
  - MCP-specific schema registration
  - argument handling and normalization
  - runtime service invocation
  - MCP-specific result mapping
- [src/index.ts](/mnt/d/env/webstorm/webstromproject/open-websearch/src/index.ts) currently coordinates both CLI dispatch and MCP bootstrapping, so it is thinner than before but still carries more entrypoint logic than the long-term target shape.

These two files should become thinner adapters after Phase 1.

## Phase plan

## Phase 1: Extract core

Goal:
- move search/fetch orchestration, normalization, validation helpers, and result shaping into shared services

Deliverables:
- core API boundary
- shared result/error model
- MCP adapter reduced to schema registration and argument/result mapping

Do not do yet:
- daemon
- background process management
- protocol expansion

## Phase 2: Add one-shot CLI

Goal:
- validate product surface and stable machine-readable output

Commands to support first:
- `open-websearch search`
- `open-websearch fetch-web`
- `open-websearch fetch-csdn`
- `open-websearch fetch-juejin`
- `open-websearch fetch-github-readme`

Requirements:
- human-readable default output
- `--json` machine-readable output
- structured error output

## Phase 3: Add local daemon

Goal:
- reduce cold-start cost
- reuse browser/runtime state
- support frequent skill-driven calls

First transport:
- localhost HTTP only

Commands to support:
- `open-websearch serve`
- `open-websearch status`

Default CLI behavior:
- do not silently spawn the daemon
- support explicit `--spawn`

## Phase 4: Skill integration

Goal:
- make `open-websearch` easier to use from the skill layer

Rule:
- skill may prefer CLI/daemon for lower friction
- skill must keep MCP compatibility when capability already exists
- CLI does not replace MCP

## Design decisions already locked

- daemon v1 uses localhost HTTP
- CLI does not silently auto-start daemon by default
- MCP adapter and local HTTP adapter should share one runtime container
- output protocol must stabilize before the skill depends on CLI

## Current source-of-truth documents

The following documents should now be treated as the primary contract references for the current CLI/daemon behavior:
- [cli-json-protocol.md](/mnt/d/env/webstorm/webstromproject/open-websearch/docs/architecture/cli-json-protocol.md)
- [local-http-adapter.md](/mnt/d/env/webstorm/webstromproject/open-websearch/docs/architecture/local-http-adapter.md)

## Risks to validate early

- whether core extraction can preserve current MCP behavior without regressions
- whether shared runtime can hold Playwright/browser state safely for both adapters
- whether CLI `--json` is stable enough for skill consumption
- how to distinguish:
  - daemon healthy
  - runtime initialized
  - capability active
  - activation pending reconnect/reload
