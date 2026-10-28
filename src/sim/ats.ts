import { unattended } from '../data/current';
import { utoBusy, utoVehicleWait, utoDoorWarningReady, beginUtoReturn, requestUtoControl, crewLabel, computerCrew } from './uto';
import { doorCloseHold, departureHold, DOOR_CUT_DWELL } from './vehicle';
/**
 * ATS: train spawning from the plan, task execution (dwell, turnback, depot),
 * automatic route setting (ARS) with plan-order arbitration, dwell
 * regulation and dispatcher train commands.
 */
import type { Sim } from './engine';
import { cancelTrip, type Block, type DepotTask, type StopTask, type Task, type Train, type Trip, type TrackDir } from './model';
import { settleDroppedCalls } from './connections';
import type { Dir, Topology, TrackPoint, RouteStep } from './topology';
import { nextLink, travelDirection, ahead, reversedBerthPoint } from './topology';
import { cancelRoute as cancelInterlockedRoute, swPos, trySetRoute, releaseRoute, approachLocked, bindRouteApproach, committedTrain, relockRescueApproach, signalPassed, type CmdResult } from './interlocking';
import { computeBody, reverseTrain, goalBerth, stopError, berthError, moveBack, rescueRouteReady, reversePermission, retreatRouteBlocker } from './movement';
import { takeVehicle, putVehicle, peekVehicle } from './yard';
import { callRmPreset, unsafeAhead, openCall } from './radio';
import { applyEB, grantRM, setMode, distToNextSignal, turnbackDwell, simulatedAmDriver, driverTurnbackKind } from './onboard';
import { openDoors, closeDoors, psdSafe, doorOpenExtra } from './psd';
import { blockTasks, addTurnback, turnbackAt, buildStops, platformBerth, entryStation, departureBerthAfterReverse, depotTasks, DEPOT_ENTRY_CLEAR, serviceEnd, overnightPlaces, effectiveStops, effectiveEnd, effectiveTrip } from './timetable';
import { STATIONS, LINE_INFO, OPERATIONS } from '../data/current';
import { boardAndAlight, boardWhileOpen, planPassengerExchange, exchangeDwell } from './passengers';
import { dmiNote } from './dmi';
import { DOOR_CLOSE_S, PLANNED_CLOSE_BUDGET, MIN_DWELL, regulatedDwell, meanRange } from './calibration';
import { BYPASS_EXTRA, PSL_EXTRA } from './psd';
import { newHalt, rootCause, type ArsWait, type HaltCode, type WaitAlternative } from './halt';
import { standsAt } from './operatingDay';
import { standbyTakeover } from './standby';
import { recordTransition } from './invariants';
import { TURNBACK } from './fsm';
import { canStopBeforeSignal } from './protection';
import { arbitrateResources, resourceAllocation, routeResourceBlocker, adoptSpawnResources, resourceRouteReserved, resourceWaitDetail, sourceReadyAt, sourceWaitReason, routeNeedsResourceProtection, resourceAdmissionBlocked } from './resourceArbitration';
import { plannedWaitLong, plannedWaitBerth } from './plannedWaitBerth';
import { routePathStart, walkRouteToBerth, type TaskPathVisitor } from './routePath';
export type { RouteTable, TaskPathVisitor } from './routePath';

/** Every actual turnback stage is observed at the event, including atomic platform turns. */
function setTurnbackStage(sim: Sim, tr: Train, next: Train['tbStage']) {
  recordTransition(sim, TURNBACK, tr.id, tr.tbStage, next, tr);
  tr.tbStage = next;
}

// ---------------------------------------------------------------- route table

export { buildRouteTable } from './routeTable';

/** Physical distance, separate from the weighted route-choice cost. */
export function distanceToBerth(sim: Sim, sig: number, goal: number, visit?: TaskPathVisitor): number {
  return walkRouteToBerth(sim.topo, sim.routeTable, { signal: sig }, goal, visit);
}

/** does the route set at its start signal lead (reasonably) towards the goal berth? */
export function routeLeadsTo(sim: Sim, rid: number, goal: number): boolean {
  const r = sim.topo.routes[rid];
  if (r.berths.includes(goal)) return true;
  const dist = sim.routeTable.dist.get(goal);
  if (!dist) return true;
  const best = dist[r.start];
  if (best === Infinity) return true; // unknown: do not block
  if (r.end < 0) return false;
  const via = r.length + (r.wrongDir ? 6000 : 0) + (r.diverging ? 250 : 0) + dist[r.end];
  return via <= best * 1.25 + 300;
}

// ---------------------------------------------------------------- helpers

export function trainLabel(tr: Train) {
  return `${tr.svc}-${tr.tripNo}`;
}

function curStop(tr: Train): StopTask | null {
  const t = tr.tasks[0];
  return t && t.k === 'stop' ? t : null;
}

/** first signal ahead of an arbitrary point (following switch positions) */
export function signalAheadFrom(sim: Sim, link: number, off: number, dir: Dir, maxDist = 600): { sig: number; dist: number } | null {
  return pathBoundaryAhead(sim, link, off, dir, maxDist);
}

/** Physical task distance from the head, including a berth before the next
 * signal. Beyond that signal use the same planned path as ARS, irrespective
 * of whether its route has been set yet. */
export function distanceToBerthFrom(sim: Sim, link: number, off: number, dir: Dir, goal: number, visit?: TaskPathVisitor): number {
  const boundary = pathBoundaryAhead(sim, link, off, dir, Infinity, goal, visit);
  return boundary ? boundary.dist + (boundary.sig < 0 ? 0 : distanceToBerth(sim, boundary.sig, goal, visit)) : Infinity;
}

/** Walk the unsignalled part once for both ARS and arrival regulation. A
 * negative signal identifies the requested berth reached before a signal. */
function pathBoundaryAhead(sim: Sim, link: number, off: number, dir: Dir, maxDist: number, goal = -1, visit?: TaskPathVisitor): { sig: number; dist: number } | null {
  const { topo } = sim;
  const berth = goal >= 0 ? topo.berths[goal] : null;
  let l = link;
  let d0 = dir;
  if (berth?.link === l && berth.dir === d0) {
    visit?.(l, off, dir === 1 ? Math.max(off, berth.offset) : Math.min(off, berth.offset));
    return { sig: -1, dist: Math.max(0, (berth.offset - off) * d0) };
  }
  visit?.(l, off, d0 === 1 ? topo.links[l].len : 0);
  let dist = d0 === 1 ? topo.links[l].len - off : off;
  for (let i = 0; i < 30 && dist < maxDist; i++) {
    const nx = nextLink(topo, l, d0, (sw) => swPos(sim, sw));
    if (!nx) return null;
    const sid = topo.signalByEntry.get(nx.node * 65536 + nx.link);
    if (sid !== undefined) return { sig: sid, dist };
    l = nx.link;
    d0 = nx.dir;
    const entry = d0 === 1 ? 0 : topo.links[l].len;
    if (berth?.link === l && berth.dir === d0) {
      visit?.(l, entry, berth.offset);
      return { sig: -1, dist: dist + (d0 === 1 ? berth.offset : topo.links[l].len - berth.offset) };
    }
    visit?.(l, entry, d0 === 1 ? topo.links[l].len : 0);
    dist += topo.links[l].len;
  }
  return null;
}

/** berth occupied or reserved by another train? */
export function berthHolder(sim: Sim, berth: number, self: number, ignoreReservation = false): number {
  const res = sim.berthRes.get(berth);
  if (!ignoreReservation && res !== undefined && res !== self && sim.trains.has(res)) return res;
  const b = sim.topo.berths[berth];
  // the same platform faced the other way, reserved by a train already on its
  // wrong-direction way in (depot exit changing ends, station-front turnback)
  if (!ignoreReservation && b.kind === 'platform') for (const o of sim.topo.berths) {
    if (o.link !== b.link || o.id === berth) continue;
    const r = sim.berthRes.get(o.id);
    // Both directions name the same physical platform. The arbiter has
    // already bounded this grant to the current movement.
    if (r !== undefined && r !== self && sim.trains.has(r)) return r;
  }
  const sec = sim.topo.links[b.link].section;
  for (const lid of sim.topo.sections[sec].links) {
    const segs = sim.linkBodies.get(lid);
    const holder = segs?.find(s => s.train !== self);
    if (holder) return holder.train;
  }
  // a turnback berth on a depot lead: a train on the lead's transfer track
  // (coming out, or going in) needs the stub
  if (b.kind === 'siding') {
    for (const d of sim.topo.depots) for (const path of d.transferPaths) {
      if (path.stub !== b.link) continue;
      for (const lid of path.links) {
        const holder = sim.linkBodies.get(lid)?.find(s => s.train !== self);
        if (holder) return holder.train;
      }
    }
  }
  // a tail berth: a train anywhere else on that tail short of the berth (e.g.
  // stabled there) blocks it as well; one further in (蟠祥路's two-place
  // storage tail, the deeper place) does not
  if (b.kind === 'tail') {
    const bl = sim.topo.links[b.link];
    for (const l of sim.topo.links) {
      if (l.track !== bl.track || sim.topo.sections[l.section].kind !== 'tail' || Math.abs(l.chainA - bl.chainA) > 800) continue;
      if (l.id !== bl.id && Math.sign(l.chainA - bl.chainA) === b.dir) continue;
      const segs = sim.linkBodies.get(l.id);
      const holder = segs?.find(s => s.train !== self);
      if (holder) return holder.train;
    }
  }
  return -1;
}

/** Boolean and wait-for edge must describe the same occupied/reserved scope. */
export function berthBusy(sim: Sim, berth: number, self: number, ignoreReservation = false): boolean {
  return berthHolder(sim, berth, self, ignoreReservation) >= 0;
}

/** train that owns (or is about to use) an active route, -1 none */
export function routeUser(sim: Sim, rid: number): number {
  const ar = sim.routes.get(rid);
  if (!ar) return -1;
  if (ar.owner >= 0 && sim.trains.has(ar.owner)) return ar.owner;
  if (ar.arsTrain !== undefined && sim.trains.has(ar.arsTrain)) return ar.arsTrain;
  if (ar.committed >= 0 && sim.trains.has(ar.committed)) return ar.committed;
  for (const [i, s] of sim.topo.routes[rid].sections.entries()) {
    if (ar.released[i]) continue;
    for (const lid of sim.topo.sections[s].links) {
      const seg = sim.linkBodies.get(lid)?.[0];
      if (seg) return seg.train;
    }
  }
  const start = sim.topo.routes[rid].start;
  let best = -1;
  let bd = Infinity;
  for (const t of sim.trainList) if (t.nextSignal === start && t.nextSignalDist < bd) { bd = t.nextSignalDist; best = t.id; }
  if (best >= 0) return best;

  return -1;
}

/** Actual body identity, independent of a route's old paper applicant. */
export function sectionOccupant(sim: Sim, section: number, except = -1): number {
  for (const link of sim.topo.sections[section].links) {
    const body = sim.linkBodies.get(link)?.find(b => b.train !== except);
    if (body) return body.train;
  }
  return -1;
}

export function routeOccupant(sim: Sim, rid: number, except = -1): { train: number; section: number } | undefined {
  const active = sim.routes.get(rid);
  for (const [index, section] of sim.topo.routes[rid].sections.entries()) {
    if (active?.released[index]) continue;
    const train = sectionOccupant(sim, section, except);
    if (train >= 0) return { train, section };
  }
}

/** what stops a route from being set: the train holding a conflicting section / switch */
export function routeBlocker(sim: Sim, rid: number, self: number): { train: number; detail: string } {
  const { topo } = sim;
  const r = topo.routes[rid];
  const lockedBy = (route: number, detail: string) => {
    const occupied = routeOccupant(sim, route, self);
    if (occupied) return { train: occupied.train,
      detail: `${detail}，区段 ${topo.sections[occupied.section].name} 实占` };
    const train = routeUser(sim, route);
    if (train !== self) return { train, detail };
  };
  for (const s of r.sections) {
    const st = sim.sec[s];
    if (st.lockRoute >= 0 && st.lockRoute !== rid) {
      const blocked = lockedBy(st.lockRoute, `区段 ${topo.sections[s].name} 被进路 ${topo.routes[st.lockRoute].name} 锁闭`);
      if (blocked) return blocked;
    }
    if (st.trainOcc) {
      const train = sectionOccupant(sim, s, self);
      if (train >= 0) return { train, detail: `区段 ${topo.sections[s].name} 占用` };
    }
  }
  for (const { sw, pos } of r.switches) {
    const st = sim.sw[sw];
    if (st.lockCount > 0 && st.pos !== pos) {
      for (const [rid2] of sim.routes) {
        if (rid2 !== rid && topo.routes[rid2].switches.some((x) => x.sw === sw)) {
          const blocked = lockedBy(rid2, `道岔 ${topo.switches[sw].name} 被进路 ${topo.routes[rid2].name} 锁闭`);
          if (blocked) return blocked;
        }
      }
    }
  }
  return { train: -1, detail: '' };
}

/**
 * Infrastructure fault / protection that keeps a route from being set:
 * the train then waits on that cause (exempt from the liveness rule while the
 * fault and its recovery procedure last) rather than on a conflicting route.
 */
export function routeFaultCode(sim: Sim, rid: number): HaltCode | null {
  const r = sim.topo.routes[rid];
  if (sim.sig[r.start].failed) return 'SIGNAL_FAULT';
  for (const { sw } of r.switches) {
    const st = sim.sw[sw];
    // without detection only a guide route can be set over it (after field locking)
    if (st.failed) return 'SWITCH_FAULT';
    if (st.blocked) return 'BLOCKED';
  }
  for (const s of r.sections) {
    const st = sim.sec[s];
    if (st.poss >= 0) return 'POSSESSION';
    if (st.blocked) return 'BLOCKED';
    if (st.preset) return 'AXLE_PRESET';
    if (st.disturbed) return 'AXLE_FAULT';
    if (st.envTsr < 0) return 'WEATHER';
  }
  return null;
}

function setArsWait(sim: Sim, tr: Train, code: HaltCode, train: number, signal: number, detail = '', alternatives?: WaitAlternative[]) {
  const w: ArsWait = { code, train: train === tr.id ? -1 : train, signal, entrySignal: tr.nextSignal, t: sim.t, detail, alternatives };
  tr.arsWait = w;
}

/** ARS may release its own claim, or an unclaimed idle automatic route.
 * Yielding changes only this train: another train's claim/issued MA stays intact. */
export function cancelArsRoute(sim: Sim, tr: Train, signal: number): CmdResult & { blocker?: number } {
  const ar = sim.routes.get(sim.sig[signal].route);
  if (!ar) return { ok: false, msg: '无已建立进路' };
  // ARS must not force emergency braking by withdrawing its own route.
  const authorised = sim.trainList.find(t => t.maSigs.includes(signal) && !canStopBeforeSignal(sim,t,signal,'supervision'));
  if (authorised) return { ok: false, blocker: authorised.id, msg: `${sim.topo.signals[signal].name} 的已发授权收缩后，列车 ${trainLabel(authorised)} 将超出允许速度曲线` };
  const claims = [ar.arsTrain ?? -1, ar.owner, ar.committed];
  const other = claims.find(id => id >= 0 && id !== tr.id && sim.trains.has(id));
  const refuse = (blocker: number, detail: string) => {
    return { ok: false, blocker, msg: detail };
  };
  const occupied = routeOccupant(sim, ar.route);
  if (occupied) {
    const occupant = sim.trains.get(occupied.train);
    return refuse(occupied.train,
      `${sim.topo.signals[signal].name} 的进路由列车 ${occupant ? trainLabel(occupant) : occupied.train} 实占${sim.topo.sections[occupied.section].name}，不能取消`);
  }
  if (other !== undefined) {
    const t = sim.trains.get(other)!;
    return refuse(other, `${sim.topo.signals[signal].name} 的进路保留给列车 ${trainLabel(t)}`);
  }
  if (ar.manual) return refuse(-1, `${sim.topo.signals[signal].name} 已排人工进路`);
  const own = claims.includes(tr.id) || ((ar.arsTrain ?? -1) < 0 && routeUser(sim, ar.route) === tr.id);
  if (!own && (!(ar.fleeting || ar.defleeted) || approachLocked(sim, signal)))
    return refuse(routeUser(sim, ar.route), `${sim.topo.signals[signal].name} 的进路尚未空闲`);
  return cancelInterlockedRoute(sim, signal, { source: 'ars', train: tr.id });
}

/**
 * Task objects are shared with replay checkpoints (structural sharing), so
 * they are never mutated in place: a changed task replaces its array slot.
 */
export function cowTask<T extends Task>(tr: Train, task: T): T {
  const i = tr.tasks.indexOf(task);
  const copy = { ...task };
  if (i >= 0) tr.tasks[i] = copy;
  return copy;
}

/** The arbiter chooses a branch; retargeting still obeys route/MA locking. */
export function applyDepotChoice(sim: Sim, tr: Train, task: DepotTask, alt: number): boolean {
  const { topo } = sim, cur = depotBerth(topo, task);
  const oldTable = sim.routeTable.next.get(cur)!, newTable = sim.routeTable.next.get(alt)!;
  const changedRoutes = [...sim.routes.values()].filter(ar =>
    (ar.directionTrain === tr.id || ar.owner === tr.id || ar.committed === tr.id)
    && oldTable[topo.routes[ar.route].start] === ar.route && newTable[topo.routes[ar.route].start] !== ar.route);
  if (changedRoutes.some(ar => ar.manual || ar.entered || ar.committed >= 0
    || approachLocked(sim, topo.routes[ar.route].start)
    || topo.routes[ar.route].sections.some(sec => sim.sec[sec].trainOcc))) return false;
  for (const ar of changedRoutes)
    if (!cancelArsRoute(sim, tr, topo.routes[ar.route].start).ok || sim.routes.has(ar.route)) return false;
  cowTask(tr, task).berth = alt;
  return true;
}

function resolveChoice(sim: Sim, tr: Train, task0: Task): Task {
  let task = task0;
  if (task.k === 'reverse') {
    // Beyond the scissors the occupied physical track fixes the choice. A
    // rescue may have entered it under the failed train's existing route;
    // a reservation on the parallel tail cannot move it across afterwards.
    const link = sim.topo.links[tr.link];
    const kind = sim.topo.sections[link.section].kind;
    if (kind === 'tail' || kind === 'siding') {
      const physical = sim.topo.stations[task.station].turnbackBerths.find(id => {
        const berth = sim.topo.berths[id];
        return berth.dir === tr.dir && (berth.link === tr.link
          || kind === 'tail' && berth.kind === 'tail' && sim.topo.links[berth.link].track === link.track);
      });
      if (physical !== undefined && physical !== task.chosen) {
        if (sim.berthRes.get(task.chosen) === tr.id) sim.berthRes.delete(task.chosen);
        task = cowTask(tr, task); task.chosen = physical; task.berths = [physical];
      }
      if (physical !== undefined) {
        return task;
      }
    }
    // Candidate selection and reservation are performed together by the arbiter.
  }
  return task;
}

export function depotBerth(topo: Topology, task: { depot: number; berth?: number }): number {
  return task.berth !== undefined && task.berth >= 0 ? task.berth : topo.depots[task.depot].berth;
}

function taskGoal(sim: Sim, task: Task | undefined): number {
  if (!task) return -1;
  if (task.k === 'stop') return task.berth;
  if (task.k === 'reverse') return task.chosen;
  if (task.k === 'stable') return task.berth;
  if (task.k === 'depot') return depotBerth(sim.topo, task);
  if (task.k === 'rescue') {
    const f = sim.trains.get(task.target);
    if (!f) return -1;
    return -2;
  }
  return -1;
}

function plannedTime(task: Task | undefined, now: number): number {
  if (!task) return now + 3600;
  if (task.k === 'stop') return task.arr ?? task.dep ?? now;
  return now + 60;
}

// ---------------------------------------------------------------- spawning

