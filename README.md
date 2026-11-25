# 微信公众号文章采集、多号订阅与深度清洗工作台

> 零外部 `npm` 依赖 · 纯 Node.js 22+ 原生实现 · **Web 工作台 + CLI + 本地 MCP（stdio / Streamable HTTP）** 三合一  
> 将微信公众号文章转化为**无尾部脏字符、带规范 YAML Frontmatter、自动去重、支持多号定时追更**的高质量 Markdown，直接适配 Obsidian / Notion / 本地知识库与 AI RAG。

---

## 核心特性

- **双通道采集 + 按公众号名搜号换算**
  - **微信读书通道（全量历史 + 阅读点赞数 · 推荐）**：通过本地 Edge/Chrome 原生 CDP 驱动 [微信读书网页版](https://weread.qq.com/)，工作台内嵌实时微信扫码弹窗，Cookie 持久化在本地 `data/weread-profile/`，支持 `wr_rt` 无感续期。支持输入**公众号名称 / 单篇文章链接 / 含 `__biz=` 的合集链接 / `MP_WXS_<数字>`** 自动换算并拉取全量历史目录（含阅读数 `readNum`、点赞数 `likeNum`），断点续传 + 自动防限速熔断 + 单日配额护栏。
  - **搜公众号名助手（`searchbiz` 换算 `MP_WXS_...`）**：可选扫码个人微信公众平台（`data/mp-admin-profile/`），直接输入任意公众号名称秒查并换算为 `MP_WXS_<数字>` 与 `__biz`，一键填入采集框或加入多号定时订阅（无需先手动找文章链接）。
  - **公开链接直抓 & 本地目录净化**：支持单篇/多行公开链接、公开合集（`appmsgalbum`）、TXT/CSV/JSON 链接清单拖拽导入、自动探测合集与文内关联推荐，以及深度净化其他工具导出的脏 `.html`/`.md` 文件。
- **多公众号定时自动订阅**
  - 支持批量添加多个公众号、分组管理、单号独立启停、自定义检查间隔（15 分钟 ~ 每天）。
  - 极低请求量增量策略：每次仅检查最新 1–2 页，命中本地已归档文章立刻提前停止翻页，仅在发布新文章时拉取正文并清洗入库。
- **高质量 Markdown 深度清洗 & 多层去重**
  - 自动剥离微信头尾 UI 垃圾文本（`预览时标签不可点`、`继续滑动看下一个`、`取消 允许` 等）。
  - 自动写入规范 YAML Frontmatter（`title`、`account`、`author`、`published_at`、`ip_region`、`read_num`、`like_num`、`source_url`、`content_sha256`、`tags`）。
  - 基于 `review_id` / `article_key` / `source_url` / `content_sha256` / `公众号+日期+标题+时间戳` 多层去重（同日同标题不同发布时间会自动保留并追加 `_HHmm` 后缀），自动维护 `00_文章索引.md`，支持一键导出 Excel UTF-8 BOM CSV 与 `wechat_articles.jsonl`。
- **开箱即用的本地 MCP 服务（14 个工具）**
  - 界面一键实时启停 `Streamable HTTP` MCP（默认 `http://127.0.0.1:4546/mcp`），同时也支持独立 `stdio` 模式（`node mcp-server.mjs`），可直接接入各类 AI 客户端搜号、检索、同步和管理公众号订阅。

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

## CLI 命令行工具（`wxclean`）

本仓库内置零依赖完整命令行工具 **`wxclean`**，支持全局安装、Windows 便携版直接调用或源码运行，并且所有命令均支持 `--json` 纯 JSON 输出（方便自动化脚本与 AI 管道调用）。

### 安装与调用方式

```bash
# 方式 A：全局注册 wxclean 命令（推荐，之后在任意目录直接输入 wxclean）
npm link
wxclean doctor

# 方式 B：Windows 绿色便携版（免装 Node.js，解压后直接运行）
.\wxclean.cmd doctor
.\wxclean.cmd --help

# 方式 C：源码目录直接运行
node cli.mjs doctor
```

### 常用命令速查

```bash
# 1. 环境体检 / 今日配额 / 启动 Web 工作台与 MCP
wxclean doctor                           # 一键检查 Node、浏览器、登录态、配额、归档与订阅
wxclean quota                            # 查看今日拉取篇数 vs 单日安全上限（默认 1200）
wxclean serve --open                     # 启动本地 Web 工作台（默认端口 4546）并自动打开浏览器
wxclean mcp                              # 启动 stdio MCP 服务（加 --http 启动 HTTP 端点）

# 2. 登录 & 按公众号名称搜号换算
wxclean login                            # 微信扫码登录微信读书
wxclean mp-login                         # 可选：扫码个人公众号后台（用于按名称搜号）
wxclean search "晚点LatePost"            # 按名称搜公众号，自动换算为 MP_WXS_<数字> 与 __biz

# 3. 全量目录解析 & 批量下载清洗（支持公众号名 / 单篇链接 / 合集链接 / MP_WXS_...）
wxclean list MP_WXS_1234567890 --from 2024-01-01
wxclean sync MP_WXS_1234567890 --from 2024-01-01 --delay 4000 --only-original --jsonl

# 4. 多公众号定时订阅管理
wxclean sub                              # 查看所有订阅与自动更新设置
wxclean sub-add MP_WXS_1234567890 --category 投研 --from 2025-01-01
wxclean sub-toggle MP_WXS_1234567890 --off
wxclean sub-sync                         # 立即增量同步所有已启用订阅
wxclean sub-watch --interval 60          # 终端常驻守护，每 60 分钟自动检查更新

# 5. 公开链接直抓 / 本地目录清洗 / 知识库检索、阅读与导出
wxclean fetch https://mp.weixin.qq.com/s/xxxxxxx
wxclean clean-dir "/path/to/exported/articles"
wxclean index -a 晚点LatePost -q 财报 -n 20
wxclean read 财报                         # 直接在终端输出匹配的干净 Markdown 全文
wxclean export-csv                       # 导出 Excel UTF-8 BOM 汇总 CSV
wxclean export-jsonl                     # 导出 RAG/AI 就绪的 wechat_articles.jsonl
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

## 隐私、防风控与合规声明

- **防风控配额建议（重要）**：微信读书对单个账号存在单日接口频率保护（实测单日连续拉取接近 1,500~1,800 篇易触发 `-2041 ErrorNeedVerify` 安全校验）。本工作台已内置**单日安全上限（默认 `1,200` 篇/日，界面可自定义）**、**每 35 篇自动冷却**、**软频控「操作频繁」自动退避重试**以及**长期凭证 `wr_rt` 无感续期**；批量回溯大号历史时建议等待时间设为 `4~6` 秒并分天完成（已归档篇目和已知空文下次均 0 耗时自动跳过）。
- 本工具所有数据（微信读书登录态 `data/weread-profile/`、公众号后台搜号登录态 `data/mp-admin-profile/`、订阅配置 `data/subscriptions.json`、归档文章 `公众号清洗归档/`）均**严格保存在用户本地设备**，无任何远程上报或第三方服务器中转。
- 严格遵循合规边界：**绝不绕过人机验证、验证码或登录鉴权**；遇到平台频控或登录失效会立即安全停止并保留已完成归档。
- 本项目仅供个人学习、研究与合法资料整理备份，请尊重原创作者版权并遵守微信与微信读书平台相关用户协议，请勿高频滥用或用于商业非法采集。

## License

[MIT](./LICENSE)
