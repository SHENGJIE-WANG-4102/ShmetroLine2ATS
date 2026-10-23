import type { FixedRun } from './types';
import type { FirstLastRow } from './types';

type Day = 'weekday' | 'weekend';
type Direction = 'DN' | 'UP';
type HolidayClock = number | 'closure';
export interface SimulationExtras {
  physics: { performance: { aMax: number; atoAccelMax: number; atoSpeedHysteresis: number; atoNeutralS: number; atoBrakeRampFraction: number; jerk: number; bService: number; bPlan: number; bEbGuaranteed: number; bPermit: number; bEb: number; vMax: number; vRM: number; vCouple: number; atoMargin: number; atoFastMargin: number; atpTolerance: number; resist: number }; traction: [number, number][]; levelBands: Record<number, { band: number; lower: number }> };
  energy: { mass: number; passengerMass: number; tractionEfficiency: number; regenEfficiency: number; sectionLength: number; levelLate: number };
  calibration: {
    ridershipTarget: Record<Day, number>;
    peakSection: { day: Day; from: string; to: string; hours: number[][] } | null;
    profiles: Record<Day, [number, number][]>;
    tides: Record<Day, { stationWeights: number[]; amplitude: number; morning: number; evening: number; width: number }>;
    plannedDoorBudget: number; plannedCloseBudget: number; minDwell: number;
    maxEarlyHold: number; maxDwellBusy: number; maxDwell: number;
    doorsPerSide: number; exchangePerDoor: number;
  };
  gradient: {
    depths: Record<string, number>; stationDepth: number; elevated: number; ground: number;
    flat: number; ramp: number; valley: number; maxDip: number;
    river: { from: string; to: string; depth: number; grade: number } | null;
  };
  holiday: {
    returnRuns: FixedRun[];
    closure: { station: string; eve: number; day: number; notice: string; activeNotice: string } | null;
    surges: { station: string; from: HolidayClock; to: HolidayClock; magnitude: number; eveMagnitude?: number; when: 'always' | 'holiday' | 'return' }[];
  };
  pis: {
    timing: { pageMs: number; scrollingPageMs: number; footerMs: number; slideMs: number; footerSlideMs: number; englishWidthsPerSecond: number };
    defaults: Record<Direction, string>;
    destinations: { station: string; first: keyof FirstLastRow; last: keyof FirstLastRow; alternatives: { station: string; when?: keyof FirstLastRow }[] }[];
    welcome: string; weatherNotice: string;
  };
}
