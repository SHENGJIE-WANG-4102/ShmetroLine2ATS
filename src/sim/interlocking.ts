import { canStopBeforeSignal } from './protection';
/**
 * Computer interlocking (计算机联锁): switches, routes, signals, axle counters.
 */
import type { Sim } from './engine';
import type { ActiveRoute, Train } from './model';
import { withdrawAuthority, rescueRouteReady } from './movement';
import { checkArsCancellation } from './invariants';

export const SWITCH_TIME = 5; // s, point machine throw time (approx)
export const APPROACH_RELEASE = 30; // s, delayed release when approach-locked
export const GUIDE_TIME = 60; // s, guide aspect timeout

export function swPos(sim: Sim, sw: number): 'N' | 'R' | null {
  const s = sim.sw[sw];
  if (s.failed) return s.fieldLock ? s.pos : null;
  if (s.pos !== s.target || sim.t < s.moveUntil) return null;
  return s.pos;
}

export interface CmdResult { ok: boolean; msg: string }

/** Reclaim the released approach behind a failed route owner before an
 * assigned rescue enters it. Points retain their existing lock/position. */
export function relockRescueApproach(sim: Sim, train: Train, signal: number): CmdResult {
  if(!rescueRouteReady(sim,train,signal))return {ok:false,msg:'救援既有进路条件不成立'};
  const rid=sim.sig[signal].route,ar=sim.routes.get(rid)!,route=sim.topo.routes[rid];
  for(let i=0;i<route.sections.length;i++)if(ar.released[i]){
    sim.sec[route.sections[i]].lockRoute=rid;
    ar.released[i]=false;ar.occSeen[i]=false;
  }
  return {ok:true,msg:'救援接近区段重新锁闭，保持既有道岔位置'};
}

/** Bind the nearest approach, including routes which were already set/fleeting. */
export function bindRouteApproach(sim: Sim, rid: number, train: number) {
  const ar = sim.routes.get(rid);
  const tr = sim.trains.get(train);
  if (!ar || !tr || ar.entered && !ar.fleeting && ar.owner !== train) return;
  ar.directionTrain = train;
  const task = tr.tasks[tr.phase === 'reversing' ? 1 : 0];
  ar.directionPullout = tr.phase === 'reversing' || ['manual', 'depart'].includes(tr.tbStage);
  ar.directionGoal = task?.k === 'stop' ? task.berth : -1;
}

function reverseIntervalApproach(sim: Sim, rid: number, train?: number) {
  const tr = train === undefined ? undefined : sim.trains.get(train);
  const task = tr?.tasks[0];
  if (tr) {
    const goal = task?.k === 'reverse' ? task.chosen : task?.k === 'stop' ? task.berth : -1;
    return goal >= 0 && sim.topo.berths[goal].kind === 'platform' && sim.topo.berths[goal].reverse;
  }
  return sim.topo.routes[rid].berths.some(b => sim.topo.berths[b].kind === 'platform' && sim.topo.berths[b].reverse);
}

