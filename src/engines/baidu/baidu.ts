import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { getSharedBrowser, destroySharedBrowser } from '../shared/browser.js';
import { config } from '../../config.js';

export async function searchBaidu(query: string, limit: number): Promise<SearchResult[]> {
    try {
        const browser = await getSharedBrowser();
        let allResults: SearchResult[] = [];
        let pn = 0;

        while (allResults.length < limit) {
            const page = await browser.newPage();

            const searchUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&pn=${pn}&ie=utf-8`;

            try {
                await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: config.requestTimeout });
            } catch (navErr: any) {
                // 百度可能在导航时销毁 iframe（如天气小组件），回退到 domcontentloaded
                if (navErr.message?.includes('frame was detached') || navErr.message?.includes('Navigating frame')) {
                    console.error('⚠️ Baidu frame detached during navigation, retrying with domcontentloaded...');
                    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: config.requestTimeout });
                } else {
                    throw navErr;
                }
            }
            await new Promise(r => setTimeout(r, 1000));

            const html = await page.content();
            await page.close();

            const $ = cheerio.load(html);

            // 检测百度安全验证页面
            const title = $('title').text();
            if (title.includes('安全验证')) {
                console.error('⚠️ Baidu security verification detected, no results for this page.');
                break;
            }

            const results: SearchResult[] = [];

            $('#content_left').children().each((i, element) => {
                const titleElement = $(element).find('h3');
                const linkElement = $(element).find('a');
                const snippetElement = $(element).find('.cos-row').first();

                if (titleElement.length && linkElement.length) {
                    const url = linkElement.attr('href');
                    if (url && url.startsWith('http')) {
                        const snippetElementBaidu = $(element).find('.c-font-normal.c-color-text').first();
                        const sourceElement = $(element).find('.cosc-source');
                        results.push({
                            title: titleElement.text(),
                            url: url,
                            description: snippetElementBaidu.attr('aria-label') || snippetElement.text().trim() || '',
                            source: sourceElement.text().trim() || '',
                            engine: 'baidu'
                        });
                    }
                }
            });

            allResults = allResults.concat(results);

            if (results.length === 0) {
                console.error('⚠️ No more results, ending early....');
                break;
            }

            pn += 10;
        }

        return allResults.slice(0, limit);
    } catch (err) {
        await destroySharedBrowser();
        throw err;
    }
}
