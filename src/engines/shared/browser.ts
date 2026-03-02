/**
 * 全局共享的 Puppeteer 浏览器管理模块。
 * 所有需要真实浏览器环境的搜索引擎（Bing、Baidu 等）共用同一个浏览器实例。
 */
import puppeteer, { type Browser } from 'puppeteer-core';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn, execFileSync } from 'child_process';
import { createServer } from 'net';

let cachedBrowserPath: string | null = null;

function getBrowserPath(): string {
    if (cachedBrowserPath) return cachedBrowserPath;

    const candidates: string[] = [];

    // Windows 硬编码常见路径（MCP 环境下环境变量可能缺失时的后备方案）
    candidates.push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    candidates.push('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
    candidates.push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
    candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');

    // 基于环境变量的路径
    const pf86 = process.env['PROGRAMFILES(X86)'];
    const pf = process.env['PROGRAMFILES'];
    const localAppData = process.env['LOCALAPPDATA'];
    if (pf86) {
        candidates.push(pf86 + '\\Microsoft\\Edge\\Application\\msedge.exe');
        candidates.push(pf86 + '\\Google\\Chrome\\Application\\chrome.exe');
    }
    if (pf) {
        candidates.push(pf + '\\Microsoft\\Edge\\Application\\msedge.exe');
        candidates.push(pf + '\\Google\\Chrome\\Application\\chrome.exe');
    }
    if (localAppData) {
        candidates.push(localAppData + '\\Google\\Chrome\\Application\\chrome.exe');
    }

    // Linux/macOS 路径
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/microsoft-edge');
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');

    const unique = [...new Set(candidates)];
    for (const p of unique) {
        if (existsSync(p)) {
            console.error(`[browser] Found browser: ${p}`);
            cachedBrowserPath = p;
            return p;
        }
    }
    throw new Error('未找到 Chromium 内核浏览器，请安装 Chrome 或 Edge。');
}

/** 查找可用的 TCP 端口 */
function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            if (addr && typeof addr === 'object') {
                const port = addr.port;
                srv.close(() => resolve(port));
            } else {
                srv.close(() => reject(new Error('Could not determine port')));
            }
        });
        srv.on('error', reject);
    });
}

interface BrowserSession {
    browser: Browser;
    tempDir: string;
    browserPid?: number;
}

let cachedSession: BrowserSession | null = null;
let cleanupRegistered = false;

async function launchBrowser(): Promise<BrowserSession> {
    const browserPath = getBrowserPath();
    const tempDir = mkdtempSync(join(tmpdir(), 'mcp-search-'));
    const port = await findFreePort();

    const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${tempDir}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        // 使用 GUI 模式（非 headless）以避免 Bing 等搜索引擎的反自动化检测，
        // 通过将窗口移到屏幕外来隐藏
        '--window-position=-32000,-32000',
        '--window-size=1,1',
    ];

    console.error(`[browser] Spawning browser on port ${port}, profile: ${tempDir}`);

    let browserPid: number | undefined;

    if (process.platform === 'win32') {
        // 在一个独立的不可见 Win32 Desktop 上启动浏览器。
        // 通过 CreateProcessW + STARTUPINFO.lpDesktop 直接指定桌面，
        // 子进程自动继承父进程的桌面，因此 Edge 的所有子进程（GPU、渲染器等）
        // 都在隐藏桌面上运行，用户桌面上不会出现任何窗口。
        const desktopName = `mcp-search-${Date.now()}`;
        // 安全说明：cmdLine 中的 browserPath 来自 getBrowserPath() 的硬编码路径列表，
        // args 全部是内部生成的常量，desktopName 是时间戳——均无外部输入，不存在注入风险。
        // 下方 replace(/'/g, "''") 是 PowerShell 单引号字符串的标准转义，作为防御性编码。
        const cmdLine = `"${browserPath}" ${args.join(' ')}`;
        const psScript = `
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
            throw new Exception("CreateDesktop failed: " +
                Marshal.GetLastWin32Error());

        var si = new STARTUPINFOW();
        si.cb = Marshal.SizeOf(si);
        si.lpDesktop = desktopName;

        PROCESS_INFORMATION pi;
        if (!CreateProcessW(null, cmdLine, IntPtr.Zero, IntPtr.Zero,
            false, 0, IntPtr.Zero, null, ref si, out pi))
            throw new Exception("CreateProcess failed: " +
                Marshal.GetLastWin32Error());

        // 将桌面句柄复制到浏览器进程中，使其持有对桌面的引用。
        // 这样即使当前进程（PowerShell）退出，桌面也不会被销毁。
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
[HiddenLauncher]::Launch('${cmdLine.replace(/'/g, "''")}', '${desktopName}')`;
        try {
            const output = execFileSync('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-Command', psScript,
            ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
            browserPid = parseInt(output.trim());
            console.error(`[browser] Browser started on hidden desktop "${desktopName}", PID: ${browserPid}`);
        } catch (err: any) {
            try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
            throw new Error(`启动浏览器失败: ${err.message}`);
        }
    } else {
        const child = spawn(browserPath, args, {
            stdio: 'ignore',
            detached: true,
        });
        child.on('error', () => {});
        child.unref();
        browserPid = child.pid;
    }

    const debugUrl = `http://127.0.0.1:${port}/json/version`;
    let wsUrl: string | null = null;
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 200));
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        try {
            const resp = await fetch(debugUrl, { signal: controller.signal });
            const data = await resp.json() as { webSocketDebuggerUrl?: string };
            if (data.webSocketDebuggerUrl) {
                wsUrl = data.webSocketDebuggerUrl;
                break;
            }
        } catch {
            // 浏览器尚未就绪或请求超时
        } finally {
            clearTimeout(timeoutId);
        }
    }

    if (!wsUrl) {
        if (browserPid) try { process.kill(browserPid); } catch {}
        try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
        throw new Error('浏览器启动失败：无法获取 WebSocket URL');
    }

    console.error(`[browser] Browser ready, connecting via ${wsUrl}`);
    try {
        const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
        return { browser, tempDir, browserPid };
    } catch (err) {
        if (browserPid) try { process.kill(browserPid); } catch {}
        try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
        throw err;
    }
}

