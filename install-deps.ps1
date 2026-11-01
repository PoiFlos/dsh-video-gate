#Requires -Version 5.1
<#
.SYNOPSIS
  为 dsh-video-gate 下载并校验依赖（ffmpeg / whisper.cpp / 模型）。

.DESCRIPTION
  只做三件事：下载、核对 sha256、解压到 <仓库>\tools\。
  不装服务、不写注册表、不改 PATH、不需要管理员权限。已存在且哈希正确的文件会跳过。

.PARAMETER Plan
  只解析下载地址与哈希并打印，不下载任何文件（用于确认来源）。

.PARAMETER Model
  small（约 465MB，默认）或 medium（约 1.46GB，更准更慢）。

.PARAMETER SkipModel
  只装二进制，不下载模型。

.PARAMETER ToolsDir
  依赖装到哪。默认是仓库的**上一级**的 tools\（插件就是去那儿找的）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-deps.ps1 -Plan
  powershell -ExecutionPolicy Bypass -File .\install-deps.ps1
#>
[CmdletBinding()]
param(
  [switch]$Plan,
  [ValidateSet('small', 'medium')][string]$Model = 'small',
  [switch]$SkipModel,
  [string]$ToolsDir = ''
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
# 插件按 <插件目录>\..\tools\ 找二进制，所以默认装到仓库的上一级
$ToolsDir = if ($PSBoundParameters.ContainsKey('ToolsDir') -and $ToolsDir) { $ToolsDir } else { Join-Path (Split-Path -Parent $RepoRoot) 'tools' }
$TmpDir = Join-Path ([IO.Path]::GetTempPath()) ('dsh-video-gate-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
$script:Curl = $null
$curlCmd = Get-Command curl.exe -ErrorAction SilentlyContinue
if ($curlCmd) { $script:Curl = $curlCmd.Source }

function Say($text) { Write-Host $text }
function Step($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  OK  $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  !!  $text" -ForegroundColor Yellow }

function Get-Json($url) {
  Invoke-RestMethod -Uri $url -Headers @{ 'User-Agent' = $UA; 'Accept' = 'application/json' } -UseBasicParsing -TimeoutSec 60
}

function Get-File($url, $out, $headers) {
  # 优先用 curl.exe（Win10+ 自带）：它能跟 308 重定向、断点更稳、大文件更快
  if ($script:Curl) {
    $argv = @('-sS', '-L', '--retry', '3', '--retry-delay', '2', '--max-time', '1800', '-A', $UA, '-o', $out)
    if ($headers) { foreach ($k in $headers.Keys) { $argv += @('-H', "$k`: $($headers[$k])") } }
    $argv += $url
    & $script:Curl @argv
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $out)) { throw "下载失败：$url" }
    return
  }
  if (-not $headers) { $headers = @{ 'User-Agent' = $UA } }
  Invoke-WebRequest -Uri $url -OutFile $out -Headers $headers -UseBasicParsing -TimeoutSec 1800
}

function Get-Text($url) {
  if ($script:Curl) {
    $text = & $script:Curl @('-sS', '-L', '--max-time', '60', '-A', $UA, $url)
    if ($LASTEXITCODE -ne 0) { throw "抓取失败：$url" }
    return ($text -join "`n")
  }
  (Invoke-WebRequest -Uri $url -Headers @{ 'User-Agent' = $UA } -UseBasicParsing -TimeoutSec 60).Content
}

function Hash-Of($path) { (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower() }

function Confirm-Hash($path, $expected, $label) {
  $actual = Hash-Of $path
  if ($actual -ne $expected.ToLower()) {
    throw "$label 哈希不符：期望 $expected，实际 $actual"
  }
  Ok "$label sha256 匹配"
}

New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
Say "仓库：$RepoRoot"
Say "临时目录：$TmpDir"
Say "模式：$(if ($Plan) { '仅解析（不下载）' } else { '下载并安装' })"

# ---------------------------------------------------------------- 1. ffmpeg
Step '1/3 ffmpeg'
$meta = Get-Json 'https://pypi.org/pypi/imageio-ffmpeg/json'
$wheel = $meta.urls | Where-Object { $_.filename -like '*win_amd64.whl' } | Select-Object -First 1
if (-not $wheel) { throw '在 PyPI 上没找到 imageio-ffmpeg 的 win_amd64 wheel' }
$wheelUrl = $wheel.url
$wheelSha = $wheel.digests.sha256
Say "  来源：imageio-ffmpeg $($meta.info.version)（内部打包 gyan.dev 的 ffmpeg essentials）"
Say "  地址：$wheelUrl"
Say "  哈希：$wheelSha"

$ffmpegExe = Join-Path $ToolsDir 'ffmpeg\ffmpeg.exe'
$ffmpegOk = (Test-Path $ffmpegExe)
if ($ffmpegOk) {
  $ver = (& $ffmpegExe -version 2>&1 | Select-Object -First 1)
  Ok "已存在：$ver"
} elseif ($Plan) {
  Say '  （计划）下载 wheel → 解压 → 复制 ffmpeg.exe 到 tools\ffmpeg\'
} else {
  $whl = Join-Path $TmpDir 'ffmpeg.whl'
  try {
    Get-File $wheelUrl $whl
  } catch {
    Warn "官方源失败，改用阿里云镜像：$($_.Exception.Message)"
    $mirror = $wheelUrl -replace '^https://files\.pythonhosted\.org/', 'https://mirrors.aliyun.com/pypi/'
    Get-File $mirror $whl
  }
  Confirm-Hash $whl $wheelSha 'ffmpeg wheel'
  $zip = Join-Path $TmpDir 'ffmpeg.zip'
  Copy-Item $whl $zip -Force
  $ex = Join-Path $TmpDir 'ffmpeg-x'
  Expand-Archive -Path $zip -DestinationPath $ex -Force
  $bin = Get-ChildItem $ex -Recurse -Filter 'ffmpeg-win-*.exe' | Select-Object -First 1
  if (-not $bin) { throw 'wheel 里没有找到 ffmpeg 可执行文件' }
  New-Item -ItemType Directory -Force -Path (Split-Path $ffmpegExe) | Out-Null
  Copy-Item $bin.FullName $ffmpegExe -Force
  Ok "已安装 $ffmpegExe（$([math]::Round((Get-Item $ffmpegExe).Length / 1MB, 1)) MB）"
}

# --------------------------------------------------------------- 2. whisper
Step '2/3 whisper.cpp'
$wanted = 'whisper-bin-x64.zip'
$release = $null
$asset = $null
$releases = Get-Json 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15'
foreach ($rel in $releases) {
  $hit = $rel.assets | Where-Object { $_.name -eq $wanted } | Select-Object -First 1
  if ($hit) { $release = $rel; $asset = $hit; break }
}
if (-not $asset) { throw "最近 15 个 release 里没有 $wanted" }
Say "  来源：whisper.cpp $($release.tag_name) / $($asset.name)"
Say "  地址：$($asset.browser_download_url)"
Say "  哈希：$($asset.digest)"

$whisperCli = Join-Path $ToolsDir 'whisper\whisper-cli.exe'
if (Test-Path $whisperCli) {
  Ok '已存在：tools\whisper\whisper-cli.exe'
} elseif ($Plan) {
  Say '  （计划）经 api.github.com 资产端点下载 → 解压 → 只保留 CLI 与所需 DLL'
} else {
  $zip = Join-Path $TmpDir 'whisper.zip'
  $apiUrl = "https://api.github.com/repos/ggml-org/whisper.cpp/releases/assets/$($asset.id)"
  Get-File $apiUrl $zip @{ 'User-Agent' = $UA; 'Accept' = 'application/octet-stream' }
  if ($asset.digest) { Confirm-Hash $zip ($asset.digest -replace '^sha256:', '') 'whisper 包' }
  $ex = Join-Path $TmpDir 'whisper-x'
  Expand-Archive -Path $zip -DestinationPath $ex -Force
  $releaseDir = Get-ChildItem $ex -Recurse -Directory -Filter 'Release' | Select-Object -First 1
  $srcDir = if ($releaseDir) { $releaseDir.FullName } else { $ex }
  $keep = @('whisper-cli.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll')
  $keep += (Get-ChildItem $srcDir -Filter 'ggml-cpu-*.dll' | ForEach-Object { $_.Name })
  $dst = Split-Path $whisperCli
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  foreach ($name in $keep) {
    $p = Join-Path $srcDir $name
    if (Test-Path $p) { Copy-Item $p (Join-Path $dst $name) -Force }
  }
  Ok "已安装 $dst（$($keep.Count) 个文件；whisper-server.exe 已刻意排除）"
}

# ------------------------------------------------------------------ 3. 模型
if (-not $SkipModel) {
  Step "3/3 模型 ggml-$Model"
  $file = "ggml-$Model.bin"
  $pointerUrl = "https://hf-mirror.com/ggerganov/whisper.cpp/raw/main/$file"
  $pointer = Get-Text $pointerUrl
  $m = [regex]::Match($pointer, 'oid sha256:([0-9a-f]{64})')
  $sizeMatch = [regex]::Match($pointer, 'size (\d+)')
  if (-not $m.Success) { throw "读不到 $file 的 LFS 指针（拿不到官方哈希）" }
  $modelSha = $m.Groups[1].Value
  Say "  来源：hf-mirror.com/ggerganov/whisper.cpp/$file"
  Say "  哈希：$modelSha"
  if ($sizeMatch.Success) { Say "  大小：$([math]::Round([int64]$sizeMatch.Groups[1].Value / 1MB, 0)) MB" }

  $modelPath = Join-Path $ToolsDir "whisper\models\$file"
  if ((Test-Path $modelPath) -and ((Hash-Of $modelPath) -eq $modelSha)) {
    Ok '已存在且哈希正确'
  } elseif ($Plan) {
    Say "  （计划）下载到 tools\whisper\models\$file"
  } else {
    New-Item -ItemType Directory -Force -Path (Split-Path $modelPath) | Out-Null
    $tmpModel = "$modelPath.part"
    Get-File "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/$file" $tmpModel
    Confirm-Hash $tmpModel $modelSha $file
    Move-Item $tmpModel $modelPath -Force
    Ok "已安装 $modelPath"
  }
}

if (-not $Plan) {
  Remove-Item $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
}

Step '完成'
if ($Plan) {
  Say '以上只做了来源解析，没有下载任何东西。去掉 -Plan 再跑一次即会真正安装。'
} else {
  Say '依赖已就位。接下来：'
  Say '  1) 在 DeepSeek Harness 里装插件：plugin_manager action=install_bundle target=<本仓库路径>'
  Say '  2) 重启 DSH'
  Say '  3) 发一句「启用读取视频插件」'
  Say "  4) 把 localRoots 配到 %USERPROFILE%\.dsh\video-gate\state.json（指向放视频的目录）"
}
