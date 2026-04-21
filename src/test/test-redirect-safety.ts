import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import {
    __setAxiosRequestForTests,
    requestWithSafeRedirects
} from '../utils/httpRequest.js';

type CannedResponse = {
    status: number;
    location?: string;
    data?: unknown;
    headers?: Record<string, string>;
};

function makeResponse(config: AxiosRequestConfig, canned: CannedResponse): AxiosResponse {
    const headers: Record<string, string> = { ...(canned.headers || {}) };
    if (canned.location) {
        headers.location = canned.location;
    }
    return {
        status: canned.status,
        statusText: '',
        headers,
        data: canned.data ?? '',
        config,
        request: { res: {} }
    } as AxiosResponse;
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
    // Literal private target on redirect — validator must reject before axios fires.
    __setAxiosRequestForTests(async (config) => {
        if (config.url === 'http://8.8.8.8/') {
            return makeResponse(config, { status: 302, location: 'http://127.0.0.1/admin' });
        }
        throw new Error(`unexpected URL: ${config.url}`);
    });
    await assertRejects(
        () => requestWithSafeRedirects('GET', 'http://8.8.8.8/', {}),
        /private or local network/,
        'redirect to literal private IP'
    );
    console.log('✅ redirect to literal private IPv4 is rejected');

    // Bracketed IPv6 loopback via redirect.
    __setAxiosRequestForTests(async (config) => {
        if (config.url === 'http://8.8.8.8/') {
            return makeResponse(config, { status: 301, location: 'http://[::1]:8080/secret' });
        }
        throw new Error(`unexpected URL: ${config.url}`);
    });
    await assertRejects(
        () => requestWithSafeRedirects('GET', 'http://8.8.8.8/', {}),
        /private or local network/,
        'redirect to bracketed IPv6 loopback'
    );
    console.log('✅ redirect to [::1] (bracketed IPv6 loopback) is rejected');

    // AWS IMDS via redirect.
    __setAxiosRequestForTests(async (config) => {
        if (config.url === 'http://8.8.8.8/') {
            return makeResponse(config, { status: 307, location: 'http://169.254.169.254/latest/meta-data/' });
        }
        throw new Error(`unexpected URL: ${config.url}`);
    });
    await assertRejects(
        () => requestWithSafeRedirects('GET', 'http://8.8.8.8/', {}),
        /private or local network/,
        'redirect to IMDS'
    );
    console.log('✅ redirect to 169.254.169.254 (IMDS) is rejected');

    // DNS-resolved private target on redirect — exercises the async path that
    // proxy-mode specifically needs (request-filtering-agent isn't in the chain
    // when USE_PROXY=true, so the sync beforeRedirect hook alone isn't enough).
    __setAxiosRequestForTests(async (config) => {
        if (config.url === 'http://8.8.8.8/') {
            return makeResponse(config, { status: 302, location: 'http://127.0.0.1.nip.io/admin' });
        }
        throw new Error(`unexpected URL: ${config.url}`);
    });
    await assertRejects(
        () => requestWithSafeRedirects('GET', 'http://8.8.8.8/', {}),
        /private or local network/,
        'redirect to DNS-resolved private host'
    );
    console.log('✅ redirect to hostname that DNS-resolves to 127.0.0.1 is rejected');

    // Public-to-public redirect: helper should follow cleanly.
    __setAxiosRequestForTests(async (config) => {
        if (config.url === 'http://8.8.8.8/') {
            return makeResponse(config, { status: 302, location: 'http://1.1.1.1/' });
        }
        if (config.url === 'http://1.1.1.1/') {
            return makeResponse(config, { status: 200, data: 'ok' });
        }
        throw new Error(`unexpected URL: ${config.url}`);
    });
    const ok = await requestWithSafeRedirects('GET', 'http://8.8.8.8/', {});
    if (ok.status !== 200 || ok.data !== 'ok') {
        throw new Error(`public redirect: expected status=200 data=ok, got status=${ok.status} data=${ok.data}`);
    }
    if (ok.request?.res?.responseUrl !== 'http://1.1.1.1/') {
        throw new Error(`public redirect: expected responseUrl=http://1.1.1.1/, got ${ok.request?.res?.responseUrl}`);
    }
    console.log('✅ public-to-public redirect is followed and responseUrl tracks final hop');

    // maxRedirects cap.
    __setAxiosRequestForTests(async (config) => makeResponse(config, { status: 302, location: 'http://1.1.1.1/' }));
    await assertRejects(
        () => requestWithSafeRedirects('GET', 'http://8.8.8.8/', { maxRedirects: 2 }),
        /Too many redirects/,
        'maxRedirects cap'
    );
    console.log('✅ redirect chain exceeding maxRedirects is rejected');

    // Relative Location header resolves against current URL.
    __setAxiosRequestForTests(async (config) => {
        if (config.url === 'http://8.8.8.8/a') {
            return makeResponse(config, { status: 302, location: '/b' });
        }
        if (config.url === 'http://8.8.8.8/b') {
            return makeResponse(config, { status: 200, data: 'relative-ok' });
        }
        throw new Error(`unexpected URL: ${config.url}`);
    });
    const rel = await requestWithSafeRedirects('GET', 'http://8.8.8.8/a', {});
    if (rel.data !== 'relative-ok') {
        throw new Error(`relative redirect: expected data=relative-ok, got ${rel.data}`);
    }
    console.log('✅ relative Location header resolves against current URL');

    __setAxiosRequestForTests();
    console.log('\nRedirect safety tests passed.');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