export function newTrain(sim: Sim, block: Block | null, link: number, off: number, dir: Dir, hist: { link: number; dir: Dir }[], vehicle: string): Train {
  const tr: Train = {
    id: sim.nextTrainId++, vehicle, svc: block?.svc ?? '---', tripNo: '----', tripId: -1, block: block?.id ?? -1,
    destText: '', destStation: -1,
    link, off, dir, hist, body: [], len: LINE_INFO.trainLength, v: 0, a: 0,
    level: 'CBTC', comm: true, mode: sim.atoLine ? 'AM' : 'DTO', eb: false, ebReason: '', ebSince: 0, ebCause: '', ebAuth: false, ebCallAt: 0,
    forceLevel: 'AUTO', dtoInhibit: '', relocSec: -1, modeSince: sim.t, rmSig: -1, spadSig: -1, tbStage: 'none', tbExitSig: -1, tbCallAt: 0, depotStage: 'none', maSigs: [],
    maDist: 0, maReason: '', maCode: 'NONE', maTrain: -1, maFar: 0, maFarReason: '', maFarCode: 'NONE', maFarTrain: -1,
    lastDs: 0, lastMa: Infinity, maCut: false, arsWait: null, halt: newHalt(), vTarget: 0, vPermit: 0, stopDist: Infinity, rmAuth: 0, rmReason: '',
    pendingModeAt: 0, pendingMode: null, pendingLevel: null,
    tasks: [], phase: 'run', phaseSince: sim.t, dwellUntil: 0, doorsOpen: false, doorSide: '', doorsAwait: false, arrivedAt: 0, depReadyAt: 0,
    load: 0, delay: 0, hold: false, skipStations: new Set(), failed: false, failRecoverAt: 0, failRecoverable: true,
    rescueBy: -1, rescuing: -1, coupledLen: 0, inService: true, nextSignal: -1, nextSignalDist: Infinity,
    lastStation: -1, trace: [], lastTraceT: -1e9, lastTraceCh: NaN, stopsMade: 0, overspeedEvents: 0, passedRed: 0,
    withdrawn: false, extraDwell: 0, tractionCut: 0, doorsCut: 0, vCap: Infinity, vfault: null, withdrawAtEnd: false, slip: '', overrun: 0, coast: false,
    manual: false, notch: 0, tgtV: 0, tgtD: Infinity, tgtReason: '', coupledVehicle: '',
    drv: { stops: [], overspeed: 0, spad: 0, since: sim.t, releases: 0, braking: false, restop: false }, stopUntil: 0, stopReason: '', waitSince: 0,
    vEbi: 0, dmiLog: [], dmiPrev: null,
  };
  computeBody(sim, tr);
  sim.addTrain(tr);
  return tr;
}

/** spawn trains whose block starts now */
export function spawnDue(sim: Sim) {
  const { topo } = sim;
  for (const b of sim.plan.blocks) {
    if (b.train !== undefined || sim.blockDone.has(b.id)) continue;
    // a duty whose trips are all cancelled (taken over or withdrawn) stays in
    if (!b.trips.some(id => !sim.plan.trips[id].cancelled)) continue;
    if (b.start.kind === 'stable') {
      spawnStabled(sim, b);
      continue;
    }
    if (sim.t < b.start.time) continue;
    const dp = topo.depots[b.start.depot];
    // the lead that serves the first trip's direction
    const first0 = b.trips.map(id => sim.plan.trips[id]).find(t => !t.cancelled)!;
    const path = dp.transferPaths[dp.portals.exit[first0.dir].path];
    const outGateLink = path.links[2];
    // transfer track must be free
    const t1 = topo.links[outGateLink];
    const exitL = topo.nodes[t1.a].links.find((l) => l !== outGateLink)!;
    if (depotSourceBusy(sim, outGateLink, exitL)) continue;
    if (sim.depotStock[b.start.depot] <= 0) {
      if (!sim.depotShortLogged.has(b.id)) {
        sim.depotShortLogged.add(b.id);
        sim.log('B', '车辆', `${dp.name} 无可用车辆，表号 ${b.svc} 出段延误`, { key: `short-${b.id}` });
      }
      continue;
    }
    sim.clearAlarm(`short-${b.id}`);
    if (!peekVehicle(sim, b.start.depot, b)) { takeVehicle(sim, b.start.depot, b); continue; }
    const decision = resourceAllocation(sim).decisions.get(-(b.id + 1));
    if (decision ? !decision.admitted : path.flow === 'shared') continue;
    const tasks = decision?.request.tasks ?? blockTasks(topo, sim.plan, b);

    const vehicle = takeVehicle(sim, b.start.depot, b);
    if (!vehicle) continue;
    // head on the transfer link next to the exit signal, heading towards the main line
    const exitLink = topo.links[exitL];
    // exitLink runs j1 → j2 (a = j1). Train heads -1 on it.
    // A configured fixed departure task begins at the existing test point.
    // The head is created there, rather than asking it to creep through the
    // red-signal safety margin before that work has been performed.
    const firstTask = tasks[0];
    const work = firstTask?.k === 'stop' && firstTask.depotWork?.kind === 'out' ? topo.berths[firstTask.berth] : undefined;
    const spawnOffset = work?.link === exitLink.id && work.dir === -1 ? work.offset : 15;
    const tr = newTrain(sim, b, exitLink.id, spawnOffset, -1, [{ link: outGateLink, dir: -1 }, { link: exitLink.id, dir: -1 }], vehicle);
    tr.tasks = tasks;
    adoptSpawnResources(sim, b.id, tr);
    b.train = tr.id;
    tr.phase = 'run';
    tr.depotStage = 'out';
    sim.log('I', '车辆', `表号 ${b.svc}（${tr.vehicle}）由${dp.name}出段`);
    setTripFromTasks(sim, tr);
  }
}

/** Source availability is the same fact for admission and physical spawn. */
export function depotSourceBusy(sim: Sim, outGate: number, exitLink: number): boolean {
  return [outGate, exitLink].some(link => (sim.linkBodies.get(link)?.length ?? 0) > 0
    || sim.sec[sim.topo.links[link].section].occ || sim.sec[sim.topo.links[link].section].lockRoute >= 0);
}

function spawnStabled(sim: Sim, b: Block) {
  const { topo } = sim;
  if (b.start.kind !== 'stable') return;
  const st = topo.stations[b.start.station];
  // in departure order: the first ones in the turnback tracks (empty again
  // before the first arrivals turn), later ones in the storage tail, the
  // earlier of those nearer the platform
  const at = b.start.station;
  const firstDep = (x: Block) => x.trips.map(id => sim.plan.trips[id]).filter(t => !t.cancelled)
    .map(t => effectiveStops(t)[0]?.dep).find(dep => dep !== undefined) ?? Infinity;
  const rank = sim.plan.blocks.filter((x) => x.start.kind === 'stable' && x.start.station === at && x.trips.some((id) => !sim.plan.trips[id].cancelled))
    .sort((x, y) => firstDep(x) - firstDep(y)).indexOf(b);
  const places = [...st.turnbackBerths, ...st.storageBerths];
  // a storage tail holds a train on each of its links
  const placeFree = (x: number) => st.storageBerths.includes(x)
    ? !(sim.linkBodies.get(topo.berths[x].link) ?? []).length : !berthBusy(sim, x, -1);
  const bid = b.start.berth !== undefined
    ? (placeFree(b.start.berth) ? b.start.berth : undefined)
    : places[rank] !== undefined && placeFree(places[rank]) ? places[rank] : places.find(placeFree);
  // (a duty cancelled before its spawn still has its car standing here; face
  // it as its first planned trip would)
  const first = sim.plan.trips[b.trips.find(id => !sim.plan.trips[id].cancelled) ?? b.trips[0]];
  const faces = (link: number, dir: number) => !first || ((topo.links[link].chainB - topo.links[link].chainA) * dir > 0) === (first.dir === 'DN');
  // after a rollover the train standing there is the one that goes out (D111)
  const idle = sim.trainList.filter(t => (t.block < 0 || sim.blockDone.has(t.block)) && !t.tasks.length && t.v < .05 && !t.failed);
  const own = b.start.berth;
  const candidates = own !== undefined
    ? [own, ...overnightPlaces(topo).filter(p => p.berth === own).map(p => p.arrivalBerth)]
    : [places[rank], ...places].filter((id): id is number => id !== undefined);
  const adopt = candidates.map(id => idle.find(t => standsAt(sim, t, id))).find(t => t !== undefined);
  if (adopt) {
    adopt.block = b.id; adopt.svc = b.svc; adopt.phase = 'run'; adopt.phaseSince = sim.t;
    if (!faces(adopt.link, adopt.dir)) reverseTrain(sim, adopt);
    adopt.tasks = blockTasks(topo, sim.plan, b);
    adopt.lastStation = st.index;
    b.train = adopt.id;
    setTripFromTasks(sim, adopt);
    return;
  }
  if (bid === undefined) return;
  if (!sim.stabledPool.length) {
    // a later day: no car stands where this duty starts (D111)
    sim.log('B', '车辆', `${st.name}存车位无车，表号 ${b.svc} 无法出车（首趟 ${first?.no ?? '-'}）`, { key: `stable-missing-${b.id}` });
    return;
  }
  const berth = topo.berths[bid];
  // place body ending at the berth, then reverse so the head faces the platform
  const headOff = berth.offset;
  const tr = newTrain(sim, b, berth.link, headOff, berth.dir, [{ link: berth.link, dir: berth.dir }], sim.stabledPool.shift()!);
  if (b.start.berth === undefined || (berth.kind !== 'platform' && !faces(berth.link, berth.dir))) reverseTrain(sim, tr);
  tr.tasks = blockTasks(topo, sim.plan, b);
  tr.lastStation = st.index;
  b.train = tr.id;
  setTripFromTasks(sim, tr);
}

/** A running train keeps its tasks up to the end of trip `last` and then
 * follows its circulation, which an added service extended (延长运用, D47).
 * `ending`: the steps after `last` when the circulation now ends there, taken
 * over from the train that was to stable there (D156). */
export function extendTrainTasks(sim: Sim, tr: Train, last: number, ending?: Task[]) {
  const { topo, plan } = sim;
  const cut = tr.tasks.findIndex(t => t.k === 'stop' && t.trip === last && t.dep === null);
  const block = plan.blocks[tr.block];
  const next = block.trips.slice(block.trips.indexOf(last) + 1).map(id => plan.trips[id]).find(t => !t.cancelled);
  if (cut < 0 || !next && !ending) return;
  const tasks = tr.tasks.slice(0, cut + 1);
  if (next) {
    const trip = plan.trips[last];
    const actualTrip = effectiveTrip(trip);
    if (!actualTrip) return;
    if (next.dir !== trip.dir) {
      // keep a turnback the train already had planned (its berth may be reserved)
      const own = tr.tasks[cut + 1];
      if (own?.k === 'reverse') tasks.push(own);
      else addTurnback(topo, actualTrip, tasks);
    }
    tasks.push(...blockTasks(topo, plan, block, block.trips.indexOf(next.id)));
  } else tasks.push(...ending!);
  const keep = new Set(tasks.flatMap(t => t.k === 'stop' ? [t.berth] : []));
  for (const [berth, train] of sim.berthRes) if (train === tr.id && !keep.has(berth)) sim.berthRes.delete(berth);
  tr.tasks = tasks;
}

export function setTripFromTasks(sim: Sim, tr: Train) {
  const depotWork = tr.tasks[0]?.k === 'stop' ? tr.tasks[0].depotWork : undefined;
  if (depotWork?.kind === 'in') {
    tr.inService = false; tr.tripNo = '回段'; tr.destText = sim.topo.depots[depotWork.depot].short;
    return;
  }
  const t = tr.tasks.find((x) => x.k === 'stop' && !x.depotWork) as StopTask | undefined;
  if (!t || t.trip < 0) {
    if (tr.tasks[0]?.k === 'depot') {
      tr.inService = false;
      tr.tripNo = '回段'; tr.destText = sim.topo.depots[tr.tasks[0].depot].short;
    }
    return;
  }
  const trip = sim.plan.trips[t.trip];
  if (tr.tripId !== trip.id) {
    tr.tripId = trip.id;
    tr.lastCompletedCall = { trip: trip.id, stopIndex: -1 };
    tr.tripNo = trip.no;
    tr.inService = trip.revenue;
    // Live delay belongs to this assignment, not the completed inbound trip.
    if (t.arr === null && t.dep !== null) tr.delay = Math.max(0, sim.t - t.dep);
  }
  const end = serviceEnd(sim.plan, trip);
  tr.destStation = end ?? -1;
  tr.destText = end === undefined ? '' : STATIONS[end].name;
}

// ---------------------------------------------------------------- per-step task logic

/** Physical occupancy of the immediately following interval, excluding platforms.
 * A departure already granted this tick also reserves one place before motion. */
export function intervalDepartureHold(sim: Sim, tr: Train, st: StopTask): Train['intervalWait'] {
  const next = tr.tasks[1];
  if ((!tr.manual && !['DTO', 'AM'].includes(tr.mode)) || tr.rescuing >= 0 || tr.coupledLen > 0
    || tr.intervalRelease === st.station || next?.k !== 'stop' || next.station === st.station) return;
  const dir = ahead('DN', st.station, next.station) ? 'DN' : 'UP';
  const adjacent = st.station + (dir === 'DN' ? 1 : -1);
  const west = Math.min(st.station, adjacent), east = Math.max(st.station, adjacent);
  const rule = OPERATIONS.intervalTrainLimits.find(r => r.from === sim.topo.stations[west]?.id && r.to === sim.topo.stations[east]?.id);
  if (!rule) return;
  const a = sim.topo.links[sim.topo.platforms[sim.topo.stations[west].platforms[dir]].link];
  const b = sim.topo.links[sim.topo.platforms[sim.topo.stations[east].platforms[dir]].link];
  const origin = dir === 'DN' ? a : b;
  const from = Math.max(a.chainA, a.chainB), to = Math.min(b.chainA, b.chainB);
  const occupants = sim.trainList.filter(other => other !== tr && (
    (other.pendingDeparture?.station === st.station || other.phase === 'run' && other.lastStation === st.station
      && other.link === origin.id
      && other.tasks[0]?.k === 'stop' && other.tasks[0].station !== st.station
      && (dir === 'DN' ? sim.trainChain(other) <= from : sim.trainChain(other) >= to))
      && dirOf(other, sim.topo) === dir || other.body.some(seg => {
      const l = sim.topo.links[seg.link];
      if (l.track !== dir && l.track !== 'X') return false;
      const x = l.chainA + (l.chainB - l.chainA) * seg.from / l.len;
      const y = l.chainA + (l.chainB - l.chainA) * seg.to / l.len;
      return Math.max(x, y) > from + .01 && Math.min(x, y) < to - .01;
    })));
  const platform=sim.topo.stations[adjacent].platforms[dir],ps=sim.plat[platform];
  // 用户决定：正常运行不额外限车；只有前方发生阻塞才启用限额。
  const blocked=ps.hold||ps.esp||(ps.psdFault&&ps.psd!=='bypass')||ps.psd==='closeFail'
    ||sim.trainList.some(other=>{
      const stop=other.tasks[0];
      if(other===tr||stop?.k!=='stop'||stop.station!==adjacent||other.phase!=='dwell'||!other.hold&&!other.failed)return false;
      const p=sim.topo.berths[stop.berth].platform;
      return p===platform||sim.topo.platforms[p]?.pool===platform;
    })
    ||occupants.some(other=>{
      if(other.failed||other.hold)return true;
      if(other.phase!=='run'||other.v>=.05||other.pendingDeparture)return false;
      const cause=rootCause(sim,other,true);
      // A pure closed traffic dependency is not an independent obstruction
      // which may activate capacity against itself. Unknown/acyclic stays.
      return !cause.cycle||cause.external!==false;
    });
  if(!blocked)return;
  if (occupants.length >= rule.limit) return { train: occupants[0].id,
    detail: `${sim.topo.stations[st.station].name}—${sim.topo.stations[adjacent].name} ${occupants.length}/${rule.limit}列` };
  // A converging platform cannot reserve the restricted interval before
  // the main-platform train it must follow has been allowed to depart.
  if (sim.topo.links[tr.link].track !== dir) {
    const route = sim.sig[tr.nextSignal]?.route ?? -1;
    if (route < 0 || !routeLeadsTo(sim, route, next.berth))
      return { train: -1, detail: '等待汇入正线的出站进路' };
  }
}