export function trySetRoute(sim: Sim, rid: number, opts: { manual?: boolean; fleeting?: boolean; guide?: boolean; train?: number } = {}): CmdResult {
  const topo = sim.topo;
  const r = topo.routes[rid];
  const sg = sim.sig[r.start];
  const sname = topo.signals[r.start].name;
  if (sg.failed && !opts.guide) return { ok: false, msg: `${sname} 信号机故障，无法开放（可办理引导进路）` };
  const approaching = opts.train !== undefined ? sim.trains.get(opts.train)
    : sim.trainList.filter(t => t.nextSignal === r.start).sort((a, b) => a.nextSignalDist - b.nextSignalDist)[0];
  const reverseInterval = r.wrongDir && reverseIntervalApproach(sim, rid, approaching?.id);
  if (reverseInterval && approaching?.level === 'TBTC') return { ok: false, msg: 'TBTC不能自动反向区间折返（P3 §2.4.2）' };
  if (sg.route >= 0) {
    if (sg.route === rid) {
      const ar = sim.routes.get(rid)!;
      if (approaching) bindRouteApproach(sim, rid, approaching.id);
      if (opts.fleeting) ar.fleeting = true;
      if (opts.guide && !ar.guide) {
        if (ar.entered || r.sections.some(s => sim.sec[s].trainOcc)) return { ok: false, msg: '进路内有车，不能改为引导进路' };
        ar.guide = true;
        ar.fleeting = false;
        ar.manual = !!opts.manual;
        ar.cancelAt = 0;
        ar.guideUntil = sim.t + GUIDE_TIME;
        for (const tr of sim.trainList) if (tr.maSigs.includes(r.start)) withdrawAuthority(sim, tr);
        return { ok: true, msg: `${sname} 引导信号开放` };
      }
      return { ok: true, msg: '进路已建立' };
    }
    return { ok: false, msg: `${sname} 已有其他进路` };
  }
  // A depot entry may not reserve a transfer track already occupied by an exiting
  // train. Occupancy on a CBTC route can admit following trains, never opposing ones.
  for (const step of r.steps) {
    if (topo.links[step.link].track !== 'DEP') continue;
    for (const body of sim.linkBodies.get(step.link) ?? []) {
      const train = sim.trains.get(body.train);
      const direction = train?.hist.slice().reverse().find(h => h.link === step.link)?.dir;
      if (direction !== undefined && direction !== step.dir) return { ok: false, msg: '出入段转换轨被对向列车占用' };
    }
  }
  for (const { sw } of r.switches) if (sim.sw[sw].blocked) return { ok: false, msg: `道岔 ${topo.switches[sw].name} 已封锁` };
  for (const s of r.sections) {
    const st = sim.sec[s];
    if (st.blocked) return { ok: false, msg: `区段 ${topo.sections[s].name} ${st.poss >= 0 ? '施工封锁' : '已封锁'}` };
    if (st.envTsr < 0) return { ok: false, msg: `区段 ${topo.sections[s].name} 大风停运` };
    if (st.lockRoute >= 0) return { ok: false, msg: `区段 ${topo.sections[s].name} 已被进路锁闭（敌对进路）` };
    if (!opts.guide && (st.disturbed || st.preset)) return { ok: false, msg: `区段 ${topo.sections[s].name} 故障占用` };
  }
  for (const { sw, pos } of r.switches) {
    const st = sim.sw[sw];
    const name = topo.switches[sw].name;
    if (st.blocked) return { ok: false, msg: `道岔 ${name} 已封锁` };
    if (st.failed) {
      if (!(opts.guide && st.fieldLock && st.pos === pos)) return { ok: false, msg: `道岔 ${name} 失表${opts.guide ? '（需现场钩锁到所需位置）' : ''}` };
      continue;
    }
    if (st.pos !== pos || st.target !== pos) {
      if (st.lockCount > 0) return { ok: false, msg: `道岔 ${name} 被进路锁闭` };
      if (st.singleLock) return { ok: false, msg: `道岔 ${name} 单锁` };
      if (st.fieldLock) return { ok: false, msg: `道岔 ${name} 已钩锁` };
      for (const s of topo.switches[sw].sections) if (sim.sec[s].occ) return { ok: false, msg: `道岔 ${name} 区段占用，不能转换` };
    }
  }
  // accept
  if (reverseInterval) for (const section of r.sections) for (const link of topo.sections[section].links)
    if (sim.linkBodies.get(link)?.some(body => body.train !== approaching?.id)) return { ok: false, msg: '反向折返防护区域有车，通过列车优先' };
  const ar: ActiveRoute = {
    route: rid, state: 'setting', fleeting: !!opts.fleeting, manual: !!opts.manual, guide: !!opts.guide,
    guideUntil: opts.guide ? sim.t + GUIDE_TIME : 0, occSeen: r.sections.map(() => false), released: r.sections.map(() => false),
    entered: false, owner: -1, arsTrain: opts.train ?? -1, cancelAt: 0, committed: -1, setAt: sim.t,
    directionTrain: approaching?.id ?? -1,
    directionReverse: reverseInterval,
  };
  for (const s of r.sections) {
    sim.sec[s].lockRoute = rid;
    if (reverseInterval) Object.assign(sim.sec[s], { td: 0, tdRoute: rid, tdTrain: ar.directionTrain, directionEsp: true });
  }
  for (const { sw, pos } of r.switches) {
    const st = sim.sw[sw];
    st.lockCount++;
    if (!st.failed && (st.pos !== pos || st.target !== pos)) {
      st.target = pos;
      st.moveUntil = sim.t + SWITCH_TIME;
    }
  }
  sim.routes.set(rid, ar);
  if (approaching) bindRouteApproach(sim, rid, approaching.id);
  sg.route = rid;
  if (reverseInterval) for (const tr of sim.trainList) withdrawAuthority(sim, tr);
  sim.routeUnlockedSw.set(rid, new Set());
  return { ok: true, msg: `进路 ${r.name} 办理成功` };
}

