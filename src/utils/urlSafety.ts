import { isIP } from 'node:net';

const MAX_UNSIGNED_INT32 = 0xffffffff;

function parseIpv4(ip: string): number[] | null {
    const parts = ip.split('.');
    if (parts.length !== 4) {
        return null;
    }

    const values: number[] = [];
    for (const part of parts) {
        if (!/^\d+$/.test(part)) {
            return null;
        }
        const value = Number(part);
        if (!Number.isInteger(value) || value < 0 || value > 255) {
            return null;
        }
        values.push(value);
    }

    return values;
}

function parseIntegerIpv4Literal(hostname: string): string | null {
    if (!/^\d+$/.test(hostname)) {
        return null;
    }
    const value = Number(hostname);
    if (!Number.isInteger(value) || value < 0 || value > MAX_UNSIGNED_INT32) {
        return null;
    }

    const a = (value >>> 24) & 255;
    const b = (value >>> 16) & 255;
    const c = (value >>> 8) & 255;
    const d = value & 255;
    return `${a}.${b}.${c}.${d}`;
}

function isPrivateIpv4(ip: string): boolean {
    const parts = parseIpv4(ip);
    if (!parts) {
        return false;
    }

    const [a, b] = parts;
    return (
        a === 10 ||
        a === 127 ||
        a === 0 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19))
    );
}

function isPrivateIpv6(ip: string): boolean {
    const normalized = ip.toLowerCase();

    if (normalized === '::1' || normalized === '::') {
        return true;
    }

    if (normalized.startsWith('::ffff:')) {
        const mapped = normalized.slice('::ffff:'.length);
        return isPrivateIpv4(mapped);
    }

    if (/^(fc|fd)/.test(normalized)) {
        return true;
    }

    if (/^fe[89ab]/.test(normalized)) {
        return true;
    }

    return false;
}

function isPrivateOrLocalIp(ip: string): boolean {
    const version = isIP(ip);
    if (version === 4) {
        return isPrivateIpv4(ip);
    }
    if (version === 6) {
        return isPrivateIpv6(ip);
    }
    return false;
}

export function isPrivateOrLocalHostname(hostname: string): boolean {
    const host = hostname.trim().toLowerCase();
    if (!host) {
        return true;
    }

    if (host === 'localhost' || host.endsWith('.localhost')) {
        return true;
    }

    if (host === 'metadata.google.internal' || host === 'metadata.azure.internal') {
        return true;
    }

    const integerIp = parseIntegerIpv4Literal(host);
    if (integerIp && isPrivateIpv4(integerIp)) {
        return true;
    }

    if (isPrivateOrLocalIp(host)) {
        return true;
    }

    return false;
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
