// 浏览器路径解析收敛到本模块：配置检测（config.checkPlaywrightModeConfiguration）与运行时启动（playwrightClient）共用同一套候选与解析顺序，避免检测判定"可用"而实际启动用了不同（甚至错误）的路径。
import { existsSync } from 'node:fs';

// 系统安装路径候选；不含 PLAYWRIGHT_EXECUTABLE_PATH（由调用方优先处理）与 Playwright 客户端捆绑浏览器（由调用方在客户端加载后探测）。
export function getSystemBrowserCandidates(): string[] {
    const candidates: string[] = [];

    if (process.platform === 'win32') {
        candidates.push(
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        );

        const pf86 = process.env['PROGRAMFILES(X86)'];
        const pf = process.env['PROGRAMFILES'];
        const localAppData = process.env['LOCALAPPDATA'];
        if (pf86) {
            candidates.push(`${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${pf86}\\Google\\Chrome\\Application\\chrome.exe`);
        }
        if (pf) {
            candidates.push(`${pf}\\Microsoft\\Edge\\Application\\msedge.exe`, `${pf}\\Google\\Chrome\\Application\\chrome.exe`);
        }
        if (localAppData) {
            candidates.push(`${localAppData}\\Google\\Chrome\\Application\\chrome.exe`);
        }
    } else if (process.platform === 'darwin') {
        candidates.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
        );
    } else {
        candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/microsoft-edge');
    }

    return candidates;
}