function releaseSection(sim: Sim, ar: ActiveRoute, i: number) {
  const topo = sim.topo;
  const r = topo.routes[ar.route];
  const s = r.sections[i];
  ar.released[i] = true;
  if (sim.sec[s].lockRoute === ar.route) sim.sec[s].lockRoute = -1;
  const protectedTrain = sim.trains.get(ar.directionTrain ?? -1);
  const regionOccupied = protectedTrain?.body.some(b => r.sections.includes(topo.links[b.link].section));
  if (sim.sec[s].tdRoute === ar.route && !regionOccupied)
    Object.assign(sim.sec[s], { td: 0, tdRoute: -1, tdTrain: -1, directionEsp: false });
  const done = sim.routeUnlockedSw.get(ar.route)!;
  for (const { sw } of r.switches) {
    if (done.has(sw)) continue;
    const secs = topo.switches[sw].sections.filter((x) => r.sections.includes(x));
    if (secs.every((x) => ar.released[r.sections.indexOf(x)])) {
      done.add(sw);
      sim.sw[sw].lockCount = Math.max(0, sim.sw[sw].lockCount - 1);
    }
  }
}

export function releaseRoute(sim: Sim, rid: number) {
  const ar = sim.routes.get(rid);
  if (!ar) return;
  const r = sim.topo.routes[rid];
  for (let i = 0; i < r.sections.length; i++) if (!ar.released[i]) releaseSection(sim, ar, i);
  const done = sim.routeUnlockedSw.get(rid)!;
  for (const { sw } of r.switches) if (!done.has(sw)) { sim.sw[sw].lockCount = Math.max(0, sim.sw[sw].lockCount - 1); done.add(sw); }
  sim.routes.delete(rid);
  sim.routeUnlockedSw.delete(rid);
  if (sim.sig[r.start].route === rid) sim.sig[r.start].route = -1;
  // the ZC withdraws every movement authority that was handed out over the route
  // (approach locking has made sure those trains can stop short of the signal)
  for (const tr of sim.trainList) if (tr.maSigs.includes(r.start)) withdrawAuthority(sim, tr);
}

/** Is a train approaching this signal (approach locking)? */
/** a train's head passed a signal: the route (if any) is now owned/consumed */
export function signalPassed(sim: Sim, train: number, sig: number) {
  const sg = sim.sig[sig];
  if (sg.route < 0) return;
  const ar = sim.routes.get(sg.route)!;
  if (ar.committed === train) ar.committed = -1;
  if (ar.arsTrain === train && ar.fleeting) ar.arsTrain = -1;
  if (ar.fleeting || ar.entered) return;
  ar.entered = true;
  ar.owner = train;
}

export function approachLocked(sim: Sim, sig: number): boolean {
  if (committedTrain(sim, sig) >= 0) return true;
  for (const tr of sim.trainList) {
    if (tr.nextSignal === sig && tr.nextSignalDist < 600 && tr.v > 0.5) return true;
  }
  return false;
}

/** an approaching train that cannot stop before the signal stopping target with the guaranteed emergency brake (-1 none) */
export function committedTrain(sim: Sim, sig: number): number {
  for (const tr of sim.trainList) {
    if (tr.v <= 0.01 || tr.mode === 'RM' || !tr.maSigs.includes(sig) && !(tr.maCut && tr.eb)) continue;
    if (!canStopBeforeSignal(sim,tr,sig,'emergency')) return tr.id;
  }
  return -1;
}

