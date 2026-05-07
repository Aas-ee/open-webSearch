import { assertPublicHttpUrlResolved, isPublicHttpUrl, isPrivateOrLocalHostname } from '../utils/urlSafety.js';

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

// Regression coverage for GHSA-v228-72c7-fx8j.
function runAdvisoryBypassCases(): void {
    const bypassUrls = [
        'http://[::1]/',
        'http://[::]/',
        'http://[::ffff:127.0.0.1]/',
        'http://[::ffff:7f00:1]/',
        'http://[0:0:0:0:0:ffff:127.0.0.1]/',
        'http://[0:0:0:0:0:0:0:1]/',
        'http://[::0:1]/',
        'http://[0:0::1]/',
        'http://[::ffff:a00:1]/',
        'http://[::ffff:c0a8:1]/',
        'http://[::ffff:a9fe:1]/',
        'http://[::ffff:169.254.169.254]/latest/meta-data'
    ];

    for (const url of bypassUrls) {
        const actual = isPublicHttpUrl(url);
        assertEqual(actual, false, `advisory bypass vector not blocked: ${url}`);
        console.log(`✅ advisory bypass blocked: ${url}`);
    }

    const publicUrls = [
        'http://[2001:4860:4860::8888]/',
        'https://[2606:4700:4700::1111]/',
        'https://example.com/'
    ];
    for (const url of publicUrls) {
        const actual = isPublicHttpUrl(url);
        assertEqual(actual, true, `public control URL wrongly blocked: ${url}`);
        console.log(`✅ public control allowed: ${url}`);
    }
}

// nip.io resolves *.nip.io to the embedded IP — exercises the real DNS path.
// May fail when the system DNS is behind a proxy like Clash fake IP mode.
async function runDnsResolvedCases(): Promise<void> {
    let rejected = false;
    try {
        await assertPublicHttpUrlResolved('https://127.0.0.1.nip.io/');
    } catch {
        rejected = true;
    }
    assertEqual(rejected, true, 'DNS-resolved private target not blocked: 127.0.0.1.nip.io');
    console.log('✅ DNS-resolved private target blocked: 127.0.0.1.nip.io');

    try {
        await assertPublicHttpUrlResolved('https://8.8.8.8.nip.io/');
        console.log('✅ DNS-resolved public target allowed: 8.8.8.8.nip.io');
    } catch {
        console.log('⚠️  Skipped public DNS test — DNS may be behind a proxy (e.g. Clash fake IP mode)');
    }
}

async function runTrustProxyDnsCases(): Promise<void> {
    const { config } = await import('../config.js');
    const previous = config.trustProxyDns;
    config.trustProxyDns = true;

    try {
        // With TRUST_PROXY_DNS=true, DNS-resolved private IPs should be allowed
        // (e.g. Clash fake IP in 198.18.0.0/15 benchmarking range)
        await assertPublicHttpUrlResolved('https://127.0.0.1.nip.io/');
        console.log('✅ TRUST_PROXY_DNS: DNS-safety bypass allows private-resolving hostname');

        // Literal private IPs in the URL should still be blocked
        let blocked = false;
        try {
            await assertPublicHttpUrlResolved('https://127.0.0.1/');
        } catch {
            blocked = true;
        }
        assertEqual(blocked, true, 'TRUST_PROXY_DNS: literal private IP was NOT blocked');
        console.log('✅ TRUST_PROXY_DNS: literal private IP still blocked');
    } finally {
        config.trustProxyDns = previous;
    }
}

async function main(): Promise<void> {
    runHostCases();
    runUrlCases();
    runAdvisoryBypassCases();
    await runDnsResolvedCases();
    await runTrustProxyDnsCases();
    console.log('\nURL safety tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
