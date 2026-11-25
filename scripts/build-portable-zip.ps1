<#
.SYNOPSIS
  Build clean, zero-leak release archives for friends & GitHub Releases:
  1) dist/WeChatArticleWorkbench-v<ver>-win64-portable.zip (includes runtime/node.exe, double-click ready)
  2) dist/WeChatArticleWorkbench-v<ver>-source.zip (tiny source-only package for Node 22+ / macOS / Linux)
#>
[CmdletBinding()]
param(
  [string]$NodeExePath = ""
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PkgJson = Get-Content -LiteralPath (Join-Path $ProjectRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$Version = $PkgJson.version

$DistDir = Join-Path $ProjectRoot "dist"
$StagingRoot = Join-Path $DistDir "staging"
$SourceStage = Join-Path $StagingRoot "WeChatArticleWorkbench-source"
$PortableStage = Join-Path $StagingRoot "WeChatArticleWorkbench"

# Clean previous staging
if (Test-Path -LiteralPath $StagingRoot) {
  Remove-Item -LiteralPath $StagingRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $DistDir -Force | Out-Null
New-Item -ItemType Directory -Path $SourceStage -Force | Out-Null
New-Item -ItemType Directory -Path $PortableStage -Force | Out-Null

# Explicit allowlist — NEVER sweeps in data/, 公众号清洗归档/, .git/, or logs
$RootFiles = @(
  "cli.mjs",
  "mcp-server.mjs",
  "web-server.mjs",
  "package.json",
  "README.md",
  "LICENSE",
  "启动前端工作台.bat",
  "wxclean.cmd",
  "start.sh"
)

function Copy-CleanTree {
  param([string]$TargetDir)
  foreach ($f in $RootFiles) {
    $src = Join-Path $ProjectRoot $f
    if (-not (Test-Path -LiteralPath $src)) {
      throw "Missing required file: $src"
    }
    Copy-Item -LiteralPath $src -Destination (Join-Path $TargetDir $f) -Force
  }

  $srcCodeDir = Join-Path $TargetDir "src"
  $publicDir = Join-Path $TargetDir "public"
  New-Item -ItemType Directory -Path $srcCodeDir -Force | Out-Null
  New-Item -ItemType Directory -Path $publicDir -Force | Out-Null

  Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "src") -Filter "*.mjs" | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $srcCodeDir $_.Name) -Force
  }
  Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "public") -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $publicDir $_.Name) -Force
  }
}

Copy-CleanTree -TargetDir $SourceStage
Copy-CleanTree -TargetDir $PortableStage

# Add quick-start text file inside the Windows portable package
$QuickStartTxt = @"
微信公众号文章采集、多号订阅与清洗工作台 v$Version（Windows 绿色便携版）
========================================================================

【零安装 3 步上手】
1. 务必先将整个压缩包「全部解压」到任意文件夹（不要在压缩包预览里直接双击）；
2. 双击运行「启动前端工作台.bat」，稍等 1~2 秒会自动打开浏览器工作台；
3. 在工作台页面中：
   - 点击蓝色「登录微信读书」，直接用手机微信扫弹窗里的二维码（登录态自动保存在本地 data\weread-profile\）；
   - 粘贴任意一篇目标公众号的文章链接、合集链接或 MP_WXS_<数字>，即可全量解析并批量清洗下载为干净 Markdown；
   - 切换到「公众号订阅」标签，可一次性批量添加多个博主，开启定时自动检查更新！

【下载文件在哪里？】
默认自动保存在本文件夹下的「公众号清洗归档」目录中（按公众号分文件夹，附带 00_文章索引.md 与 CSV 导出）。

【命令行 CLI 用法（可选，无需安装 Node.js）】
在解压目录打开终端 / PowerShell，即可直接运行内置 CLI：
  .\wxclean.cmd doctor                         一键环境与归档体检
  .\wxclean.cmd login                          扫码登录微信读书
  .\wxclean.cmd search "晚点LatePost"          按公众号名换算 MP_WXS_...
  .\wxclean.cmd sync MP_WXS_1234567890         拉取并清洗 Markdown
  .\wxclean.cmd index -q 关键词                检索本地已归档文章
  .\wxclean.cmd --help                         查看全部 CLI 命令

