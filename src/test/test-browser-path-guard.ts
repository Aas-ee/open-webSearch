import { fetchPageHtmlWithBrowser, getBrowserCookieHeader } from '../utils/browserCookies.js';

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

    console.log('\nBrowser path guard tests passed.');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
