@echo off
chcp 65001 >nul
REM ============================================================
REM 客户数据信息统计驾驶舱 —— 一键启动脚本（Windows）
REM 用法：双击本文件，或在命令行执行 start.bat
REM ============================================================
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node。请先安装 Node.js 18 或更高版本：https://nodejs.org/
  exit /b 1
)

for /f "tokens=2 delims=v" %%v in ('node -v') do set NODEVER=%%v
for /f "tokens=1 delims=." %%m in ("%NODEVER%") do set NODEMAJOR=%%m
if %NODEMAJOR% LSS 18 (
  echo [错误] Node.js 版本过低（当前 v%NODEVER%，需要 ^>= 18），请升级后重试。
  exit /b 1
)

if not exist logs mkdir logs
if not exist data mkdir data
if not exist data\storage.json if exist data\storage.json.example copy /Y data\storage.json.example data\storage.json >nul

set PORT=%PORT%
if "%PORT%"=="" set PORT=3000
set STORAGE_DRIVER=%STORAGE_DRIVER%
if "%STORAGE_DRIVER%"=="" set STORAGE_DRIVER=local

echo ------------------------------------------------------------
echo  客户数据信息统计驾驶舱
echo  Node     : %NODEVER%
echo  端口     : %PORT%
echo  存储驱动 : %STORAGE_DRIVER%
echo  访问地址 : http://localhost:%PORT%
echo ------------------------------------------------------------
echo  运行中，按 Ctrl+C 停止。
node server.js
