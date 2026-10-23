/**
 * Onboard ATP / ATO (车载控制器): the only module that writes a train's
 * driving mode, control level and emergency brake (§3 one source of truth).
 *
 * Every mode / level change goes through setMode, which only performs
 * transitions of the MODE table in fsm.ts (with their guards); the EB is set
 * by applyEB and released by releaseEB only after a dispatcher authorisation
 * (EB table). Other modules ask: ATS / radio grant RM through grantRM, the
 * dispatcher selects the train level (trainLevel command) and the zone level,
 * the movement module reports ATP interventions through applyEB.
 *
 * Behaviour and sources: docs/signalling-model.md §2 (modes, level
 * switchover) and §3 (emergency brake).
 */
import type { Sim } from './engine';
import type { EbCause, ForceLevel, Level, Mode, Train, ReverseTask } from './model';
import type { Topology } from './topology';
import { MODE, allowed, modeState, type ModeState } from './fsm';
import { trainLabel, setDepartureReadyAt } from './ats';
import { openCall, unsafeAhead } from './radio';
import { nextLink } from './topology';
import { swPos } from './interlocking';
import { withdrawAuthority } from './movement';
import { OPERATIONS, supportsSignalSystem } from '../data/current';

/** driver action time for a mode / level change at standstill (s) 【假设】 */
export const MODE_CHANGE_TIME = 10;
/** driver report of an EB to the dispatcher after standstill (s) 【假设】 */
export const EB_REPORT_DELAY = 5;
/** repeat of an EB release request after the dispatcher said "wait" (s) */
export const EB_REPEAT = 60;

const LEVEL_C = (l: Level) => (l === 'CBTC' ? 'C' : 'T');

export function stateLabel(s: ModeState): string {
  const [m, l] = s.split('-');
  return modeLabel(m as Mode, l === 'C' ? 'CBTC' : 'TBTC');
}

export function modeLabel(mode: Mode, level: Level): string {
  return `${level === 'CBTC' ? 'CBTC' : 'TBTC后备'} ${mode}`;
}

/** CBTC level possible now: train-to-wayside radio, ZC in control of the zone, not forced to TBTC */
export function cbtcAvailable(sim: Sim, tr: Train): boolean {
  return supportsSignalSystem('CBTC') && tr.comm && sim.zoneState[sim.topo.links[tr.link].zone] === 'CBTC' && tr.forceLevel !== 'TBTC';
}

/** DTO allowed for the train: the line runs DTO and its DTO equipment works */
export function dtoAllowed(sim: Sim, tr: Train): boolean {
  return !sim.atoLine && !tr.dtoInhibit && !tr.atoDriver;
}

/** best automatic mode for the train at a level: under CBTC DTO, or ATO with
 * the driver in the cab when DTO is degraded; the TBTC backup runs ATO */
export function autoMode(sim: Sim, tr: Train, level: Level): Mode {
  return level === 'CBTC' && dtoAllowed(sim, tr) ? 'DTO' : 'AM';
}

/** A simulated AM driver never takes over the player's F/G or manual handle. */
export function simulatedAmDriver(tr: Pick<Train,'mode'|'manual'|'atoDriver'>): boolean {
  return tr.mode === 'AM' && !tr.manual && !tr.atoDriver;
}

/** A platform reversal has the paper's front-turn work even when a middle
 * platform is represented as a rear-turn berth in the routing topology. */
export function driverTurnbackKind(topo: Topology, task: Pick<ReverseTask,'chosen'>): 'front'|'rear' {
  return topo.berths[task.chosen]?.kind === 'platform' ? 'front' : 'rear';
}

/** The paper measures the complete turn, including its door departures.
 * Deduct those shared driver confirmations from the change-of-ends increment. */
export function turnbackDwell(mode: Mode, minimum: number, kind: 'front'|'rear' = 'rear', simulatedDriver = false): number {
  const work=OPERATIONS.atoDriverWork;
  const extra=simulatedDriver ? work.turnbackExtraS[kind]-work.turnbackDoorCycles[kind]*work.postLockExtraS : work.legacyEndChangeS;
  return minimum + (mode === 'DTO' ? 0 : extra);
}

