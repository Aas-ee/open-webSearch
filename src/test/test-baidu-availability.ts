import { searchBaidu } from '../engines/baidu/index.js';
import { destroySharedBrowser } from '../engines/shared/browser.js';

/**
 * 测试百度搜索引擎是否正常工作 (Issue #29: baidu被ban了)
 * 验证百度搜索能返回结果，且结果结构正确
 */

async function testBaiduAvailability() {
    console.log('=== Baidu availability test (Issue #29) ===\n');

    const tests: { name: string; pass: boolean }[] = [];

    // Test 1: 英文查询能否返回结果
    {
        const name = 'English query returns results';
        try {
            const results = await searchBaidu('websearch mcp', 5);
            const pass = results.length > 0;
            console.log(`${pass ? '✅ PASS' : '❌ FAIL'}: ${name} — got ${results.length} results`);
            tests.push({ name, pass });
        } catch (e) {
            console.log(`❌ FAIL: ${name} — error: ${e instanceof Error ? e.message : e}`);
            tests.push({ name, pass: false });
        }
    }

    // Test 2: 中文热门查询 (Issue #29 的核心场景)
    {
        const name = 'Chinese hot query returns results (Issue #29)';
        try {
            const results = await searchBaidu('天气预报', 5);
            const pass = results.length > 0;
            console.log(`${pass ? '✅ PASS' : '❌ FAIL'}: ${name} — got ${results.length} results`);
            tests.push({ name, pass });
        } catch (e) {
            console.log(`❌ FAIL: ${name} — error: ${e instanceof Error ? e.message : e}`);
            tests.push({ name, pass: false });
        }
    }

    // Test 3: 结果结构验证
    {
        const name = 'Results have correct structure';
        try {
            const results = await searchBaidu('nodejs', 3);
            const pass = results.length > 0 && results.every(r =>
                typeof r.title === 'string' && r.title.length > 0 &&
                typeof r.url === 'string' && r.url.startsWith('http') &&
                typeof r.description === 'string' &&
                r.engine === 'baidu'
            );
            console.log(`${pass ? '✅ PASS' : '❌ FAIL'}: ${name}`);
            if (!pass && results.length > 0) {
                console.log('   Sample result:', JSON.stringify(results[0], null, 2));
            }
            tests.push({ name, pass });
        } catch (e) {
            console.log(`❌ FAIL: ${name} — error: ${e instanceof Error ? e.message : e}`);
            tests.push({ name, pass: false });
        }
    }

    // Test 4: limit 参数生效
    {
        const name = 'Limit parameter is respected';
        try {
            const results = await searchBaidu('open source', 3);
            const pass = results.length > 0 && results.length <= 3;
            console.log(`${pass ? '✅ PASS' : '❌ FAIL'}: ${name} — requested 3, got ${results.length}`);
            tests.push({ name, pass });
        } catch (e) {
            console.log(`❌ FAIL: ${name} — error: ${e instanceof Error ? e.message : e}`);
            tests.push({ name, pass: false });
        }
    }

    const passed = tests.filter(t => t.pass).length;
    const total = tests.length;

    console.log(`\n=== Results: ${passed}/${total} passed ===`);

    if (passed === total) {
        console.log('\n✅ 百度搜索运行正常。');
    }

    process.exit(passed === total ? 0 : 1);
}

testBaiduAvailability().catch(console.error).finally(async () => { await destroySharedBrowser(); process.exit(0); });
