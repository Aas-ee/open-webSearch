import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import {
    __setHackerNewsHttpGetForTests,
    parseHackerNewsSearchResponse,
    searchHackerNews
} from '../engines/hackernews/index.js';
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
    let requestedOptions: AxiosRequestConfig | undefined;
    __setHackerNewsHttpGetForTests(async (url, options) => {
        requestedUrl = url;
        requestedOptions = options;
        return response({
            hits: [
                {
                    objectID: '42237424',
                    title: 'Model Context Protocol',
                    url: 'https://www.anthropic.com/news/model-context-protocol',
                    author: 'benocodes',
                    points: 872,
                    num_comments: 258,
                    created_at: '2024-11-25T16:14:22Z'
                },
                {
                    objectID: '12345',
                    title: 'Ask HN: A self post',
                    url: null,
                    author: 'alice',
                    points: 1,
                    num_comments: 1,
                    story_text: '<p>How do you use <strong>MCP</strong> safely?</p><p>Hello<br>world</p><script>ignore()</script><style>.hidden{}</style>'
                }
            ]
        });
    });

    const results = await searchHackerNews('Model Context Protocol & agents 中文', 2);

    assertEqual(requestedUrl, 'https://hn.algolia.com/api/v1/search', 'fixed HN Search endpoint');
    assertEqual(requestedOptions?.params?.query, 'Model Context Protocol & agents 中文', 'query parameter');
    assertEqual(requestedOptions?.params?.tags, 'story', 'story-only tag');
    assertEqual(requestedOptions?.params?.hitsPerPage, 2, 'result limit parameter');
    assertEqual(
        requestedOptions?.params?.attributesToRetrieve,
        'objectID,title,url,author,points,num_comments,created_at,story_text',
        'minimal response attributes'
    );
    assertEqual(requestedOptions?.timeout, 15000, 'request timeout');
    assertEqual(requestedOptions?.maxContentLength, 2 * 1024 * 1024, 'response size limit');
    assertEqual(requestedOptions?.maxRedirects, 0, 'fixed endpoint must not follow redirects');
    assertEqual(requestedOptions?.proxy, false, 'request should use shared proxy handling');
    assertEqual(results.length, 2, 'mapped result count');
    assertEqual(results[0].title, 'Model Context Protocol', 'external story title');
    assertEqual(results[0].url, 'https://www.anthropic.com/news/model-context-protocol', 'external story URL');
    assertEqual(results[0].source, 'www.anthropic.com', 'external story source');
    assertEqual(results[0].engine, 'hackernews', 'engine name');
    assertEqual(results[0].description, 'By benocodes | 872 points | 258 comments | 2024-11-25', 'story metadata');
    assertEqual(results[1].url, 'https://news.ycombinator.com/item?id=12345', 'self-post discussion fallback');
    assertEqual(results[1].source, 'news.ycombinator.com', 'self-post source');
    assertEqual(
        results[1].description,
        'How do you use MCP safely? Hello world | By alice | 1 point | 1 comment',
        'self-post summary and singular metadata'
    );

    console.log('✓ Hacker News request and result mapping');
}

