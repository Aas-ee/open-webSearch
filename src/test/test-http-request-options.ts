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
    const originalFetchWebAllowInsecureTls = config.fetchWebAllowInsecureTls;

    try {
        config.useProxy = false;
        config.proxyUrl = 'http://127.0.0.1:7890';
        config.fetchWebAllowInsecureTls = false;

        const defaultOptions = buildAxiosRequestOptions();
        assert(defaultOptions.proxy === false, 'proxy should always be disabled in axios config');
        assert(defaultOptions.httpsAgent instanceof https.Agent, 'direct https requests should use an https.Agent');
        assert((defaultOptions.httpsAgent as any).options.rejectUnauthorized === true, 'direct https agent should enforce TLS verification by default');
        console.log('✅ default request options disable axios env proxy resolution');

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
        config.fetchWebAllowInsecureTls = originalFetchWebAllowInsecureTls;
    }
}

main();
