/**
 * 运行时车底池（D178、D184）: the live half of the one duty allocator. The
 * day plan (planner.ts) matches cars to departures with the terminal pool;
 * while the day runs, a duty that cannot keep its departures gets its tail
 * of trips matched to another car by the same pool rule (pool.ts takeCar).
 *
 * The demand is the tail of one duty (its trips from some departure on). Each
 * car that could take the tail from its trip `k` is an offer:
 *
 *  - tier 0, hot standby (热备, D70/D148) at a line end, crewed in its turnback
 *    track; it swaps duties with the late train, which turns in for it.
 *  - tier 1, first-ready (先到先发, D148/D156) at a terminal marked so: the
 *    train standing there with the next own departure, or after all of them a
 *    train arriving there to stable; the late train takes its duty instead.
 *  - tier 2, a yard spare (备车, D45) with its empty or carrying move out.
 *
 * Every offer changes the plan in one atomic step (tails and ends exchanged)
 * and is admitted only when the changed plan adds no validator error and
 * keeps every yard's stock non-negative (`noWorse`).
 *
 * R1 relief (a train predicted more than RELIEF_DELAY late for its next own
 * departure) takes the offers in D148's tier order, each tier from the
 * earliest trip it can take. R3 takeover (a duty lost its train) takes the
 * earliest trip any car can make, the hot standby before a yard spare.
 *
 * A car left over leaves the pool to its yard: a relieved train after its
 * last kept trip, and an idle stabled car whose place another car is due
 * for (D177).
 */
import type { Sim } from '../engine';
import type { Block, Plan, StopTask, TrackDir, Train, Trip } from '../model';
import { applyStandby, depotLedger, standbyCandidate, minTurn, blockTasks, hotStandbyPlaces, standbyWindows, effectiveStops, effectiveEnd, buildStops, clearOnToYard, type StandbyPlan } from '../timetable';
import { platformBerth, departureBerthAfterReverse, storageOccupancy } from '../timetable';
import { noWorse } from '../planning';
import { extendTrainTasks, remainingStart, setTripFromTasks, berthHolder } from '../ats';
import { travelDirection, reversedBerthPoint } from '../topology';
import { routePathStart, walkRouteToBerth } from '../routePath';
import { takeCar, type PoolCar } from './pool';

/** Notice a standby needs before leaving the yard (s). */
export const STANDBY_NOTICE = 300;
/** Predicted lateness of a train's next own departure that calls a standby
 * (s). 用户决定（D148）：20 分钟以上才换，更小的晚点靠富余自己追。 */
export const RELIEF_DELAY = 1200;

/** Notice a hot standby needs: crew to the leading cab, train woken up (s). */
export const HOT_NOTICE = 150;
/** From its turnback track onto the departure platform (s). */
const HOT_PULL_OUT = 90;

type Result = { ok: boolean; msg: string };

/** A car offered for `tail[k..]` of the demanded duty. */
interface Offer extends PoolCar {
  /** 0 hot standby, 1 first-ready, 2 yard spare; a stabler ranks after a
   * first-ready train with an own departure (D156) */
  rank: number;
  k: number;
  /** the plan change, on a copy for the check, then on the live plan */
  change(plan: Plan): number | void;
  /** already validated by its own search (a yard move) */
  checked?: boolean;
  /** the trains' tasks and the log once the change is on the live plan */
  retask(changed: number | void): Result;
}

/** The offer the pool gives the tail: `tiers` in order (relief, D148) or all
 * at once, earliest trip first (takeover). */
function allocate(sim: Sim, tail: number[], tiers: (() => Offer[])[], byTier: boolean): Offer | undefined {
  const admit = (o: Offer) => {
    if (o.checked) return true;
    const plan = structuredClone(sim.plan);
    o.change(plan);
    return noWorse(sim, plan);
  };
  const rule = { order: 'earliest' as const, maxWait: () => Infinity, rank: (o: Offer) => o.rank, admit };
  const pick = (offers: Offer[]) => {
    for (const k of [...new Set(offers.map(o => o.k))].sort((a, b) => a - b)) {
      const at = effectiveStops(sim.plan.trips[tail[k]])[0]?.dep ?? Infinity;
      // (an offer is built only where it is in time: its readiness orders it)
      const car = takeCar(offers.filter(o => o.k === k).map(o => ({ ...o, ready: Math.min(o.ready, at) })), { id: k, at }, rule);
      if (car) return car;
    }
  };
  if (!byTier) return pick(tiers.flatMap(t => t()));
  for (const tier of tiers) {
    const car = pick(tier());
    if (car) return car;
  }
}

function commit(sim: Sim, o: Offer): Result {
  const changed = o.change(sim.plan);
  sim.planRev++;
  sim.planDirty = true;
  return o.retask(changed);
}

/** A hot standby standing in its turnback track (D70): its station and the
 * trip it stands for; null for any other train. */
export function hotStandby(sim: Sim, tr: Train): { station: number; trip: number; parked?: boolean } | null {
  const t0 = tr.tasks[0];
  if (tr.failed || tr.manual || tr.withdrawn || tr.coupledLen > 0 || tr.block < 0 || tr.relievedBy
    || tr.rescuing >= 0 || tr.rescueBy >= 0) return null;
  if(tr.phase==='stabled'&&!tr.tasks.length){
    const block=sim.plan.blocks[tr.block],last=block?.trips.map(id=>sim.plan.trips[id]).filter(t=>!t.cancelled).at(-1);
    if(block?.end.kind!=='stable'||block.end.berth===undefined||!last?.standby)return null;
    const endBerth=block.end.berth;
    const place=hotStandbyPlaces(sim.topo).find(p=>p.depot&&sim.topo.berths[p.berth]?.link===tr.link
      && sim.topo.berths[endBerth]?.link===tr.link && standbyWindows(sim.plan.dayType,p).some(w=>w.from<=sim.t&&sim.t<w.to));
    return place?{station:place.station,trip:-1,parked:true}:null;
  }
  if (t0?.k !== 'stop' || !t0.standby || t0.dep === null || t0.trip < 0 || tr.phase !== 'run' || tr.v > 0.05) return null;
  // A storage spare already assigned to a passenger suffix is still on its
  // original link until its call-out starts; it is no longer available.
  if (sim.plan.trips[t0.trip]?.hotCallout) return null;
  const place = hotStandbyPlaces(sim.topo).find(p => (p.depot ? [p.berth] : sim.topo.stations[p.station].turnbackBerths)
    .some(b => sim.topo.berths[b].link === tr.link));
  return place ? { station: place.station, trip: t0.trip } : null;
}

