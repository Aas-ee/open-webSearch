import { __buildBingNewsFallbackUrlForTests, __buildBingNewsUrlForTests } from '../engines/bing/bing.js';
import { parseBingNewsResults } from '../engines/bing/newsParser.js';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
}

function testNewsUrlUsesFreshnessSorting(): void {
    const url = new URL(__buildBingNewsUrlForTests('art design exhibition'));
    assertEqual(url.origin + url.pathname, 'https://cn.bing.com/news/search', 'news endpoint');
    assertEqual(url.searchParams.get('q'), 'art design exhibition', 'news query');
    assertEqual(url.searchParams.get('qft'), 'sortbydate="1"', 'freshness sort');
    console.log('✅ Bing News URL uses the news vertical and freshness sorting');
}

function testNewsFallbackUsesRecentWebResults(): void {
    const url = new URL(__buildBingNewsFallbackUrlForTests('art design exhibition'));
    assertEqual(url.origin + url.pathname, 'https://cn.bing.com/search', 'fallback endpoint');
    assertEqual(url.searchParams.get('q'), 'art design exhibition', 'fallback query');
    assertEqual(url.searchParams.get('setlang'), 'en-US', 'fallback language');
    assertEqual(url.searchParams.get('ensearch'), '1', 'fallback English search mode');
    assertEqual(url.searchParams.get('filters'), 'ex1:"ez2"', 'fallback freshness filter');
    console.log('✅ Bing News fallback uses freshness-filtered web results');
}

function testNewsParserExtractsDirectArticles(): void {
    const html = `
        <div class="news-card" data-url="https://news.example.com/art/2026/exhibition" data-title="New Art Exhibition Opens" data-author="Example News">
            <div class="source"><a aria-label="Search news from Example News">Example News</a><span aria-label="6 hours ago"></span></div>
            <a class="title" href="https://news.example.com/art/2026/exhibition"><h2>New Art Exhibition Opens</h2></a>
            <div class="snippet" title="A new design exhibition opened today."></div>
        </div>
        <div class="news-card" data-url="https://www.bing.com/news/apiclick.aspx?id=1" data-title="Internal redirect"></div>
        <div class="news-card" data-url="https://news.example.com/art/2026/exhibition" data-title="Duplicate"></div>
    `;
    const results = parseBingNewsResults(html, 5);
    assertEqual(results.length, 1, 'result count');
    assertEqual(results[0].title, 'New Art Exhibition Opens', 'title');
    assertEqual(results[0].url, 'https://news.example.com/art/2026/exhibition', 'direct article URL');
    assertEqual(results[0].description, 'A new design exhibition opened today.', 'description');
    assertEqual(results[0].source, 'Example News', 'source');
    assertEqual(results[0].dateText, '6 hours ago', 'publication evidence');
    assertEqual(results[0].engine, 'bing', 'engine');
    assert(!results.some((result) => result.url.includes('bing.com')), 'Bing redirects must not be returned');
    console.log('✅ Bing News parser extracts direct, dated article results');
}

testNewsUrlUsesFreshnessSorting();
testNewsFallbackUsesRecentWebResults();
testNewsParserExtractsDirectArticles();
