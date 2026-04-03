import { AppConfig } from '../config.js';
import { SearchExecutionInput, SearchExecutionResult } from '../core/search/searchService.js';
import { FetchWebContentResult } from '../engines/web/fetchWebContent.js';

export type SearchService = {
    execute(input: SearchExecutionInput): Promise<SearchExecutionResult>;
};

export type FetchArticleService = {
    execute(input: { url: string }): Promise<{ content: string }>;
};

export type GithubReadmeService = {
    execute(input: { url: string }): Promise<string | null>;
};

export type FetchWebService = {
    execute(input: { url: string; maxChars: number }): Promise<FetchWebContentResult>;
};

export type OpenWebSearchRuntimeServices = {
    search: SearchService;
    fetchLinuxDoArticle: FetchArticleService;
    fetchCsdnArticle: FetchArticleService;
    fetchJuejinArticle: FetchArticleService;
    fetchGithubReadme: GithubReadmeService;
    fetchWeb: FetchWebService;
};

export type OpenWebSearchRuntime = {
    config: AppConfig;
    services: OpenWebSearchRuntimeServices;
};
