/**
 * Machine-readable stop reasons (停车原因) for every standing train, and the
 * wait-for graph between trains built from them.
 *
 * Each train carries the authority-limiting obstacle found by the onboard /
 * ZC scan (maCode, maTrain) and the ATS route-setting wait (arsWait). Once a
 * second they are combined with the train's service state into one HaltCode.
 * The code is shown in the train detail panel, written once per unplanned
 * stop episode to the event log, and used by the liveness invariants
 * (invariants.ts): a standstill is excused only when its root cause — after
 * following the wait-for edges to the train that is really blocking — is an
 * exempt code (planned dwell / layover, hold, fault, possession ...).
 */
import type { Sim } from './engine';
import type { Train, StopTask } from './model';
import { atoStartReady, simulatedAmDoorWork } from './ats';
import { manualTractionHold } from './movement';
import { STATIONS } from '../data/current';

export type HaltCode =
  | 'NONE'
  | 'DWELL' | 'LAYOVER' | 'TURNBACK' | 'REGULATION' | 'HOLD' | 'INTERVAL_LIMIT' | 'STABLED' | 'DEPOT_WAIT'
  | 'FAILED' | 'COUPLING' | 'RESCUE' | 'EB' | 'MODE_CHANGE' | 'INCIDENT' | 'RM_WAIT'
  | 'TRAIN_AHEAD' | 'ROUTE_WAIT' | 'BERTH_WAIT' | 'ROUTE_CONFLICT' | 'ROUTE_MISMATCH' | 'ARS_OFF' | 'SWITCH_MOVING'
  | 'SIGNAL_FAULT' | 'SWITCH_FAULT' | 'AXLE_FAULT' | 'AXLE_PRESET' | 'ZC_FAULT' | 'COMM_LOSS' | 'PSD_FAULT'
  | 'BLOCKED' | 'POSSESSION' | 'WEATHER' | 'ESP' | 'BUFFER' | 'DEPOT_LIMIT' | 'NO_TASK' | 'STOP_POINT'
  | 'SPAD' | 'DISPATCHER' | 'MANUAL' | 'DIRECTION_WAIT';

export interface HaltInfo { label: string; exempt: boolean }

/**
 * exempt = a standstill with this root cause is legitimate however long it
 * lasts (planned, dispatcher-ordered, or caused by an active fault / its
 * recovery procedure). Non-exempt codes must resolve on their own.
 */
export const HALT: Record<HaltCode, HaltInfo> = {
  NONE: { label: '运行中', exempt: true },
  DWELL: { label: '停站作业', exempt: true },
  LAYOVER: { label: '待发（按图）', exempt: true },
  TURNBACK: { label: '折返换端', exempt: true },
  REGULATION: { label: '按图等点/发车次序', exempt: true },
  HOLD: { label: '扣车', exempt: true },
  INTERVAL_LIMIT: { label: '区间限车', exempt: true },
  STABLED: { label: '存车', exempt: true },
  DEPOT_WAIT: { label: '等待入段', exempt: false },
  FAILED: { label: '列车故障', exempt: true },
  COUPLING: { label: '救援连挂作业', exempt: true },
  RESCUE: { label: '救援接近', exempt: true },
  EB: { label: '紧急制动（待授权缓解）', exempt: false },
  SPAD: { label: '冒进信号紧急制动', exempt: true },
  DISPATCHER: { label: '等待调度应答', exempt: true },
  MANUAL: { label: '人工驾驶', exempt: true },
  MODE_CHANGE: { label: '驾驶模式转换', exempt: true },
  DIRECTION_WAIT: { label: '折返方向防护/待司机牵出', exempt: true },
  INCIDENT: { label: '区间停车处置', exempt: true },
  RM_WAIT: { label: '等待RM授权', exempt: true },
  TRAIN_AHEAD: { label: '前方列车', exempt: false },
  ROUTE_WAIT: { label: '等待进路', exempt: false },
  BERTH_WAIT: { label: '等待股道/站台空闲', exempt: false },
  ROUTE_CONFLICT: { label: '敌对进路', exempt: false },
  ROUTE_MISMATCH: { label: '进路与计划不符', exempt: false },
  ARS_OFF: { label: '人工排列进路（ARS关闭）', exempt: true },
  SWITCH_MOVING: { label: '道岔转换中', exempt: false },
  SIGNAL_FAULT: { label: '信号机故障', exempt: true },
  SWITCH_FAULT: { label: '道岔失表', exempt: true },
  AXLE_FAULT: { label: '计轴故障占用', exempt: true },
  AXLE_PRESET: { label: '计轴预复位待压道', exempt: true },
  ZC_FAULT: { label: 'ZC故障', exempt: true },
  COMM_LOSS: { label: '车地通信中断', exempt: true },
  PSD_FAULT: { label: '站台门故障', exempt: true },
  BLOCKED: { label: '区段封锁', exempt: true },
  POSSESSION: { label: '施工封锁', exempt: true },
  WEATHER: { label: '大风停运', exempt: true },
  ESP: { label: '站台紧急关闭', exempt: true },
  BUFFER: { label: '车挡', exempt: false },
  DEPOT_LIMIT: { label: '段界', exempt: false },
  NO_TASK: { label: '无运行任务', exempt: false },
  STOP_POINT: { label: '停车点', exempt: false },
};

