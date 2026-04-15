import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { createServer } from 'net';
import { tmpdir } from 'os';
import path from 'path';
import { config, getProxyUrl } from '../config.js';

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

type LocalBrowserSession = {
    browser: any;
    sessionKey: string;
    browserPid?: number;
    debugPort?: number;
    tempDir?: string;
    strictCleanup: boolean;
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
    hideWindow: boolean;
    strictCleanup: boolean;
    createdAt: string;
};

type PooledPlaywrightPageEntry = {
    context: any | null;
    page: any;
    busy: boolean;
    prepared: boolean;
};

type BrowserPlaywrightPagePool = {
    sharedContext: any | null;
    entries: PooledPlaywrightPageEntry[];
    preparePage?: (page: any) => Promise<void>;
    contextOptions?: any;
    preferExistingContext: boolean;
};

let playwrightModulePromise: Promise<PlaywrightModule | null> | null = null;
let playwrightModuleSource: string | null = null;
let playwrightUnavailableMessage: string | null = null;
let hasEmittedPlaywrightUnavailableWarning = false;
let cachedBrowserPath: string | null = null;
let cachedLocalBrowserSession: LocalBrowserSession | null = null;
let localBrowserSessionPromise: Promise<LocalBrowserSession> | null = null;
let cachedLocalBrowserSessionKey: string | null = null;
let cleanupRegistered = false;
let staleBrowserCleanupPerformed = false;
const LOCAL_BROWSER_SESSION_METADATA_FILE = 'open-websearch-session.json';
const LOCAL_BROWSER_SESSION_REGISTRY_FILE = 'open-websearch-local-browser-sessions.json';
const LEGACY_ORPHAN_BROWSER_GRACE_PERIOD_MS = 60 * 1000;
const browserPlaywrightPagePools = new WeakMap<any, Map<string, BrowserPlaywrightPagePool>>();

type LocalBrowserSessionRegistryEntry = {
    tempDir: string;
    updatedAt: string;
};

type LocalBrowserSessionRegistry = {
    sessions: Record<string, LocalBrowserSessionRegistryEntry>;
};

function shouldUseStrictLocalBrowserCleanup(headless: boolean, options?: OpenPlaywrightBrowserOptions): boolean {
    return headless || options?.hideWindow === true;
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
        sharedContext: null,
        entries: [],
        preparePage: options?.preparePage,
        contextOptions: options?.contextOptions,
        preferExistingContext: options?.preferExistingContext !== false
    };
    browserPools.set(poolKey, pool);
    return pool;
}

function isPageClosed(page: any): boolean {
    try {
        return typeof page?.isClosed === 'function' ? page.isClosed() : false;
    } catch {
        return true;
    }
}

function syncPoolWithExistingContextPages(pool: BrowserPlaywrightPagePool, context: any): void {
    if (typeof context?.pages !== 'function') {
        return;
    }

    const existingPages = context.pages();
    if (!Array.isArray(existingPages)) {
        return;
    }

    for (const page of existingPages) {
        if (pool.entries.some((entry) => entry.page === page)) {
            continue;
        }

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
            syncPoolWithExistingContextPages(pool, context);
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

export async function acquirePooledPlaywrightPage(
    browser: any,
    options?: AcquirePlaywrightPageOptions
): Promise<PooledPlaywrightPageSession> {
    const pool = getBrowserPlaywrightPagePool(browser, options);

    if (pool.preferExistingContext && typeof browser.contexts === 'function') {
        const contexts = browser.contexts();
        if (Array.isArray(contexts) && contexts.length > 0) {
            syncPoolWithExistingContextPages(pool, contexts[0]);
        }
    }

    pool.entries = pool.entries.filter((entry) => !isPageClosed(entry.page));

    let entry = pool.entries.find((candidate) => !candidate.busy) ?? null;
    if (!entry) {
        entry = await createPooledPlaywrightPageEntry(browser, pool);
    }

    entry.busy = true;

    if (!entry.prepared) {
        if (pool.preparePage) {
            // 把页池分配与页面初始化统一到 Playwright 公共层。
            // 上层只需要提供各自的页面初始化逻辑，具体如何复用空闲页与按需扩容由这里统一负责。
            await pool.preparePage(entry.page);
        }
        entry.prepared = true;
    }

    return {
        context: entry.context,
        page: entry.page,
        closePageContext: async () => {
            if (isPageClosed(entry.page)) {
                pool.entries = pool.entries.filter((candidate) => candidate !== entry);
                return;
            }

            entry.busy = false;
        }
    };
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
        proxy: getProxyUrl() || '',
        launchArgs
    });
}