export function updateTrainTasks(sim: Sim, tr: Train, dt = 0.1) {
  const { topo } = sim;
  const departureAlarm = `turnback-departure-train-${tr.id}`;
  if (sim.alarms.has(departureAlarm) && !tr.tasks.some(t => t.k === 'stop' && t.turnbackWaitBerth !== undefined))
    sim.clearAlarm(departureAlarm);
  if (tr.phase === 'run' && (tr.v >= .05 || tr.lastDs > 1e-6)) sim.clearAlarm(`turnback-wait-unsafe-${tr.id}`);
  let task = tr.tasks[0];
  // Once the physical departure starts, the tail wait is consumed. Manual
  // driving followed by automatic control must not reapply it on a shared link.
  if (tr.phase === 'run' && task?.k === 'stop' && task.turnbackWaitBerth !== undefined
    && (tr.v >= .05 || tr.lastDs > 1e-6)) {
    task = cowTask(tr, task); delete task.turnbackWaitBerth;
    sim.clearAlarm(`turnback-departure-train-${tr.id}`);
  }
  if (tr.tbStage === 'manual' && tr.level === 'CBTC') { setTurnbackStage(sim, tr, 'depart'); tr.tbExitSig = -1; }
  if (tr.failed || utoVehicleWait(sim,tr) || utoBusy(tr) && !(tr.uto?.stage==='doors'&&tr.doorsAwait)) return;
  if (tr.depotStage === 'out' && topo.links[tr.link].track !== 'DEP') tr.depotStage = 'none';
  if (tr.depotStage === 'none' && task?.k === 'depot' && topo.links[tr.link].track === 'DEP') tr.depotStage = 'in';
  if (tr.tbStage === 'none' && task?.k === 'reverse') setTurnbackStage(sim, tr, 'arrive');
  if (tr.tbStage === 'arrive' && task?.k !== 'reverse') setTurnbackStage(sim, tr, 'none');

  if (tr.phase === 'run') {
    if (!task) {
      // nothing left: stop where we are
      return;
    }
    if (task.k === 'stop') {
      // skip-stop handling (not for terminal / non-revenue); decided far
      // enough out to come down to the platform pass limit
      const p = topo.berths[task.berth].platform;
      const isTripEnd = task.dep === null;
      if (task.revenue && !isTripEnd && tr.v > 0.1 && (sim.plat[p].skip || tr.skipStations.has(task.station)) && tr.stopDist < 900) {
        tr.skipStations.delete(task.station);
        sim.log('I', '调度', `列车 ${trainLabel(tr)} 跳停 ${STATIONS[task.station].name}`);
        tr.tasks.shift();
        return;
      }
    }
    const cur = task.k === 'reverse' || (task.k === 'stable' && task.berth < 0) ? resolveChoice(sim, tr, task) : task;
    const goal = taskGoal(sim, cur);
    if (tr.manual || tr.uto?.retreat) {
      if (goal >= 0 && tr.v < 0.05) manualArrival(sim, tr, cur);
    } else if (goal >= 0 && tr.v < 0.05) {
      const err = cur.k === 'stop' ? stopError(sim, tr) : 0;
      if (cur.k === 'stop' && err < -0.8) {
        if (!tr.overrun) atoOverrun(sim, tr, cur, err);
      } else if (tr.stopDist < 0.8) arriveAtBerth(sim, tr, cur);
    }
    if (cur.k === 'depot') {
      const b = topo.berths[depotBerth(topo, cur)];
      const near = tr.manual ? tr.off <= b.offset + 1 && tr.off >= b.offset - 40 : Math.abs(tr.off - b.offset) < 1.5;
      if (tr.link === b.link && near && tr.v < 0.05) enterDepot(sim, tr, cur.depot);
    }
    if (task.k === 'rescue') rescueStep(sim, tr, task.target);
    return;
  }

  if (tr.phase === 'dwell') {
    const st = task as StopTask;
    if (st.depotWork) {
      if (sim.t < tr.dwellUntil || tr.hold || tr.eb || tr.doorsOpen || tr.doorSide || tr.doorMotion
        || sim.t < (tr.doorLockedAt ?? 0) || departureHold(sim, tr)) return;
      tr.tasks.shift();
      if (sim.berthRes.get(st.berth) === tr.id) sim.berthRes.delete(st.berth);
      tr.phase = 'run'; tr.phaseSince = sim.t;
      setTripFromTasks(sim, tr);
      return;
    }
    // Arrival delay remains meaningful until a departure actually becomes late.
    // The same departure-clock update applies to every driving mode and hold.
    if (st.dep !== null && sim.t > st.dep) tr.delay = sim.t - st.dep;
    const p = topo.berths[st.berth].platform;
    const ps = sim.plat[p];
    if (ps.esp) { tr.dwellUntil = Math.max(tr.dwellUntil, sim.t + 1); return; }
    // handed back to automatic driving before the driver opened: open now
    if (tr.doorsAwait && !tr.manual && sim.t >= (tr.autoOpenAt ?? 0)) startDoorCycle(sim, tr, st, p, tr.mode === 'RM');
    if(utoBusy(tr))return;
    if (!tr.manual && tr.doorsOpen) tr.doorSide = '';
    // doors open (closeDoors clears doorsOpen once closing starts): late arrivals keep boarding
    const closing = tr.doorMotion?.kind === 'closing';
    if (tr.doorsOpen && !tr.doorsAwait && !closing) boardWhileOpen(sim, tr, p, st, dt);
    // 站台折返: alighting done, the train changes ends with its doors open
    if (tr.doorsOpen && !tr.doorsAwait && platformTurn(topo, tr, st) && sim.t >= tr.dwellUntil - PLANNED_CLOSE_BUDGET) { turnOnPlatform(sim, tr, st); return; }
    // the driver works the doors (driverDoor) and leaves once they are closed and locked
    if (tr.doorsAwait || tr.doorSide) return;
    const held = tr.hold || ps.hold;
    if (held) return;
    // Keep the original diagram closing slot; the shorter physical sequence
    // releases early, and ATS spends that gain in the next section.
    const closeExtra = ps.psd === 'bypass' ? BYPASS_EXTRA : ps.psdLinkFault || ps.psd === 'pslOpen' ? PSL_EXTRA : 0;
    const closeAt = Math.max(tr.dwellUntil - PLANNED_CLOSE_BUDGET - closeExtra,
      tr.depReadyAt - DOOR_CLOSE_S - meanRange(OPERATIONS.autoStartDelay) - closeExtra);
    tr.intervalWait = tr.manual || sim.t >= closeAt ? intervalDepartureHold(sim, tr, st) : undefined;
    if (tr.intervalWait) return;
    if (closing) return;
    if (tr.doorsOpen && !tr.manual && sim.t >= closeAt) {
      if(!utoDoorWarningReady(sim,tr))return;
      // a car door that does not close (vehicle.ts)
      if (st.doors && doorCloseHold(sim, tr)) return;
      // A simulated AM driver operates the same guarded door control as a
      // human. Internal deterministic work is not replayed as a second user
      // command; dispatcher/player actions still enter through sim.command.
      if(simulatedAmDoorWork(tr)) {
        driverDoor(sim,tr,platformSide(sim,tr,p));
        return;
      }
      const extra = closeDoors(sim, tr, p);
      if (extra < 0) return;
      setDepartureReadyAt(tr, Math.max(sim.t + DOOR_CLOSE_S + extra, tr.autoStartAt ?? 0));
    }
    if (tr.doorsOpen || !psdSafe(ps) || sim.t < (tr.manual ? tr.doorLockedAt ?? 0 : tr.dwellUntil)) return;
    if (!tr.manual && !tr.atoDriver && sim.t < (tr.autoStartAt ?? 0)) return;
    // turning back beyond the platform: wait here while every tail is taken —
    // following a train into an occupied tail locks both in (CBTC would allow it)
    const nx = tr.tasks[1];
    if (nx?.k === 'reverse' && nx.berths.every((b) => berthBusy(sim, b, tr.id))) {
      const berth = nx.berths[0];
      setArsWait(sim, tr, 'BERTH_WAIT', berthHolder(sim, berth, tr.id), tr.nextSignal,
        `折返泊位均被占用/预约：${nx.berths.map(b => topo.berths[b].name).join('、')}`);
      return;
    }
    // a brake that does not release, a door being dealt with (vehicle.ts)
    if (departureHold(sim, tr)) return;
    // A fixed work stop at the same berth is a continuation of this stand,
    // not a train departure. Close and lock the doors above, then begin the
    // work without requiring a movement authority or ATO start buttons.
    if (nx?.k === 'stop' && nx.depotWork && nx.berth === st.berth) {
      if (tr.eb || tr.pendingMode) return;
      tr.tasks.shift();
      tr.atoButtons = { f: false, g: false };
      tr.intervalWait = undefined; tr.intervalRelease = undefined;
      setTripFromTasks(sim, tr);
      arriveAtBerth(sim, tr, nx);
      return;
    }
    const simulatedDeparture = simulatedAmDoorWork(tr);
    if (simulatedDeparture && atoStartReady(sim,tr).ready) {
      if(!tr.atoButtons?.f)atoButton(sim,tr,'f',true);
      if(!tr.atoButtons?.g)atoButton(sim,tr,'g',true);
    }
    if ((tr.atoDriver || simulatedDeparture) && (!atoStartReady(sim, tr).ready || !tr.atoButtons?.f || !tr.atoButtons?.g)) return;
    // depart
    tr.atoButtons = { f: false, g: false };
    tr.intervalWait = undefined;
    tr.intervalRelease = undefined;
    const remaining = stopError(sim, tr);
    tr.departureDisplay = { stop: st, at: dwellDepartureAt(tr), remaining: Number.isFinite(remaining) ? remaining : undefined, side: platformSide(sim, tr, p) };
    rememberCompletedCall(sim, tr, st);
    tr.tasks.shift();
    ps.lastDep = sim.t;
    tr.phase = 'run';
    tr.phaseSince = sim.t;
    if (st.dep !== null) tr.delay = sim.t - st.dep;
    tr.pendingDeparture = st;
    if (sim.berthRes.get(st.berth) === tr.id) sim.berthRes.delete(st.berth);
    setTripFromTasks(sim, tr);
    if (tr.tasks[0] && (tr.tasks[0].k === 'reverse' || tr.tasks[0].k === 'stable')) resolveChoice(sim, tr, tr.tasks[0]);
    return;
  }

  if (tr.phase === 'reversing') {
    if (sim.t < tr.dwellUntil) return;
    const t = tr.tasks.shift();
    if (t && t.k === 'reverse' && sim.berthRes.get(t.chosen) === tr.id) sim.berthRes.delete(t.chosen);
    reverseTrain(sim, tr);
    setTurnbackStage(sim, tr, tr.level === 'TBTC' ? 'manual' : 'depart');
    tr.tbExitSig = tr.tbStage === 'manual' ? signalAheadFrom(sim, tr.link, tr.off, tr.dir, 500)?.sig ?? -1 : -1;
    tr.tbCallAt = 0;
    tr.dmiCab = (tr.dmiCab ?? 0) + 1;
    tr.phase = 'run';
    tr.phaseSince = sim.t;
    setTripFromTasks(sim, tr);
    return;
  }

  if (tr.phase === 'coupling') {
    if (sim.t >= tr.dwellUntil) completeCoupling(sim, tr);
  }
}

function arriveAtBerth(sim: Sim, tr: Train, task: Task) {
  const { topo } = sim;
  tr.v = 0;
  if (task.k === 'stop') {
    // Once physically at the next stop, this is no longer a tail call-out.
    if (task.turnbackWaitBerth !== undefined) {
      task = cowTask(tr, task); delete task.turnbackWaitBerth;
      sim.clearAlarm(`turnback-departure-train-${tr.id}`);
    }
    if (tr.tbStage === 'depart') setTurnbackStage(sim, tr, 'none');
    if (task.depotWork) {
      tr.phase = 'dwell'; tr.phaseSince = sim.t; tr.arrivedAt = sim.t;
      tr.dwellUntil = tr.depReadyAt = sim.t + (task.minDwell ?? 0);
      return;
    }
    tr.retreat = undefined;
    tr.randomOverrunM=undefined;tr.randomOverrunBerth=undefined;tr.utoDoorWarningAt=undefined;
    tr.departureDisplay = undefined;
    const duty = sim.plan.blocks[tr.block];
    if (duty?.start.kind === 'stable' && duty.start.berth === task.berth && duty.trips[0] === task.trip
      && task.dep !== null && sim.t < task.dep - 60) return;
    const p = topo.berths[task.berth].platform;
    const ps = sim.plat[p];
    tr.phase = 'dwell';
    tr.phaseSince = sim.t;
    tr.arrivedAt = sim.t;
    tr.atoButtons = { f: false, g: false };
    tr.lastStation = task.station;
    tr.stopsMade++;
    ps.lastArr = sim.t;
    if (task.arr !== null) tr.delay = sim.t - task.arr;
    // the trip's own final call only: a depot exit's change of ends carries the
    // trip number with no departure time but is not a passenger stop
    const complete = (trip: Trip, arr: number | null) => {
      sim.tripsDone++;
      sim.metrics.tripsCompleted++;
      trip.completed = true;
      sim.metrics.tripDelays.push(arr !== null ? sim.t - arr : 0);
    };
    if (task.dep === null && task.revenue && task.trip >= 0 && sim.plan.trips[task.trip].revenue && !sim.plan.trips[task.trip].completed)
      complete(sim.plan.trips[task.trip], task.arr);
    // A depot-exit passenger trip that runs on into its next trip in the same
    // direction ends here as a pass (the next trip's first call stands for it)
    if (task.dep !== null && task.trip >= 0) {
      const trip = sim.plan.trips[task.trip];
      const ids = sim.plan.blocks[trip.block]?.trips ?? [];
      const prev = ids.slice(0, ids.indexOf(trip.id)).map((id) => sim.plan.trips[id]).filter((t) => !t.cancelled).at(-1);
      const end = prev && effectiveStops(prev).at(-1);
      if (prev && end && prev.revenue && !prev.completed && !end.stop && end.st === task.station && effectiveStops(trip)[0]?.st === task.station)
        complete(prev, end.arr);
    }
    recordTrace(sim, tr, true);
    if (stopNeedsDoors(tr, task) && !tr.doorsOpen) {
      tr.autoOpenAt = tr.manual ? undefined : sim.t + OPERATIONS.autoDoorOpenDelay[0] + sim.rng() * (OPERATIONS.autoDoorOpenDelay[1] - OPERATIONS.autoDoorOpenDelay[0]);
      // Prepare the final target now; only physical opening is delayed.
      tr.doorsAwait = true;
      if (tr.manual) tr.dwellUntil = tr.depReadyAt = Math.max(sim.t + (task.minDwell ?? MIN_DWELL), task.dep ?? 0);
      else prepareDoorCycle(sim, tr, task, p, tr.mode === 'RM');
      return;
    }
    startDoorCycle(sim, tr, task, p, tr.mode === 'RM');
    return;
  }
  if (task.k === 'reverse') {
    sim.clearAlarm(`turnback-wait-unsafe-${tr.id}`);
    // Only mark a genuine planned adjacent connection, after the train has
    // physically reached the actual selected off-platform berth. This avoids
    // freezing an online exchange or a shortened task list on the main line.
    const next = tr.tasks[1];
    if (next?.k === 'stop') {
      const d = sim.plan.trips[next.trip], block = sim.plan.blocks[tr.block];
      const index = block?.trips.indexOf(next.trip) ?? -1;
      const a = index > 0 ? block.trips.slice(0, index).map(id => sim.plan.trips[id]).filter(t => t && !t.cancelled).at(-1) : undefined;
      const berth = topo.berths[task.chosen];
      const adjacent = !!a && !!d && !d.cancelled && effectiveEnd(a) === d.from && effectiveEnd(a) === task.station && a.dir !== d.dir;
      const long = adjacent && plannedWaitLong(sim.plan.dayType, a, d);
      const actual = berth && a && berth.station === effectiveEnd(a) && (berth.kind === 'tail' || berth.kind === 'siding') && tr.link === berth.link
        && tr.dir === berth.dir;
      const choice = long && actual ? plannedWaitBerth(topo, a!, d!, tr.tasks, 0, [task.chosen], task.chosen,
        { point: { link: tr.link, off: tr.off, dir: tr.dir }, incoming: tr.hist, length: tr.len }) : undefined;
      if (choice?.safe && !next.standby && !next.stabledOut) cowTask(tr, next).turnbackWaitBerth = task.chosen;
      else if (next.turnbackWaitBerth !== undefined) { const copy = cowTask(tr, next); delete copy.turnbackWaitBerth; }
      if (long && actual && choice && !choice.safe)
        sim.log('C', '运营', `列车 ${trainLabel(tr)} 所选 ${berth!.name} 不能全列安全候班，继续原折返作业`,
          { key: `turnback-wait-unsafe-${tr.id}`, code: 'TURNBACK_WAIT_UNSAFE', train: tr.id });
    }
    setTurnbackStage(sim, tr, 'reverse');
    tr.phase = 'reversing';
    tr.phaseSince = sim.t;
    // DTO reverses unattended; with a driver (ATO / TBTC backup) the driver changes ends
    tr.dwellUntil = sim.t + turnbackDwell(tr.mode, task.minTime,driverTurnbackKind(topo,task),simulatedAmDriver(tr));
    tr.lastStation = task.station;
    // reversed at a platform track: the next departure here leaves from it
    // (set now: the pull-out route is taken from tasks[1] while reversing)
    const following = tr.tasks[1];
    if (following?.k === 'stop' && following.station === task.station) {
      const berth = departureBerthAfterReverse(topo, task.chosen, following.berth);
      if (berth !== following.berth) cowTask(tr, following).berth = berth;
    }
    return;
  }
  if (task.k === 'stable') {
    tr.phase = 'stabled';
    tr.phaseSince = sim.t;
    tr.inService = false;
    tr.tripNo = '存车';
    tr.destText = '';
    tr.tasks.shift();
    beginUtoReturn(sim,tr.vehicle);
    sim.log('I', '车辆', `列车 ${tr.svc}（${tr.vehicle}）${task.reason}于 ${sim.topo.berths[task.berth].name}`);
    finishBlock(sim, tr);
  }
}

/**
 * 站台折返: a trip ending where the train changes ends at the platform itself
 * (广兰路 middle track, 虹桥火车站). The doors stay open: passengers alight,
 * the driver walks to the other cab, the next trip boards, and the doors close
 * only for its departure — not before the turnback and open again after it.
 */
function platformTurn(topo: Topology, tr: Train, st: StopTask): boolean {
  const rev = tr.tasks[1], next = tr.tasks[2];
  return st.dep === null && rev?.k === 'reverse' && rev.berths.every((b) => b === st.berth)
    && next?.k === 'stop' && next.station === st.station && topo.berths[next.berth]?.kind === 'platform';
}

/** change ends at the platform with the doors open, straight into the next trip's stop */
function turnOnPlatform(sim: Sim, tr: Train, st: StopTask) {
  rememberCompletedCall(sim, tr, st);
  tr.tasks.shift();
  const rev = tr.tasks.shift();
  if (rev?.k !== 'reverse') return;
  if (sim.berthRes.get(st.berth) === tr.id) sim.berthRes.delete(st.berth);
  if (sim.berthRes.get(rev.chosen) === tr.id) sim.berthRes.delete(rev.chosen);
  const next = tr.tasks[0];
  if (next?.k === 'stop') {
    const berth = departureBerthAfterReverse(sim.topo, rev.chosen, next.berth);
    if (berth !== next.berth) cowTask(tr, next).berth = berth;
  }
  setTurnbackStage(sim, tr, 'arrive');
  setTurnbackStage(sim, tr, 'reverse');
  reverseTrain(sim, tr);
  // the open side, as seen from the new leading cab
  if (tr.doorSide) tr.doorSide = tr.doorSide === 'L' ? 'R' : 'L';
  setTurnbackStage(sim, tr, tr.level === 'TBTC' ? 'manual' : 'depart');
  tr.tbExitSig = tr.tbStage === 'manual' ? signalAheadFrom(sim, tr.link, tr.off, tr.dir, 500)?.sig ?? -1 : -1;
  tr.tbCallAt = 0;
  tr.dmiCab = (tr.dmiCab ?? 0) + 1;
  setTripFromTasks(sim, tr);
  arriveAtBerth(sim, tr, tr.tasks[0]);
  // no departure before the driver is in the other cab
  tr.dwellUntil = Math.max(tr.dwellUntil, sim.t + turnbackDwell(tr.mode, rev.minTime,driverTurnbackKind(sim.topo,rev),simulatedAmDriver(tr)));
}

/** the stop has a door cycle: passengers, or a clear-out (清客) */
function stopNeedsDoors(tr: Train, task: StopTask): boolean {
  return task.doors || (!task.revenue && tr.load > 0);
}

/** Driver departure work follows an actual door cycle, not a closed-door
 * intermediate task such as a depot exit's in-place change of ends.
 * Clearing passengers sets load to zero while its door cycle is still real. */
export function simulatedAmDoorWork(tr: Train): boolean {
  const task = tr.tasks[0];
  if (!simulatedAmDriver(tr) || tr.phase !== 'dwell' || task?.k !== 'stop') return false;
  return stopNeedsDoors(tr, task) || tr.doorsOpen || tr.doorsAwait || !!tr.doorMotion
    || ((tr.doorLockedAt ?? 0) > 0 && tr.doorLockedAt! >= tr.arrivedAt);
}

/**
 * Doors open at a stop: passenger exchange and the dwell to the departure.
 * `noLink`: RM, no signalling door enable or PSD linkage (PSD from the PSL).
 */
function prepareDoorCycle(sim: Sim, tr: Train, task: StopTask, p: number, noLink = false) {
  const ps = sim.plat[p];
  const began = sim.t;
  tr.doorExchange = task.doors ? planPassengerExchange(sim, tr, p, task) : undefined;
  let dwell = task.doors ? Math.max(task.minDwell ?? MIN_DWELL, exchangeDwell(sim, tr, p, tr.doorExchange!))
    : !task.revenue && tr.load > 0 ? Math.max(task.minDwell ?? 60, 60) : 10;
  if (task.minDwell) dwell = Math.max(dwell, task.minDwell);
  if (stopNeedsDoors(tr, task) && !tr.doorsOpen) dwell += doorOpenExtra(sim, p, noLink);
  if (task.doors) dwell += tr.doorsCut * DOOR_CUT_DWELL;
  if (tr.extraDwell > 0) { dwell += tr.extraDwell; tr.extraDwell = 0; }
  const closeExtra = task.doors ? (ps.psd === 'bypass' ? BYPASS_EXTRA : ps.psdLinkFault || noLink ? PSL_EXTRA : 0) : 0;
  dwell += closeExtra;
  let ready = began + dwell;
  if (task.dep !== null && task.arr !== null && task.dep > task.arr && task.revenue)
    ready = began + regulatedDwell(task.dep - task.arr, dwell, began - task.arr);
  else if (task.dep !== null) ready = Math.max(ready, task.dep, began + 20);
  tr.dwellUntil = ready;
  tr.depReadyAt = began + dwell;
}

/** Opening commits the exchange prepared at standstill; it never moves the departure target. */
function startDoorCycle(sim: Sim, tr: Train, task: StopTask, p: number, noLink = false) {
  if (tr.autoOpenAt === undefined) prepareDoorCycle(sim, tr, task, p, noLink);
  tr.autoOpenAt = undefined;
  tr.doorsAwait = false;
  if (task.doors) {
    openDoors(sim, tr, p, noLink);
    const before = tr.load;
    boardAndAlight(sim, tr, p, task, tr.doorExchange);
    if (tr.delay > 120) sim.metrics.boardedDelayed += Math.max(0, tr.load - before) + Math.round(before * 0.3);
  } else if (!task.revenue && tr.load > 0) {
    openDoors(sim, tr, p, noLink);
    sim.passengersCleared += tr.load;
    sim.metrics.cleared += tr.load;
    tr.load = 0;
  }
  tr.doorExchange = undefined;
}

