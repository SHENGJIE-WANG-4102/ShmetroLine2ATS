import type { SimulationData, ServiceData } from '../../simulation';
import type { Period, Template } from '../../../sim/timetable';
import { LINE14_PHYSICS, LINE14_ENERGY } from './physics';
import { HEADWAYS } from './line14';
const H = (h: number, m = 0) => h * 3600 + m * 60;

/** 官方时段及1:1交路见 reference/line14/line14-official-timetable.md。
 * 各方向高峰间隔只定义于此；往封浜早峰200秒【待实测】。 */
export const PEAK_HEADWAYS = { morning: { DN: HEADWAYS.morning.DN / 2, UP: HEADWAYS.morning.UP / 2 }, evening: { DN: HEADWAYS.evening / 2, UP: HEADWAYS.evening / 2 } };
const templates: Record<string, Template> = {
  opening: { id: 'opening', name: '早间过渡', desc: '全程车，逐渐接近高峰【假设】', pattern: ['big'], headway: 600 },
  morning: { id: 'morning', name: '工作日早高峰', desc: '全程/真新新村—蓝天路1:1；中段下行3分、上行3分20秒', pattern: ['big','small'], headway: PEAK_HEADWAYS.morning.DN, directionalHeadway: PEAK_HEADWAYS.morning, peak: true },
  offpeak: { id: 'offpeak', name: '工作日平峰', desc: '全程8分30秒，官方表及歇浦路实拍', pattern: ['big'], headway: HEADWAYS.offPeak },
  evening: { id: 'evening', name: '工作日晚高峰', desc: '全程/小交路1:1；中段4分、外段8分', pattern: ['big','small'], headway: PEAK_HEADWAYS.evening.DN, directionalHeadway: PEAK_HEADWAYS.evening, peak: true },
  weekend: { id: 'weekend', name: '双休日日间', desc: '全程7分，无小交路', pattern: ['big'], headway: HEADWAYS.weekend },
  closing: { id: 'closing', name: '夜间过渡', desc: '全程车，至末班逐渐放疏【假设】', pattern: ['big'], headway: 600 },
};
const dayPeriods: Record<'weekday'|'weekend', Period[]> = {
  weekday: [
    { from: H(4), to: H(7), template: 'opening', label: '早间过渡', headway: 660, headwayTo: 360 },
    { from: H(7), to: H(9,30), template: 'morning', label: '早高峰' },
    { from: H(9,30), to: H(16,40), template: 'offpeak', label: '平峰' },
    { from: H(16,40), to: H(20), template: 'evening', label: '晚高峰' },
    { from: H(20), to: H(24), template: 'closing', label: '夜间过渡', headway: 480, headwayTo: 720 },
  ],
  weekend: [
    { from: H(4), to: H(7), template: 'opening', label: '早间过渡', headway: 660, headwayTo: 420 },
    { from: H(7), to: H(21), template: 'weekend', label: '日间' },
    { from: H(21), to: H(24), template: 'closing', label: '夜间过渡', headway: 480, headwayTo: 720 },
  ],
};
const service = (): ServiceData => ({ peaks: { morning: { DN: H(7), UP: H(7) }, evening: { DN: H(16,40), UP: H(16,40) } }, overrides: [], openingSupplements: [], lateHeadway: 600, standby: [{ from: H(9,45), need: H(22), to: H(22) }] });
/** 无逐站客流实测。客流曲线与35万/25万日目标均为【假设】，按通勤与休闲两种需求形状独立给出。 */
export const LINE14_SIMULATION: SimulationData = {
  physics: LINE14_PHYSICS, energy: LINE14_ENERGY,
  calibration: {
    dwellModel: 'station', // 【假设】图定停站按本线站表，5秒粒度，官方首末班联合约束
    ridershipTarget: { weekday: 350000, weekend: 250000 },
    peakSection: { day: 'weekday', from: 'ZXX', to: 'LTN', hours: [[7,9.5],[16+40/60,20]] },
    profiles: {
      weekday: [[4,0],[5.25,.1],[6,.35],[7,1.8],[8,3],[9.5,.7],[12,.6],[16,.7],[17.5,2.4],[19,1.3],[20,.6],[22,.2],[23.75,0]],
      weekend: [[4,0],[5.25,.08],[7,.4],[10,1.1],[14,1.2],[18,1],[21,.5],[23.75,0]],
    },
    tides: { weekday: { stationWeights: [], amplitude: 0, morning: 8, evening: 18, width: 2 }, weekend: { stationWeights: [], amplitude: 0, morning: 8, evening: 18, width: 2 } },
    // 【假设】自动门物理作业预算；图定停站量使用本线站表，不继承其他线路客流停站拟合。
    plannedDoorBudget: 12, plannedCloseBudget: 8, minDwell: 20,
    maxEarlyHold: 10, maxDwellBusy: 70, maxDwell: 60, doorsPerSide: 40, exchangePerDoor: 2.2,
  },
  // 全地下；无坡度资料，暂不模拟越江深槽，绝不继承其他线路地形。
  gradient: { depths: {}, stationDepth: 14, elevated: 12, ground: 1, flat: 115, ramp: .024, valley: .003, maxDip: 9, river: null },
  holiday: {
    calendar: [
      { from: '2026-05-01', to: '2026-05-05', name: '劳动节', days: 5, dayOffset: 1 },
      { from: '2026-09-30', to: '2026-09-30', name: '国庆', days: 7, dayOffset: 0 },
      { from: '2026-10-01', to: '2026-10-07', name: '国庆', days: 7, dayOffset: 1 },
    ],
    returnRuns: [],
    closure: { station: 'YY', eve: H(20), day: H(16), notice: '豫园站客流管控：{time} 起至运营结束封站，列车跳停通过', activeNotice: '豫园站封站：上、下行站台计划跳停' },
    surges: [],
  },
  pis: {
    timing: { pageMs: 8000, scrollingPageMs: 15000, footerMs: 3000, slideMs: 350, footerSlideMs: 300, englishWidthsPerSecond: .15 },
    defaults: { DN: 'GQL', UP: 'FB' },
    destinations: [
      { station: 'GQL', first: 'firstE', last: 'lastE', alternatives: [] },
      { station: 'FB', first: 'firstW', last: 'lastW', alternatives: [] },
      { station: 'LTN', first: 'firstE', last: 'lastE', alternatives: [] },
      { station: 'ZXX', first: 'firstW', last: 'lastW', alternatives: [] },
    ],
    welcome: '欢迎乘坐上海轨道交通14号线', weatherNotice: '受设备或线路条件影响，列车限速运行',
  },
  topology: { wrapAfter: 'YY' }, instructor: { previousIds: {}, events: [], scenarios: [] },
  timetable: {
    reference: { DN: 'DSJ', UP: 'DSJ' }, positioningRevenue: false, preserveRevenueRoutes: true,
    templates, dayPeriods, shownPeriods: dayPeriods,
    dwellBands: { weekday: [{ from: 0, to: Infinity, value: 1 }], weekend: [{ from: 0, to: Infinity, value: 1 }] },
    runBands: { weekday: [{ from: 0, to: Infinity, value: 1 }], weekend: [{ from: 0, to: Infinity, value: 1 }] },
    serviceData: { weekday: service(), weekend: {
      ...service(),
      // 用户决定2026-10-25：双休日日间7分钟网格锚定实拍，工作日不动。
      // 真如DN19:06:31到站+1058s预算→大世界19:24:09发车；
      // 浦东大道UP19:33:58到站+577.9s预算→大世界19:43:35.9发车。
      // 按420s取同相位的首个7点后参考时刻；早间由通用join并入。
      // 换算及六观测复核：work/line14-r4/derive-grid.ts。
      peaks: { ...service().peaks, weekend: { DN: H(7,2) + 9, UP: H(7) + 35.9 } },
    } },
    // 【假设】基地非载客整备及出车窗口，不代表新增营业首班。
    opening: { outerAlternation: 0, stockUntil: H(28), redirectFrom: H(4), emptyFeedersFrom: H(20), feederUntil: H(26), stableUntil: H(10), dayStart: H(4), defaultStableDeparture: H(6) },
    outerBandMargin: 0, overlays: [],
    terminals: {
      core: ['ZXX','LTN'], circulate: ['ZXX','LTN'],
      depot: { FB: 'FBD', GQL: 'GQD', ZXX: 'FBD', LTN: 'GQD' },
      capacity: { FB: 3, GQL: 3, ZXX: 2, LTN: 2 }, maxPresent: { FB: 3, GQL: 3, ZXX: 2, LTN: 2 },
    },
    firstOrigins: [], openingGuards: [], closingDepotMoves: [], firstTrainRunAdjust: {},
  },
};
