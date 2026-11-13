/**
 * Day duty planner (车底运用, D178). One rule for the whole day:
 *
 * 1. Each station where trips start or end keeps a pool of cars (pool.ts).
 *    A departure takes the most recently ready car that can physically turn
 *    or run on into it; the line ends then dispatch in arrival order.
 * 2. A departure left without a car is supplied, in this order: a car spare
 *    at another station positioned to it, a yard (depot or line storage)
 *    exit fitted between the other trains.
 * 3. A car left spare returns to a yard. Every yard gets back exactly as many
 *    cars as it sent out (line storage at night, after its rule's clock).
 *
 * Published service trips keep their routes and clocks: a duty never cuts
 * them short (【假设】D178: outer legs keep the requested service; a move
 * after opening carries passengers, never runs empty past an open station).
 * Physical admission reuses the existing plan rules (turnback tracks, terminal
 * capacity, single-track order, front-turn conflicts, depot lead windows),
 * which validatePlan checks again on the finished plan.
 */
import type { Block, PlanStop, TrackDir } from '../model';
import type { PlanIssue, PlanContext, Period, GenTrip } from '../timetable';
import {
  officialIntervalAt, officialPeriodAt, connectionSafe, depotIndex, depotStartTime, entryStation, frontTurnClear, hotStandbyPlaces,
  minTurn, overnightPlaces, standbyWindows, turnbackAt, MAX_LAYOVER, THROUGH_WAIT, MIN_HEADWAY, CORE_W, CORE_E, MAX_DIAGRAM_SHIFT_S, stationIndex,
  TEMPLATES, periodAt, DEPOT_ENTRY_CLEAR, inboundWindow, outboundWindow, noDepotReturnBefore,
} from '../timetable';
import { OPERATIONS, STATIONS } from '../../data/current';
import { ahead } from '../topology';
import { matchPool } from './pool';
import { createMoves, THROUGH_MIN, DEBUG, dutyDebug, setTrace, getTrace, T, fmt, type Car, type Want, type Yard, type LeadBooking } from './moves';

export { dutyDebug };

/** Inputs prepared by buildPlan: service drafts and the links drafted for
 * fixed late runs and intermediate standbys. */
export interface DutyInput {
  /** departures as requested, before any spacing (the shift budget's base) */
  requestedDeps?: readonly number[];
  ctx: PlanContext;
  trips: GenTrip[];
  periods: Period[];
  /** published first/last service: never retimed or rerouted */
  locked: ReadonlySet<number>;
  /** departures whose car comes from a yard by a draft (fixed / standby) */
  reservedStarts: ReadonlyMap<number, number>;
  /** arrivals whose car goes to a yard / a stable berth by a draft */
  fixedEnds: ReadonlyMap<number, number>;
  standbyEnds: ReadonlyMap<number, number>;
  /** departures a request already starts from a line storage berth */
  stableStarts: ReadonlyMap<number, number>;
  /** arrivals a previous pass left without a home: they go home before exits are fitted */
  homeFirst?: ReadonlySet<number>;
  /** match the evening cars to the cars each yard is owed (a further pass
   * when the balanced order left a yard's count open) */
  matchHomes?: boolean;
  /** probe (yard rebalancing): a departure no yard can supply for want of a car
   * borrows one at the nearest depot that then can; the plan is not used, only
   * its ledger (`lent`, `spare`) */
  borrow?: boolean;
  /** yard rebalancing: cars a depot short of cars must receive before these
   * times, by an off-peak car redirected from a depot that never used all its
   * own (`donors`: per depot, how many it can give) */
  deliver?: readonly { depot: number; before: number }[];
  donors?: readonly number[];
  /** yard rebalancing: the probe pass's moves over shared-lead stations (`leads`, `carOf` the car each return brings) */
  reference?: readonly (LeadBooking & { car?: number })[];
}

/** cars each depot sent out and took back; `lent`: cars a probe borrowed
 * (depot, departure time); `spare`: per depot, the cars it never used all day */
export interface DutyLedger { exits: number[]; returns: number[]; homeless: number[]; lent: { depot: number; at: number }[]; spare: number[]; leads: (LeadBooking & { car?: number })[] }

/** a spare car positioned to another station's departure has left at most this before (s) */
const POSITION_SPAN = 2 * 3600;


