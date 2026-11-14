/**
 * Parametric timetable (运行图) generation.
 *
 * Templates describe route patterns and reference headways. Independent
 * clock tables select calibrated dwell factors and running grades. The
 * generator lays out departure streams at a reference station per direction,
 * builds trips, links them into train blocks (车底运用) by FIFO matching at
 * each terminal, and closes the gaps with depot insertions (出库) and
 * withdrawals (回库) — revenue partial trips placed into gaps of the stream,
 * or non-revenue moves before/after service.
 */
import { parseTime } from './calendar';
import type { Topology } from './topology';
import { ahead, directionToward, nextStations, stablingBerth, stationPath } from './topology';
import type { RunTimes } from './dynamics';
import { cancelTrip, type Block, type DayType, type Plan, type PlanStop, type StopTask, type Task, type Trip, type TripKind, type TrackDir } from './model';
import { MIN_DWELL, plannedDwell } from './calibration';
import { STATIONS, OPERATIONS, LINE_INFO, DIRECTIONS, SIMULATION, stationOpened, type FixedRun } from '../data/current';
import { FIXED_LATE_TRAINS, POSSESSIONS } from '../data/current';
import { FIRST_LAST, OFFICIAL_HEADWAYS } from '../data/current';
import type { ClockBand } from '../data/simulation';
import { plannedWaiting } from './plannedWaiting';
import {  plannedWaitLong, plannedWaitBerth } from './plannedWaitBerth';
import { planDuties, type DutyInput } from './duty/planner';
import { overlayDuties } from './duty/overlay';

export interface Template {
  id: string;
  name: string;
  desc: string;
  /** per slot: 'big', 'small', or a route named in the line's `terminals.routes` */
  pattern: string[];
  /** headway between successive trains at the reference station (s) */
  headway: number;
  /** Directional service frequency, from the line's published headway table. */
  directionalHeadway?: Partial<Record<TrackDir, number>>;
  /** Leading peak wave and pattern phasing, read by the common stream rule. */
  peak?: boolean;
  openingAlternation?: boolean;
  phase?: Partial<Record<TrackDir, number>>;
  continuePattern?: boolean;
}

export const TEMPLATES: Record<string, Template> = SIMULATION.timetable.templates;

export interface Period { from: number; to: number; template: string; headway?: number; headwayTo?: number; label: string }

const DAY_PERIODS: Record<DayType, Period[]> = SIMULATION.timetable.dayPeriods;

/**
 * Service periods as shown to the dispatcher (header, timetable graph). The
 * generator's peak `from` is the time the whole core runs at peak, so the
 * reference stations densify well before it; these clocks are when the
 * passenger sees the change, read from the Gaode tables at 世纪公园 and
 * 张江高科 (reference/timetable-gaode/).
 */
const SHOWN_PERIODS: Record<DayType, Period[]> = SIMULATION.timetable.shownPeriods;

export function dayPeriods(dayType: DayType): Period[] {
  return DAY_PERIODS[dayType].map(p => ({ ...p }));
}

// D73/D74 calibration clocks are independent of service frequency and route patterns.
const DWELL_BANDS: Record<DayType, ClockBand[]> = SIMULATION.timetable.dwellBands;
const RUN_BANDS: Record<DayType, ClockBand[]> = SIMULATION.timetable.runBands;

const SERVICE_DATA = SIMULATION.timetable.serviceData;

// Published opening duties and depot operating windows, shared by all day types.
export const OPENING = SIMULATION.timetable.opening;
export const CARRY_MOVES = SIMULATION.timetable.carryMainlineMoves === true;

/** Margin of the outer (west of 淞虹路) alternation window inside a peak band:
 * the outer end leads (DN) or lags (UP) the core by its ~11 min running time,
 * plus the transition into the pattern. */
export const OUTER_BAND_MARGIN = SIMULATION.timetable.outerBandMargin;
/** whether a time at an outer station falls in a peak's 2'30"/5'00" pattern */
export function inOuterAlternation(periods: Period[], t: number): boolean {
  return periods.some(p => {
    const template = TEMPLATES[p.template], pattern = template.pattern;
    const alternating = pattern.length >= 3 && pattern.some((kind, i) => kind === 'big'
      && pattern[(i + 1) % pattern.length] === 'big' && pattern[(i + 2) % pattern.length] === 'small');
    return template.peak && alternating && t >= p.from + OUTER_BAND_MARGIN && t < p.to - OUTER_BAND_MARGIN;
  });
}

// ---------------------------------------------------------------- overlays (加开)

export interface OverlayPreset { id: string; label: string; from: number; to: number; a: number; b: number; headway: number; desc: string }

export const OVERLAY_PRESETS: OverlayPreset[] = SIMULATION.timetable.overlays;

// ---------------------------------------------------------------- helpers

/** fixedRuns: the fixed-time special trains of the day (default: the regular ones) */
export interface PlanContext { topo: Topology; rt: RunTimes; dayType: DayType; fixedRuns?: FixedRun[]; initialStock?: number[] }

export const stationIndex = (id: string | undefined) => STATIONS.findIndex(st => st.id === id);
const stationTable = <T>(table: Record<string, T>): Record<number, T> =>
  Object.fromEntries(Object.entries(table).map(([id, value]) => [stationIndex(id), value]));
export const [CORE_W, CORE_E] = SIMULATION.timetable.terminals.core.map(stationIndex);
const INSERT_ORIGIN = stationIndex(SIMULATION.timetable.terminals.insertOrigin);

export const TERMINAL_DEPOT = stationTable(SIMULATION.timetable.terminals.depot);
/** trains a terminal can hold at once: two tail tracks or paired stubs + the
 * departure platform; 广兰路 turns on its single middle-track platform */
const TERMINAL_CAP = stationTable(SIMULATION.timetable.terminals.capacity);
/**
 * trains the circulation lets lay over at a terminal at once. At the line ends
 * this is the full terminal: the peak cycle there leaves a turn just short of
 * the 240 s minimum, so each train waits for the next slot but one, and with
 * only two places that third train would be sent to the depot and replaced by
 * a fresh one every cycle, breaking the west-end 2'30"/5'00" pattern. An
 * insertion into a full terminal is caught by the validator (D7).
 */
export const MAX_PRESENT = stationTable(SIMULATION.timetable.terminals.maxPresent);
/** An omitted operational override never creates an extra physical berth. */
export function terminalCapacity(topo: Topology, station: number): number {
  return TERMINAL_CAP[station] ?? (topo.stations[station].turnbackBerths.length || 1);
}
/** longest a train may wait at a terminal between trips (s) */
export const MAX_LAYOVER = 1500;
/**
 * Hot standby (热备车, D70): off-peak each line end keeps one train of its
 * turning cycle aside, crewed, in one of its two turnback tracks; the other
 * trains turn through the other track. From `from` the first train the line
 * end has to spare (a third one laying over there) stays; with none to spare
 * by an hour later the next arrival stays anyway and a train comes out of the
 * yard for the departure it would have taken. From `need` it takes the first
 * departure the line end has no train for (the peak build-up: both tracks
 * turn again); at `to` it rejoins the cycle, or goes back to the yard.
 */
interface StandbyWindow { from: number; need: number; to: number }
export function standbyWindows(dayType: DayType, place?: { windows?: Partial<Record<DayType, StandbyWindow[]>> }): StandbyWindow[] {
  return place?.windows?.[dayType] ?? SERVICE_DATA[dayType].standby;
}

export function hotStandbyPlaces(topo: Topology) {
  return OPERATIONS.hotStandby.map(rule => {
    const station = STATIONS.findIndex(st => st.id === rule.station);
    const st = topo.stations[station];
    const berth = stablingBerth(topo, (rule.track === 'storage' ? st.storageBerths : st.turnbackBerths)[rule.berth]);
    return { ...rule, station, berth };
  });
}

/** The same physical slot has a stopping point for each permitted heading. */
export function storageArrivalBerth(topo: Topology, berth: number, dir: TrackDir): number | undefined {
  return topo.berths.find(b => b.link === topo.berths[berth].link
    && ((topo.links[b.link].chainB - topo.links[b.link].chainA) * b.dir > 0) === (dir === 'DN'))?.id;
}
/** longest an added train running on in its own direction may stand at an
 *  intermediate station's through platform before its next trip (s): any
 *  longer and the following train queues behind it */
export const THROUGH_WAIT = 60;
/** longest an intermediate turnback holds a car beyond its minimum turn (s): D42, the
 *  intermediate-terminal layover limit (validatePlan LAYOVER_LONG); also the 广兰路
 *  middle-track turn window of D48 (「一两个时隙内折返」) */
export const INTERMEDIATE_WAIT = 450;
/** 广兰路 single middle track (D48): the departing train has cleared the west throat and
 *  the next arrival's route into the middle track is set within this time (s) */
const CORE_CLEAR = 60;
export function depotIndex(topo: Topology, key: string): number {
  return topo.depots.findIndex((d) => d.key === key);
}

/** first station of a move out of `depot` heading `dir` (its first trip starts
 * there); the move may reach it against the direction and change ends there */
export function exitStation(topo: Topology, depot: number, dir: TrackDir): number {
  return topo.depots[depot].portals.exit[dir].station;
}
/** last station before `depot` for a train running `dir` */
export function entryStation(topo: Topology, depot: number, dir: TrackDir): number {
  return topo.depots[depot].portals.entry[dir].station;
}
/** May a depot move change ends on the junction station's platform (OPERATIONS.portalReversal)?
 * 'yes': no reversal needed or the station allows it; 'fallback': only when a turn beyond does
 * not fit (early pull-out / night pull-in); 'no': turn at the next turnback beyond instead. */
export function portalReversal(topo: Topology, depot: number, kind: 'exit' | 'entry', dir: TrackDir, at: number): 'yes' | 'fallback' | 'no' {
  const portal = topo.depots[depot].portals[kind][dir], rule = OPERATIONS.portalReversal;
  if (!portal.reverse || !rule?.stations.includes(STATIONS[portal.station].id)) return 'yes';
  const clock = parseTime(kind === 'exit' ? rule.pullOutBefore : rule.pullInFrom);
  return (kind === 'exit' ? at < clock : at >= clock) ? 'fallback' : 'no';
}
/** extra time a depot move spends changing ends at its junction station (s) */
const PORTAL_REVERSE = 90;
/** 【假设】extra time a move over a 牵出线 lead spends running to its end and changing ends (s) */
const SHUNT_REVERSE = 150;

export function minTurn(st: number): number {
  const id = STATIONS[st].id;
  return OPERATIONS.minTurnback[id] ?? 330;
}

/** 用户决定（2026-11-08）：出库的车早高峰结束（OPERATIONS.noDepotReturnBefore）前不回库 (s; none: -Infinity) */
export function noDepotReturnBefore(): number {
  return OPERATIONS.noDepotReturnBefore ? parseTime(OPERATIONS.noDepotReturnBefore) : -Infinity;
}
/** 【假设】a car counts as turned at a line end this long after its minimum turn (s): the duty
 * planner's berth and front-route checks reject a turn with no slack at all */
export const LINE_END_TURN_SLACK = 60;
/**
 * Longest a car arriving at `arrival` stands at line end (or own-track turnback) `st` before it
 * takes one of the departures `leaving` (sorted) there: its turn and one departure interval, the
 * published one or the gap the first departure after its turn leaves behind (where they alternate,
 * 150/300 s at the airport in the peak, a car that just missed one waits the local gap: no queue
 * either), at most MAX_LAYOVER. A car arriving before `standUntil` may stand on until then
 * (OPERATIONS.noDepotReturnBefore: the morning's surplus cars wait on their tracks for later
 * departures; the berth occupancy is the duty planner's reserve). One rule for the diagram's
 * balance (layoutService) and the duty planner (duty/moves.ts).
 */
export function lineEndStand(dayType: DayType, st: number, arrival: number, leaving: readonly number[], standUntil = -Infinity): number {
  const i = leaving.findIndex(t => t >= arrival + minTurn(st));
  const local = i > 0 ? leaving[i] - leaving[i - 1] : undefined;
  const official = officialEndInterval(dayType, st, arrival);
  const stand = Math.min(MAX_LAYOVER, minTurn(st) + Math.max(official ?? 0, local ?? (official === undefined ? MAX_LAYOVER : 0)));
  return arrival < standUntil ? Math.max(stand, standUntil - arrival) : stand;
}
/** FIFO turns at line end `st`: each arrival (sorted times) is ready LINE_END_TURN_SLACK after its minimum
 * turn and stands at most lineEndStand, no more cars standing than the end's `capacity` (the latest
 * arrival is the one left out); returns the departures (sorted times) no car reaches and the arrivals
 * (indices) left over */
export function lineEndTurns(dayType: DayType, st: number, arrivals: readonly number[], departures: readonly number[], capacity: number, standUntil = -Infinity) {
  const turn = minTurn(st) + LINE_END_TURN_SLACK;
  const ready: number[] = [], short: number[] = [], spare: number[] = [];
  let next = 0;
  for (const at of departures) {
    while (next < arrivals.length && arrivals[next] + turn <= at + 1e-6) ready.push(next++);
    while (ready.length && at - arrivals[ready[0]] > lineEndStand(dayType, st, arrivals[ready[0]], departures, standUntil) + 1e-6) spare.push(ready.shift()!);
    while (ready.length > capacity) spare.push(ready.pop()!);
    if (ready.length) ready.shift(); else short.push(at);
  }
  for (; next < arrivals.length; next++) ready.push(next);
  return { short, spare: [...spare, ...ready] };
}

export function overnightPlaces(topo: Topology) {
  return OPERATIONS.overnightStabling.flatMap(rule => {
    const station = STATIONS.findIndex(st => st.id === rule.station);
    const st = topo.stations[station];
    return Array.from({ length: rule.count }, (_, index) => {
      const stored = stablingBerth(topo, rule.kind === 'feeder' ? st.storageBerths[index] : st.turnbackBerths[index]);
      const berth = rule.kind === 'platform'
        ? rule.track === 'turnback' ? departureBerthAfterReverse(topo, st.turnbackBerths[index], platformBerth(topo, station, rule.departure))
          : platformBerth(topo, station, rule.departure)
        : rule.kind === 'feeder' && rule.preserveService && stored !== undefined ? storageArrivalBerth(topo, stored, rule.departure) : stored;
      if (berth === undefined) throw new Error(`${STATIONS[station].name} 缺少过夜泊位 ${index + 1}`);
      return { ...rule, station, berth, arrivalBerth: rule.kind === 'platform' && rule.track === 'turnback' ? stablingBerth(topo, st.turnbackBerths[index]) : berth };
    });
  });
}

const FIRST_LAST_COLUMNS = [['firstE', 'DN'], ['firstW', 'UP'], ['lastE', 'DN'], ['lastW', 'UP'], ['lastG', 'DN']] as const;
const officialClock = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 3600 + m * 60; };

/** D162 用户决定: a published first / last train keeps the official departure
 * minute at every station it is the published train for. A trip is that train
 * when it leaves the start of an official column at its minute; the column
 * runs on while its minutes do not decrease (a decrease is another train). */
export function officialTimingPoints(dir: TrackDir, from: number, to: number, originDep: number, last?: { train: boolean }): Map<number, number> {
  const points = new Map<number, number>();
  const sts = stationPath(from, to);
  const row = (st: number) => FIRST_LAST.find(r => r.station === STATIONS[st]?.name);
  for (const [key, d] of FIRST_LAST_COLUMNS) {
    if (d !== dir) continue;
    const own = row(from)?.[key];
    if (!own || Math.abs(officialClock(own) - originDep) >= 60) continue;
    if (nextStations(dir === 'DN' ? 'UP' : 'DN', from, STATIONS.length).some(st => { const upstream = row(st)?.[key]; return upstream && officialClock(upstream) <= officialClock(own); })) continue;
    if (last && key.startsWith('last')) last.train = true;
    let prev = -Infinity;
    for (const st of sts) {
      const v = row(st)?.[key];
      if (!v || officialClock(v) < prev) break;
      prev = officialClock(v);
      points.set(st, prev);
    }
  }
  return points;
}

/** dwellFactor: a constant, or the factor in force at each stop's arrival time. */
export function buildStops(ctx: PlanContext, dir: TrackDir, from: number, to: number, originDep: number, revenue: boolean, dwellFactor: number | ((t: number) => number), stopsAt?: (st: number) => boolean, timingPoints = true): PlanStop[] {
  const sts = stationPath(from, to);
  const stops: PlanStop[] = [];
  const last = { train: false };
  const points = revenue && timingPoints ? officialTimingPoints(dir, from, to, originDep, last) : new Map<number, number>();
  // run supplement per stop since the last timing point (allowance and the
  // level slow-down over the level-1 physical run): the only time a late
  // published train may give back; physical runs and dwells are kept
  const slack: number[] = [], allowance: number[] = [];
  // 用户决定（2026-11-05，D178）: a published last train still late after
  // that also shortens its intermediate dwells, down to the minimum dwell
  const dwellSlack: number[] = [];
  let pointAt = 0;
  let t = originDep;
  // pass times already include the platform pass limit (any train, 跨站 or empty)
  for (let k = 0; k < sts.length; k++) {
    const st = sts[k];
    if (k === 0) { stops.push({ st, arr: t, dep: t, stop: stationOpened(st) }); continue; }
    const prev = sts[k - 1];
    const idx = Math.min(prev, st);
    const prevStops = stops[k - 1].stop;
    const isLast = k === sts.length - 1;
    const stopHere = stationOpened(st) && (isLast || (stopsAt ? stopsAt(st) : revenue));
    const { level: runLevel, allowanceS } = prevStops && stopHere
      ? plannedRunProfile(ctx.dayType, t, prev, st) : plannedRunProfile(ctx.dayType, t);
    stops[k - 1].runLevel = runLevel;
    const rt = runLevel === 1 ? ctx.rt : ctx.rt.byLevel?.[runLevel] ?? ctx.rt;
    const pass = dir === 'DN' ? rt.passDn : rt.passUp;
    let run: number;
    if (prevStops && stopHere) {
      run = dir === 'DN' ? rt.dn[idx] : rt.up[idx];
      // Keep the default table byte-identical, including floating point bits.
      if (allowanceS !== OPERATIONS.sectionRunAllowanceS) run += allowanceS - OPERATIONS.sectionRunAllowanceS;
    } else run = pass[idx] + (prevStops ? 10 : 0) + (stopHere ? 12 : 0);
    const level1 = dir === 'DN' ? ctx.rt.dn[idx] : ctx.rt.up[idx];
    slack[k] = prevStops && stopHere ? Math.max(0, run - level1 + OPERATIONS.sectionRunAllowanceS) : 0;
    allowance[k] = prevStops && stopHere ? allowanceS : 0;
    // (below the physical run, so not part of the supplement a late train gives back)
    if (last.train && prevStops && stopHere) run -= SIMULATION.timetable.lastTrainRunGain
      ?.find(g => g.from === STATIONS[prev]?.id && g.to === STATIONS[st]?.id)?.s ?? 0;
    const arr = t + run;
    const dw = stopHere && !isLast ? plannedDwell(ctx.dayType, st, dir, arr, typeof dwellFactor === 'function' ? dwellFactor(arr) : dwellFactor) : 0;
    stops.push({ st, arr, dep: arr + dw, stop: stopHere });
    dwellSlack[k] = last.train && stopHere && !isLast ? Math.max(0, dw - MIN_DWELL) : 0;
    t = arr + dw;
    const point = points.get(st);
    if (point === undefined || !stopHere) continue;
    // late: give back run supplement since the last point, evenly, up to the
    // published minute; early: wait at the platform for it (等点)
    const late = (isLast ? arr : t) - point;
    if (late > 0) {
      let total = 0;
      for (let j = pointAt + 1; j <= k; j++) total += slack[j];
      const f = total > 0 ? Math.min(1, late / total) : 0;
      let shift = 0;
      for (let j = pointAt + 1; j <= k; j++) {
        const given = slack[j] * f;
        shift += given;
        stops[j].arr -= shift;
        stops[j].dep -= shift;
        // giving back more than the allowance needs the level-1 profile
        if (given > allowance[j] + 1e-6) stops[j - 1].runLevel = 1;
        slack[j] -= given;
        allowance[j] = Math.max(0, allowance[j] - given);
      }
      // only what is past the published minute itself
      const still = late - shift - 59;
      // the previous point may leave earlier, but never before its own minute
      const prevPoint = pointAt > 0 ? points.get(stops[pointAt].st) : undefined;
      const room = (j: number) => j === pointAt
        ? (prevPoint === undefined ? 0 : Math.min(dwellSlack[j], Math.max(0, stops[j].dep - prevPoint)))
        : j < k || !isLast ? dwellSlack[j] : 0;
      let dwells = 0;
      for (let j = pointAt; j <= k; j++) dwells += room(j);
      if (still > 1e-6 && dwells > 0) {
        const g = Math.min(1, still / dwells);
        let cut = 0;
        for (let j = pointAt; j <= k; j++) {
          if (j > pointAt) stops[j].arr -= cut;
          const own = room(j) * g;
          cut += own;
          stops[j].dep -= cut;
          dwellSlack[j] -= own;
        }
      }
      t = stops[k].dep;
    }
    if (!isLast && t < point) { stops[k].dep = point; t = point; }
    pointAt = k;
  }
  return stops;
}

/** Invert a reference clock without inventing holds. Clock-band changes can
 * make fixed-point iteration alternate between two profiles. Search that
 * local piecewise curve for a real solution instead of publishing its eighth
 * iterate as though it were the requested slot. */
export function stopsAtReference(build: (origin: number) => PlanStop[], reference: number, departure: number): PlanStop[] {
  const evaluate = (origin: number) => {
    const stops = build(origin);
    return { origin, stops, error: stops.find(stop => stop.st === reference)!.dep - departure };
  };
  const samples = [evaluate(departure)];
  let best = samples[0];
  for (let i = 0; i < 8 && Math.abs(best.error) >= .001; i++) {
    const last = samples.at(-1)!;
    const next = evaluate(last.origin - last.error);
    samples.push(next);
    if (Math.abs(next.error) < Math.abs(best.error)) best = next;
    if (Math.abs(next.error) < .001) return next.stops;
  }
  if (Math.abs(best.error) < .001) return best.stops;
  // The first sample starts at the reference clock, before the inverse has
  // located the origin. Search only the subsequent local iterates.
  const local = samples.slice(1), pad = Math.max(...local.map(sample => Math.abs(sample.error)), 1);
  const lo = Math.min(...local.map(sample => sample.origin)) - pad;
  const hi = Math.max(...local.map(sample => sample.origin)) + pad;
  let left = evaluate(lo);
  for (let i = 1; i <= 32; i++) {
    const right = evaluate(lo + (hi - lo) * i / 32);
    if (Math.abs(right.error) < Math.abs(best.error)) best = right;
    if (Math.abs(best.error) < .001) return best.stops;
    if (left.error * right.error < 0) {
      let a = left, b = right;
      for (let j = 0; j < 32 && b.origin - a.origin > 1e-6; j++) {
        const mid = evaluate((a.origin + b.origin) / 2);
        if (Math.abs(mid.error) < Math.abs(best.error)) best = mid;
        if (Math.abs(best.error) < .001) return best.stops;
        if (a.error * mid.error <= 0) b = mid; else a = mid;
      }
    }
    left = right;
  }
  // A genuine upward jump may have no exact inverse. Retain the closest
  // physical curve; never compress a run or create a negative allowance.
  return best.stops;
}

export function periodAt(periods: Period[], t: number): Period {
  // Diagram solvers probe elapsed runs from t=0 before service opens.
  // Use the opening defaults there, rather than the final night's level.
  if (periods.length && t < periods[0].from) return periods[0];
  for (const p of periods) if (t >= p.from && t < p.to) return p;
  return periods[periods.length - 1];
}

function clockValue(bands: ClockBand[], t: number): number {
  const band = bands.find(b => t < b.to) ?? bands[bands.length - 1];
  if (band.valueTo === undefined) return band.value;
  const fraction = Math.max(0, Math.min(1, (t - band.from) / (band.to - band.from)));
  return band.value + (band.valueTo - band.value) * fraction;
}

export function dwellFactorAt(dayType: DayType, t: number): number {
  return clockValue(DWELL_BANDS[dayType], t);
}

export function plannedRunLevel(dayType: DayType, departure: number, from?: number, to?: number): number {
  return plannedRunProfile(dayType, departure, from, to).level;
}

/** The same selected profile supplies level and stop-to-stop running margin.
 * RunTimes already contains the default margin; buildStops replaces it once.
 * Pass runs retain their separate timing model, and ATP never reads this pad. */
export function plannedRunProfile(dayType: DayType, departure: number, from?: number, to?: number): { level: number; allowanceS: number } {
  if (from !== undefined && to !== undefined) {
    const section = SIMULATION.timetable.sectionRunBands?.[dayType]?.find(section =>
      section.from === STATIONS[from]?.id && section.to === STATIONS[to]?.id);
    const band = section?.bands.find(band => departure >= band.from && departure < band.to);
    if (band) return { level: clockValue([band], departure),
      allowanceS: Math.max(0, band.allowanceS ?? OPERATIONS.sectionRunAllowanceS) };
  }
  return { level: clockValue(RUN_BANDS[dayType], departure), allowanceS: OPERATIONS.sectionRunAllowanceS };
}

// ---------------------------------------------------------------- generation

