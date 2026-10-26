/**
 * Simulation integrity checker (§5): safety invariants after every fixed
 * step, liveness invariants once a second.
 *
 * It reads the dynamic state only — it never writes to the signalling
 * layers — and re-derives what it checks independently of the code that
 * produced the state (its own track walk for the MA / route check, its own
 * body overlap test, its own observation of every state machine).
 *
 * A violation is recorded with a diagnostic snapshot of the trains and
 * routes involved, raised as an A-level "仿真完整性" alarm for every
 * instance (an identical repeat on the same train within 10 s is the same
 * event), and fails the tests (assertIntegrity).
 */
import type { Sim } from './engine';
import type { Train } from './model';
import { nextLink } from './topology';
import { swPos } from './interlocking';
import {
  MODE, EB, PSD, ROUTE, CALL, FAULT, TURNBACK, DEPOT, GUARDS, modeState, ebState, routeState,
  allowed, type Machine,
} from './fsm';
import { HALT, rootCause } from './halt';
import { canStopBeforeSignal } from './protection';

export type ViolationKind =
  | 'OVERLAP' | 'BEYOND_MA' | 'MA_NO_ROUTE' | 'SWITCH_UNDER_LOAD' | 'EB_ACCEL' | 'OVERSPEED' | 'FSM'
  | 'LIVENESS' | 'DEADLOCK' | 'NEGATIVE_COUNT' | 'ARS_FOREIGN_CANCEL' | 'ARS_AUTHORITY_CANCEL';

export const VIOLATION_LABEL: Record<ViolationKind, string> = {
  ARS_FOREIGN_CANCEL: 'ARS取消了其他列车的进路',
  ARS_AUTHORITY_CANCEL: 'ARS取消了常用制动无法接受收缩的授权',
  OVERLAP: '两列车占用同一段线路',
  BEYOND_MA: '列车越过移动授权终点',
  MA_NO_ROUTE: '移动授权越过未锁闭进路的信号机',
  SWITCH_UNDER_LOAD: '道岔在锁闭/占用状态下转换',
  EB_ACCEL: '紧急制动中列车未减速',
  OVERSPEED: '超过紧急制动触发速度而未紧急制动',
  FSM: '状态转换不在转换表中',
  LIVENESS: '列车非计划停车超过5分钟（无豁免原因）',
  DEADLOCK: '列车相互等待（死锁）',
  NEGATIVE_COUNT: '候车人数或载客量为负',
};

export interface Violation {
  t: number;
  kind: ViolationKind;
  trains: number[];
  detail: string;
  /** JSON-serialisable state of the entities involved */
  snapshot: DiagSnapshot;
}

export interface DiagSnapshot {
  t: number;
  trains: Record<string, unknown>[];
  routes: { route: number; name: string; state: string; owner: number; arsTrain?: number; committed: number; cancelAt: number }[];
  zones: string[];
}

export interface IntegrityState {
  violations: Violation[];
  /** last time each identical violation was seen (repeat suppression) */
  lastAt: Map<string, number>;
  /** violation instances raised (alarm key sequence) */
  seq: number;
  /** last observed state per machine:entity */
  fsm: Map<string, string>;
  /** speed at the previous step (EB deceleration check) */
  prevV: Map<number, number>;
  /** first time a wait-for cycle was seen, by its sorted member list */
  cycles: Map<string, number>;
  /** total count per kind (KPI) */
  counts: Record<string, number>;
  /** since when each train's wait chain has had no exempt cause (the liveness clock) */
  stuckSince: Map<number, number>;
  /** since when each train has stood, outside its plan, for an exempt cause */
  heldSince: Map<number, number>;
}

/** standing beyond the end of the planned stop longer than this is a liveness violation (s) */
export const LIVENESS_LIMIT = 300;
/** a wait-for cycle that persists this long is a deadlock (s) */
export const DEADLOCK_LIMIT = 60;
/** an exempt (fault, procedure, hold) standstill outside the plan raises an A alarm after this (s) */
export const EXEMPT_LIMIT = 1800;
/** an identical repeat of a violation (same kind, trains and detail) within this window is the same event (s) */
const REPEAT_WINDOW = 10;
/** couplers in contact during a rescue coupling (m) */
const COUPLING_CONTACT = 1;
const MAX_KEPT = 200;

