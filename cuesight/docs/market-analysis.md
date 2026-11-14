# CueSight — Market Analysis (Nov 2026)

> **Question asked:** does a "point your phone at a real pool/snooker table and get a real-time shot
> guide (aim line, power, spin, cue-ball path)" app already exist?
>
> **Short answer:** pieces of this exist, but nobody ships the whole thing. Today's products are one of:
> photo-based phone apps, drill and stat trackers, headset AR, or expensive projector rigs. **None of
> them is a live, physics-based, position-play-aware phone trainer that works on any phone.**

## 1. Landscape

| Product | Form factor | What it does | What it does NOT do | Pricing (listing) |
|---|---|---|---|---|
| **DrillRoom** (OrangeLoops) | iOS, phone/iPad on a tripod | AI ball detection for building drills ("Live Capture", v2.0), tracks drill success, 30+ drills, stance check | Shot guidance: no aim line, spin or power recommendations for the shot in front of you | Free + subscription (~$40/yr cited by users) |
| **AimPool: Billiards Shot Coach** | iOS | Analyses a **photo** of the table after you calibrate it and check the detected balls. Aim overlays and power guidance. On-device | Live video. Pool only. Camera capture is a paid unlock | One-time premium |
| **Bricole** | iOS | Camera-assisted table alignment, a "shot solver" for cushion routes, drills | Mainly **3-cushion carom**. Third-party listings say it is not a pool/snooker app | Pro tiers, up to $89.99 lifetime (US) |
| **AimCue – Billiards Angle Tool** | iOS (2026) | On-screen shot paths and bank guides after you calibrate a table rectangle by hand | Reading ball positions from the camera. It is an overlay ruler | — |
| **Aim Master 8 Ball Pool Pro** | iOS | Trajectory prediction with cushion bounces and a ghost-ball preview | Seems aimed at the *8 Ball Pool* mobile game, not real tables (unverified) | — |
| **CueScope** | Meta Quest 3 (mixed reality) | Real-time trajectory visualisation on a real table | Phones. Needs a headset you have to wear while playing | — |
| **FusionCue** (announced) | Overhead webcam + projector | Local AI vision tracks every ball. Drills, targets and guides projected onto the cloth | Portability. Needs a ceiling install | Rig-level cost (forum users cite ~$1,500 for non-vision systems) |
| **UCUE** | Ceiling-mounted lasers | Shot lines drawn on the table, difficulty rating | Portability, spin/position coaching | Commercial venue product |
| **Snooker Coach 147** | iOS + AR | Projects practice routines and tracks scores | Shot solving | — |
| **PoolLiveAid** (research, 2013), **Cornell Pi Billiard Assistant** (2023) | Overhead camera + projector/laptop | Trajectory prediction prototypes | Products. Both papers note that inferring cue direction from one camera is hard | n/a |

## 2. Gaps we can own

1. **Live, on a phone.** Competitors make you choose between a still photo (AimPool) and fixed
   hardware (FusionCue, UCUE, DrillRoom's tripod) or a headset (CueScope). Nothing gives a live overlay
   from a handheld phone with a one-tap *freeze* for study.
2. **Physics that players trust.** Shot apps draw geometry (ghost ball and a straight line). Pros think in
   *throw*, *squirt*, *tangent line*, *30° rule*, *stun/draw/follow* and *speed*. No phone app shows
   cut-induced and spin-induced throw compensation, or a cue-ball path that depends on spin and speed.
3. **Position play, not just pocketing.** Pocketing one ball is a beginner goal. Getting shape on the
   *next* ball is what wins racks. No phone app recommends power and spin to land the cue ball in a
   position zone for the next shot.
4. **Honest difficulty.** Players learn faster when they know the *margin of error*. We can compute the
   allowable aim error in degrees for every shot and rank shots by it.
5. **Any phone, no install, private.** An installable PWA runs on iOS and Android and processes every
   frame on-device: no account, no upload. The iOS-only competitors can't match this.
6. **Pool *and* snooker table presets** (7/8/9-ft pool, UK 7-ft, 12-ft snooker). Ball sizes and
   pocket geometry change the physics.

## 3. Risks and how we handle them

| Risk | Mitigation |
|---|---|
| A handheld phone sees the table at an oblique angle, so balls are occluded and perspective-distorted | Parallax correction using ball height, temporal smoothing, a "freeze frame" workflow, and a demo/virtual table that works with no camera at all |
| Cue direction can't be measured reliably from one camera (as noted in the research above) | Out of scope for v1. We prescribe the line; we don't measure your stroke |
| Real-table variance (cloth speed, cushion bounce, pocket cut) | Every physical constant is a named, tunable parameter with a sourced default. Each margin is shown as a range, not one exact number |
| Name collision with an existing app | "CueSight" is a working codename. Trademark check before any store listing |

## 4. Sources

- DrillRoom: <https://apps.apple.com/app/id1539827505>, <https://orangeloops.com/2023/06/announcing-drillroom-v2-0-and-v2-1-harness-the-power-of-ai-for-your-cue-sports-training/>, <https://orangeloops.com/2025/10/drillroom-v3-0-4-released-now-with-liquidglass-look/>
- AimPool: <https://apps.apple.com/app/id6789332083>
- Bricole: <https://apps.apple.com/app/id6782375615>, <https://appshunter.io/ios/app/bricole/id6782375615>
- AimCue: <https://mwm.ai/apps/aimcue-billiards-angle-tool/6759794534>
- Aim Master 8 Ball Pool Pro: <https://apps.apple.com/CA/app/id6764790676>
- CueScope (Quest): <https://queststoredb.com/app/cuescope/9579207835432638>
- FusionCue: <https://forums.azbilliards.com/posts/8480288/>
- UCUE: <https://www.replaymag.com/ucue-0624/?amp=1>
- PoolLiveAid: <https://dspace.zcu.cz/bitstream/11025/10662/1/Alves.pdf>
- Cornell Pi Billiard Assistant: <https://courses.ece.cornell.edu/ece5990/ECE5725_Spring2023_Projects/2%20Friday%20May%2012/1%20Billiard%20Assistant/website/index.html>
- Snooker Coach 147: <https://iphoneaddict.fr/apps/sports/snooker-coach-147.html>
