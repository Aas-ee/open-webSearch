// 测试夹具：模拟一个可真实加载的 Playwright 客户端模块。
// 供可用性检测测试通过 PLAYWRIGHT_MODULE_PATH 指向本文件，验证"客户端模块真实可加载并暴露 chromium"与后续浏览器二进制检查逻辑。
module.exports = {
    chromium: {}
};