export function newIntegrity(): IntegrityState {
  return { violations: [], lastAt: new Map(), fsm: new Map(), prevV: new Map(), cycles: new Map(), counts: {}, stuckSince: new Map(), heldSince: new Map(), seq: 0 };
}

function trainSnap(sim: Sim, tr: Train): Record<string, unknown> {
  return {
    id: tr.id, svc: tr.svc, trip: tr.tripNo, vehicle: tr.vehicle, link: tr.link, off: +tr.off.toFixed(2), dir: tr.dir,
    chain: Math.round(sim.trainChain(tr)), v: +tr.v.toFixed(3), phase: tr.phase, mode: tr.mode, level: tr.level, manual: tr.manual,
    comm: tr.comm, eb: tr.eb, ebCause: tr.ebCause, ebReason: tr.ebReason, maDist: +tr.maDist.toFixed(1), maReason: tr.maReason,
    maCode: tr.maCode, maTrain: tr.maTrain, vEbi: +tr.vEbi.toFixed(2), rmAuth: tr.rmAuth, rmSig: tr.rmSig, nextSignal: tr.nextSignal,
    nextSignalDist: +tr.nextSignalDist.toFixed(1), halt: { ...tr.halt }, task: tr.tasks[0] ? { k: tr.tasks[0].k } : null,
    pendingMode: tr.pendingMode, forceLevel: tr.forceLevel,
  };
}

export function diagSnapshot(sim: Sim, trains: number[]): DiagSnapshot {
  const { topo } = sim;
  const trs = trains.map((id) => sim.trains.get(id)).filter((x): x is Train => !!x);
  const links = new Set<number>();
  for (const tr of trs) for (const b of tr.body) links.add(b.link);
  const routes: DiagSnapshot['routes'] = [];
  for (const ar of sim.routes.values()) {
    const r = topo.routes[ar.route];
    const near = r.steps.some((s) => links.has(s.link)) || trs.some((tr) => tr.nextSignal === r.start);
    if (near) routes.push({ route: ar.route, name: r.name, state: routeState(sim, ar.route), owner: ar.owner, arsTrain: ar.arsTrain, committed: ar.committed, cancelAt: ar.cancelAt });
  }
  return { t: sim.t, trains: trs.map((tr) => trainSnap(sim, tr)), routes, zones: sim.zoneState.slice() };
}

export function violate(sim: Sim, kind: ViolationKind, trains: number[], detail: string, subject = trains.join(',')) {
  const g = sim.integrity;
  // Every instance is recorded and alarmed. Only an identical repeat (same
  // kind, trains, subject and detail) within a short window is suppressed:
  // a persisting condition is re-checked every step and would otherwise
  // raise one alarm per 0.1 s for the same event.
  const key = `${kind}:${subject}:${trains.join(',')}:${detail.replace(/[\d.]+/g, '#')}`;
  const last = g.lastAt.get(key);
  g.lastAt.set(key, sim.t);
  if (g.lastAt.size > 4096) for (const [k, at] of g.lastAt) if (sim.t - at >= REPEAT_WINDOW) g.lastAt.delete(k);
  if (last !== undefined && sim.t - last < REPEAT_WINDOW) return;
  g.counts[kind] = (g.counts[kind] ?? 0) + 1;
  const v: Violation = { t: sim.t, kind, trains, detail, snapshot: diagSnapshot(sim, trains) };
  g.violations.push(v);
  if (g.violations.length > MAX_KEPT) g.violations.splice(0, g.violations.length - MAX_KEPT);
  g.seq++;
  sim.log('A', '完整性', `仿真完整性：${VIOLATION_LABEL[kind]} — ${detail}`, { key: `integrity-${kind}-${g.seq}`, code: `INTEGRITY_${kind}`, train: trains[0], snapshot: v.snapshot });
}

/** Audit the accepted cancellation before CI releases or delays the route. */
export function checkArsCancellation(sim: Sim, signal: number, requester: number) {
  const ar = sim.routes.get(sim.sig[signal].route);
  if (!ar) return;
  const assigned = ar.arsTrain ?? -1; // old unassigned automatic routes remain unclaimed
  const other = [assigned, ar.owner, ar.committed].find(id => id >= 0 && id !== requester && sim.trains.has(id));
  const label = (id: number) => { const t = sim.trains.get(id); return t ? `${t.svc}-${t.tripNo}（ID ${id}）` : `ID ${id}`; };
  for (const tr of sim.trainList) if (tr.maSigs.includes(signal) && !canStopBeforeSignal(sim,tr,signal,'supervision'))
    violate(sim, 'ARS_AUTHORITY_CANCEL', [...new Set([requester, tr.id])], `${label(requester)} 在 ${sim.topo.signals[signal].name} 取消已向 ${label(tr.id)} 发出移动授权的进路 ${sim.topo.routes[ar.route].name}`, `signal-${signal}`);
  if (other === undefined) return;
  violate(sim, 'ARS_FOREIGN_CANCEL', [requester, other], `${label(requester)} 在 ${sim.topo.signals[signal].name} 取消为 ${label(other)} 排列的进路 ${sim.topo.routes[ar.route].name}`, `signal-${signal}`);
}

