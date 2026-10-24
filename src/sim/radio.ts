import { crewLabel } from './uto';
/**
 * Simulated dispatcher radio / phone (调度电话·无线): drivers and station
 * staff call the dispatcher with requests and reports. Each call offers a
 * few responses and has a deadline; an unanswered call has consequences
 * (the train keeps waiting, the station acts on its own, the call is
 * repeated) and counts against the scenario score.
 *
 * In auto-answer mode (headless runs, demo) every call is answered with its
 * default response after a short delay, which reproduces the behaviour of
 * an attentive dispatcher.
 */
import type { Sim } from './engine';
import type { RadioCall, Train } from './model';
import { STATIONS } from '../data/current';
import { cmdAuthRM, cmdRescue, rescueApproach, trainLabel, answerOverrun } from './ats';
import { grantRM, answerDegrade, answerEbRelease } from './onboard';
import { setBypass } from './psd';
import { HALT, type HaltCode } from './halt';
import { nextLink } from './topology';
import { swPos } from './interlocking';
import { answerVehicle } from './vehicle';

export const AUTO_DELAY = 15;
const REPEAT = 120;
/** stop reasons for which the driver may be authorised to pass the signal ahead in RM */
const EQUIPMENT_CODES: HaltCode[] = ['SIGNAL_FAULT', 'SWITCH_FAULT', 'AXLE_FAULT'];
/** unanswered repeats before the call is raised as an alarm */
const ESCALATE_AFTER = 2;

export interface CallSpec {
  kind: string;
  from: string;
  text: string;
  options: RadioCall['options'];
  auto: string;
  timeout: number;
  train?: number;
  station?: number;
  target?: number;
}

export function openCall(sim: Sim, spec: CallSpec): RadioCall | null {
  const crew=crewLabel();
  if(crew!=='司机')spec={...spec,from:spec.from.replaceAll('司机',crew),text:spec.text.replaceAll('司机',crew),options:spec.options.map(o=>({...o,label:o.label.replaceAll('司机',crew)}))};
  // one ringing call per subject
  if (sim.calls.some((c) => c.state === 'ringing' && c.kind === spec.kind && c.train === spec.train && c.station === spec.station && c.target === spec.target)) return null;
  const same = sim.calls.filter((c) => c.kind === spec.kind && c.train === spec.train && c.station === spec.station && c.target === spec.target);
  const prev = same.length;
  // unanswered repeats since the last answer
  let unanswered = 0;
  for (let i = same.length - 1; i >= 0 && same[i].state === 'expired'; i--) unanswered++;
  const call: RadioCall = {
    id: sim.nextCallId++, t: sim.t, from: spec.from, kind: spec.kind, text: spec.text, train: spec.train, station: spec.station, target: spec.target,
    options: spec.options, auto: spec.auto, deadline: sim.t + spec.timeout, state: 'ringing', repeats: prev,
  };
  sim.calls.push(call);
  if (sim.calls.length > 300) sim.calls.splice(0, sim.calls.length - 300);
  sim.log('I', '通话', `【来电】${spec.from}：${spec.text}${prev ? `（第${prev + 1}次呼叫）` : ''}`);
  // a request repeated without an answer is escalated to an alarm
  if (unanswered >= ESCALATE_AFTER) {
    sim.log('B', '通话', `${spec.from} 已${unanswered}次呼叫未获应答：${spec.text}`, { key: `esc-${spec.kind}-${spec.train ?? ''}-${spec.target ?? ''}`, train: spec.train });
  }
  return call;
}

function driverOf(tr: Train) {
  return `列车 ${trainLabel(tr)} ${crewLabel()}`;
}

function stationName(i: number) {
  return `${STATIONS[i].name}站 行车值班员`;
}