/** live trips of duty `b` from `trip` on */
function from(plan: Plan, b: Block, trip: number): number[] {
  return b.trips.slice(b.trips.indexOf(trip)).filter(id => !plan.trips[id].cancelled && !plan.trips[id].completed);
}

/** The first trip of `tail` (from `minK`) each hot standby can take on time:
 * the standby, the index, and its own later duty. */
function hotCandidate(sim: Sim, tail: number[], minK = 0): { h: Train; k: number; own: number[]; cut: number }[] {
  const out: { h: Train; k: number; own: number[]; cut: number }[] = [];
  for (const h of sim.trainList) {
    const at = hotStandby(sim, h);
    if (!at) continue;
    for (let k = minK; k < tail.length; k++) {
      const D = sim.plan.trips[tail[k]];
      if (!D.revenue || D.completed) continue;
      const stops = effectiveStops(D);
      const current = sim.trainList.find(t => t.tripId === D.id && t.block === D.block);
      const start = remainingCalls(D, current);
      if (start === undefined) continue;
      const cut = stops.findIndex((s, i) => i >= start && s.st === at.station && s.stop && s.st !== effectiveEnd(D));
      if (cut < 0 || !at.parked && stops[cut].dep < sim.t + HOT_NOTICE + HOT_PULL_OUT) continue;
      if(at.parked){
        const place=hotStandbyPlaces(sim.topo).find(p=>p.station===at.station&&sim.topo.berths[p.berth]?.link===h.link);
        if(!place)continue;
        const reversal=travelDirection(sim.topo,h)!==D.dir;
        const berth=sim.topo.berths.find(b=>b.link===h.link&&b.dir===h.dir&&Math.abs(b.offset-h.off)<5);
        const point=reversal&&berth?reversedBerthPoint(sim.topo,berth.id,h.len,h.hist):reversal?undefined:{link:h.link,off:h.off,dir:h.dir};
        const board=place.track==='storage'?stops.findIndex((p,i)=>i>cut&&p.stop&&!p.noBoard):cut;
        if(board<0||place.track==='storage'&&!place.emptyCalloutToFirstPlatform||!point)continue;
        const goal=platformBerth(sim.topo,stops[board].st,D.dir),route=routePathStart(sim.topo,point,goal);
        if(!route || 'start' in route&&!Number.isFinite(walkRouteToBerth(sim.topo,sim.routeTable,route.start,goal)))continue;
        const travel=board===cut?HOT_PULL_OUT:buildStops(sim.planCtx,D.dir,at.station,stops[board].st,0,true,1).at(-1)!.arr;
        if(stops[board].dep<sim.t+HOT_NOTICE+travel+(reversal?40:0))continue;
        out.push({h,k,cut,own:[]});break;
      }
      // A siding is left in its prepared heading. An incompatible train is
      // served by the next hot standby or a yard spare, without teleporting.
      const ownTrip = sim.plan.trips[at.trip];
      if (D.dir !== ownTrip.dir) continue;
      out.push({ h, k, cut, own: from(sim.plan, sim.plan.blocks[h.block], at.trip) });
      break;
    }
  }
  return out.sort((a, b) => a.k - b.k);
}

/** Retain the cancelled upstream service and publish a distinct recovered
 * suffix. Its downstream passenger times and stop flags stay unchanged. */
function recoveredTail(sim: Sim, plan: Plan, tail: number[], k: number, cut: number, source: 'hot' | 'yard' = 'hot'): number[] {
  const taken = tail.slice(k);
  const original = plan.trips[taken[0]];
  const effective = effectiveStops(original);
  const place = source === 'hot' ? hotStandbyPlaces(sim.topo).find(p => p.station === effective[cut].st) : undefined;
  if (source === 'hot' && !cut && place?.track !== 'storage') return taken;
  const stops = effective.slice(cut).map(s => ({ ...s }));
  stops[0].arr = stops[0].dep;
  if (place?.track === 'storage') { stops[0].stop = false; stops[0].noBoard = true; }
  const suffix = { ...original, id: plan.trips.length, no: `${original.no}续`, from: stops[0].st, to: stops[stops.length - 1].st, stops, cancelled: false };
  if(place?.track==='storage'&&place.emptyCalloutToFirstPlatform){
    const board=stops.find((p,i)=>i>0&&p.stop&&!p.noBoard);
    if(board)suffix.hotCallout={from:place.station,firstBoardable:board.st};
  }
  delete suffix.cut;
  delete suffix.cancelReason;
  plan.trips.push(suffix);
  // moveTrips also removes the original cancelled trip from its old duty.
  plan.blocks[original.block].trips.push(suffix.id);
  taken[0] = suffix.id;
  return taken;
}

/** The original stop index shared by both types of standby. */
function remainingCalls(trip: Plan['trips'][number], current?: Train): number | undefined {
  if (!current) return 0;
  const last = current.lastCompletedCall?.trip === trip.id ? current.lastCompletedCall.stopIndex : undefined;
  const next = remainingStart(trip, current);
  const pending = current.tasks.find(t => t.k === 'stop' && t.trip === trip.id);
  const standing = pending?.k === 'stop' && !!pending.standby;
  if (last === undefined && next === undefined && !standing) return;
  // A spare standing for this trip has not left its origin (a storage track
  // is passed, not a stop task): nothing of it has been served.
  if ((last ?? -1) < 0 && standing) return 0;
  return Math.max((last ?? -1) + 1, next ?? 0);
}