// ---------------------------------------------------------------- safety (every step)

export function checkSafety(sim: Sim) {
  checkOverlap(sim);
  for (const tr of sim.trainList) {
    checkMotion(sim, tr);
    checkMaRoutes(sim, tr);
  }
  checkSwitches(sim);
  observeMachines(sim);
  checkCounts(sim);
}

/** passengers waiting and on board are never negative */
function checkCounts(sim: Sim) {
  for (const tr of sim.trainList) if (!(tr.load >= 0)) violate(sim, 'NEGATIVE_COUNT', [tr.id], `${tr.svc}-${tr.tripNo} 载客量 ${tr.load}`, `load${tr.id}`);
  sim.plat.forEach((p, i) => { if (!(p.waiting >= 0)) violate(sim, 'NEGATIVE_COUNT', [], `${sim.topo.platforms[i].name} 候车 ${p.waiting}`, `wait${i}`); });
}

function checkOverlap(sim: Sim) {
  for (const [link, segs] of sim.linkBodies) {
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const a = segs[i];
        const b = segs[j];
        if (a.train === b.train) continue;
        const ta = sim.trains.get(a.train);
        const tb = sim.trains.get(b.train);
        if (!ta || !tb) continue;
        const overlap = Math.min(a.to, b.to) - Math.max(a.from, b.from);
        // The only exemption: the two rakes of a rescue pair touch while
        // coupling (contact, not intrusion). Once coupled they are one train.
        const coupling = (ta.rescuing === tb.id && ta.phase === 'coupling') || (tb.rescuing === ta.id && tb.phase === 'coupling');
        if (coupling && overlap <= COUPLING_CONTACT) continue;
        if (overlap > 0.5) violate(sim, 'OVERLAP', [ta.id, tb.id], `${ta.vehicle} / ${tb.vehicle} 于区段 ${sim.topo.sections[sim.topo.links[link].section].name} 重叠 ${overlap.toFixed(1)} m`);
      }
    }
  }
}

function checkMotion(sim: Sim, tr: Train) {
  const g = sim.integrity;
  const prev = g.prevV.get(tr.id);
  g.prevV.set(tr.id, tr.v);
  if (tr.phase !== 'run') return;
  // An automatic RM move (rescue approach, RM past a failed signal) is bounded
  // by the RM authority in its scan; only a manually driven RM train is on sight.
  const onSight = tr.mode === 'RM' && tr.manual;
  // the train did not run past the authority it had at the start of the step
  // Withdrawal changes the braking target, not the last issued authority.
  // EB gives no exemption from this bound.
  if (!onSight && Number.isFinite(tr.lastMa) && tr.lastDs > tr.lastMa + 0.5) {
    violate(sim, 'BEYOND_MA', [tr.id], `${tr.svc}-${tr.tripNo} 本步行驶 ${tr.lastDs.toFixed(2)} m，授权仅 ${tr.lastMa.toFixed(2)} m（${tr.maReason}）`);
  }
  if (tr.eb && prev !== undefined && tr.v > prev + 1e-6) {
    violate(sim, 'EB_ACCEL', [tr.id], `${tr.svc}-${tr.tripNo} 紧急制动中速度 ${prev.toFixed(2)}→${tr.v.toFixed(2)} m/s`);
  }
  if (!tr.eb && Number.isFinite(tr.vEbi) && tr.v > tr.vEbi + 0.5) {
    violate(sim, 'OVERSPEED', [tr.id], `${tr.svc}-${tr.tripNo} 速度 ${(tr.v * 3.6).toFixed(1)} km/h > 紧急制动触发速度 ${(tr.vEbi * 3.6).toFixed(1)} km/h`);
  }
}

