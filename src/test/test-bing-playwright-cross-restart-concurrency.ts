import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createOpenWebSearchRuntime } from '../runtime/createRuntime.js';
import { startLocalDaemon } from '../adapters/http/localDaemon.js';
import { SearchResult } from '../types.js';

type SearchResponse = {
    query: string;
    status: number;
    body: string;
    envelopeStatus: string | null;
    totalResults: number;
    results: SearchResult[];
    partialFailures: Array<{ engine: string; code: string; message: string }>;
};

type SearchResponseEnvelope = {
    status: string;
    data?: {
        query: string;
        totalResults: number;
        results: SearchResult[];
        partialFailures: Array<{ engine: string; code: string; message: string }>;
    };
    error?: {
        code: string;
        message: string;
    };
    hint?: string | null;
};

type QueryExpectation = {
    minimumGroupMatches: number;
    groups: Array<{
        label: string;
        anyOf: string[];
    }>;
};

type ScoredSearchResult = {
    result: SearchResult;
    matchedGroups: string[];
};

type BrowserRootInfo = {
    pid: number;
    commandLine: string;
};

type BrowserTabSnapshot = {
    totalTabs: number;
    perRoot: Array<{
        pid: number;
        port: number;
        tabCount: number;
    }>;
};

type BrowserDebugTarget = {
    pid: number;
    port: number;
};

type LocalBrowserSessionRegistry = {
    sessions?: Record<string, {
        tempDir?: string;
    }>;
};

type LocalBrowserSessionSnapshot = {
    tempDir: string;
    browserPid: number;
    debugPort: number;
    sessionMode: string;
    clientPids: number[];
};

type CliSearchRun = {
    query: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    response: SearchResponseEnvelope;
};

type HiddenRoundChildResult = {
    label: string;
    results: SearchResponse[];
};

type HiddenRoundHandle = {
    label: string;
    process: any;
    result: HiddenRoundChildResult;
    close(): Promise<void>;
};

const phase1Queries = [
    'fsutil quota',
    '古斯塔夫鳄鱼',
    'git blame',
    'visual studio'
];

const phase2Queries = [
    'elasid 蛇女',
    '蚊 小说',
    '磁盘配额不足，但是找不到占用空间的文件',
    '通假字是错别字吗'
];

const phase3Queries = [
    '狗彘食人食而不知检，涂有饿莩而不知发',
    '🩠',
    '沙花叉',
    '抑制性神经元'
];

const queryExpectations = new Map<string, QueryExpectation>([
    ['fsutil quota', {
        minimumGroupMatches: 2,
        groups: [
            { label: 'fsutil', anyOf: ['fsutil'] },
            { label: 'quota-or-配额', anyOf: ['quota', '配额'] }
        ]
    }],
    ['古斯塔夫鳄鱼', {
        minimumGroupMatches: 2,
        groups: [
            { label: '古斯塔夫', anyOf: ['古斯塔夫'] },
            { label: '鳄鱼', anyOf: ['鳄鱼'] }
        ]
    }],
    ['git blame', {
        minimumGroupMatches: 2,
        groups: [
            { label: 'git', anyOf: ['git'] },
            { label: 'blame', anyOf: ['blame'] }
        ]
    }],
    ['visual studio', {
        minimumGroupMatches: 2,
        groups: [
            { label: 'visual', anyOf: ['visual'] },
            { label: 'studio-or-vs', anyOf: ['studio', 'vs', 'visual studio'] }
        ]
    }],
    ['elasid 蛇女', {
        minimumGroupMatches: 2,
        groups: [
            { label: 'elasid', anyOf: ['elasid'] },
            { label: '蛇女', anyOf: ['蛇女'] }
        ]
    }],
    ['蚊 小说', {
        minimumGroupMatches: 2,
        groups: [
            { label: '蚊', anyOf: ['蚊'] },
            { label: '小说-or-全文', anyOf: ['小说', '全文'] }
        ]
    }],
    ['磁盘配额不足，但是找不到占用空间的文件', {
        minimumGroupMatches: 2,
        groups: [
            { label: '磁盘-or-空间', anyOf: ['磁盘', '空间'] },
            { label: '配额-or-quota', anyOf: ['配额', 'quota'] },
            { label: '文件-or-占用', anyOf: ['文件', '占用'] }
        ]
    }],
    ['通假字是错别字吗', {
        minimumGroupMatches: 2,
        groups: [
            { label: '通假字', anyOf: ['通假字'] },
            { label: '错别字', anyOf: ['错别字'] }
        ]
    }],
    ['狗彘食人食而不知检，涂有饿莩而不知发', {
        minimumGroupMatches: 2,
        groups: [
            { label: '狗彘食人食', anyOf: ['狗彘食人食'] },
            { label: '饿莩', anyOf: ['饿莩'] },
            { label: '孟子-or-梁惠王', anyOf: ['孟子', '梁惠王'] }
        ]
    }],
    ['🩠', {
        minimumGroupMatches: 1,
        groups: [
            { label: 'emoji-or-表情', anyOf: ['🩠', 'emoji', '表情'] },
            { label: '缝合-or-suture', anyOf: ['缝合', 'suture'] }
        ]
    }],
    ['沙花叉', {
        minimumGroupMatches: 1,
        groups: [
            { label: '沙花叉', anyOf: ['沙花叉'] },
            { label: 'hololive-or-vtuber', anyOf: ['hololive', 'vtuber', 'houshou', 'marine'] }
        ]
    }],
    ['抑制性神经元', {
        minimumGroupMatches: 2,
        groups: [
            { label: '抑制性', anyOf: ['抑制性'] },
            { label: '神经元', anyOf: ['神经元'] }
        ]
    }]
]);

