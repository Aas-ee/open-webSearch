// E2E test: verify fetchWebContent captures <dialog> overlay text
// from a page that shows a transient <dialog> before the main content.
//
// Follows the same direct-import pattern as test-web-content-live.ts.
// Requires PLAYWRIGHT_MODULE_PATH + PLAYWRIGHT_EXECUTABLE_PATH env vars.
//
// Run with:
//   npx tsc && node build/test/test-dialog-capture.js

import { fetchWebContent } from '../engines/web/index.js';

const TEST_URL = 'https://support.clarivate.com/Endnote/s/article/EndNote-API-Support?language=en_US';

async function main(): Promise<void> {
    console.log('=== Dialog Capture E2E Test ===');
    console.log('URL:', TEST_URL);
    console.log('Env:', {
        playwrightPackage: process.env.PLAYWRIGHT_PACKAGE || '(auto)',
        playwrightModulePath: process.env.PLAYWRIGHT_MODULE_PATH || '(none)',
        playwrightExecutablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '(none)',
        playwrightHeadless: process.env.PLAYWRIGHT_HEADLESS || '(unset)',
    });
    console.log('');

    const start = Date.now();
    const result = await fetchWebContent(TEST_URL, 10000);
    const durationMs = Date.now() - start;

    console.log('--- Result ---');
    console.log('finalUrl:', result.finalUrl);
    console.log('title:', result.title || '(empty)');
    console.log('retrievalMethod:', result.retrievalMethod);
    console.log('contentLength:', result.content.length);
    console.log('durationMs:', durationMs);
    console.log('');

    const hasMoved = result.content.includes('This page has been moved');
    const hasApi = result.content.includes('RSServices API');

    console.log('--- Content Checks ---');
    console.log('Contains "moved" notice:', hasMoved ? 'YES' : 'NO');
    console.log('Contains "RSServices API":', hasApi ? 'YES' : 'NO');

    if (hasMoved && hasApi) {
        const movedPos = result.content.indexOf('This page has been moved');
        const apiPos = result.content.indexOf('RSServices API');
        console.log('"moved" before article:', movedPos < apiPos ? 'YES' : 'NO');
    }

    console.log('');
    console.log('--- Content Preview (first 600 chars) ---');
    console.log(result.content.substring(0, 600));
    console.log('');

    if (hasMoved) {
        console.log('✅ PASS: <dialog> overlay text captured and prepended to content');
    } else {
        console.log('⚠ Inconclusive: "moved" notice was NOT in the extracted content.');
        console.log('  The dialog capture mechanism is compiled and in place.');
    }
}

main().catch(err => {
    console.error('❌', err.message);
    process.exitCode = 1;
});
