import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { createServer } from 'net';
import { tmpdir } from 'os';
import path from 'path';
import { config, getProxyUrl } from '../config.js';
import { withNativeFileLock, withNativeFileLockAsync, launchProcessOnHiddenDesktop } from './nativeInterop.js';

const PLAYWRIGHT_CONNECT_TIMEOUT_MS = Math.max(config.playwrightNavigationTimeoutMs, 30000);
const require = createRequire(import.meta.url);

export type PlaywrightChromium = {
    launch(options?: any): Promise<any>;
    connect(options: { wsEndpoint: string; timeout?: number; headers?: Record<string, string> }): Promise<any>;
    connectOverCDP(endpoint: string, options?: any): Promise<any>;
};

export type PlaywrightModule = {
    chromium: PlaywrightChromium;
};

export type PlaywrightBrowserSession = {
    browser: any;
    close(): Promise<void>;
};

export type PooledPlaywrightPageSession = {
    context: any | null;
    page: any;
    closePageContext(): Promise<void>;
};

type OpenPlaywrightBrowserOptions = {
    hideWindow?: boolean;
};

type AcquirePlaywrightPageOptions = {
    poolKey?: string;
    contextOptions?: any;
    preparePage?: (page: any) => Promise<void>;
    preferExistingContext?: boolean;
};

type LoadPlaywrightClientOptions = {
    silent?: boolean;
};

type LocalBrowserSessionMode = 'headed' | 'headless' | 'hidden-headed';

type LocalBrowserSession = {
    browser: any;
    sessionKey: string;
    sessionMode: LocalBrowserSessionMode;
    browserPid?: number;
    debugPort?: number;
    tempDir?: string;
    closeBrowser(): Promise<void>;
    forceKill(): void;
};

type LocalBrowserSessionMetadata = {
    ownerPid: number;
    browserPid?: number;
    debugPort?: number;
    tempDir: string;
    executablePath: string;
    sessionKey: string;
    compatibilityKey: string;
    sessionMode: LocalBrowserSessionMode;
    hideWindow: boolean;
    strictCleanup: boolean;
    clientPids: number[];
    createdAt: string;
};

type PooledPlaywrightPageEntry = {
    context: any | null;
    page: any;
    busy: boolean;
    prepared: boolean;
};

type BrowserPlaywrightPagePool = {
    poolKey: string;
    sharedContext: any | null;
    entries: PooledPlaywrightPageEntry[];
    preparePage?: (page: any) => Promise<void>;
    contextOptions?: any;
    preferExistingContext: boolean;
    acquireLock: Promise<void> | null;
};