const LOCAL_BROWSER_SESSION_METADATA_FILE = 'open-websearch-session.json';
const LOCAL_BROWSER_SESSION_REGISTRY_FILE = 'open-websearch-local-browser-sessions.json';

function assertCondition(condition: unknown, message: string): void {
    if (!condition) {
        throw new Error(message);
    }
}

function runPowerShell(command: string): string {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8',
        windowsHide: true
    }).trim();
}

function processExists(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function readJsonFile<T>(filePath: string): T | null {
    if (!existsSync(filePath)) {
        return null;
    }

    try {
        return JSON.parse(readFileSync(filePath, 'utf8')) as T;
    } catch {
        return null;
    }
}

function normalizeClientPids(value: unknown): number[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return [...new Set(value.filter((pid): pid is number => Number.isInteger(pid) && pid > 0 && processExists(pid)))].sort((left, right) => left - right);
}

function listRegisteredLocalBrowserSessions(): LocalBrowserSessionSnapshot[] {
    const registryPath = path.join(tmpdir(), LOCAL_BROWSER_SESSION_REGISTRY_FILE);
    const registry = readJsonFile<LocalBrowserSessionRegistry>(registryPath);
    const entries = registry?.sessions && typeof registry.sessions === 'object'
        ? Object.values(registry.sessions)
        : [];
    const tempDirs = [...new Set(entries
        .map((entry) => typeof entry?.tempDir === 'string' ? entry.tempDir : '')
        .filter((tempDir) => tempDir.length > 0))];

    return tempDirs
        .map((tempDir) => {
            const metadataPath = path.join(tempDir, LOCAL_BROWSER_SESSION_METADATA_FILE);
            const metadata = readJsonFile<Record<string, unknown>>(metadataPath);
            if (!metadata) {
                return null;
            }

            const rawBrowserPid = metadata.browserPid;
            if (typeof rawBrowserPid !== 'number' || !Number.isInteger(rawBrowserPid) || rawBrowserPid <= 0) {
                return null;
            }

            const rawDebugPort = metadata.debugPort;
            if (typeof rawDebugPort !== 'number' || !Number.isInteger(rawDebugPort) || rawDebugPort <= 0) {
                return null;
            }

            const browserPid = rawBrowserPid;
            const debugPort = rawDebugPort;

            const sessionMode = typeof metadata.sessionMode === 'string'
                ? metadata.sessionMode
                : metadata.hideWindow === true
                    ? 'hidden-headed'
                    : metadata.strictCleanup === true
                        ? 'headless'
                        : 'headed';

            return {
                tempDir,
                browserPid,
                debugPort,
                sessionMode,
                clientPids: normalizeClientPids(metadata.clientPids)
            } satisfies LocalBrowserSessionSnapshot;
        })
        .filter((session): session is LocalBrowserSessionSnapshot => session !== null)
        .sort((left, right) => left.browserPid - right.browserPid);
}

function listHiddenSessionSnapshots(): LocalBrowserSessionSnapshot[] {
    return listRegisteredLocalBrowserSessions()
        .filter((session) => session.sessionMode === 'hidden-headed' && processExists(session.browserPid));
}

function getBrowserTargetsFromSessions(sessions: LocalBrowserSessionSnapshot[]): BrowserDebugTarget[] {
    return sessions
        .map((session) => ({ pid: session.browserPid, port: session.debugPort }))
        .sort((left, right) => left.pid - right.pid);
}

function getBrowserRootPidsFromSessions(sessions: LocalBrowserSessionSnapshot[]): number[] {
    return sessions.map((session) => session.browserPid);
}

function listRootPids(): number[] {
    const raw = runPowerShell("Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') -and $_.CommandLine -match 'mcp-search-' -and $_.CommandLine -match '--remote-debugging-port=' -and $_.CommandLine -notmatch '--type=' } | Select-Object -ExpandProperty ProcessId | Sort-Object | ConvertTo-Json -Compress");
    if (!raw) {
        return [];
    }

    const parsed = JSON.parse(raw) as number[] | number;
    return Array.isArray(parsed) ? parsed : [parsed];
}

function listBrowserRootInfos(): BrowserRootInfo[] {
    const raw = runPowerShell("Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') -and $_.CommandLine -match 'mcp-search-' -and $_.CommandLine -match '--remote-debugging-port=' -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId, CommandLine | Sort-Object ProcessId | ConvertTo-Json -Compress");
    if (!raw) {
        return [];
    }

    const parsed = JSON.parse(raw) as Array<{ ProcessId?: number; CommandLine?: string }> | { ProcessId?: number; CommandLine?: string };
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items
        .map((item) => ({
            pid: Number(item.ProcessId),
            commandLine: String(item.CommandLine || '')
        }))
        .filter((item) => Number.isInteger(item.pid) && item.pid > 0 && item.commandLine.length > 0);
}

function listHiddenRootPids(): number[] {
    return getBrowserRootPidsFromSessions(listHiddenSessionSnapshots());
}

function diffRoots(nextRoots: number[], previousRoots: number[]): number[] {
    const previous = new Set(previousRoots);
    return nextRoots.filter((root) => !previous.has(root));
}

function rootsEqual(left: number[], right: number[]): boolean {
    if (left.length !== right.length) {
        return false;
    }

    return left.every((value, index) => value === right[index]);
}

function extractDebugPort(commandLine: string): number | null {
    const match = commandLine.match(/--remote-debugging-port=(\d+)/);
    if (!match) {
        return null;
    }

    const port = Number.parseInt(match[1], 10);
    return Number.isInteger(port) && port > 0 ? port : null;
}

async function listBrowserTabSnapshot(): Promise<BrowserTabSnapshot> {
    return listBrowserTabSnapshotForTargets(listBrowserRootInfos().map((root) => {
        const port = extractDebugPort(root.commandLine);
        if (!port) {
            return null;
        }

        return { pid: root.pid, port } satisfies BrowserDebugTarget;
    }).filter((target): target is BrowserDebugTarget => target !== null));
}

async function listBrowserTabSnapshotForTargets(targets: BrowserDebugTarget[]): Promise<BrowserTabSnapshot> {
    const perRoot = await Promise.all(targets.map(async (target) => {
        const { pid, port } = target;

        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`);
            if (!response.ok) {
                return { pid, port, tabCount: 0 };
            }

            const targets = await response.json() as Array<{ type?: string }>;
            return {
                pid,
                port,
                tabCount: Array.isArray(targets)
                    ? targets.filter((target) => target?.type === 'page').length
                    : 0
            };
        } catch {
            return { pid, port, tabCount: 0 };
        }
    }));

    const normalizedPerRoot = perRoot
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .sort((left, right) => left.pid - right.pid);

    return {
        totalTabs: normalizedPerRoot.reduce((sum, entry) => sum + entry.tabCount, 0),
        perRoot: normalizedPerRoot
    };
}

function hasAnyEqualTabCount(counts: number[]): boolean {
    const seen = new Set<number>();
    for (const count of counts) {
        if (seen.has(count)) {
            return true;
        }
        seen.add(count);
    }
    return false;
}

function normalizeText(value: string): string {
    return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function buildResultSearchText(result: SearchResult): string {
    return normalizeText([
        result.title,
        result.description,
        result.url,
        result.source
    ].filter(Boolean).join(' '));
}

function scoreSearchResult(result: SearchResult, expectation: QueryExpectation): ScoredSearchResult {
    const haystack = buildResultSearchText(result);
    const matchedGroups = expectation.groups
        .filter((group) => group.anyOf.some((keyword) => haystack.includes(normalizeText(keyword))))
        .map((group) => group.label);

    return { result, matchedGroups };
}

function formatResultPreview(result: SearchResult): string {
    return `${result.title || '(empty title)'} | ${(result.description || '').slice(0, 80)}`;
}

function assertRelevantResults(label: string, query: string, results: SearchResult[]): void {
    const expectation = queryExpectations.get(query);
    if (!expectation) {
        throw new Error(`missing relevance expectation for query: ${query}`);
    }
    assertCondition(results.length > 0, `${label} query returned no results: ${query}`);

    const scoredResults = results.map((result) => scoreSearchResult(result, expectation));
    const matchedGroupsAcrossResults = [...new Set(scoredResults.flatMap((scoredResult) => scoredResult.matchedGroups))];

    for (const [index, scoredResult] of scoredResults.entries()) {
        const matches = scoredResult.matchedGroups.length > 0 ? scoredResult.matchedGroups.join(',') : '(none)';
        console.log(`${label} relevance query=${query} result=${index + 1} matches=${matches} preview=${formatResultPreview(scoredResult.result)}`);
    }

    assertCondition(
        matchedGroupsAcrossResults.length >= expectation.minimumGroupMatches,
        `${label} query produced weakly related results: ${query}; aggregateMatches=${matchedGroupsAcrossResults.join(',') || '(none)'}; previews=${scoredResults.map((scoredResult) => formatResultPreview(scoredResult.result)).join(' || ')}`
    );
}

function parseSearchResponse(query: string, body: string, statusCode = 200): SearchResponse {
    let payload: SearchResponseEnvelope | undefined;
    try {
        payload = JSON.parse(body) as SearchResponseEnvelope;
    } catch {
        payload = undefined;
    }

    return {
        query,
        status: statusCode,
        body,
        envelopeStatus: payload?.status ?? null,
        totalResults: payload?.data?.totalResults ?? 0,
        results: payload?.data?.results ?? [],
        partialFailures: payload?.data?.partialFailures ?? []
    };
}

function validateSearchResponse(label: string, response: SearchResponse): void {
    console.log(`${label} query=${response.query} status=${response.status}`);
    assertCondition(response.status === 200, `${label} query failed: ${response.query} => ${response.status}`);
    assertCondition(response.envelopeStatus === 'ok', `${label} query returned invalid payload: ${response.query}; body=${response.body}`);
    assertCondition(response.partialFailures.length === 0, `${label} query had partial failures: ${response.query} => ${JSON.stringify(response.partialFailures)}`);
    assertCondition(response.totalResults > 0, `${label} query returned zero results: ${response.query}; body=${response.body}`);
    assertRelevantResults(label, response.query, response.results);
}

function getBaseChildEnv(headless: boolean): NodeJS.ProcessEnv {
    return {
        ...process.env,
        SEARCH_MODE: 'playwright',
        DEFAULT_SEARCH_ENGINE: 'bing',
        PLAYWRIGHT_HEADLESS: headless ? 'true' : 'false'
    };
}

function spawnNodeProcess(scriptPath: string, args: string[], env: NodeJS.ProcessEnv) {
    return spawn(process.execPath, [scriptPath, ...args], {
        cwd: process.cwd(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
    });
}

async function runHeadedCliSearch(query: string): Promise<CliSearchRun> {
    return new Promise((resolve, reject) => {
        const child = spawnNodeProcess('build/index.js', [
            'search',
            query,
            '--engine', 'bing',
            '--search-mode', 'playwright',
            '--limit', '3',
            '--json'
        ], getBaseChildEnv(false));

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('close', (exitCode) => {
            const response = parseSearchResponse(query, stdout, exitCode === 0 ? 200 : 500);
            resolve({
                query,
                exitCode,
                stdout,
                stderr,
                response: {
                    status: response.envelopeStatus || 'error',
                    data: {
                        query: response.query,
                        totalResults: response.totalResults,
                        results: response.results,
                        partialFailures: response.partialFailures
                    }
                }
            });
        });
    });
}

async function runHeadedRound(label: string, queries: string[]) {
    const beforeRoots = listRootPids();
    const beforeTabs = await listBrowserTabSnapshot();
    console.log(`${label} headed before roots=${JSON.stringify(beforeRoots)} tabs=${beforeTabs.totalTabs} tabDetails=${JSON.stringify(beforeTabs.perRoot)}`);

    const runs = await Promise.all(queries.map((query) => runHeadedCliSearch(query)));
    for (const run of runs) {
        assertCondition(run.exitCode === 0, `${label} headed child failed: ${run.query}; stderr=${run.stderr}; stdout=${run.stdout}`);
        validateSearchResponse(`${label}-headed`, parseSearchResponse(run.query, run.stdout));
    }

    const afterRoots = listRootPids();
    const afterTabs = await listBrowserTabSnapshot();
    console.log(`${label} headed after roots=${JSON.stringify(afterRoots)} tabs=${afterTabs.totalTabs} tabDetails=${JSON.stringify(afterTabs.perRoot)}`);

    return {
        beforeRoots,
        beforeTabs,
        afterRoots,
        afterTabs
    };
}

async function searchOnce(baseUrl: string, query: string): Promise<SearchResponse> {
    const response = await fetch(`${baseUrl}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            query,
            limit: 3,
            engines: ['bing'],
            searchMode: 'playwright'
        })
    });

    return parseSearchResponse(query, await response.text(), response.status);
}

