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

const modernResults = parseBingSearchResults(modernHtml, 5);
assert(modernResults.length === 1, 'modern layout should yield one result');
assert(modernResults[0].title === 'Docs Guide', 'modern layout title should parse');
assert(modernResults[0].url === 'https://docs.example.org/guide', 'modern layout url should parse');

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

console.log('Bing parser tests passed.');
