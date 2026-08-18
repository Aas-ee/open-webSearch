import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getSystemBrowserCandidates } from './utils/browserPaths.js';

// src/config.ts
export interface AppConfig {
    // Search engine configuration
    defaultSearchEngine: 'bing' | 'duckduckgo' | 'exa' | 'brave' | 'baidu' | 'csdn' | 'linuxdo'  | 'juejin' | 'startpage';
    // List of allowed search engines (if empty, all engines are available)
    allowedSearchEngines: string[];
    // Search mode: request only, auto request then fallback, or force Playwright
    // Currently only affects Bing.
    searchMode: 'request' | 'auto' | 'playwright';
    // Proxy configuration
    proxyUrl?: string;
    useProxy: boolean;
    fetchWebAllowInsecureTls: boolean;
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

// 用于解析可选 Playwright 客户端包与（本地启动时的）浏览器可执行文件。
const configRequire = createRequire(import.meta.url);

// Read from environment variables or use defaults
export const config: AppConfig = {
    // Search engine configuration
    defaultSearchEngine: (process.env.DEFAULT_SEARCH_ENGINE as AppConfig['defaultSearchEngine']) || 'bing',
    // Parse comma-separated list of allowed search engines
    allowedSearchEngines: process.env.ALLOWED_SEARCH_ENGINES ?
        process.env.ALLOWED_SEARCH_ENGINES.split(',').map(e => e.trim()) :
        [],
    searchMode: (process.env.SEARCH_MODE as AppConfig['searchMode']) || 'auto',
    // Proxy configuration
    proxyUrl: process.env.PROXY_URL || 'http://127.0.0.1:7890',
    useProxy: process.env.USE_PROXY === 'true',
    fetchWebAllowInsecureTls: process.env.FETCH_WEB_INSECURE_TLS === 'true',
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
const validSearchEngines = ['bing', 'duckduckgo', 'exa', 'brave', 'baidu', 'csdn', 'linuxdo', 'juejin', 'startpage'];
const validSearchModes = ['request', 'auto', 'playwright'];
const validPlaywrightPackages = ['auto', 'playwright', 'playwright-core'];
const quietStartupLogs = process.env.OPEN_WEBSEARCH_QUIET_STARTUP === 'true';

// Validate default search engine
if (!validSearchEngines.includes(config.defaultSearchEngine)) {
    console.warn(`Invalid DEFAULT_SEARCH_ENGINE: "${config.defaultSearchEngine}", falling back to "bing"`);
    config.defaultSearchEngine = 'bing';
}

if (!validSearchModes.includes(config.searchMode)) {
    console.warn(`Invalid SEARCH_MODE: "${config.searchMode}", falling back to "auto"`);
    config.searchMode = 'auto';
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

if (!quietStartupLogs) {
    // Log configuration
    console.error(`🔍 Default search engine: ${config.defaultSearchEngine}`);
    if (config.allowedSearchEngines.length > 0) {
        console.error(`🔍 Allowed search engines: ${config.allowedSearchEngines.join(', ')}`);
    } else {
        console.error(`🔍 No search engine restrictions, all available engines can be used`);
    }
    const effectiveModeForLog = getEffectiveSearchMode(config);
    const effectiveModeSuffix = effectiveModeForLog !== config.searchMode ? `, effective: ${effectiveModeForLog.toUpperCase()}` : '';
    console.error(`🔍 Search mode: ${config.searchMode.toUpperCase()}${effectiveModeSuffix} (currently only affects Bing)`);
    if (config.searchMode === 'playwright') {
        const availability = checkPlaywrightModeConfiguration(config);
        if (!availability.available) {
            console.warn(`⚠️ SEARCH_MODE=playwright is set, but the Playwright configuration is currently invalid: ${availability.reason}. Playwright searches will fail with browser_unavailable until it is fixed.`);
        }
    }

    if (config.useProxy) {
        console.error(`🌐 Using proxy: ${config.proxyUrl}`);
    } else {
        console.error(`🌐 No proxy configured (set USE_PROXY=true to enable)`);
    }
    if (config.fetchWebAllowInsecureTls) {
        console.error('⚠️ fetchWebContent TLS verification is disabled (FETCH_WEB_INSECURE_TLS=true)');
    } else {
        console.error('🔐 fetchWebContent TLS verification is enabled');
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
}


/**
 * Helper function to get the proxy URL if proxy is enabled
 */
export function getProxyUrl(): string | undefined {
    return config.useProxy ? encodeURI(<string>config.proxyUrl) : undefined;
}

/**
 * 按运行时加载顺序同步检查 Playwright 必需参数是否真实可用：
 * 1. Playwright 客户端模块（PLAYWRIGHT_MODULE_PATH 优先，其次 PLAYWRIGHT_PACKAGE/auto），必须真实可加载并暴露 chromium；远端 WS/CDP 模式同样需要本地客户端；
 * 2. 远端端点（PLAYWRIGHT_WS_ENDPOINT / PLAYWRIGHT_CDP_ENDPOINT）模式下，客户端加载成功即算可用，连通性在真实使用时验证；
 * 3. 本地启动模式下，浏览器二进制必须真实存在：显式 PLAYWRIGHT_EXECUTABLE_PATH、客户端捆绑浏览器或系统 Chrome/Edge（候选列表与 playwrightClient.getLocalBrowserExecutablePath 保持一致）。
 *
 * 供 SEARCH_MODE=auto 时判断实际生效模式，以及强制 playwright 时的启动告警使用。
 */
type PlaywrightClientModule = {
    chromium?: { executablePath?: () => string };
    default?: unknown;
};

export function checkPlaywrightModeConfiguration(appConfig: AppConfig = config): { available: boolean; reason: string | null } {
    const clientCandidates: string[] = [];
    if (appConfig.playwrightModulePath) {
        clientCandidates.push(
            path.isAbsolute(appConfig.playwrightModulePath)
                ? appConfig.playwrightModulePath
                : path.resolve(process.cwd(), appConfig.playwrightModulePath)
        );
    }
    const packageNames = appConfig.playwrightPackage === 'auto'
        ? ['playwright', 'playwright-core']
        : [appConfig.playwrightPackage];
    clientCandidates.push(...packageNames);

    const loadFailures: string[] = [];
    let loadedModule: PlaywrightClientModule | null = null;
    for (const candidate of clientCandidates) {
        try {
            loadedModule = configRequire(candidate) as PlaywrightClientModule;
            break;
        } catch (error) {
            loadFailures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    const unwrapped: unknown = loadedModule && loadedModule.default ? loadedModule.default : loadedModule;
    const clientModule = (unwrapped ?? null) as PlaywrightClientModule | null;
    if (!clientModule?.chromium) {
        return {
            available: false,
            reason: loadFailures.length > 0
                ? `Playwright client cannot be loaded (attempts: ${loadFailures.join(' | ')})`
                : 'Playwright client module does not expose chromium'
        };
    }

    // 远端端点：本地客户端可加载即可，连通性在真实使用时验证。
    if (appConfig.playwrightWsEndpoint || appConfig.playwrightCdpEndpoint) {
        return { available: true, reason: null };
    }

    // 本地启动：显式浏览器路径必须真实存在。
    if (appConfig.playwrightExecutablePath) {
        if (existsSync(appConfig.playwrightExecutablePath)) {
            return { available: true, reason: null };
        }
        return { available: false, reason: `PLAYWRIGHT_EXECUTABLE_PATH does not exist: ${appConfig.playwrightExecutablePath}` };
    }

    // 客户端捆绑浏览器（playwright 自带 registry chromium）。
    let bundledExecutable: string | null = null;
    try {
        bundledExecutable = clientModule.chromium.executablePath?.() ?? null;
    } catch {
        bundledExecutable = null;
    }
    if (bundledExecutable && existsSync(bundledExecutable)) {
        return { available: true, reason: null };
    }

    // 系统 Chrome/Edge：与运行时启动共用同一份候选（src/utils/browserPaths.ts），保证检测判定的可用路径与实际启动用的路径一致。
    for (const candidate of [...new Set(getSystemBrowserCandidates())]) {
        if (existsSync(candidate)) {
            return { available: true, reason: null };
        }
    }

    return {
        available: false,
        reason: 'No usable browser binary was found: PLAYWRIGHT_EXECUTABLE_PATH is unset, the Playwright client has no installed bundled browser, and no system Chrome/Edge was detected. Install a browser, set PLAYWRIGHT_EXECUTABLE_PATH, or configure a remote PLAYWRIGHT_WS_ENDPOINT/PLAYWRIGHT_CDP_ENDPOINT.'
    };
}

/**
 * 解析指定配置下实际生效的搜索模式：
 * - 强制 request / playwright：原样采用；
 * - auto：Playwright 配置真实可用时保持 auto（请求优先、失败回退 Playwright），否则退回强制 HTTP 请求模式。
 */
export function getEffectiveSearchMode(appConfig: AppConfig = config): AppConfig['searchMode'] {
    if (appConfig.searchMode === 'auto') {
        return checkPlaywrightModeConfiguration(appConfig).available ? 'auto' : 'request';
    }
    return appConfig.searchMode;
}
