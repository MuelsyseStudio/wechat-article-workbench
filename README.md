# 微信公众号文章采集、多号订阅与深度清洗工作台

> 零外部 `npm` 依赖 · 纯 Node.js 22+ 原生实现 · **Web 工作台 + CLI + 本地 MCP（stdio / Streamable HTTP）** 三合一  
> 将微信公众号文章转化为**无尾部脏字符、带规范 YAML Frontmatter、自动去重、支持多号定时追更**的高质量 Markdown，直接适配 Obsidian / Notion / 本地知识库与 AI RAG。

---

## 核心特性

- **双通道采集引擎**
  - **微信读书通道（全量历史 · 推荐）**：通过本地 Edge/Chrome 原生 CDP 驱动 [微信读书网页版](https://weread.qq.com/)，工作台内嵌实时微信扫码弹窗，Cookie 持久化在本地 `data/weread-profile/`。支持粘贴**单篇文章链接 / 含 `__biz=` 的合集链接 / `MP_WXS_<数字>`** 自动换算并拉取全量历史目录（含阅读数 `readNum`、点赞数 `likeNum`），断点续传 + 自动防限速熔断。
  - **公开链接直抓 & 本地目录净化**：支持单篇/多行公开链接、公开合集（`appmsgalbum`）、TXT/CSV/JSON 链接清单拖拽导入、自动探测合集与文内关联推荐，以及深度净化其他工具导出的脏 `.html`/`.md` 文件。
- **多公众号定时自动订阅**
  - 支持批量添加多个公众号、分组管理、单号独立启停、自定义检查间隔（15 分钟 ~ 每天）。
  - 极低请求量增量策略：每次仅检查最新 1–2 页，命中本地已归档文章立刻提前停止翻页，仅在发布新文章时拉取正文并清洗入库。
- **高质量 Markdown 深度清洗 & 多层去重**
  - 自动剥离微信头尾 UI 垃圾文本（`预览时标签不可点`、`继续滑动看下一个`、`取消 允许` 等）。
  - 自动写入规范 YAML Frontmatter（`title`、`account`、`author`、`published_at`、`ip_region`、`read_num`、`like_num`、`source_url`、`content_sha256`、`tags`）。
  - 基于 `review_id` / `article_key` / `source_url` / `content_sha256` / `公众号+日期+标题` 多层去重，自动维护 `00_文章索引.md`，支持一键导出 Excel UTF-8 BOM CSV 与 `wechat_articles.jsonl`。
- **开箱即用的本地 MCP 服务（12 个工具）**
  - 界面一键实时启停 `Streamable HTTP` MCP（默认 `http://127.0.0.1:4546/mcp`），同时也支持独立 `stdio` 模式（`node mcp-server.mjs`），可直接接入各类 AI 客户端检索、同步和管理公众号订阅。

---

## 快速开始

### 方式一：Windows 绿色便携版（推荐，零安装）

1. 前往本仓库 [Releases 页面](https://github.com/zianxu78-ux/wechat-article-workbench/releases) 下载 `WeChatArticleWorkbench-v*-win64-portable.zip` 并**全部解压**；
2. 双击 **`启动前端工作台.bat`**，等待 1–2 秒自动打开浏览器工作台（`http://127.0.0.1:4546`）；
3. 点击蓝色 **「登录微信读书」**，用微信扫工作台弹窗内的二维码完成登录，即可开始全量拉取或添加多号定时订阅。

> 环境要求：Windows 10 / 11（自带 Microsoft Edge 或已安装 Google Chrome），无需安装 Node.js。

### 方式二：从源码运行（Windows / macOS / Linux）

前置要求：**Node.js >= 22.0.0**（使用原生 `WebSocket` 与 `fetch`，无需 `npm install`），本机已安装 Microsoft Edge 或 Google Chrome。

```bash
git clone https://github.com/zianxu78-ux/wechat-article-workbench.git
cd wechat-article-workbench

# 启动 Web 可视化工作台 + 本地 MCP（自动打开浏览器）
node web-server.mjs --port 4546 --open
# Windows 也可直接双击 启动前端工作台.bat
# macOS / Linux 可运行 ./start.sh
```

---

## CLI 命令行用法

```bash
# 1. 微信读书扫码登录
node cli.mjs weread-login

# 2. 解析公众号全量历史目录（支持单篇文章链接 / 合集链接 / MP_WXS_...）
node cli.mjs weread-list MP_WXS_1234567890 --from 2024-01-01

# 3. 批量拉取正文并深度清洗为干净 Markdown（断点续传去重）
node cli.mjs weread-sync MP_WXS_1234567890 --from 2024-01-01 --delay 4000 --jsonl

# 4. 多公众号定时订阅管理
node cli.mjs sub-list
node cli.mjs sub-add MP_WXS_1234567890 https://mp.weixin.qq.com/s/xxxxxxx --category 投研
node cli.mjs sub-sync
node cli.mjs sub-watch --interval 60

# 5. 公开链接抓取 / 本地目录净化 / 知识库检索
node cli.mjs fetch https://mp.weixin.qq.com/s/xxxxxxx
node cli.mjs clean-dir "/path/to/exported/articles"
node cli.mjs index --keyword 关键词
```

---

## 本地 MCP 接入示例

**Streamable HTTP（随 Web 工作台一键启停）：**
```json
{
  "mcpServers": {
    "wechatArticleCleaner": {
      "type": "streamableHttp",
      "url": "http://127.0.0.1:4546/mcp"
    }
  }
}
```

**Stdio（无需打开 Web 界面）：**
```json
{
  "mcpServers": {
    "wechatArticleCleaner": {
      "command": "node",
      "args": ["/absolute/path/to/wechat-article-workbench/mcp-server.mjs"]
    }
  }
}
```

---

## 自行构建发给朋友的绿色便携 ZIP

在 Windows 上运行内置打包脚本，自动剥离你的个人 Cookie（`data/`）与已下载文章（`公众号清洗归档/`），一键生成纯净的绿色便携压缩包：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-portable-zip.ps1
```

产物输出在 `dist/` 目录：
- `WeChatArticleWorkbench-v*-win64-portable.zip`（含官方 `node.exe`，解压双击即用）
- `WeChatArticleWorkbench-v*-source.zip`（纯源码轻量包）

---

## 隐私与合规声明

- 本工具所有数据（微信读书登录态 `data/weread-profile/`、订阅配置 `data/subscriptions.json`、归档文章 `公众号清洗归档/`）均**严格保存在用户本地设备**，无任何远程上报或第三方服务器中转。
- 严格遵循合规边界：**绝不绕过人机验证、验证码或登录鉴权**；遇到平台频控或登录失效会立即安全停止并保留已完成归档。
- 本项目仅供个人学习、研究与合法资料整理备份，请尊重原创作者版权并遵守微信与微信读书平台相关用户协议，请勿高频滥用或用于商业非法采集。

## License

[MIT](./LICENSE)
