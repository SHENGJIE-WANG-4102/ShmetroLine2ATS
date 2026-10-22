/**
 * Transition tables of every state machine of the signalling core (§4).
 *
 * Each machine is a list of states and a table of allowed transitions, some
 * with a guard. The owning module performs a transition only through
 * `allowed()` (onboard.ts for modes / EB, psd.ts for the platform doors,
 * interlocking.ts for routes ...). Independently of that, the integrity
 * checker (invariants.ts) observes the state of every entity after each
 * fixed step and reports any change that is not in its table — so a write
 * that bypasses the owning module is caught as a violation.
 */
import type { Sim } from './engine';
import type { Train } from './model';

export interface Transition<S extends string> {
  from: S;
  to: S;
  /** what causes it (documentation, docs/signalling-model.md) */
  on: string;
  /** name of a guard in GUARDS that must hold when the transition happens */
  guard?: GuardName;
}

export interface Machine<S extends string> {
  name: string;
  label: string;
  states: readonly S[];
  initial: readonly S[];
  table: Transition<S>[];
}

// ---------------------------------------------------------------- guards

type GuardName = 'standstill' | 'cbtcAvailable' | 'dtoAvailable' | 'ebAuthorised' | 'stopped' | 'rescueReorientation';

/** guard context: the train (mode / EB machines) */
export const GUARDS: Record<GuardName, { label: string; check: (sim: Sim, tr: Train) => boolean }> = {
  rescueReorientation: { label: '故障列车停稳，按已核准救援路径重新换端', check: (_s, tr) => tr.v <= 0.01 && tr.failed && !!tr.rescueReverse },
  standstill: { label: '列车停稳（v < 0.1 m/s）', check: (_s, tr) => tr.v < 0.1 },
  stopped: { label: '列车速度为零', check: (_s, tr) => tr.v <= 0.01 },
  cbtcAvailable: {
    label: '车地通信正常、所在区域为CBTC、未强制TBTC',
    check: (sim, tr) => tr.comm && sim.zoneState[sim.topo.links[tr.link].zone] === 'CBTC' && tr.forceLevel !== 'TBTC',
  },
  dtoAvailable: {
    label: 'CBTC可用、列车停稳、车载DTO功能正常且未降级ATO运营',
    check: (sim, tr) => GUARDS.cbtcAvailable.check(sim, tr) && tr.v < 0.1 && !tr.dtoInhibit && !sim.atoLine,
  },
  ebAuthorised: { label: '经司机报告、调度授权缓解', check: (_s, tr) => tr.ebAuth },
};

// ---------------------------------------------------------------- driving mode × level

export type ModeState = 'DTO-C' | 'AM-C' | 'CM-C' | 'RM-C' | 'AM-T' | 'CM-T' | 'RM-T';