/** side of a platform ('L' / 'R' looking forward) for a train standing at it */
export function platformSide(sim: Sim, tr: Train, p: number): 'L' | 'R' {
  const lk = sim.topo.links[tr.link];
  const east = (lk.chainB - lk.chainA) * tr.dir > 0;
  return (sim.topo.platforms[p].face === 'N') === east ? 'L' : 'R';
}

/** The stop whose window the train is standing in: the current dwell, or the
 * stop it has just been cleared to leave — the ATP gives door enable by
 * position, so doors can be reopened after the departure was booked. */
function standingStop(sim: Sim, tr: Train): { st: StopTask; p: number } | undefined {
  for (const st of [tr.tasks[0], tr.departureDisplay?.stop]) {
    if (st?.k !== 'stop') continue;
    const p = sim.topo.berths[st.berth].platform;
    if (p >= 0 && Math.abs(berthError(sim, tr, st.berth)) <= 1) return { st, p };
  }
  return undefined;
}

/** Door enable is a physical position, independent of first passenger exchange. */
export function doorEnable(sim: Sim, tr: Train): { L: boolean; R: boolean; depot: boolean } {
  const no = { L: false, R: false, depot: false };
  if (tr.v >= 0.05 || tr.doorMotion?.kind === 'closing') return no;
  const at = standingStop(sim, tr);
  if (at && stopNeedsDoors(tr, at.st)) {
    const side = platformSide(sim, tr, at.p);
    return { L: side === 'L', R: side === 'R', depot: false };
  }
  if (!tr.manual || tr.depotStage !== 'out') return no;
  for (const dp of sim.topo.depots) {
    const test = OPERATIONS.depotDoorTests[dp.key];
    if (!test) continue;
    for (const path of dp.transferPaths.filter(p => p.exitSignal >= 0)) {
      const ahead = signalAheadFrom(sim, tr.link, tr.off, tr.dir, test.beforeSignal + 1);
      if (ahead?.sig === path.exitSignal && Math.abs(ahead.dist - test.beforeSignal) <= 1)
        return { L: true, R: true, depot: true };
    }
  }
  return no;
}

/** One readiness predicate for the buttons, departure gate and halt diagnosis.
 * Buttons themselves are not part of readiness: early presses never latch. */
export function atoStartReady(sim: Sim, tr: Train): { ready: boolean; code: HaltCode; train: number; detail: string } {
  const no = (code: HaltCode, detail: string, train = -1) => ({ ready: false, code, detail, train });
  if ((!tr.atoDriver && !simulatedAmDriver(tr)) || tr.mode !== 'AM' || tr.phase !== 'dwell') return no('MANUAL', '未接管AM停站列车');
  if (tr.failed) return no('FAILED', '列车故障');
  if (tr.eb) return no('EB', tr.ebReason || '紧急制动未缓解');
  if (tr.pendingMode) return no('MODE_CHANGE', '等待驾驶模式转换');
  const st = tr.tasks[0];
  if (st?.k !== 'stop') return no('NO_TASK', '无站台发车任务');
  const p = sim.topo.berths[st.berth].platform, ps = sim.plat[p];
  if (!ps) return no('NO_TASK', '当前位置没有客运站台');
  if (ps.esp) return no('ESP', `${sim.topo.platforms[p].name}紧急关闭`);
  if (tr.hold || ps.hold) return no('HOLD', '列车或站台扣车');
  if (tr.doorsAwait) return no('DWELL', '等待开门办理客运');
  if (tr.doorsOpen || tr.doorSide || tr.doorMotion || sim.t < (tr.doorLockedAt ?? 0)) return no('DWELL', '等待车门关闭锁闭');
  if (!psdSafe(ps)) return no('PSD_FAULT', '等待站台门关闭锁闭');
  if (simulatedAmDriver(tr) && sim.t < (tr.autoStartAt ?? 0)) return no('DWELL', '等待司机锁门确认及ATO发车作业');
  if (sim.t < tr.dwellUntil) return no('DWELL', '停站作业尚未完成');
  const interval = intervalDepartureHold(sim, tr, st);
  if (interval) return no('INTERVAL_LIMIT', interval.detail, interval.train);
  const nx = tr.tasks[1];
  if (nx?.k === 'reverse' && nx.berths.every(b => berthBusy(sim, b, tr.id)))
    return no('BERTH_WAIT', '折返泊位均被占用/预约', berthHolder(sim, nx.berths[0], tr.id));
  if (departureHold(sim, tr, false)) return no('FAILED', '等待列车门故障处置或制动缓解');
  // Closing a terminal service into this same berth has no traction movement.
  // The door/dwell guards above still apply; a different berth or depot does.
  const stableHere = st.dep === null && nx?.k === 'stable' && nx.berth === st.berth;
  if (!stableHere && tr.maDist < 15) {
    const w = tr.arsWait && sim.t - tr.arsWait.t <= 2.5 ? tr.arsWait : undefined;
    return no(w?.code ?? (tr.maCode === 'NONE' ? 'ROUTE_WAIT' : tr.maCode),
      w?.detail || tr.maReason || '等待有效发车授权', w?.train ?? tr.maTrain);
  }
  return { ready: true, code: simulatedAmDriver(tr)?'DWELL':'MANUAL', train: -1, detail: '等待司机按 ATO 启动' };
}

/** Buttons are sampled through commands; pressing before readiness never latches. */
export function atoButton(sim: Sim, tr: Train, button: 'f' | 'g', down: boolean) {
  tr.atoButtons ??= { f: false, g: false };
  if (!down) { tr.atoButtons[button] = false; return { ok: true, msg: 'ATO启动按钮释放' }; }
  const start = atoStartReady(sim, tr);
  if (!start.ready) return { ok: false, msg: `${start.detail}，ATO启动不计入` };
  tr.atoButtons[button] = true;
  return { ok: true, msg: 'ATO启动按钮按下' };
}

/** The driver's door readiness must not replace the ATS countdown target.
 * A later ATS change to dwellUntil supplies a new target without UI state feedback. */
export function dwellDepartureAt(tr: Train): number {
  const display = tr.departureDisplay;
  return tr.phase === 'dwell' && display?.readyAt === tr.dwellUntil
    ? display.at ?? tr.dwellUntil : tr.dwellUntil;
}

/** Door work or cab handover changes permission, not an existing display target. */
export function setDepartureReadyAt(tr: Train, at: number) {
  if (tr.phase === 'dwell' && tr.departureDisplay?.readyAt !== undefined) {
    tr.departureDisplay.at = dwellDepartureAt(tr);
    tr.departureDisplay.readyAt = at;
  }
  tr.dwellUntil = at;
}

/**
 * The driver of a manual train presses a door button (Y right / U left): the
 * same side again closes. CM and RM alike (user): the door enable is given only
 * for the platform side of a train stopped at its mark. RM has no PSD linkage:
 * station staff work the PSD from the PSL 【假设】.
 */
export function driverDoor(sim: Sim, tr: Train, side: 'L' | 'R'): { ok: boolean; msg: string } {
  if (!tr.manual && !tr.atoDriver && !simulatedAmDriver(tr) && tr.uto?.stage!=='doors') return { ok: false, msg: '列车未处于人工驾驶，车门由信号系统控制' };
  if (tr.v > 0.05) return { ok: false, msg: '列车未停稳，不能操作车门' };
  if (tr.doorMotion?.kind === 'closing') return { ok: false, msg: '车门正在关闭并等待锁闭确认' };
  const word = (x: 'L' | 'R') => (x === 'L' ? '左侧' : '右侧');
  const st = tr.phase === 'dwell' && tr.tasks[0]?.k === 'stop' ? tr.tasks[0] : undefined;
  // after the departure is booked, a train still in the window reopens without a new exchange
  const p = st ? sim.topo.berths[st.berth].platform : standingStop(sim, tr)?.p ?? -1;
  const plat = p >= 0 ? platformSide(sim, tr, p) : '';
  // doors the signalling opened before the driver took over
  if (tr.doorsOpen && !tr.doorSide && plat) tr.doorSide = plat;
  if (tr.doorSide === side) {
    if (side !== plat || !tr.doorsOpen) { closeDoors(sim, tr, -1); return { ok: true, msg: `${word(side)}车门开始关闭` }; }
    if (st?.doors && doorCloseHold(sim, tr)) return { ok: false, msg: '列车车门无法关闭，等待处置' };
    const displayAt = dwellDepartureAt(tr);
    const extra = closeDoors(sim, tr, p);
    if (extra < 0) return { ok: false, msg: '站台门无法关闭锁紧，等待车站处理（互锁解除）' };
    setDepartureReadyAt(tr, Math.max(sim.t + DOOR_CLOSE_S + extra,simulatedAmDriver(tr)?tr.autoStartAt??0:0));
    if ((tr.manual || tr.atoDriver) && st)
      tr.departureDisplay = { stop: st, at: displayAt, readyAt: tr.dwellUntil, side: plat };
    return { ok: true, msg: `${word(side)}车门开始关闭${extra ? '，站台门由站务人员确认关闭' : ''}` };
  }
  if (tr.doorSide) return { ok: false, msg: `${word(tr.doorSide)}车门未关闭` };
  const rm = tr.mode === 'RM';
  const enabled = doorEnable(sim, tr);
  if (!enabled[side]) {
    if (st && !stopNeedsDoors(tr, st)) return { ok: false, msg: '无门使能：本站不办理客运（非载客车次）' };
    return { ok: false, msg: plat ? '门使能仅给出客运停车窗内的站台侧' : '无门使能：列车未在客运停车窗或指定出库试验位置停稳' };
  }
  tr.doorSide = side;
  if (enabled.depot) {
    tr.doorsOpen = true; tr.doorLockedAt = 0;
    return { ok: true, msg: `${word(side)}车门开启（出库试验）` };
  }
  if (st && tr.doorsAwait) startDoorCycle(sim, tr, st, p, rm);
  else if (p >= 0) openDoors(sim, tr, p, rm);

  return { ok: true, msg: `${word(side)}车门开启${rm ? '，站务人员操作PSL开启站台门' : ''}` };
}

/** stopping-accuracy score for a manually driven stop */
export function stopScore(err: number): number {
  const a = Math.abs(err);
  if (a <= 0.3) return 100;
  if (a <= 0.5) return 90;
  if (a <= 0.75) return 75;
  if (a <= 1.0) return 60;
  return 0;
}

/** beyond this an overrun ATO train passes the station instead of backing up (m) 【假设】 */
const OVERRUN_BACK_MAX = 15;

/** An ATO train stopped beyond its mark; wait for the existing dispatch procedure. */
export function atoOverrun(sim: Sim, tr: Train, task: StopTask, err: number, refusal?: string) {
  if (tr.retreat) tr.retreat.reported = true;
  tr.overrun = -err;
  tr.stopUntil = sim.t + 86400;
  tr.stopReason = refusal ? `退行受阻：${refusal}` : '过标停车';
  if (refusal) dmiNote(sim, tr, `退行受阻：${refusal}，请调度指示`, 'warn');
  const st = STATIONS[task.station].name;
  const m = (-err).toFixed(1);
  sim.log('B', '列车', `列车 ${trainLabel(tr)} ${st} 制动停车过标 ${m} m`, { key: `overrun-${tr.id}`, train: tr.id });
  const far = -err > OVERRUN_BACK_MAX;
  const end = task.dep === null;
  openCall(sim, {
    kind: 'overrun', from: `列车 ${trainLabel(tr)} ${crewLabel()}`, train: tr.id,
    text: `${st}进站滑行过标 ${m} m，车门与站台门未对齐，${refusal ? `退行受阻（${refusal}），` : ''}请求${far || refusal ? '指示' : '退行对标'}`,
    options: [
      { key: 'back', label: '同意退行对标' },
      ...(end ? [] : [{ key: 'skip', label: '越站，不办理客运' }]),
    ],
    auto: far && !end ? 'skip' : 'back', timeout: 60,
  });
}

export function answerOverrun(sim: Sim, tr: Train | undefined, option: string): { ok: boolean; msg: string } {
  if (!tr || !tr.overrun) return { ok: false, msg: '情况已变化' };
  const task = tr.tasks[0];
  const d = tr.overrun;
  tr.overrun = 0;
  tr.stopUntil = 0;
  tr.stopReason = '';
  sim.clearAlarm(`overrun-${tr.id}`);
  if (d > 5) sim.metrics.safety.overrun++;
  if (task?.k !== 'stop') return { ok: true, msg: '' };
  if (option === 'skip') {
    tr.retreat = undefined;
    sim.log('B', '列车', `列车 ${trainLabel(tr)} ${STATIONS[task.station].name} 过标 ${d.toFixed(0)} m，越站（未办理客运）`);
    tr.tasks.shift();
    return { ok: true, msg: '越站运行，前方站广播' };
  }
  // Already taken over (key in, OCC told): the attendant only backs up, no second takeover sequence.
  if (unattended('doorClose') && tr.manual && tr.uto?.stage === 'manual') {
    if (tr.uto.computer && !(tr.mode === 'RM' || setMode(sim, tr, 'RM', tr.level, `${crewLabel()}转 RM 退行对标`))) {
      tr.overrun = d; tr.stopUntil = sim.t + 86400; tr.stopReason = 'RM 模式不可用';
      return { ok: false, msg: 'RM 模式不可用' };
    }
    tr.retreat = { distance: d, authorised: true, reported: true };
    if (tr.uto.computer) tr.uto.retreat = true;
    return { ok: true, msg: `同意退行对标，${crewLabel()}操作换向器退行` };
  }
  if (unattended('doorClose')) {
    const result=requestUtoControl(sim,tr,'RM',tr.uto?.computer??!tr.manual);
    if(!result.ok){tr.overrun=d;tr.stopUntil=sim.t+86400;tr.stopReason=result.msg;return result;}
    tr.retreat={distance:d,authorised:true,reported:true};
    tr.uto!.retreat=true;
    return {ok:true,msg:'同意退行对标，随车人员办理 RM 接管后退行'};
  }
  if (tr.manual) {
    tr.retreat = { distance: d, authorised: true, reported: true };
    return { ok: true, msg: '同意退行对标，司机操作换向器退行' };
  }
  // backing up under the dispatcher's permission takes its time
  moveBack(sim, tr, d);
  arriveAtBerth(sim, tr, task);
  if (tr.doorsAwait) tr.extraDwell += 30;
  else { tr.dwellUntil += 30; tr.depReadyAt += 30; }
  return { ok: true, msg: `退行 ${d.toFixed(1)} m 对标` };
}

/** a manually driven train has come to a stand: check the stopping position */
function manualArrival(sim: Sim, tr: Train, task: Task) {
  const err = stopError(sim, tr);
  if (Number.isNaN(err)) {
    if (tr.retreat && !tr.retreat.reported && !tr.overrun && task.k === 'stop')
      atoOverrun(sim, tr, task, -tr.retreat.distance, reversePermission(sim, tr).detail);
    return;
  }
  if (task.k !== 'stop') {
    // turnback / stabling berths: within a few metres is fine
    if (err <= 5 && err >= -3) arriveAtBerth(sim, tr, task);
    return;
  }
  const d = tr.drv;
  if (err > 1.0) {
    // short of the mark: move up (二次对标)
    if (err < 30 && !d.restop) { d.restop = true; dmiNote(sim, tr, '欠标停车，二次对标', 'warn'); }
    return;
  }
  const rec = (score: number, note: string) => {
    const r = { t: sim.t, station: task.station, err, score, note };
    tr.drv.stops.push(r);
    sim.drivingStops.push(r);
    d.releases = 0;
    d.braking = false;
    d.restop = false;
  };
  if (err >= -1.0) {
    // accuracy, one continuous brake application (一把闸), no second approach
    const oneBrake = d.releases === 0 && !d.restop;
    const score = Math.max(0, Math.min(100, Math.round(stopScore(err) * 0.8 + Math.max(0, 20 - 10 * d.releases) - (d.restop ? 30 : 0))));
    rec(tr.retreat ? 0 : score, tr.retreat ? '过标退行' : [oneBrake ? '一把闸' : d.releases ? `缓解${d.releases}次` : '', d.restop ? '二次对标' : ''].filter(Boolean).join(' '));
    sim.log('I', '列车', `列车 ${trainLabel(tr)} 人工驾驶 ${STATIONS[task.station].name} 停车，对标误差 ${err >= 0 ? '欠' : '过'}${Math.abs(err).toFixed(2)} m`);
    arriveAtBerth(sim, tr, task);
    return;
  }
  if (!tr.retreat) {
    tr.retreat = { distance: -err, authorised: -err <= 5 };
    if (-err > 5) atoOverrun(sim, tr, task, err);
    else dmiNote(sim, tr, '过标停车，司机退行对标', 'warn');
  }
  if (!tr.overrun && !tr.retreat.reported) {
    const permit = reversePermission(sim, tr);
    if (!permit.ok) atoOverrun(sim, tr, task, err, permit.detail);
  }

}

function enterDepot(sim: Sim, tr: Train, depot: number) {
  const dp = sim.topo.depots[depot];
  putVehicle(sim, depot, tr.vehicle);
  beginUtoReturn(sim,tr.vehicle);
  if (tr.coupledVehicle) {putVehicle(sim, depot, tr.coupledVehicle);beginUtoReturn(sim,tr.coupledVehicle);}
  sim.log('I', '车辆', `列车 ${tr.svc}（${tr.vehicle}）入${dp.name}`);
  finishBlock(sim, tr);
  sim.removeTrain(tr);
}

function finishBlock(sim: Sim, tr: Train) {
  if (tr.block >= 0) {
    sim.blockDone.add(tr.block);
    const b = sim.plan.blocks[tr.block];
    if (b) b.train = undefined;
  }
}

// ---------------------------------------------------------------- traces (actual train graph)

export function recordTrace(sim: Sim, tr: Train, force = false) {
  const ch = sim.trainChain(tr);
  if (!Number.isFinite(ch)) return;
  if (!force && sim.t - tr.lastTraceT < 20) return;
  if (!force && Math.abs(ch - tr.lastTraceCh) < 1 && sim.t - tr.lastTraceT < 120) return;
  // break the line when the train is out of revenue/position jumps
  tr.trace.push(sim.t, ch, tr.inService ? 1 : 0, Math.round(tr.inService ? tr.delay : 0));
  tr.lastTraceT = sim.t;
  tr.lastTraceCh = ch;
}

// ---------------------------------------------------------------- ARS

interface Desire {
  train: Train; signal: number; route: number; prio: number; eta: number; ready: boolean; berthWait?: boolean; chainSecs?: number[];
  /** path distance to `signal`, and the signals passed on the way whose route is already set for the train (signal, route, distance) */
  dist: number; via: [number, number, number][];
}

/** Both adopted and newly set resource entrances have the same applicant lifecycle. */
function bindAdmittedResourceRoute(sim: Sim, tr: Train, rid: number) {
  if (retreatRouteBlocker(sim, rid, tr.id)) return;
  const decision = resourceAllocation(sim).decisions.get(tr.id);
  if (!decision?.admitted || !decision.option.phases[0]?.routes.includes(rid)
    || !routeNeedsResourceProtection(sim, rid, decision.option)) return;
  const ar = sim.routes.get(rid);
  if (!ar || ar.manual || ar.guide || !ar.fleeting && ar.arsTrain !== tr.id) return;
  const owner = routeUser(sim, rid);
  if (owner >= 0 && owner !== tr.id) return;
  const wasFleeting = ar.fleeting;
  if (wasFleeting) { ar.fleeting = false; ar.defleeted = false; ar.arsTrain = tr.id; }
  ar.resourceBound = true;
  const route = sim.topo.routes[rid];
  if (wasFleeting && route.steps.some(s => s.link === tr.link && s.dir === tr.dir))
    signalPassed(sim, tr.id, route.start);
}