/** Project a yard takeover onto the still-unserved part of the actual trip.
 * A missing old-checkpoint index is never guessed: a remaining indexed stop
 * is usable, otherwise that trip is skipped and later trips remain eligible. */
function yardTail(sim: Sim, plan: Plan, tail: number[]): { ids: number[]; indices: number[] } {
  const ids: number[] = [], indices: number[] = [];
  for (let k = 0; k < tail.length; k++) {
    const id = tail[k], trip = plan.trips[id];
    const current = sim.trainList.find(t => t.tripId === id && t.block === trip.block);
    const start = remainingCalls(trip, current);
    if (start === undefined) continue;
    const stops = effectiveStops(trip);
    if (start >= stops.length) continue;
    const taken = start ? recoveredTail(sim, plan, [id], 0, start, 'yard')[0] : id;
    // A candidate can begin at a later trip. Keep an unselected suffix
    // cancelled; applyStandby reinstates only the trips it actually takes.
    if (start) plan.trips[taken].cancelled = true;
    ids.push(taken); indices.push(k);
  }
  return { ids, indices };
}

type YardStandbyPlan = StandbyPlan & { viewK: number };

/** Apply the same projection used by the candidate preview. */
function applyYard(sim: Sim, plan: Plan, from: number, tail: number[], c: YardStandbyPlan): Block {
  const view = yardTail(sim, plan, tail);
  return applyStandby(plan, from, view.ids, { ...c, k: c.viewK });
}

/** move `taken` (trips of block `src`, its last ones) to the end of block `dst` */
function moveTrips(plan: Plan, src: number, taken: number[], dst: number) {
  const s = plan.blocks[src], d = plan.blocks[dst];
  for (const id of taken) { const t = plan.trips[id]; t.block = dst; t.cancelled = false; delete t.cancelReason; }
  s.trips = s.trips.filter(id => !taken.includes(id));
  d.trips.push(...taken);
  d.end = s.end;
}

/** Exchange the tails `a` (of duty `x`) and `b` (of duty `y`) with their ends. */
function swapTails(plan: Plan, x: number, a: number[], y: number, b: number[]) {
  const bx = plan.blocks[x], by = plan.blocks[y];
  const [endX, endY] = [bx.end, by.end];
  for (const id of a) plan.trips[id].block = by.id;
  for (const id of b) plan.trips[id].block = bx.id;
  bx.trips = [...bx.trips.filter(id => !a.includes(id)), ...b];
  by.trips = [...by.trips.filter(id => !b.includes(id)), ...a];
  bx.end = endY;
  by.end = endX;
}

/** the hot standby `h` leaves its track for the duty it now has, from `trip` */
function callOut(sim: Sim, h: Train, trip: number) {
  const b = sim.plan.blocks[h.block];
  // (its departure stop stays a standby's: it is called up to the platform
  // STANDBY_CALL before, no earlier than the notice allows)
  h.tasks = blockTasks(sim.topo, sim.plan, b, b.trips.indexOf(trip));
  if(h.phase==='stabled'){
    const dir=sim.plan.trips[trip].dir;
    if(travelDirection(sim.topo,h)!==dir){
      const berth=sim.topo.berths.find(x=>x.link===h.link&&x.dir===h.dir&&Math.abs(x.offset-h.off)<5);
      if(berth)h.tasks.unshift({k:'reverse',station:berth.station,berths:[berth.id],chosen:berth.id,minTime:40});
    }
    h.phase='run';h.phaseSince=sim.t;b.train=h.id;sim.blockDone.delete(b.id);
  }
  setTripFromTasks(sim, h);
}

/** A standby (hot or from the yard) inherits the duty's end, its return to the
 * yard or stabling, so it takes over only a tail that runs to the end of the
 * duty. A relieved duty's kept trips end in a withdrawal instead (their end
 * is no longer reachable from where they finish), so no standby takes them. */
function takeable(plan: Plan, from: number, tail: number[]): boolean {
  const block = plan.blocks[from];
  const taken = new Set(tail);
  const last = block.trips.filter(id => taken.has(id) || !plan.trips[id].cancelled).at(-1);
  return !block.relieved && tail.at(-1) === last;
}

/** The yard standby that takes over `tail` (live trip ids of duty `from`, in
 * order), validated on a copy of the plan; null when none can. */
export function findStandby(sim: Sim, from: number, tail: number[], minK = 0, maxK = tail.length - 1, amend?: (plan: Plan) => unknown, allowPositioning = false): YardStandbyPlan | null {
  if (!tail.length || minK > maxK || !takeable(sim.plan, from, tail)) return null;
  const { topo } = sim;
  const source = structuredClone(sim.plan);
  const view = yardTail(sim, source, tail);
  const min = view.indices.findIndex(k => k >= minK);
  const max = view.indices.reduce((last, k, i) => k <= maxK ? i : last, -1);
  if (min < 0 || max < min) return null;
  const origin = topo.stations[source.trips[view.ids[min]].from].chain;
  const depots = topo.depots.map((d, i) => ({ i, dist: Math.abs(d.junctionChain - origin) }))
    .filter(d => sim.depotStock[d.i] > 0).sort((a, b) => a.dist - b.dist).map(d => d.i);
  if (!depots.length) return null;
  const notBefore = sim.t + STANDBY_NOTICE;
  const next = new Map(depots.map(d => [d, min]));
  for (let guard = 0; guard < depots.length * tail.length; guard++) {
    let best: StandbyPlan | null = null;
    for (const d of depots) {
      const k0 = next.get(d)!;
      if (k0 > max) continue;
      const c = standbyCandidate(sim.planCtx, source, view.ids, d, notBefore, k0, max, allowPositioning);
      if (!c) { next.set(d, max + 1); continue; }
      // earliest takeover first; between yards, the nearest
      if (!best || c.k < best.k) best = c;
    }
    if (!best) return null;
    const plan = structuredClone(source);
    applyStandby(plan, from, view.ids, best);
    amend?.(plan);
    // (a yard imbalance the plan already had, with the same counts, does not
    // block a takeover; one it creates or changes does)
    if (noWorse(sim, plan)) return { ...best, k: view.indices[best.k], viewK: best.k };
    next.set(best.depot, best.k + 1);
  }
  return null;
}

