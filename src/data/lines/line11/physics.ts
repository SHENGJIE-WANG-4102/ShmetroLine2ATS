import type { SimulationExtras } from '../../simulationExtras';
import { LINE14_PHYSICS } from '../line14/physics';

/** 11号线 6A、最高运营速度 100 km/h（L11-01/03）。
 * 缺 11A01 实测牵引/制动曲线，加减速度、制动率、等级带沿用同一套通用模型，
 * 只把 vMax 改到 100 km/h【假设】。不是 11A01 实测值。 */
export const LINE11_PHYSICS: SimulationExtras['physics'] = {
  ...LINE14_PHYSICS,
  performance: { ...LINE14_PHYSICS.performance, vMax: 100 / 3.6,
    /** 用户（2026-11-15）：DMI 末端速度从 3 直接跳 0，和 2 号线 D173 同一毛病。照 2 号线：数值停稳阈值收小，
     * 进站制动最后约 5.5 s 线性松闸到 0。【假设】松闸时长沿用 2 号线（02A05 录音），没有 11 号线实测。 */
    atoStopSnap: { speed: .03, distance: .03, margin: .01 },
    atoSoftStop: { releaseS: 5.5 } },
};
/** 【假设】6A 整备质量/能耗缺实测，按 6A 通用值给，用于能耗展示，不校正时刻。 */
export const LINE11_ENERGY: SimulationExtras['energy'] = {
  mass: 220e3, passengerMass: 60, tractionEfficiency: .85, regenEfficiency: .8, sectionLength: 2500, levelLate: 20,
};
