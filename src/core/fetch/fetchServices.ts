import { FetchWebContentOptions, FetchWebContentResult } from '../../engines/web/fetchWebContent.js';
import {
    validateArticleUrl,
    validateGithubRepositoryUrl,
    validatePublicWebUrl
} from '../validation/targetValidation.js';

export type ArticleFetcher = (url: string) => Promise<{ content: string }>;
export type GithubReadmeFetcher = (url: string) => Promise<string | null>;
export type WebFetcher = (url: string, maxChars: number, options?: FetchWebContentOptions) => Promise<FetchWebContentResult>;

export function createArticleFetchService(
    type: 'linuxdo' | 'csdn' | 'juejin',
    fetcher: ArticleFetcher
) {
    return {
        async execute({ url }: { url: string }): Promise<{ content: string }> {
            if (!validateArticleUrl(url, type)) {
                throw new Error(`Invalid ${type} article URL`);
            }

            return fetcher(url);
        }
    };
}

export function createGithubReadmeService(fetcher: GithubReadmeFetcher) {
    return {
        async execute({ url }: { url: string }): Promise<string | null> {
            if (!validateGithubRepositoryUrl(url)) {
                throw new Error('Invalid GitHub repository URL');
            }

            return fetcher(url);
        }
    };
}

export function createWebFetchService(fetcher: WebFetcher) {
    return {
        async execute({
            url,
            maxChars,
            readability,
            includeLinks
        }: {
            url: string;
            maxChars: number;
            readability?: boolean;
            includeLinks?: boolean;
        }): Promise<FetchWebContentResult> {
            if (!validatePublicWebUrl(url)) {
                throw new Error('Invalid public HTTP(S) URL');
            }

            return fetcher(url, maxChars, { readability, includeLinks });
        }
    };
}