export function runARS(sim: Sim, prepared = false) {
  if (!prepared) arbitrateResources(sim);
  const allocation = resourceAllocation(sim);
  const { topo } = sim;
  // A whole-movement grant belongs to one train. Consume an existing
  // automatic entrance just like a newly set single-train route, so a
  // following train cannot inherit its MA while this train changes ends.
  for (const decision of allocation.decisions.values()) {
    const tr = decision.request.train;
    if (!decision.admitted || !tr) continue;
    // Later phases reserve the whole movement logically; their opposite
    // switch positions must not be physically locked before the turn.
    for (const rid of new Set(decision.option.phases[0]?.routes ?? [])) bindAdmittedResourceRoute(sim, tr, rid);
  }
  const desires: Desire[] = [];
  for (const tr of sim.trainList) {
    if (tr.failed || tr.phase === 'stabled' || tr.phase === 'coupling') continue;
    const d = trainDesire(sim, tr);
    if (d) desires.push(d);
  }
  desires.sort((a, b) => a.prio - b.prio || a.eta - b.eta);
  const desiredSigs = new Set<number>();
  const desiredSecs = new Set<number>();
  const desiredSw = new Map<number, 'N' | 'R'>();
  for (const d of desires) {
    const r = topo.routes[d.route];
    desiredSigs.add(d.signal);
    for (const s of d.chainSecs ?? r.sections) desiredSecs.add(s);
    for (const x of r.switches) desiredSw.set(x.sw, x.pos);
  }
  // a signal serves the first train approaching it: a train behind that wants a different
  // route from the same signal waits for it (otherwise the two would cancel each other's
  // route every cycle)
  const firstAt = new Map<number, { train: Train; route: number; dist: number }>();
  const claim = (sig: number, train: Train, route: number, dist: number) => {
    const f = firstAt.get(sig);
    if (!f || dist < f.dist) firstAt.set(sig, { train, route, dist });
  };
  for (const d of desires) {
    claim(d.signal, d.train, d.route, d.dist);
    for (const [sig, route, dist] of d.via) claim(sig, d.train, route, dist);
  }
  // Each applicant releases only its own unused route when it loses whole-
  // movement admission. Issued authority still goes through cancelArsRoute.
  for (const ar of [...sim.routes.values()]) {
    const applicant = sim.trains.get(ar.arsTrain ?? -1);
    const decision = applicant && allocation.decisions.get(applicant.id);
    const belongs = decision?.option.phases.some(p => p.routes.includes(ar.route));
    const current = decision?.option.phases[0]?.routes.includes(ar.route);
    const denied = decision && !decision.admitted && belongs
      || ar.resourceBound && !current;
    if (applicant && !ar.entered && !ar.manual
      && (denied || resourceAdmissionBlocked(sim, applicant, ar.route) || routeResourceBlocker(sim, applicant, ar.route)))
      cancelArsRoute(sim, applicant, topo.routes[ar.route].start);
  }
  // A route requested ahead of an intermediate stop may outlive that
  // request's priority. Its applicant relinquishes its own unused claim
  // when the existing front-train ordering now gives that signal to another
  // train; the front train must never cancel the rear train's route itself.
  for (const ar of [...sim.routes.values()]) {
    const signal = topo.routes[ar.route].start, first = firstAt.get(signal);
    const applicant = sim.trains.get(ar.arsTrain ?? -1);
    if (!ar.entered && !ar.manual && applicant && first && first.train !== applicant)
      cancelArsRoute(sim, applicant, signal);
  }
  // Protect every admitted phase, without physically locking opposite
  // switch positions together. Only an idle automatic route can be removed.
  for (const [sec, claim] of allocation.claims) {
    desiredSecs.add(sec);
    const lr = sim.sec[sec].lockRoute, ar = sim.routes.get(lr);
    if (!ar || !ar.fleeting || ar.manual || claim.option.phases.some(p => p.routes.includes(lr))) continue;
    if (!routeNeedsResourceProtection(sim, lr, claim.option)) continue;
    const start = topo.routes[lr].start;
    if (!sim.sig[start].ars) continue;
    if (approachLocked(sim, start) || topo.routes[lr].sections.some(s => sim.sec[s].trainOcc)) { ar.fleeting = false; ar.defleeted = true; }
    else if (claim.request.train) cancelArsRoute(sim, claim.request.train, start);
  }
  for (const d of desires) {
    const r = topo.routes[d.route];
    const secs = d.chainSecs ?? r.sections;
    const first = firstAt.get(d.signal)!;
    if (first.train !== d.train) {
      setArsWait(sim, d.train, 'ROUTE_WAIT', first.train.id, d.signal, `${topo.signals[d.signal].name} 先为前行列车排列进路`);
      continue;
    }
    if (resourceAdmissionBlocked(sim, d.train, d.route)) {
      const decision = allocation.decisions.get(d.train.id);
      setArsWait(sim, d.train, decision?.code ?? 'ROUTE_WAIT', decision?.blocker ?? -1, d.signal,
        decision?.detail || `${topo.signals[d.signal].name} 等待本车当前整段动作准入${decision?.admitted ? '（本进路属于后续阶段）' : ''}`, decision?.alternatives);
      continue;
    }
    if (first.train === d.train && sim.sig[d.signal].route === d.route) bindRouteApproach(sim, d.route, d.train.id);
    for (const [sig, route] of d.via) if (firstAt.get(sig)?.train === d.train && sim.sig[sig].route === route)
      bindRouteApproach(sim, route, d.train.id);
    const blocked = routeResourceBlocker(sim, d.train, d.route);
    if (blocked) {
      setArsWait(sim, d.train, 'ROUTE_WAIT', Math.max(-1, blocked.request.id), d.signal,
        resourceWaitDetail(sim, d.route, blocked));
      const ar = sim.routes.get(sim.sig[d.signal].route);
      if (ar && !ar.entered && !ar.manual) cancelArsRoute(sim, d.train, d.signal);
      continue;
    }
    if (!d.ready) {
      // waiting for an occupied berth on a wrong-direction move: stop the
      // conflicting automatic routes re-arming so the berth can be reached
      if (d.berthWait) {
        for (const s of secs) {
          const ar = sim.sec[s].lockRoute >= 0 ? sim.routes.get(sim.sec[s].lockRoute) : undefined;
          if (ar && ar.fleeting && !ar.manual && sim.sig[topo.routes[ar.route].start].ars) { ar.fleeting = false; ar.defleeted = true; }
        }
      }
      continue;
    }
    const sg = sim.sig[d.signal];
    if (!sg.ars) { setArsWait(sim, d.train, 'ARS_OFF', -1, d.signal); continue; }
    if (sg.route >= 0 && sg.route !== d.route) {
      const ar = sim.routes.get(sg.route)!;
      if (ar.manual) { setArsWait(sim, d.train, 'ROUTE_CONFLICT', -1, d.signal, `${topo.signals[d.signal].name} 已排人工进路`); continue; }
      const res = cancelArsRoute(sim, d.train, d.signal);
      if (!res.ok || sg.route >= 0) {
        const owner = res.blocker ?? routeUser(sim, sg.route);
        setArsWait(sim, d.train, owner < 0 ? routeFaultCode(sim, sg.route) ?? 'ROUTE_CONFLICT' : 'ROUTE_CONFLICT',
          owner, d.signal, res.msg);
        continue;
      }
    }
    if (sg.route === d.route) continue;
    let res = trySetRoute(sim, d.route, { fleeting: false, train: d.train.id });
    if (!res.ok) {
      // try to clear conflicting idle automatic routes (sections or switches held by them)
      const conflicts = new Set<number>();
      for (const s of r.sections) {
        const lr = sim.sec[s].lockRoute;
        if (lr >= 0 && lr !== d.route) conflicts.add(lr);
      }
      for (const { sw, pos } of r.switches) {
        if (sim.sw[sw].lockCount === 0 || sim.sw[sw].pos === pos) continue;
        for (const [rid2] of sim.routes) {
          if (rid2 !== d.route && topo.routes[rid2].switches.some((x) => x.sw === sw)) conflicts.add(rid2);
        }
      }
      let cleared = false;
      for (const lr of conflicts) {
        const ar = sim.routes.get(lr);
        if (!ar || !ar.fleeting || ar.manual) continue;
        const other = topo.routes[lr];
        if (!sim.sig[other.start].ars) continue;
        if (approachLocked(sim, other.start) || other.sections.some((x) => sim.sec[x].trainOcc)) {
          // let the train already committed to it through, but stop the
          // automatic route re-arming for the following ones
          ar.fleeting = false;
          ar.defleeted = true;
          continue;
        }
        const c = cancelArsRoute(sim, d.train, other.start);
        if (c.ok) cleared = true;
      }
      if (cleared) res = trySetRoute(sim, d.route, { fleeting: false, train: d.train.id });
    }
    if (!res.ok) {
      const b = routeBlocker(sim, d.route, d.train.id);
      const fault = b.train < 0 ? routeFaultCode(sim, d.route) : null;
      setArsWait(sim, d.train, fault ?? 'ROUTE_CONFLICT', b.train, d.signal, b.detail || res.msg);
    } else {
      bindAdmittedResourceRoute(sim, d.train, d.route);
      d.train.arsWait = null;
    }
  }
  // restore automatic (fleeting) routes on idle signals
  for (let i = 0; i < sim.sig.length; i++) {
    const sg = sim.sig[i];
    if (sg.route >= 0 || !sg.ars || !sg.autoPass || desiredSigs.has(i)) continue;
    const fr = topo.signals[i].routes.find((rid) => topo.routes[rid].fleeting);
    if (fr === undefined || resourceRouteReserved(sim, fr)) continue;
    if (topo.routes[fr].sections.some((s) => desiredSecs.has(s))) continue;
    if (topo.routes[fr].switches.some((x) => desiredSw.has(x.sw) && desiredSw.get(x.sw) !== x.pos)) continue;
    trySetRoute(sim, fr, { fleeting: true });
  }
}

/** The existing physical-stage ARS window, also used by resource admission. */
export function arsReadyAt(tr: Train): number {
  return tr.phase === 'dwell' ? tr.dwellUntil - 25
    : tr.phase === 'reversing' ? tr.dwellUntil - 30 : -Infinity;
}

export function trainDesire(sim: Sim, tr: Train): Desire | null {
  const { topo } = sim;
  let goalTask: Task | undefined = tr.tasks[0];
  let startSig = tr.nextSignal;
  let dist = tr.nextSignalDist;
  let ready = true;
  let eta = dist / Math.max(tr.v, 6);

  if (tr.phase === 'dwell') {
    goalTask = tr.tasks[1];
    const remain = Math.max(0, tr.dwellUntil - sim.t);
    const platform = topo.berths[(tr.tasks[0] as StopTask).berth].platform;
    if (tr.hold || platform >= 0 && sim.plat[platform].hold) return null;
    eta = remain + dist / 6;
    ready = sim.t >= arsReadyAt(tr);
  } else if (tr.phase === 'reversing') {
    goalTask = tr.tasks[1];
    const tail = tailPoint(sim, tr);
    const ahead = signalAheadFrom(sim, tail.link, tail.off, tail.dir, 400);
    if (!ahead) return null;
    startSig = ahead.sig;
    dist = ahead.dist;
    const remain = Math.max(0, tr.dwellUntil - sim.t);
    eta = remain + dist / 6;
    ready = sim.t >= arsReadyAt(tr);
  } else if (tr.phase !== 'run') return null;
  else if (goalTask && tr.stopDist < tr.nextSignalDist && goalTask.k !== 'depot') {
    // will stop before the next signal: nothing to do yet
    return null;
  }
  if (!goalTask) return null;
  if (goalTask.k === 'depot') goalTask = tr.tasks.find((t) => t.k === 'depot') ?? goalTask;
  if (goalTask.k === 'reverse' || (goalTask.k === 'stable' && goalTask.berth < 0)) goalTask = resolveChoice(sim, tr, goalTask);
  let goal = taskGoal(sim, goalTask);
  if (goal === -2 && goalTask.k === 'rescue') {
    // rescue: head for the failed train — route towards its next berth in our direction
    const f = sim.trains.get(goalTask.target);
    if (!f) return null;
    goal = nearestBerthAhead(sim, f);
    if (goal < 0) return null;
  }
  if (goal < 0 || startSig < 0) return null;
  const table = sim.routeTable.next.get(goal)!;
  let sig = startSig;
  const via: [number, number, number][] = [];
  const preserveClaim = (): Desire | null => {
    if (!via.length) return null;
    const [signal, route, distance] = via[0];
    return { train: tr, signal, route, dist: distance, prio: plannedTime(goalTask!, sim.t), eta, ready: false, via: via.slice(1) };
  };
  for (let level = 0; level < 4; level++) {
    const rid = table[sig];
    if (rid < 0) {
      // the goal lies short of the next signal (e.g. a reversal berth on the current link): nothing to route
      // (just after changing ends the signal still faces the old way for a step)
      if (topo.berths[goal].link !== tr.link && tr.phase !== 'reversing' && topo.signals[sig].dir === tr.dir
        && !sim.noRouteLogged.has(tr.id * 1000 + sig)) {
        sim.noRouteLogged.add(tr.id * 1000 + sig);
        sim.log('C', 'ATS', `列车 ${trainLabel(tr)} 在 ${topo.signals[sig].name} 无可用进路至 ${topo.berths[goal].name}`);
      }
      return preserveClaim();
    }
    const sg = sim.sig[sig];
    const decision = resourceAllocation(sim).decisions.get(tr.id);
    if (decision && !decision.admitted && decision.option.phases.some(p => p.routes.includes(rid))) {
      const active = sim.routes.get(sg.route);
      if (active && !active.entered && !active.manual) cancelArsRoute(sim, tr, sig);
      setArsWait(sim, tr, decision.code ?? 'ROUTE_CONFLICT', Math.max(-1, decision.blocker), sig, decision.detail, decision.alternatives);
      return { train: tr, signal: sig, route: rid, prio: plannedTime(goalTask, sim.t), eta, ready: false, dist, via };
    }
    const resourceBlocker = routeResourceBlocker(sim, tr, rid);
    if (resourceBlocker) {
      const active = sim.routes.get(sg.route);
      if (active && !active.entered && !active.manual) cancelArsRoute(sim, tr, sig);
      setArsWait(sim, tr, 'ROUTE_WAIT', Math.max(-1, resourceBlocker.request.id), sig, resourceWaitDetail(sim, rid, resourceBlocker));
      return { train: tr, signal: sig, route: rid, prio: plannedTime(goalTask, sim.t), eta, ready: false, dist, via };
    }
    // A reverse platform movement needs CBTC on arrival too: a CBTC train
    // bound for a zone in TBTC would degrade short of the platform and be
    // trapped there, so it keeps its current stop (D146).
    const goalZone = sim.zoneState[topo.links[topo.berths[goal].link].zone];
    if (topo.berths[goal].reverse && (tr.level === 'TBTC' || goalZone !== 'CBTC' || tr.forceLevel === 'TBTC')) {
      setArsWait(sim, tr, 'DIRECTION_WAIT', -1, sig, tr.level === 'TBTC' ? 'TBTC不能自动反向进路，须恢复CBTC' : '目标反向站台所在区域为TBTC，待恢复CBTC');
      return { train: tr, signal: sig, route: rid, prio: plannedTime(goalTask, sim.t), eta, ready: false, dist, via };
    }
    if (sg.route === rid) {
      const ar = sim.routes.get(rid)!;
      if (sg.aspect === 'R' || sg.aspect === 'FAIL') {
        const blocker = routeBlocker(sim,rid,tr.id);
        const fault = blocker.train < 0 ? routeFaultCode(sim,rid) : null;
        if (blocker.train >= 0 || fault) {
          setArsWait(sim,tr,blocker.train >= 0 ? 'TRAIN_AHEAD' : fault!,blocker.train,sig,blocker.detail);
          // Keep the first actual barrier. Reserving a farther signal while
          // this one is red overwrites its live blocker with an unrelated
          // route request, and can prevent the train in front clearing out.
          return {train:tr,signal:sig,route:rid,prio:plannedTime(goalTask,sim.t),eta,ready:false,dist,via};
        }
      }
      // consumed by another train: wait for its release
      if (ar.entered && !ar.fleeting && ar.owner !== tr.id) {
        setArsWait(sim, tr, 'TRAIN_AHEAD', ar.owner, sig, `进路 ${topo.routes[rid].name} 被前车占用`);
        return preserveClaim();
      }
      const r = topo.routes[rid];
      // Keep the nearest train's claim even after its complete route is set.
      // Otherwise a following train can cancel that route while its switches
      // are still moving, restarting the setting timer every ARS cycle.
      if (r.berths.includes(goal) || r.end < 0) return {
        train: tr, signal: sig, route: rid, prio: plannedTime(goalTask, sim.t), eta,
        ready: false, dist, via,
      };
      via.push([sig, rid, dist]);
      dist += r.length;
      eta += r.length / Math.max(tr.v, 8);
      sig = r.end;
      if (dist > 2500) return preserveClaim();
      continue;
    }
    // route needed here
    const prio = plannedTime(goalTask, sim.t);
    const r = topo.routes[rid];
    // a hot standby keeps to its turnback track until it is called out (D70),
    // a train stabled overnight to its stabling place (D72)
    if (!decision && sourceReadyAt(sim, goalTask, tr) > sim.t) {
      setArsWait(sim, tr, 'REGULATION', -1, sig, sourceWaitReason(goalTask));
      return { train: tr, signal: sig, route: rid, prio, eta, ready: false, dist, via };
    }
    let ok = ready && (level === 0 || dist < 1500);
    // Physical berth occupancy remains a routing condition for ordinary
    // through stops as well as motions handled by whole-resource admission.
    let berthWait = false;
    if (r.berths.includes(goal) && berthBusy(sim, goal, tr.id)
      && !(goalTask.k === 'rescue' && berthHolder(sim, goal, tr.id) === goalTask.target)) {
      berthWait = ok; ok = false;
      setArsWait(sim, tr, 'BERTH_WAIT', berthHolder(sim, goal, tr.id), sig, topo.berths[goal].name);
    }
    return { train: tr, signal: sig, route: rid, prio, eta, ready: ok,
      berthWait: berthWait && r.wrongDir && topo.berths[goal].reverse, dist, via };
  }
  return preserveClaim();
}

function tailPoint(_sim: Sim, tr: Train): { link: number; off: number; dir: Dir } {
  const segs = tr.body;
  const hist = tr.hist.slice(tr.hist.length - segs.length);
  const tailSeg = segs[segs.length - 1];
  const tailDir = hist[0].dir;
  return { link: tailSeg.link, off: tailDir === 1 ? tailSeg.from : tailSeg.to, dir: (tailDir === 1 ? -1 : 1) as Dir };
}

/** a berth just beyond the failed train in its travel direction (rescue routing) */
function nearestBerthAhead(sim: Sim, f: Train): number {
  const { topo } = sim;
  let l = f.link;
  let d = f.dir;
  for (let i = 0; i < 40; i++) {
    for (const b of topo.berths) if (b.link === l && b.dir === d && (b.offset - (l === f.link ? f.off : d === 1 ? 0 : topo.links[l].len)) * d >= -1) return b.id;
    const nx = nextLink(topo, l, d, (sw) => swPos(sim, sw));
    if (!nx) return -1;
    l = nx.link;
    d = nx.dir;
  }
  return -1;
}

/** driver reaction to guide signals / preset sections: switch to RM */
export function driverRM(sim: Sim) {
  const { topo } = sim;
  for (const tr of sim.trainList) {
    if (tr.phase !== 'run' || tr.v > 0.05 || tr.failed || tr.pendingMode
      || tr.manual && !(computerCrew(tr) && tr.mode === 'CM') || tr.eb) continue;
    if (tr.maDist > 35) continue;
    if (tr.nextSignal >= 0 && tr.nextSignalDist < 40 && sim.sig[tr.nextSignal].aspect === 'GUIDE') {
      const rid = sim.sig[tr.nextSignal].route;
      const len = rid >= 0 ? topo.routes[rid].length : 300;
      // the guide aspect is the per-signal RM authority for this one signal
      grantRM(sim, tr, len + tr.len + 30, tr.nextSignal, `引导信号 ${topo.signals[tr.nextSignal].name}`);
      continue;
    }
    if (tr.maCode === 'AXLE_PRESET' || tr.halt.code === 'AXLE_PRESET' && tr.halt.train < 0) {
      callRmPreset(sim, tr);
    }
  }
}