/**
 * The authority of an ATP-protected train may pass a signal only over a set
 * and locked route — re-derived by walking the track from the train's head
 * through the current switch positions.
 */
function checkMaRoutes(sim: Sim, tr: Train) {
  if (tr.phase !== 'run' || tr.mode === 'RM' || !Number.isFinite(tr.maDist)) return;
  // tr.maDist was measured before this step's movement
  const ma = tr.maDist - tr.lastDs;
  if (ma <= 0) return;
  const { topo } = sim;
  let link = tr.link;
  let dir = tr.dir;
  let d = dir === 1 ? topo.links[link].len - tr.off : tr.off;
  for (let i = 0; i < 120 && d < ma - 0.5; i++) {
    // Loss of detection does not physically throw a locked point. A train
    // braking within an already issued MA uses its retained locked position;
    // new authority scans still require current detection.
    const nx = nextLink(topo, link, dir, (sw) => swPos(sim, sw) ?? (tr.maCut && tr.eb && sim.sw[sw].lockCount > 0 ? sim.sw[sw].pos : null));
    if (!nx) {
      violate(sim, 'MA_NO_ROUTE', [tr.id], `${tr.svc}-${tr.tripNo} 授权 ${ma.toFixed(0)} m 越过线路终点/未到位道岔（距 ${d.toFixed(0)} m）`, `${tr.id}`);
      return;
    }
    const sid = topo.signalByEntry.get(nx.node * 65536 + nx.link);
    if (sid !== undefined) {
      const sg = sim.sig[sid];
      const ar = sg.route >= 0 ? sim.routes.get(sg.route) : undefined;
      // a train committed to a route (could no longer stop when its signal failed / the route
      // was cancelled) keeps the authority it already had over it (D3)
      const ok = ar && ar.state === 'locked' && !ar.guide && (!sg.failed || ar.committed === tr.id);
      if (!ok) {
        violate(sim, 'MA_NO_ROUTE', [tr.id], `${tr.svc}-${tr.tripNo} 授权 ${ma.toFixed(0)} m 越过信号机 ${topo.signals[sid].name}（${ar ? (ar.guide ? '引导进路' : ar.state) : '无进路'}${sg.failed ? '，故障' : ''}）`, `${tr.id}:${sid}`);
        return;
      }
    }
    d += topo.links[nx.link].len;
    link = nx.link;
    dir = nx.dir;
  }
}

function checkSwitches(sim: Sim) {
  const { topo } = sim;
  for (let i = 0; i < sim.sw.length; i++) {
    const s = sim.sw[i];
    const moving = !s.failed && (s.pos !== s.target || sim.t < s.moveUntil);
    if (!moving) continue;
    const occ = topo.switches[i].sections.some((x) => sim.sec[x].trainOcc);
    let locked = '';
    for (const ar of sim.routes.values()) {
      if (ar.state !== 'locked') continue;
      // behind the train the route releases its switches section by section
      if (sim.routeUnlockedSw.get(ar.route)?.has(i)) continue;
      if (topo.routes[ar.route].switches.some((x) => x.sw === i)) { locked = topo.routes[ar.route].name; break; }
    }
    if (occ || locked) violate(sim, 'SWITCH_UNDER_LOAD', [], `道岔 ${topo.switches[i].name} 转换中${occ ? '，区段有车占用' : ''}${locked ? `，处于锁闭进路 ${locked}` : ''}`, `sw${i}`);
  }
}

// ---------------------------------------------------------------- state machine observation

/**
 * Observation runs once per step, so two transitions of one entity in the
 * same step are seen as one change: it is accepted when a path of at most
 * two table transitions leads there.
 */
function reachable<S extends string>(m: Machine<S>, from: S, to: S): boolean {
  if (m.table.some((x) => x.from === from && x.to === to)) return true;
  return m.table.some((x) => x.from === from && m.table.some((y) => y.from === x.to && y.to === to));
}