async function runHiddenRoundChild(label: string, queries: string[]): Promise<void> {
    const runtime = createOpenWebSearchRuntime();
    const daemon = await startLocalDaemon(runtime, { port: 0, version: `hidden-${label}` });

    try {
        const results = await Promise.all(queries.map((query) => searchOnce(daemon.baseUrl, query)));
        for (const result of results) {
            validateSearchResponse(`${label}-hidden-child`, result);
        }

        process.stdout.write(`HIDDEN_ROUND_RESULT\t${JSON.stringify({ label, results })}\n`);

        await new Promise<void>((resolve) => {
            process.stdin.resume();
            process.stdin.once('end', () => resolve());
            process.stdin.once('close', () => resolve());
        });
    } finally {
        await daemon.close();
    }
}

async function startHiddenRound(label: string, queries: string[]): Promise<HiddenRoundHandle> {
    return new Promise((resolve, reject) => {
        const child = spawnNodeProcess('build/test/test-bing-playwright-cross-restart-concurrency.js', [
            '--hidden-round',
            label,
            ...queries
        ], getBaseChildEnv(true));

        let stdout = '';
        let stderr = '';
        let settled = false;

        child.stdout.on('data', (chunk) => {
            stdout += String(chunk);
            const marker = stdout.split(/\r?\n/).find((line) => line.startsWith('HIDDEN_ROUND_RESULT\t'));
            if (!marker || settled) {
                return;
            }

            settled = true;
            const json = marker.slice('HIDDEN_ROUND_RESULT\t'.length);
            const result = JSON.parse(json) as HiddenRoundChildResult;
            resolve({
                label,
                process: child,
                result,
                close: async () => {
                    if (!child.killed) {
                        child.stdin.end();
                    }
                    await new Promise<void>((closeResolve, closeReject) => {
                        child.once('close', (exitCode) => {
                            if (exitCode === 0) {
                                closeResolve();
                                return;
                            }
                            closeReject(new Error(`${label} hidden child exited unexpectedly: ${exitCode}; stderr=${stderr}; stdout=${stdout}`));
                        });
                        child.once('error', closeReject);
                    });
                }
            });
        });

        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('close', (exitCode) => {
            if (!settled) {
                reject(new Error(`${label} hidden child exited before reporting result: ${exitCode}; stderr=${stderr}; stdout=${stdout}`));
            }
        });
    });
}

