@echo off
rem puara-server - start the show stack on Windows. Runs scripts\start.ps1
rem without changing the machine's PowerShell execution policy. Options pass
rem through, e.g. -Env default, -NoBridge, -Dump, -ServeCa.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
exit /b %ERRORLEVEL%
