/**
 * Duties of added services (加开, D47, D184): the same terminal pool as the
 * day plan, with the base plan's trains as cars already on the line.
 *
 * The added trips are laid into the stream and paired at the ends of the
 * added section by `applyOverlay`. Here every chain of them gets a car and a
 * home, with the moves fitted by moves.ts against the whole plan:
 *
 *  - a chain's first departure takes a base car finishing its duty near
 *    there, the latest ready first (its return to the yard is dropped and it
 *    goes home after the added trips), else a yard exit;
 *  - a chain's last arrival takes the first revenue departure of a base duty
 *    that has not left its yard yet (that duty's exit is dropped), else it
 *    returns to a yard, one the added exits drew from first.
 *
 * A base duty is reused only where `canExtend` allows (its train runs
 * normally, or has not left the yard). A chain no car or no home can be
 * found for is cancelled, with its reason.
 */
import type { Block, Plan } from '../model';
import { cancelTrip } from '../model';
import type { PlanContext, GenTrip, OverlayReuse } from '../timetable';
import { dayPeriods, depotStartTime, MAX_LAYOVER } from '../timetable';
import { STATIONS } from '../../data/current';
import { createMoves, type Car, type Want } from './moves';

export function overlayDuties(ctx: PlanContext, plan: Plan, tag: string, reuse: OverlayReuse): Block[] {
  const trips = plan.trips as GenTrip[];
  const blockBase = plan.blocks.length;
  const base = plan.blocks.slice();
  const now = reuse.now;
  const mv = createMoves(ctx, trips, dayPeriods(ctx.dayType), { notBefore: Number.isFinite(now) ? now : undefined, added: true });
  const { arr, dep, index } = mv;
  mv.seedBase(plan, reuse.stock);
  const added = trips.filter(t => t.overlay === tag && !t.cancelled);
  // the turns paired while the added trips were laid out hold their places
  for (const a of added) {
    const d = a.next !== undefined ? trips[a.next] : undefined;
    if (d && d.from === a.to && d.dir !== a.dir)
      mv.places.set(a.to, [...(mv.places.get(a.to) ?? []), { from: arr(a), to: dep(d) + mv.clearAfter(a.to) }]);
  }
  const depots = mv.yards.filter(y => y.depot >= 0);
  /** cars a yard is still owed back: the base plan's own shortfall, and each added exit */
  const owed = new Map(depots.map(y => [y.id, reuse.returnShift?.[y.depot] ?? 0]));
  const reused = new Set<number>();
  /** an added arrival that runs on into a base duty: that duty and the trip it continues from */
  const absorbedAt = new Map<number, { block: Block; from: number }>();
  const withheld = (list: GenTrip[]) => {
    const was = list.map(t => t.cancelled);
    for (const t of list) { index.remove(t); t.cancelled = true; }
    return () => list.forEach((t, i) => { t.cancelled = was[i]; index.add(t); });
  };
  const liveTrips = (b: Block) => b.trips.map(id => trips[id]).filter(t => !t.cancelled);
  const later = (t: GenTrip) => t.stops.every(p => p.dep >= now + 120);

  /** a base car on its way home takes the added departure `want` instead */
  const extendBase = (want: Want): boolean => {
    const D = want.trip;
    const options: { block: Block; L: GenTrip; tail: GenTrip[] }[] = [];
    for (const block of base) {
      if (block.end.kind !== 'depot' || reused.has(block.id)) continue;
      const live = liveTrips(block);
      let at = live.length - 1;
      while (at >= 0 && (live[at].kind === 'wd' || live[at].kind === 'empty')) at--;
      if (at < 0) continue;
      const L = live[at], tail = live.slice(at + 1), tA = arr(L);
      if (tA > dep(D) || dep(D) - tA > MAX_LAYOVER || tA < now + 120 || L.overlay || !tail.every(later)) continue;
      if (!reuse.canExtend(block.id, L.id)) continue;
      options.push({ block, L, tail });
    }
    // the latest ready first: the shortest stand (the pool's plan order)
    options.sort((a, b) => arr(b.L) - arr(a.L));
    for (const { block, L, tail } of options) {
      const restore = withheld(tail), entry = mv.unseed(block.id, 'entry');
      const car: Car = { id: L.id, ready: arr(L), trip: L, station: L.to };
      if (!mv.join(car, want)) { restore(); entry(); continue; }
      for (const t of tail) cancelTrip(t, `加开：车底延长运用，改担任${STATIONS[D.from].name}始发加开车次`);
      reused.add(block.id);
      reuse.extended.push({ block: block.id, last: L.id, trips: [L.next!], tail: tail.map(t => t.id), end: block.end });
      return true;
    }
    return false;
  };

  /** the added car `car` runs on into a base duty not yet out of its yard */
  const takeOver = (car: Car): boolean => {
    const options: { B: Block; k: number; D: GenTrip }[] = [];
    for (const B of base) {
      if (B.start.kind !== 'depot' || B.train !== undefined || B.relieved || reused.has(B.id) || B.start.time < now + 120) continue;
      const k = B.trips.findIndex(id => !trips[id].cancelled && trips[id].revenue);
      if (k < 0) continue;
      const D = trips[B.trips[k]];
      if (D.overlay || dep(D) < arr(car.trip) + 30 || !reuse.canExtend(B.id, D.id)) continue;
      options.push({ B, k, D });
    }
    options.sort((x, y) => dep(x.D) - dep(y.D));
    for (const { B, k, D } of options) {
      const lead = B.trips.slice(0, k).map(id => trips[id]).filter(t => !t.cancelled);
      const restore = withheld(lead), exit = mv.unseed(B.id, 'exit');
      if (!mv.join(car, { id: D.id, at: dep(D), trip: D, station: D.from })) { restore(); exit(); continue; }
      for (const t of lead) cancelTrip(t, '加开：由加开车接续，免出段');
      reused.add(B.id);
      absorbedAt.set(D.id, { block: B, from: k });
      return true;
    }
    return false;
  };

  /** insert `t` into `queue` in the order of `key` */
  const enqueue = (queue: GenTrip[], t: GenTrip, key: (t: GenTrip) => number) => {
    const i = queue.findIndex(q => key(q) > key(t));
    queue.splice(i < 0 ? queue.length : i, 0, t);
  };

  // ---- a car for every chain: a departure no car can take is not run, and
  // the next trip of its chain looks for a car of its own
  const firsts = added.filter(t => t.prev === undefined).sort((a, b) => dep(a) - dep(b));
  while (firsts.length) {
    const D = firsts.shift()!;
    const want: Want = { id: D.id, at: dep(D), trip: D, station: D.from };
    if (extendBase(want)) {
      // the base car goes home to its own yard after the added trips
      const end = reuse.extended.at(-1)!.end;
      if (end.kind === 'depot') owed.set(end.depot, owed.get(end.depot)! + 1);
      continue;
    }
    const yard = depots.slice().sort((a, b) => mv.distanceTo(a, D.from) - mv.distanceTo(b, D.from)).find(y => mv.feed(y, want));
    if (yard) { owed.set(yard.id, owed.get(yard.id)! + 1); continue; }
    cancelTrip(D, '加开：通知时间或沿途进路不足，后续班次继续尝试');
    const next = D.next !== undefined ? trips[D.next] : undefined;
    D.next = undefined;
    if (next?.overlay === tag) { next.prev = undefined; enqueue(firsts, next, dep); }
  }
  // ---- a home for every chain: an arrival that cannot get home is not run,
  // and the trip before it goes home instead
  const ends = trips.filter(t => (t.overlay === tag || t.id >= (added[0]?.id ?? Infinity)) && !t.cancelled && t.block === -1
    && t.next === undefined && !mv.endOf.has(t.id)).sort((a, b) => arr(a) - arr(b));
  while (ends.length) {
    const A = ends.shift()!;
    const car: Car = { id: A.id, ready: arr(A), trip: A, station: A.to };
    if (takeOver(car)) continue;
    // 用户决定（2026-11-10）：taking over no base duty, the car has no more work: before 10:00 it goes home
    // to its nearest yard only, as the day plan's idle cars do (moves.ts idleYard, planner.ts idleNearest)
    const idle = mv.idleYard(car);
    if (idle) {
      mv.idleHome = true;
      const ok = mv.homeBy(car, idle);
      mv.idleHome = false;
      if (ok) { owed.set(idle.id, owed.get(idle.id)! - 1); continue; }
    }
    const yard = depots.slice().sort((a, b) => Number(owed.get(b.id)! > 0) - Number(owed.get(a.id)! > 0) || mv.distanceTo(a, A.to) - mv.distanceTo(b, A.to))
      .find(y => mv.homeBy(car, y));
    if (yard) { owed.set(yard.id, owed.get(yard.id)! - 1); continue; }
    const P = A.prev !== undefined ? trips[A.prev] : undefined;
    // (a chain a base car runs is given back to that duty by the plan check)
    if (P && P.block !== -1) continue;
    cancelTrip(A, '加开：高峰间隔内无回段时隙');
    A.prev = undefined;
    if (!P) continue;
    P.next = undefined;
    // a yard move with no trip after it does not run either
    if (mv.startOf.has(P.id)) { cancelTrip(P, '加开：后续车次取消'); continue; }
    enqueue(ends, P, arr);
  }
  // the fitted moves are added service too (加开 numbering, the cancellation retry)
  for (const t of trips.slice(added[0]?.id ?? trips.length)) if (t.overlay === undefined) {
    t.overlay = tag;
    t.kind = t.revenue ? 'extra' : 'empty';
  }

  // ---- duties
  /** the added train runs on into the base duty it took over */
  const takeRest = (cur: GenTrip, b: Block) => {
    const next = cur.next !== undefined ? trips[cur.next] : undefined;
    const x = next && absorbedAt.get(next.id);
    if (!x) return false;
    const rest = x.block.trips.slice(x.from);
    reuse.absorbed ??= [];
    reuse.absorbed.push({ block: x.block.id, into: b.id, trips: rest, lead: x.block.trips.slice(0, x.from).filter(id => trips[id].cancelReason?.includes('免出段')), end: x.block.end });
    for (const id of rest) { trips[id].block = b.id; b.trips.push(id); }
    x.block.trips = x.block.trips.slice(0, x.from);
    b.end = x.block.end;
    return true;
  };
  const follow = (b: Block, first: GenTrip, list?: number[]) => {
    for (let cur: GenTrip | undefined = first, guard = 0; cur && guard < 500; guard++) {
      cur.block = b.id;
      b.trips.push(cur.id);
      list?.push(cur.id);
      if (takeRest(cur, b)) break;
      if (cur.next === undefined) { b.end = mv.endOf.get(cur.id) ?? { kind: 'none' }; break; }
      cur = trips[cur.next];
    }
  };
  const blocks: Block[] = [];
  const heads = trips.filter(t => t.overlay === tag && !t.cancelled && t.prev === undefined && t.block === -1).sort((a, b) => dep(a) - dep(b));
  for (const h of heads) {
    const b: Block = { id: blockBase + blocks.length, svc: '', start: mv.startOf.get(h.id) ?? { kind: 'stable', station: h.from }, end: { kind: 'none' }, trips: [] };
    follow(b, h);
    if (b.start.kind === 'depot') b.start.time = depotStartTime(ctx, b.start.depot, trips[b.trips[0]]);
    blocks.push(b);
  }
  for (const x of reuse.extended) {
    if (x.block >= blockBase || !reused.has(x.block)) continue;
    const first = trips[x.trips[0]];
    x.trips = [];
    follow(plan.blocks[x.block], first, x.trips);
  }
  return blocks;
}
