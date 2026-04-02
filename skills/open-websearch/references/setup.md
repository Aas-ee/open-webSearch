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
2. If it is not, guide installation before writing config.
3. Start or validate the local daemon path.
4. Use `status` or an equivalent smoke check to confirm the daemon is ready.
5. If the host runtime still needs MCP exposure, only then add or adjust MCP/client config.

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