export interface GenTrip extends Trip { next?: number; prev?: number }
/** Candidate depot moves dropped during matching have never been published. */
const UNUSED_DEPOT_MOVE = -2;
/** Select a route while drafting service data, before train matching. */
function trimRoute(trip: Pick<ServiceRequest, 'from' | 'to' | 'kind' | 'stops'>, from: number, to: number, kind: TripKind) {
  trip.from = from;
  trip.to = to;
  trip.kind = kind;
  trip.stops = trip.stops.filter(p => p.st >= Math.min(from, to) && p.st <= Math.max(from, to));
  trip.stops[0].arr = trip.stops[0].dep;
  trip.stops.at(-1)!.dep = trip.stops.at(-1)!.arr;
}

type ServiceIdentity = Pick<Trip, 'dir' | 'from' | 'to' | 'kind'> & { stations: number[] };
const laidOutService = new WeakMap<Plan, Map<Trip, ServiceIdentity>>();
const generationIssues = new WeakMap<Plan, PlanIssue[]>();
const rejectedTurns = new WeakMap<Plan, string[]>();

/** Matching diagnostics, numbered only after publishing the retained trips. */
export function terminalReuseRejections(plan: Plan): readonly string[] {
  return rejectedTurns.get(plan) ?? [];
}

function serviceIdentity(trip: Trip): ServiceIdentity {
  return { dir: trip.dir, from: trip.from, to: trip.to, kind: trip.kind, stations: trip.stops.map(p => p.st) };
}

/** The same guard is used in generation and by regressions which mutate a plan. */
export function serviceStructureIssues(plan: Plan): PlanIssue[] {
  const service = laidOutService.get(plan);
  if (!service) return [];
  const present = new Set(plan.trips);
  const issues: PlanIssue[] = [];
  for (const [trip, expected] of service) {
    if (present.has(trip) && !trip.cancelled && JSON.stringify(serviceIdentity(trip)) === JSON.stringify(expected)) continue;
    issues.push({ severity: 'error', code: 'SERVICE_STRUCTURE', t: trip.stops[0].dep, blocks: [trip.block], text: `已铺画载客车次 ${trip.no || trip.id} ${expected.from}→${expected.to} (${expected.kind}) ${!present.has(trip) ? '已丢失' : trip.cancelled ? '被取消' : `变成 ${trip.from}→${trip.to} (${trip.kind})`}` });
  }
  return issues;
}

/** Added service may keep a train of the base plan in service instead of
 * bringing another out of the depot (延长运用, D47). `canExtend` says whether
 * the train of a block is still able to take more trips after `last`. */
export interface OverlayReuse {
  nightPlaces?: ReturnType<typeof overnightPlaces>;
  blocks: Block[];
  canExtend: (block: number, last: number) => boolean;
  now: number;
  /** filled in: blocks of the base plan that now continue into added trips */
  extended: { block: number; last: number; trips: number[]; tail: number[]; end: Block['end'] }[];
  /** Depot corrections already required by cancelled base duties. */
  returnShift?: number[];
  stock?: { at: number; levels: number[]; departed: number[]; done: number[] };
  /** filled in: base duties taken over by an added train (`into`, the added
   * block): `trips` moved over, `lead` its cancelled yard exit */
  absorbed?: { block: number; into: number; trips: number[]; lead: number[]; end: Block['end'] }[];
}

/** a train returning to the yard is counted in stock this long after its last arrival (s) */
export const DEPOT_ENTRY_CLEAR = 300;

export interface YardMove { time: number; depot: number; delta: number; block: number; trip?: number; berth?: number; link?: number; window?: [number, number] }

/** The yard exits and entries of every duty that still runs: an exit at its
 * start, an entry DEPOT_ENTRY_CLEAR after its last live arrival, or at its
 * actual withdrawal. One definition for planning, validation and live stock. */
export function depotMoves(blocks: readonly Block[], trips: readonly Trip[], ctx?: Pick<PlanContext, 'topo'>): YardMove[] {
  const out: YardMove[] = [];
  for (const block of blocks) {
    const live = block.trips.map(id => trips[id]).filter(trip => !trip.cancelled);
    if (!live.length && !block.withdrawal) continue;
    if (block.start.kind === 'depot') out.push({ time: block.start.time, depot: block.start.depot, delta: -1, block: block.id, trip: live[0]?.id });
    if (block.withdrawal) out.push({ time: block.withdrawal.at, depot: block.withdrawal.depot, delta: 1, block: block.id });
    else if (block.end.kind === 'depot') {
      const last = live.at(-1)!, actual = effectiveTrip(last), arrival = actual?.stops.at(-1);
      if (arrival) out.push({ time: arrival.arr + DEPOT_ENTRY_CLEAR, depot: block.end.depot, delta: 1, block: block.id, trip: last.id });
    }
  }
  if (ctx) for (const move of out) {
    const original = move.trip === undefined ? undefined : trips[move.trip];
    const trip = original && move.delta > 0 ? effectiveTrip(original) : original;
    if (!trip) continue; // A live withdrawal has no scheduled approach window.
    const yard = ctx.topo.depots[move.depot];
    const lead = depotLeadLink(ctx.topo, move.depot, move.delta > 0, trip.dir);
    if (lead === undefined) continue;
    // Entry tasks select this berth, which identifies the actual lead.
    if (move.delta > 0) move.berth = yard.entryBerths[yard.portals.entry[trip.dir].path];
    move.link = lead;
    move.window = move.delta > 0 ? inboundWindow(ctx.topo, move.depot, trip) : outboundWindow(ctx, move.depot, trip);
    if (move.delta < 0) move.window[0] = move.time;
  }
  return sortDepotMoves(out);
}

/** The transfer track a yard move in `dir` occupies when entries and exits
 * share it (a one-way lead has none): two moves conflict only on the same one. */
export function depotLeadLink(topo: Topology, depot: number, entry: boolean, dir: TrackDir): number | undefined {
  const yard = topo.depots[depot];
  const path = yard.transferPaths[(entry ? yard.portals.entry : yard.portals.exit)[dir].path];
  return path.flow === 'shared' ? path.stub : undefined;
}

/** chronological; at the same instant exits before entries */
export function sortDepotMoves<T extends { time: number; delta: number }>(moves: T[]): T[] {
  return moves.sort((a, b) => a.time - b.time || a.delta - b.delta);
}

/** trains each yard must hold at the start of the day: its largest deficit of exits over returns */
export function depotStockRequirements(topo: Topology, plan: Plan, capacity = topo.depots.map(depot => depot.capacity)) {
  const balance = topo.depots.map(() => 0), need = topo.depots.map(() => 0);
  const deadlines = topo.depots.map(() => [] as number[]);
  const events = depotMoves(plan.blocks, plan.trips);
  for (const move of events) {
    const depot = move.depot;
    balance[depot] += move.delta;
    need[depot] = Math.max(need[depot], -balance[depot]);
    while (need[depot] > capacity[depot] + deadlines[depot].length) deadlines[depot].push(move.time);
  }
  return { need, deadlines, events };
}
export function yardNeed(topo: Topology, plan: Plan): number[] {
  return depotStockRequirements(topo, plan).need;
}
/** Physical morning stock, including unused spares. Shared by initialization
 * and the daily ledger, so validation cannot silently invent extra vehicles. */
export function initialDepotStock(topo: Topology, plan: Plan): number[] {
  if (plan.initialStock) return plan.initialStock.slice();
  const stock = yardNeed(topo, plan);
  let fleet = stock.reduce((a, b) => a + b, 0)
    + plan.blocks.filter(block => block.start.kind === 'stable').length;
  // 【假设】D178: with no train on the main line overnight the fleet outgrows
  // the stabling tracks; the spares beyond them go to a yard with a workshop,
  // where maintainFleet stands them in the shed ('stored', not maintenance).
  const room = (d: number) => topo.depots[d].capacity - stock[d];
  while (fleet < LINE_INFO.fleet) {
    const order = topo.depots.map((_, d) => d).sort((a, b) => room(b) - room(a));
    const depot = room(order[0]) > 0 ? order[0] : order.find(d => topo.depots[d].work.monthly) ?? order[0];
    stock[depot]++;
    fleet++;
  }
  return stock;
}

export function depotLedger(topo: Topology, plan: Plan) {
  const initial = initialDepotStock(topo, plan);
  const events = depotMoves(plan.blocks, plan.trips);
  const final = initial.slice(), peak = initial.slice(), peakAt = topo.depots.map(() => OPENING.dayStart);
  for (const event of events) {
    final[event.depot] += event.delta;
    if (final[event.depot] > peak[event.depot]) {
      peak[event.depot] = final[event.depot];
      peakAt[event.depot] = event.time;
    }
  }
  return { initial, final, peak, peakAt, events };
}

/** `shift`: per yard, how many of its earliest morning exits another yard
 *  takes (a second pass when the first one needed more than a yard holds) */
export function layoutService(ctx: PlanContext) {
  const { topo } = ctx;
  const periods = dayPeriods(ctx.dayType);
  const service = SERVICE_DATA[ctx.dayType];
  const trips: ServiceRequest[] = [];
  const issues: PlanIssue[] = [];
  const nS = topo.stations.length;
  const [W, E] = SIMULATION.timetable.terminals.trunk?.map(stationIndex) ?? [0, nS - 1];
  /** a pattern entry that names a route of the line's data: its ends, DN-ward */
  const namedRoute = (kind: string) => SIMULATION.timetable.terminals.routes?.[kind]?.map(stationIndex);
  const DN_REF = stationIndex(SIMULATION.timetable.reference?.DN) >= 0 ? stationIndex(SIMULATION.timetable.reference?.DN) : CORE_W;
  const UP_REF = stationIndex(SIMULATION.timetable.reference?.UP) >= 0 ? stationIndex(SIMULATION.timetable.reference?.UP) : CORE_E;


  let upPhase = 10; // UP peak phase, aligned to the first airport train below.
  /** the published first trains from their origins: they open each station */
  const firstService: ServiceRequest[] = [];

  const addTrip = (dir: TrackDir, kind: TripKind, from: number, to: number, stops: PlanStop[], revenue: boolean, overlay?: string): ServiceRequest => {
    const tr: ServiceRequest = { id: trips.length, dir, kind, from, to, stops, revenue, overlay };
    trips.push(tr);
    return tr;
  };

  const factorAt = (t: number) => dwellFactorAt(ctx.dayType, t);
  // The opening grid starts at the published train's actual curve. Keep
  // its origin fixed; ordinary slots still use the unheld inverse below.
  const firstCurves = {
    DN: buildStops(ctx, 'DN', W, E, OPERATIONS.firstWestTerminusDep, true, factorAt),
    UP: buildStops(ctx, 'UP', E, W, OPERATIONS.firstEastTerminusDep, true, factorAt),
  };
  const lastCurves = {
    DN: buildStops(ctx, 'DN', W, E, OPERATIONS.lastBigEastboundDep, true, factorAt),
    UP: buildStops(ctx, 'UP', E, W, OPERATIONS.lastBigWestboundDep, true, factorAt),
  };
  const lastReference = {
    DN: lastCurves.DN.find(stop => stop.st === DN_REF)!.dep,
    UP: lastCurves.UP.find(stop => stop.st === UP_REF)!.dep,
  };
  const lastAnchors: ServiceRequest[] = [];
  // A final candidate that collides with the published curve owns that
  // boundary slot instead. Never publish it and then consume its predecessor.
  const precedesLast = (dir: TrackDir, stops: PlanStop[]) => {
    const last = lastCurves[dir];
    return stops.every(stop => {
      const following = last.find(call => call.st === stop.st);
      return !following || stop.dep + MIN_HEADWAY <= following.dep + 1e-6;
    }) && new DepIndex([{ stops: last, dir }]).clear(stops, dir);
  };
  // A peak is a whole-core promise, not an origin departure change. Allow
  // the complete core traversal plus one headway for its leading wave.
  const peaks = periods.filter(p => TEMPLATES[p.template].peak);
  const waves = periods.filter(p => TEMPLATES[p.template].peak || service.peaks[p.template]);
  const peakHw = (p: Period, dir?: TrackDir) => (dir && TEMPLATES[p.template].directionalHeadway?.[dir]) ?? TEMPLATES[p.template].headway;
  const coreLead = new Map(peaks.map(p => {
    const hw = peakHw(p);
    const lead = Math.max(...(['DN', 'UP'] as const).map(dir => {
      const from = dir === 'DN' ? CORE_W : CORE_E, to = dir === 'DN' ? CORE_E : CORE_W;
      const stops = buildStops(ctx, dir, from, to, p.from, true, factorAt);
      return stops.at(-1)!.arr - p.from + hw + 30;
    }));
    return [p, Math.ceil(lead / hw) * hw] as const;
  }));
  if (peaks.length) {
    const first = firstCurves.UP.find(s => s.st === CORE_E)!.dep;
    const anchor = peaks[0].from - coreLead.get(peaks[0])!;
    const hw = peakHw(peaks[0]);
    // Keep the official 06:00 origin on the AM core grid, instead of adding
    // an off-grid first train which disrupts the western 1:2 alternation.
    upPhase = ((first - anchor) % hw + hw) % hw;
  }
  const morningUpStart = service.denseUp === undefined ? undefined : service.denseUp + upPhase;
  const peakStart = (p: Period, dir: TrackDir) => service.peaks[p.template]?.[dir]
    ?? (dir === 'UP' && morningUpStart !== undefined ? morningUpStart : p.from - (coreLead.get(p) ?? 0));
  /** Reference-station service waves; all directional differences come from data. */
  const streamAt = (t: number, dir: TrackDir): Period & { steady?: boolean } => {
    const override = service.overrides.find(p => p.dir === dir && t >= p.from && t < p.to);
    if (override) return override;
    if (morningUpStart !== undefined && t < morningUpStart) {
      if (dir === 'UP') return { ...service.openingUp!, from: service.openingUp!.at, to: morningUpStart };
      const start = peakStart(peaks[0], dir);
      if (t < start) return { from: 0, to: start, template: peaks[0].template, headway: service.openingDn!.find(p => t < p.to)!.headway, label: '东行开班过渡' }; // 【假设】
    }
    for (const peak of waves) {
      if (!TEMPLATES[peak.template].peak && service.peaks[peak.template]?.[dir] === undefined) continue;
      const hw = peakHw(peak, dir);
      const start = peakStart(peak, dir), transition = start - OUTER_BAND_MARGIN;
      const end = dir === 'UP' ? service.peaks[peak.template]?.upEnd ?? peak.to : peak.to;
      if (t >= start && t < end) return { ...peak, from: start, headway: hw, steady: true };
      if (t >= transition && t < start) {
        const before = periodAt(periods, transition);
        const prev = Math.max(hw, before.headway ?? TEMPLATES[before.template].headway);
        return { ...peak, from: transition, to: start, headway: hw + (prev - hw) * (start - t) / OUTER_BAND_MARGIN, label: `${peak.label}渐进预置` };
      }
    }
    return periodAt(periods, t);
  };
  const headwayAt = (t: number, dir: TrackDir) => {
    const p = streamAt(t, dir);
    const start = p.headway ?? TEMPLATES[p.template].directionalHeadway?.[dir] ?? TEMPLATES[p.template].headway;
    return p.headwayTo === undefined ? start : start + (p.headwayTo - start) * Math.max(0, Math.min(1, (t - p.from) / (p.to - p.from)));
  };

  // Solve the origin departure so every big/small train uses the same core
  // slot, with the demand at its actual stop times. Intermediate holds are
  // never used to achieve phasing.
  const atReference = (dir: TrackDir, from: number, to: number, ref: number, departure: number) => {
    // slots are placed on unheld run times; a published train then keeps its minutes
    const stops = stopsAtReference(origin => buildStops(ctx, dir, from, to, origin, true, factorAt, undefined, false), ref, departure);
    return buildStops(ctx, dir, from, to, stops[0].dep, true, factorAt);
  };
  const nextSlot = (t: number, dir: TrackDir) => {
    const p = streamAt(t, dir);
    const candidate = t + headwayAt(p.steady ? t : t + headwayAt(t, dir) / 2, dir);
    if (morningUpStart !== undefined && dir === 'UP' && t < morningUpStart && candidate >= morningUpStart) return morningUpStart;
    // The closing stream is counted back from the official last train, so it
    // is joined on that grid at its first slot, not one headway after it.
    const end = lastReference[dir], closing = streamAt(end, dir);
    if (closing.headwayTo === undefined && !TEMPLATES[closing.template].peak && t < closing.from - 1e-6 && candidate >= closing.from - 1e-6) {
      const h = headwayAt(end, dir);
      const first = end - Math.floor((end - closing.from + 1e-6) / h) * h;
      return first - t >= MIN_HEADWAY ? first : first + h;
    }
    // Join a data-anchored wave through the existing transition. Nonpeak
    // grids retain a full headway rather than inserting a short peak gap.
    const join = waves.filter(p => TEMPLATES[p.template].peak || service.peaks[p.template]?.[dir] !== undefined)
      .map(p => ({ b: peakStart(p, dir), hw: peakHw(p, dir), min: TEMPLATES[p.template].peak ? 90 : peakHw(p, dir) }))
      .find(x => x.b > t && x.b <= candidate);
    if (join) return join.b - t >= join.min ? join.b : join.b + join.hw;
    return candidate;
  };

  // ---- DN stream (reference: 淞虹路 departure)
  {
    let idx = 0;
    let lastPeriod = '';
    let t = firstCurves.DN.find(stop => stop.st === DN_REF)!.dep;
    for (let guard = 0; guard < 2000; guard++) {
      if (t >= lastReference.DN - .001) break;
      const p = streamAt(t, 'DN');
      const tpl = TEMPLATES[p.template];
      if (p.label !== lastPeriod) {
        if (!tpl.continuePattern) idx = tpl.phase?.DN ?? 0;
        lastPeriod = p.label;
      }
      if (p.steady) idx = Math.round((t - p.from) / peakHw(p, 'DN')) + (tpl.phase?.DN ?? 0);
      let kind = tpl.pattern[idx % tpl.pattern.length] as 'big' | 'small' | 'late';
      // Pre-position the core with short routes, while the west outer
      // section still has one departure every 5 minutes (D73).
      if (tpl.openingAlternation && t < OPENING.outerAlternation) kind = idx % 2 === 0 ? 'big' : 'small';
      if (guard === 0) kind = 'big'; // preserve the published PXL 05:25 opener
      const route = namedRoute(kind);
      if (route) {
        const stops = atReference('DN', route[0], route[1], DN_REF, t);
        if (!precedesLast('DN', stops)) break;
        addTrip('DN', 'big', route[0], route[1], stops, true);
      } else if (kind === 'big' || kind === 'late') {
        const to = E;
        const stops = guard === 0 ? firstCurves.DN : atReference('DN', W, to, DN_REF, t);
        if (!precedesLast('DN', stops)) break;
        addTrip('DN', kind, W, to, stops, true);
      } else {
        const stops = atReference('DN', CORE_W, CORE_E, DN_REF, t);
        // End the eastbound short route at its far end, rather than letting
        // another whole-core journey start at 20:55 (D72).
        if (service.shortClose !== undefined && stops.at(-1)!.arr >= service.shortClose) {
          // The train of the former short-route slot continues east from
          // CORE_W to the airport; adding a new PXL origin would require an
          // unrelated extra train at the west end during the withdrawal.
          const extended = buildStops(ctx, 'DN', CORE_W, E, t, true, factorAt);
          if (!precedesLast('DN', extended)) break;
          addTrip('DN', 'big', CORE_W, E, extended, true);
        } else {
          if (!precedesLast('DN', stops)) break;
          addTrip('DN', 'small', CORE_W, CORE_E, stops, true);
        }
      }
      idx++;
      t = nextSlot(t, 'DN');
    }
    lastAnchors.push(addTrip('DN', 'big', W, E, lastCurves.DN, true));
  }
  // The closing stream is counted backwards from its official final origin.
  // Only feasible slots are laid out, so no surplus first late train exists.
  const lateCount = Math.floor((OPERATIONS.lastLateEastboundDep - OPERATIONS.lastBigEastboundDep - MIN_HEADWAY) / service.lateHeadway) + 1;
  for (let index = lateCount - 1; index >= 0; index--) {
    const departure = OPERATIONS.lastLateEastboundDep - index * service.lateHeadway;
    const trip = addTrip('DN', 'late', W, CORE_E, buildStops(ctx, 'DN', W, CORE_E, departure, true, factorAt), true);
    if (index === 0) lastAnchors.push(trip);
  }
  // D173: a steady single-route period sets the westbound grid's phase
  // against the eastbound one, so that neither line end keeps a car waiting
  // much beyond its turnback. Only the relative phase moves: the period's
  // headway and the published first and last trains are unchanged.
  /** Waiting beyond the turnback at the worse line end of a whole-route
   * westbound train in reference slot `slot`, against the eastbound trips. */
  const upWaiting = (slot: number) => {
    const up = atReference('UP', E, W, UP_REF, slot);
    const west = up.at(-1)!.arr + minTurn(W), east = up[0].dep - minTurn(E);
    const w = Math.min(...trips.filter(r => r.dir === 'DN' && r.from === W && r.stops[0].dep >= west).map(r => r.stops[0].dep - west));
    const e = Math.min(...trips.filter(r => r.dir === 'DN' && r.to === E && r.stops.at(-1)!.arr <= east).map(r => east - r.stops.at(-1)!.arr));
    return Math.max(w, e);
  };
  /** The shift within half a headway that waits least over `slots`. */
  const leastWaitingShift = (slots: number[], h: number) => {
    let best = 0, score = Infinity;
    for (let shift = -h / 2; shift < h / 2; shift += 5) {
      const total = slots.reduce((sum, slot) => sum + upWaiting(slot + shift), 0);
      if (total < score - 1e-6) { score = total; best = shift; }
    }
    return best;
  };
  const balancedUpSlot = (t: number, h: number) => t + leastWaitingShift([t, t + h, t + 2 * h], h);

  // ---- UP stream (reference: 广兰路 departure)
  {
    let idx = 0;
    let lastPeriod = '';
    const firstThrough = firstCurves.UP.find(stop => stop.st === UP_REF)!.dep;
    // Explicit origin first trains below supply the early western section;
    // the airport stream starts with the published 06:00 departure.
    firstService.push(addTrip('UP', 'big', E, W, firstCurves.UP, true));
    // Opening trains from CORE_E are fed by depot trains changing ends on its
    // single middle-track platform; one cycle there takes minTurn plus the
    // throat clearance. A slot that comes sooner starts at 龙阳路 instead,
    // where the depot train enters westbound service directly (the published
    // 05:20 first train does the same).
    const coreCycle = minTurn(CORE_E) + (OPERATIONS.platformTurnClear[STATIONS[CORE_E].id] ?? 0) + 10;
    let lastCoreOpening = -Infinity;
    let t = service.openingUp?.at ?? firstThrough;
    for (let guard = 0; guard < 2000; guard++) {
      if (t >= lastReference.UP - .001) break;
      let p = streamAt(t, 'UP');
      let tpl = TEMPLATES[p.template];
      const entering = p.label !== lastPeriod;
      if (entering) {
        if (!tpl.continuePattern) idx = 0;
        lastPeriod = p.label;
      }
      // Balanced once on entering: moving the phase again mid-period would
      // open one wide interval. (An explicit directional override is a wave
      // given in the data.)
      const h = headwayAt(t, 'UP');
      if (entering && !tpl.peak && tpl.pattern.length === 1 && p.headwayTo === undefined && !('dir' in p)
        && p.from >= firstThrough && p.to <= lastReference.UP && p.to - p.from >= 3600 && p.to - t >= 3 * h) {
        t = balancedUpSlot(t, h);
        p = streamAt(t, 'UP'); tpl = TEMPLATES[p.template];
      }
      if (p.steady) idx = Math.round((t - p.from - (tpl.openingAlternation ? upPhase : 0)) / peakHw(p, 'UP'));
      idx += tpl.phase?.UP ?? 0;
      let kind = tpl.pattern[idx % tpl.pattern.length] as 'big' | 'small' | 'late';
      if (tpl.openingAlternation && t < peaks[0].from) {
        // Anchor the outer 5-minute grid to the official airport first train.
        kind = Math.round((t - firstThrough) / peakHw(p)) % 2 === 0 ? 'big' : 'small';
      }
      if (tpl.openingAlternation && t >= peaks[0].from && t < peaks[0].from + peakHw(p)) kind = 'big';
      if (kind === 'big' && atReference('UP', E, W, UP_REF, t)[0].dep < OPERATIONS.firstEastTerminusDep - .01) kind = 'small';
      // The explicit 06:00 airport train occupies its full path. During
      // morning build-up do not insert another departure within 90 seconds.
      if (Math.abs(t - firstThrough) < 120) { idx++; t = nextSlot(t, 'UP'); continue; }
      const route = namedRoute(kind);
      if (route) {
        const stops = atReference('UP', route[1], route[0], UP_REF, t);
        if (!precedesLast('UP', stops)) break;
        addTrip('UP', 'big', route[1], route[0], stops, true);
      }
      if (kind === 'big') {
        const stops = atReference('UP', E, W, UP_REF, t);
        if (!precedesLast('UP', stops)) break;
        addTrip('UP', 'big', E, W, stops, true);
      }
      if (kind === 'late') {
        break; // official airport last train is also CORE_E's last westbound service
      }
      if (kind === 'small') {
        // Before the airport's first through train reaches CORE_E, western
        // first-service trains run to PXL. This supplies west-end turns
        // without queueing dozens of early depot feeders at PXL.
        const opening = t < firstThrough;
        if (opening && INSERT_ORIGIN >= 0 && t - lastCoreOpening < coreCycle) {
          const atInsert = buildStops(ctx, 'UP', CORE_E, W, t, true, factorAt).find(s => s.st === INSERT_ORIGIN)!.dep;
          const stops = buildStops(ctx, 'UP', INSERT_ORIGIN, W, atInsert, true, factorAt);
          if (!precedesLast('UP', stops)) break;
          addTrip('UP', 'ins', INSERT_ORIGIN, W, stops, true);
        } else {
          if (opening) lastCoreOpening = t;
          const to=opening?W:CORE_W;
          const stops = atReference('UP', CORE_E, to, UP_REF, t);
          if (!precedesLast('UP', stops)) break;
          addTrip('UP', opening ? 'ins' : 'small', CORE_E, to, stops, true);
        }
      }
      idx++;
      t = nextSlot(t, 'UP');
    }
    lastAnchors.push(addTrip('UP', 'big', E, W, lastCurves.UP, true));
  }

  // Official origin first trains, shared by both day types. Intermediate
  // stations keep the published minutes through officialTimingPoints (D162).
  // (淞虹路 05:58 westbound and 远东大道 06:24 eastbound are not origins: they
  // are the 龙阳路 and 广兰路 first trains passing.)
  for (const origin of SIMULATION.timetable.firstOrigins) {
    const { dir } = origin, from = stationIndex(origin.from), to = stationIndex(origin.to);
    firstService.push(addTrip(dir, 'ins', from, to, buildStops(ctx, dir, from, to, origin.dep, true, factorAt), true));
  }

  {
    for (let round = 0; round < 30; round++) {
      const calls = trips.filter(t => t.dir === 'UP' && t.revenue && !ahead('DN', CORE_W, t.to))
        .flatMap(t => t.stops.filter(s => s.st === INSERT_ORIGIN).map(s => s.dep)).sort((a, b) => a - b);
      let added = false;
      for (let i = 0; i + 1 < calls.length; i++) {
        const at = calls[i];
        const band = service.openingSupplements.find(p => at >= p.from && at < p.to);
        if (!band || calls[i + 1] - at < band.headway + MIN_HEADWAY) continue;
        const dep = at + band.headway;
        const terminal = stationIndex(service.openingSupplements.find(p => dep >= p.from && dep < p.to)?.terminal ?? band.terminal);
        const stops = buildStops(ctx, 'UP', INSERT_ORIGIN, terminal, dep, true, factorAt);
        if (!new DepIndex(trips).clear(stops, 'UP')) continue;
        addTrip('UP', 'ins', INSERT_ORIGIN, terminal, stops, true);
        added = true;
        break;
      }
      if (!added) break;
    }
  }

  if (service.shortClose !== undefined) {
    // The last two short-route duties finish carrying passengers: the final
    // westbound one goes to 蟠祥路 and the eastbound one to 龙阳路 depot.
    const distance = (trip: ServiceRequest) => Math.abs((trip.stops.find(stop => stop.st === CORE_E)?.dep ?? -Infinity) - service.shortClose!);
    const closingSlot = trips.filter(t => t.dir === 'UP' && distance(t) <= 180).sort((a, b) => distance(a) - distance(b))[0];
    if (closingSlot) {
      const dep = service.shortClose;
      closingSlot.locked = true;
      closingSlot.kind = 'wd';
      closingSlot.from = CORE_E;
      closingSlot.to = W;
      closingSlot.stops = buildStops(ctx, 'UP', CORE_E, W, dep, true, factorAt);
    }
    // The preceding short-route trains finish their trips and return at CORE_W;
    // classify these as withdrawals once they overlap the closing window.
    for (const t of trips) if (t.dir === 'UP' && t.kind === 'small' && t.stops.at(-1)!.arr > service.shortClose) t.kind = 'wd';
    const dn = trips.filter(t => t.dir === 'DN' && t.from === CORE_W && t.kind === 'big'
      && t.stops.find(s => s.st === INSERT_ORIGIN)!.arr >= service.carryingClose!.from
      && t.stops.find(s => s.st === INSERT_ORIGIN)!.arr <= service.carryingClose!.to).at(0);
    if (dn) {
      dn.kind = 'wd';
      dn.to = INSERT_ORIGIN;
      dn.stops = buildStops(ctx, 'DN', CORE_W, INSERT_ORIGIN, dn.stops[0].dep, true, factorAt);
    }
  }

  // 广兰路 turns trains on its one middle-track platform (配线图 PDF). A DN
  // arrival that would turn into an UP departure a slot or two later, but
  // whose platform the following arrival needs first, runs on to the eastern
  // terminal instead (延伸运行), where the tails have room.
  const arrAt = (t: ServiceRequest) => t.stops[t.stops.length - 1].arr;
  /** The CORE_E middle-track turn (D48): the first departure in `deps` (sorted, none of `taken`)
   * at least a minimum turn after arrival `a` and within INTERMEDIATE_WAIT of it, that has cleared
   * the throat before the track's next arrival `next` needs it. */
  const coreTurn = (a: number, deps: readonly number[], next: number, taken?: ReadonlySet<number>): number | undefined => {
    const mt = minTurn(CORE_E);
    const d = deps.find(x => x >= a + mt - 1e-6 && !taken?.has(x));
    return d !== undefined && d - a <= mt + INTERMEDIATE_WAIT && d + CORE_CLEAR <= next ? d : undefined;
  };
  if (SIMULATION.timetable.terminals.overflowWithdrawal) {
    const arrivals = trips.filter((t) => t.dir === 'DN' && t.to === CORE_E && t.kind === 'small').sort((a, b) => arrAt(a) - arrAt(b));
    const deps = trips.filter((t) => t.dir === 'UP' && t.from === CORE_E).map((t) => t.stops[0].dep).sort((a, b) => a - b);
    for (let i = 0; i + 1 < arrivals.length; i++) {
      const A = arrivals[i];
      // (no departure within a slot or two: the train is withdrawn to the depot as before)
      if (coreTurn(arrAt(A), deps, arrAt(arrivals[i + 1])) !== undefined) continue;
      // During morning opening, a short-route train with no middle-track
      // turn runs to CSD's entry at YDD rather than filling the airport tails.
      // This is a passenger-carrying withdrawal, not an extra airport origin.
      // 【假设】 when CORE_E has no turn slot, withdraw at CSD's YDD entry
      // rather than add an unplanned arrival to the airport turning cycle.
      A.to = stationIndex(SIMULATION.timetable.terminals.overflowWithdrawal); A.kind = 'wd';
      A.stops = buildStops(ctx, 'DN', A.from, A.to, A.stops[0].dep, true, factorAt);
    }
  }

  // 用户决定（2026-11-08/11-10）：东端靠截短、延伸交路自己配平车，不在远东大道站台换端出入段，
  // 也不在两个车场之间对调车。现实有这些交路：淞虹路→浦东机场（D173 PIS）、蟠祥路→广兰路
  // （10-16 蟠祥路 PIS「开往广兰路」页、录音末G）。
  // - the eastern line end lacks a car for a westbound departure: the latest
  //   short-route train that reaches it in time runs on (延伸运行), one that
  //   could not turn at CORE_E first;
  // - it has a car left over while CORE_E lacks one: the whole-route train
  //   bringing it ends at CORE_E instead (截短).
  // 【假设】how many such trains run follows from the two ends' balance; the
  // field material shows the routes, not their count.
  if (SIMULATION.timetable.terminals.balanceRoutes) {
    const turnE = minTurn(E) + LINE_END_TURN_SLACK;
    /** the line end's turns, as the duty planner stands its cars (lineEndTurns) */
    const balanceE = () => {
      const departures = trips.filter(t => t.dir === 'UP' && t.from === E).map(t => t.stops[0].dep).sort((a, b) => a - b);
      const arrivals = trips.filter(t => t.dir === 'DN' && t.to === E).sort((a, b) => arrAt(a) - arrAt(b));
      const turns = lineEndTurns(ctx.dayType, E, arrivals.map(arrAt), departures, terminalCapacity(ctx.topo, E), noDepotReturnBefore());
      return { short: turns.short, spare: turns.spare.map(i => arrivals[i]) };
    };
    const extend = (at: number) => {
      let best: { trip: ServiceRequest; stops: PlanStop[]; rank: number } | undefined;
      const index = new DepIndex(trips);
      for (const t of trips) {
        if (t.dir !== 'DN' || t.from !== CORE_W || t.locked || !(t.kind === 'small' || t.kind === 'wd' && t.to !== E)) continue;
        const stops = buildStops(ctx, 'DN', t.from, E, t.stops[0].dep, true, factorAt);
        const reach = stops[stops.length - 1].arr, rank = t.kind === 'wd' ? 1 : 0;
        if (reach + turnE > at + 1e-6 || reach < at - turnE - MAX_LAYOVER) continue;
        if (best && (best.rank > rank || best.rank === rank && best.stops[best.stops.length - 1].arr >= reach)) continue;
        // (its own current departures do not count against it)
        if (!index.clear(stops, 'DN', MIN_HEADWAY, t.stops)) continue;
        best = { trip: t, stops, rank };
      }
      if (best) { best.trip.to = E; best.trip.kind = 'big'; best.trip.stops = best.stops; }
      return !!best;
    };
    // one at a time: each extension may also cover a later departure
    for (let tried = new Set<number>(); ;) {
      const at = balanceE().short.find(x => !tried.has(x));
      if (at === undefined) break;
      tried.add(at);
      extend(at);
    }
    // CORE_E departures no short-route arrival turns into (the CORE_E rule above)
    const coreShort = () => {
      const arrivals = trips.filter(t => t.dir === 'DN' && t.to === CORE_E).map(arrAt).sort((a, b) => a - b);
      const deps = trips.filter(t => t.dir === 'UP' && t.from === CORE_E).map(t => t.stops[0].dep).sort((a, b) => a - b);
      const fed = new Set<number>();
      arrivals.forEach((a, i) => {
        const d = coreTurn(a, deps, arrivals[i + 1] ?? Infinity, fed);
        if (d !== undefined) fed.add(d);
      });
      return { deps: deps.filter(d => !fed.has(d)), arrivals };
    };
    for (const car of balanceE().spare) {
      if (car.from !== W && car.from !== CORE_W || car.locked) continue;
      const stops = buildStops(ctx, 'DN', car.from, CORE_E, car.stops[0].dep, true, factorAt);
      const a = stops[stops.length - 1].arr, core = coreShort();
      // the middle track must be free from this arrival until the departure has cleared
      const d = coreTurn(a, core.deps, core.arrivals.find(x => x > a - CORE_CLEAR) ?? Infinity);
      if (d === undefined) continue;
      car.to = CORE_E; car.kind = car.from === W ? 'big' : 'small'; car.stops = stops;
    }
  }

  // Every official last curve was generated as the stream's boundary request;
  // different origins and retirement destinations still share one reference.
  const referenceOf = (dir: TrackDir) => dir === 'DN' ? DN_REF : UP_REF;
  const originalReferences = new Map(trips.map(trip => [trip.id,
    trip.stops.find(stop => stop.st === referenceOf(trip.dir))?.dep]));
  for (const dir of ['DN', 'UP'] as const) {
    const reference = referenceOf(dir);
    const final = lastAnchors.filter(trip => trip.dir === dir)
      .sort((a, b) => originalReferences.get(a.id)! - originalReferences.get(b.id)!).at(-1)!;
    const anchor = final.stops.find(stop => stop.st === reference)!.dep;
    const closing = streamAt(anchor, dir);
    // A ramp has no fixed reference phase and keeps its existing mechanism.
    if (closing.headwayTo !== undefined || TEMPLATES[closing.template].peak) continue;
    const end = originalReferences.get(final.id)!;
    const shared = trips.filter(trip => trip.dir === dir && trip.revenue
      && originalReferences.get(trip.id) !== undefined);
    const suffix = shared.filter(trip => originalReferences.get(trip.id)! >= closing.from - .001
      && originalReferences.get(trip.id)! <= end)
      .sort((a, b) => originalReferences.get(a.id)! - originalReferences.get(b.id)! || a.id - b.id);
    const fixed = new Set(trips.filter(trip => trip.locked || firstService.includes(trip)
      || lastAnchors.includes(trip) || isPublishedOrigin(ctx, trip)).map(trip => trip.id));
    issues.push(...anchorClosingServices(suffix, fixed, reference, headwayAt(anchor, dir),
      (trip, at) => atReference(trip.dir, trip.from, trip.to, reference, at),
      shared.filter(trip => originalReferences.get(trip.id)! < closing.from - .001)));
  }
  for (const [id, trip] of trips.entries()) trip.id = id;
  for (const place of overnightPlaces(topo).filter(place => place.kind === 'origin' || place.kind === 'platform')) {
    const candidate = trips.filter(trip => trip.stableBerth === undefined && trip.dir === place.departure
      && (place.kind === 'platform' ? trip.from === place.station
        : trip.from > place.station && !firstService.includes(trip) && !trip.locked)
      && trip.stops.some(stop => stop.st === place.station))
      .sort((a, b) => Number(STATIONS[b.from].id === place.origin) - Number(STATIONS[a.from].id === place.origin)
        || a.stops.find(stop => stop.st === place.station)!.dep - b.stops.find(stop => stop.st === place.station)!.dep)[0];
    if (!candidate) throw new Error(`${STATIONS[place.station].name} 无可用的过夜出车任务`);
    if (candidate.from !== place.station) trimRoute(candidate, place.station, candidate.to, 'ins');
    candidate.stableBerth = place.berth;
  }
  return { requests: trips, periods, firstService: new Set(firstService.map(service => service.id)), issues };
}

