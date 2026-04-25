import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

type OutputChunk = {
    stream: 'stdout' | 'stderr';
    text: string;
};

type RunningTest = {
    testName: string;
    child: ReturnType<typeof spawn>;
    outputChunks: OutputChunk[];
    killRequested: boolean;
    spawnError?: Error;
};

const rootDir = process.cwd();
const sourceTestDir = path.join(rootDir, 'src', 'test');
const compiledTestDir = path.join(rootDir, 'build', 'test');

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

function getTestNames(directory: string, extension: string): string[] {
    if (!existsSync(directory)) {
        return [];
    }

    return readdirSync(directory)
        .filter((name) => name.endsWith(extension))
        .map((name) => name.slice(0, -extension.length))
        .sort((left, right) => left.localeCompare(right));
}

const sourceTestNames = getTestNames(sourceTestDir, '.ts');
const sourceTestNameSet = new Set(sourceTestNames);
const excludedFromFullTestNames = new Set([
    // 该测试依赖调用者显式配置 PLAYWRIGHT_MODULE_PATH、PLAYWRIGHT_PACKAGE、PLAYWRIGHT_EXECUTABLE_PATH 等环境变量，
    // 并且会启动真实浏览器做跨重启并发验证；全量测试排除它，避免普通 npm test 因本机 Playwright 环境缺失失败。
    // 需要验证时请单独运行 build/test/test-bing-playwright-cross-restart-concurrency.js。
    'test-bing-playwright-cross-restart-concurrency'
]);
const runnableTestNames = sourceTestNames.filter((name) => !excludedFromFullTestNames.has(name));
const staleCompiledTestNames = getTestNames(compiledTestDir, '.js')
    .filter((name) => !sourceTestNameSet.has(name));

if (staleCompiledTestNames.length > 0) {
    fail(`发现 build/test 中存在没有对应 src/test TypeScript 源文件的过时测试：${staleCompiledTestNames.join(', ')}`);
}

if (process.argv.includes('--list')) {
    for (const testName of runnableTestNames) {
        console.log(`${testName}.js`);
    }
    process.exit(0);
}

const networkFailurePatterns = [
    /\b(EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|ENETUNREACH|EHOSTUNREACH|ECONNABORTED)\b/i,
    /\b(socket hang up|network timeout|network error|fetch failed|ERR_NETWORK)\b/i,
    /\b(TLS|SSL|certificate|CERT_[A-Z_]+)\b/i,
    /net::ERR_[A-Z_]+/i,
    /Request failed with status code (429|5\d\d)\b/i,
    /page\.goto: Timeout \d+ms exceeded[\s\S]*navigating to/i,
    /Timeout \d+ms exceeded[\s\S]*(https?:\/\/|navigating to)/i
];

