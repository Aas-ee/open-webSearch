import axios from 'axios';
import { SearchResult } from '../../types.js';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';

/**
 * Search You.com and return results
 * @param query Search query
 * @param limit Maximum number of results
 * @returns Array of search results
 */
export async function searchYoucom(query: string, limit: number): Promise<SearchResult[]> {
  try {
    // Configure request options
    const requestOptions = buildAxiosRequestOptions({
      trustedStaticHost: true,
      headers: {
        'User-Agent': 'youdotcom-integration/aas-ee-open-websearch',
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    // Add API key if available
    const apiKey = process.env.YDC_API_KEY;
    if (apiKey) {
      requestOptions.headers = {
        ...requestOptions.headers,
        'Authorization': `Bearer ${apiKey}`
      };
    }

    // Make search request to You.com Search API
    const searchUrl = 'https://api.you.com/v1/agents/search';
    const params = {
      query: query,
      count: Math.min(limit, 50) // You.com API supports up to 50 results
    };

    const response = await axios.get(searchUrl, {
      ...requestOptions,
      params
    });

    const results: SearchResult[] = [];

    // Parse You.com API response
    if (response.data && response.data.results && response.data.results.web) {
      const webResults = response.data.results.web;
      
      for (let i = 0; i < Math.min(webResults.length, limit); i++) {
        const item = webResults[i];
        
        if (item.url && item.title) {
          results.push({
            title: item.title || '',
            url: item.url || '',
            description: item.description || item.snippet || '',
            source: extractDomain(item.url) || '',
            engine: 'youcom'
          });
        }
      }
    }

    return results;
  } catch (error) {
    console.error('You.com search failed:', error);
    
    // Handle specific error cases
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 401) {
        console.warn('You.com API authentication failed. Check YDC_API_KEY environment variable.');
      } else if (error.response?.status === 429) {
        console.warn('You.com API rate limit exceeded. Consider using YDC_API_KEY for higher limits.');
      }
    }
    
    return [];
  }
}

/**
 * Extract domain from URL for source field
 * @param url Full URL
 * @returns Domain name or empty string
 */
function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return '';
  }
}
