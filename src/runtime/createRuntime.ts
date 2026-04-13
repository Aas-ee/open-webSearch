import { config, AppConfig } from '../config.js';
import { searchBaidu } from '../engines/baidu/baidu.js';
import { searchBing } from '../engines/bing/bing.js';
import { searchLinuxDo } from '../engines/linuxdo/linuxdo.js';
import { searchCsdn } from '../engines/csdn/csdn.js';
import { searchDuckDuckGo } from '../engines/duckduckgo/index.js';
import { searchExa } from '../engines/exa/index.js';
import { searchBrave } from '../engines/brave/index.js';
import { searchJuejin } from '../engines/juejin/index.js';
import { searchStartpage } from '../engines/startpage/index.js';
import { searchTavily } from '../engines/tavily/tavily.js';
import { fetchLinuxDoArticle } from '../engines/linuxdo/fetchLinuxDoArticle.js';
import { fetchCsdnArticle } from '../engines/csdn/fetchCsdnArticle.js';
import { fetchJuejinArticle } from '../engines/juejin/fetchJuejinArticle.js';
import { fetchGithubReadme } from '../engines/github/index.js';
import { fetchWebContent } from '../engines/web/index.js';
import { createSearchService, SearchEngineExecutorMap } from '../core/search/searchService.js';
import {
    createArticleFetchService,
    createGithubReadmeService,
    createWebFetchService,
    ArticleFetcher,
    GithubReadmeFetcher,
    WebFetcher
} from '../core/fetch/fetchServices.js';
import { OpenWebSearchRuntime } from './runtimeTypes.js';

export type RuntimeDependencies = {
    searchExecutors?: SearchEngineExecutorMap;
    fetchLinuxDoArticle?: ArticleFetcher;
    fetchCsdnArticle?: ArticleFetcher;
    fetchJuejinArticle?: ArticleFetcher;
    fetchGithubReadme?: GithubReadmeFetcher;
    fetchWebContent?: WebFetcher;
};

export type CreateOpenWebSearchRuntimeOptions = {
    config?: AppConfig;
    dependencies?: RuntimeDependencies;
};

function createDefaultSearchExecutors(): SearchEngineExecutorMap {
    const executors: SearchEngineExecutorMap = {
        baidu: searchBaidu,
        bing: searchBing,
        linuxdo: searchLinuxDo,
        csdn: searchCsdn,
        duckduckgo: searchDuckDuckGo,
        exa: searchExa,
        brave: searchBrave,
        juejin: searchJuejin,
        startpage: searchStartpage
    };

    if (config.tavilyApiKey) {
        executors.tavily = searchTavily;
    }

    return executors;
}

export function createOpenWebSearchRuntime(options: CreateOpenWebSearchRuntimeOptions = {}): OpenWebSearchRuntime {
    const runtimeConfig = options.config ?? config;
    const dependencies = options.dependencies ?? {};
    const searchExecutors = dependencies.searchExecutors ?? createDefaultSearchExecutors();

    return {
        config: runtimeConfig,
        services: {
            search: createSearchService(searchExecutors),
            fetchLinuxDoArticle: createArticleFetchService('linuxdo', dependencies.fetchLinuxDoArticle ?? fetchLinuxDoArticle),
            fetchCsdnArticle: createArticleFetchService('csdn', dependencies.fetchCsdnArticle ?? fetchCsdnArticle),
            fetchJuejinArticle: createArticleFetchService('juejin', dependencies.fetchJuejinArticle ?? fetchJuejinArticle),
            fetchGithubReadme: createGithubReadmeService(dependencies.fetchGithubReadme ?? fetchGithubReadme),
            fetchWeb: createWebFetchService(dependencies.fetchWebContent ?? fetchWebContent)
        }
    };
}
