@echo off
cd /d "%~dp0"
title OUTPUTWebViewer - Stop

if not exist "cache\server.pid" goto NOPID

set /p PID=<cache\server.pid
echo Stopping PID %PID% ...
taskkill /F /PID %PID% >nul 2>nul
del "cache\server.pid" >nul 2>nul
echo Stopped.
%SystemRoot%\System32\ping.exe -n 3 127.0.0.1 >nul
exit /b

:NOPID
echo No cache\server.pid found - server may not be running.
%SystemRoot%\System32\ping.exe -n 3 127.0.0.1 >nul
exit /b
