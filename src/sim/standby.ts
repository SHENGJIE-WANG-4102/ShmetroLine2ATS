/**
 * Standby trains (备车, D45). A spare vehicle in a yard takes over planned
 * service instead of the service being lost:
 *
 *  R3 takeover: a duty loses its train (withdrawal, rescue duty, failed train
 *     taken home). The trips that loss cancelled are handed to a standby from
 *     the earliest one it can start on time; earlier ones stay cancelled.
 *  R1 relief: a train will start its next own trip more than RELIEF_DELAY
 *     late. A standby takes over from that departure, on time; the late train
 *     finishes the trips it keeps and returns to the yard.
 *
 * A takeover is a plan change like an added train: the standby's empty move
 * from the yard keeps the minimum headway and the declared turnback time
 * (`standbyCandidate`), and the changed plan must add no validator error and
 * keep every yard's stock non-negative before it is applied.
 *
 * The hot standby (热备, D70) at a line end goes first: crewed in its turnback
 * track, it needs HOT_NOTICE to be ready and takes a departure from its own
 * station. In R1 it swaps duties with the late train arriving there, which
 * becomes the hot standby in its place (终点站换车); in R3 it takes the lost
 * trips, and a yard standby covers its own later duty.
 */
import type { Sim } from './engine';
import type { Block, Plan, Train } from './model';
import { applyStandby, standbyCandidate, minTurn, blockTasks, hotStandbyPlaces, type StandbyPlan } from './timetable';
import { noWorse } from './planning';
import { extendTrainTasks, setTripFromTasks } from './ats';

/** Notice a standby needs before leaving the yard (s). */
export const STANDBY_NOTICE = 300;
/** Predicted lateness of a train's next own departure that calls a standby (s). */
export const RELIEF_DELAY = 300;

/** Notice a hot standby needs: crew to the leading cab, train woken up (s). */
export const HOT_NOTICE = 150;
/** From its turnback track onto the departure platform (s). */
const HOT_PULL_OUT = 90;


/** A hot standby standing in its turnback track (D70): its station and the
 * trip it stands for; null for any other train. */
export function hotStandby(sim: Sim, tr: Train): { station: number; trip: number } | null {
  const t0 = tr.tasks[0];
  if (tr.failed || tr.manual || tr.withdrawn || tr.coupledLen > 0 || tr.block < 0 || tr.relievedBy) return null;
  if (t0?.k !== 'stop' || !t0.standby || t0.dep === null || t0.trip < 0 || tr.phase !== 'run' || tr.v > 0.05) return null;
  const place = hotStandbyPlaces(sim.topo).find(p => (p.depot ? [p.berth] : sim.topo.stations[p.station].turnbackBerths)
    .some(b => sim.topo.berths[b].link === tr.link));
  return place ? { station: place.station, trip: t0.trip } : null;
}

/** live trips of duty `b` from `trip` on */
function from(plan: Plan, b: Block, trip: number): number[] {
  return b.trips.slice(b.trips.indexOf(trip)).filter(id => !plan.trips[id].cancelled && !plan.trips[id].completed);
}

/** The first trip of `tail` (from `minK`) a hot standby can take on time:
 * the standby, the index, and its own later duty. */
