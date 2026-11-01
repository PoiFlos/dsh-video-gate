@echo off
setlocal
rem 视频通道阀门 —— 双击启动。找不到 pythonw 时退回 python（会带一个控制台窗口）。
set "HERE=%~dp0"
if exist "%HERE%gui\valve.py" goto run
echo 找不到 gui\valve.py，请在仓库根目录运行本文件。
pause
exit /b 1

:run
where pythonw >nul 2>nul
if %errorlevel%==0 (
  start "" pythonw "%HERE%gui\valve.py"
  exit /b 0
)
where python >nul 2>nul
if %errorlevel%==0 (
  start "" python "%HERE%gui\valve.py"
  exit /b 0
)
echo 找不到 python / pythonw。
echo 装个 Python 3.10+ 并勾选 "Add to PATH"，或设置环境变量 PYTHONW 指向 pythonw.exe。
pause
exit /b 1
