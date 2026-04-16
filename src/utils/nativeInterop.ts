import { closeSync, openSync } from 'fs';
import { createRequire } from 'module';

const esmRequire = createRequire(import.meta.url);

// koffi 延迟加载：仅在首次调用 native 函数时加载
let _koffi: typeof import('koffi') | undefined;
function koffi(): typeof import('koffi') {
    if (!_koffi) {
        _koffi = esmRequire('koffi');
    }
    return _koffi!;
}

// ===== Windows kernel32/user32 绑定（延迟初始化） =====

interface WinLockBindings {
    CreateFileW: (...args: any[]) => any;
    LockFileEx: (...args: any[]) => any;
    UnlockFileEx: (...args: any[]) => any;
    CloseHandle: (...args: any[]) => any;
}
let _winLock: WinLockBindings | undefined;

function winLock(): WinLockBindings {
    if (_winLock) return _winLock;
    const k = koffi();
    const kernel32 = k.load('kernel32.dll');

    // LockFileEx / UnlockFileEx 需要 OVERLAPPED 结构体（同步模式下全部置零即可）
    k.struct('OVERLAPPED', {
        Internal: 'uintptr_t',
        InternalHigh: 'uintptr_t',
        Offset: 'uint32_t',
        OffsetHigh: 'uint32_t',
        hEvent: 'void *'
    });

    _winLock = {
        CreateFileW: kernel32.func(
            'void * __stdcall CreateFileW(str16 lpFileName, uint32_t dwDesiredAccess, uint32_t dwShareMode, void *lpSecurityAttributes, uint32_t dwCreationDisposition, uint32_t dwFlagsAndAttributes, void *hTemplateFile)'
        ),
        LockFileEx: kernel32.func(
            'bool __stdcall LockFileEx(void *hFile, uint32_t dwFlags, uint32_t dwReserved, uint32_t nNumberOfBytesToLockLow, uint32_t nNumberOfBytesToLockHigh, _Inout_ OVERLAPPED *lpOverlapped)'
        ),
        UnlockFileEx: kernel32.func(
            'bool __stdcall UnlockFileEx(void *hFile, uint32_t dwReserved, uint32_t nNumberOfBytesToLockLow, uint32_t nNumberOfBytesToLockHigh, _Inout_ OVERLAPPED *lpOverlapped)'
        ),
        CloseHandle: kernel32.func(
            'bool __stdcall CloseHandle(void *hObject)'
        )
    };
    return _winLock;
}

interface WinDesktopBindings {
    CreateDesktopW: (...args: any[]) => any;
    CloseDesktop: (...args: any[]) => any;
    CreateProcessW: (...args: any[]) => any;
    DuplicateHandle: (...args: any[]) => any;
    GetCurrentProcess: (...args: any[]) => any;
    OpenProcess: (...args: any[]) => any;
    CloseHandle: (...args: any[]) => any;
    STARTUPINFOW: import('koffi').IKoffiCType;
}
let _winDesktop: WinDesktopBindings | undefined;

function winDesktop(): WinDesktopBindings {
    if (_winDesktop) return _winDesktop;
    const k = koffi();
    const kernel32 = k.load('kernel32.dll');
    const user32 = k.load('user32.dll');

    const STARTUPINFOW = k.struct('STARTUPINFOW', {
        cb: 'uint32_t',
        lpReserved: 'str16',
        lpDesktop: 'str16',
        lpTitle: 'str16',
        dwX: 'uint32_t',
        dwY: 'uint32_t',
        dwXSize: 'uint32_t',
        dwYSize: 'uint32_t',
        dwXCountChars: 'uint32_t',
        dwYCountChars: 'uint32_t',
        dwFillAttribute: 'uint32_t',
        dwFlags: 'uint32_t',
        wShowWindow: 'uint16_t',
        cbReserved2: 'uint16_t',
        lpReserved2: 'void *',
        hStdInput: 'void *',
        hStdOutput: 'void *',
        hStdError: 'void *'
    });

    k.struct('PROCESS_INFORMATION', {
        hProcess: 'void *',
        hThread: 'void *',
        dwProcessId: 'uint32_t',
        dwThreadId: 'uint32_t'
    });

    _winDesktop = {
        CreateDesktopW: user32.func(
            'void * __stdcall CreateDesktopW(str16 lpszDesktop, void *lpszDevice, void *pDevmode, uint32_t dwFlags, uint32_t dwDesiredAccess, void *lpsa)'
        ),
        CloseDesktop: user32.func(
            'bool __stdcall CloseDesktop(void *hDesktop)'
        ),
        CreateProcessW: kernel32.func(
            'bool __stdcall CreateProcessW(str16 lpApplicationName, str16 lpCommandLine, void *lpProcessAttributes, void *lpThreadAttributes, bool bInheritHandles, uint32_t dwCreationFlags, void *lpEnvironment, str16 lpCurrentDirectory, _Inout_ STARTUPINFOW *lpStartupInfo, _Out_ PROCESS_INFORMATION *lpProcessInformation)'
        ),
        DuplicateHandle: kernel32.func(
            'bool __stdcall DuplicateHandle(void *hSourceProcessHandle, void *hSourceHandle, void *hTargetProcessHandle, _Out_ void **lpTargetHandle, uint32_t dwDesiredAccess, bool bInheritHandle, uint32_t dwOptions)'
        ),
        GetCurrentProcess: kernel32.func(
            'void * __stdcall GetCurrentProcess()'
        ),
        OpenProcess: kernel32.func(
            'void * __stdcall OpenProcess(uint32_t dwDesiredAccess, bool bInheritHandle, uint32_t dwProcessId)'
        ),
        CloseHandle: kernel32.func(
            'bool __stdcall CloseHandle(void *hObject)'
        ),
        STARTUPINFOW
    };
    return _winDesktop;
}

