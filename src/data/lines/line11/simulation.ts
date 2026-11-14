import type { SimulationData, ServiceData } from '../../simulation';
import type { Period, Template } from '../../../sim/timetable';
import { LINE11_PHYSICS, LINE11_ENERGY } from './physics';
import { LINE14_SIMULATION } from '../line14/simulation';

const H = (h: number, m = 0) => h * 3600 + m * 60;

/** 分时段开行花样。按 reference/line11/official-timetable.md 的逻辑比例取整：
 * - 平峰/双休日：主干每 6/5 分钟一班，两条支线各 12/10 分钟；
 * - 工作日高峰：嘉定北、花桥两条支线都跑迪士尼，南翔始发的小交路到三林、罗山路折返；
 *   参考站（曹杨路）间隔 2.5 分钟，对应官方南翔—三林 2 分钟、罗山路—迪士尼 6 分钟、
 *   支线 5～10 分钟的近似值。
 * 小交路只写进 pattern；排图主体仍只认 terminals.core 一种小交路（L11-10 未做部分），
 * shortLSH 是额外的命名交路，走 namedRoute 生成。 */
const templates: Record<string, Template> = {
  opening: { id: 'opening', name: '早间过渡', desc: '嘉定北/花桥两条支线往迪士尼，逐渐接近高峰【假设】', pattern: ['big', 'branch'], headway: 600 },
  morning: { id: 'morning', name: '工作日早高峰', desc: '嘉定北/花桥全程 + 南翔—三林小交路，参考站约2分30秒', pattern: ['big', 'branch', 'shortSL'], headway: 150, peak: true },
  offpeak: { id: 'offpeak', name: '工作日平峰', desc: '嘉定北/花桥全程，主干约6分钟、支线约12分钟', pattern: ['big', 'branch'], headway: 360 },
  evening: { id: 'evening', name: '工作日晚高峰', desc: '嘉定北/花桥全程 + 南翔—罗山路小交路，参考站约2分30秒', pattern: ['big', 'branch', 'shortLSH'], headway: 180, peak: true },
  weekend: { id: 'weekend', name: '双休日日间', desc: '嘉定北/花桥全程，主干约5分钟、支线约10分钟', pattern: ['big', 'branch'], headway: 300, peak: true },
  closing: { id: 'closing', name: '夜间过渡', desc: '全程车，至末班逐渐放疏【假设】', pattern: ['big', 'branch'], headway: 600 },
};
const dayPeriods: Record<'weekday' | 'weekend', Period[]> = {
  weekday: [
    // 早间过渡保持 10 分钟一班，让花桥第二班正好落在官方首班 05:37（不是 05:33）。
    { from: H(4), to: H(7), template: 'opening', label: '早间过渡', headway: 600 },
    { from: H(7), to: H(9, 30), template: 'morning', label: '早高峰' },
    { from: H(9, 30), to: H(17, 30), template: 'offpeak', label: '平峰' },
    { from: H(17, 30), to: H(19, 30), template: 'evening', label: '晚高峰' },
    { from: H(19, 30), to: H(24), template: 'closing', label: '夜间过渡', headway: 480, headwayTo: 720 },
  ],
  weekend: [
    { from: H(4), to: H(7), template: 'opening', label: '早间过渡', headway: 650 },
    { from: H(7), to: H(21), template: 'weekend', label: '日间' },
    { from: H(21), to: H(24), template: 'closing', label: '夜间过渡', headway: 480, headwayTo: 720 },
  ],
};
const service = (): ServiceData => ({
  peaks: {}, overrides: [], openingSupplements: [], lateHeadway: 600, standby: [],
});

/** 首班车起点。官方表里能读出“从这里另起一趟”的车站（同一方向首班比上一站早，
 * 说明不是同一列车）：花桥 05:37、安亭 05:35、嘉定新城 05:45、南翔 05:45 往迪士尼，
 * 嘉定新城 06:36、罗山路 05:20/05:25 往花桥/嘉定北。花桥 05:37 由早间过渡的
 * 第二班产生（不是另加一趟）；这里只补罗山路 05:20 往嘉定北这一趟。
 * 其余起点在车场出车/中途折返上没有来源，或两趟只差 5 分钟会追尾，逐条写在
 * 汇报【待定】。官方表里还有“往安亭”末班和 4 趟巡道车，现字段也表达不了。 */
const firstOrigins: SimulationData['timetable']['firstOrigins'] = [
  { dir: 'UP', from: 'LSH', to: 'JDB', dep: H(5, 20) },  // 罗山路首班往嘉定北
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
    minDwell: 20,
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
    carryMainlineMoves: true, positioningRevenue: false, preserveRevenueRoutes: true,
    templates,
    dayPeriods, shownPeriods: dayPeriods,
    dwellBands: { weekday: [{ from: 0, to: Infinity, value: 1 }], weekend: [{ from: 0, to: Infinity, value: 1 }] },
    runBands: { weekday: [{ from: 0, to: Infinity, value: 1 }], weekend: [{ from: 0, to: Infinity, value: 1 }] },
    serviceData: { weekday: service(), weekend: service() },
    // 【假设】车库整备/出车窗口，不代表新增营业首班。
    opening: { outerAlternation: 0, stockUntil: H(12), redirectFrom: H(5), emptyFeedersFrom: H(20), feederUntil: H(26), stableUntil: H(10), dayStart: H(4), defaultStableDeparture: H(6) },
    outerBandMargin: 0,
    overlays: [],
    terminals: {
      // L11-10：大交路两端写嘉定北、迪士尼；两条支线和小交路用 routes 命名。
      trunk: ['JDB', 'DSL'],
      routes: {
        branch: ['HQ', 'DSL'],       // 花桥—迪士尼（白天到花桥）
        shortSL: ['NX', 'SL'],       // 南翔—三林小交路
        shortLSH: ['NX', 'LSH'],     // 南翔—罗山路小交路
      },
      // 排图主体仍只认一种小交路：选南翔—三林（L11-10 未做部分）。
      core: ['NX', 'SL'],
      circulate: ['JDB', 'HQ', 'NX', 'SL', 'LSH', 'DSL'],
      depot: { JDB: 'CBL', HQ: 'SSC', NX: 'CBL', SL: 'CYL', LSH: 'CYL', DSL: 'CYL' },
      // 花桥/嘉定北/迪士尼各两条尾轨，三林中间折返线，罗山路两条尾轨。
      capacity: { JDB: 3, HQ: 3, NX: 2, SL: 2, LSH: 3, DSL: 3 },
      maxPresent: { JDB: 3, HQ: 3, NX: 2, SL: 2, LSH: 3, DSL: 3 },
    },
    firstOrigins,
    openingGuards: [], closingDepotMoves: [],
  },
};
