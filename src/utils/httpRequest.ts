import axios, { AxiosError } from 'axios';
import type { AxiosRequestConfig, AxiosResponse, RawAxiosRequestHeaders, ResponseType } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
    RequestFilteringHttpAgent,
    RequestFilteringHttpsAgent
} from 'request-filtering-agent';
import { getProxyUrl } from '../config.js';
import { assertPublicHttpUrlResolved, isPrivateOrLocalHostname } from './urlSafety.js';

type BuildAxiosRequestOptions = {
    allowInsecureTls?: boolean;
    decompress?: boolean;
    headers?: RawAxiosRequestHeaders;
    maxBodyLength?: number;
    maxContentLength?: number;
    maxRedirects?: number;
    params?: unknown;
    responseType?: ResponseType;
    timeout?: number;
    validateStatus?: AxiosRequestConfig['validateStatus'];
};

let filteringHttpAgent: RequestFilteringHttpAgent | null = null;
let secureFilteringHttpsAgent: RequestFilteringHttpsAgent | null = null;
let insecureFilteringHttpsAgent: RequestFilteringHttpsAgent | null = null;
const proxyAgents = new Map<string, HttpsProxyAgent<string>>();

function getFilteringHttpAgent(): RequestFilteringHttpAgent {
    if (!filteringHttpAgent) {
        filteringHttpAgent = new RequestFilteringHttpAgent();
    }
    return filteringHttpAgent;
}

function getFilteringHttpsAgent(allowInsecureTls: boolean): RequestFilteringHttpsAgent {
    if (allowInsecureTls) {
        if (!insecureFilteringHttpsAgent) {
            insecureFilteringHttpsAgent = new RequestFilteringHttpsAgent({ rejectUnauthorized: false });
        }
        return insecureFilteringHttpsAgent;
    }
    if (!secureFilteringHttpsAgent) {
        secureFilteringHttpsAgent = new RequestFilteringHttpsAgent({ rejectUnauthorized: true });
    }
    return secureFilteringHttpsAgent;
}

function getProxyAgent(proxyUrl: string, allowInsecureTls: boolean): HttpsProxyAgent<string> {
    const cacheKey = `${proxyUrl}::${allowInsecureTls ? 'insecure' : 'secure'}`;
    const cachedAgent = proxyAgents.get(cacheKey);
    if (cachedAgent) {
        return cachedAgent;
    }

    const agent = new HttpsProxyAgent(proxyUrl, {
        rejectUnauthorized: !allowInsecureTls
    });
    proxyAgents.set(cacheKey, agent);
    return agent;
}

export function buildAxiosRequestOptions(options: BuildAxiosRequestOptions = {}): AxiosRequestConfig {
    const {
        allowInsecureTls = false,
        decompress,
        headers,
        maxBodyLength,
        maxContentLength,
        maxRedirects,
        params,
        responseType,
        timeout,
        validateStatus
    } = options;

    const requestOptions: AxiosRequestConfig = {
        proxy: false
    };

    if (headers) {
        requestOptions.headers = headers;
    }
    if (timeout !== undefined) {
        requestOptions.timeout = timeout;
    }
    if (maxRedirects !== undefined) {
        requestOptions.maxRedirects = maxRedirects;
    }
    if (responseType !== undefined) {
        requestOptions.responseType = responseType;
    }
    if (maxContentLength !== undefined) {
        requestOptions.maxContentLength = maxContentLength;
    }
    if (maxBodyLength !== undefined) {
        requestOptions.maxBodyLength = maxBodyLength;
    }
    if (decompress !== undefined) {
        requestOptions.decompress = decompress;
    }
    if (validateStatus !== undefined) {
        requestOptions.validateStatus = validateStatus;
    }
    if (params !== undefined) {
        requestOptions.params = params;
    }

    // Sync-only hook (follow-redirects constraint) — catches literal-IP
    // private targets. Hostname-on-redirect in proxy mode still relies on
    // the initial-URL DNS check.
    requestOptions.beforeRedirect = (opts) => {
        const target = (opts.hostname ?? opts.host) as string | undefined;
        if (target && isPrivateOrLocalHostname(target)) {
            throw new Error('Redirect target points to a private or local network address');
        }
    };

    const effectiveProxyUrl = getProxyUrl();
    if (effectiveProxyUrl) {
        const proxyAgent = getProxyAgent(effectiveProxyUrl, allowInsecureTls);
        requestOptions.httpAgent = proxyAgent;
        requestOptions.httpsAgent = proxyAgent;
    } else {
        requestOptions.httpAgent = getFilteringHttpAgent();
        requestOptions.httpsAgent = getFilteringHttpsAgent(allowInsecureTls);
    }

    return requestOptions;
}

type AxiosRequestFn = (config: AxiosRequestConfig) => Promise<AxiosResponse>;

let axiosRequestImpl: AxiosRequestFn = (config) => axios.request(config);

export function __setAxiosRequestForTests(impl?: AxiosRequestFn): void {
    axiosRequestImpl = impl ?? ((config) => axios.request(config));
}

const DEFAULT_VALIDATE_STATUS = (status: number): boolean => status >= 200 && status < 300;

// Manually chase redirects so we can async-DNS-resolve each hop. follow-redirects'
// beforeRedirect hook is sync, so in proxy mode (no request-filtering-agent) a
// redirect to a hostname resolving to 127.0.0.1 would otherwise slip through.
export async function requestWithSafeRedirects(
    method: 'GET' | 'HEAD',
    initialUrl: string,
    options: AxiosRequestConfig = {},
    urlLabel: string = 'Request URL'
): Promise<AxiosResponse> {
    const maxRedirects = options.maxRedirects ?? 5;
    const callerValidateStatus = options.validateStatus ?? DEFAULT_VALIDATE_STATUS;
    let currentUrl = initialUrl;
    let hops = 0;

    while (true) {
        await assertPublicHttpUrlResolved(currentUrl, hops === 0 ? urlLabel : 'Redirect target');

        const hopConfig: AxiosRequestConfig = {
            ...options,
            method,
            url: currentUrl,
            maxRedirects: 0,
            // Accept 3xx here so we can inspect Location. Caller's validateStatus
            // is re-applied to the final non-3xx response below.
            validateStatus: (status) => status >= 200 && status < 400,
        };

        const response = await axiosRequestImpl(hopConfig);

        const isRedirect = response.status >= 300 && response.status < 400;
        const location = isRedirect ? response.headers?.location : undefined;

        if (!isRedirect || !location) {
            if (response.request?.res && !response.request.res.responseUrl) {
                response.request.res.responseUrl = currentUrl;
            }
            if (!callerValidateStatus(response.status)) {
                throw new AxiosError(
                    `Request failed with status code ${response.status}`,
                    AxiosError.ERR_BAD_RESPONSE,
                    response.config,
                    response.request,
                    response
                );
            }
            return response;
        }

        hops++;
        if (hops > maxRedirects) {
            throw new Error(`Too many redirects (max ${maxRedirects})`);
        }
        currentUrl = new URL(String(location), currentUrl).toString();
    }
}
