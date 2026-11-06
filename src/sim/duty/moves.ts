/**
 * Move fitting of the rolling-stock duty (D178, D184): the physical half of
 * the terminal pools. Yard exits and returns, positioning runs and line
 * storage moves are fitted into the train stream here, with the occupancy
 * calendars they need (terminal places, depot leads, yard stock). The day
 * planner (planner.ts) and the added-service planner (overlay.ts) decide
 * which car goes where; this module finds the slot and keeps the ledger.
 */
import type { Block, Plan, PlanStop, TrackDir, Trip } from '../model';
import type { PlanContext, Period, GenTrip } from '../timetable';
import { plannedDwell } from '../calibration';
import {
  addTo, buildStops, officialEndInterval, carryingStops, passesOpenStation, connectionSafe, depotLeadLink, depotStartTime,
  dwellFactorAt, entryStation, exitStation, frontTurnClear, inboundWindow, inOuterAlternation,
  minTurn, outboundWindow, overnightPlaces, storageArrivalBerth, terminalCapacity, terminalOverflows,
  tailOrderClear, turnbackAt, DepIndex, MAX_LAYOVER, THROUGH_WAIT, MIN_HEADWAY, CARRY_MOVES, OPENING, CORE_W, CORE_E,
  TEMPLATES, periodAt, openingAnchors, DEPOT_ENTRY_CLEAR, depotMoves, terminalOccupancy,
} from '../timetable';
import { OPERATIONS, STATIONS } from '../../data/current';
import { ahead } from '../topology';
import type { PoolCar, PoolDemand } from './pool';

/** longest an intermediate turnback holds a car beyond its turn (s; validatePlan LAYOVER_LONG) */
const INTERMEDIATE_WAIT = 450;
/** a car running on in its own direction at a station stands at least this long (s) */
export const THROUGH_MIN = 20;
/** search step and span of a fitted move (s) */
const FIT_STEP = 5;
const FIT_SPAN = 2400;
const PRE_ANCHOR = 300;
const PRE_SLACK = 15;

export type Yard = {
  id: number;
  /** depot index, or -1 for a line storage place */
  depot: number;
  station: number;
  berth?: number;
  stock: number;
  /** cars it must hold at night; a depot's own morning draw */
  sent: number;
  /** a storage place takes its night car only after this clock */
  after?: number;
  /** a storage place's cars leave and return in this direction */
  dir?: TrackDir;
  /** the berth its night car arrives on */
  night?: number;
  name: string;
};


const DEBUG = !!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.DUTY_DEBUG;
export const dutyDebug: string[] = [];
let trace: Map<string, number> | null = null;
export const setTrace = (m: Map<string, number> | null) => { trace = m; };
export const getTrace = () => trace;
/** debug: count the first failing condition of a fitted move */
export const T = (k: string, ok: boolean) => { if (!ok && trace) trace.set(k, (trace.get(k) ?? 0) + 1); return ok; };
export { DEBUG };

/** a car at a station, and a departure wanting one */
export type Car = PoolCar & { trip: GenTrip; station: number };
export type Want = PoolDemand & { trip: GenTrip; station: number };