/**
 * 优雅关闭浏览器：通过 CDP 命令让浏览器自行退出，所有子进程自动清理。
 * 如果 close() 超时，则回退到强杀进程树。
 */
async function closeSession(session: BrowserSession) {
    try {
        // browser.close() 发送 CDP Browser.close 命令，浏览器会优雅退出并清理所有子进程
        await Promise.race([
            session.browser.close(),
            new Promise(r => { const t = setTimeout(r, 5000); if (typeof t === 'object') t.unref(); }),  // 5 秒超时，不阻塞事件循环
        ]);
    } catch (err) {
        // close 失败（例如浏览器已崩溃），回退到强杀
        console.error('[browser] browser.close() failed, falling back to force kill:', (err as Error).message ?? err);
        killBrowserProcess(session);
    }
    try { rmSync(session.tempDir, { recursive: true, force: true }); } catch {}
}

/**
 * 同步强杀浏览器进程树（仅在 process.on('exit') 等无法使用 async 的场景中使用）。
 */
function killBrowserProcess(session: BrowserSession) {
    console.error(`[browser] Force killing browser process tree (PID: ${session.browserPid ?? 'unknown'})`);
    try { session.browser.disconnect(); } catch {}
    if (session.browserPid) {
        if (process.platform === 'win32') {
            // Windows 上 process.kill 只杀主进程，Edge 的子进程（GPU、渲染器等）会变成孤儿。
            // 使用 taskkill /T 级联终止整个进程树。
            try { execFileSync('taskkill', ['/F', '/T', '/PID', String(session.browserPid)], { windowsHide: true, timeout: 5000 }); } catch {}
        } else {
            try { process.kill(-session.browserPid); } catch {}        // Unix: 杀进程组
            try { process.kill(session.browserPid); } catch {}
        }
    }
    try { rmSync(session.tempDir, { recursive: true, force: true }); } catch {}
}

/** 获取或复用全局共享的浏览器实例 */
export async function getSharedBrowser(): Promise<Browser> {
    if (cachedSession) {
        try {
            await cachedSession.browser.version();
            return cachedSession.browser;
        } catch {
            console.error('[browser] Cached browser session is dead, relaunching...');
            killBrowserProcess(cachedSession);
            cachedSession = null;
        }
    }

    const session = await launchBrowser();
    cachedSession = session;

    if (!cleanupRegistered) {
        cleanupRegistered = true;
        // exit 事件只能执行同步代码，使用强杀作为最后防线
        process.once('exit', () => {
            if (cachedSession) {
                killBrowserProcess(cachedSession);
                cachedSession = null;
            }
        });
        // SIGINT/SIGTERM 可以执行异步代码，优先使用优雅关闭
        const signalCleanup = async () => {
            if (cachedSession) {
                await closeSession(cachedSession);
                cachedSession = null;
            }
            process.exit();
        };
        process.once('SIGINT', signalCleanup);
        process.once('SIGTERM', signalCleanup);
    }

    return cachedSession.browser;
}

/** 销毁全局浏览器会话（搜索出错时调用，下次会重新启动） */
export async function destroySharedBrowser(): Promise<void> {
    if (cachedSession) {
        await closeSession(cachedSession);
        cachedSession = null;
    }
}
