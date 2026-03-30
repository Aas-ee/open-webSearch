import axios from 'axios';
import * as cheerio from 'cheerio';
import {SearchResult} from "../../types.js";
import {buildAxiosRequestOptions} from "../../utils/httpRequest.js";


/**
 * Search DuckDuckGo and return results
 * @param query Search query
 * @param limit Maximum number of results
 * @returns Array of search results
 */
export async function searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
  // Try using the preloaded URL method
  try {
    const results = await searchDuckDuckGoPreloadUrl(query, limit);
    if (results.length > 0) {
      return results;
    }
  } catch (error) {
    console.warn('预加载URL方法失败，尝试HTML方法:', error);
  }

  return await searchDuckDuckGoHtml(query, limit);
  }

  /**
  * Extract preloaded d.js URL from DuckDuckGo search page and use it directly
  */
  async function searchDuckDuckGoPreloadUrl(query: string, maxResults = 10): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    let offset = 0;

    try {
      // Configure request options
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

      const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&t=h_&ia=web`;
      const response = await axios.get(searchUrl, requestOptions);

      let basePreloadUrl = '';

      // Method 1: Use cheerio to find preload links
      const $ = cheerio.load(response.data);
      $('link[rel="preload"]').each((_, el) => {
        const href = $(el).attr('href');
        if (href && href.includes('links.duckduckgo.com/d.js')) {
          basePreloadUrl = href;
          return false; // 停止循环
        }
      });

      // Method 2: If preload link not found, try to get from script tag
      if (!basePreloadUrl) {
        $('#deep_preload_script').each((_, el) => {
          const src = $(el).attr('src');
          if (src && src.includes('links.duckduckgo.com/d.js')) {
            basePreloadUrl = src;
            return false;
          }
        });
      }

      // Method 3: Use regex to extract from entire HTML
      if (!basePreloadUrl) {
        const urlMatch = response.data.match(/https:\/\/links\.duckduckgo\.com\/d\.js\?[^"']+/i);
        if (urlMatch) {
          basePreloadUrl = urlMatch[0];
        }
      }

      if (!basePreloadUrl) {
        console.warn('无法找到预加载的d.js URL');
        return [];
      }

      // Create URL object to easily modify parameters
      const preloadUrlObj = new URL(basePreloadUrl);

      // Loop to get results from all pages until maxResults is satisfied or no more results
      let hasMoreResults = true;

      while (results.length < maxResults && hasMoreResults) {
        // Update s parameter (offset)
        preloadUrlObj.searchParams.set('s', offset.toString());

        // Get current page results
        const currentPageUrl = preloadUrlObj.toString();

        // Request search results using current page URL
        const dataResponse = await axios.get(currentPageUrl, {
          ...requestOptions,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36",
            "Connection": "keep-alive",
            "Accept": "*/*",
            "Accept-Encoding": "gzip, deflate, br",
            "sec-ch-ua": "\"Chromium\";v=\"112\", \"Google Chrome\";v=\"112\", \"Not:A-Brand\";v=\"99\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"Windows\"",
            "sec-fetch-site": "same-site",
            "sec-fetch-mode": "no-cors",
            "sec-fetch-dest": "script",
            "referer": "https://duckduckgo.com/",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
          }
        });

        // Extract JSON data from JSONP response
        const jsonpMatch = dataResponse.data.match(/DDG\.pageLayout\.load\('d',\s*(\[.*?\])\s*\);/s);

        if (jsonpMatch && jsonpMatch[1]) {
          try {
            const jsonData = JSON.parse(jsonpMatch[1]);

            // If no results, means no more data
            if (jsonData.length === 0) {
              hasMoreResults = false;
              break;
            }

            // Calculate next page offset (current offset + current page results)
            let validResultsInCurrentPage = 0;

            // Process search results
            jsonData.forEach((item: any) => {
              // Exclude navigation items
              if (item.n) return;

              validResultsInCurrentPage++;

              // If results already meet requirements, don't add more
              if (results.length >= maxResults) return;

              results.push({
                title: item.t || '',
                url: item.u || '',
                description: item.a || '',
                source: item.i || item.sn || '',
                engine: 'duckduckgo'
              });
            });

            // If current page has no valid results, assume there are no more results
            if (validResultsInCurrentPage === 0) {
              hasMoreResults = false;
              break;
            }

            // Update offset, prepare to request next page
            offset += validResultsInCurrentPage;

          } catch (error) {
            console.warn('解析JSONP数据失败:', error);
            hasMoreResults = false;
          }
        } else {
          // If unable to extract data from response, assume no more results
          hasMoreResults = false;
        }
      }

      return results.slice(0, maxResults);
    } catch (error) {
      console.error('DuckDuckGo预加载URL搜索失败:', error);
      return [];
    }
  }

  async function searchDuckDuckGoHtml(query: string, maxResults = 10): Promise<SearchResult[]> {
  const requestUrl = 'https://html.duckduckgo.com/html/';
  const results: SearchResult[] = [];
  let offset = 0;

    // Configure request options
    const requestOptions = buildAxiosRequestOptions({
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Apifox/1.0.0 (https://apifox.com)',
      'Accept': '*/*',
      'Host': 'html.duckduckgo.com',
      'Connection': 'keep-alive'
    },
  });

  try {
    let response = await axios.post(
      requestUrl,
      new URLSearchParams({ q: query }).toString(),
      requestOptions
    );

    let $ = cheerio.load(response.data);
    let items = $('div.result');

    if (items.length === 0) {
      return results;
    }

    items.each((_, el) => {
      if (results.length >= maxResults) return false;

      const titleEl = $(el).find('a.result__a');
      const snippetEl = $(el).find('.result__snippet');
      const title = titleEl.text().trim();
      const url = titleEl.attr('href') || '';
      const description = snippetEl.text().trim();
      const sourceEl = $(el).find('.result__url');
      const source = sourceEl.text().trim();

      if (title && url && !$(el).hasClass('result--ad')) {
        results.push({
          title,
          url,
          description,
          source,
          engine: 'duckduckgo'
        });
      }
    });

    while (results.length < maxResults && items.length > 0) {
      offset += items.length;

      response = await axios.post(
        requestUrl,
        new URLSearchParams({
          q: query,
          s: offset.toString(),
          dc: offset.toString(),
          v: 'l',
          o: 'json',
          api: 'd.js'
        }).toString(),
        requestOptions
      );

      $ = cheerio.load(response.data);
      items = $('div.result');

      items.each((_, el) => {
        if (results.length >= maxResults) return false;

        const titleEl = $(el).find('a.result__a');
        const snippetEl = $(el).find('.result__snippet');
        const title = titleEl.text().trim();
        const url = titleEl.attr('href') || '';
        const description = snippetEl.text().trim();
        const sourceEl = $(el).find('.result__url');
        const source = sourceEl.text().trim();

        if (title && url && !$(el).hasClass('result--ad')) {
          results.push({
            title,
            url,
            description,
            source,
            engine: 'duckduckgo'
          });
        }
      });
    }

    return results.slice(0, maxResults);
  } catch (error) {
    console.error('DuckDuckGo HTML search failed:', error);
    return [];
  }
}