export function cancelRoute(sim: Sim, sig: number, opts: { force?: boolean; manual?: boolean; source?: 'ars' | 'dispatcher' | 'fault' | 'recovery'; train?: number } = {}): CmdResult {
  const sg = sim.sig[sig];
  const name = sim.topo.signals[sig].name;
  if (sg.route < 0) return { ok: false, msg: `${name} 无已建立进路` };
  const ar = sim.routes.get(sg.route)!;
  const r = sim.topo.routes[sg.route];
  if (ar.cancelAt > 0) return { ok: true, msg: `${name} 进路正在延时解锁` };
  if (!opts.force) {
    const occ = r.sections.some((s, i) => !ar.released[i] && sim.sec[s].trainOcc);
    if (occ) return { ok: false, msg: `进路 ${r.name} 内有车占用，不能取消` };
  }
  if (opts.source === 'ars') checkArsCancellation(sim, sig, opts.train ?? -1);
  if (approachLocked(sim, sig) && !opts.force) {
    // the signal closes at once; the route is released after the approach-locking delay.
    // A train that can no longer stop before the signal stopping target with the guaranteed emergency brake keeps
    // its movement authority over the route (it is "committed") and releases it normally.
    ar.cancelAt = sim.t + APPROACH_RELEASE;
    ar.fleeting = false;
    const c = committedTrain(sim, sig);
    if (c >= 0) {
      ar.committed = c;
      return { ok: true, msg: `${name} 接近锁闭，列车已无法在信号机前停车，进路保持至列车通过后解锁` };
    }
    return { ok: true, msg: `${name} 接近锁闭，信号关闭，进路延时${APPROACH_RELEASE}秒解锁` };
  }
  releaseRoute(sim, sg.route);
  return { ok: true, msg: `${name} 进路取消` };
}

/** 区段故障解锁: force-release a section's route lock */
export function sectionUnlock(sim: Sim, sec: number): CmdResult {
  const rid = sim.sec[sec].lockRoute;
  const name = sim.topo.sections[sec].name;
  if (rid < 0) return { ok: false, msg: `区段 ${name} 未锁闭` };
  const ar = sim.routes.get(rid);
  if (!ar) { sim.sec[sec].lockRoute = -1; return { ok: true, msg: `区段 ${name} 已解锁` }; }
  const r = sim.topo.routes[rid];
  const i = r.sections.indexOf(sec);
  // The interlocking, not the operator's confirmation, decides: a lock still
  // protecting a train is never released. Occupied sections are cleared by
  // 计轴预复位 first; a route a train is approaching, holds an authority over
  // or is running on towards this section stays locked. An automatic route is
  // released as a whole, so the whole of it must be free.
  const span = ar.fleeting ? r.sections : [sec];
  const occupied = span.find((x) => sim.sec[x].trainOcc || sim.sec[x].occ);
  if (occupied !== undefined) return { ok: false, msg: `区段 ${sim.topo.sections[occupied].name} 有车占用，不能故障解锁（计轴故障占用须先预复位）` };
  if (approachLocked(sim, r.start) || sim.trainList.some((tr) => tr.maSigs.includes(r.start)))
    return { ok: false, msg: `进路 ${r.name} 接近锁闭或已向列车发出移动授权，不能故障解锁` };
  const behind = ar.fleeting ? r.sections : r.sections.slice(0, i);
  if (behind.some((x) => sim.sec[x].trainOcc)) return { ok: false, msg: `进路 ${r.name} 上有列车驶向区段 ${name}，不能故障解锁` };
  // a dangerous operation: always in the log, whoever ordered it
  sim.log('B', '联锁', `区段故障解锁（人工解除进路锁闭）：区段 ${name}，进路 ${r.name}${ar.fleeting ? '（自动通过进路整体取消）' : ''}`, { code: 'SECTION_UNLOCK' });
  if (ar.fleeting) { releaseRoute(sim, rid); return { ok: true, msg: `区段 ${name} 故障解锁，自动通过进路已取消` }; }
  releaseSection(sim, ar, i);
  if (ar.released.every((x) => x)) releaseRoute(sim, rid);
  return { ok: true, msg: `区段 ${name} 故障解锁` };
}

