<div align="center">

# Open-WebSearch MCP 服务器

[![ModelScope](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/Aas-ee/3af09e0f4c7821fb2e9acb96483a5ff0/raw/badge.json&color=%23de5a16)](https://www.modelscope.cn/mcp/servers/Aasee1/open-webSearch)
[![smithery badge](https://smithery.ai/badge/@Aas-ee/open-websearch)](https://smithery.ai/server/@Aas-ee/open-websearch)
![Version](https://img.shields.io/github/v/release/Aas-ee/open-websearch)
![License](https://img.shields.io/github/license/Aas-ee/open-websearch)
![Issues](https://img.shields.io/github/issues/Aas-ee/open-websearch)

**🇨🇳 中文 | [🇺🇸 English](./README.md)**

</div>

一个基于多引擎搜索结果的模型上下文协议(MCP)服务器，支持免费网络搜索，无需API密钥。


<details>
  <summary><strong style="color: #95cfe4">点击展开查看简单示例效果(deepseek-v3)</strong></summary>

---

### 🧩 示例开始

### prompt: 

> 使用websearch工具查询 《Open-WebSearch MCP》，用csdn引擎，查20条记录，告诉我工具返回的engine，以及相关信息，再通过url查询作者是Aasee的文章内容（如果有多篇顺序查询，不要同时查询）。规范输出

---

### assistant: 

我将使用MCP_search工具查询《Open-WebSearch MCP》并使用CSDN引擎获取20条记录。



### 查询结果分析

1. **使用的搜索引擎**: CSDN
2. **总记录数**: 20条

### 作者Aasee的文章列表
搜索结果显示有2篇作者是"Aasee."的文章：

1. **文章标题**: "开源 AI 联网搜索工具：Open-WebSearch MCP 全新升级，支持多引擎 + 流式响应！"
   **URL**: https://blog.csdn.net/weixin_45801664/article/details/149000138?ops_request_misc=%257B%2522request%255Fid%2522%253A%252203ceec270907178223ab139631d9a81f%2522%252C%2522scm%2522%253A%252220140713.130102334.pc%255Fall.%2522%257D&request_id=03ceec270907178223ab139631d9a81f&biz_id=0&utm_medium=distribute.pc_search_result.none-task-blog-2~all~first_rank_ecpm_v1~rank_v31_ecpm-1-149000138-null-null.142^v102^pc_search_result_base6&utm_term=Open-WebSearch%20MCP
   **简介**: 该项目为AI插件开发提供免费、可控的联网搜索能力，支持Bing、百度、CSDN多引擎组合搜索...

2. **文章标题**: "Web Seach 搜索 MCP 启动！"
   **URL**: https://blog.csdn.net/weixin_45801664/article/details/148813614?ops_request_misc=%257B%2522request%255Fid%2522%253A%252203ceec270907178223ab139631d9a81f%2522%252C%2522scm%2522%253A%252220140713.130102334.pc%255Fall.%2522%257D&request_id=03ceec270907178223ab139631d9a81f&biz_id=0&utm_medium=distribute.pc_search_result.none-task-blog-2~all~first_rank_ecpm_v1~rank_v31_ecpm-4-148813614-null-null.142^v102^pc_search_result_base6&utm_term=Open-WebSearch%20MCP
   **简介**: 开源Web搜索MCP服务器Open-WebSearch上线，解决AI模型无法获取最新网络信息的问题...

### 开始查询第一篇文章内容
我将先查询第一篇文章的全文内容：



# 搜索结果分析

## 工具返回的引擎信息
使用了CSDN搜索引擎进行查询，返回了20条相关记录。

## 作者Aasee的相关文章内容

### 文章1: "开源 AI 联网搜索工具：Open-WebSearch MCP 全新升级，支持多引擎 + 流式响应！"
```
🚀 开源 AI 联网搜索工具：Open-WebSearch MCP 全新升级，支持多引擎 + 流式响应！

💡「让你的 AI 插件真正能联网」—— 不需要 API Key，搜索结果可控、开箱即用！

项目亮点一览：
✅ 多引擎实时搜索：支持 Bing、百度、CSDN、DuckDuckGo、Exa、Brave
✅ 流式响应(MCP协议)：兼容 Claude 插件(MCP)协议
✅ 文章正文抓取：支持提取 CSDN 博客文章全文
✅ 完全免费 & 无需 API Key
✅ Docker 一键部署

安装方法：
- Git克隆项目: git clone https://github.com/Aas-ee/open-webSearch
- 或使用Docker: docker run -d --name web-search -p 3000:3000 -e ENABLE_CORS=true -e CORS_ORIGIN=* ghcr.io/aas-ee/open-web-search:latest

MCP工具支持：
🔍 search：多引擎搜索工具
📄 fetchCsdnArticle：提取 CSDN 文章全文
🧪 fetchLinuxDoArticle：抓取 Linux.do 文章(开发中)

项目地址：
🧩 GitHub: https://github.com/Aas-ee/open-webSearch
📦 Docker: ghcr.io/aas-ee/open-web-search:latest
```

### 文章2: "Web Seach 搜索 MCP 启动！"
```
开源Web搜索MCP服务器Open-WebSearch上线，解决AI模型无法获取最新网络信息的问题。
该项目免费提供百度搜索结果API，支持结构化JSON返回格式，兼容Claude等AI工具的MCP协议。
用户仅需简单安装即可使用，无需API密钥...
```

需要查询其他Aasee作者的文章内容吗？我可以继续为您检索。

### ✅ 示例结束

---
</details>

## 功能特性

- 使用多引擎搜索结果进行网络检索
    - bing
    - baidu
    - ~~linux.do~~ 暂不支持
    - csdn
    - duckduckgo
    - exa
    - brave
    - juejin
    - startpage
- 支持HTTP代理配置，轻松解决网络访问限制
- 无需API密钥或身份验证
- 返回带标题、URL和描述的结构化结果
- 可配置每次搜索返回的结果数量
- 可自定义默认搜索引擎
- 支持获取单篇文章内容
    - csdn
    - github（README文件）
    - 通用 HTTP(S) 网页 / Markdown 内容

## TODO
- 支持~~Bing~~（已支持）,~~DuckDuckGo~~（已支持）,~~Exa~~（已支持）,~~Brave~~（已支持）,Google等搜索引擎
- 支持更多博客论坛、社交软件
- 优化文章内容提取功能，增加更多站点支持
- ~~支持GitHub README获取~~（已支持）

## 安装指南

### NPX 快速启动（推荐）

最快的使用方式：

```bash
# 基本使用
npx open-websearch@latest

# 带环境变量（Linux/macOS）
DEFAULT_SEARCH_ENGINE=duckduckgo ENABLE_CORS=true npx open-websearch@latest

# Windows PowerShell
$env:DEFAULT_SEARCH_ENGINE="duckduckgo"; $env:ENABLE_CORS="true"; npx open-websearch@latest

# Windows CMD
set MODE=stdio && set DEFAULT_SEARCH_ENGINE=duckduckgo && npx open-websearch@latest

# 跨平台（需要 cross-env，用于本地开发）
# 全局安装
npm install -g open-websearch
npx cross-env DEFAULT_SEARCH_ENGINE=duckduckgo ENABLE_CORS=true open-websearch
```

**环境变量说明：**

| 变量名 | 默认值                     | 可选值 | 说明                                   |
|--------|-------------------------|--------|--------------------------------------|
| `ENABLE_CORS` | `false`                 | `true`, `false` | 启用CORS                               |
| `CORS_ORIGIN` | `*`                     | 任何有效来源 | CORS来源配置                             |
| `DEFAULT_SEARCH_ENGINE` | `bing`                  | `bing`, `duckduckgo`, `exa`, `brave`, `baidu`, `csdn`, `juejin`, `startpage` | 默认搜索引擎                               |
| `USE_PROXY` | `false`                 | `true`, `false` | 启用HTTP代理                             |
| `PROXY_URL` | `http://127.0.0.1:7890` | 任何有效URL | 代理服务器URL                             |
| `FETCH_WEB_INSECURE_TLS` | `false` | `true`, `false` | 仅对 `fetchWebContent` 关闭 TLS 证书校验。只建议在目标站点证书链异常时临时使用 |
| `MODE` | `both`                  | `both`, `http`, `stdio` | 服务器模式：同时支持HTTP+STDIO、仅HTTP或仅STDIO    |
| `PORT` | `3000`                  | 1-65535 | 服务器端口                                |
| `ALLOWED_SEARCH_ENGINES` | 空（全部可用） | 逗号分隔的引擎名称 | 限制可使用的搜索引擎，如默认搜索引擎不在范围，则默认第一个为默认搜索引擎 |
| `SEARCH_MODE` | `auto` | `request`, `auto`, `playwright` | 搜索策略，当前仅对 Bing 生效：仅请求、请求失败后回退 Playwright、或强制 Playwright |
| `PLAYWRIGHT_PACKAGE` | `auto` | `auto`, `playwright`, `playwright-core` | 启用浏览器模式时优先解析哪种 Playwright 客户端包 |
| `PLAYWRIGHT_MODULE_PATH` | 空 | 绝对路径或相对项目根目录路径 | 复用当前项目外部已经存在的 Playwright 客户端包 |
| `PLAYWRIGHT_EXECUTABLE_PATH` | 空 | 任意有效浏览器二进制路径 | 使用现有 Chromium/Chrome 可执行文件启动浏览器 |
| `PLAYWRIGHT_WS_ENDPOINT` | 空 | 有效的 Playwright `ws://` / `wss://` 地址 | 连接现有远端 Playwright 浏览器服务 |
| `PLAYWRIGHT_CDP_ENDPOINT` | 空 | 有效的 Chromium CDP 地址 | 通过 CDP 连接现有 Chromium 实例 |
| `PLAYWRIGHT_HEADLESS` | `true` | `true`, `false` | Playwright Chromium 是否以无头模式运行 |
| `PLAYWRIGHT_NAVIGATION_TIMEOUT_MS` | `20000` | 正整数 | Playwright 页面导航和 Bing 结果等待超时时间 |
| `MCP_TOOL_SEARCH_NAME` | `search` | 有效的MCP工具名称 | 搜索工具的自定义名称 |
| `MCP_TOOL_FETCH_LINUXDO_NAME` | `fetchLinuxDoArticle` | 有效的MCP工具名称 | Linux.do文章获取工具的自定义名称 |
| `MCP_TOOL_FETCH_CSDN_NAME` | `fetchCsdnArticle` | 有效的MCP工具名称 | CSDN文章获取工具的自定义名称 |
| `MCP_TOOL_FETCH_GITHUB_NAME` | `fetchGithubReadme` | 有效的MCP工具名称 | GitHub README获取工具的自定义名称 |
| `MCP_TOOL_FETCH_JUEJIN_NAME` | `fetchJuejinArticle` | 有效的MCP工具名称 | 掘金文章获取工具的自定义名称 |
| `MCP_TOOL_FETCH_WEB_NAME` | `fetchWebContent` | 有效的MCP工具名称 | 通用网页/Markdown抓取工具的自定义名称 |

**常用配置示例：**
```bash
# 启用代理（适用于网络受限地区）
USE_PROXY=true PROXY_URL=http://127.0.0.1:7890 npx open-websearch@latest

# 仅当目标网站证书链异常时使用
FETCH_WEB_INSECURE_TLS=true npx open-websearch@latest

# 先走请求，失败后再回退到 Playwright（如果已安装）
SEARCH_MODE=auto npx open-websearch@latest

# 强制仅使用请求模式
SEARCH_MODE=request npx open-websearch@latest

# 完整配置
DEFAULT_SEARCH_ENGINE=duckduckgo ENABLE_CORS=true USE_PROXY=true PROXY_URL=http://127.0.0.1:7890 PORT=8080 npx open-websearch@latest
```

浏览器增强 Bing 兜底现在是显式启用，不随发行包默认安装。你可以按下面几种方式手动启用：

1. 本地完整安装 Playwright：
```bash
npm install playwright
npx playwright install chromium
SEARCH_MODE=auto npx open-websearch@latest
```

2. 只安装精简客户端并复用现有浏览器：
```bash
npm install playwright-core
PLAYWRIGHT_PACKAGE=playwright-core PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chromium SEARCH_MODE=auto npx open-websearch@latest
```

3. 复用机器上其他位置已经安装好的 Playwright 包：
```bash
PLAYWRIGHT_MODULE_PATH=/absolute/path/to/node_modules/playwright SEARCH_MODE=playwright npx open-websearch@latest
```

4. 连接现有远端浏览器：
```bash
npm install playwright-core
PLAYWRIGHT_PACKAGE=playwright-core PLAYWRIGHT_WS_ENDPOINT=ws://127.0.0.1:3000/ SEARCH_MODE=auto npx open-websearch@latest
```

5. 通过 CDP 复用本地 Chrome/Chromium 会话：
```bash
npm install playwright-core

# 先启动带调试端口的 Chrome/Chromium
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/open-websearch-chrome

# 再通过 CDP 连接
PLAYWRIGHT_PACKAGE=playwright-core PLAYWRIGHT_CDP_ENDPOINT=http://127.0.0.1:9222 SEARCH_MODE=auto npx open-websearch@latest
```
如果你想复用自己已经登录过或已经过验证的浏览器会话，这通常是最实用的接入方式。

Windows PowerShell 示例：
```powershell
npm install playwright-core

& "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\open-websearch-chrome"
[types](src/types)
$env:PLAYWRIGHT_PACKAGE="playwright-core"
$env:PLAYWRIGHT_CDP_ENDPOINT="http://127.0.0.1:9222"
$env:SEARCH_MODE="auto"
npx open-websearch@latest
```

模式说明：
- `request`：只使用请求方式抓 Bing
- `auto`：先走请求，只有请求失败且手动可访问的 Playwright 客户端和浏览器可用时才回退到 Playwright
- `playwright`：强制使用 Playwright；如果配置的 Playwright 客户端或浏览器目标不可用，会直接报错

补充说明：
- `PLAYWRIGHT_MODULE_PATH` 优先级高于 `PLAYWRIGHT_PACKAGE`
- `PLAYWRIGHT_WS_ENDPOINT` 优先级高于 `PLAYWRIGHT_CDP_ENDPOINT`
- 使用远端端点时，会忽略 `PLAYWRIGHT_EXECUTABLE_PATH` 和本地启动代理参数
- 当 Playwright 可用时，CSDN/知乎文章抓取以及通用网页抓取在遇到拦截页时也会尝试复用浏览器拿到的 cookie 进行重试
- 没有 Playwright 时，`fetchWebContent` 会停留在纯请求路径。公开页面通常仍可抓取，但依赖浏览器 cookie 或浏览器渲染 HTML 的页面可能失败。

**Windows 用户注意事项：**
- 在 PowerShell 中使用 `$env:VAR="value"; ` 语法
- 本地开发推荐使用 `npx cross-env` 实现跨平台兼容

### 本地安装

1. 克隆或下载本仓库
2. 安装依赖项：
```bash
npm install
```
   这里只会安装核心 MCP 服务依赖，浏览器兜底能力仍然需要你手动安装或连接 Playwright 客户端。
3. 构建服务器：
```bash
npm run build
```
4. 将服务器添加到您的MCP配置中：

**Cherry Studio:**
```json
{
  "mcpServers": {
    "web-search": {
      "name": "Web Search MCP",
      "type": "streamableHttp",
      "description": "Multi-engine web search with article fetching",
      "isActive": true,
      "baseUrl": "http://localhost:3000/mcp"
    }
  }
}
```

Windows 下的 NPX 配置：
```json
{
  "mcpServers": {
    "web-search": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "open-websearch@latest"
      ],
      "env": {
        "MODE": "stdio",
        "DEFAULT_SEARCH_ENGINE": "duckduckgo",
        "SYSTEMROOT": "C:/Windows"
      }
    }
  }
}
```

代理与 TLS 说明：
- open-websearch 现在会在内部显式关闭 Axios 对环境变量代理的自动读取，只走 `USE_PROXY` + `PROXY_URL` 这条显式代理路径。
- 当 `USE_PROXY=true` 时，所有基于 Axios 的网络请求都会统一走配置的 `PROXY_URL` 路径，不再出现一部分请求直连、一部分请求读取环境变量代理的混合行为。
- 如果 `PROXY_URL` 指向的是本地规则代理客户端，该客户端仍然可以自行决定哪些目标走 `DIRECT`、哪些目标走代理。
- 如果 `PROXY_URL` 指向固定上游代理或固定出口，百度、CSDN、掘金、Linux.do、GitHub 这类对地区较敏感的站点表现可能会和之前不同。
- 如果系统里已经设置了 `HTTP_PROXY` 或 `HTTPS_PROXY`，它们不再覆盖服务器内部请求行为。
- Windows 上如果站点缺少中间证书，优先建议配置 `NODE_EXTRA_CA_CERTS`。
- `FETCH_WEB_INSECURE_TLS=true` 只建议作为 `fetchWebContent` 的兜底方案使用，因为它会降低 TLS 校验强度。

**VSCode版(Claude开发扩展):**
```json
{
  "mcpServers": {
    "web-search": {
      "transport": {
        "type": "streamableHttp",
        "url": "http://localhost:3000/mcp"
      }
    },
    "web-search-sse": {
      "transport": {
        "type": "sse",
        "url": "http://localhost:3000/sse"
      }
    }
  }
}
```

**Claude桌面版:**
```json
{
  "mcpServers": {
    "web-search": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    },
    "web-search-sse": {
      "type": "sse",
      "url": "http://localhost:3000/sse"
    }
  }
}
```

**NPX命令行配置示例:**
```json
{
  "mcpServers": {
    "web-search": {
      "args": [
        "open-websearch@latest"
      ],
      "command": "npx",
      "env": {
        "MODE": "stdio",
        "DEFAULT_SEARCH_ENGINE": "duckduckgo",
        "ALLOWED_SEARCH_ENGINES": "duckduckgo,bing,exa"
      }
    }
  }
}
```

**Cherry Studio 本地 STDIO 配置 (Windows):**
```json
{
  "mcpServers": {
    "open-websearch-local": {
      "command": "node",
      "args": ["C:/你的项目路径/build/index.js"],
      "env": {
        "MODE": "stdio",
        "DEFAULT_SEARCH_ENGINE": "duckduckgo",
        "ALLOWED_SEARCH_ENGINES": "duckduckgo,bing,exa"
      }
    }
  }
}
```

### Docker部署

使用Docker Compose快速部署：

```bash
docker-compose up -d
```

或者直接使用Docker：
```bash
docker run -d --name web-search -p 3000:3000 -e ENABLE_CORS=true -e CORS_ORIGIN=* ghcr.io/aas-ee/open-web-search:latest
```

配置环境变量说明：

| 变量名 | 默认值                     | 可选值 | 说明 |
|--------|-------------------------|--------|------|
| `ENABLE_CORS` | `false`                 | `true`, `false` | 启用CORS |
| `CORS_ORIGIN` | `*`                     | 任何有效来源 | CORS来源配置 |
| `DEFAULT_SEARCH_ENGINE` | `bing`                  | `bing`, `duckduckgo`, `exa`, `brave` | 默认搜索引擎 |
| `USE_PROXY` | `false`                 | `true`, `false` | 启用HTTP代理 |
| `PROXY_URL` | `http://127.0.0.1:7890` | 任何有效URL | 代理服务器URL |
| `PORT` | `3000`                  | 1-65535 | 服务器端口 |

然后在MCP客户端中配置：
```json
{
  "mcpServers": {
    "web-search": {
      "name": "Web Search MCP",
      "type": "streamableHttp",
      "description": "Multi-engine web search with article fetching",
      "isActive": true,
      "baseUrl": "http://localhost:3000/mcp"
    },
    "web-search-sse": {
      "transport": {
        "name": "Web Search MCP",
        "type": "sse",
        "description": "Multi-engine web search with article fetching",
        "isActive": true,
        "url": "http://localhost:3000/sse"
      }
    }
  }
}
```

## 使用说明

服务器提供六个工具：`search`、`fetchLinuxDoArticle`、`fetchCsdnArticle`、`fetchGithubReadme`、`fetchJuejinArticle` 和 `fetchWebContent`。

本地 daemon HTTP API（`serve`、`status`、`GET /health`、`POST /search`、`POST /fetch-*`）请参考 [docs/http-api.md](docs/http-api.md)。

### search工具使用说明

```typescript
{
  "query": string,        // 搜索查询词
  "limit": number,        // 可选：返回结果数量（默认：10）
  "engines": string[]     // 可选：使用的引擎 (bing,baidu,linuxdo,csdn,duckduckgo,exa,brave,juejin) 默认bing
}
```

使用示例：
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "search",
  arguments: {
    query: "搜索内容",
    limit: 3,  // 可选参数
    engines: ["bing", "csdn", "duckduckgo", "exa", "brave", "juejin"] // 可选参数，支持多引擎组合搜索
  }
})
```

返回示例：
```json
[
  {
    "title": "示例搜索结果",
    "url": "https://example.com",
    "description": "搜索结果的描述文本...",
    "source": "来源",
    "engine": "使用的引擎"
  }
]
```


### fetchCsdnArticle工具使用说明

用于获取CSDN博客文章的完整内容。

```typescript
{
  "url": string    // search 工具使用csdn查询出的url
}
```

使用示例：
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "fetchCsdnArticle",
  arguments: {
    url: "https://blog.csdn.net/xxx/article/details/xxx"
  }
})
```

返回示例：
```json
[
  {
    "content": "示例搜索结果"
  }
]
```

### fetchLinuxDoArticle工具使用说明

用于获取Linux.do论坛文章的完整内容。

```typescript
{
  "url": string    // search 工具使用linuxdo查询出的url
}
```

使用示例：
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "fetchLinuxDoArticle",
  arguments: {
    url: "https://xxxx.json"
  }
})
```

返回示例：
```json
[
  {
    "content": "示例搜索结果"
  }
]

```


### fetchGithubReadme工具使用说明

用于获取GitHub仓库的README文件内容。

```typescript
{
  "url": string    // GitHub仓库URL（支持HTTPS、SSH格式）
}
```

使用示例：
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "fetchGithubReadme",
  arguments: {
    url: "https://github.com/Aas-ee/open-webSearch"
  }
})
```

支持的URL格式：
- HTTPS: `https://github.com/owner/repo`
- HTTPS with .git: `https://github.com/owner/repo.git`
- SSH: `git@github.com:owner/repo.git`
- 带参数的URL: `https://github.com/owner/repo?tab=readme`

返回示例：
```json
[
  {
    "content": "<div align=\"center\">\n\n# Open-WebSearch MCP Server..."
  }
]
```

### fetchWebContent工具使用说明

用于直接抓取公开可访问的 HTTP(S) 链接内容，支持 Markdown 文件（`.md`）和普通网页。

```typescript
{
  "url": string,         // 公开可访问的 HTTP(S) URL
  "maxChars": number     // 可选：最大返回字符数（1000-200000，默认30000）
}
```

使用示例：
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "fetchWebContent",
  arguments: {
    url: "https://raw.githubusercontent.com/Aas-ee/open-webSearch/main/README.md",
    maxChars: 12000
  }
})
```

返回示例：
```json
{
  "url": "https://raw.githubusercontent.com/Aas-ee/open-webSearch/main/README.md",
  "finalUrl": "https://raw.githubusercontent.com/Aas-ee/open-webSearch/main/README.md",
  "contentType": "text/plain; charset=utf-8",
  "title": "",
  "truncated": false,
  "content": "# Open-WebSearch MCP Server ..."
}
```


### fetchJuejinArticle工具使用说明

用于获取掘金文章的完整内容。

```typescript
{
  "url": string    // 掘金文章URL
}
```

使用示例：
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "fetchJuejinArticle",
  arguments: {
    url: "https://juejin.cn/post/7520959840199360563"
  }
})
```

