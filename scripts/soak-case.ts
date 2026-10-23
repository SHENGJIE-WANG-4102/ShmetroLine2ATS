import { mkdirSync, writeFileSync, writeSync, renameSync } from 'node:fs';
import { Sim } from '../src/sim/engine';
import { exportDiagnostics, stringifyDiagnostics } from '../src/sim/diagnostics';
import { OVERLAY_PRESETS, dayPeriods } from '../src/sim/timetable';
import { STATIONS } from '../src/data/current';
import { profile } from '../src/sim/calibration';
/** minimum share of planned passenger trips delivered, by fault level (level 3 is not gated, D23) */
const DELIVERY_GATE: Record<number, number> = { 1: .95, 2: .90 };
const options = JSON.parse(process.argv[2]) as { dayType: 'weekday' | 'weekend'; template: string; seed: number; level: 0 | 1 | 2 | 3 };
const sim = new Sim({ dayType: options.dayType, dateLabel: 'soak', startTime: 4 * 3600, seed: options.seed, autoDispatch: options.level > 0 });
const output = process.env.SOAK_OUT ?? 'tests/out/soak';
mkdirSync(output, { recursive: true });
const stem = `${output}/${options.dayType}-${options.template}-${options.level}-${options.seed}`;
const saveDiagnostics = (suffix: string) => {
  const path = `${stem}-${suffix}.json`;
  writeFileSync(`${path}.tmp`, stringifyDiagnostics(exportDiagnostics(sim)));
  // Windows refuses the rename while a reader or the virus scanner holds the
  // target open: retry briefly rather than failing the case
  for (let i = 0; ; i++) {
    try { renameSync(`${path}.tmp`, path); return; }
    catch (e) { if (i >= 50 || !['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
  }
};
if (options.level) sim.command({ c: 'randomFaults', level: options.level });
// Retain a replayable state even if the worker is killed or times out.
saveDiagnostics('checkpoint');
let applied = options.template === 'base';
let failure = '';
let clearedAt = 0;
let recoveredAt = 0;
let faultPending = false;
const wall = Date.now();
const delivered = new Set<number>();
const lateTrips: { id: number; no: string; t: number; delay: number; departures: { st: number; delay: number }[] }[] = [];
let completed = 0;
let nextProgress = 8 * 3600;
// Fault-free day checks: trains online, and in-service trains standing at a
// red signal or behind a blockage outside a planned wait.
let maxOnline = 0;
let worstStuck = 0;
const stuck = new Map<number, number>();
let steps = 0;
try { while (sim.t < 27.5 * 3600) {
  if (!applied) {
    const preset = OVERLAY_PRESETS.find(p => p.id === options.template)!;
    // issued half an hour ahead, as a dispatcher would, so that trains for
    // the first added trips can still leave the depot
    const at = preset.from - 1800;
    if (sim.t >= at - 1e-6) {
      const result = sim.command({ c: 'overlay', id: preset.id, from: preset.from, to: preset.to, headway: preset.headway });
      if (!result.ok) { failure = `Template rejected: ${result.msg}`; break; }
      applied = true;
    }
  }
  if (options.level && sim.randomLevel && sim.t >= 21 * 3600) sim.command({ c: 'randomFaults', level: 0 });
  sim.step();
  if (++steps % 50 === 0) {
    maxOnline = Math.max(maxOnline, sim.trainList.length);
    for (const tr of sim.trainList) {
      const t0 = tr.tasks[0];
      const waitingByPlan = t0 && t0.k === 'stop' && t0.dep !== null && (t0.arr === null || t0.arr === t0.dep) && t0.dep > sim.t - 120;
      if (tr.phase === 'run' && tr.v < 0.05 && !waitingByPlan) {
        const since = stuck.get(tr.id) ?? sim.t;
        stuck.set(tr.id, since);
        if (tr.inService) worstStuck = Math.max(worstStuck, sim.t - since);
      } else stuck.delete(tr.id);
    }
  }
  if (sim.tripsDone !== completed) {
    completed = sim.tripsDone;
    for (const train of sim.trainList) {
      const task = train.tasks[0];
      if (train.arrivedAt !== sim.t || task?.k !== 'stop' || task.trip < 0 || task.dep !== null || !sim.plan.trips[task.trip].revenue) continue;
      delivered.add(task.trip);
      const delay = task.arr === null ? 0 : sim.t - task.arr;
      if (Math.abs(delay) > 120) lateTrips.push({ id: task.trip, no: sim.plan.trips[task.trip].no, t: sim.t, delay,
        departures: sim.depLog.filter(d => d.trip === task.trip).map(d => ({ st: d.st, delay: d.delay })) });
    }
  }
  if (sim.t >= nextProgress) {
    writeSync(2, `${options.dayType}-${options.template}-${options.level}-${options.seed}: ${Math.floor(sim.t / 3600)}h, ${sim.tripsDone} trips\n`);
    saveDiagnostics('checkpoint');
    nextProgress += 4 * 3600;
  }
  const violation = sim.integrity.violations[0];
  if (violation) { failure = `${violation.kind}: ${violation.detail}`; break; }
  if (sim.secAcc !== 0) continue;
  const active = sim.faults.some(f => f.stage !== 'closed');
  if (active) { faultPending = true; clearedAt = 0; recoveredAt = 0; }
  // The KPI begins after the LAST fault is cleared, once injection has ended.
  // An intermediate fault-free gap does not establish the final recovery time.
  else if (faultPending && sim.randomLevel === 0) {
    if (!clearedAt) clearedAt = sim.t;
    if (!recoveredAt && sim.trainList.every(t => !t.inService || t.delay <= 120)) recoveredAt = sim.t;
    if (!recoveredAt && sim.t - clearedAt > 3600) { failure = 'Service did not recover within 60 minutes after clearance'; break; }
  }
} } catch (error) {
  failure = `Simulation exception: ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
}
const delays = sim.metrics.tripDelays;
const within2 = delays.length ? delays.filter(d => Math.abs(d) <= 120).length / delays.length : 0;
const maxLate = Math.max(0, ...delays);
const planned = sim.plan.trips.filter(t => t.revenue && !t.cancelled).length;
// Delivery is measured against every planned passenger trip, including the
// ones cancelled during the day. Adjusted trips created by a short turn
// replace a cancelled original and are not counted on either side. Trips
// the added-service planning itself took out ('加开：…': added trips it
// found no capacity for, base withdrawals replaced by an extended duty)
// were never in the plan the day was run to; the added-service gate below
// accounts for them.
const original = sim.plan.trips.filter(t => t.revenue && t.kind !== 'adj' && !t.cancelReason?.startsWith('加开'));
const deliveredOriginal = original.filter(t => t.completed).length;
const delivery = original.length ? deliveredOriginal / original.length : 1;
const cancelled = sim.plan.trips.filter(t => t.revenue && t.cancelled);
const cancelReasons: Record<string, number> = {};
for (const t of cancelled) {
  const key = (t.cancelReason ?? '（无原因）').replace(/\d{3,}|列车\d+|[0-9]+分钟/g, '#');
  cancelReasons[key] = (cancelReasons[key] ?? 0) + 1;
}
if (!failure && cancelled.some(t => !t.cancelReason)) failure = `Cancellation without reason: ${cancelled.filter(t => !t.cancelReason).map(t => t.no).join(',')}`;
if (!failure && sim.tripsDone !== planned) failure = `Undelivered trips: ${sim.tripsDone}/${planned}`;
if (!failure && !options.level && (within2 < 0.98 || maxLate > 300)) failure = `Punctuality: ${within2}; max delay ${maxLate}`;
if (!failure && options.level && delivery < DELIVERY_GATE[options.level])
  failure = `Delivery: ${deliveredOriginal}/${original.length} planned passenger trips (${(delivery * 100).toFixed(1)}%), gate ${DELIVERY_GATE[options.level] * 100}%`;
if (!failure && options.level && faultPending && !recoveredAt) failure = 'Service did not recover to ±2 min after the last fault cleared';
// Where and when passengers board, against the published targets rather
// than the generator's own output: each station's share of the day's
// boardings within 5% of its demand weight, and each service hour's share
// (06–23 h) within 8% of the calibrated profile. Trains that miss stations
// or hours move boardings away from both.
const passengerShares = { station: 0, hour: 0 };
if (!options.level) {
  const rows = sim.ridership.boardings; const total = rows.flat().reduce((a, x) => a + x, 0);
  const weight = STATIONS.reduce((a, s) => a + s.demand, 0);
  for (let st = 0; st < STATIONS.length; st++)
    passengerShares.station = Math.max(passengerShares.station, Math.abs(rows[st].reduce((a, x) => a + x, 0) / total / (STATIONS[st].demand / weight) - 1));
  const hourly = Array.from({ length: 28 }, (_, h) => Array.from({ length: 60 }, (_, m) => profile(options.dayType, h * 3600 + m * 60 + 30)).reduce((a, x) => a + x, 0));
  const day = hourly.reduce((a, x) => a + x, 0);
  for (let h = 6; h < 23; h++)
    passengerShares.hour = Math.max(passengerShares.hour, Math.abs(rows.reduce((a, row) => a + row[h], 0) / total / (hourly[h] / day) - 1));
}
if (!failure && !options.level) {
  const target = options.dayType === 'weekday' ? 1_090_000 : 763_000;
  if (sim.passengersServed < target*.9 || sim.passengersServed > target*1.1)
    failure = `Ridership: ${sim.passengersServed}, target ${target} ±10%`;
  else if (options.dayType === 'weekday' && (sim.ridership.peakSectionLoad/2480 < .9 || sim.ridership.peakSectionLoad/2480 > 1.3))
    failure = `Peak section load: ${sim.ridership.peakSectionLoad}/2480, expected 90–130%`;
  else if (passengerShares.station > .05) failure = `Station boarding shares deviate up to ${(passengerShares.station * 100).toFixed(1)}% from demand weights, limit 5%`;
  else if (passengerShares.hour > .08) failure = `Hourly boarding shares deviate up to ${(passengerShares.hour * 100).toFixed(1)}% from the profile, limit 8%`;
}
// Actual peak headways, fault-free: every train departing a core station
// (DN 淞虹路–张江高科, UP 广兰路–北新泾, where every train departs) in a peak
// band keeps 150 s ±30 s for at least 95% of the intervals.
const peakHeadway = { intervals: 0, within: 0 };
if (!options.level && options.dayType === 'weekday') {
  const bands = dayPeriods('weekday').filter(p => p.template === 'weekdayAM' || p.template === 'weekdayPM');
  for (const band of bands) for (const dir of ['DN', 'UP'] as const) for (let st = 4; st <= 22; st++) {
    if (st === (dir === 'DN' ? 22 : 4)) continue;
    const times = sim.depLog.filter(d => d.st === st && sim.plan.trips[d.trip].dir === dir && d.t >= band.from && d.t < band.to).map(d => d.t).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) { peakHeadway.intervals++; if (Math.abs(times[i] - times[i - 1] - 150) <= 30) peakHeadway.within++; }
  }
}
if (!failure && !options.level) {
  const emergency = sim.events.filter(e => e.text.includes('紧急制动')).length;
  if (sim.trainList.some(t => t.phase !== 'stabled')) failure = `Trains not stabled at the end of the day: ${sim.trainList.filter(t => t.phase !== 'stabled').length}`;
  else if (maxOnline > 76) failure = `Trains online: ${maxOnline}, limit 76`;
  else if (worstStuck >= 420) failure = `In-service train stopped outside a planned wait for ${worstStuck} s`;
  else if (emergency) failure = `Emergency brakes in fault-free operation: ${emergency}`;
  else if (sim.plan.trips.some(t => t.kind === 'small') !== (options.dayType === 'weekday')) failure = 'Small-route trips must run on weekdays only';
  else if (options.dayType === 'weekday' && (peakHeadway.intervals < 3000 || peakHeadway.within < .95 * peakHeadway.intervals))
    failure = `Peak headway: ${peakHeadway.within}/${peakHeadway.intervals} core intervals within 150 s ±30 s, gate 95%`;
}
// An added-service template must run at least 90% of the grid trips it
// requested (each covering the whole added section) fault-free; trips it
// could not plan count as not run. Grid slots the base plan leaves no room
// for at all (peak) are reported, not requested (D47).
const preset = OVERLAY_PRESETS.find(p => p.id === options.template);
const overlayInfo = sim.plan.overlays.at(-1);
const gridTrips = preset ? sim.plan.trips.filter(t => t.revenue && t.overlay
  && t.stops.some(p => p.st === preset.a) && t.stops.some(p => p.st === preset.b)) : [];
const overlayRun = gridTrips.filter(t => t.completed).length;
const overlayRequested = overlayInfo?.requested ?? gridTrips.length;
if (!failure && !options.level && preset && overlayRun < .9 * overlayRequested)
  failure = `Added service: ${overlayRun}/${overlayRequested} trips ran`;
if (!failure && options.level && (sim.faults.some(f => f.stage !== 'closed') || sim.trainList.some(t => t.forceLevel === 'AUTO' && !t.manual && (t.level !== 'CBTC' || t.mode !== 'DTO')))) failure = 'Unrecovered fault or degraded state';
const result = { ...options, ok: !failure, failure, until: sim.t, integrity: sim.integrity.counts, completed: sim.tripsDone, planned,
  delivery: { delivered: deliveredOriginal, planned: original.length, ratio: delivery, gate: options.level ? DELIVERY_GATE[options.level] : 1 },
  addedService: preset ? { ran: overlayRun, requested: overlayRequested, planned: gridTrips.filter(t => !t.cancelled).length, peak: overlayInfo?.peak ?? 0 } : null,
  within2, maxLate, maxOnline, worstStuck, peakHeadway, passengerShares, departurePunctuality: sim.depTotal ? sim.depOnTime / sim.depTotal : 1,
  recoverySeconds: clearedAt && recoveredAt ? recoveredAt - clearedAt : null, lastFaultClearedAt: clearedAt || null, wallSeconds: (Date.now() - wall) / 1000,
  ridership: { boardings: sim.passengersServed, generated: sim.ridership.generated, peakLoad: sim.ridership.peakSectionLoad, maxLoad: sim.ridership.maxLoad },
  model: process.env.SOAK_MODEL_HASH, lateTrips,
  cancellations: cancelled.length, cancelReasons,
  cancelledTrips: cancelled.map(t => ({ id: t.id, no: t.no, reason: t.cancelReason })),
  undelivered: sim.plan.trips.filter(t => t.revenue && !t.cancelled && !delivered.has(t.id)).map(t => ({ id: t.id, no: t.no })) };
writeFileSync(`${stem}.json`, JSON.stringify(result, null, 2));
if (failure) saveDiagnostics('diagnostics');
writeSync(1, JSON.stringify({ ...result, lateTrips: lateTrips.length, cancelledTrips: undefined, cancelReasons: undefined, undelivered: result.undelivered.length }) + '\n');
if (failure) process.exitCode = 1;
