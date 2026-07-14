import { execFileSync } from 'child_process';
import { config } from '../config.js';
import { fetchWebContent } from '../engines/web/index.js';
import { searchBing } from '../engines/bing/bing.js';
import { shutdownLocalPlaywrightBrowserSessions } from '../utils/playwrightClient.js';

if (process.platform !== 'win32') {
    console.log('SKIP: test-browser-sharing requires Windows (uses PowerShell for process enumeration).');
    process.exit(0);
}
if (!process.env.OPEN_WEBSEARCH_INTEGRATION_TESTS) {
    console.log('SKIP: Set OPEN_WEBSEARCH_INTEGRATION_TESTS=1 to run (will taskkill msedge.exe).');
    process.exit(0);
}

function countEdgePids(): string[] {
    try {
        const raw = execFileSync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command',
                "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Select-Object -ExpandProperty ProcessId) -join ','"],
            { encoding: 'utf8', windowsHide: true, timeout: 5000 }
        );
        return raw.trim().split(',').filter(Boolean);
    } catch {
        return [];
    }
}

async function killAllEdge(): Promise<void> {
    try { execFileSync('taskkill', ['/F', '/IM', 'msedge.exe'], { windowsHide: true, timeout: 3000 }); } catch {}
    await new Promise((r) => setTimeout(r, 2000));
}

async function main(): Promise<void> {
    let passed = 0;
    let failed = 0;

    // ── 测试 1：search → fetchWebContent → search，全程共享同一浏览器 ──
    console.log('── 测试 1：search → fetch → search（全流程共享）──');
    await killAllEdge();
    await shutdownLocalPlaywrightBrowserSessions();
    console.log(`  初始主进程: ${countEdgePids().length} 个`);

    // 第一次搜索 — 触发 antiBot 隐藏有头浏览器
    console.log('  1. Bing 搜索...');
    const results1 = await searchBing('hello world', 2, { searchMode: 'playwright' });
    console.log(`      结果: ${results1.length} 条`);
    const afterSearch1 = countEdgePids();
    console.log(`  2. 搜索后主进程: ${afterSearch1.length} 个`);
    if (afterSearch1.length === 0) { failed++; console.error('  ❌ 搜索未启动浏览器'); }

    // fetchWebContent — 应复用同一个浏览器
    console.log('  3. fetchWebContent...');
    const fwc = await fetchWebContent('https://github.com/Ebola-Chan-bot/open-webSearch', 2000);
    console.log(`      结果: ${fwc.title.slice(0, 40)}..., ${fwc.retrievalMethod}`);
    const afterFwc = countEdgePids();
    const new1 = afterFwc.filter((p) => !afterSearch1.includes(p));
    console.log(`  4. fetch 后主进程: ${afterFwc.length} 个`);
    if (new1.length === 0) { passed++; console.log('  ✅ fetch 复用浏览器'); }
    else { failed++; console.error(`  ❌ 新增 PID: [${new1.join(',')}]`); }

    // 第二次搜索 — 继续复用
    console.log('  5. 再次 Bing 搜索...');
    const results2 = await searchBing('typescript', 2, { searchMode: 'playwright' });
    console.log(`      结果: ${results2.length} 条`);
    const afterSearch2 = countEdgePids();
    const new2 = afterSearch2.filter((p) => !afterFwc.includes(p));
    console.log(`  6. 再次搜索后主进程: ${afterSearch2.length} 个`);
    if (new2.length === 0) { passed++; console.log('  ✅ 第二次搜索复用浏览器'); }
    else { failed++; console.error(`  ❌ 新增 PID: [${new2.join(',')}]`); }

    await shutdownLocalPlaywrightBrowserSessions();

    // ── 测试 2：有头模式 → search/fetch/search ──
    console.log('\n── 测试 2：有头模式 search → fetch → search ──');
    (config as any).playwrightHeadless = false;
    await killAllEdge();
    console.log(`  初始: ${countEdgePids().length} 个`);

    const r1 = await searchBing('hello world', 2, { searchMode: 'playwright' });
    const a1 = countEdgePids();
    console.log(`  search后: ${a1.length} 个 (${r1.length} 条)`);

    const f = await fetchWebContent('https://github.com/Ebola-Chan-bot/open-webSearch', 2000);
    const a2 = countEdgePids();
    const n1 = a2.filter(p => !a1.includes(p));
    console.log(`  fetch后: ${a2.length} 个 ${n1.length === 0 ? '✅' : '❌'} (${f.retrievalMethod})`);
    if (n1.length === 0) passed++; else failed++;

    const r2 = await searchBing('typescript', 2, { searchMode: 'playwright' });
    const a3 = countEdgePids();
    const n2 = a3.filter(p => !a2.includes(p));
    console.log(`  再search: ${a3.length} 个 ${n2.length === 0 ? '✅' : '❌'} (${r2.length} 条)`);
    if (n2.length === 0) passed++; else failed++;

    await shutdownLocalPlaywrightBrowserSessions();

    console.log(`\n=== ${passed}/${passed + failed} 通过 ===`);
    if (failed > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
