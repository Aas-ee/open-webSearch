// tools/setupTools.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
    normalizeEngineName,
    resolveRequestedEngines,
    SUPPORTED_SEARCH_ENGINES,
    SupportedSearchEngine
} from '../core/search/searchEngines.js';
import {
    validateArticleUrl,
    validateGithubRepositoryUrl,
    validatePublicWebUrl
} from '../core/validation/targetValidation.js';
import { OpenWebSearchRuntime } from '../runtime/runtimeTypes.js';
import { AppConfig, checkPlaywrightModeConfiguration } from '../config.js';
export { normalizeEngineName };

// 获取工具名称，优先使用环境变量，否则使用默认值
function getToolName(envVarName: string, defaultName: string): string {
    const configuredName = process.env[envVarName];
    if (configuredName) {
        // Validate tool name to ensure it follows MCP naming conventions
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(configuredName)) {
            console.warn(`Invalid tool name "${configuredName}" from environment variable ${envVarName}. Using default: "${defaultName}"`);
            return defaultName;
        }
        console.error(`Using custom tool name "${configuredName}" for ${envVarName}`);
        return configuredName;
    }
    return defaultName;
}

export const setupTools = (server: McpServer, runtime: OpenWebSearchRuntime): void => {
    // Get configurable tool names from environment variables
    const searchToolName = getToolName('MCP_TOOL_SEARCH_NAME', 'search');
    const fetchLinuxDoToolName = getToolName('MCP_TOOL_FETCH_LINUXDO_NAME', 'fetchLinuxDoArticle');
    const fetchCsdnToolName = getToolName('MCP_TOOL_FETCH_CSDN_NAME', 'fetchCsdnArticle');
    const fetchGithubToolName = getToolName('MCP_TOOL_FETCH_GITHUB_NAME', 'fetchGithubReadme');
    const fetchJuejinToolName = getToolName('MCP_TOOL_FETCH_JUEJIN_NAME', 'fetchJuejinArticle');
    const fetchWebToolName = getToolName('MCP_TOOL_FETCH_WEB_NAME', 'fetchWebContent');

    // 搜索工具
    // 生成搜索工具的动态描述
    // 按 SEARCH_MODE 决定 searchMode 参数的暴露与提示语：
    // - 强制模式（request/playwright）：不暴露 searchMode 参数、不生成 searchMode 提示语；
    // - auto 模式：检查 Playwright 配置是否真实可用：
    //   - 可用：暴露 searchMode 参数，并引导 Agent 默认保持 auto、仅在 request 结果失败或异常时重试 playwright；
    //   - 不可用：按强制 request 处理，同样不暴露参数、不生成提示语。
    const autoWithPlaywrightAvailable =
        runtime.config.searchMode === 'auto' && checkPlaywrightModeConfiguration(runtime.config).available;

    const getSearchDescription = () => {
        const searchModeDescription = autoWithPlaywrightAvailable
            ? ' searchMode meanings: request performs plain HTTP scraping, playwright drives a real browser through Playwright, and auto or omitting searchMode lets the server decide (request first, falling back to Playwright when it is blocked). Start with the default auto (or omit searchMode). Only retry the same query with searchMode=playwright when the request-based results fail, come back empty, or are clearly blocked or low-quality, for example anti-bot or verification pages.'
            : '';
        if (runtime.config.allowedSearchEngines.length === 0) {
            return `Search the web using multiple engines (e.g., Baidu, Bing, DuckDuckGo, CSDN, Exa, Brave, Juejin(掘金), Startpage, Sogou(搜狗), Hacker News) with no API key required.${searchModeDescription}`;
        } else {
            const enginesText = runtime.config.allowedSearchEngines.map(e => {
                switch (e) {
                    case 'juejin':
                        return 'Juejin(掘金)';
                    case 'startpage':
                        return 'Startpage';
                    case 'sogou':
                        return 'Sogou(搜狗)';
                    case 'hackernews':
                        return 'Hacker News';
                    default:
                        return e.charAt(0).toUpperCase() + e.slice(1);
                }
            }).join(', ');
            return `Search the web using these engines: ${enginesText} (no API key required).${searchModeDescription}`;
        }
    };

    // 生成搜索引擎选项的枚举
    const getEnginesEnum = () => {
        // 如果没有限制，使用所有支持的引擎
        const allowedEngines = runtime.config.allowedSearchEngines.length > 0
            ? runtime.config.allowedSearchEngines
            : [...SUPPORTED_SEARCH_ENGINES];

        return z.enum(allowedEngines as [string, ...string[]]);
    };

    const getEngineInputSchema = () => {
        const enginesEnum = getEnginesEnum();
        return z.string()
            .min(1, "Engine value must not be empty")
            .transform((engine) => normalizeEngineName(engine))
            .pipe(enginesEnum);
    };

    // searchMode 参数只在 SEARCH_MODE=auto 且 Playwright 配置真实可用时暴露给 Agent；
    // 强制 request/playwright 以及 auto 但 Playwright 不可用退回 request 的场景都不注册该参数，
    // Agent 无法指定。
    const searchModeSchema = z.enum(['request', 'auto', 'playwright'])
        .describe('Optional search mode override. Start with the default auto (or omit searchMode); only retry with playwright when the request-based results fail, come back empty, or are clearly blocked or low-quality.')
        .optional();

    const enginesInputSchema = z.array(getEngineInputSchema()).min(1).default([runtime.config.defaultSearchEngine])
        .transform(requestedEngines => resolveRequestedEngines(
            requestedEngines,
            runtime.config.allowedSearchEngines,
            runtime.config.defaultSearchEngine
        ) as [SupportedSearchEngine, ...SupportedSearchEngine[]]);

    const searchBaseSchema = {
        query: z.string().min(1, "Search query must not be empty"),
        limit: z.number().min(1).max(50).default(10),
        engines: enginesInputSchema
    };

    type SearchToolInput = {
        query: string;
        limit: number;
        searchMode?: AppConfig['searchMode'];
        engines: [SupportedSearchEngine, ...SupportedSearchEngine[]];
    };

    const executeSearch = async ({query, limit, searchMode, engines}: SearchToolInput) => {
        try {
            const resolvedEngines = resolveRequestedEngines(
                engines ?? [runtime.config.defaultSearchEngine],
                runtime.config.allowedSearchEngines,
                runtime.config.defaultSearchEngine
            ) as [SupportedSearchEngine, ...SupportedSearchEngine[]];

            console.error(`Searching for "${query}" using engines: ${resolvedEngines.join(', ')}`);

            const searchResult = await runtime.services.search.execute({
                query,
                engines: resolvedEngines,
                limit,
                searchMode
            });
            for (const failure of searchResult.partialFailures) {
                console.error(`Search failed for engine ${failure.engine}:`, failure.message);
            }

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        query: searchResult.query,
                        engines: searchResult.engines,
                        totalResults: searchResult.totalResults,
                        results: searchResult.results,
                        partialFailures: searchResult.partialFailures
                    }, null, 2)
                }]
            };
        } catch (error) {
            console.error('Search tool execution failed:', error);
            // 生效模式为 playwright 而配置无效：返回清晰错误，而非外层成功。
            const errorCode = (error as { code?: unknown })?.code;
            const isBrowserUnavailable = errorCode === 'browser_unavailable';
            return {
                content: [{
                    type: 'text' as const,
                    text: isBrowserUnavailable
                        ? `Search failed: browser_unavailable. ${error instanceof Error ? error.message : 'Unknown error'}`
                        : `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
                }],
                isError: true
            };
        }
    };

    if (autoWithPlaywrightAvailable) {
        server.tool(
            searchToolName,
            getSearchDescription(),
            {...searchBaseSchema, searchMode: searchModeSchema},
            ({query, limit, searchMode, engines}) => executeSearch({query, limit, searchMode, engines})
        );
    } else {
        server.tool(
            searchToolName,
            getSearchDescription(),
            searchBaseSchema,
            ({query, limit, engines}) => executeSearch({query, limit, engines})
        );
    }

    // 获取 Linux.do 文章工具
    server.tool(
        fetchLinuxDoToolName,
        "Fetch full article content from a linux.do post URL",
        {
            url: z.string().url().refine(
                (url) => validateArticleUrl(url, 'linuxdo'),
                "URL must be from linux.do and end with .json"
            )
        },
        async ({url}) => {
            try {
                console.error(`Fetching Linux.do article: ${url}`);
                const result = await runtime.services.fetchLinuxDoArticle.execute({ url });

                return {
                    content: [{
                        type: 'text',
                        text: result.content
                    }]
                };
            } catch (error) {
                console.error('Failed to fetch Linux.do article:', error);
                return {
                    content: [{
                        type: 'text',
                        text: `Failed to fetch article: ${error instanceof Error ? error.message : 'Unknown error'}`
                    }],
                    isError: true
                };
            }
        }
    );

    // 获取 CSDN 文章工具
    server.tool(
        fetchCsdnToolName,
        "Fetch full article content from a csdn post URL",
        {
            url: z.string().url().refine(
                (url) => validateArticleUrl(url, 'csdn'),
                "URL must be from blog.csdn.net contains /article/details/ path"
            )
        },
        async ({url}) => {
            try {
                console.error(`Fetching CSDN article: ${url}`);
                const result = await runtime.services.fetchCsdnArticle.execute({ url });

                return {
                    content: [{
                        type: 'text',
                        text: result.content
                    }]
                };
            } catch (error) {
                console.error('Failed to fetch CSDN article:', error);
                return {
                    content: [{
                        type: 'text',
                        text: `Failed to fetch article: ${error instanceof Error ? error.message : 'Unknown error'}`
                    }],
                    isError: true
                };
            }
        }
    );

    // 获取 GitHub README 工具
    server.tool(
        fetchGithubToolName,
        "Fetch README content from a GitHub repository URL",
        {
            url: z.string().min(1).refine(
                (url) => validateGithubRepositoryUrl(url),
                "URL must be a valid GitHub repository URL (supports HTTPS, SSH formats)"
            )
        },
        async ({url}) => {
            try {
                console.error(`Fetching GitHub README: ${url}`);
                const result = await runtime.services.fetchGithubReadme.execute({ url });

                if (result) {
                    return {
                        content: [{
                            type: 'text',
                            text: result
                        }]
                    };
                } else {
                    return {
                        content: [{
                            type: 'text',
                            text: 'README not found or repository does not exist'
                        }],
                        isError: true
                    };
                }
            } catch (error) {
                console.error('Failed to fetch GitHub README:', error);
                return {
                    content: [{
                        type: 'text',
                        text: `Failed to fetch README: ${error instanceof Error ? error.message : 'Unknown error'}`
                    }],
                    isError: true
                };
            }
        }
    );

    // 获取通用网页/Markdown 内容工具
    server.tool(
        fetchWebToolName,
        "Fetch content from a public HTTP(S) URL. renderMode defaults to auto: request uses HTTP only, auto uses request with browser fallback, and browser renders directly with Playwright and fails clearly when Playwright is unavailable.",
        {
            url: z.string().url().refine(
                (url) => validatePublicWebUrl(url),
                "URL must be a public HTTP(S) address (private/local network targets are blocked)"
            ),
            maxChars: z.number().int().min(1000).max(200000).default(30000),
            readability: z.boolean().optional(),
            includeLinks: z.boolean().optional(),
            renderMode: z.enum(['request', 'auto', 'browser']).optional()
        },
        async ({url, maxChars = 30000, readability, includeLinks, renderMode}) => {
            try {
                console.error(`Fetching web content: ${url}`);
                const result = await runtime.services.fetchWeb.execute({ url, maxChars, readability, includeLinks, renderMode });

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(result, null, 2)
                    }]
                };
            } catch (error) {
                console.error('Failed to fetch web content:', error);
                return {
                    content: [{
                        type: 'text',
                        text: `Failed to fetch web content: ${error instanceof Error ? error.message : 'Unknown error'}`
                    }],
                    isError: true
                };
            }
        }
    );

    // 获取掘金文章工具
    server.tool(
        fetchJuejinToolName,
        "Fetch full article content from a Juejin(掘金) post URL",
        {
            url: z.string().url().refine(
                (url) => validateArticleUrl(url, 'juejin'),
                "URL must be from juejin.cn and contain /post/ path"
            )
        },
        async ({url}) => {
            try {
                console.error(`Fetching Juejin article: ${url}`);
                const result = await runtime.services.fetchJuejinArticle.execute({ url });

                return {
                    content: [{
                        type: 'text',
                        text: result.content
                    }]
                };
            } catch (error) {
                console.error('Failed to fetch Juejin article:', error);
                return {
                    content: [{
                        type: 'text',
                        text: `Failed to fetch article: ${error instanceof Error ? error.message : 'Unknown error'}`
                    }],
                    isError: true
                };
            }
        }
    );
};