/** Each option is an alternative movement; its blockers are required conditions.
 * Only the cause actually limiting that option in the current allocation is
 * recorded. A later blocker is not inferred before that cause clears. */
export interface WaitAlternative {
  entrySignal?: number;
  choices: { index: number; berth: number }[];
  blockers: { code: HaltCode; train: number; detail: string }[];
}

export const copyWaitAlternatives = (alternatives: WaitAlternative[] | undefined): WaitAlternative[] | undefined =>
  alternatives?.map(a => ({ ...a, choices: a.choices.map(c => ({ ...c })), blockers: a.blockers.map(b => ({ ...b })) }));

export interface Halt {
  code: HaltCode;
  /** blocking train (wait-for edge), -1 none */
  train: number;
  /** free-text detail (signal / section / platform name) */
  detail: string;
  /** standstill start (sim s), 0 while running */
  since: number;
  /** end of the planned stop (departure time / dwell end), the liveness clock starts here */
  plannedUntil: number;
  /** an unplanned-stop event was written for this episode */
  logged: boolean;
  /** since when the train's own code is non-exempt (0 while exempt): the liveness clock */
  unplannedSince: number;
  /** Current whole-movement alternatives, not additional mandatory wait edges. */
  alternatives?: WaitAlternative[];
}

export function newHalt(): Halt {
  return { code: 'NONE', train: -1, detail: '', since: 0, plannedUntil: 0, logged: false, unplannedSince: 0 };
}

/** ATS route-setting state of a train (written by runARS each second) */
export interface ArsWait {
  code: HaltCode; train: number;
  /** Actual signal/device at which the whole movement is blocked. */
  signal: number;
  /** Entrance at which this whole-movement explanation was obtained. */
  entrySignal?: number;
  t: number; detail: string;
  alternatives?: WaitAlternative[];
}

function freshArsWait(sim: Sim, tr: Train): ArsWait | undefined {
  const wait = tr.arsWait;
  if (!wait || sim.t - wait.t < 0 || sim.t - wait.t > 2.5) return;
  return tr.nextSignal < 0 || (wait.entrySignal ?? wait.signal) === tr.nextSignal ? wait : undefined;
}

/** The same authority explanation applies to automatic and manual driving. */
function authorityHalt(sim: Sim, tr: Train): { code: HaltCode; train: number; detail: string; alternatives?: WaitAlternative[] } {
  let code = tr.maCode, train = tr.maTrain, detail = tr.maReason;
  let alternatives: WaitAlternative[] | undefined;
  const wait = freshArsWait(sim, tr);
  if (code === 'ROUTE_WAIT' || code === 'ROUTE_MISMATCH') {
    if (wait) {
      code = wait.code;
      train = wait.train;
      detail = wait.detail || detail;
      alternatives = wait.alternatives;
    } else if (tr.nextSignal >= 0 && !sim.sig[tr.nextSignal].ars) code = 'ARS_OFF';
  }
  // Keep a direct physical MA cause authoritative. If the same current
  // admission cause explains it, retain its other movement options too.
  if (!alternatives && wait?.code === code && wait.train === train) alternatives = wait.alternatives;
  if (code === 'NONE') code = tr.maDist < 40 ? 'ROUTE_WAIT' : 'NONE';
  return { code, train, detail, alternatives };
}

