import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { createServer } from 'net';
import { tmpdir } from 'os';
import path from 'path';
import { config, getProxyUrl } from '../config.js';
import { launchProcessOnHiddenDesktopWithPipes, readNamedPipeAsync, closeHandle, acquireNativeFileLock, tryNativeFileLock } from './nativeInterop.js';
import type { NativeFileLockHandle } from './nativeInterop.js';

const PLAYWRIGHT_CONNECT_TIMEOUT_MS = Math.max(config.playwrightNavigationTimeoutMs, 30000);
const PLAYWRIGHT_LOCAL_CDP_READINESS_TIMEOUT_MS = Math.max(config.playwrightNavigationTimeoutMs * 2, 60000);
const PLAYWRIGHT_LOCAL_CDP_READINESS_PROBE_TIMEOUT_MS = 1000;
const PLAYWRIGHT_LOCAL_CDP_READINESS_POLL_INTERVAL_MS = 1000;
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
    /**
     * 释放当前调用方持有的浏览器句柄。WS/CDP 远程连接会断开连接；本地共享浏览器不会在这里关闭进程。
     * CLI/daemon 生命周期结束时应调用 shutdownLocalPlaywrightBrowserSessions() 统一销毁本地共享浏览器。
     */
    release(): Promise<void>;
};

export type PooledPlaywrightPageSession = {
    context: any | null;
    page: any;
    /** 将页面释放回进程内/跨进程页面池。 */
    releasePage(): Promise<void>;
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
    domainKey?: string;
    sessionMode: LocalBrowserSessionMode;
    browserPid?: number;
    debugPort?: number;
    tempDir?: string;
    closeBrowser(): Promise<void>;
    forceKill(): void;
};

