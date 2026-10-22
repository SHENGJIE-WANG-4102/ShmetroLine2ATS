# 任务：区间预算调速拿全程距离（修 D119 的漏洞，2026-10-22）

## 背景

D124 查出：ATS 区间调速（`src/sim/movement.ts:729-731` 调 `sectionCruise`）用的是 `scan.stopDist`，它来自 10 Hz 近扫 `scanAhead(..., MA_NEAR)`，`MA_NEAR = 1400 m`。停车点在 1400 m 外时它是 `Infinity`，`sectionCruise`（`src/sim/dynamics.ts:267`）直接返回上限。结果长区间前半段按全速跑（约 77 km/h），只在最后 1400 m 才用富余，等于富余全堆在进站前。远东大道→海天三路 12:00 样本中段 69% 的采样拿不到停车距离。

同一个近扫距离还用在 `tr.delay`（`movement.ts:682-683`），停车点在近扫外时晚点值不更新，又影响 `atoFastMargin` 的选择。

依据优先级已改（D125）：官方首末班 > 用户录音/PIS > 高德（只看车数）。这次的验收不再看高德分钟。

## 要做

1. 区间调速和晚点计算拿到**本站到下一个停车点的全程距离**，不管有多远。近扫（1400 m）照旧只管 ATP、制动曲线、MA，不要为这件事把 10 Hz 近扫加长。实现自己定；可以参考 `refreshAuthority`（`movement.ts:883`）每秒全长扫描 + `maFar` 按本车走行平移的做法，或者沿拓扑直接算路径长度。只写一处，别和现有扫描逻辑抄两份。
2. 如果加了 Sim/Train 状态字段，按 AGENTS.md 坑 5 在 `DAY_STATE` 里归类，带时刻的跨日减一天。`tr.stopDist` 的现有含义（DMI、PIS、halt、radio 都在用阈值读它）不要悄悄改；要改就逐个调用点核对并在汇报里列出。
3. `sectionCruise` 的算法和 `sectionCruiseMinKmh = 12` 这次不动。修完统计巡航速度分布，低于 40 km/h 的情况逐条列出原因（早多少、哪段、什么时段），由我们再定下限要不要改。
4. D 条目接着编号写一条，记改法和前后对比数字。

## 验收（改前、改后各跑一次，同样的种子和情景）

用 D124 的受控实跑探针（`work/field-calibration/` 里那套，全线双向、五时段）和录音对应的 55 段，出前后对比表：

- **区间巡航**：每段的中段巡航速度、峰值速度。重点看长区间：远东大道↔海天三路、虹桥2号航站楼↔淞虹路、广兰路↔唐镇、海天三路↔浦东1_2航站楼。改后应在整段上较均匀，不再是「全速 + 进站前慢挪」。
- **到站准点**：实到 − 图定，按时段分位数（中位、P90、最大）。不能比改前差；早到后在站里干等的时长应减少。
- **夜间高架**：21:40 以后机场段的巡航速度是多少，和用户观察的「晚上约 60 km/h」差多少。只报数，不要为了凑 60 去调参数。
- **和录音比**：用 `scripts/audio/field-calibration.ts` 那套对照重出逐区间表（现场 vs 模型实跑），说偏差是变大还是变小、集中在哪几段。
- **末班**：两种日型的末班车实跑到终点时刻和官方末班（`src/data/firstlast.ts`）比，不能比改前差。

## 必跑

- `npx tsc --noEmit`
- 单测按文件跑：`tests/calibration.test.ts`、`tests/timetable.test.ts`、`tests/field-calibration.test.ts`，以及 grep 到 `sectionCruise`/`delay`/`stopDist` 的测试文件。calibration 里改前已有 3 条失败（`recovers seven seconds…`、`keeps core peak spacing…`、`bounds west-end peak gaps…`），说清楚改后各是什么状态、为什么。
- 运行图应不受影响：改前改后两种日型计划的 `trips`、`blocks` 哈希一致（不一致就停下汇报）。
- 动了车载移动，后台并行跑一小批 `scripts/fuzz-day.ts`（含第二天、天气、随机调度操作），0 完整性违例。

## 不要做

- 不改运行图、首末班常量、走行余量、运行等级、停站模型、限速。
- 不加按区间、按时段的速度表或补差。
- 不放宽任何测试或完整性检查。
- 不跑 `npm test`、soak、simday。
