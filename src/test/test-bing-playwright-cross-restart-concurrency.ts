import { execFileSync } from 'node:child_process';
import { createOpenWebSearchRuntime } from '../runtime/createRuntime.js';
import { startLocalDaemon } from '../adapters/http/localDaemon.js';
import { SearchResult } from '../types.js';

type SearchResponse = {
    query: string;
    status: number;
    body: string;
    envelopeStatus: string | null;
    totalResults: number;
    results: SearchResult[];
    partialFailures: Array<{ engine: string; code: string; message: string }>;
};

type SearchResponseEnvelope = {
    status: string;
    data?: {
        query: string;
        totalResults: number;
        results: SearchResult[];
        partialFailures: Array<{ engine: string; code: string; message: string }>;
    };
    error?: {
        code: string;
        message: string;
    };
};

type QueryExpectation = {
    minimumGroupMatches: number;
    groups: Array<{
        label: string;
        anyOf: string[];
    }>;
};

type ScoredSearchResult = {
    result: SearchResult;
    matchedGroups: string[];
};

const phase1Queries = [
    'fsutil quota',
    '古斯塔夫鳄鱼',
    'git blame'
];

const phase2Queries = [
    'elasid 蛇女',
    '蚊 小说',
    '磁盘配额不足，但是找不到占用空间的文件'
];

// 把“结果是否相关”的判断并入正式并发/跨重启测试，避免只能人工看输出，
// 并且让每个查询都用可解释的关键词组规则校验命中结果是否仍然贴近原查询语义。
const queryExpectations = new Map<string, QueryExpectation>([
    ['fsutil quota', {
        minimumGroupMatches: 2,
        groups: [
            { label: 'fsutil', anyOf: ['fsutil'] },
            { label: 'quota-or-配额', anyOf: ['quota', '配额'] }
        ]
    }],
    ['古斯塔夫鳄鱼', {
        minimumGroupMatches: 2,
        groups: [
            { label: '古斯塔夫', anyOf: ['古斯塔夫'] },
            { label: '鳄鱼', anyOf: ['鳄鱼'] }
        ]
    }],
    ['git blame', {
        minimumGroupMatches: 2,
        groups: [
            { label: 'git', anyOf: ['git'] },
            { label: 'blame', anyOf: ['blame'] }
        ]
    }],
    ['elasid 蛇女', {
        minimumGroupMatches: 2,
        groups: [
            { label: 'elasid', anyOf: ['elasid'] },
            { label: '蛇女', anyOf: ['蛇女'] }
        ]
    }],
    ['蚊 小说', {
        minimumGroupMatches: 2,
        groups: [
            { label: '蚊', anyOf: ['蚊'] },
            { label: '小说-or-全文', anyOf: ['小说', '全文'] }
        ]
    }],
    ['磁盘配额不足，但是找不到占用空间的文件', {
        minimumGroupMatches: 2,
        groups: [
            { label: '磁盘-or-空间', anyOf: ['磁盘', '空间'] },
            { label: '配额-or-quota', anyOf: ['配额', 'quota'] },
            { label: '文件-or-占用', anyOf: ['文件', '占用'] }
        ]
    }]
]);

function assertCondition(condition: unknown, message: string): void {
    if (!condition) {
        throw new Error(message);
    }
}

function runPowerShell(command: string): string {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8',
        windowsHide: true
    }).trim();
}

function listRootPids(): number[] {
    const raw = runPowerShell("Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -match 'mcp-search-' -and $_.CommandLine -match '--remote-debugging-port=' -and $_.CommandLine -notmatch '--type=' } | Select-Object -ExpandProperty ProcessId | Sort-Object | ConvertTo-Json -Compress");
    if (!raw) {
        return [];
    }

    const parsed = JSON.parse(raw) as number[] | number;
    return Array.isArray(parsed) ? parsed : [parsed];
}

