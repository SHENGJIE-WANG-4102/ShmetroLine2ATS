/** 2 号线原有运行图、训练场景数据；搬迁保持逐项不变。 */
import type { DayType } from '../../../sim/model';
import type { Template, Period, OverlayPreset } from '../../../sim/timetable';
import type { ClockBand, ServiceData, SimulationData } from '../../simulation';
import { SIMULATION_EXTRAS } from './simulationExtras';
import { INSTRUCTOR_DATA } from './scenarios';
const H = (h: number, m = 0) => h * 3600 + m * 60;
const TEMPLATES: Record<string, Template> = {
  weekdayAM: {
    id: 'weekdayAM', name: '工作日早高峰', desc: '大小交路交替：大—大—小，淞虹路—广兰路 2\'30"，外段平均 3\'45"',
    pattern: ['big', 'big', 'small'], headway: 150, peak: true, openingAlternation: true, phase: { DN: 2 },
  },
  weekdayPM: {
    id: 'weekdayPM', name: '工作日晚高峰', desc: '大小交路交替：大—大—小，淞虹路—广兰路 3\'00"，外段 4\'30"',
    pattern: ['big', 'big', 'small'], headway: 180, peak: true, phase: { UP: 1 },
  },
  weekdayAMTail: {
    id: 'weekdayAMTail', name: '早高峰退出', desc: '2:1 交路逐步退出早高峰', // 【假设】
    pattern: ['big', 'big', 'small'], headway: 210,
  },
  weekdayOff: {
    id: 'weekdayOff', name: '工作日平峰', desc: '单一大交路 5\'00"', pattern: ['big'], headway: 300,
  },
  weekdayEvening: {
    id: 'weekdayEvening', name: '工作日夜间平峰', desc: '单一大交路 7\'00"', pattern: ['big'], headway: 420,
  },
  weekdayPMTail: {
    id: 'weekdayPMTail', name: '晚高峰延续', desc: '2:1 延至约20:55，间隔由2\'45"逐步增至4\'00"', // 【假设】 piecewise-linear interpolation
    pattern: ['big', 'big', 'small'], headway: 165, continuePattern: true,
  },
  weekdayNight: {
    id: 'weekdayNight', name: '晚间大交路', desc: '21:00附近原小交路时隙改开机场车，3\'00"向末班8\'00"插值', // 【假设】
    pattern: ['big'], headway: 180,
  },
  weekend: {
    id: 'weekend', name: '双休日/节假日', desc: '全天单一大交路，日间 4\'30"', pattern: ['big'], headway: 270,
  },
  firstLast: {
    id: 'firstLast', name: '首末班及收车', desc: '首班 05:25 起 7\'00"；21:57 后蟠祥路—广兰路 8\'00"，末班后回段/存车',
    pattern: ['big'], headway: 420,
  },
};

const DAY_PERIODS: Record<DayType, Period[]> = {
  weekday: [
    { from: H(4), to: H(6, 5), template: 'firstLast', label: '首班/早间' },
    { from: H(6, 5), to: H(7, 40), template: 'weekdayOff', headway: 300, label: '早高峰前过渡' },
    { from: H(7, 40), to: H(10), template: 'weekdayAM', label: '早高峰' },
    { from: H(10), to: H(10, 40), template: 'weekdayAMTail', headway: 190, headwayTo: 270, label: '早高峰退出' }, // 【假设】
    { from: H(10, 40), to: H(18, 15), template: 'weekdayOff', label: '平峰' },
    { from: H(18, 15), to: H(19, 30), template: 'weekdayPM', label: '晚高峰' },
    // D72: 19:44 observed ~165 s, 20:43 observed ~240 s. The
    // interpolation between observations is 【假设】, with a 12-min 2:1
    // cycle by 20:45. This band does not pre-position a second peak wave.
    { from: H(19, 30), to: H(19, 45), template: 'weekdayPMTail', label: '晚高峰延续' },
    { from: H(19, 45), to: H(20, 45), template: 'weekdayPMTail', headway: 165, headwayTo: 240, label: '晚高峰间隔渐长' },
    { from: H(20, 45), to: H(20, 55), template: 'weekdayPMTail', headway: 240, label: '小交路收车前' },
    { from: H(20, 55), to: H(21), template: 'weekdayNight', headway: 240, headwayTo: 180, label: '机场车接替时隙' }, // 【假设】
    { from: H(21), to: H(21, 40), template: 'weekdayNight', headway: 240, label: '晚间大交路' }, // 【假设】
    { from: H(21, 40), to: H(28), template: 'firstLast', headway: 240, label: '末班/收车' },
  ],
  weekend: [
    { from: H(4), to: H(6, 40), template: 'firstLast', label: '首班/早间' },
    { from: H(6, 40), to: H(7, 40), template: 'weekend', headway: 360, label: '早间过渡' },
    { from: H(7, 40), to: H(21), template: 'weekend', label: '双休日日间' },
    { from: H(21), to: H(21, 40), template: 'weekdayEvening', label: '夜间' },
    { from: H(21, 40), to: H(28), template: 'firstLast', headway: 480, label: '末班/收车' },
  ],
};

