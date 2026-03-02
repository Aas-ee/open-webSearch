import axios from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import {getProxyUrl, config} from "../../config.js";
import {HttpsProxyAgent} from "https-proxy-agent";

export async function searchBrave(query: string, limit: number): Promise<SearchResult[]> {
    let allResults: SearchResult[] = [];
    let pn = 0;
    // use the proxy from environment variables
    const effectiveProxyUrl = getProxyUrl();

    // Configure request options
    const requestOptions: any = {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36",
            "Connection": "keep-alive",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            "Accept-Encoding": "gzip, deflate, br",
            "sec-ch-ua": "\"Chromium\";v=\"112\", \"Google Chrome\";v=\"112\", \"Not:A-Brand\";v=\"99\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"Windows\"",
            "upgrade-insecure-requests": "1",
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "navigate",
            "sec-fetch-user": "?1",
            "sec-fetch-dest": "document",
            "referer": "https://duckduckgo.com/",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
        }
    };

    // If a proxy URL is provided, use it
    if (effectiveProxyUrl) {
        const proxyAgent = new HttpsProxyAgent(effectiveProxyUrl);
        requestOptions.httpAgent = proxyAgent;
        requestOptions.httpsAgent = proxyAgent;
    }

    const encodedQuery = encodeURIComponent(query);
    while (allResults.length < limit) {
        const response = await axios.get(`https://search.brave.com/search?q=${encodedQuery}&source=web&offset=${pn}`, { ...requestOptions, timeout: config.requestTimeout })

        const $ = cheerio.load(response.data);
        const results: SearchResult[] = [];


        // Select the main container for all search results
        const resultsContainer = $('#results');

        // Find each result snippet within the container
        resultsContainer.find('.snippet').each((index, element) => {
            const resultElement = $(element);

            // Extract the title
            const titleElement = resultElement.find('.title');
            const title = titleElement.text().trim();

            // Extract the URL from the main link
            const linkElement = resultElement.find('a.heading-serpresult');
            const url = linkElement.attr('href');

            // Extract the description/snippet
            const snippetElement = resultElement.find('.snippet-description');
            const description = snippetElement.text().trim() || '';

            // Extract the source/sitename
            const sourceElement = resultElement.find('.sitename');
            const source = sourceElement.text().trim() || '';

            // Ensure that we have a valid title and URL before adding
            if (title && url) {
                results.push({
                    title: title,
                    url: url,
                    description: description,
                    source: source,
                    engine: 'bing'
                });
            }
        });


        allResults = allResults.concat(results);

        if (results.length === 0) {
            console.error('⚠️ No more results, ending early....');
            break;
        }

        pn += 1;
    }

    return allResults.slice(0, limit); // 截取最多 limit 个
}
