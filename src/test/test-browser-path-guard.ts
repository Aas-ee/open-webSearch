import {
    __getBrowserSubresourceClassificationForTests,
    __resetBrowserSubresourceCacheForTests,
    classifyBrowserSubresourceUrl,
    fetchPageHtmlWithBrowser,
    getBrowserCookieHeader
} from '../utils/browserCookies.js';
import { __setDnsLookupForTests } from '../utils/urlSafety.js';

// 确定性 DNS 注入口：将测试主机名解析到预定地址，避免依赖外部 nip.io 服务。
function installTestDnsLookup(): void {
    __setDnsLookupForTests(async (hostname) => {
        if (hostname === 'private-dns.example') {
            return [{ address: '127.0.0.1' }];
        }
        if (hostname === 'public-dns.example') {
            return [{ address: '93.184.216.34' }];
        }
        throw new Error(`unexpected hostname: ${hostname}`);
    });
}

async function assertRejects(
    fn: () => Promise<unknown>,
    pattern: RegExp,
    label: string
): Promise<void> {
    try {
        await fn();
    } catch (err: any) {
        const message = err?.message ?? String(err);
        if (!pattern.test(message)) {
            throw new Error(`${label}: rejected with unexpected message "${message}", expected ${pattern}`);
        }
        return;
    }
    throw new Error(`${label}: expected rejection, got success`);
}

async function run(): Promise<void> {
    installTestDnsLookup();

    // getBrowserCookieHeader must reject before loading Playwright.
    await assertRejects(
        () => getBrowserCookieHeader('http://127.0.0.1/admin'),
        /private or local network/,
        'getBrowserCookieHeader with literal private IPv4'
    );
    console.log('✅ getBrowserCookieHeader rejects literal private IPv4 pre-navigation');

    await assertRejects(
        () => getBrowserCookieHeader('http://[::1]/admin'),
        /private or local network/,
        'getBrowserCookieHeader with bracketed IPv6 loopback'
    );
    console.log('✅ getBrowserCookieHeader rejects [::1] pre-navigation');

    await assertRejects(
        () => getBrowserCookieHeader('http://169.254.169.254/latest/meta-data/'),
        /private or local network/,
        'getBrowserCookieHeader with IMDS'
    );
    console.log('✅ getBrowserCookieHeader rejects IMDS pre-navigation');

    await assertRejects(
        () => getBrowserCookieHeader('http://private-dns.example/admin'),
        /resolves to private IP/,
        'getBrowserCookieHeader with DNS-resolved private'
    );
    console.log('✅ getBrowserCookieHeader rejects DNS-resolved private pre-navigation');

    // fetchPageHtmlWithBrowser: same coverage.
    await assertRejects(
        () => fetchPageHtmlWithBrowser('http://127.0.0.1/admin'),
        /private or local network/,
        'fetchPageHtmlWithBrowser with literal private IPv4'
    );
    console.log('✅ fetchPageHtmlWithBrowser rejects literal private IPv4 pre-navigation');

    await assertRejects(
        () => fetchPageHtmlWithBrowser('http://[::ffff:7f00:1]/admin'),
        /private or local network/,
        'fetchPageHtmlWithBrowser with IPv4-mapped IPv6 loopback'
    );
    console.log('✅ fetchPageHtmlWithBrowser rejects [::ffff:7f00:1] pre-navigation');

    await assertRejects(
        () => fetchPageHtmlWithBrowser('http://private-dns.example/admin'),
        /resolves to private IP/,
        'fetchPageHtmlWithBrowser with DNS-resolved private'
    );
    console.log('✅ fetchPageHtmlWithBrowser rejects DNS-resolved private pre-navigation');

    // Subresource guard: literal-private blocked sync, DNS-private blocked via
    // classifyBrowserSubresourceUrl, repeat calls served from the TTL cache.
    __resetBrowserSubresourceCacheForTests();

    await assertRejects(
        () => classifyBrowserSubresourceUrl('http://127.0.0.1/internal.js'),
        /private or local network/,
        'subresource literal private IPv4'
    );
    console.log('✅ subresource guard rejects literal private IPv4');

    await assertRejects(
        () => classifyBrowserSubresourceUrl('http://[::1]/internal.js'),
        /private or local network/,
        'subresource literal IPv6 loopback'
    );
    console.log('✅ subresource guard rejects [::1]');

    await assertRejects(
        () => classifyBrowserSubresourceUrl('http://169.254.169.254/latest/meta-data/'),
        /private or local network/,
        'subresource IMDS'
    );
    console.log('✅ subresource guard rejects IMDS');

    await assertRejects(
        () => classifyBrowserSubresourceUrl('http://private-dns.example/img.png'),
        /resolves to private IP/,
        'subresource DNS-resolved private'
    );
    console.log('✅ subresource guard rejects DNS-resolved private (first call)');

    if (__getBrowserSubresourceClassificationForTests('private-dns.example') !== false) {
        throw new Error('expected cached negative classification for private-dns.example');
    }
    console.log('✅ subresource cache stores negative classification');

    await assertRejects(
        () => classifyBrowserSubresourceUrl('http://private-dns.example/img2.png'),
        /private or local network/,
        'subresource DNS-resolved private (second call, cached)'
    );
    console.log('✅ subresource guard rejects repeated DNS-resolved private (cache hit)');

    await classifyBrowserSubresourceUrl('http://public-dns.example/cdn/asset.css');
    if (__getBrowserSubresourceClassificationForTests('public-dns.example') !== true) {
        throw new Error('expected cached positive classification for public-dns.example');
    }
    console.log('✅ subresource guard allows public DNS-resolved host and caches positive classification');

    // Second call must succeed and stay cached.
    await classifyBrowserSubresourceUrl('http://public-dns.example/cdn/other.js');
    console.log('✅ subresource guard allows repeated public host (cache hit)');

    // 恢复默认 DNS 解析，避免影响同进程内后续测试。
    __setDnsLookupForTests();

    console.log('\nBrowser path guard tests passed.');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
