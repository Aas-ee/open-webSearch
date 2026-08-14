import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { config } from '../config.js';
import { searchBing } from '../engines/bing/bing.js';
import { fetchPageHtmlWithBrowser } from '../utils/browserCookies.js';
import { shutdownLocalPlaywrightBrowserSessions } from '../utils/playwrightClient.js';

if (process.platform !== 'win32') {
    console.log('SKIP: test-browser-sharing requires Windows (uses PowerShell for process enumeration).');
    process.exit(0);
}
if (!process.env.OPEN_WEBSEARCH_INTEGRATION_TESTS) {
    console.log('SKIP: Set OPEN_WEBSEARCH_INTEGRATION_TESTS=1 to run (only kills browser processes started against the test profile).');
    process.exit(0);
}

// 隔离的测试 profile：清理时只杀使用本目录的浏览器进程，不碰用户自己打开的 Edge。
const TEST_PROFILE_DIR = mkdtempSync(path.join(tmpdir(), 'ows-test-browser-sharing-'));
process.env.OPEN_WEBSEARCH_PROFILE_DIR = TEST_PROFILE_DIR;

function listTestBrowserRootPids(): number[] {
    try {
        const raw = execFileSync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command',
                `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${TEST_PROFILE_DIR}*' -and $_.CommandLine -notmatch '--type=' } | Select-Object -ExpandProperty ProcessId`],
            { encoding: 'utf8', windowsHide: true, timeout: 5000 }
        );
        return raw.trim().split(/\s+/).filter(Boolean).map(Number);
    } catch {
        return [];
    }
}

function killTestBrowsers(): void {
    for (const pid of listTestBrowserRootPids()) {
        try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, timeout: 3000 }); } catch {}
    }
}

function listTestBrowserCommandLines(): Array<{ pid: number; commandLine: string }> {
    try {
        const raw = execFileSync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command',
                `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${TEST_PROFILE_DIR}*' -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`],
            { encoding: 'utf8', windowsHide: true, timeout: 5000 }
        ).trim();
        if (!raw) {
            return [];
        }
        const parsed = JSON.parse(raw) as Array<{ ProcessId?: number; CommandLine?: string }>;
        return parsed
            .filter((item) => typeof item.ProcessId === 'number' && typeof item.CommandLine === 'string')
            .map((item) => ({ pid: item.ProcessId!, commandLine: item.CommandLine! }));
    } catch {
        return [];
    }
}