/** current halt code of a train from its own state (no graph propagation) */
export function classify(sim: Sim, tr: Train): { code: HaltCode; train: number; detail: string; plannedUntil: number; alternatives?: WaitAlternative[] } {
  const r = (code: HaltCode, train = -1, detail = '', plannedUntil = 0) => ({ code, train, detail, plannedUntil });
  const emergency = () => {
    if (tr.ebCause === 'spad') return r('SPAD', -1, tr.ebReason);
    if (tr.ebCause === 'comm' && !tr.comm) return r('COMM_LOSS', -1, tr.ebReason);
    if (tr.ebCause === 'zc' && sim.zoneState[sim.topo.links[tr.link].zone] === 'ZCFAIL') return r('ZC_FAULT', -1, tr.ebReason);
    if (!sim.autoRadio && sim.t >= sim.config.startTime) return r('DISPATCHER', -1, tr.ebReason);
    return r('EB', -1, tr.ebReason);
  };
  if (tr.phase === 'stabled') return r('STABLED');
  if (tr.failed) return r('FAILED');
  if (tr.phase === 'coupling') return r('COUPLING');
  if (tr.phase === 'dwell') {
    const work = tr.tasks[0]?.k === 'stop' ? tr.tasks[0].depotWork : undefined;
    if (work) {
      if (tr.eb) return emergency();
      if (tr.hold) return r('HOLD');
      if (sim.t >= tr.dwellUntil && (tr.doorsOpen || tr.doorSide || tr.doorMotion || sim.t < (tr.doorLockedAt ?? 0)))
        return r(tr.manual ? 'MANUAL' : 'DWELL', -1, '等待车门关闭锁闭');
      if (sim.t >= tr.dwellUntil && tr.vfault && tr.vfault.stage !== 'armed') return r('FAILED', -1, '等待车辆故障处理');
      return r('DWELL', -1, work.kind === 'in' ? '入段固定作业' : '出段固定作业', tr.dwellUntil);
    }
    if (tr.atoDriver || simulatedAmDoorWork(tr)) {
      const start = atoStartReady(sim, tr);
      return r(start.code, start.train, start.ready && tr.atoButtons?.f && tr.atoButtons?.g ? '等待列车起步' : start.detail, tr.dwellUntil);
    }
    const st = tr.tasks[0] as StopTask | undefined;
    const p = st ? sim.topo.berths[st.berth].platform : -1;
    const ps = p >= 0 ? sim.plat[p] : null;
    if (ps?.esp) return r('ESP', -1, sim.topo.platforms[p].name);
    if (tr.hold || ps?.hold) return r('HOLD');
    if (tr.intervalWait) return r('INTERVAL_LIMIT', tr.intervalWait.train, tr.intervalWait.detail);
    if (ps && ps.psd === 'closeFail') return r('PSD_FAULT', -1, sim.topo.platforms[p].name);
    const planned = tr.dwellUntil;
    if (sim.t < tr.dwellUntil) return r(st && st.arr === null && st.dep !== null && sim.t < st.dep - 30 ? 'LAYOVER' : 'DWELL', -1, '', planned);

    const wait = freshArsWait(sim, tr);
    if (wait) return { ...r(wait.code, wait.train, wait.detail, planned), alternatives: wait.alternatives };
    if (tr.doorsAwait || tr.manual) return r('MANUAL', -1, '等待司机关门发车', planned);
    return r('ROUTE_WAIT', tr.maTrain, tr.maReason || '停站已结束，等待发车条件', planned);
  }
  if (tr.phase === 'reversing') return r('TURNBACK', -1, '', tr.dwellUntil);
  if (tr.phase !== 'run') return r('NONE');
  if (tr.v > 0.05) return r('NONE');
  if (tr.eb) return emergency();
  if (tr.pendingMode) return r('MODE_CHANGE');
  if (tr.stopUntil > sim.t) return r('INCIDENT', -1, tr.stopReason, tr.stopUntil);
  if (tr.hold) return r('HOLD');
  if (tr.manual) {
    const hold = manualTractionHold(sim, tr);
    if (hold) return r('MANUAL', -1, hold);
    if (tr.maDist <= 1 && tr.maCode !== 'NONE') return { ...authorityHalt(sim, tr), plannedUntil: 0 };
    return r('MANUAL', -1, tr.notch <= 0 ? '等待司机加牵引' : '司机牵引起步');
  }
  if (!tr.tasks.length) return r('NO_TASK');
  if (tr.tasks[0].k === 'rescue') return r('RESCUE', tr.tasks[0].target);
  const plannedUntil = 0;
  if (Number.isFinite(tr.stopDist) && tr.stopDist <= tr.maDist
    && (tr.maCode === 'ROUTE_WAIT' || tr.maDist > 40 && tr.stopDist < 1.5))
    return r('STOP_POINT', -1, `停车点前 ${tr.stopDist.toFixed(1)} m，授权足够`, plannedUntil);
  return { ...authorityHalt(sim, tr), plannedUntil };
}