/**
 * Perform a mode / level transition. Returns false (and changes nothing) when
 * it is not in the MODE table or its guard does not hold.
 */
export function setMode(sim: Sim, tr: Train, mode: Mode, level: Level, why: string): boolean {
  if (!supportsSignalSystem(level)) return false;
  const wasSimulatedDriver = simulatedAmDriver(tr);
  const from = modeState(tr);
  const to = `${mode}-${LEVEL_C(level)}` as ModeState;
  if (from === to) return true;
  if (!MODE.states.includes(to)) return false;
  const a = allowed(sim, MODE, from, to, tr);
  if (!a.ok) return false;
  tr.mode = mode;
  tr.level = level;
  tr.modeSince = sim.t;
  if (tr.phase === 'dwell' && tr.autoStartAt !== undefined && !tr.manual && !tr.atoDriver) {
    const delta=(Number(simulatedAmDriver(tr))-Number(wasSimulatedDriver))*OPERATIONS.atoDriverWork.postLockExtraS;
    const previous=tr.autoStartAt;
    tr.autoStartAt+=delta;
    if(tr.dwellUntil<=previous)setDepartureReadyAt(tr,Math.max(tr.doorLockedAt??0,tr.autoStartAt));
  }
  // ATS may enter reversal before this tick's DTO→AM conversion. Complete the
  // same driver budget used at reversal entry, without adding it twice.
  const task = tr.tasks[0];
  if (tr.phase === 'reversing' && task?.k === 'reverse')
    tr.dwellUntil = Math.max(tr.dwellUntil, tr.phaseSince + turnbackDwell(mode, task.minTime,driverTurnbackKind(sim.topo,task),simulatedAmDriver(tr)));
  if (mode !== 'RM') { tr.rmAuth = 0; tr.rmSig = -1; tr.rmReason = ''; }
  // A sighting scan is not an ATP authority. Mode/level changes can happen
  // after the second's ZC refresh, so validate the new protection immediately.
  withdrawAuthority(sim, tr);
  if (why) sim.log('I', '列车', `列车 ${trainLabel(tr)} ${why}：${stateLabel(from)} → ${stateLabel(to)}`, { train: tr.id });
  return true;
}

// ---------------------------------------------------------------- emergency brake

export function applyEB(sim: Sim, tr: Train, reason: string, cause: EbCause) {
  if (tr.eb) {
    // a SPAD during an EB still counts as the more serious cause
    if (cause === 'spad' && tr.ebCause !== 'spad') { tr.ebCause = cause; tr.ebReason = reason; tr.ebAuth = false; }
    return;
  }
  tr.eb = true;
  tr.ebSince = sim.t;
  // the integrity check measures "never faster under EB" from the speed at
  // which it was applied (an EB from an event after this step's integration)
  sim.integrity.prevV.set(tr.id, tr.v);
  tr.ebReason = reason;
  tr.ebCause = cause;
  tr.ebAuth = false;
  tr.ebCallAt = 0;
  sim.log(cause === 'spad' ? 'A' : 'B', '列车', `列车 ${tr.svc}${tr.tripNo}（${tr.vehicle}）紧急制动：${reason}`, { key: `eb-${tr.id}`, train: tr.id, code: 'EB' });
}

/** the EB cause no longer holds (release can be authorised without further measures) */
export function ebCauseCleared(sim: Sim, tr: Train): boolean {
  switch (tr.ebCause) {
    // a SPAD is never "cleared": only the SPAD procedure releases it
    case 'spad': return false;
    case 'comm': return tr.comm || tr.level === 'TBTC';
    // the ZC gives authorities again, or the train has left CBTC
    case 'zc': return tr.level === 'TBTC' || sim.zoneState[sim.topo.links[tr.link].zone] === 'CBTC';
    // ATP / overspeed / RM / driver EBs end with the train at a stand
    default: return true;
  }
}

