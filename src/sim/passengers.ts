/**
 * Simple passenger model: per-platform waiting queues fed by a time-of-day
 * demand profile, boarding/alighting at stops driving dwell time, crowding
 * and passenger surges (大客流).
 */
import type { Sim } from './engine';
import type { StopTask, Train } from './model';
import { STATIONS, LINE_INFO } from '../data/current';
import { callCrowd } from './radio';
import { ahead } from './topology';
import { effectiveStops } from './timetable';

import { boardingDemand, inPeakSection, passengerMinimum } from './calibration';

// Assumption: directional boarding demand starts 15 minutes before the first
// usable train. A closed service cannot accumulate hours of rush-hour demand
// before that direction's first train reaches an outer station.
const serviceWindows = new WeakMap<Sim, { rev: number; trips: Sim['plan']['trips']; first: number[]; last: number[] }>();
function boardingWindows(sim: Sim) {
  let windows = serviceWindows.get(sim);
  if (!windows || windows.rev !== sim.planRev || windows.trips !== sim.plan.trips) {
    const first = sim.topo.platforms.map(() => Infinity);
    const last = sim.topo.platforms.map(() => -Infinity);
    for (const trip of sim.plan.trips) if (trip.revenue && !trip.cancelled) {
      const stops = effectiveStops(trip);
      for (let i = 0; i < stops.length - 1; i++) {
        const stop = stops[i];
        // (a set-down-only stop is no boarding opportunity)
        if (!stop.stop || stop.noBoard) continue;
        const platform = sim.topo.stations[stop.st].platforms[trip.dir];
        first[platform] = Math.min(first[platform], stop.dep - 900);
        last[platform] = Math.max(last[platform], stop.dep);
      }
    }
    windows = { rev: sim.planRev, trips: sim.plan.trips, first, last };
    serviceWindows.set(sim, windows);
  }
  return windows;
}

/** Integrate the base service windows once. Persist the scale in checkpoints:
 * cancelling service during faults must not redistribute that lost demand. */
function scaleFor(sim: Sim): number {
  if (sim.passengerScale > 0) return sim.passengerScale;
  const windows = boardingWindows(sim);
  let total = 0;
  for (const p of sim.topo.platforms) {
    if (p.pool !== undefined) continue;
    if ((p.track === 'DN' && p.station === STATIONS.length - 1) || (p.track === 'UP' && p.station === 0)) continue;
    for (let t = windows.first[p.id]; t < windows.last[p.id]; t += 60)
      total += boardingDemand(sim.plan.dayType, p.station, p.track as 'DN' | 'UP', t + 30) * Math.min(60, windows.last[p.id] - t);
  }
  sim.passengerScale = sim.ridershipTarget / Math.max(1, total);
  return sim.passengerScale;
}

/** per second update of waiting passengers */
export function passengersTick(sim: Sim, dt: number) {
  const scale = scaleFor(sim);
  const { topo } = sim;
  const windows = boardingWindows(sim);
  for (const p of topo.platforms) {
    // a face sharing another platform's queue (广兰路 middle track) has no demand of its own
    if (p.pool !== undefined) continue;
    const ps = sim.plat[p.id];
    const st = STATIONS[p.station];
    // no boarding demand towards the line end
    const towardsEnd = (p.track === 'DN' && p.station === STATIONS.length - 1) || (p.track === 'UP' && p.station === 0);
    if (towardsEnd) { ps.waiting = 0; continue; }
    // a closed station (封站: both platforms skipped) has its entrances shut;
    // those still on the platform are led out
    const sp = topo.stations[p.station].platforms;
    if (sim.plat[sp.DN].skip && sim.plat[sp.UP].skip) { ps.waiting *= Math.max(0, 1 - dt / 120); continue; }
    const lambda = scale * boardingDemand(sim.plan.dayType, p.station, p.track as 'DN' | 'UP', sim.t) * ps.surge;
    const inflow = Math.max(0, lambda * dt * (0.85 + 0.3 * sim.rng()));
    if (sim.t < windows.first[p.id]) { ps.waiting = 0; continue; }
    if (sim.t > windows.last[p.id]) continue;
    sim.ridership.generated += inflow;
    if (ps.limitUntil > sim.t) {
      // station inflow control (限流): part of the demand is held outside the station
      ps.waiting += inflow * 0.6;
      sim.metrics.limited += inflow * 0.4;
    } else ps.waiting += inflow;
    if (ps.waiting > 1200 && !sim.alarms.has(`crowd-${p.station}`)) {
      sim.log('B', '客流', `${st.name} 站台客流拥挤（候车约 ${Math.round(ps.waiting)} 人）`, { key: `crowd-${p.station}` });
      callCrowd(sim, p.station, ps.waiting);
    } else if (ps.waiting < 600 && sim.alarms.has(`crowd-${p.station}`)) {
      const other = topo.stations[p.station].platforms;
      if (sim.plat[other.DN].waiting < 600 && sim.plat[other.UP].waiting < 600) sim.clearAlarm(`crowd-${p.station}`);
    }
  }
}

