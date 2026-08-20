// 集成测试：验证 fetchPageHtmlWithBrowser 能从使用 Shadow DOM 模态框的真实页面捕获对话框悬浮层文本。
//
// 与 test-browser-sharing.ts 同一模式：
//   - 需要 PLAYWRIGHT_MODULE_PATH + PLAYWRIGHT_EXECUTABLE_PATH
//   - 直接调用生产代码 fetchPageHtmlWithBrowser
//   - 测试结束后清理浏览器会话
//
// 运行方式：
//   PLAYWRIGHT_MODULE_PATH=<path> PLAYWRIGHT_EXECUTABLE_PATH=<path> npx tsc && node build/test/test-dialog-capture.js

import { fetchPageHtmlWithBrowser } from '../utils/browserCookies.js';
import { fetchWebContent } from '../engines/web/index.js';
import { shutdownLocalPlaywrightBrowserSessions } from '../utils/playwrightClient.js';

const TEST_URL = 'https://support.clarivate.com/Endnote/s/article/EndNote-API-Support?language=en_US';

let failed = 0;

function assert(condition: boolean, label: string): void {
    if (condition) {
        console.log(`  ✅ ${label}`);
    } else {
        console.log(`  ❌ ${label}`);
        failed++;
    }
}

async function main(): Promise<void> {
    console.log('=== Dialog Capture Integration Tests ===\n');

    // 测试 1：fetchPageHtmlWithBrowser 必须捕获 dialogTexts，且不允许重复
    console.log('Test 1: fetchPageHtmlWithBrowser returns dialogTexts');
    const result = await fetchPageHtmlWithBrowser(TEST_URL);

    assert(result.html.length > 0, 'HTML is non-empty');
    assert(result.finalUrl.length > 0, 'finalUrl is set');
    console.log(`  dialogTexts: ${JSON.stringify(result.dialogTexts)}`);

    // 必须捕获到"页面已移动"模态框文本，且不允许重复。
    const dialogTexts = result.dialogTexts ?? [];
    assert(dialogTexts.length > 0, 'dialogTexts is non-empty');
    const allText = dialogTexts.join(' ');
    assert(allText.includes('This page has been moved'), 'contains "moved" text');

    // "moved" 文本必须只出现一次
    const movedCount = (allText.match(/This page has been moved/g) || []).length;
    assert(movedCount === 1, `"moved" appears exactly once (got ${movedCount})`);

    // 相同文本必须只出现一次（无重复）
    const uniqueTexts = [...new Set(dialogTexts)];
    assert(uniqueTexts.length === dialogTexts.length, 'no duplicate dialog texts');
    console.log(`  All captured text: ${allText.substring(0, 100)}...`);

    // 测试 2：fetchWebContent 最终输出中 "moved" 只能出现一次
    console.log('\nTest 2: fetchWebContent final output');
    const webResult = await fetchWebContent(TEST_URL, 10000);
    const movedInFinal = (webResult.content.match(/This page has been moved/g) || []).length;
    assert(movedInFinal === 1, `"moved" in final output appears exactly once (got ${movedInFinal})`);
    assert(webResult.content.includes('RSServices API'), 'final output contains article text');

    // 测试 3：CSS 悬浮检测逻辑（内联，与生产代码一致）
    console.log('\nTest 3: Synthetic floating overlay detection');
    function isVisuallyFloating(position: string, display: string, visibility: string, zIndex: string): boolean {
        if (position !== 'fixed' && position !== 'absolute') return false;
        if (display === 'none' || visibility === 'hidden') return false;
        const z = parseInt(zIndex || '0', 10);
        return !isNaN(z) && z > 0;
    }

    // CSS 定位检测——悬浮层检测的核心逻辑
    assert(isVisuallyFloating('fixed', 'block', 'visible', '9001'), 'fixed + z=9001 → floating');
    assert(isVisuallyFloating('fixed', 'block', 'visible', '1'), 'fixed + z=1 → floating');
    assert(isVisuallyFloating('absolute', 'flex', 'visible', '100'), 'absolute + z=100 → floating');
    assert(!isVisuallyFloating('static', 'block', 'visible', '9001'), 'static → not floating');
    assert(!isVisuallyFloating('relative', 'block', 'visible', '100'), 'relative → not floating');
    assert(!isVisuallyFloating('fixed', 'none', 'visible', '9001'), 'display:none → not floating');
    assert(!isVisuallyFloating('fixed', 'block', 'hidden', '9001'), 'visibility:hidden → not floating');
    assert(!isVisuallyFloating('fixed', 'block', 'visible', '0'), 'z=0 → not floating');
    assert(!isVisuallyFloating('fixed', 'block', 'visible', ''), 'z=empty → not floating');
    assert(!isVisuallyFloating('fixed', 'block', 'visible', 'abc'), 'z=NaN → not floating');

    // 清理
    await shutdownLocalPlaywrightBrowserSessions().catch(() => undefined);

    console.log('');
    if (failed === 0) {
        console.log('✅ ALL TESTS PASSED');
    } else {
        console.log(`❌ ${failed} test(s) failed`);
        process.exitCode = 1;
    }
}

main().catch(err => {
    console.error('❌', err.message);
    process.exitCode = 1;
});




