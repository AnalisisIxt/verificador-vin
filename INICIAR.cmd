@echo off
chcp 65001 >nul
title Verificador de VIN
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   No se encontro Node.js en este equipo.
  echo   Instala la version LTS desde https://nodejs.org y vuelve a ejecutar este archivo.
  echo.
  pause
  exit /b 1
)

echo.
echo   Iniciando el verificador de VIN...
echo.

node server.mjs --open
pause
