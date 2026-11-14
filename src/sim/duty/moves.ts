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

/** a yard move over a shared-lead station's tracks (`st`); `trip`: the trip a return enters on */
export interface LeadBooking { st: number; move: LeadMove; trip?: number }
import { plannedDwell } from '../calibration';
import {
  addTo, buildStops, carryingStops, passesOpenStation, connectionSafe, depotLeadLink, depotStartTime,
  dwellFactorAt, entryStation, exitStation, frontTurnClear, inboundWindow, inOuterAlternation,
  minTurn, outboundWindow, overnightPlaces, storageArrivalBerth, terminalCapacity, terminalOverflows,
  tailOrderClear, turnbackAt, DepIndex, MAX_LAYOVER, THROUGH_WAIT, MIN_HEADWAY, CARRY_MOVES, OPENING, CORE_W, CORE_E,
  TEMPLATES, periodAt, openingAnchors, DEPOT_ENTRY_CLEAR, depotMoves, terminalOccupancy, portalReversal, INTERMEDIATE_WAIT,
  noDepotReturnBefore, lineEndStand as lineEndStandAt, leadMoveConflict, type LeadMove, depotIndex, platformBerth,
} from '../timetable';
import { berthRoundTripReachable, buildRouteTable, type RouteTable } from '../routeTable';
import { OPERATIONS, STATIONS } from '../../data/current';
import { ahead, between, sharedTransferLink } from '../topology';
import type { PoolCar, PoolDemand } from './pool';

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

const routeTables = new WeakMap<PlanContext['topo'], RouteTable>();
/** a stationed standby arrives within this of its window's start (s) 【假设】L14-03：最多后移 1 小时 */
const STANDBY_SLIP = 3600;

/** `notBefore`: no yard exit or move may start earlier (a plan changed while the day runs); `added`: the
 * duties of added services (加开, duty/overlay.ts) */
