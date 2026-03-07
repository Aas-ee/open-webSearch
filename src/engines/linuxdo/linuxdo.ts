import axios from 'axios';
import {SearchResult} from '../../types.js';
import { config } from '../../config.js';
import {searchDuckDuckGo} from "../duckduckgo/index.js";
import {searchBrave} from "../brave/brave.js";
import * as cheerio from 'cheerio';

async function searchBingForLinuxDo(query: string, limit: number): Promise<SearchResult[]> {
    let allResults: SearchResult[] = [];
    let pn = 0;
    // Format query for URL
    const encodedQuery = encodeURIComponent(query);

    try {
        while (allResults.length < limit) {
            const response = await axios.get('https://cn.bing.com/search', {
                params: {
                    "q": query,
                    "qs": "n",
                    "sp": "-1",
                    "lq": "0",
                    "pq": query,
                    "sc": "1-26",
                    "sk": "",
                    "cvid": "83A1CA7981304D6D9DC6924C92C248C9",
                    "FPIG": "5A297328992C4FB8BEED24CB159DD092",
                    "first": 1 + pn * 10,
                    "FORM": "PERE",
                    "rdr": "1",
                    "rdrig": "5BE6670756A24EA5A4274EB2A47D978D"
                },
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36",
                    "Connection": "keep-alive",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
                    "Accept-Encoding": "gzip, deflate, br",
                    "ect": "4g",
                    "sec-ch-ua": "\"Chromium\";v=\"112\", \"Google Chrome\";v=\"112\", \"Not:A-Brand\";v=\"99\"",
                    "sec-ch-ua-mobile": "?0",
                    "sec-ch-ua-full-version": "\"112.0.5615.50\"",
                    "sec-ch-ua-arch": "\"x86\"",
                    "sec-ch-ua-platform": "\"Windows\"",
                    "sec-ch-ua-platform-version": "\"15.0.0\"",
                    "sec-ch-ua-model": "\"\"",
                    "sec-ch-ua-bitness": "\"64\"",
                    "sec-ch-ua-full-version-list": "\"Chromium\";v=\"112.0.5615.50\", \"Google Chrome\";v=\"112.0.5615.50\", \"Not:A-Brand\";v=\"99.0.0.0\"",
                    "upgrade-insecure-requests": "1",
                    "sec-fetch-site": "same-origin",
                    "sec-fetch-mode": "navigate",
                    "sec-fetch-dest": "document",
                    "referer": `https://cn.bing.com/search?q=${encodedQuery}&qs=n&sp=-1&lq=0&pq=${encodedQuery}&sc=1-26&sk=&cvid=83A1CA7981304D6D9DC6924C92C248C9&FPIG=5A297328992C4FB8BEED24CB159DD092&first=11&FORM=PERE`,
                    "accept-language": "zh-CN,zh;q=0.9",
                    "Cookie": "MUID=296FAEFA1CB065372DBFB8DB1D6264B0; MUIDB=296FAEFA1CB065372DBFB8DB1D6264B0; _EDGE_S=F=1&SID=063A15C99EE5624608BF03E89F3763A1; _EDGE_V=1; SRCHD=AF=NOFORM; SRCHUID=V=2&GUID=5C95B3592BB9427D94A15ACCB93B2998&dmnchg=1; _Rwho=u=d&ts=2025-07-06; ipv6=hit=1751775967739&t=4; USRLOC=HS=1&ELOC=LAT=23.0211181640625|LON=113.73304748535156|N=%E4%B8%9C%E8%8E%9E%E5%B8%82%EF%BC%8C%E5%B9%BF%E4%B8%9C%E7%9C%81|ELT=4|; BFPRResults=FirstPageUrls=B0D24EBFA8A0B66D6B071D854B69DC44%2C20426A336B6E4CF57DE0D0DD3484549D%2C9BF59C5A66BB498707BDEE26787183B3%2C4BD56F463CDE1E98954C975164097F6F%2C0F9C9A380F681662D573A082BEE6F471%2C8ED94F5FBF7A57786DE0FECB10C3D613%2C23FB8C1D9A41145741724F52CB242134%2CBD2D8F53469372B7D64F7AEF3D7F642D%2C6D9A9E581F375A9E57BF5A9599101CD5%2C8FC7081B6D04C85C644E9E41D523F4A0&FPIG=5A297328992C4FB8BEED24CB159DD092; SRCHUSR=DOB=20250706&DS=1; _RwBf=r=0&ilt=10&ihpd=0&ispd=10&rc=30&rb=0&rg=200&pc=27&mtu=0&rbb=0&clo=0&v=10&l=2025-07-05T07:00:00.0000000Z&lft=0001-01-01T00:00:00.0000000&aof=0&ard=0001-01-01T00:00:00.0000000&rwdbt=0&rwflt=0&rwaul2=0&g=&o=2&p=&c=&t=0&s=0001-01-01T00:00:00.0000000+00:00&ts=2025-07-06T04:16:43.3231859+00:00&rwred=0&wls=&wlb=&wle=&ccp=&cpt=&lka=0&lkt=0&aad=0&TH=&cid=0&gb=; _SS=SID=063A15C99EE5624608BF03E89F3763A1&R=30&RB=0&GB=0&RG=200&RP=27; SRCHHPGUSR=SRCHLANG=zh-Hans&PV=15.0.0&BZA=0&BRW=XW&BRH=M&CW=1707&CH=809&SCW=1691&SCH=1685&DPR=1.5&UTC=480&PRVCW=1707&PRVCH=809&HV=1751775699&HVE=CfDJ8Inh5QCoSQBNls38F2rbEpRMaCs0odiEKdnprhQV_w0a8_NuQurksG4JGF0rBdUFR2yGWPBo6wf3uOSO2p1l-Y8XcVCroAmqnrOsA1QCo3OSPJl7M38jS2gXSuJk8XX-qNBkwJmrKmfmGnVmG3kTuHL1a5gIpkLuYYB9-DlPnVHAE8tfBgro5p7vESusk8fsWA&EXLTT=11&DM=0"
                }
            });

            const $ = cheerio.load(response.data);
            const results: SearchResult[] = [];

            $('#b_content').children()
                .find('#b_results').children()
                .each((i, element) => {
                    const titleElement = $(element).find('h2');
                    const linkElement = $(element).find('a');
                    const snippetElement = $(element).find('p').first();

                    if (titleElement.length && linkElement.length) {
                        const url = linkElement.attr('href');
                        if (url && url.startsWith('http') && url.includes('linux.do')) {
                            const sourceElement = $(element).find('.b_tpcn');
                            results.push({
                                title: titleElement.text(),
                                url: url,
                                description: snippetElement.text().trim() || '',
                                source: 'linux.do',
                                engine: 'bing'
                            });
                        }
                    }
                });

            allResults = allResults.concat(results);

            if (results.length === 0) {
                console.error('⚠️ No more results from Bing, ending early....');
                break;
            }

            pn += 1;
        }

        return allResults.slice(0, limit);
    } catch (error: any) {
        console.error('❌ Bing search failed:', error.message || error);
        return [];
    }
}