let playwrightModulePromise: Promise<PlaywrightModule | null> | null = null;
let playwrightModuleSource: string | null = null;
let playwrightUnavailableMessage: string | null = null;
let hasEmittedPlaywrightUnavailableWarning = false;
let cachedBrowserPath: string | null = null;
let cachedLocalBrowserSession: LocalBrowserSession | null = null;
let localBrowserSessionPromise: Promise<LocalBrowserSession> | null = null;
let cachedLocalBrowserSessionKey: string | null = null;
let cachedLocalBrowserSessionOptions: {
    headless: boolean;
    launchArgs: string[];
    options?: OpenPlaywrightBrowserOptions;
} | null = null;
let cleanupRegistered = false;
let staleBrowserCleanupPerformed = false;
const LOCAL_BROWSER_SESSION_METADATA_FILE = 'open-websearch-session.json';
const LOCAL_BROWSER_SESSION_REGISTRY_FILE = 'open-websearch-local-browser-sessions.json';
const LEGACY_ORPHAN_BROWSER_GRACE_PERIOD_MS = 60 * 1000;
const CROSS_PROCESS_POOL_LOCK_DIR = path.join(tmpdir(), 'open-websearch-page-pool-locks');
const CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR = path.join(tmpdir(), 'open-websearch-browser-session-locks');
const PAGE_LEASE_STALE_MS = Math.max(config.playwrightNavigationTimeoutMs * 3, 60 * 1000);
const OPEN_WEBSEARCH_PAGE_STATE_PREFIX = '__open_websearch_page_state__:';
const browserPlaywrightPagePools = new WeakMap<any, Map<string, BrowserPlaywrightPagePool>>();
const currentProcessLeaseOwner = `${process.pid}:${createHash('sha1').update(`${process.pid}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 12)}`;

type LocalBrowserSessionRegistryEntry = {
    tempDir: string;
    updatedAt: string;
};

type LocalBrowserSessionRegistry = {
    sessions: Record<string, LocalBrowserSessionRegistryEntry>;
};

type OpenWebSearchPageState = {
    poolKey: string;
    leaseOwner: string | null;
    leaseTimestamp: number | null;
};

function shouldUseStrictLocalBrowserCleanup(headless: boolean, options?: OpenPlaywrightBrowserOptions): boolean {
    return headless && options?.hideWindow !== true;
}

function getLocalBrowserSessionMode(headless: boolean, options?: OpenPlaywrightBrowserOptions): LocalBrowserSessionMode {
    if (options?.hideWindow) {
        return 'hidden-headed';
    }

    return headless ? 'headless' : 'headed';
}

function getBrowserPlaywrightPagePool(browser: any, options?: AcquirePlaywrightPageOptions): BrowserPlaywrightPagePool {
    let browserPools = browserPlaywrightPagePools.get(browser);
    if (!browserPools) {
        browserPools = new Map<string, BrowserPlaywrightPagePool>();
        browserPlaywrightPagePools.set(browser, browserPools);
    }

    const poolKey = options?.poolKey ?? 'default';
    let pool = browserPools.get(poolKey);
    if (pool) {
        return pool;
    }

    pool = {
        poolKey,
        sharedContext: null,
        entries: [],
        preparePage: options?.preparePage,
        contextOptions: options?.contextOptions,
        preferExistingContext: options?.preferExistingContext !== false,
        acquireLock: null
    };
    browserPools.set(poolKey, pool);
    return pool;
}

async function withPoolAcquireLock<T>(pool: BrowserPlaywrightPagePool, operation: () => Promise<T>): Promise<T> {
    while (pool.acquireLock) {
        await pool.acquireLock;
    }

    let releaseLock!: () => void;
    pool.acquireLock = new Promise<void>((resolve) => {
        releaseLock = resolve;
    });

    try {
        return await operation();
    } finally {
        pool.acquireLock = null;
        releaseLock();
    }
}

function buildCrossProcessPoolLockKey(poolKey: string): string {
    const material = JSON.stringify({
        sessionKey: cachedLocalBrowserSessionKey ?? null,
        wsEndpoint: config.playwrightWsEndpoint ?? null,
        cdpEndpoint: config.playwrightCdpEndpoint ?? null,
        executablePath: config.playwrightExecutablePath ?? null,
        poolKey
    });
    return createHash('sha1').update(material).digest('hex');
}

function getCrossProcessPoolLockFilePath(poolKey: string): string {
    mkdirSync(CROSS_PROCESS_POOL_LOCK_DIR, { recursive: true });
    return path.join(CROSS_PROCESS_POOL_LOCK_DIR, `${buildCrossProcessPoolLockKey(poolKey)}.lock`);
}

function getCrossProcessBrowserSessionLockFilePath(sessionKey: string): string {
    mkdirSync(CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR, { recursive: true });
    return path.join(
        CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR,
        `${createHash('sha1').update(sessionKey).digest('hex')}.lock`
    );
}

async function withCrossProcessPoolLock<T>(poolKey: string, operation: () => Promise<T>): Promise<T> {
    return withNativeFileLockAsync(getCrossProcessPoolLockFilePath(poolKey), operation);
}

async function withCrossProcessBrowserSessionLock<T>(sessionKey: string, operation: () => Promise<T>): Promise<T> {
    return withNativeFileLockAsync(getCrossProcessBrowserSessionLockFilePath(sessionKey), operation);
}

function isPageClosed(page: any): boolean {
    try {
        return typeof page?.isClosed === 'function' ? page.isClosed() : false;
    } catch {
        return true;
    }
}

function parseOpenWebSearchPageState(windowName: string, poolKey: string): OpenWebSearchPageState | null {
    if (!windowName.startsWith(OPEN_WEBSEARCH_PAGE_STATE_PREFIX)) {
        return windowName === `__open_websearch_pool__:${poolKey}`
            ? {
                poolKey,
                leaseOwner: null,
                leaseTimestamp: null
            }
            : null;
    }

    const encoded = windowName.slice(OPEN_WEBSEARCH_PAGE_STATE_PREFIX.length);
    try {
        const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<OpenWebSearchPageState>;
        if (typeof parsed.poolKey !== 'string' || parsed.poolKey.length === 0) {
            return null;
        }

        return {
            poolKey: parsed.poolKey,
            leaseOwner: typeof parsed.leaseOwner === 'string' && parsed.leaseOwner.length > 0 ? parsed.leaseOwner : null,
            leaseTimestamp: typeof parsed.leaseTimestamp === 'number' && Number.isFinite(parsed.leaseTimestamp) ? parsed.leaseTimestamp : null
        };
    } catch {
        return null;
    }
}

function serializeOpenWebSearchPageState(state: OpenWebSearchPageState): string {
    const encoded = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
    return `${OPEN_WEBSEARCH_PAGE_STATE_PREFIX}${encoded}`;
}

async function getOpenWebSearchPageState(page: any, poolKey: string): Promise<OpenWebSearchPageState | null> {
    const windowName = await page.evaluate(() => window.name).catch(() => '');
    return typeof windowName === 'string' ? parseOpenWebSearchPageState(windowName, poolKey) : null;
}

function isActivePageLease(state: OpenWebSearchPageState | null): boolean {
    return !!(state?.leaseOwner && state.leaseTimestamp && Date.now() - state.leaseTimestamp < PAGE_LEASE_STALE_MS);
}

async function updateOpenWebSearchPageState(
    page: any,
    poolKey: string,
    updater: (current: OpenWebSearchPageState | null) => OpenWebSearchPageState | null
): Promise<OpenWebSearchPageState | null> {
    const currentState = await getOpenWebSearchPageState(page, poolKey);
    const nextState = updater(currentState);
    if (!nextState) {
        return currentState;
    }

    const nextWindowName = serializeOpenWebSearchPageState(nextState);
    await page.evaluate((windowName: string) => {
        window.name = windowName;
    }, nextWindowName).catch(() => undefined);
    return nextState;
}

async function tryAcquirePlaywrightPageLease(page: any, poolKey: string): Promise<boolean> {
    const currentState = await getOpenWebSearchPageState(page, poolKey);
    if (currentState?.poolKey && currentState.poolKey !== poolKey && isActivePageLease(currentState)) {
        return false;
    }

    if (isActivePageLease(currentState) && currentState?.leaseOwner !== currentProcessLeaseOwner) {
        return false;
    }

    const nextState = await updateOpenWebSearchPageState(page, poolKey, (current) => ({
        poolKey,
        leaseOwner: currentProcessLeaseOwner,
        leaseTimestamp: Date.now()
    }));

    return nextState?.leaseOwner === currentProcessLeaseOwner;
}

async function releasePlaywrightPageLease(page: any, poolKey: string): Promise<void> {
    await updateOpenWebSearchPageState(page, poolKey, (current) => {
        if (!current || current.poolKey !== poolKey || current.leaseOwner !== currentProcessLeaseOwner) {
            return current;
        }

        return {
            poolKey,
            leaseOwner: null,
            leaseTimestamp: null
        };
    });
}

type ExistingContextPageWindowBounds = {
    left?: number;
    top?: number;
    width?: number;
    height?: number;
    windowState?: string;
};

async function getExistingContextPageWindowBounds(page: any): Promise<{ bounds: ExistingContextPageWindowBounds | null; unavailable: boolean }> {
    try {
        const context = typeof page?.context === 'function' ? page.context() : null;
        if (!context || typeof context.newCDPSession !== 'function') {
            return { bounds: null, unavailable: false };
        }

        const session = await context.newCDPSession(page);
        const windowForTarget = await session.send('Browser.getWindowForTarget');
        const boundsResult = await session.send('Browser.getWindowBounds', { windowId: windowForTarget.windowId });
        return {
            bounds: boundsResult?.bounds ?? null,
            unavailable: false
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            bounds: null,
            unavailable: /Browser\.getWindowForTarget\): Browser window not found/i.test(message)
        };
    }
}

async function isPopupLikePlaywrightPage(page: any): Promise<boolean> {
    const { unavailable } = await getExistingContextPageWindowBounds(page);
    if (unavailable) {
        // 如果 CDP 已经拿不到这个 page 对应的 Browser window，就把它视为不安全页（可能是浏览器弹出窗口），不参与复用。
        return true;
    }
    return false;
}

async function isReusableExistingContextPage(page: any, poolKey: string): Promise<boolean> {
    const state = await getOpenWebSearchPageState(page, poolKey);
    if (state?.poolKey && state.poolKey !== poolKey && isActivePageLease(state)) {
        return false;
    }

    if (await isPopupLikePlaywrightPage(page)) {
        return false;
    }

    return true;
}

async function syncPoolWithReusableExistingContextPages(pool: BrowserPlaywrightPagePool, context: any): Promise<void> {
    if (typeof context?.pages !== 'function') {
        return;
    }

    const existingPages = context.pages();
    if (!Array.isArray(existingPages)) {
        return;
    }

    for (const page of existingPages) {
        if (isPageClosed(page) || pool.entries.some((entry) => entry.page === page)) {
            continue;
        }

        if (!await isReusableExistingContextPage(page, pool.poolKey)) {
            continue;
        }

        if (pool.entries.some((entry) => entry.page === page)) {
            continue;
        }

        // 收编所有当前可复用的现有标签页；当前唯一的排除规则是
        // 该 page 在 CDP 层已经找不到对应 Browser window。
        // await 之后仍要再次检查去重，否则并发扫描时仍可能把同一真实 page 重复塞进池子。
        pool.entries.push({
            context,
            page,
            busy: false,
            prepared: false
        });
    }
}

async function createPooledPlaywrightPageEntry(browser: any, pool: BrowserPlaywrightPagePool): Promise<PooledPlaywrightPageEntry> {
    if (pool.preferExistingContext && typeof browser.contexts === 'function') {
        const contexts = browser.contexts();
        if (Array.isArray(contexts) && contexts.length > 0 && typeof contexts[0].newPage === 'function') {
            const context = contexts[0];
            await syncPoolWithReusableExistingContextPages(pool, context);

            const page = await context.newPage();
            const entry: PooledPlaywrightPageEntry = {
                context,
                page,
                busy: false,
                prepared: false
            };
            pool.entries.push(entry);
            return entry;
        }
    }

    if (typeof browser.newContext === 'function') {
        if (!pool.sharedContext) {
            pool.sharedContext = await browser.newContext(pool.contextOptions);
        }

        const page = await pool.sharedContext.newPage();
        const entry: PooledPlaywrightPageEntry = {
            context: pool.sharedContext,
            page,
            busy: false,
            prepared: false
        };
        pool.entries.push(entry);
        return entry;
    }

    if (!pool.contextOptions && typeof browser.newPage === 'function') {
        const page = await browser.newPage();
        const entry: PooledPlaywrightPageEntry = {
            context: null,
            page,
            busy: false,
            prepared: false
        };
        pool.entries.push(entry);
        return entry;
    }

    throw new Error('Connected Playwright browser does not support creating a pooled page');
}

function isRecoverableLocalBrowserSessionError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    const message = error.message.toLowerCase();
    return message.includes('browser has been closed')
        || message.includes('target page, context or browser has been closed')
        || message.includes('connection closed')
        || message.includes('browser closed')
        || message.includes('not connected');
}

async function recoverLocalBrowserSessionBrowser(browser: any): Promise<any | null> {
    if (config.playwrightWsEndpoint || config.playwrightCdpEndpoint) {
        return null;
    }

    if (!cachedLocalBrowserSession || cachedLocalBrowserSession.browser !== browser || !cachedLocalBrowserSessionOptions) {
        return null;
    }

    const playwright = await loadPlaywrightClient();
    if (!playwright) {
        return null;
    }

    cachedLocalBrowserSession = null;
    cachedLocalBrowserSessionKey = null;

    const recoveredSession = await getOrCreateLocalBrowserSession(
        playwright,
        cachedLocalBrowserSessionOptions.headless,
        cachedLocalBrowserSessionOptions.launchArgs,
        cachedLocalBrowserSessionOptions.options
    );
    return recoveredSession.browser;
}

async function acquirePooledPlaywrightPageOnce(
    browser: any,
    options?: AcquirePlaywrightPageOptions
): Promise<PooledPlaywrightPageSession> {
    const pool = getBrowserPlaywrightPagePool(browser, options);

    const entry = await withPoolAcquireLock(pool, async () => withCrossProcessPoolLock(pool.poolKey, async () => {
        if (pool.preferExistingContext && typeof browser.contexts === 'function') {
            const contexts = browser.contexts();
            if (Array.isArray(contexts) && contexts.length > 0) {
                await syncPoolWithReusableExistingContextPages(pool, contexts[0]);
            }
        }

        pool.entries = pool.entries.filter((candidate) => !isPageClosed(candidate.page));

        let candidate: PooledPlaywrightPageEntry | null = null;
        for (const poolEntry of pool.entries) {
            if (poolEntry.busy) {
                continue;
            }

            if (await tryAcquirePlaywrightPageLease(poolEntry.page, pool.poolKey)) {
                candidate = poolEntry;
                break;
            }
        }

        if (!candidate) {
            candidate = await createPooledPlaywrightPageEntry(browser, pool);
            const acquired = await tryAcquirePlaywrightPageLease(candidate.page, pool.poolKey);
            if (!acquired) {
                throw new Error(`Failed to acquire lease for newly created Playwright page in pool ${pool.poolKey}`);
            }
        }

        candidate.busy = true;
        return candidate;
    }));

    if (!entry.prepared) {
        try {
            if (pool.preparePage) {
                await pool.preparePage(entry.page);
            }
            entry.prepared = true;
        } catch (error) {
            if (isPageClosed(entry.page)) {
                pool.entries = pool.entries.filter((candidate) => candidate !== entry);
            } else {
                await releasePlaywrightPageLease(entry.page, pool.poolKey);
                entry.busy = false;
            }
            throw error;
        }
    }

    return {
        context: entry.context,
        page: entry.page,
        closePageContext: async () => {
            if (isPageClosed(entry.page)) {
                pool.entries = pool.entries.filter((candidate) => candidate !== entry);
                return;
            }

            await releasePlaywrightPageLease(entry.page, pool.poolKey);
            entry.busy = false;
        }
    };
}

export async function acquirePooledPlaywrightPage(
    browser: any,
    options?: AcquirePlaywrightPageOptions
): Promise<PooledPlaywrightPageSession> {
    try {
        return await acquirePooledPlaywrightPageOnce(browser, options);
    } catch (error) {
        if (!isRecoverableLocalBrowserSessionError(error)) {
            throw error;
        }

        const recoveredBrowser = await recoverLocalBrowserSessionBrowser(browser);
        if (!recoveredBrowser) {
            throw error;
        }

        return acquirePooledPlaywrightPageOnce(recoveredBrowser, options);
    }
}

function buildPlaywrightProxy(): { server: string; username?: string; password?: string } | undefined {
    const effectiveProxyUrl = getProxyUrl();
    if (!effectiveProxyUrl) {
        return undefined;
    }

    try {
        const proxyUrl = new URL(effectiveProxyUrl);
        return {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}${proxyUrl.port ? `:${proxyUrl.port}` : ''}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
    } catch (error) {
        console.warn('Invalid proxy URL for Playwright, falling back without browser proxy:', error);
        return undefined;
    }
}

function normalizeLoadedPlaywrightModule(loaded: any): PlaywrightModule | null {
    if (loaded?.chromium) {
        return loaded as PlaywrightModule;
    }
    if (loaded?.default?.chromium) {
        return loaded.default as PlaywrightModule;
    }
    return null;
}

function getLocalBrowserExecutablePath(): string {
    if (config.playwrightExecutablePath && existsSync(config.playwrightExecutablePath)) {
        return config.playwrightExecutablePath;
    }

    if (cachedBrowserPath) {
        return cachedBrowserPath;
    }

    const candidates: string[] = [];
    candidates.push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    candidates.push('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
    candidates.push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
    candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');

    const pf86 = process.env['PROGRAMFILES(X86)'];
    const pf = process.env['PROGRAMFILES'];
    const localAppData = process.env['LOCALAPPDATA'];
    if (pf86) {
        candidates.push(`${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`);
        candidates.push(`${pf86}\\Google\\Chrome\\Application\\chrome.exe`);
    }
    if (pf) {
        candidates.push(`${pf}\\Microsoft\\Edge\\Application\\msedge.exe`);
        candidates.push(`${pf}\\Google\\Chrome\\Application\\chrome.exe`);
    }
    if (localAppData) {
        candidates.push(`${localAppData}\\Google\\Chrome\\Application\\chrome.exe`);
    }

    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/microsoft-edge');
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');

    for (const candidate of [...new Set(candidates)]) {
        if (existsSync(candidate)) {
            cachedBrowserPath = candidate;
            return candidate;
        }
    }

    throw new Error('No Chromium-based browser executable was found. Configure PLAYWRIGHT_EXECUTABLE_PATH or install Edge/Chrome.');
}

function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (address && typeof address === 'object') {
                const { port } = address;
                server.close(() => resolve(port));
                return;
            }

            server.close(() => reject(new Error('Could not determine a free debugging port')));
        });
        server.on('error', reject);
    });
}

function buildLocalSessionKey(headless: boolean, launchArgs: string[], options?: OpenPlaywrightBrowserOptions): string {
    const proxy = buildPlaywrightProxy();

    return JSON.stringify({
        headless,
        hideWindow: options?.hideWindow === true,
        executablePath: config.playwrightExecutablePath || '',
        // 这里仅保留不含凭据的代理服务器标识和其哈希，用来区分会话，不把敏感信息写进 %TEMP%。
        proxyServer: proxy?.server || '',
        proxyFingerprint: proxy?.server
            ? createHash('sha256').update(proxy.server).digest('hex')
            : '',
        launchArgs
    });
}

function buildLocalBrowserCompatibilityKey(launchArgs: string[]): string {
    const proxy = buildPlaywrightProxy();
    const normalizedLaunchArgs = launchArgs.filter((arg) => ![
        '--window-position=-32000,-32000',
        '--window-size=1,1',
        '--disable-extensions',
        '--no-default-browser-check',
        '--headless=new',
        '--headless'
    ].includes(arg));

    return JSON.stringify({
        executablePath: config.playwrightExecutablePath || '',
        proxyServer: proxy?.server || '',
        proxyFingerprint: proxy?.server
            ? createHash('sha256').update(proxy.server).digest('hex')
            : '',
        launchArgs: normalizedLaunchArgs.sort()
    });
}

function isCompatibleLocalBrowserSessionMode(
    requestedMode: LocalBrowserSessionMode,
    candidateMode: LocalBrowserSessionMode
): boolean {
    if (requestedMode === 'headless') {
        return candidateMode === 'headless' || candidateMode === 'hidden-headed';
    }

    return requestedMode === candidateMode;
}

function getLocalBrowserSessionModeReuseScore(
    requestedMode: LocalBrowserSessionMode,
    candidateMode: LocalBrowserSessionMode
): number {
    if (requestedMode === candidateMode) {
        return 2;
    }

    if (requestedMode === 'headless' && candidateMode === 'hidden-headed') {
        return 1;
    }

    return 0;
}

function buildLocalBrowserProcessArgs(port: number, tempDir: string, launchArgs: string[], headless = false): string[] {
    const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${tempDir}`,
        ...launchArgs
    ];

    if (headless) {
        args.push('--headless=new');
    }

    const proxy = buildPlaywrightProxy();

    if (proxy?.server) {
        args.push(`--proxy-server=${proxy.server}`);
        if (proxy.username || proxy.password) {
            console.warn('Playwright local browser process proxy authentication is not applied via command-line flags. Use WS/CDP mode if authenticated proxy support is required.');
        }
    }

    return args;
}