/** follow wait-for edges to the root cause; returns the root and whether a cycle was met */
function selectedRootCause(sim: Sim, tr: Train): { root: Train; code: HaltCode; cycle: number[] | null } {
  const seen: number[] = [];
  let cur = tr;
  for (let i = 0; i < 80; i++) {
    seen.push(cur.id);
    const h = cur.halt;
    if (h.train < 0) return { root: cur, code: h.code, cycle: null };
    const nx = sim.trains.get(h.train);
    if (!nx) return { root: cur, code: h.code, cycle: null };
    // the blocker is moving: the wait will resolve
    if (nx.halt.code === 'NONE') return { root: nx, code: 'NONE', cycle: null };
    const k = seen.indexOf(nx.id);
    if (k >= 0) return { root: nx, code: h.code, cycle: seen.slice(k) };
    cur = nx;
  }
  return { root: cur, code: cur.halt.code, cycle: null };
}

/** Read the stored halt evidence only. An OR movement is closed only when
 * every option still requires a member of a closed dependency set. Peeling
 * off completing options avoids treating a selected edge as the only exit. */
export function rootCause(sim: Sim, tr: Train): { root: Train; code: HaltCode; cycle: number[] | null; alternatives?: boolean } {
  const selected = selectedRootCause(sim, tr);
  if (!selected.cycle) return selected;
  type Blocker = WaitAlternative['blockers'][number];
  const nodes = new Map<number, { train: Train; options: Blocker[][] }>();
  const pending = [tr];
  let hasAlternatives = false;
  while (pending.length) {
    const current = pending.pop()!;
    if (nodes.has(current.id)) continue;
    const h = current.halt;
    const options = h.code === 'NONE' ? [] : h.alternatives?.length
      ? h.alternatives.map(a => a.blockers)
      : h.train >= 0 ? [[{ train: h.train, code: h.code, detail: h.detail }]] : [];
    hasAlternatives ||= !!h.alternatives?.length;
    nodes.set(current.id, { train: current, options });
    for (const option of options) for (const blocker of option) {
      const next = sim.trains.get(blocker.train);
      if (next && !nodes.has(next.id)) pending.push(next);
    }
  }
  if (!hasAlternatives) return selected;
  const closed = new Set(nodes.keys());
  // Remember the actual exit that removed each node. Its dependencies have
  // already left the closed set, so following this witness cannot loop.
  const exits = new Map<number, Blocker[]>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of closed) {
      const options = nodes.get(id)!.options;
      const exit = options.find(option => option.every(b => !closed.has(b.train)));
      if (!options.length || exit) {
        closed.delete(id); exits.set(id, exit ?? []); changed = true;
      }
    }
  }
  if (closed.has(tr.id)) {
    // Only closed sink components are the circular roots. Queued ancestors
    // can join or leave without changing the root's identity or its clock.
    // Keep every sink: different options can lead to distinct true cycles.
    const edges = (id: number) => [...new Set(nodes.get(id)!.options.flatMap(option => option
      .filter(b => closed.has(b.train)).map(b => b.train)))];
    let index = 0;
    const indices = new Map<number, number>(), low = new Map<number, number>();
    const stack: number[] = [], active = new Set<number>(), components: number[][] = [];
    const visit = (id: number) => {
      indices.set(id, index); low.set(id, index++); stack.push(id); active.add(id);
      for (const next of edges(id)) {
        if (!indices.has(next)) { visit(next); low.set(id, Math.min(low.get(id)!, low.get(next)!)); }
        else if (active.has(next)) low.set(id, Math.min(low.get(id)!, indices.get(next)!));
      }
      if (low.get(id) !== indices.get(id)) return;
      const component: number[] = [];
      let next: number;
      do { next = stack.pop()!; active.delete(next); component.push(next); } while (next !== id);
      components.push(component);
    };
    for (const id of closed) if (!indices.has(id)) visit(id);
    const membership = new Map<number, number>();
    components.forEach((component, i) => component.forEach(id => membership.set(id, i)));
    const cycle = components.filter((component, i) => component.every(id => edges(id)
      .every(next => membership.get(next) === i))).flat().sort((a, b) => a - b);
    const root = nodes.get(cycle[0])!.train;
    return { root, code: root.halt.code, cycle, alternatives: true };
  }
  let current = tr;
  for (;;) {
    const blockers = exits.get(current.id) ?? [];
    if (!blockers.length) return { root: current, code: current.halt.code, cycle: null };
    // Today's admission stores one actual controlling cause per option.
    // Prefer a non-train condition if a future producer supplies several.
    const blocker = blockers.find(b => !nodes.has(b.train)) ?? blockers[0];
    const next = nodes.get(blocker.train)?.train;
    if (!next) return { root: current, code: blocker.code, cycle: null };
    current = next;
  }
}