/** Generate the shared closing flow backwards, preserving its request order.
 * Nominal reference spacing cannot reserve a path whose last train recovers
 * allowance downstream: every proposed curve also precedes the whole calendar. */
export function anchorClosingServices(requests: readonly ServiceRequest[], fixed: ReadonlySet<number>, reference: number,
  headway: number, build: (request: ServiceRequest, referenceDeparture: number) => PlanStop[],
  prefix: readonly ServiceRequest[] = []): PlanIssue[] {
  if (!requests.length) return [];
  if (!fixed.has(requests.at(-1)!.id)) return [{ severity: 'error', code: 'HEADWAY',
    t: requests.at(-1)!.stops[0].dep, text: '末班参考流缺少固定的最后请求' }];
  const separation = MIN_HEADWAY + .01;
  const lower = new Map<number, number>();
  const rememberEarlier = (stops: readonly PlanStop[]) => {
    for (const stop of stops) lower.set(stop.st, Math.max(lower.get(stop.st) ?? -Infinity, stop.dep + separation));
  };
  for (const trip of prefix) rememberEarlier(trip.stops);
  const bounds = requests.map(trip => {
    const bound = new Map(lower);
    if (fixed.has(trip.id)) rememberEarlier(trip.stops);
    return bound;
  });
  const following: ServiceRequest[] = [], next = new Map<number, number>();
  const paths = new Map<ServiceRequest, PlanStop[]>();
  let cursor = Infinity;
  for (let index = requests.length - 1; index >= 0; index--) {
    const request = requests[index], anchored = fixed.has(request.id);
    const calendar = new DepIndex(following);
    let at = cursor - headway, stops = request.stops, fitted = false;
    for (let attempt = 0; attempt < 32; attempt++) {
      if (!anchored) stops = build(request, at);
      const push = stops.reduce((amount, stop) => Math.max(amount,
        stop.dep + separation - (next.get(stop.st) ?? Infinity)), 0);
      const afterPrefix = stops.every(stop => stop.dep >= (bounds[index].get(stop.st) ?? -Infinity) - 1e-6);
      if (push <= 1e-6 && afterPrefix && calendar.clear(stops, request.dir)) { fitted = true; break; }
      if (anchored || !afterPrefix) break;
      at -= Math.max(.01, push);
    }
    if (!fitted) return [{ severity: 'error', code: 'HEADWAY', t: request.stops[0].dep,
      text: `${DIRECTIONS[request.dir].label}末班参考流请求 ${request.id} 无保持原顺序及完整路径间隔的可行相位` }];
    paths.set(request, stops);
    following.push({ ...request, stops });
    for (const stop of stops) next.set(stop.st, Math.min(next.get(stop.st) ?? Infinity, stop.dep));
    cursor = stops.find(stop => stop.st === reference)!.dep;
  }
  // A failed phase publishes its error without partially changing the stream.
  for (const [request, stops] of paths) request.stops = stops;
  return [];
}


/** A service request fixes its core slot; outer legs are selected against
 * terminal places before any Trip is created. No request is cancelled. */
export interface ServiceRequest {
  id: number;
  dir: TrackDir;
  kind: TripKind;
  from: number;
  to: number;
  stops: PlanStop[];
  revenue: boolean;
  overlay?: string;
  standby?: boolean;
  locked?: boolean;
  stableBerth?: number;
}
/** A proposed vehicle connection may wait only at an actual safe berth. */
export function connectionChoice(topo: Topology, dayType: Plan['dayType'], a: Trip, d: Trip, candidates?: readonly number[]) {
  const long = plannedWaitLong(dayType, a, d);
  const tasks: Task[] = [];
  tripTasks(topo, a, tasks, false);
  if (a.dir !== d.dir) addTurnback(topo, a, tasks);
  const reverse = tasks.map(t => t.k === 'reverse').lastIndexOf(true);
  const task = tasks[reverse];
  tripTasks(topo, d, tasks, false);
  const berths = candidates ?? (a.dir === d.dir ? [platformBerth(topo, a.to, a.dir)]
    : task?.k === 'reverse' ? task.berths : []);
  const choice = plannedWaitBerth(topo, a, d, tasks, reverse, berths,
    task?.k === 'reverse' ? task.chosen : undefined);
  return { ...choice, safe: !long || choice.safe, options: long ? choice.safeBerths : berths };
}
export function connectionSafe(topo: Topology, dayType: Plan['dayType'], a: Trip, d: Trip, candidates?: readonly number[]): boolean {
  return connectionChoice(topo, dayType, a, d, candidates).safe;
}

/** D166 experiment: select passenger-carrying approaches to fixed departures
 * while requests are still being drafted. Never add an empty mainline feeder. */
export function draftFixedPassengerSupply(ctx: PlanContext, requests: ServiceRequest[], published: ReadonlySet<number>, runs: FixedRun[]) {
  const {topo} = ctx, pairs: [number, number, number, number, number?][] = [], anchors: number[] = [];
  const starts=new Map<number,number>();
  const issues: PlanIssue[] = [];
  const reserved = new Set<number>();
  const factor = (t: number) => dwellFactorAt(ctx.dayType,t);
  const index = new DepIndex(requests);
  for (const run of runs) {
    const from=stationIndex(run.from), to=stationIndex(run.to);
    const direction: TrackDir = ahead('DN',from,to) ? 'DN' : 'UP';
    const back: TrackDir = direction === 'DN' ? 'UP' : 'DN';
    const board=new Set(run.board.map(stationIndex)), alight=new Set(run.alight.map(stationIndex));
    for (const departure of run.departures) {
      const fixed=buildStops(ctx,direction,from,to,departure,true,1,st=>board.has(st)||alight.has(st));
      for (const p of fixed) if (alight.has(p.st)) p.noBoard=true;
      let choice: {arrival: ServiceRequest; station: number; prefix: PlanStop[]; feeder: PlanStop[]} | undefined;
      const stations=topo.stations.filter(st=>ahead(direction,st.index,from) && !!turnbackAt(topo,st.index,back))
        .sort((a,b)=>Math.abs(a.chain-topo.stations[from].chain)-Math.abs(b.chain-topo.stations[from].chain));
      for (const station of stations) {
        const candidates=requests.filter(t=>t.dir===back&&!reserved.has(t.id)&&!t.locked&&!published.has(t.id)
          && !isPublishedOrigin(ctx,t)&&t.stops.some(p=>p.st===station.index))
          .sort((a,b)=>b.stops.find(p=>p.st===station.index)!.arr-a.stops.find(p=>p.st===station.index)!.arr);
        for (const arrival of candidates) {
          const at=arrival.stops.findIndex(p=>p.st===station.index), arr=arrival.stops[at].arr;
          // Only an outer leg may end here; every requested core call stays.
          const core=arrival.stops.filter(stop=>!ahead('DN',stop.st,CORE_W)&&!ahead('DN',CORE_E,stop.st));
          if(core.some(stop=>!arrival.stops.slice(0,at+1).some(prefix=>prefix.st===stop.st)))continue;
          const earliest=arr+minTurn(station.index), latest=departure-180;
          if (earliest>latest || latest-earliest>900) continue;
          let start=latest-buildStops(ctx,direction,station.index,from,0,true,factor).at(-1)!.arr;
          for(let k=0;k<8;k++) start-=buildStops(ctx,direction,station.index,from,start,true,factor).at(-1)!.arr-latest;
          for(let offset=0;offset<=450;offset+=5) {
            const feeder=buildStops(ctx,direction,station.index,from,start-offset,true,factor);
            if(feeder[0].dep<earliest || departure-feeder.at(-1)!.arr>450 || !index.clear(feeder,direction)) continue;
            const prefix=arrival.stops.slice(0,at+1).map(x=>({...x}));prefix.at(-1)!.dep=prefix.at(-1)!.arr;
            choice={arrival,station:station.index,prefix,feeder};break;
          }
          if(choice)break;
        }
        if(choice)break;
      }
      if(!choice) {
        // Some fixed services originate at a line end. A real depot exit can
        // carry to that terminal and turn there; it is part of the draft, not
        // a later empty positioning movement.
        const depot=depotIndex(topo,run.depotFrom), origin=depot>=0?exitStation(topo,depot,back):-1;
        if(origin>=0 && ahead(back,origin,from) && turnbackAt(topo,from,back)){
          const latest=departure-minTurn(from)-10;
          let start=latest-buildStops(ctx,back,origin,from,0,true,factor).at(-1)!.arr;
          for(let k=0;k<8;k++)start-=buildStops(ctx,back,origin,from,start,true,factor).at(-1)!.arr-latest;
          let incoming:PlanStop[]|undefined;
          for(let offset=0;offset<=900;offset+=5){const stops=buildStops(ctx,back,origin,from,start-offset,true,factor);
            if(!index.clear(stops,back))continue;
            const [outFrom,outTo]=outboundWindow(ctx,depot,{dir:back,stops});
            const path=topo.depots[depot].portals.exit[back].path;
            const conflict=requests.some(t=>{
              const entry=topo.depots[depot].portals.entry[t.dir];
              if(t.to!==entry.station||entry.path!==path)return false;
              const [inFrom,inTo]=inboundWindow(topo,depot,t);
              return outFrom<inTo&&inFrom<outTo;
            });
            if(!conflict){incoming=stops;break;}}
          if(incoming){
            const feeder:ServiceRequest={id:requests.length,dir:back,kind:'ins',from:origin,to:from,stops:incoming,revenue:true,locked:true};
            requests.push(feeder);index.add(feeder);starts.set(feeder.id,depot);
            const service:ServiceRequest={id:requests.length,dir:direction,kind:'extra',from,to,stops:fixed,revenue:true,locked:true};
            requests.push(service);index.add(service);anchors.push(service.id);
            pairs.push([-1,feeder.id,service.id,depotIndex(topo,run.depotTo)]);continue;
          }
        }
        const service:ServiceRequest={id:requests.length,dir:direction,kind:'extra',from,to,stops:fixed,revenue:true,locked:true};
        requests.push(service);index.add(service);anchors.push(service.id);
        issues.push({severity:'error',code:'UNASSIGNED',t:departure,text:`${run.from} 定点班车没有可行载客接续`});
        continue;
      }
      reserved.add(choice.arrival.id); choice.arrival.to=choice.station;choice.arrival.kind='wd';choice.arrival.stops=choice.prefix;choice.arrival.locked=true;
      const feeder:ServiceRequest={id:requests.length,dir:direction,kind:'ins',from:choice.station,to:from,stops:choice.feeder,revenue:true,locked:true};
      requests.push(feeder);index.add(feeder);
      const service:ServiceRequest={id:requests.length,dir:direction,kind:'extra',from,to,stops:fixed,revenue:true,locked:true};
      requests.push(service);index.add(service);anchors.push(service.id);
      pairs.push([choice.arrival.id,feeder.id,service.id,depotIndex(topo,run.depotTo)]);
    }
  }
  // A fixed service may finish before its yard portal. Represent the rest as
  // an actual carrying service, rather than an implicit empty task.
  for(const pair of pairs){
    const service=requests[pair[2]],depot=pair[3],target=depot>=0?entryStation(topo,depot,service.dir):-1;
    if(target===service.to)continue;
    if(target<0||!ahead(service.dir,service.to,target)){
      issues.push({severity:'error',code:'UNASSIGNED',t:service.stops.at(-1)!.arr,text:`定点班车终点没有同向可达的载客回段路径`});continue;
    }
    const arrival=service.stops.at(-1)!.arr;
    const earliest=arrival+plannedDwell(ctx.dayType,service.to,service.dir,arrival,factor(arrival));
    const others=new DepIndex(requests.filter(t=>t.id!==service.id));
    let stops:PlanStop[]|undefined;
    for(let offset=0;offset<=MAX_LAYOVER;offset+=5){const candidate=buildStops(ctx,service.dir,service.to,target,earliest+offset,true,factor);
      if(others.clear(candidate,service.dir)){stops=candidate;break;}}
    if(!stops){issues.push({severity:'error',code:'UNASSIGNED',t:arrival,text:'定点班车载客回段没有可行时隙'});continue;}
    const returning:ServiceRequest={id:requests.length,dir:service.dir,kind:'wd',from:service.to,to:target,stops,revenue:true,locked:true};
    requests.push(returning);index.add(returning);pair[4]=returning.id;
  }
  return {pairs,anchors,starts,issues};
}

