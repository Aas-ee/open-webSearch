// src/config.ts
export interface AppConfig {
    // Search engine configuration
    defaultSearchEngine: 'bing' | 'duckduckgo' | 'exa' | 'brave' | 'baidu' | 'csdn' | 'linuxdo'  | 'juejin';
    // List of allowed search engines (if empty, all engines are available)
    allowedSearchEngines: string[];
    // Search mode: request only, auto request then fallback, or force Playwright
    // Currently only affects Bing.
    searchMode: 'request' | 'auto' | 'playwright';
    // Proxy configuration
    proxyUrl?: string;
    useProxy: boolean;
    // Playwright configuration
    playwrightPackage: 'auto' | 'playwright' | 'playwright-core';
    playwrightModulePath?: string;
    playwrightExecutablePath?: string;
    playwrightWsEndpoint?: string;
    playwrightCdpEndpoint?: string;
    playwrightHeadless: boolean;
    playwrightNavigationTimeoutMs: number;
    // CORS configuration
    enableCors: boolean;
    corsOrigin: string;
    // Server configuration (determined by MODE env var: 'both', 'http', or 'stdio')
    enableHttpServer: boolean;
}

function readOptionalEnv(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value ? value : undefined;
}

// Read from environment variables or use defaults
export const config: AppConfig = {
    // Search engine configuration
    defaultSearchEngine: (process.env.DEFAULT_SEARCH_ENGINE as AppConfig['defaultSearchEngine']) || 'bing',
    // Parse comma-separated list of allowed search engines
    allowedSearchEngines: process.env.ALLOWED_SEARCH_ENGINES ?
        process.env.ALLOWED_SEARCH_ENGINES.split(',').map(e => e.trim()) :
        [],
    searchMode: (process.env.SEARCH_MODE as AppConfig['searchMode']) || 'request',
    // Proxy configuration
    proxyUrl: process.env.PROXY_URL || 'http://127.0.0.1:7890',
    useProxy: process.env.USE_PROXY === 'true',
    playwrightPackage: (process.env.PLAYWRIGHT_PACKAGE as AppConfig['playwrightPackage']) || 'auto',
    playwrightModulePath: readOptionalEnv('PLAYWRIGHT_MODULE_PATH'),
    playwrightExecutablePath: readOptionalEnv('PLAYWRIGHT_EXECUTABLE_PATH'),
    playwrightWsEndpoint: readOptionalEnv('PLAYWRIGHT_WS_ENDPOINT'),
    playwrightCdpEndpoint: readOptionalEnv('PLAYWRIGHT_CDP_ENDPOINT'),
    playwrightHeadless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    playwrightNavigationTimeoutMs: Number(process.env.PLAYWRIGHT_NAVIGATION_TIMEOUT_MS || 20000),
    // CORS configuration
    enableCors: process.env.ENABLE_CORS === 'true',
    corsOrigin: process.env.CORS_ORIGIN || '*',
    // Server configuration - determined by MODE environment variable
    // Modes: 'both' (default), 'http', 'stdio'
    enableHttpServer: process.env.MODE ? ['both', 'http'].includes(process.env.MODE) : true
};

// Valid search engines list
const validSearchEngines = ['bing', 'duckduckgo', 'exa', 'brave', 'baidu', 'csdn', 'linuxdo', 'juejin'];
const validSearchModes = ['request', 'auto', 'playwright'];
const validPlaywrightPackages = ['auto', 'playwright', 'playwright-core'];

// Validate default search engine
if (!validSearchEngines.includes(config.defaultSearchEngine)) {
    console.warn(`Invalid DEFAULT_SEARCH_ENGINE: "${config.defaultSearchEngine}", falling back to "bing"`);
    config.defaultSearchEngine = 'bing';
}

if (!validSearchModes.includes(config.searchMode)) {
    console.warn(`Invalid SEARCH_MODE: "${config.searchMode}", falling back to "request"`);
    config.searchMode = 'request';
}

if (!validPlaywrightPackages.includes(config.playwrightPackage)) {
    console.warn(`Invalid PLAYWRIGHT_PACKAGE: "${config.playwrightPackage}", falling back to "auto"`);
    config.playwrightPackage = 'auto';
}

if (!Number.isFinite(config.playwrightNavigationTimeoutMs) || config.playwrightNavigationTimeoutMs <= 0) {
    console.warn(`Invalid PLAYWRIGHT_NAVIGATION_TIMEOUT_MS: "${process.env.PLAYWRIGHT_NAVIGATION_TIMEOUT_MS}", falling back to 20000`);
    config.playwrightNavigationTimeoutMs = 20000;
}

if (config.playwrightWsEndpoint && config.playwrightCdpEndpoint) {
    console.warn('Both PLAYWRIGHT_WS_ENDPOINT and PLAYWRIGHT_CDP_ENDPOINT are set, PLAYWRIGHT_WS_ENDPOINT will take precedence');
}

if ((config.playwrightWsEndpoint || config.playwrightCdpEndpoint) && config.playwrightExecutablePath) {
    console.warn('PLAYWRIGHT_EXECUTABLE_PATH is ignored when connecting to a remote browser endpoint');
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
console.error(`🔍 Search mode: ${config.searchMode.toUpperCase()} (currently only affects Bing)`);

if (config.useProxy) {
    console.error(`🌐 Using proxy: ${config.proxyUrl}`);
} else {
    console.error(`🌐 No proxy configured (set USE_PROXY=true to enable)`);
}

console.error(`🧭 Playwright client source: ${config.playwrightPackage}`);
if (config.playwrightModulePath) {
    console.error(`🧭 Playwright module path override: ${config.playwrightModulePath}`);
}
if (config.playwrightWsEndpoint) {
    console.error(`🧭 Playwright remote endpoint (ws): ${config.playwrightWsEndpoint}`);
} else if (config.playwrightCdpEndpoint) {
    console.error(`🧭 Playwright remote endpoint (cdp): ${config.playwrightCdpEndpoint}`);
} else if (config.playwrightExecutablePath) {
    console.error(`🧭 Playwright executable path: ${config.playwrightExecutablePath}`);
}
console.error(`🧭 Playwright headless: ${config.playwrightHeadless}`);
console.error(`🧭 Playwright navigation timeout: ${config.playwrightNavigationTimeoutMs}ms`);

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