// Unix libc 绑定（延迟初始化）
interface UnixLockBindings {
    flock: (...args: any[]) => any;
}
let _unixLock: UnixLockBindings | undefined;

function unixLock(): UnixLockBindings {
    if (_unixLock) return _unixLock;
    const k = koffi();
    const libcPath = process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6';
    const libc = k.load(libcPath);
    _unixLock = {
        flock: libc.func('int flock(int fd, int operation)')
    };
    return _unixLock;
}

// ===== 常量 =====

// Windows
const GENERIC_READ  = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const FILE_SHARE_READ  = 0x00000001;
const FILE_SHARE_WRITE = 0x00000002;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const LOCKFILE_EXCLUSIVE_LOCK = 0x00000002;

const GENERIC_ALL = 0x10000000;
const PROCESS_DUP_HANDLE = 0x0040;
const DUPLICATE_SAME_ACCESS = 0x0002;

// Unix
const LOCK_EX = 2;

// ===== 导出函数 =====

/**
 * 跨平台的同步独占文件锁。
 * - Windows: CreateFileW + LockFileEx (OS 级锁，进程死亡后自动释放)
 * - Linux/macOS: open + flock(LOCK_EX) (OS 级锁，进程死亡后自动释放)
 */
export function withNativeFileLock<T>(lockFilePath: string, operation: () => T): T {
    if (process.platform === 'win32') {
        return withWindowsFileLock(lockFilePath, operation);
    }
    return withUnixFileLock(lockFilePath, operation);
}

/**
 * 跨平台的异步独占文件锁（锁在整个 async operation 执行期间持有）。
 * 锁的获取本身是阻塞的（LockFileEx / flock），但 operation 可以是异步的。
 */
export async function withNativeFileLockAsync<T>(lockFilePath: string, operation: () => Promise<T>): Promise<T> {
    if (process.platform === 'win32') {
        return withWindowsFileLockAsync(lockFilePath, operation);
    }
    return withUnixFileLockAsync(lockFilePath, operation);
}

function withWindowsFileLock<T>(lockFilePath: string, operation: () => T): T {
    const w = winLock();
    const k = koffi();

    // 以共享方式打开锁文件（多进程可同时打开，靠 LockFileEx 互斥）
    const handle = w.CreateFileW(
        lockFilePath,
        GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        null, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null
    );

    // INVALID_HANDLE_VALUE = (HANDLE)-1
    if (k.address(handle) === 0xFFFFFFFFFFFFFFFFn) {
        throw new Error(`withNativeFileLock: CreateFileW failed for ${lockFilePath}`);
    }

    // 同步独占锁（无 FILE_FLAG_OVERLAPPED → LockFileEx 阻塞直到获取锁）
    const overlapped = { Internal: 0, InternalHigh: 0, Offset: 0, OffsetHigh: 0, hEvent: null };
    if (!w.LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, overlapped)) {
        w.CloseHandle(handle);
        throw new Error(`withNativeFileLock: LockFileEx failed for ${lockFilePath}`);
    }

    try {
        return operation();
    } finally {
        w.UnlockFileEx(handle, 0, 1, 0, overlapped);
        w.CloseHandle(handle);
    }
}

