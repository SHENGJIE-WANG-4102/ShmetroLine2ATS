import type { SimulationData, ServiceData } from '../../simulation';
import type { Period, Template } from '../../../sim/timetable';
import { LINE11_PHYSICS, LINE11_ENERGY } from './physics';
import { LINE14_SIMULATION } from '../line14/simulation';

const H = (h: number, m = 0) => h * 3600 + m * 60;

/** 分时段开行花样。交路见 docs/design-decisions.md D213（用户 2026-11-18）：
 * - 平峰/双休日：嘉定北、花桥两条支线全程车，主干每 6/5 分钟一班，两条支线各 12/10 分钟；
 * - 工作日高峰：再加南翔—罗山路、花桥—罗山路两种小交路；参考站（南翔）早 2 分 30 秒、晚 3 分钟；
 * - 夜间（21:30 起）：每 6 班里一班嘉定北车只到三林东，进浦三路中间线过夜。
 * 小交路写进 pattern，按 terminals.routes 的名字生成；排图主体的 core 取南翔—罗山路。 */
const templates: Record<string, Template> = {
  opening: { id: 'opening', name: '早间过渡', desc: '嘉定北/花桥两条支线往迪士尼，逐渐接近高峰【假设】', pattern: ['big', 'branch'], headway: 600 },
  morning: { id: 'morning', name: '工作日早高峰', desc: '嘉定北/花桥全程 + 南翔—罗山路小交路 + 花桥—罗山路（罗山路再出库一趟往迪士尼），嘉定北与花桥各约 9 班/小时，参考站约2分30秒', pattern: ['big','branch','big','shortNX','relayHQ','branch','big','shortNX'], headway: 150, peak: true },
  offpeak: { id: 'offpeak', name: '工作日平峰', desc: '嘉定北/花桥全程，主干约6分钟、支线约12分钟', pattern: ['big', 'branch'], headway: 360 },
  evening: { id: 'evening', name: '工作日晚高峰', desc: '嘉定北/花桥全程 + 南翔/花桥—罗山路（两趟都在罗山路再出库一趟往迪士尼），参考站约3分钟', pattern: ['branch','big','relayNX','branch','big','relayHQ','big','relayHQ','branch','big','relayHQ','big'], headway: 180, peak: true },
  weekend: { id: 'weekend', name: '双休日日间', desc: '嘉定北/花桥全程，主干约5分钟、支线约10分钟', pattern: ['big', 'branch'], headway: 300, peak: true },
  closing: { id: 'closing', name: '夜间过渡', desc: '全程车，至末班逐渐放疏【假设】', pattern: ['big', 'branch'], headway: 600 },
  late: { id: 'late', name: '末班前', desc: '全程车；每三班嘉定北车有一班只到三林东，进浦三路中间线过夜（夜间特殊交路）【假设】', pattern: ['big', 'branch', 'night', 'branch', 'big', 'branch'], headway: 600 },
};
const dayPeriods: Record<'weekday' | 'weekend', Period[]> = {
  weekday: [
    // 早间过渡保持 10 分钟一班，让花桥第二班正好落在官方首班 05:37（不是 05:33）。
    { from: H(4), to: H(7), template: 'opening', label: '早间过渡', headway: 600 },
    { from: H(7), to: H(9, 45), template: 'morning', label: '早高峰' },
    // 高德（2026-11-18）到站表：东方体育中心 10:27 前仍约 2～3 分钟一班，10:33 起 6 分钟；南翔到东方体育中心约 43 分钟，
    // 折回南翔是 09:44 起退峰、09:50 已是 6 分。官方是区段平均值，故退峰、升峰用渐变，不用一档。
    { from: H(9, 45), to: H(9, 55), template: 'offpeak', label: '早高峰退峰', headway: 200, headwayTo: 360 },
    { from: H(9, 55), to: H(14, 10), template: 'offpeak', label: '平峰' },
    { from: H(14, 10), to: H(15, 30), template: 'offpeak', label: '晚高峰前升峰', headway: 360, headwayTo: 200 },
    { from: H(15, 30), to: H(19, 15), template: 'evening', label: '晚高峰' },
    // 晚间 21:33 起东方体育中心约 3 分、22:00 后约 4～5 分一班（折算到南翔提前 43 分）。
    { from: H(19, 15), to: H(20, 45), template: 'closing', label: '夜间过渡', headway: 190, headwayTo: 230 },
    { from: H(20, 45), to: H(21, 30), template: 'closing', label: '夜间过渡', headway: 230, headwayTo: 255 },
    { from: H(21, 30), to: H(24), template: 'late', label: '末班前', headway: 255, headwayTo: 300 },
  ],
  weekend: [
    { from: H(4), to: H(7), template: 'opening', label: '早间过渡', headway: 650 },
    { from: H(7), to: H(21), template: 'weekend', label: '日间' },
    { from: H(20, 45), to: H(24), template: 'closing', label: '夜间过渡', headway: 330, headwayTo: 360 },
  ],
};
/** 高峰波的起点按参考站（南翔下行、罗山路上行）起算【假设】。小交路到罗山路，单程约 1 小时，
 * 默认的“核心区提前一整程”会把波排到首班车上（05:47 嘉定新城两车只隔 10 s），所以直接给起点：
 * 早高峰 06:45/07:00，晚高峰 15:30；小交路的车头一进核心区就有车接，排图 0 问题、班数贴近高德。 */