const SHOWN_PERIODS: Record<DayType, Period[]> = {
  weekday: [
    { from: H(4), to: H(6, 5), template: 'firstLast', label: '首班/早间' },
    { from: H(6, 5), to: H(6, 45), template: 'weekdayOff', label: '早高峰前过渡' },
    { from: H(6, 45), to: H(10), template: 'weekdayAM', label: '早高峰' },
    { from: H(10), to: H(10, 45), template: 'weekdayAMTail', label: '早高峰退出' },
    { from: H(10, 45), to: H(17), template: 'weekdayOff', label: '平峰' },
    { from: H(17), to: H(17, 30), template: 'weekdayOff', label: '晚高峰前过渡' },
    { from: H(17, 30), to: H(20, 30), template: 'weekdayPM', label: '晚高峰' },
    { from: H(20, 30), to: H(21, 30), template: 'weekdayPMTail', label: '晚高峰退出' },
    { from: H(21, 30), to: H(22, 30), template: 'weekdayNight', label: '夜间' },
    { from: H(22, 30), to: H(28), template: 'firstLast', label: '末班/收车' },
  ],
  weekend: DAY_PERIODS.weekend,
};

const DWELL_BANDS: Record<DayType, ClockBand[]> = {
  weekday: [
    { from: 0, to: H(6, 5), value: 0.918 },
    { from: H(6, 5), to: H(6, 50), value: 1 },
    { from: H(6, 50), to: H(9, 30), value: 0.8 },
    { from: H(9, 30), to: H(16, 50), value: 1 },
    { from: H(16, 50), to: H(19, 30), value: 0.8 },
    // D138【假设】: existing evening band fitted to the seven ride-east samples.
    { from: H(19, 30), to: H(21), value: 1.2 },
    { from: H(21), to: H(21, 40), value: 1.1, valueTo: 0.418 },
    { from: H(21, 40), to: Infinity, value: 0.418 },
  ],
  weekend: [
    { from: 0, to: H(6, 40), value: 0.918 },
    { from: H(6, 40), to: H(21), value: 1.05 },
    { from: H(21), to: H(21, 40), value: 0.918 },
    { from: H(21, 40), to: Infinity, value: 0.418 },
  ],
};

const RUN_BANDS: Record<DayType, ClockBand[]> = {
  weekday: [
    { from: 0, to: H(21, 10), value: 1 },
    { from: H(21, 10), to: H(21, 25), value: 2 },
    { from: H(21, 25), to: H(21, 40), value: 3 },
    { from: H(21, 40), to: Infinity, value: 4 },
  ],
  weekend: [
    { from: 0, to: H(21, 40), value: 1 },
    { from: H(21, 40), to: Infinity, value: 4 },
  ],
};

const SERVICE_DATA: Record<DayType, ServiceData> = {
  weekday: {
    openingUp: { at: H(5, 35) + 30, headway: 450, template: 'weekdayOff', label: '西行开班疏班' }, // 【假设】
    denseUp: H(6, 55),
    openingDn: [{ to: H(6, 10), headway: 225 }, { to: Infinity, headway: 180 }],
    peaks: { weekdayAM: {}, weekdayPM: { DN: H(17), UP: H(17, 24), upEnd: H(20, 20) } },
    overrides: [
      { dir: 'UP', from: H(18, 55), to: H(19, 25), template: 'weekdayNight', headway: 180, label: '西段退峰前三分钟连续大交路' }, // 【假设】由实拍S1/S2反推参考站波次
      { dir: 'DN', from: H(19, 45), to: H(21, 20), template: 'weekdayNight', headway: 180, label: '西段东行三分钟延续' }, // 【假设】
      { dir: 'DN', from: H(9, 45), to: H(10, 40), template: 'weekdayAMTail', headway: 200, headwayTo: 300, label: '东行早高峰退出' }, // 【假设】
    ],
    // 【假设】 LYL depot origins fill the western opening wave while GLL is sparse.
    openingSupplements: [
      { from: 0, to: H(5, 35), headway: 450, terminal: 'PXL' },
      { from: H(5, 35), to: H(5, 50), headway: 225, terminal: 'PXL' },
      { from: H(5, 50), to: H(6, 10), headway: 450, terminal: 'PXL' },
      { from: H(6, 10), to: H(6, 30), headway: 225, terminal: 'PXL' },
      { from: H(6, 30), to: H(6, 40), headway: 225, terminal: 'SHR' },
      { from: H(6, 40), to: H(7, 10), headway: 150, terminal: 'SHR' },
    ],
    shortClose: H(20, 55),
    carryingClose: { from: H(20, 50), to: H(21) },
    lateHeadway: 240,
    standby: [{ from: H(11, 30), need: H(16), to: H(20, 30) }],
  },
  weekend: {
    peaks: {}, overrides: [], openingSupplements: [], lateHeadway: 480,
    standby: [{ from: H(9), need: H(21), to: H(21) }],
  },
};

