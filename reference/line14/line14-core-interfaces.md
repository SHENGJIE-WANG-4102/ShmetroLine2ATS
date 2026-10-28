# 14号线要动的公共接口：2号线对话的答复（2026-10-24）

14号线一步到位（数据、运行图、完整 UTO、DMI/PIS）要动 6 处公共代码。我们去问了 2号线对话，下面是它定的口径，14号线照此实现。送审规矩见 `line14-base-handoff.md` 第 4 节。

## 2号线那边的排期

| 顺序 | 内容 | 会碰的公共代码 |
|---|---|---|
| ① | 9 条基线失败（`docs/handoff-baseline-reds.md`） | `onboard.ts`、`psd.ts` 的 CM/RM 门使能；可能还有 `ats.ts` 的救援和热备、`timetable.ts` 的加开 |
| ② | F2/F3/F4 压测根因第二轮 | `ats.ts` 出入段的进路和资源仲裁。先交设计、审过再实现，**没有日期** |
| ③ | 第二部分 dutyPlan | 独立模块；但 D139 会改 `calibration.ts` 的停站模型 |

- 近期不动 `src/ui` 的 DMI、PIS。
- ① 和 ② 落地时，他们会通知我们。

## 1. UTO 入口

- `LineData` 加必填字段：

  ```ts
  unattended: { doorClose: boolean; turnback: boolean; wakeSleep: boolean; depotMoves: boolean }
  ```

  2号线和测试线全部显式填 `false`。
- `current.ts` 加判据函数 `unattended(task)`。onboard、psd、radio、ui 只调这一个函数判断。
- `automation` 保留，只当显示标签用。代码里不许写 `automation === 'UTO'`。
- UTO 流程写成独立函数，只在少数几个调用点按判据分流。不要在现有门控逻辑里逐行插判断，这样和 ① 冲突少。
- onboard 两边都会动，不用排队。我们带 UTO 去送审之前，先合并最新的 nifty-faraday，自己解决冲突。

## 2. 不停车的站（龙居路）

- `StationData.opened?: boolean`，默认 `true`。含义是现实状态「建成未开通」。
- 由它推出：不排停站、PIS 不列这一站、客流为 0、列车按跳停通过。
- 通过速度复用 `OPERATIONS.platformPassKmh`，不另开字段。
- 「这站停不停」只在 timetable 生成停站的地方判断一次。PIS、客流、线路图都读这同一个结果，不各自判断。
- 线路图上怎么画由我们定。

## 3. 首末班字段

- 先不改名，14号线映射到现有字段名：
  - `West` 指站表第一站那端（封浜），`East` 指最后一站那端（桂桥路）。
  - `lastBig*`、`lastLate*` 都填全程末班。
  - 字段名不贴切的地方，在 14号线数据文件里加注释说明。
- 读这些字段的只有 `timetable.ts`（14 处）和一条测试，dutyPlan 不读。
- 改成按终点的通用表，等第二部分落地后再作为一次单独的公共重构，2号线哈希必须不变。

## 4. 出入段和存车

- **现在就能做**：唤醒、休眠、FAM 自动出库这类列车状态机，和资源仲裁无关。
- **要等 F2/F3/F4**：`ats.ts` 里出入段的进路和资源仲裁，即 `trainDesire`、`reversalGuard`、`depotEntryBlocker`、`resolveDepot`，以及出段准入 `spawnDue`。做到这一步之前，先合并他们的分支。
- **正线存车线过夜**：只写数据 `OPERATIONS.overnightStabling`，由 timetable 现有的 `overnightPlaces` / `overnightHolds` 处理。引擎排不下就报出来，不另写一套。

## 5. DMI、PIS 分线样式

- 样式键按「样式」命名，不按线路命名。例如 `pisStyle: 'strip' | 'column'`，不写 `'line14'`。
- 用一张表把样式键对应到各自的渲染模块，不在 ui 里到处写 if。
- 现有的 `StationData.pisLayout`（classic / wide）是先例，看要不要并进去。
- `src/sim/dmi.ts` 是公共的：新增的量（比如目标距离）按通用字段加，2号线取值不变，dmi 测试要过。

## 6. 信号丢失后的降级

- 写成 `signalling.onLoss: 'fallback' | 'restrictedManual' | 'wait'`：

  | 线路 | 取值 | 行为 |
  |---|---|---|
  | 2号线 | `'fallback'` | 走 TBTC，行为不变 |
  | 测试线 | `'wait'` | 显式填，原来的占位规则变成测试线自己的数据 |
  | 14号线 | `'restrictedManual'` | 随车人员按 RM 模式限速驾驶 |

- `restrictedManual` 复用现有 RM 模式和 `PERF.vRM`，不新造模式。
- 「CBTC 失效后由随车人员限速人工驾驶」是现实事实，资料里没查到。标【假设】，由 14号线这边问用户确认。

## 7. 顺手做的公共改动

- `gaode-compare` 加 `--line` 参数。不加时默认 2号线，输出不变。
- `line-data.test` 扩到所有登记的线路。

## 8. 送审要求

每组公共改动单独送审，附上：

- 2号线 `npx tsx scripts/plan-hash.ts` 的四个哈希，和合并基点一致；
- 测试线 `tests/test-line.test.ts` 通过；
- 测试失败表和基线相同；
- 三条线各跑一个压测种子。
