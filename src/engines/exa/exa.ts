import axios from 'axios';
import { SearchResult } from '../../types.js';
import { getProxyUrl, config } from "../../config.js";
import { HttpsProxyAgent } from "https-proxy-agent";

interface ExaResult {
    id: string;
    title: string;
    url: string;
    publishedDate?: string;
    author?: string;
}

export async function searchExa(query: string, limit: number): Promise<SearchResult[]> {
    const effectiveProxyUrl = getProxyUrl();

    // Configure request options, no changes needed here
    const requestOptions: any = {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36",
            "Connection": "keep-alive",
            "Accept": "*/*",
            "Accept-Encoding": "gzip, deflate, br",
            "sec-ch-ua": "\"Chromium\";v=\"112\", \"Google Chrome\";v=\"112\", \"Not:A-Brand\";v=\"99\"",
            "content-type": "text/plain;charset=UTF-8",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"Windows\"",
            "origin": "https://exa.ai",
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "cors",
            "sec-fetch-dest": "empty",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
        }
    };

    // The payload for the POST request
    const data = {
        "numResults": limit,
        "query": query,
        "type": "auto",
        "useAutoprompt": true,
        "domainFilterType": "include",
        "text": true,
        "density": "compact",
        "resolvedSearchType": "neural",
        "moderation": true,
        "fastMode": false,
        "rerankerType": "default"
    };

    // If a proxy URL is provided, use it
    if (effectiveProxyUrl) {
        const proxyAgent = new HttpsProxyAgent(effectiveProxyUrl);
        requestOptions.httpAgent = proxyAgent;
        requestOptions.httpsAgent = proxyAgent;
    }

    try {
        const response = await axios.post<{ results: ExaResult[] }>(
            `https://exa.ai/search/api/search-fast`,
            data,
            { ...requestOptions, timeout: config.requestTimeout }
        );

        const apiResults = response.data.results;

        if (!apiResults || apiResults.length === 0) {
            console.error('⚠️ No results returned from Exa.ai API.');
            return [];
        }

        const allResults: SearchResult[] = apiResults.map((item: ExaResult) => {
            return {
                title: item.title || 'No title',
                url: item.url,
                description: `Author: ${item.author || 'N/A'}. Published: ${item.publishedDate ? new Date(item.publishedDate).toLocaleDateString() : 'N/A'}`,
                source: new URL(item.url).hostname,
                engine: 'exa'
            };
        });

        return allResults.slice(0, limit);

    } catch (error) {
        const msg = axios.isAxiosError(error)
            ? [error.code, error.message, error.response?.status && `HTTP ${error.response.status}`].filter(Boolean).join(' - ')
            : (error instanceof Error ? error.message : String(error));
        console.error(`❌ Exa.ai search failed: ${msg}`);
        return [];
    }
}
