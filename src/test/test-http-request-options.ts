import https from 'node:https';
import { config } from '../config.js';
import { buildAxiosRequestOptions } from '../utils/httpRequest.js';

function assert(condition: unknown, message: string): void {
    if (!condition) {
        throw new Error(message);
    }
}

function main(): void {
    const originalUseProxy = config.useProxy;
    const originalProxyUrl = config.proxyUrl;
    const originalFakeIpCidrs = [...config.fakeIpCidrs];
    const originalFetchWebAllowInsecureTls = config.fetchWebAllowInsecureTls;

    try {
        config.useProxy = false;
        config.proxyUrl = 'http://127.0.0.1:7890';
        config.fakeIpCidrs = ['198.18.0.0/15'];
        config.fetchWebAllowInsecureTls = false;

        const defaultOptions = buildAxiosRequestOptions();
        assert(defaultOptions.proxy === false, 'proxy should always be disabled in axios config');
        assert(defaultOptions.httpsAgent instanceof https.Agent, 'direct https requests should use an https.Agent');
        assert((defaultOptions.httpsAgent as any).options.rejectUnauthorized === true, 'direct https agent should enforce TLS verification by default');
        assert(((defaultOptions.httpAgent as any).requestFilterOptions?.allowIPAddressList ?? []).includes('198.18.0.0/15'), 'direct http agent should allow configured fake-ip CIDRs');
        assert(((defaultOptions.httpsAgent as any).requestFilterOptions?.allowIPAddressList ?? []).includes('198.18.0.0/15'), 'direct https agent should allow configured fake-ip CIDRs');
        console.log('✅ default request options disable axios env proxy resolution');

        const trustedStaticHostOptions = buildAxiosRequestOptions({ trustedStaticHost: true });
        assert(trustedStaticHostOptions.proxy === false, 'trusted static host requests should still disable axios env proxy resolution');
        assert(!trustedStaticHostOptions.httpAgent, 'trusted static host direct requests should not use the filtering http agent');
        assert(!trustedStaticHostOptions.httpsAgent, 'trusted static host direct requests should not use the filtering https agent');
        assert(trustedStaticHostOptions.maxRedirects === 0, 'trusted static host requests should force redirects off');
        console.log('✅ trusted static host request options bypass DNS private-network filtering and force redirects off');

        const trustedStaticHostWithRedirects = buildAxiosRequestOptions({ trustedStaticHost: true, maxRedirects: 5 });
        assert(trustedStaticHostWithRedirects.maxRedirects === 0, 'trusted static host requests should force redirects off even when maxRedirects is provided');
        console.log('✅ trusted static host request options force redirects off');

        const insecureTrustedStaticHostOptions = buildAxiosRequestOptions({ trustedStaticHost: true, allowInsecureTls: true });
        assert(!insecureTrustedStaticHostOptions.httpAgent, 'trusted static host insecure requests should not use the filtering http agent');
        assert(insecureTrustedStaticHostOptions.httpsAgent instanceof https.Agent, 'trusted static host insecure requests should use a direct https agent');
        assert((insecureTrustedStaticHostOptions.httpsAgent as any).options.rejectUnauthorized === false, 'trusted static host insecure requests should disable TLS verification when requested');
        assert(insecureTrustedStaticHostOptions.maxRedirects === 0, 'trusted static host insecure requests should still force redirects off');
        console.log('✅ trusted static host insecure TLS option is honored without re-enabling filtering or redirects');

        const insecureOptions = buildAxiosRequestOptions({ allowInsecureTls: true });
        assert((insecureOptions.httpsAgent as any).options.rejectUnauthorized === false, 'insecure TLS option should disable certificate verification only when requested');
        console.log('✅ insecure TLS option is opt-in');

        config.useProxy = true;
        const proxiedOptions = buildAxiosRequestOptions();
        assert(proxiedOptions.proxy === false, 'proxied requests should still disable axios env proxy resolution');
        assert(proxiedOptions.httpAgent, 'proxied requests should include an http agent');
        assert(proxiedOptions.httpsAgent, 'proxied requests should include an https agent');
        assert((proxiedOptions.httpsAgent as any).connectOpts.rejectUnauthorized === true, 'proxied agent should enforce TLS verification by default');
        console.log('✅ proxied request options use the explicit proxy agent path');

        const proxiedInsecureOptions = buildAxiosRequestOptions({ allowInsecureTls: true });
        assert((proxiedInsecureOptions.httpsAgent as any).connectOpts.rejectUnauthorized === false, 'proxied insecure TLS should be opt-in');
        console.log('✅ proxied insecure TLS remains opt-in');

        console.log('\nHTTP request options tests passed.');
    } finally {
        config.useProxy = originalUseProxy;
        config.proxyUrl = originalProxyUrl;
        config.fakeIpCidrs = originalFakeIpCidrs;
        config.fetchWebAllowInsecureTls = originalFetchWebAllowInsecureTls;
    }
}

main();