export function createMoves(ctx: PlanContext, trips: GenTrip[], periods: Period[], opts: { notBefore?: number; added?: boolean } = {}) {
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
  // (the stand itself: lineEndStand in timetable.ts)
  const noReturnBefore = noDepotReturnBefore();
  // 用户决定（2026-11-10）：一列车全天再没有活（早高峰东头多出来的车），10:00 前也可以就近顺向进库
  let idleHome = false;
  const homeFrom = () => idleHome ? -Infinity : noReturnBefore;
  /** a car arriving at `arrival`: the shared rule (timetable.ts); an idle car going home stands no longer for 10:00 */
  const lineEndStand = (st: number, arrival: number) => lineEndStandAt(ctx.dayType, st, arrival, leavingFrom.get(st) ?? [], homeFrom());
  /** shortest stop of a car running on at `st` from `at`: passengers alight and board (planned dwell) */
  const throughMin = (st: number, dir: TrackDir, at: number) => Math.max(THROUGH_MIN, plannedDwell(ctx.dayType, st, dir, at, dwellFactorAt(ctx.dayType, at)));
  // D189: an intermediate station with two or more turnback tracks (淞虹路) stands a turning
  // car on its own track like a line end: its turn and one interval of the departures there
  // (the evening small-route arrivals fall 3 min before a departure: too short to turn, so
  // they take the next one, 12 min on — not a reason to swap cars through the yard).
  const ownTracks = (st: number) => topo.stations[st].turnbackBerths.filter(b => topo.berths[b].kind !== 'platform').length > 1;
  /** trips of this planner's own: an added service's (opts.added), or a move fitted here */
  const firstNew = trips.length;
  const addedTrip = (t: GenTrip | undefined) => !!opts.added && (!t || t.overlay !== undefined || t.id >= firstNew);
  /** longest stand of a car arriving at `st` at `at` (`car`: its trip; none: a move fitted here) before it
   * runs on or turns. An added train turns at an intermediate station, own tracks or not, within D47's
   * limit (applyOverlay turnWait, validatePlan LAYOVER_LONG). */
  const waitLimit = (st: number, turn: boolean, at: number, car?: GenTrip) => !turn ? THROUGH_WAIT
    : lineEnd(st) || ownTracks(st) && !addedTrip(car) ? lineEndStand(st, at) : minTurn(st) + INTERMEDIATE_WAIT;
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
  /** `dep`: the departure (`to` adds the platform's clearing time) */
  const places = new Map<number, { from: number; to: number; dep: number }[]>();
  const standbyPlaces = new Map<number, { from: number; to: number }[]>();
  const clearAfter = (st: number) => OPERATIONS.platformTurnClear[STATIONS[st].id] ?? 0;
  const reserve = (st: number, from: number, to: number, commit = true) => {
    const list = places.get(st) ?? [];
    const held = { from, to: to + clearAfter(st), dep: to };
    const combined = [...list, held];
    // (every committed hold passed this check: only the ones near the new one can overflow with it)
    if (terminalOverflows(topo, st, combined.filter(p => p.to >= held.from - 3600 && p.from <= held.to + 3600)).length) return false;
    if (!tailOrderClear(topo, st, list, held.from, held.to)) return false;
    if (!leadRoom(st, { turn: held })) return false;
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
  /** a move wholly within one of OPERATIONS.emptyLegs never carries (D166 does not apply there) */
  const emptyLegs = (OPERATIONS.emptyLegs ?? []).map(([a, b]) => [STATIONS.findIndex(s => s.id === a), STATIONS.findIndex(s => s.id === b)])
    .filter(([a, b]) => a >= 0 && b >= 0);
  const emptyLeg = (from: number, to: number) => emptyLegs.some(([a, b]) => between(from, a, b) && between(to, a, b));
  /** carrying when it can board anybody; empty only while every station on
   * it is still closed (D166). */
  const buildMove = (dir: TrackDir, from: number, to: number, start: number) => {
    // it keeps a service train's times (the outer stream's slot) but calls nowhere
    if (emptyLeg(from, to)) {
      const stops = buildStops(ctx, dir, from, to, start, true, factor);
      stops.forEach((p, i) => { if (i < stops.length - 1) p.stop = false; });
      return { stops, revenue: false };
    }
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
  // A move depends only on its arguments here (ctx, openers and lastService are fixed for this
  // planner); the fitting loops build the same slot many times over (weekday: ~350k calls,
  // ~28k distinct), so each is built once and every caller gets its own copy.
  const builtMoves = new Map<string, ReturnType<typeof buildMove>>();
  const moveStops = (dir: TrackDir, from: number, to: number, start: number) => {
    const key = `${dir}${from},${to},${start}`;
    let move = builtMoves.get(key);
    if (move === undefined) { move = buildMove(dir, from, to, start); builtMoves.set(key, move); }
    return move && { stops: move.stops.map(p => ({ ...p })), revenue: move.revenue };
  };
  // No empty or non-boarding move on the outer leg inside a peak's big/small
  // alternation; a move carrying passengers there is one more service train
  // in that stream (D178: the official west interval needs the morning
  // ramp's extra trains, which the bare pattern does not give).
  const outer = (p: PlanStop) => ahead('DN', p.st, CORE_W);
  const outerQuiet = (stops: PlanStop[]) => (emptyLeg(stops[0].st, stops.at(-1)!.st) || !stops.some(p => outer(p) && inOuterAlternation(periods, p.dep))
      || stops.slice(0, -1).every(p => !outer(p) || p.stop && !p.noBoard))
    && T('core', viaCore || !stops.some(p => ahead('DN', CORE_W, p.st) && ahead('DN', p.st, CORE_E)));
  /** a supply move may run through the core interior */
  let viaCore = true;
  const exitClear = (depot: number, dir: TrackDir, stops: PlanStop[]) => {
    const [start, clear] = outboundWindow(ctx, depot, { dir, stops });
    const lead = depotLeadLink(topo, depot, false, dir);
    if (!leadRoom(exitStation(topo, depot, dir), { move: { depot, link: lead, window: [start, clear] } })) return false;
    return lead === undefined || inbound.every(m => m.depot !== depot || depotLeadLink(topo, depot, true, m.dir) !== lead || clear <= m.from || start >= m.to);
  };
  const entryClear = (depot: number, dir: TrackDir, to: number, stops: PlanStop[]) => {
    const [from, until] = inboundWindow(topo, depot, { to, stops });
    const lead = depotLeadLink(topo, depot, true, dir);
    if (!leadRoom(entryStation(topo, depot, dir), { move: { depot, link: lead, window: [from, until], entry: { dir, station: to, arr: stops.at(-1)!.arr } } })) return false;
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
  /** `at`: the car counts in the yard's stock, the same moment as the day ledger (depotMoves);
   * `st`, `arr`: the return's last stop and its arrival there; `trip`: the trip it enters on
   * (this plan's; the car it brings: planner.ts carOf) */
  const inbound: { depot: number; dir: TrackDir; from: number; to: number; at: number; st: number; arr: number; trip?: number; car?: number }[] = [];
  const outbound: { depot: number; dir: TrackDir; from: number; to: number }[] = [];
  const addExit = (x: (typeof exits)[number]) => { ledgerVersion++; exits.push(x); };
  /** D189: where the turnback tracks are also the depot leads (淞虹路 1/2 道), a turning
   * car stands on one of them from its arrival to its departure, and a yard move
   * passes over its own lead: every turn must find one track free of the moves
   * (the rule validation checks, leadMoveConflict) and of the other turns for its
   * whole stand. `add`: the new turn, or the new move. */
  // (only where a turning car may wait on them, plannedWaitBerth: two or more such tracks)
  const sharedTurnLeads = (st: number) => topo.stations[st].turnbackBerths.length > 1
    && topo.stations[st].turnbackBerths.some(b => sharedTransferLink(topo, topo.berths[b].link));
  type Stand = { from: number; to: number; dep: number };
  /** the yard moves booked so far over the leads of shared-lead stations (or of `at` only), as the lead rule sees them */
  const leadMoves = (at?: number): LeadBooking[] => {
    const here = (st: number) => at === undefined ? st >= 0 && sharedTurnLeads(st) : st === at;
    return [
      ...outbound.filter(m => here(exitStation(topo, m.depot, m.dir)))
        .map(m => ({ st: exitStation(topo, m.depot, m.dir), move: { depot: m.depot, link: depotLeadLink(topo, m.depot, false, m.dir), window: [m.from, m.to] as const } })),
      ...inbound.filter(m => here(entryStation(topo, m.depot, m.dir))).map(m => ({ st: entryStation(topo, m.depot, m.dir), trip: m.trip,
        move: { depot: m.depot, link: depotLeadLink(topo, m.depot, true, m.dir), window: [m.from, m.to] as const, entry: { dir: m.dir, station: m.st, arr: m.arr } } })),
    ];
  };
  /** while a car is sent off-peak to another yard (planner.ts redirect): the moves the plain day
   * plan books (the probe pass) bind its turn too, but for that car's own return there */
  let redirecting: { moves: readonly LeadBooking[]; own: (b: LeadBooking) => boolean } | undefined;
  const leadRoom = (st: number, add: { turn: Stand } | { move: LeadMove }) => {
    if (st < 0 || !sharedTurnLeads(st)) return true;
    const [lo, hi] = 'turn' in add ? [add.turn.from, add.turn.to] : add.move.window;
    const near = (from: number, to: number) => from < hi + 3600 && to > lo - 3600;
    const nearBy = (b: LeadBooking) => b.st === st && near(...b.move.window);
    const moves: LeadMove[] = [...leadMoves(st).filter(nearBy), ...(redirecting?.moves.filter(b => nearBy(b) && !redirecting!.own(b)) ?? [])].map(b => b.move);
    const turns: Stand[] = (places.get(st) ?? []).filter(h => near(h.from, h.to));
    if ('turn' in add) turns.push(add.turn); else moves.push(add.move);
    turns.sort((a, b) => a.from - b.from);
    // the turnback a car arriving there turns on (each way that turns there)
    const rear = (['DN', 'UP'] as TrackDir[]).flatMap(arrDir => {
      const tb = turnbackAt(topo, st, arrDir);
      return tb?.kind === 'rear' ? [{ arrDir, depDir: (arrDir === 'DN' ? 'UP' : 'DN') as TrackDir, berths: tb.berths }] : [];
    });
    const berths = [...new Set(rear.flatMap(r => r.berths))];
    const free = (w: Stand, berth: number) => !moves.some(m => rear.some(r => r.berths.includes(berth)
      && leadMoveConflict(topo, { station: st, arrDir: r.arrDir, depDir: r.depDir, from: w.from, to: w.dep }, berth, m)));
    const options = turns.map(w => berths.filter(b => free(w, b)));
    const busy = new Map<number, Stand[]>(berths.map(b => [topo.berths[b].link, []]));
    const place = (k: number): boolean => {
      if (k === turns.length) return true;
      for (const b of options[k]) {
        const track = busy.get(topo.berths[b].link)!;
        if (track.some(o => o.from < turns[k].to && o.to > turns[k].from)) continue;
        track.push(turns[k]);
        if (place(k + 1)) return true;
        track.pop();
      }
      return false;
    };
    return place(0);
  };
  const addInbound = (m: (typeof inbound)[number]) => { ledgerVersion++; inbound.push(m); };
  const dropInbound = (i: number) => { ledgerVersion++; inbound.splice(i, 1); };
  /** a cheap headway pre-test of the slot at `at`: the move built at a
   * nearby slot, shifted (with slack for the dwell differences); the exact
   * move is built and tested only where this passes */
  const preClear = (dir: TrackDir, from: number, to: number, own: PlanStop[] | undefined) => {
    let base: { at: number; stops: PlanStop[] | undefined } | undefined;
    /** how many FIT_STEP slots on from `at` (stepping later, or earlier when `down`) the pre-test fails
     * for certain (0: it passes at `at`): a slot it fails at is skipped as before, only without building
     * and testing each one; never past this anchor, whose successor is built where the loop reaches it */
    return (at: number, down = false) => {
      if (!base || Math.abs(at - base.at) > PRE_ANCHOR) base = { at, stops: moveStops(dir, from, to, at)?.stops };
      if (!base.stops) return 0;
      const gap = index.clearGap(base.stops, dir, MIN_HEADWAY - PRE_SLACK, own, at - base.at, down);
      if (gap <= 0) return 0;
      const room = Math.floor((PRE_ANCHOR - (down ? base.at - at : at - base.at)) / FIT_STEP + 1e-9);
      return Math.max(1, Math.min(Math.ceil(gap / FIT_STEP - 1e-6), room));
    };
  };
  /** latest move from→to arriving by `latest` (and not before `earliest`) that fits the stream */
  const fitBefore = (dir: TrackDir, from: number, to: number, earliest: number, latest: number, own: PlanStop[] | undefined,
    accept: (stops: PlanStop[]) => boolean) => {
    const probe = moveStops(dir, from, to, 0) ?? moveStops(dir, from, to, latest); // (only its run time is used)
    if (!probe) return null;
    let start = latest - probe.stops.at(-1)!.arr;
    for (let k = 0; k < 6; k++) {
      const run = moveStops(dir, from, to, start);
      if (!run) break;
      start -= run.stops.at(-1)!.arr - latest;
    }
    const pre = preClear(dir, from, to, own);
    for (let at = Math.floor(start); at >= earliest - 1e-6 && at >= start - FIT_SPAN; at -= FIT_STEP) {
      const skip = pre(at, true);
      if (!T('headway', !skip)) { at -= (skip - 1) * FIT_STEP; continue; }
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
      const skip = pre(at);
      if (!T('headway', !skip)) { at += (skip - 1) * FIT_STEP; continue; }
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
      && T('waitX', stops[0].dep - arr(a) <= waitLimit(X, turnX, arr(a), a)) && T('waitP', dep(d) - stops.at(-1)!.arr <= waitLimit(P, turnP, stops.at(-1)!.arr))
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
  const opposite = (dir: TrackDir): TrackDir => dir === 'UP' ? 'DN' : 'UP';
  // ---- the pieces every yard run shares: a depot exit or entry, a leg into a departure, a leg out of an arrival
  /** the depot side of a move leaving `yard` running `dir`: its exit path, a car in stock, not before notBefore */
  const exitFits = (yard: Yard, dir: TrackDir, stops: PlanStop[]) => T('exit', exitClear(yard.depot, dir, stops))
    && T('stock', canDraw(yard, depotStartTime(ctx, yard.depot, { dir, stops }))) && depotStartTime(ctx, yard.depot, { dir, stops }) >= notBefore;
  /** the depot side of a move entering `depot` running `dir`: its entry path and a free road */
  const entryFits = (depot: number, dir: TrackDir, en: number, stops: PlanStop[]) => T('entry', entryClear(depot, dir, en, stops))
    && T('full', canTake(depot, stops.at(-1)!.arr + DEPOT_ENTRY_CLEAR));
  /** a car leaves `yard`'s depot on `trip`, its first move */
  const leaveYard = (yard: Yard, trip: GenTrip) => {
    const depot = yard.depot;
    startOf.set(trip.id, { kind: 'depot', depot, time: 0 });
    const [from, to] = outboundWindow(ctx, depot, trip);
    outbound.push({ depot, dir: trip.dir, from, to });
    addExit({ yard: yard.id, at: depotStartTime(ctx, depot, trip) });
  };
  /** a car enters `depot` at the end of `trip` */
  const enterYard = (depot: number, trip: GenTrip) => {
    endOf.set(trip.id, { kind: 'depot', depot });
    const [from, to] = inboundWindow(topo, depot, trip);
    addInbound({ depot, dir: trip.dir, from, to, at: arr(trip) + DEPOT_ENTRY_CLEAR, st: trip.to, arr: arr(trip), trip: trip.id });
  };
  /** A stationed hot standby (a hotStandby place with yard sources, 用户决定 L14-03): a car leaves a
   * yard, stands on the place's track from the window's start and goes home to the same yard after
   * its end. Sources in the data's order; one counts only if the track's two stopping heads are
   * reachable by normal routes from and to the main line that way. A turnback track is held in the
   * station's place calendar like any long turn; a storage track is clear before its night car is due.
   * Returns the reason when no source can run it. */
  const stationedStandby = (place: { station: number; berth: number; track: 'turnback' | 'storage'; depot?: string; incoming?: TrackDir;
    alternatives?: readonly { depot: string; incoming: TrackDir }[] }, window: { from: number; to: number }): string | undefined => {
    let reason = '进位';
    const P = place.station, track = topo.berths[place.berth].link;
    const night = yards.find(y => y.depot < 0 && y.night !== undefined && topo.berths[y.night].link === track);
    for (const source of [{ depot: place.depot!, incoming: place.incoming! }, ...(place.alternatives ?? [])]) {
      const depot = depotIndex(topo, source.depot), dir = source.incoming, back = opposite(dir);
      if (depot < 0) continue;
      const ex = exitStation(topo, depot, dir), en = entryStation(topo, depot, back);
      const head = storageArrivalBerth(topo, place.berth, dir), tail = storageArrivalBerth(topo, place.berth, back);
      const there = moveStops(dir, ex, P, window.from), home = moveStops(back, P, en, window.to);
      if (head === undefined || tail === undefined || !there || !home || there.stops.length < 2 || home.stops.length < 2) { reason = '泊位进出路径'; continue; }
      let table = routeTables.get(topo);
      if (!table) routeTables.set(topo, table = buildRouteTable(topo));
      if (!berthRoundTripReachable(topo, table, platformBerth(topo, there.stops.at(-2)!.st, dir), head, tail,
        platformBerth(topo, home.stops[1].st, back))) { reason = '泊位进出路径'; continue; }
      const yard = yards[depot], run = there.stops.at(-1)!.arr - window.from;
      const arrives = (stops: PlanStop[]) => stops.at(-1)!.arr >= window.from - 1e-6 && stops.at(-1)!.arr <= window.from + STANDBY_SLIP;
      const from = Math.max(OPENING.dayStart, notBefore, window.from - run - 60), until = window.from + STANDBY_SLIP - run + 60;
      const out = fitAfter(dir, ex, P, from, until, undefined, stops => arrives(stops) && exitFits(yard, dir, stops));
      if (!out) {
        // the slot and the lead exist but the yard has no car to spare then
        if (fitAfter(dir, ex, P, from, until, undefined, stops => arrives(stops) && exitClear(depot, dir, stops))) reason = '基地库存';
        continue;
      }
      const latest = Math.min(window.to + STANDBY_SLIP, (night?.after ?? Infinity) - 60 - MIN_HEADWAY);
      const into = fitAfter(back, P, en, window.to, latest, undefined, stops => entryFits(depot, back, en, stops)
        && (place.track !== 'turnback' || T('standby-track', reserve(P, out.stops.at(-1)!.arr, stops[0].dep, false))));
      if (!into) {
        // the way home exists but the station's turning needs this track meanwhile
        reason = place.track === 'turnback' && fitAfter(back, P, en, window.to, latest, undefined, stops => entryFits(depot, back, en, stops)) ? '折返线容量' : '回段';
        continue;
      }
      if (place.track === 'turnback') reserve(P, out.stops.at(-1)!.arr, into.stops[0].dep);
      const arrival = addMove(dir, ex, P, out.stops, out.revenue), departure = addMove(back, P, en, into.stops, into.revenue);
      arrival.standby = true;
      link(arrival, departure);
      leaveYard(yard, arrival);
      enterYard(depot, departure);
      return undefined;
    }
    return reason;
  };
  /** the latest move from→P running `dir` that brings a car for departure `d` there (turning at P when
   * `dir` is not d's): its wait, the car's berth and, turning, P's turnback and front route; `fits`: the rest */
  const fitInto = (dir: TrackDir, from: number, P: number, d: GenTrip, fits: (stops: PlanStop[]) => boolean) => {
    const turnP = dir !== d.dir;
    if (turnP && !turnbackAt(topo, P, dir)) return null;
    const latest = dep(d) - (turnP ? minTurn(P) : throughMin(P, d.dir, dep(d)));
    return fitBefore(dir, from, P, Math.max(OPENING.dayStart, notBefore), latest, turnP ? undefined : d.stops, stops => T('outer', outerQuiet(stops))
      && T('waitP', dep(d) - stops.at(-1)!.arr <= waitLimit(P, turnP, stops.at(-1)!.arr)) && T('safeP', safe(asTrip(dir, from, P, stops), d)) && fits(stops)
      && (!turnP || T('placeP', reserve(P, stops.at(-1)!.arr, dep(d), false))
        && T('frontP', frontTurnClear(ctx, live(), { dir, to: P, stops }, dep(d), new Set([d.id])))));
  };
  /** the earliest move X→to running `dir` that takes car `a` on from X (turning there when `dir` is not
   * a's), from its turn (or `earliest`) to `latest`: the car's berth and, turning, X's turnback and front route */
  const fitOutOf = (a: GenTrip, X: number, dir: TrackDir, to: number, earliest: number, latest: (turnX: boolean) => number,
    fits: (stops: PlanStop[]) => boolean) => {
    const turnX = a.dir !== dir;
    if (turnX && !turnbackAt(topo, X, a.dir)) return null;
    return fitAfter(dir, X, to, Math.max(arr(a) + (turnX ? minTurn(X) : throughMin(X, a.dir, arr(a))), earliest), latest(turnX), turnX ? undefined : a.stops,
      stops => fits(stops) && T('outer', outerQuiet(stops)) && T('safeX', safe(a, asTrip(dir, X, to, stops)))
        && (!turnX || T('placeX', reserve(X, arr(a), stops[0].dep, false)) && T('frontX', frontTurnClear(ctx, live(), a, stops[0].dep, new Set([a.id])))));
  };
  /** the nearest station beyond `st` running `dir` where a train arriving `dir` can turn back */
  const turnBeyond = (st: number, dir: TrackDir): number | undefined => STATIONS.map((_, k) => k)
    .filter(k => ahead(dir, st, k) && !!turnbackAt(topo, k, dir))
    .sort((a, b) => Math.abs(topo.stations[a].chain - topo.stations[st].chain) - Math.abs(topo.stations[b].chain - topo.stations[st].chain))[0];
  /** 用户决定（2026-11-08）：出库方向就是运行方向。A car for `want` leaves its yard the way the portal
   * faces without changing ends, runs on to the next turnback (川沙 → 广兰路), turns there and runs
   * back to P (OPERATIONS.portalReversal). */
  const feedViaTurn = (yard: Yard, want: Want): boolean => {
    const depot = yard.depot, P = want.station, d = want.trip;
    for (const dir1 of ['UP', 'DN'] as TrackDir[]) {
      if (topo.depots[depot].portals.exit[dir1].reverse) continue;
      const from = exitStation(topo, depot, dir1), dir2 = opposite(dir1), K = turnBeyond(from, dir1);
      if (K === undefined || K === P || !ahead(dir2, K, P)) continue;
      const back = fitInto(dir2, K, P, d, () => true);
      if (!back) { if (DEBUG) dutyDebug.push(`via-turn ${STATIONS[P].id} ${d.dir} ${fmt(dep(d))} back ${STATIONS[K].id}→${STATIONS[P].id} failed`); continue; }
      const second = asTrip(dir2, K, P, back.stops), leave = back.stops[0].dep;
      const out = fitBefore(dir1, from, K, Math.max(OPENING.dayStart, notBefore), leave - minTurn(K), undefined, stops => T('outer', outerQuiet(stops))
        && T('waitK', leave - stops.at(-1)!.arr <= waitLimit(K, true, stops.at(-1)!.arr)) && T('safeK', safe(asTrip(dir1, from, K, stops), second))
        && exitFits(yard, dir1, stops)
        && T('placeK', reserve(K, stops.at(-1)!.arr, leave, false))
        && T('frontK', frontTurnClear(ctx, live(), { dir: dir1, to: K, stops }, leave, new Set())));
      if (!out) { if (DEBUG) dutyDebug.push(`via-turn ${STATIONS[P].id} ${d.dir} ${fmt(dep(d))} out →${STATIONS[K].id} by ${fmt(leave - minTurn(K))} failed`); continue; }
      reserve(K, out.stops.at(-1)!.arr, leave);
      if (dir2 !== d.dir) reserve(P, back.stops.at(-1)!.arr, dep(d));
      const first = addMove(dir1, from, K, out.stops, out.revenue), then = addMove(dir2, K, P, back.stops, back.revenue);
      link(first, then); link(then, d);
      leaveYard(yard, first);
      return true;
    }
    return false;
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
        stops => dep(d) - stops.at(-1)!.arr <= waitLimit(P, turnP, stops.at(-1)!.arr) && safe(asTrip(yard.dir!, yard.station, P, stops), d)
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
      // a platform change of ends here is not used in service (OPERATIONS.portalReversal)
      const rule = portalReversal(topo, depot, 'exit', d.dir, depotStartTime(ctx, depot, d));
      if (rule !== 'yes' && feedViaTurn(yard, want)) return true;
      if (rule === 'no') return false;
      const stops = d.stops;
      if (!exitClear(depot, d.dir, stops)) {
        if (DEBUG) { const [st, cl] = outboundWindow(ctx, depot, { dir: d.dir, stops });
          dutyDebug.push(`exit ${STATIONS[P].id} ${fmt(dep(d))} win ${fmt(st)}+${Math.round(cl - st)} vs ${inbound.filter(m => m.depot === depot && !(cl <= m.from || st >= m.to)).map(m => fmt(m.from) + '+' + Math.round(m.to - m.from) + (m.car !== undefined ? 'T' : '')).join(' ')}`); }
        return false;
      }
      const at = depotStartTime(ctx, depot, d);
      if (at < notBefore) return false;
      if (!canDraw(yard, at)) return false;
      leaveYard(yard, d);
      return true;
    }
    const dir = depotDir(P, depot) === 'DN' ? 'UP' : 'DN';
    // (the car leaves the yard toward P: away from the junction)
    const from = exitStation(topo, depot, dir);
    if (from === P || ahead(dir, P, from)) return false;
    // its exit changes ends on the junction platform: turn beyond instead (OPERATIONS.portalReversal)
    if (topo.depots[depot].portals.exit[dir].reverse && portalReversal(topo, depot, 'exit', dir, dep(d)) !== 'yes' && feedViaTurn(yard, want)) return true;
    const move = fitInto(dir, from, P, d, stops => exitFits(yard, dir, stops)
      && T('reverse', portalReversal(topo, depot, 'exit', dir, depotStartTime(ctx, depot, { dir, stops })) !== 'no'));
    if (!move) return false;
    if (dir !== d.dir) reserve(P, move.stops.at(-1)!.arr, dep(d));
    const trip = addMove(dir, from, P, move.stops, move.revenue);
    link(trip, d);
    leaveYard(yard, trip);
    return true;
  };
  const distanceTo = (yard: Yard, st: number) => yard.depot >= 0
    ? Math.abs(topo.depots[yard.depot].junctionChain - topo.stations[st].chain)
    : Math.abs(topo.stations[yard.station].chain - topo.stations[st].chain);
  /** 用户决定（2026-11-10）：a car with no more work that reaches its nearest yard's entry, or its own end,
   * before the end of the morning peak (OPERATIONS.noDepotReturnBefore) goes home to that yard only, then
   * (idleHome); undefined: it goes home by the ordinary rules */
  const idleYard = (car: Car): Yard | undefined => {
    const yard = yards.filter(y => y.depot >= 0).sort((a, b) => distanceTo(a, car.station) - distanceTo(b, car.station))[0];
    if (!yard) return undefined;
    const entry = entryStation(topo, yard.depot, car.trip.dir);
    return car.trip.stops.some(p => (p.st === entry || p === car.trip.stops.at(-1)) && p.arr < noReturnBefore) ? yard : undefined;
  };
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
      const move = fitAfter(dir, X, yard.station, earliest, Math.max(earliest, arr(a) + waitLimit(X, turnX, arr(a), a)), turnX ? undefined : a.stops,
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
      if (!T('peakHome', arr(a) >= homeFrom())) return false;
      // entering here would change ends on the platform: turn beyond instead (OPERATIONS.portalReversal)
      const rule = portalReversal(topo, depot, 'entry', a.dir, arr(a));
      if (rule !== 'yes' && homeViaTurn(car, yard)) return true;
      if (rule === 'no') return false;
      if (DEBUG && trace && !entryClear(depot, a.dir, X, a.stops)) { const [f, u] = inboundWindow(topo, depot, a);
        dutyDebug.push(`  d-entry ${STATIONS[X].id} ${fmt(f)}-${fmt(u)} vs ${outbound.filter(m => m.depot === depot && !(m.to <= f || m.from >= u)).map(m => fmt(m.from) + '-' + fmt(m.to) + m.dir).join(' ')}`); }
      if (!T('d-entry', entryClear(depot, a.dir, X, a.stops)) || !T('d-full', canTake(depot, arr(a) + DEPOT_ENTRY_CLEAR))) return false;
      if (dry) return true;
      enterYard(depot, a);
      return true;
    }
    const dir = depotDir(X, depot);
    const en = entryStation(topo, depot, dir);
    // (the entry must lie ahead: on a branched line a station off that way is not merely behind)
    if (en === X || !ahead(dir, X, en)) return false;
    if (topo.depots[depot].portals.entry[dir].reverse && portalReversal(topo, depot, 'entry', dir, arr(a)) !== 'yes' && homeViaTurn(car, yard)) return true;
    // (no entry before the end of the morning peak: a turning car stands on until then)
    const probe = moveStops(dir, X, en, 0), run = probe ? probe.stops.at(-1)!.arr - probe.stops[0].dep : 0;
    const move = fitOutOf(a, X, dir, en, homeFrom() - run, turnX => arr(a) + waitLimit(X, turnX, arr(a), a),
      stops => T('peakHome', stops.at(-1)!.arr >= homeFrom()) && entryFits(depot, dir, en, stops)
        && T('reverse', portalReversal(topo, depot, 'entry', dir, stops.at(-1)!.arr) !== 'no'));
    if (!move) return false;
    if (dry) return true;
    if (a.dir !== dir) reserve(X, arr(a), move.stops[0].dep);
    const trip = addMove(dir, X, en, move.stops, move.revenue);
    trip.kind = move.revenue ? 'wd' : 'empty';
    link(a, trip);
    enterYard(depot, trip);
    return true;
  };

  /** 用户决定（2026-11-08）：a car for a yard whose entry from its side changes ends on the junction
   * platform runs past it to the next turnback (远东大道 → 广兰路), turns and enters running the way the
   * portal faces (OPERATIONS.portalReversal). */
  const homeViaTurn = (car: Car, yard: Yard): boolean => {
    const depot = yard.depot, X = car.station, a = car.trip;
    for (const dirE of ['UP', 'DN'] as TrackDir[]) {
      if (topo.depots[depot].portals.entry[dirE].reverse) continue;
      const en = entryStation(topo, depot, dirE), dirO = opposite(dirE);
      if (X !== en && !ahead(dirO, X, en)) continue;
      const K = turnBeyond(en, dirO);
      if (K === undefined) continue;
      // a car with no more work may stand on at a line end until a path home opens (its track reserved)
      const out = fitOutOf(a, X, dirO, K, -Infinity, turnX => arr(a) + Math.max(waitLimit(X, turnX, arr(a), a), turnX && lineEnd(X) ? MAX_LAYOVER : 0), () => true);
      if (!out) { if (DEBUG) dutyDebug.push(`home-via ${STATIONS[X].id} ${fmt(arr(a))} out →${STATIONS[K].id} failed`); continue; }
      const first = asTrip(dirO, X, K, out.stops), reach = out.stops.at(-1)!.arr;
      const before = DEBUG && trace ? new Map(trace) : undefined;
      const back = fitAfter(dirE, K, en, reach + minTurn(K), reach + waitLimit(K, true, reach), undefined,
        stops => T('peakHome', stops.at(-1)!.arr >= homeFrom()) && T('outer', outerQuiet(stops)) && T('safeK', safe(first, asTrip(dirE, K, en, stops)))
          && T('placeK', reserve(K, reach, stops[0].dep, false)) && T('frontK', frontTurnClear(ctx, live(), first, stops[0].dep, new Set()))
          && entryFits(depot, dirE, en, stops));
      if (!back) { if (DEBUG) dutyDebug.push(`home-via ${STATIONS[X].id} ${fmt(arr(a))} back ${STATIONS[K].id}@${fmt(reach)}→${STATIONS[en].id} failed ${before ? [...trace!].filter(([k, n]) => n !== (before.get(k) ?? 0)).map(([k, n]) => k + '=' + (n - (before.get(k) ?? 0))).join(' ') : ''}`); continue; }
      if (dry) return true;
      if (a.dir !== dirO) reserve(X, arr(a), out.stops[0].dep);
      reserve(K, reach, back.stops[0].dep);
      const t1 = addMove(dirO, X, K, out.stops, out.revenue), t2 = addMove(dirE, K, en, back.stops, back.revenue);
      t1.kind = out.revenue ? 'wd' : 'empty'; t2.kind = back.revenue ? 'wd' : 'empty';
      link(a, t1); link(t1, t2);
      enterYard(depot, t2);
      return true;
    }
    return false;
  };

  /** car `car` takes departure `want`: turning or running on at its own
   * station, else by a positioning run; links them (D184, added services) */
  const join = (car: Car, want: Want): boolean => {
    if (car.station !== want.station) return !!position(car, want);
    const a = car.trip, d = want.trip, X = car.station, turn = a.dir !== d.dir, wait = dep(d) - arr(a);
    if (wait < (turn ? minTurn(X) : throughMin(X, a.dir, arr(a))) - 1e-6 || wait > waitLimit(X, turn, arr(a), a) || !safe(a, d)) return false;
    if (turn && (!turnbackAt(topo, X, a.dir) || !frontTurnClear(ctx, live(), a, dep(d), new Set([a.id, d.id])) || !reserve(X, arr(a), dep(d)))) return false;
    link(a, d);
    return true;
  };

  /** The base plan's own use of the places and yards (added services, D184):
   * its terminal stands, depot leads and yard events; with `live`, the yard
   * stock now and the events still to come. */
  const seeded = new Map<number, { exit?: (typeof exits)[number]; out?: (typeof outbound)[number]; entry?: (typeof inbound)[number] }>();
  const seedBase = (plan: Plan, live?: { at: number; levels: number[]; departed: number[]; done: number[] }) => {
    for (const [st, list] of terminalOccupancy(plan)) places.set(st, [...(places.get(st) ?? []), ...list.map(o => ({ from: o.from, to: o.to + clearAfter(st), dep: o.to }))]);
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
        const last = ts.at(-1)!, [from, to] = inboundWindow(topo, m.depot, last);
        own.entry = { depot: m.depot, dir: last.dir, from, to, at: m.time, st: last.to, arr: last.stops.at(-1)!.arr }; addInbound(own.entry);
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
    feed, distanceTo, idleYard, dropHeld, releasable, homeBy, join, seedBase, unseed, clearAfter, leadMoves, stationedStandby,
    get redirecting() { return redirecting; }, set redirecting(v: typeof redirecting) { redirecting = v; },
    get viaCore() { return viaCore; }, set viaCore(v: boolean) { viaCore = v; },
    get early() { return early; }, set early(v: boolean) { early = v; },
    get idleHome() { return idleHome; }, set idleHome(v: boolean) { idleHome = v; },
    get dry() { return dry; }, set dry(v: boolean) { dry = v; },
  };
}
