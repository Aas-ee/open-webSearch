import { __setDnsLookupForTests, assertPublicHttpUrlResolved, isPublicHttpUrl, isPrivateOrLocalHostname } from '../utils/urlSafety.js';

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
        { value: 'localhost.', expected: true },
        { value: 'foo.localhost.', expected: true },
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
        { value: 'http://foo.localhost./secret', expected: false },
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

// 用确定性 DNS 注入覆盖解析路径：私网应答被拦截、公网应答放行。
// 不依赖外部 nip.io，避免网络或代理（如 Clash fake-IP 模式）导致测试不稳定。
async function runDnsResolvedCases(): Promise<void> {
    __setDnsLookupForTests(async (hostname) => {
        if (hostname === 'private-dns.example') {
            return [{ address: '127.0.0.1' }];
        }
        if (hostname === 'public-dns.example') {
            return [{ address: '93.184.216.34' }];
        }
        throw new Error(`unexpected hostname: ${hostname}`);
    });

    try {
        let rejected = false;
        try {
            await assertPublicHttpUrlResolved('https://private-dns.example/');
        } catch {
            rejected = true;
        }
        assertEqual(rejected, true, 'DNS-resolved private target not blocked: private-dns.example');
        console.log('✅ DNS-resolved private target blocked: private-dns.example');

        await assertPublicHttpUrlResolved('https://public-dns.example/');
        console.log('✅ DNS-resolved public target allowed: public-dns.example');
    } finally {
        __setDnsLookupForTests();
    }
}

async function runFakeIpCidrsCases(): Promise<void> {
    const { config } = await import('../config.js');
    const previousFakeIpCidrs = [...config.fakeIpCidrs];

    try {
        config.fakeIpCidrs = ['198.18.0.0/15'];

        __setDnsLookupForTests(async (hostname) => {
            if (hostname === 'fake-ip.example') {
                return [{ address: '198.18.1.2' }];
            }
            if (hostname === 'private-ip.example') {
                return [{ address: '127.0.0.1' }];
            }
            if (hostname === 'lan-ip.example') {
                return [{ address: '192.168.1.10' }];
            }
            if (hostname === 'public-ip.example') {
                return [{ address: '8.8.8.8' }];
            }
            throw new Error(`unexpected hostname: ${hostname}`);
        });

        await assertPublicHttpUrlResolved('https://fake-ip.example/');
        console.log('✅ FAKE_IP_CIDRS: synthetic fake-ip DNS answer allowed');

        let blocked = false;
        try {
            await assertPublicHttpUrlResolved('https://private-ip.example/');
        } catch {
            blocked = true;
        }
        assertEqual(blocked, true, 'FAKE_IP_CIDRS: loopback DNS answer was NOT blocked');
        console.log('✅ FAKE_IP_CIDRS: loopback DNS answer still blocked');

        blocked = false;
        try {
            await assertPublicHttpUrlResolved('https://lan-ip.example/');
        } catch {
            blocked = true;
        }
        assertEqual(blocked, true, 'FAKE_IP_CIDRS: LAN DNS answer was NOT blocked');
        console.log('✅ FAKE_IP_CIDRS: LAN DNS answer still blocked');

        await assertPublicHttpUrlResolved('https://public-ip.example/');
        console.log('✅ FAKE_IP_CIDRS: public DNS answer still allowed');

        blocked = false;
        try {
            await assertPublicHttpUrlResolved('https://127.0.0.1/');
        } catch {
            blocked = true;
        }
        assertEqual(blocked, true, 'FAKE_IP_CIDRS: literal private IP was NOT blocked');
        console.log('✅ FAKE_IP_CIDRS: literal private IP still blocked');
    } finally {
        config.fakeIpCidrs = previousFakeIpCidrs;
        __setDnsLookupForTests();
    }
}

async function runErrorMessageCases(): Promise<void> {
    __setDnsLookupForTests(async (hostname) => {
        if (hostname === 'private-dns.example') {
            return [{ address: '192.168.1.10' }];
        }
        if (hostname === 'multi-dns.example') {
            return [
                { address: '10.0.0.5' },
                { address: '169.254.169.254' },
                { address: '93.184.216.34' }
            ];
        }
        throw new Error(`unexpected hostname: ${hostname}`);
    });

    async function expectBlockedMessage(url: string): Promise<string> {
        try {
            await assertPublicHttpUrlResolved(url);
        } catch (err) {
            return err instanceof Error ? err.message : String(err);
        }
        throw new Error(`expected ${url} to be blocked`);
    }

    function assertMessage(message: string, mustInclude: string[], mustExclude: string[], caseName: string): void {
        for (const part of mustInclude) {
            if (!message.includes(part)) {
                throw new Error(`${caseName}: message missing "${part}": ${message}`);
            }
        }
        for (const part of mustExclude) {
            if (message.includes(part)) {
                throw new Error(`${caseName}: message must not include "${part}": ${message}`);
            }
        }
    }

    try {
        let message = await expectBlockedMessage('https://192.168.1.1/admin');
        assertMessage(message, ['192.168.1.1'], ['FAKE_IP_CIDRS'], 'literal IPv4');
        console.log('✅ error message: literal IPv4 shows target without fake-ip hint');

        message = await expectBlockedMessage('http://[fd00::1]/');
        assertMessage(message, ['[fd00::1]'], ['FAKE_IP_CIDRS'], 'literal IPv6');
        console.log('✅ error message: literal IPv6 shows target without fake-ip hint');

        message = await expectBlockedMessage('https://private-dns.example/');
        assertMessage(
            message,
            ['private-dns.example', '192.168.1.10', 'FAKE_IP_CIDRS', '198.18.0.0/15'],
            ['/10'],
            'single private DNS answer'
        );
        console.log('✅ error message: private DNS answer lists hostname, blocked IP and configured-CIDR hint');

        message = await expectBlockedMessage('https://multi-dns.example/');
        assertMessage(
            message,
            ['multi-dns.example', '10.0.0.5, 169.254.169.254'],
            ['93.184.216.34', '/10'],
            'multiple DNS answers'
        );
        console.log('✅ error message: multiple DNS answers list only blocked IPs');
    } finally {
        __setDnsLookupForTests();
    }
}

async function main(): Promise<void> {
    runHostCases();
    runUrlCases();
    runAdvisoryBypassCases();
    await runDnsResolvedCases();
    await runFakeIpCidrsCases();
    await runErrorMessageCases();
    console.log('\nURL safety tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