const nonNetworkFailurePatterns = [
    /Playwright client is not available/i,
    /Playwright client is unavailable/i,
    /Cannot find module ['`](playwright|playwright-core)['`]/i,
    /Cannot find package ['`](playwright|playwright-core)['`]/i
];

function getCapturedOutput(test: RunningTest): string {
    return test.outputChunks.map((chunk) => chunk.text).join('');
}

function isForgivableNetworkFailure(test: RunningTest): boolean {
    const output = `${test.spawnError?.message || ''}\n${getCapturedOutput(test)}`;
    if (nonNetworkFailurePatterns.some((pattern) => pattern.test(output))) {
        return false;
    }

    return networkFailurePatterns.some((pattern) => pattern.test(output));
}

function printCapturedOutput(test: RunningTest): void {
    const output = getCapturedOutput(test);
    if (!output.trim()) {
        return;
    }

    console.error(`----- ${test.testName}.js output begin -----`);
    for (const chunk of test.outputChunks) {
        const target = chunk.stream === 'stderr' ? process.stderr : process.stdout;
        target.write(chunk.text);
    }
    if (!output.endsWith('\n')) {
        console.error();
    }
    console.error(`----- ${test.testName}.js output end -----`);
}

function killProcessTree(test: RunningTest): void {
    if (!test.child.pid || test.child.killed) {
        return;
    }

    test.killRequested = true;
    try {
        if (process.platform === 'win32') {
            execFileSync('taskkill', ['/pid', String(test.child.pid), '/T', '/F'], { stdio: 'ignore' });
            return;
        }

        process.kill(-test.child.pid, 'SIGTERM');
    } catch {
        try {
            test.child.kill('SIGKILL');
        } catch {
            // 终止失败通常表示进程已经退出；这里不再覆盖原始失败原因。
        }
    }
}

function validateCompiledTests(): void {
    if (sourceTestNames.length === 0) {
        fail('没有发现当前 TypeScript 测试文件：src/test/*.ts');
    }
    if (runnableTestNames.length === 0) {
        fail('全量测试没有可运行的测试文件，请检查排除列表。');
    }

    for (const testName of sourceTestNames) {
        const compiledTestPath = path.join(compiledTestDir, `${testName}.js`);
        if (!existsSync(compiledTestPath)) {
            fail(`当前 TypeScript 测试缺少编译产物：src/test/${testName}.ts -> build/test/${testName}.js`);
        }
    }
}

function runAllTestsInParallel(): Promise<number> {
    validateCompiledTests();

    const runningTests = new Map<string, RunningTest>();
    let completed = 0;
    let passed = 0;
    let excused = 0;
    let failed = 0;
    let failFastStarted = false;
    let resolveExitCode: (exitCode: number) => void;
    const done = new Promise<number>((resolve) => {
        resolveExitCode = resolve;
    });

    function stopOtherTests(failedTestName: string): void {
        for (const test of runningTests.values()) {
            if (test.testName !== failedTestName) {
                killProcessTree(test);
            }
        }
    }

    function finishIfDone(): void {
        if (completed < runnableTestNames.length) {
            return;
        }

        if (failed > 0) {
            console.error(`\n测试失败：${failed} 个失败，${passed} 个通过，${excused} 个网络问题已赦免。`);
            resolveExitCode(1);
            return;
        }

        console.log(`\n所有当前 TypeScript 测试已完成：${passed} 个通过，${excused} 个网络问题已赦免。`);
        resolveExitCode(0);
    }

    const skippedTestNames = sourceTestNames.filter((name) => excludedFromFullTestNames.has(name));
    if (skippedTestNames.length > 0) {
        console.log(`全量测试跳过 ${skippedTestNames.length} 个需单独运行的测试：${skippedTestNames.map((name) => `${name}.js`).join(', ')}`);
    }
    console.log(`将并行运行 ${runnableTestNames.length} 个当前 TypeScript 测试；非网络失败会立即终止其它测试。`);

    for (const testName of runnableTestNames) {
        const compiledTestPath = path.join(compiledTestDir, `${testName}.js`);
        console.log(`===== START ${testName}.js =====`);

        const child = spawn(process.execPath, [compiledTestPath], {
            detached: process.platform !== 'win32',
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        const runningTest: RunningTest = {
            testName,
            child,
            outputChunks: [],
            killRequested: false
        };
        runningTests.set(testName, runningTest);

        child.stdout?.on('data', (chunk: Buffer) => {
            runningTest.outputChunks.push({ stream: 'stdout', text: chunk.toString('utf8') });
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            runningTest.outputChunks.push({ stream: 'stderr', text: chunk.toString('utf8') });
        });
        child.on('error', (error) => {
            runningTest.spawnError = error;
        });
        child.on('close', (code, signal) => {
            runningTests.delete(testName);
            completed += 1;

            if (runningTest.killRequested) {
                console.warn(`===== STOPPED ${testName}.js (${signal || (code ?? 'unknown')}) =====`);
                finishIfDone();
                return;
            }

            if (!runningTest.spawnError && code === 0) {
                passed += 1;
                console.log(`===== PASS ${testName}.js =====`);
                finishIfDone();
                return;
            }

            if (isForgivableNetworkFailure(runningTest)) {
                excused += 1;
                console.warn(`===== EXCUSED ${testName}.js: 网络问题，已赦免 =====`);
                printCapturedOutput(runningTest);
                finishIfDone();
                return;
            }

            failed += 1;
            console.error(`===== FAIL ${testName}.js (${runningTest.spawnError?.message || signal || (code ?? 'unknown')}) =====`);
            printCapturedOutput(runningTest);

            if (!failFastStarted) {
                failFastStarted = true;
                // 修复全量测试等待过久的问题：第一个非网络失败出现后立即终止其它并行测试。
                stopOtherTests(testName);
            }

            finishIfDone();
        });
    }

    return done;
}

runAllTestsInParallel().then((exitCode) => {
    process.exit(exitCode);
}).catch((error) => {
    console.error(error);
    process.exit(1);
});
