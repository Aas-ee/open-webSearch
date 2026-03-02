// tools/setupTools.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fetchLinuxDoArticle } from '../engines/linuxdo/fetchLinuxDoArticle.js';
import { searchBaidu } from '../engines/baidu/baidu.js';
import { searchBing } from '../engines/bing/bing.js';
import { searchLinuxDo } from "../engines/linuxdo/linuxdo.js";
import { searchCsdn } from "../engines/csdn/csdn.js";
import { fetchCsdnArticle } from "../engines/csdn/fetchCsdnArticle.js";
import { SearchResult } from '../types.js';
import { z } from 'zod';
import {searchDuckDuckGo} from "../engines/duckduckgo/index.js";
import {config} from "../config.js";
import {searchExa} from "../engines/exa/index.js";
import {searchBrave} from "../engines/brave/index.js";
import {fetchGithubReadme} from "../engines/github/index.js";
import { fetchJuejinArticle } from "../engines/juejin/fetchJuejinArticle.js";
import { searchJuejin } from "../engines/juejin/index.js";
import axios from 'axios';

/** 从错误对象中提取可读的错误消息（处理 AxiosError/AggregateError 等 message 为空的情况） */
function getErrorMessage(error: unknown): string {
    if (axios.isAxiosError(error)) {
        const parts: string[] = [];
        if (error.code) parts.push(error.code);
        if (error.message) parts.push(error.message);
        if (error.response) parts.push(`HTTP ${error.response.status}`);
        if (parts.length > 0) return parts.join(' - ');
    }
    if (error instanceof Error && error.message) return error.message;
    return String(error) || 'Unknown error';
}

// 支持的搜索引擎
const SUPPORTED_ENGINES = ['baidu', 'bing', 'linuxdo', 'csdn', 'duckduckgo','exa','brave','juejin'] as const;
type SupportedEngine = typeof SUPPORTED_ENGINES[number];

// 搜索引擎调用函数映射
const engineMap: Record<SupportedEngine, (query: string, limit: number) => Promise<SearchResult[]>> = {
    baidu: searchBaidu,
    bing: searchBing,
    linuxdo: searchLinuxDo,
    csdn: searchCsdn,
    duckduckgo: searchDuckDuckGo,
    exa: searchExa,
    brave: searchBrave,
    juejin: searchJuejin,
};

// 分配搜索结果数量
const distributeLimit = (totalLimit: number, engineCount: number): number[] => {
    const base = Math.floor(totalLimit / engineCount);
    const remainder = totalLimit % engineCount;

    return Array.from({ length: engineCount }, (_, i) =>
        base + (i < remainder ? 1 : 0)
    );
};

interface SearchExecutionResult {
    results: SearchResult[];
    errors: { engine: string; message: string }[];
}

// 执行搜索
const executeSearch = async (query: string, engines: string[], limit: number): Promise<SearchExecutionResult> => {
    // Clean up the query string to ensure it won't cause issues due to spaces or special characters
    const cleanQuery = query.trim();
    console.error(`[DEBUG] Executing search, query: "${cleanQuery}", engines: ${engines.join(', ')}, limit: ${limit}`);

    if (!cleanQuery) {
        console.error('Query string is empty');
        throw new Error('Query string cannot be empty');
    }

    const limits = distributeLimit(limit, engines.length);
    const errors: { engine: string; message: string }[] = [];

    const searchTasks = engines.map((engine, index) => {
        const engineLimit = limits[index];
        const searchFn = engineMap[engine as SupportedEngine];

        if (!searchFn) {
            const msg = `Unsupported search engine: ${engine}`;
            console.warn(msg);
            errors.push({ engine, message: msg });
            return Promise.resolve([]);
        }

        return searchFn(query, engineLimit).catch(error => {
            const msg = getErrorMessage(error);
            console.error(`Search failed for engine ${engine}: ${msg}`);
            errors.push({ engine, message: msg });
            return [];
        });
    });

    const results = await Promise.all(searchTasks);
    return { results: results.flat().slice(0, limit), errors };
};