type LocalBrowserSessionMetadata = {
    domainKey: string;
    ownerPid: number;
    browserPid?: number;
    debugPort?: number;
    tempDir: string;
    executablePath: string;
    sessionKey: string;
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
    pageTargetId: string;
    pageLock: NativeFileLockHandle | null;
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
const LOCAL_BROWSER_DOMAIN_METADATA_PREFIX = 'domain-session-';
const LEGACY_ORPHAN_BROWSER_GRACE_PERIOD_MS = 60 * 1000;
const CROSS_PROCESS_POOL_LOCK_DIR = path.join(tmpdir(), 'open-websearch-page-pool-locks');
const CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR = path.join(tmpdir(), 'open-websearch-browser-session-locks');
const browserPlaywrightPagePools = new WeakMap<any, Map<string, BrowserPlaywrightPagePool>>();

// 用 CDP targetId（浏览器内全局唯一且跨连接稳定）作为锁文件标识，
// 确保所有进程对同一物理页始终竞争同一把锁。
// 如果 CDP targetId 获取失败则直接抛出错误——没有任何本地生成的 ID
// 能满足跨进程稳定性要求

async function getPlaywrightPageTargetId(page: any): Promise<string> {
    try {
        const context = typeof page?.context === 'function' ? page.context() : null;
        if (context && typeof context.newCDPSession === 'function') {
            const session = await context.newCDPSession(page);
            const info = await session.send('Target.getTargetInfo');
            const targetId = info?.targetInfo?.targetId;
            if (typeof targetId === 'string' && targetId.length > 0) {
                return targetId;
            }
        }
    } catch {}
    // CDP targetId 获取失败：不能回退到本地生成的 ID，否则不同进程会为
    // 同一物理页生成不同的锁标识，两个进程各自拿到锁并同时操作同一页。
    throw new Error('无法获取 CDP targetId，跨进程页面锁需要浏览器提供全局唯一的页面标识');
}

function getPageLockFilePath(poolKey: string, pageTargetId: string): string {
    mkdirSync(CROSS_PROCESS_POOL_LOCK_DIR, { recursive: true });
    const keyHash = createHash('sha1').update(`${poolKey}:${pageTargetId}`).digest('hex');
    return path.join(CROSS_PROCESS_POOL_LOCK_DIR, `page-${keyHash}.lock`);
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

function isPageClosed(page: any): boolean {
    try {
        return typeof page?.isClosed === 'function' ? page.isClosed() : false;
    } catch {
        return true;
    }
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
    // 如果 CDP 已经拿不到这个 page 对应的 Browser window，就把它视为不安全页（可能是浏览器弹出窗口），不参与复用。
    const { unavailable } = await getExistingContextPageWindowBounds(page);
    return unavailable;
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

        if (await isPopupLikePlaywrightPage(page)) {
            continue;
        }

        if (pool.entries.some((entry) => entry.page === page)) {
            continue;
        }

        // 收编所有当前可复用的现有标签页；当前唯一的排除规则是
        // 该 page 在 CDP 层已经找不到对应 Browser window。
        // await 之后仍要再次检查去重，否则并发扫描时仍可能把同一真实 page 重复塞进池子。
        const pageTargetId = await getPlaywrightPageTargetId(page);
        pool.entries.push({
            context,
            page,
            busy: false,
            prepared: false,
            pageTargetId,
            pageLock: null
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
            const pageTargetId = await getPlaywrightPageTargetId(page);
            const entry: PooledPlaywrightPageEntry = {
                context,
                page,
                busy: false,
                prepared: false,
                pageTargetId,
                pageLock: null
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
        const pageTargetId = await getPlaywrightPageTargetId(page);
        const entry: PooledPlaywrightPageEntry = {
            context: pool.sharedContext,
            page,
            busy: false,
            prepared: false,
            pageTargetId,
            pageLock: null
        };
        pool.entries.push(entry);
        return entry;
    }

    if (!pool.contextOptions && typeof browser.newPage === 'function') {
        const page = await browser.newPage();
        const pageTargetId = await getPlaywrightPageTargetId(page);
        const entry: PooledPlaywrightPageEntry = {
            context: null,
            page,
            busy: false,
            prepared: false,
            pageTargetId,
            pageLock: null
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

async function connectOverCdpOnly(
    playwright: PlaywrightModule,
    endpoint: string,
    timeout: number
): Promise<any> {
    return playwright.chromium.connectOverCDP(endpoint, { timeout });
}

async function waitForTimeout(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        if (typeof timer === 'object' && 'unref' in timer) {
            timer.unref();
        }
    });
}

async function withOperationTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), timeoutMs);
                if (typeof timer === 'object' && 'unref' in timer) {
                    timer.unref();
                }
            })
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

async function probeLocalCdpReadiness(
    playwright: PlaywrightModule,
    endpoint: string
): Promise<any> {
    const browser = await connectOverCdpOnly(
        playwright,
        endpoint,
        PLAYWRIGHT_LOCAL_CDP_READINESS_PROBE_TIMEOUT_MS
    );

    try {
        await withOperationTimeout(
            browser.version(),
            PLAYWRIGHT_LOCAL_CDP_READINESS_PROBE_TIMEOUT_MS,
            `Timed out while probing local browser CDP readiness after ${PLAYWRIGHT_LOCAL_CDP_READINESS_PROBE_TIMEOUT_MS}ms`
        );
        return browser;
    } catch (error) {
        await browser.close().catch(() => undefined);
        throw error;
    }
}

async function connectOverCdpWhenReady(
    playwright: PlaywrightModule,
    endpoint: string
): Promise<any> {
    const startedAt = Date.now();
    let lastError: unknown;

    while (Date.now() - startedAt < PLAYWRIGHT_LOCAL_CDP_READINESS_TIMEOUT_MS) {
        try {
            return await probeLocalCdpReadiness(playwright, endpoint);
        } catch (error) {
            lastError = error;
            // 这里只轮询本地 CDP 握手可用性，不参与任何页面导航或 Bing 加载判断，
            // 因此 1 秒探测超时不会把正常超过 1 秒的网页加载误判为失败。
            const elapsedMs = Date.now() - startedAt;
            const remainingMs = PLAYWRIGHT_LOCAL_CDP_READINESS_TIMEOUT_MS - elapsedMs;
            if (remainingMs <= 0) {
                break;
            }
            await waitForTimeout(Math.min(PLAYWRIGHT_LOCAL_CDP_READINESS_POLL_INTERVAL_MS, remainingMs));
        }
    }

    const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
    throw new Error(`Timed out while waiting for local browser CDP readiness after ${PLAYWRIGHT_LOCAL_CDP_READINESS_TIMEOUT_MS}ms.${suffix}`);
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

    const entry = await withPoolAcquireLock(pool, async () => {
        // 同步现有标签页
        if (pool.preferExistingContext && typeof browser.contexts === 'function') {
            const contexts = browser.contexts();
            if (Array.isArray(contexts) && contexts.length > 0) {
                await syncPoolWithReusableExistingContextPages(pool, contexts[0]);
            }
        }

        pool.entries = pool.entries.filter((candidate) => !isPageClosed(candidate.page));

        // 逐一尝试获取标签页的 OS 级独占锁
        let candidate: PooledPlaywrightPageEntry | null = null;
        for (const poolEntry of pool.entries) {
            if (poolEntry.busy) continue;

            const lockPath = getPageLockFilePath(pool.poolKey, poolEntry.pageTargetId);
            const lock = tryNativeFileLock(lockPath);
            if (lock) {
                poolEntry.pageLock = lock;
                candidate = poolEntry;
                break;
            }
        }

        // 所有锁都被占用时持续新建标签页，直到当前进程成功拿到某一页的 OS 锁。
        while (!candidate) {
            const createdEntry = await createPooledPlaywrightPageEntry(browser, pool);
            const lockPath = getPageLockFilePath(pool.poolKey, createdEntry.pageTargetId);
            const lock = tryNativeFileLock(lockPath);
            if (lock) {
                createdEntry.pageLock = lock;
                candidate = createdEntry;
                break;
            }

            // 新建页刚落地就可能被其他进程抢占；保留该页在池中，继续创建下一页重试。
        }

        candidate.busy = true;
        return candidate;
    });

    if (!entry.prepared) {
        try {
            if (pool.preparePage) {
                await pool.preparePage(entry.page);
            }
            entry.prepared = true;
        } catch (error) {
            if (isPageClosed(entry.page)) {
                // 修复 preparePage 失败且页面已关闭时只移除池条目、未释放 OS 页面锁的问题。
                // daemon 长时间运行时该分支若反复触发，会导致 fd/native lock 句柄累积。
                entry.pageLock?.release();
                entry.pageLock = null;
                pool.entries = pool.entries.filter((candidate) => candidate !== entry);
            } else {
                entry.pageLock?.release();
                entry.pageLock = null;
                entry.busy = false;
            }
            throw error;
        }
    }

    const releasePage = async () => {
        if (isPageClosed(entry.page)) {
            entry.pageLock?.release();
            entry.pageLock = null;
            pool.entries = pool.entries.filter((candidate) => candidate !== entry);
            return;
        }

        entry.pageLock?.release();
        entry.pageLock = null;
        entry.busy = false;
    };

    return {
        context: entry.context,
        page: entry.page,
        releasePage
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
    return JSON.stringify({
        headless,
        hideWindow: options?.hideWindow === true,
        executablePath: config.playwrightExecutablePath || '',
        launchArgs
    });
}

/**
 * 浏览器复用域策略：
 * - headed: `headed:<executablePath>`（不同浏览器路径用不同域）
 * - hidden-headed: `hidden-headed`（所有隐藏有头进程共享一个域）
 * - headless: `headless`（所有无头进程共享一个域）
 */
function buildBrowserDomainKey(mode: LocalBrowserSessionMode): string {
    if (mode === 'headed') {
        const execPath = config.playwrightExecutablePath || getLocalBrowserExecutablePath();
        return `headed:${execPath}`;
    }
    return mode;
}

function getBrowserDomainHash(domainKey: string): string {
    return createHash('sha1').update(domainKey).digest('hex');
}

function getBrowserDomainLockFilePathByHash(domainHash: string): string {
    mkdirSync(CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR, { recursive: true });
    return path.join(
        CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR,
        `domain-${domainHash}.lock`
    );
}

function getBrowserDomainLockFilePath(domainKey: string): string {
    return getBrowserDomainLockFilePathByHash(getBrowserDomainHash(domainKey));
}

function getBrowserDomainMetadataPath(domainKey: string): string {
    mkdirSync(CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR, { recursive: true });
    return path.join(
        CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR,
        `${LOCAL_BROWSER_DOMAIN_METADATA_PREFIX}${getBrowserDomainHash(domainKey)}.json`
    );
}

function listBrowserDomainMetadataEntries(): Array<{ domainHash: string; metadataPath: string }> {
    try {
        mkdirSync(CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR, { recursive: true });
        return readdirSync(CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR)
            .map((fileName) => {
                const match = fileName.match(new RegExp(`^${LOCAL_BROWSER_DOMAIN_METADATA_PREFIX}([a-f0-9]+)\\.json$`, 'u'));
                return match
                    ? { domainHash: match[1], metadataPath: path.join(CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR, fileName) }
                    : null;
            })
            .filter((entry): entry is { domainHash: string; metadataPath: string } => entry !== null);
    } catch {
        return [];
    }
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

    // 阻止 Edge 兼容层重启（compat layer relaunch）：Edge 启动时可能退出原始进程并以新 PID 重新启动，
    // 导致我们通过 stdio 管道监听 DevTools ready 信号的逻辑失败。此标志跳过该重启行为。
    args.push('--edge-skip-compat-layer-relaunch');

    const proxy = buildPlaywrightProxy();

    if (proxy?.server) {
        args.push(`--proxy-server=${proxy.server}`);
        if (proxy.username || proxy.password) {
            console.warn('Playwright local browser process proxy authentication is not applied via command-line flags. Use WS/CDP mode if authenticated proxy support is required.');
        }
    }

    return args;
}

function normalizeBrowserDomainMetadata(parsed: Partial<LocalBrowserSessionMetadata>): LocalBrowserSessionMetadata | null {
    if (typeof parsed.domainKey !== 'string' || parsed.domainKey.length === 0) return null;
    if (typeof parsed.tempDir !== 'string' || parsed.tempDir.length === 0) return null;
    if (typeof parsed.sessionKey !== 'string' || parsed.sessionKey.length === 0) return null;
    if (parsed.sessionMode !== 'headed' && parsed.sessionMode !== 'headless' && parsed.sessionMode !== 'hidden-headed') return null;

    return {
        domainKey: parsed.domainKey,
        ownerPid: Number.isInteger(parsed.ownerPid) ? parsed.ownerPid! : 0,
        browserPid: Number.isInteger(parsed.browserPid) ? parsed.browserPid : undefined,
        debugPort: Number.isInteger(parsed.debugPort) ? parsed.debugPort : undefined,
        tempDir: parsed.tempDir,
        executablePath: typeof parsed.executablePath === 'string' ? parsed.executablePath : '',
        sessionKey: parsed.sessionKey,
        sessionMode: parsed.sessionMode,
        hideWindow: parsed.hideWindow ?? parsed.sessionMode === 'hidden-headed',
        strictCleanup: parsed.strictCleanup ?? parsed.sessionMode === 'headless',
        clientPids: Array.isArray(parsed.clientPids)
            ? parsed.clientPids.filter((pid): pid is number => Number.isInteger(pid) && pid > 0)
            : [],
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date(0).toISOString()
    };
}

function readBrowserDomainMetadataFromPath(metadataPath: string): LocalBrowserSessionMetadata | null {
    try {
        return normalizeBrowserDomainMetadata(JSON.parse(readFileSync(metadataPath, 'utf8')) as Partial<LocalBrowserSessionMetadata>);
    } catch {
        return null;
    }
}

function readBrowserDomainMetadata(domainKey: string): LocalBrowserSessionMetadata | null {
    return readBrowserDomainMetadataFromPath(getBrowserDomainMetadataPath(domainKey));
}

function writeBrowserDomainMetadata(metadata: LocalBrowserSessionMetadata): void {
    try {
        writeFileSync(
            getBrowserDomainMetadataPath(metadata.domainKey),
            JSON.stringify(metadata, null, 2),
            'utf8'
        );
    } catch {
        // metadata 写入失败只影响跨进程复用，当前进程仍然可以继续使用已连接的浏览器。
    }
}

function clearBrowserDomainMetadata(domainKey: string, tempDir?: string): void {
    const metadataPath = getBrowserDomainMetadataPath(domainKey);
    if (tempDir) {
        const metadata = readBrowserDomainMetadataFromPath(metadataPath);
        if (metadata && metadata.tempDir !== tempDir) {
            return;
        }
    }

    try {
        rmSync(metadataPath, { force: true });
    } catch {
        // Ignore metadata cleanup failures.
    }
}

function isTempDirTrackedByDomainMetadata(tempDir: string): boolean {
    return listBrowserDomainMetadataEntries()
        .some(({ metadataPath }) => readBrowserDomainMetadataFromPath(metadataPath)?.tempDir === tempDir);
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
    writeBrowserDomainMetadata(normalizedMetadata);
    return normalizedMetadata;
}

function unregisterLocalBrowserSessionClient(metadata: LocalBrowserSessionMetadata, pid = process.pid): LocalBrowserSessionMetadata {
    const normalizedMetadata: LocalBrowserSessionMetadata = {
        ...metadata,
        clientPids: normalizeActiveClientPids(metadata.clientPids.filter((clientPid) => clientPid !== pid))
    };
    writeBrowserDomainMetadata(normalizedMetadata);
    return normalizedMetadata;
}

function isExecTimeoutError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }

    const candidate = error as {
        code?: unknown;
        message?: unknown;
    };

    return candidate.code === 'ETIMEDOUT'
        || (typeof candidate.message === 'string' && candidate.message.includes('ETIMEDOUT'));
}