// ---------------------------------------------------------------- dispatcher train commands

export function cmdTrainHold(_sim: Sim, tr: Train, on: boolean) {
  tr.hold = on;
  if (!on && tr.phase === 'dwell' && tr.tasks[0]?.k === 'stop') tr.intervalRelease = tr.tasks[0].station;
  return { ok: true, msg: `列车 ${trainLabel(tr)} ${on ? '扣车' : '放行'}` };
}

export function cmdSkip(_sim: Sim, tr: Train, station: number, on: boolean) {
  if (on) tr.skipStations.add(station); else tr.skipStations.delete(station);
  return { ok: true, msg: `列车 ${trainLabel(tr)} ${on ? '设置' : '取消'}跳停 ${STATIONS[station].name}` };
}

function dirOf(tr: Train, topo: Topology): TrackDir {
  return travelDirection(topo, tr);
}

/** stations ahead of the train in its travel direction */
export function stationsAhead(sim: Sim, tr: Train): number[] {
  const ch = sim.trainChain(tr);
  const d = dirOf(tr, sim.topo);
  return sim.topo.stations.filter((s) => (d === 'DN' ? s.chain > ch + 20 : s.chain < ch - 20)).map((s) => s.index).sort((a, b) => (d === 'DN' ? a - b : b - a));
}

export function turnbackOptions(sim: Sim, tr: Train): number[] {
  const d = dirOf(tr, sim.topo);
  return stationsAhead(sim, tr).filter((s) => turnbackAt(sim.topo, s, d) !== null);
}

/** Follow only the registered route selected for this movement. Live switch
 * positions, occupancy and faults are deliberately left to normal ARS. */
function turnbackPath(sim: Sim, point: TrackPoint, goal: number, incoming: readonly RouteStep[], route?: number) {
  const start = routePathStart(sim.topo, point, goal, route);
  if (!start) return;
  const path = [...start.segments];
  if (!('reached' in start) && !Number.isFinite(walkRouteToBerth(sim.topo, sim.routeTable, start.start, goal,
    (link, from, to) => path.push({ link, from, to })))) return;
  const history = [...incoming];
  for (const segment of path) {
    if (segment.from === segment.to) continue;
    const step: RouteStep = { link: segment.link, dir: segment.to > segment.from ? 1 : -1 };
    const last = history.at(-1);
    if (!last || last.link !== step.link || last.dir !== step.dir) history.push(step);
  }
  const berth = sim.topo.berths[goal];
  return { point: { link: berth.link, off: berth.offset, dir: berth.dir } as TrackPoint, history };
}

/** A physical route already assigned to this train is the only selected
 * route to continue; do not inspect or modify another train's routes. */
function turnbackSelectedRoute(sim: Sim, tr: Train): number | undefined {
  for (const ar of sim.routes.values()) {
    if (ar.owner !== tr.id && ar.committed !== tr.id && ar.arsTrain !== tr.id) continue;
    if (sim.topo.routes[ar.route]?.steps.some(s => s.link === tr.link && s.dir === tr.dir)) return ar.route;
  }
}

function reversedTrainPoint(tr: Train): TrackPoint | undefined {
  const tail = tr.body.at(-1), hist = tr.hist.slice(tr.hist.length - tr.body.length);
  if (!tail || !hist.length || hist[0].link !== tail.link) return;
  const dir = hist[0].dir;
  return { link: tail.link, off: dir === 1 ? tail.from : tail.to, dir: -dir as Dir };
}

/** Recognise an existing turn only if its physical continuation is valid. */
function existingTurnbackSatisfied(sim: Sim, tr: Train, station: number): boolean {
  const first = tr.tasks[0];
  if (tr.phase === 'reversing' && first?.k === 'reverse' && first.station === station) {
    const next = tr.tasks[1], point = reversedTrainPoint(tr), berth = sim.topo.berths[first.chosen];
    if (next?.k !== 'stop' || next.station !== station || !point || !berth || berth.station !== station
      || !tr.body.some(part => part.link === berth.link)) return false;
    const trip = sim.plan.trips[next.trip];
    const goal = next.station === station ? departureBerthAfterReverse(sim.topo, first.chosen, next.berth) : next.berth;
    const target = sim.topo.berths[goal], direction = travelDirection(sim.topo, point);
    if (!target || target.station !== station) return false;
    const matchingTrip = trip ? trip.from === station && trip.dir === direction
      : next.station === station && !!target && travelDirection(sim.topo, { link: target.link, dir: target.dir }) === direction;
    return matchingTrip
      && !!turnbackPath(sim, point, goal, []);
  }
  if (first?.k !== 'stop' || first.station !== station || tr.phase !== 'run' || tr.v >= .05 || tr.lastDs > 1e-6 || tr.lastStation !== station
    || !['depart', 'manual'].includes(tr.tbStage)) return false;
  const trip = sim.plan.trips[first.trip];
  const physical = first.turnbackWaitBerth === undefined
    ? sim.topo.berths.some(b => b.station === station && tr.body.some(part => part.link === b.link))
    : sim.topo.berths[first.turnbackWaitBerth]?.station === station
      && tr.body.some(part => part.link === sim.topo.berths[first.turnbackWaitBerth!].link);
  const target = sim.topo.berths[first.berth], direction = dirOf(tr, sim.topo);
  if (!target || target.station !== station) return false;
  const matchingTrip = trip ? trip.from === station && trip.dir === direction
    : first.station === station && !!target && travelDirection(sim.topo, { link: target.link, dir: target.dir }) === direction;
  return physical && matchingTrip
    && !!turnbackPath(sim, { link: tr.link, off: tr.off, dir: tr.dir }, first.berth, tr.hist, turnbackSelectedRoute(sim, tr));
}

/** Preview the actual retargeted arrival and selected reverse, then verify
 * each phase through the opposite platform before changing the live plan. */
function turnbackCandidateProblem(sim: Sim, tr: Train, tasks: Task[]): string | undefined {
  let point: TrackPoint = { link: tr.link, off: tr.off, dir: tr.dir };
  let history: readonly RouteStep[] = tr.hist;
  let first = true, reversed = false, previousTurn: { berth: number; station: number } | undefined;
  for (const task of tasks) {
    if (task.k === 'rescue') return '救援任务无法作为折返接续';
    let berth = task.k === 'stop' ? task.berth : task.k === 'reverse' ? task.chosen
      : task.k === 'depot' ? depotBerth(sim.topo, task) : task.berth;
    if (berth < 0 || !sim.topo.berths[berth]) return '接续泊位尚未确定';
    if (task.k === 'stop' && previousTurn?.station === task.station)
      berth = departureBerthAfterReverse(sim.topo, previousTurn.berth, berth);
    previousTurn = undefined;
    const reached = turnbackPath(sim, point, berth, history, first ? turnbackSelectedRoute(sim, tr) : undefined);
    first = false;
    if (!reached) return `无法到达 ${sim.topo.berths[berth].name}`;
    point = reached.point; history = reached.history;
    if (task.k === 'reverse') {
      const changed = reversedBerthPoint(sim.topo, berth, tr.len, [...history]);
      if (!changed) return `${sim.topo.berths[berth].name} 无法容纳全列换端`;
      point = changed;
      history = [...history].reverse().map(s => ({ link: s.link, dir: -s.dir as Dir }));
      reversed = true; previousTurn = { berth, station: task.station };
    }
  }
  return reversed ? undefined : '没有可用的换端任务';
}

/** A skipped or overrun call never reaches this completion path. */
function rememberCompletedCall(sim: Sim, tr: Train, stop: StopTask) {
  if (stop.trip < 0 || (stop.stopIndex === undefined && !stop.revenue && stop.arr === null)) return;
  if (stop.stopIndex === undefined)
    sim.log('B', '运营', `列车 ${trainLabel(tr)} 的已完成停站索引缺失，车次按无已完成停站处理`);
  tr.lastCompletedCall = { trip: stop.trip, stopIndex: stop.stopIndex ?? -1 };
}

/** Index of the next planned call; old checkpoints can use its unique time. */
export function remainingStart(trip: Trip, tr: Train): number | undefined {
  // Depot/turnback positioning stops can share the trip id but are not
  // calls in its service. Older checkpoints lack stopIndex on real calls.
  const pending = tr.tasks.find(t => t.k === 'stop' && t.trip === trip.id && (t.revenue || t.stopIndex !== undefined));
  if (!pending || pending.k !== 'stop') return undefined;
  if (pending.stopIndex !== undefined && trip.stops[pending.stopIndex]?.st === pending.station) return pending.stopIndex;
  const sameStation = trip.stops.map((s, i) => ({ s, i })).filter(({s}) => s.st === pending.station);
  const timed = sameStation.filter(({s}) => pending.arr !== null && s.arr === pending.arr
    || pending.dep !== null && s.dep === pending.dep);
  const matches = timed.length ? timed : sameStation;
  return matches.length === 1 ? matches[0].i : undefined;
}

/** Resolve the first remaining occurrence of a station in this trip. */
function candidateCut(trip: Trip, tr: Train, station: number, cause: NonNullable<Trip['cut']>['cause']): Trip['cut'] | undefined {
  const pending = remainingStart(trip, tr);
  if (pending === undefined) return undefined;
  const last = tr.lastCompletedCall;
  // The next stopping task can be beyond planned pass-through or skipped
  // calls. Include those calls; route preflight still checks their physical
  // reachability from the train's actual position.
  let start = pending;
  if (last?.trip === trip.id && last.stopIndex >= -1 && last.stopIndex < pending)
    start = last.stopIndex + 1;
  else {
    // Old checkpoints lack a completed-call index. Only a contiguous run of
    // explicitly planned pass calls can be recovered without guessing.
    while (start > 0 && !trip.stops[start - 1].stop) start--;
  }
  const stopIndex = trip.stops.findIndex((s, i) => i >= start && s.st === station);
  if (stopIndex < 0 || (trip.cut && stopIndex > trip.cut.stopIndex)) return undefined;
  return { station, stopIndex, cause };
}

/** 人工折返 */
export function cmdTurnback(sim: Sim, tr: Train, station: number) {
  const { topo, plan } = sim;
  const d = dirOf(tr, topo);
  if (existingTurnbackSatisfied(sim, tr, station))
    return { ok: true, msg: `列车 ${trainLabel(tr)} 已在 ${STATIONS[station].name} 完成或正在执行所需折返`, reasonCode: 'TURNBACK_ALREADY_SATISFIED' };
  const tb = turnbackAt(topo, station, d);
  if (!tb) return { ok: false, msg: `${STATIONS[station].name} 无该方向折返条件`, reasonCode: 'TURNBACK_UNAVAILABLE' };
  if (tb.kind === 'front' && tr.level === 'TBTC') return { ok: false, msg: 'TBTC不能自动反向区间折返（P3 §2.4.2）；须恢复CBTC或安排其他折返站', reasonCode: 'TURNBACK_TBTC_UNAVAILABLE' };
  // keep stops up to the turnback station
  const keep: Task[] = [];
  for (const t of tr.tasks) {
    if (t.k === 'stop' && t.depotWork) break;
    if (t.k === 'stop' && (t.station === station || ahead(d, station, t.station))) break;
    if (t.k !== 'stop') break;
    keep.push({ ...t });
  }
  const est = sim.t + estimateRun(sim, tr, station);
  const arrStop: StopTask = { k: 'stop', berth: platformBerth(topo, station, d), station, trip: tr.tripId, arr: est, dep: null, doors: tr.inService, revenue: tr.inService, note: '人工折返' };
  const tasks: Task[] = [...keep, arrStop];
  const back: TrackDir = d === 'DN' ? 'UP' : 'DN';
  const fake: Trip = { id: -1, no: '', dir: d, kind: 'adj', from: station, to: station, stops: [], revenue: true, block: -1 };
  addTurnback(topo, fake, tasks);
  const commandReverse = tasks.at(-1);
  // Build the entire continuation on a shallow plan copy: all modified trips
  // and the affected block have their own objects. No live plan or task is
  // changed until the actual retargeted route has passed every phase.
  const block = tr.block >= 0 ? plan.blocks[tr.block] : null;
  const curTrip = tr.tripId >= 0 ? plan.trips[tr.tripId] : null;
  const cut = block && curTrip ? candidateCut(curTrip, tr, station, 'turnback') : undefined;
  if (block && curTrip && !cut)
    return { ok: false, msg: '折返站不在当前车次可截短的剩余站序中', reasonCode: 'TURNBACK_UNREACHABLE' };
  if (cut) arrStop.stopIndex = cut.stopIndex;
  const candidatePlan = { ...plan, trips: [...plan.trips], blocks: [...plan.blocks] };
  if (curTrip && cut) candidatePlan.trips[curTrip.id] = { ...curTrip, cut };
  const candidateBlock = block ? { ...block, trips: [...block.trips] } : null;
  if (candidateBlock) candidatePlan.blocks[candidateBlock.id] = candidateBlock;
  let adj: Trip | null = null;
  let replaced: Trip | undefined;
  if (block && curTrip) {
    const idx = block.trips.indexOf(curTrip.id);
    const nextTrip = block.trips.slice(idx + 1).map((i) => plan.trips[i]).find((t) => !t.cancelled);
    const nextEnd = nextTrip && effectiveEnd(nextTrip);
    if (nextTrip && nextEnd !== undefined && nextTrip.dir === back && ahead(back, station, nextEnd)) {
      // adjusted trip: from turnback station to the next trip's destination
      // depart as soon as the turnback allows (a station-front turnback occupies the opposite platform)
      const depAt = est + 240;
      const originalStops = new Map(effectiveStops(nextTrip).map(s => [s.st, s]));
      const stops = buildStops(sim.planCtx, back, station, nextEnd, depAt, nextTrip.revenue, 1,
        st => originalStops.get(st)?.stop ?? nextTrip.revenue);
      for (const stop of stops) {
        const original = originalStops.get(stop.st);
        if (original) {
          stop.stop = original.stop;
          if (original.noBoard !== undefined) stop.noBoard = original.noBoard;
        }
      }
      adj = { id: plan.trips.length, no: `6${nextTrip.no.slice(1)}`, dir: back, kind: 'adj', from: station, to: nextEnd, stops, revenue: nextTrip.revenue, block: block.id };
      candidatePlan.trips.push(adj);
      replaced = nextTrip;
      candidatePlan.trips[nextTrip.id] = { ...nextTrip };
      cancelTrip(candidatePlan.trips[nextTrip.id], `人工折返：${STATIONS[station].name}折返，改开调整车次${adj.no}`);
      candidateBlock!.trips.splice(candidateBlock!.trips.indexOf(nextTrip.id), 0, adj.id);
    }
  }
  if (adj && candidateBlock) {
    // The existing block builder owns direction changes and the final depot
    // move. A same-direction empty continuation must not change ends again.
    tasks.push(...blockTasks(topo, candidatePlan, candidateBlock, candidateBlock.trips.indexOf(adj.id)));
  } else {
    // no follow-on service: withdraw to depot after turning back
    depotTasks(topo, nearestDepot(sim, station, back), back, tasks);
  }
  // A block continuation must include the actual terminal operation in the
  // same task list being checked. If the builder cannot represent its end,
  // accepting a passenger-only prefix would strand the train after service.
  const end = adj && candidateBlock?.end;
  const lastTask = tasks.at(-1);
  const missingEnd = end?.kind === 'depot' ? lastTask?.k !== 'depot' || lastTask.depot !== end.depot
    : end?.kind === 'stable' ? lastTask?.k !== 'stable'
      || (end.berth !== undefined && lastTask.berth !== end.berth)
      || (lastTask.berth >= 0 && topo.berths[lastTask.berth]?.station !== end.station) : false;
  const problem = missingEnd ? '车底终点作业未生成' : turnbackCandidateProblem(sim, tr, tasks);
  if (problem)
    return { ok: false, msg: `列车 ${trainLabel(tr)} 无法完成 ${STATIONS[station].name} 折返：${problem}`, reasonCode: 'TURNBACK_UNREACHABLE' };
  // Only the commanded turn is fixed to its checked track. Later normal
  // duties retain their existing dynamic alternative-berth arbitration.
  if (commandReverse?.k === 'reverse') commandReverse.berths = [commandReverse.chosen];
  if (adj && block && replaced) {
    plan.trips.push(adj);
    cancelTrip(replaced, `人工折返：${STATIONS[station].name}折返，改开调整车次${adj.no}`);
    block.trips.splice(block.trips.indexOf(replaced.id), 0, adj.id);
  }
  if (block && curTrip) {
    curTrip.cancelled = curTrip.cancelled || false;
    curTrip.cut = cut;
    sim.planRev++;
  }
  settleDroppedCalls(sim, ...[curTrip, replaced].filter((t): t is Trip => !!t));
  tr.tasks = tasks;
  setTripFromTasks(sim, tr);
  sim.planDirty = true;
  return { ok: true, msg: `列车 ${trainLabel(tr)} 人工折返于 ${STATIONS[station].name}${adj ? `，折返后担当 ${adj.no}` : '，折返后回段'}` };
}

function estimateRun(sim: Sim, tr: Train, station: number): number {
  const ch = sim.trainChain(tr);
  return Math.abs(sim.topo.stations[station].chain - ch) / 11 + 30;
}

export function nearestDepot(sim: Sim, station: number, dir: TrackDir): number {
  const { topo } = sim;
  const ch = topo.stations[station].chain;
  let best = 0;
  let bd = Infinity;
  topo.depots.forEach((d, i) => {
    const ahead = dir === 'DN' ? d.junctionChain > ch : d.junctionChain < ch;
    const dist = Math.abs(d.junctionChain - ch) + (ahead ? 0 : 1e6);
    if (dist < bd) { bd = dist; best = i; }
  });
  return best;
}

/** A coupled consist changes ends on the portal platform only if it then
 * stands clear of the lead junction behind it. */
function entryFits(topo: Topology, depot: number, dir: TrackDir, len: number): boolean {
  const dp = topo.depots[depot], p = dp.portals.entry[dir];
  if (!p.reverse) return true;
  const b = topo.berths[platformBerth(topo, p.station, dir)], l = topo.links[b.link];
  const mark = l.chainA + (l.chainB - l.chainA) * b.offset / l.len;
  return Math.abs(mark - dp.junctionChain) >= len + 60;
}

/** nearestDepot ahead whose entry the consist fits (else the nearest) */
function fittingDepot(sim: Sim, station: number, dir: TrackDir, len: number): number {
  const { topo } = sim;
  const ch = topo.stations[station].chain;
  const ahead = topo.depots.map((_, i) => i)
    .filter((i) => (dir === 'DN' ? topo.depots[i].junctionChain > ch : topo.depots[i].junctionChain < ch) && entryFits(topo, i, dir, len))
    .sort((i, j) => Math.abs(topo.depots[i].junctionChain - ch) - Math.abs(topo.depots[j].junctionChain - ch));
  return ahead[0] ?? nearestDepot(sim, station, dir);
}

/** A return path must respect routes the train has already entered or cannot
 * stop short of. Geographic chainage alone can choose a depot junction whose
 * through route is already committed. */
function returnPathReachable(sim: Sim, tr: Train, berth: number): boolean {
  const signal = signalAheadFrom(sim, tr.link, tr.off, tr.dir, 3000);
  if (!signal) return sim.topo.berths[berth].link === tr.link;
  const table = sim.routeTable.next.get(berth)!;
  let sig = signal.sig;
  const seen = new Set<number>();
  while (sig >= 0 && !seen.has(sig)) {
    seen.add(sig);
    const wanted = table[sig];
    const actual = sim.sig[sig].route;
    const ar = sim.routes.get(actual);
    const fixed = ar && (ar.entered && ar.owner === tr.id || ar.committed === tr.id || committedTrain(sim,sig) === tr.id);
    const rid = fixed ? actual : wanted;
    if (rid < 0) return false;
    const route = sim.topo.routes[rid];
    if (route.berths.includes(berth)) return true;
    sig = route.end;
  }
  return false;
}