export function moveSwitch(sim: Sim, sw: number, pos: 'N' | 'R'): CmdResult {
  const st = sim.sw[sw];
  const name = sim.topo.switches[sw].name;
  if (st.failed && pos === st.pos && st.target === pos) {
    // operating a repaired switch to the position it already holds restores detection without movement
    const f = sim.faults.find((x) => x.kind === 'switch' && x.target === sw && !x.repaired);
    if (!f || sim.t >= f.repairAt) {
      st.failed = false;
      st.fieldLock = false;
      if (f) f.repaired = true;
      sim.clearAlarm(`sw-${sw}`);
      return { ok: true, msg: `道岔 ${name} ${pos === 'N' ? '定位' : '反位'}表示恢复` };
    }
  }
  if (st.lockCount > 0) return { ok: false, msg: `道岔 ${name} 被进路锁闭` };
  if (st.singleLock) return { ok: false, msg: `道岔 ${name} 单锁，不能转换` };
  if (st.fieldLock) return { ok: false, msg: `道岔 ${name} 已现场钩锁` };
  for (const s of sim.topo.switches[sw].sections) {
    if (sim.sec[s].trainOcc) return { ok: false, msg: `道岔 ${name} 区段有车占用，不能转换` };
    if (sim.sec[s].occ) return { ok: false, msg: `道岔 ${name} 区段计轴占用（未确认出清），不能转换` };
  }
  st.target = pos;
  st.moveUntil = sim.t + SWITCH_TIME;
  if (st.failed) {
    // a throw attempt on a failed switch: succeeds only after maintenance
    const f = sim.faults.find((x) => x.kind === 'switch' && x.target === sw && !x.repaired);
    if (!f || sim.t >= f.repairAt) {
      st.failed = false;
      if (f) { f.repaired = true; sim.clearAlarm(`sw-${sw}`); }
      st.pos = st.pos === pos ? pos : st.pos;
      return { ok: true, msg: `道岔 ${name} 转换至${pos === 'N' ? '定位' : '反位'}，表示恢复` };
    }
    return { ok: false, msg: `道岔 ${name} 转换后仍无表示（失表）` };
  }
  return { ok: true, msg: `道岔 ${name} 转换至${pos === 'N' ? '定位' : '反位'}` };
}

export function computeOccupancy(sim: Sim) {
  const { sec, topo } = sim;
  for (const s of sec) { s.trainOcc = false; s.commOnly = true; }
  for (const tr of sim.trainList) {
    const commTrain = tr.comm && tr.level === 'CBTC' && sim.zoneState[topo.links[tr.link].zone] === 'CBTC';
    for (const b of tr.body) {
      const s = sec[topo.links[b.link].section];
      s.trainOcc = true;
      if (!commTrain) s.commOnly = false;
    }
  }
  for (const s of sec) {
    if (s.preset) {
      if (s.trainOcc) s.presetSeen = true;
      else if (s.presetSeen) { s.preset = false; s.presetSeen = false; }
    }
    s.occ = s.trainOcc || s.disturbed;
    if (s.disturbed) s.commOnly = false;
    if (!s.trainOcc && !s.disturbed) s.commOnly = false;
  }
}

