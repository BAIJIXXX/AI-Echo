@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [?] 没有找到 Node.js。请先安装 Node.js 18 或更新版本：
  echo      https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo  正在启动 回响 · EchoLab ...
echo  关闭这个窗口即可停止本地服务。
echo.

node server.mjs
if errorlevel 1 (
  echo.
  echo  服务异常退出。请把上面的错误信息保存下来。
  pause
)