支持的URL格式：
- `https://juejin.cn/post/{文章ID}`

返回示例：
```json
[
  {
    "content": "🚀 开源 AI 联网搜索工具：Open-WebSearch MCP 全新升级，支持多引擎 + 流式响应..."
  }
]
```


## 使用限制

由于本工具通过爬取多引擎搜索结果实现，请注意以下重要限制：

1. **频率限制**：
    - 短时间内搜索次数过多可能导致使用的引擎暂时屏蔽请求
    - 建议：
        - 保持合理的搜索频率
        - 审慎使用limit参数
        - 必要时可在搜索间设置延迟

2. **结果准确性**：
    - 依赖对应引擎的HTML结构，可能随引擎改版失效
    - 部分结果可能缺失描述等元数据
    - 复杂搜索运算符可能无法按预期工作

3. **法律条款**：
    - 本工具仅限个人使用
    - 请遵守对应引擎的服务条款
    - 建议根据实际使用场景实施适当的频率限制

4. **搜索引擎配置**：
   - 可通过环境变量`DEFAULT_SEARCH_ENGINE`设置默认搜索引擎
   - 支持的引擎有：bing, duckduckgo, exa, brave
   - 当搜索特定网站内容时，会自动使用默认搜索引擎

5. **代理服务配置**：
   - 当某些搜索引擎在特定地区不可用时，可配置HTTP代理
   - 通过环境变量`USE_PROXY=true`启用代理
   - 使用`PROXY_URL`配置代理服务器地址

