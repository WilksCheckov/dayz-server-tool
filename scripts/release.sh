#!/usr/bin/env bash
# Release: the tests must pass, then commit, bump the version, push, build, publish on GitHub (with latest.yml and
# the blockmap, which the in-app updater needs) and copy both exes into the project folder.
#   scripts/release.sh "<commit message>" "<release notes>"
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PATH:/c/Program Files/GitHub CLI"
MSG="${1:?commit message}"; NOTES="${2:?release notes}"
npm test
git add -A
git diff --cached --quiet || git commit -q -m "$MSG"
npm version patch -m "Release %s" >/dev/null
V=$(node -p "require('./package.json').version"); [ -n "$V" ]
git push -q && git push -q --tags
rm -rf dist
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win > "${TMP:-/tmp}/eb.log" 2>&1 || { tail -20 "${TMP:-/tmp}/eb.log"; exit 1; }
ls dist/*.exe dist/latest.yml dist/*.blockmap > /dev/null
gh release create "v$V" dist/*.exe dist/latest.yml dist/*.blockmap --title "$V" --notes "$NOTES" > /dev/null
cp "dist/DayZ-Admin-Tools-Setup-$V.exe" "DayZ Admin Tools Setup.exe"
cp "dist/DayZ-Admin-Tools-$V-portable.exe" "DayZ Admin Tools.exe" 2>/dev/null || cp "dist/DayZ-Admin-Tools-$V-portable.exe" "DayZ Admin Tools $V.exe"
echo "released v$V"
