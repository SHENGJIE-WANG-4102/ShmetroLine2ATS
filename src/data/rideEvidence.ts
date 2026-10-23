import type { RideStop, RideMeasuredEvent, RecordingId } from './types';

export const RIDE_MEASURED_EVENTS: readonly RideMeasuredEvent[] = ['stop', 'open', 'closingMotion', 'start', 'close'];

/** Confidence is event-specific: a weak opening never invalidates a strong
 * stop→start dwell; a weak stop never enters either run or dwell means. */
export function usableRideEvent(row: RideStop, event: RideMeasuredEvent): boolean {
  const value = row[event];
  return typeof value === 'number' && Number.isFinite(value) &&
    row.evidence[event] !== undefined && row.evidence[event]!.confidence !== 'low';
}

/** Observed-only summaries. Never pair recordings, impute boundaries, or mix
 * the old immutable plan snapshot with the current clock-matched plan. */
export function summarizeRideLog(rows: readonly RideStop[]) {
  const runs: number[] = [], dwells: number[] = [], openingLags: number[] = [];
  const warningToStart: number[] = [], closingToStart: number[] = [];
  const pairedRuns: number[] = [], pairedDwells: number[] = [];
  const events = Object.fromEntries(RIDE_MEASURED_EVENTS.map(event => [event,
    { high: 0, medium: 0, low: 0, missing: 0 }])) as Record<RideMeasuredEvent,
      { high: number; medium: number; low: number; missing: number }>;
  const previousBySource = new Map<RecordingId, RideStop>();
  for (const row of rows) {
    for (const event of RIDE_MEASURED_EVENTS) {
      const value = row[event], evidence = row.evidence[event];
      if (typeof value !== 'number' || !Number.isFinite(value) || !evidence) events[event].missing++;
      else events[event][evidence.confidence]++;
    }
    const hasDwell = usableRideEvent(row, 'stop') && usableRideEvent(row, 'start');
    const dwell = hasDwell ? row.start! - row.stop! : null;
    if (dwell !== null && dwell >= 0) dwells.push(dwell);
    if (usableRideEvent(row, 'stop') && usableRideEvent(row, 'open') && row.open! >= row.stop!)
      openingLags.push(row.open! - row.stop!);
    if (usableRideEvent(row, 'close') && usableRideEvent(row, 'start') && row.start! >= row.close!)
      warningToStart.push(row.start! - row.close!);
    if (usableRideEvent(row, 'closingMotion') && usableRideEvent(row, 'start') && row.start! >= row.closingMotion!)
      closingToStart.push(row.start! - row.closingMotion!);
    const previous = previousBySource.get(row.recording);
    if (previous && previous.direction === row.direction && usableRideEvent(previous, 'start') && usableRideEvent(row, 'stop')) {
      const run = row.stop! - previous.start!;
      if (run >= 0) {
        runs.push(run);
        if (dwell !== null && dwell >= 0) { pairedRuns.push(run); pairedDwells.push(dwell); }
      }
    }
    previousBySource.set(row.recording, row);
  }
  const metric = (values: number[]) => ({ count: values.length,
    meanS: values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 100) / 100 : null });
  return { rows: rows.length, events, run: metric(runs), dwell: metric(dwells),
    openingLag: metric(openingLags), warningToStart: metric(warningToStart), closingToStart: metric(closingToStart),
    paired: { count: pairedRuns.length, runMeanS: metric(pairedRuns).meanS, dwellMeanS: metric(pairedDwells).meanS } };
}