## 贡献指南

欢迎提交问题报告和功能改进建议！

### 贡献者指南

如果您想要fork本仓库并发布自己的Docker镜像，需要进行以下配置：

#### GitHub Secrets配置

要启用自动Docker镜像构建和发布功能，请在您的GitHub仓库设置中添加以下secrets（Settings → Secrets and variables → Actions）：

**必需的Secrets:**
- `GITHUB_TOKEN`: GitHub自动提供（无需设置）

**可选的Secrets（用于阿里云ACR）:**
- `ACR_REGISTRY`: 您的阿里云容器镜像服务URL（例如：`registry.cn-hangzhou.aliyuncs.com`）
- `ACR_USERNAME`: 您的阿里云ACR用户名
- `ACR_PASSWORD`: 您的阿里云ACR密码
- `ACR_IMAGE_NAME`: 您在ACR中的镜像名称（例如：`your-namespace/open-web-search`）

#### CI/CD工作流程

仓库包含一个GitHub Actions工作流程（`.github/workflows/docker.yml`），会自动：

1. **触发条件**：
    - 推送到`main`分支
    - 推送版本标签（`v*`）
    - 手动触发workflow

2. **构建并推送到**：
    - GitHub Container Registry (ghcr.io) - 始终启用
    - 阿里云容器镜像服务 - 仅在配置ACR secrets时启用

