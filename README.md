<div align="center">

# Open-WebSearch MCP 服务器

[![ModelScope](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/Aas-ee/3af09e0f4c7821fb2e9acb96483a5ff0/raw/badge.json&color=%23de5a16)](https://www.modelscope.cn/mcp/servers/Aasee1/open-webSearch)
[![Trust Score](https://archestra.ai/mcp-catalog/api/badge/quality/Aas-ee/open-webSearch)](https://archestra.ai/mcp-catalog/aas-ee__open-websearch)
[![smithery badge](https://smithery.ai/badge/@Aas-ee/open-websearch)](https://smithery.ai/server/@Aas-ee/open-websearch)
![Version](https://img.shields.io/github/v/release/Aas-ee/open-websearch)
![License](https://img.shields.io/github/license/Aas-ee/open-websearch)
![Issues](https://img.shields.io/github/issues/Aas-ee/open-websearch)

**🇨🇳 中文 | [🇺🇸 English](./README-en.md)**

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
    - linux.do
    - csdn
    - duckduckgo
    - exa
    - brave
    - juejin
- 支持HTTP代理配置，轻松解决网络访问限制
- 无需API密钥或身份验证
- 返回带标题、URL和描述的结构化结果
- 可配置每次搜索返回的结果数量
- 可自定义默认搜索引擎
- 支持获取单篇文章内容
    - csdn
    - github（README文件）
    - 掘金（juejin）
    - linux.do

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
| `DEFAULT_SEARCH_ENGINE` | `bing`                  | `bing`, `duckduckgo`, `exa`, `brave`, `baidu`, `csdn`, `juejin`, `linuxdo` | 默认搜索引擎                               |
| `USE_PROXY` | `false`                 | `true`, `false` | 启用HTTP代理                             |
| `PROXY_URL` | `http://127.0.0.1:10809` | 任何有效URL | 代理服务器URL                             |
| `MODE` | `both`                  | `both`, `http`, `stdio` | 服务器模式：同时支持HTTP+STDIO、仅HTTP或仅STDIO    |
| `PORT` | `3000`                  | 1-65535 | 服务器端口                                |
| `ALLOWED_SEARCH_ENGINES` | 空（全部可用） | 逗号分隔的引擎名称 | 限制可使用的搜索引擎，如默认搜索引擎不在范围，则默认第一个为默认搜索引擎 |
| `MAX_DESCRIPTION_LENGTH` | 无限制 | 正整数 | 搜索结果描述的全局最大长度，超出部分将被截断 |
| `MCP_TOOL_SEARCH_NAME` | `search` | 有效的MCP工具名称 | 搜索工具的自定义名称 |
| `MCP_TOOL_FETCH_LINUXDO_NAME` | `fetchLinuxDoArticle` | 有效的MCP工具名称 | Linux.do文章获取工具的自定义名称 |
| `MCP_TOOL_FETCH_CSDN_NAME` | `fetchCsdnArticle` | 有效的MCP工具名称 | CSDN文章获取工具的自定义名称 |
| `MCP_TOOL_FETCH_GITHUB_NAME` | `fetchGithubReadme` | 有效的MCP工具名称 | GitHub README获取工具的自定义名称 |
| `MCP_TOOL_FETCH_JUEJIN_NAME` | `fetchJuejinArticle` | 有效的MCP工具名称 | 掘金文章获取工具的自定义名称 |

**常用配置示例：**
```bash
# 启用代理（适用于网络受限地区）
USE_PROXY=true PROXY_URL=http://127.0.0.1:7890 npx open-websearch@latest

# 完整配置
DEFAULT_SEARCH_ENGINE=duckduckgo ENABLE_CORS=true USE_PROXY=true PROXY_URL=http://127.0.0.1:7890 PORT=8080 npx open-websearch@latest
```

**Windows 用户注意事项：**
- 在 PowerShell 中使用 `$env:VAR="value"; ` 语法
- 本地开发推荐使用 `npx cross-env` 实现跨平台兼容

### 本地安装

1. 克隆或下载本仓库
2. 安装依赖项：
```bash
npm install
```
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
| `DEFAULT_SEARCH_ENGINE` | `bing`                  | `bing`, `duckduckgo`, `exa`, `brave`, `baidu`, `csdn`, `juejin`, `linuxdo` | 默认搜索引擎 |
| `USE_PROXY` | `false`                 | `true`, `false` | 启用HTTP代理 |
| `PROXY_URL` | `http://127.0.0.1:10809` | 任何有效URL | 代理服务器URL |
| `MODE` | `both`                  | `both`, `http`, `stdio` | 服务器模式 |
| `PORT` | `3000`                  | 1-65535 | 服务器端口 |
| `ALLOWED_SEARCH_ENGINES` | 空（全部可用） | 逗号分隔的引擎名称 | 限制可使用的搜索引擎 |
| `MAX_DESCRIPTION_LENGTH` | 无限制 | 正整数 | 搜索结果描述最大长度 |

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

服务器提供五个工具：`search`、`fetchCsdnArticle`、`fetchGithubReadme`、`fetchJuejinArticle` 和 `fetchLinuxDoArticle`。

### search工具使用说明

```typescript
{
  "query": string,        // 搜索查询词
  "limit": number,        // 可选：返回结果数量（默认：10，范围：1-50）
  "engines": string[],    // 可选：使用的引擎 (bing,baidu,linuxdo,csdn,duckduckgo,exa,brave,juejin) 默认bing，大小写不敏感
  "maxDescriptionLength": number  // 可选：单次调用的描述最大长度，优先级高于全局 MAX_DESCRIPTION_LENGTH
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
