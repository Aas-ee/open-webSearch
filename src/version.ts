import { readFileSync } from 'node:fs';

type PackageManifest = {
    version?: unknown;
};

export function readPackageVersion(): string {
    try {
        const manifest = JSON.parse(
            readFileSync(new URL('../package.json', import.meta.url), 'utf8')
        ) as PackageManifest;
        return typeof manifest.version === 'string' && manifest.version.trim()
            ? manifest.version.trim()
            : 'unknown';
    } catch {
        return 'unknown';
    }
}

export const packageVersion = readPackageVersion();
