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
    'tavily'
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
        case 'tavily':
            return 'tavily';
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