【遇到 -2041 (ErrorNeedVerify) 怎么恢复？】
1. 先关闭「公众号订阅」里的「定时自动更新」，停止所有请求；
2. 打开手机「微信读书 App」->「我」->「设置」->「登录管理」，退出旧的网页端设备，并在 App 里正常翻阅几页（如有官方验证请本人手动完成）；
3. 回到工作台点击「登录微信读书」重新微信扫码获取全新会话即可恢复（后续建议等待 4~6 秒、单日 ≤ 1200 篇）。
（如需彻底重置本地登录档案，关闭独立 Edge 窗口后删除 data\weread-profile\ 重新扫码即可，不影响已归档文章。）

【温馨提示】
- 本绿色版已内置官方 Node.js 运行时（runtime\node.exe），无需额外安装任何环境；
- 需要本机装有 Microsoft Edge（Win10/Win11 默认自带）或 Google Chrome；
- 首次全量回溯历史文章建议等待时间保持 4~6 秒、单日拉取总量不要超过 1200~1500 篇（内置每日安全上限默认 1200 篇），避免触发微信读书 -2041 频控校验。
"@
Set-Content -LiteralPath (Join-Path $PortableStage "使用说明（先看这里）.txt") -Value $QuickStartTxt -Encoding UTF8

# Locate single-binary node.exe for portable Windows bundle
if (-not $NodeExePath) {
  $NodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $NodeCmd) {
    throw "Cannot locate node.exe on PATH. Pass -NodeExePath explicitly."
  }
  $NodeExePath = $NodeCmd.Source
}
if (-not (Test-Path -LiteralPath $NodeExePath)) {
  throw "node.exe not found at: $NodeExePath"
}

$RuntimeDir = Join-Path $PortableStage "runtime"
New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
Copy-Item -LiteralPath $NodeExePath -Destination (Join-Path $RuntimeDir "node.exe") -Force

# Automated privacy & leak audit before zipping
foreach ($dirToCheck in @($SourceStage, $PortableStage)) {
  foreach ($forbidden in @("data", "公众号清洗归档", ".git", "node_modules", "dist")) {
    if (Test-Path -LiteralPath (Join-Path $dirToCheck $forbidden)) {
      throw "LEAK GUARD FAILED: Forbidden path '$forbidden' found in staging dir: $dirToCheck"
    }
  }
  $badFiles = Get-ChildItem -LiteralPath $dirToCheck -Recurse -File | Where-Object {
    $_.Name -match "weread-profile|mp-admin-profile|subscriptions\.json|weread-accounts\.json|push-config\.json|index\.json"
  }
  if ($badFiles) {
    throw "LEAK GUARD FAILED: Found personal data files in staging dir!"
  }
}

# Build ZIP archives
$PortableZip = Join-Path $DistDir "WeChatArticleWorkbench-v$Version-win64-portable.zip"
$SourceZip = Join-Path $DistDir "WeChatArticleWorkbench-v$Version-source.zip"

if (Test-Path -LiteralPath $PortableZip) { Remove-Item -LiteralPath $PortableZip -Force }
if (Test-Path -LiteralPath $SourceZip) { Remove-Item -LiteralPath $SourceZip -Force }

Compress-Archive -Path $PortableStage -DestinationPath $PortableZip -CompressionLevel Optimal
Compress-Archive -Path $SourceStage -DestinationPath $SourceZip -CompressionLevel Optimal

# Clean up staging directory after zipping
Remove-Item -LiteralPath $StagingRoot -Recurse -Force

$pInfo = Get-Item -LiteralPath $PortableZip
$sInfo = Get-Item -LiteralPath $SourceZip
$pHash = (Get-FileHash -LiteralPath $PortableZip -Algorithm SHA256).Hash
$sHash = (Get-FileHash -LiteralPath $SourceZip -Algorithm SHA256).Hash

Write-Host ""
Write-Host "=== 打包成功（隐私泄露检查已通过） ===" -ForegroundColor Green
Write-Host ("1) Windows 绿色便携版（发朋友 / 上传 GitHub Release）:")
Write-Host ("   路径: {0}" -f $PortableZip)
Write-Host ("   大小: {0:N2} MB | SHA256: {1}" -f ($pInfo.Length / 1MB), $pHash)
Write-Host ("2) 纯源码轻量版（Mac / Linux / 开发者）:")
Write-Host ("   路径: {0}" -f $SourceZip)
Write-Host ("   大小: {0:N2} KB | SHA256: {1}" -f ($sInfo.Length / 1KB), $sHash)