function createProcessInspectionTimeoutError(message: string, cause: unknown): Error {
    const error = new Error(message);
    error.name = 'LocalBrowserProcessInspectionTimeoutError';
    (error as Error & { cause?: unknown }).cause = cause;
    return error;
}

function isProcessInspectionTimeoutError(error: unknown): boolean {
    return error instanceof Error && error.name === 'LocalBrowserProcessInspectionTimeoutError';
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
    } catch (error) {
        if (process.platform === 'win32' && isExecTimeoutError(error)) {
            throw createProcessInspectionTimeoutError(
                `PowerShell timed out while querying command line for PID ${pid}`,
                error
            );
        }

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
    return registerLocalBrowserSessionClient({
        ...metadata,
        ownerPid: pid
    }, pid);
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

            if (isTempDirTrackedByDomainMetadata(tempDir)) {
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
    } catch (error) {
        if (isExecTimeoutError(error)) {
            throw createProcessInspectionTimeoutError(
                'PowerShell timed out while enumerating legacy Playwright browser processes',
                error
            );
        }

        // Ignore legacy cleanup failures.
    }
}

function cleanupStaleLocalBrowserSessions(): void {
    if (staleBrowserCleanupPerformed) {
        return;
    }

    staleBrowserCleanupPerformed = true;

    const entries = listBrowserDomainMetadataEntries();

    for (const { domainHash, metadataPath } of entries) {
        const domainLock = acquireNativeFileLock(getBrowserDomainLockFilePathByHash(domainHash));
        try {
            // 每个域只有一个 metadata 文件，
            // cleanup 必须持有对应域锁后再读写，避免误删正在冷启动或刚复用的浏览器。
            const metadata = readBrowserDomainMetadataFromPath(metadataPath);
            if (!metadata) {
                rmSync(metadataPath, { force: true });
                continue;
            }

            const normalizedMetadata = registerLocalBrowserSessionClient({
                ...metadata,
                clientPids: metadata.clientPids.filter((pid) => pid !== process.pid)
            }, metadata.ownerPid);

            const browserIsAlive = normalizedMetadata.browserPid !== undefined
                && processMatchesLocalBrowserSession(normalizedMetadata.browserPid, normalizedMetadata.tempDir);

            if (!browserIsAlive) {
                clearBrowserDomainMetadata(normalizedMetadata.domainKey, normalizedMetadata.tempDir);
                rmSync(normalizedMetadata.tempDir, { recursive: true, force: true });
            }
        } catch (error) {
            if (isProcessInspectionTimeoutError(error)) {
                throw error;
            }

            // Metadata read failed; skip this entry.
        } finally {
            domainLock.release();
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
                return await connectOverCdpWhenReady(playwright, endpoint);
            }
        } catch {
            // Browser is still starting.
        }
    }

    throw new Error('Timed out while waiting for the local browser debugging endpoint');
}

