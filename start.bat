@echo off
chcp 65001 >nul
title AnyShare WebDAV 网关 (asy-webdav)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 node，请先安装 Node.js 18+
  pause
  exit /b 1
)

if not exist "node_modules\webdav-server" (
  echo 首次运行，正在安装依赖...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败
    pause
    exit /b 1
  )
)

node server.js
echo.
echo 服务已退出。
pause
