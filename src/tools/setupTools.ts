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
    const getSearchDescription = () => {
        if (runtime.config.allowedSearchEngines.length === 0) {
            return "Search the web using multiple engines (e.g., Baidu, Bing, DuckDuckGo, CSDN, Exa, Brave, Juejin(掘金), Startpage) with no API key required";
        } else {
            const enginesText = runtime.config.allowedSearchEngines.map(e => {
                switch (e) {
                    case 'juejin':
                        return 'Juejin(掘金)';
                    case 'startpage':
                        return 'Startpage';
                    default:
                        return e.charAt(0).toUpperCase() + e.slice(1);
                }
            }).join(', ');
            return `Search the web using these engines: ${enginesText} (no API key required)`;
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

    server.tool(
        searchToolName,
        getSearchDescription(),
        {
            query: z.string().min(1, "Search query must not be empty"),
            limit: z.number().min(1).max(50).default(10),
            searchMode: z.enum(['request', 'auto', 'playwright']).optional(),
            engines: z.array(getEngineInputSchema()).min(1).default([runtime.config.defaultSearchEngine])
                .transform(requestedEngines => resolveRequestedEngines(
                    requestedEngines,
                    runtime.config.allowedSearchEngines,
                    runtime.config.defaultSearchEngine
                ) as [SupportedSearchEngine, ...SupportedSearchEngine[]])
        },
        async ({query, limit = 10, searchMode, engines}) => {
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
                        type: 'text',
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
                return {
                    content: [{
                        type: 'text',
                        text: `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
                    }],
                    isError: true
                };
            }
        }
    );

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
        "Fetch content from a public HTTP(S) URL (supports Markdown files and normal web pages)",
        {
            url: z.string().url().refine(
                (url) => validatePublicWebUrl(url),
                "URL must be a public HTTP(S) address (private/local network targets are blocked)"
            ),
            maxChars: z.number().int().min(1000).max(200000).default(30000)
        },
        async ({url, maxChars = 30000}) => {
            try {
                console.error(`Fetching web content: ${url}`);
                const result = await runtime.services.fetchWeb.execute({ url, maxChars });

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