export const MODE: Machine<ModeState> = {
  name: 'mode',
  label: '驾驶模式/控制级别',
  states: ['DTO-C', 'AM-C', 'CM-C', 'RM-C', 'AM-T', 'CM-T', 'RM-T'],
  initial: ['DTO-C', 'AM-C', 'AM-T', 'CM-T', 'CM-C', 'RM-C', 'RM-T'],
  table: [
    // within CBTC
    { from: 'DTO-C', to: 'CM-C', on: '司机转人工驾驶（ATP防护）' },
    { from: 'CM-C', to: 'DTO-C', on: '恢复DTO', guard: 'cbtcAvailable' },
    { from: 'DTO-C', to: 'RM-C', on: '引导/授权RM', guard: 'standstill' },
    { from: 'CM-C', to: 'RM-C', on: '引导/授权RM', guard: 'standstill' },
    { from: 'RM-C', to: 'DTO-C', on: 'RM结束，获得移动授权', guard: 'cbtcAvailable' },
    { from: 'RM-C', to: 'CM-C', on: 'RM结束（人工驾驶）', guard: 'cbtcAvailable' },
    // ATO with the driver in the cab under CBTC (AM-C): the DTO degraded mode
    // (ATO is not the TBTC backup's own mode, D52)
    { from: 'DTO-C', to: 'AM-C', on: '降级ATO（司机驾驶室值守）', guard: 'standstill' },
    { from: 'AM-C', to: 'DTO-C', on: '恢复DTO', guard: 'dtoAvailable' },
    { from: 'AM-C', to: 'CM-C', on: '司机转人工驾驶（ATP防护）' },
    { from: 'CM-C', to: 'AM-C', on: '恢复ATO', guard: 'cbtcAvailable' },
    { from: 'AM-C', to: 'RM-C', on: '引导/授权RM', guard: 'standstill' },
    { from: 'RM-C', to: 'AM-C', on: 'RM结束，获得移动授权', guard: 'cbtcAvailable' },
    { from: 'AM-C', to: 'AM-T', on: '降级TBTC（ATO）', guard: 'standstill' },
    { from: 'AM-C', to: 'CM-T', on: '降级TBTC（人工）', guard: 'standstill' },
    { from: 'AM-T', to: 'AM-C', on: '升级CBTC（ATO）', guard: 'cbtcAvailable' },
    { from: 'CM-T', to: 'AM-C', on: '升级CBTC并恢复ATO', guard: 'cbtcAvailable' },
    { from: 'RM-T', to: 'AM-C', on: 'RM结束，获得CBTC移动授权', guard: 'cbtcAvailable' },
    // within TBTC
    { from: 'AM-T', to: 'CM-T', on: '司机转人工驾驶' },
    { from: 'CM-T', to: 'AM-T', on: '恢复ATO' },
    { from: 'AM-T', to: 'RM-T', on: '引导/授权RM', guard: 'standstill' },
    { from: 'CM-T', to: 'RM-T', on: '引导/授权RM', guard: 'standstill' },
    { from: 'RM-T', to: 'AM-T', on: 'RM结束，获得TBTC授权' },
    { from: 'RM-T', to: 'CM-T', on: 'RM结束（人工驾驶）' },
    // degrade CBTC → TBTC: only at standstill (P1 停站降级; comm loss after EB)
    { from: 'DTO-C', to: 'AM-T', on: '降级TBTC（ATO）', guard: 'standstill' },
    { from: 'DTO-C', to: 'CM-T', on: '降级TBTC（人工）', guard: 'standstill' },
    { from: 'CM-C', to: 'CM-T', on: '降级TBTC', guard: 'standstill' },
    { from: 'CM-C', to: 'AM-T', on: '降级TBTC（ATO）', guard: 'standstill' },
    // upgrade TBTC → CBTC: on the move after relocalisation (P1 不停车升级)
    { from: 'AM-T', to: 'DTO-C', on: '升级CBTC', guard: 'cbtcAvailable' },
    { from: 'CM-T', to: 'CM-C', on: '升级CBTC', guard: 'cbtcAvailable' },
    { from: 'CM-T', to: 'DTO-C', on: '升级CBTC并恢复DTO', guard: 'cbtcAvailable' },
    // RM does not depend on the level
    { from: 'RM-C', to: 'RM-T', on: 'RM运行中级别转换' },
    { from: 'RM-T', to: 'RM-C', on: 'RM运行中级别转换', guard: 'cbtcAvailable' },
    { from: 'RM-C', to: 'AM-T', on: 'RM结束，进入TBTC' },
    { from: 'RM-C', to: 'CM-T', on: 'RM结束，进入TBTC（人工）' },
    { from: 'RM-T', to: 'DTO-C', on: 'RM结束，获得CBTC移动授权', guard: 'cbtcAvailable' },
    { from: 'RM-T', to: 'CM-C', on: 'RM结束（人工，CBTC）', guard: 'cbtcAvailable' },
  ],
};

// ---------------------------------------------------------------- emergency brake

export type EbState = 'off' | 'braking' | 'standstill';

