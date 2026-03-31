import axios from 'axios';
import * as cheerio from 'cheerio';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';

export async function fetchJuejinArticle(url: string): Promise<{ content: string }> {
    try {
        console.error(`🔍 Fetching Juejin article: ${url}`);

        const response = await axios.get(url, buildAxiosRequestOptions({
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
                'Connection': 'keep-alive',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Encoding': 'gzip, deflate, br, zstd',
                'pragma': 'no-cache',
                'cache-control': 'no-cache',
                'upgrade-insecure-requests': '1',
                'sec-fetch-site': 'none',
                'sec-fetch-mode': 'navigate',
                'sec-fetch-user': '?1',
                'sec-fetch-dest': 'document',
                'accept-language': 'zh-CN,zh;q=0.9',
                'priority': 'u=0, i'
            },
            timeout: 30000,
            decompress: true
        }));

        const $ = cheerio.load(response.data);

        // 掘金文章内容的可能选择器（按优先级排序）
        const selectors = [
            '.markdown-body',
            '.article-content',
            '.content',
            '[data-v-md-editor-preview]',
            '.bytemd-preview',
            '.article-area .content',
            '.main-area .article-area',
            '.article-wrapper .content'
        ];

        let content = '';

        // 尝试多个选择器
        for (const selector of selectors) {
            console.error(`🔍 Trying selector: ${selector}`);
            const element = $(selector);
            if (element.length > 0) {
                console.error(`✅ Found content with selector: ${selector}`);
                // 移除脚本和样式标签
                element.find('script, style, .code-block-extension, .hljs-ln-numbers').remove();
                content = element.text().trim();

                if (content.length > 100) { // 确保内容足够长
                    break;
                }
            }
        }

        // 如果所有选择器都失败，尝试提取页面主要文本内容
        if (!content || content.length < 100) {
            console.error('⚠️ All selectors failed, trying fallback extraction');
            $('script, style, nav, header, footer, .sidebar, .comment').remove();
            content = $('body').text().trim();
        }

        console.error(`✅ Successfully extracted ${content.length} characters`);
        return { content };

    } catch (error) {
        console.error('❌ 获取掘金文章失败:', error);
        throw new Error(`获取掘金文章失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
}
