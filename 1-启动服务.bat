@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Sports Booking System - Server

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found.
  echo Please install Node.js 22.5 or newer:  https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo ==================================================
echo    Sports Booking System  v3
echo    Frontend + Backend + Shared modules + AI
echo    Web page: http://localhost:3000/
echo    API base: http://localhost:3000/api
echo    Close this window to stop the server.
echo ==================================================
echo.

rem 提示：AI 能力需要项目根目录的 .env（不随压缩包分发，避免泄露 Key）
if not exist ".env" (
  echo [HINT] .env not found in this folder.
  echo        AI features run in local-rule mode ^(fully usable offline^).
  echo        To enable the LLM: copy .env.example to .env, set AI_API_KEY, restart.
  echo.
)

start "" /b powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:3000/'"

node backend\src\server.js

echo.
echo Server stopped. Press any key to close.
pause >nul
