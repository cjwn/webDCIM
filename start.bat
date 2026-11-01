@echo off
cd /d "%~dp0"
title OUTPUTWebViewer - Photo Library

where node >nul 2>nul
if errorlevel 1 goto NONODE

start "" http://localhost:7788
node server.js
pause
exit /b

:NONODE
echo.
echo [ERROR] Node.js not found. Install it from https://nodejs.org/
echo.
pause
exit /b
