@echo off
cd /d "%~dp0"

rem 方案 1（首选）：直接运行原生 WinExe 托盘程序（零 VBS、零黑框）
if exist "OUTPUTWebViewer.exe" (
  start "" "%~dp0OUTPUTWebViewer.exe"
  exit /b
)

rem 方案 2（备用，零 VBS）：若未编译 exe，回退到 PowerShell 托盘
start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0tray.ps1" -OpenBrowser
exit /b
