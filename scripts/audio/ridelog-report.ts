/** Metadata-only report using the recorded pre-calibration plan snapshot.
 * npx --no-install vite-node scripts/audio/ridelog-report.ts
 * --measurement-input work/recordings/analysis/events.json exports analysis bounds.
 * --json work/recordings/analysis/report.json exports the full computed report.
 */
import { writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { FIRST_LAST } from '../../src/data/current';
import { STATIONS } from '../../src/data/current';
import { RECORDING_SOURCES, RIDE_LOG, RIDE_MODEL_BASELINE, USER_DOOR_REFERENCES,
  LEGACY_RECORDING_IDS, FIELD_1016_RECORDING_IDS, summarizeRideLog, type RecordingId, type RideStop } from '../../src/data/audio/ridelog';

const minute = (clock: string): number => {
  const [hours, minutes] = clock.split(':').map(Number);
  return hours * 60 + minutes;
};
const valid = (row: RideStop, event: 'stop' | 'close' | 'start') =>
  row[event] !== null && row.evidence[event] !== undefined && row.evidence[event]!.confidence !== 'low';
const round = (value: number | null): number | null => value === null ? null : Math.round(value * 100) / 100;
const avg = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function saveIgnored(path: string, data: unknown) {
  const inside = relative(resolve('work'), resolve(path));
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Report output must be under ignored work/');
  writeFileSync(resolve(path), JSON.stringify(data, null, 2), 'utf8');
}
for (const source of RECORDING_SOURCES) {
  const rows = RIDE_LOG.filter(row => row.recording === source.id);
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const stationIndex = STATIONS.findIndex(station => station.name === row.station);
    if (stationIndex < 0) throw new Error(`Unknown station: ${row.station}`);
    const times = [row.stop, row.open, row.close, row.closingMotion ?? null, row.start].filter((at): at is number => at !== null);
    if (times.some(at => !Number.isFinite(at) || at < 0 || at > source.durationS)) throw new Error(`Out-of-file event: ${row.station}`);
    if (times.some((at, i) => i > 0 && at < times[i - 1])) throw new Error(`Event order: ${row.station}`);
    const bounds = row.analysisWindowS;
    if (bounds && (bounds[0] < 0 || bounds[1] > source.durationS || bounds[1] <= bounds[0])) throw new Error(`Invalid bounds: ${row.station}`);
    if (index > 0) {
      const previous = rows[index - 1];
      const step = row.direction === 'DN' ? 1 : -1;
      if (row.direction !== previous.direction || stationIndex - STATIONS.findIndex(station => station.name === previous.station) !== step)
        throw new Error(`Non-adjacent ride rows: ${previous.station} / ${row.station}`);
    }
  }
}
const args = process.argv.slice(2);
const referenceRow = RIDE_LOG.find(row => row.recording === USER_DOOR_REFERENCES.recording && row.station === USER_DOOR_REFERENCES.station)!;
const referenceTimes = [referenceRow.stop!, USER_DOOR_REFERENCES.open, referenceRow.close!, USER_DOOR_REFERENCES.closingMotion,
  USER_DOOR_REFERENCES.locked.parsedSeconds, referenceRow.start!];
if (!USER_DOOR_REFERENCES.locked.usable || referenceTimes.some((at, index) => index > 0 && at < referenceTimes[index - 1]))
  throw new Error('User door-reference chronology mismatch');
const exportIndex = args.indexOf('--measurement-input');
if (exportIndex >= 0) saveIgnored(args[exportIndex + 1], RIDE_LOG);

const intervals: { from: string; to: string; recording: string; direction: string;
  observedRun: number | null; modelRun: number; runDelta: number | null; runIncluded: boolean;
  observedDwell: number | null; modelDwell: number; dwellDelta: number | null; dwellIncluded: boolean;
  closeToStart: number | null; closeIncluded: boolean; observedTotal: number | null; modelTotal: number;
  officialSeconds: number; officialKind: 'departure-arrival' | 'departure-departure'; pairIncluded: boolean }[] = [];
