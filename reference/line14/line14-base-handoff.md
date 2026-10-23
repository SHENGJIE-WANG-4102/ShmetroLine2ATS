# 多线路基座交接：14号线怎么接上、哪些是公共接口

写给 14号线那边（分支 `claude/line14-ats-renovation-8298b1`）。基座是 2号线这边的 D140（`docs/design-decisions.md`），提交在 `claude/nifty-faraday-mdr3ug` 上，从 `4305715` 起可用。2号线和 14号线从这里开始并行开发。

## 1. 先接上基座

- 14号线分支现在停在 `e6a6372`，它是基座的祖先，自己还没有提交，所以直接快进到 `claude/nifty-faraday-mdr3ug` 就行，不会有冲突。
- 那个工作区里有一份未跟踪的 `reference/line14/`（`line14-README.md`、`line14-gaps.md` 等），文件名和基座里已提交的 `README.md`、`line14-layout-pdf.md`、`line14-field-cab-2025-09-05.md`、本文件都不重名，快进不会覆盖。快进前还是先 `git status` 看一眼。两份资料以后怎么合并，你们那边定；结论放本目录顶层，外部调研放 `research/`（不入库）。
- 以后 2号线这边推了新的公共改动，14号线分支定期合并 `claude/nifty-faraday-mdr3ug`。

## 2. 目录归谁

| 归 14号线自己，随便改 | 公共，改了算核心改动（见第 4 节） |
|---|---|
| `src/data/lines/line14/**`（新建） | `src/sim/**`、`src/ui/**` |
| `tests/` 里 14号线专用的测试文件 | `src/data/` 下 `lines/` 以外的文件（类型、注册表、选线、范围） |
| `reference/line14/**` | `scripts/**`、公共测试和 `tests/helpers/` |
| `src/data/registry.ts` 里登记 14号线的那一行 | `src/data/lines/line2/**`、`lines/test/**`（别的线的数据） |

## 3. 公共接口

### 选线和登记

- 启动时选一次，换线整页重载，没有运行中切换：
  - 页面用 `?line=14`；
  - Node 脚本和测试用 `ATS_LINE=14`，或者 `--line=14` / `--line 14`；
  - 不指定时默认 2号线。
- 登记：在 `src/data/registry.ts` 的 `LINE_GROUPS` 里加 `singleLineGroup(LINE_14, true)`。
  - 第二个参数 `true` 表示只在开发模式和测试里出现，正式构建的菜单里看不到。
  - 验收前一直保持 `true`，什么时候放进正式菜单由用户决定。
- 线路组 `LineGroup` 有 `lines` / `lineIds` 两个数组，为以后 3、4号线共线留的。14号线是一组一条线。

### 数据契约 `LineData`（`src/data/types.ts`）

| 字段 | 内容 | 14号线注意 |
|---|---|---|
| `id` | `'14'` | 进存档、诊断、inputLog、预热键 |
| `branding` / `ui` | 标题、线路色、标志、帮助文字、偏好前缀（`LineUiData`） | 没有图片标志时，`badgeUrl: ''` 加 `logoText` |
| `signalling` | `{ primary, fallback[] }`，可选 CBTC / TBTC / TACS / fixed | 后备方式按资料填，见第 5 节 |
| `automation` | DTO / UTO / ATO | **目前代码里没有任何地方读它**，见第 5 节 |
| `core` | `CoreLineData`：车站、车辆、配线 `LAYOUT`、限速、`OPERATIONS`、露天段、施工 | 31站、封浜和金桥基地，按 `line14-layout-pdf.md` 建 |
| `firstLast` / `lastTrains` | 官方首末班、间隔、换乘末班 | 官方时刻表是硬约束 |
| `audio` | 六个音频库 | 没有录音就用 `emptyAudio(stations, doorTiming)`（`src/data/emptyAudio.ts`） |
| `simulation` | `SimulationData`：运行图 `timetable`、`physics`、`energy`、`calibration`、`gradient`、`holiday`、`pis`、`topology`、`instructor` | 没有的功能填空表或 `null`，例如 `river: null`、`peakSection: null` |

