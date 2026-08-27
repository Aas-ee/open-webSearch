import { SearchResult } from '../types.js';
import {
    SUPPORTED_SEARCH_ENGINES,
    distributeLimit,
    normalizeEngineName,
    resolvePerEngineLimits,
    resolveRequestedEngines
} from '../core/search/searchEngines.js';
import {
    createSearchService,
    SearchEngineExecutorMap
} from '../core/search/searchService.js';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
}

function assertEqualArray(actual: unknown[], expected: unknown[], label: string): void {
    const ok = actual.length === expected.length && actual.every((value, index) => value === expected[index]);
    if (!ok) {
        throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function createResult(engine: string, index: number): SearchResult {
    return {
        title: `${engine}-${index}`,
        url: `https://${engine}.example.com/${index}`,
        description: `result ${index} from ${engine}`,
        source: `${engine}.example.com`,
        engine
    };
}

function testNormalizeEngineName(): void {
    assertEqual(normalizeEngineName('Bing'), 'bing', 'normalizes Bing');
    assertEqual(normalizeEngineName('duck-duck-go'), 'duckduckgo', 'normalizes duckduckgo alias');
    assertEqual(normalizeEngineName('linux.do'), 'linuxdo', 'normalizes linux.do alias');
    assertEqual(normalizeEngineName('StartPage'), 'startpage', 'normalizes StartPage');
    assertEqual(normalizeEngineName('sou-gou'), 'sogou', 'normalizes sou-gou alias');
    assertEqual(normalizeEngineName('搜狗'), 'sogou', 'normalizes Chinese Sogou alias');
    assertEqual(normalizeEngineName('Hacker News'), 'hackernews', 'normalizes Hacker News alias');
    assertEqual(normalizeEngineName('hn'), 'hackernews', 'normalizes HN alias');
    assertEqualArray([...SUPPORTED_SEARCH_ENGINES], [
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
        'hackernews'
    ], 'supported engines list');
    console.log('✅ normalizeEngineName and supported engines');
}

function testDistributeLimit(): void {
    assertEqualArray(distributeLimit(10, 3), [4, 3, 3], 'distributes remainder to leading engines');
    assertEqualArray(distributeLimit(2, 5), [1, 1, 0, 0, 0], 'supports fewer results than engines');
    console.log('✅ distributeLimit');
}

function testResolvePerEngineLimits(): void {
    assertEqualArray(resolvePerEngineLimits(10, 3, 'fast'), [4, 3, 3], 'fast mode preserves distributed limit');
    assertEqualArray(resolvePerEngineLimits(10, 3, 'balanced'), [6, 6, 6], 'balanced mode fetches a wider candidate pool');
    assertEqualArray(resolvePerEngineLimits(10, 3, 'deep'), [10, 10, 10], 'deep mode fetches limit from each engine');
    assertEqualArray(resolvePerEngineLimits(10, 3, 'deep', 5), [5, 5, 5], 'perEngineLimit overrides mode');
    console.log('✅ resolvePerEngineLimits');
}

function testResolveRequestedEngines(): void {
    assertEqualArray(
        resolveRequestedEngines(['bing', 'startpage'], [], 'bing'),
        ['bing', 'startpage'],
        'keeps requested engines when unrestricted'
    );
    assertEqualArray(
        resolveRequestedEngines(['bing', 'startpage'], ['startpage'], 'bing'),
        ['startpage'],
        'filters to allowed engines'
    );
    assertEqualArray(
        resolveRequestedEngines(['bing'], ['startpage'], 'startpage'),
        ['startpage'],
        'falls back to default allowed engine when all requested engines are filtered'
    );
    console.log('✅ resolveRequestedEngines');
}

async function testSearchServiceExecution(): Promise<void> {
    const seenCalls: Array<{ engine: string; query: string; limit: number; searchMode?: string }> = [];
    const engineMap: SearchEngineExecutorMap = {
        bing: async (query, limit, context) => {
            seenCalls.push({ engine: 'bing', query, limit, searchMode: context?.searchMode });
            return Array.from({ length: limit }, (_, index) => createResult('bing', index + 1));
        },
        startpage: async (query, limit, context) => {
            seenCalls.push({ engine: 'startpage', query, limit, searchMode: context?.searchMode });
            throw new Error(`blocked for ${query} (${limit})`);
        }
    };

    const service = createSearchService(engineMap);
    const result = await service.execute({
        query: '  open web search  ',
        engines: ['bing', 'startpage'],
        limit: 3,
        searchMode: 'playwright'
    });

    assertEqual(result.query, 'open web search', 'trims query');
    assertEqual(result.totalResults, 2, 'keeps successful engine results');
    assertEqual(result.partialFailures.length, 1, 'captures one partial failure');
    assertEqual(result.partialFailures[0].engine, 'startpage', 'records failed engine');
    assertEqual(result.partialFailures[0].code, 'engine_error', 'uses stable partial failure code');
    assertEqualArray(
        seenCalls.map(call => `${call.engine}:${call.query}:${call.limit}:${call.searchMode ?? 'none'}`),
        ['bing:open web search:2:playwright', 'startpage:open web search:1:playwright'],
        'passes trimmed query, distributed limits, and request-level search mode'
    );

    console.log('✅ search service executes with partial failures');
}

async function testSearchMetadataEnrichment(): Promise<void> {
    const retrievedAt = new Date('2026-08-18T09:15:00.000Z');
    const service = createSearchService({
        bing: async () => [{
            title: 'Metadata result',
            url: 'HTTPS://WWW.Example.COM./news?id=1',
            description: 'metadata',
            source: 'example.comhttps://www.example.com',
            sourceDomain: 'untrusted.example',
            dateText: '2026年8月18日',
            publishedAt: '2026-08-18T00:00:00.000Z',
            engine: 'bing'
        }]
    }, {
        now: () => retrievedAt
    });

    const result = await service.execute({
        query: 'metadata',
        engines: ['bing'],
        limit: 1
    });

    assertEqual(result.retrievedAt, retrievedAt.toISOString(), 'uses injected retrieval clock');
    assertEqual(result.results[0].source, 'example.comhttps://www.example.com', 'preserves legacy source field');
    assertEqual(result.results[0].sourceDomain, 'www.example.com', 'derives sourceDomain from final URL');
    assertEqual(result.results[0].dateText, '2026年8月18日', 'preserves parser dateText');
    assertEqual(result.results[0].publishedAt, '2026-08-18T00:00:00.000Z', 'preserves evidence-backed publishedAt');

    const invalidUrlService = createSearchService({
        bing: async () => [{
            ...createResult('bing', 1),
            url: 'not a URL',
            sourceDomain: 'must-not-survive.example'
        }]
    }, {
        now: () => retrievedAt
    });
    const invalidUrlResult = await invalidUrlService.execute({
        query: 'invalid URL metadata',
        engines: ['bing'],
        limit: 1
    });
    assertEqual(invalidUrlResult.results[0].sourceDomain, undefined, 'omits sourceDomain for invalid result URLs');

    console.log('✅ search service enriches trustworthy retrieval metadata');
}

async function testPublicationMetadataDerivation(): Promise<void> {
    const retrievedAt = new Date('2026-08-18T10:05:32.120Z');
    const metadataResult = (
        key: string,
        dateText?: string,
        overrides: Partial<SearchResult> = {}
    ): SearchResult => ({
        title: key,
        url: `https://news.example.com/${key}`,
        description: `${dateText ?? 'no date'} · fixture`,
        source: 'news.example.com',
        ...(dateText ? { dateText } : {}),
        engine: 'bing',
        ...overrides
    });
    const service = createSearchService({
        bing: async () => [
            metadataResult('chinese', '2026年8月18日'),
            metadataResult('iso', '2026-08-17'),
            metadataResult('relative-days', '6 天之前'),
            metadataResult('relative-hours', '3 hours ago'),
            metadataResult('relative-minutes', '20 分钟前'),
            metadataResult('leap-day', '2024-02-29'),
            metadataResult('invalid-leap-day', '2025-02-29'),
            metadataResult('future', '2026年8月19日'),
            metadataResult('ambiguous', '2026/08/18'),
            metadataResult('future-structured', undefined, { publishedAt: '2026-08-18T10:06:00.000Z' }),
            metadataResult('timezone-less-structured', undefined, { publishedAt: '2026-08-17T10:00:00' }),
            metadataResult('missing')
        ],
        startpage: async () => [metadataResult('other-engine', '6 days ago', { engine: 'startpage' })]
    }, {
        now: () => retrievedAt
    });

    const result = await service.execute({
        query: 'publication metadata',
        engines: ['bing', 'startpage'],
        limit: 20,
        aggregationMode: 'deep'
    });
    const byTitle = new Map(result.results.map((item) => [item.title, item]));

    assertEqual(result.retrievedAt, retrievedAt.toISOString(), 'publication metadata uses one retrieval clock');
    assertEqual(byTitle.get('chinese')?.publishedAt, '2026-08-17T16:00:00.000Z', 'Chinese date uses Bing zh-CN timezone');
    assertEqual(byTitle.get('iso')?.publishedAt, '2026-08-16T16:00:00.000Z', 'ISO date uses Bing zh-CN timezone');
    assertEqual(byTitle.get('relative-days')?.publishedAt, '2026-08-12T10:05:32.120Z', 'relative days use retrievedAt');
    assertEqual(byTitle.get('relative-hours')?.publishedAt, '2026-08-18T07:05:32.120Z', 'relative hours use retrievedAt');
    assertEqual(byTitle.get('relative-minutes')?.publishedAt, '2026-08-18T09:45:32.120Z', 'relative minutes use retrievedAt');
    assertEqual(byTitle.get('leap-day')?.publishedAt, '2024-02-28T16:00:00.000Z', 'valid leap day is normalized');
    assertEqual(byTitle.get('invalid-leap-day')?.publishedAt, undefined, 'invalid leap day is rejected');
    assertEqual(byTitle.get('invalid-leap-day')?.dateText, '2025-02-29', 'invalid explicit dateText stays auditable');
    assertEqual(byTitle.get('future')?.publishedAt, undefined, 'future date is rejected');
    assertEqual(byTitle.get('ambiguous')?.publishedAt, undefined, 'ambiguous date format is rejected');
    assertEqual(byTitle.get('future-structured')?.publishedAt, undefined, 'future structured timestamp is rejected');
    assertEqual(byTitle.get('timezone-less-structured')?.publishedAt, undefined, 'timezone-less structured timestamp is rejected');
    assertEqual(byTitle.get('missing')?.dateText, undefined, 'missing dateText remains absent');
    assertEqual(byTitle.get('missing')?.publishedAt, undefined, 'missing publishedAt remains absent');
    assertEqual(byTitle.get('other-engine')?.publishedAt, undefined, 'Bing-specific relative rules do not affect other engines');

    console.log('✅ publication metadata is derived conservatively from a fixed retrieval clock');
}

async function testSearchServiceAutoModeUsesRuntimeDefault(): Promise<void> {
    const seenCalls: Array<{ searchMode?: string }> = [];
    const service = createSearchService({
        bing: async (query, limit, context) => {
            seenCalls.push({ searchMode: context?.searchMode });
            return Array.from({ length: limit }, (_, index) => createResult(`${query}:${context?.searchMode ?? 'none'}`, index + 1));
        }
    });

    await service.execute({
        query: 'open web search',
        engines: ['bing'],
        limit: 1,
        searchMode: 'auto'
    });

    assertEqual(seenCalls[0].searchMode, undefined, 'request-level auto should be treated like omitted search mode');
    console.log('✅ search service treats request-level auto as runtime default');
}

async function testSearchServiceDedupeAndMergeEngines(): Promise<void> {
    const service = createSearchService({
        bing: async () => [{
            title: 'Canonical',
            url: 'https://Example.com/docs/?utm_source=newsletter&b=2&a=1#section',
            description: 'from bing',
            source: 'example.com',
            engine: 'bing'
        }],
        duckduckgo: async () => [{
            title: 'Duplicate',
            url: 'https://example.com/docs/?a=1&b=2',
            description: 'from duckduckgo',
            source: 'example.com',
            engine: 'duckduckgo'
        }]
    });

    const result = await service.execute({
        query: 'open web search',
        engines: ['bing', 'duckduckgo'],
        limit: 5,
        aggregationMode: 'deep'
    });

    assertEqual(result.totalResults, 1, 'dedupes normalized URLs');
    assertEqual(result.results[0].title, 'Canonical', 'keeps best ranked candidate content');
    assertEqual(result.results[0].engine, 'bing', 'keeps primary engine');
    assertEqual(result.results[0].engines?.join(','), 'bing,duckduckgo', 'records merged engines');
    assert(typeof result.results[0].score === 'number', 'adds aggregate score');

    console.log('✅ search service dedupes URLs and merges engines');
}

async function testSearchServiceCanDisableDedupe(): Promise<void> {
    const service = createSearchService({
        bing: async () => [createResult('bing', 1)],
        duckduckgo: async () => [{
            ...createResult('duckduckgo', 1),
            url: 'https://bing.example.com/1'
        }]
    });

    const result = await service.execute({
        query: 'open web search',
        engines: ['bing', 'duckduckgo'],
        limit: 5,
        aggregationMode: 'deep',
        dedupe: false
    });

    assertEqual(result.totalResults, 2, 'dedupe=false preserves duplicate URLs');
    console.log('✅ search service can disable dedupe');
}

async function testSearchServiceRrfPromotesSharedResults(): Promise<void> {
    const sharedUrl = 'https://example.com/shared';
    const service = createSearchService({
        bing: async () => [
            { ...createResult('bing', 1), url: 'https://example.com/bing-only' },
            { ...createResult('bing', 2), url: sharedUrl }
        ],
        startpage: async () => [
            { ...createResult('startpage', 1), url: 'https://example.com/startpage-only' },
            { ...createResult('startpage', 2), url: sharedUrl }
        ]
    });

    const result = await service.execute({
        query: 'open web search',
        engines: ['bing', 'startpage'],
        limit: 3,
        aggregationMode: 'deep',
        ranking: 'rrf'
    });

    assertEqual(result.results[0].url, sharedUrl, 'RRF promotes result found by multiple engines');
    assertEqual(result.results[0].engines?.join(','), 'bing,startpage', 'RRF promoted result preserves all engines');
    console.log('✅ search service RRF promotes shared results');
}

async function testSearchServiceEngineWeightsAffectRrf(): Promise<void> {
    const service = createSearchService({
        bing: async () => [
            { ...createResult('bing', 1), url: 'https://example.com/bing-top' }
        ],
        startpage: async () => [
            { ...createResult('startpage', 1), url: 'https://example.com/startpage-top' }
        ]
    });

    const result = await service.execute({
        query: 'open web search',
        engines: ['bing', 'startpage'],
        limit: 2,
        aggregationMode: 'deep',
        ranking: 'rrf',
        engineWeights: {
            bing: 0.5,
            startpage: 3
        }
    });

    assertEqual(result.results[0].engine, 'startpage', 'higher engine weight wins same-rank RRF tie');
    console.log('✅ search service engine weights affect RRF');
}

async function testSearchServicePerEngineLimit(): Promise<void> {
    const seenCalls: Array<{ engine: string; limit: number }> = [];
    const service = createSearchService({
        bing: async (_query, limit) => {
            seenCalls.push({ engine: 'bing', limit });
            return Array.from({ length: limit }, (_, index) => createResult('bing', index + 1));
        },
        startpage: async (_query, limit) => {
            seenCalls.push({ engine: 'startpage', limit });
            return Array.from({ length: limit }, (_, index) => createResult('startpage', index + 1));
        }
    });

    const result = await service.execute({
        query: 'open web search',
        engines: ['bing', 'startpage'],
        limit: 3,
        perEngineLimit: 4
    });

    assertEqualArray(
        seenCalls.map(call => `${call.engine}:${call.limit}`),
        ['bing:4', 'startpage:4'],
        'passes perEngineLimit to each engine'
    );
    assertEqual(result.totalResults, 3, 'final limit still caps returned results');
    console.log('✅ search service perEngineLimit controls candidate pool');
}

async function testSearchServiceValidation(): Promise<void> {
    const service = createSearchService({});

    let threw = false;
    try {
        await service.execute({
            query: '   ',
            engines: ['bing'],
            limit: 1
        });
    } catch (error) {
        threw = error instanceof Error && error.message === 'Query string cannot be empty';
    }

    assert(threw, 'empty trimmed query should fail');
    console.log('✅ search service validates empty query');
}

async function main(): Promise<void> {
    testNormalizeEngineName();
    testDistributeLimit();
    testResolvePerEngineLimits();
    testResolveRequestedEngines();
    await testSearchServiceExecution();
    await testSearchMetadataEnrichment();
    await testPublicationMetadataDerivation();
    await testSearchServiceAutoModeUsesRuntimeDefault();
    await testSearchServiceDedupeAndMergeEngines();
    await testSearchServiceCanDisableDedupe();
    await testSearchServiceRrfPromotesSharedResults();
    await testSearchServiceEngineWeightsAffectRrf();
    await testSearchServicePerEngineLimit();
    await testSearchServiceValidation();
    console.log('\nCore search tests passed.');
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
