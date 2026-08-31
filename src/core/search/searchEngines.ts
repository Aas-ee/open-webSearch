export const SUPPORTED_SEARCH_ENGINES = [
    'baidu',
    'bing',
    'linuxdo',
    'csdn',
    'duckduckgo',
    'exa',
    'brave',
    'juejin',
    'startpage',
    'sogou',
    'hackernews',
    'chinanews'
] as const;

export type SupportedSearchEngine = typeof SUPPORTED_SEARCH_ENGINES[number];

export function normalizeEngineName(engine: string): string {
    const cleaned = engine.trim().toLowerCase();
    const compact = cleaned.replace(/[\s._-]+/g, '');

    switch (compact) {
        case 'baidu':
            return 'baidu';
        case 'bing':
            return 'bing';
        case 'linuxdo':
            return 'linuxdo';
        case 'csdn':
            return 'csdn';
        case 'duckduckgo':
            return 'duckduckgo';
        case 'exa':
            return 'exa';
        case 'brave':
            return 'brave';
        case 'juejin':
            return 'juejin';
        case 'startpage':
            return 'startpage';
        case 'sogou':
        case 'sougou':
        case '搜狗':
            return 'sogou';
        case 'hackernews':
        case 'hn':
            return 'hackernews';
        case 'chinanews':
        case '中新网':
            return 'chinanews';
        default:
            return cleaned;
    }
}

export function distributeLimit(totalLimit: number, engineCount: number): number[] {
    const base = Math.floor(totalLimit / engineCount);
    const remainder = totalLimit % engineCount;

    return Array.from({ length: engineCount }, (_, index) =>
        base + (index < remainder ? 1 : 0)
    );
}

export type SearchAggregationMode = 'fast' | 'balanced' | 'deep';

export type SearchRankingMode = 'engine-order' | 'rrf';

export function resolvePerEngineLimits(
    totalLimit: number,
    engineCount: number,
    aggregationMode: SearchAggregationMode = 'fast',
    perEngineLimit?: number
): number[] {
    if (engineCount <= 0) {
        return [];
    }

    if (perEngineLimit !== undefined) {
        return Array.from({ length: engineCount }, () => perEngineLimit);
    }

    if (aggregationMode === 'deep') {
        return Array.from({ length: engineCount }, () => totalLimit);
    }

    if (aggregationMode === 'balanced') {
        const balancedLimit = Math.min(50, Math.max(1, Math.ceil(totalLimit / engineCount) + 2));
        return Array.from({ length: engineCount }, () => balancedLimit);
    }

    return distributeLimit(totalLimit, engineCount);
}

export function resolveRequestedEngines(
    requestedEngines: string[],
    allowedSearchEngines: string[],
    defaultSearchEngine: string
): string[] {
    if (allowedSearchEngines.length === 0) {
        return requestedEngines;
    }

    const filteredEngines = requestedEngines.filter((engine) => allowedSearchEngines.includes(engine));
    return filteredEngines.length > 0 ? filteredEngines : [defaultSearchEngine];
}
