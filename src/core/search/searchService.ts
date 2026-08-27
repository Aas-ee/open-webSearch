import { SearchResult } from '../../types.js';
import { AppConfig } from '../../config.js';
import {
    resolvePerEngineLimits,
    SearchAggregationMode,
    SearchRankingMode
} from './searchEngines.js';
import { normalizePublicationMetadata } from './publicationMetadata.js';

export type SearchExecutionContext = {
    searchMode?: AppConfig['searchMode'];
};

export type SearchEngineExecutor = (query: string, limit: number, context?: SearchExecutionContext) => Promise<SearchResult[]>;
export type SearchEngineExecutorMap = Partial<Record<string, SearchEngineExecutor>>;

export type SearchExecutionFailure = {
    engine: string;
    code: 'engine_error' | 'unsupported_engine' | 'browser_unavailable';
    message: string;
};

export type SearchExecutionResult = {
    query: string;
    engines: string[];
    retrievedAt: string;
    totalResults: number;
    results: SearchResult[];
    partialFailures: SearchExecutionFailure[];
};

export type SearchServiceOptions = {
    now?: () => Date;
};

export type SearchExecutionInput = {
    query: string;
    engines: string[];
    limit: number;
    searchMode?: AppConfig['searchMode'];
    aggregationMode?: SearchAggregationMode;
    perEngineLimit?: number;
    ranking?: SearchRankingMode;
    engineWeights?: Record<string, number>;
    dedupe?: boolean;
};

type SearchCandidate = {
    result: SearchResult;
    engine: string;
    engineIndex: number;
    rank: number;
    globalIndex: number;
};

type SearchCandidateGroup = {
    key: string;
    candidates: SearchCandidate[];
    bestCandidate: SearchCandidate;
    engines: string[];
    firstEngineIndex: number;
    bestRank: number;
    score: number;
};

const TRACKING_PARAM_PREFIXES = ['utm_'];
const TRACKING_PARAM_NAMES = new Set([
    'fbclid',
    'gclid',
    'gbraid',
    'wbraid',
    'mc_cid',
    'mc_eid',
    'igshid',
    'ref',
    'ref_src',
    'spm'
]);

const RRF_K = 60;

function resolveSearchModeOverride(searchMode: AppConfig['searchMode'] | undefined): AppConfig['searchMode'] | undefined {
    // Agent 显式传 searchMode=auto 时，应与不传参数一致，优先使用环境变量值。不能优先使用HTTP请求，因为它会导致Bing返回垃圾结果。
    return searchMode === 'auto' ? undefined : searchMode;
}

function normalizeSearchResultUrl(url: string): string {
    try {
        const parsed = new URL(url.trim());
        parsed.protocol = parsed.protocol.toLowerCase();
        parsed.hostname = parsed.hostname.toLowerCase();
        parsed.hash = '';

        const preservedParams = Array.from(parsed.searchParams.entries())
            .filter(([name]) => {
                const lowerName = name.toLowerCase();
                return !TRACKING_PARAM_NAMES.has(lowerName) &&
                    !TRACKING_PARAM_PREFIXES.some(prefix => lowerName.startsWith(prefix));
            })
            .sort(([leftName, leftValue], [rightName, rightValue]) =>
                leftName === rightName ? leftValue.localeCompare(rightValue) : leftName.localeCompare(rightName)
            );

        parsed.search = '';
        for (const [name, value] of preservedParams) {
            parsed.searchParams.append(name, value);
        }

        if (parsed.pathname.length > 1) {
            parsed.pathname = parsed.pathname.replace(/\/+$/, '');
        }

        return parsed.toString();
    } catch {
        return url.trim();
    }
}

function getSourceDomain(url: string): string | undefined {
    try {
        const parsed = new URL(url.trim());
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return undefined;
        }

        const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
        return hostname || undefined;
    } catch {
        return undefined;
    }
}

function getRankingMode(aggregationMode: SearchAggregationMode, ranking?: SearchRankingMode): SearchRankingMode {
    if (ranking) {
        return ranking;
    }

    return aggregationMode === 'fast' ? 'engine-order' : 'rrf';
}

function getEngineWeight(engineWeights: Record<string, number> | undefined, engine: string): number {
    const weight = engineWeights?.[engine];
    return typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? weight : 1;
}

function roundScore(score: number): number {
    return Math.round(score * 1000000) / 1000000;
}

function createCandidateGroups(
    candidates: SearchCandidate[],
    options: {
        dedupe: boolean;
        rankingMode: SearchRankingMode;
        engineWeights?: Record<string, number>;
    }
): SearchCandidateGroup[] {
    const groups = new Map<string, SearchCandidateGroup>();

    for (const candidate of candidates) {
        const key = options.dedupe ? normalizeSearchResultUrl(candidate.result.url) : `${candidate.globalIndex}:${candidate.result.url}`;
        const existing = groups.get(key);

        if (!existing) {
            groups.set(key, {
                key,
                candidates: [candidate],
                bestCandidate: candidate,
                engines: [candidate.engine],
                firstEngineIndex: candidate.engineIndex,
                bestRank: candidate.rank,
                score: 0
            });
            continue;
        }

        existing.candidates.push(candidate);
        if (!existing.engines.includes(candidate.engine)) {
            existing.engines.push(candidate.engine);
        }

        if (
            candidate.rank < existing.bestCandidate.rank ||
            (candidate.rank === existing.bestCandidate.rank && candidate.engineIndex < existing.bestCandidate.engineIndex)
        ) {
            existing.bestCandidate = candidate;
        }

        existing.firstEngineIndex = Math.min(existing.firstEngineIndex, candidate.engineIndex);
        existing.bestRank = Math.min(existing.bestRank, candidate.rank);
    }

    for (const group of groups.values()) {
        if (options.rankingMode === 'rrf') {
            group.score = group.candidates.reduce((score, candidate) =>
                score + getEngineWeight(options.engineWeights, candidate.engine) / (RRF_K + candidate.rank), 0);
        } else {
            group.score = 1 / (group.firstEngineIndex + 1) + 1 / ((group.bestRank + 1) * 1000);
        }

        group.engines.sort((left, right) => {
            const leftCandidate = group.candidates.find(candidate => candidate.engine === left);
            const rightCandidate = group.candidates.find(candidate => candidate.engine === right);
            return (leftCandidate?.globalIndex ?? 0) - (rightCandidate?.globalIndex ?? 0);
        });
    }

    return [...groups.values()];
}

