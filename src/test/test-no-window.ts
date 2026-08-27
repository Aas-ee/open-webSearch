import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fetchPageHtmlWithBrowser } from '../utils/browserCookies.js';
import { shutdownLocalPlaywrightBrowserSessions } from '../utils/playwrightClient.js';

if (process.platform !== 'win32') {
    console.log('SKIP: test-no-window requires Windows (uses user32.dll via koffi).');
    process.exit(0);
}
if (!process.env.OPEN_WEBSEARCH_INTEGRATION_TESTS) {
    console.log('SKIP: Set OPEN_WEBSEARCH_INTEGRATION_TESTS=1 to run (only kills browser processes started against the test profile).');
    process.exit(0);
}

// 隔离的测试 profile：清理时只杀使用本目录的浏览器进程，不碰用户自己打开的 Edge。
const TEST_PROFILE_DIR = mkdtempSync(path.join(tmpdir(), 'ows-test-no-window-'));
process.env.OPEN_WEBSEARCH_PROFILE_DIR = TEST_PROFILE_DIR;

function listTestBrowserRootPids(): number[] {
    try {
        const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${TEST_PROFILE_DIR}*' -and $_.CommandLine -notmatch '--type=' } | Select-Object -ExpandProperty ProcessId`],
            { encoding: 'utf8', windowsHide: true, timeout: 5000 });
        return raw.trim().split(/\s+/).filter(Boolean).map(Number);
    } catch { return []; }
}

function killTestBrowsers(): void {
    for (const pid of listTestBrowserRootPids()) {
        try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, timeout: 3000 }); } catch {}
    }
}

const esmRequire = createRequire(import.meta.url);
const koffiLib = esmRequire('koffi') as typeof import('koffi');
const koffiAny = koffiLib as any;

const user32 = koffiLib.load('user32.dll');

koffiLib.struct('RECT', { Left: 'int32_t', Top: 'int32_t', Right: 'int32_t', Bottom: 'int32_t' });

const EnumWindows = user32.func('bool __stdcall EnumWindows(void *lpEnumFunc, intptr_t lParam)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *lpdwProcessId)');
const GetClassNameW = user32.func('int32_t __stdcall GetClassNameW(void *hWnd, _Out_ char16 *lpClassName, int32_t nMaxCount)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hWnd, _Out_ RECT *lpRect)');

function checkForVisibleWindow(targetPids: Set<number>): { visible: boolean; details: string[] } {
    const details: string[] = [];
    let visible = false;
    const proto = koffiAny.proto('bool (void *, intptr_t)');
    const cb = koffiAny.register(
        (hWnd: any, _lParam: any) => {
            const pidBuf = [0];
            GetWindowThreadProcessId(hWnd, pidBuf);
            if (!targetPids.has(pidBuf[0])) return true;

            const cnBuf = Buffer.alloc(256 * 2);
            GetClassNameW(hWnd, cnBuf as any, 256);
            const cn = cnBuf.toString('utf16le').replace(/\0/g, '');

            const rect = { Left: 0, Top: 0, Right: 0, Bottom: 0 };
            GetWindowRect(hWnd, rect);
            const w = rect.Right - rect.Left;
            const h = rect.Bottom - rect.Top;

            details.push(`${cn} @(${rect.Left},${rect.Top}) ${w}x${h}`);

            if (cn.startsWith('Chrome_WidgetWin_') && w > 10 && h > 10 && rect.Left > -30000 && rect.Left < 10000) {
                visible = true;
                return false;
            }
            return true;
        },
        koffiAny.pointer(proto)
    );
    EnumWindows(cb, 0);
    return { visible, details };
}

async function main(): Promise<void> {
    console.log('=== 无窗口回归测试 ===\n');
    console.log('   测试 profile: ' + TEST_PROFILE_DIR + '\n');

    killTestBrowsers();
    await shutdownLocalPlaywrightBrowserSessions();
    await new Promise(r => setTimeout(r, 2000));
    console.log('1. 初始测试浏览器根进程: ' + listTestBrowserRootPids().length + ' 个');

    // 后台轮询窗口
    let visible = false;
    let details: string[] = [];
    const pollPromise = (async () => {
        const endAt = Date.now() + 15000;
        while (Date.now() < endAt) {
            const pids = listTestBrowserRootPids();
            if (pids.length > 0) {
                const r = checkForVisibleWindow(new Set(pids));
                if (r.details.length > 0) details = r.details;
                if (r.visible) { visible = true; break; }
            }
            await new Promise(r2 => setTimeout(r2, 50));
        }
    })();

    // 直接调用 fetchPageHtmlWithBrowser：保证真实执行浏览器渲染路径（fetchWebContent 只有在回退条件命中时才会进浏览器，无法作为强制路径断言）。
    console.log('2. 后台轮询已启动，fetchPageHtmlWithBrowser（强制浏览器路径）...');
    const result = await fetchPageHtmlWithBrowser('https://github.com/microsoft/vscode');
    await pollPromise;

    console.log('   title: ' + result.title.slice(0, 50));
    console.log('   html 长度: ' + result.html.length);
    console.log('   窗口可见: ' + visible);
    if (details.length > 0) {
        for (const d of [...new Set(details)].slice(0, 8)) console.log('     ' + d);
    }

    if (!result.html.trim()) {
        console.error('\n❌ 失败：浏览器路径返回空 HTML');
        process.exit(1);
    }
    if (!result.title.trim()) {
        console.error('\n❌ 失败：浏览器路径返回空标题，无法证明真实渲染');
        process.exit(1);
    }

    await shutdownLocalPlaywrightBrowserSessions();
    killTestBrowsers();
    try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch {}

    if (visible) {
        console.error('\n❌ 失败：检测到可见窗口');
        process.exit(1);
    } else {
        console.log('\n✅ 通过：浏览器路径真实执行且无可见窗口');
    }
    console.log('=== 测试完成 ===');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