// 验证文章 URL
const validateArticleUrl = (url: string, type: 'linuxdo' | 'csdn' | 'juejin'): boolean => {
    try {
        const urlObj = new URL(url);

        switch (type) {
            case 'linuxdo':
                return urlObj.hostname === 'linux.do' && /\/t(opic)?\//.test(url);
            case 'csdn':
                return urlObj.hostname === 'blog.csdn.net' && url.includes('/article/details/');
            case 'juejin':
                return urlObj.hostname === 'juejin.cn' && url.includes('/post/');
            default:
                return false;
        }
    } catch {
        return false;
    }
};

// 验证 GitHub URL
const validateGithubUrl = (url: string): boolean => {
    try {

        const isSshGithub = /^git@github\.com:/.test(url);

        if (isSshGithub) {
            // SSH 格式: git@github.com:owner/repo.git
            return /^git@github\.com:[^\/]+\/[^\/]+/.test(url);
        }

        const urlObj = new URL(url);

        // 支持多种 GitHub URL 格式
        const isHttpsGithub = urlObj.hostname === 'github.com' || urlObj.hostname === 'www.github.com';

        if (isHttpsGithub) {
            // 检查路径格式: /owner/repo
            const pathParts = urlObj.pathname.split('/').filter(part => part.length > 0);
            return pathParts.length >= 2;
        }

        return false;
    } catch {
        return false;
    }
};

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