// The immutable 10-14 comparison must never require a legacy model interval
// for a new source, or silently compare 21:05 data to an old last-train plan.
const legacyIds: readonly RecordingId[] = LEGACY_RECORDING_IDS;
const fieldIds: readonly RecordingId[] = FIELD_1016_RECORDING_IDS;
for (const source of RECORDING_SOURCES.filter(source => source.kind === 'ride' && legacyIds.includes(source.id))) {
  const rows = RIDE_LOG.filter(row => row.recording === source.id);
  for (let index = 1; index < rows.length; index++) {
    const from = rows[index - 1], to = rows[index];
    const model = RIDE_MODEL_BASELINE.intervals.find(row => row.direction === from.direction && row.from === from.station && row.to === to.station);
    if (!model) throw new Error(`Missing model baseline: ${from.station} / ${to.station}`);
    const modelRun = model.runS, modelDwell = model.dwellS;
    const observedRun = from.start === null || to.stop === null ? null : to.stop - from.start;
    const observedDwell = to.stop === null || to.start === null ? null : to.start - to.stop;
    const closeToStart = to.close === null || to.start === null ? null : to.start - to.close;
    const runIncluded = valid(from, 'start') && valid(to, 'stop');
    const dwellIncluded = valid(to, 'stop') && valid(to, 'start');
    const terminal = to.station === (from.direction === 'DN' ? RIDE_MODEL_BASELINE.terminalDN : RIDE_MODEL_BASELINE.terminalUP);
    const observedTotal = from.start === null || (terminal ? to.stop : to.start) === null ? null :
      (terminal ? to.stop! : to.start!) - from.start;
    const modelTotal = modelRun + (terminal ? 0 : modelDwell);
    const key = from.direction === 'DN' ? 'lastG' : 'lastW';
    const fromOfficial = FIRST_LAST.find(row => row.station === from.station)!;
    const toOfficial = FIRST_LAST.find(row => row.station === to.station)!;
    intervals.push({ from: from.station, to: to.station, recording: source.id, direction: from.direction,
      observedRun: round(observedRun), modelRun: round(modelRun)!, runDelta: round(observedRun === null ? null : observedRun - modelRun), runIncluded,
      observedDwell: round(observedDwell), modelDwell: round(modelDwell)!, dwellDelta: round(observedDwell === null ? null : observedDwell - modelDwell), dwellIncluded,
      closeToStart: round(closeToStart), closeIncluded: valid(to, 'close') && valid(to, 'start'),
      observedTotal: round(observedTotal), modelTotal: round(modelTotal)!,
      officialSeconds: (minute(toOfficial[key]) - minute(fromOfficial[key])) * 60,
      officialKind: terminal ? 'departure-arrival' : 'departure-departure', pairIncluded: runIncluded && dwellIncluded && !terminal });
  }
}
// Use identical intervals for both components so the decomposition adds up.
const paired = intervals.filter(row => row.pairIncluded);
const runExtra = avg(paired.map(row => row.runDelta!));
const dwellExtra = avg(paired.map(row => row.dwellDelta!));
const totalExtra = runExtra === null || dwellExtra === null ? null : runExtra + dwellExtra;
const runShare = totalExtra !== null && totalExtra > 0 ? runExtra! / totalExtra : null;
const dwellShare = totalExtra !== null && totalExtra > 0 ? dwellExtra! / totalExtra : null;
// Show sensitivity to prolonged station stops without deleting valid observations.
const usualDwells = paired.filter(row => row.observedDwell! <= 70);
const usualRunExtra = avg(usualDwells.map(row => row.runDelta!));
const usualDwellExtra = avg(usualDwells.map(row => row.dwellDelta!));
const usualTotal = usualRunExtra === null || usualDwellExtra === null ? null : usualRunExtra + usualDwellExtra;
for (const row of paired) {
  if (Math.abs(row.observedRun! + row.observedDwell! - row.observedTotal!) > .02) throw new Error(`Observed decomposition mismatch: ${row.to}`);
  if (Math.abs(row.runDelta! + row.dwellDelta! - (row.observedTotal! - row.modelTotal)) > .04) throw new Error(`Delta decomposition mismatch: ${row.to}`);
}
const east = RIDE_LOG.filter(row => row.recording === 'ride-east');
const first = east[0], end = east.at(-1)!;
const wholeObserved = first.start === null || end.stop === null ? null : end.stop - first.start;
const wholeModel = RIDE_MODEL_BASELINE.wholeRecordedModelSeconds;
const wholeOfficial = (minute(FIRST_LAST.find(row => row.station === end.station)!.lastG) - minute(FIRST_LAST.find(row => row.station === first.station)!.lastG)) * 60;
const report = {
  baseline: { gitRevision: RIDE_MODEL_BASELINE.revision, mode: 'immutable pre-calibration snapshot',
    dayType: 'weekday', modelTripG: RIDE_MODEL_BASELINE.tripG, modelTripW: RIDE_MODEL_BASELINE.tripW,
    modelAirportTrip: RIDE_MODEL_BASELINE.tripAirport, modelAirportFullSeconds: RIDE_MODEL_BASELINE.airportFullSeconds,
    clockAlignment: 'unknown; last-train planned dwells, not a synchronized evening trip' },
  events: RIDE_LOG, intervals,
  averages: { pairedCount: paired.length, pairedStations: paired.map(row => row.to),
    pairedObservedRunS: round(avg(paired.map(row => row.observedRun!))), pairedModelRunS: round(avg(paired.map(row => row.modelRun))),
    pairedObservedDwellS: round(avg(paired.map(row => row.observedDwell!))), pairedModelDwellS: round(avg(paired.map(row => row.modelDwell))),
    runExtraS: round(runExtra), dwellExtraS: round(dwellExtra), totalExtraS: round(totalExtra),
    runShare: round(runShare), dwellShare: round(dwellShare),
    extrapolated36S: { run: runShare === null ? null : round(36 * runShare), dwell: dwellShare === null ? null : round(36 * dwellShare) },
    validRunCount: intervals.filter(row => row.runIncluded).length,
    runMeanS: round(avg(intervals.filter(row => row.runIncluded).map(row => row.observedRun!))),
    validDwellCount: intervals.filter(row => row.dwellIncluded).length,
    dwellMeanS: round(avg(intervals.filter(row => row.dwellIncluded).map(row => row.observedDwell!))),
    closeToStartMeanS: round(avg(intervals.filter(row => row.closeIncluded).map(row => row.closeToStart!))) },
  wholeRecordedRide: { sections: east.length - 1, observedSeconds: round(wholeObserved), modelSeconds: round(wholeModel), officialSeconds: wholeOfficial,
    observedExtraPerSection: wholeObserved === null ? null : round((wholeObserved - wholeModel) / (east.length - 1)),
    officialExtraPerSection: round((wholeOfficial - wholeModel) / (east.length - 1)), boundaryIncluded: valid(first, 'start') && valid(end, 'stop') },
  sensitivity: { assumption: 'exclude dwells >70 s only for sensitivity; keep primary mean unchanged', count: usualDwells.length,
    omitted: paired.filter(row => row.observedDwell! > 70).map(row => row.to),
    runExtraS: round(usualRunExtra), dwellExtraS: round(usualDwellExtra),
    dwellShare: usualTotal === null || usualTotal <= 0 ? null : round(usualDwellExtra! / usualTotal) },
  excludedStops: RIDE_LOG.filter(row => legacyIds.includes(row.recording) && row.evidence.stop?.confidence === 'low').map(row => `${row.recording}:${row.station}`),
  measurementSummaries: {
    legacy: summarizeRideLog(RIDE_LOG.filter(row => legacyIds.includes(row.recording))),
    field1016: summarizeRideLog(RIDE_LOG.filter(row => fieldIds.includes(row.recording))),
    combined: summarizeRideLog(RIDE_LOG),
    byRecording: Object.fromEntries(RECORDING_SOURCES.filter(source => source.kind === 'ride')
      .map(source => [source.id, summarizeRideLog(RIDE_LOG.filter(row => row.recording === source.id))])),
  },
};
const jsonIndex = args.indexOf('--json');
if (jsonIndex >= 0) saveIgnored(args[jsonIndex + 1], report);
console.log('Metadata valid. Low-confidence stop events excluded from run/dwell means.');
console.log('| 区间 | 运行 实测/计划/差 s | 下一站停站 实测/计划/差 s | 关门→起车 s | 发→发/终到 实测/计划/官方 s | 入均值 |');
console.log('|---|---:|---:|---:|---:|---|');
const fmt = (v: number | null) => v === null ? '—' : v.toFixed(2);
for (const row of intervals) console.log(`| ${row.from}→${row.to} | ${fmt(row.observedRun)} / ${fmt(row.modelRun)} / ${fmt(row.runDelta)} | ${fmt(row.observedDwell)} / ${fmt(row.modelDwell)} / ${fmt(row.dwellDelta)} | ${fmt(row.closeToStart)} | ${fmt(row.observedTotal)} / ${fmt(row.modelTotal)} / ${row.officialSeconds} | ${row.pairIncluded ? '是' : '否'} |`);
console.log(JSON.stringify({ averages: report.averages, wholeRecordedRide: report.wholeRecordedRide, sensitivity: report.sensitivity, excludedStops: report.excludedStops }, null, 2));
