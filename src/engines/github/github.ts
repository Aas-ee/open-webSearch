import axios from 'axios';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';

// Avoid the GitHub README API here because anonymous API requests in this
// environment hit rate limits quickly; raw URLs are more stable for this tool.
const README_CANDIDATES = [
    'README.md',
    'README.mdx',
    'README.markdown',
    'README',
    'README.txt',
    'readme.md',
    'readme.mdx',
    'readme.markdown',
    'readme',
    'readme.txt'
];

/**
 * GitHub README Fetcher - Extract repo info from URLs and fetch README content
 */

/**
 * Extract owner and repo name from GitHub URLs
 * Supports HTTPS, SSH, and URLs with query params/fragments
 * @param url GitHub repository URL
 * @returns {owner, repo} object or null if invalid
 */
function extractOwnerAndRepo(url: string): { owner: string; repo: string } | null {
    try {
        const trimmedUrl = url.trim();

        // Regex patterns for HTTPS and SSH URLs
        const patterns = [
            /(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+)/i,
            /git@github\.com:([^\/\s]+)\/([^\/\s]+)\.git/i
        ];

        for (const pattern of patterns) {
            const match = trimmedUrl.match(pattern);
            if (match) {
                const [, owner, rawRepo] = match;

                // Clean repo name: remove query params, fragments, .git suffix, paths
                const repo = rawRepo.replace(/(?:[?#].*$|\.git$|\/.*$)/g, '');
                if (owner && repo && owner.length > 0 && repo.length > 0) {
                    return { owner: owner.trim(), repo: repo.trim() };
                }
            }
        }

        return null;
    } catch (error) {
        console.warn('Failed to parse GitHub URL:', url, error);
        return null;
    }
}

/**
 * Fetch README content from GitHub repository raw URLs
 * @param owner Repository owner (username or org)
 * @param repo Repository name
 * @returns README content string or null if failed
 */
async function fetchReadme(owner: string, repo: string): Promise<string | null> {
    if (!owner?.trim() || !repo?.trim()) {
        console.error('Invalid owner or repo name provided');
        return null;
    }

    let sawFetchFailure = false;

    for (const readmeFile of README_CANDIDATES) {
        const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/HEAD/${readmeFile}`;

        try {
            console.error(`Fetching README from: ${rawUrl}`);

            const response = await axios.get(rawUrl, {
                ...buildAxiosRequestOptions({
                    headers: {
                        'User-Agent': 'GitHub-README-Fetcher/1.0'
                    },
                    timeout: 10000,
                    responseType: 'text',
                    validateStatus: (status) => status === 200 || status === 404
                })
            });

            if (response.status === 404) {
                continue;
            }

            if (typeof response.data === 'string' && response.data.trim()) {
                return response.data;
            }

            sawFetchFailure = true;
            console.warn(`Empty or invalid README content for ${owner}/${repo} at ${readmeFile}`);
        } catch (error: any) {
            const isTimeout = error?.code === 'ECONNABORTED';
            const status = typeof error?.response?.status === 'number' ? error.response.status : undefined;
            const message = error instanceof Error ? error.message : String(error);

            if (isTimeout) {
                console.error(`Timeout fetching README for ${owner}/${repo} at ${readmeFile}`);
            } else if (status !== undefined) {
                console.error(`Failed to fetch README for ${owner}/${repo} at ${readmeFile} (HTTP ${status}):`, message);
            } else {
                console.error(`Network error fetching README for ${owner}/${repo} at ${readmeFile}:`, message);
            }

            // Short-circuit on request failures that are unlikely to improve on later candidates.
            return null;
        }
    }

    if (sawFetchFailure) {
        console.warn(`Failed to fetch README for ${owner}/${repo}`);
    } else {
        console.warn(`README not found for ${owner}/${repo}`);
    }

    return null;
}

/**
 * Main function: parse URL and fetch README content
 * @param githubUrl GitHub repository URL
 * @returns README content or null if failed
 */
async function getReadmeFromUrl(githubUrl: string): Promise<string | null> {
    console.error(`\n--- Processing URL: ${githubUrl} ---`);

    if (!githubUrl?.trim()) {
        console.error('Invalid URL provided');
        return null;
    }

    const repoInfo = extractOwnerAndRepo(githubUrl);

    if (!repoInfo) {
        console.error(`Unable to extract owner and repo from URL: ${githubUrl}`);
        return null;
    }

    console.error(`✅ Extraction successful: ${repoInfo.owner}/${repoInfo.repo}`);

    const content = await fetchReadme(repoInfo.owner, repoInfo.repo);

    if (content) {
        console.error(`✅ README fetched successfully (${content.length} characters)`);
        return content;
    } else {
        console.warn(`❌ Failed to fetch README for ${repoInfo.owner}/${repoInfo.repo}`);
        return null;
    }
}

/**
 * Fetch README content from GitHub repository
 * @param githubUrl GitHub repository URL (supports HTTPS, SSH, with params)
 * @returns README content string or null if failed
 */
export async function fetchGithubReadme(githubUrl: string): Promise<string | null> {
    return getReadmeFromUrl(githubUrl);
}