// ---------------------------------------------------------------- offers

/** Tier 2 for a lost duty: a yard spare takes the tail. */
function yardTakeOffer(sim: Sim, from: number, tail: number[], why: string): Offer[] {
  const c = findStandby(sim, from, tail);
  if (!c) return [];
  return [{ id: -1, rank: 2, k: c.k, ready: c.start, checked: true,
    change: plan => applyYard(sim, plan, from, tail, c).id,
    retask: id => {
      const block = sim.plan.blocks[id as number];
      const skipped = c.k ? `；此前${c.k}趟来不及接替，仍取消` : '';
      const msg = `备车顶替：${sim.topo.depots[c.depot].name}备车表号${block.svc}接替${sim.plan.trips[tail[c.k]].no}起${tail.length - c.k}趟车次（${why}）${skipped}`;
      sim.log('C', '运营', msg, { key: `standby-${block.id}` });
      return { ok: true, msg };
    } }];
}

/** (time, direction) pairs: every 10 min from `from` to `to`, each direction in turn */
function* slots(from: number, to: number, dirs: TrackDir[]): Generator<[number, TrackDir]> {
  for (let at = from; at < to; at += 600) for (const dir of dirs) yield [at, dir];
}

/** A parked standby's duty ends at its place, where it stands until its
 * night or its own way home: taking it away vacates the place. The yard the
 * takeover leaves a train up (where the withdrawn train goes) sends one there
 * on an empty move to the station, from where it enters the place as a
 * night car does; it then stands as the hot standby (用户决定 2026-11-06：
 * 补热备位；【假设】3 h 内第一个可行时隙). `plan` is the plan after the takeover. */
function refillPlace(sim: Sim, plan: Plan, end: Block['end']): StandbyPlan | null {
  if (end.kind !== 'stable' || end.berth === undefined) return null;
  const link = sim.topo.berths[end.berth].link;
  const place = hotStandbyPlaces(sim.topo).find(p => p.station === end.station && sim.topo.berths[p.berth]?.link === link);
  if (!place) return null;
  const { initial, final } = depotLedger(sim.topo, plan);
  const notBefore = sim.t + STANDBY_NOTICE;
  for (const d of sim.topo.depots.map((_, i) => i).filter(i => final[i] > initial[i] && sim.depotStock[i] > 0)) {
    const run: TrackDir = sim.topo.stations[end.station].chain < sim.topo.depots[d].junctionChain ? 'UP' : 'DN';
    const back: TrackDir = run === 'UP' ? 'DN' : 'UP';
    // a storage place is entered by its registered storage approach (the
    // move passes the platform and reverses in); any other runs on into it
    for (const [at, dir] of slots(notBefore, sim.t + 3 * 3600, place.track === 'storage' ? [back, run] : [run, back])) {
      const target = { id: plan.trips.length, no: '', dir, kind: 'empty', from: end.station, to: end.station,
        stops: [{ st: end.station, arr: at, dep: at, stop: true }], revenue: false, block: -1 } as Trip;
      plan.trips.push(target);
      const c = standbyCandidate(sim.planCtx, plan, [target.id], d, notBefore, 0, 0, true);
      plan.trips.pop();
      if (!c?.stops) continue;
      const stops = c.standby ? c.stops : c.stops.map((p, i, all) => i === all.length - 1 ? { ...p, stop: true, dep: p.arr } : p);
      const refill = { ...c, k: 0, stops, standby: true };
      // (it arrives once the place is clear: a later slot otherwise)
      const check = structuredClone(plan);
      applyStandby(check, -1, [], refill, end);
      if (noWorse(sim, check)) return refill;
    }
  }
  return null;
}

/** Tier 0 for a lost duty: the hot standby takes the lost trips from the
 * first it can make from its station; a yard standby covers its own later
 * duty in the same step. */
function hotTakeOffers(sim: Sim, from: number, tail: number[], why: string): Offer[] {
  if (!takeable(sim.plan, from, tail)) return [];
  const out: Offer[] = [];
  for (const { h, k, own, cut } of hotCandidate(sim, tail)) {
    if (!own.length && h.phase !== 'stabled') continue;
    const positioningOnly = own.every(id => !sim.plan.trips[id].revenue);
    const finish = (plan: Plan) => {
      plan.blocks[h.block].relieved = false;
      const taken = recoveredTail(sim, plan, tail, k, cut);
      moveTrips(plan, from, taken, h.block);
      plan.blocks[from].relieved = true;
      return taken[0];
    };
    // Cover and takeover form one stock transaction. Testing the cover in
    // isolation would choose the hot duty's old home instead of the lost
    // duty's home, then incorrectly reject the complete, balanced swap.
    // For a dedicated spare the covered empty return is also the required
    // stock transfer: the withdrawn car returns to one yard, its replacement
    // leaves that yard for the spare's former home. No night stock is invented.
    const cover = own.length ? findStandby(sim, h.block, own, 0, 0, finish, positioningOnly) : null;
    if (own.length && (!cover || cover.k)) continue;
    const vacated = own.length ? undefined : sim.plan.blocks[h.block].end;
    let refill: StandbyPlan | null = null;
    if (vacated?.kind === 'stable') {
      const plan = structuredClone(sim.plan);
      finish(plan);
      refill = refillPlace(sim, plan, vacated);
    }
    const T = effectiveStops(sim.plan.trips[tail[k]])[cut].st;
    out.push({ id: h.id, rank: 0, k, ready: sim.t + HOT_NOTICE,
      change: plan => {
        if (cover) applyYard(sim, plan, h.block, own, cover);
        const first = finish(plan);
        if (refill) applyStandby(plan, -1, [], refill, vacated);
        return first;
      },
      retask: first => {
        callOut(sim, h, first as number);
        const skipped = k ? `；此前${k}趟来不及接替，仍取消` : '';
        const again = refill ? `；${sim.topo.depots[refill.depot].name}另派一列补${sim.topo.stations[T].name}热备位` : '';
        const msg = `热备车顶替：${sim.topo.stations[T].name}热备车${h.svc}（${h.vehicle}）接替${sim.plan.trips[tail[k]].no}起${tail.length - k}趟车次（${why}）${skipped}${again}`;
        sim.log('C', '运营', msg, { key: `hot-${h.id}-${tail[k]}` });
        return { ok: true, msg };
      } });
  }
  return out;
}