async function main(): Promise<void> {
    let passed = 0;
    let failed = 0;

    try {
        // ── 测试 1：search → fetchWebContent → search，全程共享同一浏览器 ──
        console.log('── 测试 1：search → fetch → search（全流程共享）──');
        console.log(`  测试 profile: ${TEST_PROFILE_DIR}`);
        killTestBrowsers();
        await shutdownLocalPlaywrightBrowserSessions();
        console.log(`  初始测试浏览器主进程: ${listTestBrowserRootPids().length} 个`);

        // 第一次搜索 — 触发 antiBot 隐藏有头浏览器
        console.log('  1. Bing 搜索...');
        const results1 = await searchBing('hello world', 2, { searchMode: 'playwright' });
        console.log(`      结果: ${results1.length} 条`);
        const afterSearch1 = listTestBrowserRootPids();
        console.log(`  2. 搜索后主进程: ${afterSearch1.length} 个`);
        if (afterSearch1.length === 0) { failed++; console.error('  ❌ 搜索未启动浏览器'); }

        // 强制浏览器路径 fetch — 应复用同一个浏览器。
        // 这里不用 fetchWebContent：它可能直接走 HTTP 返回，即使不进浏览器也不会新增进程，使“复用”断言空转；fetchPageHtmlWithBrowser 必然真实执行渲染路径。
        console.log('  3. fetchPageHtmlWithBrowser（强制浏览器路径）...');
        const fwcPage = await fetchPageHtmlWithBrowser('https://github.com/Ebola-Chan-bot/open-webSearch');
        if (!fwcPage.html.trim()) {
            failed++;
            console.error('      ❌ fetch 浏览器路径返回空 HTML');
        }
        const afterFwc = listTestBrowserRootPids();
        const new1 = afterFwc.filter((p) => !afterSearch1.includes(p));
        console.log(`  4. fetch 后主进程: ${afterFwc.length} 个（html ${fwcPage.html.length} 字符）`);
        if (new1.length === 0) { passed++; console.log('  ✅ fetch 复用浏览器'); }
        else { failed++; console.error(`  ❌ 新增 PID: [${new1.join(',')}]`); }

        // 第二次搜索 — 继续复用
        console.log('  5. 再次 Bing 搜索...');
        const results2 = await searchBing('typescript', 2, { searchMode: 'playwright' });
        console.log(`      结果: ${results2.length} 条`);
        const afterSearch2 = listTestBrowserRootPids();
        const new2 = afterSearch2.filter((p) => !afterFwc.includes(p));
        console.log(`  6. 再次搜索后主进程: ${afterSearch2.length} 个`);
        if (new2.length === 0) { passed++; console.log('  ✅ 第二次搜索复用浏览器'); }
        else { failed++; console.error(`  ❌ 新增 PID: [${new2.join(',')}]`); }

        await shutdownLocalPlaywrightBrowserSessions();

        // ── 测试 2：反向顺序 fetch → search（antiBot 不得复用无头浏览器）──
        // 回归审查意见：fetch（--headless=new）先创建浏览器时，antiBot 搜索不得复用该进程，否则隐藏有头反爬静默失效。hidden-headless / hidden-headed 分域后，antiBot 会启动自己的隐藏有头浏览器，测试 profile 内不得残留 --headless 进程。
        console.log('\n── 测试 2：fetch → search（反向顺序，antiBot 不得复用无头浏览器）──');
        killTestBrowsers();
        await shutdownLocalPlaywrightBrowserSessions();

        console.log('  1. fetchPageHtmlWithBrowser（强制浏览器路径）...');
        const page = await fetchPageHtmlWithBrowser('https://github.com/Ebola-Chan-bot/open-webSearch');
        if (!page.html.trim()) {
            failed++;
            console.error('  ❌ fetch 浏览器路径返回空 HTML');
        } else {
            passed++;
            console.log(`  ✅ fetch 浏览器路径真实执行（html ${page.html.length} 字符）`);
        }
        const afterFetch = listTestBrowserRootPids();
        console.log(`  2. fetch 后主进程: ${afterFetch.length} 个`);

        console.log('  3. Bing 搜索（antiBot）...');
        const results3 = await searchBing('hello world', 2, { searchMode: 'playwright' });
        console.log(`      结果: ${results3.length} 条`);
        if (results3.length > 0) { passed++; console.log('  ✅ 反向顺序搜索返回结果'); }
        else { failed++; console.error('  ❌ 反向顺序搜索无结果'); }

        // 精确断言：antiBot 搜索必须启动自己的隐藏有头浏览器，而不是复用 fetch 的 --headless=new 进程。若复用成立，afterSearch 相对 afterFetch 不会有新 PID；若正确分域启动，新 PID 的命令行一定不含 --headless。（fetch 的无头浏览器此时仍可存活，那是正常的另一个复用域，不参与此断言。）
        const afterSearch3 = listTestBrowserRootPids();
        const antiBotNewPids = afterSearch3.filter((p) => !afterFetch.includes(p));
        if (antiBotNewPids.length === 0) {
            failed++;
            console.error('  ❌ antiBot 未启动新浏览器，复用了 fetch 的无头进程');
        } else {
            const antiBotProcesses = listTestBrowserCommandLines().filter((item) => antiBotNewPids.includes(item.pid));
            const headlessOnes = antiBotProcesses.filter((item) => item.commandLine.includes('--headless'));
            if (headlessOnes.length > 0) {
                failed++;
                console.error(`  ❌ antiBot 新启动的浏览器带 --headless 参数: [${headlessOnes.map((item) => item.pid).join(',')}]`);
            } else {
                passed++;
                console.log(`  ✅ antiBot 新启动隐藏有头浏览器 (PID: ${antiBotNewPids.join(',')})，未复用 --headless 进程`);
            }
        }

        await shutdownLocalPlaywrightBrowserSessions();

        // ── 测试 3：有头模式 → search/fetch/search ──
        console.log('\n── 测试 3：有头模式 search → fetch → search ──');
        (config as any).playwrightHeadless = false;
        killTestBrowsers();
        await shutdownLocalPlaywrightBrowserSessions();
        console.log(`  初始: ${listTestBrowserRootPids().length} 个`);

        const r1 = await searchBing('hello world', 2, { searchMode: 'playwright' });
        const a1 = listTestBrowserRootPids();
        console.log(`  search后: ${a1.length} 个 (${r1.length} 条)`);

        const headedPage = await fetchPageHtmlWithBrowser('https://github.com/Ebola-Chan-bot/open-webSearch');
        const a2 = listTestBrowserRootPids();
        const n1 = a2.filter(p => !a1.includes(p));
        console.log(`  fetch后: ${a2.length} 个 ${n1.length === 0 ? '✅' : '❌'} (html ${headedPage.html.length} 字符)`);
        if (n1.length === 0) passed++; else failed++;

        const r2 = await searchBing('typescript', 2, { searchMode: 'playwright' });
        const a3 = listTestBrowserRootPids();
        const n2 = a3.filter(p => !a2.includes(p));
        console.log(`  再search: ${a3.length} 个 ${n2.length === 0 ? '✅' : '❌'} (${r2.length} 条)`);
        if (n2.length === 0) passed++; else failed++;

        await shutdownLocalPlaywrightBrowserSessions();

        console.log(`\n=== ${passed}/${passed + failed} 通过 ===`);
    } finally {
        killTestBrowsers();
        try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch {}
    }

    if (failed > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
