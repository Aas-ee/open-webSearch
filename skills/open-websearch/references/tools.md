# Tools

These tool-selection notes apply after the `open-websearch` MCP capability is available in the current workspace.

## `search`

Use for:
- finding current information
- comparing multiple public sources
- locating candidate URLs before deeper reading

Returns:
- structured search results with `title`, `url`, `description`, `source`, `engine`

Good follow-up actions:
- fetch one or more result URLs with `fetchWebContent`
- fetch a repository with `fetchGithubReadme`
- use the `hackernews` engine when the goal is specifically to find Hacker News stories or discussions
- if Bing Playwright mode returns no results for a `site:` query, retry once without the `site:` prefix before assuming the search target is empty

## `fetchWebContent`

Use for:
- reading a specific public HTTP(S) page
- extracting article or documentation text from a known URL
- confirming details from a search result before summarizing

Notes:
- supports Markdown files and normal public pages
- accepts `renderMode`: `request` is HTTP-only, `auto` (default) is request-first with browser fallback, and `browser` renders directly with Playwright
- use `browser` when the user explicitly needs client-rendered content; it returns a clear error when Playwright or its browser target is unavailable
- may fail on pages that require browser cookies, unusual TLS chains, or browser capabilities that are not configured
- if the user wants cleaner extracted content or wants to preserve in-content links for follow-up multi-page research, prefer the optional Readability path for `fetch-web`; do not assume it is best for every page
- `FETCH_WEB_INSECURE_TLS` applies only to the request leg; it does not change Playwright browser TLS handling
- do not jump to TLS or environment explanations for an ordinary fetch failure; first try a better source URL, a more stable result, or a clearer page target
- do not assume arbitrary homepages or JS-heavy landing pages will yield readable article text; often it is better to search first and then fetch a more specific result page

## `fetchGithubReadme`

Use for:
- GitHub repository URLs
- fast repository understanding before reading source files

Prefer this over `fetchWebContent` when the input is clearly a repository URL.
