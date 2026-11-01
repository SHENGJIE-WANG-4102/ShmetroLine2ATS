import type { DayType, TrackDir, TripKind } from '../../src/sim/model';

export function rulesForDay<T extends { days?: DayType[] }>(rules: readonly T[], day: DayType): T[] {
  return rules.filter(rule => !rule.days || rule.days.includes(day));
}

/** Scope an evidence comparison by arrival time, without changing the plan. */
export function includedInComparison(
  rules: readonly { station: string; dir: TrackDir; from: number; to: number; kinds: TripKind[] }[],
  station: string, dir: TrackDir, kind: TripKind, arrivalMinute: number,
): boolean {
  return !rules.some(rule => rule.station === station && rule.dir === dir &&
    arrivalMinute >= rule.from && arrivalMinute < rule.to && rule.kinds.includes(kind));
}