/** Match draft requests to stock and daily homes, publish their final passenger
 * boundaries, then resolve bounded timing conflicts. Published routes are fixed. */
const generatedPlans = new Map<string, Plan>();
/** Cache only pristine diagrams; every caller gets its own mutable copy and
 * validation metadata. Include all mutable planning inputs in the key. */
export function generatePlan(ctx: PlanContext): Plan {
  const key=JSON.stringify([ctx,OPERATIONS,SIMULATION.timetable,TEMPLATES,SHOWN_PERIODS,DWELL_BANDS,RUN_BANDS,FIXED_LATE_TRAINS,FIRST_LAST]);
  let pristine=generatedPlans.get(key);
  if(!pristine) {
    pristine=buildPlan(ctx);
    if(generatedPlans.size>=8)generatedPlans.delete(generatedPlans.keys().next().value!);
    generatedPlans.set(key,pristine);
  }
  const plan=structuredClone(pristine);
  const identities=laidOutService.get(pristine);
  if(identities)laidOutService.set(plan,new Map([...identities].map(([trip,identity])=>[plan.trips[trip.id],structuredClone(identity)])));
  generationIssues.set(plan,structuredClone(generationIssues.get(pristine)??[]));
  rejectedTurns.set(plan,[...(rejectedTurns.get(pristine)??[])]);
  return plan;
}

/** A pristine diagram with its key and side tables (trips by id), as the
 * worker keeps it between launches (buildCache.ts, D186). */
export interface StoredPlan { key: string; plan: Plan; identities?: [number, ServiceIdentity][]; issues: PlanIssue[]; rejected: string[] }

export function storedPlans(): StoredPlan[] {
  return [...generatedPlans].map(([key, plan]) => {
    const identities = laidOutService.get(plan);
    return { key, plan, ...(identities ? { identities: [...identities].map(([trip, identity]): [number, ServiceIdentity] => [trip.id, identity]) } : {}),
      issues: generationIssues.get(plan) ?? [], rejected: rejectedTurns.get(plan) ?? [] };
  });
}

/** Seeds the cache above. The source digest in buildCache.ts stands for every
 * input the key does not spell out (the planning code itself). */
export function restorePlans(stored: readonly StoredPlan[]) {
  for (const s of stored) {
    if (generatedPlans.has(s.key)) continue;
    if (s.identities) laidOutService.set(s.plan, new Map(s.identities.map(([id, identity]) => [s.plan.trips[id], identity])));
    generationIssues.set(s.plan, s.issues);
    rejectedTurns.set(s.plan, s.rejected);
    if (generatedPlans.size >= 8) generatedPlans.delete(generatedPlans.keys().next().value!);
    generatedPlans.set(s.key, s.plan);
  }
}

function buildPlan(ctx: PlanContext): Plan {
  const { requests, periods, firstService: published, issues: layoutIssues } = layoutService(ctx);
  const fixedDraft = CARRY_MOVES ? draftFixedPassengerSupply(ctx, requests, published, ctx.fixedRuns ?? FIXED_LATE_TRAINS) : {pairs: [], anchors: [], starts:new Map<number,number>(), issues: []};
  return buildPoolPlan(ctx, requests, periods, published, layoutIssues, fixedDraft, new Map(fixedDraft.starts));
}

/** D178: the day duty from the terminal pools (duty/planner.ts). */
function buildPoolPlan(ctx: PlanContext, requests: readonly ServiceRequest[], periods: Period[], published: ReadonlySet<number>, layoutIssues: PlanIssue[],
  fixedDraft: { pairs: [number, number, number, number, (number | undefined)?][]; anchors: number[]; issues: PlanIssue[] },
  reservedStarts: Map<number, number>): Plan {
  const W = 0;
  const locked = new Set(requests.filter(r => r.locked || published.has(r.id) || isPublishedOrigin(ctx, r)).map(r => r.id));
  const anchors = new Set([...published, ...fixedDraft.anchors, ...locked]);
  const stableStarts = new Map(requests.filter(r => r.stableBerth !== undefined).map(r => [r.id, r.stableBerth!]));
  let requested: number[] = [];
  const draft = (homeFirst?: ReadonlySet<number>, matchHomes = false, rebalance: Pick<DutyInput, 'borrow' | 'deliver' | 'donors' | 'reference'> = {}) => {
    const drafts: GenTrip[] = [];
    for (const request of requests) {
      const trip = addTo(drafts, request.dir, request.kind, request.from, request.to, request.stops.map(stop => ({ ...stop })), request.revenue, request.overlay);
      if (request.standby) trip.standby = true;
    }
    const fixedEnds = new Map<number, number>();
    for (const [a, b, c, depot, returning] of fixedDraft.pairs) {
      if (a >= 0) { drafts[a].next = b; drafts[b].prev = a; }
      drafts[b].next = c; drafts[c].prev = b;
      if (returning !== undefined) { drafts[c].next = returning; drafts[returning].prev = c; }
      fixedEnds.set(returning ?? c, depot);
    }
    requested = drafts.map(trip => trip.stops[0].dep);
    spaceServiceDepartures(drafts, anchors, requested);
    return { drafts, ...planDuties({ ctx, trips: drafts, periods, locked, reservedStarts, fixedEnds, stableStarts, homeFirst, matchHomes, requestedDeps: requested, ...rebalance }) };
  };
  // Yard rebalancing (用户决定 2026-11-13): the first pass also probes. A
  // departure no yard can supply for want of a car borrows one at the nearest
  // depot that then can (`lent`), and the pass counts the cars each depot
  // never drew (`spare`). Where it borrowed, every pass is drafted again with
  // spare cars sent there off-peak, in service (planner.ts redirect), and that
  // is the day's plan: whatever it still cannot cover is reported, not swapped
  // for another plan. With the usual stock no departure fails, nothing is
  // borrowed and the first pass is the plain one.
  let pass = draft(undefined, false, { borrow: true });
  const lent = pass.ledger.lent;
  const rebalance = lent.length ? { deliver: lent.map(l => ({ depot: l.depot, before: l.at })), donors: pass.ledger.spare, reference: pass.ledger.leads } : {};
  if (lent.length) pass = draft(undefined, false, rebalance);
  // A car the day left without a home goes home first in a second pass,
  // before the exits it collided with are fitted (D178: no cross-yard
  // lending; a car with no room nearby runs home empty after the service).
  const homeFirst = pass.ledger.homeless.length ? new Set(pass.ledger.homeless) : undefined;
  if (homeFirst) pass = draft(homeFirst, false, rebalance);
  // The evening cars go home in the balanced order (depotReturns); when that
  // leaves a yard's count open, they are matched to the yards' counts.
  const open = (p: typeof pass) => p.ledger.exits.reduce((sum, n, d) => sum + Math.abs(n - p.ledger.returns[d]), 0);
  if (open(pass)) { const matched = draft(homeFirst, true, rebalance); if (open(matched) < open(pass)) pass = matched; }
  return finish(pass);

  function finish(pass: ReturnType<typeof draft>): Plan {
  const { drafts, blocks, issues } = pass;
  if (SIMULATION.timetable.positioningRevenue === false) for (const trip of drafts.slice(requests.length)) {
    trip.revenue = false;
    if (trip.kind === 'ins' || trip.kind === 'wd') trip.kind = 'empty';
  }
  const trips = drafts.map(trip => ({ ...trip, stops: trip.stops.map(stop => ({ ...stop })) }));
  const serviceStructure = new Map<Trip, ServiceIdentity>();
  for (const trip of trips.slice(0, requests.length)) serviceStructure.set(trip, serviceIdentity(trip));
  const originalDepartures = new Map(trips.slice(0, requests.length).map(trip => [trip as Trip, requested[trip.id]]));
  finishDepotMoves(trips, blocks);
  resolveTimingConflicts(ctx, trips, blocks, anchors, originalDepartures);
  const firstService = trips.filter(trip => published.has(trip.id));
  const firstDN = trips.filter(t => t.dir === 'DN' && t.from === W && t.revenue && !t.cancelled)
    .sort((a, b) => a.stops[0].dep - b.stops[0].dep)[0];
  const openers = [...firstService, ...(firstDN ? [firstDN] : [])].filter(t => !t.cancelled);
  for (const trip of trips) if (trip.revenue && !trip.cancelled) {
    for (const stop of trip.stops) if (stop.dep < stationOpening(stop.st, trip.dir, openers) - .001) stop.noBoard = true;
    if (!trip.stops.some(s => s.st !== trip.to && s.stop && !s.noBoard)) trip.revenue = false;
  }
  const plan: Plan = {
    dayType: ctx.dayType, trips, blocks,
    ...(ctx.initialStock ? { initialStock: ctx.initialStock.slice() } : {}),
    periods: SHOWN_PERIODS[ctx.dayType].map(p => ({ from: p.from, to: p.to, template: p.template, label: p.label })),
    overlays: [], fleetPeak: 0,
  };
  laidOutService.set(plan, serviceStructure);
  generationIssues.set(plan, [...layoutIssues, ...fixedDraft.issues, ...issues, ...serviceStructureIssues(plan)]);
  numberPlan(plan);
  rejectedTurns.set(plan, []);
  plan.fleetPeak = fleetPeak(plan);
  return plan;
  }
}

/** Publish only the chosen depot moves after matching; unused feeder candidates
 * never become numbered train services. Primary services are protected above. */
function finishDepotMoves(trips: GenTrip[], blocks: Block[]) {
  const used = new Set(blocks.flatMap(b => b.trips));
  const retained = trips.filter(t => used.has(t.id));
  const ids = new Map(retained.map((t, id) => [t.id, id]));
  for (const trip of retained) {
    trip.id = ids.get(trip.id)!;
    if (trip.prev !== undefined) trip.prev = ids.get(trip.prev);
    if (trip.next !== undefined) trip.next = ids.get(trip.next);
  }
  for (const block of blocks) block.trips = block.trips.map(id => ids.get(id)!);
  trips.splice(0, trips.length, ...retained);
}

export function isPublishedOrigin(ctx: PlanContext, trip: Pick<Trip, 'from' | 'to' | 'dir' | 'stops'>): boolean {
  return (trip.from === 0 && [OPERATIONS.firstWestTerminusDep, OPERATIONS.lastBigEastboundDep, OPERATIONS.lastLateEastboundDep].includes(trip.stops[0].dep))
    || (trip.from === ctx.topo.stations.length - 1 && [OPERATIONS.firstEastTerminusDep, OPERATIONS.lastBigWestboundDep].includes(trip.stops[0].dep));
}

/** Actual first service anchors, with the published minute as fallback. */
/** D173: the published average interval (s) of the section ending at line
 * end `st` at time `t` — a range's upper bound outside the named periods —
 * or undefined where the line publishes none. */
export function officialEndInterval(dayType: DayType, st: number, t: number): number | undefined {
  const rows = OFFICIAL_HEADWAYS[dayType] ?? [];
  const clock = (v: string) => { const [h, m] = v.split(':').map(Number); return h * 3600 + m * 60; };
  const row = rows.find(r => r.from && r.to && t >= clock(r.from) && t < clock(r.to)) ?? rows.find(r => !r.from);
  const h = row?.sections.find(([a, b]) => a === STATIONS[st].name || b === STATIONS[st].name)?.[2];
  return h === undefined ? undefined : typeof h === 'number' ? h : h[1];
}

/** D178: the published average interval (s, a range's upper bound) of the
 * section holding station `st` at time `t` (the first listed where two meet). */
/** The official interval row in force at `t`: a timed period, else the general one. */
export function officialPeriodAt(dayType: DayType, t: number) {
  const rows = OFFICIAL_HEADWAYS[dayType] ?? [];
  const clock = (v: string) => { const [h, m] = v.split(':').map(Number); return h * 3600 + m * 60; };
  return rows.find(r => r.from && r.to && t >= clock(r.from) && t < clock(r.to)) ?? rows.find(r => !r.from);
}
export function officialIntervalAt(dayType: DayType, st: number, t: number): number | undefined {
  const row = officialPeriodAt(dayType, t);
  const at = (n: string) => STATIONS.findIndex(x => x.name === n);
  const h = row?.sections.find(([a, b]) => Math.min(at(a), at(b)) <= st && st <= Math.max(at(a), at(b)))?.[2];
  return h === undefined ? undefined : typeof h === 'number' ? h : h[1];
}

/** official first departure per station and direction (s), parsed once */
const firstClock=new Map<number,number|undefined>();
function officialFirst(st:number,dir:TrackDir):number|undefined {
  const key=st*2+(dir==='DN'?1:0);
  if(!firstClock.has(key)){
    const row=FIRST_LAST.find(r=>r.station===STATIONS[st].name),clock=row&&(dir==='DN'?row.firstE:row.firstW);
    firstClock.set(key,clock?(([h,m])=>h*3600+m*60)(clock.split(':').map(Number)):undefined);
  }
  return firstClock.get(key);
}
export function stationOpening(st:number,dir:TrackDir,openers:readonly Trip[]):number {
  // a station not in service never opens: an empty move may pass it
  if(!stationOpened(st))return Infinity;
  const clock=officialFirst(st,dir);
  const own=openers.filter(t=>t.dir===dir).flatMap(t=>t.stops.filter(s=>s.st===st&&s.stop&&s.st!==t.to).map(s=>s.dep));
  // the published clock, or the first train itself when it calls a little ahead of that minute
  if(CARRY_MOVES&&clock!==undefined)return Math.min(clock,...own);
  if(own.length)return Math.min(...own);
  return clock??-Infinity;
}

export function openingAnchors(trips:readonly Trip[]):Trip[] {
  const openers=trips.filter(t=>!t.cancelled&&SIMULATION.timetable.firstOrigins.some(origin=>
    t.dir===origin.dir&&t.from===stationIndex(origin.from)&&t.to===stationIndex(origin.to)&&Math.abs(t.stops[0].dep-origin.dep)<1));
  const firstDN=trips.filter(t=>!t.cancelled&&t.revenue&&t.dir==='DN'&&t.from===0)
    .sort((a,b)=>a.stops[0].dep-b.stops[0].dep)[0];
  if(firstDN&&!openers.includes(firstDN))openers.push(firstDN);
  return openers;
}

/** Mark pre-opening calls and report whether the movement can take passengers. */
export function carryingStops(stops:PlanStop[],dir:TrackDir,openers:readonly Trip[]):boolean {
  for(const stop of stops)if(stop.dep<stationOpening(stop.st,dir,openers)-.001)stop.noBoard=true;
  return stops.some((stop,index)=>index<stops.length-1&&stop.stop&&!stop.noBoard);
}

export function passesOpenStation(stops:readonly PlanStop[],dir:TrackDir,openers:readonly Trip[]):boolean {
  return stops.some((stop,index)=>index<stops.length-1
    &&stop.arr>=stationOpening(stop.st,dir,openers));
}

/** Resolve full-path headway drift before assigning trains and depot moves. */
export function spaceServiceDepartures(trips: GenTrip[], protectedIds: Set<number>, original = trips.map(t => t.stops[0].dep)) {
  const shifted = (trip: GenTrip, delta: number) => trip.stops.map(p => ({ ...p, arr: p.arr + delta, dep: p.dep + delta }));
  const withinBudget = (trip: GenTrip, delta: number) => Math.abs(trip.stops[0].dep + delta - original[trip.id]) <= MAX_DIAGRAM_SHIFT_S;
  for (let round = 0; round < TIMING_ROUNDS; round++) {
    let moved = false;
    let index = new DepIndex(trips);
    for (const trip of trips) {
      if (protectedIds.has(trip.id) || index.clear(trip.stops, trip.dir, MIN_HEADWAY + 0.01, trip.stops)) continue;
      const others = new DepIndex(trips.filter(t => t !== trip));
      const neighbours = trips.filter(t => t !== trip && t.dir === trip.dir && !protectedIds.has(t.id)
        && !new DepIndex([t]).clear(trip.stops, trip.dir, MIN_HEADWAY + 0.01));
      let resolved = false;
      // Minimise the largest clock change. Sharing a correction between two
      // neighbours avoids moving an entire full-route path by twenty seconds.
      for (let amount = 1; amount <= MAX_DIAGRAM_SHIFT_S && !resolved; amount++) {
        for (const sign of [-1, 1]) {
          const delta = amount * sign;
          if (!withinBudget(trip, delta)) continue;
          const stops = shifted(trip, delta);
          if (others.clear(stops, trip.dir, MIN_HEADWAY + 0.01)) {
            trip.stops = stops;
            resolved = true;
            break;
          }
          for (const neighbour of neighbours) {
            if (!withinBudget(neighbour, -delta)) continue;
            const otherStops = shifted(neighbour, -delta);
            const index = new DepIndex(trips.filter(t => t !== trip && t !== neighbour));
            if (!index.clear(stops, trip.dir, MIN_HEADWAY + 0.01) || !index.clear(otherStops, neighbour.dir, MIN_HEADWAY + 0.01)
              || !new DepIndex([{ ...neighbour, stops: otherStops }]).clear(stops, trip.dir, MIN_HEADWAY + 0.01)) continue;
            trip.stops = stops;
            neighbour.stops = otherStops;
            resolved = true;
            break;
          }
          if (resolved) break;
        }
      }
      moved ||= resolved;
      if (resolved) index = new DepIndex(trips);
    }
    if (!moved) break;
  }
}

/** Only clock shifts are permitted once the service has been laid out. */
export const MAX_DIAGRAM_SHIFT_S = 20;
const TIMING_ROUNDS = 64;
function resolveTimingConflicts(ctx: PlanContext, trips: GenTrip[], blocks: Block[], protectedIds: Set<number>, serviceDepartures: Map<GenTrip, number>) {
  const original = trips.map(t => serviceDepartures.get(t) ?? t.stops[0].dep);
  const plan: Plan = { dayType: ctx.dayType, trips, blocks, periods: [], overlays: [], fleetPeak: 0 };
  // Fixed late runs have not been attached yet, so the daily stock ledger
  // is checked on the finished plan, not on this temporary timing draft.
  const errors = () => validatePlan(ctx, plan, false, true).filter(i => i.severity === 'error');
  const cost = (issues: PlanIssue[]) => issues.reduce((sum, issue) =>
    sum + (issue.code === 'HEADWAY' ? 100 + Math.max(0, MIN_HEADWAY - (issue.gap ?? 0)) : 1000), 0);
  for (let round = 0; round < TIMING_ROUNDS; round++) {
    const before = errors();
    if (!before.length) break;
    let moved = false;
    for (const issue of before) {
      const candidates = [...new Set((issue.blocks ?? []).flatMap(id => blocks[id].trips))]
        .map(id => trips[id]).filter(t => !t.cancelled && !protectedIds.has(t.id)
          && t.stops[0].dep <= issue.t && t.stops.at(-1)!.arr >= issue.t - 120);
      for (const trip of candidates) {
        const stops = trip.stops;
        const amounts = [...(issue.code === 'HEADWAY' && issue.gap !== undefined
          ? [Math.min(MAX_DIAGRAM_SHIFT_S, MIN_HEADWAY - issue.gap + 1e-6)] : []),
          ...Array.from({ length: MAX_DIAGRAM_SHIFT_S }, (_, index) => MAX_DIAGRAM_SHIFT_S - index)];
        for (const amount of amounts) {
          for (const sign of [-1, 1]) {
            const delta = amount * sign;
            if (Math.abs(stops[0].dep + delta - original[trip.id]) > MAX_DIAGRAM_SHIFT_S) continue;
            trip.stops = stops.map(p => ({ ...p, arr: p.arr + delta, dep: p.dep + delta }));
            const after = errors();
            if (cost(after) < cost(before) && !after.some(i => !before.some(b => b.code === i.code && b.blocks?.join() === i.blocks?.join()))) {
              moved = true;
              break;
            }
            trip.stops = stops;
          }
          if (moved) break;
        }
        if (moved) break;
      }
      if (moved) break;
    }
    if (!moved) break; // Unsolved conflicts stay visible to validatePlan.
  }
}

export function addTo(trips: GenTrip[], dir: TrackDir, kind: TripKind, from: number, to: number, stops: PlanStop[], revenue: boolean, overlay?: string): GenTrip {
  const t: GenTrip = { id: trips.length, no: '', dir, kind, from, to, stops, revenue, block: -1, overlay };
  trips.push(t);
  return t;
}

/** Instead of going into its night berth, the last train of `block` runs
 * empty on to the nearest yard ahead, or turns back to one when no yard lies
 * ahead (a full-route terminal); the duty then ends in that yard. */
export function clearOnToYard(ctx: PlanContext, trips: GenTrip[], block: Block, last: Trip,
  options?: { depot:number; notBefore:number }): GenTrip | undefined {
  const toward = (dir: TrackDir) => {
    const rules=OPERATIONS.depotReturns.filter(r => r.dir === dir
      && (options === undefined || depotIndex(ctx.topo,r.depot) === options.depot))
      .map(r => ({depot:depotIndex(ctx.topo,r.depot),station:STATIONS.findIndex(s => s.id === r.station)}));
    // An explicitly selected yard may also be reached via its opposite
    // portal, with a change of ends at the entrance station.
    if(options!==undefined)rules.push({depot:options.depot,station:entryStation(ctx.topo,options.depot,dir)});
    return rules.filter(r => r.station === last.to || ahead(dir, last.to, r.station))
      .sort((x,y) => Math.abs(x.station-last.to)-Math.abs(y.station-last.to))[0];
  };
  const back: TrackDir = last.dir === 'DN' ? 'UP' : 'DN';
  const ahead1 = toward(last.dir), rule = ahead1 ?? toward(back);
  if (!rule) return;
  const dir = ahead1 ? last.dir : back, turn = ahead1 ? 0 : minTurn(last.to);
  const index = new DepIndex(trips.filter(t => t !== last));
  const openers=openingAnchors(trips);
  // (running on the same way, the train first clears its passengers: D188)
  for (let wait = ahead1 && last.revenue ? Math.max(30, OPERATIONS.terminalClearS ?? 0) : 30; wait <= 180; wait += 10) {
    const start = Math.max(last.stops.at(-1)!.arr+turn,options?.notBefore??-Infinity)+wait;
    const stops = buildStops(ctx,dir,last.to,rule.station,start,CARRY_MOVES,1);
    const revenue=CARRY_MOVES&&carryingStops(stops,dir,openers);
    if(!CARRY_MOVES){if(ahead1)stops[0].stop=false;stops.at(-1)!.stop=false;}
    if(CARRY_MOVES&&!revenue&&passesOpenStation(stops,dir,openers))continue;
    if (!index.clear(stops,dir)) continue;
    const move = addTo(trips,dir,revenue?'wd':'empty',last.to,rule.station,stops,revenue);
    move.block = block.id;
    block.trips.push(move.id);
    block.end = {kind:'depot',depot:rule.depot};
    return move;
  }
}

/** A path-scoped yard checks the actual entry and exit lead. Other yards keep
 * their existing conservative yard-wide check wherever a lead is shared. */
export function depotLeadsConflict(topo: Topology, depot: number, entry: TrackDir, exit: TrackDir): boolean {
  const yard = topo.depots[depot], p = yard.portals;
  if (OPERATIONS.depotLeadConflictScope?.[yard.key] === 'path') return p.entry[entry].path === p.exit[exit].path;
  const ins = new Set([p.entry.DN.path, p.entry.UP.path]);
  return ins.has(p.exit.DN.path) || ins.has(p.exit.UP.path);
}

export function inboundWindow(topo: Topology, depot: number, last: Pick<Trip, 'to' | 'stops'>): [number, number] {
  const d = topo.depots[depot];
  const distance = Math.abs(topo.stations[last.to].chain - d.junctionChain);
  const arr = last.stops.at(-1)!.arr;
  const transfer = d.transferPaths[0].links.reduce((sum, id) => sum + topo.links[id].len, 0);
  const work = OPERATIONS.depotLeadWork?.[d.key]?.entryS ?? 0;
  return [arr + 15 + Math.max(0, distance - 1500) / 20, arr + 15 + distance / 20 + (transfer + LINE_INFO.trainLength) / (25 / 3.6) + 25 + work];
}

/** A reversing exit occupies the conversion track until it can reach and
 * clear its junction platform. The yard's nominal exitTime alone omits the
 * change of ends and can place a return in front of the exiting car.
 * 【假设】 Retain the inbound model's 25 s clearing margin after departure. */
export function outboundWindow(ctx: Pick<PlanContext, 'topo'>, depot: number, first: Pick<Trip, 'dir' | 'stops'>): [number, number] {
  const yard = ctx.topo.depots[depot];
  const start = depotStartTime(ctx, depot, first);
  const portal = yard.portals.exit[first.dir];
  return [start, Math.max(start + yard.exitTime, portal.reverse ? first.stops[0].dep + 25 : -Infinity)];
}

