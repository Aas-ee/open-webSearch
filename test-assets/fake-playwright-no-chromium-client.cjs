// 测试夹具：可真实加载但不暴露 chromium 的 Playwright 客户端模块。
// 用途：在安装/未安装 playwright 包的环境下都确定性地模拟"Playwright 不可用"，因为 checkPlaywrightModeConfiguration 优先加载 PLAYWRIGHT_MODULE_PATH 并以此中断候选探测。与 fake-playwright-client.cjs（暴露 chromium）配合，覆盖可用性检测的两个分支。
module.exports = {};
