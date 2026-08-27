import { SearchResult } from '../../types.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const BING_ZH_CN_OFFSET_MINUTES = 8 * 60;

function isValidCalendarDate(year: number, month: number, day: number): boolean {
    const calendarDate = new Date(Date.UTC(year, month - 1, day));
    return calendarDate.getUTCFullYear() === year &&
        calendarDate.getUTCMonth() === month - 1 &&
        calendarDate.getUTCDate() === day;
}

function createDateOnlyTimestamp(
    year: number,
    month: number,
    day: number,
    timezoneOffsetMinutes: number
): number | undefined {
    if (!isValidCalendarDate(year, month, day)) {
        return undefined;
    }

    return Date.UTC(year, month - 1, day) - timezoneOffsetMinutes * MINUTE_MS;
}

function normalizeEvidenceTimestamp(timestamp: number | undefined, retrievedAt: Date): string | undefined {
    if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp > retrievedAt.getTime()) {
        return undefined;
    }

    return new Date(timestamp).toISOString();
}

function parseExistingPublishedAt(value: string | undefined, retrievedAt: Date, timezoneOffsetMinutes: number): string | undefined {
    const candidate = value?.trim();
    if (!candidate || candidate.length > 100) {
        return undefined;
    }

    const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(candidate);
    if (dateOnlyMatch) {
        return normalizeEvidenceTimestamp(createDateOnlyTimestamp(
            Number(dateOnlyMatch[1]),
            Number(dateOnlyMatch[2]),
            Number(dateOnlyMatch[3]),
            timezoneOffsetMinutes
        ), retrievedAt);
    }

    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(candidate)) {
        return undefined;
    }

    const [year, month, day] = candidate.slice(0, 10).split('-').map(Number);
    if (!isValidCalendarDate(year, month, day)) {
        return undefined;
    }

    const timestamp = Date.parse(candidate);
    return normalizeEvidenceTimestamp(Number.isNaN(timestamp) ? undefined : timestamp, retrievedAt);
}

function parseAbsoluteDateText(value: string, retrievedAt: Date, timezoneOffsetMinutes: number): string | undefined {
    const chineseMatch = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(value);
    const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const match = chineseMatch ?? isoMatch;
    if (!match) {
        return undefined;
    }

    return normalizeEvidenceTimestamp(createDateOnlyTimestamp(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        timezoneOffsetMinutes
    ), retrievedAt);
}

function parseRelativeDateText(value: string, retrievedAt: Date): string | undefined {
    const chineseMatch = /^(\d{1,4})\s*(分钟|小时|天)\s*(?:之前|前)$/.exec(value);
    const englishMatch = /^(\d{1,4})\s*(minutes?|hours?|days?)\s+ago$/i.exec(value);
    const match = chineseMatch ?? englishMatch;
    if (!match) {
        return undefined;
    }

    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const unitMs = unit === '分钟' || unit.startsWith('minute')
        ? MINUTE_MS
        : unit === '小时' || unit.startsWith('hour')
            ? HOUR_MS
            : DAY_MS;
    const timestamp = retrievedAt.getTime() - amount * unitMs;
    return normalizeEvidenceTimestamp(timestamp, retrievedAt);
}

function parseBingDateText(dateText: string | undefined, retrievedAt: Date): string | undefined {
    const candidate = dateText?.trim();
    if (!candidate || candidate.length > 100) {
        return undefined;
    }

    return parseAbsoluteDateText(candidate, retrievedAt, BING_ZH_CN_OFFSET_MINUTES) ??
        parseRelativeDateText(candidate, retrievedAt);
}

export function normalizePublicationMetadata(result: SearchResult, retrievedAt: Date): SearchResult {
    const { publishedAt: untrustedPublishedAt, ...resultWithoutPublishedAt } = result;
    const timezoneOffsetMinutes = result.engine === 'bing' ? BING_ZH_CN_OFFSET_MINUTES : 0;
    const publishedAt = parseExistingPublishedAt(untrustedPublishedAt, retrievedAt, timezoneOffsetMinutes) ??
        (result.engine === 'bing' ? parseBingDateText(result.dateText, retrievedAt) : undefined);

    return {
        ...resultWithoutPublishedAt,
        ...(publishedAt ? { publishedAt } : {})
    };
}
