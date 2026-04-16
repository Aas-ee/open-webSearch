import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { createServer } from 'net';
import { tmpdir } from 'os';
import path from 'path';
import { config, getProxyUrl } from '../config.js';
import { withNativeFileLock, launchProcessOnHiddenDesktopWithPipes, readNamedPipeAsync, closeHandle, acquireNativeFileLock, tryNativeFileLock } from './nativeInterop.js';
import type { NativeFileLockHandle } from './nativeInterop.js';

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
const LOCAL_BROWSER_SESSION_METADATA_FILE = 'open-websearch-session.json';
const LOCAL_BROWSER_SESSION_REGISTRY_FILE = 'open-websearch-local-browser-sessions.json';
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

type LocalBrowserSessionRegistryEntry = {
    tempDir: string;
    updatedAt: string;
};

type LocalBrowserSessionRegistry = {
    sessions: Record<string, LocalBrowserSessionRegistryEntry>;
};

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
                pool.entries = pool.entries.filter((candidate) => candidate !== entry);
            } else {
                entry.pageLock?.release();
                entry.pageLock = null;
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
                entry.pageLock?.release();
                entry.pageLock = null;
                pool.entries = pool.entries.filter((candidate) => candidate !== entry);
                return;
            }

            entry.pageLock?.release();
            entry.pageLock = null;
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
    return JSON.stringify({
        headless,
        hideWindow: options?.hideWindow === true,
        executablePath: config.playwrightExecutablePath || '',
        launchArgs
    });
}

/**
 * 浏览器域锁签名：
 * - headed: `headed:<executablePath>`（不同浏览器路径用不同锁）
 * - hidden-headed: `hidden-headed`（所有隐藏头进程共享一个锁）
 * - headless: `headless`（所有无头进程共享一个锁）
 */
function buildBrowserDomainLockKey(mode: LocalBrowserSessionMode): string {
    if (mode === 'headed') {
        const execPath = config.playwrightExecutablePath || getLocalBrowserExecutablePath();
        return `headed:${execPath}`;
    }
    return mode;
}

