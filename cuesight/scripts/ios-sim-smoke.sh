#!/usr/bin/env bash
# CueSight iOS Simulator smoke test (spec 002, US4 FR-134). Runs in CI (.github/workflows/cuesight-ios.yml)
# and on any Mac with Xcode 26:
#
#   npm ci && npm run cap:sync          # web build + copy into ios/App/App/public
#   bash scripts/ios-sim-smoke.sh       # build, install, launch, screenshot, check
#
# Steps: pick an available iPhone simulator (newest iOS runtime; SIM_UDID overrides), xcodebuild for the
# simulator without signing, boot, install, grant photo-library access, launch with the console attached,
# wait for the web app, take screenshots, relaunch in Practice and Snap (debug launch argument
# -CueSightStartQuery, see ios/App/App/CueSightViewController.swift), and check the app is still alive.
#
# Hard failures: build/install errors, the app dying, Capacitor failing to load the web bundle, or a
# blank screen. Soft (warning): the web app's "[CueSight] ready" log marker not seen.
# If the web build was made with VITE_CUESIGHT_TOUR=1 and logs "[CueSight] tour <step>" markers, one
# screenshot is taken per step.
#
# Output (SIM_OUT, default build/sim): *.png screenshots, console-*.log, xcodebuild.log, summary.md.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${SIM_OUT:-build/sim}"
DERIVED="${DERIVED_DATA:-build/DerivedData}"
READY_TIMEOUT="${READY_TIMEOUT:-60}"
mkdir -p "$OUT"
: > "$OUT/summary.md"
note() { echo "$*" | tee -a "$OUT/summary.md"; }
warn() { echo "::warning::$*"; echo "- ⚠️ $*" >> "$OUT/summary.md"; }
fail() { echo "::error::$*"; echo "- ❌ $*" >> "$OUT/summary.md"; FAILED=1; }
FAILED=0
touch "$OUT/.started"

[[ -f ios/App/App/public/index.html ]] || { echo "::error::ios/App/App/public/index.html is missing: run 'npm run cap:sync' (vite build && cap sync ios) first"; exit 1; }