export function planDuties(input: DutyInput): { blocks: Block[]; issues: PlanIssue[]; ledger: DutyLedger } {
  const { ctx, trips, periods, locked } = input;
  /** the car a return brings in: the trip it arrived on, before the moves added to take it in */
  const firstAdded = trips.length;
  const carOf = (id: number) => { let t = trips[id]; while (t.id >= firstAdded && t.prev !== undefined) t = trips[t.prev]; return t.id; };
  const { topo } = ctx;
  const issues: PlanIssue[] = [];
  const mv = createMoves(ctx, trips, periods);
  const { lineEnd, arr, dep, live, services, leavingFrom, throughMin, waitLimit, index, slot, lastService, POSITIONING, startOf, endOf, link,
    standbyPlaces, reserve, yards, safe, exits, inbound, outbound, addExit, addInbound, position, feed, distanceTo, dropHeld, releasable, homeBy } = mv;
  /** the requested runs, before any duty joins or leaves one partway */
  const requestedEnd = new Map(services.map(t => [t.id, { to: t.to, at: arr(t) }]));
  // 【假设】D178: past the last service of its direction a move boards nobody,
  // the drafted ones (fixed-run supply) as much as the ones fitted below
  for (const t of services) if (POSITIONING.has(t.kind) && !t.cancelled) {
    for (const p of t.stops.slice(0, -1)) if (p.dep > (lastService[slot(p.st, t.dir)] ?? Infinity) + 1e-6) p.noBoard = true;
    if (t.revenue && !t.stops.slice(0, -1).some(p => p.stop && !p.noBoard)) t.revenue = false;
  }
  for (const [id, depot] of input.reservedStarts) startOf.set(id, { kind: 'depot', depot, time: 0 });
  for (const [id, depot] of input.fixedEnds) endOf.set(id, { kind: 'depot', depot });
  for (const [id, berth] of input.standbyEnds) endOf.set(id, { kind: 'stable', station: topo.berths[berth].station, berth });
  for (const [id, berth] of input.stableStarts) startOf.set(id, { kind: 'stable', station: topo.berths[berth].station, berth });



  // ---- 1. the pools
  const isFree = (t: GenTrip) => !t.cancelled;
  const stations = [...new Set(services.filter(isFree).flatMap(t => [t.from, t.to]))];
  const spare: Car[] = [];
  const unmet: Want[] = [];
  const nights = overnightPlaces(topo).filter(p => p.kind === 'terminal');
  for (const T of stations) {
    const arrivals = services.filter(t => isFree(t) && t.to === T && t.next === undefined && !endOf.has(t.id));
    const departures = services.filter(t => isFree(t) && t.from === T && t.prev === undefined && !startOf.has(t.id))
      .sort((a, b) => dep(a) - dep(b));
    // overnight cars at a line end: the earliest departures in the morning,
    // the last arrivals at night (D72); their places are free in between
    const night = nights.filter(p => p.station === T);
    for (const place of night) {
      const first = departures.shift();
      if (first) startOf.set(first.id, { kind: 'stable', station: T, berth: place.berth });
    }
    const lastDeparture = Math.max(-Infinity, ...services.filter(t => isFree(t) && t.from === T).map(dep));
    arrivals.sort((a, b) => arr(a) - arr(b));
    const nightCars = night.length ? arrivals.filter(a => arr(a) >= lastDeparture - 60).slice(-night.length) : [];
    nightCars.forEach((a, k) => endOf.set(a.id, { kind: 'stable', station: T, berth: night[night.length - 1 - k].arrivalBerth }));
    const cars: Car[] = arrivals.filter(a => !nightCars.includes(a)).map(a => ({ id: a.id, ready: arr(a) + THROUGH_MIN, trip: a, station: T }));
    const wants: Want[] = departures.map(d => ({ id: d.id, at: dep(d), trip: d, station: T }));
    hotStandby(T, cars, wants);
    const turnAllowed = (a: GenTrip, d: GenTrip) => {
      const wait = dep(d) - arr(a);
      if (a.dir === d.dir) return wait >= throughMin(T, a.dir, arr(a)) - 1e-6 && wait <= THROUGH_WAIT && safe(a, d);
      return !!turnbackAt(topo, T, a.dir) && wait >= minTurn(T) - 1e-6 && safe(a, d)
        && frontTurnClear(ctx, live(), a, dep(d), new Set([a.id, d.id]));
    };
    // published arrivals turn first, into the first departure they can make
    for (const car of cars.filter(c => locked.has(c.id))) {
      const want = wants.find(w => turnAllowed(car.trip, w.trip) && w.at - arr(car.trip) <= MAX_LAYOVER && (car.trip.dir === w.trip.dir || reserve(T, arr(car.trip), w.at)));
      if (!want) continue;
      link(car.trip, want.trip);
      cars.splice(cars.indexOf(car), 1); wants.splice(wants.indexOf(want), 1);
    }
    const result = matchPool(cars, wants, {
      order: 'latest',
      maxWait: (car, want) => car.trip.dir === want.trip.dir ? THROUGH_WAIT
        : waitLimit(T, true, arr(car.trip)),
      admit: (car, want) => turnAllowed(car.trip, want.trip) && (car.trip.dir === want.trip.dir || reserve(T, arr(car.trip), want.at)),
    });
    for (const [id, car] of result.pairs) link(car.trip, trips[id]);
    // D173: at a line end a car a few seconds short of the turn takes the
    // departure moved later within MAX_DIAGRAM_SHIFT_S (of its requested
    // time); a yard car instead would leave this one standing, and every
    // turn after it queueing. The departure keeps its order on the platform,
    // its path, and the turn or return at its other end.
    if (lineEnd(T)) for (const want of result.unmet.slice()) {
      const d = want.trip, turn = minTurn(T);
      if (locked.has(d.id)) continue;
      const late = result.spare.filter(c => c.trip.dir !== d.dir && arr(c.trip) + turn > dep(d) && arr(c.trip) + turn <= dep(d) + MAX_DIAGRAM_SHIFT_S)
        .sort((x, y) => arr(x.trip) - arr(y.trip))[0];
      if (!late) continue;
      const by = arr(late.trip) + turn - dep(d);
      if (Math.abs(dep(d) + by - (input.requestedDeps?.[d.id] ?? dep(d))) > MAX_DIAGRAM_SHIFT_S) continue;
      if ((leavingFrom.get(T) ?? []).some(t => t > dep(d) + 1e-6 && t <= dep(d) + by)) continue;
      const before = d.stops, shifted = before.map(p => ({ ...p, arr: p.arr + by, dep: p.dep + by }));
      if (!index.clear(shifted, d.dir, MIN_HEADWAY, before)) continue;
      const after = d.next !== undefined ? trips[d.next] : undefined;
      if (after && dep(after) < arr(d) + by + (after.dir === d.dir ? THROUGH_MIN : minTurn(d.to))) continue;
      d.stops = shifted;
      if (!turnAllowed(late.trip, d) || !reserve(T, arr(late.trip), dep(d))) { d.stops = before; continue; }
      index.remove({ dir: d.dir, stops: before }); index.add(d);
      const list = leavingFrom.get(T)!;
      list[list.indexOf(before[0].dep)] = dep(d);
      link(late.trip, d);
      result.spare.splice(result.spare.indexOf(late), 1);
      result.unmet.splice(result.unmet.indexOf(want), 1);
    }
    if (DEBUG) {
      const why = (a: GenTrip, d: GenTrip) => {
        const wait = dep(d) - arr(a);
        if (a.dir === d.dir) return wait <= THROUGH_WAIT ? 'ok' : 'through-wait';
        if (!turnbackAt(topo, T, a.dir)) return 'no-turnback';
        if (wait < minTurn(T) - 1e-6) return 'short';
        if (!connectionSafe(topo, ctx.dayType, a, d)) return 'unsafe';
        if (!frontTurnClear(ctx, live(), a, dep(d), new Set([a.id, d.id]))) return 'front';
        if (!reserve(T, arr(a), dep(d), false)) return 'reserve';
        return 'ok';
      };
      dutyDebug.push(`${STATIONS[T].id} arr ${arrivals.length} dep ${departures.length} pairs ${result.pairs.size} spare ${result.spare.length} unmet ${result.unmet.length}`);
      const tally = new Map<string, number>();
      for (const w of result.unmet) {
        const near = result.spare.filter(c => arr(c.trip) < w.at && arr(c.trip) > w.at - 1800);
        for (const c of near) { const k = why(c.trip, w.trip); tally.set(k, (tally.get(k) ?? 0) + 1); }
        if (near.length && (lineEnd(T) || w.at > 7 * 3600 && w.at < 10 * 3600)) dutyDebug.push(`  unmet ${fmt(w.at)} ${w.trip.dir} near: ${near.map(c => fmt(arr(c.trip)) + c.trip.dir + ':' + why(c.trip, w.trip)).join(' ')}`);
      }
      dutyDebug.push(`  why ${[...tally].map(([k, n]) => k + '=' + n).join(' ')}`);
    }
    spare.push(...result.spare);
    unmet.push(...result.unmet);
    // A line end dispatches from one departure platform: the turning cars
    // leave in the order they arrived (only who turns was chosen above).
    if (lineEnd(T)) {
      const turns = arrivals.filter(a => a.next !== undefined && trips[a.next].dir !== a.dir && !a.standby);
      const outs = turns.map(a => trips[a.next!]).sort((x, y) => dep(x) - dep(y));
      turns.forEach((a, k) => link(a, outs[k]));
    }
  }

  /** Hot standby (D70, D148): in each window the line end keeps one car its
   * departures can spare aside, from `from`; from `need` it takes the first
   * departure the other cars leave uncovered. */
  function hotStandby(T: number, cars: Car[], wants: Want[]) {
    const place = hotStandbyPlaces(topo).find(p => p.station === T && !p.depot);
    if (!place) return;
    const turn = minTurn(T);
    const uncovered = (t: number, until: number, without?: Car) => {
      const pool = cars.filter(c => c !== without && arr(c.trip) >= t - 2 * MAX_LAYOVER && arr(c.trip) <= until).map(c => arr(c.trip));
      const missing: Want[] = [];
      for (const w of wants) {
        if (w.at < t - MAX_LAYOVER || w.at > until) continue;
        let best = -1;
        for (let i = 0; i < pool.length; i++) if (pool[i] + turn <= w.at && pool[i] >= w.at - MAX_LAYOVER) best = i;
        if (best >= 0) pool.splice(best, 1); else missing.push(w);
      }
      return missing;
    };
    const unmetIn = (t: number, without?: Car) => uncovered(t, t + 3600, without).length;
    for (const window of standbyWindows(ctx.dayType, place)) {
      const eligible = (c: Car) => arr(c.trip) >= window.from && arr(c.trip) < Math.min(window.need, window.to - 240);
      const incoming = cars.find(c => eligible(c) && arr(c.trip) < window.from + 3600 && unmetIn(arr(c.trip), c) <= unmetIn(arr(c.trip)))
        ?? cars.find(c => eligible(c) && arr(c.trip) >= window.from + 3600) ?? cars.find(eligible);
      if (!incoming) continue;
      const from = Math.max(window.need, arr(incoming.trip) + turn);
      const outgoing = uncovered(from, window.to, incoming).find(w => w.at >= from)
        ?? wants.find(w => w.at >= Math.max(window.to, arr(incoming.trip) + turn));
      if (!outgoing || !reserve(T, arr(incoming.trip), outgoing.at)) continue;
      incoming.trip.standby = true;
      standbyPlaces.set(T, [...(standbyPlaces.get(T) ?? []), { from: arr(incoming.trip), to: outgoing.at }]);
      link(incoming.trip, outgoing.trip);
      cars.splice(cars.indexOf(incoming), 1); wants.splice(wants.indexOf(outgoing), 1);
    }
  }

  // Drafted yard moves (fixed late runs, standby supply) are in the ledger
  // and hold their leads from the start.
  for (const [id, depot] of input.reservedStarts) {
    const first = trips[id];
    addExit({ yard: depot, at: depotStartTime(ctx, depot, first) });
    const [from, to] = outboundWindow(ctx, depot, first);
    outbound.push({ depot, dir: first.dir, from, to });
  }
  for (const [id, depot] of input.fixedEnds) {
    const [from, to] = inboundWindow(topo, depot, trips[id]);
    addInbound({ depot, dir: trips[id].dir, from, to, at: arr(trips[id]) + DEPOT_ENTRY_CLEAR, st: trips[id].to, arr: arr(trips[id]), trip: id });
  }
  // A spare car standing at a yard's entry in its own direction goes in
  // there unless it is used elsewhere: hold its entry before exits are fitted.
  for (const car of spare) {
    const depot = topo.depots.findIndex((_, d) => entryStation(topo, d, car.trip.dir) === car.station);
    if (depot < 0) continue;
    const [from, to] = inboundWindow(topo, depot, car.trip);
    addInbound({ depot, dir: car.trip.dir, from, to, at: arr(car.trip) + DEPOT_ENTRY_CLEAR, st: car.trip.to, arr: arr(car.trip), trip: car.trip.id, car: car.trip.id });
  }

  // ---- 2. supply each departure left without a car
  const homeless: number[] = [];
  // ---- outer legs: a service is laid out end to end, but only its core is
  // fixed; a car may join after the outer leg or leave before it (the old
  // former terminal-service allocator's rule). Last resort, published trips never.
  /** a trip may be cut at `st` only on an outer leg: at its start before the
   * core, at its end past the core (never dropping a core call) */
  const outerCut = (dir: TrackDir, st: number, atStart: boolean) => {
    const end = (atStart === (dir === 'DN')) ? CORE_W : CORE_E;
    return st === end || (atStart ? ahead(dir, st, end) : ahead(dir, end, st));
  };
  /** car `a` may take `d` at `st`: turning or running on, held within the limits */
  const connectAt = (a: GenTrip, d: GenTrip, st: number) => {
    const turn = a.dir !== d.dir, wait = dep(d) - arr(a);
    return wait >= (turn ? minTurn(st) : throughMin(st, a.dir, arr(a))) - 1e-6 && wait <= waitLimit(st, turn, arr(a)) && safe(a, d)
      && (!turn || !!turnbackAt(topo, st, a.dir) && frontTurnClear(ctx, live(), a, dep(d), new Set([a.id, d.id])) && reserve(st, arr(a), dep(d)));
  };
  const trimStart = (want: Want): boolean => {
    const d = want.trip;
    if (locked.has(d.id)) return false;
    const from = d.from, stops = d.stops;
    for (let i = 1; i < stops.length - 1; i++) {
      const k = stops[i].st;
      if (!outerCut(d.dir, k, true)) break;
      d.from = k;
      d.stops = stops.slice(i).map(p => ({ ...p }));
      d.stops[0].arr = d.stops[0].dep;
      const car = spare.find(c => c.station === k && c.trip.next === undefined && !endOf.has(c.trip.id) && releasable(c.trip.id) && connectAt(c.trip, d, k));
      if (car) { link(car.trip, d); spare.splice(spare.indexOf(car), 1); dropHeld(car.trip.id); reindex(d, stops); return true; }
      const w: Want = { ...want, station: k, at: dep(d) };
      if (yards.slice().sort((a, b) => distanceTo(a, k) - distanceTo(b, k)).some(y => feed(y, w))) { reindex(d, stops); return true; }
    }
    d.from = from; d.stops = stops;
    return false;
  };
  /** a run cut short at a new end (its dwell there dropped) keeps the
   * headway to the trains passing that stop; `was`: its stops before */
  /** a run cut short keeps its place in the headway index as it now runs */
  const reindex = (t: GenTrip, was: PlanStop[]) => { index.remove({ dir: t.dir, stops: was }); index.add(t); };
  const endClear = (a: GenTrip, was: PlanStop[]) => index.clear([a.stops.at(-1)!], a.dir, MIN_HEADWAY, was);
  const trimEnd = (car: Car, only?: Yard): boolean => {
    const a = car.trip;
    if (!T('locked', !locked.has(a.id)) || !T('held', releasable(a.id))) return false;
    const to = a.to, stops = a.stops;
    if (!mv.dry) dropHeld(a.id);
    for (let i = stops.length - 2; i > 0; i--) {
      const k = stops[i].st;
      if (!outerCut(a.dir, k, false)) break;
      a.to = k;
      a.stops = stops.slice(0, i + 1).map(p => ({ ...p }));
      a.stops.at(-1)!.dep = a.stops.at(-1)!.arr;
      if (!T('end-headway', endClear(a, stops))) continue;
      const c: Car = { ...car, station: k, ready: arr(a) + THROUGH_MIN };
      // a yard still owed cars first (each yard ends the day at its own count), then the nearest
      const yard = (only ? [only] : yards.filter(y => y.depot >= 0).sort((x, y) => Number(due(y) > 0) - Number(due(x) > 0) || distanceTo(x, k) - distanceTo(y, k)))
        .find(y => homeBy(c, y));
      if (yard && mv.dry) { a.to = to; a.stops = stops; return true; }
      if (yard) { returned.set(yard.id, (returned.get(yard.id) ?? 0) + 1); reindex(a, stops); return true; }
    }
    a.to = to; a.stops = stops;
    return false;
  };

  // Direct returns (OPERATIONS.depotReturns): a car with no further work
  // clears and enters at the yard's entry on its way, unless dropping the rest
  // of its run would open a gap at the end the rules protect.
  const endStream = (dir: TrackDir, end: number) => services.filter(t => t.revenue && t.dir === dir && requestedEnd.get(t.id)!.to === end)
    .map(t => ({ t, at: requestedEnd.get(t.id)!.at })).sort((a, b) => a.at - b.at);
  const gapWithout = (a: GenTrip, end: number) => {
    const stream = endStream(a.dir, end), at = requestedEnd.get(a.id)!.at;
    const current = stream.filter(c => c.t !== a && c.t.to === end);
    const before = current.filter(c => c.at < at).at(-1), after = current.find(c => c.at > at);
    return before && after ? { gap: after.at - before.at, span: stream.filter(c => c.at >= before.at && c.at <= after.at) } : undefined;
  };
  const serviceRules = OPERATIONS.depotReturns.filter(r => r.service).map(r => ({ terminal: stationIndex(r.service!.terminal), multiplier: r.service!.intervalMultiplier }));
  const keepsThrough = (a: GenTrip) => {
    const end = requestedEnd.get(a.id)!.to;
    for (const rule of serviceRules) if (rule.terminal === end) {
      const g = gapWithout(a, end);
      if (g && g.gap > Math.max(...g.span.slice(1).map((c, i) => c.at - g.span[i].at)) * rule.multiplier + 1e-3) return true;
    }
    // the outer stream of a peak pattern keeps its widest planned gap
    if (!lineEnd(end)) return false;
    const coreCall = a.stops.find(p => p.st === (a.dir === 'DN' ? CORE_E : CORE_W));
    if (!coreCall) return false;
    const period = periodAt(periods, coreCall.dep), template = TEMPLATES[period.template];
    if (!template.peak) return false;
    const full = template.pattern.flatMap((kind, i) => kind === 'big' ? [i] : []);
    if (!full.length) return false;
    const longest = Math.max(...full.map((i, n) => ((full[(n + 1) % full.length] - i + template.pattern.length - 1) % template.pattern.length) + 1));
    const headway = period.headway ?? template.directionalHeadway?.[a.dir] ?? template.headway;
    const g = gapWithout(a, end);
    return !!g && g.gap > headway * longest + MAX_DIAGRAM_SHIFT_S;
  };
  /** D178: a declared return station cuts a trip inside the core only while
   * the far core end (GLL / SHR) keeps the published interval without it, and
   * only outside the published timed periods (user 2026-11-05: the core
   * interval holds; peaks and 平峰 keep every train, the late evening returns
   * at 龙阳路 as Gaode shows). */
  const coreMayDrop = (a: GenTrip, k: number) => {
    const end = a.dir === 'DN' ? CORE_E : CORE_W;
    const call = a.stops.find(p => p.st === end);
    if (!call || !ahead(a.dir, k, end)) return true;
    // only outside the published timed periods (peaks, 平峰): those keep every train
    if (officialPeriodAt(ctx.dayType, call.arr)?.from) return false;
    const limit = officialIntervalAt(ctx.dayType, end, call.arr);
    if (limit === undefined) return false;
    const calls = services.filter(t => t !== a && !t.cancelled && t.revenue && t.dir === a.dir)
      .map(t => t.stops.find(p => p.st === end && !p.noBoard)?.arr).filter((x): x is number => x !== undefined);
    const before = Math.max(...calls.filter(x => x < call.arr)), after = Math.min(...calls.filter(x => x > call.arr));
    return Number.isFinite(before) && Number.isFinite(after) && after - before <= limit + 1e-3;
  };
  const directReturn = (car: Car, yard: Yard): boolean => {
    if (yard.depot < 0) return false;
    const a = car.trip, k = entryStation(topo, yard.depot, a.dir);
    if (k === car.station) return home(car, yard);
    if (locked.has(a.id) || !releasable(a.id)) return false;
    const i = a.stops.findIndex(p => p.st === k);
    // a yard's declared return station is a boundary of its own (depotReturns)
    const declared = OPERATIONS.depotReturns.some(r => r.dir === a.dir && stationIndex(r.station) === k && depotIndex(topo, r.depot) === yard.depot);
    if (i <= 0 || i >= a.stops.length - 1 || !(outerCut(a.dir, k, false) || declared && coreMayDrop(a, k)) || keepsThrough(a)) return false;
    const to = a.to, stops = a.stops;
    a.to = k;
    a.stops = stops.slice(0, i + 1).map(p => ({ ...p }));
    a.stops.at(-1)!.dep = a.stops.at(-1)!.arr;
    if (!T('end-headway', endClear(a, stops))) { a.to = to; a.stops = stops; return false; }
    if (!mv.dry) dropHeld(a.id);
    const ok = homeBy({ ...car, station: k, ready: arr(a) + THROUGH_MIN }, yard);
    // D189: the headway index keeps the run as it now ends (it held the dropped calls)
    if (ok && !mv.dry) { reindex(a, stops); return true; }
    a.to = to; a.stops = stops;
    return ok;
  };

  const returned = new Map<number, number>();
  const home = (car: Car, yard: Yard): boolean => {
    const a = car.trip;
    const held = inbound.findIndex(m => m.car === a.id);
    if (held >= 0 && inbound[held].depot === yard.depot && (due(yard) > 0 || !releasable(a.id))) {
      if (mv.dry) return true;
      delete inbound[held].car;
      endOf.set(a.id, { kind: 'depot', depot: yard.depot });
      return true;
    }
    if (!T('held', releasable(a.id))) return false;
    // every exit is fitted by now: the held window protects nothing more
    if (!mv.dry) dropHeld(a.id);
    return homeBy(car, yard);
  };
  const due = (yard: Yard) => yard.sent - (returned.get(yard.id) ?? 0);
  mv.early = true;
  for (const car of spare.filter(c => input.homeFirst?.has(c.trip.id))) {
    const yard = yards.filter(y => y.depot >= 0).sort((a, b) => distanceTo(a, car.station) - distanceTo(b, car.station)).find(y => home(car, y));
    if (yard) returned.set(yard.id, (returned.get(yard.id) ?? 0) + 1);
    if (yard || trimEnd(car)) spare.splice(spare.indexOf(car), 1);
  }
  mv.early = false;
  // A car no later departure can take any more goes home as the day goes
  // on, so the yards' stock knows of it when the evening exits are fitted.
  // (A line storage place's night cars come from after its clock.)
  const storageClock = Math.min(...yards.filter(y => y.depot < 0 && y.after !== undefined).map(y => y.after!));
  const retire = (car: Car, order: Yard[], first?: Yard): Yard | undefined => {
    let yard: Yard | undefined;
    // the yard the car is matched to, by any way home (trimEnd counts its own return)
    if (first) for (const across of [false, true]) {
      mv.viaCore = across;
      if (directReturn(car, first) || home(car, first)) yard = first;
      else if (trimEnd(car, first)) { mv.viaCore = true; return first; }
      if (yard) { mv.viaCore = true; returned.set(yard.id, (returned.get(yard.id) ?? 0) + 1); return yard; }
    }
    for (const across of [false, true]) {
      mv.viaCore = across;
      yard = order.find(y => directReturn(car, y)) ?? order.find(y => home(car, y));
      if (yard) break;
    }
    mv.viaCore = true;
    if (yard) returned.set(yard.id, (returned.get(yard.id) ?? 0) + 1);
    return yard;
  };
  const fixedIn = topo.depots.map((_, d) => [...input.fixedEnds.values()].filter(x => x === d).length);
  // Yard rebalancing (用户决定 2026-11-13): a depot whose morning stock falls
  // short of the day's departures from it receives, before it needs it, a car
  // that retires off-peak after OPERATIONS.noDepotReturnBefore and would have
  // gone home to a depot that never used all its own cars. The car runs there
  // in service (homeBy's carrying move). Which depots are short or spare comes
  // from the probe pass (input.deliver / donors); normal stock never asks.
  const noReturnBefore = noDepotReturnBefore();
  const deliveries = (input.deliver ?? []).map(d => ({ ...d, done: false }));
  const givable = (input.donors ?? []).slice();
  const redirect = (car: Car, nearest: Yard): Yard | undefined => {
    const at = arr(car.trip);
    if (at < noReturnBefore || TEMPLATES[periodAt(periods, at).template].peak || !(givable[nearest.depot] > 0)) return undefined;
    for (const d of deliveries) {
      if (d.done || d.depot === nearest.depot || at > d.before - POSITION_SPAN) continue;
      const target = yards.find(y => y.depot === d.depot)!;
      // it may not take the leads the plain plan's moves use, but for its own return there
      mv.redirecting = { moves: input.reference ?? [], own: b => (b as { car?: number }).car === car.trip.id };
      const went = retire(car, [target]);
      mv.redirecting = undefined;
      if (!went) continue;
      d.done = true; givable[nearest.depot]--;
      if (DEBUG) dutyDebug.push(`rebalance ${fmt(at)} ${STATIONS[car.station].id} ${car.trip.dir} → ${went.name} (instead of ${nearest.name}) for ${fmt(d.before)}`);
      return went;
    }
    return undefined;
  };
  const lent: DutyLedger['lent'] = [];
  for (const want of unmet.sort((a, b) => a.at - b.at)) {
    for (const car of spare.filter(c => c.trip.next === undefined && !endOf.has(c.trip.id)
      && arr(c.trip) < Math.min(want.at - POSITION_SPAN, storageClock - 60))) {
      const order = yards.filter(y => y.depot >= 0).sort((a, b) => distanceTo(a, car.station) - distanceTo(b, car.station));
      if (DEBUG) setTrace(new Map());
      const went = (deliveries.length ? redirect(car, order[0]) : undefined) ?? retire(car, order);
      if (DEBUG) dutyDebug.push(`retire ${fmt(arr(car.trip))} ${STATIONS[car.station].id} ${car.trip.dir} → ${went?.name ?? '-'}: ${[...getTrace()!].map(([k, n]) => k + '=' + n).join(' ')}`);
      setTrace(null);
      if (went) spare.splice(spare.indexOf(car), 1);
    }
    // a spare car elsewhere, the one standing least long first
    const candidates = spare.filter(c => c.station !== want.station && c.trip.next === undefined
      && arr(c.trip) < want.at && arr(c.trip) >= want.at - POSITION_SPAN).sort((a, b) => arr(b.trip) - arr(a.trip));
    let done = false;
    if (DEBUG) setTrace(new Map());
    // a storage place's overnight car must leave in the morning: it goes first
    const stored = (y: Yard) => y.depot < 0 && y.stock - exits.filter(x => x.yard === y.id).length > 0;
    // a yard the drafted returns (fixed runs) would overfill sends its cars out first
    const overfull = (y: Yard) => y.depot >= 0 && fixedIn[y.depot] - exits.filter(x => x.yard === y.id).length > topo.depots[y.depot].capacity - y.stock;
    const order = yards.slice().sort((a, b) => Number(stored(b)) - Number(stored(a)) || Number(overfull(b)) - Number(overfull(a))
      || distanceTo(a, want.station) - distanceTo(b, want.station));
    // First without running an extra train through the core (the requested
    // core stream stays as laid out), joining after the outer leg if need be;
    // only then a move across the core.
    // ... and may run through the core for it, before any other yard
    for (const yard of order.filter(overfull)) { mv.viaCore = true; if (feed(yard, want)) { done = true; break; } }
    for (const across of [false, true]) {
      if (done) break;
      mv.viaCore = across;
      for (const car of candidates) if (position(car, want)) { spare.splice(spare.indexOf(car), 1); done = true; break; }
      if (!done) for (const yard of order) if (feed(yard, want)) { done = true; break; }
      // 用户决定（2026-11-08）：a line end's origin (浦东机场) is not cut back to spare a car
      // running there through the core: 北翟路 cars run east in service and turn there
      if (!done && !across && !lineEnd(want.station)) done = trimStart(want);
      if (done) break;
    }
    if (!done && lineEnd(want.station)) { mv.viaCore = false; done = trimStart(want); }
    mv.viaCore = true;
    // probe: would one more car at a depot supply it? (the nearest such depot is short)
    if (!done && input.borrow) {
      const byDistance = yards.filter(y => y.depot >= 0).sort((a, b) => distanceTo(a, want.station) - distanceTo(b, want.station));
      for (const yard of byDistance) {
        yard.stock++;
        if (feed(yard, want)) { lent.push({ depot: yard.depot, at: want.at }); done = true; break; }
        yard.stock--;
      }
      // still without a car while the nearest depot has none left to draw from then on: that
      // depot is a car short all the same (an earlier departure took the car or the slot it
      // would run in); the car stays this departure's, not one more for later ones
      const nearest = byDistance[0];
      if (!done && nearest && !mv.canDraw(nearest, want.at)) lent.push({ depot: nearest.depot, at: want.at });
    }
    if (DEBUG && !done) dutyDebug.push(`feed-fail ${STATIONS[want.station].id} ${want.trip.dir} ${fmt(want.at)} cands ${candidates.length}: ${[...getTrace()!].map(([k, n]) => k + '=' + n).join(' ')}`);
    setTrace(null);
    if (!done) issues.push({ severity: 'error', code: 'UNASSIGNED', t: want.at,
      text: `${STATIONS[want.station].name} ${want.trip.dir} ${fmt(want.at)} 发车无车可供（无剩余车、车场出车均排不进）` });
  }
  for (const yard of yards) if (yard.depot >= 0) yard.sent = exits.filter(x => x.yard === yard.id).length;
    else if (yard.stock) yard.sent = exits.filter(x => x.yard === yard.id).length;

  // ---- 3. every spare car returns to a yard, each yard to its own count
  // 用户决定（2026-11-10/11-11）：10:00 前（OPERATIONS.noDepotReturnBefore）不回库。早高峰多出来、全天
  // 再没有活的车就近顺向进库，不为车场配额改去别的车场；配额由之后和夜间的回库去平。
  // 【假设】先不截短（定位走行回库），走不了才在最近车场的入口截短顺向进库（东头多余车在远东大道进川沙）：
  // 一律不截短时这些车既回不了库也停不下（尾轨满），见 work/review/stage1-report.md 第二批。
  const idleNearest = (car: Car): Yard | undefined => {
    const yard = mv.idleYard(car);
    if (!yard) return undefined;
    let ok = false;
    mv.idleHome = true;
    for (const across of [false, true]) { mv.viaCore = across; if (home(car, yard) || directReturn(car, yard)) { ok = true; break; } }
    if (!ok) { mv.viaCore = true; ok = trimEnd(car, yard); if (ok) { mv.idleHome = false; return yard; } }
    mv.idleHome = false; mv.viaCore = true;
    if (!ok) return undefined;
    returned.set(yard.id, (returned.get(yard.id) ?? 0) + 1);
    return yard;
  };
  // drafted returns (fixed late runs) are in the yards' counts
  for (const depot of input.fixedEnds.values()) returned.set(depot, (returned.get(depot) ?? 0) + 1);
  // a hot standby car that stays at a storage place is that place's night car
  for (const berth of input.standbyEnds.values()) {
    const yard = yards.find(y => y.depot < 0 && y.night === berth);
    if (yard) returned.set(yard.id, (returned.get(yard.id) ?? 0) + 1);
  }
  // line storage first: its latest reachable cars after its clock
  for (const yard of yards.filter(y => y.depot < 0)) {
    while (due(yard) > 0) {
      const car = spare.filter(c => c.trip.next === undefined && !endOf.has(c.trip.id) && arr(c.trip) + 60 >= (yard.after ?? -Infinity))
        .sort((a, b) => arr(b.trip) - arr(a.trip)).find(c => home(c, yard));
      if (!car) break;
      spare.splice(spare.indexOf(car), 1);
      returned.set(yard.id, (returned.get(yard.id) ?? 0) + 1);
    }
  }
  const depots = yards.filter(y => y.depot >= 0);
  const nearest = (st: number) => depots.slice().sort((a, b) => distanceTo(a, st) - distanceTo(b, st))[0].id;
  const homing = spare.filter(c => c.trip.next === undefined && !endOf.has(c.trip.id)).sort((a, b) => arr(a.trip) - arr(b.trip));
  const later = new Map(depots.map(y => [y.id, homing.filter(c => nearest(c.station) === y.id).length]));
  // Each yard ends the day at its own count: first find, without committing,
  // the yards each car can still reach, and match the cars to the cars each
  // yard is owed (augmenting paths), nearest first. A car whose match no
  // longer fits when its turn comes falls back to the balanced order below.
  const reach = new Map<Car, Yard[]>();
  const matched = new Map<Car, Yard>();
  const rematch = (all: Car[]) => {
    reach.clear(); matched.clear();
    // An idle morning car goes to its nearest yard whatever the counts
    // (idleNearest): it is no car to match, and the count it fills there is
    // not offered to the others.
    const idle = new Map<number, number>();
    const rest = all.filter(car => {
      const y = car.trip.next === undefined && !endOf.has(car.trip.id) ? mv.idleYard(car) : undefined;
      if (y) idle.set(y.id, (idle.get(y.id) ?? 0) + 1);
      return !y;
    });
    mv.dry = true;
    // a car's yards, fewest extra moves first (straight in, then a move, then
    // a cut run), then the nearest
    for (const car of rest) {
      const cost = new Map<Yard, number>();
      for (const y of depots) for (const across of [false, true]) {
        mv.viaCore = across;
        const c = directReturn(car, y) ? 0 : home(car, y) ? 1 : trimEnd(car, y) ? 2 : undefined;
        if (c !== undefined) { cost.set(y, Math.min(c, cost.get(y) ?? c)); break; }
      }
      reach.set(car, [...cost.keys()].sort((a, b) => cost.get(a)! - cost.get(b)! || distanceTo(a, car.station) - distanceTo(b, car.station)));
    }
    mv.dry = false; mv.viaCore = true;
    const slots = new Map(depots.map(y => [y.id, Math.max(0, due(y) - (idle.get(y.id) ?? 0))]));
    const holders = new Map<number, Car[]>(depots.map(y => [y.id, []]));
    const assign = (car: Car, seen: Set<number>): boolean => {
      for (const y of reach.get(car)!) {
        if (seen.has(y.id)) continue;
        seen.add(y.id);
        const list = holders.get(y.id)!;
        const other = list.length < slots.get(y.id)! ? undefined : list.find(o => assign(o, seen));
        if (list.length >= slots.get(y.id)! && !other) continue;
        if (other) list.splice(list.indexOf(other), 1);
        list.push(car); matched.set(car, y);
        return true;
      }
      return false;
    };
    for (const car of rest.slice().sort((a, b) => reach.get(a)!.length - reach.get(b)!.length)) assign(car, new Set());
  };
  if (input.matchHomes) rematch(homing);
  for (const [i, car] of homing.entries()) {
    later.set(nearest(car.station), later.get(nearest(car.station))! - 1);
    if (car.trip.next !== undefined || endOf.has(car.trip.id)) continue;
    // Balanced quotas (OPERATIONS.depotReturns): a yard the later cars would
    // leave short comes first, then any yard still owed, then the nearest.
    const short = (y: Yard) => due(y) > later.get(y.id)!;
    const balanced = depots.slice().sort((a, b) => Number(short(b)) - Number(short(a)) || Number(due(b) > 0) - Number(due(a) > 0)
      || distanceTo(a, car.station) - distanceTo(b, car.station));
    const match = matched.get(car);
    if (DEBUG) setTrace(new Map());
    const yard = idleNearest(car) ?? retire(car, balanced, match);
    if (DEBUG && yard) { const last = lastOf(car.trip); dutyDebug.push(`home ${fmt(arr(car.trip))} ${STATIONS[car.station].id} ${car.trip.dir} → ${yard.name} via ${last === car.trip ? 'direct' : `${last.revenue ? '' : 'empty '}${STATIONS[last.from].id}-${STATIONS[last.to].id}`} trimmed ${car.trip.to !== car.station ? STATIONS[car.trip.to].id : '-'} match ${match?.name ?? '-'} due ${depots.map(y => due(y)).join(',')} later ${depots.map(y => later.get(y.id)).join(',')}`); }
    // a match that no longer fits when its turn comes: match the rest again
    if (match && yard !== match) rematch(homing.slice(i + 1));
    if (yard) void 0;
    else if (match && trimEnd(car, match) || trimEnd(car)) void 0;
    else if (DEBUG && dutyDebug.push(`home-fail ${STATIONS[car.station].id} ${car.trip.dir} ${fmt(arr(car.trip))} ${car.trip.kind} ${STATIONS[car.trip.from].id}: ${[...getTrace()!].map(([k, n]) => k + '=' + n).join(' ')} due ${yards.map(y => due(y)).join(',')}`) < 0) void 0;
    else if (homeless.push(car.trip.id) < 0) void 0;
    else issues.push({ severity: 'error', code: 'YARD_BALANCE', t: arr(car.trip),
      text: `${STATIONS[car.station].name} ${fmt(arr(car.trip))} 到达的车无法回段或存车` });
  }

  function lastOf(t: GenTrip): GenTrip { let cur = t; while (cur.next !== undefined) cur = trips[cur.next]; return cur; }

  // ---- 4. duties
  const blocks: Block[] = [];
  const heads = trips.filter(t => !t.cancelled && t.prev === undefined && t.block === -1).sort((a, b) => dep(a) - dep(b));
  for (const head of heads) {
    const block: Block = { id: blocks.length, svc: '', start: startOf.get(head.id) ?? { kind: 'stable', station: head.from }, end: { kind: 'none' }, trips: [] };
    let cur: GenTrip | undefined = head;
    for (let guard = 0; cur && guard < 500; guard++) {
      cur.block = block.id;
      block.trips.push(cur.id);
      if (cur.next === undefined) { block.end = endOf.get(cur.id) ?? { kind: 'none' }; break; }
      cur = trips[cur.next];
    }
    if (block.start.kind === 'depot') block.start.time = depotStartTime(ctx, block.start.depot, trips[block.trips[0]]);
    if (!startOf.has(head.id)) issues.push({ severity: 'error', code: 'UNASSIGNED', t: dep(head), text: `车次起点 ${STATIONS[head.from].name} ${fmt(dep(head))} 无出车来源` });
    if (block.end.kind === 'none') issues.push({ severity: 'error', code: 'UNASSIGNED', t: arr(trips[block.trips.at(-1)!]), text: `车底终点 ${STATIONS[trips[block.trips.at(-1)!].to].name} 无回段或存车` });
    blocks.push(block);
  }
  const ledger: DutyLedger = {
    exits: topo.depots.map((_, d) => exits.filter(x => x.yard === d).length),
    returns: topo.depots.map((_, d) => blocks.filter(b => b.end.kind === 'depot' && b.end.depot === d).length),
    homeless, lent, leads: input.borrow ? mv.leadMoves().map(b => ({ ...b, car: b.trip === undefined ? undefined : carOf(b.trip) })) : [],
    // a depot a car was lent to is short, never spare
    spare: topo.depots.map((_, d) => lent.some(l => l.depot === d) ? 0 : Math.max(0, mv.lowest(yards.find(y => y.depot === d)!, -Infinity, 0))),
  };
  if (DEBUG && (input.borrow || input.deliver)) dutyDebug.push(`rebalance ${input.borrow ? 'probe' : 'pass'}: lent ${lent.map(l => `${topo.depots[l.depot].name}@${fmt(l.at)}`).join(' ')} spare ${ledger.spare} undelivered ${deliveries.filter(d => !d.done).map(d => `${topo.depots[d.depot].name}@${fmt(d.before)}`).join(' ')} exits ${ledger.exits} returns ${ledger.returns}`);
  return { blocks, issues, ledger };
}