interface Observation { key: string; machine: string; id: number; seen: number; state?: string }
interface Observations { epoch: number; entries: Observation[]; machines: Record<string, (Observation | undefined)[]> }
// Runtime-only visitation marks avoid rebuilding/hashing a Set of every
// entity at 10 Hz. Checkpoints keep the authoritative FSM map; restoring
// its IntegrityState creates a fresh index, including disappeared entities.
const observations = new WeakMap<IntegrityState, Observations>();
function observationIndex(g: IntegrityState): Observations {
  let index = observations.get(g);
  if (!index) {
    index = { epoch: 0, entries: [], machines: {} };
    for (const [key,state] of g.fsm) {
      const colon = key.indexOf(':'), machine = key.slice(0,colon), id = Number(key.slice(colon+1));
      const entry = { key, machine, id, seen: 0, state };
      (index.machines[machine] ??= [])[id] = entry;
      index.entries.push(entry);
    }
    observations.set(g,index);
  }
  index.epoch++;
  return index;
}
function observe<S extends string>(sim: Sim, m: Machine<S>, id: number, state: S, seen: Observations, tr?: Train) {
  const g = sim.integrity;
  const entities = seen.machines[m.name] ??= [];
  let entry = entities[id];
  if (!entry) {
    entry = entities[id] = { key: `${m.name}:${id}`, machine: m.name, id, seen: 0 };
    seen.entries.push(entry);
  }
  entry.seen = seen.epoch;
  // Only this observer writes the FSM map between restores. Most entities
  // stay in the same state, so compare locally before its string-key lookup.
  if (entry.state === state) return;
  entry.state = state;
  const key = entry.key;
  // an entity without a record is in the machine's rest state (a route not in sim.routes is idle)
  const prev = (g.fsm.get(key) ?? (m.name === 'route' ? 'idle' : undefined)) as S | undefined;
  if (prev === state) return;
  g.fsm.set(key, state);
  if (prev === undefined) {
    if (!m.initial.includes(state)) violate(sim, 'FSM', tr ? [tr.id] : [], `${m.label}[${id}] 初始状态 ${state} 不允许`, key);
    return;
  }
  if (!reachable(m, prev, state)) {
    violate(sim, 'FSM', tr ? [tr.id] : [], `${m.label}[${id}]：${prev}→${state} 不在转换表中`, key);
    return;
  }
  // guards that are observable after the fact
  const x = m.table.find((t) => t.from === prev && t.to === state);
  if (x?.guard === 'ebAuthorised' && tr && !GUARDS.ebAuthorised.check(sim, tr)) {
    violate(sim, 'FSM', [tr.id], `${m.label}[${id}]：${prev}→${state} 未经授权`, key);
  }
}

/** Record real event transitions before another event in the same tick can hide them.
 * The ordinary observer remains independent and catches unrecorded state writes. */
export function recordTransition<S extends string>(sim: Sim, machine: Machine<S>, id: number, from: S, to: S, tr?: Train) {
  const seen = observationIndex(sim.integrity);
  observe(sim, machine, id, from, seen, tr);
  const result = allowed(sim, machine, from, to, tr);
  if (!result.ok) violate(sim, 'FSM', tr ? [tr.id] : [], `${machine.label}[${id}]：${result.why}`, `${machine.name}:${id}`);
  observe(sim, machine, id, to, seen, tr);
}

function observeMachines(sim: Sim) {
  const g = sim.integrity;
  const seen = observationIndex(g);
  for (const tr of sim.trainList) {
    const id = tr.id;
    observe(sim, MODE, id, modeState(tr), seen, tr);
    observe(sim, EB, id, ebState(tr), seen, tr);
    observe(sim, TURNBACK, id, tr.tbStage, seen, tr);
    observe(sim, DEPOT, id, tr.depotStage, seen, tr);
  }
  for (let p = 0; p < sim.plat.length; p++) observe(sim, PSD, p, sim.plat[p].psd, seen);
  for (const rid of sim.routes.keys()) observe(sim, ROUTE, rid, routeState(sim, rid), seen);
  for (const c of sim.calls) observe(sim, CALL, c.id, c.state, seen);
  for (const f of sim.faults) observe(sim, FAULT, f.id, f.stage, seen);
  // entities that disappeared: routes go back to idle; trains / calls / faults leave the observation
  let kept = 0;
  for (const entry of seen.entries) {
    if (entry.seen === seen.epoch) { seen.entries[kept++] = entry; continue; }
    const {key,machine,id} = entry, st = g.fsm.get(key);
    if (machine === 'route' && st !== undefined) {
      if (!reachable(ROUTE, st as never, 'idle' as never)) violate(sim, 'FSM', [], `进路[${id}]：${st}→idle 不在转换表中`, key);
    }
    g.fsm.delete(key);
    seen.machines[machine][id] = undefined;
  }
  seen.entries.length = kept;
}

// ---------------------------------------------------------------- liveness (1 Hz)