function getLocalBrowserSessionMetadataPath(tempDir: string): string {
    return path.join(tempDir, LOCAL_BROWSER_SESSION_METADATA_FILE);
}

function getLocalBrowserSessionRegistryPath(): string {
    return path.join(tmpdir(), LOCAL_BROWSER_SESSION_REGISTRY_FILE);
}

function readLocalBrowserSessionRegistry(): LocalBrowserSessionRegistry {
    try {
        const parsed = JSON.parse(readFileSync(getLocalBrowserSessionRegistryPath(), 'utf8')) as LocalBrowserSessionRegistry;
        return parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object'
            ? parsed
            : { sessions: {} };
    } catch {
        return { sessions: {} };
    }
}

function writeLocalBrowserSessionRegistry(registry: LocalBrowserSessionRegistry): void {
    try {
        writeFileSync(getLocalBrowserSessionRegistryPath(), JSON.stringify(registry, null, 2), 'utf8');
    } catch {
        // Ignore registry write failures.
    }
}

function registerLocalBrowserSession(metadata: LocalBrowserSessionMetadata): void {
    const registry = readLocalBrowserSessionRegistry();
    registry.sessions[metadata.sessionKey] = {
        tempDir: metadata.tempDir,
        updatedAt: new Date().toISOString()
    };
    writeLocalBrowserSessionRegistry(registry);
}