export function updateInterlocking(sim: Sim) {
  const { topo } = sim;
  // Protection lasts through cab change; releasing an inbound route does not
  // invite through traffic into the still occupied reverse-turnback region.
  for (const sec of sim.sec) if (sec.tdRoute >= 0 && !sim.routes.has(sec.tdRoute)) {
    const owner = sim.trains.get(sec.tdTrain);
    if (!owner?.body.some(b => topo.routes[sec.tdRoute].sections.includes(topo.links[b.link].section)))
      Object.assign(sec, { td: 0, tdRoute: -1, tdTrain: -1, directionEsp: false });
  }
  // switches
  for (const s of sim.sw) {
    if (!s.failed && s.pos !== s.target && sim.t >= s.moveUntil) s.pos = s.target;
  }
  // routes
  for (const ar of Array.from(sim.routes.values())) {
    const r = topo.routes[ar.route];
    if (ar.state === 'setting') {
      if (r.switches.every(({ sw, pos }) => swPos(sim, sw) === pos)) {
        ar.state = 'locked';
        if (ar.directionReverse) for (const section of r.sections) {
          const step = r.steps.find(x => topo.links[x.link].section === section && topo.links[x.link].normalDir !== 0)
            ?? r.steps.find(x => topo.links[x.link].section === section)!;
          sim.sec[section].td = step.dir;
        }
      }
      else if (sim.t - ar.setAt > 30) {
        // switch failed to reach position
        sim.log('B', '联锁', `进路 ${r.name} 办理超时（道岔未到位），进路取消`);
        releaseRoute(sim, ar.route);
        continue;
      }
    }
    const directionOwner = sim.trains.get(ar.directionTrain ?? -1);
    const goalSection = ar.directionGoal !== undefined && ar.directionGoal >= 0
      ? topo.links[topo.berths[ar.directionGoal].link].section : -1;
    const goalFree = goalSection >= 0 && topo.sections[goalSection].links.every(link =>
      !(sim.linkBodies.get(link) ?? []).some(b => b.train !== directionOwner?.id));
    if (ar.state === 'locked' && ar.cancelAt === 0 && !ar.guide && ar.directionPullout && goalFree
      && directionOwner && directionOwner.v < 0.1 && directionOwner.phase === 'run'
      && ['manual', 'depart'].includes(directionOwner.tbStage)) {
      for (const sec of sim.sec) if (sec.tdTrain === directionOwner.id)
        Object.assign(sec, { td: 0, tdRoute: -1, tdTrain: -1, directionEsp: false });
    }
    if (ar.cancelAt > 0 && sim.t >= ar.cancelAt) {
      // a train that entered during the delay keeps the route (normal sectional release)
      if (ar.entered) { ar.cancelAt = 0; ar.committed = -1; }
      else if (ar.committed >= 0 && sim.trains.get(ar.committed)?.nextSignal === r.start) { /* still approaching */ }
      else { releaseRoute(sim, ar.route); continue; }
    }
    if (ar.guide && !ar.entered && sim.t > ar.guideUntil) {
      sim.log('C', '联锁', `${topo.signals[r.start].name} 引导信号超时关闭`);
      releaseRoute(sim, ar.route);
      continue;
    }
    if (ar.fleeting) continue;
    if (!ar.entered) {
      // former automatic route: once the trains inside have left and nobody approaches, release it
      if (ar.defleeted && !r.sections.some((s) => sim.sec[s].trainOcc) && !approachLocked(sim, r.start)) { releaseRoute(sim, ar.route); }
      continue;
    }
    // sectional release behind the owning train
    const owner = sim.trains.get(ar.owner);
    if (!owner) { releaseRoute(sim, ar.route); continue; }
    const ownSecs = new Set<number>();
    for (const b of owner.body) ownSecs.add(topo.links[b.link].section);
    for (let i = 0; i < r.sections.length; i++) if (ownSecs.has(r.sections[i])) ar.occSeen[i] = true;
    // owner came to rest with its head in the last section: the route is complete
    const lastSec = r.sections[r.sections.length - 1];
    if (owner.v < 0.05 && topo.links[owner.link].section === lastSec && owner.phase !== 'run'
      && !(owner.failed && owner.rescueBy >= 0)) {
      releaseRoute(sim, ar.route);
      continue;
    }
    for (let i = 0; i < r.sections.length; i++) {
      if (ar.released[i]) continue;
      if (ar.occSeen[i] && !ownSecs.has(r.sections[i]) && (i === 0 || ar.released[i - 1])) releaseSection(sim, ar, i);
      else break;
    }
    if (ar.released.every((x) => x)) releaseRoute(sim, ar.route);
  }
  // aspects
  for (let i = 0; i < sim.sig.length; i++) {
    const sg = sim.sig[i];
    sg.aspect = computeAspect(sim, i);
  }
}

function computeAspect(sim: Sim, i: number) {
  const sg = sim.sig[i];
  const { topo } = sim;
  const rid = sg.route;
  if (rid < 0) return sg.failed ? 'FAIL' : 'R';
  const ar = sim.routes.get(rid)!;
  if (ar.guide) return ar.state === 'locked' && !ar.entered && sim.t <= ar.guideUntil ? 'GUIDE' : 'R';
  if (sg.failed) return 'FAIL';
  if (ar.state !== 'locked' || ar.cancelAt > 0) return 'R';
  if (ar.entered && !ar.fleeting) return 'R';
  const r = topo.routes[rid];
  for (const { sw, pos } of r.switches) if (swPos(sim, sw) !== pos) return 'R';
  let comm = false;
  for (const s of r.sections) {
    const st = sim.sec[s];
    if (st.disturbed || st.preset) return 'R';
    if (st.occ) {
      if (st.commOnly && sim.zoneState[topo.sections[s].zone] === 'CBTC') comm = true;
      else return 'R';
    }
  }
  if (comm) return 'DARK';
  return r.diverging ? 'Y' : 'G';
}
