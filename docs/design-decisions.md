# 设计决定（Design decisions）

论文未直接规定的取舍。每条写明：问题、决定、理由、依据（论文 / 【假设】）。
优先级：安全不变量 > 论文（docs/signalling-model.md §0）> 通用 CBTC 实践 > 早期需求。

本文件是索引；条目正文按主题分在 `docs/decisions/` 下。线路自己的决定另见 [11号线](design-decisions-line11.md)、[14号线](design-decisions-line14.md)。

## 写新条目

- 正文追加到对应主题文件末尾，标题 `## Dxxx 标题`；同时在下面的索引表末尾加一行。
- 条目只写现在有效的决定、理由和改了哪些公共文件；过程、对照表、验收输出放 `work/`，不进条目。
- 一条决定取代旧条目时：旧条目整条作废的，移到 `archive.md`，索引里状态写「已取代 → Dxxx」；部分过期的，在旧条目标题下加一行「> 状态：…」，索引状态同步。

## 主题

- [线路、信号与联锁](decisions/track-signalling.md)（19 条）：配线、进路、ARS、授权、联锁和信号故障的处理。
- [调度、故障与救援](decisions/operations.md)（25 条）：自动调度、故障注入与恢复、救援、清客。
- [运行图、运行时分与停站](decisions/timetable.md)（55 条）：运行图结构、首末班、高德对照、区间时分、停站、各线排图交路。
- [车底运用、出入段与存车](decisions/rolling-stock.md)（41 条）：车底接续、出入段、存车与过夜、备车、加开、资源仲裁。
- [车载、驾驶与车辆](decisions/onboard.md)（26 条）：驾驶模式、ATO、人工驾驶、车辆性能与故障、DMI 以外的车载行为。
- [界面、报站与声音](decisions/ui-audio.md)（32 条）：ATS 画面、DMI、PIS、对标近景、报站和音效、实地录音素材。
- [多线路、性能、测试与审计](decisions/platform.md)（15 条）：多线路接口、性能、测试与压测口径、审计整理。
- [已取代的条目](decisions/archive.md)（14 条）
- [长条目的过程记录](decisions/logs.md)：精简条目时删下来的原文（设计推导、停止现场、验收记录），只作历史；现行决定以主题文件为准。

编号说明：D164 没有单独成条，D165 和 `line2.ts` 里的「D164」指同一次机场视频标定，内容在 D165；原「D???」14 号线共用接口补编为 D183。

## 条目状态索引（2026-11-06 整理，11-08 补到 D190）

正文保留原样，作为历史记录；已过期的条目在标题下另加一行「状态」。

- 已废弃或被取代：D27（D44）、D50（D72）、D59（D134）、D63（D133）、D68（D72、D91、D178）、D70（D148、D178）、D144（D178）、D158（D170、D178）。
- 部分过期：D45（R1 门槛，D148）、D72（过夜部分，D170、D178）、D74（夜间巡航，D121）、D91（过夜、中途热备，D178）、D119（`sectionEta`，D127）、D138（AM 锁门后作业，D179）、D166（跨日存车、中途热备，D178）、D161（DMI 状态行，D187）、D169（起步箭头扩到 CM，D188）、D181（进路显示改为车头前方逐段，D188）、D48（广兰路站台折返 100 s，D188 改为 90 s）、D73（关门提示至起车 12 s、进出站平台限速，D119）、D79/D80/D81（整图重试、单格补车、按日型分叉等级、末班后多铺再取消，D83）、D114（机场 A/B 方案，D115）、D120（首末班误差直接保留，D121）、D124（电机起停与停站数值表，D126）。
- 旧排图实现已删除（D184；D178 时还能用 `OLD_DUTY=1` 对比）：D88、D91、D92、D99、D105、D154。
- 实现搬了位置（D184）：D45、D70、D148、D156、D166、D177 的换车规则从 `src/sim/standby.ts` 搬到 `src/sim/duty/live.ts`；D47 加开的车底运用从 `circulate` 换成 `src/sim/duty/overlay.ts`。
- 标题状态是写条目时的（「验收中」「待审」「待复审」）：D142、D145、D154、D166。

## 索引