export const setupTools = (server: McpServer): void => {
    // Get configurable tool names from environment variables
    const searchToolName = getToolName('MCP_TOOL_SEARCH_NAME', 'search');
    const fetchLinuxDoToolName = getToolName('MCP_TOOL_FETCH_LINUXDO_NAME', 'fetchLinuxDoArticle');
    const fetchCsdnToolName = getToolName('MCP_TOOL_FETCH_CSDN_NAME', 'fetchCsdnArticle');
    const fetchGithubToolName = getToolName('MCP_TOOL_FETCH_GITHUB_NAME', 'fetchGithubReadme');
    const fetchJuejinToolName = getToolName('MCP_TOOL_FETCH_JUEJIN_NAME', 'fetchJuejinArticle');

    // 搜索工具
    // 生成搜索工具的动态描述
    const getSearchDescription = () => {
        if (config.allowedSearchEngines.length === 0) {
            return "Search the web using multiple engines (e.g., Baidu, Bing, DuckDuckGo, CSDN, Exa, Brave, Juejin(掘金)) with no API key required";
        } else {
            const enginesText = config.allowedSearchEngines.map(e => {
                switch (e) {
                    case 'juejin':
                        return 'Juejin(掘金)';
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
        const allowedEngines = config.allowedSearchEngines.length > 0
            ? config.allowedSearchEngines
            : [...SUPPORTED_ENGINES];

        return z.enum(allowedEngines as [string, ...string[]]);
    };

    server.tool(
        searchToolName,
        getSearchDescription(),
        {
            query: z.string().min(1, "Search query must not be empty"),
            limit: z.number().min(1).max(50).default(10),
            maxDescriptionLength: z.number().min(1).optional()
                .describe("Maximum length of each result's description. Defaults to the global MAX_DESCRIPTION_LENGTH setting. Omit for no limit."),
            engines: z.array(z.string().transform(s => s.toLowerCase()).pipe(getEnginesEnum())).min(1).default([config.defaultSearchEngine])
                .transform(requestedEngines => {
                    // 如果有配置允许的搜索引擎，过滤请求的引擎
                    if (config.allowedSearchEngines.length > 0) {
                        const filteredEngines = requestedEngines.filter(engine =>
                            config.allowedSearchEngines.includes(engine));

                        // 如果所有请求的引擎都被过滤掉，使用默认引擎
                        return filteredEngines.length > 0 ?
                            filteredEngines :
                            [config.defaultSearchEngine];
                    }
                    return requestedEngines;
                })
        },
        async ({query, limit = 10, maxDescriptionLength, engines = ['bing']}) => {
            try {
                console.error(`Searching for "${query}" using engines: ${engines.join(', ')}`);

                const { results, errors } = await executeSearch(query.trim(), engines, limit);

                // 所有引擎全部失败（错误数 == 引擎数）→ 返回 isError
                if (errors.length === engines.length) {
                    const errorDetail = errors.map(e => `${e.engine}: ${e.message}`).join('\n');
                    return {
                        content: [{
                            type: 'text',
                            text: `All search engines failed:\n${errorDetail}`
                        }],
                        isError: true
                    };
                }

                // 0 结果但只有部分引擎失败 → 也标记为错误，列出各引擎状态
                if (results.length === 0 && errors.length > 0) {
                    const failedSet = new Set(errors.map(e => e.engine));
                    const succeededEngines = engines.filter(e => !failedSet.has(e));
                    const lines = errors.map(e => `${e.engine}: ${e.message}`);
                    if (succeededEngines.length > 0) {
                        lines.push(`${succeededEngines.join(', ')}: returned 0 results`);
                    }
                    return {
                        content: [{
                            type: 'text',
                            text: `No results found:\n${lines.join('\n')}`
                        }],
                        isError: true
                    };
                }

                // 所有引擎均成功执行但返回 0 条结果 → 不是错误，给出信息性提示
                if (results.length === 0 && errors.length === 0) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                query: query.trim(),
                                engines: engines,
                                totalResults: 0,
                                results: [],
                                message: `所有搜索引擎（${engines.join('、')}）均未找到与此查询匹配的结果。可能是查询过于具体、过长，或搜索引擎未能找到匹配的页面。建议简化查询或使用不同的关键词。`
                            }, null, 2)
                        }]
                    };
                }

                // 应用描述长度限制：调用参数 > 全局配置 > 不限制
                const descLimit = maxDescriptionLength ?? config.maxDescriptionLength;
                const truncatedResults = descLimit
                    ? results.map(r => ({
                        ...r,
                        description: r.description.length > descLimit
                            ? r.description.slice(0, descLimit) + '...'
                            : r.description
                    }))
                    : results;

                const response: Record<string, unknown> = {
                    query: query.trim(),
                    engines: engines,
                    totalResults: truncatedResults.length,
                    results: truncatedResults
                };

                // 部分引擎失败 → 在结果中附带警告
                if (errors.length > 0) {
                    response.warnings = errors.map(e => `${e.engine}: ${e.message}`);
                }

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(response, null, 2)
                    }]
                };
            } catch (error) {
                console.error(`Search tool execution failed: ${getErrorMessage(error)}`);
                return {
                    content: [{
                        type: 'text',
                        text: `Search failed: ${getErrorMessage(error)}`
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
                const result = await fetchLinuxDoArticle(url);

                return {
                    content: [{
                        type: 'text',
                        text: result.content
                    }]
                };
            } catch (error) {
                console.error(`Failed to fetch Linux.do article: ${getErrorMessage(error)}`);
                return {
                    content: [{
                        type: 'text',
                        text: `Failed to fetch article: ${getErrorMessage(error)}`
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
                const result = await fetchCsdnArticle(url);

                return {
                    content: [{
                        type: 'text',
                        text: result.content
                    }]
                };
            } catch (error) {
                console.error(`Failed to fetch CSDN article: ${getErrorMessage(error)}`);
                return {
                    content: [{
                        type: 'text',
                        text: `Failed to fetch article: ${getErrorMessage(error)}`
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
                (url) => validateGithubUrl(url),
                "URL must be a valid GitHub repository URL (supports HTTPS, SSH formats)"
            )
        },
        async ({url}) => {
            try {
                console.error(`Fetching GitHub README: ${url}`);
                const result = await fetchGithubReadme(url);

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
                console.error(`Failed to fetch GitHub README: ${getErrorMessage(error)}`);
                return {
                    content: [{
                        type: 'text',
                        text: `Failed to fetch README: ${getErrorMessage(error)}`
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
                const result = await fetchJuejinArticle(url);

                return {
                    content: [{
                        type: 'text',
                        text: result.content
                    }]
                };
            } catch (error) {
                console.error(`Failed to fetch Juejin article: ${getErrorMessage(error)}`);
                return {
                    content: [{
                        type: 'text',
                        text: `Failed to fetch article: ${getErrorMessage(error)}`
                    }],
                    isError: true
                };
            }
        }
    );
};