/** answer a ringing call (dispatcher or auto) */
export function answerCall(sim: Sim, id: number, option: string, auto = false): { ok: boolean; msg: string } {
  const call = sim.calls.find((c) => c.id === id);
  if (!call) return { ok: false, msg: '通话不存在' };
  if (call.state !== 'ringing') return { ok: false, msg: '通话已结束' };
  const opt = call.options.find((o) => o.key === option);
  if (!opt) return { ok: false, msg: '无此应答' };
  if (auto && (option === 'rm' || call.kind === 'rmPreset' && option === 'approve')) return { ok: false, msg: '自动应答不能授权RM' };
  const r = applyAnswer(sim, call, option);
  if (!r.ok) {
    sim.log('C', '通话', `【应答拒绝】${call.from}：${r.msg}`, { manual: !auto });
    return r;
  }
  call.state = 'answered';
  call.answer = option;
  call.answeredAt = sim.t;
  if (!auto) sim.metrics.callsAnswered++;
  sim.log(r.ok ? 'I' : 'C', '通话', `【应答${auto ? '·自动' : ''}】${call.from}：${opt.label}${r.msg ? ` — ${r.msg}` : ''}`, { manual: !auto });
  return { ok: r.ok, msg: `${opt.label}${r.msg ? `：${r.msg}` : ''}` };
}

function applyAnswer(sim: Sim, call: RadioCall, option: string): { ok: boolean; msg: string } {
  const tr = call.train !== undefined ? sim.trains.get(call.train) : undefined;
  switch (call.kind) {
    case 'vTraction':
    case 'vDoorCut':
    case 'vDoorStuck':
    case 'vBrake':
      return answerVehicle(sim, call.kind, tr, option);
    case 'overrun':
      return answerOverrun(sim, tr, option);
    case 'degrade':
      if (!tr) return { ok: false, msg: '列车已不在线' };
      return answerDegrade(sim, tr, option);
    case 'ebRelease':
      if (!tr) return { ok: false, msg: '列车已不在线' };
      return answerEbRelease(sim, tr, option);
    case 'turnback': {
      if (!tr || tr.tbStage !== 'manual' || tr.level !== 'TBTC') return { ok: false, msg: 'TBTC人工牵出条件已变化' };
      if (option === 'wait') return { ok: true, msg: '司机在折返股道等待' };
      const sig = tr.tbExitSig;
      const ar = sig >= 0 && sim.routes.get(sim.sig[sig].route);
      if (!ar || ar.state !== 'locked' || ar.cancelAt || ar.guide) return { ok: false, msg: '牵出进路尚未锁闭' };
      const unsafe = unsafeAhead(sim, tr);
      if (unsafe) return { ok: false, msg: unsafe };
      return grantRM(sim, tr, tr.nextSignalDist + 20, sig, 'TBTC正向折返人工牵出（P3 §2.4.1）')
        ? { ok: true, msg: '人工越过牵出信号内方后重新获取TBTC授权' } : { ok: false, msg: '须停稳并完成EB缓解' };
    }
    case 'rmPreset': {
      if (!tr) return { ok: false, msg: '列车已不在线' };
      if (option === 'approve') {
        const unsafe = unsafeAhead(sim, tr);
        if (unsafe) return { ok: false, msg: unsafe };
        // the authority covers the preset section ahead and the one signal protecting it
        const sig = tr.nextSignal >= 0 && tr.nextSignalDist <= 450 ? tr.nextSignal : -1;
        if (!grantRM(sim, tr, 450 + tr.len, sig, '预复位区段压道')) return { ok: false, msg: '列车紧急制动中，须先缓解' };
        return { ok: true, msg: '司机以RM模式压道' };
      }
      return { ok: true, msg: '司机原地等待' };
    }
    case 'stuck': {
      if (!tr) return { ok: false, msg: '列车已不在线' };
      if (option === 'rm') {
        const why = unsafeAhead(sim, tr);
        if (why) {
          sim.metrics.safety.unsafeAuth++;
          sim.log('A', '安全', `不安全授权：列车 ${trainLabel(tr)} 前方${why}，仍授权RM运行`);
        }
        return cmdAuthRM(sim, tr, tr.nextSignal >= 0 ? tr.nextSignal : undefined);
      }
      return { ok: true, msg: '司机原地等待' };
    }
    case 'rescue': {
      const f = call.train !== undefined ? sim.trains.get(call.train) : undefined;
      if (!f || !f.failed) return { ok: true, msg: '故障列车已恢复/不在线' };
      if (option === 'organize') {
        const r = rescuerFor(sim, f);
        if (!r) return { ok: false, msg: '后方无可用救援列车' };
        return cmdRescue(sim, f, r);
      }
      return { ok: true, msg: '继续等待' };
    }
    case 'psd': {
      const p = call.target!;
      if (option === 'bypass') return setBypass(sim, p, true);
      return { ok: true, msg: '等待维修' };
    }
    case 'crowd': {
      const st = call.station!;
      if (option === 'limit') {
        const s = sim.topo.stations[st];
        for (const p of [s.platforms.DN, s.platforms.UP]) sim.plat[p].limitUntil = sim.t + 900;
        return { ok: true, msg: `${STATIONS[st].name} 实施进站限流15分钟` };
      }
      return { ok: true, msg: '' };
    }
    case 'pecu': {
      if (!tr) return { ok: false, msg: '列车已不在线' };
      if (option === 'next') { tr.extraDwell += 60; return { ok: true, msg: '列车运行至前方站停车处置（加站60秒）' }; }
      tr.stopUntil = sim.t + 90;
      tr.stopReason = '乘客紧急报警处置';
      return { ok: true, msg: '列车区间停车处置约90秒' };
    }
    case 'trackPerson': {
      const p = call.target!;
      if (option === 'esp') {
        sim.plat[p].esp = true;
        sim.log('A', '车站', `${sim.topo.platforms[p].name} 紧急关闭`, { key: `esp-${p}` });
        sim.pendingCalls.push({ at: sim.t + 150, spec: espClearSpec(sim, p) });
        return { ok: true, msg: '站台紧急关闭' };
      }
      sim.metrics.safety.espIgnored++;
      sim.log('A', '安全', `${sim.topo.platforms[call.target!].name} 有人员侵入轨道，调度未同意紧急关闭`);
      return { ok: true, msg: '未同意紧急关闭' };
    }
    case 'espClear': {
      const p = call.target!;
      if (option === 'clear') {
        sim.plat[p].esp = false;
        sim.clearAlarm(`esp-${p}`);
        return { ok: true, msg: '取消站台紧急关闭' };
      }
      sim.pendingCalls.push({ at: sim.t + 120, spec: espClearSpec(sim, p) });
      return { ok: true, msg: '保持紧急关闭' };
    }
    case 'possReq': {
      const ps = sim.possessions.find((x) => x.id === call.target);
      if (!ps) return { ok: false, msg: '施工计划不存在' };
      if (option === 'approve') {
        for (const s of ps.sections) { sim.sec[s].blocked = true; sim.sec[s].poss = ps.id; }
        ps.state = 'active';
        sim.log('B', '施工', `${ps.name} 施工封锁开始`, { key: `poss-${ps.id}` });
        return { ok: true, msg: '同意施工请点，区段封锁' };
      }
      ps.state = 'cancelled';
      return { ok: true, msg: '施工取消' };
    }
    case 'possRel': {
      const ps = sim.possessions.find((x) => x.id === call.target);
      if (!ps) return { ok: false, msg: '施工计划不存在' };
      if (option === 'approve') { releasePossession(sim, ps.id); return { ok: true, msg: '施工销点，区段解封' }; }
      sim.pendingCalls.push({ at: sim.t + 300, spec: possRelSpec(sim, ps.id) });
      return { ok: true, msg: '暂缓销点' };
    }
  }
  return { ok: true, msg: '' };
}

