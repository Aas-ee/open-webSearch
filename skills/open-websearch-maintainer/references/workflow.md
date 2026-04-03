# Workflow

## Adding a new engine

1. Create the engine implementation under `src/engines/<engine>/`.
2. Export it from that engine's `index.ts` when needed.
3. Register it in `src/tools/setupTools.ts`.
4. Add it to the default/valid engine config in `src/config.ts`.
5. Add engine normalization coverage if the engine name has aliases or mixed-case input.
6. Update user-facing documentation in both README files.

## Networking conventions

- Use `buildAxiosRequestOptions()` for Axios requests.
- Do not let individual engines drift into separate proxy behavior.
- Keep request headers intentional and minimal.
- Browser fallback should remain explicit and testable.
- If a change only affects parsing logic, avoid widening it into a shared networking refactor.

## Documentation sync

Update these together when behavior changes:
- `README.md`
- `README-zh.md`
- package scripts if a new test or workflow is added

If a change only affects docs or tests, avoid touching MCP tool contracts or shared networking code.
