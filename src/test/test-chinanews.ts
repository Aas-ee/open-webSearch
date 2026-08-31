import assert from 'node:assert/strict';
import { createChinaNewsSearch, parseChinaNewsFeed } from '../engines/chinanews/chinanews.js';
import { createOpenWebSearchRuntime } from '../runtime/createRuntime.js';
import { config } from '../config.js';

const now = new Date('2026-08-31T12:00:00Z');
const articleURL = 'https://www.chinanews.com.cn/cul/2026/08-31/10000001.shtml';
function item(title: string, url = articleURL, date = 'Mon, 31 Aug 2026 18:00:00 +0800'): string {
    return `<item><title><![CDATA[${title}]]></title><link>${url}</link><pubDate>${date}</pubDate><description><![CDATA[<p>电影产业新消息。</p><script>untrusted()</script>]]></description></item>`;
}
const rss = (...items: string[]) => `<rss version="2.0"><channel><title>中新网文化新闻</title>${items.join('')}</channel></rss>`;

function testPublicationEvidenceAndSafety(): void {
    const results = parseChinaNewsFeed(rss(
        item('暑期电影票房增长'), item('duplicate'),
        item('future', articleURL + '?future', 'Tue, 01 Sep 2026 18:00:00 +0800'),
        item('old', articleURL + '?old', 'Mon, 24 Aug 2026 18:00:00 +0800'),
        item('missing date', articleURL + '?missing', ''),
        item('private', 'http://127.0.0.1/private/10000002.shtml'),
        item('credentials', 'https://user:password@www.chinanews.com.cn/cul/10000002.shtml'),
        item('other host', 'https://www.chinanews.com.cn.evil.test/10000002.shtml'),
        item('portal', 'https://www.chinanews.com.cn/browse/2026/08/31/culture-news.html'),
        item('category', 'https://www.chinanews.com.cn/category/2026/08/31/culture-news.html'),
        item('encoded category', 'https://www.chinanews.com.cn/%63ategories/2026/08/31/culture-news.html')
    ), now);
    assert.equal(results.length, 1);
    assert.equal(results[0].publishedAt, '2026-08-31T10:00:00.000Z');
    assert.equal(results[0].engine, 'chinanews');
    assert.equal(results[0].description, '电影产业新消息。');
    assert.throws(() => parseChinaNewsFeed('<html>unavailable</html>', now), /invalid RSS/);
    assert.deepEqual(parseChinaNewsFeed(rss(), now), []);
}

async function testTopicSelectionAndCache(): Promise<void> {
    const calls: string[] = [];
    let clock = now;
    const search = createChinaNewsSearch({ now: () => clock, loadFeed: async url => {
        calls.push(url);
        return rss(item('电影上映'), item('图书出版', articleURL + '?book'));
    } });
    const [films, books] = await Promise.all([
        search('Film and cinema industry news 2026-08-30', 10),
        search('Literature books and publishing news 2026-08-30', 10)
    ]);
    assert.equal(films.length, 2); // Both descriptions mention film.
    assert.equal(books.length, 1);
    assert.equal(calls.length, 1, 'same public feed must coalesce concurrent queries');
    assert.equal(calls[0], 'https://www.chinanews.com.cn/rss/culture.xml');
    assert(!calls[0].includes('2026-08-30'), 'query text must not leave the process');
    assert.deepEqual(await search('unmapped-private-interest', 10), []);
    assert.equal(calls.length, 1);
    assert.equal((await search('film', 1)).length, 1);
    clock = new Date(now.getTime() + 61_000);
    await search('film', 1);
    assert.equal(calls.length, 2, 'expired cache must refresh');
}

async function testFailuresAreNotSilentlyEmptyOrCached(): Promise<void> {
    let calls = 0;
    const search = createChinaNewsSearch({ now: () => now, loadFeed: async () => {
        if (++calls === 1) throw new Error('network failure');
        return rss(item('电影上映'));
    } });
    await assert.rejects(search('film', 10), /unavailable/);
    assert.equal((await search('film', 10)).length, 1);
    assert.equal(calls, 2);
    const partial = createChinaNewsSearch({ now: () => now, loadFeed: async url => {
        if (url.endsWith('/life.xml')) throw new Error('network failure');
        return rss(item('心理健康研究'));
    } });
    assert.equal((await partial('psychology wellbeing', 10)).length, 1);
}

async function testFallbackRespectsAllowedEngines(): Promise<void> {
    for (const allowed of [['bing'], ['bing', 'chinanews']]) {
        let fallbackCalls = 0;
        const runtime = createOpenWebSearchRuntime({
            config: { ...config, allowedSearchEngines: allowed, defaultSearchEngine: 'bing' },
            dependencies: { searchExecutors: {
                bing: async () => [{ title: 'History Portal | Britannica', url: 'https://www.britannica.com/browse/World-History', description: '', source: 'Britannica', engine: 'bing', publishedAt: now.toISOString() }],
                chinanews: async () => { fallbackCalls++; return parseChinaNewsFeed(rss(item('电影上映')), now); }
            } },
            searchServiceOptions: { now: () => now }
        });
        const result = await runtime.services.search.execute({ query: 'film news', engines: ['bing'], limit: 10, vertical: 'news' });
        assert.equal(result.newsDiagnostics?.rejectedResults, 1);
        assert.equal(fallbackCalls, allowed.includes('chinanews') ? 1 : 0);
        assert.equal(result.totalResults, fallbackCalls);
        if (fallbackCalls) {
            assert.equal(result.results[0].engine, 'chinanews');
            assert.equal(result.retrievalMode, 'news_fallback');
        }
    }
}

testPublicationEvidenceAndSafety();
await testTopicSelectionAndCache();
await testFailuresAreNotSilentlyEmptyOrCached();
await testFallbackRespectsAllowedEngines();
console.log('✅ China News: original timestamps/URLs, topic filtering, cache, failures, and allowed fallback');