function hotCandidate(sim: Sim, tail: number[], minK = 0): { h: Train; k: number; own: number[]; cut: number }[] {
  const out: { h: Train; k: number; own: number[]; cut: number }[] = [];
  for (const h of sim.trainList) {
    const at = hotStandby(sim, h);
    if (!at) continue;
    for (let k = minK; k < tail.length; k++) {
      const D = sim.plan.trips[tail[k]];
      if (!D.revenue || D.completed) continue;
      const cut = D.stops.findIndex(s => s.st === at.station && s.stop && s.st !== D.to);
      if (cut < 0 || D.stops[cut].dep < sim.t + HOT_NOTICE + HOT_PULL_OUT) continue;
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
function recoveredTail(sim: Sim, plan: Plan, tail: number[], k: number, cut: number): number[] {
  const taken = tail.slice(k);
  const original = plan.trips[taken[0]];
  const place = hotStandbyPlaces(sim.topo).find(p => p.station === original.stops[cut].st);
  if (!cut && place?.track !== 'storage') return taken;
  const stops = original.stops.slice(cut).map(s => ({ ...s }));
  stops[0].arr = stops[0].dep;
  if (place?.track === 'storage') { stops[0].stop = false; stops[0].noBoard = true; }
  const suffix = { ...original, id: plan.trips.length, no: `${original.no}续`, from: stops[0].st, stops, cancelled: false };
  delete suffix.cancelReason;
  plan.trips.push(suffix);
  // moveTrips also removes the original cancelled trip from its old duty.
  plan.blocks[original.block].trips.push(suffix.id);
  taken[0] = suffix.id;
  return taken;
}

/** move `taken` (trips of block `src`, its last ones) to the end of block `dst` */
function moveTrips(plan: Plan, src: number, taken: number[], dst: number) {
  const s = plan.blocks[src], d = plan.blocks[dst];
  for (const id of taken) { const t = plan.trips[id]; t.block = dst; t.cancelled = false; delete t.cancelReason; }
  s.trips = s.trips.filter(id => !taken.includes(id));
  d.trips.push(...taken);
  d.end = s.end;
}

/** the hot standby `h` leaves its track for the duty it now has, from `trip` */
function callOut(sim: Sim, h: Train, trip: number) {
  const b = sim.plan.blocks[h.block];
  // (its departure stop stays a standby's: it is called up to the platform
  // STANDBY_CALL before, no earlier than the notice allows)
  h.tasks = blockTasks(sim.topo, sim.plan, b, b.trips.indexOf(trip));
  setTripFromTasks(sim, h);
  sim.planRev++;
  sim.planDirty = true;
}

/** R3 by the hot standby: it takes the lost trips from the first it can make
 * from its station; a yard standby takes over its own later duty, or nothing
 * is changed. */
function hotTakeover(sim: Sim, from: number, tail: number[], why: string, depotK: number): Block | null {
  for (const { h, k, own, cut } of hotCandidate(sim, tail)) {
    if (k > depotK) break;
    if (!own.length) continue;
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
    const cover = findStandby(sim, h.block, own, 0, 0, finish, positioningOnly);
    if (!cover || cover.k) continue;
    const change = (plan: Plan) => {
      applyStandby(plan, h.block, own, cover);
      return finish(plan);
    };
    const plan = structuredClone(sim.plan);
    change(plan);
    if (!noWorse(sim, plan)) continue;
    const T = sim.plan.trips[tail[k]].stops[cut].st;
    const first = change(sim.plan);
    callOut(sim, h, first);
    const skipped = k ? `；此前${k}趟来不及接替，仍取消` : '';
    sim.log('C', '运营', `热备车顶替：${sim.topo.stations[T].name}热备车${h.svc}（${h.vehicle}）接替${sim.plan.trips[tail[k]].no}起${tail.length - k}趟车次（${why}）${skipped}`,
      { key: `hot-${h.id}-${tail[k]}` });
    return sim.plan.blocks[h.block];
  }
  return null;
}

/** The standby that takes over `tail` (live trip ids of duty `from`, in
 * order), validated on a copy of the plan; null when none can. */
export function findStandby(sim: Sim, from: number, tail: number[], minK = 0, maxK = tail.length - 1, amend?: (plan: Plan) => unknown, allowPositioning = false): StandbyPlan | null {
  if (!tail.length || minK > maxK) return null;
  // The standby inherits the duty's end (its return to the yard or stabling),
  // so it takes over only a tail that runs to the end of the duty. A relieved
  // train's kept trips end in a withdrawal instead.
  const block = sim.plan.blocks[from];
  if (block.relieved || tail[tail.length - 1] !== block.trips.at(-1)) return null;
  const { topo } = sim;
  const origin = topo.stations[sim.plan.trips[tail[minK]].from].chain;
  const depots = topo.depots.map((d, i) => ({ i, dist: Math.abs(d.junctionChain - origin) }))
    .filter(d => sim.depotStock[d.i] > 0).sort((a, b) => a.dist - b.dist).map(d => d.i);
  if (!depots.length) return null;
  const notBefore = sim.t + STANDBY_NOTICE;
  const next = new Map(depots.map(d => [d, minK]));
  for (let guard = 0; guard < depots.length * tail.length; guard++) {
    let best: StandbyPlan | null = null;
    for (const d of depots) {
      const k0 = next.get(d)!;
      if (k0 > maxK) continue;
      const c = standbyCandidate(sim.planCtx, sim.plan, tail, d, notBefore, k0, maxK, allowPositioning);
      if (!c) { next.set(d, maxK + 1); continue; }
      // earliest takeover first; between yards, the nearest
      if (!best || c.k < best.k) best = c;
    }
    if (!best) return null;
    const plan = structuredClone(sim.plan);
    applyStandby(plan, from, tail, best);
    amend?.(plan);
    // (a yard imbalance the plan already had, with the same counts, does not
    // block a takeover; one it creates or changes does)
    if (noWorse(sim, plan)) return best;
    next.set(best.depot, best.k + 1);
  }
  return null;
}

function apply(sim: Sim, from: number, tail: number[], c: StandbyPlan, why: string): Block {
  const block = applyStandby(sim.plan, from, tail, c);
  sim.planRev++;
  sim.planDirty = true;
  const first = sim.plan.trips[tail[c.k]];
  const skipped = c.k ? `；此前${c.k}趟来不及接替，仍取消` : '';
  sim.log('C', '运营', `备车顶替：${sim.topo.depots[c.depot].name}备车表号${block.svc}接替${first.no}起${tail.length - c.k}趟车次（${why}）${skipped}`,
    { key: `standby-${block.id}` });
  return block;
}

/** R3: hand the trips a lost train's cancellation dropped to a standby.
 * `tail` lists the trips of duty `from` that this loss cancelled. Applied only
 * by the automatic dispatcher; a trainee dispatcher adds trains by hand. */
export function standbyTakeover(sim: Sim, from: number, tail: number[], why: string): Block | null {
  if (!sim.autoDispatch || !tail.length) return null;
  const c = findStandby(sim, from, tail);
  // the hot standby first, unless a yard standby makes an earlier trip
  const hot = hotTakeover(sim, from, tail, why, c?.k ?? tail.length);
  if (hot) return hot;
  return c ? apply(sim, from, tail, c, why) : null;
}

/** R1 at a line end (终点站换车): the hot standby there takes the late train's
 * duty from its first departure there it can make on time; the late train
 * turns into the standby's track and stands for the standby's own duty. */
function hotSwap(sim: Sim, tr: Train, tail: number[], minK: number, late: number): { ok: boolean; msg: string } | null {
  const keeps = (id: number) => tr.tasks.findIndex(t => t.k === 'stop' && t.trip === id && t.dep === null);
  for (const { h, k, own, cut } of hotCandidate(sim, tail, minK)) {
    if (cut || hotStandbyPlaces(sim.topo).some(p => p.depot && p.station === sim.plan.trips[tail[k]].from)) continue;
    if (!own.length) continue;
    const lastKept = k ? tail[k - 1] : tr.tripId;
    if (keeps(lastKept) < 0) continue;
    const swap = (plan: Plan) => {
      const taken = tail.slice(k);
      const bx = plan.blocks[tr.block], bh = plan.blocks[h.block];
      const [endX, endH] = [bx.end, bh.end];
      for (const id of taken) plan.trips[id].block = bh.id;
      for (const id of own) plan.trips[id].block = bx.id;
      bx.trips = [...bx.trips.filter(id => !taken.includes(id)), ...own];
      bh.trips = [...bh.trips.filter(id => !own.includes(id)), ...taken];
      bx.end = endH;
      bh.end = endX;
      plan.trips[lastKept].standby = true;
    };
    const plan = structuredClone(sim.plan);
    swap(plan);
    if (!noWorse(sim, plan)) continue;
    swap(sim.plan);
    const T = sim.plan.trips[tail[k]].from;
    callOut(sim, h, tail[k]);
    extendTrainTasks(sim, tr, lastKept);
    setTripFromTasks(sim, tr);
    const name = sim.topo.stations[T].name;
    const msg = `${name}热备车${h.svc}（${h.vehicle}）接替${sim.plan.trips[tail[k]].no}起车次；列车${tr.svc}（${tr.vehicle}）预计晚点${Math.round(late / 60)}分钟，到达${name}后转为热备`;
    sim.log('C', '运营', `终点站换车：${msg}`, { key: `hotswap-${h.id}-${tail[k]}` });
    return { ok: true, msg };
  }
  return null;
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

/** R1 relief: a standby takes over from the late train's next departure it
 * can make on time; the late train keeps the trips before it, then is
 * withdrawn at the end of the last one (`standbyTick`). */
export function cmdStandbyRelief(sim: Sim, tr: Train) {
  if (tr.failed || tr.manual || tr.coupledLen > 0 || !tr.inService || tr.block < 0)
    return { ok: false, msg: '仅对正常载客运行的计划列车办理备车接替' };
  if (tr.relievedBy) return { ok: false, msg: `已由备车表号${tr.relievedBy}接替` };
  const tail = dutyTail(sim, tr);
  if (!tail.length) return { ok: false, msg: '本车底无后续车次' };
  const keeps = (id: number) => tr.tasks.findIndex(t => t.k === 'stop' && t.trip === id && t.dep === null);
  // The late train must still be able to stop at the end of what it keeps.
  const minK = keeps(tr.tripId) >= 0 ? 0 : 1;
  const late = predictedLateness(sim, tr);
  const hot = hotSwap(sim, tr, tail, minK, late);
  if (hot) return hot;
  const c = findStandby(sim, tr.block, tail, minK);
  if (!c) return { ok: false, msg: '无可正点接替的备车' };
  const lastKept = c.k ? tail[c.k - 1] : tr.tripId;
  const cut = keeps(lastKept);
  if (cut < 0) return { ok: false, msg: '列车已驶离保留车次终点' };
  const block = apply(sim, tr.block, tail, c, `列车${tr.svc}预计晚点${Math.round(late / 60)}分钟`);
  tr.tasks = tr.tasks.slice(0, cut + 1);
  const keep = new Set(tr.tasks.flatMap(t => t.k === 'stop' ? [t.berth] : []));
  for (const [berth, train] of sim.berthRes) if (train === tr.id && !keep.has(berth)) sim.berthRes.delete(berth);
  tr.relievedBy = block.svc;
  return { ok: true, msg: `备车表号${block.svc}接替${sim.plan.trips[tail[c.k]].no}起车次；本车运行至${sim.plan.trips[lastKept].no}终点后回段` };
}

/** A relieved train that has finished its last kept trip returns to the yard. */
export function standbyTick(sim: Sim) {
  for (const tr of sim.trainList) {
    const stop = tr.tasks[0];
    if (!tr.relievedBy || tr.withdrawn || tr.phase !== 'dwell' || tr.tasks.length !== 1 || stop?.k !== 'stop' || stop.dep !== null) continue;
    // 5 s after arrival, then once a minute while the withdrawal is refused
    if (Math.floor(sim.t - tr.phaseSince) % 60 !== 5) continue;
    sim.command({ c: 'withdraw', train: tr.id, reason: `后续车次已由备车表号${tr.relievedBy}接替` }, '系统');
  }
}
