import { SearchResult } from '../../types.js';
import { distributeLimit } from './searchEngines.js';

export type SearchEngineExecutor = (query: string, limit: number) => Promise<SearchResult[]>;
export type SearchEngineExecutorMap = Partial<Record<string, SearchEngineExecutor>>;

export type SearchExecutionFailure = {
    engine: string;
    code: 'engine_error' | 'unsupported_engine';
    message: string;
};

export type SearchExecutionResult = {
    query: string;
    engines: string[];
    totalResults: number;
    results: SearchResult[];
    partialFailures: SearchExecutionFailure[];
};

export type SearchExecutionInput = {
    query: string;
    engines: string[];
    limit: number;
};

export function createSearchService(engineMap: SearchEngineExecutorMap) {
    return {
        async execute({ query, engines, limit }: SearchExecutionInput): Promise<SearchExecutionResult> {
            const cleanQuery = query.trim();
            if (!cleanQuery) {
                throw new Error('Query string cannot be empty');
            }

            const limits = distributeLimit(limit, engines.length);
            const partialFailures: SearchExecutionFailure[] = [];

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
                    return await executor(cleanQuery, engineLimit);
                } catch (error) {
                    partialFailures.push({
                        engine,
                        code: 'engine_error',
                        message: error instanceof Error ? error.message : String(error)
                    });
                    return [];
                }
            });

            const results = (await Promise.all(tasks)).flat().slice(0, limit);

            return {
                query: cleanQuery,
                engines,
                totalResults: results.length,
                results,
                partialFailures
            };
        }
    };
}
