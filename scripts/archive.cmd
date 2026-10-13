@echo off
rem Build, then pack dist\ into release\port-switch-<version>.tar.gz.
rem Local runtime files (servers.json, .env, run\) are left out, so extracting the archive
rem over an existing install upgrades it without touching its config or logs:
rem   tar -xzf port-switch-<version>.tar.gz -C ~/port-switch
setlocal
cd /d "%~dp0.."

call yarn build || exit /b 1
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "VERSION=%%v"
set "OUT=release\port-switch-%VERSION%.tar.gz"
if not exist release mkdir release
rem Windows' own tar (bsdtar), not whichever tar happens to be first on PATH
"%SystemRoot%\System32\tar.exe" -czf "%OUT%" -C dist --exclude=servers.json --exclude=.env --exclude=run . || exit /b 1
echo wrote %OUT%:
"%SystemRoot%\System32\tar.exe" -tzf "%OUT%"
