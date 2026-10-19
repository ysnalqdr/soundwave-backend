@echo off
chcp 65001 >nul
title SoundWave - backend + tunnel
cd /d "%~dp0"
cls
node start_tunnel.js
if errorlevel 1 (
  echo.
  echo   Gagal menjalankan. Pastikan Node.js terpasang, lalu coba: npm install
  echo.
)
pause
