@echo off
chcp 65001 >nul
cd /d "%~dp0"
title PENGUMUMAN SoundWave

:menu
cls
echo.
echo   ============================================================
echo     PENGUMUMAN SOUNDWAVE  -  kirim pesan ke user
echo   ============================================================
echo.
echo     [1]  Kirim pengumuman   (ditanya satu-satu)
echo     [2]  Uji coba saja      (TIDAK mengirim apa pun)
echo     [3]  Lihat bantuan
echo     [0]  Keluar
echo.
set "pilih="
set /p "pilih=    Pilih lalu tekan Enter: "

if "%pilih%"=="1" goto kirim
if "%pilih%"=="2" goto ujicoba
if "%pilih%"=="3" goto bantuan
if "%pilih%"=="0" exit /b
goto menu

:kirim
echo.
node pengumuman.js
goto selesai

:ujicoba
echo.
node pengumuman.js --dry
goto selesai

:bantuan
echo.
node pengumuman.js --help
goto selesai

:selesai
echo.
echo   ------------------------------------------------------------
echo     Tekan tombol apa saja untuk kembali ke menu...
pause >nul
goto menu
