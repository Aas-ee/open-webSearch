import * as cheerio from 'cheerio';
import { looksLikeBotChallengePage } from '../../utils/browserCookies.js';
import { buildAxiosRequestOptions, requestWithSafeRedirects } from '../../utils/httpRequest.js';
import { fetchWithCookiesRaceViaPlaywright } from '../web/index.js';

function normalizeArticleText(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// 请求头保持普通即可：linux.do 的拦截发生在 Cloudflare 边缘（TLS 指纹 + JS 挑战），与请求头无关，反头伪装对过挑战没有作用。
function buildRequestOptions(): any {
    const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    };

    return buildAxiosRequestOptions({ headers });
}

function extractContentFromTopicJson(data: any): string {
    const cookedHtml = String(data?.post_stream?.posts?.[0]?.cooked || '');
    if (!cookedHtml) {
        return '';
    }
    // 与渲染路径保持一致：剥离 script/style/noscript 后提取纯文本，防止 cooked 中的脚本标签内容混入正文。
    const $ = cheerio.load(cookedHtml);
    $('script, style, noscript').remove();
    return normalizeArticleText($('body').text() || '');
}

function extractContentFromRenderedHtml(html: string): string {
    const $ = cheerio.load(html);
    $('script, style, noscript').remove();
    const cookedPosts = $('.cooked');
    if (cookedPosts.length > 0) {
        const text = cookedPosts.map((_index, element) => $(element).text()).get().join('\n\n');
        return normalizeArticleText(text);
    }

    // 浏览器直接访问 topic 的 .json 接口时，响应会以纯文本页面形式展示 JSON 原文；此时按 Discourse JSON 结构提取 cooked，而不是把整个 JSON 当成正文。
    const bodyText = ($('body').text() || '').trim();
    if (bodyText.startsWith('{')) {
        try {
            const jsonContent = extractContentFromTopicJson(JSON.parse(bodyText));
            if (jsonContent) {
                return jsonContent;
            }
        } catch {
            // 非合法 JSON，继续按普通 HTML 页面提取。
        }
    }

    const mainOutlet = $('#main-outlet');
    const fallbackText = mainOutlet.length > 0 ? mainOutlet.text() : bodyText;
    return normalizeArticleText(fallbackText || '');
}

function extractContentFromBrowserAssistedText(rawText: string): string {
    // 竞速层 HTTP 臂胜出时返回的是 topic JSON 原文，直接解析。
    try {
        const data = JSON.parse(rawText);
        const fromApi = extractContentFromTopicJson(data);
        if (fromApi) {
            return fromApi;
        }
    } catch {
        // 非合法 JSON，按渲染页面提取。
    }
    return extractContentFromRenderedHtml(rawText);
}

function isAntiBotResponseError(error: any): boolean {
    const status = error?.response?.status;
    return [401, 403, 429, 503].includes(status);
}

export async function fetchLinuxDoArticle(url: string): Promise<{ content: string }> {
    const match = url.match(/\/topic\/(\d+)/);
    const topicId = match ? match[1] : null;

    if (!topicId) {
        throw new Error('Invalid URL: Cannot extract topic ID.');
    }
    const apiUrl = `https://linux.do/t/${topicId}.json`;

    let content = '';
    let lastError: unknown;

    // 第一层：普通请求直取 Discourse JSON。
    try {
        const response = await requestWithSafeRedirects('GET', apiUrl, buildRequestOptions());
        content = extractContentFromTopicJson(response.data);
    } catch (error: any) {
        lastError = error;
        // 非反爬类失败（网络/DNS/真实拒绝等）换任何栈也救不回来，原样上抛。
        if (!isAntiBotResponseError(error)) {
            throw error;
        }
        console.error(`fetchLinuxDoArticle: direct API request blocked (status ${error?.response?.status}), falling back to the browser race mode`);
    }

    if (!content) {
        // 第二、三层：复用 fetchWebContent 的竞速模式——浏览器只导航一次，页面 Cookie + HTTP 请求与页面渲染并行竞速。实测 linux.do 的 Cloudflare Cookie 与 TLS 指纹绑定，HTTP 臂被拒时由渲染臂拿回正文（浏览器直接访问 .json 接口，响应以纯文本页形式展示）。
        try {
            const raceResult = await fetchWithCookiesRaceViaPlaywright(apiUrl);
            const raceContent = extractContentFromBrowserAssistedText(raceResult.raw);
            // 浏览器可能停在挑战页而未真正进入正文：与 CSDN 路径同款判定，命中挑战页特征且提取文本过短时视为未拿到内容，最终按失败上抛，避免把挑战页文案当文章返回。
            content = (looksLikeBotChallengePage(raceResult.raw) && raceContent.length < 200) ? '' : raceContent;
        } catch (error) {
            lastError = error;
        }
    }

    if (!content) {
        if (lastError instanceof Error) {
            throw lastError;
        }
        throw new Error('Failed to extract readable linux.do article content');
    }

    return { content };
}