const OPENING = {
  defaultStableDeparture: H(6),
  outerAlternation: H(7, 10),
  stockUntil: H(10), redirectFrom: H(7), emptyFeedersFrom: H(20),
  feederUntil: H(26), stableUntil: H(10), dayStart: H(4),
};

const OVERLAY_PRESETS: OverlayPreset[] = [
  { id: 'ciie', label: '进博会保障加开', from: H(9, 30), to: H(17, 30), a: 1, b: 22, headway: 900, desc: '国家会展中心 ↔ 广兰路 区间加开，平峰每15分钟一列（各方向）' },
  { id: 'hongqiao', label: '虹桥枢纽大客流加开', from: H(20), to: H(22, 30), a: 2, b: 22, headway: 720, desc: '虹桥火车站 ↔ 广兰路 区间加开，夜间每12分钟一列（虹桥火车站无折返条件，加开车延至国家会展中心折返）' },
];

const FIRST_TRAIN_DIAGRAM_RUN_ADJUST_S = { guanglanEast: 15, longyangWest: -6 };


export const SIMULATION: SimulationData = {
  ...SIMULATION_EXTRAS,
  topology: { wrapAfter: 'LJZ' },
  timetable: {
    diagnostics: {
      firstLastLabels: ['last→airport', 'last→蟠祥路', 'last→广兰路'],
      gaode: { directory: 'reference/timetable-gaode', checks: [['北新泾', 'UP'], ['世纪公园', 'UP'], ['世纪公园', 'DN'], ['张江高科', 'UP'], ['张江高科', 'DN']],
        windows: [[360,660],[960,1410]], reference: { stations: ['川沙','凌空路','远东大道','海天三路','浦东1号2号航站楼'], from: 8, to: 24 } },
    },
    templates: TEMPLATES, dayPeriods: DAY_PERIODS, shownPeriods: SHOWN_PERIODS,
    dwellBands: DWELL_BANDS, runBands: RUN_BANDS, serviceData: SERVICE_DATA,
    opening: OPENING, outerBandMargin: 1200, overlays: OVERLAY_PRESETS,
    terminals: {
      core: ['SHR', 'GLL'], insertOrigin: 'LYL', overflowWithdrawal: 'YDD',
      circulate: ['SHR', 'GLL', 'GJH', 'LYL', 'YDD'],
      depot: { PXL: 'BZL', PDA: 'CSD', SHR: 'BZL', GLL: 'LYD', GJH: 'BZL', HQZ: 'BZL', LYL: 'LYD', YDD: 'CSD' },
      capacity: { PXL: 3, PDA: 3, SHR: 3, GLL: 1, GJH: 3, HQZ: 2 },
      maxPresent: { PXL: 3, PDA: 3, SHR: 2, GLL: 1, GJH: 3, HQZ: 2 },
    },
    firstOrigins: [
      { dir: 'UP', from: 'LYL', to: 'PXL', dep: H(5, 20), checkpoint: { station: 'KJG', dep: H(5, 24) }, runAdjustS: FIRST_TRAIN_DIAGRAM_RUN_ADJUST_S.longyangWest },
      { dir: 'UP', from: 'GLL', to: 'PXL', dep: H(5, 28) },
      { dir: 'DN', from: 'GLL', to: 'PDA', dep: H(6), runAdjustS: FIRST_TRAIN_DIAGRAM_RUN_ADJUST_S.guanglanEast },
    ],
    openingGuards: [{ station: 'GLL', dir: 'DN', until: H(6) }],
    closingDepotMoves: [{ station: 'GLL', dir: 'DN', depot: 'CSD' }],
    firstTrainRunAdjust: FIRST_TRAIN_DIAGRAM_RUN_ADJUST_S,
  },
  instructor: INSTRUCTOR_DATA,
};