const weekdayPeaks: ServiceData['peaks'] = {
  morning: { DN: H(6, 45), UP: H(7, 0) },
  evening: { DN: H(15, 30), UP: H(15, 30) },
};
const service = (): ServiceData => ({
  peaks: {}, overrides: [], openingSupplements: [], lateHeadway: 600, standby: [],
});

/** 首班车起点。官方表里能读出“从这里另起一趟”的车站（同一方向首班比上一站早，
 * 说明不是同一列车）：花桥 05:37、安亭 05:35、南翔 05:45 往迪士尼（嘉定新城 05:45 是嘉定北 05:36 那趟路过的，
 * 不是始发，2026-11-18 用户决定），罗山路 05:20/05:25 往花桥/嘉定北。花桥 05:37 由早间过渡的
 * 第二班产生（不是另加一趟）；这里只补罗山路 05:20 往嘉定北这一趟。
 * 其余起点在车场出车/中途折返上没有来源，或两趟只差 5 分钟会追尾，逐条写在
 * 汇报【待定】。官方表里还有“往安亭”末班，现字段表达不了；4 趟巡道车见下面 patrols。 */
const firstOrigins: SimulationData['timetable']['firstOrigins'] = [
  { dir: 'UP', from: 'LSH', to: 'JDB', dep: H(5, 20) },  // 罗山路首班往嘉定北
  // 【假设】官方表南翔 05:45 往迪士尼早于上一站陈翔公路 05:53，是另起的始发；来源按车场出车排
  { dir: 'DN', from: 'NX', to: 'DSL', dep: H(5, 45) },
  // 官方：往花桥首班也从罗山路起，05:25（往嘉定北 05:20 之后）
  { dir: 'UP', from: 'LSH', to: 'HQ', dep: H(5, 25) },
  // 官方：安亭 05:35 往迪士尼是始发，车是前一晚往安亭末班（迪士尼 22:25 发、00:01 到）停在安亭中间存车线的那列
  { dir: 'DN', from: 'AT', to: 'DSL', dep: H(5, 35) },
  // 高德桃浦新村/嘉定北上行 06:17 起约 8 分一班（只取班数）：罗山路 05:30–05:55 往两条支线各补三趟，约 10 分一班【假设】
  { dir: 'UP', from: 'LSH', to: 'JDB', dep: H(5, 30) },
  { dir: 'UP', from: 'LSH', to: 'HQ', dep: H(5, 35) },
  { dir: 'UP', from: 'LSH', to: 'JDB', dep: H(5, 40) },
  { dir: 'UP', from: 'LSH', to: 'HQ', dep: H(5, 45) },
  { dir: 'UP', from: 'LSH', to: 'JDB', dep: H(5, 50) },
  { dir: 'UP', from: 'LSH', to: 'HQ', dep: H(5, 55) },
];