/** time of the train's next scheduled event (first timed stop in its task list), 0 if none */
function nextPlanned(tr: Train): number {
  for (const t of tr.tasks) {
    if (t.k !== 'stop') continue;
    const at = t.arr ?? t.dep;
    if (at !== null) return at;
  }
  return 0;
}

export function checkLiveness(sim: Sim) {
  const g = sim.integrity;
  g.heldSince ??= new Map();
  const live = new Set<string>();
  for (const tr of sim.trainList) {
    const h = tr.halt;
    if (h.code === 'NONE') continue;
    const { root, code, cycle, alternatives } = rootCause(sim, tr);
    if (cycle) {
      const key = cycle.slice().sort((a, b) => a - b).join(',');
      live.add(key);
      const first = g.cycles.get(key) ?? sim.t;
      g.cycles.set(key, first);
      if (sim.t - first >= DEADLOCK_LIMIT) {
        const names = cycle.map((id) => { const t = sim.trains.get(id); return t ? `${t.svc}-${t.tripNo}` : `#${id}`; });
        const detail = alternatives ? `全部可选动作阻挡闭环：${names.join('、')}` : `${names.join(' → ')} → ${names[0]}`;
        violate(sim, 'DEADLOCK', cycle, `${detail}（${Math.round(sim.t - first)} s）`, key);
      }
      continue;
    }
    // the clock runs only while neither the train's own cause nor the root of its
    // wait chain is exempt (a train queueing behind a dwelling / held train is not stuck)
    if (HALT[h.code].exempt || HALT[code].exempt || !h.unplannedSince) {
      g.stuckSince.delete(tr.id);
      // An exemption is not open-ended: a standstill outside the plan that a
      // fault or procedure explains is still reported after EXEMPT_LIMIT.
      // (nor is one queued behind another in a storage track, waiting for its
      // own departure that is not yet due)
      const t0 = tr.tasks[0];
      const notDue = t0?.k === 'stop' && t0.arr === null && t0.dep !== null && t0.dep > sim.t;
      if (h.unplannedSince && h.code !== 'STABLED' && !notDue) {
        const held = Math.max(g.heldSince.get(tr.id) ?? sim.t, h.unplannedSince);
        g.heldSince.set(tr.id, held);
        if (sim.t - held >= EXEMPT_LIMIT && !sim.alarms.has(`held-${tr.id}`))
          sim.log('A', '运营', `列车 ${tr.svc}-${tr.tripNo} 计划外停车已 ${Math.round((sim.t - held) / 60)} 分钟：${HALT[h.code].label}${via(root, tr)}，请核查处置进度`, { key: `held-${tr.id}` });
      } else releaseHeld(sim, tr.id);
      continue;
    }
    releaseHeld(sim, tr.id);
    const since = g.stuckSince.get(tr.id) ?? sim.t;
    g.stuckSince.set(tr.id, since);
    // "beyond plan": a train is not late while its next scheduled event (arrival /
    // departure) still lies ahead, e.g. queueing for a terminal turnback track
    const from = Math.max(since, h.unplannedSince, h.plannedUntil, nextPlanned(tr));
    if (sim.t - from < LIVENESS_LIMIT) continue;
    violate(sim, 'LIVENESS', [tr.id, ...(root.id !== tr.id ? [root.id] : [])], `${tr.svc}-${tr.tripNo} ${HALT[h.code].label}${h.detail ? `（${h.detail}）` : ''} 已 ${Math.round((sim.t - from) / 60)} 分钟${via(root, tr)}：${HALT[code].label}`, `${tr.id}`);
  }
  for (const k of g.cycles.keys()) if (!live.has(k)) g.cycles.delete(k);
  for (const id of g.stuckSince.keys()) { const tr = sim.trains.get(id); if (!tr || tr.halt.code === 'NONE') g.stuckSince.delete(id); }
  for (const id of g.heldSince.keys()) { const tr = sim.trains.get(id); if (!tr || tr.halt.code === 'NONE') releaseHeld(sim, id); }
}

const via = (root: Train, tr: Train) => root.id !== tr.id ? `，根因列车 ${root.svc}-${root.tripNo}` : '';

function releaseHeld(sim: Sim, id: number) {
  if (!sim.integrity.heldSince.delete(id)) return;
  if (sim.alarms.has(`held-${id}`)) sim.clearAlarm(`held-${id}`);
}