/** an EB whose cause is the loss of CBTC (radio or ZC): released only by degrading to TBTC */
const needsDegrade = (sim: Sim, tr: Train) => (tr.ebCause === 'comm' || tr.ebCause === 'zc') && tr.level === 'CBTC' && !ebCauseCleared(sim, tr);

/** how a release is authorised: plain release, the SPAD procedure (route
 * verified, RM to the next signal) or the comm-loss degrade to TBTC */
export type EbProcedure = 'release' | 'spad' | 'degrade';

/** dispatcher authorises the release (driver has reported the EB) */
export function authoriseEBRelease(sim: Sim, tr: Train, by: string, procedure: EbProcedure = 'release'): { ok: boolean; msg: string } {
  if (!tr.eb) return { ok: false, msg: '列车未处于紧急制动' };
  if (tr.v > 0.01) return { ok: false, msg: '列车未停稳，不能缓解紧急制动' };
  if (procedure === 'degrade' && !supportsSignalSystem('TBTC')) return { ok: false, msg: '本线路无TBTC后备，须等待通信或区域控制恢复' };
  if (tr.ebCause === 'spad' && procedure !== 'spad')
    return { ok: false, msg: '冒进信号紧急制动须按冒进处置程序办理（无线电：核实进路后RM运行至前方信号机）' };
  const viaDegrade = procedure === 'degrade' && needsDegrade(sim, tr);
  if (tr.ebCause !== 'spad' && !viaDegrade && !ebCauseCleared(sim, tr))
    return { ok: false, msg: `紧急制动原因未消除（${tr.ebReason}）${needsDegrade(sim, tr) ? supportsSignalSystem('TBTC') ? '：须同意缓解并降级TBTC后备运行（司机来电选项）' : '：本线路无TBTC后备，须等待通信或区域控制恢复' : ''}` };
  tr.ebAuth = true;
  releaseEB(sim, tr, by);
  return { ok: true, msg: `列车 ${trainLabel(tr)} 紧急制动缓解` };
}

function releaseEB(sim: Sim, tr: Train, by: string) {
  if (!tr.eb || !tr.ebAuth || tr.v > 0.01) return;
  tr.eb = false;
  sim.clearAlarm(`eb-${tr.id}`);
  for (const c of sim.calls) if (c.state === 'ringing' && c.kind === 'ebRelease' && c.train === tr.id) c.state = 'withdrawn';
  sim.log('I', '列车', `列车 ${trainLabel(tr)} 紧急制动缓解（${by}）`, { train: tr.id });
}

function callEbRelease(sim: Sim, tr: Train) {
  tr.ebCallAt = sim.t;
  const spad = tr.ebCause === 'spad';
  const comm = needsDegrade(sim, tr);
  const backup = supportsSignalSystem('TBTC');
  const options = spad
    ? [{ key: 'rm', label: '核实进路后缓解，RM运行至前方信号机', critical: true }, { key: 'wait', label: '原地待命（调查）' }]
    : comm
      ? backup ? [{ key: 'degrade', label: '同意缓解，降级TBTC后备ATO运行' }, { key: 'wait', label: '原地等待' }]
        : [{ key: 'wait', label: '原地等待通信或区域控制恢复' }]
      : [{ key: 'release', label: '同意缓解紧急制动' }, { key: 'wait', label: '原地等待' }];
  openCall(sim, {
    kind: 'ebRelease', from: `列车 ${trainLabel(tr)} 司机`, train: tr.id,
    text: spad ? `列车冒进信号 ${tr.spadSig >= 0 ? sim.topo.signals[tr.spadSig].name : ''}，紧急制动停车，请求处置` : `列车紧急制动停车（${tr.ebReason}），请求缓解`,
    // auto-answer never authorises RM (SPAD stays until the dispatcher decides)
    options, auto: spad ? 'wait' : comm ? backup ? 'degrade' : 'wait' : 'release', timeout: 120,
  });
}

