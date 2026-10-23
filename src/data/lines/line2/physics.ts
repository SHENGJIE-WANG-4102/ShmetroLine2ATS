import type { SimulationExtras } from '../../simulationExtras';

const PERF: SimulationExtras['physics']['performance'] = {
  /** max traction acceleration at low speed (m/s²) */
  aMax: 1.0,
  /** 【假设】2025-08-04 改造后 02113 两段录音；低速拟合
   * 0.893/0.804，均值 0.8485，0.85 为折中【假设】。 */
  atoAccelMax: 0.85,
  /** 【假设】Comfort thresholds, pending comparison with the measured coast. */
  atoSpeedHysteresis: 3 / 3.6,
  atoNeutralS: .5,
  /** 【假设】Each brake ramp occupies 10% of braking time. The recording
   * supports a gentle ~2 s build-up, but its weak low-frequency tail cannot
   * establish the release fraction. Symmetry preserves bPlan and distance. */
  atoBrakeRampFraction: .1,
  /** longitudinal jerk limit in traction and service braking; not under EB (m/s³, GB/T 7928 6.13) */
  jerk: 0.75,
  /** max service brake (m/s²) */
  bService: 1.0,
  /** braking rate used by ATO planning (comfort) */
  bPlan: 0.75,
  /** guaranteed emergency brake used by ATP curves */
  bEbGuaranteed: 0.95,
  /** the permitted-speed curve shown to the driver (overspeed warning): below
   *  the EB intervention curve so that a driver following it with the service
   *  brake has room before the EB 【假设】 */
  bPermit: 0.8,
  /** actual emergency brake */
  bEb: 1.25,
  /** line / train ceiling: 02A05 design speed and the Line 2 line speed (80 km/h) */
  vMax: 80 / 3.6,
  /** RM speed ceiling (25 km/h) */
  vRM: 25 / 3.6,
  /** coupling approach speed */
  vCouple: 3 / 3.6,
  /** ATO margin below permitted speed (m/s) */
  atoMargin: 3 / 3.6,
  /** Highest ATO performance margin, also used for minimum planning runs. */
  atoFastMargin: .25,
  /** ATP overspeed tolerance before EB (m/s) */
  atpTolerance: 5 / 3.6,
  /** running resistance when coasting */
  resist: 0.03,
};

/**
 * Traction force against speed, as a fraction of the starting force: the AW2
 * curve of the Line 2 study (560 kN flat to 40 km/h, 420 at 50, 180 at 80;
 * reference/…Rolling_Stock_Research.md 图3(b), read off the figure), normalised.
 * Beyond 80 km/h it falls as constant power. Points are (m/s, fraction).
 */
const TRACTION: [number, number][] = [[0, 1], [40 / 3.6, 1], [50 / 3.6, 420 / 560], [80 / 3.6, 180 / 560]];

export const PHYSICS = { performance: PERF, traction: TRACTION, levelBands: {
  1: { band: 0, lower: 0 }, 2: { band: 5 / 3.6, lower: 0 },
  3: { band: 10 / 3.6, lower: 6.5 / 3.6 }, 4: { band: 10 / 3.6, lower: 9.5 / 3.6 },
} };
export const ENERGY = { mass: 290e3, passengerMass: 60, tractionEfficiency: .85, regenEfficiency: .8, sectionLength: 2500, levelLate: 20 };