- 参照写法：`src/data/lines/line2/index.ts` 是完整的真实线路，`src/data/lines/test/index.ts` 是最小的虚构线路。
- **不要学测试线用 `...LINE_2.core` 这种展开继承。**
  - 测试线是虚构的，借用 2号线的值没关系。
  - 14号线这样做，会把 2号线的车辆性能、停站、首末班口径悄悄带进来。
  - 每个值都要写出来并注明来源；确实和 2号线相同的（比如同为 8A 车的门动作），在注释里写明「同 2号线，依据……」。

### 代码里怎么读当前线路

- 一律从 `src/data/current.ts` 取：`LINE`、`LINE_ID`、`GROUP`、`SIMULATION`、`STATIONS`、`OPERATIONS`、`FIRST_LAST`、`supportsSignalSystem(level)` 等。
- 不要在 `src/sim`、`src/ui` 里直接 import `lines/line14`。
- 判断「谁在前方」用 `topology.ts` 导出的 `ahead(dir, a, b)`；车站范围用 `orderedStations` / `stationRange`。不许拿车站序号比大小。
- 线路范围：`src/data/scope.ts` 的 `currentScope()` / `assertScope()`。存档、诊断、inputLog 都带 `groupId + lineIds`，跨线恢复或回放一律拒绝。

## 4. 改公共代码的规矩

AGENTS.md 的硬规矩照常适用。另外：

1. **行为差异写成数据或能力判据，不许写 `if (LINE_ID === '14')`**。现成的判据是 `supportsSignalSystem`。需要新判据时，加在 `current.ts` 或线路数据上，2号线和测试线都要显式给值。
2. **类型里新加字段**：2号线和测试线要么显式填值，要么把字段设成可选。不许因为加字段改变 2号线的结果。
3. **流程**：
   - 公共改动单独成一组改动，不和 14号线的数据混在一起；
   - 用户把它带到 2号线对话审，审过先进 `claude/nifty-faraday-mdr3ug`；
   - 14号线分支再合并下来。
   - 2号线这边动公共代码，也走同一套检查，并在 `docs/design-decisions.md` 里写清楚。
4. **核心改动两边都要过的检查**：
   - **2号线**：
     - `npx tsx scripts/plan-hash.ts`：四个哈希和改前一致；结果本来就该变的，要逐条说明原因；
     - `validate-plan`（weekday、weekend）、`firstlast`、`gaode-compare` 三个脚本，输出和改前一致；
     - 测试失败表和改前相同（基线的失败见第 6 节）。
   - **测试线**：`tests/test-line.test.ts` 通过；`ATS_LINE=test npx tsx scripts/plan-hash.ts` 不变。
   - **14号线**：你们自己定的验收。
   - **压测**：`scripts/fuzz-day.ts` 在 2号线、测试线、14号线上各跑一个种子，带第二天、天气和调度操作，0 完整性违例。失败了先用改前代码跑同一个种子，看是不是原来就有。
   - 不跑 `npm test`、soak、simday。

## 5. 基座现在的限制（14号线会碰到，多半要改核心）

- **UTO 没有入口**。
  - `automation` 字段只是登记了，代码里没有地方读它。
  - 现在司机相关的流程都按驾驶模式和 `OPERATIONS` 数据走：AM 司机作业 `OPERATIONS.atoDriverWork`、DTO 司机关门发车、司机来电、司机室显示。
  - 14号线要的「平时无人驾驶、随车人员只在需要时介入（偶尔 ATPM）」，得在核心里加一个能力入口。这是核心改动，按第 4 节走。
- **没有后备系统时「停车等区域控制或通信恢复」是测试线的占位规则**，不是现实。14号线真实的降级方式要按资料建，同样是核心改动。
- **运行图引擎的假设**：
  - 两个核心终点（`timetable.terminals.core`）、大小交路模板；
  - `OPERATIONS` 里首末班相关的字段名是 2号线口径：`firstWestTerminusDep`、`lastBigEastboundDep` 等。
  - 14号线是单条直线，应该装得下。字段名不合适的话，改名属于公共改动。
