// 跨复用池页面锁回归测试：
// 不同 poolKey（bing-search / fetch-html）的页面池都会收编持久化 context 中的同一批物理页，必须以 pageTargetId 为唯一键竞争同一把 OS 锁；若锁键含 poolKey，同一物理页可被两个池同时持有，导航会互相覆盖。
import { acquirePooledPlaywrightPage } from '../utils/playwrightClient.js';
import { getPageLockFilePath } from '../utils/playwrightClient.js';
import { tryNativeFileLock } from '../utils/nativeInterop.js';

function assert(cond: unknown, message: string): asserts cond {
    if (!cond) {
        throw new Error(message);
    }
}

// 构造一个确定性 mock：browser context 中只有一个物理页（targetId=SHT-1），context.newPage() 则依次产出新页（SHT-2、SHT-3...）。
function makeMockBrowser(): any {
    let nextTargetSeq = 2;

    const makeSession = (targetId: string) => ({
        send: async (method: string) => {
            if (method === 'Target.getTargetInfo') {
                return { targetInfo: { targetId } };
            }
            if (method === 'Browser.getWindowForTarget') {
                return { windowId: 1 };
            }
            if (method === 'Browser.getWindowBounds') {
                return { bounds: { left: 0, top: 0, width: 800, height: 600, windowState: 'normal' } };
            }
            return {};
        }
    });

    const makePage = (targetId: string): any => {
        const page: any = {
            _targetId: targetId,
            isClosed: () => false,
            context: () => context
        };
        return page;
    };

    const sharedPage = makePage('SHT-1');

    const context: any = {
        pages: () => [sharedPage],
        newPage: async () => {
            const page = makePage(`SHT-${nextTargetSeq}`);
            nextTargetSeq += 1;
            return page;
        },
        newCDPSession: async (page: any) => makeSession(page._targetId)
    };

    return {
        contexts: () => [context],
        close: async () => {}
    };
}

async function run(): Promise<void> {
    const browser = makeMockBrowser();

    // 池 A（bing-search）获取物理页并持锁不释放。
    const sessionA = await acquirePooledPlaywrightPage(browser, {
        poolKey: 'bing-search',
        preferExistingContext: true
    });

    // 池 B（fetch-html）获取：同一物理页已锁，应通过 newPage 拿新页。
    const sessionB = await acquirePooledPlaywrightPage(browser, {
        poolKey: 'fetch-html',
        preferExistingContext: true
    });

    // 核心断言：两个池拿到的是不同的物理页。
    assert(sessionA.page !== sessionB.page, '两把不同 poolKey 的锁绝不能指向同一物理页');
    assert((sessionA.page as any)._targetId !== (sessionB.page as any)._targetId, '两池 pageTargetId 必须不同');
    console.log('✅ 跨池物理页互斥：池 A=' + (sessionA.page as any)._targetId + '，池 B=' + (sessionB.page as any)._targetId);

    // 同一路径的 OS 锁不能重复获取。
    const lockPath = getPageLockFilePath((sessionA.page as any)._targetId);
    const secondLock = tryNativeFileLock(lockPath);
    assert(secondLock === null, '同一 pageTargetId 的锁被占用时必须拒绝二次获取');
    console.log('✅ 同一路径锁不可重复获取');

    // 释放 A，锁路径才可再次获取。
    await sessionA.releasePage();
    const reacquired = tryNativeFileLock(lockPath);
    assert(reacquired !== null, '释放后锁应可再次获取');
    reacquired!.release();
    console.log('✅ 释放后可重新获取锁');

    await sessionB.releasePage();

    console.log('\n页面池跨池互斥锁测试通过。');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