function testFallbacksAndMalformedHits(): void {
    const results = parseHackerNewsSearchResponse({
        hits: [
            null,
            'invalid',
            { objectID: '199', title: '   ' },
            {
                objectID: '200',
                title: 'First submission',
                url: 'https://example.com/story'
            },
            {
                objectID: '201',
                title: 'Unsafe credential URL',
                url: 'https://user:secret@example.com/private'
            },
            {
                objectID: '202',
                title: 'Unsupported scheme',
                url: 'javascript:alert(1)'
            },
            {
                objectID: '203',
                title: 'Private literal URL',
                url: 'http://127.0.0.1/private'
            },
            {
                objectID: '204',
                title: 'Localhost URL',
                url: 'http://localhost/private'
            },
            {
                objectID: '205',
                title: 'IPv6 loopback URL',
                url: 'http://[::1]/private'
            },
            {
                objectID: '206',
                title: 'Trailing-dot localhost URL',
                url: 'http://foo.localhost./private'
            },
            {
                objectID: '207',
                title: 'Second discussion for same URL',
                url: 'https://example.com/story'
            },
            {
                objectID: 'not-an-id',
                title: 'No usable URL',
                url: 'file:///tmp/private'
            }
        ]
    }, 10);

    assertEqual(results.length, 8, 'skips malformed hits without dropping later valid stories');
    assertEqual(results[0].title, 'First submission', 'valid hit after malformed entries');
    assertEqual(results[0].url, 'https://example.com/story', 'external story URL');
    assertEqual(results[1].url, 'https://news.ycombinator.com/item?id=201', 'credential URL fallback');
    assertEqual(results[2].url, 'https://news.ycombinator.com/item?id=202', 'unsupported scheme fallback');
    assertEqual(results[3].url, 'https://news.ycombinator.com/item?id=203', 'private literal URL fallback');
    assertEqual(results[4].url, 'https://news.ycombinator.com/item?id=204', 'localhost URL fallback');
    assertEqual(results[5].url, 'https://news.ycombinator.com/item?id=205', 'IPv6 loopback URL fallback');
    assertEqual(results[6].url, 'https://news.ycombinator.com/item?id=206', 'trailing-dot localhost URL fallback');
    assertEqual(results[7].title, 'Second discussion for same URL', 'preserves distinct HN stories for the same external URL');

    console.log('✓ Hacker News fallbacks and malformed hits');
}

function testInvalidResponses(): void {
    for (const value of [null, [], 'invalid', {}, { hits: {} }]) {
        let threw = false;
        try {
            parseHackerNewsSearchResponse(value, 10);
        } catch (error) {
            threw = error instanceof Error && error.message.includes('Hacker News Search');
        }
        assert(threw, `invalid response should throw: ${JSON.stringify(value)}`);
    }

    for (const value of [
        { hits: [null, 'invalid'] },
        { hits: [{ objectID: 'not-an-id', title: 'No usable URL' }] }
    ]) {
        let threw = false;
        try {
            parseHackerNewsSearchResponse(value, 10);
        } catch (error) {
            threw = error instanceof Error && error.message.includes('no usable story hits');
        }
        assert(threw, `non-empty unusable hits should throw: ${JSON.stringify(value)}`);
    }

    console.log('✓ Hacker News invalid response handling');
}

async function testLimitAndErrorBehavior(): Promise<void> {
    let calls = 0;
    let seenLimit = 0;
    __setHackerNewsHttpGetForTests(async (_url, options) => {
        calls += 1;
        seenLimit = Number(options.params?.hitsPerPage);
        return response({ hits: [] });
    });

    assertEqual((await searchHackerNews('zero', 0)).length, 0, 'zero-limit result');
    assertEqual(calls, 0, 'zero limit should not make a request');
    await searchHackerNews('bounded', 75);
    assertEqual(seenLimit, 50, 'direct calls clamp API page size');

    const upstreamError = new Error('rate limited');
    __setHackerNewsHttpGetForTests(async () => {
        throw upstreamError;
    });
    let receivedError: unknown;
    try {
        await searchHackerNews('failure', 1);
    } catch (error) {
        receivedError = error;
    }
    assert(receivedError === upstreamError, 'upstream errors should propagate to the shared partial-failure handler');

    console.log('✓ Hacker News limits and error propagation');
}

async function testDefaultRuntimeRegistration(): Promise<void> {
    __setHackerNewsHttpGetForTests(async () => response({
        hits: [{ objectID: '300', title: 'Registered engine' }]
    }));

    const runtime = createOpenWebSearchRuntime();
    const result = await runtime.services.search.execute({
        query: 'runtime registration',
        engines: ['hackernews'],
        limit: 1
    });

    assertEqual(result.partialFailures.length, 0, 'default runtime partial failures');
    assertEqual(result.totalResults, 1, 'default runtime result count');
    assertEqual(result.results[0].engine, 'hackernews', 'default runtime engine registration');

    console.log('✓ Hacker News default runtime registration');
}

async function main(): Promise<void> {
    try {
        await testSearchRequestAndMapping();
        testFallbacksAndMalformedHits();
        testInvalidResponses();
        await testLimitAndErrorBehavior();
        await testDefaultRuntimeRegistration();
        console.log('\nHacker News tests passed.');
    } finally {
        __setHackerNewsHttpGetForTests();
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
