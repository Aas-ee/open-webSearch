import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import {
    __setKeenableHttpPostForTests,
    parseKeenableSearchResponse,
    searchKeenable
} from '../engines/keenable/index.js';
import { createOpenWebSearchRuntime } from '../runtime/createRuntime.js';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
    }
}

function response(data: unknown): AxiosResponse {
    return {
        data,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: { headers: {} } as AxiosResponse['config']
    };
}

async function testSearchRequestAndMapping(): Promise<void> {
    let requestedUrl = '';
    let requestedBody: unknown;
    let requestedOptions: AxiosRequestConfig | undefined;
    __setKeenableHttpPostForTests(async (url, body, options) => {
        requestedUrl = url;
        requestedBody = body;
        requestedOptions = options;
        return response({
            query: 'sqlite wal',
            results: [
                {
                    title: 'Write-Ahead Logging',
                    url: 'https://sqlite.org/wal.html',
                    description: '',
                    snippet: 'The default method by which SQLite\nimplements atomic commit is a rollback journal.',
                    published_at: '2025-06-01T00:00:00Z'
                },
                {
                    title: '',
                    url: 'https://example.com/page',
                    description: 'Description fallback'
                }
            ]
        });
    });

    const results = await searchKeenable('sqlite wal 中文', 2);
    const headers = (requestedOptions?.headers ?? {}) as Record<string, string>;

    assertEqual(requestedUrl, 'https://api.keenable.ai/v1/search/public', 'fixed keyless endpoint');
    assertEqual(JSON.stringify(requestedBody), JSON.stringify({ query: 'sqlite wal 中文', max_results: 2 }), 'request body');
    assertEqual(headers['X-Keenable-Title'], 'open-websearch', 'app title header');
    assert(!('Authorization' in headers) && !('X-API-Key' in headers), 'no credential header is sent');
    assertEqual(requestedOptions?.timeout, 15000, 'request timeout');
    assertEqual(requestedOptions?.maxContentLength, 2 * 1024 * 1024, 'response size limit');
    assertEqual(requestedOptions?.maxRedirects, 0, 'fixed endpoint must not follow redirects');
    assertEqual(requestedOptions?.proxy, false, 'request should use shared proxy handling');
    assertEqual(results.length, 2, 'mapped result count');
    assertEqual(results[0].title, 'Write-Ahead Logging', 'title');
    assertEqual(results[0].url, 'https://sqlite.org/wal.html', 'url');
    assertEqual(results[0].source, 'sqlite.org', 'source');
    assertEqual(results[0].engine, 'keenable', 'engine name');
    assertEqual(
        results[0].description,
        'The default method by which SQLite implements atomic commit is a rollback journal. | 2025-06-01',
        'snippet with collapsed whitespace and publish date'
    );
    assertEqual(results[1].title, 'example.com', 'hostname title fallback');
    assertEqual(results[1].description, 'Description fallback', 'description fallback');

    console.log('✓ Keenable request and mapping');
}

function testMalformedHitsAndInvalidResponses(): void {
    const results = parseKeenableSearchResponse({
        results: [
            null,
            'invalid',
            { title: 'No URL' },
            { title: 'Private', url: 'http://127.0.0.1/admin' },
            { title: 'Localhost', url: 'http://localhost:8080/' },
            { title: 'Credentials', url: 'https://user:pass@example.com/' },
            { title: 'File', url: 'file:///etc/passwd' },
            { title: 'Valid', url: 'https://example.org/a' }
        ]
    }, 10);
    assertEqual(results.length, 1, 'only the public http(s) hit survives');
    assertEqual(results[0].url, 'https://example.org/a', 'valid hit');
    assertEqual(parseKeenableSearchResponse({ results: [] }, 10).length, 0, 'empty results are not an error');

    for (const value of [null, [], 'invalid', {}, { results: {} }]) {
        let threw = false;
        try {
            parseKeenableSearchResponse(value, 10);
        } catch (error) {
            threw = error instanceof Error && error.message.includes('Keenable Search');
        }
        assert(threw, `invalid response should throw: ${JSON.stringify(value)}`);
    }

    console.log('✓ Keenable malformed hits and invalid responses');
}

async function testLimitAndErrorBehavior(): Promise<void> {
    let calls = 0;
    let seenLimit = 0;
    __setKeenableHttpPostForTests(async (_url, body) => {
        calls += 1;
        seenLimit = Number((body as { max_results: number }).max_results);
        return response({ results: [] });
    });

    assertEqual((await searchKeenable('zero', 0)).length, 0, 'zero-limit result');
    assertEqual(calls, 0, 'zero limit should not make a request');
    await searchKeenable('bounded', 75);
    assertEqual(seenLimit, 50, 'direct calls clamp max_results');

    __setKeenableHttpPostForTests(async () => {
        throw new Error('Request failed with status code 429');
    });
    let threw = false;
    try {
        await searchKeenable('rate limited', 5);
    } catch (error) {
        threw = error instanceof Error && error.message.includes('429');
    }
    assert(threw, 'upstream errors propagate so the search service reports a partial failure');

    console.log('✓ Keenable limit and error behavior');
}

async function testDefaultRuntimeRegistration(): Promise<void> {
    __setKeenableHttpPostForTests(async () => response({
        results: [{ title: 'Registered engine', url: 'https://example.net/' }]
    }));

    const runtime = createOpenWebSearchRuntime();
    const result = await runtime.services.search.execute({
        query: 'runtime registration',
        engines: ['keenable'],
        limit: 1
    });

    assertEqual(result.partialFailures.length, 0, 'default runtime partial failures');
    assertEqual(result.totalResults, 1, 'default runtime result count');
    assertEqual(result.results[0].engine, 'keenable', 'default runtime engine registration');

    console.log('✓ Keenable default runtime registration');
}

async function main(): Promise<void> {
    try {
        await testSearchRequestAndMapping();
        testMalformedHitsAndInvalidResponses();
        await testLimitAndErrorBehavior();
        await testDefaultRuntimeRegistration();
        console.log('\nKeenable tests passed.');
    } finally {
        __setKeenableHttpPostForTests();
    }
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