async function runHiddenScenario(): Promise<void> {
    const phaseQueries = [phase1Queries, phase2Queries, phase3Queries];
    const labels = ['phase1', 'phase2', 'phase3'];
    const handles: HiddenRoundHandle[] = [];
    const tabCounts: number[] = [];
    const initialHiddenSessions = listHiddenSessionSnapshots();
    const initialHiddenRoots = getBrowserRootPidsFromSessions(initialHiddenSessions);
    const hiddenChildPids = new Set<number>();

    try {
        for (let index = 0; index < phaseQueries.length; index += 1) {
            const label = labels[index];
            const beforeSessions = listHiddenSessionSnapshots();
            const beforeRoots = getBrowserRootPidsFromSessions(beforeSessions);
            const beforeTabs = await listBrowserTabSnapshotForTargets(getBrowserTargetsFromSessions(beforeSessions));
            console.log(`${label} hidden before roots=${JSON.stringify(beforeRoots)} tabs=${beforeTabs.totalTabs} tabDetails=${JSON.stringify(beforeTabs.perRoot)}`);

            const handle = await startHiddenRound(label, phaseQueries[index]);
            handles.push(handle);
            if (Number.isInteger(handle.process.pid) && handle.process.pid > 0) {
                hiddenChildPids.add(handle.process.pid);
            }

            for (const result of handle.result.results) {
                validateSearchResponse(`${label}-hidden`, result);
            }

            const afterSessions = listHiddenSessionSnapshots();
            const afterRoots = getBrowserRootPidsFromSessions(afterSessions);
            const afterTabs = await listBrowserTabSnapshotForTargets(getBrowserTargetsFromSessions(afterSessions));
            console.log(`${label} hidden after roots=${JSON.stringify(afterRoots)} tabs=${afterTabs.totalTabs} tabDetails=${JSON.stringify(afterTabs.perRoot)}`);

            if (index === 0) {
                const newRoots = diffRoots(afterRoots, beforeRoots);
                assertCondition(newRoots.length <= 1, `${label} hidden should add at most one browser root, before=${JSON.stringify(beforeRoots)} after=${JSON.stringify(afterRoots)}`);
            } else {
                assertCondition(rootsEqual(afterRoots, beforeRoots), `${label} hidden should reuse the same browser roots, before=${JSON.stringify(beforeRoots)} after=${JSON.stringify(afterRoots)}`);
            }

            tabCounts.push(afterTabs.totalTabs);
        }

        assertCondition(
            tabCounts.some((count) => count > 0),
            `hidden rounds could not observe any browser tabs, counts=${JSON.stringify(tabCounts)}`
        );
        assertCondition(
            hasAnyEqualTabCount(tabCounts),
            `hidden tab reuse check expected at least two rounds to report the same tab count, counts=${JSON.stringify(tabCounts)}`
        );
    } finally {
        for (const handle of handles.reverse()) {
            await handle.close();
        }
    }

    const remainingHiddenSessions = listHiddenSessionSnapshots();
    const rootsAfterClose = getBrowserRootPidsFromSessions(remainingHiddenSessions);
    const leakedRoots = diffRoots(rootsAfterClose, initialHiddenRoots);
    const leakedChildRegistrations = remainingHiddenSessions
        .filter((session) => session.clientPids.some((pid) => hiddenChildPids.has(pid)))
        .map((session) => ({
            pid: session.browserPid,
            tempDir: session.tempDir,
            clientPids: session.clientPids
        }));

    // 修复隐藏轮次收尾把前半段有头浏览器或既有隐藏会话误算为泄漏的问题：
    // 这里只要求隐藏场景结束后回到其起始隐藏会话集合，并确认本轮子进程登记已全部释放。
    assertCondition(
        rootsEqual(rootsAfterClose, initialHiddenRoots),
        `hidden browsers should return to the initial hidden root set after all holder processes exit, initial=${JSON.stringify(initialHiddenRoots)} actual=${JSON.stringify(rootsAfterClose)} leaked=${JSON.stringify(leakedRoots)}`
    );
    assertCondition(
        leakedChildRegistrations.length === 0,
        `hidden browser sessions should unregister hidden round child holders after close, leaked=${JSON.stringify(leakedChildRegistrations)}`
    );
}

