import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import {
    __setAxiosRequestForTests,
    requestWithSafeRedirects
} from '../utils/httpRequest.js';

type CannedResponse = {
    status: number;
    location?: string;
    data?: unknown;
};

function makeResponse(config: AxiosRequestConfig, canned: CannedResponse): AxiosResponse {
    const headers: Record<string, string> = {};
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

// Stub axios with a fixed URL→response map. Unmatched URLs throw so test
// oversights don't silently hit the real network.
function stubAxios(responses: Record<string, CannedResponse>): void {
    __setAxiosRequestForTests(async (config) => {
        const canned = config.url ? responses[config.url] : undefined;
        if (!canned) {
            throw new Error(`unexpected URL: ${config.url}`);
        }
        return makeResponse(config, canned);
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

async function assertPrivateRedirectRejected(from: string, to: string, label: string): Promise<void> {
    stubAxios({ [from]: { status: 302, location: to } });
    await assertRejects(
        () => requestWithSafeRedirects('GET', from, {}),
        /private or local network/,
        label
    );
    console.log(`✅ ${label}`);
}

async function run(): Promise<void> {
    await assertPrivateRedirectRejected('http://8.8.8.8/', 'http://127.0.0.1/admin', 'redirect to literal private IPv4 is rejected');
    await assertPrivateRedirectRejected('http://8.8.8.8/', 'http://[::1]:8080/secret', 'redirect to [::1] (bracketed IPv6 loopback) is rejected');
    await assertPrivateRedirectRejected('http://8.8.8.8/', 'http://169.254.169.254/latest/meta-data/', 'redirect to 169.254.169.254 (IMDS) is rejected');
    // DNS-resolved private hop — exercises the async path proxy mode needs.
    await assertPrivateRedirectRejected('http://8.8.8.8/', 'http://127.0.0.1.nip.io/admin', 'redirect to hostname that DNS-resolves to 127.0.0.1 is rejected');

    // Public-to-public redirect: helper follows cleanly, responseUrl tracks final hop.
    stubAxios({
        'http://8.8.8.8/': { status: 302, location: 'http://1.1.1.1/' },
        'http://1.1.1.1/': { status: 200, data: 'ok' }
    });
    const ok = await requestWithSafeRedirects('GET', 'http://8.8.8.8/', {});
    if (ok.status !== 200 || ok.data !== 'ok') {
        throw new Error(`public redirect: expected status=200 data=ok, got status=${ok.status} data=${ok.data}`);
    }
    if (ok.request?.res?.responseUrl !== 'http://1.1.1.1/') {
        throw new Error(`public redirect: expected responseUrl=http://1.1.1.1/, got ${ok.request?.res?.responseUrl}`);
    }
    console.log('✅ public-to-public redirect is followed and responseUrl tracks final hop');

    // maxRedirects cap: every hop redirects, never resolves.
    __setAxiosRequestForTests(async (config) => makeResponse(config, { status: 302, location: 'http://1.1.1.1/' }));
    await assertRejects(
        () => requestWithSafeRedirects('GET', 'http://8.8.8.8/', { maxRedirects: 2 }),
        /Too many redirects/,
        'maxRedirects cap'
    );
    console.log('✅ redirect chain exceeding maxRedirects is rejected');

    // Relative Location header resolves against current URL.
    stubAxios({
        'http://8.8.8.8/a': { status: 302, location: '/b' },
        'http://8.8.8.8/b': { status: 200, data: 'relative-ok' }
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
