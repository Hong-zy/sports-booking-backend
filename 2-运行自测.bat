@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Sports Booking System - Self Test

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 22.5 or newer:  https://nodejs.org/
  pause
  exit /b 1
)

echo Running end-to-end self test (backend API + shared modules + static frontend)...
echo.
node backend\test\smoke.mjs
echo.
echo Press any key to close.
pause >nul
