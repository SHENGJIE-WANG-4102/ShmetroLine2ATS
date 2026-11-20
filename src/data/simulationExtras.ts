import type { FixedRun } from './types';
import type { FirstLastRow } from './types';

type Day = 'weekday' | 'weekend';
type Direction = 'DN' | 'UP';
type HolidayClock = number | 'closure';
export interface SimulationExtras {
  physics: { performance: { aMax: number; atoAccelMax: number; atoSpeedHysteresis: number; atoNeutralS: number; atoBrakeRampFraction: number; atoStopSnap?: { speed: number; distance: number; margin: number }; atoSoftStart?: { speed: number; accel: number }; atoSoftStop?: { releaseS: number }; jerk: number; bService: number; bPlan: number; bEbGuaranteed: number; bPermit: number; bEb: number; vMax: number; vRM: number; vCouple: number; atoMargin: number; atoFastMargin: number; atpTolerance: number; resist: number }; traction: [number, number][]; levelBands: Record<number, { band: number; lower: number }> };
  energy: { mass: number; passengerMass: number; tractionEfficiency: number; regenEfficiency: number; sectionLength: number; levelLate: number };
  calibration: {
    /** Optional explicit station dwell budget; default retains the demand model. */
    dwellModel?: 'demand' | 'station';
    ridershipTarget: Record<Day, number>;
    peakSection: { day: Day; from: string; to: string; hours: number[][] } | null;
    profiles: Record<Day, [number, number][]>;
    tides: Record<Day, { stationWeights: number[]; amplitude: number; morning: number; evening: number; width: number }>;
    plannedDoorBudget: number; plannedCloseBudget: number; minDwell: number;
    /** A driver who closes by the departure countdown (TDT/DMI), drawn per stop. Closing may begin once the
     * countdown shows `closeFromS` or less: usually between that and `typicalToS` remaining; with probability
     * `lateProbability` later, thinning out to `overrunMaxS` after zero (the display then shows --).
     * Closing takes DOOR_CLOSE_S; the departure lamp lights `lampDelayS` after the doors lock and the
     * driver starts `startAfterLampS` [min, max] after the lamp. Absent: plannedCloseBudget. */
    driverCloseRule?: { closeFromS: number; typicalToS: number; lateProbability: number; overrunMaxS: number;
      lampDelayS: number; startAfterLampS: [number, number] };
    maxEarlyHold: number; maxDwellBusy: number; maxDwell: number;
    doorsPerSide: number; exchangePerDoor: number;
  };
  gradient: {
    depths: Record<string, number>; stationDepth: number; elevated: number; ground: number;
    flat: number; ramp: number; valley: number; maxDip: number;
    river: { from: string; to: string; depth: number; grade: number } | null;
  };
  holiday: {
    /** Explicit published dates; absence preserves the legacy calendar. */
    calendar?: { from: string; to: string; name: string; days: number; dayOffset: number }[];
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