/** time a train must leave the depot gate to make its first departure */
export function depotStartTime(ctx: Pick<PlanContext, 'topo'>, depot: number, first: Pick<Trip, 'stops'> & { dir?: TrackDir }): number {
  const { topo } = ctx;
  const J = topo.depots[depot].junctionChain;
  const st0 = first.stops[0].st;
  const dist = Math.abs(topo.stations[st0].chain - J);
  // Both the time and the distance must refer to the first station, even
  // when an empty feeder passes it without stopping.
  const refTime = first.stops[0].dep;
  // transfer track (~470 m at 25 km/h) + junction + run on the main line
  // (+ the change of ends where the lead reaches the line against `dir`)
  // (callers may pass bare stops: then the direction follows from their order)
  const dir: TrackDir = first.dir ?? (first.stops.length > 1 && first.stops[1].st < st0 ? 'UP' : 'DN');
  const work = OPERATIONS.depotLeadWork?.[topo.depots[depot].key]?.exitS ?? 0;
  const portal = topo.depots[depot].portals.exit[dir];
  const travel = 95 + dist / 13 + 25 + work + (portal.reverse ? PORTAL_REVERSE : 0)
    + (topo.depots[depot].transferPaths[portal.path].shuntBerths?.length ? SHUNT_REVERSE : 0);
  return Math.round(refTime - travel - (first.stops[0].stop ? 75 : 30));
}

export function numberPlan(plan: Plan, startSvc = 1) {
  const cnt: Record<string, number> = {};
  const digit: Record<TripKind, string> = { big: '1', small: '2', late: '3', ins: '4', wd: '4', extra: '5', empty: '0', adj: '6' };
  for (const trip of plan.trips) if (/^\d{4}$/.test(trip.no)) {
    const key=trip.no[0]+trip.dir;
    cnt[key]=Math.max(cnt[key]??0,(Number(trip.no.slice(1))+(trip.dir==='DN'?1:0))/2);
  }
  const sorted = [...plan.trips].filter((t) => !t.no).sort((a, b) => a.stops[0].dep - b.stops[0].dep);
  for (const t of sorted) {
    const key = digit[t.kind] + t.dir;
    const n = (cnt[key] ?? 0) + 1;
    cnt[key] = n;
    const seqN = t.dir === 'DN' ? 2 * n - 1 : 2 * n;
    t.no = digit[t.kind] + String(seqN % 1000).padStart(3, '0');
  }
  const blocks = plan.blocks.filter((b) => !b.svc).sort((a, b) => blockStart(plan, a) - blockStart(plan, b));
  let svc = startSvc;
  for (const b of blocks) b.svc = String(svc++).padStart(3, '0');
}

function blockStart(plan: Plan, b: Block) {
  return b.start.kind === 'depot' ? b.start.time : plan.trips[b.trips[0]].stops[0].dep;
}