export const EB: Machine<EbState> = {
  name: 'eb',
  label: '紧急制动',
  states: ['off', 'braking', 'standstill'],
  initial: ['off', 'braking', 'standstill'],
  table: [
    { from: 'off', to: 'braking', on: 'ATP/司机/冒进触发紧急制动' },
    { from: 'off', to: 'standstill', on: '停车状态下触发紧急制动', guard: 'stopped' },
    { from: 'braking', to: 'standstill', on: '列车停稳', guard: 'stopped' },
    { from: 'standstill', to: 'off', on: '司机报告→调度授权→缓解', guard: 'ebAuthorised' },
  ],
};

// ---------------------------------------------------------------- platform screen doors (per platform)

export type PsdState = 'closed' | 'open' | 'pslOpen' | 'closeFail' | 'bypass';

export const PSD: Machine<PsdState> = {
  name: 'psd',
  label: '站台门/车门联动',
  states: ['closed', 'open', 'pslOpen', 'closeFail', 'bypass'],
  initial: ['closed'],
  table: [
    { from: 'closed', to: 'open', on: '列车停准，信号联动开门（DTO）' },
    { from: 'closed', to: 'pslOpen', on: '联动故障：站务员PSL开门' },
    { from: 'open', to: 'closed', on: '联动关门，关闭且锁紧' },
    { from: 'pslOpen', to: 'closed', on: 'PSL关门，关闭且锁紧' },
    { from: 'open', to: 'closeFail', on: '站台门无法关闭锁紧' },
    { from: 'pslOpen', to: 'closeFail', on: '站台门无法关闭锁紧' },
    { from: 'closeFail', to: 'bypass', on: '人工确认并互锁解除' },
    { from: 'open', to: 'bypass', on: '关门失败，互锁解除已在用' },
    { from: 'pslOpen', to: 'bypass', on: '关门失败，互锁解除已在用' },
    { from: 'closeFail', to: 'closed', on: '故障修复，关闭且锁紧' },
    { from: 'bypass', to: 'closed', on: '故障修复，取消互锁解除' },
    { from: 'bypass', to: 'open', on: '互锁解除期间下一列车开门' },
    { from: 'bypass', to: 'pslOpen', on: '互锁解除期间PSL开门' },
  ],
};

// ---------------------------------------------------------------- route lifecycle (per route)

export type RouteState = 'idle' | 'setting' | 'locked' | 'cancelling' | 'entered';

export const ROUTE: Machine<RouteState> = {
  name: 'route',
  label: '进路',
  states: ['idle', 'setting', 'locked', 'cancelling', 'entered'],
  initial: ['idle'],
  table: [
    { from: 'idle', to: 'setting', on: '办理进路（检查敌对、锁闭区段、转换道岔）' },
    { from: 'setting', to: 'locked', on: '道岔到位，进路锁闭' },
    { from: 'setting', to: 'idle', on: '办理超时 / 取消' },
    { from: 'locked', to: 'idle', on: '取消（无接近列车） / 引导超时' },
    { from: 'locked', to: 'cancelling', on: '接近锁闭中取消：延时解锁' },
    { from: 'cancelling', to: 'idle', on: '延时到，解锁' },
    { from: 'cancelling', to: 'entered', on: '已承诺列车进入进路' },
    { from: 'locked', to: 'entered', on: '列车越过始端信号机' },
    { from: 'entered', to: 'idle', on: '分段解锁完毕 / 区段故障解锁' },
  ],
};

// ---------------------------------------------------------------- turnback (per train)

export type TurnbackState = 'none' | 'arrive' | 'reverse' | 'manual' | 'depart';

export const TURNBACK: Machine<TurnbackState> = {
  name: 'turnback',
  label: '折返（含区间折返）',
  states: ['none', 'arrive', 'reverse', 'manual', 'depart'],
  initial: ['none', 'arrive'],
  table: [
    { from: 'none', to: 'arrive', on: '下一作业为折返：驶向折返股道' },
    { from: 'arrive', to: 'reverse', on: '在折返股道停稳，换端', guard: 'stopped' },
    { from: 'reverse', to: 'depart', on: '换端完成；出发站台空闲时排列牵出进路' },
    { from: 'reverse', to: 'manual', on: 'TBTC正向折返换端完成，待司机人工牵出（P3 §2.4.1）' },
    { from: 'manual', to: 'depart', on: '司机越过牵出信号内方，重新获得TBTC授权；或恢复CBTC' },
    { from: 'depart', to: 'none', on: '到达出发站台' },
    { from: 'arrive', to: 'none', on: '折返计划取消' },
    { from: 'depart', to: 'arrive', on: '牵出后再次折返（调度调整）' },
    { from: 'manual', to: 'arrive', on: '故障车为救援接近重新换端', guard: 'rescueReorientation' },
    { from: 'reverse', to: 'arrive', on: '故障中止原换端，改为救援接近', guard: 'rescueReorientation' },
  ],
};

