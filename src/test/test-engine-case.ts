import { z } from 'zod';

// 复现 setupTools.ts 中的引擎 schema 逻辑（与实际代码一致）
const SUPPORTED_ENGINES = ['baidu', 'bing', 'linuxdo', 'csdn', 'duckduckgo', 'exa', 'brave', 'juejin'] as const;

const getAllowedEngines = () => [...SUPPORTED_ENGINES] as string[];

const enginesSchema = z.array(z.string())
    .min(1).default(['bing'])
    .transform(requestedEngines => {
        const allowed = getAllowedEngines();
        const normalized = requestedEngines.map(e => e.toLowerCase());
        const valid = normalized.filter(e => allowed.includes(e));
        if (valid.length === 0) {
            throw new Error(`No valid engine found. Allowed engines: ${allowed.join(', ')}`);
        }
        return valid;
    });

function test(name: string, input: unknown, expected: string[] | 'error') {
    try {
        const result = enginesSchema.parse(input);
        if (expected === 'error') {
            console.log(`❌ FAIL: ${name} — expected error but got ${JSON.stringify(result)}`);
            return false;
        }
        const pass = JSON.stringify(result) === JSON.stringify(expected);
        console.log(`${pass ? '✅ PASS' : '❌ FAIL'}: ${name} — got ${JSON.stringify(result)}`);
        return pass;
    } catch (e) {
        if (expected === 'error') {
            console.log(`✅ PASS: ${name} — correctly rejected`);
            return true;
        }
        console.log(`❌ FAIL: ${name} — unexpected error: ${e instanceof Error ? e.message : e}`);
        return false;
    }
}

console.log('=== Engine name case-insensitivity tests ===\n');

const results = [
    test('lowercase "bing"', ['bing'], ['bing']),
    test('uppercase first letter "Bing"', ['Bing'], ['bing']),
    test('all caps "DUCKDUCKGO"', ['DUCKDUCKGO'], ['duckduckgo']),
    test('mixed case "BaiDu"', ['BaiDu'], ['baidu']),
    test('multiple mixed case engines', ['Bing', 'BRAVE', 'exa'], ['bing', 'brave', 'exa']),
    test('invalid engine name', ['invalid'], 'error'),
    test('empty array', [], 'error'),
];

const passed = results.filter(Boolean).length;
const total = results.length;
console.log(`\n=== Results: ${passed}/${total} passed ===`);
process.exit(passed === total ? 0 : 1);