function unregisterLocalBrowserSession(sessionKey: string, tempDir?: string): void {
    const registry = readLocalBrowserSessionRegistry();
    const existingEntry = registry.sessions[sessionKey];
    if (!existingEntry) {
        return;
    }

    if (tempDir && existingEntry.tempDir !== tempDir) {
        return;
    }

    delete registry.sessions[sessionKey];
    writeLocalBrowserSessionRegistry(registry);
}

function unregisterLocalBrowserSessionByTempDir(tempDir?: string): void {
    if (!tempDir) {
        return;
    }

    const registry = readLocalBrowserSessionRegistry();
    let changed = false;

    for (const [sessionKey, entry] of Object.entries(registry.sessions)) {
        if (entry.tempDir !== tempDir) {
            continue;
        }

        delete registry.sessions[sessionKey];
        changed = true;
    }

    if (changed) {
        writeLocalBrowserSessionRegistry(registry);
    }
}

function getRegisteredLocalBrowserSessionTempDir(sessionKey: string): string | null {
    const registry = readLocalBrowserSessionRegistry();
    return registry.sessions[sessionKey]?.tempDir ?? null;
}

function listRegisteredLocalBrowserSessionTempDirs(): string[] {
    const registeredTempDirs = new Set<string>();

    for (const entry of Object.values(readLocalBrowserSessionRegistry().sessions)) {
        if (entry?.tempDir) {
            registeredTempDirs.add(entry.tempDir);
        }
    }

    return [...registeredTempDirs];
}

/**
 * per-tempDir 的同步独占锁，保护 metadata 文件的 read-modify-write 操作。
 * 使用 koffi FFI 调用 OS 级文件锁（Windows: LockFileEx, Unix: flock），
 * 进程崩溃后锁自动释放。
 */
function withMetadataLock<T>(tempDir: string, operation: () => T): T {
    return withNativeFileLock(`${tempDir}.lock`, operation);
}

function writeLocalBrowserSessionMetadata(metadata: LocalBrowserSessionMetadata): void {
    try {
        writeFileSync(
            getLocalBrowserSessionMetadataPath(metadata.tempDir),
            JSON.stringify(metadata, null, 2),
            'utf8'
        );
        registerLocalBrowserSession(metadata);
    } catch {
        // Ignore metadata write failures.
    }
}

