import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

// Fast-path only. The authoritative SSRF boundary is request-filtering-agent
// in src/utils/httpRequest.ts, which re-validates at connect time.
export function isPrivateOrLocalHostname(hostname: string): boolean {
    const raw = hostname.trim().toLowerCase();
    const host = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
    if (!host || host === 'localhost' || host.endsWith('.localhost')) {
        return true;
    }
    if (isIP(host) === 0) {
        return false;
    }
    try {
        return ipaddr.parse(host).range() !== 'unicast';
    } catch {
        return false;
    }
}

export function isPublicHttpUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return false;
        }
        return !isPrivateOrLocalHostname(parsed.hostname);
    } catch {
        return false;
    }
}

export function assertPublicHttpUrl(url: string | URL, label: string = 'URL'): void {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`${label} must use HTTP or HTTPS`);
    }
    if (isPrivateOrLocalHostname(parsed.hostname)) {
        throw new Error(`${label} points to a private or local network target, which is not allowed`);
    }
}