/** answer of the EB release call (radio.ts) */
export function answerEbRelease(sim: Sim, tr: Train, option: string): { ok: boolean; msg: string } {
  if (!tr.eb) return { ok: true, msg: '紧急制动已缓解' };
  if (option === 'wait') return { ok: true, msg: '司机原地等待' };
  if (option === 'degrade') {
    const r = authoriseEBRelease(sim, tr, '调度授权', 'degrade');
    if (r.ok && tr.level === 'CBTC') requestMode(sim, tr, tr.manual ? 'CM' : 'AM', 'TBTC');
    return { ok: r.ok, msg: r.ok ? `缓解后${MODE_CHANGE_TIME}秒转TBTC后备ATO` : r.msg };
  }
  if (option === 'rm') {
    const why = unsafeAhead(sim, tr);
    if (why) {
      return { ok: false, msg: `不能授权RM：${why}` };
    }
    const r = authoriseEBRelease(sim, tr, '调度授权', 'spad');
    if (!r.ok) return r;
    const d = distToNextSignal(sim, tr);
    grantRM(sim, tr, Math.max(0, d - 6), -1, '冒进后调度授权RM运行至前方信号机');
    return { ok: true, msg: `缓解，RM运行至前方信号机（${Math.round(d)} m）` };
  }
  return authoriseEBRelease(sim, tr, '调度授权');
}

// ---------------------------------------------------------------- RM authority

/**
 * Grant restricted manual (RM, ≤25 km/h on sight). `signal` is the one signal
 * at danger the authority allows to pass (-1: none — the train may only run
 * up to the next signal). RM is never granted under an EB: the EB is released
 * first by its own authorisation.
 */
export function grantRM(sim: Sim, tr: Train, metres: number, signal: number, reason: string): boolean {
  if (tr.eb) return false;
  if (tr.mode !== 'RM' && !setMode(sim, tr, 'RM', tr.level, '')) return false;
  tr.rmAuth = metres;
  tr.rmSig = signal;
  tr.rmReason = reason;
  tr.modeSince = sim.t;
  sim.log('C', '列车', `列车 ${trainLabel(tr)} 以RM模式（≤25km/h）运行：${reason}`, { train: tr.id });
  return true;
}

/** P3 §2.4.1: only after the cab passes the pull-out signal's inside point. */
export function turnbackSignalPassed(sim: Sim, tr: Train, signal: number) {
  if (tr.tbStage !== 'manual' || tr.tbExitSig !== signal || tr.mode !== 'RM') return;
  tr.rmAuth = 0;
  tr.tbStage = 'depart';
  tr.tbExitSig = -1;
  setMode(sim, tr, tr.manual ? 'CM' : 'AM', 'TBTC', '越过牵出信号内方，重新获取TBTC授权');
}

export function distToNextSignal(sim: Sim, tr: Train): number {
  const { topo } = sim;
  let link = tr.link;
  let dir = tr.dir;
  let d = dir === 1 ? topo.links[link].len - tr.off : tr.off;
  for (let i = 0; i < 60 && d < 5000; i++) {
    const nx = nextLink(topo, link, dir, (sw) => swPos(sim, sw));
    if (!nx) return d;
    const lk = topo.links[link];
    const node = dir === 1 ? lk.b : lk.a;
    if (topo.signalByEntry.has(node * 65536 + nx.link)) return d;
    d += topo.links[nx.link].len;
    link = nx.link;
    dir = nx.dir;
  }
  return d;
}

// ---------------------------------------------------------------- driver mode changes

/** a mode / level change performed by the driver after MODE_CHANGE_TIME at standstill */
export function requestMode(sim: Sim, tr: Train, mode: Mode, level: Level, delay = MODE_CHANGE_TIME) {
  if (!supportsSignalSystem(level)) return;
  tr.pendingMode = mode;
  tr.pendingLevel = level;
  tr.pendingModeAt = sim.t + delay;
}

