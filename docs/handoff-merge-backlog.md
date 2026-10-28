# 任务书：2+14 合并分支遗留问题（2026-10-28）

## 工作区和规矩

- **只在 `D:/ShmetroLine2ATS/.claude/worktrees/merge-l2-l14` 里改**，分支 `claude/merge-l2-l14`（HEAD `ddd7a71`）。主仓库 `D:/ShmetroLine2ATS` 和 `.claude/worktrees/base-*` 都别碰：base-d9d558b 正在跑 Claude 的压测，base-4791f1c 是对照用的旧树。
- 照 AGENTS.md 来：只改工作区，不 commit、不 push、不切分支。
- 补充两条用户决定（2026-10-28）：
  - **plan-hash 不是门槛**，变了没关系；
  - **旧运行图不是依据**，排图结果为了消掉下面这些错误而改变，可以。
- 但新加或删掉运营规则、改用户能看到的运营方式，还是先用选择题问用户。
- 不许为了过测试放宽检查。测试预期因为你的改动变了可以改，每条在汇报里说明为什么。
- **别跑整套测试**：不跑 `npm test`、soak、simday，也不跑整个 `core.test.ts` / `dispatcher.test.ts`（这两个各要 7–15 分钟）。按文件或 `-t` 跑相关用例。随机压测（fuzz）Claude 最后统一跑，你不用跑。
- 下面每项「现状」里的数字，都是在 `ddd7a71` 上实测的。

## 1. D145 之后的退出、救援、回段（优先）

现状：下面这些用例在 4791f1c（D145/D146）上就已经失败，这次合并前就有：
- `tests/core.test.ts`：
  - `occupied-route rescue > admits only the assigned rescuer and retains locks through coupling` 4 例（S2402→S2322、S0102→尽头(侧向)，preset 真/假），都是 `expected true to be false`；
  - `paper-based turnback and depot procedures > rescues an opposing failed terminal-tail train without selecting its parallel tail neighbour` 2 例；
  - `withdrawal approach continuity > clears passengers before choosing a forward turnback after leaving 淞虹路`：任务里多了一个 stop，`[3,1,4,4]` 对 `[3,1,4]`；
  - `withdrawal approach continuity > goes straight to the tail when an empty terminal train has already departed its clear-out mark`：`['stop','reverse','stop','depot']` 对 `['stop','reverse','depot']`；
  - `depot selection after clear-out > does not choose a depot entrance before the passenger clear-out station`：`['stop','stop','reverse','depot']` 对 `['stop','reverse','depot']`。
- `tests/exchange-duty-origin.test.ts`：`keeps the actual unfinished depot exit when the incoming duty has depot 2/0 as its source`，出段换端的首个 stop 不是 `{station:28, note:'出段换端'}`。

目标：找到 D145（出入段固定作业、川沙分线）以后退出清客、救援选车、出段换端哪里不对，修根因。退出规则以 `cmdWithdraw`（`src/sim/ats.ts`）为准：调度员下的退出命令在下一站清客、空车回段。用户 2026-10-28 定的 D150「轻故障就近回段站下线」只走 `vehicleTick`，别改它。

完成标准：上面 11 例全过，同一批文件里其他用例不新增失败。

验证：`npx vitest run tests/core.test.ts -t "occupied-route rescue|parallel tail neighbour|withdrawal approach continuity|depot selection after clear-out"`，`npx vitest run tests/exchange-duty-origin.test.ts`。

## 2. 14 号线排图错误

