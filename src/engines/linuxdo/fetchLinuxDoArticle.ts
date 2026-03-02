import axios from 'axios';
import { JSDOM } from 'jsdom';
import { config } from '../../config.js';

export async function fetchLinuxDoArticle(url: string): Promise<{ content: string }> {
    // 同时支持 /topic/123 和 /t/slug/123 两种 URL 格式
    const match = url.match(/(?:\/topic\/|\/)t\/(?:[^\/]+\/)?(\d+)/) || url.match(/\/topic\/(\d+)/);
    const topicId = match ? match[1] : null;

    if (!topicId) {
        throw new Error('Invalid URL: Cannot extract topic ID.');
    }
    const apiUrl = `https://linux.do/t/${topicId}.json`;

    const response = await axios.get(apiUrl, {
        headers: {
            'accept': 'application/json',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        timeout: config.requestTimeout
    });

    const cookedHtml = response.data?.post_stream?.posts?.[0]?.cooked || '';
    const dom = new JSDOM(cookedHtml);
    const plainText = dom.window.document.body.textContent?.trim() || '';

    return { content: plainText };
}
