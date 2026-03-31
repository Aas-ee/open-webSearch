import axios from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import {buildAxiosRequestOptions} from "../../utils/httpRequest.js";

export async function searchBrave(query: string, limit: number): Promise<SearchResult[]> {
    let allResults: SearchResult[] = [];
    let pn = 0;
    const requestOptions = buildAxiosRequestOptions({
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
    });

    const encodedQuery = encodeURIComponent(query);
    while (allResults.length < limit) {
        const response = await axios.get(`https://search.brave.com/search?q=${encodedQuery}&source=web&offset=${pn}`, requestOptions)

        const $ = cheerio.load(response.data);
        const results: SearchResult[] = [];


        // Brave now uses SvelteKit SSR. The page structure is:
        // #results > .snippet.svelte-* (top-level result card)
        //   └── .result-content
        //        ├── > a (main link with href)
        //        │   ├── .site-name-wrapper (source)
        //        │   └── .search-snippet-title (title)
        //        └── .generic-snippet (description)
        $('#results .snippet').each((index, element) => {
            const resultElement = $(element);
            const content = resultElement.find('.result-content').first();
            if (content.length === 0) return;

            // The first <a> inside .result-content is the main link
            const mainLink = content.find('> a').first();
            const url = mainLink.attr('href');

            // Title is inside .search-snippet-title
            const title = mainLink.find('.search-snippet-title').text().trim();

            // Description is in .generic-snippet
            const description = content.find('.generic-snippet').text().trim() || '';

            // Source/site name is in .site-name-wrapper
            const source = mainLink.find('.site-name-wrapper').first().text().trim() || '';

            // Ensure that we have a valid title and URL before adding
            if (title && url) {
                results.push({
                    title: title,
                    url: url,
                    description: description,
                    source: source,
                    engine: 'brave'
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
