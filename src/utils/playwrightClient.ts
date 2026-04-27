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
// 修复 CDP ready 探测单次等待策略过硬的问题：从 1 秒开始指数退避，避免每轮都用同一个短超时窗口误判启动中的浏览器。
const PLAYWRIGHT_LOCAL_CDP_READINESS_INITIAL_PROBE_TIMEOUT_MS = 1000;
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

type LocalBrowserSessionMetadataFile = {
    browserPid?: number;
    debugPort?: number;
    tempDir: string;
    clientPids?: number[];
};

type LocalBrowserSessionMetadata = {
    domainKey?: string;
    metadataPath?: string;
    sessionMode: LocalBrowserSessionMode;
    browserPid?: number;
    debugPort?: number;
    tempDir: string;
    clientPids: number[];
};

type BrowserDomainMetadataEntry = {
    domainHash: string;
    sessionMode: LocalBrowserSessionMode;
    metadataPath: string;
};

type LocalBrowserProcessCandidate = {
    pid: number;
    debugPort: number;
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

async function closeConnectedCdpBrowser(browser: any, timeoutMs = 3000): Promise<void> {
    if (!browser || typeof browser.close !== 'function') {
        return;
    }

    await Promise.race([
        browser.close(),
        new Promise((resolve) => {
            const timer = setTimeout(resolve, timeoutMs);
            if (typeof timer === 'object' && 'unref' in timer) {
                (timer as NodeJS.Timeout).unref();
            }
        })
    ]).catch(() => undefined);
}

function detachLaunchedChildProcess(child: any): void {
    try {
        child.stdout?.destroy?.();
    } catch {
        // Ignore stream cleanup errors.
    }
    try {
        child.stderr?.destroy?.();
    } catch {
        // Ignore stream cleanup errors.
    }
    try {
        child.unref?.();
    } catch {
        // Ignore unref errors.
    }
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function waitForTimeout(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
        // 这是主动等待 CDP readiness 的控制流，不能 unref；否则进程可能在 metadata 写入前提前退出，留下不可复用的孤儿浏览器窗口。
        setTimeout(resolve, ms);
    });
}

async function withOperationTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                // 这是正在执行的探测超时，必须保持 ref，避免 top-level await 在探测失败重试期间被 Node 提前判定为 unsettled。
                timer = setTimeout(() => reject(new Error(message)), timeoutMs);
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
    endpoint: string,
    probeTimeoutMs: number
): Promise<any> {
    const browser = await connectOverCdpOnly(
        playwright,
        endpoint,
        probeTimeoutMs
    );

    try {
        await withOperationTimeout(
            browser.version(),
            probeTimeoutMs,
            `Timed out while probing local browser CDP readiness after ${probeTimeoutMs}ms`
        );
        return browser;
    } catch (error) {
        // 探测失败只释放这次 CDP 连接；加超时是为了避免 readiness 重试或进程退出被 close 卡住。
        await closeConnectedCdpBrowser(browser);
        throw error;
    }
}

