import axios from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';

export async function searchBaidu(query: string, limit: number): Promise<SearchResult[]> {
    let allResults: SearchResult[] = [];
    let pn = 0;

    while (allResults.length < limit) {
        const response = await axios.get('https://www.baidu.com/s', buildAxiosRequestOptions({
            params: {
                wd: query,
                pn: pn.toString(),
                ie: "utf-8",
                mod: "1",
                isbd: "1",
                isid: "f7ba1776007bcf9e",
                oq: query,
                tn: "88093251_62_hao_pg",
                usm: "1",
                fenlei: "256",
                rsv_idx: "1",
                rsv_pq: "f7ba1776007bcf9e",
                rsv_t: "8179fxGiNMUh/0dXHrLsJXPlKYbkj9S5QH6rOLHY6pG6OGQ81YqzRTIGjjeMwEfiYQTSiTQIhCJj",
                bs: query,
                rsv_sid: undefined,
                _ss: "1",
                f4s: "1",
                csor: "5",
                _cr1: "30385",
            },
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        }));

        const $ = cheerio.load(response.data);
        const results: SearchResult[] = [];

        $('#content_left').children().each((i, element) => {
            const titleElement = $(element).find('h3');
            const linkElement = $(element).find('a');
            const snippetElement = $(element).find('.cos-row').first();

            if (titleElement.length && linkElement.length) {
                const url = linkElement.attr('href');
                if (url && url.startsWith('http')) {
                    const snippetElementBaidu = $(element).find('.c-font-normal.c-color-text').first();
                    const sourceElement = $(element).find('.cosc-source');
                    results.push({
                        title: titleElement.text(),
                        url: url,
                        description: snippetElementBaidu.attr('aria-label') || snippetElement.text().trim() || '',
                        source: sourceElement.text().trim() || '',
                        engine: 'baidu'
                    });
                }
            }
        });

        allResults = allResults.concat(results);

        if (results.length === 0) {
            console.error('⚠️ No more results, ending early....');
            break;
        }

        pn += 10;
    }

    return allResults.slice(0, limit); // 截取最多 limit 个
}