function readLocalBrowserSessionMetadata(tempDir: string): LocalBrowserSessionMetadata | null {
    try {
        const parsed = JSON.parse(readFileSync(getLocalBrowserSessionMetadataPath(tempDir), 'utf8')) as Partial<LocalBrowserSessionMetadata>;
        const sessionMode = parsed.sessionMode
            ?? (parsed.hideWindow
                ? 'hidden-headed'
                : parsed.strictCleanup
                    ? 'headless'
                    : 'headed');
        const compatibilityKey = parsed.compatibilityKey ?? JSON.stringify({
            executablePath: parsed.executablePath || '',
            proxyServer: '',
            proxyFingerprint: '',
            launchArgs: []
        });

        return {
            ownerPid: parsed.ownerPid ?? 0,
            browserPid: parsed.browserPid,
            debugPort: parsed.debugPort,
            tempDir: parsed.tempDir ?? tempDir,
            executablePath: parsed.executablePath ?? '',
            sessionKey: parsed.sessionKey ?? '',
            compatibilityKey,
            sessionMode,
            hideWindow: parsed.hideWindow ?? sessionMode === 'hidden-headed',
            strictCleanup: parsed.strictCleanup ?? sessionMode === 'headless',
            clientPids: Array.isArray(parsed.clientPids)
                ? parsed.clientPids.filter((pid): pid is number => Number.isInteger(pid) && pid > 0)
                : [],
            createdAt: parsed.createdAt ?? new Date(0).toISOString()
        };
    } catch {
        return null;
    }
}

function processExists(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function normalizeActiveClientPids(clientPids: number[]): number[] {
    return [...new Set(clientPids.filter((pid) => processExists(pid)))];
}

function registerLocalBrowserSessionClient(metadata: LocalBrowserSessionMetadata, pid = process.pid): LocalBrowserSessionMetadata {
    const normalizedMetadata: LocalBrowserSessionMetadata = {
        ...metadata,
        clientPids: normalizeActiveClientPids([...metadata.clientPids, pid]),
        ownerPid: pid
    };
    writeLocalBrowserSessionMetadata(normalizedMetadata);
    return normalizedMetadata;
}

function unregisterLocalBrowserSessionClient(metadata: LocalBrowserSessionMetadata, pid = process.pid): LocalBrowserSessionMetadata {
    const normalizedMetadata: LocalBrowserSessionMetadata = {
        ...metadata,
        clientPids: normalizeActiveClientPids(metadata.clientPids.filter((clientPid) => clientPid !== pid))
    };
    writeLocalBrowserSessionMetadata(normalizedMetadata);
    return normalizedMetadata;
}

function getProcessCommandLine(pid: number): string | null {
    if (!processExists(pid)) {
        return null;
    }

    try {
        if (process.platform === 'win32') {
            const output = execFileSync(
                'powershell.exe',
                [
                    '-NoProfile',
                    '-NonInteractive',
                    '-Command',
                    `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`
                ],
                { encoding: 'utf8', windowsHide: true, timeout: 5000 }
            );
            return output.trim() || null;
        }

        const output = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
            encoding: 'utf8',
            timeout: 5000
        });
        return output.trim() || null;
    } catch {
        return null;
    }
}

function processMatchesLocalBrowserSession(pid: number, tempDir: string): boolean {
    const commandLine = getProcessCommandLine(pid);
    if (!commandLine) {
        return false;
    }

    const matches = commandLine.includes(tempDir)
        && commandLine.includes('--remote-debugging-port=');
    return matches;
}