async function connectOverCdpWhenReady(
    playwright: PlaywrightModule,
    endpoint: string
): Promise<any> {
    const startedAt = Date.now();
    let lastError: unknown;
    let probeTimeoutMs = PLAYWRIGHT_LOCAL_CDP_READINESS_INITIAL_PROBE_TIMEOUT_MS;

    while (Date.now() - startedAt < PLAYWRIGHT_LOCAL_CDP_READINESS_TIMEOUT_MS) {
        const remainingBeforeProbeMs = PLAYWRIGHT_LOCAL_CDP_READINESS_TIMEOUT_MS - (Date.now() - startedAt);
        if (remainingBeforeProbeMs <= 0) {
            break;
        }

        const currentProbeTimeoutMs = Math.min(probeTimeoutMs, remainingBeforeProbeMs);
        try {
            return await probeLocalCdpReadiness(playwright, endpoint, currentProbeTimeoutMs);
        } catch (error) {
            lastError = error;
            // 这里只轮询本地 CDP 握手和 Browser.getVersion 可用性，不参与任何页面导航或 Bing 加载判断。
            // 每轮失败后加倍下一轮探测窗口，同时仍受整体 readiness 超时约束。
            probeTimeoutMs = Math.min(probeTimeoutMs * 2, PLAYWRIGHT_LOCAL_CDP_READINESS_TIMEOUT_MS);
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

function getLocalBrowserSessionModeFromDomainKey(domainKey: string): LocalBrowserSessionMode {
    if (domainKey.startsWith('headed:')) {
        return 'headed';
    }

    if (domainKey === 'hidden-headed') {
        return 'hidden-headed';
    }

    if (domainKey === 'headless') {
        return 'headless';
    }

    throw new Error(`Unknown local browser domain key: ${domainKey}`);
}

function getBrowserDomainMetadataPath(domainKey: string): string {
    mkdirSync(CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR, { recursive: true });
    const sessionMode = getLocalBrowserSessionModeFromDomainKey(domainKey);
    return path.join(
        CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR,
        `${LOCAL_BROWSER_DOMAIN_METADATA_PREFIX}${sessionMode}-${getBrowserDomainHash(domainKey)}.json`
    );
}

function listBrowserDomainMetadataEntries(): BrowserDomainMetadataEntry[] {
    try {
        mkdirSync(CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR, { recursive: true });
        const metadataFilePattern = new RegExp(
            `^${LOCAL_BROWSER_DOMAIN_METADATA_PREFIX}(headed|headless|hidden-headed)-([a-f0-9]+)\\.json$`,
            'u'
        );
        return readdirSync(CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR)
            .map((fileName) => {
                const match = fileName.match(metadataFilePattern);
                return match
                    ? {
                        sessionMode: match[1] as LocalBrowserSessionMode,
                        domainHash: match[2],
                        metadataPath: path.join(CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR, fileName)
                    }
                    : null;
            })
            .filter((entry): entry is BrowserDomainMetadataEntry => entry !== null);
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

function normalizeBrowserDomainMetadata(
    parsed: Partial<LocalBrowserSessionMetadataFile>,
    sessionMode: LocalBrowserSessionMode,
    metadataPath?: string,
    domainKey?: string
): LocalBrowserSessionMetadata | null {
    if (typeof parsed.tempDir !== 'string' || parsed.tempDir.length === 0) return null;

    return {
        domainKey,
        metadataPath,
        sessionMode,
        browserPid: Number.isInteger(parsed.browserPid) ? parsed.browserPid : undefined,
        debugPort: Number.isInteger(parsed.debugPort) ? parsed.debugPort : undefined,
        tempDir: parsed.tempDir,
        clientPids: shouldTrackLocalBrowserSessionClients(sessionMode) && Array.isArray(parsed.clientPids)
            ? parsed.clientPids.filter((pid): pid is number => Number.isInteger(pid) && pid > 0)
            : []
    };
}

function readBrowserDomainMetadataFromPath(metadataPath: string, sessionMode: LocalBrowserSessionMode, domainKey?: string): LocalBrowserSessionMetadata | null {
    try {
        return normalizeBrowserDomainMetadata(
            JSON.parse(readFileSync(metadataPath, 'utf8')) as Partial<LocalBrowserSessionMetadataFile>,
            sessionMode,
            metadataPath,
            domainKey
        );
    } catch {
        return null;
    }
}

function readBrowserDomainMetadata(domainKey: string): LocalBrowserSessionMetadata | null {
    return readBrowserDomainMetadataFromPath(
        getBrowserDomainMetadataPath(domainKey),
        getLocalBrowserSessionModeFromDomainKey(domainKey),
        domainKey
    );
}

function serializeBrowserDomainMetadata(metadata: LocalBrowserSessionMetadata): LocalBrowserSessionMetadataFile {
    const serializedMetadata: LocalBrowserSessionMetadataFile = {
        browserPid: metadata.browserPid,
        debugPort: metadata.debugPort,
        tempDir: metadata.tempDir
    };

    if (shouldTrackLocalBrowserSessionClients(metadata.sessionMode)) {
        serializedMetadata.clientPids = normalizeActiveClientPids(metadata.clientPids);
    }

    return serializedMetadata;
}

function writeBrowserDomainMetadata(metadata: LocalBrowserSessionMetadata): void {
    const metadataPath = metadata.domainKey
        ? getBrowserDomainMetadataPath(metadata.domainKey)
        : metadata.metadataPath;
    if (!metadataPath) return;

    try {
        writeFileSync(
            metadataPath,
            JSON.stringify(serializeBrowserDomainMetadata(metadata), null, 2),
            'utf8'
        );
    } catch {
        // metadata 写入失败只影响跨进程复用，当前进程仍然可以继续使用已连接的浏览器。
    }
}

function readBrowserDomainMetadataTempDirFromPath(metadataPath: string): string | undefined {
    try {
        const parsed = JSON.parse(readFileSync(metadataPath, 'utf8')) as Partial<LocalBrowserSessionMetadataFile>;
        return typeof parsed.tempDir === 'string' ? parsed.tempDir : undefined;
    } catch {
        return undefined;
    }
}

function clearBrowserDomainMetadataFromPath(metadataPath: string, tempDir?: string): void {
    if (tempDir) {
        const currentTempDir = readBrowserDomainMetadataTempDirFromPath(metadataPath);
        if (currentTempDir && currentTempDir !== tempDir) {
            return;
        }
    }

    try {
        rmSync(metadataPath, { force: true });
    } catch {
        // Ignore metadata cleanup failures.
    }
}

function clearBrowserDomainMetadata(domainKey: string, tempDir?: string): void {
    clearBrowserDomainMetadataFromPath(getBrowserDomainMetadataPath(domainKey), tempDir);
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

function shouldTrackLocalBrowserSessionClients(sessionMode: LocalBrowserSessionMode): boolean {
    return sessionMode !== 'headed';
}

function registerLocalBrowserSessionClient(metadata: LocalBrowserSessionMetadata, pid = process.pid): LocalBrowserSessionMetadata {
    if (!shouldTrackLocalBrowserSessionClients(metadata.sessionMode)) {
        // 有头 metadata 文件只记录连接浏览器的三个字段，客户端列表完全不写入 JSON。
        return { ...metadata, clientPids: [] };
    }

    const normalizedMetadata: LocalBrowserSessionMetadata = {
        ...metadata,
        clientPids: normalizeActiveClientPids([...metadata.clientPids, pid])
    };
    writeBrowserDomainMetadata(normalizedMetadata);
    return normalizedMetadata;
}

function unregisterLocalBrowserSessionClient(metadata: LocalBrowserSessionMetadata, pid = process.pid): LocalBrowserSessionMetadata {
    if (!shouldTrackLocalBrowserSessionClients(metadata.sessionMode)) {
        // 有头 metadata 文件没有客户端列表，因此 release 不需要注销并改写文件。
        return { ...metadata, clientPids: [] };
    }

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

function getLocalBrowserDebugPortCommandLineFragment(debugPort?: number): string {
    return isValidLocalBrowserDebugPort(debugPort)
        ? `--remote-debugging-port=${debugPort}`
        : '--remote-debugging-port=';
}

function isValidLocalBrowserDebugPort(debugPort: number | undefined): debugPort is number {
    return typeof debugPort === 'number' && Number.isInteger(debugPort) && debugPort > 0;
}

function extractLocalBrowserDebugPortFromCommandLine(commandLine: string): number | undefined {
    const match = commandLine.match(/--remote-debugging-port=(\d+)/u);
    if (!match) {
        return undefined;
    }

    const debugPort = Number(match[1]);
    return Number.isInteger(debugPort) && debugPort > 0 ? debugPort : undefined;
}

function commandLineMatchesLocalBrowserCandidate(commandLine: string, tempDir: string, debugPort?: number): boolean {
    return commandLine.includes(tempDir)
        && commandLine.includes(getLocalBrowserDebugPortCommandLineFragment(debugPort))
        && !commandLine.includes('--type=');
}

function createLocalBrowserCandidateFromCommandLine(
    pid: number,
    commandLine: string,
    tempDir: string,
    debugPort?: number
): LocalBrowserProcessCandidate | null {
    if (!Number.isInteger(pid) || pid <= 0 || !commandLineMatchesLocalBrowserCandidate(commandLine, tempDir, debugPort)) {
        return null;
    }

    const candidateDebugPort = extractLocalBrowserDebugPortFromCommandLine(commandLine);
    if (!candidateDebugPort) {
        return null;
    }

    if (isValidLocalBrowserDebugPort(debugPort) && candidateDebugPort !== debugPort) {
        // 调试端口是启动时显式指定的会话入口，不应像 launcher PID 一样被候选进程反向修正。
        return null;
    }

    return { pid, debugPort: candidateDebugPort };
}

function getLocalBrowserCandidateFromPid(pid: number, tempDir: string, debugPort?: number): LocalBrowserProcessCandidate | null {
    const commandLine = getProcessCommandLine(pid);
    return commandLine
        ? createLocalBrowserCandidateFromCommandLine(pid, commandLine, tempDir, debugPort)
        : null;
}

function quotePowerShellSingleQuotedString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function listLocalBrowserCandidatesByTempDir(tempDir: string, debugPort?: number): LocalBrowserProcessCandidate[] {
    const debugPortFragment = getLocalBrowserDebugPortCommandLineFragment(debugPort);

    if (process.platform !== 'win32') {
        try {
            const raw = execFileSync('ps', ['-eo', 'pid=,command='], {
                encoding: 'utf8',
                timeout: 5000
            });
            return raw.split(/\r?\n/u)
                .map((line) => {
                    const match = line.match(/^\s*(\d+)\s+(.*)$/u);
                    if (!match) return null;
                    const pid = Number(match[1]);
                    const commandLine = match[2];
                    return createLocalBrowserCandidateFromCommandLine(pid, commandLine, tempDir, debugPort);
                })
                .filter((candidate): candidate is LocalBrowserProcessCandidate => candidate !== null && processExists(candidate.pid));
        } catch {
            return [];
        }
    }

    try {
        const script = [
            `$targetTempDir = ${quotePowerShellSingleQuotedString(tempDir)}`,
            `$debugPortFragment = ${quotePowerShellSingleQuotedString(debugPortFragment)}`,
            "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') -and $_.CommandLine -and $_.CommandLine.Contains($targetTempDir) -and $_.CommandLine.Contains($debugPortFragment) -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId,CommandLine | Sort-Object ProcessId | ConvertTo-Json -Compress"
        ].join('; ');
        const raw = execFileSync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            { encoding: 'utf8', windowsHide: true, timeout: 5000 }
        ).trim();

        if (!raw) {
            return [];
        }

        const parsed = JSON.parse(raw) as Array<{ ProcessId?: number; CommandLine?: string }> | { ProcessId?: number; CommandLine?: string };
        const processes = Array.isArray(parsed) ? parsed : [parsed];
        return processes
            .map((processInfo) => {
                const pid = processInfo.ProcessId;
                const commandLine = processInfo.CommandLine;
                if (!Number.isInteger(pid) || typeof commandLine !== 'string') {
                    return null;
                }

                return createLocalBrowserCandidateFromCommandLine(pid as number, commandLine, tempDir, debugPort);
            })
            .filter((candidate): candidate is LocalBrowserProcessCandidate => candidate !== null && processExists(candidate.pid));
    } catch (error) {
        if (isExecTimeoutError(error)) {
            throw createProcessInspectionTimeoutError(
                `PowerShell timed out while enumerating local browser candidate processes for ${tempDir}`,
                error
            );
        }

        return [];
    }
}

function resolveLocalBrowserCandidate(preferredPid: number | undefined, tempDir: string, debugPort?: number): LocalBrowserProcessCandidate | null {
    if (preferredPid) {
        const preferredCandidate = getLocalBrowserCandidateFromPid(preferredPid, tempDir, debugPort);
        if (preferredCandidate) {
            return preferredCandidate;
        }
    }

    const exactCandidates = listLocalBrowserCandidatesByTempDir(tempDir, debugPort);
    if (exactCandidates.length > 0) {
        // Edge 在 Windows 上可能先返回 launcher PID；最终可复用进程只能按 tempDir/debugPort 重新枚举候选。
        return exactCandidates[0];
    }

    if (isValidLocalBrowserDebugPort(debugPort)) {
        // metadata 已有端口时，只能按该端口复用；端口不匹配说明会话已不可复用，不能被 tempDir 候选覆盖。
        return null;
    }

    const tempDirCandidates = listLocalBrowserCandidatesByTempDir(tempDir);
    return tempDirCandidates[0] ?? null;
}

function resolveLocalBrowserCandidatePid(preferredPid: number | undefined, tempDir: string, debugPort?: number): number | undefined {
    return resolveLocalBrowserCandidate(preferredPid, tempDir, debugPort)?.pid;
}

function requireLocalBrowserCandidatePid(preferredPid: number | undefined, tempDir: string, debugPort: number, context: string): number {
    const candidatePid = resolveLocalBrowserCandidatePid(preferredPid, tempDir, debugPort);
    if (!candidatePid) {
        throw new Error(`${context}: local browser process could not be verified by tempDir/debugPort`);
    }
    return candidatePid;
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

function trackLocalBrowserSessionClientForReuse(metadata: LocalBrowserSessionMetadata, pid = process.pid): LocalBrowserSessionMetadata {
    if (!shouldTrackLocalBrowserSessionClients(metadata.sessionMode)) {
        return { ...metadata, clientPids: [] };
    }

    return registerLocalBrowserSessionClient(metadata, pid);
}

function cleanupStaleLocalBrowserSessions(): void {
    if (staleBrowserCleanupPerformed) {
        return;
    }

    staleBrowserCleanupPerformed = true;

    const entries = listBrowserDomainMetadataEntries();

    for (const { domainHash, metadataPath, sessionMode } of entries) {
        const domainLock = acquireNativeFileLock(getBrowserDomainLockFilePathByHash(domainHash));
        try {
            // 每个域只有一个 metadata 文件，
            // cleanup 必须持有对应域锁后再读写，避免误删正在冷启动或刚复用的浏览器。
            const metadata = readBrowserDomainMetadataFromPath(metadataPath, sessionMode);
            if (!metadata) {
                rmSync(metadataPath, { force: true });
                continue;
            }

            const normalizedMetadata = shouldTrackLocalBrowserSessionClients(metadata.sessionMode)
                ? {
                    ...metadata,
                    clientPids: normalizeActiveClientPids(metadata.clientPids.filter((pid) => pid !== process.pid))
                }
                : metadata;
            if (shouldTrackLocalBrowserSessionClients(normalizedMetadata.sessionMode)
                && normalizedMetadata.clientPids.length !== metadata.clientPids.length) {
                writeBrowserDomainMetadata(normalizedMetadata);
            }

            const browserCandidatePid = resolveLocalBrowserCandidatePid(
                normalizedMetadata.browserPid,
                normalizedMetadata.tempDir,
                normalizedMetadata.debugPort
            );

            if (!browserCandidatePid) {
                // metadata 指向的会话已经无法通过 tempDir/debugPort 验证；这里只清理记录中的 PID 和 metadata，避免误杀同目录外的其它候选进程。
                createForceKill(normalizedMetadata.browserPid, normalizedMetadata.tempDir)();
                clearBrowserDomainMetadataFromPath(metadataPath, normalizedMetadata.tempDir);
            } else if (browserCandidatePid !== normalizedMetadata.browserPid) {
                // 旧 PID 可能只是 launcher；发现仍带正确 tempDir/debugPort 的候选进程后，回写 metadata 供后续复用。
                writeBrowserDomainMetadata({
                    ...normalizedMetadata,
                    browserPid: browserCandidatePid
                });
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
    domainKey: string,
    sessionKey: string
): Promise<LocalBrowserSession | null> {
    const metadata = readBrowserDomainMetadata(domainKey);
    if (!metadata) return null;

    const reusableBrowserCandidate = resolveLocalBrowserCandidate(metadata.browserPid, metadata.tempDir, metadata.debugPort);
    if (!reusableBrowserCandidate) {
        clearBrowserDomainMetadata(domainKey, metadata.tempDir);
        try { rmSync(metadata.tempDir, { recursive: true, force: true }); } catch { /* metadata 指向的会话目录已经不可复用，清理失败不影响新建。 */ }
        return null;
    }

    const reusableBrowserPid = reusableBrowserCandidate.pid;
    const reusableDebugPort = metadata.debugPort ?? reusableBrowserCandidate.debugPort;

    // 尝试连接已有浏览器；如果浏览器已被用户关闭或崩溃，清理掉死 session 并返回 null
    const endpoint = `http://127.0.0.1:${reusableDebugPort}`;
    let browser: any;
    try {
        browser = await connectOverCdpWhenReady(playwright, endpoint);
    } catch {
        console.error(`🧹 Persisted browser session (PID ${reusableBrowserPid}, port ${reusableDebugPort}) is no longer reachable, cleaning up`);
        // metadata 指向的浏览器已经无法完成 CDP 握手；只删除 metadata 会留下不可复用的旧窗口，下一次搜索又会再启动新浏览器。
        createForceKill(reusableBrowserPid, metadata.tempDir, undefined, domainKey)();
        return null;
    }

    const metadataWithVerifiedPid: LocalBrowserSessionMetadata = {
        ...metadata,
        browserPid: reusableBrowserPid,
        debugPort: reusableDebugPort
    };
    const updatedMetadata = trackLocalBrowserSessionClientForReuse(metadataWithVerifiedPid);
    if (!shouldTrackLocalBrowserSessionClients(updatedMetadata.sessionMode)
        && (metadata.browserPid !== reusableBrowserPid || metadata.debugPort !== reusableDebugPort)) {
        // 有头模式没有客户端登记写入；PID/端口从旧记录修正为候选进程时必须显式回写。
        writeBrowserDomainMetadata(updatedMetadata);
    }
    const forceKill = createForceKill(reusableBrowserPid, metadata.tempDir, browser, domainKey);
    const session: LocalBrowserSession = {
        browser,
        sessionKey,
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
    console.error(`🧭 Reused existing Playwright browser session from PID ${reusableBrowserPid}`);
    return session;
}

async function closeLocalBrowserSession(session: LocalBrowserSession): Promise<void> {
    if (session.browserPid && session.tempDir && session.domainKey) {
        if (session.sessionMode === 'headed') {
            // 有头浏览器由用户可见进程自身存活决定，不需要最后一个客户端关闭浏览器，因此 release 只断开连接且不改写 metadata。
            try {
                // 通过 Playwright 的 CDP Browser.close 释放当前连接，并用 metadata 保留浏览器复用入口。
                await closeConnectedCdpBrowser(session.browser);
            } catch {
                // 释放 headed 复用连接失败不影响浏览器继续由 metadata 复用。
            }
            return;
        }

        const domainLockPath = getBrowserDomainLockFilePath(session.domainKey);
        const domainLock = acquireNativeFileLock(domainLockPath);

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
                    await closeConnectedCdpBrowser(session.browser);
                } catch {
                    // 断开当前连接失败时不影响其他客户端继续复用浏览器。
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

function createLocalBrowserLaunchError(message: string, browserPid?: number, cause?: unknown): Error {
    const error = new Error(message);
    error.name = 'LocalBrowserLaunchError';
    if (Number.isInteger(browserPid) && browserPid! > 0) {
        (error as Error & { browserPid?: number }).browserPid = browserPid;
    }
    if (cause !== undefined) {
        (error as Error & { cause?: unknown }).cause = cause;
    }
    return error;
}

function getLocalBrowserLaunchErrorPid(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') {
        return undefined;
    }

    const browserPid = (error as { browserPid?: unknown }).browserPid;
    return Number.isInteger(browserPid) && (browserPid as number) > 0
        ? browserPid as number
        : undefined;
}

function resolveLaunchFailureBrowserPid(preferredPid: number | undefined, tempDir: string, debugPort: number, error?: unknown): number | undefined {
    // 启动失败清理只能针对已通过 tempDir/debugPort 验证的真实根进程；找不到时不能回退杀 launcher PID。
    return getLocalBrowserLaunchErrorPid(error)
        ?? resolveLocalBrowserCandidatePid(preferredPid, tempDir, debugPort);
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

async function connectLaunchedLocalBrowserSession(
    playwright: PlaywrightModule,
    endpoint: string,
    preferredPid: number | undefined,
    tempDir: string,
    debugPort: number,
    context: string
): Promise<{ browser: any; browserPid: number }> {
    let browser: any;
    let verifiedBrowserPid: number | undefined;
    try {
        browser = await connectOverCdpWhenReady(playwright, endpoint);
    } catch (error) {
        const candidatePid = resolveLocalBrowserCandidatePid(preferredPid, tempDir, debugPort);
        if (!candidatePid) {
            throw createLocalBrowserLaunchError(
                `${context}: CDP connection failed and no local browser process matched tempDir/debugPort: ${getErrorMessage(error)}`,
                undefined,
                error
            );
        }

        // 新建浏览器时 launcher 可能已经交接给真正的浏览器进程；重新确认候选 PID 后再给 CDP 一次就绪机会。
        verifiedBrowserPid = candidatePid;
        try {
            browser = await connectOverCdpWhenReady(playwright, endpoint);
        } catch (retryError) {
            throw createLocalBrowserLaunchError(
                `${context}: CDP connection failed for verified local browser process PID ${candidatePid}: ${getErrorMessage(retryError)}`,
                candidatePid,
                retryError
            );
        }
    }

    try {
        const browserPid = requireLocalBrowserCandidatePid(preferredPid, tempDir, debugPort, context);
        return { browser, browserPid };
    } catch (error) {
        await closeConnectedCdpBrowser(browser);
        throw createLocalBrowserLaunchError(
            error instanceof Error ? error.message : `${context}: local browser process verification failed`,
            verifiedBrowserPid,
            error
        );
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
            detachLaunchedChildProcess(child);
            createForceKill(resolveLaunchFailureBrowserPid(browserPid, tempDir, port, error), tempDir, undefined, domainKey)();
            throw error;
        }

        detachLaunchedChildProcess(child);

        const endpoint = `http://127.0.0.1:${port}`;
        try {
            const connectedSession = await connectLaunchedLocalBrowserSession(
                playwright,
                endpoint,
                browserPid,
                tempDir,
                port,
                'Hidden local browser launch'
            );
            const browser = connectedSession.browser;
            browserPid = connectedSession.browserPid;
            writeBrowserDomainMetadata({
                domainKey,
                sessionMode: 'hidden-headed',
                browserPid,
                debugPort: port,
                tempDir,
                clientPids: [process.pid]
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
            createForceKill(resolveLaunchFailureBrowserPid(browserPid, tempDir, port, error), tempDir, undefined, domainKey)();
            throw error;
        }
    }

    // Windows 路径：通过管道等待 ready
    try {
        await waitForBrowserReadyViaStdout({ type: 'pipe', readHandle: pipeHandle });
    } catch (error) {
        closeHandle(pipeHandle);
        createForceKill(resolveLaunchFailureBrowserPid(browserPid, tempDir, port, error), tempDir, undefined, domainKey)();
        throw error;
    }
    closeHandle(pipeHandle);

    const endpoint = `http://127.0.0.1:${port}`;
    try {
        const connectedSession = await connectLaunchedLocalBrowserSession(
            playwright,
            endpoint,
            browserPid,
            tempDir,
            port,
            'Hidden desktop local browser launch'
        );
        browserPid = connectedSession.browserPid;
        const browser = connectedSession.browser;
        writeBrowserDomainMetadata({
            domainKey,
            sessionMode: 'hidden-headed',
            browserPid,
            debugPort: port,
            tempDir,
            clientPids: [process.pid]
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
        createForceKill(resolveLaunchFailureBrowserPid(browserPid, tempDir, port, error), tempDir, undefined, domainKey)();
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
            detachLaunchedChildProcess(child);
            createForceKill(resolveLaunchFailureBrowserPid(child.pid, tempDir, port, error), tempDir, undefined, domainKey)();
            throw error;
        }

        detachLaunchedChildProcess(child);

        const endpoint = `http://127.0.0.1:${port}`;
        let browserPid = child.pid;
        try {
            const connectedSession = await connectLaunchedLocalBrowserSession(
                playwright,
                endpoint,
                child.pid,
                tempDir,
                port,
                'Local browser launch'
            );
            browserPid = connectedSession.browserPid;
            const browser = connectedSession.browser;
            writeBrowserDomainMetadata({
                domainKey,
                sessionMode,
                browserPid,
                debugPort: port,
                tempDir,
                clientPids: shouldTrackLocalBrowserSessionClients(sessionMode) ? [process.pid] : []
            });
            const forceKill = createForceKill(browserPid, tempDir, browser, domainKey);
            const session: LocalBrowserSession = {
                browser, sessionKey, domainKey, sessionMode,
                browserPid, debugPort: port, tempDir,
                closeBrowser: async () => { await closeLocalBrowserSession(session); },
                forceKill
            };
            return session;
        } catch (error) {
            // 连接阶段失败时 child.pid 可能只是 Edge launcher；如果已经解析出真实根 PID，就只清理该 PID。
            createForceKill(resolveLaunchFailureBrowserPid(browserPid, tempDir, port, error), tempDir, undefined, domainKey)();
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
            const reusedSession = await tryReusePersistedLocalBrowserSession(playwright, domainKey, sessionKey);
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
                    const hiddenHeadedSession = await tryReusePersistedLocalBrowserSession(playwright, hiddenHeadedDomainKey, sessionKey);
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
