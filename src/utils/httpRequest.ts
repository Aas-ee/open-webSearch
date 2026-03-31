import type { AxiosRequestConfig, RawAxiosRequestHeaders, ResponseType } from 'axios';
import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyUrl } from '../config.js';

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

const directHttpsAgents = new Map<boolean, https.Agent>();
const proxyAgents = new Map<string, HttpsProxyAgent<string>>();

function getDirectHttpsAgent(allowInsecureTls: boolean): https.Agent {
    const cachedAgent = directHttpsAgents.get(allowInsecureTls);
    if (cachedAgent) {
        return cachedAgent;
    }

    const agent = new https.Agent({
        rejectUnauthorized: !allowInsecureTls
    });
    directHttpsAgents.set(allowInsecureTls, agent);
    return agent;
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

    const effectiveProxyUrl = getProxyUrl();
    if (effectiveProxyUrl) {
        const proxyAgent = getProxyAgent(effectiveProxyUrl, allowInsecureTls);
        requestOptions.httpAgent = proxyAgent;
        requestOptions.httpsAgent = proxyAgent;
    } else {
        requestOptions.httpsAgent = getDirectHttpsAgent(allowInsecureTls);
    }

    return requestOptions;
}
