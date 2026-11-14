#!/usr/bin/env bash
# Select the Xcode used for the CueSight iOS build (GitHub macOS runners ship several side by side).
#
#   XCODE_VERSION=26.1 bash scripts/ios-select-xcode.sh   # a specific /Applications/Xcode_26.1.app
#   bash scripts/ios-select-xcode.sh                      # the newest stable Xcode installed
#
# Capacitor 8's Swift package is a binary built with Xcode 26, and App Store Connect only accepts
# builds made with a current SDK, so the newest stable Xcode is the right default. Exports
# DEVELOPER_DIR for later GitHub Actions steps and prints the chosen version.
set -euo pipefail

pick=""
if [[ -n "${XCODE_VERSION:-}" && -d "/Applications/Xcode_${XCODE_VERSION}.app" ]]; then
  pick="/Applications/Xcode_${XCODE_VERSION}.app"
fi
if [[ -z "$pick" ]]; then
  pick="$(
    python3 - <<'PY'
import glob, os, re
best = None
for p in glob.glob('/Applications/Xcode*.app'):
    m = re.fullmatch(r'/Applications/Xcode_(\d+(?:\.\d+)*)\.app', p)
    if not m or not os.path.isdir(os.path.join(p, 'Contents/Developer')):
        continue  # skips betas/RCs (e.g. Xcode_26.2_beta.app) and bare Xcode.app symlinks
    v = tuple(int(x) for x in m.group(1).split('.'))
    if best is None or v > best[0]:
        best = (v, p)
print(best[1] if best else '')
PY
  )"
fi
if [[ -z "$pick" ]]; then
  echo "No versioned Xcode found under /Applications; keeping $(xcode-select -p)"
else
  if [[ "$(id -u)" == "0" ]]; then xcode-select -s "$pick/Contents/Developer"; else sudo xcode-select -s "$pick/Contents/Developer"; fi
  if [[ -n "${GITHUB_ENV:-}" ]]; then echo "DEVELOPER_DIR=$pick/Contents/Developer" >> "$GITHUB_ENV"; fi
  echo "Selected $pick"
fi
xcodebuild -version
xcrun simctl list runtimes available | sed -n '1,20p' || true