/** dispatcher: train-level CBTC / TBTC selection (P1 表3) */
export function cmdTrainLevel(_sim: Sim, tr: Train, level: ForceLevel): { ok: boolean; msg: string } {
  if (level !== 'AUTO' && !supportsSignalSystem(level)) return { ok: false, msg: `本线路不支持${level}控制级别` };
  tr.forceLevel = level;
  const txt = level === 'AUTO' ? '自动' : level === 'CBTC' ? '强制CBTC' : '强制TBTC';
  if (level === 'TBTC' && tr.level === 'CBTC') return { ok: true, msg: `列车 ${trainLabel(tr)} 设为${txt}：下一站停站时降级TBTC后备` };
  if (level !== 'TBTC' && tr.level === 'TBTC') return { ok: true, msg: `列车 ${trainLabel(tr)} 设为${txt}：具备条件后不停车升级CBTC` };
  return { ok: true, msg: `列车 ${trainLabel(tr)} 控制级别设为${txt}` };
}

/** dispatcher: degrade one train to ATO with the driver (on = false), or let it run DTO again */
export function cmdTrainDto(sim: Sim, tr: Train, on: boolean): { ok: boolean; msg: string } {
  if (!on) {
    if (tr.dtoInhibit) return { ok: false, msg: `列车已不能DTO运行（${tr.dtoInhibit}）` };
    tr.dtoInhibit = '调度命令降级ATO';
    return { ok: true, msg: `列车 ${trainLabel(tr)} 降级ATO：司机在下一站停站时转AM驾驶` };
  }
  if (tr.dtoInhibit === '调度命令降级ATO') tr.dtoInhibit = '';
  else if (tr.dtoInhibit) return { ok: false, msg: `${tr.dtoInhibit}未修复，不能恢复DTO` };
  if (sim.atoLine) return { ok: false, msg: '全线ATO运营中，先恢复全线DTO' };
  return { ok: true, msg: `列车 ${trainLabel(tr)} 下一站停站时恢复DTO` };
}

/** dispatcher: the whole line runs ATO with drivers (DTO compatibility mode) or DTO again */
export function cmdLineAto(sim: Sim, on: boolean): { ok: boolean; msg: string } {
  if (sim.atoLine === on) return { ok: false, msg: on ? '已是全线ATO运营' : '已是全线DTO运营' };
  sim.atoLine = on;
  sim.log('B', '调度', on
    ? '全线转ATO运营（DTO兼容模式）：各列车停站时由司机转AM驾驶，终点站折返司机换端'
    : '全线恢复DTO运营：各列车停站时恢复DTO', {});
  return { ok: true, msg: on ? '全线转ATO运营：列车在下一站停站时转AM' : '全线恢复DTO：列车在下一站停站时恢复DTO' };
}

