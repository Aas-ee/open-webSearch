import axios from 'axios';
import { JSDOM } from 'jsdom';
import { buildAxiosRequestOptions } from '../../utils/httpRequest.js';

export async function fetchLinuxDoArticle(url: string): Promise<{ content: string }> {
    const match = url.match(/\/topic\/(\d+)/);
    const topicId = match ? match[1] : null;

    if (!topicId) {
        throw new Error('Invalid URL: Cannot extract topic ID.');
    }
    const apiUrl = `https://linux.do/t/${topicId}.json`;

    const response = await axios.get(apiUrl, buildAxiosRequestOptions({
        headers: {
            'accept': 'application/json, text/javascript, */*; q=0.01',
            'accept-language': 'zh-CN,zh;q=0.9',
            'cache-control': 'no-cache',
            'discourse-track-view': 'true',
            'discourse-track-view-topic-id': `${topicId}`,
            'pragma': 'no-cache',
            'referer': 'https://linux.do/search',
            'sec-ch-ua': '"Chromium";v="112", "Google Chrome";v="112", "Not:A-Brand";v="99"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
            'x-csrf-token': 'K7YORqytPH8vZTM48iHLitfzv4NfU9GuiL1992MKuIBoviOCHyJk_w0LvTkfsX2bjn8ueXKzIGU8Uf8tzoxldg',
            'x-requested-with': 'XMLHttpRequest',
            'Cookie': '_ga=GA1.1.1014556084.1750571986; cf_clearance=OHwsuY8kOismHG8rBN1tCKczIEyTdoJrMPH65aPVUSI-1750571989-1.2.1.1-uJ4vrRUBXQtFG8Ws7JrPw0VNT8_YWVWOz1GSvHyAWTCUPPC8PNqnKApl9hVhLHHs4kB.sQ4B0V54VEwG.RT23ewifTx0rifGNIVItA1Tt5Sq1M78h7sqlwaW7p0vWYuAasaSwcZLKElbcwIxDGd4_EU44Lss.jIl0p9PYPa9QWlUCtbwHISkR8lt8zHtX_YIFrU25pjsHLkLqzYgk7mpmEwAaryi4wgxoc7R0u_FqP5kD1Fq4t559mXPdvj3H23004H12XYT95hHNudrfmHUbO6yLzrspsmV0rdUxJHLwCtI_0aK6JvrQNGJpU13_XS0Q8R_WKOLYrVgHLC_wmg_YOJJ2tMRkJFt_yV2pHV0JPLCvN5I986ooXiLXkVAWvNQ; __stripe_mid=45e0bc73-88a1-4392-9a8e-56b3ad60d5017557f5; __stripe_sid=23ed10a8-f6f4-4cd8-948b-386cb239067ad435dc; _ga_1X49KS6K0M=GS2.1.s1750571986$o1$g1$t1750571999$j47$l0$h1911122445',
            'Host': 'linux.do',
            'Connection': 'keep-alive'
        }
    }));

    const cookedHtml = response.data?.post_stream?.posts?.[0]?.cooked || '';
    const dom = new JSDOM(cookedHtml);
    const plainText = dom.window.document.body.textContent?.trim() || '';

    return { content: plainText };
}
