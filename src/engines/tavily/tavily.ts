import { tavily } from '@tavily/core';
import { SearchResult } from '../../types.js';
import { config } from '../../config.js';

export async function searchTavily(query: string, limit: number): Promise<SearchResult[]> {
    const apiKey = config.tavilyApiKey;
    if (!apiKey) {
        throw new Error('TAVILY_API_KEY is not configured');
    }

    const client = tavily({ apiKey });
    const response = await client.search(query, {
        maxResults: Math.min(limit, 20),
        searchDepth: 'basic',
        topic: 'general',
    });

    return response.results.map((result) => ({
        title: result.title || '',
        url: result.url,
        description: result.content || '',
        source: new URL(result.url).hostname,
        engine: 'tavily',
    }));
}