# --------------------------------------------------------------------------------------------- simulator
pick_sim() {
  xcrun simctl list -j devices available | node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8")).devices;
    const ver = (k) => ((k.match(/iOS-(\d+)-(\d+)(?:-(\d+))?/) || []).slice(1)).map((x) => +(x || 0));
    const newer = (a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0; };
    const rank = (n) => (/^iPhone \d+ Pro$/.test(n) ? 0 : /^iPhone \d+$/.test(n) ? 1 : /^iPhone (?!SE)/.test(n) ? 2 : /^iPhone/.test(n) ? 3 : 9);
    for (const r of Object.keys(d).filter((k) => /SimRuntime\.iOS-/.test(k)).sort(newer)) {
      const c = d[r].filter((x) => x.isAvailable !== false && rank(x.name) < 9)
        .sort((a, b) => rank(a.name) - rank(b.name) || b.name.localeCompare(a.name, undefined, { numeric: true }));
      if (c.length) { console.log([c[0].udid, c[0].name, r.replace(/.*SimRuntime\./, "")].join("\t")); process.exit(0); }
    }
    process.exit(1);'
}
create_sim() {
  # No iPhone device yet: create one on the newest iOS runtime with the newest iPhone device type.
  local rt dt
  rt=$(xcrun simctl list -j runtimes available | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")).runtimes.filter(x=>x.platform==="iOS"||/iOS/.test(x.name)); r.sort((a,b)=>b.version.localeCompare(a.version,undefined,{numeric:true})); if(!r.length) process.exit(1); console.log(r[0].identifier)')
  dt=$(xcrun simctl list -j devicetypes | node -e 'const t=JSON.parse(require("fs").readFileSync(0,"utf8")).devicetypes.filter(x=>/^iPhone \d+( Pro)?$/.test(x.name)); t.sort((a,b)=>b.name.localeCompare(a.name,undefined,{numeric:true})); if(!t.length) process.exit(1); console.log(t[0].identifier)')
  xcrun simctl create "CueSight iPhone" "$dt" "$rt" >/dev/null
}
if [[ -n "${SIM_UDID:-}" ]]; then
  UDID="$SIM_UDID"; SIM_NAME="(SIM_UDID)"; SIM_RT="?"
else
  if ! SIM_LINE=$(pick_sim); then
    echo "No available iPhone simulator; trying to create one"
    create_sim || { echo "No iOS simulator runtime installed; downloading the iOS platform (slow)"; xcodebuild -downloadPlatform iOS; create_sim; }
    SIM_LINE=$(pick_sim)
  fi
  IFS=$'\t' read -r UDID SIM_NAME SIM_RT <<< "$SIM_LINE"
fi
XCODE_VER=$(xcodebuild -version | sed -n 1p)
note "## CueSight iOS Simulator smoke test"
note ""
note "- Simulator: **$SIM_NAME** ($SIM_RT) \`$UDID\`"
note "- $XCODE_VER"

# --------------------------------------------------------------------------------------------- build
echo "::group::xcodebuild (simulator, Debug, unsigned)"
if ! xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator \
  -destination "id=$UDID" -derivedDataPath "$DERIVED" CODE_SIGNING_ALLOWED=NO build >"$OUT/xcodebuild.log" 2>&1; then
  echo "::endgroup::"
  grep -E "error:|\*\* BUILD" "$OUT/xcodebuild.log" | head -60 || true
  tail -120 "$OUT/xcodebuild.log"
  fail "xcodebuild failed (see xcodebuild.log)"
  exit 1
fi
echo "$(grep -cE 'warning:' "$OUT/xcodebuild.log" || true) compiler warning lines"
echo "::endgroup::"
APP="$DERIVED/Build/Products/Debug-iphonesimulator/App.app"
BUNDLE_ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")
note "- Built \`$BUNDLE_ID\` ($(du -sh "$APP" | cut -f1))"

# --------------------------------------------------------------------------------------------- boot + install
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null
xcrun simctl ui "$UDID" appearance dark 2>/dev/null || true
xcrun simctl status_bar "$UDID" override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100 2>/dev/null || true
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"
xcrun simctl privacy "$UDID" grant photos "$BUNDLE_ID" 2>/dev/null || echo "photos privacy grant not supported here"
# Put the Snap sample photos into the Simulator's Photos library (handy for trying Snap by hand).
for f in tests/fixtures/snap-overview.png tests/fixtures/snap-player.png; do
  [[ -f "$f" ]] && xcrun simctl addmedia "$UDID" "$f" 2>/dev/null || true
done
# The Simulator has no camera. Granting is harmless and avoids the alert if a future runtime emulates one.
xcrun simctl privacy "$UDID" grant camera "$BUNDLE_ID" 2>/dev/null || echo "camera privacy grant not supported by this simctl (the Simulator has no camera)"

# --------------------------------------------------------------------------------------------- helpers
LAUNCH_PID=""
launch() { # launch <label> [app arguments...]
  local label=$1; shift
  xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
  [[ -n "$LAUNCH_PID" ]] && kill "$LAUNCH_PID" 2>/dev/null || true
  CONSOLE="$OUT/console-$label.log"
  : > "$CONSOLE"
  # --console-pty: the app's stdout (Capacitor's "⚡️ ..." native log, including forwarded JS console
  # messages in Debug builds) goes to the log, line-buffered.
  xcrun simctl launch --console-pty --terminate-running-process "$UDID" "$BUNDLE_ID" "$@" >"$CONSOLE" 2>&1 &
  LAUNCH_PID=$!
  LAUNCHED_AT=$(date +%s)
}
wait_for() { # wait_for <fixed-string> <seconds>
  local i
  for ((i = 0; i < $2 * 2; i++)); do grep -qF -- "$1" "$CONSOLE" 2>/dev/null && return 0; sleep 0.5; done
  return 1
}
alive() { xcrun simctl spawn "$UDID" launchctl list 2>/dev/null | grep -F "UIKitApplication:$BUNDLE_ID" >/dev/null; }
shot() { xcrun simctl io "$UDID" screenshot --type=png "$OUT/$1.png" >/dev/null 2>&1 && echo "$OUT/$1.png"; }
settle_until() { local t=$(( LAUNCHED_AT + $1 - $(date +%s) )); (( t > 0 )) && sleep "$t" || true; }
png_stats() { # prints "w h luma_std bg_fraction" for a PNG (8-bit RGB/RGBA), using only Node's zlib
  node - "$1" <<'JS'
const fs = require('fs'), zlib = require('zlib');
const b = fs.readFileSync(process.argv[2]);
let p = 8, w, h, depth, ct; const idat = [];
while (p < b.length) {
  const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8), data = b.subarray(p + 8, p + 8 + len);
  if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ct = data[9]; }
  if (type === 'IDAT') idat.push(data);
  p += 12 + len;
}
const ch = { 2: 3, 6: 4 }[ct];
if (depth !== 8 || !ch) { console.log(`${w} ${h} NaN NaN`); process.exit(0); }
const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, img = Buffer.alloc(stride * h);
for (let y = 0; y < h; y++) {
  const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
  for (let i = 0; i < stride; i++) {
    const a = i >= ch ? img[y * stride + i - ch] : 0, up = y ? img[(y - 1) * stride + i] : 0, c = y && i >= ch ? img[(y - 1) * stride + i - ch] : 0;
    let pr = 0;
    if (f === 1) pr = a; else if (f === 2) pr = up; else if (f === 3) pr = (a + up) >> 1;
    else if (f === 4) { const q = a + up - c, pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - c); pr = pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
    img[y * stride + i] = (src[i] + pr) & 255;
  }
}
let n = 0, s = 0, s2 = 0, bg = 0;
for (let i = 0; i < img.length; i += ch * 7) {
  const r = img[i], g = img[i + 1], bl = img[i + 2], l = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  n++; s += l; s2 += l * l;
  if (Math.abs(r - 7) + Math.abs(g - 11) + Math.abs(bl - 20) < 24) bg++; // --bg #070B14
}
const m = s / n;
console.log(`${w} ${h} ${Math.sqrt(Math.max(0, s2 / n - m * m)).toFixed(1)} ${(bg / n).toFixed(3)}`);
JS
}
check_screen() { # check_screen <png> <label>: a blank (uniform) screen is a failure
  local st; st=$(png_stats "$1")
  read -r W H STD BG <<< "$st"
  note "- \`$(basename "$1")\` ${W}×${H}, luminance σ=$STD, background share=$BG"
  if [[ "$STD" != "NaN" ]] && awk "BEGIN{exit !($STD < 2.0)}"; then fail "$2: the screen is blank (uniform image)"; fi
}