export function fmt(t: number) {
  return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}`;
}

export type Moves = ReturnType<typeof createMoves>;

/** `notBefore`: no yard exit or move may start earlier (a plan changed while the day runs) */
export function createMoves(ctx: PlanContext, trips: GenTrip[], periods: Period[], opts: { notBefore?: number } = {}) {
  const { topo } = ctx;
  const notBefore = opts.notBefore ?? -Infinity;
  const E = topo.stations.length - 1;
  const lineEnd = (st: number) => st === 0 || st === E;
  const factor = (t: number) => dwellFactorAt(ctx.dayType, t);
  const arr = (t: Trip) => t.stops.at(-1)!.arr;
  const dep = (t: Trip) => t.stops[0].dep;
  const live = () => trips.filter(t => !t.cancelled);
  const services = trips.slice();
  // A car turning at a line end stands no longer than its turn and one
  // interval there (D173): the published one, else that of the departures —
  // a car ready before the previous departure would have taken that one, so
  // a longer stand is a car too many.
  const leavingFrom = new Map<number, number[]>();
  for (const t of services) if (!t.cancelled) leavingFrom.set(t.from, [...(leavingFrom.get(t.from) ?? []), dep(t)]);
  for (const list of leavingFrom.values()) list.sort((x, y) => x - y);
  // The published interval is an average: where the departures alternate
  // (150/300 s at the airport in the peak) a car that just missed one waits
  // the local gap, which is no queue either.
  const lineEndStand = (st: number, from: number) => {
    const list = leavingFrom.get(st) ?? [], i = list.findIndex(t => t >= from + minTurn(st));
    const local = i > 0 ? list[i] - list[i - 1] : undefined;
    const official = officialEndInterval(ctx.dayType, st, from);
    return Math.min(MAX_LAYOVER, minTurn(st) + Math.max(official ?? 0, local ?? (official === undefined ? MAX_LAYOVER : 0)));
  };
  /** shortest stop of a car running on at `st` from `at`: passengers alight and board (planned dwell) */
  const throughMin = (st: number, dir: TrackDir, at: number) => Math.max(THROUGH_MIN, plannedDwell(ctx.dayType, st, dir, at, dwellFactorAt(ctx.dayType, at)));
  /** longest stand of a car at `st` leaving at `at` */
  const waitLimit = (st: number, turn: boolean, at: number) => !turn ? THROUGH_WAIT : lineEnd(st) ? lineEndStand(st, at) : minTurn(st) + INTERMEDIATE_WAIT;
  const openers = openingAnchors(services);
  const index = new DepIndex(services);
  /** last service departure per station and direction */
  const slot = (st: number, dir: TrackDir) => st * 2 + (dir === 'DN' ? 1 : 0);
  const lastService: number[] = [];
  // (of the service trains: a yard run or positioning run is no service a later move may follow)
  const POSITIONING = new Set(['ins', 'wd', 'empty', 'adj']);
  for (const t of services) if (t.revenue && !POSITIONING.has(t.kind)) for (const p of t.stops.slice(0, -1)) if (p.stop)
    lastService[slot(p.st, t.dir)] = Math.max(lastService[slot(p.st, t.dir)] ?? -Infinity, p.dep);
  const addMove = (dir: TrackDir, from: number, to: number, stops: PlanStop[], revenue: boolean): GenTrip => {
    const move = addTo(trips, dir, revenue ? (from === to ? 'adj' : 'ins') : 'empty', from, to, stops, revenue);
    index.add(move);
    return move;
  };
  const startOf = new Map<number, Block['start']>();
  const endOf = new Map<number, Block['end']>();
  const link = (a: GenTrip, d: GenTrip) => { a.next = d.id; d.prev = a.id; };
  // ---- terminal places: one occupancy calendar per station
  const places = new Map<number, { from: number; to: number }[]>();
  const standbyPlaces = new Map<number, { from: number; to: number }[]>();
  const clearAfter = (st: number) => OPERATIONS.platformTurnClear[STATIONS[st].id] ?? 0;
  const reserve = (st: number, from: number, to: number, commit = true) => {
    const list = places.get(st) ?? [];
    const held = { from, to: to + clearAfter(st) };
    const combined = [...list, held];
    // (every committed hold passed this check: only the ones near the new one can overflow with it)
    if (terminalOverflows(topo, st, combined.filter(p => p.to >= held.from - 3600 && p.from <= held.to + 3600)).length) return false;
    if (!tailOrderClear(topo, st, list, held.from, held.to)) return false;
    // Off-peak and while a standby stands, keep the arrival platform free:
    // only a peak arrival wave may hold a car on it.
    const standby = standbyPlaces.get(st) ?? [];
    const bounds = [from, ...combined.map(p => p.from), ...periods.map(p => p.from), ...standby.map(w => w.from)];
    if (lineEnd(st) && bounds.some(t => t >= from && t < to
      && (!TEMPLATES[periodAt(periods, t).template].peak || standby.some(w => w.from <= t && w.to > t))
      && combined.filter(p => p.from <= t && p.to > t).length > terminalCapacity(topo, st))) return false;
    if (commit) { list.push(held); places.set(st, list); }
    return true;
  };

  // ---- the yards: depots and line storage places
  const yards: Yard[] = topo.depots.map((dp, d) => ({ id: d, depot: d, station: -1, stock: Math.min(ctx.initialStock?.[d] ?? dp.capacity, dp.capacity), sent: 0, name: dp.name }));
  for (const place of overnightPlaces(topo)) {
    if (place.kind !== 'feeder') continue;
    const berth = topo.berths[place.berth], link = topo.links[berth.link];
    yards.push({ id: yards.length, depot: -1, station: place.station, berth: place.berth, night: place.arrivalBerth, stock: 1, sent: 0, after: place.nightAfter,
      dir: (link.chainB - link.chainA) * berth.dir > 0 ? 'DN' : 'UP', name: berth.name });
  }
  // A line storage place (kind 'origin') whose morning cars are already
  // requests (stableStarts) only takes its cars back at night.
  for (const place of overnightPlaces(topo)) {
    if (place.kind !== 'origin') continue;
    const berth = topo.berths[place.arrivalBerth], link = topo.links[berth.link];
    yards.push({ id: yards.length, depot: -1, station: place.station, berth: place.arrivalBerth, night: place.arrivalBerth, stock: 0, sent: 1, after: place.nightAfter,
      dir: (link.chainB - link.chainA) * berth.dir > 0 ? 'DN' : 'UP', name: berth.name });
  }

  /** a move not yet added, as a trip for the waiting rules */
  const asTrip = (dir: TrackDir, from: number, to: number, stops: PlanStop[]): Trip =>
    ({ id: -1, no: '', dir, kind: 'ins', from, to, stops, revenue: true, block: -1 });
  /** the car may stand between `a` and `d` where it waits (D149 safe berths) */
  const safe = (a: Trip, d: Trip) => connectionSafe(topo, ctx.dayType, a, d);
  // ---- move fitting
  const opened = (stops: PlanStop[], dir: TrackDir) => {
    const copy = stops.map(s => ({ ...s }));
    const carrying = carryingStops(copy, dir, openers);
    return { stops: copy, carrying };
  };
  /** carrying when it can board anybody; empty only while every station on
   * it is still closed (D166). */
  const moveStops = (dir: TrackDir, from: number, to: number, start: number) => {
    if (!CARRY_MOVES) return { stops: buildStops(ctx, dir, from, to, start, false, 1), revenue: false };
    const carrying = opened(buildStops(ctx, dir, from, to, start, true, factor), dir);
    if (carrying.carrying) {
      // 【假设】D178: past the last service of its direction a move boards nobody
      for (const p of carrying.stops) if (p.dep > (lastService[slot(p.st, dir)] ?? Infinity) + 1e-6) p.noBoard = true;
      return { stops: carrying.stops, revenue: carrying.stops.slice(0, -1).some(p => p.stop && !p.noBoard) };
    }
    const empty = buildStops(ctx, dir, from, to, start, false, 1);
    if (passesOpenStation(empty, dir, openers)) return null;
    empty[0].stop = false;
    return { stops: empty, revenue: false };
  };
  // No empty or non-boarding move on the outer leg inside a peak's big/small
  // alternation; a move carrying passengers there is one more service train
  // in that stream (D178: the official west interval needs the morning
  // ramp's extra trains, which the bare pattern does not give).
  const outer = (p: PlanStop) => ahead('DN', p.st, CORE_W);
  const outerQuiet = (stops: PlanStop[]) => (!stops.some(p => outer(p) && inOuterAlternation(periods, p.dep))
      || stops.slice(0, -1).every(p => !outer(p) || p.stop && !p.noBoard))
    && T('core', viaCore || !stops.some(p => ahead('DN', CORE_W, p.st) && ahead('DN', p.st, CORE_E)));
  /** a supply move may run through the core interior */
  let viaCore = true;
  const exitClear = (depot: number, dir: TrackDir, stops: PlanStop[]) => {
    const [start, clear] = outboundWindow(ctx, depot, { dir, stops });
    const lead = depotLeadLink(topo, depot, false, dir);
    return lead === undefined || inbound.every(m => m.depot !== depot || depotLeadLink(topo, depot, true, m.dir) !== lead || clear <= m.from || start >= m.to);
  };
  const entryClear = (depot: number, dir: TrackDir, to: number, stops: PlanStop[]) => {
    const [from, until] = inboundWindow(topo, depot, { to, stops });
    const lead = depotLeadLink(topo, depot, true, dir);
    return lead === undefined || outbound.every(m => m.depot !== depot || depotLeadLink(topo, depot, false, m.dir) !== lead || m.to <= from || m.from >= until);
  };
  const exits: { yard: number; at: number }[] = [];
  /** the ledger changes: cached event lists are stale */
  let ledgerVersion = 0;
  const eventCache = new Map<number, { version: number; events: { at: number; d: number }[] }>();
  const eventsOf = (yard: Yard) => {
    const hit = eventCache.get(yard.id);
    if (hit && hit.version === ledgerVersion) return hit.events;
    const events = [
      ...exits.filter(x => x.yard === yard.id).map(x => ({ at: x.at, d: -1 })),
      ...inbound.filter(m => m.depot === yard.depot).map(m => ({ at: m.at, d: 1 })),
    ].sort((a, b) => a.at - b.at || a.d - b.d);
    eventCache.set(yard.id, { version: ledgerVersion, events });
    return events;
  };
  /** `car`: a window held ahead for a spare car that can only enter directly */
  /** `at`: the car counts in the yard's stock, the same moment as the day ledger (depotMoves) */
  const inbound: { depot: number; dir: TrackDir; from: number; to: number; at: number; car?: number }[] = [];
  const outbound: { depot: number; dir: TrackDir; from: number; to: number }[] = [];
  const addExit = (x: (typeof exits)[number]) => { ledgerVersion++; exits.push(x); };
  const addInbound = (m: (typeof inbound)[number]) => { ledgerVersion++; inbound.push(m); };
  const dropInbound = (i: number) => { ledgerVersion++; inbound.splice(i, 1); };
  /** a cheap headway pre-test of the slot at `at`: the move built at a
   * nearby slot, shifted (with slack for the dwell differences); the exact
   * move is built and tested only where this passes */
  const preClear = (dir: TrackDir, from: number, to: number, own: PlanStop[] | undefined) => {
    let base: { at: number; stops: PlanStop[] | undefined } | undefined;
    return (at: number) => {
      if (!base || Math.abs(at - base.at) > PRE_ANCHOR) base = { at, stops: moveStops(dir, from, to, at)?.stops };
      return !base.stops || index.clear(base.stops, dir, MIN_HEADWAY - PRE_SLACK, own, at - base.at);
    };
  };
  /** latest move from→to arriving by `latest` (and not before `earliest`) that fits the stream */
  const fitBefore = (dir: TrackDir, from: number, to: number, earliest: number, latest: number, own: PlanStop[] | undefined,
    accept: (stops: PlanStop[]) => boolean) => {
    const probe = moveStops(dir, from, to, 0);
    if (!probe) return null;
    let start = latest - probe.stops.at(-1)!.arr;
    for (let k = 0; k < 6; k++) {
      const run = moveStops(dir, from, to, start);
      if (!run) break;
      start -= run.stops.at(-1)!.arr - latest;
    }
    const pre = preClear(dir, from, to, own);
    for (let at = Math.floor(start); at >= earliest - 1e-6 && at >= start - FIT_SPAN; at -= FIT_STEP) {
      if (!T('headway', pre(at))) continue;
      const move = moveStops(dir, from, to, at);
      if (!T('none', !!move) || !T('time', move!.stops.at(-1)!.arr <= latest + 1e-6 && move!.stops[0].dep >= earliest - 1e-6)) continue;
      if (!T('headway', index.clear(move!.stops, dir, MIN_HEADWAY, own)) || !accept(move!.stops)) continue;
      return move;
    }
    return null;
  };
  /** earliest move from→to leaving at or after `earliest` (no later than `latest`) that fits */
  const fitAfter = (dir: TrackDir, from: number, to: number, earliest: number, latest: number, own: PlanStop[] | undefined,
    accept: (stops: PlanStop[]) => boolean) => {
    const pre = preClear(dir, from, to, own);
    for (let at = Math.ceil(earliest); at <= latest; at += FIT_STEP) {
      if (!T('headway', pre(at))) continue;
      const move = moveStops(dir, from, to, at);
      if (!T('none', !!move)) continue;
      if (!T('headway', index.clear(move!.stops, dir, MIN_HEADWAY, own)) || !accept(move!.stops)) continue;
      return move;
    }
    return null;
  };
  /** longest a car stands at `st` between two trips (turning or running on) */
  const toward = (from: number, to: number): TrackDir => ahead('DN', from, to) ? 'DN' : 'UP';
  const depotDir = (st: number, depot: number): TrackDir => topo.stations[st].chain < topo.depots[depot].junctionChain ? 'DN' : 'UP';
  /** run spare `car` from its station to `want`'s origin */
  const position = (car: Car, want: Want): GenTrip | undefined => {
    const X = car.station, P = want.station, a = car.trip, d = want.trip;
    if (X === P) return undefined;
    const dir = toward(X, P);
    const turnX = a.dir !== dir, turnP = dir !== d.dir;
    if (turnX && !turnbackAt(topo, X, a.dir) || turnP && !turnbackAt(topo, P, dir)) return undefined;
    const earliest = arr(a) + (turnX ? minTurn(X) : throughMin(X, a.dir, arr(a)));
    const latest = dep(d) - (turnP ? minTurn(P) : throughMin(P, d.dir, dep(d)));
    if (latest - earliest < 60) return undefined;
    if (!T('held', releasable(a.id))) return undefined;
    const held = inbound.find(m => m.car === a.id);
    // a run on (no turn) is the same train as `a` at X, and as `d` at P
    const own = [...(turnX ? [] : [a.stops.at(-1)!]), ...(turnP ? [] : d.stops)];
    const move = fitBefore(dir, X, P, earliest, latest, own.length ? own : undefined, stops => T('outer', outerQuiet(stops))
      && T('waitX', stops[0].dep - arr(a) <= waitLimit(X, turnX, stops[0].dep)) && T('waitP', dep(d) - stops.at(-1)!.arr <= waitLimit(P, turnP, dep(d)))
      && T('safeX', safe(a, asTrip(dir, X, P, stops))) && T('safeP', safe(asTrip(dir, X, P, stops), d))
      && (!turnX || T('placeX', reserve(X, arr(a), stops[0].dep, false))
        && T('frontX', frontTurnClear(ctx, live(), a, stops[0].dep, new Set([a.id]))))
      && (!turnP || T('placeP', reserve(P, stops.at(-1)!.arr, dep(d), false))
        && T('frontP', frontTurnClear(ctx, live(), { dir, to: P, stops }, dep(d), new Set([d.id])))));
    if (!move) return undefined;
    if (turnX) reserve(X, arr(a), move.stops[0].dep);
    if (turnP) reserve(P, move.stops.at(-1)!.arr, dep(d));
    const trip = addMove(dir, X, P, move.stops, move.revenue);
    link(a, trip); link(trip, d);
    if (held) dropInbound(inbound.indexOf(held));
    return trip;
  };
  /** the yard's lowest stock from `t` on with `delta` more at `t` (exits
   * before entries at the same instant; entries held ahead count) */
  const lowest = (yard: Yard, t: number, delta: number) => {
    let stock = yard.stock, low = Infinity, added = false;
    for (const e of eventsOf(yard)) {
      if (!added && (t < e.at || t === e.at && delta < e.d)) { stock += delta; added = true; low = Math.min(low, stock); }
      stock += e.d;
      if (e.at >= t) low = Math.min(low, stock);
    }
    if (!added) low = Math.min(low, stock + delta);
    return low;
  };
  const canDraw = (yard: Yard, t: number) => lowest(yard, t, -1) >= 0;
  /** a yard never holds more cars than it has places (the day still closes on its own count, `due`) */
  /** while homing ahead of the exits the stock bound is not known yet */
  let early = false;
  const canTake = (depot: number, t: number) => {
    if (early) return true;
    const yard = yards[depot], places = topo.depots[depot].capacity;
    let stock = yard.stock, added = false;
    for (const e of eventsOf(yard)) {
      if (!added && (t < e.at || t === e.at && 1 < e.d)) { if (++stock > places) return false; added = true; }
      stock += e.d;
      // only the stock from `t` on carries this car
      if (added && stock > places) return false;
    }
    return added || stock + 1 <= places;
  };
  /** a yard exit for `want`: straight from the portal, or a fitted move */
  const feed = (yard: Yard, want: Want): boolean => {
    const P = want.station, d = want.trip;
    if (yard.depot < 0) {
      // line storage: its cars leave in their stored direction only
      if (yard.stock - exits.filter(x => x.yard === yard.id).length <= 0 || yard.dir === undefined) return false;
      if (yard.station === P) {
        if (d.dir !== yard.dir) return false;
        startOf.set(d.id, { kind: 'stable', station: P, berth: yard.berth });
        addExit({ yard: yard.id, at: dep(d) });
        return true;
      }
      if (toward(yard.station, P) !== yard.dir) return false;
      const turnP = yard.dir !== d.dir;
      if (turnP && !turnbackAt(topo, P, yard.dir)) return false;
      const latest = dep(d) - (turnP ? minTurn(P) : throughMin(P, d.dir, dep(d)));
      const move = fitBefore(yard.dir, yard.station, P, Math.max(OPENING.dayStart, notBefore), latest, turnP ? undefined : d.stops,
        stops => dep(d) - stops.at(-1)!.arr <= waitLimit(P, turnP, dep(d)) && safe(asTrip(yard.dir!, yard.station, P, stops), d)
          && (!turnP || reserve(P, stops.at(-1)!.arr, dep(d), false)));
      if (!move) return false;
      if (turnP) reserve(P, move.stops.at(-1)!.arr, dep(d));
      const trip = addMove(yard.dir, yard.station, P, move.stops, move.revenue);
      link(trip, d);
      startOf.set(trip.id, { kind: 'stable', station: yard.station, berth: yard.berth });
      addExit({ yard: yard.id, at: dep(trip) });
      return true;
    }
    const depot = yard.depot;
    if (exitStation(topo, depot, d.dir) === P) {
      const stops = d.stops;
      if (!exitClear(depot, d.dir, stops)) {
        if (DEBUG) { const [st, cl] = outboundWindow(ctx, depot, { dir: d.dir, stops });
          dutyDebug.push(`exit ${STATIONS[P].id} ${fmt(dep(d))} win ${fmt(st)}+${Math.round(cl - st)} vs ${inbound.filter(m => m.depot === depot && !(cl <= m.from || st >= m.to)).map(m => fmt(m.from) + '+' + Math.round(m.to - m.from) + (m.car !== undefined ? 'T' : '')).join(' ')}`); }
        return false;
      }
      const at = depotStartTime(ctx, depot, d);
      if (at < notBefore) return false;
      if (!canDraw(yard, at)) return false;
      startOf.set(d.id, { kind: 'depot', depot, time: 0 });
      const [from, to] = outboundWindow(ctx, depot, d);
      outbound.push({ depot, dir: d.dir, from, to });
      addExit({ yard: yard.id, at });
      return true;
    }
    const dir = depotDir(P, depot) === 'DN' ? 'UP' : 'DN';
    // (the car leaves the yard toward P: away from the junction)
    const from = exitStation(topo, depot, dir);
    if (from === P || ahead(dir, P, from)) return false;
    const turnP = dir !== d.dir;
    if (turnP && !turnbackAt(topo, P, dir)) return false;
    const latest = dep(d) - (turnP ? minTurn(P) : throughMin(P, d.dir, dep(d)));
    const move = fitBefore(dir, from, P, Math.max(OPENING.dayStart, notBefore), latest, turnP ? undefined : d.stops, stops => T('outer', outerQuiet(stops))
      && T('waitP', dep(d) - stops.at(-1)!.arr <= waitLimit(P, turnP, dep(d)))
      && T('safeP', safe(asTrip(dir, from, P, stops), d)) && T('exit', exitClear(depot, dir, stops)) && T('stock', canDraw(yard, depotStartTime(ctx, depot, { dir, stops }))) && depotStartTime(ctx, depot, { dir, stops }) >= notBefore
      && (!turnP || T('placeP', reserve(P, stops.at(-1)!.arr, dep(d), false))
        && T('frontP', frontTurnClear(ctx, live(), { dir, to: P, stops }, dep(d), new Set([d.id])))));
    if (!move) return false;
    if (turnP) reserve(P, move.stops.at(-1)!.arr, dep(d));
    const trip = addMove(dir, from, P, move.stops, move.revenue);
    link(trip, d);
    startOf.set(trip.id, { kind: 'depot', depot, time: 0 });
    const [start, clear] = outboundWindow(ctx, depot, trip);
    outbound.push({ depot, dir, from: start, to: clear });
    addExit({ yard: yard.id, at: depotStartTime(ctx, depot, trip) });
    return true;
  };
  const distanceTo = (yard: Yard, st: number) => yard.depot >= 0
    ? Math.abs(topo.depots[yard.depot].junctionChain - topo.stations[st].chain)
    : Math.abs(topo.stations[yard.station].chain - topo.stations[st].chain);
  const dropHeld = (id: number) => { const i = inbound.findIndex(m => m.car === id); if (i >= 0) dropInbound(i); };
  /** a car held for its yard's entry may go elsewhere only if the exits
   * fitted on the strength of its return still find their cars */
  const releasable = (id: number) => {
    const held = inbound.find(m => m.car === id);
    return !held || lowest(yards[held.depot], held.to, -1) >= 0;
  };
  /** while set, the homing functions only check that a way home exists, committing nothing */
  let dry = false;
  const homeBy = (car: Car, yard: Yard): boolean => {
    const X = car.station, a = car.trip;
    if (yard.depot < 0) {
      if (yard.dir === undefined || yard.berth === undefined) return false;
      const earliest = Math.max(arr(a) + (a.dir === toward(X, yard.station) ? THROUGH_MIN : minTurn(X)), yard.after ?? -Infinity);
      if (X === yard.station) return false;
      const dir = toward(X, yard.station);
      const turnX = a.dir !== dir;
      if (turnX && !turnbackAt(topo, X, a.dir)) return false;
      const berth = storageArrivalBerth(topo, yard.berth, dir);
      if (berth === undefined) return false;
      const move = fitAfter(dir, X, yard.station, earliest, Math.max(earliest, arr(a) + waitLimit(X, turnX, arr(a))), turnX ? undefined : a.stops,
        stops => safe(a, asTrip(dir, X, yard.station, stops))
          && (!turnX || reserve(X, arr(a), stops[0].dep, false) && frontTurnClear(ctx, live(), a, stops[0].dep, new Set([a.id]))));
      if (!move) return false;
      if (dry) return true;
      if (turnX) reserve(X, arr(a), move.stops[0].dep);
      const trip = addMove(dir, X, yard.station, move.stops, move.revenue);
      trip.kind = move.revenue ? 'wd' : 'empty';
      link(a, trip);
      endOf.set(trip.id, { kind: 'stable', station: yard.station, berth });
      return true;
    }
    const depot = yard.depot;
    if (entryStation(topo, depot, a.dir) === X) {
      if (DEBUG && trace && !entryClear(depot, a.dir, X, a.stops)) { const [f, u] = inboundWindow(topo, depot, a);
        dutyDebug.push(`  d-entry ${STATIONS[X].id} ${fmt(f)}-${fmt(u)} vs ${outbound.filter(m => m.depot === depot && !(m.to <= f || m.from >= u)).map(m => fmt(m.from) + '-' + fmt(m.to) + m.dir).join(' ')}`); }
      if (!T('d-entry', entryClear(depot, a.dir, X, a.stops)) || !T('d-full', canTake(depot, arr(a) + DEPOT_ENTRY_CLEAR))) return false;
      if (dry) return true;
      endOf.set(a.id, { kind: 'depot', depot });
      const [from, to] = inboundWindow(topo, depot, a);
      addInbound({ depot, dir: a.dir, from, to, at: arr(a) + DEPOT_ENTRY_CLEAR });
      return true;
    }
    const dir = depotDir(X, depot);
    const en = entryStation(topo, depot, dir);
    if (en === X || ahead(dir, en, X)) return false;
    const turnX = a.dir !== dir;
    if (turnX && !turnbackAt(topo, X, a.dir)) return false;
    const earliest = arr(a) + (turnX ? minTurn(X) : throughMin(X, a.dir, arr(a)));
    const move = fitAfter(dir, X, en, earliest, arr(a) + waitLimit(X, turnX, arr(a)), turnX ? undefined : a.stops,
      stops => T('outer', outerQuiet(stops)) && T('safeX', safe(a, asTrip(dir, X, en, stops))) && T('entry', entryClear(depot, dir, en, stops))
        && T('full', canTake(depot, stops.at(-1)!.arr + DEPOT_ENTRY_CLEAR))
        && (!turnX || T('placeX', reserve(X, arr(a), stops[0].dep, false)) && T('frontX', frontTurnClear(ctx, live(), a, stops[0].dep, new Set([a.id])))));
    if (!move) return false;
    if (dry) return true;
    if (turnX) reserve(X, arr(a), move.stops[0].dep);
    const trip = addMove(dir, X, en, move.stops, move.revenue);
    trip.kind = move.revenue ? 'wd' : 'empty';
    link(a, trip);
    endOf.set(trip.id, { kind: 'depot', depot });
    const [from, to] = inboundWindow(topo, depot, trip);
    addInbound({ depot, dir, from, to, at: arr(trip) + DEPOT_ENTRY_CLEAR });
    return true;
  };

  /** car `car` takes departure `want`: turning or running on at its own
   * station, else by a positioning run; links them (D184, added services) */
  const join = (car: Car, want: Want): boolean => {
    if (car.station !== want.station) return !!position(car, want);
    const a = car.trip, d = want.trip, X = car.station, turn = a.dir !== d.dir, wait = dep(d) - arr(a);
    if (wait < (turn ? minTurn(X) : throughMin(X, a.dir, arr(a))) - 1e-6 || wait > waitLimit(X, turn, dep(d)) || !safe(a, d)) return false;
    if (turn && (!turnbackAt(topo, X, a.dir) || !frontTurnClear(ctx, live(), a, dep(d), new Set([a.id, d.id])) || !reserve(X, arr(a), dep(d)))) return false;
    link(a, d);
    return true;
  };

  /** The base plan's own use of the places and yards (added services, D184):
   * its terminal stands, depot leads and yard events; with `live`, the yard
   * stock now and the events still to come. */
  const seeded = new Map<number, { exit?: (typeof exits)[number]; out?: (typeof outbound)[number]; entry?: (typeof inbound)[number] }>();
  const seedBase = (plan: Plan, live?: { at: number; levels: number[]; departed: number[]; done: number[] }) => {
    for (const [st, list] of terminalOccupancy(plan)) places.set(st, [...(places.get(st) ?? []), ...list.map(o => ({ from: o.from, to: o.to + clearAfter(st) }))]);
    if (live) for (const y of yards) if (y.depot >= 0) y.stock = live.levels[y.depot];
    for (const m of depotMoves(plan.blocks, plan.trips, ctx)) {
      if (live && (live.done.includes(m.block) || m.delta < 0 && live.departed.includes(m.block) || m.time < live.at)) continue;
      const ts = plan.blocks[m.block].trips.map(id => plan.trips[id]).filter(t => !t.cancelled);
      const own = seeded.get(m.block) ?? {};
      seeded.set(m.block, own);
      if (m.delta < 0 && ts[0]) {
        const [from, to] = outboundWindow(ctx, m.depot, ts[0]);
        own.exit = { yard: m.depot, at: m.time }; addExit(own.exit);
        own.out = { depot: m.depot, dir: ts[0].dir, from, to }; outbound.push(own.out);
      } else if (m.delta > 0 && ts.length) {
        const [from, to] = inboundWindow(topo, m.depot, ts.at(-1)!);
        own.entry = { depot: m.depot, dir: ts.at(-1)!.dir, from, to, at: m.time }; addInbound(own.entry);
      }
    }
  };
  /** take a base duty's yard exit or entry out of the ledger; returns its undo */
  const unseed = (block: number, which: 'exit' | 'entry'): (() => void) => {
    const own = seeded.get(block);
    const exit = which === 'exit' ? own?.exit : undefined, out = which === 'exit' ? own?.out : undefined, entry = which === 'entry' ? own?.entry : undefined;
    if (exit && exits.includes(exit)) { exits.splice(exits.indexOf(exit), 1); ledgerVersion++; }
    if (out && outbound.includes(out)) outbound.splice(outbound.indexOf(out), 1);
    if (entry && inbound.includes(entry)) dropInbound(inbound.indexOf(entry));
    return () => { if (exit) addExit(exit); if (out) outbound.push(out); if (entry) addInbound(entry); };
  };

  return {
    E, lineEnd, factor, arr, dep, live, services, leavingFrom, lineEndStand, throughMin, waitLimit, openers, index, slot, lastService, POSITIONING,
    addMove, startOf, endOf, link, places, standbyPlaces, reserve, yards, asTrip, safe, moveStops, outerQuiet, exitClear, entryClear,
    exits, inbound, outbound, addExit, addInbound, dropInbound, fitBefore, fitAfter, toward, depotDir, position, lowest, canDraw, canTake,
    feed, distanceTo, dropHeld, releasable, homeBy, join, seedBase, unseed, clearAfter,
    get viaCore() { return viaCore; }, set viaCore(v: boolean) { viaCore = v; },
    get early() { return early; }, set early(v: boolean) { early = v; },
    get dry() { return dry; }, set dry(v: boolean) { dry = v; },
  };
}
