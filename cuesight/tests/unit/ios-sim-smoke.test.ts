/**
 * scripts/ios-sim-smoke.sh (spec 002 US4-AS1, FR-134): the Simulator run must FAIL when the web app
 * never logs its "[CueSight] ready" marker. The script needs macOS + Xcode, so here it runs against
 * stub `xcrun` / `xcodebuild` / PlistBuddy / `sleep` commands that play a Simulator whose app does or
 * does not log the marker. The real CI run (Xcode 26.3, iOS 26.2) logged
 * "[CueSight] ready mode=camera renderer=webgl2" 22 s after launch.
 */
import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const STUBS: Record<string, string> = {
  xcrun: `#!/usr/bin/env bash
[[ "$1" == simctl ]] || exit 0
shift
case "$1" in
  list) [[ "$3" == devices ]] && echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-2":[{"udid":"SIM-1","name":"iPhone 17 Pro","isAvailable":true}]}}' ;;
  launch)
    echo "⚡️  Loading app at capacitor://localhost/index.html"
    if [[ -n "\${STUB_READY:-}" ]]; then echo "⚡️  [info] - [CueSight] ready mode=camera renderer=webgl2"; fi ;;
  spawn) echo "123	0	UIKitApplication:com.cuesight.app[1a2b][rb-legacy]" ;;
  io) cp "$STUB_PNG" "\${!#}" ;;
esac
exit 0
`,
  xcodebuild: `#!/usr/bin/env bash
if [[ "$1" == -version ]]; then echo "Xcode 26.3"; echo "Build version 17C52"; exit 0; fi
while [[ $# -gt 0 ]]; do [[ "$1" == -derivedDataPath ]] && d="$2"; shift; done
mkdir -p "$d/Build/Products/Debug-iphonesimulator/App.app"
echo plist > "$d/Build/Products/Debug-iphonesimulator/App.app/Info.plist"
echo "** BUILD SUCCEEDED **"
`,
  PlistBuddy: `#!/usr/bin/env bash
echo com.cuesight.app
`,
  // The script waits in real seconds (settling before screenshots, polling for log lines): keep each wait short.
  sleep: `#!/usr/bin/env bash
exec /bin/sleep 0.01
`,
};

let tmp = '';
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cuesight-sim-'));
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
});
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** Runs a copy of the script in its own project tree (it cds to the script's parent directory). */
function run(label: string, env: Record<string, string>): Promise<{ code: number; out: string; summary: string }> {
  const proj = join(tmp, label);
  mkdirSync(join(proj, 'scripts'), { recursive: true });
  mkdirSync(join(proj, 'ios/App/App/public'), { recursive: true });
  writeFileSync(join(proj, 'ios/App/App/public/index.html'), '<!doctype html>');
  copyFileSync('scripts/ios-sim-smoke.sh', join(proj, 'scripts/ios-sim-smoke.sh'));
  const { GITHUB_STEP_SUMMARY: _summary, ...base } = process.env;
  return new Promise((resolve) => {
    execFile(
      'bash',
      [join(proj, 'scripts/ios-sim-smoke.sh')],
      {
        env: {
          ...base,
          PATH: `${join(tmp, 'bin')}:${process.env.PATH}`,
          HOME: proj,
          PLISTBUDDY: join(tmp, 'bin/PlistBuddy'),
          STUB_PNG: join(process.cwd(), 'tests/fixtures/snap-overview.png'),
          READY_TIMEOUT: '2',
          ...env,
        },
        timeout: 120_000,
      },
      (err, stdout, stderr) => {
        const summary = readFileSync(join(proj, 'build/sim/summary.md'), 'utf8');
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: `${stdout}${stderr}`, summary });
      },
    );
  });
}

describe.skipIf(process.platform === 'win32')('iOS Simulator smoke script (stubbed Simulator)', () => {
  it('passes when every launch logs the ready marker', async () => {
    const r = await run('ready', { STUB_READY: '1' });
    expect(r.code, r.out).toBe(0);
    expect(r.summary).toContain('Web app ready after');
    expect(r.summary).toContain('**passed**');
    expect(r.out).not.toContain('::error::');
  }, 120_000);

  it('fails when the web app never logs "[CueSight] ready" (US4-AS1: a hard failure, not a warning)', async () => {
    const r = await run('not-ready', {});
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toMatch(/::error::.*\[CueSight\] ready.*within 2 ?s/);
    expect(r.summary).toContain('**FAILED**');
  }, 120_000);

  it('waits 90 s for the marker by default', () => {
    expect(readFileSync('scripts/ios-sim-smoke.sh', 'utf8')).toMatch(/^READY_TIMEOUT="\$\{READY_TIMEOUT:-90\}"$/m);
  });
});
