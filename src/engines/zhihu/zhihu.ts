import { SearchResult } from '../../types.js';
import { config } from '../../config.js';
import { searchBing } from '../bing/index.js';
import { searchDuckDuckGo } from '../duckduckgo/index.js';

export async function searchZhiHu(query: string, limit: number): Promise<SearchResult[]> {
    console.error(`🔍 Searching zhuanlan.zhihu.com with "${query}" using ${config.defaultSearchEngine} engine`);

    const siteQuery = `site:zhuanlan.zhihu.com ${query}`;
    let results: SearchResult[] = [];

    try {
        if (config.defaultSearchEngine === 'duckduckgo') {
            results = await searchDuckDuckGo(siteQuery, limit);
        } else {
            results = await searchBing(siteQuery, limit);
        }

        const filteredResults = results.filter((result) => {
            try {
                const url = new URL(result.url);
                return url.hostname === 'zhuanlan.zhihu.com';
            } catch {
                return false;
            }
        });

        filteredResults.forEach((result) => {
            result.source = 'zhuanlan.zhihu.com';
        });

        return filteredResults.slice(0, limit);
    } catch (error: any) {
        console.error(`❌ zhuanlan.zhihu.com search failed using ${config.defaultSearchEngine}:`, error.message || error);
        return [];
    }
}