/** Tier 0 for a late train (终点站换车): the hot standby at a line end takes
 * its duty from the first departure there it can make on time; the late
 * train turns into the standby's track and stands for the standby's duty. */
function hotSwapOffers(sim: Sim, tr: Train, tail: number[], minK: number, late: number): Offer[] {
  const keeps = (id: number) => tr.tasks.findIndex(t => t.k === 'stop' && t.trip === id && t.dep === null);
  const out: Offer[] = [];
  for (const { h, k, own, cut } of hotCandidate(sim, tail, minK)) {
    if (cut || hotStandbyPlaces(sim.topo).some(p => p.depot && p.station === sim.plan.trips[tail[k]].from)) continue;
    if (!own.length) continue;
    const lastKept = k ? tail[k - 1] : tr.tripId;
    if (keeps(lastKept) < 0) continue;
    const taken = tail.slice(k);
    out.push({ id: h.id, rank: 0, k, ready: sim.t + HOT_NOTICE,
      change: plan => { swapTails(plan, tr.block, taken, h.block, own); plan.trips[lastKept].standby = true; },
      retask: () => {
        const T = sim.plan.trips[tail[k]].from;
        callOut(sim, h, tail[k]);
        extendTrainTasks(sim, tr, lastKept);
        setTripFromTasks(sim, tr);
        const name = sim.topo.stations[T].name;
        const msg = `${name}热备车${h.svc}（${h.vehicle}）接替${sim.plan.trips[tail[k]].no}起车次；列车${tr.svc}（${tr.vehicle}）预计晚点${Math.round(late / 60)}分钟，到达${name}后转为热备`;
        sim.log('C', '运营', `终点站换车：${msg}`, { key: `hotswap-${h.id}-${tail[k]}` });
        return { ok: true, msg };
      } });
  }
  return out;
}

/** The train on its way into, or standing at, terminal T at the end of its
 * duty to stable there; it could leave again in direction `dir` after a
 * turnback. */
function stablesAt(sim: Sim, r: Train, T: number, dir: TrackDir): boolean {
  const b = sim.plan.blocks[r.block], arrival = r.tasks[0], trip = sim.plan.trips[r.tripId];
  if (!b || !trip || b.end.kind !== 'stable' || b.end.station !== T || arrival?.k !== 'stop' || arrival.station !== T
    || arrival.trip !== r.tripId || arrival.dep !== null || trip.to !== T || trip.dir === dir) return false;
  return from(sim.plan, b, r.tripId).every(id => id === r.tripId)
    && r.tasks.slice(1).every(t => t.k === 'stable' || (t.k === 'stop' || t.k === 'reverse') && t.station === T);
}

const firstReadyAt = (sim: Sim, T: number) => hotStandbyPlaces(sim.topo).some(p => p.station === T && p.firstReady);

/** Tier 1 for a late train (D148 先到先发, D156): at a first-ready terminal,
 * the train standing there with the next own departure takes the late
 * train's due one, and the late train takes that later one. A train
 * arriving there to stable ranks after every such departure: it takes the
 * late train's duty, and the late train stables in its place. */
function firstReadyOffers(sim: Sim, tr: Train, tail: number[], minK: number, late: number): Offer[] {
  const keeps = (id: number) => tr.tasks.findIndex(t => t.k === 'stop' && t.trip === id && t.dep === null);
  const out: Offer[] = [];
  for (let k = minK; k < tail.length; k++) {
    const D = sim.plan.trips[tail[k]];
    if (D.completed || D.cancelled) continue;
    const T = D.from, due = D.stops[0].dep;
    const lastKept = k ? tail[k - 1] : tr.tripId;
    // A non-revenue departure (an empty move on to a later duty) passes only
    // to a stabler; otherwise the next departure is looked at as before.
    if (!firstReadyAt(sim, T) || keeps(lastKept) < 0) {
      if (!D.revenue) continue;
      break;
    }
    let best: { r: Train; index: number; trip: number; dep: number } | undefined;
    for (const r of sim.trainList) {
      if (r === tr || r.block < 0 || r.block === tr.block || r.failed || r.manual || r.withdrawn || r.relievedBy || r.coupledLen > 0
        || r.rescuing >= 0 || r.rescueBy >= 0) continue;
      const index = r.tasks.findIndex(t => t.k === 'stop' && t.station === T && t.arr === null && t.dep !== null && t.trip >= 0);
      if (index < 0) {
        if (!best && stablesAt(sim, r, T, D.dir)) best = { r, index: 0, trip: -1, dep: Infinity };
        continue;
      }
      if (!D.revenue) continue;
      const own = r.tasks[index] as StopTask, trip = sim.plan.trips[own.trip];
      // standing at this terminal now: only its arrival, turnback and departure there
      if (trip.from !== T || trip.dir !== D.dir || own.dep! <= due) continue;
      if (!r.tasks.slice(0, index).every(t => (t.k === 'stop' || t.k === 'reverse') && t.station === T)) continue;
      if (!best || own.dep! < best.dep) best = { r, index, trip: own.trip, dep: own.dep! };
    }
    if (!best) {
      if (!D.revenue) continue;
      break;
    }
    const { r, index } = best, stabler = best.trip < 0;
    const own = stabler ? [] : from(sim.plan, sim.plan.blocks[r.block], best.trip);
    const taken = tail.slice(k);
    out.push({ id: r.id, rank: stabler ? 1.5 : 1, k, ready: sim.t,
      change: plan => swapTails(plan, tr.block, taken, r.block, own),
      retask: () => {
        const br = sim.plan.blocks[r.block];
        if (stabler) {
          // its stabling steps there pass to the late train
          const ending = r.tasks.slice(1);
          extendTrainTasks(sim, r, r.tripId);
          extendTrainTasks(sim, tr, lastKept, ending);
        } else {
          r.tasks = [...r.tasks.slice(0, index), ...blockTasks(sim.topo, sim.plan, br, br.trips.indexOf(tail[k]))];
          extendTrainTasks(sim, tr, lastKept);
        }
        setTripFromTasks(sim, r);
        setTripFromTasks(sim, tr);
        const name = sim.topo.stations[T].name;
        const then = stabler ? `到达后在${name}存车` : `改接${sim.plan.trips[best!.trip].no}`;
        const msg = `${name}先到先发：列车${r.svc}（${r.vehicle}）接${D.no}；列车${tr.svc}（${tr.vehicle}）预计晚点${Math.round(late / 60)}分钟，${then}`;
        sim.log('C', '运营', `终点站换车：${msg}`, { key: `firstready-${r.id}-${D.id}` });
        return { ok: true, msg };
      } });
  }
  return out;
}

