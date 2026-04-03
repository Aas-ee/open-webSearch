---
name: open-websearch-maintainer
description: Maintain and extend the open-websearch MCP server. Trigger when changing search engines, proxy or TLS behavior, tool registration, live parsing behavior, or compatibility and regression behavior inside this repository.
version: 1.2.0
version_note: Routes changes by surface area, keeps scope tight, preserves shared networking and tool contracts, and treats current repository behavior as the source of truth.
---

# Open WebSearch Maintainer

Use this skill when modifying the `open-websearch` codebase itself.

If this skill and the current repository behavior disagree, trust the repository code, tests, and intended change scope, then update the skill or docs before finishing.

## First classify the change

- Engine change: new engine, engine parsing, engine pagination, anti-bot handling.
- Network change: proxy, TLS, request builder, Playwright interaction, browser fallback.
- Tool surface change: MCP tool registration, schema, engine normalization, config exposure.
- Validation-only change: tests, docs, or release hygiene when no code-path behavior changes are intended.

Use this classification as the execution entrypoint. Start by choosing one category, load only the checklist that matches it, and expand scope only when the changed code path actually crosses that boundary.

## Scope discipline

- Keep fixes as local as the real failure surface allows.
- Do not turn a parsing or engine-specific issue into a shared networking refactor without evidence.
- Do not widen insecure or compatibility-relaxing behavior just to make one test pass.
- Do not change tool contracts or global behavior unless the change is intentional, verified, and documented.

## Core rules

- Keep MCP tool contracts stable unless the change explicitly requires a breaking change.
- Route Axios-based networking through the shared HTTP request builder instead of ad hoc proxy handling.
- Treat proxy, TLS, and Playwright behavior as cross-cutting concerns. Verify them explicitly after changes.
- Update tests and README files when adding engines or changing behavior.

## Do not

- Do not bypass the shared HTTP request builder for a one-off engine fix.
- Do not silently fork proxy behavior in a single engine unless the repository explicitly adopts that policy.
- Do not widen insecure TLS behavior beyond the narrow code path that requires it.
- Do not change tool contracts without checking tests, config handling, and README files.
- Do not touch shared networking code if the change is only about result parsing or docs.

## Change checklist

When adding or changing a search engine:
- update `src/config.ts`
- update `src/tools/setupTools.ts`
- add or update engine tests
- update `README.md` and `README-zh.md`

When changing network behavior:
- prefer `src/utils/httpRequest.ts`
- keep `proxy: false` behavior explicit for Axios
- keep insecure TLS opt-in and scoped only where necessary

## Validation

- Run TypeScript checks first.
- Run targeted tests for the touched area.
- Run live tests when the change depends on real network behavior.

## Review focus

- pagination and empty-result handling
- anti-bot / verification page detection
- proxy interactions with `USE_PROXY` and `PROXY_URL`
- request-mode versus Playwright-mode behavior
- documentation drift

Read [references/workflow.md](references/workflow.md) when implementing changes and [references/validation.md](references/validation.md) before finalizing a patch.