# --------------------------------------------------------------------------------------------- run 1: default launch
note ""
note "### Launch (default start)"
launch default
sleep 3
shot 01-launch >/dev/null || true
if wait_for "Loading app at" 30; then note "- Capacitor loaded the bundled web app: \`$(grep -m1 -o 'Loading app at [^ ]*' "$CONSOLE")\`"; else fail "Capacitor never logged 'Loading app at' (web bundle not loaded)"; fi
if grep -qE "FATAL ERROR|Unable to load .*index.html" "$CONSOLE"; then fail "Capacitor reported a fatal load error (see console-default.log)"; fi
READY=0
if wait_for "[CueSight] ready" "$READY_TIMEOUT"; then READY=1; note "- Web app ready after $(( $(date +%s) - LAUNCHED_AT )) s: \`$(grep -m1 -o '\[CueSight\] ready.*' "$CONSOLE" | tr -d '\r')\`"; else warn "the web app's '[CueSight] ready' marker was not logged within ${READY_TIMEOUT}s (screenshots still taken)"; fi
settle_until 12
sleep 1.5
if shot 02-home >/dev/null; then check_screen "$OUT/02-home.png" "default launch"; else fail "simctl screenshot failed"; fi

# Optional screenshot tour (web build with VITE_CUESIGHT_TOUR=1 logs "[CueSight] tour <step>").
if grep -qF "[CueSight] tour" "$CONSOLE"; then
  note ""
  note "### Screenshot tour"
  seen=0; idle=0; n=0; tour_done=0
  # Stops at "[CueSight] tour done", after 15 s without a new step, or 180 s after launch.
  while (( ! tour_done && idle < 30 && $(date +%s) - LAUNCHED_AT < 180 )); do
    count=$(grep -cF "[CueSight] tour" "$CONSOLE" || true)
    if (( count > seen )); then
      for ((k = seen + 1; k <= count; k++)); do
        step=$(grep -F "[CueSight] tour" "$CONSOLE" | sed -n "${k}p" | sed -E 's/.*\[CueSight\] tour ([^ ]+).*/\1/' | tr -cd 'A-Za-z0-9_-')
        if [[ "$step" == "done" ]]; then tour_done=1; break; fi
        sleep 1.2; n=$((n + 1))
        f=$(printf 'tour-%02d-%s' "$n" "${step:-step}")
        if shot "$f" >/dev/null; then note "- \`$f.png\`"; fi
      done
      seen=$count; idle=0
    else
      sleep 0.5; idle=$((idle + 1))
    fi
  done
