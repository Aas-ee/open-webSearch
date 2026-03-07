import { z } from 'zod';
import { normalizeEngineName } from '../tools/setupTools.js';

const SUPPORTED_ENGINES = [
    'baidu',
    'bing',
    'linuxdo',
    'csdn',
    'duckduckgo',
    'exa',
    'brave',
    'juejin'
] as const;

const engineSchema = z.array(
    z.string()
        .min(1)
        .transform(normalizeEngineName)
        .pipe(z.enum(SUPPORTED_ENGINES))
).min(1);

type SuccessCase = {
    input: string[];
    expected: string[];
};

type FailureCase = {
    input: string[];
    reason: string;
};

const successCases: SuccessCase[] = [
    { input: ['bing'], expected: ['bing'] },
    { input: ['Bing'], expected: ['bing'] },
    { input: ['DuckDuckGo'], expected: ['duckduckgo'] },
    { input: ['duck-duck-go'], expected: ['duckduckgo'] },
    { input: ['linux.do'], expected: ['linuxdo'] },
    { input: ['  CSDN  ', 'JueJin'], expected: ['csdn', 'juejin'] }
];

const failureCases: FailureCase[] = [
    { input: ['Google'], reason: 'unsupported engine should fail' },
    { input: [''], reason: 'empty engine should fail' }
];

function assertEqualArray(actual: string[], expected: string[], label: string): void {
    const ok = actual.length === expected.length && actual.every((value, index) => value === expected[index]);
    if (!ok) {
        throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function runSuccessCases(): void {
    for (const testCase of successCases) {
        const parsed = engineSchema.parse(testCase.input);
        assertEqualArray(parsed, testCase.expected, `success case ${JSON.stringify(testCase.input)}`);
        console.log(`✅ success: ${JSON.stringify(testCase.input)} -> ${JSON.stringify(parsed)}`);
    }
}

function runFailureCases(): void {
    for (const testCase of failureCases) {
        const result = engineSchema.safeParse(testCase.input);
        if (result.success) {
            throw new Error(`failure case should fail: ${JSON.stringify(testCase.input)} (${testCase.reason})`);
        }
        console.log(`✅ expected failure: ${JSON.stringify(testCase.input)} (${testCase.reason})`);
    }
}

function main(): void {
    runSuccessCases();
    runFailureCases();
    console.log('\nEngine normalization tests passed.');
}

main();
