@echo off
setlocal
node.exe "%~dp0ptunnel.js" %*
exit /b %errorlevel%
