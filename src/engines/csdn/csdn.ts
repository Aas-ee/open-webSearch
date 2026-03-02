import axios from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { config } from '../../config.js';

export async function searchCsdn(query: string, limit: number): Promise<SearchResult[]> {
    let allResults: SearchResult[] = [];
    let pn = 1;

    while (allResults.length < limit) {
        const response = await axios.get('https://so.csdn.net/api/v3/search', {
            timeout: config.requestTimeout,
            params: {
                q: query,
                p: pn
            },
            headers: {
                'Pragma': 'no-cache',
                'Cookie': 'uuid_tt_dd=10_20283040220-1750745713898-623562; dc_session_id=10_1750745713898.508399; dc_sid=0aa6fae5250c4389fac68320b1cb43b2; waf_captcha_marker=1b4e9099857d7aedf0941f03fa70bfb22ea2153f7fa053b8101ed28dc1504b11; c_pref=default; c_ref=default; fid=20_93458541565-1750745714849-027048; c_first_ref=default; c_first_page=https%3A//so.csdn.net/so/search%3Fq%3Dweb%2520search%2520mcp; c_dsid=11_1750745714849.980720; c_segment=10; c_page_id=default; creative_btn_mp=1; log_Id_view=9; fe_request_id=1750745715289_2973_2073791; dc_tos=syck1f; log_Id_pv=1; log_Id_click=1; uuid_tt_dd=10_20283045860-1751096847125-425142; dc_session_id=10_1751096847125.891975',
                'User-Agent': 'Apifox/1.0.0 (https://apifox.com)',
                'Accept': '*/*',
                'Host': 'so.csdn.net',
                'Connection': 'keep-alive'
            }
        });

        const { result_vos } = response.data

        if (!Array.isArray(result_vos)) {
            break
        }

        const results: SearchResult[] = [];


        result_vos.forEach(re => {

            const { digest, title, url_location,nickname } = re

            results.push ({
                title: title,
                url: url_location,
                description: digest || '',
                source: nickname,
                engine: "csdn"
            });
        });

        allResults = allResults.concat(results);

        if (results.length === 0) {
            console.error('⚠️ No more results, ending early....');
            break;
        }

        pn += 1;
    }

    return allResults.slice(0, limit); // 截取最多 limit 个
}
