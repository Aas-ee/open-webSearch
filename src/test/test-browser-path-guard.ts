import {
    __getBrowserSubresourceClassificationForTests,
    __createCookieCollectionPageForTests,
    __installNavigationGuardForTests,
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

    await assertRejects(
        () => __installNavigationGuardForTests({}),
        /request interception is unavailable/,
        'browser page without route interception'
    );
    console.log('✅ browser navigation fails closed without route interception');

    await assertRejects(
        () => __installNavigationGuardForTests({
            route: async () => {
                throw new Error('route unsupported');
            }
        }),
        /could not be installed/,
        'browser page whose route installation fails'
    );
    console.log('✅ browser navigation fails closed when route installation fails');

    let abandonedContextClosed = 0;
    const fallbackPage = { close: async () => undefined };
    const fallbackContext = {
        newPage: async () => fallbackPage,
        clearCookies: async () => undefined
    };
    const pageHandle = await __createCookieCollectionPageForTests({
        newContext: async () => ({
            newPage: async () => {
                throw new Error('new page failed');
            },
            close: async () => {
                abandonedContextClosed += 1;
            }
        }),
        contexts: () => [fallbackContext]
    });
    if (abandonedContextClosed !== 1 || pageHandle.page !== fallbackPage) {
        throw new Error('failed dedicated browser context should close before default-context fallback');
    }
    await pageHandle.close();
    console.log('✅ failed dedicated browser context closes before fallback');

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

    // Rebind defense: a host that resolves public then private across requests
    // must be blocked on the second request (public allows are never cached).
    let rebindLookups = 0;
    __setDnsLookupForTests(async (hostname) => {
        if (hostname !== 'rebind.example') {
            throw new Error(`unexpected hostname: ${hostname}`);
        }
        rebindLookups += 1;
        return [{ address: rebindLookups === 1 ? '93.184.216.34' : '127.0.0.1' }];
    });
    await classifyBrowserSubresourceUrl('https://rebind.example/first.js');
    await assertRejects(
        () => classifyBrowserSubresourceUrl('https://rebind.example/second.js'),
        /resolves to private IP/,
        'subresource host that resolves public then private across requests'
    );
    if (rebindLookups !== 2) {
        throw new Error(`expected two DNS lookups for rebinding defense, got ${rebindLookups}`);
    }
    console.log('✅ subresource guard revalidates public hosts on subsequent requests');

    // 重新装回确定性映射，供下面的 public-host 断言使用。
    installTestDnsLookup();

    // Public hosts are never cached: each request re-resolves so a later
    // private resolution cannot be masked by an earlier allow decision.
    await classifyBrowserSubresourceUrl('http://public-dns.example/cdn/asset.css');
    if (__getBrowserSubresourceClassificationForTests('public-dns.example') !== undefined) {
        throw new Error('public subresource classifications must not be cached');
    }
    console.log('✅ subresource guard allows public DNS-resolved host without caching an allow decision');

    // Second call must resolve again rather than trusting an earlier allow.
    await classifyBrowserSubresourceUrl('http://public-dns.example/cdn/other.js');
    console.log('✅ subresource guard revalidates repeated public hosts');

    // 恢复默认 DNS 解析，避免影响同进程内后续测试。
    __setDnsLookupForTests();

    console.log('\nBrowser path guard tests passed.');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
