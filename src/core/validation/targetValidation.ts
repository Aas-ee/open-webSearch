import { isPublicHttpUrl } from '../../utils/urlSafety.js';

export function validateArticleUrl(url: string, type: 'linuxdo' | 'csdn' | 'juejin'): boolean {
    try {
        const urlObj = new URL(url);

        switch (type) {
            case 'linuxdo':
                return urlObj.hostname === 'linux.do' && url.includes('.json');
            case 'csdn':
                return urlObj.hostname === 'blog.csdn.net' && url.includes('/article/details/');
            case 'juejin':
                return urlObj.hostname === 'juejin.cn' && url.includes('/post/');
            default:
                return false;
        }
    } catch {
        return false;
    }
}

export function validateGithubRepositoryUrl(url: string): boolean {
    try {
        const trimmedUrl = url.trim();

        if (/^git@github\.com:/.test(trimmedUrl)) {
            return /^git@github\.com:[^\/]+\/[^\/]+/.test(trimmedUrl);
        }

        const urlObj = new URL(trimmedUrl);
        const isHttpsGithub = urlObj.hostname === 'github.com' || urlObj.hostname === 'www.github.com';
        if (!isHttpsGithub) {
            return false;
        }

        const pathParts = urlObj.pathname.split('/').filter((part) => part.length > 0);
        return pathParts.length >= 2;
    } catch {
        return false;
    }
}

export function validatePublicWebUrl(url: string): boolean {
    return isPublicHttpUrl(url);
}