/** Pure exchange allocation, captured when stopping and applied only once doors open. */
export function planPassengerExchange(sim: Sim, tr: Train, platform: number, task: StopTask): { board: number; alight: number } {
  const { topo } = sim;
  const p = topo.platforms[platform];
  const ps = sim.plat[p.pool ?? platform];
  const st = p.station;
  const direction = p.track === 'DN' ? 'DN' : 'UP';
  // alighting share: this station's weight among this and the remaining stations
  // (a trip with a stopping pattern: among the stations it still stops at)
  let rem = 0;
  const trip = task.trip >= 0 ? sim.plan.trips[task.trip] : undefined;
  const stops = trip && effectiveStops(trip);
  if (trip?.revenue && stops && (trip.cut || stops.some((x) => !x.stop))) {
    for (const x of stops) if (x.stop && (x.st === st || ahead(direction, st, x.st))) rem += STATIONS[x.st].demand;
  } else {
    const onward = STATIONS.map((_, i) => i).filter(i => i === st || ahead(direction, st, i));
    if (direction === 'UP') onward.reverse();
    for (const i of onward) rem += STATIONS[i].demand;
  }
  const isEnd = task.dep === null;
  const alightFrac = isEnd ? 1 : Math.min(1, (STATIONS[st].demand / Math.max(0.1, rem)));
  const alight = Math.round(tr.load * alightFrac);
  const remainingLoad = tr.load - alight;
  const board = !isEnd && task.revenue && !task.noBoard
    ? Math.max(0, Math.min(Math.floor(ps.waiting), LINE_INFO.crushCapacity - remainingLoad)) : 0;
  return { board, alight };
}

export function exchangeDwell(sim: Sim, tr: Train, platform: number, exchange: { board: number; alight: number }): number {
  const p = sim.topo.platforms[platform];
  return passengerMinimum(exchange.board, exchange.alight,
    tr.load - exchange.alight + exchange.board > LINE_INFO.capacity * .95, sim.plat[p.pool ?? platform].surge);
}

/** Commit the prepared exchange when the actual doors open; no exchange occurs while closed. */
export function boardAndAlight(sim: Sim, tr: Train, platform: number, task: StopTask,
  prepared = planPassengerExchange(sim, tr, platform, task)): number {
  const p = sim.topo.platforms[platform], st = p.station, ps = sim.plat[p.pool ?? platform];
  const alight = Math.min(tr.load, prepared.alight);
  tr.load -= alight;
  const board = Math.max(0, Math.min(prepared.board, Math.floor(ps.waiting), LINE_INFO.crushCapacity - tr.load));
  ps.waiting -= board;
  tr.load += board;
  ps.stranded = Math.floor(ps.waiting);
  sim.passengersServed += board;
  sim.metrics.boarded = (sim.metrics.boarded ?? 0) + board;
  const hour = Math.min(27, Math.floor(sim.t / 3600));
  sim.ridership.boardings[st][hour] += board;
  sim.ridership.alightings[st][hour] += alight;
  sim.ridership.maxLoad = Math.max(sim.ridership.maxLoad, tr.load);
  if (inPeakSection(sim.plan.dayType, st, sim.t))
    sim.ridership.peakSectionLoad = Math.max(sim.ridership.peakSectionLoad, tr.load);
  return passengerMinimum(board, alight, tr.load > LINE_INFO.capacity * .95, ps.surge);
}

/** boarding rate with the doors open: 8 cars x 5 doors, ~0.4 pax/s each 【假设】 */
const BOARD_RATE = 16;

/**
 * One tick of boarding while the doors stand open (an origin stop can wait
 * minutes for its departure): the platform keeps filling and the train takes
 * the newcomers, up to the crush load and BOARD_RATE per second 【假设】.
 * No alighting, and the dwell is not extended (late boarders do not hold the train).
 */
export function boardWhileOpen(sim: Sim, tr: Train, platform: number, task: StopTask, dt: number) {
  if (!task.doors || !task.revenue || task.noBoard || task.dep === null) return;
  // whole seconds only (the step is 0.1 s; waiting is a fraction)
  if (Math.floor(sim.t) === Math.floor(sim.t - dt)) return;
  const p = sim.topo.platforms[platform];
  const ps = sim.plat[p.pool ?? platform];
  const st = p.station;
  const room = Math.max(0, LINE_INFO.crushCapacity - tr.load);
  const board = Math.max(0, Math.min(Math.floor(ps.waiting), room, Math.ceil(BOARD_RATE * Math.max(1, dt))));
  if (board <= 0) return;
  ps.waiting -= board;
  tr.load += board;
  ps.stranded = Math.floor(ps.waiting);
  sim.passengersServed += board;
  sim.metrics.boarded = (sim.metrics.boarded ?? 0) + board;
  const hour = Math.min(27, Math.floor(sim.t / 3600));
  sim.ridership.boardings[st][hour] += board;
  sim.ridership.maxLoad = Math.max(sim.ridership.maxLoad, tr.load);
  if (inPeakSection(sim.plan.dayType, st, sim.t))
    sim.ridership.peakSectionLoad = Math.max(sim.ridership.peakSectionLoad, tr.load);
}
