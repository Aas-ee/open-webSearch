# Core, Runtime, and Adapter Boundaries

This document defines the module boundaries required before adding CLI and daemon features.

## Proposed layers

## 1. Core

Core contains transport-agnostic business capabilities.

Responsibilities:
- search dispatch
- engine normalization
- limit distribution
- URL validation for fetch operations
- canonical result shaping
- canonical error shaping

Core should not know about:
- MCP tool registration
- Express routes
- CLI argument parsing
- stdio/http session handling

## 2. Shared runtime / service container

The runtime layer owns stateful and reusable services.

Responsibilities:
- configuration loading and caching
- shared HTTP client setup
- browser / Playwright lifecycle
- cookie and session helpers
- health / readiness state
- service object construction

This should be the single place that wires:
- config
- engine services
- fetch services
- browser access
- future daemon state

## 3. Adapters

Adapters translate protocol-specific input/output to core calls.

Adapters planned:
- MCP adapter
- local HTTP adapter
- CLI control layer

Adapter responsibilities:
- parse transport-specific arguments
- call core/runtime services
- format transport-specific responses

Adapter anti-goals:
- no business logic forks
- no custom search dispatch
- no separate config system

## Proposed service surface

The following service interfaces should exist before CLI or daemon work expands:

## Search service

Input:
- `query`
- `engines`
- `limit`

Output:
- normalized search result list
- metadata about engines used and partial failures

## Web fetch service

Input:
- `url`
- operation-specific options such as `maxChars`

Output:
- structured fetch payload or canonical error

## Readme/article fetch service

Input:
- target URL

Output:
- structured content payload or canonical error

## Validation helpers

Provide reusable checks for:
- public HTTP(S) URLs
- GitHub repository URL forms
- engine names
- operation-specific limits

## Current file mapping

Likely extraction sources:
- [src/tools/setupTools.ts](/mnt/d/env/webstorm/webstromproject/open-websearch/src/tools/setupTools.ts)
- [src/config.ts](/mnt/d/env/webstorm/webstromproject/open-websearch/src/config.ts)
- [src/utils/httpRequest.ts](/mnt/d/env/webstorm/webstromproject/open-websearch/src/utils/httpRequest.ts)
- [src/utils/playwrightClient.ts](/mnt/d/env/webstorm/webstromproject/open-websearch/src/utils/playwrightClient.ts)

Likely engine-specific dependencies remain under:
- `src/engines/*`

## Runtime container sketch

Suggested module shape:

```text
src/core/
  models/
  services/
  validation/
src/runtime/
  createRuntime.ts
  runtimeTypes.ts
src/adapters/
  mcp/
  http/
  cli/
```

Possible runtime constructor:

```ts
type OpenWebSearchRuntime = {
  config: AppConfig;
  services: {
    search: SearchService;
    fetchWeb: FetchWebService;
    fetchGithubReadme: GithubReadmeService;
    fetchCsdn: ArticleFetchService;
    fetchJuejin: ArticleFetchService;
  };
  health: RuntimeHealthService;
};
```

## Error model requirement

Before adapters multiply, define one shared error shape.

Suggested fields:
- `code`
- `message`
- `retryable`
- `hint`
- `details`

This avoids MCP, CLI, and local HTTP inventing different error semantics.