/** Tier 2 for a late train: a yard spare takes over from its next departure
 * it can make on time; the late train keeps the trips before it, then is
 * withdrawn at the end of the last one (`standbyTick`). */
function yardReliefOffer(sim: Sim, tr: Train, tail: number[], minK: number, late: number): Offer[] {
  const T = sim.plan.trips[tail[minK]]?.from;
  if (T !== undefined && firstReadyAt(sim, T))
    sim.log('B', '运营', `${sim.topo.stations[T].name}备车位已用、无先到列车可接：列车${tr.svc}预计晚点${Math.round(late / 60)}分钟`,
      { key: `standby-short-${T}-${tail[minK]}` });
  const c = findStandby(sim, tr.block, tail, minK);
  if (!c) return [];
  const lastKept = c.k ? tail[c.k - 1] : tr.tripId;
  const cut = tr.tasks.findIndex(t => t.k === 'stop' && t.trip === lastKept && t.dep === null);
  if (cut < 0) return [];
  const from = tr.block;
  return [{ id: -1, rank: 2, k: c.k, ready: c.start, checked: true,
    change: plan => applyYard(sim, plan, from, tail, c).id,
    retask: id => {
      const block = sim.plan.blocks[id as number];
      const skipped = c.k ? `；此前${c.k}趟来不及接替，仍取消` : '';
      sim.log('C', '运营', `备车顶替：${sim.topo.depots[c.depot].name}备车表号${block.svc}接替${sim.plan.trips[tail[c.k]].no}起${tail.length - c.k}趟车次（列车${tr.svc}预计晚点${Math.round(late / 60)}分钟）${skipped}`,
        { key: `standby-${block.id}` });
      tr.tasks = tr.tasks.slice(0, cut + 1);
      const keep = new Set(tr.tasks.flatMap(t => t.k === 'stop' ? [t.berth] : []));
      for (const [berth, train] of sim.berthRes) if (train === tr.id && !keep.has(berth)) sim.berthRes.delete(berth);
      tr.relievedBy = block.svc;
      return { ok: true, msg: `备车表号${block.svc}接替${sim.plan.trips[tail[c.k]].no}起车次；本车运行至${sim.plan.trips[lastKept].no}终点后回段` };
    } }];
}

// ---------------------------------------------------------------- entry points

/** R3: hand the trips a lost train's cancellation dropped to a standby.
 * `tail` lists the trips of duty `from` that this loss cancelled. Applied only
 * by the automatic dispatcher; a trainee dispatcher adds trains by hand. */
export function standbyTakeover(sim: Sim, from: number, tail: number[], why: string): Block | null {
  if (!sim.autoDispatch || !tail.length) return null;
  let yard: Offer[] | undefined;
  const yardOffers = () => yard ??= yardTakeOffer(sim, from, tail, why);
  // the hot standby first, unless a yard standby makes an earlier trip
  const offer = allocate(sim, tail, [() => hotTakeOffers(sim, from, tail, why).filter(o => o.k <= (yardOffers()[0]?.k ?? tail.length)), yardOffers], false);
  if (!offer) return null;
  const before = sim.plan.blocks.length;
  commit(sim, offer);
  return offer.rank === 0 ? sim.plan.blocks[sim.trains.get(offer.id)!.block] : sim.plan.blocks[before] ?? null;
}

/** Trips of the train's duty after its current one that are still to run. */
function dutyTail(sim: Sim, tr: Train): number[] {
  if (tr.block < 0) return [];
  const trips = sim.plan.blocks[tr.block].trips;
  const idx = trips.indexOf(tr.tripId);
  return trips.slice(idx + 1).filter(id => !sim.plan.trips[id].cancelled && !sim.plan.trips[id].completed);
}

/** Predicted lateness (s) of the train's next own departure: the end of its
 * current trip at its present delay, plus the minimum turnback. */
