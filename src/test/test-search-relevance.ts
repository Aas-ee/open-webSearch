import { searchBaidu } from '../engines/baidu/index.js';
import { searchBing } from '../engines/bing/index.js';
import { destroySharedBrowser } from '../engines/shared/browser.js';

interface TestCase {
    engine: 'baidu' | 'bing';
    query: string;
    mustContainAny: string[];
    description: string;
}

const tests: TestCase[] = [
    {
        engine: 'baidu',
        query: '天气预报',
        mustContainAny: ['天气', '预报', 'weather'],
        description: 'Baidu "天气预报" (Issue #29 核心问题词)',
    },
    {
        engine: 'baidu',
        query: 'Python教程',
        mustContainAny: ['python', 'Python', '教程', '编程'],
        description: 'Baidu "Python教程" (Issue #29 问题词)',
    },
    {
        engine: 'bing',
        query: 'websearch mcp server',
        mustContainAny: ['websearch', 'mcp', 'search', 'MCP'],
        description: 'Bing "websearch mcp server" 结果相关性',
    },
    {
        engine: 'bing',
        query: 'TypeScript tutorial',
        mustContainAny: ['typescript', 'TypeScript', 'tutorial', '教程'],
        description: 'Bing "TypeScript tutorial" 结果相关性',
    },
];

async function testSearchRelevance() {
    console.log('=== 搜索结果相关性测试 ===\n');

    let passed = 0;
    let failed = 0;

    for (const tc of tests) {
        console.log(`--- ${tc.description} ---`);
        console.log(`查询: "${tc.query}" (${tc.engine})`);

        try {
            const results = tc.engine === 'baidu'
                ? await searchBaidu(tc.query, 5)
                : await searchBing(tc.query, 5);

            if (results.length === 0) {
                console.log(`❌ FAIL: 返回 0 条结果`);
                failed++;
                continue;
            }

            results.forEach((r, i) => {
                console.log(`  ${i + 1}. ${r.title}`);
            });

            const keywords = tc.mustContainAny.map(k => k.toLowerCase());
            let relevantCount = 0;
            for (const r of results) {
                const text = `${r.title} ${r.url} ${r.description}`.toLowerCase();
                if (keywords.some(k => text.includes(k))) {
                    relevantCount++;
                }
            }

            const ratio = relevantCount / results.length;
            if (ratio >= 0.5) {
                console.log(`✅ PASS: ${relevantCount}/${results.length} 条结果相关 (${(ratio * 100).toFixed(0)}%)`);
                passed++;
            } else {
                console.log(`❌ FAIL: ${relevantCount}/${results.length} 条结果相关 (${(ratio * 100).toFixed(0)}%) — 相关性不足`);
                failed++;
            }
        } catch (err: any) {
            console.log(`❌ FAIL: ${err.message}`);
            failed++;
        }
        console.log();
    }

    console.log(`=== 结果: ${passed}/${passed + failed} 通过 ===`);
    if (failed > 0) {
        console.log(`⚠️ ${failed} 项未通过`);
        process.exitCode = 1;
    }
}

testSearchRelevance().catch(console.error).finally(async () => { await destroySharedBrowser(); process.exit(0); });
