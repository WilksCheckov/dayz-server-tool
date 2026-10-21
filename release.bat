@echo off
setlocal
REM Publish a new release: bump the patch version, commit, build, and upload to GitHub Releases.
REM Usage: release.bat            (0.1.0 -> 0.1.1)
REM        release.bat minor      (0.1.0 -> 0.2.0)
REM        release.bat 1.0.0      (explicit version)
cd /d "%~dp0"
set BUMP=%1
if "%BUMP%"=="" set BUMP=patch

for /f "delims=" %%t in ('"C:\Program Files\GitHub CLI\gh.exe" auth token 2^>nul') do set GH_TOKEN=%%t
if "%GH_TOKEN%"=="" (
  echo Not logged in to GitHub CLI. Run: gh auth login
  exit /b 1
)

call npm version %BUMP% -m "Release %%s" || exit /b 1
git push && git push --tags || exit /b 1
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npx electron-builder --win --publish always || exit /b 1
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set VER=%%v
copy /y "dist\DayZ-Server-Tool-%VER%-portable.exe" "DayZ Server Tool.exe" >nul
echo.
echo Released v%VER%: https://github.com/WilksCheckov/dayz-server-tool/releases/tag/v%VER%
endlocal
