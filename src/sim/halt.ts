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
import { STATIONS } from '../data/line2';

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
}

export function newHalt(): Halt {
  return { code: 'NONE', train: -1, detail: '', since: 0, plannedUntil: 0, logged: false, unplannedSince: 0 };
}

/** ATS route-setting state of a train (written by runARS each second) */
export interface ArsWait { code: HaltCode; train: number; signal: number; t: number; detail: string }

/** current halt code of a train from its own state (no graph propagation) */
export function classify(sim: Sim, tr: Train): { code: HaltCode; train: number; detail: string; plannedUntil: number } {
  const r = (code: HaltCode, train = -1, detail = '', plannedUntil = 0) => ({ code, train, detail, plannedUntil });
  if (tr.phase === 'stabled') return r('STABLED');
  if (tr.failed) return r('FAILED');
  if (tr.phase === 'coupling') return r('COUPLING');
  if (tr.phase === 'dwell') {
    const st = tr.tasks[0] as StopTask | undefined;
    const p = st ? sim.topo.berths[st.berth].platform : -1;
    const ps = p >= 0 ? sim.plat[p] : null;
    if (ps?.esp) return r('ESP', -1, sim.topo.platforms[p].name);
    if (tr.hold || ps?.hold) return r('HOLD');
    if (tr.intervalWait) return r('INTERVAL_LIMIT', tr.intervalWait.train, tr.intervalWait.detail);
    if (ps && ps.psd === 'closeFail') return r('PSD_FAULT', -1, sim.topo.platforms[p].name);
    const planned = tr.dwellUntil;
    if (sim.t < tr.dwellUntil) return r(st && st.arr === null && st.dep !== null && sim.t < st.dep - 30 ? 'LAYOVER' : 'DWELL', -1, '', planned);
    const wait = tr.arsWait;
    if (wait && sim.t - wait.t <= 2.5) return r(wait.code, wait.train, wait.detail, planned);
    if (tr.doorsAwait || tr.manual) return r('MANUAL', -1, '等待司机关门发车', planned);
    return r('ROUTE_WAIT', tr.maTrain, tr.maReason || '停站已结束，等待发车条件', planned);
  }
  if (tr.phase === 'reversing') return r('TURNBACK', -1, '', tr.dwellUntil);
  if (tr.phase !== 'run') return r('NONE');
  if (tr.v > 0.05) return r('NONE');
  if (tr.eb) {
    if (tr.ebCause === 'spad') return r('SPAD', -1, tr.ebReason);
    if (tr.ebCause === 'comm' && !tr.comm) return r('COMM_LOSS', -1, tr.ebReason);
    if (tr.ebCause === 'zc' && sim.zoneState[sim.topo.links[tr.link].zone] === 'ZCFAIL') return r('ZC_FAULT', -1, tr.ebReason);
    // the release needs a dispatcher answer: with manual answering the clock is the dispatcher's
    if (!sim.autoRadio && sim.t >= sim.config.startTime) return r('DISPATCHER', -1, tr.ebReason);
    return r('EB', -1, tr.ebReason);
  }
  if (tr.pendingMode) return r('MODE_CHANGE');
  if (tr.stopUntil > sim.t) return r('INCIDENT', -1, tr.stopReason, tr.stopUntil);
  if (tr.hold) return r('HOLD');
  if (tr.manual) return r('MANUAL');
  if (!tr.tasks.length) return r('NO_TASK');
  if (tr.tasks[0].k === 'rescue') return r('RESCUE', tr.tasks[0].target);
  const plannedUntil = 0;
  if (Number.isFinite(tr.stopDist) && tr.stopDist <= tr.maDist
    && (tr.maCode === 'ROUTE_WAIT' || tr.maDist > 40 && tr.stopDist < 1.5))
    return r('STOP_POINT', -1, `停车点前 ${tr.stopDist.toFixed(1)} m，授权足够`, plannedUntil);
  let code = tr.maCode;
  let train = tr.maTrain;
  let detail = tr.maReason;
  if (code === 'ROUTE_WAIT' || code === 'ROUTE_MISMATCH') {
    const w = tr.arsWait;
    // the ATS explanation applies when it concerns the signal we stand at
    if (w && sim.t - w.t <= 2.5 && (w.signal === tr.nextSignal || tr.nextSignal < 0)) {
      code = w.code;
      train = w.train;
      detail = w.detail || detail;
    } else if (tr.nextSignal >= 0 && !sim.sig[tr.nextSignal].ars) code = 'ARS_OFF';
  }
  if (code === 'NONE') code = tr.maDist < 40 ? 'ROUTE_WAIT' : 'NONE';
  return r(code, train, detail, plannedUntil);
}

/** follow wait-for edges to the root cause; returns the root and whether a cycle was met */
export function rootCause(sim: Sim, tr: Train): { root: Train; code: HaltCode; cycle: number[] | null } {
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
