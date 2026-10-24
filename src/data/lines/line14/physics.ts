import type { SimulationExtras } from '../../simulationExtras';

/** 性能数据依任务明确授权逐项同2号线8A：同为8A且运行80km/h，均为【假设】，不是14A01实测。
 * 只承用性能数值；不承用该线录音校准、区间时分或运行等级结果。 */
export const LINE14_PHYSICS: SimulationExtras['physics'] = {
  performance: {
    aMax: 1.0, atoAccelMax: .85, atoSpeedHysteresis: 3 / 3.6, atoNeutralS: .5,
    atoBrakeRampFraction: .1, jerk: .75, bService: 1.0, bPlan: .75,
    bEbGuaranteed: .95, bPermit: .8, bEb: 1.25,
    vMax: 80 / 3.6, // TCMS实拍线路限速80；其余速度/性能同2号线【假设】
    vRM: 25 / 3.6, vCouple: 3 / 3.6, atoMargin: 3 / 3.6,
    atoFastMargin: .25, atpTolerance: 5 / 3.6, resist: .03,
  },
  // 同2号线：缺14A01牵引曲线，8A归一化牵引包络占位【假设】。
  traction: [[0, 1], [40 / 3.6, 1], [50 / 3.6, 420 / 560], [80 / 3.6, 180 / 560]],
  levelBands: {
    1: { band: 0, lower: 0 }, 2: { band: 5 / 3.6, lower: 0 },
    3: { band: 10 / 3.6, lower: 6.5 / 3.6 }, 4: { band: 10 / 3.6, lower: 9.5 / 3.6 },
  },
};
/** 【假设】整备质量/能耗缺实测，按8A通用能量模型显式给值；用于能耗展示，不校正时刻。 */
export const LINE14_ENERGY: SimulationExtras['energy'] = {
  mass: 290e3, passengerMass: 60, tractionEfficiency: .85, regenEfficiency: .8, sectionLength: 2500, levelLate: 20,
};