/** Depots a train running `d` can still return to from `clearChain` on, nearest
 * first: straight in, or by changing ends on the junction station's platform
 * where the leads join against `d` (that platform must be ahead and reachable). */
function depotsAhead(sim: Sim, tr: Train, d: TrackDir, clearChain: number): { dp: Topology['depots'][number]; index: number }[] {
  const { topo } = sim;
  const where = (dp: Topology['depots'][number]) => {
    const p = dp.portals.entry[d];
    return p.reverse ? topo.stations[p.station].chain : dp.junctionChain;
  };
  return topo.depots.map((dp, index) => ({ dp, index }))
    .filter(({ dp }) => {
      const p = dp.portals.entry[d];
      if (!p.reverse) return (d === 'DN' ? dp.junctionChain > clearChain : dp.junctionChain < clearChain) && returnPathReachable(sim, tr, dp.entryBerths[p.path]);
      const c = topo.stations[p.station].chain;
      return (d === 'DN' ? c >= clearChain - 1 : c <= clearChain + 1) && returnPathReachable(sim, tr, platformBerth(topo, p.station, d));
    })
    .sort((a, b) => Math.abs(where(a.dp) - clearChain) - Math.abs(where(b.dp) - clearChain));
}

/** 退出服务（清客回段） */
export function cmdWithdraw(sim: Sim, tr: Train, reason = '调度命令') {
  const { topo, plan } = sim;
  if (tr.tasks[0]?.k === 'depot') {
    tr.inService = false;
    tr.withdrawn = true;
    return { ok: true, msg: `列车 ${tr.svc}已在回段，保留现有入段路径` };
  }
  // Entering a turnback siding: the only way out is the end change already
  // routed; a new forward path from here would run into the buffer stop.
  if (tr.tasks[0]?.k === 'reverse') return { ok: false, msg: '列车正在进入折返线，换端完成后再办理退出服务' };
  const d = dirOf(tr, topo);
  const ahead = stationsAhead(sim, tr);
  const next = ahead[0];
  // Clear passengers first. An otherwise reachable depot can be behind the
  // clear-out station, so select a forward return path from that station.
  const clearStation = tr.phase === 'dwell' ? curStop(tr)?.station : tr.inService ? next : undefined;
  const clearChain = clearStation === undefined ? sim.trainChain(tr) : topo.stations[clearStation].chain;
  const forward = depotsAhead(sim, tr, d, clearChain);
  const depot = forward[0]?.index ?? nearestDepot(sim, tr.lastStation >= 0 ? tr.lastStation : (next ?? 0), d);
  const reachable = forward.length > 0;
  const tasks: Task[] = [];
  if (tr.phase === 'dwell') {
    const cur = { ...curStop(tr)! };
    cur.revenue = false;
    cur.doors = true;
    cur.dep = null;
    cur.minDwell = 60;
    tasks.push(cur);
  } else if (next !== undefined && tr.inService) {
    tasks.push({ k: 'stop', berth: platformBerth(topo, next, d), station: next, trip: -1, arr: null, dep: null, doors: false, revenue: false, minDwell: 60, note: '清客' });
  }
  if (reachable) depotTasks(topo, depot, d, tasks);
  else {
    const platform = topo.links[tr.link].platform;
    const current = tr.phase === 'dwell' ? curStop(tr)?.station
      : topo.stations.find(st => st.platforms[d] === platform)?.index;
    // Keep the already issued approach to the normal clear-out platform.
    // A front turnback would retarget it to the parallel reverse platform,
    // which may be unreachable once the old route has been entered.
    const afterClear = (station: number) => clearStation === undefined
      || (d === 'DN' ? station >= clearStation : station <= clearStation);
    // (a platform turnback track retargets the clear-out stop like a front turn)
    const rearOk = (st: number) => { const tb = turnbackAt(topo, st, d); return tb?.kind === 'rear' && topo.berths[tb.berths[0]].kind !== 'platform'; };
    const tbSt = current !== undefined && afterClear(current) && rearOk(current) ? current
      : turnbackOptions(sim, tr).find(st => afterClear(st) && rearOk(st));
    if (tbSt === undefined) return { ok: false, msg: '前方无折返/回段条件' };
    const berth = topo.berths[platformBerth(topo, tbSt, d)];
    const alreadyCleared = current === tbSt && tr.load === 0 && tr.link === berth.link && tr.dir === berth.dir
      && (tr.dir === 1 ? tr.off >= berth.offset - 1 : tr.off <= berth.offset + 1);
    if (!alreadyCleared && !tasks.some((t) => t.k === 'stop' && t.station === tbSt)) tasks.push({ k: 'stop', berth: berth.id, station: tbSt, trip: -1, arr: null, dep: null, doors: false, revenue: false, minDwell: 20 });
    const fake: Trip = { id: -1, no: '', dir: d, kind: 'adj', from: tbSt, to: tbSt, stops: [], revenue: false, block: -1 };
    addTurnback(topo, fake, tasks);
    const back: TrackDir = d === 'DN' ? 'UP' : 'DN';
    depotTasks(topo, nearestDepot(sim, tbSt, back), back, tasks);
  }
  // cancel remaining trips of the block
  if (tr.block >= 0) {
    const b = plan.blocks[tr.block];
    const idx = b.trips.indexOf(tr.tripId);
    const tail = liveTail(sim, b, idx);
    for (const tid of b.trips.slice(idx + 1)) cancelTrip(plan.trips[tid], `列车${tr.svc}退出服务（${reason}）`);
    if (tr.tripId >= 0) {
      if (!plan.trips[tr.tripId].completed) cancelTrip(plan.trips[tr.tripId], `列车${tr.svc}退出服务（${reason}）`);
    }
    sim.planDirty = true;
    const home = tasks.at(-1);
    if (home?.k === 'depot') {
      // 【假设】Conservative stock-credit clock for an unplanned move: 36
      // km/h over its physical task path, 120 s per cab change and 5 min
      // entry clearance. Actual yard stock is still credited on real entry.
      let at = sim.trainChain(tr), distance = 0;
      for (const task of tasks) {
        const target = task.k === 'stop' ? topo.stations[task.station].chain
          : task.k === 'reverse' ? topo.stations[task.station].chain
            : task.k === 'depot' ? topo.depots[task.depot].junctionChain : at;
        distance += Math.abs(target-at); at = target;
      }
      b.withdrawal = { depot: home.depot, at: sim.t + 60 + distance/10 + tasks.filter(task=>task.k==='reverse').length*120 + DEPOT_ENTRY_CLEAR };
    }
    const unfinished = tr.tripId >= 0 && !plan.trips[tr.tripId].completed ? [tr.tripId] : [];
    standbyTakeover(sim, b.id, [...unfinished, ...tail], `列车${tr.svc}退出服务`);
  }
  if (tr.phase === 'dwell' && tr.load > 0) { sim.passengersCleared += tr.load; sim.metrics.cleared += tr.load; tr.load = 0; }
  tr.tasks = tasks;
  tr.inService = false;
  tr.tripNo = '回段';
  tr.destText = topo.depots[tasks[tasks.length - 1].k === 'depot' ? (tasks[tasks.length - 1] as { depot: number }).depot : depot].short;
  tr.withdrawn = true;
  return { ok: true, msg: `列车 ${tr.svc}（${tr.vehicle}）退出服务（${reason}），清客后回${topo.depots[depot].name}` };
}

/** Trips of a duty after index `idx` that are still to run: what losing the
 * train cancels and a standby may take over. */
function liveTail(sim: Sim, b: Block, idx: number): number[] {
  return b.trips.slice(idx + 1).filter(id => !sim.plan.trips[id].cancelled && !sim.plan.trips[id].completed);
}

/** Lateness above which a train is taken out of its current service (D44 R1, s). */
export const SEVERE_DELAY = 600;

/**
 * Recovery regulation (D44, D147). Explicit rules, each decided on the state
 * of this one train — never on time elapsed since an incident. A late train
 * keeps carrying passengers: there is no clearing and empty positioning to
 * chase an original slot (D147, 用户决定). A late train is first relieved by
 * the terminal hot standby, which it then replaces (`cmdStandbyRelief`);
 * at an intermediate station it takes the slot due now by a duty exchange
 * (R4, `cmdExchangeDuty`). This command is the terminal fallback:
 *  R2 missed cycle: at the terminal of a completed trip whose next departure
 *     was missed by more than 2 min, the missed whole cycle is cancelled and
 *     the train takes its own next departure from this terminal.
 *  Otherwise the train keeps its plan and runs it late; it returns to the
 *  depot only when its duty has no departure left.
 */
export function cmdRecoverService(sim: Sim, tr: Train) {
  if (tr.tasks[0]?.k === 'depot' || tr.depotStage === 'in')
    return { ok: false, msg: '已在回段，不能改接载客始发时隙' };
  if (tr.tasks[0]?.k === 'reverse') return { ok: false, msg: '列车正在进入折返线，换端完成后再办理' };
  const current = curStop(tr);
  if (tr.failed || tr.manual || tr.coupledLen > 0 || tr.phase !== 'dwell' || !current
    || current.dep !== null || current.trip < 0 || !sim.plan.trips[current.trip].completed || tr.block < 0)
    return { ok: false, msg: '须在已完成车次的终点停站办理恢复调度；中途大晚点照常载客，不清客空驶（D147）' };
  const skip = skipMissedCycle(sim, tr, current);
  if (skip.ok) return skip;
  const departure = tr.tasks.some((t, i) => i > 0 && t.k === 'stop' && t.revenue && t.dep !== null && t.trip >= 0
    && !sim.plan.trips[t.trip].cancelled);
  if (!departure) return cmdWithdraw(sim, tr, '故障恢复：车底已无后续始发，回段');
  return { ok: false, msg: `${skip.msg}；按原计划晚点载客运行（D147）` };
}

/** How far from now the departure of the trip a late train takes over by
 * R4 may be: it runs that trip at most this late, and is not held for it (s). */
export const EXCHANGE_DELAY = 120;

const exchangeable = (sim: Sim, tr: Train) => !tr.failed && !tr.manual && tr.coupledLen === 0 && !tr.withdrawn
  && !tr.relievedBy && tr.inService && tr.block >= 0 && tr.rescuing < 0 && tr.rescueBy < 0
  && !sim.plan.blocks[tr.block].relieved && tr.tasks[0]?.k === 'stop' && tr.tasks[0].trip === tr.tripId;

/** the two trips call at the same stations, the same way, from `from` to the end */
function sameRoute(a: Trip, b: Trip, from: number): boolean {
  if (a.dir !== b.dir || effectiveEnd(a) !== effectiveEnd(b) || !a.revenue || !b.revenue) return false;
  const rest = (t: Trip) => { const stops = effectiveStops(t); return stops.slice(stops.findIndex(p => p.st === from)); };
  const ra = rest(a), rb = rest(b);
  return ra.length > 0 && ra.length === rb.length && ra[0].st === from && rb[0].st === from
    && ra.every((p, i) => p.st === rb[i].st && p.stop === rb[i].stop);
}

/**
 * R4 车次调整 (D44): the train `tr`, standing at an intermediate station of
 * its trip more than SEVERE_DELAY late, and the train running the
 * same-route trip due to leave that station now, which has not reached it
 * yet. Null when there is none.
 */
export function exchangePartner(sim: Sim, tr: Train): Train | null {
  const cur = tr.tasks[0];
  if (tr.phase !== 'dwell' || !exchangeable(sim, tr) || cur?.k !== 'stop' || cur.arr === null || cur.dep === null
    || sim.t - cur.dep <= SEVERE_DELAY) return null;
  const own = sim.plan.trips[tr.tripId];
  let best: Train | null = null;
  let bestGap = Infinity;
  for (const w of sim.trainList) {
    if (w === tr || !exchangeable(sim, w) || w.block === tr.block) continue;
    const trip = sim.plan.trips[w.tripId];
    const next = w.tasks[0] as StopTask;
    // the partner still has to call at every station it would run under the late trip
    if (!sameRoute(own, trip, next.station) || !sameRoute(own, trip, cur.station)) continue;
    const at = w.tasks.find(t => t.k === 'stop' && t.trip === trip.id && t.station === cur.station) as StopTask | undefined;
    if (!at || at.dep === null || at.dep - cur.dep <= EXCHANGE_DELAY) continue;
    // due now: the late train runs it at most EXCHANGE_DELAY late, and is not held for it
    const gap = at.dep - sim.t;
    if (gap < -EXCHANGE_DELAY || gap > 60 || Math.abs(gap) >= bestGap) continue;
    best = w;
    bestGap = Math.abs(gap);
  }
  return best;
}

/** Resume at the actual passenger call, not a positioning or depot cab
 * change that happens to carry the same trip number and station. */
export function serviceDutyTail(sim: Pick<Sim, 'topo' | 'plan'>, block: Block, trip: Trip, station: number): Task[] | undefined {
  const index = block.trips.indexOf(trip.id);
  if (index < 0) return undefined;
  const tasks = blockTasks(sim.topo, sim.plan, block, index);
  const anchor = tasks.findIndex(t => t.k === 'stop' && t.trip === trip.id && t.station === station && t.revenue && t.doors);
  return anchor < 0 ? undefined : tasks.slice(anchor);
}

/**
 * R4 车次调整 (duty exchange, D44). The late train takes the identity (trip,
 * duty, 表号) of the same-route trip due to leave its station now; the
 * train of that trip, behind it, takes the late trip and the late train's
 * duty in exchange. Both trains keep their stations, platforms and the
 * terminal they run to: only the timetable each one runs to changes, so the
 * exchange is decided on the two trains' own state. The late trip keeps its
 * lateness and its record; a later train can pass it on in turn, or it is
 * cleared by R1/R5.
 */
export function cmdExchangeDuty(sim: Sim, tr: Train, other: number) {
  const w = sim.trains.get(other);
  if (!w || exchangePartner(sim, tr) !== w) return { ok: false, msg: '无可调整的同交路正点车次' };
  const { plan } = sim;
  const bx = plan.blocks[tr.block], bw = plan.blocks[w.block];
  const tx = plan.trips[tr.tripId], tw = plan.trips[w.tripId];
  const retime = (t: Train, tasks: Task[]) => {
    const cur = t.tasks[0] as StopTask;
    const head = tasks[0] as StopTask;
    if (!cur.revenue) {
      // This cab has not completed its own physical depot exit. Keep only
      // its unexecuted positioning steps, not the incoming duty's source.
      const firstCall = t.tasks.findIndex(x => x.k === 'stop' && x.trip === cur.trip && x.revenue);
      if (firstCall > 0) return [...t.tasks.slice(0, firstCall).map(x =>
        x.k === 'stop' && x.trip === cur.trip ? { ...x, trip: head.trip } : x), ...tasks];
    }
    // a train at the platform keeps its stop; it now leaves to the new timetable
    tasks[0] = t.phase === 'dwell' ? { ...cur, trip: head.trip, stopIndex: head.stopIndex, arr: head.arr, dep: head.dep } : { ...head, berth: cur.berth };
    return tasks;
  };
  const serviceStation = (t: Train) => {
    const call = t.tasks.find(x => x.k === 'stop' && x.trip === t.tripId && x.revenue);
    return call?.k === 'stop' ? call.station : (t.tasks[0] as StopTask).station;
  };
  const late = Math.round((sim.t - (tr.tasks[0] as StopTask).dep!) / 60);
  const tailX = serviceDutyTail(sim, bw, tw, serviceStation(tr));
  const tailW = serviceDutyTail(sim, bx, tx, serviceStation(w));
  if (!tailX || !tailW) return { ok: false, msg: '车次调整缺少对应的实际客运停站，保留原车次' };
  const nx = retime(tr, tailX);
  const nw = retime(w, tailW);
  tr.tasks = nx;
  w.tasks = nw;
  [tr.block, w.block] = [bw.id, bx.id];
  bw.train = tr.id;
  bx.train = w.id;
  [tr.svc, w.svc] = [bw.svc, bx.svc];
  for (const t of [tr, w]) {
    setTripFromTasks(sim, t);
    const keep = new Set(t.tasks.flatMap(x => x.k === 'stop' ? [x.berth] : x.k === 'reverse' ? [x.chosen] : []));
    for (const [berth, train] of sim.berthRes) if (train === t.id && !keep.has(berth)) sim.berthRes.delete(berth);
  }
  const head = tr.tasks[0] as StopTask;
  tr.delay = sim.t - (head.dep ?? sim.t);
  sim.planDirty = true;
  const msg = `车次调整：列车${tr.vehicle}晚点${late}分钟，改按${tw.no}（表号${bw.svc}）运行；后续列车${w.vehicle}改按${tx.no}（表号${bx.svc}）运行`;
  sim.log('C', '运营', msg);
  return { ok: true, msg };
}

/** R2: at the terminal, cancel the missed whole cycle and take the train's
 * own original slot from the same platform within 15 minutes. */
function skipMissedCycle(sim: Sim, tr: Train, current: StopTask) {
  const first = tr.tasks.findIndex((t, i) => i > 0 && t.k === 'stop' && t.arr === null && t.dep !== null);
  const missed = tr.tasks[first];
  if (missed?.k !== 'stop' || missed.dep === null || missed.dep >= sim.t - 120)
    return { ok: false, msg: '无已错过始发的接续车次' };
  const target = tr.tasks.findIndex((t, i) => i > first && t.k === 'stop' && t.arr === null
    && t.berth === missed.berth && t.dep !== null && t.dep >= sim.t + 120 && t.dep <= sim.t + 900);
  const reason = '故障恢复：取消已错过的完整往返接续';
  if (target < 0) return { ok: false, msg: '无近期同终点接续；保留后续计划，须另行人工调整' };
  const reverse = tr.tasks[target - 1];
  if (reverse?.k !== 'reverse') return { ok: false, msg: '接续车次缺少可验证的换端路径' };
  const cancelled = new Set<number>();
  for (const task of tr.tasks.slice(1, target)) if (task.k === 'stop' && task.trip >= 0
    && !sim.plan.trips[task.trip].completed) cancelled.add(task.trip);
  if (!cancelled.size) return { ok: false, msg: '无可取消的未开行车次' };
  for (const id of cancelled) cancelTrip(sim.plan.trips[id], reason);
  for (const [berth, train] of sim.berthRes) if (train === tr.id && berth !== current.berth) sim.berthRes.delete(berth);
  tr.tasks = [current, { ...reverse, chosen: -1 }, ...tr.tasks.slice(target)];
  sim.planDirty = true;
  return { ok: true, msg: `取消${cancelled.size}趟未开行车次，按原图接续${sim.plan.trips[(tr.tasks[2] as StopTask).trip].no}；已完成车次及原始晚点记录保留` };
}



/**
 * Dispatcher RM authorisation: bound to one signal (default: the next signal
 * ahead). The authority covers the approach to that signal and the route /
 * block section behind it, up to the following signal.
 */