export function releasePossession(sim: Sim, id: number) {
  const ps = sim.possessions.find((x) => x.id === id);
  if (!ps) return;
  for (const s of ps.sections) {
    if (sim.sec[s].poss === id) { sim.sec[s].blocked = false; sim.sec[s].poss = -1; }
  }
  ps.state = 'done';
  sim.clearAlarm(`poss-${ps.id}`);
}

function espClearSpec(sim: Sim, p: number): CallSpec {
  const st = sim.topo.platforms[p].station;
  return {
    kind: 'espClear', from: stationName(st), text: `${sim.topo.platforms[p].name} 侵入人员已带离、线路出清，申请取消紧急关闭`, target: p, station: st,
    options: [{ key: 'clear', label: '同意取消紧急关闭' }, { key: 'keep', label: '暂保持关闭' }], auto: 'clear', timeout: 180,
  };
}

export function possRelSpec(sim: Sim, id: number): CallSpec {
  const ps = sim.possessions.find((x) => x.id === id)!;
  const st = sim.topo.sections[ps.sections[0]].station;
  return {
    kind: 'possRel', from: `${STATIONS[st].name}站 施工负责人`, text: `${ps.name} 施工完毕、人员机具已出清，申请销点`, target: id, station: st,
    options: [{ key: 'approve', label: '同意销点' }, { key: 'later', label: '稍后' }], auto: 'approve', timeout: 240,
  };
}