export async function searchLinuxDo(query: string, limit: number): Promise<SearchResult[]> {

    console.error(`🔍 Searching linux.do with "${query}" using ${config.defaultSearchEngine} engine`);

    // Create the site-specific query
    const siteQuery = `site:linux.do ${query}`;

    let results: SearchResult[] = [];

    try {
        // Use the configured search engine
        if (config.defaultSearchEngine === 'duckduckgo') {
            results = await searchDuckDuckGo(siteQuery, limit);
        } else if (config.defaultSearchEngine === 'bing') {
            results = await searchBingForLinuxDo(siteQuery, limit);
        } else {
            // Use Brave which reliably supports site: operator
            results = await searchBrave(siteQuery, limit);
        }

        // If no results from configured engine, try Brave as fallback
        if (results.length === 0 && config.defaultSearchEngine !== 'brave') {
            console.error('🔄 No results from configured engine, falling back to Brave...');
            results = await searchBrave(siteQuery, limit);
        }

        // Filter results to ensure they're from linux.do (including subdomains)
        const filteredResults = results.filter(result => {
            try {
                const url = new URL(result.url);
                return url.hostname === 'linux.do' || url.hostname.endsWith('.linux.do');
            } catch {
                return false;
            }
        });

        // Update source to be consistent
        filteredResults.forEach(result => {
            result.source = 'linux.do';
            // Keep the original engine info
        });

        return filteredResults.slice(0, limit);
    } catch (error: any) {
        console.error(`❌ Linux.do search failed using ${config.defaultSearchEngine}:`, error.message || error);
        return [];
    }

}