function buildLocalBrowserProcessArgs(port: number, tempDir: string, launchArgs: string[]): string[] {
    const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${tempDir}`,
        ...launchArgs
    ];
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
        return JSON.parse(readFileSync(getLocalBrowserSessionMetadataPath(tempDir), 'utf8')) as LocalBrowserSessionMetadata;
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

    return commandLine.includes(tempDir)
        && commandLine.includes('--remote-debugging-port=');
}

function updateLocalBrowserSessionOwner(metadata: LocalBrowserSessionMetadata): void {
    writeLocalBrowserSessionMetadata({
        ...metadata,
        ownerPid: process.pid
    });
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
                "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -match 'mcp-search-' -and $_.CommandLine -match '--remote-debugging-port=' -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine | ConvertTo-Json -Compress"
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
            const metadata = readLocalBrowserSessionMetadata(tempDir);
            if (!metadata) {
                unregisterLocalBrowserSessionByTempDir(tempDir);
                rmSync(tempDir, { recursive: true, force: true });
                continue;
            }

            if (metadata.ownerPid === process.pid) {
                continue;
            }

            const browserIsAlive = metadata.browserPid !== undefined
                && processMatchesLocalBrowserSession(metadata.browserPid, metadata.tempDir);

            if (browserIsAlive && !metadata.strictCleanup) {
                continue;
            }

            if (browserIsAlive && metadata.strictCleanup) {
                unregisterLocalBrowserSession(metadata.sessionKey, metadata.tempDir);
                createForceKill(metadata.browserPid, metadata.tempDir)();
                console.error(`🧹 Cleaned stale Playwright browser session from PID ${metadata.browserPid}`);
                continue;
            }

            unregisterLocalBrowserSession(metadata.sessionKey, metadata.tempDir);
            rmSync(metadata.tempDir, { recursive: true, force: true });
        } catch {
            unregisterLocalBrowserSessionByTempDir(tempDir);
            try {
                rmSync(tempDir, { recursive: true, force: true });
            } catch {
                // Ignore stale cleanup errors.
            }
        }
    }

    cleanupLegacyOrphanLocalBrowserProcesses();
}

function buildHiddenDesktopLaunchScript(cmdLine: string, desktopName: string): string {
    return `
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class HiddenLauncher {
    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern IntPtr CreateDesktopW(string lpszDesktop, IntPtr lpszDevice,
        IntPtr pDevmode, int dwFlags, uint dwDesiredAccess, IntPtr lpsa);

    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern bool CreateProcessW(string lpApp, string lpCmd,
        IntPtr lpProcAttr, IntPtr lpThreadAttr, bool bInherit, uint dwFlags,
        IntPtr lpEnv, string lpDir, ref STARTUPINFOW si, out PROCESS_INFORMATION pi);

    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool DuplicateHandle(IntPtr hSourceProcess, IntPtr hSourceHandle,
        IntPtr hTargetProcess, out IntPtr lpTargetHandle,
        uint dwDesiredAccess, bool bInheritHandle, uint dwOptions);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInherit, int dwProcId);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr hObject);

    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct STARTUPINFOW {
        public int cb; public string lpReserved; public string lpDesktop;
        public string lpTitle; public int dwX; public int dwY;
        public int dwXSize; public int dwYSize; public int dwXCountChars;
        public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
        public short wShowWindow; public short cbReserved2;
        public IntPtr lpReserved2; public IntPtr hStdInput;
        public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION {
        public IntPtr hProcess; public IntPtr hThread;
        public int dwProcessId; public int dwThreadId;
    }

    const uint GENERIC_ALL = 0x10000000;
    const uint PROCESS_DUP_HANDLE = 0x0040;
    const uint DUPLICATE_SAME_ACCESS = 0x0002;

    public static int Launch(string cmdLine, string desktopName) {
        IntPtr hDesk = CreateDesktopW(desktopName, IntPtr.Zero, IntPtr.Zero,
            0, GENERIC_ALL, IntPtr.Zero);
        if (hDesk == IntPtr.Zero)
            throw new Exception("CreateDesktop failed: " + Marshal.GetLastWin32Error());

        var si = new STARTUPINFOW();
        si.cb = Marshal.SizeOf(si);
        si.lpDesktop = desktopName;

        PROCESS_INFORMATION pi;
        if (!CreateProcessW(null, cmdLine, IntPtr.Zero, IntPtr.Zero,
            false, 0, IntPtr.Zero, null, ref si, out pi))
            throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());

        IntPtr hBrowserProc = OpenProcess(PROCESS_DUP_HANDLE, false, pi.dwProcessId);
        if (hBrowserProc != IntPtr.Zero) {
            IntPtr dupHandle;
            DuplicateHandle(GetCurrentProcess(), hDesk,
                hBrowserProc, out dupHandle,
                0, false, DUPLICATE_SAME_ACCESS);
            CloseHandle(hBrowserProc);
        }

        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return pi.dwProcessId;
    }
}
"@
[HiddenLauncher]::Launch('${cmdLine.replace(/'/g, "''")}', '${desktopName.replace(/'/g, "''")}')`;
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
    sessionKey: string,
    strictCleanup: boolean
): Promise<LocalBrowserSession | null> {
    if (strictCleanup) {
        return null;
    }

    // 通过 %TEMP% 根目录下的索引文件，按 sessionKey 直接定位上次会话的 tempDir。
    // 如果没有索引，就视为没有可复用旧会话，直接由上层创建新的浏览器会话。
    const registeredTempDir = getRegisteredLocalBrowserSessionTempDir(sessionKey);
    if (!registeredTempDir) {
        return null;
    }

    const entries = [registeredTempDir];

    for (const tempDir of entries) {
        const metadata = readLocalBrowserSessionMetadata(tempDir);
        if (!metadata || metadata.strictCleanup || metadata.sessionKey !== sessionKey) {
            continue;
        }

        if (!metadata.debugPort || !metadata.browserPid || !processMatchesLocalBrowserSession(metadata.browserPid, metadata.tempDir)) {
            unregisterLocalBrowserSession(metadata.sessionKey, metadata.tempDir);
            continue;
        }

        try {
            const browser = await connectToLocalDebugBrowser(playwright, metadata.debugPort);
            updateLocalBrowserSessionOwner(metadata);
            const forceKill = createForceKill(metadata.browserPid, metadata.tempDir, browser);
            const session: LocalBrowserSession = {
                browser,
                sessionKey,
                browserPid: metadata.browserPid,
                debugPort: metadata.debugPort,
                tempDir: metadata.tempDir,
                strictCleanup: false,
                closeBrowser: async () => {
                    await closeLocalBrowserSession(session);
                },
                forceKill
            };
            console.error(`🧭 Reused existing Playwright browser session from PID ${metadata.browserPid}`);
            return session;
        } catch {
            unregisterLocalBrowserSession(metadata.sessionKey, metadata.tempDir);
            // Ignore failed reuse attempts and continue scanning.
        }
    }

    return null;
}

async function closeLocalBrowserSession(session: LocalBrowserSession): Promise<void> {
    if (session.browserPid && session.strictCleanup) {
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

        // 修复 daemon 关闭后 Edge 进程残留的问题：
        // 对 connectOverCDP 接入的外部浏览器，仅关闭 Playwright 连接并不会结束根进程。
        // 这里显式回收由当前进程创建的浏览器 PID。
        session.forceKill();
        return;
    }

    if (session.browserPid) {
        try {
            await session.browser.close().catch(() => undefined);
        } catch {
            // Ignore close errors for reusable headed browsers.
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
            if (cachedLocalBrowserSession.strictCleanup) {
                cachedLocalBrowserSession.forceKill();
            }
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
    const cmdLine = `"${browserPath}" ${args.join(' ')}`;

    let browserPid: number | undefined;
    if (process.platform === 'win32') {
        const desktopName = `mcp-search-${Date.now()}`;
        const script = buildHiddenDesktopLaunchScript(cmdLine, desktopName);
        const output = execFileSync('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            script
        ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
        browserPid = Number.parseInt(output.trim(), 10);
        writeLocalBrowserSessionMetadata({
            ownerPid: process.pid,
            browserPid,
            debugPort: port,
            tempDir,
            executablePath: browserPath,
            sessionKey,
            hideWindow: true,
            strictCleanup: true,
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
            hideWindow: true,
            strictCleanup: true,
            createdAt: new Date().toISOString()
        });
    }

    try {
        const browser = await connectToLocalDebugBrowser(playwright, port);
        const forceKill = createForceKill(browserPid, tempDir, browser);
        const session: LocalBrowserSession = {
            browser,
            sessionKey,
            browserPid,
            debugPort: port,
            tempDir,
            strictCleanup: true,
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
    if (process.platform === 'win32' && !headless) {
        const browserPath = getLocalBrowserExecutablePath();
        const tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-search-'));
        const port = await findFreePort();
        const args = buildLocalBrowserProcessArgs(port, tempDir, launchArgs);
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
            hideWindow: false,
            strictCleanup: false,
            createdAt: new Date().toISOString()
        });

        try {
            const browser = await connectToLocalDebugBrowser(playwright, port);
            const forceKill = createForceKill(child.pid, tempDir, browser);
            const session: LocalBrowserSession = {
                browser,
                sessionKey,
                browserPid: child.pid,
                debugPort: port,
                tempDir,
                strictCleanup: false,
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
        strictCleanup: true,
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
}

export async function shutdownLocalPlaywrightBrowserSessions(): Promise<void> {
    if (cachedLocalBrowserSession?.strictCleanup) {
        await destroyCachedLocalBrowserSession();
        return;
    }

    if (cachedLocalBrowserSession) {
        try {
            await cachedLocalBrowserSession.browser.close().catch(() => undefined);
        } finally {
            cachedLocalBrowserSession = null;
            cachedLocalBrowserSessionKey = null;
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
    const strictCleanup = shouldUseStrictLocalBrowserCleanup(headless, options);

    if (strictCleanup) {
        cleanupStaleLocalBrowserSessions();
    }

    if (cachedLocalBrowserSession && cachedLocalBrowserSessionKey === sessionKey) {
        try {
            await cachedLocalBrowserSession.browser.version();
            return cachedLocalBrowserSession;
        } catch {
            cachedLocalBrowserSession.forceKill();
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
        if (!strictCleanup) {
            const reusedSession = await tryReusePersistedLocalBrowserSession(playwright, sessionKey, strictCleanup);
            if (reusedSession) {
                cachedLocalBrowserSession = reusedSession;
                registerLocalBrowserCleanup();
                return reusedSession;
            }
        }

        const session = options?.hideWindow
            ? await launchHiddenDesktopBrowser(playwright, sessionKey, launchArgs)
            : await launchStandardLocalBrowser(playwright, sessionKey, headless, launchArgs);
        session.sessionKey = sessionKey;
        cachedLocalBrowserSession = session;
        registerLocalBrowserCleanup();
        return session;
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
            // 共享本地浏览器由进程级缓存统一管理，这里不主动关闭，避免每次搜索都重启浏览器。
            return Promise.resolve();
        }
    };
}
