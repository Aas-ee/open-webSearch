import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { getSharedBrowser, destroySharedBrowser } from '../shared/browser.js';
import { config } from '../../config.js';

/**
 * 解码 Bing 重定向 URL，提取实际目标地址。
 * Bing URL 格式: https://www.bing.com/ck/a?...&u=a1<Base64编码的URL>
 * 参数 'u' 的值以 'a1' 开头，后接 Base64 编码的原始 URL。
 */
function decodeBingUrl(bingUrl: string): string {
    try {
        const url = new URL(bingUrl);
        const encodedUrl = url.searchParams.get('u');
        if (!encodedUrl) {
            return bingUrl;
        }
        const base64Part = encodedUrl.substring(2);
        const decodedUrl = Buffer.from(base64Part, 'base64').toString('utf-8');
        if (decodedUrl.startsWith('http')) {
            return decodedUrl;
        }
        return bingUrl;
    } catch {
        return bingUrl;
    }
}

function parsePageResults(html: string): SearchResult[] {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    $('#b_results h2').each((i, element) => {
        const linkElement = $(element).find('a').first();
        if (linkElement.length) {
            const rawUrl = linkElement.attr('href');
            if (rawUrl && rawUrl.startsWith('http')) {
                const url = decodeBingUrl(rawUrl);
                const parentLi = $(element).closest('li');
                const snippetElement = parentLi.find('p').first();
                const sourceElement = parentLi.find('.b_tpcn');
                results.push({
                    title: linkElement.text().trim(),
                    url: url,
                    description: snippetElement.text().trim() || '',
                    source: sourceElement.text().trim() || '',
                    engine: 'bing'
                });
            }
        }
    });
    return results;
}

export async function searchBing(query: string, limit: number): Promise<SearchResult[]> {
    try {
        const browser = await getSharedBrowser();
        const page = await browser.newPage();

        try {
            const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
            await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: config.requestTimeout });

            // cn.bing.com 等本地化版本可能异步渲染搜索结果，
            // networkidle2 无法保证 DOM 已就绪，需要显式等待结果选择器。
            try {
                await page.waitForSelector('#b_results .b_algo', { timeout: 10000 });
            } catch {
                // 可能确实没有结果，或者 Bing 使用了不同的页面结构，继续尝试解析
                console.warn('[bing] 等待搜索结果选择器 #b_results .b_algo 超时，页面 URL:', page.url());
            }

            let allResults = parsePageResults(await page.content());

            // 如果首次解析为空，可能是异步渲染还没完成（cn.bing.com 特有的延迟），
            // 或者出现了 cookie 同意弹窗等遮挡，尝试再等待一次。
            if (allResults.length === 0) {
                console.warn('[bing] 首次解析返回 0 条结果，等待 3 秒后重试...');
                await new Promise(r => setTimeout(r, 3000));
                allResults = parsePageResults(await page.content());
            }

            while (allResults.length < limit) {
                const nextLink = await page.$('.sb_pagN');
                if (!nextLink) break;
                // Bing 翻页可能用完整导航或 AJAX，两种方式都要兼容
                const navPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: config.requestTimeout }).catch(() => {});
                await nextLink.click();
                await navPromise;
                try {
                    await page.waitForSelector('#b_results .b_algo', { timeout: 10000 });
                } catch {
                    // 翻页后如果超时，继续尝试解析
                }
                const pageResults = parsePageResults(await page.content());
                if (pageResults.length === 0) break;
                allResults = allResults.concat(pageResults);
            }

            const finalResults = allResults.slice(0, limit);
            if (finalResults.length === 0) {
                const finalUrl = page.url();
                console.warn(`[bing] 搜索返回 0 条结果。最终 URL: ${finalUrl}。页面可能出现了验证码、Cookie 同意弹窗，或 HTML 结构已变更。`);
            }
            return finalResults;
        } finally {
            await page.close();
        }
    } catch (err) {
        await destroySharedBrowser();
        throw err;
    }
}
