@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title OUTPUTWebViewer - Stop

set "PORT=7788"
if exist "cache\port.txt" (
  set /p PORT=<cache\port.txt
)
set "KILLED=0"

if exist "cache\server.pid" (
  set /p PID=<cache\server.pid
  if not "!PID!"=="" (
    tasklist /FI "PID eq !PID!" 2>nul | find /I "node.exe" >nul
    if not errorlevel 1 (
      echo Stopping PID !PID! ...
      taskkill /F /T /PID !PID! >nul 2>nul
      if not errorlevel 1 set "KILLED=1"
    )
  )
  del "cache\server.pid" >nul 2>nul
)

rem 兜底：若 server.pid 失效或被覆盖，直接查杀实际监听 PORT 的进程
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  if not "%%P"=="0" (
    echo Stopping process listening on port %PORT% (PID %%P^) ...
    taskkill /F /T /PID %%P >nul 2>nul
    if not errorlevel 1 set "KILLED=1"
  )
)

if "!KILLED!"=="1" (
  echo Stopped.
) else (
  echo No running server found on port %PORT%.
)
%SystemRoot%\System32\ping.exe -n 2 127.0.0.1 >nul
exit /b