export function predictedLateness(sim: Sim, tr: Train): number {
  const end = tr.tasks.findIndex(t => t.k === 'stop' && t.trip === tr.tripId && t.dep === null);
  const next = tr.tasks.find((t, i) => i > end && t.k === 'stop' && t.trip >= 0 && t.trip !== tr.tripId && t.dep !== null);
  if (next?.k !== 'stop' || next.dep === null) return 0;
  const last = end >= 0 ? tr.tasks[end] : undefined;
  if (last?.k !== 'stop' || last.arr === null) return 0;
  const ready = Math.max(sim.t, last.arr + Math.max(0, tr.delay)) + minTurn(last.station);
  return ready - next.dep;
}

/** D156: the train most late (beyond R1's threshold) for its next departure
 * from first-ready terminal T, where `r` now arrives to stable; relief for it
 * may let `r` take that departure. */
export function lateForStabler(sim: Sim, r: Train): Train | null {
  const T = r.tasks[0]?.k === 'stop' ? r.tasks[0].station : -1;
  if (!firstReadyAt(sim, T)) return null;
  let worst: { tr: Train; late: number } | null = null;
  for (const tr of sim.trainList) {
    if (tr === r || tr.failed || tr.manual || !tr.inService || tr.coupledLen > 0 || tr.withdrawn || tr.relievedBy
      || tr.rescuing >= 0 || tr.rescueBy >= 0) continue;
    const next = sim.plan.trips[dutyTail(sim, tr)[0]];
    if (!next || next.from !== T || !stablesAt(sim, r, T, next.dir)) continue;
    const late = predictedLateness(sim, tr);
    if (late > RELIEF_DELAY && (!worst || late > worst.late)) worst = { tr, late };
  }
  return worst?.tr ?? null;
}

/** R1 relief (the `standby` command): the pool takes the late train's tail
 * in D148's order (hot standby, first-ready, yard spare). */
export function cmdStandbyRelief(sim: Sim, tr: Train): Result {
  const expired = expiredStablingExchange(sim, tr);
  if (expired) return expired;
  if (tr.failed || tr.manual || tr.coupledLen > 0 || !tr.inService || tr.block < 0 || tr.rescuing >= 0 || tr.rescueBy >= 0)
    return { ok: false, msg: '仅对正常载客运行的计划列车办理备车接替' };
  if (tr.relievedBy) return { ok: false, msg: `已由备车表号${tr.relievedBy}接替` };
  const tail = dutyTail(sim, tr);
  if (!tail.length) return { ok: false, msg: '本车底无后续车次' };
  // The late train must still be able to stop at the end of what it keeps.
  const minK = tr.tasks.findIndex(t => t.k === 'stop' && t.trip === tr.tripId && t.dep === null) >= 0 ? 0 : 1;
  const late = predictedLateness(sim, tr);
  const offer = allocate(sim, tail, [
    () => hotSwapOffers(sim, tr, tail, minK, late),
    () => firstReadyOffers(sim, tr, tail, minK, late),
    () => yardReliefOffer(sim, tr, tail, minK, late),
  ], true);
  return offer ? commit(sim, offer) : { ok: false, msg: '无可正点接替的备车' };
}

// ---------------------------------------------------------------- stabling exchange (D166)

/** Read the same reservation calendar used by planning; do not attempt a
 * dispatcher command for a train merely because another train is stabled. */
function stablingExchangeCandidate(sim: Sim, incoming: Train) {
  if (incoming.failed || incoming.manual || incoming.coupledLen > 0 || incoming.withdrawn || incoming.block < 0) return null;
  if (incoming.rescuing >= 0 || incoming.rescueBy >= 0 || incoming.tasks.some(t => t.k === 'rescue')) return null;
  const arrival = incoming.tasks[0];
  if (arrival?.k !== 'stop' || arrival.dep !== null || arrival.trip !== incoming.tripId || arrival.berth < 0) return null;
  const held = sim.trains.get(incoming.halt.train);
  if (!held || held.id===incoming.id || held.phase!=='stabled' || held.failed || held.manual || held.block<0 || held.tasks.length) return null;
  const a=sim.plan.blocks[held.block], b=sim.plan.blocks[incoming.block];
  if (!a || !b || a.id===b.id || a.end.kind!=='stable' || a.end.berth===undefined) return null;
  const position=sim.topo.berths[a.end.berth],target=sim.topo.berths[arrival.berth];
  if (!position || !target || position.link!==target.link || held.link!==position.link) return null;
  const heldSlot=storageOccupancy(sim.topo,sim.plan).find(x=>x.block===a.id && x.link===position.link && x.morning===false);
  if(!heldSlot || (sim.t<heldSlot.to && (arrival.arr===null || arrival.arr>=heldSlot.from))) return null;
  const tail=dutyTail(sim,incoming),first=sim.plan.trips[tail[0]];
  if(!first){
    const last=a.trips.map(id=>sim.plan.trips[id]).filter(t=>t&&!t.cancelled).at(-1);
    if(b.end.kind!=='depot'||!last||last.to!==arrival.station||position.kind!=='platform')return null;
    return {arrival,held,a,b,heldSlot,tail,first:undefined,destination:a.end,depot:b.end.depot};
  }
  if(first.cancelled || first.from!==arrival.station) return null;
  const index=incoming.tasks.findIndex(t=>t.k==='stop' && t.trip===first.id && t.dep!==null);
  if(index<0 || !incoming.tasks.slice(1,index).every(t=>t.k==='reverse'&&t.station===arrival.station))return null;
  return {arrival,held,a,b,heldSlot,tail,first,destination:a.end,depot:undefined};
}

export function canExchangeStabling(sim: Sim, incoming: Train): boolean {
  return stablingExchangeCandidate(sim,incoming)!==null;
}

/** The held stabled car takes the incoming train's tail and the incoming
 * train stables in its place, in one step, after the held car's reservation
 * expired. */
