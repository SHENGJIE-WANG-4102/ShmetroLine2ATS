import type { SimulationExtras } from '../../simulationExtras';
import { HQ_LATE_RUN } from './firstlast';
import { STATIONS } from './line2';
import { PHYSICS, ENERGY } from './physics';
const H = (h: number, m = 0) => h * 3600 + m * 60;

/** Extracted unchanged from the service, holiday, gradient and PIS models. */
export const SIMULATION_EXTRAS: SimulationExtras = {
  physics: PHYSICS, energy: ENERGY,
  calibration: {
    ridershipTarget: { weekday: 1_090_000, weekend: 1_090_000 * 0.7 },
    peakSection: { day: 'weekday', from: 'SHR', to: 'GLL', hours: [[6.8333, 9.5], [16.8333, 19.5]] },
    profiles: { weekday: [[4.5,0],[5.4,.08],[6.2,.4],[6.8,1.2],[7.5,3.4],[8.1,4],[8.8,2.7],[9.6,.8],[11,.65],[13,.7],[16,.8],[17.2,2.6],[18,3.7],[18.8,2.8],[19.8,.85],[21,.5],[22.5,.25],[23.5,.1],[24.5,0]], weekend: [[4.5,0],[5.4,.1],[7,.4],[9,.9],[10.5,1.15],[14,1.2],[17,1.25],[19,1.1],[21,.7],[22.5,.4],[23.5,.15],[24.5,0]] },
    tides: {
      weekday: { stationWeights: STATIONS.map((_, i) => i <= 12 ? 1 : i >= 17 ? -1 : 0), amplitude: .72, morning: 8, evening: 18, width: 2 },
      weekend: { stationWeights: [], amplitude: 0, morning: 8, evening: 18, width: 2 },
    },
    plannedDoorBudget: 15, plannedCloseBudget: 12, minDwell: 22,
    maxEarlyHold: 10, maxDwellBusy: 85, maxDwell: 70, doorsPerSide: 40, exchangePerDoor: 2.2,
  },
  gradient: {
    depths: { 虹桥火车站: 18, 人民广场: 16, 南京东路: 18, 陆家嘴: 19, 世纪大道: 17, 龙阳路: 15 },
    stationDepth: 14, elevated: 12, ground: 1, flat: 115, ramp: .024, valley: .003, maxDip: 9,
    river: { from: '南京东路', to: '陆家嘴', depth: 34, grade: .027 },
  },
  holiday: {
    returnRuns: [{ ...HQ_LATE_RUN, departures: [H(23, 4), H(23, 30), H(23, 50), H(24, 10), H(24, 30)] }],
    closure: { station: 'NJD', eve: H(20), day: H(16),
      notice: '外滩地区客流管控：{time} 起至运营结束南京东路站封站，列车跳站通过，ATS 按计划设置跳停',
      activeNotice: '南京东路站封站：上、下行站台跳停（计划）' },
    surges: [
      { station: 'RMG', from: 'closure', to: H(22, 30), magnitude: 2.5, eveMagnitude: 1.8, when: 'always' },
      { station: 'LJZ', from: 'closure', to: H(22, 30), magnitude: 2.5, eveMagnitude: 1.8, when: 'always' },
      { station: 'NJD', from: H(12), to: 'closure', magnitude: 2, when: 'holiday' },
      { station: 'KJG', from: H(10), to: H(16), magnitude: 1.6, when: 'holiday' },
      { station: 'HQZ', from: H(19, 30), to: H(24, 15), magnitude: 4, when: 'return' },
      { station: 'HQ2', from: H(20), to: H(24), magnitude: 3, when: 'return' },
      { station: 'PDA', from: H(20, 30), to: H(23, 20), magnitude: 3.5, when: 'return' },
    ],
  },
  pis: {
    timing: { pageMs: 4450, scrollingPageMs: 13350, footerMs: 2500, slideMs: 350, footerSlideMs: 300, englishWidthsPerSecond: .15 },
    defaults: { DN: 'PDA', UP: 'PXL' },
    destinations: [
      { station: 'PDA', first: 'firstE', last: 'lastE', alternatives: [{ station: 'GLL', when: 'lastG' }] },
      { station: 'GLL', first: 'firstE', last: 'lastG', alternatives: [{ station: 'PDA' }] },
      { station: 'PXL', first: 'firstW', last: 'lastW', alternatives: [] },
    ],
    welcome: '欢迎乘坐上海地铁2号线', weatherNotice: '受天气影响，东段高架区段列车限速运行',
  },
};
