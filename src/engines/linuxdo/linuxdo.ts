import {SearchResult} from '../../types.js';
import { config } from '../../config.js';
import {searchDuckDuckGo} from "../duckduckgo/index.js";
import {searchBing} from "../bing/index.js";


export async function searchLinuxDo(query: string, limit: number): Promise<SearchResult[]> {

    console.error(`🔍 Searching linux.do with "${query}" using ${config.defaultSearchEngine} engine`);

    // Create the site-specific query
    const siteQuery = `site:linux.do ${query}`;

    let results: SearchResult[] = [];

    try {
        // Use the configured search engine
        if (config.defaultSearchEngine === 'duckduckgo') {
            results = await searchDuckDuckGo(siteQuery, limit * 3);
        } else {
            // 默认使用 Bing（基于 puppeteer 浏览器）
            results = await searchBing(siteQuery, limit * 3);
        }

        // Filter results to ensure they're from linux.do
        const filteredResults = results.filter(result => {
            try {
                const url = new URL(result.url);
                return url.hostname === 'linux.do';
            } catch {
                return false;
            }
        });

        // Update source to be consistent
        filteredResults.forEach(result => {
            result.source = 'linux.do';
        });

        return filteredResults.slice(0, limit);
    } catch (error: any) {
        console.error(`❌ Linux.do search failed using ${config.defaultSearchEngine}:`, error.message || error);
        return [];
    }

}