3. **镜像标签**：
    - `ghcr.io/您的用户名/open-web-search:latest`
    - `您的ACR地址/您的镜像名:latest`（如果配置了ACR）

#### Fork和发布步骤：

1. **Fork仓库**到您的GitHub账户
2. **配置secrets**（如果需要ACR发布）：
    - 进入您fork的仓库的Settings → Secrets and variables → Actions
    - 添加上面列出的ACR相关secrets
3. **推送更改**到`main`分支或创建版本标签
4. **GitHub Actions将自动构建并推送**您的Docker镜像
5. **使用您的镜像**，更新Docker命令：
   ```bash
   docker run -d --name web-search -p 3000:3000 -e ENABLE_CORS=true -e CORS_ORIGIN=* ghcr.io/您的用户名/open-web-search:latest
   ```

#### 注意事项：
- 如果您不配置ACR secrets，工作流程将只发布到GitHub Container Registry
- 确保您的GitHub仓库已启用Actions功能
- 工作流程会使用您的GitHub用户名（转换为小写）作为GHCR镜像名称

<div align="center">

## Star History
如果项目对你有帮助，请考虑给个⭐ Star！

[![Star History Chart](https://api.star-history.com/svg?repos=Aas-ee/open-webSearch&type=Date)](https://www.star-history.com/#Aas-ee/open-webSearch&Date)

</div>
