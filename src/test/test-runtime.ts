import { AppConfig } from '../config.js';
import { createOpenWebSearchRuntime } from '../runtime/createRuntime.js';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function createTestConfig(): AppConfig {
    return {
        defaultSearchEngine: 'bing',
        allowedSearchEngines: [],
        searchMode: 'request',
        proxyUrl: 'http://127.0.0.1:7890',
        useProxy: false,
        fetchWebAllowInsecureTls: false,
        playwrightPackage: 'auto',
        playwrightHeadless: true,
        playwrightNavigationTimeoutMs: 20000,
        enableCors: false,
        corsOrigin: '*',
        enableHttpServer: true
    };
}

async function testRuntimeUsesInjectedDependencies(): Promise<void> {
    const seenCalls: string[] = [];
    const runtime = createOpenWebSearchRuntime({
        config: createTestConfig(),
        dependencies: {
            searchExecutors: {
                bing: async (query, limit) => {
                    seenCalls.push(`search:${query}:${limit}`);
                    return [{
                        title: 'bing result',
                        url: 'https://bing.example.com/1',
                        description: 'result',
                        source: 'bing.example.com',
                        engine: 'bing'
                    }];
                }
            },
            fetchGithubReadme: async (url) => {
                seenCalls.push(`github:${url}`);
                return '# README';
            },
            fetchWebContent: async (url, maxChars) => {
                seenCalls.push(`web:${url}:${maxChars}`);
                return {
                    url,
                    finalUrl: url,
                    contentType: 'text/plain',
                    title: 'Example',
                    retrievalMethod: 'request',
                    truncated: false,
                    content: 'example'
                };
            },
            fetchCsdnArticle: async (url) => {
                seenCalls.push(`csdn:${url}`);
                return { content: 'csdn' };
            },
            fetchJuejinArticle: async (url) => {
                seenCalls.push(`juejin:${url}`);
                return { content: 'juejin' };
            },
            fetchLinuxDoArticle: async (url) => {
                seenCalls.push(`linuxdo:${url}`);
                return { content: 'linuxdo' };
            }
        }
    });

    assert(runtime.config.defaultSearchEngine === 'bing', 'runtime should expose config');

    const searchResult = await runtime.services.search.execute({
        query: ' open web search ',
        engines: ['bing'],
        limit: 1
    });
    assert(searchResult.totalResults === 1, 'runtime search service should be callable');

    const github = await runtime.services.fetchGithubReadme.execute({
        url: 'https://github.com/Aas-ee/open-webSearch'
    });
    assert(github === '# README', 'runtime github service should be callable');

    const web = await runtime.services.fetchWeb.execute({
        url: 'https://example.com',
        maxChars: 1234
    });
    assert(web.title === 'Example', 'runtime web fetch service should be callable');

    const csdn = await runtime.services.fetchCsdnArticle.execute({
        url: 'https://blog.csdn.net/user/article/details/123456'
    });
    assert(csdn.content === 'csdn', 'runtime csdn service should be callable');

    const juejin = await runtime.services.fetchJuejinArticle.execute({
        url: 'https://juejin.cn/post/1234567890'
    });
    assert(juejin.content === 'juejin', 'runtime juejin service should be callable');

    const linuxdo = await runtime.services.fetchLinuxDoArticle.execute({
        url: 'https://linux.do/t/topic/123.json'
    });
    assert(linuxdo.content === 'linuxdo', 'runtime linuxdo service should be callable');

    assert(
        seenCalls.includes('search:open web search:1') &&
        seenCalls.includes('github:https://github.com/Aas-ee/open-webSearch') &&
        seenCalls.includes('web:https://example.com:1234'),
        'runtime should delegate to injected dependencies'
    );

    console.log('✅ runtime uses injected dependencies');
}

async function main(): Promise<void> {
    await testRuntimeUsesInjectedDependencies();
    console.log('\nRuntime tests passed.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