// ---------------------------------------------------------------- depot moves (per train)

export type DepotState = 'none' | 'out' | 'in';

export const DEPOT: Machine<DepotState> = {
  name: 'depot',
  label: '出入段',
  states: ['none', 'out', 'in'],
  initial: ['none', 'out'],
  table: [
    { from: 'out', to: 'none', on: '经出段转换轨进入正线' },
    { from: 'none', to: 'in', on: '进入入段转换轨' },
  ],
};

// ---------------------------------------------------------------- radio calls (per call)

export type CallState = 'ringing' | 'answered' | 'expired' | 'withdrawn';

export const CALL: Machine<CallState> = {
  name: 'call',
  label: '调度通话',
  states: ['ringing', 'answered', 'expired', 'withdrawn'],
  initial: ['ringing'],
  table: [
    { from: 'ringing', to: 'answered', on: '调度应答' },
    { from: 'ringing', to: 'expired', on: '超时未应答（按默认处置/重复呼叫/升级报警）' },
    { from: 'ringing', to: 'withdrawn', on: '呼叫原因已消失' },
  ],
};

// ---------------------------------------------------------------- faults (per fault)

export type FaultState = 'effect' | 'procedure' | 'recovery' | 'closed';

export const FAULT: Machine<FaultState> = {
  name: 'fault',
  label: '故障处置',
  states: ['effect', 'procedure', 'recovery', 'closed'],
  initial: ['effect'],
  table: [
    { from: 'effect', to: 'procedure', on: '开始应急处置' },
    { from: 'effect', to: 'recovery', on: '设备修复（未需处置）' },
    { from: 'procedure', to: 'recovery', on: '设备修复，恢复正常模式' },
    { from: 'recovery', to: 'closed', on: '全部列车/设备恢复正常' },
  ],
};

export const MACHINES = [MODE, EB, PSD, ROUTE, TURNBACK, DEPOT, CALL, FAULT] as const;

/** is `from → to` in the machine's table (guards not evaluated) */
export function inTable<S extends string>(m: Machine<S>, from: S, to: S): Transition<S> | undefined {
  return m.table.find((x) => x.from === from && x.to === to);
}

/** table lookup plus guard evaluation for train machines */
export function allowed<S extends string>(sim: Sim, m: Machine<S>, from: S, to: S, tr?: Train): { ok: boolean; why: string } {
  if (from === to) return { ok: true, why: '' };
  const x = inTable(m, from, to);
  if (!x) return { ok: false, why: `${m.label}：${from}→${to} 不在转换表中` };
  if (x.guard && tr && !GUARDS[x.guard].check(sim, tr)) return { ok: false, why: `${m.label}：${from}→${to} 条件不满足（${GUARDS[x.guard].label}）` };
  return { ok: true, why: '' };
}

// ---------------------------------------------------------------- state extractors

export function modeState(tr: Train): ModeState {
  return `${tr.mode}-${tr.level === 'CBTC' ? 'C' : 'T'}` as ModeState;
}

export function ebState(tr: Train): EbState {
  if (!tr.eb) return 'off';
  return tr.v > 0.01 ? 'braking' : 'standstill';
}

export function routeState(sim: Sim, rid: number): RouteState {
  const ar = sim.routes.get(rid);
  if (!ar) return 'idle';
  if (ar.state === 'setting') return 'setting';
  if (ar.entered) return 'entered';
  if (ar.cancelAt > 0) return 'cancelling';
  return 'locked';
}