function quoteWindowsCommandLineArg(arg: string): string {
    if (arg.length === 0) {
        return '""';
    }

    if (!/[\s"]/u.test(arg)) {
        return arg;
    }

    let escaped = '"';
    let backslashCount = 0;

    for (const char of arg) {
        if (char === '\\') {
            backslashCount += 1;
            continue;
        }

        if (char === '"') {
            escaped += '\\'.repeat(backslashCount * 2 + 1);
            escaped += '"';
            backslashCount = 0;
            continue;
        }

        if (backslashCount > 0) {
            escaped += '\\'.repeat(backslashCount);
            backslashCount = 0;
        }

        escaped += char;
    }

    if (backslashCount > 0) {
        escaped += '\\'.repeat(backslashCount * 2);
    }

    escaped += '"';
    return escaped;
}

function updateLocalBrowserSessionOwner(metadata: LocalBrowserSessionMetadata, pid = process.pid): LocalBrowserSessionMetadata {
    return withMetadataLock(metadata.tempDir, () =>
        registerLocalBrowserSessionClient({
            ...metadata,
            ownerPid: pid
        }, pid)
    );
}

function extractTempDirFromCommandLine(commandLine: string): string | null {
    const match = commandLine.match(/--user-data-dir=(?:"([^"]+)"|(\S+))/);
    if (!match) {
        return null;
    }

    return match[1] || match[2] || null;
}

function parseProcessCreationDate(rawCreationDate: string): number {
    const cimMatch = rawCreationDate.match(/\/Date\((\d+)\)\//);
    if (cimMatch) {
        return Number.parseInt(cimMatch[1], 10);
    }

    return new Date(rawCreationDate).getTime();
}

function cleanupLegacyOrphanLocalBrowserProcesses(): void {
    if (process.platform !== 'win32') {
        return;
    }

    try {
        const raw = execFileSync(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') -and $_.CommandLine -match 'mcp-search-' -and $_.CommandLine -match '--remote-debugging-port=' -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine | ConvertTo-Json -Compress"
            ],
            { encoding: 'utf8', windowsHide: true, timeout: 5000 }
        ).trim();

        if (!raw) {
            return;
        }

        const parsed = JSON.parse(raw) as Array<{ ProcessId: number; ParentProcessId: number; CreationDate: string; CommandLine: string }> | { ProcessId: number; ParentProcessId: number; CreationDate: string; CommandLine: string };
        const processes = Array.isArray(parsed) ? parsed : [parsed];

        for (const processInfo of processes) {
            const tempDir = extractTempDirFromCommandLine(processInfo.CommandLine);
            if (!tempDir) {
                continue;
            }

            if (existsSync(getLocalBrowserSessionMetadataPath(tempDir))) {
                continue;
            }

            const createdAt = parseProcessCreationDate(processInfo.CreationDate);
            const isOldEnough = Number.isFinite(createdAt)
                && Date.now() - createdAt >= LEGACY_ORPHAN_BROWSER_GRACE_PERIOD_MS;

            if (!isOldEnough) {
                continue;
            }

            createForceKill(processInfo.ProcessId, tempDir)();
            console.error(`🧹 Cleaned legacy orphan Playwright browser session from PID ${processInfo.ProcessId}`);
        }
    } catch {
        // Ignore legacy cleanup failures.
    }
}

function cleanupStaleLocalBrowserSessions(): void {
    if (staleBrowserCleanupPerformed) {
        return;
    }

    staleBrowserCleanupPerformed = true;

    const entries = listRegisteredLocalBrowserSessionTempDirs();

    for (const tempDir of entries) {
        const metadataPath = getLocalBrowserSessionMetadataPath(tempDir);
        if (!existsSync(metadataPath)) {
            unregisterLocalBrowserSessionByTempDir(tempDir);
            continue;
        }

        try {
            // 使用独占锁保护 metadata 的 read-modify-write，
            // 解决并发 cleanup/连接进程写文件导致其他进程 JSON.parse 失败误删活跃会话的竞态条件。
            const shouldRemove = withMetadataLock(tempDir, () => {
                const metadata = readLocalBrowserSessionMetadata(tempDir);
                if (!metadata) {
                    return false;
                }

                const normalizedMetadata = registerLocalBrowserSessionClient({
                    ...metadata,
                    clientPids: metadata.clientPids.filter((pid) => pid !== process.pid)
                }, metadata.ownerPid);

                const browserIsAlive = normalizedMetadata.browserPid !== undefined
                    && processMatchesLocalBrowserSession(normalizedMetadata.browserPid, normalizedMetadata.tempDir);

                return !browserIsAlive;
            });

            if (shouldRemove) {
                unregisterLocalBrowserSessionByTempDir(tempDir);
                rmSync(tempDir, { recursive: true, force: true });
            }
        } catch {
            // Metadata lock or read failed; skip this entry.
        }
    }

    cleanupLegacyOrphanLocalBrowserProcesses();
}

async function connectToLocalDebugBrowser(playwright: PlaywrightModule, port: number): Promise<any> {
    const endpoint = `http://127.0.0.1:${port}`;

    for (let index = 0; index < 30; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        try {
            const response = await fetch(`${endpoint}/json/version`);
            const data = await response.json() as { webSocketDebuggerUrl?: string };
            if (data.webSocketDebuggerUrl) {
                return await playwright.chromium.connectOverCDP(endpoint, {
                    timeout: PLAYWRIGHT_CONNECT_TIMEOUT_MS
                });
            }
        } catch {
            // Browser is still starting.
        }
    }

    throw new Error('Timed out while waiting for the local browser debugging endpoint');
}

async function tryReusePersistedLocalBrowserSession(
    playwright: PlaywrightModule,
    requestedMode: LocalBrowserSessionMode,
    compatibilityKey: string
): Promise<LocalBrowserSession | null> {
    const entries = listRegisteredLocalBrowserSessionTempDirs();
    let bestMatch: { metadata: LocalBrowserSessionMetadata; score: number } | null = null;

    for (const tempDir of entries) {
        const metadata = readLocalBrowserSessionMetadata(tempDir);
        if (!metadata || metadata.compatibilityKey !== compatibilityKey) {
            continue;
        }

        if (!isCompatibleLocalBrowserSessionMode(requestedMode, metadata.sessionMode)) {
            continue;
        }

        const score = getLocalBrowserSessionModeReuseScore(requestedMode, metadata.sessionMode);
        if (!bestMatch || score > bestMatch.score) {
            bestMatch = { metadata, score };
        }
    }

    if (!bestMatch) {
        return null;
    }

    const metadata = bestMatch.metadata;

    if (!metadata.debugPort || !metadata.browserPid || !processMatchesLocalBrowserSession(metadata.browserPid, metadata.tempDir)) {
        unregisterLocalBrowserSession(metadata.sessionKey, metadata.tempDir);
        return null;
    }

    try {
        const browser = await connectToLocalDebugBrowser(playwright, metadata.debugPort);
        const updatedMetadata = updateLocalBrowserSessionOwner(metadata);
        const forceKill = createForceKill(metadata.browserPid, metadata.tempDir, browser);
        const session: LocalBrowserSession = {
            browser,
            sessionKey: updatedMetadata.sessionKey,
            sessionMode: updatedMetadata.sessionMode,
            browserPid: updatedMetadata.browserPid,
            debugPort: updatedMetadata.debugPort,
            tempDir: updatedMetadata.tempDir,
            closeBrowser: async () => {
                await closeLocalBrowserSession(session);
            },
            forceKill
        };
        console.error(`🧭 Reused existing Playwright browser session from PID ${metadata.browserPid}`);
        return session;
    } catch {
        unregisterLocalBrowserSession(metadata.sessionKey, metadata.tempDir);
    }

    return null;
}

async function closeLocalBrowserSession(session: LocalBrowserSession): Promise<void> {
    if (session.browserPid && session.tempDir) {
        // 使用独占锁保护 metadata 的 read-modify-write，避免并发退出时竞态
        const hasOtherClients = withMetadataLock(session.tempDir, () => {
            const metadata = readLocalBrowserSessionMetadata(session.tempDir!);
            const updatedMetadata = metadata
                ? unregisterLocalBrowserSessionClient(metadata)
                : null;
            return (updatedMetadata?.clientPids.length ?? 0) > 0;
        });

        if (session.sessionMode !== 'headed' && !hasOtherClients) {
            try {
                await Promise.race([
                    session.browser.close(),
                    new Promise((resolve) => {
                        const timer = setTimeout(resolve, 3000);
                        if (typeof timer === 'object' && 'unref' in timer) {
                            (timer as NodeJS.Timeout).unref();
                        }
                    })
                ]);
            } catch {
                // Ignore connection close errors for externally spawned browsers.
            }

            // 修复无头/隐藏头模式退出时遗留后台浏览器的问题：
            // 只有在当前进程释放后确认没有其它 Node 进程仍登记复用时，才真正结束外部浏览器根进程。
            session.forceKill();
            return;
        }

        try {
            await session.browser.close().catch(() => undefined);
        } catch {
            // Ignore close errors for reusable externally spawned browsers.
        }
        return;
    }

    try {
        await Promise.race([
            session.browser.close(),
            new Promise((resolve) => {
                const timer = setTimeout(resolve, 5000);
                if (typeof timer === 'object' && 'unref' in timer) {
                    (timer as NodeJS.Timeout).unref();
                }
            })
        ]);
    } catch {
        session.forceKill();
    }

    if (session.tempDir) {
        try {
            rmSync(session.tempDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors.
        }
    }
}

function createForceKill(browserPid?: number, tempDir?: string, browser?: any): () => void {
    return () => {
        try {
            browser?.disconnect?.();
        } catch {
            // Ignore disconnect errors.
        }

        if (browserPid) {
            if (process.platform === 'win32') {
                try {
                    execFileSync('taskkill', ['/F', '/T', '/PID', String(browserPid)], { windowsHide: true, timeout: 5000 });
                } catch {
                    // Ignore kill errors.
                }
            } else {
                try {
                    process.kill(-browserPid);
                } catch {
                    // Ignore group kill errors.
                }
                try {
                    process.kill(browserPid);
                } catch {
                    // Ignore direct kill errors.
                }
            }
        }

        if (tempDir) {
            try {
                unregisterLocalBrowserSessionByTempDir(tempDir);
                rmSync(tempDir, { recursive: true, force: true });
            } catch {
                // Ignore cleanup errors.
            }
        }
    };
}

function registerLocalBrowserCleanup(): void {
    if (cleanupRegistered) {
        return;
    }

    cleanupRegistered = true;
    process.once('exit', () => {
        if (cachedLocalBrowserSession) {
            cachedLocalBrowserSession = null;
            cachedLocalBrowserSessionKey = null;
        }
    });

    const handleSignalCleanup = async () => {
        if (cachedLocalBrowserSession) {
            await closeLocalBrowserSession(cachedLocalBrowserSession);
            cachedLocalBrowserSession = null;
            cachedLocalBrowserSessionKey = null;
        }
        process.exit();
    };

    process.once('SIGINT', handleSignalCleanup);
    process.once('SIGTERM', handleSignalCleanup);

    for (const signal of ['SIGBREAK', 'SIGHUP'] as NodeJS.Signals[]) {
        try {
            process.once(signal, handleSignalCleanup);
        } catch {
            // Signal is not supported on this platform/runtime.
        }
    }
}

async function launchHiddenDesktopBrowser(playwright: PlaywrightModule, sessionKey: string, launchArgs: string[]): Promise<LocalBrowserSession> {
    const browserPath = getLocalBrowserExecutablePath();
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-search-'));
    const port = await findFreePort();
    const args = buildLocalBrowserProcessArgs(port, tempDir, launchArgs);
    const compatibilityKey = buildLocalBrowserCompatibilityKey(launchArgs);
    // 解决隐藏桌面启动命令在参数含空格时的解析问题。
    // 这里通过逐项转义/加引号构造传给 CreateProcessW 的完整命令行，确保 user-data-dir 等参数不会被拆错。
    const cmdLine = [quoteWindowsCommandLineArg(browserPath), ...args.map((arg) => quoteWindowsCommandLineArg(arg))].join(' ');

    let browserPid: number | undefined;
    if (process.platform === 'win32') {
        // 通过 koffi FFI 直接调用 Win32 API 在隐藏桌面上启动浏览器
        const desktopName = `mcp-search-${Date.now()}`;
        browserPid = launchProcessOnHiddenDesktop(cmdLine, desktopName);
        writeLocalBrowserSessionMetadata({
            ownerPid: process.pid,
            browserPid,
            debugPort: port,
            tempDir,
            executablePath: browserPath,
            sessionKey,
            compatibilityKey,
            sessionMode: 'hidden-headed',
            hideWindow: true,
            strictCleanup: false,
            clientPids: [process.pid],
            createdAt: new Date().toISOString()
        });
        console.error(`🧭 Playwright browser started on hidden desktop "${desktopName}" (PID: ${browserPid})`);
    } else {
        const child = spawn(browserPath, args, {
            stdio: 'ignore',
            detached: true
        });
        child.on('error', () => undefined);
        child.unref();
        browserPid = child.pid;
        writeLocalBrowserSessionMetadata({
            ownerPid: process.pid,
            browserPid,
            debugPort: port,
            tempDir,
            executablePath: browserPath,
            sessionKey,
            compatibilityKey,
            sessionMode: 'hidden-headed',
            hideWindow: true,
            strictCleanup: false,
            clientPids: [process.pid],
            createdAt: new Date().toISOString()
        });
    }

    try {
        const browser = await connectToLocalDebugBrowser(playwright, port);
        const forceKill = createForceKill(browserPid, tempDir, browser);
        const session: LocalBrowserSession = {
            browser,
            sessionKey,
            sessionMode: 'hidden-headed',
            browserPid,
            debugPort: port,
            tempDir,
            closeBrowser: async () => {
                await closeLocalBrowserSession(session);
            },
            forceKill
        };
        return session;
    } catch (error) {
        createForceKill(browserPid, tempDir)();
        throw error;
    }
}

async function launchStandardLocalBrowser(playwright: PlaywrightModule, sessionKey: string, headless: boolean, launchArgs: string[]): Promise<LocalBrowserSession> {
    if (process.platform === 'win32') {
        const browserPath = getLocalBrowserExecutablePath();
        const tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-search-'));
        const port = await findFreePort();
        const args = buildLocalBrowserProcessArgs(port, tempDir, launchArgs, headless);
        const sessionMode: LocalBrowserSessionMode = headless ? 'headless' : 'headed';
        const compatibilityKey = buildLocalBrowserCompatibilityKey(launchArgs);
        const child = spawn(browserPath, args, {
            stdio: 'ignore',
            detached: true
        });
        child.on('error', () => undefined);
        child.unref();
        writeLocalBrowserSessionMetadata({
            ownerPid: process.pid,
            browserPid: child.pid,
            debugPort: port,
            tempDir,
            executablePath: browserPath,
            sessionKey,
            compatibilityKey,
            sessionMode,
            hideWindow: false,
            strictCleanup: sessionMode === 'headless',
            clientPids: [process.pid],
            createdAt: new Date().toISOString()
        });

        try {
            const browser = await connectToLocalDebugBrowser(playwright, port);
            const forceKill = createForceKill(child.pid, tempDir, browser);
            const session: LocalBrowserSession = {
                browser,
                sessionKey,
                sessionMode,
                browserPid: child.pid,
                debugPort: port,
                tempDir,
                closeBrowser: async () => {
                    await closeLocalBrowserSession(session);
                },
                forceKill
            };
            return session;
        } catch (error) {
            createForceKill(child.pid, tempDir)();
            throw error;
        }
    }

    // 修复 Windows 有头模式每次搜索都开关整个浏览器窗口的问题：
    // 这里改为复用外部 Edge 调试进程，使浏览器窗口常驻。
    // 其他情况仍用 Playwright 自带 launch 创建浏览器，避免扩大变更面。
    // 这里的区别只影响浏览器进程如何创建，以及 Windows 有头模式能否在服务重启后重连既有浏览器。
    // 同一服务进程内的浏览器会话复用和 Bing 标签页池复用，仍由上层缓存与页池逻辑统一处理。
    const browser = await playwright.chromium.launch({
        headless,
        proxy: buildPlaywrightProxy(),
        args: launchArgs,
        executablePath: config.playwrightExecutablePath
    });

    const forceKill = createForceKill(undefined, undefined, browser);
    const session: LocalBrowserSession = {
        browser,
        sessionKey,
        sessionMode: headless ? 'headless' : 'headed',
        closeBrowser: async () => {
            await closeLocalBrowserSession(session);
        },
        forceKill
    };
    return session;
}

async function destroyCachedLocalBrowserSession(): Promise<void> {
    if (localBrowserSessionPromise) {
        const inFlightPromise = localBrowserSessionPromise;
        localBrowserSessionPromise = null;
        try {
            const session = await inFlightPromise;
            await closeLocalBrowserSession(session);
        } catch {
            // Ignore launch/close errors during reset.
        }
    } else if (cachedLocalBrowserSession) {
        await closeLocalBrowserSession(cachedLocalBrowserSession);
    }

    cachedLocalBrowserSession = null;
    cachedLocalBrowserSessionKey = null;
    cachedLocalBrowserSessionOptions = null;
}

export async function shutdownLocalPlaywrightBrowserSessions(): Promise<void> {
    if (cachedLocalBrowserSession) {
        try {
            await closeLocalBrowserSession(cachedLocalBrowserSession);
        } finally {
            cachedLocalBrowserSession = null;
            cachedLocalBrowserSessionKey = null;
            cachedLocalBrowserSessionOptions = null;
        }
    }
}

async function getOrCreateLocalBrowserSession(
    playwright: PlaywrightModule,
    headless: boolean,
    launchArgs: string[],
    options?: OpenPlaywrightBrowserOptions
): Promise<LocalBrowserSession> {
    const sessionKey = buildLocalSessionKey(headless, launchArgs, options);
    const sessionMode = getLocalBrowserSessionMode(headless, options);
    const compatibilityKey = buildLocalBrowserCompatibilityKey(launchArgs);
    cachedLocalBrowserSessionOptions = {
        headless,
        launchArgs: [...launchArgs],
        options: options ? { ...options } : undefined
    };

    // 这里统一清理已经失活的登记会话，但不再误杀仍可跨进程复用的隐藏/无头调试浏览器。
    cleanupStaleLocalBrowserSessions();

    if (cachedLocalBrowserSession && cachedLocalBrowserSessionKey === sessionKey) {
        try {
            await cachedLocalBrowserSession.browser.version();
            return cachedLocalBrowserSession;
        } catch {
            cachedLocalBrowserSession = null;
            cachedLocalBrowserSessionKey = null;
        }
    }

    if (localBrowserSessionPromise && cachedLocalBrowserSessionKey === sessionKey) {
        return localBrowserSessionPromise;
    }

    // 不需要多会话缓存：tryReusePersistedLocalBrowserSession 的兼容性匹配已允许 hidden-headed 会话服务 headless 请求，
    // 且跨进程浏览器会话锁保证同一时刻只有一个进程能新建/切换会话。
    if (cachedLocalBrowserSession || localBrowserSessionPromise) {
        await destroyCachedLocalBrowserSession();
    }

    cachedLocalBrowserSessionKey = sessionKey;
    localBrowserSessionPromise = (async () => {
        return withCrossProcessBrowserSessionLock(sessionKey, async () => {
            const reusedSession = await tryReusePersistedLocalBrowserSession(playwright, sessionMode, compatibilityKey);
            if (reusedSession) {
                cachedLocalBrowserSession = reusedSession;
                registerLocalBrowserCleanup();
                return reusedSession;
            }

            // 修复隐藏/无头多进程并发时相互抢建并互相清理浏览器的问题：
            // 同一个 sessionKey 现在先走跨进程锁，再复用已登记的调试浏览器；只有确认不存在可重连会话时才新建。
            const session = options?.hideWindow
                ? await launchHiddenDesktopBrowser(playwright, sessionKey, launchArgs)
                : await launchStandardLocalBrowser(playwright, sessionKey, headless, launchArgs);
            session.sessionKey = sessionKey;
            cachedLocalBrowserSession = session;
            registerLocalBrowserCleanup();
            return session;
        });
    })().finally(() => {
        localBrowserSessionPromise = null;
    });

    return localBrowserSessionPromise;
}

function getPlaywrightModuleCandidates(): Array<{ label: string; specifier: string }> {
    const candidates: Array<{ label: string; specifier: string }> = [];
    const seenSpecifiers = new Set<string>();

    const pushCandidate = (label: string, specifier: string) => {
        if (seenSpecifiers.has(specifier)) {
            return;
        }
        seenSpecifiers.add(specifier);
        candidates.push({ label, specifier });
    };

    if (config.playwrightModulePath) {
        const resolvedModulePath = path.isAbsolute(config.playwrightModulePath)
            ? config.playwrightModulePath
            : path.resolve(process.cwd(), config.playwrightModulePath);
        pushCandidate(`PLAYWRIGHT_MODULE_PATH (${resolvedModulePath})`, resolvedModulePath);
    }

    if (config.playwrightPackage === 'auto') {
        pushCandidate('playwright package', 'playwright');
        pushCandidate('playwright-core package', 'playwright-core');
    } else {
        pushCandidate(`${config.playwrightPackage} package`, config.playwrightPackage);
    }

    return candidates;
}

export function getPlaywrightModuleSource(): string | null {
    return playwrightModuleSource;
}

function emitPlaywrightUnavailableWarning(options?: LoadPlaywrightClientOptions): void {
    if (options?.silent || !playwrightUnavailableMessage || hasEmittedPlaywrightUnavailableWarning) {
        return;
    }

    hasEmittedPlaywrightUnavailableWarning = true;
    console.warn(playwrightUnavailableMessage);
}

export async function loadPlaywrightClient(options?: LoadPlaywrightClientOptions): Promise<PlaywrightModule | null> {
    if (!playwrightModulePromise) {
        playwrightModulePromise = (async () => {
            const attempts: string[] = [];

            for (const candidate of getPlaywrightModuleCandidates()) {
                try {
                    const loaded = require(candidate.specifier);
                    const normalized = normalizeLoadedPlaywrightModule(loaded);
                    if (!normalized) {
                        attempts.push(`${candidate.label}: loaded module does not expose chromium`);
                        continue;
                    }

                    playwrightModuleSource = candidate.label;
                    playwrightUnavailableMessage = null;
                    hasEmittedPlaywrightUnavailableWarning = false;
                    console.error(`🧭 Playwright client resolved from ${candidate.label}`);
                    return normalized;
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    attempts.push(`${candidate.label}: ${message}`);
                }
            }

            playwrightUnavailableMessage = [
                'Playwright client is unavailable, falling back to HTTP-only behavior.',
                'Install `playwright` or `playwright-core`, or expose an existing client with PLAYWRIGHT_MODULE_PATH.',
                `Attempts: ${attempts.join(' | ')}`
            ].join(' ');
            return null;
        })();
    }

    const playwright = await playwrightModulePromise;
    if (!playwright) {
        emitPlaywrightUnavailableWarning(options);
    }
    return playwright;
}

export async function openPlaywrightBrowser(
    headless: boolean,
    launchArgs: string[] = [],
    options?: OpenPlaywrightBrowserOptions
): Promise<PlaywrightBrowserSession> {
    const playwright = await loadPlaywrightClient();
    if (!playwright) {
        throw new Error('Playwright client is not available. Install `playwright`/`playwright-core` manually or configure PLAYWRIGHT_MODULE_PATH.');
    }

    if (config.playwrightWsEndpoint) {
        const browser = await playwright.chromium.connect({
            wsEndpoint: config.playwrightWsEndpoint,
            timeout: PLAYWRIGHT_CONNECT_TIMEOUT_MS
        });
        return {
            browser,
            close: async () => {
                await browser.close().catch(() => undefined);
            }
        };
    }

    if (config.playwrightCdpEndpoint) {
        const browser = await playwright.chromium.connectOverCDP(config.playwrightCdpEndpoint, {
            timeout: PLAYWRIGHT_CONNECT_TIMEOUT_MS
        });
        return {
            browser,
            close: async () => {
                await browser.close().catch(() => undefined);
            }
        };
    }

    // 修复 Playwright 本地搜索每次都重新拉起浏览器的问题：
    // 这里改为复用单个后台浏览器会话，只有会话失活或启动参数变化时才重建。
    // 对 Bing 的隐藏有头模式，还会复用同一个隐藏桌面上的浏览器进程，避免窗口闪现到用户桌面。
    const session = await getOrCreateLocalBrowserSession(playwright, headless, launchArgs, options);

    return {
        browser: session.browser,
        close: async () => {
            // openPlaywrightBrowser 在本地模式下返回的是共享浏览器句柄；若在这里真实关闭，会破坏进程内浏览器复用与页池复用。
            // 共享浏览器的生命周期统一由 shutdownLocalPlaywrightBrowserSessions 管理，这里只释放调用方句柄语义。
            return Promise.resolve();
        }
    };
}