export function possReqSpec(sim: Sim, id: number): CallSpec {
  const ps = sim.possessions.find((x) => x.id === id)!;
  const st = sim.topo.sections[ps.sections[0]].station;
  return {
    kind: 'possReq', from: `${STATIONS[st].name}站 施工负责人`, text: `${ps.name} 申请施工请点（计划至 ${hhmm(ps.to)}）`, target: id, station: st,
    options: [{ key: 'approve', label: '同意请点（封锁区段）' }, { key: 'deny', label: '不同意' }], auto: 'approve', timeout: 300,
  };
}

function hhmm(t: number) {
  const s = Math.floor(t) % 86400;
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

/** reasons why authorising RM would be unsafe right now */
export function unsafeAhead(sim: Sim, tr: Train, ignore = -1): string {
  const { topo } = sim;
  let link = tr.link;
  let dir = tr.dir;
  let d = 0;
  let passedAuthorisedSignal = false;
  for (let i = 0; i < 120 && d < 4000; i++) {
    const l = topo.links[link];
    for (const body of sim.linkBodies.get(link) ?? []) {
      if (body.train === tr.id || body.train === ignore) continue;
      const ahead = i > 0 || (dir === 1 ? body.to > tr.off : body.from < tr.off);
      if (ahead) return '前方列车占用，须等待';
    }
    const node = topo.nodes[dir === 1 ? l.b : l.a];
    if (node.kind === 'switch') {
      const st = sim.sw[node.sw!];
      if (st.failed && !st.fieldLock) return `道岔 ${topo.switches[node.sw!].name} 失表且未钩锁`;
    }
    const nx = nextLink(topo, link, dir, (sw) => swPos(sim, sw) ?? sim.sw[sw].pos);
    if (!nx) break;
    const signal = topo.signalByEntry.get(node.id * 65536 + nx.link);
    if (signal !== undefined) {
      if (passedAuthorisedSignal) break;
      if (signal === tr.nextSignal) passedAuthorisedSignal = true;
    }
    const sec = sim.sec[topo.links[nx.link].section];
    if (sec.poss >= 0) return '为施工封锁区段';
    if (sec.blocked) return '为封锁区段';
    const p = topo.links[nx.link].platform;
    if (p >= 0 && sim.plat[p].esp) return '站台紧急关闭';
    d += topo.links[nx.link].len;
    link = nx.link;
    dir = nx.dir;
  }
  return '';
}

/** nearest train behind a failed train on its running line */
export function rescuerFor(sim: Sim, f: Train): Train | null {
  let best: Train | null = null;
  let bd = Infinity;
  const fCh = sim.trainChain(f);
  for (const tr of sim.trainList) {
    if (!rescueApproach(sim, f, tr)) continue;
    const ch = sim.trainChain(tr);
    const behind = Math.abs(fCh - ch);
    if (behind <= 0 || behind > 6000) continue;
    if (behind < bd) { bd = behind; best = tr; }
  }
  return best;
}

/** per-second: auto answers, deadlines and situation-driven calls */
export function radioTick(sim: Sim) {
  // delayed calls
  for (let i = sim.pendingCalls.length - 1; i >= 0; i--) {
    const p = sim.pendingCalls[i];
    if (sim.t >= p.at) { sim.pendingCalls.splice(i, 1); openCall(sim, p.spec); }
  }
  // the warm-up before the requested start time is always auto-answered:
  // nobody sits at the desk then (otherwise night possessions are never
  // signed off and a scenario would start on a gridlocked line)
  const auto = sim.autoRadio || sim.t < sim.config.startTime;
  for (const c of sim.calls) {
    if (c.state !== 'ringing') continue;
    if (auto && sim.t - c.t >= AUTO_DELAY) { answerCall(sim, c.id, c.auto, true); continue; }
    if (sim.t >= c.deadline) expire(sim, c);
  }
  // A wait response is temporary: repeat rescue requests while no order exists.
  for (const tr of sim.trainList) if (tr.failed && tr.rescueBy < 0) {
    const last = sim.calls.slice().reverse().find(c => c.kind === 'rescue' && c.train === tr.id);
    if (last && last.state !== 'ringing' && sim.t - (last.answeredAt ?? last.deadline) >= REPEAT) callRescue(sim, tr);
  }
  // drivers standing at an obstacle for a long time ask for instructions
  for (const tr of sim.trainList) {
    if (tr.tbStage === 'manual' && tr.level === 'TBTC' && tr.mode !== 'RM' && tr.tbExitSig >= 0
      && tr.v < 0.05 && !tr.eb && (tr.tbCallAt === 0 || sim.t - tr.tbCallAt >= 60)) {
      const ar = sim.routes.get(sim.sig[tr.tbExitSig].route);
      if (ar?.state === 'locked' && !ar.cancelAt) {
        openCall(sim, { kind: 'turnback', from: driverOf(tr), train: tr.id,
          text: 'TBTC正向折返换端完成，请求人工越过牵出信号内方再获取TBTC授权',
          options: [{ key: 'rm', label: '核实牵出进路后授权司机人工牵出', critical: true }, { key: 'wait', label: '折返股道等待' }], auto: 'wait', timeout: 120 });
        tr.tbCallAt = sim.t;
      }
    }
    const waiting = tr.phase === 'run' && tr.v < 0.05 && !tr.failed && !tr.hold && tr.stopUntil <= sim.t && !tr.pendingMode && !tr.manual
      && tr.maDist < 40 && tr.stopDist > 1.5 && tr.maReason !== '' && tr.tasks[0]?.k !== 'rescue';
    if (!waiting) { tr.waitSince = 0; continue; }
    const code = tr.halt.code;
    // RM is offered only for an equipment / signalling failure at the signal ahead
    const equip = EQUIPMENT_CODES.includes(code);
    // a train held by another train just waits; preset sections and comm loss have their own calls;
    // a planned / ordered wait (departure order, hold, layover…) is no reason to call. None of these
    // count towards the 3 minutes either: a train released from a 90-minute departure-order hold
    // whose route is still being set is not "stuck"
    if (tr.halt.train >= 0 || code === 'TRAIN_AHEAD' || code === 'AXLE_PRESET' || code === 'COMM_LOSS'
      || (HALT[code].exempt && !equip)) { tr.waitSince = 0; continue; }
    if (!tr.waitSince) tr.waitSince = sim.t;
    if (sim.t - tr.waitSince >= 180) {
      const r = tr.maReason;
      const c = openCall(sim, {
        kind: 'stuck', from: driverOf(tr), train: tr.id,
        text: `在${nearStationName(sim, tr)}因“${r}”停车已超过${Math.floor((sim.t - tr.waitSince) / 60)}分钟，请求指示`,
        options: equip
          ? [{ key: 'rm', label: `授权RM越过${tr.nextSignal >= 0 ? ` ${sim.topo.signals[tr.nextSignal].name}` : ''}（≤25km/h，目视）`, critical: true }, { key: 'wait', label: '原地等待' }]
          : [{ key: 'wait', label: '原地等待（调度处理）' }],
        auto: 'wait', timeout: 120,
      });
      if (c) tr.waitSince = sim.t; // ask again later
    }
  }
}

function expire(sim: Sim, c: RadioCall) {
  c.state = 'expired';
  sim.metrics.callsExpired++;
  sim.log('C', '通话', `【未应答】${c.from}：${c.text}`);
  const tr = c.train !== undefined ? sim.trains.get(c.train) : undefined;
  const again = (delay: number) => sim.pendingCalls.push({ at: sim.t + delay, spec: { kind: c.kind, from: c.from, text: c.text, options: c.options, auto: c.auto, timeout: c.deadline - c.t, train: c.train, station: c.station, target: c.target } });
  switch (c.kind) {
    case 'overrun':
      if (tr?.overrun) again(30);
      break;
    case 'vDoorStuck':
      // the train cannot move until somebody decides
      if (tr?.vfault?.stage === 'decide') again(60);
      break;
    case 'degrade':
      if (tr && !tr.comm && tr.level === 'CBTC') again(REPEAT / 2);
      break;
    case 'ebRelease':
      // the onboard logic repeats the report while the EB stands (onboard.ts)
      break;
    case 'rmPreset':
      if (tr) again(REPEAT / 2);
      break;
    case 'rescue':
      if (tr && tr.failed) again(REPEAT);
      break;
    case 'psd':
      if (sim.plat[c.target!].psd === 'closeFail') again(REPEAT);
      break;
    case 'pecu':
      // the driver stops in section on his own
      if (tr) {
        tr.stopUntil = sim.t + 150;
        tr.stopReason = '乘客紧急报警（未获指示，司机自行停车）';
        sim.log('B', '列车', `列车 ${trainLabel(tr)} 未获调度指示，司机按规定区间停车处置乘客报警`);
      }
      break;
    case 'trackPerson': {
      // the station presses its local emergency stop plunger
      const p = c.target!;
      sim.metrics.safety.espIgnored++;
      sim.plat[p].esp = true;
      sim.log('A', '车站', `${sim.topo.platforms[p].name} 车站自行按下紧急停车按钮（调度未应答）`, { key: `esp-${p}` });
      sim.pendingCalls.push({ at: sim.t + 150, spec: espClearSpec(sim, p) });
      break;
    }
    case 'espClear':
      again(60);
      break;
    case 'possReq': {
      const ps = sim.possessions.find((x) => x.id === c.target);
      if (ps && ps.state === 'requested') again(REPEAT);
      break;
    }
    case 'possRel':
      again(180);
      break;
  }
}

function nearStationName(sim: Sim, tr: Train): string {
  const ch = sim.trainChain(tr);
  let best = 0;
  for (let i = 1; i < sim.topo.stations.length; i++) if (Math.abs(sim.topo.stations[i].chain - ch) < Math.abs(sim.topo.stations[best].chain - ch)) best = i;
  const d = sim.topo.stations[best].chain - ch;
  return Math.abs(d) < 150 ? `${STATIONS[best].name}站` : `${STATIONS[best].name}站附近`;
}

// ---------------------------------------------------------------- call factories used by other modules

export function callRmPreset(sim: Sim, tr: Train) {
  return openCall(sim, {
    kind: 'rmPreset', from: driverOf(tr), train: tr.id,
    text: '前方区段计轴预复位，请求以RM模式压道运行',
    options: [{ key: 'approve', label: '同意RM压道', critical: true }, { key: 'wait', label: '原地等待' }], auto: 'wait', timeout: 120,
  });
}

export function callRescue(sim: Sim, tr: Train) {
  return openCall(sim, {
    kind: 'rescue', from: driverOf(tr), train: tr.id,
    text: '列车故障经处置无法恢复，请求组织救援',
    options: [{ key: 'organize', label: '组织后车救援', critical: true }, { key: 'wait', label: '继续处置/等待' }], auto: 'wait', timeout: 180,
  });
}

export function callPsd(sim: Sim, p: number) {
  const st = sim.topo.platforms[p].station;
  return openCall(sim, {
    kind: 'psd', from: stationName(st), target: p, station: st,
    text: `${sim.topo.platforms[p].name} 站台门无法关闭锁紧，已人工确认关闭并派员看守，请求互锁解除发车`,
    options: [{ key: 'bypass', label: '同意互锁解除', critical: true }, { key: 'wait', label: '等待维修' }], auto: 'wait', timeout: 120,
  });
}

export function callCrowd(sim: Sim, st: number, waiting: number) {
  return openCall(sim, {
    kind: 'crowd', from: stationName(st), station: st,
    text: `站台客流拥挤（候车约 ${Math.round(waiting)} 人），请求组织疏导`,
    options: [{ key: 'limit', label: '同意进站限流（15分钟）' }, { key: 'ack', label: '知道了，加强组织' }], auto: 'ack', timeout: 180,
  });
}

export function callPecu(sim: Sim, tr: Train) {
  return openCall(sim, {
    kind: 'pecu', from: driverOf(tr), train: tr.id,
    text: '车厢内乘客按下紧急报警按钮，请求处置方式',
    options: [{ key: 'next', label: '运行至前方站处置' }, { key: 'stop', label: '立即停车处置' }], auto: 'next', timeout: 45,
  });
}

export function callTrackPerson(sim: Sim, p: number) {
  const st = sim.topo.platforms[p].station;
  return openCall(sim, {
    kind: 'trackPerson', from: stationName(st), target: p, station: st,
    text: `${sim.topo.platforms[p].name} 有乘客跌落/侵入轨道，请求立即紧急关闭站台`,
    options: [{ key: 'esp', label: '立即紧急关闭站台', critical: false }, { key: 'deny', label: '不同意' }], auto: 'esp', timeout: 25,
  });
}
