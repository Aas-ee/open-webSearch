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

Stage script:
1. Collect prerequisites.
   - First check whether the command is already available.
   - Confirm whether the user wants a quick one-shot path or a reusable local CLI/daemon path.
   - Confirm whether the environment needs npm proxy, npm mirror, or runtime proxy settings.
   - Check whether the user already has a reusable local checkout instead of needing package installation.
   - If daemon startup is expected to be followed immediately by live `search`, `fetch-web`, or other public-page retrieval, confirm runtime proxy needs before starting the daemon. If the goal is only `serve` plus `status`, runtime proxy can wait.
2. Confirm risky actions.
   - Ask before package installation, global installation, daemon startup, or MCP/client config changes.
3. Perform the smallest matching action.
   - If the command already exists, reuse it.
   - If package installation is needed, guide installation before writing config.
   - Start or validate the local daemon path with explicit commands: `open-websearch serve` to start and `open-websearch status` to check readiness.
   - Do not treat bare `open-websearch` as the recommended daemon start command for agent automation.
   - If the host runtime still needs MCP exposure, only then add or adjust MCP/client config.
4. Validate.
   - Confirm daemon readiness with `open-websearch status`.
   - If possible, run a minimal one-shot smoke check.
   - Do not treat installation alone as completion.
5. If package installation hangs, times out, or fails on network access, suspect proxy or mirror configuration before treating it as an `open-websearch` failure.

Useful npm-oriented guidance:
- One-shot proxied installs may work better with explicit npm flags such as `npm --proxy ... --https-proxy ... install ...`.
- Persistent npm access may work better with `npm config set proxy`, `npm config set https-proxy`, and `npm config set registry`.
- Do not assume runtime env vars like `USE_PROXY` or `PROXY_URL` will fix npm package downloads; they are for `open-websearch` runtime traffic, not npm registry access.
- Keep that distinction explicit: npm proxy or registry settings help installation, while runtime proxy settings affect the networked search/fetch work that happens after `open-websearch serve`.

## Existing MCP mode

Use when:
- the workspace already should expose `open-websearch` tools
- the likely problem is validation, reconnection, or reload

Stage script:
1. Collect prerequisites.
   - Confirm whether the current runtime should already see the tools.
   - Confirm whether the issue is activation/reconnection rather than installation.
2. Confirm risky actions.
   - Ask before changing MCP/client config or reconnecting a running client in a way that changes the user's environment.
3. Perform.
   - Reconnect, reload, or update the relevant client config only as needed.
4. Validate.
   - Confirm that the runtime now exposes the core tools.
   - Do not stop at “config updated”; verify tool visibility.

## Local source/build mode

Use when:
- the user already has a local repository checkout
- a local project entrypoint such as `node build/index.js` is more appropriate than reinstalling
- reusing the current checkout is smaller than creating a second install path

Stage script:
1. Collect prerequisites.
   - Check whether the local build output or entrypoint exists.
   - Confirm that reusing the current checkout is smaller than creating a second install path.
2. Confirm risky actions.
   - Ask before changing local config, wiring that entrypoint into MCP/client config, or starting a long-lived daemon from that checkout.
3. Perform.
   - Reuse that local entrypoint to start or validate the local daemon path.
   - If needed, reuse that same entrypoint in MCP/client configuration.
4. Validate.
   - Confirm that the entrypoint actually works.
   - Confirm that the runtime now exposes the core tools or a working local path.

## Existing HTTP endpoint mode

Use when:
- the user already has a reachable `open-websearch` HTTP endpoint
- the goal is to connect the current workspace, not create a new local server

Stage script:
1. Collect prerequisites.
   - Confirm the endpoint details.
   - Confirm that connecting to the existing endpoint is smaller than creating a new local process.
2. Confirm risky actions.
   - Ask before writing endpoint-related config or switching the current workflow to a different remote/local HTTP service.
3. Perform.
   - Configure CLI or MCP/client access to that endpoint as needed.
4. Validate.
   - Validate connectivity first.
   - Then check that the core tools or equivalent path appear.

## Browser-assisted / Playwright mode

Use when:
- the user explicitly wants Bing Playwright mode
- Bing auto fallback is expected but browser support is missing
- browser-assisted cookie retry or browser-rendered HTML is needed
- request mode is insufficient and the failure strongly suggests browser-only content or blocked request-mode access

Stage script:
1. Collect prerequisites.
   - First distinguish ordinary search/fetch setup from browser-assisted setup.
   - Do not suggest Playwright installation for ordinary search, `fetchWebContent`, or `fetchGithubReadme` unless browser assistance is actually needed.
   - Confirm whether the user already has a Playwright client, a browser binary, or a remote browser endpoint.
2. Confirm risky actions.
   - Ask before installing Playwright packages, downloading browser binaries, or changing browser endpoint configuration.
3. Perform the smallest fitting path.
   - local install: `npm install playwright` and `npx playwright install chromium`
   - existing browser binary with a Playwright client (commonly `playwright-core`) and `PLAYWRIGHT_EXECUTABLE_PATH`
   - existing Playwright package via `PLAYWRIGHT_MODULE_PATH`
   - existing remote browser via `PLAYWRIGHT_WS_ENDPOINT` or `PLAYWRIGHT_CDP_ENDPOINT`
4. Validate.
   - Validate the browser-assisted path before claiming success.
   - If the user specifically wants Bing Playwright mode, verify that the browser-assisted path is actually reachable.
5. If Playwright package or browser installation hangs or fails on download, check proxy or npm mirror expectations before retrying.
6. If Playwright is being installed through npm, the same npm proxy or registry guidance applies before treating the failure as a browser-mode problem.

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