async function main(): Promise<void> {
    assertCondition(process.platform === 'win32', 'This test currently requires Windows process inspection');
    assertCondition(process.env.SEARCH_MODE === 'playwright', 'Set SEARCH_MODE=playwright before running this test');
    assertCondition(process.env.DEFAULT_SEARCH_ENGINE === 'bing', 'Set DEFAULT_SEARCH_ENGINE=bing before running this test');

    if (process.argv[2] === '--hidden-round') {
        const label = process.argv[3];
        const queries = process.argv.slice(4);
        assertCondition(queries.length === 4, `hidden round requires exactly 4 queries, received=${queries.length}`);
        await runHiddenRoundChild(label, queries);
        return;
    }

    assertCondition(process.env.PLAYWRIGHT_HEADLESS === 'false', 'Set PLAYWRIGHT_HEADLESS=false before running this test');

    console.log('Bing Playwright cross-restart concurrency test config:', {
        searchMode: process.env.SEARCH_MODE,
        defaultEngine: process.env.DEFAULT_SEARCH_ENGINE,
        playwrightHeadless: process.env.PLAYWRIGHT_HEADLESS,
        navigationTimeoutMs: process.env.PLAYWRIGHT_NAVIGATION_TIMEOUT_MS || '(default)'
    });

    const headedRounds = [
        await runHeadedRound('phase1', phase1Queries),
        await runHeadedRound('phase2', phase2Queries),
        await runHeadedRound('phase3', phase3Queries)
    ];

    const phase1NewRoots = diffRoots(headedRounds[0].afterRoots, headedRounds[0].beforeRoots);
    assertCondition(
        phase1NewRoots.length <= 1,
        `phase1 headed should add at most one browser root, before=${JSON.stringify(headedRounds[0].beforeRoots)} after=${JSON.stringify(headedRounds[0].afterRoots)}`
    );
    assertCondition(
        rootsEqual(headedRounds[1].beforeRoots, headedRounds[0].afterRoots),
        `phase2 headed should start from the same reusable browser roots, expected=${JSON.stringify(headedRounds[0].afterRoots)} actual=${JSON.stringify(headedRounds[1].beforeRoots)}`
    );
    assertCondition(
        rootsEqual(headedRounds[1].afterRoots, headedRounds[1].beforeRoots),
        `phase2 headed should not create extra browser roots, before=${JSON.stringify(headedRounds[1].beforeRoots)} after=${JSON.stringify(headedRounds[1].afterRoots)}`
    );
    assertCondition(
        rootsEqual(headedRounds[2].beforeRoots, headedRounds[1].afterRoots),
        `phase3 headed should start from the same reusable browser roots, expected=${JSON.stringify(headedRounds[1].afterRoots)} actual=${JSON.stringify(headedRounds[2].beforeRoots)}`
    );
    assertCondition(
        rootsEqual(headedRounds[2].afterRoots, headedRounds[2].beforeRoots),
        `phase3 headed should not create extra browser roots, before=${JSON.stringify(headedRounds[2].beforeRoots)} after=${JSON.stringify(headedRounds[2].afterRoots)}`
    );

    const headedTabCounts = headedRounds.map((round) => round.afterTabs.totalTabs);
    assertCondition(
        headedTabCounts.some((count) => count > 0),
        `headed rounds could not observe any browser tabs, counts=${JSON.stringify(headedTabCounts)}`
    );
    assertCondition(
        hasAnyEqualTabCount(headedTabCounts),
        `headed tab reuse check expected at least two rounds to report the same tab count, counts=${JSON.stringify(headedTabCounts)}`
    );

    await runHiddenScenario();

    console.log('Bing headed/hidden Playwright cross-restart concurrency test passed.');
}

main().catch((error) => {
    console.error('Bing headed/hidden Playwright cross-restart concurrency test failed:', error);
    process.exit(1);
});
