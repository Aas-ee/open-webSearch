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

console.log('Bing parser tests passed.');