现状：`tests/line14-timetable.test.ts` 的 `weekday：不丢服务、配线/库存/间隔全部可行` 失败。合并前的 14 号线工作区里一模一样，是 14 号线 WIP 自带的。`ATS_LINE=14 npx tsx scripts/validate-plan.ts weekday` 报：
- `HEADWAY 07:05 桂桥路 上行 0022/0024 间隔 49 s`、`07:07 金粤路 61 s`：两列从桂桥路出段的空车（0022 去蓝天路，0024 去真新新村）挨得太近；
- `TERMINAL_FULL 17:14/17:46/18:18/18:50/19:22 真新新村 同时折返/待发 3 列，超过能力 2 列`；
- 打开候班检查（validate-plan 默认开）后还有一串 `STABLE_CONFLICT`：蓝天路下行、真新新村上行有车在站台同方向长候班，比如 2017→0015 在蓝天路等 450 s、2032→0040 在真新新村等 1690 s，挡住后面通过和停靠的车。14 号线 `longWaitPlatformStations: []`，站台不该长候班。同方向接续这么长的等待，本身就说明车底串法不对。

目标：14 号线工作日、双休日 validate-plan 都是 0 error，上面那个测试通过。

完成标准：`ATS_LINE=14 npx tsx scripts/validate-plan.ts weekday` 和 `weekend` 都是 0 error；`npx vitest run tests/line14-*.test.ts` 全过；2 号线 `npx tsx scripts/validate-plan.ts weekday/weekend` 的 error 数不比现在多（见第 3 项）。

## 3. 2 号线淞虹路早高峰不安全候班

现状：`npx tsx scripts/validate-plan.ts weekday` 报 31 个 `UNSAFE_WAIT`：
- 06:21–08:3x 淞虹路 1道/2道（出入段线）候班 377–670 s，正常作业 240 s；
- 08:13 远东大道 4055→4096 候班 1342 s。

合并前是 30 个。D149（站后折返只用一条主用线，淞虹路主用 2道）以后多了 1 个。

目标：0 error。可以改车底串法和候班地点，比如换到能安全长停的位置，或者把车底拆开别让它长等，但不许在排完图以后取消车次或改起终点来消错误（AGENTS 硬规矩 3）。

完成标准：2 号线工作日、双休日 validate-plan 都是 0 error；`npx tsx scripts/firstlast.ts` 首末班不变；`npx tsx scripts/gaode-compare.ts` 不合格格数不超过 8（现在是 8）。

## 4. 2 号线高峰间隔

现状：`tests/calibration.test.ts` 两例失败，4791f1c 上就有：
- `keeps core peak spacing and accounts for planned LYL returns, depot moves included`：龙阳路（站 19）下行 9:00 前后间隔 147/102/193 s，不均匀；龙阳路终到车和开往川沙的车同一时段挤在一起；
- `bounds west-end peak gaps when portal origins replace some outer legs`：现在报「西端某个高峰窗口里车数不够」（`expected 6 to be greater than 6`）；4791f1c 上是蟠祥路上行 9:35 间隔 445 s。

目标：找到间隔不均的原因（龙阳路回段车和过站车的相位、热备补位、出段时机都可能），修排图规则本身，不要针对这一格挪车。

完成标准：这两例通过，第 3 项的 validate-plan、首末班、高德三项不变差。

## 5. D139 首末班

现状：`tests/timetable.test.ts` 两例：
- `D73 calibrated service anchors > fixes all three last origins and matches official end-to-end arrivals within a minute`：机场方向末班到达晚 86 s，要求 ≤60 s；
- `matches every published first/last minute within two minutes`：静安寺 firstW 晚 138 s，要求 ≤120 s。

官方首末班（`src/data/lines/line2/firstlast.ts`）必须对上。这两项在 D139 时就有。

目标：查清是停站模型、区间时分还是排图平移造成的偏差。不许改 `firstlast.ts` 常量，也不许改 `calibration.ts`、`dynamics.ts` 的运行时分（AGENTS「运行图的依据」）。如果只有改运行时分才能对上，写信给 Claude，附证据。

## 汇报

- 每做完一项写一封到 `work/claude-inbox/`，写清改了哪些文件、根因、验证命令和关键输出，Claude 审。
- 每项的结论写进 `docs/design-decisions.md` 的 D 条目，按编号顺延，从 D151 开始。
- 卡住了照 AGENTS.md 的写信规矩来。
