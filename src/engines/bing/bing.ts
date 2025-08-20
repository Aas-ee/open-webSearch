import axios from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';

/**
 * Fetches a cookie from a GitHub Gist formatted as JSON.
 * @param gistUrl The raw URL of the GitHub Gist.
 * @returns The cookie string from the Gist.
 */
async function getCookieFromGist(gistUrl: string): Promise<string> {
    try {
        const response = await axios.get(gistUrl);
        const { cookie, timestamp } = response.data;

        if (!cookie) {
            throw new Error('"cookie" property not found in the Gist JSON.');
        }

        // Log when the cookies were last updated
        if (timestamp) {
            const cookieDate = new Date(timestamp);
            const ageInHours = Math.round((Date.now() - cookieDate.getTime()) / (1000 * 60 * 60));
            console.log(`Using Bing cookies from ${cookieDate.toISOString()} (${ageInHours} hours ago)`);

            // Warn if cookies are older than 48 hours
            if (ageInHours > 48) {
                console.warn(`Warning: Bing cookies are ${ageInHours} hours old. Consider updating them.`);
            }
        }

        return cookie;
    } catch (error) {
        console.error('Error fetching or parsing cookie from Gist:', error);
        throw new Error('Could not retrieve a valid cookie from GitHub Gist.');
    }
}

export async function searchBing(query: string, limit: number): Promise<SearchResult[]> {
    // Default Gist URL - should be updated to your own Gist after setting up the workflow
    const cookieGistUrl = 'https://gist.githubusercontent.com/Aas-ee/dfaebdeb82052a17036e071b463e10f0/raw/6ec7c1e263568100c1cae4576b2d94e50b2f3218/bing_cookies.json';

    let cookie: string;
    try {
        cookie = await getCookieFromGist(cookieGistUrl);
    } catch (error) {
        console.error('Failed to retrieve Bing cookies, search may not work properly:', error);
        // Provide a minimal cookie set as fallback (may not work well)
        cookie = 'SRCHHPGUSR=SRCHLANG=en; _EDGE_S=ui=en; _EDGE_V=1';
    }

    let allResults: SearchResult[] = [];
    let pn = 0;

    while (allResults.length < limit) {
        const response = await axios.get('https://www.bing.com/search', {
            params: {
                q: query,
                first: 1 + pn * 10
            },
            headers: {
                "authority": "www.bing.com",
                "ect": "3g",
                "pragma": "no-cache",
                "sec-ch-ua-arch": "\"x86\"",
                "sec-ch-ua-bitness": "\"64\"",
                "sec-ch-ua-full-version": "\"112.0.5615.50\"",
                "sec-ch-ua-full-version-list": "\"Chromium\";v=\"112.0.5615.50\", \"Google Chrome\";v=\"112.0.5615.50\", \"Not:A-Brand\";v=\"99.0.0.0\"",
                "sec-ch-ua-model": "\"\"",
                "sec-ch-ua-platform-version": "\"15.0.0\"",
                "sec-fetch-user": "?1",
                "upgrade-insecure-requests": "1",
                "Cookie": cookie,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36",
                "Accept": "*/*",
                "Host": "cn.bing.com",
                "Connection": "keep-alive"
            }
        });

        const $ = cheerio.load(response.data);
        const results: SearchResult[] = [];

        $('#b_content').children()
            .find('#b_results').children()
            .each((i, element) => {
                const titleElement = $(element).find('h2');
                const linkElement = $(element).find('a');
                const snippetElement = $(element).find('p').first();

                if (titleElement.length && linkElement.length) {
                    const url = linkElement.attr('href');
                    if (url && url.startsWith('http')) {

                        const sourceElement = $(element).find('.b_tpcn');
                        results.push({
                            title: titleElement.text(),
                            url: url,
                            description: snippetElement.text().trim() || '',
                            source: sourceElement.text().trim() || '',
                            engine: 'bing'
                        });
                    }
                }
            });

        allResults = allResults.concat(results);

        if (results.length === 0) {
            console.log('⚠️ No more results, ending early....');
            break;
        }

        pn += 1;
    }

    return allResults.slice(0, limit); // Truncate to a maximum of 'limit' results
}