export function fleetPeak(plan: Plan): number {
  const ev: [number, number][] = [];
  for (const b of plan.blocks) {
    const live = b.trips.map(id => plan.trips[id]).filter(t => !t.cancelled);
    if (!live.length) continue;
    const first = live[0];
    const last = live[live.length - 1];
    const s = b.start.kind === 'depot' ? b.start.time : first.stops[0].dep - 600;
    const e = last.stops[last.stops.length - 1].arr + (b.end.kind === 'depot' ? 300 : 0);
    if (b.start.kind === 'stable' || b.end.kind === 'stable') continue;
    ev.push([s, 1], [e, -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of ev) { cur += d; max = Math.max(max, cur); }
  const stabled = plan.blocks.filter((b) => b.trips.some(id => !plan.trips[id].cancelled) && (b.start.kind === 'stable' || b.end.kind === 'stable')).length;
  return max + stabled;
}

// ---------------------------------------------------------------- overlays

export function applyOverlay(ctx: PlanContext, plan: Plan, preset: { id: string; label: string; a: number; b: number; from: number; to: number; headway: number },
  live?: Pick<OverlayReuse, 'canExtend' | 'now' | 'stock'>): { trips: number; blocks: number; skipped: number; extended: OverlayReuse['extended'] } {
  restoreCancelledHomes(ctx, plan, live?.now ?? OPENING.dayStart);
  const factorAt = (t: number) => dwellFactorAt(ctx.dayType, t);
  const trips = plan.trips as GenTrip[];
  const tag = `${preset.id}@${preset.from}`;
  const n0 = trips.length;
  const { a, b } = preset;
  const deferred: { block: Block; end: Block['end']; move: number; place: ReturnType<typeof overnightPlaces>[number] }[] = [];
  // If added services run beyond the planned night delivery, the arriving
  // car clears on to its yard. A later added arrival delivers the same slot.
  // The published passenger trip keeps its route and every call unchanged.
  for (const block of plan.blocks) {
    if (block.end.kind !== 'stable' || block.end.berth === undefined || block.train !== undefined && !live?.canExtend(block.id, block.trips.at(-1)!)) continue;
    const end = block.end, last = block.trips.map(id => trips[id]).filter(t => !t.cancelled).at(-1);
    const place = overnightPlaces(ctx.topo).find(p => p.arrivalBerth === end.berth);
    if (!last || !place || ctx.topo.berths[end.berth!].kind !== 'platform' || last.to < Math.min(a,b) || last.to > Math.max(a,b)
      || preset.to < last.stops.at(-1)!.arr - 1800 || last.stops.at(-1)!.arr < (live?.now ?? OPENING.dayStart)) continue;
    const move = clearOnToYard(ctx, trips, block, last);
    if (move) deferred.push({block,end,move:move.id,place});
  }
  const dirAB: TrackDir = a < b ? 'DN' : 'UP';
  const dirBA: TrackDir = dirAB === 'DN' ? 'UP' : 'DN';
  const existing = [...plan.trips];
  const stockBefore = depotLedger(ctx.topo, plan);
  // every added trip keeps the minimum headway (P1) to all other trains along its whole
  // path; it is moved by up to half the overlay headway to find such a slot, otherwise
  // it is not run (reported as a shortfall)
  const idx = new DepIndex(existing);
  // Added trains arriving at an end of the added section, waiting to turn
  // back. A departure is placed, where its slot allows, inside the turnback
  // window of such a train, so that the added trips form circulations rather
  // than each arrival waiting out the intermediate station's turnback limit
  // and going back to the depot while a fresh train comes out for the
  // departure (D47).
  const waiting = new Map<number, GenTrip[]>([[a, []], [b, []]]);
  const waitAt = (X: number) => { if (!waiting.has(X)) waiting.set(X, []); return waiting.get(X)!; };
  const occ0 = turnbackOccupancy(ctx.topo, plan);
  const paired: { st: number; from: number; to: number }[] = [];
  const turnWait = (X: number) => X > 0 && X < ctx.topo.stations.length - 1 ? INTERMEDIATE_WAIT : MAX_LAYOVER;
  const turnFree = (station: number, from: number, to: number, own?: number) => {
    const clear = OPERATIONS.platformTurnClear[STATIONS[station].id] ?? 0;
    const pending = waitAt(station).filter(t => t.id !== own).map(t => ({from:t.stops.at(-1)!.arr,to:t.stops.at(-1)!.arr+minTurn(station)}));
    const list = [...(occ0.get(station) ?? []), ...paired.filter(o => o.st === station), ...pending]
      .map(o => ({from:o.from-clear,to:o.to+clear}));
    return !terminalOverflows(ctx.topo,station,[...list.filter(o=>o.from<to && o.to>from),{from,to}]).some(o=>o.t>=from && o.t<to);
  };
  let pairedWith: GenTrip | undefined;
  const fit = (dir: TrackDir, from: number, to: number, t: number, turn: boolean): PlanStop[] | null => {
    pairedWith = undefined;
    for (let k = 0; k * 10 <= preset.headway / 2; k++) {
      for (const t0 of k ? [t + k * 10, t - k * 10] : [t]) {
        let pair = -1;
        if (turn) {
          pair = waitAt(from).findIndex(A => t0 >= A.stops.at(-1)!.arr + minTurn(from) && t0 <= A.stops.at(-1)!.arr + minTurn(from) + turnWait(from)
            && turnFree(from,A.stops.at(-1)!.arr,t0,A.id)
            && tailOrderClear(ctx.topo, from, [...(occ0.get(from) ?? []), ...paired.filter(o => o.st === from)], A.stops.at(-1)!.arr, t0)
            && frontTurnClear(ctx, trips, A, t0, new Set([A.id])));
          if (pair < 0) continue;
        }
        const st = buildStops(ctx, dir, from, to, t0, true, factorAt);
        const rear = turnbackAt(ctx.topo,to,dir);
        if (!idx.clear(st, dir) || !storedPlatformsClear(ctx.topo,plan,{dir,to,stops:st},rear?.kind==='rear'?rear.berths[0]:undefined)) continue;
        if (!turnFree(to,st.at(-1)!.arr,st.at(-1)!.arr+minTurn(to))) continue;
        // Fit front-turn slots while placing the revenue streams, rather
        // than discovering after FIFO matching that every arrival occupies
        // a platform needed by the opposite stream.
        if (!frontTurnClear(ctx, trips, {dir,to,stops:st}, st.at(-1)!.arr+minTurn(to), new Set())) continue;
        const incoming = dir === 'DN' ? 'UP' : 'DN';
        // a train brought in to front-turn for it arrives between the
        // trains of its own direction, up to 2 min before its turnback
        // time, and holds the departure platform until it leaves
        const front = turnbackAt(ctx.topo, from, incoming)?.kind === 'front';
        const arrives = (w: number) => {
          const arrival = { ...st[0], arr: t0 - minTurn(from) - w, dep: t0 - minTurn(from) - w };
          return frontTurnClear(ctx, trips, { dir: incoming, to: from, stops: [arrival] }, t0, new Set())
            && (!front || idx.clear([arrival], incoming));
        };
        if (!turn && ![0, 10, 20, 30, 40, 50, 60, 80, 100, 120].some(arrives)) continue;
        if (turn) {
          pairedWith = waitAt(from).splice(pair, 1)[0];
          paired.push({ st: from, from: pairedWith.stops.at(-1)!.arr, to: t0 });
        }
        return st;
      }
    }
    return null;
  };
  // A grid trip the base plan alone leaves no room for — no time within
  // half the overlay headway at which its whole path keeps the minimum
  // headway and its front turns at both ends stay clear of the base trains
  // (the peak and its build-up; 虹桥火车站's front turnback while the base
  // runs closer than ~5 min) — cannot be added without retiming the base
  // plan. It is not requested; it is reported as such, not counted as a
  // shortfall of the added-service planning (D47).
  const baseTrips = existing.filter(t => !t.overlay && !t.cancelled);
  const base = new DepIndex(baseTrips);
  const baseRoom = (dir: TrackDir, from: number, to: number, t: number) => {
    for (let k = -preset.headway / 2; k <= preset.headway / 2; k += 10) {
      const st = buildStops(ctx, dir, from, to, t + k, true, factorAt);
      if (!base.clear(st, dir) || !frontTurnClear(ctx, baseTrips, { dir, to, stops: st }, st.at(-1)!.arr + minTurn(to), new Set())) continue;
      const arrival = { ...st[0], arr: st[0].dep - minTurn(from), dep: st[0].dep - minTurn(from) };
      if (frontTurnClear(ctx, baseTrips, { dir: dir === 'DN' ? 'UP' : 'DN', to: from, stops: [arrival] }, st[0].dep, new Set())) return true;
    }
    return false;
  };
  // An end of the added section that is a front turnback (虹桥火车站) turns
  // a train on a through platform: the platform must stay free of the base
  // trains of both directions from ~90 s before the arrival to ~90 s after
  // the departure, ≥300 s, and the arrival must keep the headway of its own
  // direction. With the base running every 4.5–7 min both ways there is no
  // such time (D47). The added trains run on to the nearest station beyond
  // it with a rear turnback (国家会展中心) and turn there, still serving the
  // whole requested section.
  // An end with no turnback at all (虹桥火车站 since the PDF layout) is served the same way.
  // (the duties are not touched while the grid is fitted: one storage calendar)
  const stored0 = storageOccupancy(ctx.topo, plan);
  const outward = (X: number, arrDir: TrackDir, at: number, next = false): number | undefined => {
    const available = (station: number) => {
      const rear = turnbackAt(ctx.topo, station, arrDir);
      if (rear?.kind !== 'rear') return false;
      const from = at - minTurn(station) - preset.headway/2;
      const to = at + minTurn(station) + preset.headway/2;
      const stored = stored0.filter(o => o.station === station && o.from < to && o.to > from
        && (o.from <= OPENING.dayStart || o.to >= OPENING.dayStart+86400 || o.to-o.from > MAX_LAYOVER));
      return rear.berths.some(b => !stored.some(o => o.link === ctx.topo.berths[b].link));
    };
    if (!next && available(X)) return undefined;
    const step = arrDir === 'DN' ? 1 : -1;
    for (let Y = X + step; Y >= 0 && Y < ctx.topo.stations.length; Y += step)
      if (available(Y)) return Y;
    return undefined;
  };
  const terminals = new Set([a, b]);
  const unfitted: {dir:TrackDir;from:number;to:number;at:number}[] = [];
  let requested = 0;
  let peak = 0;
  for (let t = preset.from; t <= preset.to; t += preset.headway) {
    for (const [dir, from, to, t0] of [[dirAB, a, b, t], [dirBA, b, a, t + preset.headway / 2]] as [TrackDir, number, number, number][]) {
      const back: TrackDir = dir === 'DN' ? 'UP' : 'DN';
      const run = buildStops(ctx, dir, from, to, t0, true, factorAt);
      const ends: [number, number][] = [[(turnbackAt(ctx.topo, from, back)?.kind === 'rear' ? from : outward(from, back, t0) ?? from), outward(to, dir, run.at(-1)!.arr) ?? to]];
      // the departure time is the one at the requested origin
      const at = (o: number) => o === from ? t0 : t0 - (buildStops(ctx, dir, o, to, t0, true, 1).find(p => p.st === from)!.dep - t0);
      const room = ends.filter(([o, d]) => baseRoom(dir, o, d, at(o)));
      if (!room.length) { peak++; continue; }
      requested++;
      let st: PlanStop[] | null = null, end = room[0];
      for (const [o, d] of room) {
        st = fit(dir, o, d, at(o), true) ?? fit(dir, o, d, at(o), false);
        if (st) { end = [o, d]; break; }
      }
      // A short turn already booked at the requested end can use its tail
      // even when no overnight car is there. Try the next physical turnback
      // before rejecting the request; keep serving the entire requested part.
      if (!st) {
        const beyond = outward(end[1], dir, run.at(-1)!.arr, true);
        if (beyond !== undefined && baseRoom(dir, end[0], beyond, at(end[0]))) {
          st = fit(dir, end[0], beyond, at(end[0]), true) ?? fit(dir, end[0], beyond, at(end[0]), false);
          if (st) end = [end[0], beyond];
        }
      }
      if (!st) { unfitted.push({dir,from:end[0],to:end[1],at:at(end[0])}); continue; }
      const trip = addTo(trips, dir, 'extra', end[0], end[1], st, true, tag);
      if (pairedWith) { pairedWith.next = trip.id; trip.prev = pairedWith.id; }
      idx.add(trip);
      waitAt(end[1]).push(trip);
      terminals.add(end[0]); terminals.add(end[1]);
    }
  }
  const reuse: OverlayReuse = { now: live?.now ?? -Infinity, canExtend: live?.canExtend ?? (() => false), blocks: plan.blocks, extended: [],
    returnShift: stockBefore.initial.map((n, d) => n - stockBefore.final[d]), stock: live?.stock, nightPlaces: deferred.map(x => x.place) };
  const blocks = overlayDuties(ctx, plan, tag, reuse);
  plan.blocks.push(...blocks);
  plan.overlays.push({ id: tag, label: preset.label, from: preset.from, to: preset.to, requested, peak });
  const maxSvc = Math.max(0, ...plan.blocks.filter((x) => x.svc).map((x) => parseInt(x.svc, 10)));
  numberPlan(plan, maxSvc + 1);
  plan.fleetPeak = fleetPeak(plan);
  for (const block of blocks) {
    if (block.end.kind!=='stable' || block.end.berth===undefined) continue;
    const last=trips[block.trips.at(-1)!], previous=trips[block.trips.at(-2)!];
    if (!last || last.id<n0 || last.revenue || !previous) continue;
    const berth=ctx.topo.berths[block.end.berth];
    const nightStation = block.end.station;
    if (berth.platform!==ctx.topo.stations[nightStation].platforms[last.dir]) continue;
    const uses=trips.filter(t=>t!==last && !t.cancelled && t.dir===last.dir)
      .flatMap(t=>t.stops.filter(s=>s.st===nightStation).map(s=>s.dep));
    const after=Math.max(...uses,0)+MIN_HEADWAY;
    if (last.stops.at(-1)!.arr>=after) continue;
    const index=new DepIndex(trips.filter(t=>t!==last));
    for (let offset=10;offset<=450;offset+=10) {
      const stops=buildStops(ctx,last.dir,last.from,last.to,last.stops[0].dep+offset,false,1);
      if (stops.at(-1)!.arr<after || !index.clear(stops,last.dir)) continue;
      const other=(terminalOccupancy(plan).get(last.from)??[]).filter(o=>o.block!==block.id);
      if (terminalOverflows(ctx.topo,last.from,[...other,{from:previous.stops.at(-1)!.arr,to:stops[0].dep}]).length) continue;
      last.stops=stops;
      break;
    }
  }
  // Fault cancellations change the available gaps and terminal occupancy.
  // Check complete added circulations after matching, including every point
  // inside a layover, rather than only the occupancy at its arrival event.
  const extended = reuse?.extended ?? [];
  extended.push(...deferred.map(x => ({block:x.block.id,last:x.block.trips.at(-2)!,trips:[x.move],tail:[],end:x.end})));
  const absorbed = reuse?.absorbed ?? [];
  /** a base duty taken over by the train of `block` goes back to its own train */
  const giveBack = (block: Block) => {
    for (const x of absorbed.filter(x => x.into === block.id)) {
      const own = plan.blocks[x.block];
      block.trips = block.trips.filter(id => !x.trips.includes(id));
      own.trips.push(...x.trips);
      for (const id of x.trips) trips[id].block = own.id;
      for (const id of x.lead) { trips[id].cancelled = false; delete trips[id].cancelReason; }
      own.end = x.end;
      absorbed.splice(absorbed.indexOf(x), 1);
    }
  };
  const added = (id: number) => blocks.some(b => b.id === id && b.trips.some(t => !trips[t].cancelled))
    || extended.some(x => x.block === id);
  // An added chain run by a base car that found no home (overlayDuties leaves
  // it to this check) ends its duty mid-line: give the base car its own
  // withdrawal back like any other infeasible extension.
  const homeless = (): PlanIssue | undefined => {
    const b = plan.blocks.find(x => added(x.id) && x.end.kind === 'none' && x.trips.some(id => !trips[id].cancelled));
    const last = b && trips[b.trips.filter(id => !trips[id].cancelled).at(-1)!];
    return b && last && { severity: 'error', code: 'BLOCK_BREAK', t: last.stops.at(-1)!.arr, blocks: [b.id],
      text: `车底 ${b.svc} 加开车次 ${last.no} 终到 ${STATIONS[last.to].name} 后无回段或存车安排` };
  };
  for (let attempt = 0; attempt < blocks.length + extended.length; attempt++) {
    const issue = homeless() ?? validatePlan(ctx, plan).find(i => i.blocks?.some(added));
    if (!issue) break;
    const reason = `加开能力不足：${issue.text}`;
    const x = extended.filter(e => issue.blocks!.includes(e.block)).at(-1);
    if (x) {
      // give the base train back its own withdrawal
      const block = plan.blocks[x.block];
      giveBack(block);
      for (const id of x.trips) cancelTrip(trips[id], reason);
      block.trips = block.trips.filter(id => !x.trips.includes(id));
      for (const id of x.tail) { trips[id].cancelled = false; delete trips[id].cancelReason; }
      block.end = x.end;
      extended.splice(extended.indexOf(x), 1);
    } else {
      const block = blocks.filter(b => issue.blocks!.includes(b.id) && b.trips.some(t => !trips[t].cancelled)).at(-1)!;
      giveBack(block);
      for (const id of block.trips) cancelTrip(trips[id], reason);
    }
    plan.fleetPeak = fleetPeak(plan);
  }
  // A base car sent on to the yard only gives up its overnight berth when an
  // added arrival really stands there now. Otherwise it keeps its slot.
  for (const x of deferred) {
    const kept = extended.find(e => e.block === x.block.id && e.trips.includes(x.move));
    if (!kept) continue;
    const delivered = plan.blocks.some(b => b !== x.block && b.end.kind === 'stable' && b.end.berth === x.place.arrivalBerth
      && b.trips.some(id => !trips[id].cancelled));
    if (delivered) continue;
    const moved = x.block.trips, end = x.block.end;
    x.block.trips = moved.filter(id => id !== x.move);
    x.block.end = x.end;
    const link = ctx.topo.berths[x.place.arrivalBerth].link;
    const slot = storageOccupancy(ctx.topo, plan).filter(o => o.link === link);
    const own = slot.find(o => o.block === x.block.id);
    const platformBlocked = trips.some(trip => {
      if (trip.cancelled || trip.block === x.block.id) return false;
      const duty = plan.blocks[trip.block];
      const next = duty && trips[duty.trips[duty.trips.indexOf(trip.id) + 1]];
      const turn = next && next.dir !== trip.dir ? turnbackAt(ctx.topo, trip.to, trip.dir) : undefined;
      // (only the berth being restored: a conflict elsewhere is not this car's)
      return !storedPlatformsClear(ctx.topo, plan, trip, turn?.kind === 'rear' ? turn.berths[0] : undefined, x.block);
    });
    // (an added turnback now needs the slot: the car stays on its way to the
    // yard and the ledger reports the berth short, rather than a conflict)
    if (platformBlocked || own && slot.some(o => o.block !== x.block.id && o.from < own.to && own.from < o.to)) {
      x.block.trips = moved; x.block.end = end;
      continue;
    }
    cancelTrip(trips[x.move], '加开：过夜位无加开车接替，原车照常入位');
    extended.splice(extended.indexOf(kept), 1);
  }
  plan.fleetPeak = fleetPeak(plan);
  // a move linked behind a cancelled arrival but never put in a block (its
  // withdrawal, after the trip it followed was dropped) does not run either
  for (const t of trips.slice(n0) as GenTrip[]) {
    const P = t.prev === undefined ? undefined : trips[t.prev];
    if (!t.cancelled && t.block < 0 && P?.cancelled) cancelTrip(t, P.cancelReason ?? '加开：前序车次取消');
  }
  // Close the stock flow across all retained duties, including returns whose
  // passenger services finished in a different yard. Real transfer workings
  // carry any residual surplus; no published service is retimed or removed.
  restoreCancelledHomes(ctx, plan, live?.now ?? OPENING.dayStart);
  numberPlan(plan, maxSvc + blocks.length + 1);
  plan.fleetPeak = fleetPeak(plan);
  // Retain every infeasible grid request in the preview with its reason.
  // These empty, cancelled duties reserve no car and never enter service.
  for (const request of unfitted) {
    const trip=addTo(trips,request.dir,'extra',request.from,request.to,
      buildStops(ctx,request.dir,request.from,request.to,request.at,true,factorAt),true,tag);
    trip.block=plan.blocks.length;
    cancelTrip(trip,'加开能力不足：整条路径的追踪间隔、折返占用或存车预留时段内无可用时隙');
    plan.blocks.push({id:trip.block,svc:'',start:{kind:'depot',depot:0,time:request.at},end:{kind:'none'},trips:[trip.id]});
  }
  numberPlan(plan,maxSvc+blocks.length+1);
  const kept = trips.slice(n0).filter((t) => !t.cancelled);
  return { trips: kept.length, blocks: blocks.length, extended, skipped: trips.slice(n0).filter((t) => t.cancelled && t.revenue).length };
}

/** Whole-duty cancellations can remove an overnight delivery or a cross-yard
 * return. Restore that physical stock separately from the added passenger
 * grid. Original cancelled trips stay intact; every transfer has a real,
 * headway-checked path and an explicit yard/berth destination. */
function restoreCancelledHomes(ctx: PlanContext, plan: Plan, now: number) {
  const { topo } = ctx;
  const cancelled = (b: Block) => b.trips.every(id => plan.trips[id].cancelled);
  const trips = plan.trips as GenTrip[], index = new DepIndex(trips), openers=openingAnchors(trips);
  const retained = plan.blocks.filter(b => cancelled(b) && b.start.kind === 'stable').map(b => b.start);
  const fitMove = (depot: number, station: number, dir: TrackDir, earliest: number, end: Block['end']) => {
    const ex = exitStation(topo, depot, dir);
    if (!ahead(dir, ex, station)) return null;
    // (the plan does not change while one move is fitted)
    const ledger = depotLedger(topo,plan);
    const turns = [...terminalOccupancy(plan).values()].flat();
    const plannedMoves = depotMoves(plan.blocks, trips, ctx);
    // The main line is cleared for the night's engineering work: a stock
    // move that cannot arrive before it leaves the car where it is (the next
    // day plans from the carried yard stock).
    const lastArrival = POSSESSIONS.nightFrom;
    for (let offset = 0; earliest + offset < lastArrival; offset += 10) {
      const stops = buildStops(ctx, dir, ex, station, earliest + offset, CARRY_MOVES, t => dwellFactorAt(ctx.dayType, t), () => true);
      const revenue=CARRY_MOVES&&carryingStops(stops,dir,openers);
      if(CARRY_MOVES&&!revenue&&passesOpenStation(stops,dir,openers))continue;
      if (stops.at(-1)!.arr >= lastArrival) break;
      if (depotStartTime(ctx, depot, { dir, stops }) < now + 120 || !index.clear(stops, dir)
        || !storedPlatformsClear(topo,plan,{dir,to:station,stops},end.kind==='stable'?end.berth:undefined)) continue;
      const first = { dir, stops }, [start, clear] = outboundWindow(ctx, depot, first);
      if (plan.blocks.some(b => b.end.kind === 'depot' && b.end.depot === depot && !cancelled(b)
        && (() => { const last=trips[b.trips.filter(id => !trips[id].cancelled).at(-1)!];
          return depotLeadsConflict(topo,depot,last.dir,dir) && (([a,z]) => start < z && clear > a)(inboundWindow(topo,depot,last)); })())) continue;
      if (end.kind === 'depot') {
        const [a,z] = inboundWindow(topo, end.depot, { to: station, stops });
        if (plan.blocks.some(b => b.start.kind === 'depot' && b.start.depot === end.depot && !cancelled(b)
          && (() => { const first=trips[b.trips.find(id => !trips[id].cancelled)!];
            return depotLeadsConflict(topo,end.depot,dir,first.dir) && (([x,y]) => x < z && y > a)(outboundWindow(ctx,end.depot,first)); })())) continue;
      }
      // Stock-restoring empty moves use the same lead reservations as a
      // passenger duty: an otherwise clear return may still cut across a
      // train waiting to leave its turnback. Fit that resource before adding
      // the move, including any alternative berth chosen for the existing turn.
      const candidate: Trip = { id: trips.length, no: '', block: plan.blocks.length, dir, kind: revenue?'ins':'empty', from: ex, to: station, stops, revenue };
      const proposedTrips = [...trips, candidate];
      const duty: Block = { id: candidate.block, svc: '', start: { kind: 'depot', depot, time: start }, end, trips: [candidate.id] };
      const moves = [...plannedMoves, ...depotMoves([duty], proposedTrips, ctx)];
      if (turns.some(hold => {
        const arrival = trips[hold.arrival!], departure = trips[hold.departure!];
        const berth = dutyTurnBerths(topo, { ...plan, trips: proposedTrips }, plan.blocks[hold.block], arrival, departure, moves)[0];
        return berth !== undefined && moves.some(move => move.block !== hold.block
          && turnLeadConflict(topo, move, proposedTrips, arrival, departure, berth));
      })) continue;
      const events = sortDepotMoves([...ledger.events.map(e=>({...e})),{time:start,depot,delta:-1,block:-1},
        ...(end.kind==='depot'?[{time:stops.at(-1)!.arr+DEPOT_ENTRY_CLEAR,depot:end.depot,delta:1,block:-1}]:[])]);
      const balance = ledger.initial.slice();
      let fits = true;
      for (const event of events) {
        balance[event.depot]+=event.delta;
        if (balance[event.depot]<0 || event.depot===depot && balance[depot]>Math.max(topo.depots[depot].capacity,ledger.peak[depot]-1)
          || end.kind==='depot' && event.depot===end.depot && balance[event.depot]>topo.depots[event.depot].capacity) {fits=false;break;}
      }
      if (!fits) continue;
      return stops;
    }
    return null;
  };
  const append = (b: Block, depot: number, station: number, dir: TrackDir, stops: PlanStop[]) => {
    const revenue=CARRY_MOVES&&carryingStops(stops,dir,openers);
    const move = addTo(trips, dir, revenue?'ins':'empty', stops[0].st, station, stops, revenue);
    move.block = b.id;
    b.trips.push(move.id);
    b.start = { kind: 'depot', depot, time: depotStartTime(ctx, depot, move) };
    index.add(move);
  };
  // A cancelled morning train still occupies its own berth; no delivery is
  // needed to that slot. Other cancelled night deliveries use the same duty.
  const deliveries = plan.blocks.filter(b => cancelled(b) && b.train === undefined && b.start.kind === 'depot' && b.end.kind === 'stable');
  // A retained car already stands in a night berth whose own delivery still
  // runs: that delivery is surplus, and its car clears on to a yard instead.
  for (const start of retained.slice()) {
    if (start.kind !== 'stable' || start.berth === undefined) continue;
    const link = topo.berths[start.berth].link;
    if (deliveries.some(b => b.end.kind === 'stable' && b.end.berth !== undefined && topo.berths[b.end.berth].link === link)) continue;
    const live = plan.blocks.find(b => !cancelled(b) && b.train === undefined && b.end.kind === 'stable' && b.end.berth !== undefined
      && topo.berths[b.end.berth].link === link);
    const last = live && trips[live.trips.filter(id => !trips[id].cancelled).at(-1)!];
    if (!live || !last || last.stops.at(-1)!.arr < now) continue;
    const move = clearOnToYard(ctx, trips, live, last);
    if (!move) continue;
    index.add(move);
    retained.splice(retained.indexOf(start), 1);
  }
  for (const b of deliveries) {
    if (b.end.kind !== 'stable' || b.end.berth === undefined) continue;
    const berth = topo.berths[b.end.berth];
    const stayed = retained.findIndex(start => start.kind === 'stable' && start.berth !== undefined && topo.berths[start.berth].link === berth.link);
    if (stayed >= 0) { retained.splice(stayed, 1); continue; }
    const ledger = depotLedger(topo, plan);
    // Cancelled morning stabling duties leave their cars on the line, even
    // when their original slot differs from the cancelled night delivery.
    // Only replace the net loss of line stock from the yards.
    if (ledger.final.reduce((sum, n, d) => sum + n - ledger.initial[d], 0) <= 0) break;
    const dir = (topo.links[berth.link].chainB - topo.links[berth.link].chainA) * berth.dir > 0 ? 'DN' : 'UP';
    const station = b.end.station;
    const lastUse = Math.max(OPENING.dayStart, ...trips.filter(t => !t.cancelled && t.dir === dir)
      .flatMap(t => t.stops.filter(s => s.st === station).map(s => s.dep)));
    const desired = Math.max(trips[b.trips.at(-1)!].stops.at(-1)!.arr, lastUse + MIN_HEADWAY);
    // Prefer the surplus yard, but a nearer yard can deliver the slot and
    // receive a real balancing transfer below. Its latest departure need not
    // precede a distant surplus yard's earlier capacity peak.
    const sources = topo.depots.slice().sort((a, b) => Number(ledger.final[b.id] > ledger.initial[b.id])
      - Number(ledger.final[a.id] > ledger.initial[a.id]));
    for (const depot of sources) {
      const run = buildStops(ctx, dir, exitStation(topo, depot.id, dir), b.end.station, desired, false, 1, () => true).at(-1)!.arr - desired;
      const stops = fitMove(depot.id, b.end.station, dir, desired - run, b.end);
      if (!stops) continue;
      append(b, depot.id, b.end.station, dir, stops);
      break;
    }
  }
  for (let guard = 0; guard < LINE_INFO.fleet; guard++) {
    const ledger = depotLedger(topo, plan);
    const surplus = topo.depots.filter(d => ledger.final[d.id] > ledger.initial[d.id]);
    const deficit = topo.depots.filter(d => ledger.final[d.id] < ledger.initial[d.id]);
    if (!surplus.length || !deficit.length) break;
    let placed = false;
    for (const source of surplus) for (const target of deficit) {
      if (placed) continue;
      const dir = source.junctionChain < target.junctionChain ? 'DN' : 'UP';
      const station = entryStation(topo, target.id, dir);
      const end: Block['end'] = { kind: 'depot', depot: target.id };
      const stops = fitMove(source.id, station, dir, now + 900, end);
      if (!stops) continue;
      const b: Block = { id: plan.blocks.length, svc: '', start: { kind: 'depot', depot: source.id, time: 0 }, end, trips: [] };
      append(b, source.id, station, dir, stops); plan.blocks.push(b); placed = true;
    }
    if (!placed) break;
  }
}

/** A standby train (备车) that can take over a duty: see `standbyCandidate`. */
export interface StandbyPlan { depot: number; k: number; start: number; dir: TrackDir; from: number; to: number; stops: PlanStop[] | null; standby?: boolean; revenue?: boolean }

/**
 * Standby takeover (备车顶替, D45): the earliest trip of `tail` (trip ids of
 * one duty, in order, from index `minK`) that a spare vehicle leaving
 * `depot` no earlier than `notBefore` can start on time. The empty move
 * from the yard keeps the minimum headway to every other trip along its
 * whole path and leaves the declared turnback time at the origin.
 * Pure: the plan is not changed.
 */
export function standbyCandidate(ctx: PlanContext, plan: Plan, tail: number[], depot: number, notBefore: number, minK = 0, maxK = tail.length - 1, allowPositioning = false): StandbyPlan | null {
  const { topo } = ctx;
  const own = new Set(tail);
  const index = new DepIndex(plan.trips.filter(t => !own.has(t.id)));
  const openers=openingAnchors(plan.trips);
  for (let k = minK; k <= maxK && k < tail.length; k++) {
    const D = plan.trips[tail[k]];
    if ((!D.revenue && !allowPositioning) || D.completed) continue;
    const T = D.from;
    const dep = D.stops[0].dep;
    const dir: TrackDir = topo.stations[T].chain < topo.depots[depot].junctionChain ? 'UP' : 'DN';
    const ex = exitStation(topo, depot, dir);
    if (ex === T) {
      const start = depotStartTime(ctx, depot, D);
      if (start >= notBefore) return { depot, k, start, dir, from: ex, to: T, stops: null };
      continue;
    }
    // An origin passed in the same direction is joined on the move; an
    // opposite one is reached on the arrival platform and turned back.
    const same = dir === D.dir;
    // Replacing a dedicated hot spare's empty return uses that spare's
    // registered storage approach, not an ordinary platform turnback.
    const storage = !same && allowPositioning && !D.revenue && hotStandbyPlaces(topo).find(p => p.depot
      && p.track === 'storage' && p.station === T && p.incoming === dir && storageArrivalBerth(topo,p.berth,dir)!==undefined);
    const mt = same ? 0 : minTurn(T);
    for (const stopping of CARRY_MOVES ? [true] : [false, true]) {
    const factor = (t: number) => dwellFactorAt(ctx.dayType, t);
    const calls = stopping ? () => true : undefined;
    const run = buildStops(ctx, dir, ex, T, dep, CARRY_MOVES, factor, calls).at(-1)!.arr - dep;
    const latest = dep - mt - (same ? 0 : 60) - run;
    for (let step = 0; step <= 90; step++) {
      const stops = buildStops(ctx, dir, ex, T, latest - step * 10, CARRY_MOVES, factor, calls);
      if(!CARRY_MOVES)stops[0].stop = false;
      if (same) stops[stops.length - 1].stop = false;
      if (storage) stops[stops.length - 1].stop = false;
      const revenue=CARRY_MOVES&&carryingStops(stops,dir,openers);
      if(CARRY_MOVES&&!revenue&&passesOpenStation(stops,dir,openers))continue;
      const start = depotStartTime(ctx, depot, { stops } as Trip);
      if (start < notBefore) break;
      if (stops.at(-1)!.arr > dep - mt + 1e-6 || !index.clear(stops, dir)) continue;
      const [,clear] = outboundWindow(ctx,depot,{dir,stops});
      const exitPath = topo.depots[depot].portals.exit[dir].path;
      if (plan.blocks.some(b => {
        if (b.withdrawal || b.end.kind !== 'depot' || b.end.depot !== depot) return false;
        const last = b.trips.map(id=>plan.trips[id]).filter(t=>!t.cancelled&&!own.has(t.id)).at(-1);
        if (!last || topo.depots[depot].portals.entry[last.dir].path !== exitPath) return false;
        const [approach,end] = inboundWindow(topo,depot,last);
        return start < end && clear > approach;
      })) continue;
      if (!same && !frontTurnClear(ctx, plan.trips, { dir, to: T, stops }, dep, new Set([D.id]))) continue;
      return { depot, k, start, dir, from: ex, to: T, stops, ...(storage ? { standby: true } : {}), ...(revenue ? {revenue:true} : {}) };
    }
    }
  }
  return null;
}

/** Apply a standby takeover: trips `tail[k..]` move from duty `from` to a
 * new duty run by the standby, and are reinstated if their cancellation was
 * caused by losing the original train. Returns the new block. With `from`
 * < 0 the standby only makes its move, to `end` (a vacated standby place). */
export function applyStandby(plan: Plan, from: number, tail: number[], c: StandbyPlan, end?: Block['end']): Block {
  const trips = plan.trips as GenTrip[];
  const taken = tail.slice(c.k);
  const id = plan.blocks.length;
  const ids: number[] = [];
  if (c.stops) {
    const move = addTo(trips, c.dir, c.revenue?'ins':'empty', c.from, c.to, c.stops.map(p => ({ ...p })), !!c.revenue);
    if (c.standby) move.standby = true;
    move.block = id;
    ids.push(move.id);
  }
  for (const t of taken) {
    const trip = trips[t];
    trip.block = id;
    trip.cancelled = false;
    delete trip.cancelReason;
    ids.push(t);
  }
  const old = from >= 0 ? plan.blocks[from] : undefined;
  if (old) {
    old.trips = old.trips.filter(t => !taken.includes(t));
    old.relieved = true;
  }
  const block: Block = { id, svc: '', start: { kind: 'depot', depot: c.depot, time: c.start }, end: end ?? old!.end, trips: ids };
  plan.blocks.push(block);
  const maxSvc = Math.max(0, ...plan.blocks.filter((x) => x.svc).map((x) => parseInt(x.svc, 10)));
  numberPlan(plan, maxSvc + 1);
  plan.fleetPeak = fleetPeak(plan);
  return block;
}

/** Single extra train (加开列车) from a depot to a turnback station and back. */
export function addExtraTrain(ctx: PlanContext, plan: Plan, depot: number, dir: TrackDir, to: number, time: number): Block | string {
  const { topo } = ctx;
  const ex = exitStation(topo, depot, dir);
  if ((dir === 'DN' && to <= ex) || (dir === 'UP' && to >= ex)) return '目的站不在出段方向前方';
  const back: TrackDir = dir === 'DN' ? 'UP' : 'DN';
  if (!turnbackAt(topo, to, dir)) return `${STATIONS[to].name} 无该方向折返条件`;
  const en = entryStation(topo, depot, back);
  const trips = plan.trips as GenTrip[];
  const index = new DepIndex(plan.trips);
  let s1: PlanStop[] = [], s2: PlanStop[] = [];
  for (let offset = 0; offset <= 900; offset += 10) {
    const out = buildStops(ctx, dir, ex, to, time + offset, true, 1);
    if (!index.clear(out,dir)) continue;
    // A lead that reaches the line against `dir` brings the train in on the
    // other track to change ends there: that pass keeps the headway of the
    // other direction, and no train of `dir` still has the departure
    // platform while it comes in (ARS lets the earlier departure go first).
    if (topo.depots[depot].portals.exit[dir].reverse) {
      const at = out[0].dep - PORTAL_REVERSE - 75;
      if (!index.clear([{ st: ex, arr: at, dep: at, stop: false }], back)
        || plan.trips.some(t => !t.cancelled && t.dir === dir && t.stops.some(p => p.st === ex && p.dep > at - 30 && p.dep < out[0].dep))) continue;
    }
    // Opposing streams need not have a usable slot exactly 240 seconds after
    // arrival. Search the permitted terminal layover; never hold ordinary stops.
    for(let wait=0;wait<=Math.max(0,(to===0||to===topo.stations.length-1?1500:450)-minTurn(to));wait+=10){
      const into = buildStops(ctx, back, to, en, out[out.length - 1].arr + minTurn(to)+wait, true, 1);
      if(index.clear(into,back)){s1=out;s2=into;break;}
    }
    if(s1.length)break;
  }
  if (!s1.length) return '未来15分钟内无全路径可行的加开及回段时隙';
  const t1 = addTo(trips, dir, 'extra', ex, to, s1, true, 'adhoc');
  const t2 = addTo(trips, back, 'extra', to, en, s2, true, 'adhoc');
  const b: Block = { id: plan.blocks.length, svc: '', start: { kind: 'depot', depot, time: 0 }, end: { kind: 'depot', depot }, trips: [t1.id, t2.id] };
  t1.block = t2.block = b.id;
  b.start = { kind: 'depot', depot, time: depotStartTime(ctx, depot, t1) };
  plan.blocks.push(b);
  const maxSvc = Math.max(0, ...plan.blocks.filter((x) => x.svc).map((x) => parseInt(x.svc, 10)));
  numberPlan(plan, maxSvc + 1);
  plan.fleetPeak = fleetPeak(plan);
  return b;
}

// ---------------------------------------------------------------- turnback & tasks

export type Turnback = { kind: 'rear'; berths: number[] } | { kind: 'front'; arrBerth: number; depBerth: number };

/** how a train arriving at `station` travelling `arrDir` can reverse there */
export function turnbackAt(topo: Topology, station: number, arrDir: TrackDir): Turnback | null {
  const s = topo.stations[station];
  // A middle-track platform (广兰路) has a throat to both mains at each end: a
  // train arriving the other way stops on it heading its own way and changes
  // ends there too (用户决定 2026-11-08：川沙出段车经广兰路换端).
  const twins = s.turnbackBerths.flatMap(bid => {
    const b = topo.berths[bid];
    if (b.kind !== 'platform') return [];
    const twin = topo.berths.find(o => o.link === b.link && o.kind === 'platform' && o.dir === -b.dir);
    return twin ? [twin.id] : [];
  });
  // a berth serves arrivals that keep their heading into it (eastbound berths for DN)
  const rear = [...s.turnbackBerths, ...twins].filter((bid) => {
    const b = topo.berths[bid];
    const l = topo.links[b.link];
    const east = (l.chainB - l.chainA) * b.dir > 0;
    return arrDir === 'DN' ? east : !east;
  });
  // D149: the station's main turnback track first; the others remain
  // alternatives the arbiter offers only after it (occupancy, conflicts).
  const main = OPERATIONS.mainTurnback?.[STATIONS[station].id];
  if (main) rear.sort((a, b) => Number(topo.berths[b].name === main) - Number(topo.berths[a].name === main));
  if (rear.length) return { kind: 'rear', berths: rear };
  if (s.frontTurnback[arrDir]) {
    // arrive on the opposite platform against its normal direction
    const opp = arrDir === 'DN' ? s.platforms.UP : s.platforms.DN;
    const travel = arrDir === 'DN' ? 1 : -1;
    const arrBerth = topo.berths.find((b) => b.platform === opp && b.dir === travel)!.id;
    const depBerth = topo.berths.find((b) => b.platform === opp && b.dir !== travel)!.id;
    return { kind: 'front', arrBerth, depBerth };
  }
  return null;
}

/** `from`: the station the train comes from. Where a joining run has a platform face of its own,
 * its trains stop there and not at the face of the main they then meet. */
export function platformBerth(topo: Topology, station: number, dir: TrackDir, from?: number): number {
  const s = topo.stations[station];
  const p = (from === undefined ? undefined : topo.platforms.find(x => x.station === station && x.track === dir && x.from === from)?.id)
    ?? (dir === 'DN' ? s.platforms.DN : s.platforms.UP);
  const travel = dir === 'DN' ? 1 : -1;
  return topo.berths.find((b) => b.platform === p && b.dir === travel)!.id;
}

/** Existing depot leads may also serve as turnback tracks. Reserve the
 * other lead while a direct return needs one, in both tasks and validation. */
const DEPOT_TURN_CLEAR = 120;
function dutyTurnBerths(topo: Topology, plan: Plan, block: Block, arrival: Trip, departure: Trip, plannedMoves?: YardMove[]): number[] {
  const turn = turnbackAt(topo, arrival.to, arrival.dir);
  if (turn?.kind !== 'rear') return [];
  let berths = turn.berths;
  const hot = hotStandbyPlaces(topo).find(p => p.station === arrival.to);
  if (hot?.depot && !arrival.standby) {
    const busy = plan.blocks.some(b => b.id !== block.id && b.trips.some((id, i) => {
      const a = effectiveTrip(plan.trips[id]), rawD = plan.trips[b.trips[i + 1]], d = rawD && effectiveTrip(rawD);
      return !!a && !a.cancelled && a.standby && a.to === arrival.to && d && !d.cancelled
        && a.stops.at(-1)!.arr < departure.stops[0].dep && d.stops[0].dep > arrival.stops.at(-1)!.arr;
    }));
    if (busy) berths = berths.filter(b => topo.berths[b].link !== topo.berths[hot.berth].link);
  }
  if (!berths.some(berth => topo.depots.some(yard => yard.transferPaths.some(path => path.flow === 'shared'
    && path.stub === topo.berths[berth].link)))) return berths;
  const moves = plannedMoves ?? depotMoves(plan.blocks, plan.trips, { topo });
  const clear = berths.filter(berth => !moves.some(move => move.block !== block.id
    && turnLeadConflict(topo, move, plan.trips, arrival, departure, berth)));
  // Keep an infeasible choice visible to validation rather than substituting
  // an unmodelled route or silently dropping the duty.
  if (clear.length) berths = clear;
  return berths;
}

/** A turn standing at `station` from its arrival (`from`, running `arrDir`) to its departure (`to`, running `depDir`). */
export interface LeadTurn { station: number; arrDir: TrackDir; depDir: TrackDir; from: number; to: number }
/** A yard move over its depot lead `link` during `window`; `entry`: a return entering the
 * depot, with the direction it runs in and its last stop and arrival there. */
export interface LeadMove { depot: number; link: number | undefined; window: readonly [number, number]; entry?: { dir: TrackDir; station: number; arr: number } }

/** One resource rule for a turn on a turnback track that is also a depot lead (淞虹路 1/2 道)
 * and a yard move: the duty planner's track assignment (duty/moves.ts leadRoom), the
 * turnback choice of tasks and duty matching, and validation (DEPOT_CONFLICT) all ask this.
 * The turn on `berth` conflicts while the move holds that track, or when a return enters
 * there close to the turn's departure over the turn's exit route. */
export function leadMoveConflict(topo: Topology, turn: LeadTurn, berth: number, move: LeadMove): boolean {
  if (move.link === undefined) return false;
  const [start, clear] = move.window;
  if (topo.berths[berth].link === move.link && turn.from < clear - .001 && start < turn.to - .001) return true;
  const entry = move.entry;
  return !!entry && !topo.depots[move.depot].portals.entry[entry.dir].reverse
    && entry.station === turn.station && entry.dir === turn.arrDir && turn.from < entry.arr
    && Math.abs(entry.arr - turn.to) < DEPOT_TURN_CLEAR
    && returnSharesTurnExit(topo, move.depot, entry.dir, turn.station, turn.depDir, berth);
}

function turnLeadConflict(topo: Topology, move: YardMove, trips: readonly Trip[], arrival: Trip, departure: Trip, berth: number): boolean {
  if (move.link === undefined || !move.window || move.trip === undefined) return false;
  const moving = effectiveTrip(trips[move.trip]);
  return leadMoveConflict(topo, { station: arrival.to, arrDir: arrival.dir, depDir: departure.dir, from: arrival.stops.at(-1)!.arr, to: departure.stops[0].dep }, berth, {
    depot: move.depot, link: move.link, window: move.window,
    ...(moving && move.delta > 0 ? { entry: { dir: moving.dir, station: moving.to, arr: moving.stops.at(-1)!.arr } } : {}),
  });
}

/** Check the actual interlocking sections. SHR2 -> DN and UP -> SHR1 are
 * disjoint straight routes (layout PDF); SHR1 -> DN crosses that return.
 * Keep the existing clearance whenever routes overlap or are unknown. */
function returnSharesTurnExit(topo: Topology, depot: number, inDir: TrackDir, station: number, outDir: TrackDir, berth: number): boolean {
  const yard = topo.depots[depot];
  if (!yard) return true;
  const entryStub = yard.transferPaths[yard.portals.entry[inDir].path].stub;
  const tail = topo.links[topo.berths[berth].link];
  const head = topo.berths[berth].dir === 1 ? tail.a : tail.b;
  const platform = topo.platforms[topo.stations[station].platforms[outDir]].link;
  const entries = topo.routes.filter(route => route.steps.at(-1)?.link === entryStub && topo.links[route.steps[0].link].track === inDir);
  const exits = topo.routes.filter(route => topo.signals[route.start].node === head && route.end >= 0 && topo.signals[route.end].link === platform);
  if (!entries.length || !exits.length) return true;
  return entries.some(entry => exits.some(exit => entry.sections.some(section => exit.sections.includes(section))
    || entry.switches.some(point => exit.switches.some(other => other.sw === point.sw))));
}

/** Actual service stops, derived solely from the immutable runtime cut while
 * preserving the original diagram. Callers must only set a valid stopIndex
 * corresponding to the cut station. A passed station becomes an actual stop
 * only in this view; task generation determines terminal departure semantics. */
export function effectiveStops(trip: Trip): PlanStop[] {
  if (!trip.cut) return trip.stops;
  const stops = trip.stops.slice(0, trip.cut.stopIndex + 1);
  const last = stops.at(-1);
  if (last && !last.stop) stops[stops.length - 1] = { ...last, stop: true };
  return stops;
}

export function effectiveEnd(trip: Trip): number | undefined {
  return trip.cut ? effectiveStops(trip).at(-1)?.st : trip.to;
}

/** A transient view; never overwrite the trip or its original diagram stops. */
export function effectiveTrip(trip: Trip): Trip | undefined {
  if (!trip.cut) return trip;
  const stops = effectiveStops(trip), end = stops.at(-1);
  return end ? { ...trip, to: end.st, stops } : undefined;
}

/** Task list for a block (from its first trip). */
/** Where a passenger on `trip` is carried: a trip that runs through its last
 * station without stopping (an opening feeder, D73) goes on as its block's next
 * trip in the same direction, so destination displays name that trip's end. */
export function serviceEnd(plan: Pick<Plan, 'trips' | 'blocks'>, trip: Trip): number | undefined {
  let actual = effectiveTrip(trip);
  if (!actual) return;
  for (let k = 0; k < 8 && actual.stops.at(-1)?.stop === false; k++) {
    const block = plan.blocks[actual.block];
    if (!block) break;
    const next = block.trips.slice(block.trips.indexOf(actual.id) + 1).map(id => plan.trips[id]).find(t => !t.cancelled);
    if (!next || next.dir !== actual.dir || next.from !== actual.to || !next.revenue) break;
    const continued = effectiveTrip(next);
    if (!continued) break;
    actual = continued;
  }
  return actual.to;
}

export function blockTasks(topo: Topology, plan: Plan, block: Block, fromTrip = 0): Task[] {
  const tasks: Task[] = [];
  const ids = block.trips.slice(fromTrip);
  for (let k = 0; k < ids.length; k++) {
    const raw = plan.trips[ids[k]];
    if (raw.cancelled) continue;
    const trip = effectiveTrip(raw);
    // An empty service is an unresolved physical boundary, not a cancelled
    // trip: do not invent a connection to a later duty.
    if (!trip) break;
    const fromDepot = k === 0 && block.start.kind === 'depot' && fromTrip === 0;
    if (fromDepot && block.start.kind === 'depot') {
      const depot = topo.depots[block.start.depot], work = OPERATIONS.depotLeadWork?.[depot.key];
      const berth = depot.transferPaths[depot.portals.exit[trip.dir].path].exitWorkBerth;
      if (work && berth !== undefined) tasks.push({ k:'stop', berth, station:depot.station, trip:-1,
        arr:null, dep:null, doors:false, revenue:false, minDwell:work.exitS, note:'出段固定作业',
        depotWork:{kind:'out',depot:block.start.depot,berths:[berth]} });
      portalExitTasks(topo, block.start.depot, trip, tasks);
    }
    if (k === 0 && fromTrip === 0 && block.start.kind === 'stable' && block.start.berth !== undefined
      && trip.from === block.start.station && trip.stops[0]?.stop) {
      const start = topo.berths[block.start.berth];
      const shunt = start && topo.stations[block.start.station].shuntEntries.find(entry =>
        entry.storageLink === start.link && entry.incoming === trip.dir);
      const platform = platformBerth(topo, trip.from, trip.dir);
      const reverse = topo.berths.find(berth => berth.platform === topo.berths[platform].platform
        && berth.link === topo.berths[platform].link && berth.dir === -topo.berths[platform].dir);
      if (shunt && reverse) {
        tasks.push({ k:'reverse', berths:[shunt.berth], chosen:shunt.berth, station:trip.from, minTime:40 });
        tasks.push({ k:'reverse', berths:[reverse.id], chosen:reverse.id, station:trip.from, minTime:40 });
      }
    }
    const first = tasks.length;
    tripTasks(topo, trip, tasks, fromDepot);
    // An explicit overnight berth fixes the departure platform as well as
    // the train's initial position (CORE_E middle track versus DN main).
    if (k === 0 && fromTrip === 0 && block.start.kind === 'stable' && block.start.berth !== undefined) {
      const departure = tasks.slice(first).find((t): t is StopTask => t.k === 'stop');
      if (departure && topo.berths[block.start.berth].kind === 'platform') departure.berth = block.start.berth;
    }
    // an overnight train comes out of its stabling place shortly before its
    // first departure, not as soon as the day starts (D72)
    if (k === 0 && fromTrip === 0 && block.start.kind === 'stable') {
      const departure = tasks.slice(first).find((t): t is StopTask => t.k === 'stop');
      if (departure) departure.stabledOut = true;
    }
    // after a hot standby: its departure stop (D70)
    const previous = block.trips.slice(0, fromTrip + k).map(i => plan.trips[i]).filter(t => !t.cancelled).at(-1);
    const before = previous && effectiveTrip(previous);
    const dep = tasks.slice(first).find((t): t is StopTask => t.k === 'stop');
    if (before?.standby && dep) dep.standby = true;
    const nextRaw = ids.slice(k + 1).map(i => plan.trips[i]).find(t => !t.cancelled);
    const next = nextRaw && effectiveTrip(nextRaw);
    // 终到清客（D188）: the passengers leave unless the train runs on with them
    const clearS = OPERATIONS.terminalClearS ?? 0;
    if (clearS > 0 && trip.revenue && !(next?.revenue && next.dir === trip.dir)) {
      const last = tasks.slice(first).filter((t): t is StopTask => t.k === 'stop' && t.trip === trip.id).at(-1);
      if (last?.doors) last.minDwell = Math.max(last.minDwell ?? 0, clearS);
    }
    if (next) {
      if (next.dir !== trip.dir) {
        const hot = trip.standby && hotStandbyPlaces(topo).find(p => p.station === trip.to && p.depot);
        const berth = hot && storageArrivalBerth(topo, hot.berth, trip.dir);
        if (berth !== undefined && berth !== false) {
          tasks.push({ k: 'reverse', berths: [berth], chosen: berth, station: trip.to, minTime: 40 });
        } else addTurnback(topo, trip, tasks);
        const reverse = tasks.at(-1);
        if (!hot && reverse?.k === 'reverse') {
          const berths = dutyTurnBerths(topo, plan, block, trip, next);
          if (berths.length) { reverse.berths = berths; reverse.chosen = berths[0]; }
        }
      }
    }
    else if (!nextRaw) appendBlockEndTasks(topo, plan, block, trip, tasks);
  }
  // The arbiter may choose a different free tail. For a long planned turn,
  // every offered alternative must pass the same physical waiting decision
  // used by validation; no global plan or live occupancy is cached here.
  const live = ids.map(id => plan.trips[id]).filter(t => t && !t.cancelled).map(effectiveTrip);
  for (let i = 1; i < live.length; i++) {
    const a = live[i - 1], d = live[i];
    if (!a || !d) continue;
    if (a.to !== d.from || a.dir === d.dir || a.standby || !plannedWaitLong(plan.dayType, a, d)) continue;
    const arrival = tasks.map(t => t.k === 'stop' && t.trip === a.id).lastIndexOf(true);
    const departure = tasks.findIndex((t, index) => index > arrival && t.k === 'stop' && t.trip === d.id);
    if (arrival < 0 || departure <= arrival) continue;
    const index = tasks.findIndex((t, index) => index > arrival && index < departure && t.k === 'reverse');
    const reverse = tasks[index];
    if (reverse?.k !== 'reverse') continue;
    const choice = plannedWaitBerth(topo, a, d, tasks, index, reverse.berths, reverse.chosen);
    if (choice.safe && choice.safeBerths.length) {
      reverse.chosen = choice.selectedBerth!;
      reverse.berths = choice.safeBerths;
    }
  }
  return tasks;
}

/** Finish the same block after its last service, including an adjusted trip. */
export function appendBlockEndTasks(topo: Topology, plan: Plan, block: Block, trip: Trip, tasks: Task[]) {
  const destination = block.end.kind === 'depot' ? entryStation(topo, block.end.depot, trip.dir)
    : block.end.kind === 'stable' ? block.end.station : trip.to;
  let direction = trip.dir;
  const toward = directionToward(topo.stations[trip.to].chain, topo.stations[destination].chain, direction);
  if (toward !== direction && turnbackAt(topo, trip.to, direction)) {
    addTurnback(topo, trip, tasks);
    direction = toward;
    // The normal block task builder starts the positioning trip at the
    // departure platform after the same turnback.
    tasks.push({ k:'stop', berth:platformBerth(topo,trip.to,direction), station:trip.to,
      trip:-1, arr:null, dep:null, doors:false, revenue:false, note:'回段定位' });
  }
  if (block.end.kind === 'depot') depotTasks(topo, block.end.depot, direction, tasks);
  else if (block.end.kind === 'stable') {
    if (destination !== trip.to) tasks.push({ k:'stop', berth:platformBerth(topo,destination,direction), station:destination,
      trip:-1, arr:null, dep:null, doors:false, revenue:false, note:'存车定位' });
    if (block.end.berth !== undefined) {
      if (topo.berths[block.end.berth].kind === 'platform') retargetArrival(tasks, destination, block.end.berth);
      const target=topo.berths[block.end.berth];
      const shunt=topo.stations[destination].shuntEntries.find(entry=>entry.storageLink===target.link&&entry.incoming===direction);
      if (shunt) {
        const reverse: TrackDir=direction==='DN'?'UP':'DN';
        const berth=storageArrivalBerth(topo,block.end.berth,reverse);
        if (berth !== undefined) {
          tasks.push({k:'reverse',berths:[shunt.berth],chosen:shunt.berth,station:destination,minTime:40});
          tasks.push({k:'stable',berth,reason:'存车',station:destination});
          return;
        }
      }
      tasks.push({ k: 'stable', berth: block.end.berth, reason: '存车', station: destination });
      return;
    }
    const positioned = destination === trip.to ? trip : { ...trip, to:destination, dir:direction };
    const tb = turnbackAt(topo, destination, direction);
    if (tb && tb.kind === 'rear' && !tailTasks(topo, plan, block, positioned, tasks)) tasks.push({ k: 'stable', berth: -1, reason: '存车', station: destination });
  }
}

/**
 * The first trains stabled overnight at a terminal with a storage tail
 * (蟠祥路下行尾轨) go on into it, the first deepest: it is entered only from
 * the departure platform, so the train turns through a turnback track, changes
 * ends again on the departure platform and sets back into the tail. The last
 * ones stay in the turnback tracks, which they would otherwise block.
 * false: this train stays in a turnback track.
 */
function tailTasks(topo: Topology, plan: Plan, block: Block, trip: Trip, tasks: Task[]): boolean {
  const st = topo.stations[trip.to];
  const tb = turnbackAt(topo, trip.to, trip.dir);
  if (!st.storageBerths.length || tb?.kind !== 'rear') return false;
  const lastArr = (b: Block) => plan.trips[b.trips.filter((id) => !plan.trips[id].cancelled).at(-1)!].stops.at(-1)!.arr;
  const ending = plan.blocks.filter((b) => b.end.kind === 'stable' && b.end.station === trip.to && b.trips.some((id) => !plan.trips[id].cancelled))
    .sort((a, b) => lastArr(a) - lastArr(b));
  const rank = ending.indexOf(block);
  if (rank < 0 || rank >= Math.min(st.storageBerths.length, ending.length - st.turnbackBerths.length)) return false;
  const plat = platformBerth(topo, trip.to, trip.dir === 'DN' ? 'UP' : 'DN');
  tasks.push({ k: 'reverse', berths: tb.berths, chosen: tb.berths[0], station: trip.to, minTime: 40 });
  tasks.push({ k: 'stop', berth: plat, station: trip.to, trip: -1, arr: null, dep: null, doors: false, revenue: false, note: '入尾轨换端' });
  tasks.push({ k: 'reverse', berths: [plat], chosen: plat, station: trip.to, minTime: 40 });
  tasks.push({ k: 'stable', berth: st.storageBerths[st.storageBerths.length - 1 - rank], reason: '存车' });
  return true;
}

/** A move out of the depot reaching its first platform against the trip's
 * direction stops there and changes ends before the trip starts. */
function portalExitTasks(topo: Topology, depot: number, trip: Trip, tasks: Task[]) {
  const p = topo.depots[depot].portals.exit[trip.dir];
  shuntTasks(topo.depots[depot].transferPaths[p.path].shuntBerths, topo.depots[depot].station, tasks);
  if (!p.reverse) return;
  const plat = topo.stations[p.station].platforms[trip.dir];
  const travel = trip.dir === 'DN' ? 1 : -1;
  const berth = topo.berths.find((b) => b.platform === plat && b.dir !== travel)!.id;
  tasks.push({ k: 'stop', berth, station: p.station, trip: trip.id, arr: null, dep: null, doors: false, revenue: false, note: '出段换端' });
  tasks.push({ k: 'reverse', berths: [berth], chosen: berth, station: p.station, minTime: 40 });
  // then stand at the platform in the trip's direction (as after a station-front
  // turnback) unless the trip itself stops there first
  const first = trip.stops[0];
  if (!(first.st === p.station && first.stop)) {
    const dep = trip.stops.find((x) => x.st === p.station)?.dep ?? first.dep;
    tasks.push({ k: 'stop', berth: platformBerth(topo, p.station, trip.dir), station: p.station, trip: trip.id, arr: null, dep, doors: false, revenue: false, note: '出段换端' });
  }
}

/** Into `depot` after running `dir`: where the leads are entered against that
 * direction the train first changes ends on the junction station's platform. */
export function depotTasks(topo: Topology, depot: number, dir: TrackDir, tasks: Task[]) {
  const p = topo.depots[depot].portals.entry[dir];
  const yard = topo.depots[depot], work = OPERATIONS.depotLeadWork?.[yard.key];
  const addWork = (berths:number[]) => {
    if (!work || !berths.length) return;
    tasks.push({ k:'stop', berth:berths[0], station:yard.station, trip:-1, arr:null, dep:null,
      doors:false, revenue:false, minDwell:work.entryS, note:'入段固定作业',
      depotWork:{kind:'in',depot,berths} });
  };
  if (work?.entryPosition === 'platform') addWork([platformBerth(topo, p.station, dir)]);
  if (p.reverse) {
    const berth = platformBerth(topo, p.station, dir);
    const last = tasks[tasks.length - 1];
    if (!(last?.k === 'stop' && last.station === p.station && last.berth === berth)) {
      tasks.push({ k: 'stop', berth, station: p.station, trip: -1, arr: null, dep: null, doors: false, revenue: false, note: '回段换端' });
    }
    tasks.push({ k: 'reverse', berths: [berth], chosen: berth, station: p.station, minTime: 40 });
  }
  if (work?.entryPosition === 'lead') {
    const candidates = yard.transferPaths.flatMap((path,index) => {
      if (yard.entryBerths[index] < 0) return [];
      const berth = leadWorkBerth(topo, path.stub);
      return berth ? [{ index, berth:berth.id }] : [];
    });
    candidates.sort((a,b) => Number(b.index === p.path) - Number(a.index === p.path));
    addWork(candidates.map(c => c.berth));
  }
  shuntTasks(yard.transferPaths[p.path].shuntBerths, yard.station, tasks);
  tasks.push({ k: 'depot', depot, berth: yard.entryBerths[p.path] });
}

/** A lead into 牵出线 (DepotDef.shunts): the move runs to a 牵出线's end (its own yard track's
 * first, the other when that one is taken) and changes ends there. */
function shuntTasks(berths: number[] | undefined, station: number, tasks: Task[]) {
  if (!berths?.length) return;
  tasks.push({ k: 'reverse', berths: [...berths], chosen: berths[0], station, minTime: 40 });
}

/** The fixed entry work place on a depot lead (its inward siding berth). */
function leadWorkBerth(topo: Topology, stub: number) {
  return topo.berths.find(b => b.link === stub && b.dir === 1 && b.kind === 'siding');
}

/** Entering `depot` straight off the lead track `stub` a train already stands
 * on: that lead's fixed entry work, then the yard. Undefined where the line
 * does not lead into the yard from there, or the entry work is done on a
 * platform (the ordinary portal path, depotTasks, applies). */
export function depotLeadTasks(topo: Topology, depot: number, stub: number): Task[] | undefined {
  const yard = topo.depots[depot], work = OPERATIONS.depotLeadWork?.[yard.key];
  const index = yard.transferPaths.findIndex(path => path.stub === stub);
  if (index < 0 || yard.entryBerths[index] < 0 || work && work.entryPosition !== 'lead') return undefined;
  const tasks: Task[] = [];
  if (work) {
    const berth = leadWorkBerth(topo, stub);
    if (!berth) return undefined;
    tasks.push({ k:'stop', berth:berth.id, station:yard.station, trip:-1, arr:null, dep:null,
      doors:false, revenue:false, minDwell:work.entryS, note:'入段固定作业', depotWork:{kind:'in',depot,berths:[berth.id]} });
  }
  shuntTasks(yard.transferPaths[index].shuntBerths, yard.station, tasks);
  tasks.push({ k: 'depot', depot, berth: yard.entryBerths[index] });
  return tasks;
}

export function tripTasks(topo: Topology, trip: Trip, tasks: Task[], fromDepot: boolean) {
  const actual = effectiveTrip(trip);
  if (!actual) return;
  trip = actual;
  for (let i = 0; i < trip.stops.length; i++) {
    const s = trip.stops[i];
    if (!s.stop) continue;
    const isFirst = i === 0;
    tasks.push({
      k: 'stop', berth: platformBerth(topo, s.st, trip.dir, trip.stops[i - 1]?.st), station: s.st, trip: trip.id, stopIndex: i,
      arr: isFirst && !fromDepot ? null : s.arr, dep: i === trip.stops.length - 1 ? null : s.dep,
      doors: trip.revenue, revenue: trip.revenue, ...(s.noBoard ? { noBoard: true } : {}),
    });
  }
}

export function addTurnback(topo: Topology, trip: Trip, tasks: Task[]) {
  const actual = effectiveTrip(trip);
  if (!actual) return;
  trip = actual;
  const tb = turnbackAt(topo, trip.to, trip.dir);
  if (!tb) return;
  if (tb.kind === 'rear') {
    // a platform turnback track (广兰路 middle track): set down there, not on the main
    const platform = topo.berths[tb.berths[0]].kind === 'platform';
    if (platform) retargetArrival(tasks, trip.to, tb.berths[0]);
    const minTime = platform ? OPERATIONS.platformChangeEndsS?.[STATIONS[trip.to].id] ?? 40 : 40;
    tasks.push({ k: 'reverse', berths: tb.berths, chosen: tb.berths[0], station: trip.to, minTime });
  } else {
    // station-front: retarget the arrival stop to the opposite platform
    retargetArrival(tasks, trip.to, tb.arrBerth);
    tasks.push({ k: 'reverse', berths: [tb.arrBerth], chosen: tb.arrBerth, station: trip.to, minTime: 40 });
  }
}

function retargetArrival(tasks: Task[], station: number, berth: number) {
  for (let i = tasks.length - 1; i >= 0; i--) {
    const t = tasks[i];
    // a copy: a running train's task objects are shared with its checkpoints
    if (t.k === 'stop' && t.station === station) { if (t.berth !== berth) tasks[i] = { ...t, berth }; break; }
  }
}

/** A train that reversed at a platform berth departs from that platform: the
 * berth facing its new direction on the same platform, if it differs from the
 * planned one (广兰路 middle track instead of the UP main). */
export function departureBerthAfterReverse(topo: Topology, reversedAt: number, planned: number): number {
  const b = topo.berths[reversedAt];
  if (b.kind !== 'platform' || topo.berths[planned].kind !== 'platform' || topo.berths[planned].platform === b.platform) return planned;
  return topo.berths.find((x) => x.platform === b.platform && x.dir !== b.dir)?.id ?? planned;
}

// ---------------------------------------------------------------- validation

export interface PlanIssue {
  /** Whole-day yard aggregates compare by yard and magnitude, never display text/time. */
  depot?: number;
  delta?: number;
  /** Exact interval for resolving timing conflicts; text is rounded for display. */
  gap?: number;
  /** Circulations contributing to this conflict; used by pure overlay fitting. */
  blocks?: number[];
  /** The two service events of a connection when that choice caused an issue. */
  arrival?: number;
  departure?: number;
  /** Physical platform holder and conflicting service, or a headway pair. */
  holdBlock?: number;
  conflictingTrip?: number;
  conflictingTrips?: number[];
  severity: 'error' | 'warn';
  code: 'SERVICE_STRUCTURE' | 'TURN_SHORT' | 'TURN_UNAVAILABLE' | 'BLOCK_BREAK' | 'TERMINAL_FULL' | 'TAIL_ORDER' | 'FRONT_CONFLICT' | 'LAYOVER_LONG' | 'UNSAFE_WAIT' | 'DEPOT_CONFLICT' | 'HEADWAY' | 'FLEET' | 'TIME_ORDER' | 'UNASSIGNED' | 'STABLE_CONFLICT' | 'TURN_HEADWAY' | 'YARD_CAPACITY' | 'YARD_BALANCE' | 'POSSESSION' | 'TRIP_DIRECTION';
  t: number;
  text: string;
}

/** shortest turnback the line can do (s): P1 table 1, CBTC 115–120 s */
/** shortest station headway (s), a hard planning limit: P1 table 1, CBTC
 *  design headway ≤ 90 s. The headways the templates aim for (D50) are wider. */
export const MIN_HEADWAY = 90;

/** A front turn occupies the opposite platform from arrival to departure.
 * Its timetable slot must protect normal-direction arrivals through that
 * platform as well as the incoming train's own departure stream. */
export function frontTurnClear(ctx: PlanContext, trips: readonly Pick<Trip, 'id' | 'dir' | 'stops' | 'cancelled'>[], arrival: Pick<Trip, 'dir' | 'to' | 'stops'>, departure: number, excluded: Set<number>): boolean {
  if (turnbackAt(ctx.topo, arrival.to, arrival.dir)?.kind !== 'front') return true;
  const arr = arrival.stops.at(-1)!.arr;
  return !trips.some(trip => !trip.cancelled && !excluded.has(trip.id) && trip.dir !== arrival.dir
    && trip.stops.some(stop => stop.st === arrival.to && stop.dep > arr - MIN_HEADWAY && stop.arr < departure + MIN_HEADWAY));
}

/** A single rear turnback dispatches its trains in arrival order (TAIL_ORDER):
 * may a train stand in it over [from, to) among the others in `occ`? */
export function tailOrderClear(topo: Topology, st: number, occ: { from: number; to: number; block?: number }[], from: number, to: number, own?: number): boolean {
  if (topo.stations[st].turnbackBerths.length !== 1) return true;
  return occ.every(o => o.block === own || !(o.from < from && o.to > to + .01) && !(o.from > from && o.to < to - .01));
}

/** time a train held on a line end's arrival platform needs to move on
 *  into the turnback track once a place there is free */
const HOLD_CLEAR = 120;

/**
 * Moments a terminal holds more trains than it can. TERMINAL_CAP keeps the
 * arrival platform free; at a line end (every train arriving there
 * terminates) one more may stand on it, provided the next arrival comes
 * HOLD_CLEAR after a place has freed up for it.
 */
export function terminalOverflows(topo: Topology, st: number, list: { from: number; to: number }[]): { t: number; cur: number; cap: number }[] {
  const cap = terminalCapacity(topo, st);
  const lineEnd = st === 0 || st === topo.stations.length - 1;
  const evs = list.flatMap((o) => [[o.from, 1], [o.to, -1]] as [number, number][]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: { t: number; cur: number; cap: number }[] = [];
  let cur = 0;
  let held = -Infinity; // when the train held on the arrival platform can move on
  for (const [t, dlt] of evs) {
    if (dlt > 0 && lineEnd && (cur > cap || (cur === cap && t < held))) out.push({ t, cur: cur + 1, cap });
    cur += dlt;
    if (!lineEnd && cur > cap) out.push({ t, cur, cap });
    if (lineEnd && dlt < 0 && cur === cap) held = t + HOLD_CLEAR;
  }
  return out;
}

/** time intervals trains spend turning back / laying over at each station (between two trips in opposite directions) */
export function terminalOccupancy(plan: Plan, topo?: Topology): Map<number, { from: number; to: number; block: number; arrival?: number; departure?: number; berths?: number[] }[]> {
  const occ = new Map<number, { from: number; to: number; block: number; arrival?: number; departure?: number; berths?: number[] }[]>();
  const moves = topo ? depotMoves(plan.blocks, plan.trips, { topo }) : undefined;
  for (const b of plan.blocks) {
    const ts = b.trips.map(i => plan.trips[i]).filter(t => !t.cancelled).map(effectiveTrip);
    for (let i = 0; i + 1 < ts.length; i++) {
      const a = ts[i];
      const d = ts[i + 1];
      if (!a || !d) continue;
      if (a.to !== d.from || a.dir === d.dir) continue;
      if (!occ.has(a.to)) occ.set(a.to, []);
      occ.get(a.to)!.push({ from: a.stops[a.stops.length - 1].arr, to: d.stops[0].dep, block: b.id,
        arrival: a.id, departure: d.id, ...(topo ? { berths: dutyTurnBerths(topo, plan, b, a, d, moves) } : {}) });
    }
  }
  return occ;
}

/** The overnight berth reservations of one duty: a stabled start holds its
 * berth from the start of the day to its first departure, a stabled end from
 * its last arrival to the next day's start (none after an actual withdrawal).
 * The one definition behind the turnback, storage and platform calendars. */
function overnightHolds(block: Block, live: readonly (Trip | undefined)[]) {
  const out: { station: number; berth: number; from: number; to: number; morning: boolean }[] = [];
  if (!live.length) return out;
  if (live[0] && block.start.kind === 'stable' && block.start.berth !== undefined)
    out.push({ station: block.start.station, berth: block.start.berth, from: OPENING.dayStart, to: live[0].stops[0].dep, morning: true });
  const last = live.at(-1);
  if (last && !block.withdrawal && block.end.kind === 'stable' && block.end.berth !== undefined)
    out.push({ station: block.end.station, berth: block.end.berth, from: block.end.holdFrom ?? last.stops.at(-1)!.arr,
      to: block.end.holdUntil ?? (last.stops.at(-1)!.arr < OPENING.dayStart ? OPENING.dayStart : OPENING.dayStart + 86400), morning: false });
  return out;
}

const liveTrips = (plan: Plan, block: Block) => block.trips.map(id => plan.trips[id]).filter(t => !t.cancelled).map(effectiveTrip);

/** Include the morning/evening reservations of fixed rear-track berths in
 * the same capacity calendar used to choose added-service turnbacks. */
function turnbackOccupancy(topo: Topology, plan: Plan) {
  const occ = terminalOccupancy(plan);
  for (const block of plan.blocks) for (const hold of overnightHolds(block, liveTrips(plan, block))) {
    if (!topo.stations[hold.station].turnbackBerths.some(b => topo.berths[b].link === topo.berths[hold.berth].link)) continue;
    if (!occ.has(hold.station)) occ.set(hold.station, []);
    occ.get(hold.station)!.push({ from: hold.from, to: hold.to, block: block.id });
  }
  return occ;
}

/** Main-platform overnight stock also protects through and feeder moves;
 * a rear-platform arrival branches off before the main platform. */
export function storedPlatformsClear(topo: Topology, plan: Plan, trip: Pick<Trip,'dir'|'to'|'stops'>, arrivalBerth?: number, only?: Block) {
  for (const block of only ? [only] : plan.blocks) {
    if (block.withdrawal) continue;
    for (const hold of overnightHolds(block, liveTrips(plan, block))) {
      // (a headway's margin after the morning departure / before the evening arrival)
      const from = hold.morning ? hold.from : hold.from - MIN_HEADWAY, to = hold.morning ? hold.to + MIN_HEADWAY : hold.to;
      const berth=topo.berths[hold.berth];
      if (berth.kind!=='platform' || berth.platform!==topo.stations[hold.station].platforms[trip.dir]) continue;
      const stop=trip.stops.find(s=>s.st===hold.station);
      if (!stop) continue;
      if (trip.to===hold.station && arrivalBerth!==undefined && topo.berths[arrivalBerth].platform!==berth.platform) continue;
      if (stop.dep>=from && stop.arr<to) return false;
    }
  }
  return true;
}

/** Physical storage reservations shared by overnight trains and hot spares.
 * Opposite-heading berths on the same link are one slot. */
export function storageOccupancy(topo: Topology, plan: Plan, waiting: ReturnType<typeof plannedWaiting>['waits'] = []) {
  const out: { link: number; station: number; from: number; to: number; block: number; morning?: boolean;
    platformWait?: { berth: number; arrival: number; departure: number } }[] = [];
  const add = (berth: number, from: number, to: number, block: number, morning?: boolean) => {
    const b = topo.berths[berth];
    out.push({ link: b.link, station: b.station, from, to, block, ...(morning === undefined ? {} : {morning}) });
  };
  const hotPlaces = hotStandbyPlaces(topo);
  for (const b of plan.blocks) {
    const ts = liveTrips(plan, b);
    for (const hold of overnightHolds(b, ts)) add(hold.berth, hold.from, hold.to, b.id, hold.morning);
    for (let i = 0; i + 1 < ts.length; i++) {
      const a = ts[i], d = ts[i + 1];
      if (!a || !d) continue;
      if (a.to !== d.from || a.dir === d.dir) continue;
      const hot = a.standby && hotPlaces.find(p => p.station === a.to);
      // Multiple rear tracks are assigned at runtime. Aggregate capacity is
      // checked by terminalOccupancy; only a fixed/single slot is reserved here.
      const rear = topo.stations[a.to].turnbackBerths;
      const berth = hot && hot.depot ? hot.berth : rear.length === 1 ? rear[0] : undefined;
      if (berth !== undefined) add(berth, a.stops.at(-1)!.arr, d.stops[0].dep, b.id);
    }
  }
  // A caller requesting waiting validation can add the one selected physical
  // platform to the same calendar. Default callers retain the original slots.
  for (const wait of waiting) {
    const berth = wait.selectedBerth;
    const b = berth === undefined ? undefined : topo.berths[berth];
    if (berth === undefined || !b || b.kind !== 'platform' || !wait.long) continue;
    const entry = out.find(o => o.block === wait.block && o.link === b.link && o.from === wait.from && o.to === wait.to);
    const platformWait = { berth, arrival: wait.arrival, departure: wait.departure };
    if (entry) entry.platformWait = platformWait;
    else out.push({ link: b.link, station: b.station, from: wait.from, to: wait.to, block: wait.block, platformWait });
  }
  return out;
}

/** departure times per station and direction, for headway checks while trips are added */
export class DepIndex {
  private m = new Map<string, number[]>();
  constructor(trips: Iterable<Pick<Trip, 'dir' | 'stops' | 'cancelled'> & { block?: number }>) { for (const t of trips) this.add(t); }
  add(t: Pick<Trip, 'dir' | 'stops' | 'cancelled'> & { block?: number }) {
    if (t.cancelled || t.block === UNUSED_DEPOT_MOVE) return;
    for (const p of t.stops) {
      const k = `${p.st}${t.dir}`;
      let a = this.m.get(k);
      if (!a) { a = []; this.m.set(k, a); }
      let i = a.length;
      while (i > 0 && a[i - 1] > p.dep) i--;
      a.splice(i, 0, p.dep);
    }
  }
  remove(t: Pick<Trip, 'dir' | 'stops'>) {
    for (const p of t.stops) {
      const a = this.m.get(`${p.st}${t.dir}`), i = a ? a.indexOf(p.dep) : -1;
      if (i >= 0) a!.splice(i, 1);
    }
  }
  /** no other train departs / passes within the minimum headway at any stop;
   * `shift`: test `stops` moved by that many seconds */
  clear(stops: PlanStop[], dir: TrackDir, h = MIN_HEADWAY, except?: PlanStop[], shift = 0): boolean {
    for (const p of stops) {
      const a = this.m.get(`${p.st}${dir}`);
      if (!a) continue;
      const t = p.dep + shift;
      let lo = 0, hi = a.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] <= t - h) lo = mid + 1; else hi = mid; }
      let ignored = false;
      const own = except?.find(s => s.st === p.st)?.dep;
      while (lo < a.length && a[lo] < t + h) {
        if (!ignored && own !== undefined && a[lo] === own) { ignored = true; lo++; }
        else return false;
      }
    }
    return true;
  }
  /** 0 when clear(stops, dir, h, except, shift) holds; else how far (s) the shift must still move later
   * (`down`: earlier) before it can: every departure now within the headway of a stop stays within it
   * until then */
  clearGap(stops: PlanStop[], dir: TrackDir, h: number, except: PlanStop[] | undefined, shift: number, down = false): number {
    let gap = 0;
    for (const p of stops) {
      const a = this.m.get(`${p.st}${dir}`);
      if (!a) continue;
      const t = p.dep + shift;
      let lo = 0, hi = a.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] <= t - h) lo = mid + 1; else hi = mid; }
      let ignored = false;
      const own = except?.find(s => s.st === p.st)?.dep;
      for (; lo < a.length && a[lo] < t + h; lo++) {
        if (!ignored && own !== undefined && a[lo] === own) { ignored = true; continue; }
        gap = Math.max(gap, down ? t - (a[lo] - h) : a[lo] + h - t);
      }
    }
    return gap;
  }
}

