@echo off
title GMS Lighting Bridge
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get the LTS version from https://nodejs.org then run this again. & pause & exit /b 1)
if not exist node_modules (echo Installing for the first time... & call npm install --omit=dev)
node bridge.js
pause