| 编号 | 标题 | 主题 | 状态 |
|---|---|---|---|
| D1 | [正常运营模式为 DTO，无 FAM](decisions/onboard.md) | 车载 |  |
| D2 | [已发 MA 与回撤后的制动目标分开](decisions/track-signalling.md) | 信号 |  |
| D3 | [信号机故障注入不强制取消进路](decisions/track-signalling.md) | 信号 |  |
| D4 | [自动调度（自动调度员）与无线自动应答分离](decisions/operations.md) | 调度 |  |
| D5 | [活性（liveness）判定](decisions/operations.md) | 调度 |  |
| D6 | [随机故障只在开始时刻之后注入](decisions/operations.md) | 调度 |  |
| D7 | [运行图可行性：终点站能力、插空间隔、加开不足即报告](decisions/timetable.md) | 运行图 |  |
| D8 | [自动进路：一架信号机先为最近的接近列车排列进路](decisions/track-signalling.md) | 信号 |  |
| D9 | [信号机故障立即进入移动授权](decisions/track-signalling.md) | 信号 |  |
| D10 | [停车中的驾驶模式转换：转换完成前列车不动](decisions/onboard.md) | 车载 |  |
| D11 | [原子命令校验及受限授权](decisions/track-signalling.md) | 信号 |  |
| D12 | [共享转换轨防护与 ARS 归属](decisions/track-signalling.md) | 信号 |  |
| D13 | [出站授权、预览及无损回放](decisions/track-signalling.md) | 信号 |  |
| D14 | [验证状态与遗留偏差](decisions/platform.md) | 平台 |  |
| D15 | [P3 折返方向防护与牵出](decisions/track-signalling.md) | 信号 |  |
| D16 | [首班需求与插车到站估算](decisions/timetable.md) | 运行图 |  |
| D17 | [牵出前等待完整授权，不向关闭的尾轨信号爬行](decisions/track-signalling.md) | 信号 |  |
| D18 | [已处于 RM 的列车也需重新报告预复位/引导](decisions/operations.md) | 调度 |  |
| D19 | [救援列车清客、换端及回段的完整任务](decisions/operations.md) | 调度 |  |
| D20 | [修复后的道岔原位恢复表示](decisions/track-signalling.md) | 信号 |  |
| D21 | [快速验证与无人值守全矩阵](decisions/platform.md) | 平台 |  |
| D22 | [终端尾轨救援的物理路径与服务取消](decisions/operations.md) | 调度 |  |
| D23 | [预复位阻止排列进路时的压道路径](decisions/operations.md) | 调度 |  |
| D24 | [故障恢复时只取消已经错过的完整往返](decisions/operations.md) | 调度 |  |
| D25 | [前车等待远端进路时仍保留近端ARS归属](decisions/track-signalling.md) | 信号 |  |
| D26 | [已进入尾轨后按物理股道固定折返停车点](decisions/track-signalling.md) | 信号 |  |
| D27 | [故障全部关闭后撤回没有可达原图始发的耗尽车底（本轮修订，由 D44 取代触发条件）](decisions/archive.md) | 已取代 | 已取代 → D44 |
| D28 | [清客回段必须保持已提交接近路径，并从清客站判断接轨可达性](decisions/operations.md) | 调度 |  |
| D29 | [八节A型容量及客流标定来源](decisions/timetable.md) | 运行图 |  |
| D30 | [高峰覆盖整段及渐进预置](decisions/timetable.md) | 运行图 |  |
| D31 | [全停站倒计时、客流最短停站及ATO调节](decisions/timetable.md) | 运行图 |  |
| D32 | [唯一折返线预置估时与初始尾轨救援](decisions/rolling-stock.md) | 车底 |  |
| D33 | [定位出段参考一致、始发资源提前预留与故障后加开能力](decisions/rolling-stock.md) | 车底 |  |
| D34 | [单一站后折返线的到达/发车顺序、失效授权及停车根因](decisions/track-signalling.md) | 信号 |  |
| D35 | [双重列车故障堵塞救援的现场抢修假设](decisions/operations.md) | 调度 |  |
| D36 | [共用转换轨的出段等待留在段内](decisions/rolling-stock.md) | 车底 |  |
| D37 | [故障结束后的原图接续定位（本轮修订：取消45min计时）](decisions/operations.md) | 调度 |  |
| D38 | [首个红灯阻挡及既有占用进路内的受限救援](decisions/operations.md) | 调度 |  |
| D39 | [保留已经开始的回段路径](decisions/rolling-stock.md) | 车底 |  |
| D40 | [模式转换立即重算授权](decisions/onboard.md) | 车载 |  |
| D41 | [清客站之后才能折返](decisions/operations.md) | 调度 |  |
| D42 | [中间终端等点与站前折返的双向资源时隙](decisions/timetable.md) | 运行图 |  |
| D43 | [加开回段不得挤占基本图的高峰出段](decisions/rolling-stock.md) | 车底 |  |
| D44 | [恢复调度的显式规则](decisions/operations.md) | 调度 |  |
| D45 | [备车](decisions/rolling-stock.md) | 车底 | 见状态行：R1 门槛 300 s 已改为晚点 20 分钟（D148，`standby.ts` `RELIEF_… |
| D46 | [救援、紧急制动与完整性报警](decisions/operations.md) | 调度 |  |
| D47 | [加开优先延长运用基本图车底，按完整周转排图](decisions/rolling-stock.md) | 车底 |  |
| D48 | [配线按配线图PDF](decisions/track-signalling.md) | 信号 | 见状态行：广兰路站台换端最短折返 100 s（30+40+30）已由 D188 改为 max(清客 60, 换… |
| D49 | [定点班车与站台通过限速](decisions/timetable.md) | 运行图 |  |
| D50 | [高峰间隔与运行时分重新标定](decisions/archive.md) | 已取代 | 已取代 → D72 |
| D51 | [早高峰晚点：道岔防护信号与终点站先到先发](decisions/operations.md) | 调度 |  |
| D52 | [ATO（有司机）作为CBTC下的DTO降级模式](decisions/onboard.md) | 车载 || AM-C 降级模式现行；换端/发车常量已由 D138 的 atoDriverWork、autoStartDelay 替代 |
| D53 | [审计修正：客流倍数、追踪间隔硬约束、实际仿真倍率](decisions/timetable.md) | 运行图 |  |
| D54 | [审计修正：区故解、运行中故障、启动时间、ZC紧急制动](decisions/track-signalling.md) | 信号 |  |
| D55 | [人工驾驶：JRETS/TSW键位、倍率限制、司机开关门、对标近景与评分](decisions/onboard.md) | 车载 |  |
| D56 | [评估评分按时长归一化](decisions/onboard.md) | 车载 |  |
| D57 | [牵引特性曲线、冲击率限制与运行时分](decisions/onboard.md) | 车载 |  |
| D58 | [站台折返开门换端](decisions/operations.md) | 调度 |  |
| D59 | [限速预告与允许速度曲线](decisions/archive.md) | 已取代 | 已取代 → D134 |
| D60 | [对标近景：按距离缩放、站台门编号](decisions/ui-audio.md) | 界面 |  |
| D61 | [走行音（02A05 VVVF）](decisions/ui-audio.md) | 界面 |  |
| D62 | [国庆节假日运营（全天，不跳转）](decisions/timetable.md) | 运行图 |  |
| D63 | [末班车接续（常规运营，非场景）](decisions/archive.md) | 已取代 | 已取代 → D133 |
| D64 | [车辆故障：牵引单元、车门、制动不缓解](decisions/operations.md) | 调度 |  |
| D65 | [坡道（合成纵断面）](decisions/onboard.md) | 车载 |  |
| D66 | [雨天低粘着：空转/滑行、WSP、过标、低粘着模式](decisions/onboard.md) | 车载 |  |
| D67 | [牵引能耗与 ATO 运行等级（可关闭）](decisions/onboard.md) | 车载 |  |
| D68 | [夜间存车：上海科技馆折返线、蟠祥路尾轨](decisions/archive.md) | 已取代 | 已取代 → D72、D91、D178 |
| D69 | [回段换端的逆向径路保护](decisions/track-signalling.md) | 信号 |  |
| D70 | [热备车：线路两端平峰各留一列](decisions/archive.md) | 已取代 | 已取代 → D148、D178 |
| D71 | [实地录音：测量与车站音效](decisions/ui-audio.md) | 界面 |  |
| D72 | [运行图结构：150秒早高峰、晚间收小交路、官方首班与广兰路过夜](decisions/timetable.md) | 运行图 | 首班与编图规则现行；过夜部分废弃（D170/D178），夜间插值由 D81 取代 |
| D73 | [运行时分、分时段停站与官方末班标定（用户决定）](decisions/timetable.md) | 运行图 | 大部分已被后来的条目取代，只剩下面「仍有效」的几项（过程记录见 logs.md） |
| D74 | [按图运行等级：夜间慢走行、正常停站与首班图定修正（用户决定）](decisions/timetable.md) | 运行图 | 「按图运行等级」的机制现行；夜间巡航 −7.5 km/h 已由 D121 取代（D134），首班的图定区间修正 `FIRST_TRAIN_DIAGRAM_RUN_ADJUST_S` 已删，首末班改为 D162 逐站按官方分钟定点；晚间运行等级和停站后来按录音重标（D163）（过程记录见 logs.md） |
| D75 | [广兰路中间线折返间隔：早间开班改由龙阳路分担](decisions/timetable.md) | 运行图 |  |
| D76 | [高德到站表自动采集与完整性校验](decisions/timetable.md) | 运行图 | 现行采集口径 |
| D77 | [高德时刻逐车配对及西段守恒检查](decisions/timetable.md) | 运行图 |  |
| D78 | [东段区间车核验口径](decisions/timetable.md) | 运行图 | 采集分析口径；东段交路未确认，不改运行图 |
| D79 | [高德工作日早高峰：分方向开班、退出及车底接续](decisions/timetable.md) | 运行图 | 结构重试由 D83 取代；时段间隔按 D173 重排 |
| D80 | [高德工作日晚高峰：分方向进入及东行延续](decisions/timetable.md) | 运行图 |  |
| D81 | [高德工作日夜间：四分钟核心及龙阳路载客出入段](decisions/timetable.md) | 运行图 | 工作日夜间 240 s 现行；末班后多铺一趟由 D83 取代 |
| D82 | [远东大道共用出入段线：出段换端车先出，回段车在站台外等](decisions/rolling-stock.md) | 车底 |  |
| D83 | [运行图整理：先分配终端资源，再创建车次](decisions/timetable.md) | 运行图 | 先定请求后建车次现行；终端配车部分由 D178/D184 替代 |
| D84 | [界面时段按乘客看到的钟点显示](decisions/ui-audio.md) | 界面 |  |
| D85 | [车厢视频校准：关门提示频率容差与停稳上下文](decisions/ui-audio.md) | 界面 |  |
| D86 | [10-16 实拍 PIS：两种硬件、分页和真实终点](decisions/ui-audio.md) | 界面 |  |
| D87 | [10-16四段录音测量：视频校准工具、新旧样本隔离](decisions/ui-audio.md) | 界面 |  |
| D88 | [回段归属与车辆段逐日收支（第一轮）](decisions/archive.md) | 已取代 | 已取代 → D178/D184（旧排图已删） |
| D89 | [10-16报站补缺：西端站名、蟠祥路终到及独立成品](decisions/ui-audio.md) | 界面 |  |
| D90 | [报站复核：原段优先、淞虹路取词与虹桥2号航站楼双侧门](decisions/ui-audio.md) | 界面 |  |
| D91 | [回段任务第二轮：晚间服务、库存加开、分散过夜与中途热备](decisions/archive.md) | 已取代 | 已取代 → D178/D184（旧排图已删） |
| D92 | [第三轮：泊位停车、全天车底接续、存车预约和开机缓存](decisions/archive.md) | 已取代 | 已取代 → D178/D184（旧排图已删） |
| D93 | [第三轮续验：共用线等待环、实际折返方向与停车授权边界](decisions/rolling-stock.md) | 车底 |  |
| D94 | [第三轮性能：逐步状态观察索引](decisions/rolling-stock.md) | 车底 |  |
| D95 | [全仓审计整理：库存进出与过夜预约各留一处定义](decisions/rolling-stock.md) | 车底 |  |
| D96 | [列车符号按站台长度定长，显示占用跟随符号](decisions/ui-audio.md) | 界面 |  |
| D97 | [直通出段车的终点站显示](decisions/ui-audio.md) | 界面 |  |
| D98 | [回段让行只看自己要走的那条共用线](decisions/rolling-stock.md) | 车底 |  |
| D99 | [折返待发与共用出入段线统一预约](decisions/archive.md) | 已取代 | 已取代 → D178/D184（旧排图已删） |
| D100 | [车内报站不分驾驶模式](decisions/ui-audio.md) | 界面 |  |
| D101 | [对标近景：到 2-5 号门后停止缩放](decisions/ui-audio.md) | 界面 |  |
| D102 | [车内广播：意外停车时「因故稍作停留」](decisions/ui-audio.md) | 界面 |  |
| D103 | [站台门状态显示：暂不加](decisions/ui-audio.md) | 界面 |  |
| D104 | [列车符号等长，灰色区域显示真实占用](decisions/ui-audio.md) | 界面 |  |
| D105 | [收车终点随图定服务需求选择](decisions/archive.md) | 已取代 | 已取代 → D178/D184（旧排图已删） |
| D106 | [ATO出站区间限车](decisions/onboard.md) | 车载 |  |
| D107 | [车次窗口限制在本行并汇总溢出](decisions/ui-audio.md) | 界面 |  |
| D108 | [加开比较已有问题，继承实际库存并校验施工](decisions/rolling-stock.md) | 车底 |  |
| D109 | [随机故障改为全天预算](decisions/operations.md) | 调度 |  |
| D110 | [热备车不接已被接替车底的保留车次](decisions/rolling-stock.md) | 车底 |  |
| D111 | [连续跨运营日，不重开世界](decisions/platform.md) | 平台 |  |
| D112 | [车辆检修分工、档案和共用挑车](decisions/rolling-stock.md) | 车底 |  |
| D113 | [ARS 进路归属和短授权对标，随机跨日排查](decisions/track-signalling.md) | 信号 |  |
| D114 | [随机排查第一轮：制动档位、命令契约、真实等待和跨日来源](decisions/platform.md) | 平台 |  |
| D115 | [机场晚间车底运用方向与新实拍 DMI（用户决定，2026-10-22）](decisions/rolling-stock.md) | 车底 | 车底运用的方向（下面第一条）现行，由 D178、D184 的整体重写实现；当时的设计草案和独立原型 `src/sim/dutyPlan.ts` 已删（过程记录见 logs.md） |
| D116 | [10/21东段车尾录音补库、原段优先和本地试听清单](decisions/ui-audio.md) | 界面 |  |
| D117 | [关门开始与门锁闭分开发布，声音按关门开始触发](decisions/ui-audio.md) | 界面 |  |
| D118 | [按现有交路列报站、补唐镇终到，并逐份复核原录音](decisions/ui-audio.md) | 界面 |  |
| D119 | [10/22试玩：司机门控、退行、ATO启动、DMI队列与区间富余](decisions/onboard.md) | 车载 | 见状态行：`sectionEta` 名义加减速估计已由 D127 取代… |
| D120 | [试玩审查修正：统一走行余量、停站目标与起步条件](decisions/onboard.md) | 车载 || 停站目标与起步条件现行；runMargin 已由 D137/D173 固定区间富余替代 |
| D121 | [取消平台限速后重新标定慢运行等级](decisions/timetable.md) | 运行图 || 3/4 级标定现行；runMargin 已由 D137/D173 固定区间富余替代 |
| D122 | [夜间 60 km/h 假说与机场晚间备车试算（2026-10-22，只试算，未改生产代码）](decisions/timetable.md) | 运行图 | 结论是「不改」，保留 D121 的等级参数和当时的机场运用；晚间运行等级后来按录音重标（D163），机场晚间车底运用由 D178 重写（过程记录见 logs.md） |
| D123 | [北新泾上行 06:30 窗口少 3 列：接受](decisions/timetable.md) | 运行图 |  |
| D124 | [现场资料对照与录音入口：长区间预算调速受近扫限制](decisions/timetable.md) | 运行图 |  |
| D125 | [运行图依据改优先级：官方首末班 > 实地录音/PIS > 高德（只看车数）](decisions/timetable.md) | 运行图 |  |
| D126 | [门声重算、区间预算改用完整任务距离；严格验收未全通过](decisions/timetable.md) | 运行图 | 完整任务距离现行；ETA 见 D127，富余口径见 D137/D173 |
| D127 | [沿任务路径静态限速积分ETA，消除局部低限速外推](decisions/onboard.md) | 车载 |  |
| D128 | [10/22晚试玩：退行路径、模式切换、CM推荐速度及统一发车时钟](decisions/onboard.md) | 车载 |  |
| D129 | [现有录音覆盖审计、条件富余与现场文档归档](decisions/timetable.md) | 运行图 | 分析与资料整理；条件富余未采用 |
| D130 | [DMI 按 10/21 实拍校正布局；HOLD 与 CM 推荐速度显示](decisions/ui-audio.md) | 界面 |  |
| D131 | [车内关门使用选定提示音及机械声，完整保留6.25秒](decisions/ui-audio.md) | 界面 |  |
| D132 | [人工到站不动换向器；门使能按停车位置给出](decisions/onboard.md) | 车载 |  |
| D133 | [末班换乘不互相等候（用户决定）](decisions/timetable.md) | 运行图 |  |
| D134 | [【假设】盘点后的用户决定；已被替代的假设](decisions/platform.md) | 平台 |  |
| D135 | [改造后录音复测、ATO 区间阶段与统一富余重标（2026-10-23）](decisions/timetable.md) | 运行图 | ATO 区间阶段（牵引、连续保速、惰行、制动）的结构现行；富余比例 `runMargin = .176` 已由 D137 改成固定秒数，停车形状后来改为 D173 的软停车（过程记录见 logs.md） |
| D136 | [海天三路—机场60限速及高架预算调查（触发首末班停点）](decisions/timetable.md) | 运行图 || 60 km/h 限速现行；runMargin 已由 D137/D173 固定区间富余替代 |
| D137 | [固定区间富余秒数（用户决定，2026-10-23）](decisions/timetable.md) | 运行图 | 「固定秒数、全线一个值」现行（过程记录见 logs.md） |
| D138 | [早高峰停站和折返按 2 号线 DTO 论文对照（2026-10-23，10-24 定稿）](decisions/timetable.md) | 运行图 | 图定停站公式和 AM 司机作业的结构现行；AM 锁门后多 20 s 已改为约 5 s（D179，用户决定），后来的停站调整见 D163、D173（过程记录见 logs.md） |
| D139 | [两处首末班超差诊断：有限候选未通过，不应用（2026-10-24）](decisions/timetable.md) | 运行图 | 诊断，已由 D162 解决 |
| D140 | [线路组选线骨架与虚构测试线（2026-10-24）](decisions/platform.md) | 平台 |  |
| D141 | [基线九条红测与长测试排查（2026-10-24）](decisions/platform.md) | 平台 |  |
| D142 | [出入段与泊位统一仲裁（用户批准设计与五条规则 2026-10-24，10-26 收尾）](decisions/rolling-stock.md) | 车底 | 现行，实现在 `src/sim/resourceArbitration.ts`；后续改动见 D174、D182、D195（过程记录见 logs.md） |
| D143 | [第二部分晚间：安全候班与独立车底原型（2026-10-26，已审）](decisions/rolling-stock.md) | 车底 |  |
| D144 | [全天离线车底：共享路径、完整运用闭合与未通过的全图门禁（2026-10-26，第一版未收）](decisions/archive.md) | 已取代 | 已取代 → D178 |
| D145 | [三处出入段固定作业与川沙分线（2026-10-27，待复审）](decisions/rolling-stock.md) | 车底 |  |
| D146 | [反向站台进路与 TBTC：不放进去、原地重新注册（2026-10-28，用户决定）](decisions/track-signalling.md) | 信号 |  |
| D147 | [大晚点不清客空驶追图（2026-10-28，用户决定）](decisions/operations.md) | 调度 |  |
| D148 | [终点热备白天常驻、晚点 20 分钟换车、先到先发（2026-10-28，用户决定）](decisions/rolling-stock.md) | 车底 |  |
| D149 | [站后折返只用一条主用折返线（2026-10-28，用户决定）](decisions/rolling-stock.md) | 车底 |  |
| D150 | [车辆故障按轻重下线：轻故障就近回段站下线（2026-10-28，用户决定）](decisions/operations.md) | 调度 |  |
| D151 | [救援连挂与固定出入段作业测试（2026-10-28）](decisions/operations.md) | 调度 |  |
| D152 | [合并后 14 号线排图（2026-10-28）](decisions/timetable.md) | 运行图 |  |
| D153 | [不安全候班的车底接续（2026-10-28）](decisions/rolling-stock.md) | 车底 |  |
| D154 | [高峰回段车底归属与西端间隔（2026-10-28，待审）](decisions/archive.md) | 已取代 | 已取代 → D178/D184（旧排图已删） |
| D155 | [D139 首末班复核（2026-10-28，诊断完成）](decisions/timetable.md) | 运行图 |  |
| D156 | [先到先发包括终点存车车：大晚点后防止折返线被存车占满（2026-10-28，用户决定）](decisions/rolling-stock.md) | 车底 |  |
| D157 | [第二天存车位无车的表号按失去列车处理（2026-10-29）](decisions/rolling-stock.md) | 车底 |  |
| D158 | [合并后压测仍未通过的两例（2026-10-29，用户决定留待重做）](decisions/archive.md) | 已取代 | 已取代 → D170、D178 |
| D159 | [14 号线高德工作日到站表和车数对照（2026-10-29）](decisions/timetable.md) | 运行图 |  |
| D160 | [双休日高德到站表（2026-11-01，部分完成）](decisions/timetable.md) | 运行图 |  |
| D161 | [DMI 消息栏只留有依据的字样（2026-11-01）](decisions/ui-audio.md) | 界面 |  |
| D162 | [首末班车逐站按官方分钟定点（2026-11-01，用户决定）](decisions/timetable.md) | 运行图 |  |
| D163 | [工作日晚间运行等级和停站按录音标定（2026-11-01，用户决定）](decisions/timetable.md) | 运行图 |  |
| D165 | [浦东机场站后折返按视频标定（2026-11-02）](decisions/timetable.md) | 运行图 | 现行；近位/深位后由 D171 扩到蟠祥路、淞虹路 |
| D166 | [2 号线车底接续、载客出入段与跨日存车（2026-11-02）](decisions/rolling-stock.md) | 车底 | 跨日存车、创新中路中间线热备已被 D178 取代（正线不过夜、中途热备取消）；创新中路中间线后来改作出入段换端（D203）（过程记录见 logs.md） |
| D167 | [侧式站台画在正线外侧；华夏东路改侧式（2026-11-02）](decisions/ui-audio.md) | 界面 |  |
| D168 | [2 号线上下行名称更正（2026-11-02，用户决定）](decisions/ui-audio.md) | 界面 |  |
| D169 | [DMI 按 11-02 机场实拍改（2026-11-02，用户实拍）](decisions/ui-audio.md) | 界面 |  |
| D170 | [广兰路不存车及检修库占用（2026-11-02）](decisions/rolling-stock.md) | 车底 |  |
| D171 | [11-02区间、关门链、站后折返及公共参考钟（2026-11-02）](decisions/timetable.md) | 运行图 | 现行；默认余量 22.5→18.7 s（D173） |
| D172 | [救援恢复、分段清客及134/16601/16602旧链（2026-11-02）](decisions/operations.md) | 调度 |  |
| D173 | [接手收尾：低客流停站、收车格、救援、机场晚间供车、ATO 计坡度与软起停、按官方间隔重排运行图（2026-11-03～04）](decisions/timetable.md) | 运行图 | 现行（过程记录见 logs.md） |
| D174 | [性能第一批：结果逐位不变的优化（2026-11-04）](decisions/platform.md) | 平台 |  |
| D175 | [性能第二轮：晚点 10 s 估计一次及其他（2026-11-04）](decisions/platform.md) | 平台 |  |
| D176 | [人工驾驶越过折返股道停车点：就地换端（2026-11-05）](decisions/onboard.md) | 车载 |  |
| D177 | [无任务存车收车前自动回段（2026-11-05）](decisions/rolling-stock.md) | 车底 |  |
| D178 | [车底运用整体重写（排图部分）：终点车底池 + 车场配额（2026-11-05）](decisions/rolling-stock.md) | 车底 |  |
| D179 | [AM 司机锁门后作业改为约 5 s（2026-11-05）](decisions/onboard.md) | 车载 |  |
| D180 | [D178 后压测：夜间调拨撞上施工（2026-11-05）](decisions/rolling-stock.md) | 车底 |  |
| D181 | [进路只点亮经过的股道；机场、中山公园改真实剪刀叉（2026-11-05）](decisions/ui-audio.md) | 界面 |  |
| D182 | [出段车按图进入始发站台；严重晚出段按丢车处理（2026-11-06）](decisions/rolling-stock.md) | 车底 |  |
| D183 | [14号线共用接口与能力扩展（2026-10-24 写，原 D???，2026-11-06 整理时补编号）](decisions/platform.md) | 平台 |  |
| D184 | [车底运用整体重写（运行时和加开部分）：同一个终点车底池（2026-11-06）](decisions/rolling-stock.md) | 车底 |  |
| D185 | [压测查出的两处运行时问题：退出服务避开已批施工；互锁恢复时站台门跟车门（2026-11-06）](decisions/operations.md) | 调度 |  |
| D186 | [启动提速：进路始发让行只在真有入场车时才查接近锁闭；运行图在启动之间缓存（2026-11-06）](decisions/platform.md) | 平台 |  |
| D187 | [DMI 速度表下方状态行只留「紧急制动」（2026-11-07，用户决定）](decisions/ui-audio.md) | 界面 |  |
| D188 | [终到清客 60 s、广兰路换端 26 s；ATS 监控画面改 CASCO TACS 画法（2026-11-07，用户决定）](decisions/ui-audio.md) | 界面 |  |
| D189 | [用户 11-07 测试反馈：DMI 倒计时、TDT、TBTC 级别、总览行长、广兰路中间线站台门（2026-11-07）](decisions/ui-audio.md) | 界面 |  |
| D190 | [用户 11-08 测试反馈：淞虹路折返停站、C 级候班报警、TDT、信号常亮与白灯、对标误差、进路线闪烁、竖放对标特写（2026-11-08）](decisions/ui-audio.md) | 界面 | 末条「出入库方向、早高峰不回库、广兰路小交路折返（进行中）」已由 D191 做完，以 D191 为准；其余各项现行（TDT 起步 10 s … |
| D191 | [车底配平改走数据开关，线路尽头折返占用并成一套，出入段线上的空车就地回段，两处运行时修复（2026-11-12）](decisions/rolling-stock.md) | 车底 | 「川沙去机场方向先到广兰路折返」已由 D203 改为先到创新中路中间线换端；「已知遗留」里虹桥2号航站楼没有折返能力一条是站名记错，D192… |
| D192 | [审计复核：站台门转换表外的请求不再让软件崩，Sim 字段全部登记跨日归属，按当天编号的报警不带到第二天（2026-11-13）](decisions/platform.md) | 平台 | 「没修的红」`operating-day` 两条已由 D194 修好。 |
| D193 | [每步提速（结果逐位不变）：预热 04:00→18:00 约快 19%（2026-11-13）](decisions/platform.md) | 平台 | 「剩下的」资源仲裁提速已由 D195 做了一部分（逐位不变的缓存），增量仲裁仍未做。 |
| D194 | [东头车场缺车的日子，北翟路多出的车平峰载客调过去；共用出入段线的占用判据并成一处（2026-11-13）](decisions/rolling-stock.md) | 车底 |  |
| D195 | [资源仲裁提速，结果逐位不变（2026-11-13）](decisions/platform.md) | 平台 |  |
| D196 | [驻站热备改成一张独立运用；未开通站不拦空车；公布首班车从基地出（2026-11-14）](decisions/rolling-stock.md) | 车底 |  |
| D197 | [降级次序 FAM/DTO → ATO → ATPM 各线通用；快进时通话自动应答；Y 形线空车走向；站台门停车原因说真话（2026-11-15）](decisions/onboard.md) | 车载 |  |
| D198 | [「车载ATO功能故障」进随机故障池；人工驾驶入段点判定；模拟司机按剩余距离制动（2026-11-15）](decisions/onboard.md) | 车载 |  |
| D199 | [快进期间自动调度员接管（2026-11-15，用户决定）](decisions/operations.md) | 调度 |  |
| D200 | [司机按发车倒计时关门（线路数据 driverCloseRule）（2026-11-15，用户决定）](decisions/onboard.md) | 车载 | 字段已由 D220 换成 `closeFromS` / `typicalToS` / `lateProbability` / `overru… |
| D201 | [始发站台停站（OPERATIONS.originStandS）（2026-11-15，用户决定）](decisions/timetable.md) | 运行图 | 现行；文中「D173 晚移」已由 D226 和补车合成同一个循环。 |
| D202 | [用户 11-16 试驾反馈：人工车停站显示、站台门动作、退行停车窗、随机过标残留、进路线（2026-11-16）](decisions/onboard.md) | 车载 | 末条「069-4056 卡在龙阳路始发前，待修」已由 D203 修好。 |
| D203 | [创新中路中间线作出入段换端（2026-11-16，用户决定）](decisions/rolling-stock.md) | 车底 | 「未完成」的 `duty-balance` 库存偏移两例已由 D225 修好。 |
| D204 | [11号线界面去掉2号线/14号线专属说法（2026-11-16，用户要求「清理11号线中的2号线元素」）](decisions/ui-audio.md) | 界面 | 「没动：11 号线列车内部仍按 DTO 跑」已由 D205 改为司机驾驶 ATO。 |
| D205 | [11号线改为司机驾驶 ATO；出发授权、司机台 ATO 启动按钮；门键 Y 左 U 右；站台特写按编组（2026-11-16，用户决定）](decisions/onboard.md) | 车载 |  |
| D206 | [手柄支持：可扫描绑定、组合键（2026-11-17，用户决定）](decisions/onboard.md) | 车载 |  |
| D207 | [审计小项：worker 崩溃可见、去掉 DUTY_DEBUG 环境开关、scripts 进类型检查、simday 跨平台（2026-11-18，用户决定）](decisions/platform.md) | 平台 | 「没做」的两处 `throw`（`timetable.ts` 缺过夜泊位、无可用过夜出车任务）2026-11-22 核对仍在，未改成报警加降… |
| D208 | [11号线首末班核对：末班不被截短、补南翔 05:45 始发（2026-11-18，用户要求核对 11/14 号线）](decisions/timetable.md) | 运行图 | 「没解决」各项后来都处理了：14 号线工作日 5 个问题由 D210 解决；花桥支线往迪士尼末班、花桥和安亭首班、往安亭末班由 D214 按… |
| D209 | [终点停站检查只限站台停靠（2026-11-18，用户决定：等进路应在折返线上）](decisions/timetable.md) | 运行图 | 文中「14 号线工作日 5 个问题仍在」已由 D210 解决。 |
| D210 | [14号线工作日排图：中间站自带折返线上等发车（2026-11-18，用户指出：等进路应在折返线上）](decisions/timetable.md) | 运行图 |  |
| D211 | [11号线区间对照结果（2026-11-18，只记录，未修）](decisions/timetable.md) | 运行图 | 记录的 11 号线区间对不上，已由 D213（交路重做）、D215（罗山路出库交路）、D216（高峰以高德为准）、D218（支线分配）处理，… |
| D212 | [11号线工作日：早高峰退峰与午后升峰用渐变发车（2026-11-18；时段已被 D213 取代）](decisions/timetable.md) | 运行图 |  |
| D213 | [11号线工作日交路重做：小交路改到罗山路，加夜间嘉定北—三林东（2026-11-18）](decisions/timetable.md) | 运行图 | 「没解决」各项：（1）秀沿路班数由 D215 解决；（3）官方间隔与高德哪个为准由 D216 定为高峰以高德为准，D218 起测试通过；（4… |
| D214 | [首末班按官方表逐趟对齐：具名交路停在官方末班后、往安亭末班、安亭首班、罗山路往花桥首班（2026-11-18）](decisions/timetable.md) | 运行图 |  |
| D215 | [罗山路出库往迪士尼的营业交路（2026-11-18）](decisions/timetable.md) | 运行图 | 被 D234 取代 |
| D216 | [11号线高峰班数以高德为准：官方间隔测试只留非高德部分（2026-11-18）](decisions/timetable.md) | 运行图 | 被 D234 取代 |
| D217 | [随机冲标概率降为每次进站十万分之二（2026-11-19）](decisions/onboard.md) | 车载 |  |
| D218 | [11 号线早高峰、晚高峰支线分配，上行首班补车，周末夜间放疏（2026-11-19）](decisions/timetable.md) | 运行图 |  |
| D219 | [玩家接管 AM（人工 ATO 驾驶）时车门不再自动关（2026-11-19）](decisions/onboard.md) | 车载 |  |
| D220 | [11 号线停站时序、牵引制动按实测改，补时重拟合（2026-11-21）](decisions/timetable.md) | 运行图 |  |
| D221 | [11 号线早高峰结束前不回库（2026-11-21）](decisions/rolling-stock.md) | 车底 |  |
| D222 | [11 号线日间调车并入载客车次、备车不回库（2026-11-22）](decisions/rolling-stock.md) | 车底 | 用户决定和备车做法现行。调车并入的实现已由 D226 改成排班器里一遍完成，「重排一次，工作日排图约 23→42 s」不再成立（D226 后… |
| D223 | [11 号线浦三路、安亭中间存车线开调车换端进线（2026-11-22）](decisions/track-signalling.md) | 信号 | 「未解」的 `local-shunt` 三项红已由 D224 修好。 |
| D224 | [中间线存车不再被误认为已在换端位（2026-11-22）](decisions/rolling-stock.md) | 车底 | 「未解」的 `duty-balance` 库存偏移两例已由 D225 修好。 |
| D225 | [回段配车按总代价最小分配（2026-11-22）](decisions/rolling-stock.md) | 车底 |  |
| D226 | [调车并入载客车次在排班器里一遍完成（2026-11-22）](decisions/rolling-stock.md) | 车底 |  |
| D227 | [里程位置的方向判断统一走 `chainAhead`；规则检查脚本（2026-11-23）](decisions/platform.md) | 平台 |  |
| D228 | [区域视图可以多接一个下一区的车站：ZC1 接上嘉定新城（2026-11-23）](decisions/ui-audio.md) | 界面 | |
| D229 | [折返咽喉：按图先发的出线车先走，进线车后排（2026-11-24）](decisions/platform.md) | 平台 |  |
| D230 | [人工折返不进到达时仍有车停着的折返股道（2026-11-24）](decisions/operations.md) | 运营 |  |
| D231 | [终点早到的车不占最后一条空折返线候班，改开下一班（2026-11-24）](decisions/operations.md) | 运营 | 用户决定 |
| D232 | [同方向换车次（罗山路）只停一次站（2026-11-24）](decisions/timetable.md) | 运行图 |  |
| D233 | [车场间定时调车（depotTransfers）：11 号线工作日下午城北路→川杨河四趟空车（2026-11-27）](decisions/timetable.md) | 运行图 | 用户现场所见；去向【假设】 |
| D234 | [11号线以官方间隔为准：取消 D215、D216，早高峰恢复三林小交路，晚高峰川杨河单向出库（2026-11-27）](decisions/timetable.md) | 运行图 | 用户决定；备车到 15:30、上行升峰钟点、晚高峰出库结构按高德和排图（用户 11-28 认可） |
| D235 | [停站列车紧急制动时，停车原因按制动原因分（2026-11-27）](decisions/onboard.md) | 车载 |  |
| D236 | [排图提速：车底运用的时隙扫描少做白工，结果逐位不变（2026-11-28）](decisions/timetable.md) | 运行图 |  |
| D237 | [地面信号机：2 号线正线对 CBTC 车灭灯，11/14 号线常亮且不因前车占用亮红（2026-11-28，用户决定）](decisions/track-signalling.md) | 信号 | 用户决定；两用信号机平时灭灯为【假设】 |
| D238 | [站台换端出段只算换端；按图先发看得见还没出闸的出段车（2026-11-28）](decisions/rolling-stock.md) | 车底 | 罗山路 2 min 一对的始发由城北路空车补；嘉定北尾轨重叠见 D239 |
| D239 | [线路终点按拓扑认，支线终点也算；长候班不超过能长候班的尾轨数（2026-11-28）](decisions/timetable.md) | 运行图 |  |
