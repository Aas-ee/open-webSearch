import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { fetchWebContent } from '../engines/web/index.js';
import { shutdownLocalPlaywrightBrowserSessions } from '../utils/playwrightClient.js';

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

function getEdgePids(): string[] {
    try {
        const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Select-Object -ExpandProperty ProcessId) -join ','"],
            { encoding: 'utf8', windowsHide: true, timeout: 5000 });
        return raw.trim().split(',').filter(Boolean);
    } catch { return []; }
}

async function main(): Promise<void> {
    console.log('=== 无窗口回归测试 ===\n');

    try { execFileSync('taskkill', ['/F', '/IM', 'msedge.exe'], { windowsHide: true, timeout: 3000 }); } catch {}
    await new Promise(r => setTimeout(r, 2000));
    console.log('1. 初始 msedge: ' + getEdgePids().length + ' 个');

    let visible = false;
    let details: string[] = [];
    const pollPromise = (async () => {
        const endAt = Date.now() + 15000;
        while (Date.now() < endAt) {
            const pids = getEdgePids();
            if (pids.length > 0) {
                const r = checkForVisibleWindow(new Set(pids.map(Number)));
                if (r.details.length > 0) details = r.details;
                if (r.visible) { visible = true; break; }
            }
            await new Promise(r2 => setTimeout(r2, 50));
        }
    })();

    console.log('2. 后台轮询已启动，fetchWebContent...');
    const result = await fetchWebContent('https://github.com/microsoft/vscode', 2000);
    await pollPromise;

    console.log('   fetch: ' + result.retrievalMethod + ' ' + result.title.slice(0, 50));
    console.log('   窗口可见: ' + visible);
    if (details.length > 0) {
        for (const d of [...new Set(details)].slice(0, 8)) console.log('     ' + d);
    }

    await shutdownLocalPlaywrightBrowserSessions();

    if (!visible) {
        console.log('\n✅ 通过：无可见窗口');
    } else {
        console.error('\n❌ 失败：检测到可见窗口');
        process.exit(1);
    }
    console.log('=== 测试完成 ===');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
