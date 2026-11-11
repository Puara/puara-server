@echo off
rem puara-server - Windows setup. Runs scripts\install.ps1 without changing the
rem machine's PowerShell execution policy. Options pass through, e.g. -NoHttps.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %ERRORLEVEL%
