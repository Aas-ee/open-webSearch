# Setup

Use these setup paths only when the current workspace does not yet have a usable `open-websearch` path.

## Choose the smallest matching path

- Prefer validation or reconnection if the user already configured `open-websearch` and the issue is only that the current workspace is not seeing it.
- Prefer local CLI/daemon mode when the runtime can launch `open-websearch` directly and no better existing path is already active.
- Prefer existing MCP validation or reconnection when the workspace is supposed to expose the tools already.
- Prefer an existing HTTP endpoint if the user already has a reachable `open-websearch` server.
- Prefer local source/build mode if the user already has a local checkout with a usable entrypoint.

## Local CLI/daemon mode

Use when:
- the runtime can launch `open-websearch` directly
- the user wants the lowest-friction local setup
- there is no already-working MCP or HTTP path to reuse

Minimal steps:
1. Check whether the command is already available.
2. Before installation, check whether the user needs a proxy or alternate npm registry/mirror.
3. If package installation is needed in a restricted network, ask before proceeding with long-running install steps.
4. If it is not already installed, guide installation before writing config.
5. Start or validate the local daemon path with explicit commands: `open-websearch serve` to start and `open-websearch status` to check readiness.
6. Do not treat bare `open-websearch` as the recommended daemon start command for agent automation.
7. If package installation hangs, times out, or fails on network access, suspect proxy or mirror configuration before treating it as an `open-websearch` failure.
8. If the host runtime still needs MCP exposure, only then add or adjust MCP/client config.

Useful npm-oriented guidance:
- One-shot proxied installs may work better with explicit npm flags such as `npm --proxy ... --https-proxy ... install ...`.
- Persistent npm access may work better with `npm config set proxy`, `npm config set https-proxy`, and `npm config set registry`.
- Do not assume runtime env vars like `USE_PROXY` or `PROXY_URL` will fix npm package downloads; they are for `open-websearch` runtime traffic, not npm registry access.

## Existing MCP mode

Use when:
- the workspace already should expose `open-websearch` tools
- the likely problem is validation, reconnection, or reload

Minimal steps:
1. Confirm whether the current runtime should already see the tools.
2. Check whether the issue is missing activation rather than missing installation.
3. Reconnect, reload, or update the relevant client config only as needed.
4. Validate that the runtime now exposes the core tools.

## Local source/build mode

Use when:
- the user already has a local repository checkout
- a local project entrypoint such as `node build/index.js` is more appropriate than reinstalling
- reusing the current checkout is smaller than creating a second install path

Minimal steps:
1. Check whether the local build output or entrypoint exists.
2. Reuse that local entrypoint to start or validate the local daemon path.
3. If needed, reuse that same entrypoint in MCP/client configuration.
4. Validate that the runtime now exposes the core tools or a working local path.

## Existing HTTP endpoint mode

Use when:
- the user already has a reachable `open-websearch` HTTP endpoint
- the goal is to connect the current workspace, not create a new local server

Minimal steps:
1. Confirm the endpoint details.
2. Prefer connecting the current workflow to that endpoint rather than creating a new local process.
3. Configure CLI or MCP/client access to that endpoint as needed.
4. Validate connectivity and check that the core tools appear.

## Browser-assisted / Playwright mode

Use when:
- the user explicitly wants Bing Playwright mode
- Bing auto fallback is expected but browser support is missing
- browser-assisted cookie retry or browser-rendered HTML is needed
- request mode is insufficient and the failure strongly suggests browser-only content or blocked request-mode access

Minimal steps:
1. First distinguish ordinary search/fetch setup from browser-assisted setup.
2. Do not suggest Playwright installation for ordinary search, `fetchWebContent`, or `fetchGithubReadme` unless browser assistance is actually needed.
3. If browser mode is required, explain that the published package does not bundle Playwright browser binaries by default.
4. Prefer the smallest fitting path:
   - local install: `npm install playwright` and `npx playwright install chromium`
   - existing browser binary with a Playwright client (commonly `playwright-core`) and `PLAYWRIGHT_EXECUTABLE_PATH`
   - existing Playwright package via `PLAYWRIGHT_MODULE_PATH`
   - existing remote browser via `PLAYWRIGHT_WS_ENDPOINT` or `PLAYWRIGHT_CDP_ENDPOINT`
5. After setup, validate the browser-assisted path before claiming success.
6. If Playwright package or browser installation hangs or fails on download, check proxy or npm mirror expectations before retrying.
7. If Playwright is being installed through npm, the same npm proxy or registry guidance applies before treating the failure as a browser-mode problem.

## Validation target

After any setup path:
- check whether the runtime exposes a usable `open-websearch` path
- check whether core tools such as `search`, `fetchWebContent`, and `fetchGithubReadme` are available
- if using a local daemon path, confirm `status` or an equivalent readiness check first
- if possible, run a minimal smoke check

Use these result states:
- `capability active`
- `setup completed, activation pending reload/reconnect`
- `setup incomplete or failed`
