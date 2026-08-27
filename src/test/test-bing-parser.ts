import { hasSiteOperator, shouldSuggestRemovingSiteOperator } from '../engines/bing/bing.js';
import { parseBingSearchResults } from '../engines/bing/parser.js';

function assert(condition: unknown, message: string): void {
    if (!condition) {
        throw new Error(message);
    }
}

const classicHtml = `
<div id="b_content">
  <ol id="b_results">
    <li class="b_algo">
      <h2><a href="https://example.com/article?utm_source=bing">Example Result</a></h2>
      <div class="b_caption"><p>Classic Bing result snippet.</p></div>
      <div class="b_attribution"><cite>example.com</cite></div>
      <time datetime="2026-08-18T08:30:00+08:00">2026年8月18日</time>
    </li>
  </ol>
</div>`;

const modernHtml = `
<ol id="b_results">
  <li class="b_algo">
    <div class="b_tpcn">
      <a class="tilk" href="https://docs.example.org/guide"><span class="tptt">Docs Guide</span></a>
    </div>
    <div class="b_snippet">Modern Bing layout snippet.</div>
  </li>
</ol>`;

const fallbackHtml = `
<div id="b_results">
  <div class="b_algo">
    <a href="https://fallback.example.dev/path">Fallback title</a>
  </div>
</div>`;

const classicResults = parseBingSearchResults(classicHtml, 5);
assert(classicResults.length === 1, 'classic layout should yield one result');
assert(classicResults[0].title === 'Example Result', 'classic layout title should parse');
assert(classicResults[0].url === 'https://example.com/article', 'tracking params should be stripped');
assert(classicResults[0].description.includes('Classic Bing result snippet'), 'classic layout snippet should parse');
assert(classicResults[0].dateText === '2026年8月18日', 'explicit result date text should be preserved');
assert(classicResults[0].publishedAt === '2026-08-18T00:30:00.000Z', 'zoned machine date should be normalized to UTC');

const modernResults = parseBingSearchResults(modernHtml, 5);
assert(modernResults.length === 1, 'modern layout should yield one result');
assert(modernResults[0].title === 'Docs Guide', 'modern layout title should parse');
assert(modernResults[0].url === 'https://docs.example.org/guide', 'modern layout url should parse');
assert(modernResults[0].dateText === undefined, 'missing result date should stay absent');
assert(modernResults[0].publishedAt === undefined, 'missing machine date should not be fabricated');

const relativeDateHtml = `
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="https://news.example.net/story">Recent story</a></h2>
    <div class="b_caption"><p>Recent story snippet.</p></div>
    <span class="b_age">3 hours ago</span>
  </li>
</ol>`;
const relativeDateResults = parseBingSearchResults(relativeDateHtml, 5);
assert(relativeDateResults[0].dateText === '3 hours ago', 'relative date text should be preserved verbatim');
assert(relativeDateResults[0].publishedAt === undefined, 'relative date text should not be guessed into publishedAt');

