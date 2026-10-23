# Shanghai Metro Line 2 ATS simulator

[English](README.md) · [简体中文](README.zh-CN.md)

A TypeScript/Vite simulation of the Line 2 OCC overview, station interlocking and train operation. The Simplified Chinese interface covers 31 stations from 蟠祥路·国家会计学院 to 浦东1号2号航站楼, with a browser version and a Tauri desktop application.

## Run

```bash
npm install
npm run dev
npm run build
npm run preview
```

The development server uses `http://localhost:5173`. `build` checks types and writes `dist/`; `preview` serves that build. The browser starts at 07:40 on a weekday; `?t=04:00` selects another simulation time. The desktop application starts with an operating-day dialog.

Windows desktop builds need Rust, Visual Studio C++ build tools and WebView2:

```powershell
npm run app:dev
npm run app:build
powershell -ExecutionPolicy Bypass -File scripts/app-shortcut.ps1
```

`app:build` creates `src-tauri/target/release/line2-ats.exe` without an installer. Rebuild after source updates; an already running executable does not update itself. The shortcut only needs creating once.

## Dispatch and drive

- The overview and station views show trains, routes, signals, switches, occupied sections, platforms and yards. Select an object for its commands; use the train list, actual/planned graph and alarm list to locate it.
- Weekday/weekend diagrams include through and short workings, depot moves, turnbacks, overnight stock and hot spares. Dispatch actions include holding, skipping, withdrawals, extra trains and recovery, with radio procedures, fault injection, weather, instructor scenarios and scoring.
- CBTC is the primary train-control model with TBTC backup. Follow a train for its DMI. DTO/AM run automatically; AM can be taken over for ATO driving, and CM/RM for manual driving.
- The selected train gets the platform close-up, stopping indication and departure countdown in every mode. DEP and the countdown use the same ATS departure clock; H indicates a hold. See D128 in [design decisions](docs/design-decisions.md).
- CM displays a yellow recommended-speed marker and actual/recommended/permitted values. The advice uses the same ATO target, section budget, running level, limits and braking calculation; the driver's handle still controls traction. AM/DTO/RM do not show this advice.
- Manual overruns use the train's recently travelled path. Returns up to 5 m can be driven back; longer returns require dispatch consent. A refused return states the actual reason and offers the existing dispatch procedure. Mode changes after a completed stop clear the obsolete retreat state.
- Section regulation uses the full stop-task distance (D126) and the path's static speed profile for ETA (D127). Train protection still uses its safety scan; temporary restrictions, weather, leading trains and authority remain active.

| Control | Action |
|---|---|
| Space / 1–7 | Pause / simulation speed; automatic operation supports 1×–120× |
| Wheel / drag | Zoom / pan the line view |
| F1 / M | Help / application sound toggle |
| Z or ↑ / Q or ↓ | More traction or release brake / more brake or reduce traction |
| S / E | Neutral handle / emergency brake |
| Y / U | Right / left doors; press again to close |
| L / K / J | Reverser forward / neutral / reverse, only at a standstill |
| F + G | Hold both ATO-start buttons once the taken-over AM train is ready |

Early ATO-start presses do not latch. CM/RM operation limits simulation speed to 5×. CM door enable follows the platform side and stopping window; RM uses on-sight driving and station-staff PSD procedures. The help pages explain command conditions and fault recovery.

## Diagnostics and local sound

Dispatcher commands and driving inputs are logged for diagnostic replay. Checkpoints and continuous operating-day carry preserve the physical world across midnight; diagnostic exports are preferable to screenshots alone when reporting a stuck train.

Recorded announcements, door motion, warning tones and ambience are generated from local sources. Audio files are excluded from Git: derived clips belong in `public/sounds/`, originals and private analysis in ignored `work/`. Passenger transcripts are not committed. Analysis reads files without playing or uploading them and does not download speech models automatically.

```powershell
npx tsx scripts/audio/field-calibration.ts --existing --prepare-only
npx tsx scripts/audio/field-calibration.ts --input "work/recordings/19.56威宁路~淞虹路.mp4" --from 威宁路 --direction UP --clock 19:56 --out work/bottom-up-runtime/new-video --no-model
python scripts/audio/test-field-calibration.py
```

Use [the audio entry guide](scripts/audio/README-field.md) for a new recording and [the field index](docs/field/README.md) for sources, door measurements and PIS observations. Missing local audio does not imply a complete public sound bundle.

## Evidence and current limits

Timetable evidence follows D125:

1. [Official first/last trains, fixed late services and headways](src/data/firstlast.ts).
2. [User field recordings and photographed PIS](docs/field/README.md) for running/dwell times and speed observations. PIS countdowns are predictions, not actual arrivals.
3. [Gaode captures](reference/line2/timetable-gaode.md), only for train counts per 15 minutes in the accepted columns. Minute readings do not define section timing, dwell or running level.

Topology, gradients, vehicle performance, demand and operating procedures contain documented approximations; they do not constitute an operational railway system. Current random runs still expose depot-related waiting cycles. D128 found no new wait-cycle type in its small comparison batch, which stopped at existing cycles before day two; this is not a claim of a clean full-day safety regression.

The [bottom-up timing analysis](docs/field/bottom-up-runtime-2026-10.md) has complete door-based candidates for 40/60 directional sections, with stronger evidence for 22. Its margins and dwell rules are proposals only; current timetable parameters remain unchanged. See [modelling decisions](docs/design-decisions.md), [layout](docs/layout-pdf.md), [signalling](docs/signalling-model.md) and [line/vehicle research](reference/line2/Shanghai_Metro_Line2_Profile_and_Rolling_Stock_Research.md).

## Focused checks

```powershell
npx tsc --noEmit
npx vitest run tests/driver.test.ts tests/dmi.test.ts tests/stopview.test.ts
```

Run the relevant test files for a change. Timetable edits additionally need both day-type plan validators, official first/last checks and the Gaode count comparison. See [AGENTS.md](AGENTS.md) for repository constraints and verification rules.

## License

AGPL-3.0: [LICENSE](LICENSE). PIS seven-segment digits use DSEG7 Classic by keshikan under SIL Open Font License 1.1: [font license](src/ui/assets/fonts/DSEG-LICENSE.txt).
