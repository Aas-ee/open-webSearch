import {
    __getBrowserSubresourceCacheEntryForTests,
    __resetBrowserSubresourceCacheForTests,
    classifyBrowserSubresourceUrl,
    fetchPageHtmlWithBrowser,
    getBrowserCookieHeader
} from '../utils/browserCookies.js';

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
        () => getBrowserCookieHeader('http://127.0.0.1.nip.io/admin'),
        /private or local network/,
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
        () => fetchPageHtmlWithBrowser('http://127.0.0.1.nip.io/admin'),
        /private or local network/,
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
        () => classifyBrowserSubresourceUrl('http://127.0.0.1.nip.io/img.png'),
        /private or local network/,
        'subresource DNS-resolved private'
    );
    console.log('✅ subresource guard rejects DNS-resolved private (first call)');

    const negativeEntry = __getBrowserSubresourceCacheEntryForTests('127.0.0.1.nip.io');
    if (!negativeEntry || negativeEntry.allowed !== false) {
        throw new Error(`expected cached negative entry for 127.0.0.1.nip.io, got ${JSON.stringify(negativeEntry)}`);
    }
    console.log('✅ subresource cache stores negative classification');

    await assertRejects(
        () => classifyBrowserSubresourceUrl('http://127.0.0.1.nip.io/img2.png'),
        /private or local network/,
        'subresource DNS-resolved private (second call, cached)'
    );
    console.log('✅ subresource guard rejects repeated DNS-resolved private (cache hit)');

    await classifyBrowserSubresourceUrl('http://8.8.8.8.nip.io/cdn/asset.css');
    const positiveEntry = __getBrowserSubresourceCacheEntryForTests('8.8.8.8.nip.io');
    if (!positiveEntry || positiveEntry.allowed !== true) {
        throw new Error(`expected cached positive entry for 8.8.8.8.nip.io, got ${JSON.stringify(positiveEntry)}`);
    }
    console.log('✅ subresource guard allows public DNS-resolved host and caches positive classification');

    // Second call must succeed and stay cached.
    await classifyBrowserSubresourceUrl('http://8.8.8.8.nip.io/cdn/other.js');
    console.log('✅ subresource guard allows repeated public host (cache hit)');

    console.log('\nBrowser path guard tests passed.');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
