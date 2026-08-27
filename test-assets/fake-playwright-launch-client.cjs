// 测试夹具：可真实加载并暴露 chromium 的 Playwright 客户端模块，但 connect/launch 永不被调用。
// 供竞速层测试通过 PLAYWRIGHT_MODULE_PATH 指向本文件，配合 __setBrowserSessionOpenerForTests 接缝在不启动真实浏览器的前提下驱动 fetchWithCookiesRaceViaPlaywright 的真实竞速逻辑。
module.exports = {
    chromium: {}
};