/**
 * Feasibility check of a plan (运行图校验): block continuity and turn times,
 * terminal occupancy, station headways, stop-time order and fleet size.
 * Errors make the plan infeasible for the signalling model; warnings are
 * tight but workable.
 */
export function validatePlan(ctx: PlanContext, plan: Plan, checkDepotStock = true, allHeadways = false, options: {checkWaiting?:boolean} = {}): PlanIssue[] {
  const { topo } = ctx;
  const out: PlanIssue[] = [...(generationIssues.get(plan) ?? [])];
  // Plan geometry stays original for display. Runtime validation must use
  // the same effective terminals and calls as task construction.
  if (plan.trips.some(t => t.cut))
    plan = { ...plan, trips: plan.trips.map(t => effectiveTrip(t) ?? t) };
  const waiting = options.checkWaiting ? plannedWaiting(ctx, plan) : undefined;
  if (waiting) out.push(...waiting.issues);
  const name = (st: number) => STATIONS[st].name;
  const live = plan.trips.filter((t) => !t.cancelled);
  // every trip runs one way only: each call lies ahead of the last (a branch is not reached by
  // running on past the junction; that needs a change of ends, i.e. another trip)
  for (const trip of live) {
    const back = trip.stops.findIndex((s, k) => k > 0 && !ahead(trip.dir, trip.stops[k - 1].st, s.st));
    if (back > 0) out.push({ severity: 'error', code: 'TRIP_DIRECTION', t: trip.stops[back].arr, blocks: [trip.block],
      text: `${trip.no || trip.id} ${name(trip.from)}—${name(trip.to)} 在 ${name(trip.stops[back - 1].st)}—${name(trip.stops[back].st)} 不是${trip.dir === 'DN' ? '下行' : '上行'}方向` });
  }
  const storage = storageOccupancy(topo, plan, waiting?.waits);
  for (let i = 0; i < storage.length; i++) for (let j = i + 1; j < storage.length; j++) {
    const a = storage[i], b = storage[j];
    if (a.link === b.link && a.block !== b.block && a.from < b.to - .001 && b.from < a.to - .001)
      out.push({ severity: 'error', code: 'STABLE_CONFLICT', t: Math.max(a.from, b.from), blocks: [a.block, b.block],
        text: a.platformWait || b.platformWait
          ? `${name(a.station)} ${topo.berths[(a.platformWait ?? b.platformWait)!.berth].name} 长候班与其他存车或候班重叠`
          : `${name(a.station)} 同一存车泊位的过夜、热备或折返占用重叠` });
  }
  if (waiting) {
    const taskCache = new Map<number, Task[]>();
    for (const hold of storage) {
      if (!hold.platformWait) continue;
      const occupiedPlatform = topo.berths[hold.platformWait.berth].platform;
      for (const trip of live) {
        if (trip.block === hold.block) continue;
        const stop = trip.stops.find(s => s.st === hold.station);
        if (!stop) continue;
        // Passing calls have zero duration but do occupy the platform at that instant.
        const overlap = stop.arr === stop.dep ? stop.arr >= hold.from && stop.arr < hold.to
          : stop.arr < hold.to && stop.dep > hold.from;
        if (!overlap) continue;
        const block = plan.blocks[trip.block];
        if (!block) continue;
        let tasks = taskCache.get(block.id);
        if (!tasks) { tasks = blockTasks(topo, plan, block); taskCache.set(block.id, tasks); }
        // For a terminal, addTurnback may retarget the arrival to a middle or
        // opposite platform; use the actual task rather than the direction's main.
        let index = -1;
        for (let i = tasks.length - 1; i >= 0; i--) {
          const t = tasks[i];
          if (t.k === 'stop' && t.trip === trip.id && t.station === stop.st && t.revenue === trip.revenue) { index = i; break; }
        }
        let berth = index < 0 ? platformBerth(topo, stop.st, trip.dir) : (tasks[index] as StopTask).berth;
        const before = tasks[index - 1];
        if (index >= 0 && before?.k === 'reverse' && before.station === stop.st)
          berth = departureBerthAfterReverse(topo, before.chosen, berth);
        if (topo.berths[berth]?.platform !== occupiedPlatform) continue;
        // A separately recorded storage slot already emitted this same block
        // conflict above; do not count it a second time as a passing call.
        if (storage.some(other => other !== hold && other.block === trip.block && other.link === hold.link
          && other.from < hold.to - .001 && hold.from < other.to - .001
          && (stop.arr === stop.dep ? stop.arr >= other.from && stop.arr < other.to : stop.arr < other.to && stop.dep > other.from))) continue;
        const a = plan.trips[hold.platformWait.arrival], d = plan.trips[hold.platformWait.departure];
        out.push({ severity: 'error', code: 'STABLE_CONFLICT', t: Math.max(hold.from, stop.arr), blocks: [hold.block, trip.block],
          text: `${topo.berths[hold.platformWait.berth].name} 长候班 ${a.no}→${d.no} 与 ${trip.no} 通过或停靠冲突` });
      }
    }
  }
  if (checkDepotStock) {
    const ledger = depotLedger(topo, plan);
    for (const [depot, yard] of topo.depots.entries()) {
      if (ledger.peak[depot] > yard.capacity)
        out.push({ severity: 'error', code: 'YARD_CAPACITY', t: ledger.peakAt[depot], depot, delta: ledger.peak[depot] - yard.capacity,
          text: `${yard.name} 库存峰值 ${ledger.peak[depot]} 列，超过库位 ${yard.capacity} 列` });
      if (ledger.final[depot] !== ledger.initial[depot])
        out.push({ severity: 'error', code: 'YARD_BALANCE', t: ledger.events.at(-1)?.time ?? OPENING.dayStart, depot, delta: ledger.final[depot] - ledger.initial[depot],
          text: `${yard.name} 夜间库存 ${ledger.final[depot]} 列，次日早晨需 ${ledger.initial[depot]} 列（含备车）` });
    }
  }
  // Line stabling (正线存车) must hold as many trains at night as leave it in
  // the morning, or the next day starts a train short.
  const overnight = new Map<string, number>();
  for (const place of OPERATIONS.overnightStabling) overnight.set(place.station, (overnight.get(place.station) ?? 0) + place.count);
  for (const [id, n] of overnight) {
    const st = STATIONS.findIndex(x => x.id === id);
    // Cars actually there at night: live deliveries, plus a cancelled morning
    // car that never left its berth.
    const off = (b: Block) => b.trips.every(id => plan.trips[id].cancelled);
    const night = plan.blocks.filter(b => !b.withdrawal && (off(b)
      ? b.start.kind === 'stable' && b.start.station === st
      : b.end.kind === 'stable' && b.end.station === st)).length;
    const morning = plan.blocks.filter(b => b.start.kind === 'stable' && b.start.station === st).length;
    if (night !== n || morning !== n)
      out.push({ severity: 'warn', code: 'FLEET', t: OPENING.dayStart, blocks: [], text: `${name(st)} 正线存车 ${n} 列：夜间入位 ${night} 列，早晨出车 ${morning} 列` });
  }
  // Explicit overnight stabling on a main platform reserves that track from
  // the evening arrival through the following day's departure. Check both
  // today's early movements and tomorrow's via a 24-hour shift, empty or not.
  for (const block of plan.blocks) {
    if (block.withdrawal || block.end.kind !== 'stable' || block.end.berth === undefined) continue;
    const berth = topo.berths[block.end.berth];
    if (berth.platform !== topo.stations[block.end.station].platforms.DN) continue;
    const station = block.end.station;
    const stableBerth = block.end.berth;
    const last = block.trips.map(id => plan.trips[id]).filter(t => !t.cancelled).at(-1)!;
    if (!last) continue;
    const arrived = last.stops.at(-1)!.arr;
    const morning = plan.blocks.find(b => b.start.kind === 'stable' && b.start.station === station && b.start.berth === stableBerth);
    const first = morning?.trips.map(id => plan.trips[id]).find(t => !t.cancelled);
    const departure = first?.stops[0].dep ?? OPENING.defaultStableDeparture;
    for (const trip of live) {
      if (trip.dir !== 'DN' || trip === last || trip === first) continue;
      const stop = trip.stops.find(s => s.st === station);
      // A DN positioning trip ending on the middle track uses the west
      // throat and never passes/occupies the DN main platform.
      const duty = plan.blocks[trip.block];
      const next = duty && plan.trips[duty.trips[duty.trips.indexOf(trip.id) + 1]];
      if (trip.to === station && duty?.end.kind === 'stable' && duty.end.berth !== undefined
        && duty.trips.filter(id=>!plan.trips[id].cancelled).at(-1)===trip.id
        && topo.berths[duty.end.berth].platform!==berth.platform) continue;
      if (trip.to === station && next?.dir === 'UP' && turnbackAt(topo, station, 'DN')?.kind === 'rear') continue;
      if (stop && (stop.dep >= arrived - MIN_HEADWAY || stop.arr < departure + MIN_HEADWAY))
        out.push({ severity: 'error', code: 'STABLE_CONFLICT', t: stop.arr, blocks: [block.id, trip.block], holdBlock:block.id, conflictingTrip:trip.id,
          text: `${name(station)} ${DIRECTIONS.DN.label}正线存车与 ${trip.no}（${trip.revenue ? '载客' : '空驶'}）冲突` });
    }
  }
  for (const t of live) {
    if (t.block < 0 && t.revenue) out.push({ severity: 'error', code: 'UNASSIGNED', t: t.stops[0].dep, text: `车次 ${t.no} 未分配车底` });
    for (let i = 0; i < t.stops.length; i++) {
      const s = t.stops[i];
      const prev = t.stops[i - 1];
      if (s.dep < s.arr || (prev && s.arr < prev.dep)) { out.push({ severity: 'error', code: 'TIME_ORDER', t: s.arr, text: `车次 ${t.no} 在 ${name(s.st)} 时刻倒序` }); break; }
    }
  }
  // blocks: continuity, turn time, terminal occupancy
  const occ = terminalOccupancy(plan, topo);
  for (const b of plan.blocks) {
    const ts = b.trips.map((i) => plan.trips[i]).filter((t) => !t.cancelled);
    for (let i = 0; i + 1 < ts.length; i++) {
      const a = ts[i];
      const d = ts[i + 1];
      const arr = a.stops[a.stops.length - 1].arr;
      const dep = d.stops[0].dep;
      if (a.to !== d.from) { out.push({ severity: 'error', code: 'BLOCK_BREAK', t: arr, text: `车底 ${b.svc}：${a.no} 终到 ${name(a.to)}，下一车次 ${d.no} 从 ${name(d.from)} 出发` }); continue; }
      const storedTurn = a.standby && hotStandbyPlaces(topo).some(p=>p.station===a.to&&p.depot
        &&storageArrivalBerth(topo,p.berth,a.dir)!==undefined);
      if (a.dir !== d.dir && !turnbackAt(topo,a.to,a.dir) && !storedTurn)
        out.push({severity:'error',code:'TURN_UNAVAILABLE',t:arr,blocks:[b.id],text:`${name(a.to)} 无${DIRECTIONS[a.dir].label}到达换端条件（${a.no}→${d.no}）`});
      if (a.dir !== d.dir && dep - arr < minTurn(a.to) - 1e-6) out.push({ severity: 'error', code: 'TURN_SHORT', t: arr, text: `车底 ${b.svc} 在 ${name(a.to)} 折返仅 ${(dep - arr).toFixed(1)} s（${a.no}→${d.no}，最小 ${minTurn(a.to)} s）` });
      if (a.dir !== d.dir && !storedTurn && !frontTurnClear(ctx, live, a, dep, new Set(ts.map(trip => trip.id))))
        out.push({severity:'error',code:'FRONT_CONFLICT',t:arr,blocks:[b.id],text:`${name(a.to)} 站前折返占用时段与正常方向列车冲突`});
      if (a.overlay && a.dir !== d.dir && a.to > 0 && a.to < topo.stations.length - 1 && dep-arr > minTurn(a.to)+INTERMEDIATE_WAIT+.01)
        out.push({severity:'error',code:'LAYOVER_LONG',t:arr,blocks:[b.id],text:`${name(a.to)} 加开接续等待超过中间折返站能力`});
    }
  }
  for (const [st, list] of occ) {
    // A single rear turnback cannot dispatch its second arrival before its
    // first: the first would have to hold either the tail or the exit platform.
    if (topo.stations[st].turnbackBerths.length === 1) {
      const ordered = list.slice().sort((a,b) => a.from-b.from);
      for (let i=1;i<ordered.length;i++) if (ordered[i-1].to > ordered[i].to + .01)
        out.push({severity:'error',code:'TAIL_ORDER',t:ordered[i].from,blocks:[ordered[i-1].block,ordered[i].block],text:`${name(st)} 单一折返线到达次序与发车次序相反`});
    }
    // A platform turnback track is entered and left through one throat: the
    // next turning train arrives only after the previous one has left and
    // cleared it (OPERATIONS.platformTurnClear).
    const tb = topo.stations[st].turnbackBerths;
    const clear = OPERATIONS.platformTurnClear[STATIONS[st].id];
    if (clear !== undefined && tb.length === 1 && topo.berths[tb[0]].kind === 'platform') {
      const ordered = list.slice().sort((a,b) => a.from-b.from);
      for (let i=1;i<ordered.length;i++) {
        const gap = ordered[i].from - ordered[i-1].to;
        if (gap < clear - 1e-6) out.push({severity:'error',code:'TURN_HEADWAY',t:ordered[i].from,blocks:[ordered[i-1].block,ordered[i].block],
          text:`${name(st)} 站台折返线前车发车到后车到达仅 ${gap.toFixed(0)} s（最小 ${clear} s）`});
      }
    }
    let reported = -Infinity;
    for (const { t, cur, cap } of terminalOverflows(topo, st, list)) {
      if (t - reported <= 1800) continue;
      reported = t;
      const blocks = plan.blocks.filter(block => {
        const ts = block.trips.map(id => plan.trips[id]).filter(trip => !trip.cancelled);
        return ts.some((a,i) => { const d = ts[i+1]; return d && a.to === st && d.from === st && a.dir !== d.dir
          && a.stops.at(-1)!.arr <= t && d.stops[0].dep > t; });
      }).map(block => block.id);
      out.push({ severity: 'error', code: 'TERMINAL_FULL', t, blocks, text: `${name(st)} 同时折返/待发 ${cur} 列，超过能力 ${cap} 列` });
    }
  }
  const moves = depotMoves(plan.blocks, plan.trips, ctx).filter(move => move.link !== undefined && move.window);
  for (const inbound of moves.filter(move => move.delta > 0)) {
    for (const outbound of moves.filter(move => move.delta < 0)) {
      if (inbound.block === outbound.block || inbound.link !== outbound.link) continue;
      const [approach, clear] = inbound.window!, [start, end] = outbound.window!;
      if (start < clear && end > approach)
        out.push({ severity: 'error', code: 'DEPOT_CONFLICT', t: Math.max(approach, start), blocks: [inbound.block, outbound.block],
          text: `${topo.depots[inbound.depot].name} 回段接近与出段共用转换轨时隙冲突` });
    }
  }
  for (const move of moves) for (const holds of occ.values()) for (const hold of holds) {
    if (hold.block === move.block || hold.arrival === undefined || hold.departure === undefined) continue;
    const arrival = plan.trips[hold.arrival], departure = plan.trips[hold.departure], berth = hold.berths?.[0];
    if (berth === undefined || !turnLeadConflict(topo, move, plan.trips, arrival, departure, berth)) continue;
    const moving = plan.trips[move.trip!];
    out.push({ severity: 'error', code: 'DEPOT_CONFLICT', t: Math.max(move.window![0], hold.from), blocks: [move.block, hold.block],
      text: `${topo.depots[move.depot].name} ${moving.no} ${move.delta > 0 ? '回段' : '出段'}与 ${arrival.no}→${departure.no} 折返待发共用出入段线或咽喉冲突` });
  }
  // station headways per direction (passing / departing)
  for (const dir of ['DN', 'UP'] as TrackDir[]) {
    const byStation = new Map<number, { t: number; no: string; block: number; trip: number }[]>();
    for (const t of live) {
      if (t.dir !== dir) continue;
      for (const s of t.stops) {
        const block = plan.blocks[t.block];
        // (the train's next trip actually run: a cancelled one in between, e.g. the
        // withdrawal an added service replaced, does not part the train from it — D189)
        const next = block && block.trips.slice(block.trips.indexOf(t.id) + 1).map(id => plan.trips[id]).find(x => x && !x.cancelled);
        if (s === t.stops.at(-1) && next?.dir === t.dir && next.from === s.st) continue;
        if (!byStation.has(s.st)) byStation.set(s.st, []);
        byStation.get(s.st)!.push({ t: s.dep, no: t.no, block: t.block, trip:t.id });
      }
    }
    for (const [st, list] of byStation) {
      list.sort((a, b) => a.t - b.t);
      let reported = -Infinity;
      for (let i = 1; i < list.length; i++) {
        const h = list[i].t - list[i - 1].t;
        if (h < MIN_HEADWAY && (allHeadways || list[i].t - reported > 1800)) {
          reported = list[i].t;
          // the design headway is the hard limit: a plan below it cannot run
          // to time (the operating headways the templates keep are far wider)
          out.push({ severity: 'error', code: 'HEADWAY', gap: h, t: list[i].t, blocks: [list[i-1].block,list[i].block], conflictingTrips:[list[i-1].trip,list[i].trip],
            text: `${name(st)} ${DIRECTIONS[dir].label} ${list[i - 1].no}/${list[i].no} 间隔 ${Math.round(h)} s（最小 ${MIN_HEADWAY} s）` });
        }
      }
    }
  }
  if (plan.fleetPeak > LINE_INFO.fleet) out.push({ severity: 'error', code: 'FLEET', t: 0, text: `用车 ${plan.fleetPeak} 列，超过配属 ${LINE_INFO.fleet} 列` });
  return out.sort((a, b) => a.t - b.t);
}