/** 用户决定（2026-11-14，L11-04）：首班前 4 趟巡道车，跑完在终点等，接那里的第一趟发车。
 * 花桥支线两趟从赛车场车辆段出：一趟到花桥折返线等，一趟到嘉定新城站台等（出车车场
 * 【假设】）；主线：嘉定北→迪士尼到折返线等，罗山路→迪士尼→嘉定北到折返线等。 */
const patrols: SimulationData['timetable']['patrols'] = [
  { depot: 'SSC', via: ['SSC', 'HQ'] },
  { depot: 'SSC', via: ['SSC', 'NX'] }, // 用户决定（2026-11-18）：原到嘉定新城等车的巡道车改到南翔，接南翔 05:45
  { depot: 'CBL', via: ['JDB', 'DSL'] },
  { depot: 'CYL', via: ['LSH', 'DSL', 'JDB'] },
];

export const LINE11_SIMULATION: SimulationData = {
  physics: LINE11_PHYSICS, energy: LINE11_ENERGY,
  calibration: {
    ...LINE14_SIMULATION.calibration,
    dwellModel: 'station', // 图定停站按本线站表；官方只到分钟，逻辑为主
    ridershipTarget: { weekday: 900000, weekend: 700000 }, // 【假设】无11号线逐日客流实测
    peakSection: { day: 'weekday', from: 'NX', to: 'SL', hours: [[7, 9], [18, 19]] },
    profiles: {
      weekday: [[4, 0], [5.25, .12], [6, .4], [7, 1.8], [8, 3], [9.5, .75], [12, .6], [16, .7], [17.5, 2.2], [19, 1.2], [20, .6], [22, .25], [23.75, 0]],
      weekend: [[4, 0], [5.25, .08], [7, .4], [10, 1.1], [14, 1.3], [18, 1], [21, .5], [23.75, 0]],
    },
    tides: {
      weekday: { stationWeights: [], amplitude: 0, morning: 8, evening: 18, width: 2 },
      weekend: { stationWeights: [], amplitude: 0, morning: 8, evening: 18, width: 2 },
    },
    // 用户决定（2026-11-15，L11-03）：TDT 最短 20 s，开门到位起算。D220：最短图定停站 = 停稳到门开好约 4.4 s
    // + TDT 20 s + 倒计时归零到平均起动（COUNTDOWN_LEAD_S，约 14.7 s）≈ 39 s。
    minDwell: 39,
    // 用户决定（2026-11-21，D220）：TDT 开门到位起算，剩 12 s 起可关门，最晚归零后 10 s（显示 --）；关门约 6 s，
    // 关门完成后 5 s 站台端门内发车指示灯亮绿灯，绿灯后 6–15 s 起步。关门时刻多数在剩 12–5 s，
    // 20% 的概率更晚（密度线性减小到归零后 10 s）【假设：概率】；曹杨路和其他站同一规则。
    driverCloseRule: { closeFromS: 12, typicalToS: 5, lateProbability: .2, overrunMaxS: 10, lampDelayS: 5, startAfterLampS: [6, 15] },
  },
  gradient: { ...LINE14_SIMULATION.gradient, depths: {}, river: null }, // 【假设】缺11号线纵断面，按平坦隧道处理
  holiday: { calendar: [], returnRuns: [], closure: null, surges: [] },
  pis: {
    timing: LINE14_SIMULATION.pis.timing,
    defaults: { DN: 'DSL', UP: 'HQ' },
    destinations: [
      { station: 'DSL', first: 'firstE', last: 'lastE', alternatives: [] },
      { station: 'JDB', first: 'firstW', last: 'lastW', alternatives: [{ station: 'HQ' }] },
      { station: 'HQ', first: 'firstW', last: 'lastW', alternatives: [] },
    ],
    welcome: '欢迎乘坐上海轨道交通11号线',
    weatherNotice: '受设备或线路条件影响，列车限速运行',
  },
  topology: { wrapAfter: 'SL' },
  instructor: { previousIds: {}, events: [], scenarios: [] },
  timetable: {
    carryMainlineMoves: true, positioningRevenue: { from: H(7), to: H(21) }, preserveRevenueRoutes: true, truncateHome: { from: H(7), to: H(19) },
    templates,
    dayPeriods, shownPeriods: dayPeriods,
    dwellBands: { weekday: [{ from: 0, to: Infinity, value: 1 }], weekend: [{ from: 0, to: Infinity, value: 1 }] },
    runBands: { weekday: [{ from: 0, to: Infinity, value: 1 }], weekend: [{ from: 0, to: Infinity, value: 1 }] },
    serviceData: { weekday: { ...service(), peaks: weekdayPeaks }, weekend: service() },
    // 【假设】车库整备/出车窗口，不代表新增营业首班。
    opening: { outerAlternation: 0, stockUntil: H(12), redirectFrom: H(5), emptyFeedersFrom: H(20), feederUntil: H(26), stableUntil: H(10), dayStart: H(4), defaultStableDeparture: H(6) },
    outerBandMargin: 0,
    overlays: [],
    terminals: {
      // L11-10：大交路两端写嘉定北、迪士尼；两条支线和小交路用 routes 命名。
      trunk: ['JDB', 'DSL'],
      routes: {
        branch: ['HQ', 'DSL'],       // 花桥—迪士尼（白天到花桥）
        shortNX: ['NX', 'LSH'],      // 南翔—罗山路小交路（主线短交路）
        shortHQ: ['HQ', 'LSH'],      // 花桥—罗山路小交路（支线短交路）
        relayNX: ['NX', 'LSH'],      // 南翔—罗山路：在罗山路折返的同一槽里，罗山路出库一趟往迪士尼（relays）
        relayHQ: ['HQ', 'LSH'],      // 花桥—罗山路，同上（早晚高峰都用）
        night: ['JDB', 'SLD'],       // 嘉定北—三林东夜间特殊交路，到后进浦三路中间线过夜
      },
      // 罗山路出库往迪士尼的营业交路（D215）：这两条小交路在罗山路折返的同一槽里，罗山路再出库一趟往迪士尼
      relays: { relayNX: 'DSL', relayHQ: 'DSL' },
      // 排图主体仍只认一种小交路 core，取南翔—罗山路（与 shortNX 同一条）。
      core: ['NX', 'LSH'],
      circulate: ['JDB', 'HQ', 'NX', 'SL', 'LSH', 'DSL'],
      depot: { JDB: 'CBL', HQ: 'SSC', NX: 'CBL', SL: 'CYL', LSH: 'CYL', DSL: 'CYL' },
      // 花桥/嘉定北/迪士尼各两条尾轨，三林中间折返线，罗山路两条尾轨。
      capacity: { JDB: 3, HQ: 3, NX: 2, SL: 2, LSH: 3, DSL: 3 },
      maxPresent: { JDB: 3, HQ: 3, NX: 2, SL: 2, LSH: 3, DSL: 3 },
    },
    firstOrigins, patrols,
    lastRuns: [{ dir: 'UP', from: 'DSL', to: 'AT', dep: H(22, 25) }, { dir: 'DN', from: 'HQ', to: 'DSL', dep: H(22, 0) }],
    // 官方末班往迪士尼一列，嘉定新城之后的分钟是花桥 22:00 那趟的（赛车场 22:19 → 嘉定新城 22:23，4 分钟）；嘉定北 22:10 那趟比它早一站间隔
    columnOwners: [{ column: 'lastE', station: 'JDC', from: 'HQ' }],
    openingGuards: [], closingDepotMoves: [],
  },
};