function listRendererCount(): number {
    const raw = runPowerShell("Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -match 'mcp-search-' -and $_.CommandLine -match '--type=renderer' } | Measure-Object | Select-Object -ExpandProperty Count | Out-String");
    return Number.parseInt(raw.trim(), 10) || 0;
}

function diffRoots(nextRoots: number[], previousRoots: number[]): number[] {
    const previous = new Set(previousRoots);
    return nextRoots.filter((root) => !previous.has(root));
}

function rootsEqual(left: number[], right: number[]): boolean {
    if (left.length !== right.length) {
        return false;
    }

    return left.every((value, index) => value === right[index]);
}

function normalizeText(value: string): string {
    return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function buildResultSearchText(result: SearchResult): string {
    return normalizeText([
        result.title,
        result.description,
        result.url,
        result.source
    ].filter(Boolean).join(' '));
}

function scoreSearchResult(result: SearchResult, expectation: QueryExpectation): ScoredSearchResult {
    const haystack = buildResultSearchText(result);
    const matchedGroups = expectation.groups
        .filter((group) => group.anyOf.some((keyword) => haystack.includes(normalizeText(keyword))))
        .map((group) => group.label);

    return { result, matchedGroups };
}

function formatResultPreview(result: SearchResult): string {
    return `${result.title || '(empty title)'} | ${(result.description || '').slice(0, 80)}`;
}

function assertRelevantResults(label: string, query: string, results: SearchResult[]): void {
    const expectation = queryExpectations.get(query);
    if (!expectation) {
        throw new Error(`missing relevance expectation for query: ${query}`);
    }
    assertCondition(results.length > 0, `${label} query returned no results: ${query}`);

    const scoredResults = results.map((result) => scoreSearchResult(result, expectation));
    const bestResult = scoredResults.reduce((best, current) => (
        current.matchedGroups.length > best.matchedGroups.length ? current : best
    ));

    for (const [index, scoredResult] of scoredResults.entries()) {
        const matches = scoredResult.matchedGroups.length > 0 ? scoredResult.matchedGroups.join(',') : '(none)';
        console.log(`${label} relevance query=${query} result=${index + 1} matches=${matches} preview=${formatResultPreview(scoredResult.result)}`);
    }

    assertCondition(
        bestResult.matchedGroups.length >= expectation.minimumGroupMatches,
        `${label} query produced weakly related results: ${query}; bestMatches=${bestResult.matchedGroups.join(',') || '(none)'}; preview=${formatResultPreview(bestResult.result)}`
    );
}

async function searchOnce(baseUrl: string, query: string): Promise<SearchResponse> {
    const response = await fetch(`${baseUrl}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            query,
            limit: 3,
            engines: ['bing'],
            searchMode: 'playwright'
        })
    });

    const body = await response.text();
    let payload: SearchResponseEnvelope | undefined;
    try {
        payload = JSON.parse(body) as SearchResponseEnvelope;
    } catch {
        payload = undefined;
    }

    return {
        query,
        status: response.status,
        body,
        envelopeStatus: payload?.status ?? null,
        totalResults: payload?.data?.totalResults ?? 0,
        results: payload?.data?.results ?? [],
        partialFailures: payload?.data?.partialFailures ?? []
    };
}

async function runPhase(version: string, label: string, queries: string[]) {
    const runtime = createOpenWebSearchRuntime();
    const daemon = await startLocalDaemon(runtime, { port: 0, version });
    const beforeRoots = listRootPids();
    const beforeRenderers = listRendererCount();

    console.log(`${label} before roots=${JSON.stringify(beforeRoots)} renderers=${beforeRenderers}`);

    try {
        const results = await Promise.all(queries.map((query) => searchOnce(daemon.baseUrl, query)));
        for (const result of results) {
            console.log(`${label} query=${result.query} status=${result.status}`);
            assertCondition(result.status === 200, `${label} query failed: ${result.query} => ${result.status}`);
            assertCondition(result.envelopeStatus === 'ok', `${label} query returned invalid payload: ${result.query}; body=${result.body}`);
            assertCondition(result.partialFailures.length === 0, `${label} query had partial failures: ${result.query} => ${JSON.stringify(result.partialFailures)}`);
            assertCondition(result.totalResults > 0, `${label} query returned zero results: ${result.query}; body=${result.body}`);
            assertRelevantResults(label, result.query, result.results);
        }

        const afterConcurrentRoots = listRootPids();
        const afterConcurrentRenderers = listRendererCount();
        console.log(`${label} afterConcurrent roots=${JSON.stringify(afterConcurrentRoots)} renderers=${afterConcurrentRenderers}`);

        return {
            beforeRoots,
            beforeRenderers,
            afterConcurrentRoots,
            afterConcurrentRenderers
        };
    } finally {
        await daemon.close();
        const afterCloseRoots = listRootPids();
        const afterCloseRenderers = listRendererCount();
        console.log(`${label} afterClose roots=${JSON.stringify(afterCloseRoots)} renderers=${afterCloseRenderers}`);
    }
}

async function main(): Promise<void> {
    assertCondition(process.platform === 'win32', 'This test currently requires Windows process inspection');
    assertCondition(process.env.SEARCH_MODE === 'playwright', 'Set SEARCH_MODE=playwright before running this test');
    assertCondition(process.env.DEFAULT_SEARCH_ENGINE === 'bing', 'Set DEFAULT_SEARCH_ENGINE=bing before running this test');
    assertCondition(process.env.PLAYWRIGHT_HEADLESS === 'false', 'Set PLAYWRIGHT_HEADLESS=false before running this test');

    console.log('Bing headed Playwright cross-restart concurrency test config:', {
        searchMode: process.env.SEARCH_MODE,
        defaultEngine: process.env.DEFAULT_SEARCH_ENGINE,
        playwrightHeadless: process.env.PLAYWRIGHT_HEADLESS,
        navigationTimeoutMs: process.env.PLAYWRIGHT_NAVIGATION_TIMEOUT_MS || '(default)'
    });

    const phase1 = await runPhase('bing-playwright-cross-restart-1', 'phase1', phase1Queries);
    const phase1NewRoots = diffRoots(phase1.afterConcurrentRoots, phase1.beforeRoots);
    assertCondition(
        phase1NewRoots.length <= 1,
        `phase1 should add at most one browser root, before=${JSON.stringify(phase1.beforeRoots)} after=${JSON.stringify(phase1.afterConcurrentRoots)}`
    );

    const rootsAfterPhase1Close = listRootPids();
    assertCondition(
        rootsEqual(rootsAfterPhase1Close, phase1.afterConcurrentRoots),
        `headed browser roots should stay stable after phase1 close, expected=${JSON.stringify(phase1.afterConcurrentRoots)} actual=${JSON.stringify(rootsAfterPhase1Close)}`
    );

    const phase2 = await runPhase('bing-playwright-cross-restart-2', 'phase2', phase2Queries);
    assertCondition(
        rootsEqual(phase2.beforeRoots, rootsAfterPhase1Close),
        `phase2 should start from the same reusable browser roots, expected=${JSON.stringify(rootsAfterPhase1Close)} actual=${JSON.stringify(phase2.beforeRoots)}`
    );
    assertCondition(
        rootsEqual(phase2.afterConcurrentRoots, phase2.beforeRoots),
        `phase2 concurrent run should not create an extra browser root, before=${JSON.stringify(phase2.beforeRoots)} after=${JSON.stringify(phase2.afterConcurrentRoots)}`
    );

    console.log('Bing headed Playwright cross-restart concurrency test passed.');
}

main().catch((error) => {
    console.error('Bing headed Playwright cross-restart concurrency test failed:', error);
    process.exit(1);
});