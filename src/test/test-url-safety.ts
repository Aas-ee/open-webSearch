import { isPublicHttpUrl, isPrivateOrLocalHostname } from '../utils/urlSafety.js';

type Case = {
    value: string;
    expected: boolean;
};

function assertEqual(actual: boolean, expected: boolean, message: string): void {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
    }
}

function runHostCases(): void {
    const hostCases: Case[] = [
        { value: 'localhost', expected: true },
        { value: '127.0.0.1', expected: true },
        { value: '10.0.0.5', expected: true },
        { value: '172.20.1.8', expected: true },
        { value: '192.168.1.1', expected: true },
        { value: '169.254.169.254', expected: true },
        { value: '::1', expected: true },
        { value: 'fd00::1', expected: true },
        { value: 'example.com', expected: false },
        { value: '8.8.8.8', expected: false }
    ];

    for (const testCase of hostCases) {
        const actual = isPrivateOrLocalHostname(testCase.value);
        assertEqual(actual, testCase.expected, `host check failed for ${testCase.value}`);
        console.log(`✅ host ${testCase.value} -> private=${actual}`);
    }
}

function runUrlCases(): void {
    const urlCases: Case[] = [
        { value: 'https://example.com/skill.md', expected: true },
        { value: 'http://8.8.8.8/resource', expected: true },
        { value: 'ftp://example.com/file', expected: false },
        { value: 'http://localhost:3000/secret', expected: false },
        { value: 'http://127.0.0.1/admin', expected: false },
        { value: 'http://169.254.169.254/latest/meta-data', expected: false }
    ];

    for (const testCase of urlCases) {
        const actual = isPublicHttpUrl(testCase.value);
        assertEqual(actual, testCase.expected, `url check failed for ${testCase.value}`);
        console.log(`✅ url ${testCase.value} -> allowed=${actual}`);
    }
}

function main(): void {
    runHostCases();
    runUrlCases();
    console.log('\nURL safety tests passed.');
}

main();
