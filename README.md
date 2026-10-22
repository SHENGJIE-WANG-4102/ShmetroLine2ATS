# 上海轨道交通2号线 · ATS 中央监视模拟器

A browser-based simulator of the OCC (控制中心) ATS overview wall for Shanghai Metro
Line 2 as operated from 2025-11-01: 31 stations from **蟠祥路·国家会计学院** to
**浦东1号2号航站楼**, CBTC primary with TBTC backup, interlocking, a full weekday or
weekend service generated from parametric timetable templates, dispatcher commands
and fault injection. The UI is in Simplified Chinese and laid out for a 3840×2160 wall.

## Run

```bash
npm install
npm run dev          # http://localhost:5173  (opens at 07:40 on the next weekday)
npm run build        # type-check + production build into dist/
npm run preview      # serve the production build
npm test             # headless simulation tests (full days, faults, commands, features)
npm run soak:quick   # parallel: both days, all templates, fault-free + level 2 seeds 1–2 (18 days)
npm run soak         # parallel unattended: all 126 days; tests/out/soak/summary.json
npm run replay -- diagnostics.json  # lossless replay and full snapshot comparison
```

URL options: `?t=17:30` sets the start time (the day is simulated from 04:00 at full
speed up to that time first), `?holiday=1` uses the weekend/holiday timetable.

On the first start a short guided tour opens (F1 or **?** reopens it). It has six pages:
screen areas, basic operation, colours and symbols, following and driving a train,
instructor/replay, and a glossary of every signalling term used on screen.

## 桌面版

本机需要 Rust、Visual Studio C++ 生成工具和 WebView2。只构建本地 exe，不生成安装包。

```powershell
npm install
npm run app:build
powershell -ExecutionPolicy Bypass -File scripts/app-shortcut.ps1
```

以后双击桌面的「2号线ATS」即可打开，先选择运营日设置，再生成运行图。
更新后只需重新执行 `npm run app:build`，快捷方式不必重建。
程序位于 `src-tauri/target/release/line2-ats.exe`；关闭窗口即退出。

## Screen size and UI scale

The whole UI is laid out on a logical 3840×2160 canvas and scaled uniformly to the
window. On top of that, **界面缩放** (header 设置 menu → 界面缩放, or Ctrl + / Ctrl −) applies a
global scale of 75 %–200 %, which is remembered in the browser. At 100 % on a 4K wall the
minimum sizes are: text ≥ 20 px, station names ≥ 40 px, train windows ≥ 30 px, panel body
text ≥ 24 px and controls ≥ 56 px. The default scale depends on the window: 100 % on a 4K
display, up to 150 % on smaller screens so text stays readable at 1080p.

Header and toolbars wrap when they don't fit, and the layout measures them, so nothing
is cut off at any scale.

## Layout

* **Header**: clock, operating day and timetable period, simulation rate (pause,
  a 1×–120× drop-down, fast-forward to a time picked by hour and minute, new operating day;
  when the computer cannot keep up, `实际 N×` next to it shows the rate actually reached), ZC area levels (CBTC / TBTC /
  ZC故障), KPIs (trains in service/on line, late > 2 min, punctuality, completed trips),
  A/B/C alarm counters, UI scale, sound on/off, help.
* **Line overview** (≥ 55 % of the screen height): the line folded into as many rows as
  give the largest drawing for the window (3 rows at 16:9). Wheel zooms and drag pans;
  zoomed out you see the whole line, zoomed in you see detail.
  * **Level of detail**: signal names, section names and kilometre posts appear only when
    zoomed in, or when forced on with the layer buttons (信号机 / 区段 / 公里标 / 客流).
  * **No overlaps**: labels go through a greedy placement index (station names first,
    then train windows by priority: selected, faulty, degraded, held, late, rest), and
    anything that doesn't fit is dropped instead of drawn on top.
  * **Colours**: normal states are muted. CBTC occupancy is slate, plain line is
    dark grey, and CBTC wayside signals are small dark rings rather than red lamps. Red
    is reserved for faults and alarms; amber marks things that need attention (axle-counter
    occupancy by non-communicating trains, TSR, preset).
  * **Depots** are drawn as yards with their stabling tracks and the trains standing on
    them; clicking one opens the yard view.
* **Train graph** (下方条带): strip (~20 % of the height), collapsed to its toolbar, or
  maximised (it then takes the place of the overview). Windows of 1 h / 3 h / 6 h / the whole day. Planned
  lines are thin and muted (big route, small route, depot runs, added, adjusted). Actual
  lines are thick and coloured by deviation: green ≤ 2 min, yellow 2–5 min, orange
  > 5 min, grey for non-revenue runs.
* **Right side**:
  * The **alarm list** collapses to one line when there is nothing active and expands and
    flashes when a new alarm arrives. Clicking a row acknowledges it and locates the
    object.
  * The **dispatcher phone/radio** (调度电话·无线) queue sits below the alarms.
  * Tabs: **详情** (the selected object and its commands), **列车** (train table),
    **事件** (event log with filters), **教员** (scenarios, random faults, fault
    injection, weather), **回放** (rewind/replay and bookmarks), and **客流**
    (actual daily boardings, peak load, and station/hour boardings and alightings).
  * All controls are at least 56 px high.

## Interaction

### Selecting and commanding

Click any object (train window, signal, switch, section, platform, station name, depot)
and the **详情** tab shows its state and commands. Routine commands execute at once.
Safety-relevant ones (guide route, axle-counter preset, fault release, TSR, blocking,
TBTC switchover, RM authorisation, rescue) need a second, timed confirmation with the
buttons swapped.

| Object | Commands |
|---|---|
| Signal | 办理进路 (route list with preview), 取消进路 (30 s delayed release when approach-locked), 引导进路 ★, 自动通过 on/off, 自动排列(ARS) on/off |
| Switch | 单操定位/反位, 单锁/单解, 封锁/解封 ★, 钩锁确认 ★, 取消钩锁 |
| Section | 计轴预复位 ★, 区段故障解锁 ★ (refused while the section is occupied, the route is approach-locked or has issued an authority, or a train on the route is heading for the section), 封锁/解封 ★, 设置/取消临时限速 ★ (one section or the whole station interval) |
| Platform | 扣车/取消扣车, 跳停/取消跳停, 紧急关闭/取消 ★, 站台门互锁解除 ★, PIS preview |
| Train | 跟踪列车, 人工驾驶 CM / RM ★, 恢复 AM, 扣车/放行, 跳停, 人工折返, 退出服务, 授权RM ★, 组织救援 ★ (failed train only) |
| Station | 打开车站图 (interlocking view), PIS preview |
| Depot | 车场图 (yard view), 加开列车 from that depot |
| System (nothing selected) | 切换TBTC / 恢复CBTC per ZC area or whole line ★, 加开列车, 加开运行图 templates (进博会保障, 虹桥枢纽大客流) |

★ = two-step confirmation.

### Station interlocking view (车站图)

Opens from a station's details or the 车站图 menu and replaces the overview with that
station at full detail: every signal, switch and section with its name. It works like a
real workstation: pick the **function** first (button or key), then click the
**device**.

