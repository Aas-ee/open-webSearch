import { SearchResult } from '../../types.js';
import { config } from '../../config.js';
import { searchBing } from '../bing/index.js';
import { searchDuckDuckGo } from '../duckduckgo/index.js';
import { searchBrave } from '../brave/brave.js';

export async function searchLinuxDo(query: string, limit: number): Promise<SearchResult[]> {
    console.error(`🔍 Searching linux.do with "${query}" using ${config.defaultSearchEngine} engine`);

    const siteQuery = `site:linux.do ${query}`;
    let results: SearchResult[] = [];

    try {
        if (config.defaultSearchEngine === 'duckduckgo') {
            results = await searchDuckDuckGo(siteQuery, limit);
        } else if (config.defaultSearchEngine === 'bing') {
            results = await searchBing(siteQuery, limit);
        } else {
            results = await searchBrave(siteQuery, limit);
        }

        if (results.length === 0 && config.defaultSearchEngine !== 'brave') {
            console.error('🔄 No results from configured engine, falling back to Brave...');
            results = await searchBrave(siteQuery, limit);
        }

        const filteredResults = results.filter((result) => {
            try {
                const url = new URL(result.url);
                return url.hostname === 'linux.do' || url.hostname.endsWith('.linux.do');
            } catch {
                return false;
            }
        });

        filteredResults.forEach((result) => {
            result.source = 'linux.do';
        });

        return filteredResults.slice(0, limit);
    } catch (error: any) {
        console.error(`❌ Linux.do search failed using ${config.defaultSearchEngine}:`, error.message || error);
        return [];
    }
}
