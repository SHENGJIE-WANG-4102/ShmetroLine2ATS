# 任务：基线上就失败的 9 条测试，加贴着超时线的长测试

**接下来 2号线这边的顺序**：先做本文，再做 `docs/handoff-fuzz-roots.md` 第二轮（先交设计），最后做 `docs/handoff-runtime-and-diagram.md` 第二部分。

14号线在另一个分支上并行开发，所以本文和后面两份改到的 `src/sim`、`src/ui`，都按 AGENTS.md「多线路」一节的公共代码规矩来：
- 2号线 `scripts/plan-hash.ts` 不变，或者逐条说明为什么变；
- 测试线 `tests/test-line.test.ts` 通过。

## 背景

D140 审查时跑了 25 个测试文件，有 14 条失败。其中 13 条在 `ce1954b` 原代码上同样失败，信息相同。证据在主工作区：
- `work/multiline/failure-comparison.json`
- `work/multiline/baseline-extra-tests.*`
- `work/multiline/baseline-core-extra.*`

其中 4 条是已知的，留给第二部分：calibration 两条高峰间隔、timetable D73 两条首末班。本文处理剩下的 9 条，以前只盯着两个文件，一直没发现它们失败：

| 文件 | 测试 | 基线报错 |
|---|---|---|
| features | driver doors… **CM** obeys physical locks and dispatch holds; only manual ignores planned time | expected 'dwell' to be 'run' |
| features | driver doors… **RM** obeys physical locks and dispatch holds… | expected 'dwell' to be 'run' |
| features | CM: the ATP enables only the platform side of a train at its mark; no traction with doors open | expected 'run' to be 'dwell' |
| features | CM: an empty run stopping at its mark gets no door enable, and says why | expected true to be false |
| round3 | early and late added-service reservations: continues beyond a briefly occupied tail while retaining every requested call | expected 1 to be ≥ 2 |
| core | occupied-route rescue … (S0102→尽头(侧向), preset=false) | LIVENESS 违例 |
| core | 同上，preset=true | LIVENESS 违例 |
| core | standby trains (D45) a standby takes over the trips a withdrawn train leaves… | STACK_TRACE_ERROR |
| core | standby trains (D45) relieves a late train… | STACK_TRACE_ERROR |

另外，features 里「vehicles are conserved between yards, the line and terminal stabling」单独跑要 53–67 s，测试超时是 60 s，并行跑全批次时会超时。超时时报的也是 `STACK_TRACE_ERROR`，所以 core 那两条热备测试**可能也只是超时**，先确认。

## 要做的

1. **先分清是超时还是真失败**。9 条逐条单独跑，把 `--testTimeout` 放大（只在命令行上放大，不改文件），记下耗时和结果。
2. **真失败的，找出从哪个提交开始失败**。用 `git bisect` 或者手动二分都行，在单独的 worktree 里跑，不要动主工作区。写清楚：是哪个提交、哪个 D 条目引入的。
3. **按原因分两类处理**：
   - **行为退化**：代码违反了测试要守的规则。修根因，修法要符合 AGENTS 的硬规矩和踩坑清单。
   - **测试过期**：引入它的那个提交，是按用户决定改了行为（比如 D138「司机关门发车，倒计时照走、可以提前发车」，或者 D119 关门时序），测试还按旧规则写。这种按新规则改测试预期，汇报里逐条写依据：哪个 D 条目，用户哪句话。
   - 拿不准属于哪类的，按 AGENTS 出选择题，其他条目接着做。
4. **贴着超时线的长测试**（守恒、热备，以及第 1 步里发现的其他同类）：
   - 先测一下时间花在哪；
   - 能让测试本身变快的（比如复用预热检查点、缩短模拟时段但覆盖同样的事件），优先这么做；
   - 做不到的，给这条测试单独设一个更长的超时，并写明理由。测试超时不是完整性检查，可以调；但完整性时限和豁免照旧不许动。

## 验收

- 9 条：真失败的修好以后通过；过期的改预期以后通过；每条一行，写清结论和依据。
- 25 个文件全批次重跑：失败的只剩那 4 条已知失败（calibration 2 条、timetable D73 2 条），没有超时。
- 2号线 `plan-hash` 不变。修根因导致变化的，说明是哪几趟车、为什么变；`validate-plan` 两种日型 0 error，`firstlast` 和 `gaode-compare` 不比改前差。
- `tests/test-line.test.ts` 通过。
- 动了 ATS、车载或联锁的，后台跑 2号线两个种子加测试线一个种子，带第二天、天气和调度操作，0 完整性违例。已知的泊位预约死锁（13501、13502、13812、13813、13821）归第二轮处理，选种子时避开它们。
- D 条目接着 D140 往后编号。

## 不要做

- 不碰泊位、出入段预约那几个死锁。它们是 `handoff-fuzz-roots.md` 第二轮的事。
- 不改运行时分、停站模型、首末班常量。
- 不为了让测试通过放宽断言；改预期必须有 D 条目或用户决定作依据。
- 不动 `src/data/lines/line14/`、`reference/line14/`，也不动 14号线分支。