/** dispatcher hands a train to manual driving (CM / RM) or back to automatic (DTO / AM) */
export function setManual(sim: Sim, tr: Train, mode: 'CM' | 'RM' | 'AM' | 'AUTO'): { ok: boolean; msg: string } {
  if (tr.failed) return { ok: false, msg: '列车故障中' };
  if (tr.phase === 'stabled') return { ok: false, msg: '列车已存车' };
  if (tr.eb) return { ok: false, msg: '列车紧急制动中，须先报告调度并获授权缓解' };
  if (mode === 'AUTO') {
    if (!tr.manual && !tr.atoDriver) return { ok: false, msg: '列车未处于人工驾驶' };
    if (tr.v > 0.1 && tr.mode === 'RM') return { ok: false, msg: 'RM 转自动驾驶须停车后进行' };
    if (tr.doorSide && !tr.doorsOpen) return { ok: false, msg: '非站台侧车门未关闭' };
    const level: Level = cbtcAvailable(sim, tr) ? 'CBTC' : tr.level === 'CBTC' && !tr.comm ? 'CBTC' : 'TBTC';
    if (!supportsSignalSystem(level)) return { ok: false, msg: '当前控制级别不可用，本线路无可用后备系统' };
    if (level === 'CBTC' && !tr.comm) return { ok: false, msg: '车地通信中断，不能以CBTC自动驾驶' };
    const priorDriver = tr.atoDriver, priorManual = tr.manual;
    tr.atoDriver = false;
    // The mode transition must see the returned automatic cab, so it restores
    // an existing post-lock AM confirmation sample through the same delta.
    tr.manual = false;
    if (!setMode(sim, tr, autoMode(sim, tr, level), level, '恢复自动驾驶')) {
      tr.atoDriver = priorDriver;
      tr.manual = priorManual;
      return { ok: false, msg: '当前条件下不能转换（见状态机条件）' };
    }
    tr.atoButtons = { f: false, g: false };
    tr.notch = 0;
    // Player/manual closing has no automatic start sample. Handing the cab
    // back to AM must retain the remaining driver work from physical lock,
    // including AM→AM handback which does not pass through a mode change.
    if (simulatedAmDriver(tr) && tr.phase === 'dwell' && tr.autoStartAt === undefined
      && (tr.doorLockedAt ?? 0) > 0 && tr.doorLockedAt! >= tr.arrivedAt) {
      // 【假设】No DTO sample exists here: use its midpoint, without consuming
      // another random draw or changing the player's own F/G procedure.
      const [lo,hi]=OPERATIONS.autoStartDelay;
      tr.autoStartAt=tr.doorLockedAt!+(lo+hi)/2+OPERATIONS.atoDriverWork.postLockExtraS;
      setDepartureReadyAt(tr,Math.max(tr.dwellUntil,tr.autoStartAt));
    }
    return { ok: true, msg: `列车 ${trainLabel(tr)} 恢复 ${modeLabel(tr.mode, tr.level)} 自动驾驶` };
  }
  if (mode === 'AM') {
    const other = sim.trainList.find(o => o.id !== tr.id && (o.manual || o.atoDriver));
    if (other) return { ok: false, msg: `列车 ${trainLabel(other)} 已被接管` };
    if (tr.doorSide || tr.doorMotion?.kind === 'closing') return { ok: false, msg: '请先完成车门操作' };
    if (!setMode(sim, tr, 'AM', tr.level, '司机接管ATO')) return { ok: false, msg: '当前条件不能转AM' };
    tr.manual = false; tr.atoDriver = true; tr.reverser = 1; tr.notch = 0;
    // Player takeover retains the original cab-change budget, including an
    // AM→AM takeover that did not require a mode transition.
    const task = tr.tasks[0];
    if (tr.phase === 'reversing' && task?.k === 'reverse')
      tr.dwellUntil = Math.max(tr.dwellUntil, tr.phaseSince + turnbackDwell(tr.mode, task.minTime));
    tr.atoButtons = { f: false, g: false };
    // A takeover during automatic post-lock waiting goes straight to F/G.
    if (tr.phase === 'dwell' && tr.autoStartAt !== undefined && !tr.doorsOpen) {
      setDepartureReadyAt(tr, Math.min(tr.dwellUntil, Math.max(sim.t, tr.doorLockedAt ?? 0)));
      tr.autoStartAt = undefined;
    }
    return { ok: true, msg: 'ATO驾驶接管，发车条件满足后同时按住F和G' };
  }
  // one cab at a time: a second manual train would run on with its handle left where it was
  const other = !tr.manual && [...sim.trains.values()].find((o) => o.id !== tr.id && (o.manual || o.atoDriver));
  if (other) return { ok: false, msg: `列车 ${trainLabel(other)} 正在人工驾驶，请先将其恢复自动驾驶` };
  if (mode === 'RM' && tr.v > 0.1) return { ok: false, msg: '转RM模式须先停车' };
  if (mode === 'CM' && tr.level === 'CBTC' && !tr.comm) return { ok: false, msg: '车地通信中断，无ATP防护，只能以RM模式驾驶' };
  if (mode === 'CM' && sim.zoneState[sim.topo.links[tr.link].zone] === 'ZCFAIL' && tr.level === 'CBTC') return { ok: false, msg: 'ZC故障区域无移动授权，只能以RM模式驾驶' };
  if (mode === 'RM') {
    if (!setMode(sim, tr, 'RM', tr.level, '转人工驾驶')) return { ok: false, msg: '当前条件下不能转RM' };
    tr.rmAuth = 0;
    tr.rmSig = -1;
  } else if (!setMode(sim, tr, 'CM', tr.level, '转人工驾驶')) return { ok: false, msg: '当前条件下不能转CM' };
  tr.atoDriver = false; tr.reverser = 1;
  tr.autoOpenAt = undefined; tr.doorExchange = undefined;
  tr.manual = true;
  tr.notch = tr.v > 0.1 ? 0 : -7;
  tr.drv = { stops: [], overspeed: 0, spad: 0, since: sim.t, releases: 0, braking: false, restop: false };
  return { ok: true, msg: `列车 ${trainLabel(tr)} 转人工驾驶 ${mode}${mode === 'RM' ? '（≤25km/h，目视行车；越过关闭的信号机须调度逐架授权）' : '（ATP防护）'}` };
}