function withUnixFileLock<T>(lockFilePath: string, operation: () => T): T {
    const u = unixLock();

    // Node.js openSync 返回的是 OS 级 fd，可直接传给 native flock()
    const fd = openSync(lockFilePath, 'a');

    if (u.flock(fd, LOCK_EX) !== 0) {
        closeSync(fd);
        throw new Error(`withNativeFileLock: flock failed for ${lockFilePath}`);
    }

    try {
        return operation();
    } finally {
        closeSync(fd); // close 时自动释放 flock 锁
    }
}

async function withWindowsFileLockAsync<T>(lockFilePath: string, operation: () => Promise<T>): Promise<T> {
    const w = winLock();
    const k = koffi();

    const handle = w.CreateFileW(
        lockFilePath,
        GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        null, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null
    );

    if (k.address(handle) === 0xFFFFFFFFFFFFFFFFn) {
        throw new Error(`withNativeFileLockAsync: CreateFileW failed for ${lockFilePath}`);
    }

    const overlapped = { Internal: 0, InternalHigh: 0, Offset: 0, OffsetHigh: 0, hEvent: null };
    if (!w.LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, overlapped)) {
        w.CloseHandle(handle);
        throw new Error(`withNativeFileLockAsync: LockFileEx failed for ${lockFilePath}`);
    }

    try {
        return await operation();
    } finally {
        w.UnlockFileEx(handle, 0, 1, 0, overlapped);
        w.CloseHandle(handle);
    }
}

async function withUnixFileLockAsync<T>(lockFilePath: string, operation: () => Promise<T>): Promise<T> {
    const u = unixLock();
    const fd = openSync(lockFilePath, 'a');

    if (u.flock(fd, LOCK_EX) !== 0) {
        closeSync(fd);
        throw new Error(`withNativeFileLockAsync: flock failed for ${lockFilePath}`);
    }

    try {
        return await operation();
    } finally {
        closeSync(fd);
    }
}

/**
 * 在 Windows 隐藏桌面上启动进程。
 * 通过 koffi FFI 直接调用 Win32 API（CreateDesktopW / CreateProcessW / DuplicateHandle）。
 *
 * @returns 启动的进程 PID
 */
export function launchProcessOnHiddenDesktop(cmdLine: string, desktopName: string): number {
    if (process.platform !== 'win32') {
        throw new Error('launchProcessOnHiddenDesktop is only supported on Windows');
    }

    const w = winDesktop();
    const k = koffi();

    // 创建隐藏桌面
    const hDesk = w.CreateDesktopW(desktopName, null, null, 0, GENERIC_ALL, null);
    if (hDesk === null || k.address(hDesk) === 0n) {
        throw new Error(`CreateDesktopW failed for desktop "${desktopName}"`);
    }

    // 构造 STARTUPINFOW，指定在隐藏桌面上启动
    const si = {
        cb: k.sizeof('STARTUPINFOW'),
        lpReserved: null,
        lpDesktop: desktopName,
        lpTitle: null,
        dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0,
        dwXCountChars: 0, dwYCountChars: 0,
        dwFillAttribute: 0, dwFlags: 0,
        wShowWindow: 0, cbReserved2: 0,
        lpReserved2: null,
        hStdInput: null, hStdOutput: null, hStdError: null
    };

    const pi: Record<string, any> = {};
    if (!w.CreateProcessW(null, cmdLine, null, null, false, 0, null, null, si, pi)) {
        w.CloseDesktop(hDesk);
        throw new Error(`CreateProcessW failed for command "${cmdLine}"`);
    }

    const browserPid: number = pi.dwProcessId;

    // 将桌面句柄复制到浏览器进程，防止启动者退出后桌面被销毁
    const hBrowserProc = w.OpenProcess(PROCESS_DUP_HANDLE, false, browserPid);
    if (hBrowserProc !== null && k.address(hBrowserProc) !== 0n) {
        const dupHandle = [null];
        w.DuplicateHandle(
            w.GetCurrentProcess(), hDesk,
            hBrowserProc, dupHandle,
            0, false, DUPLICATE_SAME_ACCESS
        );
        w.CloseHandle(hBrowserProc);
    }

    // 不能在此 CloseDesktop(hDesk)：DuplicateHandle 对 USER 对象（desktop handle）的行为不可靠，
    // 子进程持有的副本不能可靠地延续桌面生命周期，关闭后浏览器立即崩溃。
    // 父进程刻意保留 hDesk；句柄数量受浏览器会话数（通常 1）限制，不会累积泄漏。

    w.CloseHandle(pi.hThread);
    w.CloseHandle(pi.hProcess);

    return browserPid;
}