function getBrowserDomainLockFilePath(mode: LocalBrowserSessionMode): string {
    mkdirSync(CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR, { recursive: true });
    const key = buildBrowserDomainLockKey(mode);
    return path.join(
        CROSS_PROCESS_BROWSER_SESSION_LOCK_DIR,
        `domain-${createHash('sha1').update(key).digest('hex')}.lock`
    );
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

// registry 的所有 read-modify-write 都在 withMetadataLock（per-tempDir OS 级独占锁）
// 保护下执行，不存在并发截断 JSON 的可能，无需额外的原子写或文件锁。
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

        return {
            ownerPid: parsed.ownerPid ?? 0,
            browserPid: parsed.browserPid,
            debugPort: parsed.debugPort,
            tempDir: parsed.tempDir ?? tempDir,
            executablePath: parsed.executablePath ?? '',
            sessionKey: parsed.sessionKey ?? '',
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
        } catch (error) {
            if (isProcessInspectionTimeoutError(error)) {
                throw error;
            }

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
    requestedMode: LocalBrowserSessionMode
): Promise<LocalBrowserSession | null> {
    const entries = listRegisteredLocalBrowserSessionTempDirs();

    let bestMatch: { metadata: LocalBrowserSessionMetadata; score: number } | null = null;

    for (const tempDir of entries) {
        const metadata = readLocalBrowserSessionMetadata(tempDir);
        if (!metadata) continue;

        if (!isCompatibleLocalBrowserSessionMode(requestedMode, metadata.sessionMode)) continue;

        const score = getLocalBrowserSessionModeReuseScore(requestedMode, metadata.sessionMode);
        if (!bestMatch || score > bestMatch.score) {
            bestMatch = { metadata, score };
        }
    }

    if (!bestMatch) return null;

    // 此函数按 sessionMode 筛选 + 评分选出最佳候选，不额外校验 sessionKey。
    // 隔离由上游域锁保证：headed 模式的域锁 key 包含 executablePath（不同浏览器路径用不同锁），
    // hidden-headed/headless 各自共享一个域锁。连接失败时会自动清理死 session。
    const metadata = bestMatch.metadata;
    if (!metadata.debugPort || !metadata.browserPid) {
        unregisterLocalBrowserSession(metadata.sessionKey, metadata.tempDir);
        return null;
    }

    // 尝试连接已有浏览器；如果浏览器已被用户关闭或崩溃，清理掉死 session 并返回 null
    const endpoint = `http://127.0.0.1:${metadata.debugPort}`;
    let browser: any;
    try {
        browser = await playwright.chromium.connectOverCDP(endpoint, {
            timeout: PLAYWRIGHT_CONNECT_TIMEOUT_MS
        });
    } catch {
        console.error(`🧹 Persisted browser session (PID ${metadata.browserPid}, port ${metadata.debugPort}) is no longer reachable, cleaning up`);
        unregisterLocalBrowserSession(metadata.sessionKey, metadata.tempDir);
        try { rmSync(metadata.tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
        return null;
    }
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
}

async function closeLocalBrowserSession(session: LocalBrowserSession): Promise<void> {
    if (session.browserPid && session.tempDir) {
        if (session.sessionMode === 'headed') {
            // 有头模式：保留浏览器，只断开连接
            try {
                await session.browser.close().catch(() => undefined);
            } catch {
                // Ignore close errors for reusable headed browsers.
            }
            // 从 metadata 注销当前进程
            withMetadataLock(session.tempDir, () => {
                const metadata = readLocalBrowserSessionMetadata(session.tempDir!);
                if (metadata) unregisterLocalBrowserSessionClient(metadata);
            });
            return;
        }

        // 无头/隐藏头模式：获取域锁，检查是否最后一个使用者
        const domainLockPath = getBrowserDomainLockFilePath(session.sessionMode);
        const domainLock = acquireNativeFileLock(domainLockPath);

        try {
            const hasOtherClients = withMetadataLock(session.tempDir, () => {
                const metadata = readLocalBrowserSessionMetadata(session.tempDir!);
                const updatedMetadata = metadata
                    ? unregisterLocalBrowserSessionClient(metadata)
                    : null;
                return (updatedMetadata?.clientPids.length ?? 0) > 0;
            });

            if (!hasOtherClients) {
                // 最后一个使用者：关闭浏览器，然后释放域锁
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
            createForceKill(browserPid, tempDir)();
            throw error;
        }

        // 不再需要 stdio，断开引用让子进程脱离
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();

        writeLocalBrowserSessionMetadata({
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

        const endpoint = `http://127.0.0.1:${port}`;
        const browser = await playwright.chromium.connectOverCDP(endpoint, { timeout: PLAYWRIGHT_CONNECT_TIMEOUT_MS });
        const forceKill = createForceKill(browserPid, tempDir, browser);
        const session: LocalBrowserSession = {
            browser, sessionKey, sessionMode: 'hidden-headed',
            browserPid, debugPort: port, tempDir,
            closeBrowser: async () => { await closeLocalBrowserSession(session); },
            forceKill
        };
        return session;
    }

    // Windows 路径：通过管道等待 ready
    try {
        await waitForBrowserReadyViaStdout({ type: 'pipe', readHandle: pipeHandle });
    } catch (error) {
        closeHandle(pipeHandle);
        createForceKill(browserPid, tempDir)();
        throw error;
    }
    closeHandle(pipeHandle);

    writeLocalBrowserSessionMetadata({
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

    const endpoint = `http://127.0.0.1:${port}`;
    try {
        const browser = await playwright.chromium.connectOverCDP(endpoint, { timeout: PLAYWRIGHT_CONNECT_TIMEOUT_MS });
        const forceKill = createForceKill(browserPid, tempDir, browser);
        const session: LocalBrowserSession = {
            browser, sessionKey, sessionMode: 'hidden-headed',
            browserPid, debugPort: port, tempDir,
            closeBrowser: async () => { await closeLocalBrowserSession(session); },
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

        // 使用 pipe 模式启动，监听 stdout ready 信号
        const child = spawn(browserPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true
        });
        child.on('error', () => undefined);

        try {
            await waitForBrowserReadyViaStdout({ type: 'child', child });
        } catch (error) {
            createForceKill(child.pid, tempDir)();
            throw error;
        }

        // Ready 后断开 stdio 引用，让子进程脱离
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();

        writeLocalBrowserSessionMetadata({
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

        const endpoint = `http://127.0.0.1:${port}`;
        try {
            const browser = await playwright.chromium.connectOverCDP(endpoint, { timeout: PLAYWRIGHT_CONNECT_TIMEOUT_MS });
            const forceKill = createForceKill(child.pid, tempDir, browser);
            const session: LocalBrowserSession = {
                browser, sessionKey, sessionMode,
                browserPid: child.pid, debugPort: port, tempDir,
                closeBrowser: async () => { await closeLocalBrowserSession(session); },
                forceKill
            };
            return session;
        } catch (error) {
            createForceKill(child.pid, tempDir)();
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
        // 获取域锁：同域内同一时刻只有一个进程能操作浏览器
        const domainLockPath = getBrowserDomainLockFilePath(sessionMode);
        const domainLock = acquireNativeFileLock(domainLockPath);

        try {
            // 持有域锁时，检查是否已有可复用的浏览器
            const reusedSession = await tryReusePersistedLocalBrowserSession(playwright, sessionMode);
            if (reusedSession) {
                // 复用成功，立即释放域锁
                domainLock.release();
                cachedLocalBrowserSession = reusedSession;
                registerLocalBrowserCleanup();
                return reusedSession;
            }

            // 无头模式降级：如果无头锁域内无浏览器，检查 hidden-headed 是否存在。
            // 必须先获取 hidden-headed 域锁，否则在我们连接的瞬间，
            // 另一个 hidden-headed 进程可能正在 closeLocalBrowserSession 中判定自己是
            // 最后一个使用者并杀死浏览器，导致我们拿到一个已死的连接。
            if (sessionMode === 'headless') {
                const hiddenHeadedLockPath = getBrowserDomainLockFilePath('hidden-headed');
                const hiddenHeadedLock = acquireNativeFileLock(hiddenHeadedLockPath);
                try {
                    const hiddenHeadedSession = await tryReusePersistedLocalBrowserSession(playwright, 'hidden-headed');
                    if (hiddenHeadedSession) {
                        // 复用成功，释放两把域锁
                        hiddenHeadedLock.release();
                        domainLock.release();
                        // 更新 session 信息以反映实际模式
                        hiddenHeadedSession.sessionKey = sessionKey;
                        cachedLocalBrowserSession = hiddenHeadedSession;
                        registerLocalBrowserCleanup();
                        return hiddenHeadedSession;
                    }
                } finally {
                    hiddenHeadedLock.release();
                }
            }

            // 没有可复用浏览器，新建。新建过程中持有域锁，确保 ready 后才释放。
            const session = options?.hideWindow
                ? await launchHiddenDesktopBrowser(playwright, sessionKey, launchArgs)
                : await launchStandardLocalBrowser(playwright, sessionKey, headless, launchArgs);
            session.sessionKey = sessionKey;

            // 浏览器已就绪（stdout ready 信号已收到），释放域锁
            domainLock.release();

            cachedLocalBrowserSession = session;
            registerLocalBrowserCleanup();
            return session;
        } catch (error) {
            domainLock.release();
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
