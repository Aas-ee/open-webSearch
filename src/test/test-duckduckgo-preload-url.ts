import { isTrustedDuckDuckGoPreloadUrl } from '../engines/duckduckgo/searchDuckDuckGo.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function main(): void {
  assert(
    isTrustedDuckDuckGoPreloadUrl('https://links.duckduckgo.com/d.js'),
    'default DuckDuckGo preload URL should be trusted'
  );

  assert(
    isTrustedDuckDuckGoPreloadUrl('https://links.duckduckgo.com:443/d.js?foo=bar'),
    'DuckDuckGo preload URL on the default HTTPS port should be trusted'
  );

  assert(
    !isTrustedDuckDuckGoPreloadUrl('https://links.duckduckgo.com:444/d.js'),
    'DuckDuckGo preload URL on a non-default port should not be trusted'
  );

  assert(
    !isTrustedDuckDuckGoPreloadUrl('https://user:pass@links.duckduckgo.com/d.js'),
    'DuckDuckGo preload URL with credentials should not be trusted'
  );

  assert(
    !isTrustedDuckDuckGoPreloadUrl('https://links.duckduckgo.com/other.js'),
    'DuckDuckGo preload URL should require the exact d.js path'
  );

  assert(
    !isTrustedDuckDuckGoPreloadUrl('http://links.duckduckgo.com/d.js'),
    'DuckDuckGo preload URL should require HTTPS'
  );

  console.log('DuckDuckGo preload URL trust tests passed.');
}

main();
