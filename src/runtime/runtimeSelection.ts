import { commandNeedsRuntime } from '../cli/runCli.js';

export function shouldCreateFullRuntimeForInvocation(argv: string[]): boolean {
    return argv.length === 0 || commandNeedsRuntime(argv);
}