| Key | Function | Click |
|---|---|---|
| Q | 选择 | any device → details |
| R | 排列进路 | start signal, then end signal / track / depot (valid ends are highlighted) |
| G | 引导进路 ★ | start signal, then end |
| C | 取消进路 | start signal |
| N / V | 定位 / 反位 | switch |
| L | 单锁/单解 | switch |
| B | 封锁/解封 ★ | switch or section |
| U | 区故解 ★ | section |
| X | 计轴预复位 ★ | faulty section |

Esc steps back (pending start → function → overview).

### Following a train and driving it

**跟踪列车** keeps the camera on the train and shows its cab display (DMI) in the
side panel, modelled on the Casco DMI in the 02A05 cabs (see [Cab DMI](#cab-dmi)).
It shows:

* terminus, next station, trip, train ID and the departure time;
* the speedometer with the permitted speed in red on the rim;
* mode and level, door mode, platform and train doors;
* the highest available mode and the stopping-window indicator;
* a timestamped message log;
* the target and movement-authority readout.

**人工驾驶 CM** (supervised) or **RM** (restricted, ≤ 25 km/h, on sight; ★, train must be
at a stand) hands the train to you. The single master controller (JRETS layout) has
traction P1–P4, N, brake B1–B7 and emergency; the doors follow TSW:

| Input | Effect |
|---|---|
| Z / ↑ | more traction / release brake |
| Q / ↓ | more brake / less traction |
| S | handle to N |
| E | emergency brake |
| Y / U | right / left doors (again: close) |
| mouse | click a notch, or scroll on the lever |

Only one train can be driven at a time. While any CM / RM train runs (yours or a
degraded one) the simulation runs at most 5× and a fast-forward stops.

At a stop you open and close the doors yourself; no traction with a door open. In CM
the ATP enables only the platform side (green arrow by the DMI door icon); in RM
there is no door enable — the wrong side opens and is an A-level incident — and the
PSD is worked from the PSL by station staff (+15 s each way). Within 300 m of the
stop a close-up under the DMI shows the platform doors, the last PSD pillar and your
cab window: stopped right, the window stands at that pillar (D55). Its scale follows the
distance to go — far out the whole platform and train are in view with the end door at
the right edge, closing in to 26 px/m over the last metres — and the PSD doors carry
car-door numbers from the stopping end (1-1 opposite the head car's front door; doors 1/3/5,
then only each car's first door, while they would crowd) (D60).

ATP supervises all the time:

* Overspeed in CM triggers EB and counts as a safety violation.
* Passing a stop signal in RM is a SPAD.
* Each station stop is scored on stopping accuracy: ±0.3 m scores 100, ±0.5 m 90, ±0.75 m 75, ±1 m 60.
* Overrunning by up to 15 m means backing up to the mark (> 5 m counts as a violation); further than that, the train skips the station.

**恢复自动驾驶** returns the train to DTO under CBTC (AM when the train or the line runs ATO, below) or AM under TBTC.

### ATO with a driver (DTO compatibility mode)

DTO is the normal mode. ATO with the driver in the cab (AM) is its degraded mode
under CBTC — still moving block, not the TBTC backup's own mode:

* **One train.** 降级ATO in the train panel, or the instructor fault 车载DTO功能故障.
  The driver takes the cab at the next stop (CBTC DTO → CBTC AM). 恢复DTO works once a
  dispatcher degrade is lifted or the fault is repaired; the change back happens at a stop.
* **Whole line.** 系统 → 全线转ATO运营 / 全线恢复DTO, or choose ATO in the operating-day
  dialog. Every train changes at its next stop. The timetable stays the same: its
  terminal layovers absorb the change of ends.
* **What AM costs.** At a turnback the driver changes ends: 45 s on top of the 40 s
  unattended DTO reversal. Each departure waits 3 s for the driver's ATO start button.
  Both values are assumptions.

### Radio and phone calls (调度电话·无线)

Drivers, station staff and possession leaders call the dispatcher. Every call offers
a few responses and has a countdown. Each call type, and what happens if it isn't
answered in time:

| Call type | If unanswered |
|---|---|
| Train stuck at an obstacle > 3 min | It waits and calls again |
| CBTC degradation | |
| RM preset sweep | |
| Rescue | |
| PSD failure | |
| Platform crowding | |
| PECU passenger alarm | |
| Person on the track | |
| ESP clear request | The platform stays closed |
| Possession request (请点) | The possession is not given |
| Possession release (销点) | The line does not open in the morning |

Missed calls are counted in the report. In free play, **来电自动应答** (教员 tab) answers
every call with its default response after 15 s. Scenarios switch it off. The warm-up
before any start time is always auto-answered.

### Passengers and PIS

Waiting passengers are shown per platform. With the 客流 layer on, train windows also
show a load bar (blue → yellow → orange). Crowding raises alarms, lengthens dwells and
fills trains. Selecting a station or platform shows a **PIS preview** laid out like the
Line 2 platform screens: on the right the first train's countdown (mm:ss) and destination,
then the second and third trains and individual first/last pages (about 4.45 s for a
short page, 13.35 s when the destination English scrolls), with the clock/date and
station name alternating vertically every 2.5 s. The two western extension stations
use wide screens with an independent first/last column and persistent clock and station
header. Train pages slide left; overflowing destination English scrolls while To stays
fixed. On the left are the station, direction, the
stations ahead and the next train's load, with the notice ticker beneath (skip, hold,
delays, weather). The header shows the day's ridership (今日客流, boardings so far)
next to the other KPIs.

### Fixed-time special trains (定点班车) and passing platforms

Every day two fixed-time trains run after the last train from 虹桥火车站 (23:04, 23:30;
虹桥2号航站楼 two minutes later) to 龙阳路. They board only at the two 虹桥 stations, set
down only at 淞虹路, 威宁路, 中山公园, 静安寺, 人民广场 and 世纪大道 (the PIS shows
"只下不上"), and pass the other stations. The train is one returning empty from
蟠祥路 to 北翟路 that waits in the 虹桥火车站 platform; it goes into 龙阳路 depot
afterwards.

Any train passing a platform without stopping (a special train, an empty move, 跳停 or
a closed station) runs through it at **no more than 45 km/h**, against the pressure wave
on the platform screen doors. The holiday scenarios add their own special trains
(虹桥火车站 → 龙阳路 extended to 00:05, 浦东1号2号航站楼 → 中山公园 boarding only at the
airport) and close 南京东路 (both platforms skipped: entrances shut, no passengers); in
the 南京东路 closure scenario ATS sets the planned skip-stops itself at 16:00.

### Holiday operation (国庆)

Pick a date from 9-30 to 10-07 in **运营日** and the whole day runs with the holiday
measures planned in, from the first train (the dialog shows what the day brings):
10-01…10-07 run the holiday timetable; 南京东路 is closed by ATS at 16:00 (20:00 on 9-30)
until the end of service, as published for 2021, 2024 and 2026, with the crowds moving to
人民广场 and 陆家嘴; the afternoons bring more demand at 南京东路, 陆家嘴 and 上海科技馆;
on the return evenings (10-06, 10-07) 虹桥火车站, 虹桥2号航站楼 and 浦东1号2号航站楼
fill up and 虹桥火车站 → 龙阳路 fixed-time trains run until 00:30 (23:04, 23:30, 23:50,
00:10, 00:30). Equipment faults come only from the random fault setting (D62).

### Last-train connections (末班车接续)

Every evening the last trains of the other lines at the 15 interchange stations are
checked against Line 2 (times from the other lines' published last-train tables, Fri/Sat
times on those days; walking times are estimates). Two kinds (D63):

- **接入** (other line → Line 2): the last Line 2 train that still takes the transfer
  passengers. When the other line's last train runs late, the station calls about 3 min
  before departure: hold the Line 2 train (it is held at the platform until the
  passengers are across) or leave on time. The auto answer holds up to 5 min.
- **接出** (Line 2 → other line): when a late Line 2 train would miss the other line's last
  train, NCC asks the other line to wait. It agrees up to 4 min.

A missed connection strands its passengers (shown in 客流 › 末班车接续 and counted in the
score). Holding one last train delays the connections further down: our synthetic last
down train 3011 meets several of them within minutes, which is the classic chain.

### Energy and ATO run levels (能耗与运行等级)

Off by default (设置 › 能耗与运行等级). When shown, the header adds the net traction
energy per train-km and how much of the braking energy fed back into the third rail was
used by other trains (it is wasted in the braking resistors otherwise), and a line-wide
ATO run level: 1 runs at the full performance the timetable is planned with, 2 coasts in
a 5 km/h band when cruising, 3 cruises 5 km/h lower and coasts in a 10 km/h band.
Trains more than 20 s late run level 1 to catch up. Figures are assumptions (D67).

### Weather and night possessions

The elevated east section (广兰路以东—海天三路) and the at-grade airport section are
exposed:

| Condition | Restriction |
|---|---|
| 大风 7 级 | elevated ≤ 60 km/h |
| 大风 8 级 | elevated ≤ 45 km/h |
| 大风 9 级 | elevated ≤ 25 km/h |
| 大风 ≥ 10 级 | elevated service suspended |
| 暴雨 | elevated and at grade ≤ 60 km/h |

Restricted stretches are shown with blue dashes and badges, and a banner shows the
current weather.

Rain also wets the exposed rail (it stays wet for 20 min after the rain) and the
adhesion drops, more so at speed and on a few slippery spots (D66, figures assumed):
trains spin their wheels starting and slide braking (DMI 空转/滑行, the inverter sound
jumps), and an ATO train can slide past its stopping point. It then stands with its doors
off the platform doors and the driver calls: back up to the mark (≤ 15 m) or pass the
station. The **低粘着模式** button on the 轨面湿滑 banner makes ATO on the exposed
section pull less and brake earlier and softer (0.55 instead of 0.75 m/s²): few slides,
longer running times.

The line has a vertical profile (D65, synthesized, no profile is public): energy-saving
dips between the underground stations, the dive under the 黄浦江 and the 30‰ climb onto
the viaduct. Gravity acts on the train, the ATP curves allow for the height to the target,
and the cab DMI shows the grade.

Night possessions (施工封锁) are requested and released by phone. The
morning possessions must be released (销点) before the first trains can run.

### Instructor tab (教员), scenarios and scoring

* **Scenarios** (each loads its own day and time and runs at 1×):

| Scenario | Day | Start | Length |
|---|---|---|---|
| 龙阳路早高峰加车 | weekday | 06:52 | 45 min |
| 淞虹路道岔故障 | weekday | 07:40 | 40 min |
| 人民广场大客流 | weekday | 17:25 | 40 min |
| CBTC→TBTC 降级切换 | weekday | 09:55 | 45 min |
| 故障列车救援 | weekday | 09:05 | 45 min |
| 东段雷暴大风 | weekday | 16:30 | 50 min |
| 首班车：施工延时销点 | weekday | 04:50 | 90 min |
| 广兰路中间线道岔故障 | weekday | 17:20 | 45 min |
| 虹桥枢纽夜间大客流 | weekday | 19:40 | 50 min |
| 进博会散场 | weekday | 16:40 | 50 min |
| 陆家嘴人员侵入轨行区 | weekday | 08:15 | 40 min |
| 越江隧道列车故障 | weekday | 18:00 | 50 min |
| 国庆返程高峰：定点加班车 | holiday | 22:30 | 100 min |
| 国庆南京东路封站跳停 | holiday | 15:40 | 60 min |

  Each scenario has objectives and timed events.
* **Random faults**: off, 初级, 中级 or 高级. A fault arrives about every 25, 14 or 8
  minutes, and the higher levels draw from a wider set (up to ZC failures, wind and
  persons on the track).
* **Manual fault injection** and **weather**.
* **Report** (评分报告 at the end of a scenario, or on demand) covers:
  * total delay minutes and affected passengers;
  * trip delivery and on-time departures;
  * calls answered;
  * manual-driving stop scores;
  * safety violations (SPAD, overspeed EB, RM near-miss, unsafe authorisation, ignored ESP, overrun).

  The result is a 0–100 score and a grade. A ≥ 90, B ≥ 80, C ≥ 65; any safety violation
  caps the grade at C.

### Replay (回放)

The worker keeps a checkpoint every simulated minute (two hours of history) and a log
of every command and lever movement.

* **回退** restores a past moment so you can handle it differently.
* **回放** restores it and re-runs your recorded commands. Issuing any command during
  the replay takes over, and the recorded future is discarded.
* A/B alarms, scenario events and random faults create bookmarks automatically, and you
  can add your own.
* Replays are deterministic (tested).

### Sound

Alarm and call tones (Web Audio, no files). Toggle with the speaker button or **M**.

**Traction sound** of the selected train (02A05, TKQ506B-2000 IGBT-VVVF), played from
recordings by speed: grains are read from where the recording runs at the train's stator
frequency, so the pitch and the PWM mode changes follow the train. Power uses a recorded
start, electric braking a recorded stop down to a stand, ATO speed holding the recorded steady
running before the brake (resampled to the speed); coasting, a stand and the EB are silent.
Up to 5× only; switch it off in 设置 › 走行音. The recordings are third-party (Bilibili BV1VGZiBPEjt) and not in
the repository: cut them from p02.wav with `scripts/vvvf-clips.sh path/to/p02.wav` into
`public/sounds/vvvf/` (git-ignored); without them the sound stays off (D61).

Local field recordings also stay outside the repository. Timing measurements,
confidence labels and reproducible analysis are documented in `docs/recordings.md` (D71).
**Station sound** (设置 › 车站音效, on by default) plays local platform recordings
while a station is selected, unmuted and running at up to 5×. Arrivals follow a
stable stop estimate, departures and closing warnings follow the train state;
missing recordings stay silent. Jiangsu Road platform material is reused at underground
stations (assumption); exposed stations stay silent. Selecting a train adds complete bilingual
carriage PA and speed-dependent rolling/floor noise alongside VVVF. Matching original PA
wins; otherwise exact-name library compositions are used. By user decision, 江苏路
borrows its platform name; its English fallback joins 江苏 to the recorded word Road.
Other station phrases use the carriage voice library. Airport services
omit the short-route airport transfer notice. 设置 › 车内/车站音量 offers 大/中/小,
with a shared gain for recorded PA/ambience and VVVF. Speech uses loudnorm -16 LUFS;
noise preserves its measured level relative to the source announcements.
Cut the supplied WAVs with `npx --no-install vite-node scripts/audio/slice-recordings.ts work/recordings`
into the ignored `public/sounds/field-20261014/`; `node scripts/mock-soundbank.mjs`
creates missing placeholders for testing and preserves existing recordings.

### Keys

| Key | Action |
|---|---|
| Space | pause/resume |
| 1–7 | simulation speed |
| + / − / 0 | zoom view / zoom out / whole line |
| Esc | cancel selection / follow / back to overview |
| M | mute |
| F1 | help |
| Ctrl + / Ctrl − | UI scale |
| ↑ ↓ W S X E | lever when driving |
| Q R G C N V L B U X | station view functions |

## Faults and recovery

| Fault | Consequence in the simulation | Recovery |
|---|---|---|
| 列车车地通信中断 | ZC loses the train; its sections become non-communicating occupancy, followers stop at the section boundary; the train's MA expires → EB | Driver switches to TBTC/ATO after 30 s and runs under section-occupancy protection; upgrades to CBTC/DTO when communication and localization recover |
| 车载DTO功能故障 | The train cannot run DTO; at its next stop the driver takes the cab and it runs CBTC AM (slower turnbacks and departures) | Repair, then DTO returns at a stop; or withdraw the train to the depot |
| ZC 故障 (one area or whole line) | CBTC trains in the area lose MA and stop (moving trains under EB); trains outside cannot enter | The EB is released only with a degrade to TBTC (the driver's call) or after the ZC recovers; 切换TBTC (★) → trains run under TBTC fixed block; after repair 恢复CBTC (★); restoring before repair is refused |
| 计轴区段故障占用 | Section shows fault occupancy; CBTC trains stop before it | Reset is refused until maintenance is done; then 计轴预复位 (★); the first train sweeps it in RM and the section clears. Before that, 授权RM / 引导进路 can pass trains |
| 道岔失表 | Routes over the switch cannot be set; trains stop at the protecting signal | 单操 attempts fail until repaired; 钩锁确认 (★) then 引导进路 (★) → RM ≤25 km/h; after repair 单操 restores detection, 取消钩锁 |
| 信号机故障 | Signal cannot clear; approach/occupied route locking is retained until safe release; other trains stop at it | 引导进路 (★) per train, RM passage; repair restores automatic routes |
| 站台门故障 | At the next door close the PSD cannot lock: the train cannot leave and the next train cannot enter | 站台门互锁解除 (★); every train then loses ~25 s for manual confirmation until repaired |
| 列车故障 | Train brakes to a stand under EB; followers queue behind it. "Recoverable" clears after driver troubleshooting | Non-recoverable: 组织救援 (★) with the following train → it clears passengers, approaches in RM, couples (≤3 km/h, 60 s), pushes to the next station, clears passengers, returns to depot; remaining trips of both trains are cancelled on the graph |
| 车站大客流 | Arrival rate ×N at a station: crowding alarm, longer dwells, full trains, delays | Holding, skip-stop, added trains / added-service templates |
| PECU / 人员侵入 / ESP | Train held at the platform / platform closed until cleared | Answer the call; cancel 紧急关闭 after the line is clear |
| 牵引单元故障 | 1–2 of the 6 traction units cut: acceleration ×(1 − n/6), the train loses time on every run; "recoverable" comes back after the driver resets the inverters at a stop (3–5 min) | Driver's call: run on and withdraw at the terminus (终点站下线), clear passengers and return at the next station, or keep running until the night |
| 车门故障 | At the next station a door does not close. Normal: the driver isolates it (≈75 s), each cut door adds 2 s dwell from then on. Severe: it can neither close nor be isolated, the train cannot move | Severe: clear passengers and lock the door (2 min), then empty to the depot; or wait for the maintainer (≈8 min) |
| 制动不缓解 | At departure a car's brake does not release; the driver tries for 2 min. Recoverable: it releases. One car: its brake is cut out, ≤ 60 km/h. Several cars: train cannot move → rescue | One car: run to the terminus and withdraw, or withdraw now; several cars: 组织救援 as for 列车故障 |
| 大风 / 暴雨 | Speed restriction on the exposed sections (table above) | Ends with the weather; regulate with holds and turnbacks |

Every automatic and manual event goes to the event log; alarms stay active until the
condition clears and can be acknowledged.

## Engineering

* **Stack**: Vite + TypeScript, PixiJS 8 (WebGL) for the overview and the train graph,
  DOM for panels. Static geometry is built once; per frame only tints, visibility and
  the train layer change. Graph lines are cached in hourly chunks and actual lines are
  appended incrementally.
* **Simulation** runs in a Web Worker (`src/sim/worker.ts`) with a fixed 0.1 s step,
  decoupled from rendering, with time acceleration; snapshots stream to the UI at 20 Hz
  as packed typed arrays.
* `src/data/line2.ts` holds all line data (stations, distances, sources, layout
  approximations, depots, speed limits, operating anchors); `src/sim/topology.ts` turns
  it into a node/link track graph with 483 axle-counter sections, 59 switches,
  300 signals and 389 interlocking routes generated automatically.
* `interlocking.ts` (routes, switch locking, sectional release, approach locking,
  guide routes, aspects), `movement.ts` (MA scan: CBTC moving block behind the
  preceding train's tail, fixed-block TBTC by section occupancy, RM on sight; ATP/ATO
  control), `ats.ts` (task execution, ARS with plan-order arbitration, regulation,
  commands, manual driving and stop scoring), `timetable.ts` (templates, circulation,
  insertion/withdrawal), `faults.ts`, `passengers.ts`, `radio.ts` (calls, responses,
  deadlines and consequences), `env.ts` (weather, possessions), `yard.ts` (stabling
  tracks), `pis.ts`, `scenario.ts` (scenarios, random faults, metrics, report),
  `state.ts` (checkpoint capture/restore and a state fingerprint for determinism tests).
* **UI** (`src/ui/`):
  * `layout.ts` computes the screen regions from the window, the UI scale and the graph
    mode.
  * `geometry.ts` folds the track graph into rows for any width.
  * `trackview.ts` is the PixiJS schematic, used both for the overview and for the
    station view, with `labels.ts` doing the overlap-free label placement.
  * `graph.ts` is the train graph; `stationview.ts`, `yardview.ts`, `dmi.ts`,
    `pisview.ts`, `report.ts` and `help.ts` are the views and dialogs; `audio.ts` is
    sound.
  * DOM panels are scaled with the same factor as the canvas. Snapshot listeners run once
    per rendered frame, so panel and DMI updates can never queue up behind a slow frame.
* **Tests** (`tests/`):
  * a full weekday and weekend: every planned revenue trip runs, no collision, no
    emergency brakes, ≥ 98 % on time, everything returns to depot or overnight stabling;
  * one scenario per fault type and dispatcher command;
  * the revision features: blocking, CM/RM driving with ATP and stop scoring, radio
    consequences, wind restriction, possessions, vehicle conservation in yards, PIS,
    scenarios and their warm-up, and replay determinism.
* `scripts/label-check.mjs` loads the running dev server in Chromium at 4K/100 %,
  1440p/110 %, 1080p/150 % and 768p/150 %. For the overview (whole line and two zoom
  levels) and a station view, it checks label overlaps and the minimum font size.

## Timetable

Generated from parametric templates (no real timetable is copied):

| Template | Parameters |
|---|---|
| 工作日早高峰 | pattern big–big–small, 2'00" through 淞虹路–广兰路 → outer sections alternate 2'00"/4'00" (avg 3'00"), dwell ×1.15; about 72 trains on the line |
| 工作日晚高峰 | the same pattern at 3'00" → outer 3'00"/6'00" (avg 4'30"), dwell ×1.1; about 48 trains |
| 工作日平峰 | big route only, 5'00" (also the pre-peak transition; 7'00" evening); about 36 trains |
| 双休日/节假日 | big route only all day, 4'30" daytime |
| 首末班及收车 | first train 05:25 from 蟠祥路·国家会计学院; last 蟠祥路→浦东1号2号航站楼 21:57, then 蟠祥路↔广兰路 until 22:42 (eastbound) / ~23:20 (westbound); last westbound from the airport timed to reach 蟠祥路 at ~00:05; trains then run empty to depots or stable in terminal tails |
| 加开 | 进博会保障 (国家会展中心↔广兰路), 虹桥枢纽大客流 (虹桥火车站↔广兰路, station-front turnback at 虹桥火车站), or a single extra train from any depot |

Departure streams are laid out at a reference station per direction (淞虹路 eastbound,
广兰路 westbound) so the core section has uniform headways. Trips are linked into train
blocks by FIFO matching at each terminal (minimum turnback 240 s; 100 s on the 广兰路
middle-track platform and 120 s for the 虹桥火车站 station-front turn, both of which change
ends on the platform; terminal layover ≤ 25 min, terminal capacity respected). Missing
trains are supplied by revenue insertion trips from the nearest depot placed into gaps of
the stream (e.g. peak insertion from 龙阳路车辆段 for small-route trains at 广兰路), surplus
trains withdraw the same way. 广兰路 holds one turning train at a time: a positioning
move that cannot turn there without crowding the platform comes from 川沙停车场 instead,
already facing west, and a small-route arrival whose platform the next arrival needs
first runs on to 浦东1号2号航站楼 (延伸运行).
Weekday peak uses 65 trains, within the 100-train fleet.

Overnight the yards hold 92 trains; the other 8 stay on the line (D68): 4 at 蟠祥路 (both
turnback tracks and the two places of the DN storage tail), 2 in the airport tails and 2
in the 上海科技馆 turnback track, which run up westbound as that station's first trains.

Off-peak each line end keeps a hot standby (热备车, D70) in one of its turnback tracks
(weekday 10:10–15:50 and 20:00–21:40, weekend 10:00–21:00); the other trains turn through
the other track. In the peak build-up it takes the first departure the line end has no
train for. Dispatch uses it before a yard standby: with 2–3 min notice it takes over a
departure from its station, either for a late train arriving there (which turns into the
track and becomes the standby, 终点站换车) or for a train lost to a failure (a yard
standby then covers its own later duty). The train label shows 热备; the train command
备车接替 calls it.

## Cab DMI

The DMI follows the clear Line 2 photo `reference/dmi/IMG_20261021_202812.HEIC`
(2026-10-21). The older photos below remain secondary references.

| File | Shows | Used as |
|---|---|---|
| `IMG_20261021_202812.HEIC` | clear Line 2 cab, DTO-CBTC | primary layout, labels and message wording |
| `line2_blurry_1.png`, `line2_blurry_2.png` | the DMI in a Line 2 02A05 cab | authority for Line 2 content wherever legible |
| `casco_am_clear.png` | a clear Casco DMI in AM (another Shanghai line) | authority for colours, typography, icon shapes, log style, proportions |
| `casco_fam_clear.png` | a clear Casco DMI on another city's GoA4 line | layout cross-check only |

No vendor logo or bezel is drawn.

### Layout

* **Background and colours.** Navy background (`#161d49`), white primary text, blue labels,
  green for normal / closed, yellow for open doors and warnings, red for the permitted
  speed and emergencies.
* **Top bar.**
  * 下一站 on the left, 终点站 on the right, with white labels above names.
  * HOLD while held, `T` + 4 digits, service number, grey C000, white 菜单.
  * No separate trip-number field. Station spelling uses `StationData.dmiName`: only
    浦东1_2航站楼 is confirmed; all other stations keep their full names.
    折 appears in both fields only at the arrival platform before entering a
    turnback track (用户决定，2026-10-22). Passenger running shows the real terminus.
    On entering the turnback track the next station becomes the next working's
    departure platform, and the terminus becomes that working's real destination.
    Once stopped at the departure platform, 下一站 shows the following call.
    Platform-only changes of ends show the next working immediately, without 折 (用户确认，2026-10-22).
  * `DEP hh:mm:ss` under the train ID.
* **Speedometer.**
  * Range 0–120 km/h, labelled every 20, minor ticks every 2 km/h, long ticks every 10, as on the Line 2 photos.
  * Digital speed in the hub circle, `km/h` beneath.
  * Permitted speed shown as a red arc on the rim from the permitted speed up to 120, plus a red triangle marker.
* **Right column.**
  * Large mode and level: `DTO CBTC` / `AM CBTC` / `AM TBTC` / `CM …` / `RM …`.
  * Outlined distance strip: distance to the platform stopping point in metres,
    or --m without a valid target (用户选定并确认，2026-10-22); train-front icon.
  * Train doors above `AA` / `MM`: two leaves, each with a square window, always
    visible. Connected to train door opening, actual lock-confirmation time,
    door faults and isolated doors; unrelated train faults do not turn them red.
  * PSD to the right of `AA` / `MM`: two yellow framed bars with yellow cores
    when open (leaves separated), meeting when closed (用户确认). Connected independently to the current platform's PSD state.
    Visible from head entry into the platform track until the head leaves it;
    hidden between stations (用户确认，2026-10-22).
  * The photo shows open white train-door leaves and yellow PSD leaves;
    both pairs meet when closed (用户确认).
    Each symbol follows its own actual physical transition. A close command
    does not immediately join the leaves: PSD close first, train doors follow.
    Opening differs by at most 0.5 s (用户要求，2026-10-22); the chosen 0.3 s,
    with train doors opening first, is【假设】. Closure uses the same 0.3 s lead
    for PSD inside the existing cycle, without extending the departure deadline.
    The close-up also reads PSD independently. A failed close never shows closed.
    Remaining styles【假设】: closing doors are dim until
    lock confirmation; a door fault is red with a cross; isolated train doors
    and a PSD interlock bypass are orange with a slash. PSD faults and bypass
    come from the platform state, not the train door state.
  * Door mode `AA` / `MM` with its white bar.
* **Row below the dial.** Circled B, current mode-level (`DTO-CBTC`, `AM-TBTC`, etc.),
  stopping-window hexagon.
* **Bottom.**
  * Bottom line: date (YYYY/MM/DD), time, 版本：1.0.0.
  * Message log: `hh:mm text`, newest first. The selected row is highlighted in light cyan; up / down scroll buttons sit on the right.
  * Clicking a row selects it; the buttons scroll the log.

### What drives it

* **Movement authority.**
  * The MA ends at the nearer of:
    * the rear of the preceding train, minus 20 m when both trains are communicating CBTC trains, 25 m otherwise;
    * the end of the set route (6 m before the first signal without a locked route).
  * Other protections can only shorten it: blocked or disturbed sections, platform emergency close, an unlocked platform door, ZC failure, link loss.
  * It is never a fixed length:
    * The 10 Hz supervision scan covers 1400 m, which is further than any braking curve under 80 km/h can reach.
    * The full-length MA is recomputed for every train once a second (ZC cycle) and shifted by the train's own travel in between.
    * `tests/features.test.ts` checks it against an independent track walker.
* **Permitted speed.**
  * The guaranteed-emergency-brake curve to the MA end and to each speed restriction.
  * Capped at the 80 km/h line / train ceiling (02A05 design speed), whatever the dial range.
  * Emergency brake intervention sits 5 km/h above it.
  * The platform stopping point is an ATO target, not an ATP limit.
* **Target.** On a station approach the target is the stopping point at 0 km/h.
* **Modes.**
  * Behaviour stays AM / CM / RM on CBTC / TBTC.
  * The door mode is `AA` in DTO / AM and `MM` in CM / RM.
* **States covered.**
  * AM traction / coasting / braking, station approach, stopped and aligned.
  * Separate train/PSD doors, actual lock confirmation and faults.
  * The departure countdown is on the platform close-up, never on the DMI.
  * CM, RM.
  * Communication loss with emergency brake.
  * Alarms in the log.
* **Train IDs.** Real Line 2 fleet numbers per type, 100 trains:

  | Type | Numbers | Count |
  |---|---|---|
  | 02A01 | 0201–0216 | 16 |
  | 02A02 | 0233–0253 | 21 |
  | 02A03 | 0254–0269 | 16 |
  | 02A04 | 0270–0285 | 16 |
  | 02A05 | 02086–02116 | 31 |

  Sources are under [Data sources](#data-sources). The DMI ID is `T` + the last four digits of the five-digit form: 0213 → T2013, 02086 → T2086.

### Decisions where the photos are not legible

| Element | What the photos show | What is drawn |
|---|---|---|
| Small number after the train ID ("25") | a 1–2 digit number | service (表号) number without leading zeros |
| C000 | grey field, 含义未知 | fixed C000, no model data |
| 菜单 | white button | caption only, no inferred function |
| Circled B | B inside a circular axle icon | circular B icon |
| Level wording in TBTC | only CBTC visible | TBTC |
| Distance strip | outlined strip and --m; platform stopping distance (用户确认) | 用户选定并确认（2026-10-22）：到站台停车点距离（m），无有效停车目标时 --m |
| Train-front icon | outline with triangle | existing traction / brake indication retained as a model assumption |
| Two square icons above AA | train door leaves, each with a square window (用户确认，2026-10-22) | actual train door state, always shown; unphotographed states as described above【假设】 |
| Two yellow bars | PSD open shape, leaves separated (用户确认，2026-10-22) | actual PSD state while on the platform track; hidden between stations; unphotographed states【假设】 |
| Hexagon colours | green / white vertical hexagon | green tips approaching a stop, green body when aligned, yellow tip short / over, white otherwise |
| AA / MM mapping | `AA` on Line 2, `MM` on the clear photo | AA in AM, MM in CM / RM |

### Extrapolations (states the references do not show)

* **Status line** under the door mode: 紧急制动 (red), 超速 / 前方限速 XX · NNN m / 前方停车 · NNN m / 扣车 (yellow), 非站台侧车门开启 (red), 停稳，待开门 / 人工驾驶 (white).
* **Restriction pre-indication** (manual cab only, 【假设】 after the ETCS indication status): about 6 s before the permitted-speed curve towards a lower limit or the end of authority meets the present speed, the status line announces it, a yellow marker shows the target speed on the rim, and a two-tone chime sounds once. The platform stopping point is not announced. The permitted speed (red, overspeed warning) follows a 0.8 m/s² curve; the EB intervenes 5 km/h above the 0.95 m/s² guaranteed-EB curve.
* **Overspeed** turns the hub digits yellow; an emergency brake turns them red.
* **Log messages from the new photo:** `ATPM模式可用` on the existing supervised-mode
  availability event; `定位已确认` at existing DMI initialisation with a valid model
  track position (【假设】: the model has no separate localisation acquisition phase).
  Older-photo wording retained where applicable: `DMI激活`, `连接丢失`.
* **Log messages added in the same style:**
  * `连接恢复`, `CM模式可用`, `仅RM模式可用`
  * `紧急制动 <reason>`, `紧急制动缓解`, `超速报警`
  * `扣车`, `扣车取消`, `区间停车 <reason>`, `列车故障`
  * `<mode> <level>模式` on every mode change
  * Warnings are drawn yellow and alarms red; the clear photo shows only white entries.

## Data sources

| Data | Source |
|---|---|
| Station order, inter-station distances (站间距), chainage, 62.2 km length | [上海轨道交通2号线 — 维基百科](https://zh.wikipedia.org/zh-hans/%E4%B8%8A%E6%B5%B7%E8%BD%A8%E9%81%93%E4%BA%A4%E9%80%9A2%E5%8F%B7%E7%BA%BF) station table |
| West extension opening 2025-11-01, first/last trains, big/small route pattern | [上海市交通委 2025-10-27](https://jtw.sh.gov.cn/xwfb2/20251027/14557ac7aeaa4e95a61cce023ce01a55.html), [澎湃新闻 2025-11-01](https://www.thepaper.cn/newsDetail_forward_31871679) |
| Renaming 徐泾东→国家会展中心, 东昌路→浦东南路, 浦东国际机场→浦东1号2号航站楼 | [澎湃新闻 2024-09-21](https://www.thepaper.cn/newsDetail_forward_28825374) |
| CBTC primary + TBTC backup with switchover | [上海市政府 2024-02-27](https://www.shanghai.gov.cn/nw4411/20240227/180dcb4ed7aa4c48b38cf0761062580c.html), [上海市交通委 2024-01-29](https://jtw.sh.gov.cn/xydt/20240129/723ad1281785433db88e237f2c0748a0.html) |
| Depot junction stations (北翟路→淞虹路, 龙阳路→龙阳路, 川沙→远东大道) | [上海轨道交通车辆基地 — 维基百科](https://zh.wikipedia.org/zh-hans/%E4%B8%8A%E6%B5%B7%E8%BD%A8%E9%81%93%E4%BA%A4%E9%80%9A%E8%BD%A6%E8%BE%86%E5%9F%BA%E5%9C%B0) |
| 8-car trains, 80 km/h operating speed; 02A05 numbers 02086–02116 | [02A05 车型资料](https://www.china-emu.cn/Trains/Cityrails/Model/M-203-T.html) |
| 02A01 numbers 0201–0216 | [上海地铁02A01型电动列车 — 维基百科](https://zh.wikipedia.org/zh-hans/%E4%B8%8A%E6%B5%B7%E5%9C%B0%E9%93%8102A01%E5%9E%8B%E7%94%B5%E5%8A%A8%E5%88%97%E8%BD%A6) |
| 02A02 numbers 0233–0253 | [上海地铁02A02型电动列车 — 维基百科](https://zh.wikipedia.org/zh-hans/%E4%B8%8A%E6%B5%B7%E5%9C%B0%E9%93%8102A02%E5%9E%8B%E7%94%B5%E5%8A%A8%E5%88%97%E8%BD%A6) |
| 02A03 numbers 0254–0269, 02A04 numbers 0270–0285 | [上海地铁02A03型、02A04型电动列车 — 维基百科](https://zh.wikipedia.org/wiki/%E4%B8%8A%E6%B5%B7%E5%9C%B0%E9%93%8102A03%E5%9E%8B%E3%80%8102A04%E5%9E%8B%E7%94%B5%E5%8A%A8%E5%88%97%E8%BD%A6) |
| 100 trains in total (the 100th is 02116) | [文汇报 2020-06-02](https://wenhui.whb.cn/third/zaker/202006/02/352215.html) |

The 蟠祥路·国家会计学院 → 国家会展中心 distance (1640 m) is derived from the constant
1640 m offset between the table's chainage (zero at 蟠祥路) and the pre-extension
chainage (zero at 徐泾东); the official extension length is "约1.67 km". Summing the
table's inter-station distances gives 61 941 m to the eastern terminus versus 61 940 m in
the table (1 m rounding). The source list is also kept in `src/data/line2.ts`.

## Approximations

Everything below is plausible but **not** taken from a public source.

**Track layout**
* Which stations have which track work follows the 配线图 PDF
  (`reference/上海轨道交通全网配线V2025.26.2.pdf`, read station by station in
  `docs/layout-pdf.md`): scissors and 450 m tails at both termini; a scissors with two
  stub tracks between the mains at 国家会展中心 (west), 淞虹路 (west, small-route turnback)
  and 上海科技馆 (east); one stub east of 龙阳路; the 广兰路 middle track along the island
  platform (small-route trains reverse at that platform face); the 创新中路 middle track;
  side storage sidings along the platform at 威宁路 (UP side) and 人民广场 (DN side);
  scissors east of 中山公园; single crossovers at 威宁路, 人民广场 and 凌空路. The PDF is a
  schematic without lengths, so all positions and lengths are approximations. 虹桥火车站's
  two crossovers are not in the PDF (its legend draws only documented track work) and are
  kept for the 虹桥 large-crowd template's station-front turnback.
* 淞虹路's two stubs are in reality the 北翟路 lead tracks; the model keeps a separate
  depot junction 1300 m west, so depot moves do not use the stubs.
* Depot junction geometry: each depot has a grade-separated double connection (exit and
  entry turnouts on each main, the DN legs on a flyover) at 1300 m west of 淞虹路
  (北翟路), 700 m east of 龙阳路 (龙阳路) and 420 m east of 远东大道 (川沙). Only the junction
  station is sourced. Depot capacities are the PDF's 8A positions (北翟路 36, 龙阳路 24,
  川沙 32 = 92); the 100-train fleet's spares beyond that are stabled over capacity.
  Stabling tracks and the 4-minute exit preparation are approximations; depot-internal
  movements are not simulated.
* Axle-counter sections: one per platform, one per turnout, plain line split into ≤450 m
  sections.
* Signal placement and naming (X/S + station number + sequence, odd for eastbound),
  switch numbering (P + station number), section names (G + station number), and the
  convention 下行 = towards 浦东1号2号航站楼, 上行 = towards 蟠祥路·国家会计学院.
* Four ZC areas: 蟠祥路—娄山关路, 中山公园—浦东南路, 世纪大道—广兰路, 唐镇—浦东1号2号航站楼.
* Platform length 190 m, train length 186 m, island platforms drawn for every station
  (广兰路: island between the UP main and the middle track, side platform for DN).

**Signalling behaviour**
* CBTC: MA ends 20 m behind the preceding communicating train's tail, at sections occupied
  without a communicating train, at signals without a locked route, at closed platforms
  and at unlocked switches. ZC cycle and radio latency are not modelled.
* TBTC backup is modelled as fixed block by axle-counter section with ATO still
  available (the real line ran ATO under its former TBTC); the actual TBTC block layout is
  not public.
* Plain-line routes are permanent automatic (自动通过) routes; signals show the
  fixed-block aspect and go dark (灭灯) when the route is occupied only by communicating
  trains.
* Guide routes stay open 60 s; approach-locked route cancellation is delayed 30 s;
  switches throw in 5 s.
* Driving modes: DTO normal; AM (ATO with a driver) under CBTC as DTO's degraded mode, and under TBTC after a
  communication loss or zone switch; manual CM retains ATP; RM
  (≤25 km/h, on sight) for guide signals, preset sweeps, dispatcher authorisation and
  rescue coupling. Train-level downgrade takes 30 s of driver action. No unattended
  operation.

**Speeds and performance**
* Permanent speed restrictions other than the 80 km/h line speed (terminal areas 55,
  curves 60–70, river crossing 65–70), turnout speeds (crossover 35, siding 30, depot 25,
  tails 40 km/h).
* Train performance: 1.0 m/s² up to 40 km/h then constant power, 0.75 m/s² planning
  brake, 1.25 m/s² emergency brake. Planned run times are computed with the same model
  with a 5% margin over the fastest modeled ATO run. Trains enter and leave the platforms
  they stop at at no more than 50 km/h, and pass platforms they do not stop at at no more
  than 45 km/h.

**Operations**
* Peak core 2'00" (AM) / 3'00" (PM); off-peak and pre-peak 5'00", evening 7'00",
  first/last-train periods 7'00"/8'00", weekend 4'30".
  Peak periods 06:50–09:30 and 16:50–19:30.
* First westbound train from 浦东1号2号航站楼 at 05:30; last westbound 广兰路 departure 23:20.
* Demand-derived planned dwells of 20–35 s (busy stations up to 50 s at the peaks), minimum planned turnback 240 s (广兰路 100 s, 虹桥火车站 120 s), 40 s change of ends with
  a driver pre-positioned at the other cab.
* Overnight stabling: two trains each in the tails of both termini; all others in depots.
* Passenger model: time-of-day demand profiles, per-station demand weights, alighting
  proportional to the remaining demand along the line, 40 doors × 2.2 pax/s exchange
  rate, capacity 2480 (rated) / 3200 (crush).
* Trip numbering (1xxx big, 2xxx small, 3xxx late, 4xxx insertion/withdrawal, 5xxx
  added, 0xxx empty, 6xxx adjusted; odd eastbound). Train set numbers are the real
  ones (see [Cab DMI](#cab-dmi)); which set runs which block is invented.
* Added-service presets (routes, periods and headways) for CIIE and the Hongqiao hub.

**Revision features**
* Exposed sections: elevated from K37.4 (east of 广兰路) to 海天三路, at grade from there
  to the airport terminus. The wind and rain limits are typical operating rules, not
  Line 2's published ones.
* Night possessions: drawn from 9 candidate station intervals. Morning possessions are
  released by 04:20 if the call is answered. The night window is 00:50–03:30.
* Yards: stabling tracks 14 / 12 / 8 with 34 / 30 / 20 places (北翟路 / 龙阳路 / 川沙),
  2–3 trains per track. Yard moves are instantaneous.
* Radio calls:
  * the scripts and the set of responses are simplified;
  * call deadlines are 45–300 s;
  * auto-answer waits 15 s;
  * an unanswered call is repeated every 2 min.
* Manual driving:
  * lever notches scale traction (P1–P4 = ¼–4/4 of the available effort) and service
    brake (B1–B7 = 1/7–7/7 of 1.0 m/s²) linearly; emergency is 1.25 m/s²;
  * the ATP permitted speed is the curve to the end of authority at a guaranteed
    0.95 m/s² plus 0.15 m/s tolerance (the ATO drives the 0.75 m/s² planning curve);
  * stop scoring: accuracy (0.3 / 0.5 / 0.75 / 1.0 m) 80 points, one continuous
    brake application in the last 200 m (一把闸) 20 points less 10 per release, a
    second approach after stopping short −30;
  * platform sides: island unless the track-layout PDF shows a side platform
    (创新中路, 川沙, 凌空路, 浦东1号2号航站楼, 广兰路 DN); PSD and car door geometry of
    the close-up is approximate;
  * overruns of up to 15 m are backed up automatically (in reality only with
    dispatcher permission).
* Scenario scoring weights (delay, affected passengers, delivery, calls, safety) are our
  own choice.

## Performance

The renderer keeps static geometry in GPU buffers. Per frame it only changes tints,
visibility and the train layer, and it does so only when a new 20 Hz snapshot arrives or a
blink phase changes. The train graph caches planned lines in hourly chunks and appends
actual lines as small batched graphics every 0.6 s. The simulation runs in its worker. Full-day runtime depends on train load and the
per-tick integrity checks; the earlier 70 s measurement predates those checks. The frame rate and per-frame update
cost are shown at the top of the graph panel.

Measured in the development container at 3840×2160 during the 08:00 peak (65 trains,
graph visible), headless Chromium with **software** WebGL (SwiftShader) sharing the CPU:
schematic update ≈ 2.6 ms and graph update ≈ 3 ms per updated frame, at 1× and at 60×.
The container has no GPU, so the frame rate there (≈10 fps) reflects software
rasterisation, and **60 fps on real 4K hardware has not been measured**. Check it with
the on-screen readout in a hardware-accelerated browser.

## License

AGPL-3.0, see [LICENSE](LICENSE).

The PIS seven-segment digits use DSEG7 Classic by keshikan (SIL Open Font License 1.1,
[src/ui/assets/fonts/DSEG-LICENSE.txt](src/ui/assets/fonts/DSEG-LICENSE.txt)).


## Stabilization validation

The runtime checks every 0.1 s for overlap, issued-MA overrun, unlocked routes,
points moving under load, EB acceleration, overspeed and illegal FSM changes.
Faults, holds and planned layovers are distinguished in the stop reason and wait graph.
Diagnostics exports include the complete plan, input timeline and immutable alarm history.
The planning preview validates the same candidate plan used at confirmation.

Full certification requires 2 day types × 3 templates × fault levels 0–2; level 0
runs seed 1 only (no gate depends on the seed), levels 1–2 run 10 seeds.
Fault-free cases require at least 98% of completed revenue trips within ±120 s and
no arrival more than 300 s late; fault cases must recover within 3600 s after the
last cleared fault once injection ends and deliver at least 95% (level 1) or 90%
(level 2) of planned passenger trips. Level 3 (a train failure about every 45 min)
remains an instructor setting but is not a soak gate: no real operating day has
that fault rate (D23). A filtered run is never certified.

**Status: certification pending.** Current results and remaining paper/model gaps
are recorded in `docs/design-decisions.md` and `docs/signalling-model.md`; unit-test or
subset success does not establish that the complete stabilization pass is finished.

`soak:quick` runs **18 complete service days**: weekday/weekend × base/ciie/hongqiao
× fault-free (seed 1) and level 2 (seeds 1–2), using the same checks as the full run.
Quick results go to `tests/out/soak-quick/summary.json` and never count as full certification.

Both runners use parallel child processes (default 2–4 workers, according to CPU
availability), continue through all cases after failures, and return a nonzero exit
code if any case fails. Each case saves JSON results. Every simulation failure
has a lossless replay bundle (`*-diagnostics.json`) and report (`*-failure.json`).
For a crashed/timed-out worker the runner preserves its latest checkpoint; the
report identifies the process exit or timeout. A worker that cannot initialize
has a process failure bundle with stderr and `stateUnavailable: true`.
The summary is replaced atomically after each result; the default wall timeout
is 60 minutes per case.

Run the full matrix overnight, with four workers and a persistent log:

```bash
mkdir -p tests/out
nohup env SOAK_WORKERS=4 npm run soak > tests/out/soak.log 2>&1 &
```

Options: `SOAK_WORKERS=N`, `SOAK_OUT=directory`, `SOAK_TIMEOUT_MS=milliseconds`,
`SOAK_RESUME=1` (reuse only complete passing cases with an identical model hash),
`SOAK_FAIL_FAST=1` (optional), and `SOAK_PROGRESS=0` (quiet worker progress).
`SOAK_SEEDS` and `SOAK_FILTER` support focused full-run debugging;
filtered/incomplete results cannot be certified. A directory lock prevents
concurrent writers. Stale locks recover automatically once their process exits.

## Calibrated service and regulation

Weekday peak bands cover the whole 淞虹路–广兰路 core in both directions from
06:50 to 09:30 and 16:50 to 19:30. Origins dispatch the leading wave earlier,
with a gradual pre-peak transition. Core slots are 120 s (AM) and 180 s (PM); the
2:1 big/small pattern gives alternating one/two-slot big-route intervals on the outer
sections.
Positioning runs and depot returns have explicit paths and circulation capacity.

Ordinary planned stops are 20–35 s and busy stops 25–50 s, growing with the demand; the
longer peak stops leave a late train room to make up time. ATS shortens late
stops only to the actual passenger/door minimum (absolute 15 s assumption),
adds at most 10 s for early arrival, and adjusts ATO performance on the next
section within ATP limits. The platform-end green dot-matrix sign beside the
departure signal counts seconds down to zero, then counts positive overtime;
a train or platform hold displays H. It goes dark five seconds after the
simulator records the head leaving the platform (用户确认，2026-10-22). A stop
without a planned departure has no numeric count; hold still shows H. Its position follows the
topological signal, including middle-track platforms, with no station-specific
branches. There is no countdown on the DMI. CM/RM may depart once actual train
doors and PSD are closed/locked, without waiting for the plan; the existing door
cycle and staff-confirmation delays remain. Train/platform holds, interval
metering, equipment faults and turnback waits remain in force. An early wheel
start records one “早发 N 秒” information event and negative delay; automatic
DTO/AM still obey their departure time. Actual DEP records wheel start.
Planning run-time margin is at most 5%
of the fastest modeled ATO run. Sources and assumptions: design decisions D28–D43.

Fault-free soak cases require at least 98% of final revenue arrivals within
±120 s, none over 300 s late, actual daily boardings within 10% of the target,
and weekday peak maximum section load at 90–130% of the rated 2480 passengers.
Every failure saves a diagnostics bundle and failure manifest. Full soak runs
continue unattended across failures; `SOAK_WORKERS=4 npm run soak` runs the full
126 cases locally, with results under `tests/out/soak/`. The quick command runs
exactly 18 cases and does not certify the full matrix.

For automatic dispatch only, a failed train that traps an existing two-train
rescue, or physically prevents its assigned rescuer from setting the required
points, may receive timed field maintenance (20 simulated minutes).
This is an explicit simulation assumption: the repaired blocker clears passengers
and withdraws through normal routing. Ordinary failures still require rescue;
trains and failed vehicles are never removed from the track to clear a blockage.
See D35 for the conditions and limits.

Shared depot conversion tracks keep early departures in the yard until ARS
is ready, giving nearby returning trains priority (D36). After faults close,
persistent late services can clear passengers and position for an original
future departure; unfinished trips are explicitly cancelled, while completed
trip lateness and planned future times remain unchanged (D37). The 45-minute
intervention point is a simulation assumption; the 60-minute recovery limit
still applies. Failure bundles retain both final diagnostics and the last
pre-failure checkpoint.
