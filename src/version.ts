import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const metadata = require('../package.json') as { version?: unknown };

if (typeof metadata.version !== 'string' || metadata.version.trim() === '') {
    throw new Error('Invalid package version');
}

export const OPEN_WEBSEARCH_VERSION = metadata.version;