const descriptionDatePrefixHtml = `
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="https://news.example.net/chinese-date">Chinese date</a></h2>
    <div class="b_caption"><p>2025年10月9日 · Chinese absolute date.</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://news.example.net/iso-date">ISO date</a></h2>
    <div class="b_caption"><p>2026-08-17 • ISO absolute date.</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://news.example.net/relative-date">Relative date</a></h2>
    <div class="b_caption"><p>6 天之前 · Relative date.</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://news.example.net/relative-english">Relative English date</a></h2>
    <div class="b_caption"><p>20 minutes ago • Relative English date.</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://news.example.net/history">History in body</a></h2>
    <div class="b_caption"><p>The article discusses an event from 2024年3月13日 · not publication metadata.</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://news.example.net/no-separator">No separator</a></h2>
    <div class="b_caption"><p>2026年8月18日 This lacks the required delimiter.</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://news.example.net/year-in-title">2026 annual report</a></h2>
    <div class="b_caption"><p>No publication date in this snippet.</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://news.example.net/invalid-date">Invalid date</a></h2>
    <div class="b_caption"><p>2025年2月29日 · Invalid dates remain auditable text only.</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://news.example.net/long-snippet">Long snippet</a></h2>
    <div class="b_caption"><p>2026年8月17日 · ${'x'.repeat(1000)}</p></div>
  </li>
</ol>`;
const descriptionDatePrefixResults = parseBingSearchResults(descriptionDatePrefixHtml, 20);
const findPrefixResult = (path: string) => descriptionDatePrefixResults.find((item) => item.url.includes(path));
assert(findPrefixResult('/chinese-date')?.dateText === '2025年10月9日', 'Chinese date prefix should be preserved');
assert(findPrefixResult('/iso-date')?.dateText === '2026-08-17', 'ISO date prefix should be preserved');
assert(findPrefixResult('/relative-date')?.dateText === '6 天之前', 'Chinese relative prefix should be preserved');
assert(findPrefixResult('/relative-english')?.dateText === '20 minutes ago', 'English relative prefix should be preserved');
assert(findPrefixResult('/history')?.dateText === undefined, 'date in snippet body should not be extracted');
assert(findPrefixResult('/no-separator')?.dateText === undefined, 'date prefix without delimiter should not be extracted');
assert(findPrefixResult('/year-in-title')?.dateText === undefined, 'year in title should not be extracted');
assert(findPrefixResult('/invalid-date')?.dateText === '2025年2月29日', 'invalid but explicit date text should remain auditable');
assert(findPrefixResult('/long-snippet')?.dateText === '2026年8月17日', 'long snippet should preserve its leading date');
assert((findPrefixResult('/long-snippet')?.description.length ?? 0) <= 400, 'long snippet should remain bounded');
assert(descriptionDatePrefixResults.every((item) => item.publishedAt === undefined), 'description prefixes need the shared retrieval clock before publication normalization');

const fallbackResults = parseBingSearchResults(fallbackHtml, 5);
assert(fallbackResults.length === 1, 'fallback layout should yield one result');
assert(fallbackResults[0].title === 'Fallback title', 'fallback link title should parse');
assert(fallbackResults[0].url === 'https://fallback.example.dev/path', 'fallback link url should parse');

assert(hasSiteOperator('site:blink.new blink.new') === true, 'site operator should be detected');
assert(hasSiteOperator('blink.new AI App Builder') === false, 'plain query should not be treated as site-restricted');
assert(
    shouldSuggestRemovingSiteOperator(
        'site:blink.new blink.new',
        new Error('page.waitForSelector: Timeout 15000ms exceeded.')
    ) === true,
    'site-restricted timeout should suggest removing site operator'
);
assert(
    shouldSuggestRemovingSiteOperator(
        'blink.new AI App Builder',
        new Error('page.waitForSelector: Timeout 15000ms exceeded.')
    ) === false,
    'plain timeout should not suggest removing site operator'
);
// /ck/a 跳转链接解析测试
const ckRedirectHtml = `
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="https://www.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from('https://real-target.example.com/page').toString('base64url')}&ntb=1">CK Redirect Result</a></h2>
    <div class="b_caption"><p>Result behind /ck/a redirect.</p></div>
  </li>
</ol>`;
const ckResults = parseBingSearchResults(ckRedirectHtml, 5);
assert(ckResults.length === 1, '/ck/a redirect should yield one result');
assert(ckResults[0].url === 'https://real-target.example.com/page', '/ck/a redirect target should be decoded from base64url u param');
assert(ckResults[0].title === 'CK Redirect Result', '/ck/a result title should parse');

// 固定相对 /ck/a 的当前行为：这类链接没有可信 origin，上游解析器会按 Bing 内部跳转丢弃，避免返回不可点击的相对 URL。
const relativeCkRedirectHtml = `
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="/ck/a?!&&p=abc&u=a1${Buffer.from('https://relative-target.example.com/page').toString('base64url')}&ntb=1">Relative CK Redirect Result</a></h2>
    <div class="b_caption"><p>Relative /ck/a redirect should be ignored.</p></div>
  </li>
</ol>`;
const relativeCkResults = parseBingSearchResults(relativeCkRedirectHtml, 5);
assert(relativeCkResults.length === 0, 'relative /ck/a redirect should be discarded as an internal Bing jump link');

console.log('Bing parser tests passed.');
