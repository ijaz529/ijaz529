# Quickstart & Validation Scenarios: Real-Time Shot Guide

## Run

```bash
cd cuesight
npm install
npm run dev            # http://localhost:5173 — open on a phone on the same network via --host
npm run typecheck
npm test               # unit + integration (Vitest)
npm run fixtures       # renders tests/fixtures/table.y4m (synthetic fake-camera video)
npm run e2e            # Playwright: virtual table + fake camera
npm run build          # production PWA into dist/
```

To use a real phone: run `npm run dev -- --host`, then open the HTTPS tunnel or LAN URL. Camera
access requires HTTPS or localhost. Or deploy `dist/` to any static host.

## Validation scenarios (map to spec acceptance criteria)

| # | Scenario | How to verify | Spec ref |
|---|---|---|---|
| Q1 | Straight-in shot | Virtual table → *Straight-in* preset → tap OB, tap pocket. Card shows cut 0.0°, "full", throw 0.0° | US1-AS1 |
| Q2 | Tangent line | *30° cut* preset with stun selected. Dashed CB line leaves ~90° to the OB path. Tip mentions the tangent line | US1-AS2 |
| Q3 | 30° rule | Same preset, tap "Follow" on the spin pad. CB deflection ≈ 34°. Tip mentions the 30° rule | US1-AS3 |
| Q4 | Blocked | Drag a ball onto the aim line. "Blocked by …" warning | US1-AS4 |
| Q5 | Scratch | Line up a straight shot into a corner with follow and high power. Scratch warning | US1-AS5 |
| Q6 | Live camera | `npm run e2e` runs `camera.spec.ts`: fake camera → "Locked" → balls detected → plan drawn | US2-AS1/2 |
| Q7 | Manual calibration | Camera mode → *Calibrate* → tap 4 corners → locked | US2-AS3 |
| Q8 | Freeze | Camera mode → *Freeze* → layout persists on the mini-map | US2-AS4 |
| Q9 | Camera denied | Block camera permission → message and a *Practice table* button | US2-AS5 |
| Q10 | Draw/follow | Move the tip below then above centre. CB path reverses, then follows | US3-AS1 |
| Q11 | Too soft | Power 1 on a long shot. "Too soft" warning | US3-AS4 |
| Q12 | Suggest | *Suggest* → up to 3 ranked shots in < 2 s. No blocked shots | US4 |
| Q13 | Position | *Position* → tap a spot. Recommended stroke. Rest marker near the spot (≤ 15 cm when reachable) | US5-AS1 |
| Q14 | Heatmap | *Zones* → choose the next ball. Coloured zones drawn | US5-AS3 |
| Q15 | Offline | Build + preview, load once, go offline, reload. App works | FR-026 |

## Accuracy self-check

`npm test -- vision` prints per-scene corner and ball-position errors. Compare them with the
targets in `contracts/core-api.md`.
