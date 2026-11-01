@echo off
setlocal
rem 双击即可：下载 + 校验 + 解压 ffmpeg / whisper / 模型。
rem 只是为了免去开 PowerShell / 改 ExecutionPolicy，做的事和 install-deps.ps1 完全一样。
set "HERE=%~dp0"

if not exist "%HERE%install-deps.ps1" (
  echo 找不到 install-deps.ps1，请在仓库根目录运行本文件。
  pause
  exit /b 1
)

echo 即将检查并安装依赖（已就绪的会跳过）。
echo 需要下载时：ffmpeg 约 84MB、whisper 约 11MB、模型约 465MB。
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%install-deps.ps1" %*
echo.
echo 完成后按任意键关闭。
pause >nul