fi
if alive; then note "- App process alive after $(( $(date +%s) - LAUNCHED_AT )) s"; else fail "the app is not running after the default launch (crash?)"; fi

# --------------------------------------------------------------------------------------------- runs 2-3: Practice, Snap
for mode in practice snap; do
  note ""
  note "### Launch with ?mode=$mode"
  launch "$mode" -CueSightStartQuery "mode=$mode"
  if wait_for "[CueSight] ready" 40; then note "- ready: \`$(grep -m1 -o '\[CueSight\] ready.*' "$CONSOLE" | tr -d '\r')\`"; fi
  settle_until 10
  sleep 1.5
  n=$([[ $mode == practice ]] && echo 03 || echo 04)
  if shot "$n-$mode" >/dev/null; then check_screen "$OUT/$n-$mode.png" "$mode launch"; else fail "simctl screenshot failed"; fi
  if alive; then note "- App process alive"; else fail "the app is not running after the $mode launch (crash?)"; fi
done

# --------------------------------------------------------------------------------------------- logs, crashes, summary
xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
[[ -n "$LAUNCH_PID" ]] && kill "$LAUNCH_PID" 2>/dev/null || true
mkdir -p "$OUT/crash"
find "$HOME/Library/Logs/DiagnosticReports" -maxdepth 1 -name 'App[-_.]*' -newer "$OUT/.started" -exec cp {} "$OUT/crash/" \; 2>/dev/null || true
if compgen -G "$OUT/crash/*" >/dev/null; then fail "crash reports were written (see crash/)"; fi
ERRS=$(cat "$OUT"/console-*.log | tr -d '\r' | grep -E '\[error\]' | sort -u | head -20 || true)
note ""
note "### Console"
note "- JS console errors: $( [[ -z "$ERRS" ]] && echo none || echo "$(printf '%s\n' "$ERRS" | wc -l | tr -d ' ') distinct")"
[[ -n "$ERRS" ]] && printf '%s\n' "$ERRS" | sed 's/^/    /' | tee -a "$OUT/summary.md" >/dev/null
note "- Screenshots: $(cd "$OUT" && for f in ./*.png; do printf '%s ' "${f#./}"; done)"
note "- Result: $( (( FAILED )) && echo '**FAILED**' || echo '**passed**')$( (( READY )) || echo ' (without the ready marker)')"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then cat "$OUT/summary.md" >> "$GITHUB_STEP_SUMMARY"; fi
exit "$FAILED"
