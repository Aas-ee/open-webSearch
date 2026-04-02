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

## `fetchWebContent`

Use for:
- reading a specific public HTTP(S) page
- extracting article or documentation text from a known URL
- confirming details from a search result before summarizing

Notes:
- supports Markdown files and normal public pages
- may fail on pages that require browser cookies or unusual TLS chains
- `FETCH_WEB_INSECURE_TLS` applies only here
- do not jump to TLS or environment explanations for an ordinary fetch failure; first try a better source URL, a more stable result, or a clearer page target

## `fetchGithubReadme`

Use for:
- GitHub repository URLs
- fast repository understanding before reading source files

Prefer this over `fetchWebContent` when the input is clearly a repository URL.