function sortCandidateGroups(groups: SearchCandidateGroup[], rankingMode: SearchRankingMode): SearchCandidateGroup[] {
    return groups.sort((left, right) => {
        if (rankingMode === 'rrf' && right.score !== left.score) {
            return right.score - left.score;
        }

        if (left.firstEngineIndex !== right.firstEngineIndex) {
            return left.firstEngineIndex - right.firstEngineIndex;
        }

        if (left.bestRank !== right.bestRank) {
            return left.bestRank - right.bestRank;
        }

        return left.bestCandidate.globalIndex - right.bestCandidate.globalIndex;
    });
}

function aggregateSearchResults(
    engineResults: SearchResult[][],
    engines: string[],
    limit: number,
    options: {
        aggregationMode: SearchAggregationMode;
        ranking?: SearchRankingMode;
        engineWeights?: Record<string, number>;
        dedupe: boolean;
        retrievedAt: Date;
    }
): SearchResult[] {
    let globalIndex = 0;
    const candidates = engineResults.flatMap((results, engineIndex) =>
        results.map((result, index) => ({
            result,
            engine: result.engine || engines[engineIndex],
            engineIndex,
            rank: index + 1,
            globalIndex: globalIndex++
        }))
    );

    const rankingMode = getRankingMode(options.aggregationMode, options.ranking);
    const groups = sortCandidateGroups(
        createCandidateGroups(candidates, {
            dedupe: options.dedupe,
            rankingMode,
            engineWeights: options.engineWeights
        }),
        rankingMode
    );

    return groups.slice(0, limit).map((group) => {
        const { sourceDomain: _ignoredSourceDomain, ...result } = group.bestCandidate.result;
        const sourceDomain = getSourceDomain(result.url);
        const resultWithMetadata = normalizePublicationMetadata(result, options.retrievedAt);

        return {
            ...resultWithMetadata,
            ...(sourceDomain ? { sourceDomain } : {}),
            engine: group.bestCandidate.engine,
            engines: group.engines,
            score: roundScore(group.score)
        };
    });
}

function classifyEngineError(error: unknown): SearchExecutionFailure['code'] {
    // 引擎抛出的带 code 的错误（如 browser_unavailable）原样保留 code，其余都归入通用的 engine_error。
    return (typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code as SearchExecutionFailure['code'] : 'engine_error');
}

export function createSearchService(engineMap: SearchEngineExecutorMap, options: SearchServiceOptions = {}) {
    const now = options.now ?? (() => new Date());

    return {
        async execute({
            query,
            engines,
            limit,
            searchMode,
            aggregationMode = 'fast',
            perEngineLimit,
            ranking,
            engineWeights,
            dedupe = true
        }: SearchExecutionInput): Promise<SearchExecutionResult> {
            const cleanQuery = query.trim();
            if (!cleanQuery) {
                throw new Error('Query string cannot be empty');
            }

            const limits = resolvePerEngineLimits(limit, engines.length, aggregationMode, perEngineLimit);
            const partialFailures: SearchExecutionFailure[] = [];
            const effectiveSearchMode = resolveSearchModeOverride(searchMode);

            const tasks = engines.map(async (engine, index) => {
                const executor = engineMap[engine];
                const engineLimit = limits[index];

                if (!executor) {
                    partialFailures.push({
                        engine,
                        code: 'unsupported_engine',
                        message: `Unsupported search engine: ${engine}`
                    });
                    return [];
                }

                try {
                    return await executor(cleanQuery, engineLimit, { searchMode: effectiveSearchMode });
                } catch (error) {
                    // 强制 Playwright 而配置无效属于明确的配置错误，直接上抛，由各入口以 browser_unavailable 错误响应。
                    if ((error as { code?: unknown })?.code === 'browser_unavailable') {
                        throw error;
                    }
                    partialFailures.push({
                        engine,
                        code: classifyEngineError(error),
                        message: error instanceof Error ? error.message : String(error)
                    });
                    return [];
                }
            });

            const engineResults = await Promise.all(tasks);
            const retrievedAtDate = now();
            const retrievedAt = retrievedAtDate.toISOString();
            const results = aggregateSearchResults(engineResults, engines, limit, {
                aggregationMode,
                ranking,
                engineWeights,
                dedupe,
                retrievedAt: retrievedAtDate
            });

            return {
                query: cleanQuery,
                engines,
                retrievedAt,
                totalResults: results.length,
                results,
                partialFailures
            };
        }
    };
}