function expiredStablingExchange(sim: Sim, incoming: Train): Result | null {
  const candidate=stablingExchangeCandidate(sim,incoming);
  if(!candidate)return null;
  const {arrival,held,a,b,heldSlot,tail,first,destination,depot}=candidate;
  const mutate=(plan:Plan,notBefore?:number)=>{
    const p=plan.blocks[a.id],q=plan.blocks[b.id];
    q.trips=q.trips.filter(id=>!tail.includes(id));p.trips.push(...tail);
    for(const id of tail)plan.trips[id].block=p.id;
    [p.end,q.end]=[q.end,p.end];p.train=held.id;
    if(q.end.kind==='stable')q.end={...q.end,holdFrom:heldSlot.from,holdUntil:heldSlot.to};
    if(depot!==undefined){
      q.relieved=false;
      const previous=p.trips.map(id=>plan.trips[id]).filter(t=>t&&!t.cancelled).at(-1);
      if(!previous||notBefore===undefined)return undefined;
      const move=clearOnToYard(sim.planCtx,plan.trips,p,previous,{depot,notBefore});
      if(!move||!move.revenue)return undefined;
      move.no=`${previous.no}续`;return move;
    }
    return first;
  };
  let preview:Plan|undefined, chosen:Trip|undefined,notBefore:number|undefined;
  for(let at=sim.t+STANDBY_NOTICE;at<=sim.t+STANDBY_NOTICE+900;at+=30){
    const proposed=structuredClone(sim.plan),move=mutate(proposed,depot===undefined?undefined:at);
    if(!move){if(depot===undefined)break;continue;}
    if(noWorse(sim,proposed,new Set([a.id]))){preview=proposed;chosen=move;notBefore=at;break;}
    if(depot===undefined)break;
  }
  if(!preview||!chosen)return {ok:false,msg:`存车预约交换不可行：列车${held.svc}占用${sim.topo.berths[destination.berth!].name}，${depot===undefined?'原接续未通过预检':'没有可行载客回段接续'}`};
  const committed=mutate(sim.plan,notBefore)!;
  const tasks=blockTasks(sim.topo,sim.plan,a,a.trips.indexOf(committed.id));
  const travel=travelDirection(sim.topo,held);
  if(travel!==committed.dir){
    const departure=tasks.find(t=>t.k==='stop');
    if(departure?.k==='stop')departure.berth=departureBerthAfterReverse(sim.topo,destination.berth!,departure.berth);
    tasks.unshift({k:'reverse',station:destination.station,berths:[destination.berth!],chosen:destination.berth!,minTime:40});
  }else if(depot!==undefined){
    const departure=tasks.find(t=>t.k==='stop');
    if(departure?.k==='stop')departure.berth=destination.berth!;
  }
  held.tasks=tasks;held.phase='run';held.phaseSince=sim.t;held.inService=true;sim.blockDone.delete(a.id);
  incoming.tasks=[arrival,{k:'stable',berth:destination.berth!,station:destination.station,reason:'存车'}];
  if(depot!==undefined)delete incoming.relievedBy;
  setTripFromTasks(sim,held);setTripFromTasks(sim,incoming);sim.planRev++;sim.planDirty=true;
  const msg=`${sim.topo.stations[destination.station].name}过期存车交换：${held.svc}接${committed.no}，${incoming.svc}到达后存车`;
  sim.log('C','运营',msg,{key:`expired-slot-${held.id}-${incoming.id}`});
  return {ok:true,msg};
}

// ---------------------------------------------------------------- cars leaving the pool

/** A relieved train that has finished its last kept trip returns to the yard.
 * So does one whose duty ends there with no home at all (a plan defect, never
 * planned on purpose): degraded to a system withdrawal with an alarm, rather
 * than a train standing on the line with no task. */
export function standbyTick(sim: Sim) {
  for (const tr of sim.trainList) {
    const stop = tr.tasks[0];
    if (tr.withdrawn || tr.phase !== 'dwell' || tr.tasks.length !== 1 || stop?.k !== 'stop' || stop.dep !== null) continue;
    const homeless = !tr.relievedBy && tr.block >= 0 && sim.plan.blocks[tr.block]?.end.kind === 'none';
    if (!tr.relievedBy && !homeless) continue;
    // 5 s after arrival, then once a minute while the withdrawal is refused
    if (Math.floor(sim.t - tr.phaseSince) % 60 !== 5) continue;
    if (homeless) sim.log('C', '运营', `列车 ${tr.svc}（${tr.vehicle}）车底运用无回段或存车安排，系统安排回段`,
      { key: `duty-no-home-${tr.id}`, train: tr.id });
    sim.command({ c: 'withdraw', train: tr.id, reason: homeless ? '车底运用无回段安排' : `后续车次已由备车表号${tr.relievedBy}接替` }, '系统');
  }
  returnIdleStock(sim);
}

/** 用户决定（2026-11-05，D177）：存车没有后续任务、却占着另一列车计划的存车位时，
 * 那列车一开始跑最后一趟，存车就自动回段；不等它到站后在门口等一夜。 */
function returnIdleStock(sim: Sim) {
  if (Math.floor(sim.t) % 60 !== 17) return;
  for (const claimant of sim.trainList) {
    if (!claimant.tasks.every(t => t.k !== 'stop' || t.dep === null || t.trip === claimant.tripId)) continue;
    const stable = claimant.tasks.find(t => t.k === 'stable' && t.berth >= 0);
    if (stable?.k !== 'stable') continue;
    const idle = sim.trains.get(berthHolder(sim, stable.berth, claimant.id, true));
    // (a parked hot standby inside its window is on duty, not idle)
    if (!idle || idle.id === claimant.id || idle.phase !== 'stabled' || idle.tasks.length || idle.failed || idle.coupledLen > 0
      || hotStandby(sim, idle)) continue;
    const place = sim.topo.berths[stable.berth].name;
    const r = sim.command({ c: 'withdraw', train: idle.id, reason: `让出${place}供列车${claimant.svc}存车` }, '系统');
    if (!r.ok) sim.log('B', '运营', `无任务存车 ${idle.svc}（${idle.vehicle}）占用${place}，自动回段未办成：${r.msg}`, { key: `idle-stock-${idle.id}` });
  }
}