export function cmdAuthRM(sim: Sim, tr: Train, signal?: number) {
  if (tr.failed) return { ok: false, msg: '列车故障中' };
  if (tr.eb) return { ok: false, msg: '列车紧急制动中，须先授权缓解' };
  if (tr.v > 0.1) return { ok: false, msg: '列车须停车后转RM' };
  const sig = signal ?? tr.nextSignal;
  if (sig < 0) return { ok: false, msg: '前方无信号机' };
  if (sig !== tr.nextSignal) return { ok: false, msg: 'RM授权仅限前方第一架信号机' };
  const unsafe = unsafeAhead(sim, tr);
  if (unsafe) return { ok: false, msg: unsafe };
  const equipment = ['SIGNAL_FAULT', 'SWITCH_FAULT', 'AXLE_FAULT', 'AXLE_PRESET', 'ZC_FAULT', 'COMM_LOSS'];
  if (!equipment.includes(tr.maCode) && !equipment.includes(tr.arsWait?.code ?? '') && sim.sig[sig].aspect !== 'GUIDE') {
    return { ok: false, msg: 'RM仅用于设备/信号故障；前车占用或未排进路须等待' };
  }
  const d = sig === tr.nextSignal ? tr.nextSignalDist : distToNextSignal(sim, tr);
  const beyond = signalBlockLength(sim, sig);
  if (!grantRM(sim, tr, d + beyond, sig, `调度授权越过信号机 ${sim.topo.signals[sig].name}`)) return { ok: false, msg: '当前条件下不能转RM' };
  return { ok: true, msg: `授权列车 ${trainLabel(tr)} 以RM模式越过 ${sim.topo.signals[sig].name}（${Math.round(d + beyond)} m，≤25km/h，目视行车）` };
}


/** length from a signal to the next signal in its direction (the block it protects) */
function signalBlockLength(sim: Sim, sig: number): number {
  const { topo } = sim;
  const s = topo.signals[sig];
  let link = s.link;
  let dir = s.dir;
  let d = 0;
  for (let i = 0; i < 40 && d < 3000; i++) {
    d += topo.links[link].len;
    const nx = nextLink(topo, link, dir, (sw) => swPos(sim, sw));
    if (!nx) break;
    const node = dir === 1 ? topo.links[link].b : topo.links[link].a;
    if (topo.signalByEntry.has(node * 65536 + nx.link)) break;
    link = nx.link;
    dir = nx.dir;
  }
  return d;
}

// ---------------------------------------------------------------- rescue

/** A two-rake rescue cannot couple a third rake or pass a second failed train. */
export function rescueBlockedByConsist(sim: Sim, failed: Train): number {
  if (failed.failed && !failed.failRecoverable && failed.rescueBy >= 0) {
    const rescuer = sim.trains.get(failed.rescueBy);
    const goal = nearestBerthAhead(sim,failed);
    const rid = rescuer && goal >= 0 ? sim.routeTable.next.get(goal)?.[rescuer.nextSignal] ?? -1 : -1;
    // A failed consist straddling the terminal scissors can lock a required
    // point in the other position. Moving it under that body is forbidden.
    if (rescuer && rescuer.v < .05 && rid >= 0 && sim.topo.routes[rid].switches.some(({sw,pos}) =>
      sim.sw[sw].pos !== pos && sim.topo.switches[sw].sections.some(section =>
        sim.topo.sections[section].links.some(link => sim.linkBodies.get(link)?.some(body=>body.train===failed.id))))) return rescuer.id;
  }
  if (!failed.failed || failed.failRecoverable || failed.rescueBy >= 0
    || sim.trainList.some(tr => rescueApproach(sim,failed,tr))) return -1;
  const goal = nearestBerthAhead(sim,failed);
  return sim.trainList.find(tr => tr.coupledLen > 0 && tr.v < .05
    && goal >= 0 && trainAheadOf(sim,tr,8000,goal) === failed.id)?.id ?? -1;
}

/** Planned rescue approach, including a change of ends in a terminal tail. */
export function rescueApproach(sim: Sim, failed: Train, rescuer: Train): { goal: number; reverseFailed: boolean } | null {
  if (rescuer.id === failed.id || rescuer.failed || rescuer.rescuing >= 0 || rescuer.coupledLen > 0
    || !['run', 'dwell'].includes(rescuer.phase) || rescuer.manual) return null;
  const sameDirection = dirOf(rescuer, sim.topo) === dirOf(failed, sim.topo);
  if (sameDirection) {
    const goal = nearestBerthAhead(sim, failed);
    return goal >= 0 && trainAheadOf(sim, rescuer, 8000, goal) === failed.id ? { goal, reverseFailed: false } : null;
  }
  // Cab change is stationary and preserves the footprint. Limit opposing-end
  // rescue to a terminal tail, where the approach remains off the running line.
  if (failed.v > 0.01 || !failed.failed) return null;
  const chain = sim.trainChain(failed);
  const station = chain < sim.topo.stations[0].chain ? 0 : chain > sim.topo.stations.at(-1)!.chain ? sim.topo.stations.length - 1 : -1;
  if (station < 0 || sim.topo.sections[sim.topo.links[failed.link].section].kind !== 'tail'
    && !['manual','depart','arrive'].includes(failed.tbStage)) return null;
  const d = rescuer.dir;
  const goal = sim.topo.stations[station].turnbackBerths.find(id => {
    const b = sim.topo.berths[id];
    return b.dir === d && sim.topo.links[b.link].track === sim.topo.links[failed.link].track;
  });
  return goal !== undefined && trainAheadOf(sim, rescuer, 8000, goal) === failed.id ? { goal, reverseFailed: true } : null;
}

export function cmdRescue(sim: Sim, failed: Train, rescuer: Train) {
  if (!failed.failed) return { ok: false, msg: '被救援列车未处于故障状态' };
  if (rescuer.failed) return { ok: false, msg: '救援列车本身故障' };
  // Validate the planned physical path, rather than geographic proximity on
  // parallel tracks. A stopped terminal-tail train may change ends for rescue.
  const approach = rescueApproach(sim, failed, rescuer);
  if (!approach) return { ok: false, msg: '救援列车须为故障列车后方同向列车（中间无其他列车）' };
  const { topo } = sim;
  if (approach.reverseFailed) {
    // Cancel the failed train's unused pull-out through normal CI checks. Its
    // route can otherwise keep both tail tracks and the rescue approach locked.
    for (const [rid, ar] of [...sim.routes]) if (ar.directionTrain === failed.id && !ar.entered)
      cancelInterlockedRoute(sim, topo.routes[rid].start,{source:'recovery',train:failed.id});
    reverseTrain(sim, failed);
    failed.rescueReverse = true;
    setTurnbackStage(sim, failed, 'arrive'); failed.tbExitSig = -1;
  }
  const d = dirOf(rescuer, topo);
  const tasks: Task[] = [];
  // clear-out at the next station before the failed train, if any
  const failedCh = sim.trainChain(failed);
  const nextSt = stationsAhead(sim, rescuer).find(st => {
    const berth = topo.berths[platformBerth(topo,st,d)];
    const link = topo.links[berth.link];
    const stop = link.chainA + (link.chainB-link.chainA)*berth.offset/link.len;
    // The train's head stops beyond the station centre. Clearing first is
    // possible only when the full stop keeps the normal train separation.
    return d==='DN' ? stop < failedCh-failed.len-25 : stop > failedCh+failed.len+25;
  });
  if (rescuer.inService && rescuer.phase !== 'dwell' && nextSt !== undefined) {
    tasks.push({ k: 'stop', berth: platformBerth(topo, nextSt, d), station: nextSt, trip: -1, arr: null, dep: null, doors: false, revenue: false, minDwell: 90, note: '救援清客' });
  } else if (rescuer.phase === 'dwell') {
    const cur = cowTask(rescuer, curStop(rescuer)!);
    cur.revenue = false; cur.dep = null; cur.minDwell = 90;
    tasks.push(cur);
  }
  tasks.push({ k: 'rescue', target: failed.id });
  if (rescuer.block >= 0) {
    const b = sim.plan.blocks[rescuer.block];
    const idx = b.trips.indexOf(rescuer.tripId);
    const why = `救援：列车${rescuer.svc}担任故障列车${failed.svc}的救援车`;
    const tail = liveTail(sim, b, idx);
    for (const tid of b.trips.slice(idx + 1)) cancelTrip(sim.plan.trips[tid], why);
    if (rescuer.tripId >= 0) {
      if (!sim.plan.trips[rescuer.tripId].completed) cancelTrip(sim.plan.trips[rescuer.tripId], why);
    }
    const unfinished = rescuer.tripId >= 0 && !sim.plan.trips[rescuer.tripId].completed ? [rescuer.tripId] : [];
    standbyTakeover(sim, b.id, [...unfinished, ...tail], `列车${rescuer.svc}担任救援`);
  }
  rescuer.tasks = tasks;
  rescuer.inService = false;
  rescuer.tripNo = '救援';
  rescuer.rescuing = failed.id;
  failed.rescueBy = rescuer.id;
  sim.planDirty = true;
  return { ok: true, msg: `组织列车 ${rescuer.svc}（${rescuer.vehicle}）救援故障列车 ${failed.svc}（${failed.vehicle}）` };
}

/** id of the first train ahead of `tr` (same direction path), or -1 */
export function trainAheadOf(sim: Sim, tr: Train, maxDist: number, goal = -1): number {
  const { topo } = sim;
  let l = tr.link;
  let d = tr.dir;
  let dist = 0;
  const positions = new Map<number, 'N' | 'R'>();
  const table = goal >= 0 ? sim.routeTable.next.get(goal) : undefined;
  // same link ahead
  const own = sim.linkBodies.get(l)?.filter((s) => s.train !== tr.id && (d === 1 ? s.from >= tr.off - 0.5 : s.to <= tr.off + 0.5)) ?? [];
  if (own.length) return own.sort((a, b) => (d === 1 ? a.from - b.from : b.to - a.to))[0].train;
  dist = d === 1 ? topo.links[l].len - tr.off : tr.off;
  for (let i = 0; i < 200 && dist < maxDist; i++) {
    const node = topo.nodes[d === 1 ? topo.links[l].b : topo.links[l].a];
    if (table) {
      const sig = node.links.map(link => topo.signalByEntry.get(node.id * 65536 + link))
        .filter((id): id is number => id !== undefined).map(id => topo.signals[id])
        .find(s => table[s.id] >= 0 && topo.routes[table[s.id]].steps[0]?.dir === d);
      if (sig) for (const { sw, pos } of topo.routes[table[sig.id]].switches) positions.set(sw, pos);
    }
    const nx = nextLink(topo, l, d, sw => positions.get(sw) ?? swPos(sim, sw) ?? sim.sw[sw].pos);
    if (!nx) return -1;
    l = nx.link;
    d = nx.dir;
    const segs = sim.linkBodies.get(l);
    if (segs && segs.length) {
      const sorted = segs.slice().sort((a, b) => (d === 1 ? a.from - b.from : b.to - a.to));
      return sorted[0].train;
    }
    dist += topo.links[l].len;
  }
  return -1;
}

function rescueStep(sim: Sim, tr: Train, target: number) {
  const f = sim.trains.get(target);
  if (!f) { tr.tasks.shift(); return; }
  if(tr.mode!=='RM'&&tr.v<.05&&tr.nextSignalDist<40&&rescueRouteReady(sim,tr,tr.nextSignal)){
    const route=sim.topo.routes[sim.sig[tr.nextSignal].route];
    if(relockRescueApproach(sim,tr,tr.nextSignal).ok)
      grantRM(sim,tr,tr.nextSignalDist+route.length+10,tr.nextSignal,'救援：既有锁闭进路内目视接近（≤3km/h）');
  }
  // approach in RM when close
  const gapToFailed = tr.maReason === '救援连挂' ? tr.maDist : Infinity;
  // RM only when the missing authority is caused by the failed train itself:
  // its body ends the MA, or the MA ends at a signal / block boundary and the
  // failed train is the first train beyond it. Held by any other train, the
  // rescuer waits like any follower.
  const byTarget = tr.maTrain === f.id || (tr.maTrain < 0 && trainAheadOf(sim, tr, 400) === f.id);
  if (tr.mode !== 'RM' && tr.v < 0.05 && tr.maDist < 60 && byTarget && !unsafeAhead(sim, tr, f.id)) {
    // the rescue order authorises passing the signal between the rescuer and the failed train
    const sig = tr.nextSignal >= 0 && tr.nextSignalDist <= tr.maDist + 15 ? tr.nextSignal : -1;
    grantRM(sim, tr, 400, sig, '救援连挂（≤3km/h 接近）');
  }
  if (gapToFailed < 0.6 && tr.v < 0.05) {
    tr.phase = 'coupling';
    tr.phaseSince = sim.t;
    tr.dwellUntil = sim.t + 60;
    sim.log('C', '列车', `救援列车 ${tr.svc}（${tr.vehicle}）与故障列车 ${f.svc}（${f.vehicle}）连挂作业`);
  }
}

function completeCoupling(sim: Sim, tr: Train) {
  const { topo } = sim;
  const task = tr.tasks[0];
  const f = task && task.k === 'rescue' ? sim.trains.get(task.target) : undefined;
  tr.tasks.shift();
  if (!f) { tr.phase = 'run'; return; }
  // merge consists: head moves to the failed train's head
  const rh = tr.hist.slice(tr.hist.length - tr.body.length);
  const fh = f.hist.slice(f.hist.length - f.body.length);
  const merged = [...rh];
  for (const h of fh) if (merged[merged.length - 1]?.link !== h.link) merged.push(h);
  tr.link = f.link;
  tr.off = f.off;
  tr.dir = f.dir;
  tr.hist = merged;
  tr.len = tr.len + f.len + 1;
  tr.coupledLen = f.len;
  tr.coupledVehicle = f.vehicle;
  tr.load += f.load;
  computeBody(sim, tr);
  sim.passengersStranded += 0;
  const fBlock = f.block;
  if (fBlock >= 0) {
    sim.blockDone.add(fBlock);
    const b = sim.plan.blocks[fBlock];
    const idx = b.trips.indexOf(f.tripId);
    const why = `列车故障：列车${f.svc}不能恢复，由${tr.svc}连挂救援回段`;
    const tail = liveTail(sim, b, idx);
    for (const tid of b.trips.slice(idx + 1)) cancelTrip(sim.plan.trips[tid], why);
    if (f.tripId >= 0) {
      if (!sim.plan.trips[f.tripId].completed) cancelTrip(sim.plan.trips[f.tripId], why);
    }
    const unfinished = f.tripId >= 0 && !sim.plan.trips[f.tripId].completed ? [f.tripId] : [];
    standbyTakeover(sim, b.id, [...unfinished, ...tail], `故障列车${f.svc}连挂回段`);
  }
  const fault = sim.faults.find((x) => x.kind === 'trainFail' && x.target === f.id && !x.repaired);
  if (fault) { fault.repaired = true; }
  sim.clearAlarm(`tf-${f.id}`);
  // The joined physical consist now owns the failed train's occupied routes.
  // Removing the failed id must not release them underneath its new rear.
  for(const ar of sim.routes.values()){
    if(ar.owner===f.id)ar.owner=tr.id;
    if(ar.directionTrain===f.id)ar.directionTrain=tr.id;
    if(ar.committed===f.id)ar.committed=tr.id;
  }
  sim.removeTrain(f);
  setMode(sim, tr, 'RM', tr.level, '');
  tr.rmAuth = 0;
  tr.rmSig = -1;
  tr.tripNo = '救援';
  tr.phase = 'run';
  // continue to the next station, detrain, then to the nearest depot / siding
  const d = dirOf(tr, topo);
  const currentPlatform = topo.links[tr.link].platform;
  const next = stationsAhead(sim, tr)[0] ?? (currentPlatform >= 0 ? topo.platforms[currentPlatform].station : undefined);
  const tasks: Task[] = [];
  const tailStation = sim.trainChain(tr) < topo.stations[0].chain && d === 'UP' ? 0
    : sim.trainChain(tr) > topo.stations.at(-1)!.chain && d === 'DN' ? topo.stations.length - 1 : -1;
  if (tailStation >= 0 && next === undefined) {
    const berths = topo.stations[tailStation].turnbackBerths.filter(id => topo.berths[id].dir === tr.dir && topo.links[topo.berths[id].link].track === topo.links[tr.link].track);
    if (berths.length) {
      tasks.push({ k: 'reverse', berths, chosen: berths[0], station: tailStation, minTime: 40 });
      const back = d === 'DN' ? 'UP' : 'DN';
      tasks.push({ k: 'stop', berth: platformBerth(topo, tailStation, back), station: tailStation, trip: -1, arr: null, dep: null, doors: false, revenue: false, minDwell: 120, note: '故障车清客' });
      depotTasks(topo, fittingDepot(sim, tailStation, back, tr.len), back, tasks);
      tr.tasks = tasks; setTurnbackStage(sim, tr, 'arrive');
      sim.log('B', '列车', '终点折返股道救援连挂完成，换端后清客回段');
      return;
    }
  }
  // A failed train that had already passed the stop mark of its terminal
  // platform (leaving for the turnback) cannot be pushed back to it: the
  // consist turns back and is cleared on the other platform instead.
  const passed = (station: number) => {
    const berth = topo.berths[platformBerth(topo, station, d)];
    const link = topo.links[berth.link];
    const mark = link.chainA + (link.chainB - link.chainA) * berth.offset / link.len;
    return d === 'DN' ? sim.trainChain(tr) > mark + 1 : sim.trainChain(tr) < mark - 1;
  };
  if (next !== undefined && !passed(next)) tasks.push({ k: 'stop', berth: platformBerth(topo, next, d), station: next, trip: -1, arr: null, dep: null, doors: false, revenue: false, minDwell: 120, note: '故障车清客' });
  const clearChain = next === undefined ? sim.trainChain(tr) : topo.stations[next].chain;
  const forward = depotsAhead(sim, tr, d, clearChain).filter((x) => entryFits(topo, x.index, d, tr.len));
  const depot = forward[0]?.index ?? nearestDepot(sim,next ?? 0,d);
  const reachable = forward.length>0;
  if (reachable) depotTasks(topo, depot, d, tasks);
  else {
    // A coupled consist cannot fit a single-train siding. Continue to a
    // terminal tail sized for it, turn back and return both vehicles to depot.
    // Include the current terminal: its station centre is behind the head
    // when the failed train was already stopped at the arrival mark.
    const tbs = [...new Set([...(next === undefined ? [] : [next]), ...turnbackOptions(sim, tr)])];
    const terminal = tbs.find(s => (s === 0 || s === topo.stations.length - 1) && turnbackAt(topo, s, d)?.kind === 'rear');
    if (terminal !== undefined) {
      if (!tasks.some(t => t.k === 'stop' && t.station === terminal) && !passed(terminal)) tasks.push({ k: 'stop', berth: platformBerth(topo, terminal, d), station: terminal, trip: -1, arr: null, dep: null, doors: false, revenue: false, minDwell: 10 });
      addTurnback(topo, { id: -1, no: '', dir: d, kind: 'adj', from: terminal, to: terminal, stops: [], revenue: false, block: -1 }, tasks);
      const back = d === 'DN' ? 'UP' : 'DN';
      tasks.push({ k: 'stop', berth: platformBerth(topo, terminal, back), station: terminal, trip: -1, arr: null, dep: null, doors: false, revenue: false, minDwell: 10 });
      depotTasks(topo, fittingDepot(sim, terminal, back, tr.len), back, tasks);
    }
  }
  tr.tasks = tasks;
  const clear = tasks.find((t): t is StopTask => t.k === 'stop');
  sim.log('B', '列车', `救援连挂完成，救援列车推送故障车以RM模式运行至 ${clear ? `${STATIONS[clear.station].name}${clear.berth === platformBerth(topo, clear.station, d) ? '' : '（折返后）'}` : '前方站'} 清客后回段`);
  void entryStation;
}

export function failTrain(sim: Sim, tr: Train, recoverable: boolean, recoverAfter: number) {
  tr.failed = true;
  tr.failRecoverable = recoverable;
  tr.failRecoverAt = sim.t + recoverAfter;
  if (tr.phase === 'run' && tr.v > 0.01) {
    // a moving train brakes to a stand under the EB (movement.ts goes on
    // integrating it); it becomes a standing failed train once stopped
    applyEB(sim, tr, '列车牵引/制动故障', 'driver');
    return;
  }
  tr.phase = tr.phase === 'dwell' ? 'dwell' : 'failed';
  tr.v = 0;
}

export function recoverTrain(sim: Sim, tr: Train) {
  tr.failed = false;
  if (tr.phase === 'failed') tr.phase = 'run';
  sim.log('C', '列车', `列车 ${trainLabel(tr)} 故障排除，恢复运行`);
}

export { goalBerth, releaseRoute };
