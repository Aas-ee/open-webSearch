import * as dns from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

// URL.hostname preserves the brackets for IPv6 literals (`[::1]`), which
// break isIP and dns.lookup. Strip them once here.
function stripIpv6Brackets(host: string): string {
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export function isPrivateOrLocalHostname(hostname: string): boolean {
    const host = stripIpv6Brackets(hostname.trim().toLowerCase());
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

// DNS-resolves hostnames and rejects private answers. Needed for proxy mode,
// where request-filtering-agent isn't in the chain.
export async function assertPublicHttpUrlResolved(url: string | URL, label: string = 'URL'): Promise<void> {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    assertPublicHttpUrl(parsed, label);

    const host = stripIpv6Brackets(parsed.hostname);
    if (isIP(host) !== 0) {
        return;
    }

    let resolved: Array<{ address: string }>;
    try {
        resolved = await dns.lookup(host, { all: true, verbatim: true });
    } catch {
        throw new Error(`${label} could not be resolved`);
    }
    if (resolved.some((entry) => isPrivateOrLocalHostname(entry.address))) {
        throw new Error(`${label} resolves to a private or local network target, which is not allowed`);
    }
}
