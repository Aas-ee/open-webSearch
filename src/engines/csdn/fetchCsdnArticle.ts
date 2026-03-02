import axios from 'axios';
import * as cheerio from "cheerio";
import { config } from '../../config.js';

export async function fetchCsdnArticle(url: string): Promise<{ content: string }> {

    const response = await axios.get(url, {
        headers: {
            'Accept': '*/*',
            'Host': 'blog.csdn.net',
            'Connection': 'keep-alive',
            'Cookie': 'https_waf_cookie=771a8075-77ae-4b2cdf3bda08cd28ad372861867be773d8c1; uuid_tt_dd=10_20283045860-1751096847125-425142; dc_session_id=10_1751096847125.891975; waf_captcha_marker=318c5c7f316f665febdb746a58e039a681a94708df7a26376ed47720663cd99d',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
        },
        timeout: config.requestTimeout
    });

    const $ = cheerio.load(response.data);
    const plainText = $('#content_views').text()

    return { content: plainText };
}


