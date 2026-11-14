#!/usr/bin/env bash
# Archive CueSight for the App Store and upload it to App Store Connect / TestFlight (spec 002, US4 FR-136).
# Used by the "testflight" job of .github/workflows/cuesight-ios.yml; also works on a Mac with Xcode 26.
#
# Prerequisites: the web bundle is built and synced (npm run cap:sync), and these variables are set:
#   ASC_KEY_ID        App Store Connect API key ID (10 characters)
#   ASC_ISSUER_ID     API key issuer ID (UUID)
#   ASC_KEY_P8        the AuthKey_<KEY_ID>.p8 contents: raw PEM, or base64 of the file
#   APPLE_TEAM_ID     Apple Developer team ID (10 characters)
# Optional:
#   IOS_BUNDLE_ID     default com.cuesight.app (must match the App Store Connect app record)
#   BUILD_NUMBER      CFBundleVersion; default "<GITHUB_RUN_NUMBER>.<GITHUB_RUN_ATTEMPT>", else a timestamp
#   MARKETING_VERSION CFBundleShortVersionString; default package.json "version"
#   UPLOAD=0          export a signed .ipa into build/export instead of uploading
#
# Signing is automatic through the API key (-allowProvisioningUpdates): Xcode creates or reuses the
# distribution certificate (cloud-managed) and the App Store profile, so no certificates are stored in
# the repository or in CI secrets. The key file lives in a temp dir and is deleted on exit.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${ASC_KEY_ID:?ASC_KEY_ID is required}" "${ASC_ISSUER_ID:?ASC_ISSUER_ID is required}"
: "${ASC_KEY_P8:?ASC_KEY_P8 is required}" "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"
IOS_BUNDLE_ID="${IOS_BUNDLE_ID:-com.cuesight.app}"
MARKETING_VERSION="${MARKETING_VERSION:-$(node -p 'require("./package.json").version')}"
if [[ -z "${BUILD_NUMBER:-}" ]]; then
  if [[ -n "${GITHUB_RUN_NUMBER:-}" ]]; then BUILD_NUMBER="${GITHUB_RUN_NUMBER}.${GITHUB_RUN_ATTEMPT:-1}"; else BUILD_NUMBER="$(date -u +%Y%m%d.%H%M)"; fi
fi
UPLOAD="${UPLOAD:-1}"
ARCHIVE=build/CueSight.xcarchive
EXPORT_DIR=build/export

[[ -f ios/App/App/public/index.html ]] || { echo "::error::web bundle missing: run 'npm run cap:sync' first"; exit 1; }

# --- API key: raw PEM or base64, written with mode 600 to a private temp dir -------------------------
KEY_DIR="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/asc.XXXXXX")"
trap 'rm -rf "$KEY_DIR"' EXIT
KEY_PATH="$KEY_DIR/AuthKey_${ASC_KEY_ID}.p8"
umask 077
if [[ "$ASC_KEY_P8" == *"BEGIN PRIVATE KEY"* ]]; then
  printf '%s\n' "$ASC_KEY_P8" > "$KEY_PATH"
else
  printf '%s' "$ASC_KEY_P8" | tr -d ' \r\n' > "$KEY_DIR/key.b64"
  openssl base64 -d -A -in "$KEY_DIR/key.b64" -out "$KEY_PATH"
fi
grep -q 'BEGIN PRIVATE KEY' "$KEY_PATH" || { echo "::error::APP_STORE_CONNECT_KEY_P8 is neither a PEM key nor base64 of one"; exit 1; }
AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")

# --- ExportOptions.plist with the team ID filled in ---------------------------------------------------
EXPORT_PLIST="$KEY_DIR/ExportOptions.plist"
cp ios/ExportOptions.plist "$EXPORT_PLIST"
/usr/libexec/PlistBuddy -c "Set :teamID $APPLE_TEAM_ID" "$EXPORT_PLIST"
if [[ "$UPLOAD" != "1" ]]; then /usr/libexec/PlistBuddy -c "Set :destination export" "$EXPORT_PLIST"; fi

echo "Archiving $IOS_BUNDLE_ID $MARKETING_VERSION ($BUILD_NUMBER) for team $APPLE_TEAM_ID with $(xcodebuild -version | head -1)"
rm -rf "$ARCHIVE" "$EXPORT_DIR"
mkdir -p build
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" "${AUTH[@]}" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" CODE_SIGN_STYLE=Automatic PRODUCT_BUNDLE_IDENTIFIER="$IOS_BUNDLE_ID" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" MARKETING_VERSION="$MARKETING_VERSION" \
  archive > build/xcodebuild-archive.log 2>&1 || {
  grep -E "error:|\*\* ARCHIVE" build/xcodebuild-archive.log | head -60 || true
  tail -80 build/xcodebuild-archive.log
  echo "::error::xcodebuild archive failed (see build/xcodebuild-archive.log)"
  exit 1
}
echo "Archive OK: $ARCHIVE"

xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$EXPORT_DIR" -exportOptionsPlist "$EXPORT_PLIST" "${AUTH[@]}" \
  > build/xcodebuild-export.log 2>&1 || {
  tail -80 build/xcodebuild-export.log
  echo "::error::xcodebuild -exportArchive failed (see build/xcodebuild-export.log)"
  exit 1
}
tail -20 build/xcodebuild-export.log

if [[ "$UPLOAD" == "1" ]]; then
  MSG="Uploaded CueSight $MARKETING_VERSION ($BUILD_NUMBER), bundle $IOS_BUNDLE_ID, to App Store Connect. It appears in TestFlight after Apple's processing (usually 5-30 minutes)."
else
  MSG="Exported a signed App Store .ipa to $EXPORT_DIR (UPLOAD=0, nothing uploaded)."
fi
echo "$MSG"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "## TestFlight"
    echo ""
    echo "- $MSG"
    echo "- $(xcodebuild -version | head -1), team \`$APPLE_TEAM_ID\`"
  } >> "$GITHUB_STEP_SUMMARY"
fi
