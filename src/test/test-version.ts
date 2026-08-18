import { createRequire } from 'node:module';
import { OPEN_WEBSEARCH_VERSION } from '../version.js';

const require = createRequire(import.meta.url);
const metadata = require('../../package.json') as { version?: unknown };

if (OPEN_WEBSEARCH_VERSION !== metadata.version) {
    throw new Error(`version module mismatch: expected ${String(metadata.version)}, got ${OPEN_WEBSEARCH_VERSION}`);
}

console.log(`Version tests passed (${OPEN_WEBSEARCH_VERSION}).`);