/**
 * 等待浏览器通过 stdout/stderr 管道输出 "DevTools listening on ws://..." ready 信号。
 * Windows 隐藏桌面模式通过 Win32 管道读取，普通模式通过 Node.js ChildProcess 的 stdio。
 *
 * @returns debugPort 对应的 ws endpoint URL
 */
async function waitForBrowserReadyViaStdout(
    source: { type: 'pipe'; readHandle: any } | { type: 'child'; child: any },
    timeoutMs = 30000
): Promise<string> {
    let accumulated = '';

    if (source.type === 'pipe') {
        // Win32 管道：ReadFile 在 libuv 工作线程阻塞，事件驱动，主线程不轮询
        const readLoop = (async () => {
            while (true) {
                const chunk = await readNamedPipeAsync(source.readHandle, 4096);
                if (!chunk || chunk.length === 0) break; // pipe broken / EOF
                accumulated += chunk.toString('utf-8');
                const match = accumulated.match(/DevTools listening on (ws:\/\/[^\s]+)/);
                if (match) return match[1];
            }
            throw new Error('Pipe closed before browser emitted DevTools ready signal');
        })();

        const timeout = new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error(`Browser did not emit DevTools ready signal within ${timeoutMs}ms`)), timeoutMs);
            if (typeof timer === 'object' && 'unref' in timer) (timer as NodeJS.Timeout).unref();
        });

        return Promise.race([readLoop, timeout]);
    } else {
        // Node.js child process stdout/stderr
        const child = source.child;
        return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Browser did not emit DevTools ready signal within ${timeoutMs}ms`));
            }, timeoutMs);
            // 与管道分支保持一致：unref() 防止 timer 阻止 CLI/测试进程自然退出
            if (typeof timer === 'object' && 'unref' in timer) (timer as NodeJS.Timeout).unref();

            const onData = (data: Buffer) => {
                accumulated += data.toString('utf-8');
                const match = accumulated.match(/DevTools listening on (ws:\/\/[^\s]+)/);
                if (match) {
                    clearTimeout(timer);
                    child.stdout?.removeListener('data', onData);
                    child.stderr?.removeListener('data', onData);
                    resolve(match[1]);
                }
            };

            child.stdout?.on('data', onData);
            child.stderr?.on('data', onData);
            child.on('exit', () => {
                clearTimeout(timer);
                reject(new Error('Browser process exited before emitting DevTools ready signal'));
            });
        });
    }
}

/**
 * 在持有域锁的情况下，查找并复用已有的浏览器会话。
 * 域锁已保证同域内不会并发创建，这里只需找到匹配的会话并连接。
 */
async function tryReusePersistedLocalBrowserSession(
    playwright: PlaywrightModule,
    domainKey: string
): Promise<LocalBrowserSession | null> {
    const metadata = readBrowserDomainMetadata(domainKey);
    if (!metadata) return null;

    if (!metadata.debugPort || !metadata.browserPid) {
        clearBrowserDomainMetadata(domainKey, metadata.tempDir);
        return null;
    }

    // 尝试连接已有浏览器；如果浏览器已被用户关闭或崩溃，清理掉死 session 并返回 null
    const endpoint = `http://127.0.0.1:${metadata.debugPort}`;
    let browser: any;
    try {
        browser = await connectOverCdpWhenReady(playwright, endpoint);
    } catch {
        console.error(`🧹 Persisted browser session (PID ${metadata.browserPid}, port ${metadata.debugPort}) is no longer reachable, cleaning up`);
        clearBrowserDomainMetadata(domainKey, metadata.tempDir);
        try { rmSync(metadata.tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
        return null;
    }
    const updatedMetadata = updateLocalBrowserSessionOwner(metadata);
    const forceKill = createForceKill(metadata.browserPid, metadata.tempDir, browser, domainKey);
    const session: LocalBrowserSession = {
        browser,
        sessionKey: updatedMetadata.sessionKey,
        domainKey,
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
}

async function closeLocalBrowserSession(session: LocalBrowserSession): Promise<void> {
    if (session.browserPid && session.tempDir && session.domainKey) {
        const domainLockPath = getBrowserDomainLockFilePath(session.domainKey);
        const domainLock = acquireNativeFileLock(domainLockPath);

        if (session.sessionMode === 'headed') {
            try {
                // 有头模式：保留浏览器，只断开连接；metadata 仍在同一域锁下去掉当前 client。
                try {
                    await session.browser.close().catch(() => undefined);
                } catch {
                    // Ignore close errors for reusable headed browsers.
                }

                const metadata = readBrowserDomainMetadata(session.domainKey);
                if (metadata) unregisterLocalBrowserSessionClient(metadata);
            } finally {
                domainLock.release();
            }
            return;
        }

        try {
            const metadata = readBrowserDomainMetadata(session.domainKey);
            const updatedMetadata = metadata
                ? unregisterLocalBrowserSessionClient(metadata)
                : null;
            const hasOtherClients = (updatedMetadata?.clientPids.length ?? 0) > 0;

            if (!hasOtherClients) {
                // 最后一个使用者：关闭浏览器，并清理当前域的唯一 metadata。
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
                    // Ignore close errors.
                }
                session.forceKill();
            } else {
                // 还有其他使用者：保留浏览器，只断开
                try {
                    await session.browser.close().catch(() => undefined);
                } catch {
                    // Ignore close errors.
                }
            }
        } finally {
            domainLock.release();
        }
        return;
    }

    // 无 browserPid/tempDir 的会话（如 Playwright launch 创建的）
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

function createForceKill(browserPid?: number, tempDir?: string, browser?: any, domainKey?: string): () => void {
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
                if (domainKey) {
                    clearBrowserDomainMetadata(domainKey, tempDir);
                }
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

async function launchHiddenDesktopBrowser(playwright: PlaywrightModule, sessionKey: string, domainKey: string, launchArgs: string[]): Promise<LocalBrowserSession> {
    const browserPath = getLocalBrowserExecutablePath();
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-search-'));
    const port = await findFreePort();
    const args = buildLocalBrowserProcessArgs(port, tempDir, launchArgs);
    const cmdLine = [quoteWindowsCommandLineArg(browserPath), ...args.map((arg) => quoteWindowsCommandLineArg(arg))].join(' ');

    let browserPid: number | undefined;
    let pipeHandle: any = null;

    if (process.platform === 'win32') {
        const desktopName = `mcp-search-${Date.now()}`;
        const result = launchProcessOnHiddenDesktopWithPipes(cmdLine, desktopName);
        browserPid = result.pid;
        pipeHandle = result.readStdoutHandle;
        console.error(`🧭 Playwright browser started on hidden desktop "${desktopName}" (PID: ${browserPid})`);
    } else {
        const child = spawn(browserPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true
        });
        child.on('error', () => undefined);
        browserPid = child.pid;

        try {
            await waitForBrowserReadyViaStdout({ type: 'child', child });
        } catch (error) {
            createForceKill(browserPid, tempDir, undefined, domainKey)();
            throw error;
        }

        // 不再需要 stdio，断开引用让子进程脱离
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();

        const endpoint = `http://127.0.0.1:${port}`;
        try {
            const browser = await connectOverCdpWhenReady(playwright, endpoint);
            writeBrowserDomainMetadata({
                domainKey,
                ownerPid: process.pid,
                browserPid,
                debugPort: port,
                tempDir,
                executablePath: browserPath,
                sessionKey,
                sessionMode: 'hidden-headed',
                hideWindow: true,
                strictCleanup: false,
                clientPids: [process.pid],
                createdAt: new Date().toISOString()
            });
            const forceKill = createForceKill(browserPid, tempDir, browser, domainKey);
            const session: LocalBrowserSession = {
                browser, sessionKey, domainKey, sessionMode: 'hidden-headed',
                browserPid, debugPort: port, tempDir,
                closeBrowser: async () => { await closeLocalBrowserSession(session); },
                forceKill
            };
            return session;
        } catch (error) {
            createForceKill(browserPid, tempDir, undefined, domainKey)();
            throw error;
        }
    }

    // Windows 路径：通过管道等待 ready
    try {
        await waitForBrowserReadyViaStdout({ type: 'pipe', readHandle: pipeHandle });
    } catch (error) {
        closeHandle(pipeHandle);
        createForceKill(browserPid, tempDir, undefined, domainKey)();
        throw error;
    }
    closeHandle(pipeHandle);

    const endpoint = `http://127.0.0.1:${port}`;
    try {
        const browser = await connectOverCdpWhenReady(playwright, endpoint);
        writeBrowserDomainMetadata({
            domainKey,
            ownerPid: process.pid,
            browserPid,
            debugPort: port,
            tempDir,
            executablePath: browserPath,
            sessionKey,
            sessionMode: 'hidden-headed',
            hideWindow: true,
            strictCleanup: false,
            clientPids: [process.pid],
            createdAt: new Date().toISOString()
        });
        const forceKill = createForceKill(browserPid, tempDir, browser, domainKey);
        const session: LocalBrowserSession = {
            browser, sessionKey, domainKey, sessionMode: 'hidden-headed',
            browserPid, debugPort: port, tempDir,
            closeBrowser: async () => { await closeLocalBrowserSession(session); },
            forceKill
        };
        return session;
    } catch (error) {
        createForceKill(browserPid, tempDir, undefined, domainKey)();
        throw error;
    }
}

async function launchStandardLocalBrowser(playwright: PlaywrightModule, sessionKey: string, domainKey: string, headless: boolean, launchArgs: string[]): Promise<LocalBrowserSession> {
    if (process.platform === 'win32') {
        const browserPath = getLocalBrowserExecutablePath();
        const tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-search-'));
        const port = await findFreePort();
        const args = buildLocalBrowserProcessArgs(port, tempDir, launchArgs, headless);
        const sessionMode: LocalBrowserSessionMode = headless ? 'headless' : 'headed';

        // 使用 pipe 模式启动，监听 stdout ready 信号
        const child = spawn(browserPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true
        });
        child.on('error', () => undefined);

        try {
            await waitForBrowserReadyViaStdout({ type: 'child', child });
        } catch (error) {
            createForceKill(child.pid, tempDir, undefined, domainKey)();
            throw error;
        }

        // Ready 后断开 stdio 引用，让子进程脱离
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();

        const endpoint = `http://127.0.0.1:${port}`;
        try {
            const browser = await connectOverCdpWhenReady(playwright, endpoint);
            writeBrowserDomainMetadata({
                domainKey,
                ownerPid: process.pid,
                browserPid: child.pid,
                debugPort: port,
                tempDir,
                executablePath: browserPath,
                sessionKey,
                sessionMode,
                hideWindow: false,
                strictCleanup: sessionMode === 'headless',
                clientPids: [process.pid],
                createdAt: new Date().toISOString()
            });
            const forceKill = createForceKill(child.pid, tempDir, browser, domainKey);
            const session: LocalBrowserSession = {
                browser, sessionKey, domainKey, sessionMode,
                browserPid: child.pid, debugPort: port, tempDir,
                closeBrowser: async () => { await closeLocalBrowserSession(session); },
                forceKill
            };
            return session;
        } catch (error) {
            createForceKill(child.pid, tempDir, undefined, domainKey)();
            throw error;
        }
    }

    // 非 Windows：使用 Playwright 自带 launch
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
        domainKey,
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
    cachedLocalBrowserSessionOptions = {
        headless,
        launchArgs: [...launchArgs],
        options: options ? { ...options } : undefined
    };

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

    if (cachedLocalBrowserSession || localBrowserSessionPromise) {
        await destroyCachedLocalBrowserSession();
    }

    cachedLocalBrowserSessionKey = sessionKey;
    localBrowserSessionPromise = (async () => {
        const domainKey = buildBrowserDomainKey(sessionMode);
        // 获取域锁：同域内同一时刻只有一个进程能操作浏览器
        const domainLockPath = getBrowserDomainLockFilePath(domainKey);
        const domainLock = acquireNativeFileLock(domainLockPath);
        let domainLockReleased = false;
        const releaseDomainLock = () => {
            if (domainLockReleased) {
                return;
            }
            domainLockReleased = true;
            domainLock.release();
        };

        try {
            // 持有域锁时，检查是否已有可复用的浏览器
            const reusedSession = await tryReusePersistedLocalBrowserSession(playwright, domainKey);
            if (reusedSession) {
                // 复用成功，立即释放域锁
                releaseDomainLock();
                cachedLocalBrowserSession = reusedSession;
                registerLocalBrowserCleanup();
                return reusedSession;
            }

            // 无头模式降级：如果无头锁域内无浏览器，检查 hidden-headed 是否存在。
            // 必须先获取 hidden-headed 域锁，否则在我们连接的瞬间，
            // 另一个 hidden-headed 进程可能正在 closeLocalBrowserSession 中判定自己是
            // 最后一个使用者并杀死浏览器，导致我们拿到一个已死的连接。
            if (sessionMode === 'headless') {
                const hiddenHeadedDomainKey = buildBrowserDomainKey('hidden-headed');
                const hiddenHeadedLockPath = getBrowserDomainLockFilePath(hiddenHeadedDomainKey);
                const hiddenHeadedLock = acquireNativeFileLock(hiddenHeadedLockPath);
                let hiddenHeadedLockReleased = false;
                const releaseHiddenHeadedLock = () => {
                    if (hiddenHeadedLockReleased) {
                        return;
                    }
                    hiddenHeadedLockReleased = true;
                    hiddenHeadedLock.release();
                };
                try {
                    const hiddenHeadedSession = await tryReusePersistedLocalBrowserSession(playwright, hiddenHeadedDomainKey);
                    if (hiddenHeadedSession) {
                        // 复用成功，释放两把域锁
                        releaseHiddenHeadedLock();
                        releaseDomainLock();
                        // 更新 session 信息以反映实际模式
                        hiddenHeadedSession.sessionKey = sessionKey;
                        cachedLocalBrowserSession = hiddenHeadedSession;
                        registerLocalBrowserCleanup();
                        return hiddenHeadedSession;
                    }
                } finally {
                    releaseHiddenHeadedLock();
                }
            }

            // 没有可复用浏览器时才新建；launch* 内部会等待 stdout ready 后继续探测 CDP Browser 域可响应。
            // 整个过程仍持有原有域锁，避免第二个并发请求在 CDP 尚未可用时误判为不可复用并再启动一个浏览器。
            const session = options?.hideWindow
                ? await launchHiddenDesktopBrowser(playwright, sessionKey, domainKey, launchArgs)
                : await launchStandardLocalBrowser(playwright, sessionKey, domainKey, headless, launchArgs);
            session.sessionKey = sessionKey;

            // 浏览器进程与 CDP 连接都已就绪，释放域锁允许后续进程复用。
            releaseDomainLock();

            cachedLocalBrowserSession = session;
            registerLocalBrowserCleanup();
            return session;
        } catch (error) {
            releaseDomainLock();
            throw error;
        }
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
        const release = async () => {
            await browser.close().catch(() => undefined);
        };
        return {
            browser,
            release
        };
    }

    if (config.playwrightCdpEndpoint) {
        const browser = await playwright.chromium.connectOverCDP(config.playwrightCdpEndpoint, {
            timeout: PLAYWRIGHT_CONNECT_TIMEOUT_MS
        });
        const release = async () => {
            await browser.close().catch(() => undefined);
        };
        return {
            browser,
            release
        };
    }

    // 修复 Playwright 本地搜索每次都重新拉起浏览器的问题：
    // 这里改为复用单个后台浏览器会话，只有会话失活或启动参数变化时才重建。
    // 对 Bing 的隐藏有头模式，还会复用同一个隐藏桌面上的浏览器进程，避免窗口闪现到用户桌面。
    const session = await getOrCreateLocalBrowserSession(playwright, headless, launchArgs, options);
    const release = async () => {
        // 本地模式返回共享浏览器句柄，release 只释放调用方引用，
        // 不真正关闭浏览器；真正销毁由 CLI/daemon 在生命周期结束时调用 shutdownLocalPlaywrightBrowserSessions()。
        return Promise.resolve();
    };

    return {
        browser: session.browser,
        release
    };
}
