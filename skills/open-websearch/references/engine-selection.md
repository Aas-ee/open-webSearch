# Engine Selection

Engine choice is heuristic, not mandatory. If a preferred engine is unavailable, restricted, or clearly low quality for the current query, switch to a better available engine.

## Broad public web search

- Prefer `startpage` for general English-language discovery.
- Use `bing` when Startpage is insufficient or when a second broad engine is useful.

## Chinese-language or China-hosted sources

- Use `baidu` for broad Chinese web discovery.
- Use `csdn` for developer blog content and tutorial-style posts.
- Use `juejin` for Chinese developer posts and frontend/backend engineering topics.

## Source-specific retrieval

- Use `fetchGithubReadme` for GitHub repositories.
- Use `fetchWebContent` for a specific article, doc page, or Markdown URL.

## Failure handling

- If `bing` returns verification or anti-bot pages, prefer `SEARCH_MODE=auto` or switch engines.
- If a page fetch fails due to network restrictions, check proxy configuration.
- If `fetchWebContent` fails on a site with a broken certificate chain, only then consider `FETCH_WEB_INSECURE_TLS=true`.
