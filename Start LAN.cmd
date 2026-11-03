@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 18.2 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)
node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 18 || major === 18 && minor >= 2 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 版本过低，请安装 18.2 或更高版本。
  pause
  exit /b 1
)
node server.mjs
pause
