// src/config.ts
export interface AppConfig {
    // Search engine configuration
    defaultSearchEngine: 'bing' | 'duckduckgo' | 'exa' | 'brave' | 'baidu' | 'csdn' | 'linuxdo'  | 'juejin';
    // List of allowed search engines (if empty, all engines are available)
    allowedSearchEngines: string[];
    // Proxy configuration
    proxyUrl?: string;
    useProxy: boolean;
    // CORS configuration
    enableCors: boolean;
    corsOrigin: string;
    // Server configuration (determined by MODE env var: 'both', 'http', or 'stdio')
    enableHttpServer: boolean;
    // 搜索结果描述最大长度（undefined = 不限制）
    maxDescriptionLength?: number;
    // 网络请求超时时间（毫秒）
    requestTimeout: number;
}

// Read from environment variables or use defaults
export const config: AppConfig = {
    // Search engine configuration
    defaultSearchEngine: (process.env.DEFAULT_SEARCH_ENGINE as AppConfig['defaultSearchEngine']) || 'bing',
    // Parse comma-separated list of allowed search engines
    allowedSearchEngines: process.env.ALLOWED_SEARCH_ENGINES ?
        process.env.ALLOWED_SEARCH_ENGINES.split(',').map(e => e.trim()) :
        [],
    // Proxy configuration
    proxyUrl: process.env.PROXY_URL || 'http://127.0.0.1:10809',
    useProxy: process.env.USE_PROXY === 'true',
    // CORS configuration
    enableCors: process.env.ENABLE_CORS === 'true',
    corsOrigin: process.env.CORS_ORIGIN || '*',
    // Server configuration - determined by MODE environment variable
    // Modes: 'both' (default), 'http', 'stdio'
    enableHttpServer: process.env.MODE ? ['both', 'http'].includes(process.env.MODE) : true,
    // 搜索结果描述最大长度
    maxDescriptionLength: process.env.MAX_DESCRIPTION_LENGTH ? parseInt(process.env.MAX_DESCRIPTION_LENGTH, 10) : undefined,
    // 网络请求超时时间（毫秒），默认 30 秒
    requestTimeout: process.env.REQUEST_TIMEOUT ? parseInt(process.env.REQUEST_TIMEOUT, 10) : 30000
};

// Valid search engines list
const validSearchEngines = ['bing', 'duckduckgo', 'exa', 'brave', 'baidu', 'csdn', 'linuxdo', 'juejin'];

// Validate default search engine
if (!validSearchEngines.includes(config.defaultSearchEngine)) {
    console.warn(`Invalid DEFAULT_SEARCH_ENGINE: "${config.defaultSearchEngine}", falling back to "bing"`);
    config.defaultSearchEngine = 'bing';
}

// Validate allowed search engines
if (config.allowedSearchEngines.length > 0) {
    // Filter out invalid engines
    const invalidEngines = config.allowedSearchEngines.filter(engine => !validSearchEngines.includes(engine));
    if (invalidEngines.length > 0) {
        console.warn(`Invalid search engines detected and will be ignored: ${invalidEngines.join(', ')}`);
    }
    config.allowedSearchEngines = config.allowedSearchEngines.filter(engine => validSearchEngines.includes(engine));

    // If all engines were invalid, don't restrict (allow all engines)
    if (config.allowedSearchEngines.length === 0) {
        console.warn(`No valid search engines specified in the allowed list, all engines will be available`);
    }
    // Check if default engine is in the allowed list
    else if (!config.allowedSearchEngines.includes(config.defaultSearchEngine)) {
        console.warn(`Default search engine "${config.defaultSearchEngine}" is not in the allowed engines list`);
        // Update the default engine to the first allowed engine
        config.defaultSearchEngine = config.allowedSearchEngines[0] as AppConfig['defaultSearchEngine'];
        console.error(`Default search engine updated to "${config.defaultSearchEngine}"`);
    }
}

// Log configuration
console.error(`🔍 Default search engine: ${config.defaultSearchEngine}`);
if (config.allowedSearchEngines.length > 0) {
    console.error(`🔍 Allowed search engines: ${config.allowedSearchEngines.join(', ')}`);
} else {
    console.error(`🔍 No search engine restrictions, all available engines can be used`);
}

if (config.useProxy) {
    console.error(`🌐 Using proxy: ${config.proxyUrl}`);
} else {
    console.error(`🌐 No proxy configured (set USE_PROXY=true to enable)`);
}

// Determine server mode from config
const mode = process.env.MODE || (config.enableHttpServer ? 'both' : 'stdio');
console.error(`🖥️ Server mode: ${mode.toUpperCase()}`);

if (config.enableHttpServer) {
    if (config.enableCors) {
        console.error(`🔒 CORS enabled with origin: ${config.corsOrigin}`);
    } else {
        console.error(`🔒 CORS disabled (set ENABLE_CORS=true to enable)`);
    }
}


/**
 * Helper function to get the proxy URL if proxy is enabled
 */
export function getProxyUrl(): string | undefined {
    return config.useProxy ? encodeURI(<string>config.proxyUrl) : undefined;
}