// ---------------------------------------------------------------- per-second onboard logic

export function updateOnboard(sim: Sim) {
  const { topo } = sim;
  for (const tr of sim.trainList) {
    // ---- emergency brake: driver report → dispatcher authorisation → release
    if (tr.eb) {
      if (tr.v > 0.01) continue;
      if (tr.ebAuth) { releaseEB(sim, tr, '调度授权'); continue; }
      const ringing = sim.calls.some((c) => c.state === 'ringing' && c.kind === 'ebRelease' && c.train === tr.id);
      if (!ringing && sim.t - tr.ebSince >= EB_REPORT_DELAY && (tr.ebCallAt === 0 || sim.t - tr.ebCallAt >= EB_REPEAT)) callEbRelease(sim, tr);
      continue;
    }
    // ---- pending driver mode change
    if (tr.pendingMode) {
      if (sim.t < tr.pendingModeAt) continue;
      const mode = tr.pendingMode;
      const level = tr.pendingLevel ?? tr.level;
      tr.pendingMode = null;
      tr.pendingLevel = null;
      if (!setMode(sim, tr, mode, level, '模式转换')) {
        // the condition went away meanwhile (e.g. comm recovered): stay as is
        sim.log('I', '列车', `列车 ${trainLabel(tr)} 取消模式转换（条件不满足）`, { train: tr.id });
      }
      continue;
    }
    if (tr.failed || tr.phase === 'stabled') continue;
    const zone = sim.zoneState[topo.links[tr.link].zone];
    const avail = cbtcAvailable(sim, tr);
    if (tr.manual && (tr.mode !== 'CM' || tr.level === 'CBTC')) continue;
    // ---- RM authority used up → supervised mode again
    if (tr.mode === 'RM') {
      if (tr.rmAuth > 0 || tr.coupledLen > 0 || tr.tasks[0]?.k === 'rescue') continue;
      const level: Level = avail ? 'CBTC' : 'TBTC';
      if (!supportsSignalSystem(level)) continue;
      setMode(sim, tr, autoMode(sim, tr, level), level, '结束RM');
      continue;
    }
    // ---- degrade CBTC → TBTC
    if (tr.level === 'CBTC') {
      const standing = tr.v < 0.1;
      if (!tr.comm) {
        // comm loss at standstill without EB (e.g. during a dwell): driver asks to degrade
        if (standing && !sim.calls.some((c) => c.state === 'ringing' && c.kind === 'degrade' && c.train === tr.id)) callDegrade(sim, tr);
        continue;
      }
      // forced TBTC (train or zone): degrade at the next station stop (P1 停站降级);
      // without a ZC (zone failed / switched) the train degrades where it stands
      // a dwelling train whose next stop lies in a zone switched to TBTC degrades here,
      // at the last station before the TBTC area, rather than in section
      const nextZone = tr.phase === 'dwell' ? nextStopZone(sim, tr) : 'CBTC';
      const forced = tr.forceLevel === 'TBTC' || zone !== 'CBTC' || nextZone !== 'CBTC';
      if (!forced) {
        // DTO degraded → the driver takes the cab at the next stop (ATO); back
        // to DTO at a stop once it is allowed again (D52)
        const stop = standing && (tr.phase === 'dwell' || tr.phase === 'reversing' || !tr.inService);
        if (tr.mode === 'DTO' && !dtoAllowed(sim, tr) && stop) setMode(sim, tr, 'AM', 'CBTC', sim.atoLine ? '全线ATO运营，转ATO（司机驾驶）' : `降级ATO（${tr.dtoInhibit}）`);
        else if (tr.mode === 'AM' && dtoAllowed(sim, tr) && stop) setMode(sim, tr, 'DTO', 'CBTC', '恢复DTO');
        continue;
      }
      if (!standing || !supportsSignalSystem('TBTC')) continue;
      if (tr.phase === 'dwell') setMode(sim, tr, 'AM', 'TBTC', tr.forceLevel === 'TBTC' ? '强制TBTC，停站降级' : '区域转TBTC，停站降级');
      else if (tr.phase === 'run' && (zone === 'ZCFAIL' || tr.maDist < 40)) {
        // no ZC movement authority: the driver changes over where the train stands
        requestMode(sim, tr, 'AM', 'TBTC');
        sim.log('I', '列车', `列车 ${trainLabel(tr)} ${zone === 'ZCFAIL' ? 'ZC故障，' : ''}原地降级TBTC后备（司机操作约${MODE_CHANGE_TIME}秒）`, { train: tr.id });
      }
      continue;
    }
    // ---- upgrade TBTC → CBTC on the move after relocalisation (P1 不停车升级)
    // (not towards a stop in a zone switched to TBTC: it would only degrade again there)
    if (!avail || tr.forceLevel === 'TBTC' || nextStopZone(sim, tr) !== 'CBTC') { tr.relocSec = -1; continue; }
    const sec = topo.links[tr.link].section;
    if (tr.relocSec < 0) { tr.relocSec = sec; continue; }
    const atBeacon = tr.v < 0.1 && topo.berths.some(b => b.link === tr.link && Math.abs(b.offset - tr.off) < 1);
    if (sec !== tr.relocSec || tr.phase === 'dwell' || atBeacon) {
      if (setMode(sim, tr, tr.mode === 'CM' ? 'CM' : autoMode(sim, tr, 'CBTC'), 'CBTC', '升级CBTC')) tr.relocSec = -1;
    }
  }
}