- **单里程轴**：线路图和运行图的纵轴都按一条里程轴画，直线线路没问题。
- **`scripts/gaode-compare.ts` 写死读 `reference/timetable-gaode/`**，那是 2号线的数据。14号线要比高德，就要给脚本加参数（公共改动）。
- **`tests/line-data.test.ts` 只扫 2号线的站名和站码**。14号线接入时，要把它扩到所有登记的线路（公共测试）。
- **预热检查点**的键包含 `src/data/**` 的源码。改 14号线的数据会让 2号线的预热重建一次，这是正常的。

## 6. 2号线这边接下来要动的公共代码（提前说，避免同时改同一块）

按顺序：

1. **9 条基线测试失败排查**：
   - features 4 条：CM/RM 物理锁闭和扣车、CM 站台侧门使能、CM 空车停门使能；
   - round3 1 条：短暂占用尾轨后的加开延续；
   - core 4 条：S0102 救援两条、热备 D45 两条。
   - 可能碰 `onboard.ts`、`psd.ts`、`ats.ts`、`timetable.ts` 的加开。
   - 另外基线还有 4 条已知失败（calibration 2 条、timetable D73 2 条），放在第二部分处理。
2. **压测根因第二轮：出入段和资源统一仲裁**（F2/F3/F4，`docs/handoff-fuzz-roots.md`）。
   - 改 `ats.ts` 里的 `trainDesire`、`reversalGuard`、`depotEntryBlocker`、`resolveDepot`，以及出段准入 `spawnDue`。
   - **14号线的出入段、折返、存车逻辑，尽量等这一轮落地再动。**
3. **第二部分：车底运用**。
   - 新模块 `src/sim/dutyPlan.ts`，不接进 `Sim`，不改 `timetable.ts`、`ats.ts`。
   - 但其中「停站基础交换时间随客流缩放」要改 `calibration.ts` 的停站模型。14号线如果复用这个停站公式，会跟着变。

每一项落地，`docs/design-decisions.md` 都会有 D 条目，提交说明里写明动了哪些公共文件。

## 7. 已定的公共接口口径（2026-10-24，答复 14号线对话）

| 事项 | 口径 |
|---|---|
| UTO 入口 | `LineData` 加必填字段 `unattended: { doorClose, turnback, wakeSleep, depotMoves }`，2号线和测试线全部显式填 false。`current.ts` 加 `unattended(task)` 判据，只认这一个；`automation` 只当显示标签。UTO 流程写成独立函数，在少数几个调用点按判据分流。 |
| 不停车的站 | `StationData.opened?: boolean`，默认 true，表示「建成未开通」。在 timetable 生成停站的地方集中判断一次，PIS、客流、线路图都读这个结果；通过速度用现有的 `OPERATIONS.platformPassKmh`。 |
| 首末班字段 | 暂时不改名。West 是站表第一站那一端，East 是最后一站那一端；`lastBig*`、`lastLate*` 填全程末班。改成按终点的通用表，等第二部分落地后单独做一次公共重构，2号线哈希不变。 |
| 出入段和存车 | 列车状态机（唤醒、休眠、自动出库）现在就可以做。`ats.ts` 里出入段的进路和资源仲裁，等 F2/F3/F4 落地。正线过夜先写成 `OPERATIONS.overnightStabling` 数据，交给现有的 `overnightPlaces`、`overnightHolds`。 |
| DMI、PIS 样式 | 样式键按样式命名，不按线路命名；用一张表对应到各自的渲染模块。`src/sim/dmi.ts` 的模型新增量写成通用字段，2号线取值不变。 |
| 无后备时的降级 | `signalling.onLoss: 'fallback' \| 'restrictedManual' \| 'wait'`：2号线填 fallback（TBTC），测试线填 wait，14号线填 restrictedManual。restrictedManual 复用 RM 模式和 `PERF.vRM`。「随车人员限速驾驶」是【假设】，由 14号线对话向用户确认。 |
| 脚本和测试 | `gaode-compare` 加 `--line`，默认仍是 2号线、输出不变；`line-data.test` 扩到所有登记的线路。 |