const hhmm = (t: number) => {
  const s = Math.floor(t) % 86400;
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
};

/** once a second: refresh every train's halt record and log unplanned stops */
export function updateHalts(sim: Sim) {
  for (const tr of sim.trainList) {
    const c = classify(sim, tr);
    const h = tr.halt;
    if (c.code === 'NONE') {
      if (h.code !== 'NONE') tr.halt = newHalt();
      continue;
    }
    if (h.code === 'NONE') {
      tr.halt = { ...newHalt(), since: sim.t };
    } else if (h.code !== c.code || h.train !== c.train || h.detail !== c.detail || h.plannedUntil !== c.plannedUntil) {
      tr.halt = { ...h };
    }
    const n = tr.halt;
    n.code = c.code;
    n.train = c.train;
    n.detail = c.detail;
    n.plannedUntil = c.plannedUntil;
    n.alternatives = c.alternatives;
    if (HALT[c.code].exempt) n.unplannedSince = 0;
    else if (!n.unplannedSince) n.unplannedSince = sim.t;
  }
  // one event per unplanned stop episode (standing > 20 s at an obstacle)
  for (const tr of sim.trainList) {
    const h = tr.halt;
    if (h.logged || h.code === 'NONE' || tr.phase !== 'run' && h.code !== 'INTERVAL_LIMIT' && HALT[h.code].exempt || sim.t - h.since < 20) continue;
    if (h.code === 'STOP_POINT' || h.code === 'MODE_CHANGE') continue;
    h.logged = true;
    const blocker = h.train >= 0 ? sim.trains.get(h.train) : undefined;
    const who = blocker ? `（${blocker.svc}-${blocker.tripNo}）` : '';
    sim.log('I', '停车', `列车 ${tr.svc}-${tr.tripNo} ${nearStation(sim, tr)} 停车：${HALT[h.code].label}${who}${h.detail && h.detail !== HALT[h.code].label ? ` — ${h.detail}` : ''}（${hhmm(h.since)} 起）`, { code: h.code, train: tr.id });
  }
}

function nearStation(sim: Sim, tr: Train): string {
  const ch = sim.trainChain(tr);
  let best = 0;
  for (let i = 1; i < sim.topo.stations.length; i++) if (Math.abs(sim.topo.stations[i].chain - ch) < Math.abs(sim.topo.stations[best].chain - ch)) best = i;
  return Math.abs(sim.topo.stations[best].chain - ch) < 150 ? STATIONS[best].name : `${STATIONS[best].name}附近`;
}