/** level state of the zone of the train's next stop (after the current dwell); 'CBTC' if none */
function nextStopZone(sim: Sim, tr: Train) {
  for (let i = tr.phase === 'dwell' ? 1 : 0; i < tr.tasks.length; i++) {
    const t = tr.tasks[i];
    const b = t.k === 'stop' || t.k === 'stable' ? t.berth : t.k === 'reverse' ? (t.chosen >= 0 ? t.chosen : t.berths[0]) : -1;
    if (b < 0) continue;
    return sim.zoneState[sim.topo.links[sim.topo.berths[b].link].zone];
  }
  return 'CBTC';
}

export function callDegrade(sim: Sim, tr: Train) {
  const backup = supportsSignalSystem('TBTC');
  return openCall(sim, {
    kind: 'degrade', from: `列车 ${trainLabel(tr)} 司机`, train: tr.id,
    text: backup ? '车载与轨旁通信中断，列车已停车，请求降级为TBTC后备ATO运行' : '车载与轨旁通信中断，列车已停车，本线路无TBTC后备，等待通信恢复',
    options: backup ? [{ key: 'approve', label: '同意降级TBTC后备运行' }, { key: 'wait', label: '原地等待' }] : [{ key: 'wait', label: '原地等待通信恢复' }], auto: backup ? 'approve' : 'wait', timeout: 120,
  });
}

export function answerDegrade(sim: Sim, tr: Train, option: string): { ok: boolean; msg: string } {
  if (option !== 'approve') return { ok: true, msg: '司机原地等待' };
  if (tr.comm || tr.level !== 'CBTC') return { ok: true, msg: '通信已恢复，无需降级' };
  if (!supportsSignalSystem('TBTC')) return { ok: false, msg: '本线路无TBTC后备，须等待通信恢复' };
  requestMode(sim, tr, 'AM', 'TBTC');
  return { ok: true, msg: `司机${MODE_CHANGE_TIME}秒后以TBTC后备ATO运行` };
}
