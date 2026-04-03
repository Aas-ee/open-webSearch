# Validation

## Baseline

- `npx tsc --noEmit`

## Targeted tests

Run the tests relevant to the touched area, for example:
- `npm run test:engine-normalization`
- `npm run test:url-safety`
- `npm run test:http-request-options`
- `npm run test:web-content`
- `npm run test:startpage`

## Live checks

Run live checks when implementation depends on real remote behavior, anti-bot handling, or parsing live HTML:
- `npm run test:web-content:live`
- `npm run test:bing:live`
- `npm run test:article-fetch:live`
- `npm run test:startpage` when Startpage parsing, anti-bot handling, or pagination logic changed. This test depends on real network behavior and is not the default first test for unrelated changes.

## Release hygiene

- confirm docs match behavior
- confirm the new engine or fix is reflected in package scripts if needed
- use `npm pack --dry-run` before publish
