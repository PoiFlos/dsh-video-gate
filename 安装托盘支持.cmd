@echo off
setlocal
rem 可选：给阀门窗口装上「最小化到托盘」能力（pystray + Pillow）。
rem 装到 gui\_vendor\ 里，不动系统 Python；卸载就是删掉那个目录。
set "HERE=%~dp0"
set "TARGET=%HERE%gui\_vendor"
set "MIRROR=https://mirrors.aliyun.com/pypi/simple/"

where python >nul 2>nul
if errorlevel 1 (
  echo 找不到 python，请先装 Python 3.10+ 并加入 PATH。
  pause
  exit /b 1
)

echo 正在把 pystray / Pillow 装到 %TARGET%
echo （只装到本仓库目录，不污染系统环境）
python -m pip install --disable-pip-version-check --no-warn-script-location ^
  --target "%TARGET%" --upgrade -i %MIRROR% pystray pillow
if errorlevel 1 (
  echo.
  echo 安装失败。可以换官方源再试：
  echo   python -m pip install --target "%TARGET%" pystray pillow
  pause
  exit /b 1
)
echo.
echo 装好了。以后关窗口会缩到托盘，图标在右下角。
pause
