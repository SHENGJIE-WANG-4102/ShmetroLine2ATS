/**
 * Train movement: movement-authority scan (ZC / TBTC / on-sight), ATP & ATO
 * control, kinematics and footprint (occupancy) maintenance.
 */
import type { Sim } from './engine';
import type { Train, BodySeg } from './model';
import { STANDBY_CALL } from './model';
import { nextLink, linkChain, type Dir } from './topology';
import { profileOf, heightAt, chainSense, gradeAccelAt, brakingSpeedH } from './gradient';
import { adhesionLimit, LOW_ADH_BPLAN, LOW_ADH_TRACTION } from './adhesion';
import { levelAccel, trainLevel } from './energy';
import { swPos } from './interlocking';
import { TRACTION_UNITS } from './vehicle';
import { PERF, brakingSpeed, jerkLimited, tractionAccel, atoTractionAccel, atoControl, atoStopApproachDistance, atoBrakeProfile, atoLimitSpeed, sectionPlan, sectionRecommended, sectionEta, staticLinkLimit, taskPlatformLimit, levelTarget, type SectionLimit } from './dynamics';
import { routeLeadsTo, distanceToBerthFrom, atoOverrun, type TaskPathVisitor } from './ats';
import type { HaltCode } from './halt';
import { applyEB } from './onboard';
import { psdSafe } from './psd';
import type { EbCause } from './model';
import { OPERATIONS } from '../data/line2';
import { SIGNAL_MARGIN, canAcceptRestriction } from './protection';

/** speed limits / platform stops further than this do not influence the braking curves */
const LOOKAHEAD = 1400;
/**
 * The movement authority itself is not range limited: the scan follows the set
 * route until it reaches its end (first signal without a locked route) or the
 * rear of the preceding train. This cap only guards against a pathological loop
 * of fleeting routes; on Line 2 the MA always terminates well before it.
 */
export const MA_SCAN_CAP = 25000;
/**
 * The per-step (10 Hz) supervision scan stops at the look-ahead range: nothing
 * further away can bind a braking curve below the 80 km/h ceiling
 * (guaranteed-EB distance from 80 km/h is ~260 m, the ATO planning curve
 * ~330 m). The MA end beyond it is refreshed once a second (ZC cycle) by
 * refreshAuthority and shifted by the train's own travel in between.
 */
export const MA_NEAR = LOOKAHEAD;
export const MA_CAP_REASON = '授权扫描上限';
const CBTC_SAFETY = 20; // m behind a preceding communicating train's tail
const SIGHT_MARGIN = 10; // m, RM on-sight stopping margin

export interface ScanResult {
  maDist: number;
  maReason: string;
  maCode: HaltCode;
  /** train that limits the MA (-1 none) */
  maTrain: number;
  /** nearest physical obstacle (train, buffer, undetected switch) */
  hardDist: number;
  /** what the nearest physical obstacle is */
  hardCode: HaltCode;
  stopDist: number;
  constraints: number[]; // flat [d, v, ...]
  vBody: number;
  nextSignal: number;
  nextSignalDist: number;
  /** signals the movement authority passes (route-locked by the MA: approach locking) */
  maSignals: number[];
}

/** link speed limit incl. TSR and weather restrictions (m/s) */
export function linkLimit(sim: Sim, link: number): number {
  const l = sim.topo.links[link];
  const s = sim.sec[l.section];
  let v = l.limit;
  if (s.tsr > 0) v = Math.min(v, s.tsr);
  if (s.envTsr > 0) v = Math.min(v, s.envTsr);
  return v / 3.6;
}

/** berth the train is currently heading for, or -1 */
export function goalBerth(tr: Train): number {
  const t = tr.tasks[0];
  if (!t) return -1;
  if (t.k === 'stop') return t.berth;
  if (t.k === 'reverse') return t.chosen;
  if (t.k === 'stable') return t.berth;
  return -1;
}

/** Remaining task-path distance for the arrival budget, independent of MA.
 * Reuse ARS's physical route-table distance rather than extending the 10Hz
 * safety scan. Signals/obstacles still constrain the near scan separately.
 * No cached train state: task/berth/route changes and day rollover take effect
 * immediately. stopDist retains its existing near-scan meaning for consumers.
 */
export function regulationDistance(sim: Sim, tr: Train, visit?: TaskPathVisitor): number {
  const goal = goalBerth(tr);
  if (goal < 0) return Infinity;
  if (stopError(sim, tr) < 0) return 0;
  return distanceToBerthFrom(sim, tr.link, tr.off, tr.dir, goal, visit);
}

/** Static head-path limits, extended until the tail clears. No traffic, TSR,
 * weather or MA is extrapolated into this unhindered arrival-budget profile.
 * Pure derived data: task/route/body changes and day carry need no cache state. */
export function regulationProfile(sim: Sim, tr: Train): { distance: number; limits: SectionLimit[] } {
  const berth = sim.topo.berths[goalBerth(tr)];
  const goalPlatform = berth?.kind === 'platform' ? berth.platform : -1;
  const restrictions: { from: number; to: number; limit: number }[] = [];
  const add = (link: number, from: number, to: number) => {
    const platformKmh = taskPlatformLimit(sim.topo, sim.topo.links[link].platform, tr.lastStation, goalPlatform) * 3.6;
    const limit = staticLinkLimit(sim.topo, link, platformKmh);
    if (limit < PERF.vMax && to + tr.len > 0 && to > from)
      restrictions.push({ from: Math.max(0, from), to: to + tr.len, limit });
  };
  let pathDistance = 0;
  const distance = regulationDistance(sim, tr, (link, from, to) => {
    const length = Math.abs(to - from);
    add(link, pathDistance, pathDistance + length);
    pathDistance += length;
  });
  if (!Number.isFinite(distance) || distance <= 0) return { distance, limits: [] };
  let behind = 0;
  for (const body of tr.body) {
    const length = body.to - body.from;
    add(body.link, -behind - length, -behind);
    behind += length;
  }
  const cuts = [...new Set([0, distance, ...restrictions.flatMap(s => [s.from, s.to]).filter(d => d > 0 && d < distance)])].sort((a, b) => a - b);
  const limits: SectionLimit[] = [];
  for (let i = 1; i < cuts.length; i++) {
    const start = cuts[i - 1];
    let limit = PERF.vMax;
    for (const r of restrictions) if (r.from <= start && r.to > start) limit = Math.min(limit, r.limit);
    const last = limits.at(-1), length = cuts[i] - start;
    if (last?.limit === limit) last.length += length;
    else limits.push({ length, limit });
  }
  return { distance, limits };
}

function obstacle(res: ScanResult, d: number, reason: string, code: HaltCode, hard = false, train = -1) {
  if (d < res.maDist) { res.maDist = Math.max(0, d); res.maReason = reason; res.maCode = code; res.maTrain = train; }
  if (hard && d < res.hardDist) { res.hardDist = Math.max(0, d); res.hardCode = code; }
}

/** a train (other than self) with its body in the section, -1 none */
function trainInSection(sim: Sim, sec: number, self: number): number {
  for (const lid of sim.topo.sections[sec].links) {
    const segs = sim.linkBodies.get(lid);
    if (segs) for (const s of segs) if (s.train !== self) return s.train;
  }
  return -1;
}

/** An assigned rescuer may enter the failed train's existing occupied route
 * on sight. It cannot realign points, pass another train, or use an opposing
 * route. Ordinary followers never receive this permission. */
export function rescueRouteReady(sim: Sim, tr: Train, signal: number): boolean {
  const task=tr.tasks[0];
  if(task?.k!=='rescue'||tr.rescuing!==task.target||signal<0)return false;
  const target=sim.trains.get(task.target);const rid=sim.sig[signal].route;
  const ar=sim.routes.get(rid);const route=sim.topo.routes[rid];
  if(!target?.failed||target.rescueBy!==tr.id||!ar||!route||ar.state!=='locked'||ar.cancelAt!==0
    ||!ar.entered||ar.owner!==target.id||route.steps[0]?.dir!==sim.topo.signals[signal].dir)return false;
  // A terminal tail can be entered against its nominal track direction.
  // This permission never extends to opposing moves on the running line.
  if(route.steps.some(step=>{
    const link=sim.topo.links[step.link];
    const tail=link.platform<0&&(Math.max(link.chainA,link.chainB)<sim.topo.stations[0].chain
      ||Math.min(link.chainA,link.chainB)>sim.topo.stations.at(-1)!.chain);
    return link.normalDir!==0&&link.normalDir!==step.dir&&!tail;
  }))return false;
  if(route.switches.some(({sw,pos})=>sim.sw[sw].failed||swPos(sim,sw)!==pos))return false;
  // RM sighting can sweep a counter preset. Physical bodies and point proof
  // still apply, and a foreign route/TD protection cannot be displaced.
  if(route.sections.some(s=>sim.sec[s].blocked||sim.sec[s].envTsr<0||sim.sec[s].directionEsp
    ||sim.sec[s].lockRoute>=0&&sim.sec[s].lockRoute!==rid))return false;
  let found=false;
  for(const step of route.steps)for(const body of sim.linkBodies.get(step.link)??[]){
    if(body.train===tr.id)continue;
    if(body.train!==target.id)return false;
    if(target.hist.slice().reverse().find(h=>h.link===step.link)?.dir!==step.dir)return false;
    found=true;
  }
  return found;
}

export function scanAhead(sim: Sim, tr: Train, goal: number, cap = MA_SCAN_CAP): ScanResult {
  const { topo } = sim;
  const res: ScanResult = { maDist: Infinity, maReason: '', maCode: 'NONE', maTrain: -1, hardDist: Infinity, hardCode: 'NONE', stopDist: Infinity, constraints: [], vBody: Infinity, nextSignal: -1, nextSignalDist: Infinity, maSignals: [] };
  const atp = tr.mode !== 'RM';
  // a manually driven RM train is on sight: authority limits are advisory, the scan goes on to find physical obstacles
  const onSight = tr.manual && tr.mode === 'RM';
  const cbtc = tr.level === 'CBTC' && tr.comm;
  const rescueTarget = tr.tasks[0]?.k === 'rescue' ? (tr.tasks[0] as { target: number }).target : -1;
  const dt0 = tr.tasks[0]?.k === 'depot' ? tr.tasks[0] as { depot: number; berth?: number } : null;
  const depotGoal = dt0 ? (dt0.berth !== undefined && dt0.berth >= 0 ? dt0.berth : topo.depots[dt0.depot].berth) : -1;
  const gb = goal >= 0 ? goal : depotGoal;
  const berth = gb >= 0 ? topo.berths[gb] : null;

  // any train — in service or empty — passes a platform it does not stop at
  // at the platform pass limit (the pressure wave would break the PSD glass);
  // it enters the platform it is bound for and leaves the one it has just
  // left at the platform stop limit
  const goalPlatform = berth?.kind === 'platform' ? berth.platform : -1;
  const platformLimit = (pl: number) => taskPlatformLimit(topo, pl, tr.lastStation, goalPlatform);

  // body limits & ESP on body
  for (const b of tr.body) {
    res.vBody = Math.min(res.vBody, linkLimit(sim, b.link));
    res.vBody = Math.min(res.vBody, platformLimit(topo.links[b.link].platform));
    const p = topo.links[b.link].platform;
    if (p >= 0 && sim.plat[p].esp) { res.maDist = 0; res.maReason = '站台紧急关闭'; res.maCode = 'ESP'; }
  }
  res.vBody = Math.min(res.vBody, PERF.vMax);
  if (tr.mode === 'RM') res.vBody = Math.min(res.vBody, rescueTarget >= 0 ? PERF.vCouple : PERF.vRM);
  if (tr.tbStage === 'manual' && tr.level === 'TBTC' && tr.mode !== 'RM')
    obstacle(res, 0, 'TBTC牵出须司机人工越过牵出信号内方', 'DIRECTION_WAIT');
  // (the departure platform of the station it turned back at: a train going
  // on to stop elsewhere first has no departure platform here to wait for)
  const pulloutStart = ['manual', 'depart'].includes(tr.tbStage) && berth?.kind === 'platform' && tr.v < 0.05
    && topo.platforms[berth.platform].station === tr.lastStation;
  // (a hot standby not yet called out does not queue for the platform, D70)
  const t0 = tr.tasks[0];
  const standing = t0?.k === 'stop' && (t0.standby || t0.stabledOut) && t0.dep !== null && t0.dep - sim.t > STANDBY_CALL;
  // The preceding reversal (or overnight spawn) already placed the body at
  // its registered berth. Withholding ARS alone still lets ATO creep to the
  // exit signal. Keep authority here until the scheduled call-out instead.
  if (standing && !tr.manual) obstacle(res, 0, t0.standby ? '热备待命' : '存车待发', 'REGULATION');
  if (pulloutStart && !standing) {
    const holder = trainInSection(sim, topo.links[berth.link].section, tr.id);
    if (holder >= 0) obstacle(res, 0, '折返发车站台有车，等待平台出清', 'BERTH_WAIT', false, holder);
  }



  let link = tr.link;
  let dir = tr.dir;
  const l0 = topo.links[link];
  let d = dir === 1 ? l0.len - tr.off : tr.off;

  // goal on current link
  if (berth && berth.link === link && berth.dir === dir) {
    const dist = dir === 1 ? berth.offset - tr.off : tr.off - berth.offset;
    res.stopDist = Math.max(0, dist);
  }
  // A still-pending task does not cease to be a stopping target when the
  // moving head overruns it, including across the following short links.
  if (berth && gb === goalBerth(tr) && stopError(sim, tr) < 0) res.stopDist = 0;
  // other trains on current link ahead
  checkTrainsOnLink(sim, tr, link, dir, -(dir === 1 ? tr.off : l0.len - tr.off), rescueTarget, cbtc, atp, res);

  // zone check for current position
  const z0 = sim.zoneState[l0.zone];
  // without a ZC (zone failed, train-ground link lost) no new authority comes in: the
  // onboard keeps the last MA it received and stops within it (it is never pulled
  // back under a moving train); tr.maDist was measured before the last movement
  const kept = tr.v > .01 && Number.isFinite(tr.maDist) ? Math.max(0, tr.maDist - tr.lastDs) : 0;
  if (atp && tr.level === 'CBTC' && z0 === 'ZCFAIL' && tr.rmAuth <= 0) obstacle(res, kept, '区域控制器故障', 'ZC_FAULT');
  if (atp && tr.level === 'CBTC' && !tr.comm) obstacle(res, kept, '车地通信中断', 'COMM_LOSS');

  let lastSec = l0.section;
  let guard = 0;
  const swAt = (sw: number) => swPos(sim, sw);
  // past the stopping point we only keep looking for the next signal (for ARS)
  // once the MA end is found we only keep looking for the next signal (for ARS)
  let signalOnly = res.maDist <= 0;
  const sigPass: number[] = [];
  while (guard++ < 600) {
    if (!signalOnly && !onSight && d >= res.maDist) signalOnly = true;
    if (onSight && (d >= res.hardDist || d >= LOOKAHEAD)) break;
    if (signalOnly && (res.nextSignal >= 0 || d > 500)) break;
    if (!signalOnly && d >= cap) break;
    const nx = nextLink(topo, link, dir, swAt);
    const lk = topo.links[link];
    const node = dir === 1 ? lk.b : lk.a;
    if (signalOnly) {
      if (!nx) break;
      const sid = topo.signalByEntry.get(node * 65536 + nx.link);
      if (sid !== undefined) { res.nextSignal = sid; res.nextSignalDist = d; break; }
      d += topo.links[nx.link].len;
      link = nx.link;
      dir = nx.dir;
      continue;
    }
    if (!nx) {
      const n = topo.nodes[node];
      const swFailed = n.kind === 'switch' && sim.sw[n.sw!].failed;
      const code: HaltCode = n.kind === 'end' ? (n.endKind === 'depot' ? 'DEPOT_LIMIT' : 'BUFFER') : swFailed ? 'SWITCH_FAULT' : 'SWITCH_MOVING';
      obstacle(res, d - (n.kind === 'end' ? 3 : SIGNAL_MARGIN), n.kind === 'end' ? (n.endKind === 'depot' ? '段界' : '车挡') : '道岔无表示', code, true);
      break;
    }
    const nl = topo.links[nx.link];
    // signal at entry
    const sigId = topo.signalByEntry.get(node * 65536 + nx.link);
    if (sigId !== undefined) {
      // the next signal (for ARS / approach locking) is only reported within the look-ahead range
      if (res.nextSignal < 0 && d < LOOKAHEAD) { res.nextSignal = sigId; res.nextSignalDist = d; }
      const sg = sim.sig[sigId];
      let ok = false;
      if (sg.route >= 0) {
        const ar = sim.routes.get(sg.route)!;
        const consumed = ar.entered && !ar.fleeting && !ar.guide;
        // a route over a switch that lost detection gives no movement authority past its signal
        let swOk = true;
        for (const x of topo.routes[sg.route].switches) if (swPos(sim, x.sw) !== x.pos) { swOk = false; break; }
        if (atp) ok = ar.state === 'locked' && ar.cancelAt === 0 && !ar.guide && !consumed && !sg.failed && swOk;
        else {
          const rescuePass=tr.rmSig===sigId&&tr.rmAuth>d&&swOk&&rescueRouteReady(sim,tr,sigId);
          // RM is on sight but not over points still moving or without detection
          ok = (ar.state === 'locked' || ar.guide) && ar.cancelAt === 0 && (!consumed||rescuePass) && swOk
            && (sg.aspect !== 'R' && sg.aspect !== 'FAIL' || (tr.rmSig === sigId && tr.rmAuth > d));
          if(rescuePass)res.constraints.push(0,PERF.vCouple);
        }
        // a committed train keeps the authority of a route cancelled in front of it
        if (!ok && ar.committed === tr.id && ar.state === 'locked' && !consumed && swOk) ok = true;
        if (atp && tr.level === 'TBTC' && ar.directionReverse) ok = false;
        if (ok && atp) sigPass.push(sigId, d);
      } else if (!atp && tr.rmSig === sigId && tr.rmAuth > d && !topo.signals[sigId].routes.some((r) => topo.routes[r].switches.length > 0)) {
        ok = true; // authorised (for this one signal) to pass it at danger on plain line
      }
      if (!ok) {
        // a locked route over a switch without detection waits on the switch fault, not on ARS
        const swLost = sg.route >= 0 && topo.routes[sg.route].switches.some((x) => sim.sw[x.sw].failed && swPos(sim, x.sw) !== x.pos);
        if (atp && tr.level === 'TBTC' && sg.route >= 0 && sim.routes.get(sg.route)?.directionReverse)
          obstacle(res, d - SIGNAL_MARGIN, 'TBTC不能自动反向区间折返', 'DIRECTION_WAIT');
        else if (sg.failed) obstacle(res, d - SIGNAL_MARGIN, '信号机故障', 'SIGNAL_FAULT');
        else if (swLost) obstacle(res, d - SIGNAL_MARGIN, '进路内道岔失表', 'SWITCH_FAULT');
        else if (!atp && sg.route >= 0 && topo.routes[sg.route].sections.some(s => sim.sec[s].preset))
          obstacle(res, d - SIGNAL_MARGIN, '计轴预复位区段', 'AXLE_PRESET');
        else if (!atp && sg.route >= 0 && topo.routes[sg.route].sections.some(s => sim.sec[s].disturbed))
          obstacle(res, d - SIGNAL_MARGIN, '计轴故障占用', 'AXLE_FAULT');
        else obstacle(res, d - SIGNAL_MARGIN, '信号/进路未开放', 'ROUTE_WAIT');
        if (!onSight) break;
      }
      // ATS departure / route check: the set route must lead towards the train's goal
      const routeGoal = gb >= 0 ? gb : sim.rescueGoal(tr);
      if (ok && !tr.manual && res.stopDist === Infinity && routeGoal >= 0 && sg.route >= 0 && !routeLeadsTo(sim, sg.route, routeGoal)) { obstacle(res, d - SIGNAL_MARGIN, '进路与计划不符', 'ROUTE_MISMATCH'); break; }
    }
    // section checks
    if (nl.section !== lastSec) {
      const st = sim.sec[nl.section];
      const zs = sim.zoneState[nl.zone];
      lastSec = nl.section;
      if (st.blocked || st.envTsr < 0) {
        obstacle(res, d - 5, st.poss >= 0 ? '施工封锁区段' : st.envTsr < 0 ? '大风停运区段' : '区段封锁', st.poss >= 0 ? 'POSSESSION' : st.envTsr < 0 ? 'WEATHER' : 'BLOCKED');
        if (!onSight) break;
      }
      if (atp && tr.rmAuth <= d) {
        if (st.tdRoute >= 0 && (st.td === 0 || st.directionEsp && st.tdTrain !== tr.id || nl.normalDir !== 0 && st.td !== nx.dir)) {
          obstacle(res, d - 5, '反向折返区域TD切除/紧急停车防护', 'DIRECTION_WAIT', false, st.tdTrain === tr.id ? -1 : st.tdTrain); break;
        }
        // the MA already issued into the failed zone stays valid (kept); no new one is given
        if (tr.level === 'CBTC' && zs === 'ZCFAIL') { obstacle(res, Math.max(d - 5, kept), 'ZC故障区域', 'ZC_FAULT'); if (kept <= d - 5) break; }
        if (st.disturbed || st.preset) { obstacle(res, d - 5, st.preset ? '计轴预复位区段' : '计轴故障占用', st.preset ? 'AXLE_PRESET' : 'AXLE_FAULT'); break; }
        if (st.occ) {
          const passable = cbtc && zs === 'CBTC' && st.commOnly;
          if (!passable) { obstacle(res, d - 5, cbtc ? '非通信车占用' : '前方区段占用', 'TRAIN_AHEAD', false, trainInSection(sim, nl.section, tr.id)); break; }
        }
      }
    }
    // other trains on this link (before the platform checks below, which end the walk)
    checkTrainsOnLink(sim, tr, nx.link, nx.dir, d, rescueTarget, cbtc, atp, res);
    // platform protections
    if (nl.platform >= 0) {
      const ps = sim.plat[nl.platform];
      if (ps.esp) { obstacle(res, d - 3, '站台紧急关闭', 'ESP'); if (!onSight) break; }
      if (!psdSafe(ps) && atp) { obstacle(res, d - 3, '站台门未关闭锁紧', 'PSD_FAULT'); break; }
    }
    // speed limits
    const lim = Math.min(platformLimit(nl.platform), linkLimit(sim, nx.link));
    if (d < LOOKAHEAD && (lim < res.vBody + 0.01 || lim < 25)) res.constraints.push(d, tr.mode === 'RM' ? Math.min(lim, PERF.vRM) : lim);
    // goal
    if (res.stopDist === Infinity && berth && berth.link === nx.link && berth.dir === nx.dir) {
      res.stopDist = d + (nx.dir === 1 ? berth.offset : nl.len - berth.offset);
    }
    d += nl.len;
    link = nx.link;
    dir = nx.dir;
  }
  // the walk ended without meeting an authority limit (RM on sight, scan cap)
  if (res.maDist === Infinity && !onSight) { res.maDist = Math.min(d, cap); res.maReason = MA_CAP_REASON; res.maCode = 'NONE'; }
  // P3: a stopped train obtains pull-out authority only after the complete
  // departure path is locked and clear. Creeping toward a closed tail signal
  // before this point can force a sudden zero target when the platform fills.
  if (pulloutStart && tr.mode !== 'RM' && (res.stopDist === Infinity || res.maDist < res.stopDist - 0.5)) {
    const code = res.maCode === 'NONE' ? 'ROUTE_WAIT' : res.maCode;
    obstacle(res, 0, res.maReason || '等待折返牵出进路锁闭并到达发车站台', code, false, res.maTrain);
  }
  if (res.nextSignal < 0) { res.nextSignalDist = Infinity; }
  for (let i = 0; i < sigPass.length; i += 2) if (sigPass[i + 1] < res.maDist) res.maSignals.push(sigPass[i]);
  return res;
}

/**
 * Signed distance from the head to the goal stopping point (m): positive =
 * short of the mark, negative = overrun. NaN when no stopping point is near.
 */
export function stopError(sim: Sim, tr: Train): number {
  const goal = goalBerth(tr);
  if (goal < 0) return NaN;
  const err = berthError(sim, tr, goal);
  if (!Number.isNaN(err)) return err;
  if (Number.isFinite(tr.stopDist) && tr.stopDist < 400) return tr.stopDist;
  return NaN;
}

/** Signed distance from the head to a berth's stopping point along the
 * travelled path; NaN when the berth is not on it. */
export function berthError(sim: Sim, tr: Train, goal: number): number {
  const { topo } = sim;
  const b = topo.berths[goal];
  if (b.link === tr.link && b.dir === tr.dir) return (b.offset - tr.off) * tr.dir;
  let beyond = tr.dir === 1 ? tr.off : topo.links[tr.link].len - tr.off;
  for (let i = tr.hist.length - 2; i >= 0; i--) {
    const prev = tr.hist[i], link = topo.links[prev.link];
    if (prev.link === b.link && prev.dir === b.dir)
      return -(beyond + (b.dir === 1 ? link.len - b.offset : b.offset));
    beyond += link.len;
  }
  return NaN;
}

/** move the head back along its own path (no signal handling): used for 退行对标 */
export function moveBack(sim: Sim, tr: Train, dist: number) {
  const { topo } = sim;
  let rem = dist;
  let guard = 0;
  while (rem > 0.001 && guard++ < 10) {
    const room = tr.dir === 1 ? tr.off : topo.links[tr.link].len - tr.off;
    if (rem <= room) { tr.off -= tr.dir * rem; break; }
    rem -= room;
    if (tr.hist.length < 2) { tr.off = tr.dir === 1 ? 0 : topo.links[tr.link].len; break; }
    tr.hist.pop();
    const prev = tr.hist[tr.hist.length - 1];
    tr.link = prev.link;
    tr.dir = prev.dir;
    tr.off = prev.dir === 1 ? topo.links[prev.link].len : 0;
  }
  computeBody(sim, tr, false);
}

/** commanded acceleration from the driver's master controller */
export function notchAccel(v: number, notch: number): number {
  if (notch <= -8) return -PERF.bEb;
  if (notch < 0) return -PERF.bService * (-notch / 7);
  if (notch > 0) return tractionAccel(v) * Math.min(4, notch) / 4;
  return v > 0.1 ? -PERF.resist : 0;
}

function checkTrainsOnLink(
  sim: Sim, tr: Train, link: number, dir: Dir, dEntry: number, rescueTarget: number, cbtc: boolean, atp: boolean,
  res: ScanResult,
) {
  const segs = sim.linkBodies.get(link);
  if (!segs) return;
  const len = sim.topo.links[link].len;
  for (const s of segs) {
    if (s.train === tr.id) continue;
    const near = dir === 1 ? s.from : len - s.to;
    const dist = dEntry + near;
    if (dist < -0.5) continue; // behind us on the same link
    if (s.train === rescueTarget) {
      obstacle(res, dist - 0.3, '救援连挂', 'RESCUE', true, s.train);
      res.constraints.push(Math.max(0, dist - 25), PERF.vCouple);
      continue;
    }
    const other = sim.trains.get(s.train)!;
    const otherComm = other.comm && other.level === 'CBTC';
    let margin = SIGHT_MARGIN;
    if (atp) margin = cbtc && otherComm ? CBTC_SAFETY : 25;
    // a manual RM driver may close up to the train ahead (on sight); the physical limit is 1 m
    if (tr.manual && !atp) { obstacle(res, dist - margin, '前方列车(目视)', 'TRAIN_AHEAD', false, s.train); obstacle(res, dist - 1, '前方列车(目视)', 'TRAIN_AHEAD', true, s.train); continue; }
    obstacle(res, dist - margin, otherComm ? '前车' : '前方列车(非通信)', 'TRAIN_AHEAD', true, s.train);
  }
}

/** Recompute body footprint from head + history. */
function pathBody(sim: Sim, tr: Train, length: number) {
  const { topo } = sim;
  const body: BodySeg[] = [];
  let remaining = length;
  const l = topo.links[tr.link];
  if (tr.dir === 1) {
    const from = Math.max(0, tr.off - remaining);
    body.push({ link: tr.link, from, to: tr.off });
    remaining -= tr.off - from;
  } else {
    const to = Math.min(l.len, tr.off + remaining);
    body.push({ link: tr.link, from: tr.off, to });
    remaining -= to - tr.off;
  }
  for (let i = tr.hist.length - 2; i >= 0 && remaining > 0.01; i--) {
    const h = tr.hist[i];
    const hl = topo.links[h.link];
    if (h.dir === 1) {
      const from = Math.max(0, hl.len - remaining);
      body.push({ link: h.link, from, to: hl.len });
      remaining -= hl.len - from;
    } else {
      const to = Math.min(hl.len, remaining);
      body.push({ link: h.link, from: 0, to });
      remaining -= to;
    }
  }
  return body;
}

export function computeBody(sim: Sim, tr: Train, remember = true) {
  const body = pathBody(sim, tr, tr.len);
  tr.body = body;
  if (remember) {
    // Keep a measured distance behind the tail, rather than one arbitrarily
    // short link. An overrun retains its entire return as it grows, including
    // returns requiring dispatch consent. Projection must not prune its copy.
    const err = stopError(sim, tr);
    const back = Math.max(5, Number.isFinite(err) ? -err : 0, tr.retreat?.distance ?? 0, tr.overrun);
    const retained = pathBody(sim, tr, tr.len + back);
    if (tr.hist.length > retained.length) tr.hist.splice(0, tr.hist.length - retained.length);
    const visited = (tr.recentBody ?? []).flatMap(b => {
      const span = retained.find(r => r.link === b.link);
      if (!span) return [];
      const from = Math.max(b.from, span.from), to = Math.min(b.to, span.to);
      return to > from ? [{ link: b.link, from, to }] : [];
    });
    for (const b of body) {
      const old = visited.find(v => v.link === b.link);
      if (old) { old.from = Math.min(old.from, b.from); old.to = Math.max(old.to, b.to); }
      else visited.push({ ...b });
    }
    tr.recentBody = visited;
  }
}

/** Change ends: head becomes the old tail. */
export function reverseTrain(sim: Sim, tr: Train) {
  const segs = tr.body.slice();
  const hist = tr.hist.slice(tr.hist.length - segs.length);
  // hist[i] corresponds to segs[segs.length-1-i]
  const tailSeg = segs[segs.length - 1];
  const tailDir = hist[0].dir;
  const newHead = tailDir === 1 ? tailSeg.from : tailSeg.to;
  const newHist: { link: number; dir: Dir }[] = [];
  for (let i = hist.length - 1; i >= 0; i--) newHist.push({ link: hist[i].link, dir: (hist[i].dir === 1 ? -1 : 1) as Dir });
  tr.link = tailSeg.link;
  tr.off = newHead;
  tr.dir = (tailDir === 1 ? -1 : 1) as Dir;
  tr.hist = newHist;
  tr.recentBody = undefined;
  computeBody(sim, tr);
}

/** Advance the head by ds metres along the current switch positions. Returns false if blocked. */
export function advance(sim: Sim, tr: Train, ds: number): boolean {
  const { topo } = sim;
  let rem = ds;
  let guard = 0;
  while (rem > 0 && guard++ < 20) {
    const l = topo.links[tr.link];
    const room = tr.dir === 1 ? l.len - tr.off : tr.off;
    if (rem <= room) {
      tr.off += tr.dir * rem;
      return true;
    }
    rem -= room;
    const nx = nextLink(topo, tr.link, tr.dir, (sw) => swPos(sim, sw));
    if (!nx) {
      tr.off = tr.dir === 1 ? l.len : 0;
      return false;
    }
    // passing a signal without authority (SPAD)?
    const sigId = topo.signalByEntry.get(nx.node * 65536 + nx.link);
    if (sigId !== undefined) {
      if (!passAuthorised(sim, tr, sigId, ds - rem)) spad(sim, tr, sigId);
    }
    tr.link = nx.link;
    tr.dir = nx.dir;
    tr.off = nx.dir === 1 ? 0 : topo.links[nx.link].len;
    tr.hist.push({ link: nx.link, dir: nx.dir });
    // The cab is now inside the signal. A pull-out may change RM to ATP
    // here, whose immediate authority scan must start from this new link.
    if (sigId !== undefined) sim.onSignalPassed(tr, sigId);
  }
  return true;
}

/**
 * May the train pass this signal? Within a valid movement authority (CBTC /
 * TBTC ATP), over the locked route the signal protects, on a guide aspect
 * in RM, or with an RM authorisation for exactly this signal. Anything else
 * is a SPAD (docs/signalling-model.md §3.4).
 */
export function passAuthorised(sim: Sim, tr: Train, sigId: number, travelled: number): boolean {
  const rm = tr.mode === 'RM';
  if (!rm && travelled <= tr.lastMa + 0.5) return true;
  if (rm && tr.rmSig === sigId && tr.rmAuth > 0) return true;
  const sg = sim.sig[sigId];
  if (sg.route < 0) return false;
  const ar = sim.routes.get(sg.route)!;
  if (ar.guide) return rm;
  if (ar.state !== 'locked') return false;
  if (ar.entered && !ar.fleeting && ar.owner !== tr.id) return false;
  if (ar.cancelAt > 0 && ar.committed !== tr.id) return false;
  return !rm || sg.aspect === 'G' || sg.aspect === 'Y' || sg.aspect === 'DARK';
}

function spad(sim: Sim, tr: Train, sigId: number) {
  const name = sim.topo.signals[sigId].name;
  tr.passedRed++;
  tr.spadSig = sigId;
  if (tr.manual) tr.drv.spad++;
  sim.metrics.safety.spad++;
  sim.log('A', '信号', `列车 ${tr.svc}-${tr.tripNo} 冒进信号 ${name}`, { key: `spad-${tr.id}`, code: 'SPAD', train: tr.id });
  applyEB(sim, tr, `冒进信号 ${name}`, 'spad');
}

/** Unbudgeted moves still share the same continuous ATO level controller. */
function runLevelAccel(sim: Sim, tr: Train, vT: number, vCruise: number, stopAt: number, regulated: boolean,
  protection: { brakeRate: number; protecting: boolean; grade: number }): number {
  const trip = sim.plan.trips[tr.tripId];
  const plannedEmpty = !tr.manual && (tr.mode === 'DTO' || tr.mode === 'AM') && trip && !trip.revenue
    && tr.tasks[0]?.k === 'stop' && sim.topo.links[tr.link].track === trip.dir;
  tr.atoMove ??= { phase: 'traction', recovered: false, neutral: 0 };
  return levelAccel(tr, regulated || plannedEmpty ? trainLevel(sim, tr) : 1, vT, vCruise, stopAt, tr.atoMove, protection);
}

/** Full swept footprint on the train's actual recent path, never a new route.
 * Check the whole return before permitting traction; repeat while reversing. */
export function reversePermission(sim: Sim, tr: Train, distance = Math.max(0, -stopError(sim, tr))) {
  if (!tr.retreat?.authorised)
    return { ok: false, detail: '等待调度同意退行', train: -1 };
  if (tr.tasks[0]?.k !== 'stop') return { ok: false, detail: '退行缺少停车对标任务', train: -1 };
  if (!Number.isFinite(distance)) return { ok: false, detail: '退行停车点不在本车已走路径内', train: -1 };
  const projected = { ...tr, hist: tr.hist.slice(), body: tr.body.slice() };
  const swept = tr.body.slice();
  let left = distance;
  // Sweep intermediate footprints as well as the endpoints on long returns.
  while (left > .001) {
    const step = Math.min(left, tr.len / 2);
    moveBack(sim, projected, step);
    swept.push(...projected.body);
    left -= step;
  }
  const endError = stopError(sim, projected);
  if (!Number.isFinite(endError) || Math.abs(endError) > 1 || projected.body.reduce((s, b) => s + b.to - b.from, 0) < tr.len - .01)
    return { ok: false, detail: '退行范围超出本车已占用路径', train: -1 };
  for (const b of swept) {
    const visited = tr.recentBody?.find(v => v.link === b.link);
    if (!visited || b.from < visited.from - .01 || b.to > visited.to + .01)
      return { ok: false, detail: '退行范围超出本车已占用路径', train: -1 };
    const section = sim.topo.links[b.link].section, sec = sim.sec[section];
    const other = trainInSection(sim, section, tr.id);
    if (other >= 0) return { ok: false, detail: `退行后方区段被列车${other}占用`, train: other };
    const route = sec.lockRoute >= 0 ? sim.routes.get(sec.lockRoute) : undefined;
    const claimant = route && [route.owner, route.arsTrain ?? -1, route.committed, route.directionTrain ?? -1]
      .find(id => id >= 0 && id !== tr.id);
    const opposing = route && route.owner < 0 && sim.topo.routes[route.route].steps.some(step =>
      swept.some(b => b.link === step.link) && tr.hist.find(h => h.link === step.link)?.dir !== step.dir);
    if (route && (claimant !== undefined || opposing))
      return { ok: false, detail: `退行后方区段锁闭给进路${route.route}`, train: claimant ?? route.owner };
    if (sec.blocked || sec.envTsr < 0 || sec.directionEsp || sec.disturbed)
      return { ok: false, detail: '退行后方区段防护/故障', train: -1 };
  }
  // Every historical link transition still has the same detected point position.
  for (let i = projected.hist.length - projected.body.length; i < tr.hist.length - 1; i++) {
    if (i < 0) continue;
    const h = tr.hist[i], next = tr.hist[i + 1];
    const actual = nextLink(sim.topo, h.link, h.dir, sw => swPos(sim, sw));
    if (!actual || actual.link !== next.link || actual.dir !== next.dir)
      return { ok: false, detail: '退行路径道岔未在原位', train: -1 };
  }
  return { ok: true, detail: '司机退行对标', train: -1 };
}

function manualReverse(sim: Sim, tr: Train, dt: number) {
  const err = stopError(sim, tr), permit = reversePermission(sim, tr);
  if (!permit.ok && tr.retreat && !tr.overrun && tr.tasks[0]?.k === 'stop')
    atoOverrun(sim, tr, tr.tasks[0], Number.isFinite(err) ? err : -tr.retreat.distance, permit.detail);
  const limit = OPERATIONS.reverseKmh / 3.6;
  tr.stopDist = Number.isFinite(err) ? Math.max(0, -err) : Infinity; tr.vPermit = permit.ok ? limit : 0; tr.vEbi = tr.vPermit;
  tr.maDist = 0; // No forward authority; lastMa below is the separately supervised return distance.
  tr.maSigs = []; tr.maFar = 0; tr.maReason = permit.detail;
  tr.maCode = permit.ok ? 'STOP_POINT' : permit.train >= 0 ? 'TRAIN_AHEAD' : 'DIRECTION_WAIT'; tr.maTrain = permit.train;
  tr.vTarget = permit.ok ? limit : 0;
  tr.vRecommended = 0;
  if (!tr.eb && (tr.v > limit + 1e-6 || err > 1)) {
    triggerEB(sim, tr, err > 1 ? '退行越过停车窗' : '退行超速防护', 'atp');
    if (tr.v > limit) { tr.drv.overspeed++; sim.metrics.safety.overspeed++; }
  }
  if (!permit.ok && tr.v > 0 && !tr.eb) triggerEB(sim, tr, permit.detail, 'atp');
  let a = tr.eb ? -PERF.bEb : jerkLimited(tr.a, notchAccel(tr.v, tr.notch), dt);
  if (!permit.ok || tr.doorsOpen || tr.doorSide || sim.t < (tr.doorLockedAt ?? 0) || tr.hold || tr.stopUntil > sim.t) a = Math.min(0, a);
  const before = tr.v;
  tr.v = Math.max(0, before + a * dt); tr.a = a;
  let ds = (before + tr.v) * dt / 2;
  const remaining = Number.isFinite(err) ? Math.max(0, 1 - err) : 0;
  if (ds > remaining) {
    if (!tr.eb) triggerEB(sim, tr, '退行越过停车窗', 'atp');
    ds = remaining; tr.v = 0; tr.a = 0;
  }
  if (!permit.ok) { ds = 0; tr.v = 0; }
  tr.lastMa = remaining; tr.lastDs = ds;
  if (ds > 0) moveBack(sim, tr, ds);
}

export function updateTrainMotion(sim: Sim, tr: Train, dt: number) {
  tr.vRecommended = undefined;
  // A withdrawn target may be inside the braking distance. The onboard keeps
  // its last issued authority while braking; after standstill it can accept
  // the shorter replacement. This is not permission to overrun an issued MA.
  if (tr.maCut && tr.v <= 0.01) tr.maCut = false;
  // a train failing on the move keeps braking under its EB until it stands
  if (tr.failed && tr.phase === 'run' && tr.v <= 0.01) tr.phase = 'failed';
  const moving = tr.phase === 'run';
  if (!moving) {
    tr.ato = undefined;
    tr.atoMove = undefined;
    tr.coast = false;
    tr.lastDs = 0;
    // standing (dwell, turnback, stabled, failed): authority, next signal and the
    // permitted speed come from the 1 Hz refresh
    tr.v = 0;
    tr.a = 0;
    tr.vTarget = 0;
    if (tr.manual && tr.mode === 'CM') tr.vRecommended = 0;
    tr.tgtV = 0;
    tr.tgtD = tr.phase === 'dwell' ? 0 : Infinity;
    tr.tgtReason = tr.phase === 'dwell' ? '停站' : '';
    return;
  }
  if (tr.manual && tr.reverser === -1) { manualReverse(sim, tr, dt); return; }
  const scan = scanAhead(sim, tr, goalBerth(tr), MA_NEAR);
  if (scan.maReason === MA_CAP_REASON && tr.maFar > scan.maDist) {
    // authority reaches beyond the near scan: last full MA, shifted by our own travel
    tr.maDist = tr.maFar;
    tr.maReason = tr.maFarReason;
    tr.maCode = tr.maFarCode;
    tr.maTrain = tr.maFarTrain;
  } else {
    tr.maDist = scan.maDist;
    tr.maReason = scan.maReason;
    tr.maCode = scan.maCode;
    tr.maTrain = scan.maTrain;
    tr.maSigs = scan.maSignals;
  }
  tr.nextSignal = scan.nextSignal;
  tr.nextSignalDist = scan.nextSignalDist;
  tr.stopDist = scan.stopDist;

  // pending driver mode change while stopped: the train stands until the onboard logic
  // has switched (or dropped) the mode — not just until the switching time is up
  if (tr.pendingMode && tr.v < 0.05) { tr.v = 0; tr.lastDs = 0; return; }
  // dispatcher / driver stop in section (e.g. passenger emergency alarm)
  const standStill = tr.stopUntil > sim.t;

  // ATO target speed, permitted speed (shown on the DMI) and the emergency brake
  // intervention speed (permitted + ATP tolerance). Permitted speed is never above
  // the line / train ceiling; the platform stopping point is an ATO target only,
  // the ATP curves end at the movement authority.
  const rm = tr.mode === 'RM';
  const regulated = !rm && !tr.manual && tr.inService && (tr.mode === 'DTO' || tr.mode === 'AM');
  const recommend = tr.manual && tr.mode === 'CM';
  const targetRegulated = regulated || recommend && tr.inService;
  // Running delay against the arrival plan: the arrival this train makes
  // from here at the current speed limit, compared with the planned arrival.
  const nextStop = tr.tasks[0];
  const budgetProfile = targetRegulated && nextStop?.k === 'stop' && nextStop.arr !== null ? regulationProfile(sim, tr) : null;
  const budgetDistance = budgetProfile?.distance ?? Infinity;
  const targetDelay = targetRegulated && nextStop?.k === 'stop' && nextStop.arr !== null && Number.isFinite(budgetDistance)
    ? sim.t + etaToStop(budgetDistance, tr.v, PERF.vMax - PERF.atoMargin, budgetProfile?.limits, PERF.atoMargin) - nextStop.arr : tr.delay;
  if (regulated) tr.delay = targetDelay;
  const atoMargin = targetRegulated && targetDelay > 2 ? PERF.atoFastMargin : PERF.atoMargin;
  const stopAt = Math.min(scan.stopDist, scan.maDist);
  // the profile (gradient.ts): gravity on the train, and the height of a point
  // ahead for the ATP curves, which brake against the grade as well (D65)
  const prof = profileOf(sim.topo);
  const sense = chainSense(sim.topo, tr.link, tr.dir);
  const head = linkChain(sim.topo, tr.link, tr.off);
  const aG = gradeAccelAt(prof, head, sense);
  const h0 = heightAt(prof, head);
  const rise = (d: number) => sense ? heightAt(prof, head + sense * d) - h0 : 0;
  // wet rail (adhesion.ts); in low-adhesion mode ATO brakes earlier and softer on the exposed section
  const adh = adhesionLimit(sim, tr);
  const lowAdh = sim.env.lowAdh && adh.exposed && (!tr.manual || recommend);
  const bPlan = lowAdh ? LOW_ADH_BPLAN : PERF.bPlan;
  let vT = scan.vBody - (rm ? 0.3 : atoMargin);
  let vPerm = scan.vBody;
  let vEbi = scan.vBody + PERF.atpTolerance;
  // most restrictive target ahead (for the DMI)
  let tgtV = scan.vBody;
  let tgtD = Infinity;
  let tgtCurve = Infinity;
  let tgtReason = '';
  const consider = (d: number, v: number, why: string) => {
    const c = brakingSpeed(d, v, PERF.bPlan);
    if (c < tgtCurve) { tgtCurve = c; tgtV = v; tgtD = Math.max(0, d); tgtReason = why; }
  };
  for (let i = 0; i < scan.constraints.length; i += 2) {
    const d = scan.constraints[i];
    const v = scan.constraints[i + 1];
    vT = Math.min(vT, atoLimitSpeed(d - 3, v - (rm ? 0.2 : atoMargin), tr.v, tr.a, bPlan));
    const dh = rise(d);
    vPerm = Math.min(vPerm, brakingSpeedH(d, v, PERF.bPermit, dh));
    vEbi = Math.min(vEbi, brakingSpeedH(d, v, PERF.bEbGuaranteed, dh) + PERF.atpTolerance);
    if (v < scan.vBody - 0.1) consider(d, v, '限速');
  }
  vT = Math.min(vT, brakingSpeed(scan.maDist - 1, 0, bPlan));
  if (scan.stopDist !== Infinity) {
    // Only the ATO station-stop shape changes. Wet-rail precautions, authority
    // and ATP curves retain their independently supervised braking rates.
    const state = tr.ato && tr.ato.berth === goalBerth(tr) ? tr.ato.state : tr.atoMove;
    const entry = state?.brakeEntrySpeed;
    const stopping = lowAdh ? brakingSpeed(scan.stopDist - .2, 0, bPlan)
      : entry !== undefined ? atoBrakeProfile(entry, scan.stopDist, state?.brakeEntryDistance, state?.brakeEntryGrade).speed
        : scan.stopDist <= atoStopApproachDistance(tr.v, tr.a, aG) ? atoBrakeProfile(tr.v, scan.stopDist, undefined, aG).speed : Infinity;
    vT = Math.min(vT, stopping);
  }
  if (!(tr.manual && rm)) {
    const dh = rise(scan.maDist);
    vPerm = Math.min(vPerm, brakingSpeedH(scan.maDist, 0, PERF.bPermit, dh));
    // the EB intervention curve ends at the EOA itself: at / past it any motion trips the EB
    vEbi = Math.min(vEbi, scan.maDist > 0 ? brakingSpeedH(scan.maDist, 0, PERF.bEbGuaranteed, dh) + 0.3 : 0);
  }
  consider(tr.maDist, 0, tr.maReason || 'MA终点');
  if (scan.stopDist !== Infinity && scan.stopDist <= scan.maDist) consider(scan.stopDist, 0, '停车点');
  // A section has one physical plan, rather than a new cruise target at every
  // 100 ms tick. Only a changed task, budget, level or driver mode replaces it.
  // No route/traffic/ATP constraint is cached in this unhindered plan.
  const level = targetRegulated ? trainLevel(sim, tr, targetDelay) : 1;
  if (targetRegulated && nextStop?.k === 'stop' && nextStop.arr !== null && Number.isFinite(budgetDistance) && budgetDistance > 0) {
    const ceiling = PERF.vMax - atoMargin;
    const old = tr.ato;
    const obstructed = tr.hold || standStill || scan.maDist < budgetDistance - 1
      && scan.maDist < tr.v * tr.v / (2 * bPlan) + 60;
    if (!old || old.berth !== nextStop.berth || old.arrival !== nextStop.arr || old.level !== level
      || old.ceiling !== ceiling || old.manual && !tr.manual || old.obstructed && !obstructed
      || Math.abs(budgetDistance - ((old?.distance ?? budgetDistance) - tr.lastDs)) > 2) {
      // Switching between the ordinary and late speed margin must not erase a
      // completed coast/recovery. A changed task or a real obstruction release
      // still starts a fresh trajectory from the train's physical state.
      const state = old && old.berth === nextStop.berth && old.arrival === nextStop.arr
        && old.manual === tr.manual && old.level === level && !old.obstructed && old.ceiling !== ceiling
        && Math.abs(budgetDistance - (old.distance - tr.lastDs)) <= 2
        ? { ...old.state } : { phase: 'traction' as const, recovered: false, neutral: 0 };
      tr.ato = { state,
        plan: sectionPlan(budgetDistance, tr.v, nextStop.arr - sim.t, ceiling, budgetProfile?.limits, atoMargin, tr.a, level),
        berth: nextStop.berth, arrival: nextStop.arr, level, ceiling, manual: tr.manual, distance: budgetDistance, obstructed };
    }
    tr.ato!.distance = budgetDistance;
    tr.ato!.obstructed = obstructed;
    tr.ato!.manual = tr.manual;
  } else tr.ato = undefined;
  vT = Math.min(vT, vPerm, tr.vCap);
  // standing a few metres short of a signal at stop: ATO does not start into
  // so short an authority (it could not ease off in time under the jerk limit)
  if (!rm && (!tr.manual || recommend) && tr.v < 0.05 && scan.maCode === 'ROUTE_WAIT' && scan.maDist < 15 && scan.stopDist > scan.maDist) vT = 0;
  if (tr.hold && tr.v < 0.1) vT = 0;
  if (standStill) vT = 0;
  vT = Math.max(0, vT);
  const recommendation = tr.ato ? Math.min(vT, sectionRecommended(tr.ato.plan, budgetDistance - Math.max(.5, tr.v * .5)))
    : levelTarget(level, vT, scan.vBody - atoMargin, tr.v);
  if (recommend) tr.vRecommended = tr.eb ? 0 : Math.max(0, recommendation);
  tr.vTarget = Math.max(0, recommendation);
  tr.vPermit = Math.max(0, vPerm);
  tr.vEbi = rm ? PERF.vRM + PERF.atpTolerance : vEbi;
  tr.tgtV = tgtV;
  tr.tgtD = tgtD;
  tr.tgtReason = tgtReason;

  // ATP supervision
  if (!tr.eb) {
    const atp = tr.mode !== 'RM';
    if (atp && tr.level === 'CBTC' && !tr.comm && tr.v > 0.1) triggerEB(sim, tr, '车地通信中断，MA失效', 'comm');
    else if (atp && tr.level === 'CBTC' && sim.zoneState[sim.topo.links[tr.link].zone] === 'ZCFAIL' && tr.v > 0.1) triggerEB(sim, tr, 'ZC故障，MA失效', 'zc');
    else if (tr.v > tr.vEbi + 0.15) {
      triggerEB(sim, tr, atp ? (scan.maDist < 30 ? `MA终点防护(${scan.maReason})` : '超速防护') : 'RM超速', atp ? (scan.maDist < 30 ? 'atp' : 'overspeed') : 'rm');
      if (tr.manual) { tr.drv.overspeed++; sim.metrics.safety.overspeed++; }
    }
  }

  // `a` is the effort of the motors and brakes; the train accelerates at a + aG.
  // The driver's notch is an effort; ATO asks for an acceleration and works
  // out the effort against the grade, within what the train has.
  let a: number;
  if (tr.eb) {
    // released only by onboard.ts after the dispatcher's authorisation
    a = -PERF.bEb;
    if (tr.v <= 0.01) tr.v = 0;
  } else if (tr.manual) {
    a = notchAccel(tr.v, tr.notch);
    // door-closed loop: no traction with any door open
    if (manualTractionHold(sim, tr) && a > 0) a = 0;
    trackApproach(tr);
  } else {
    let c: number;
    if (tr.ato) {
      c = atoControl(tr.ato.state, { v: tr.v, a: tr.a, target: vT, cruise: tr.ato.plan.cutoff,
        stopDist: stopAt, remaining: budgetDistance, plan: tr.ato.plan, dt, grade: aG, brakeRate: bPlan,
        protecting: tr.ato.obstructed || tr.v >= vPerm - .1 });
      tr.coast = tr.ato.state.phase === 'coast';
    } else c = runLevelAccel(sim, tr, vT, scan.vBody - atoMargin, stopAt, regulated,
      { brakeRate: bPlan, grade: aG, protecting: tr.v >= vPerm - .1
        || scan.maDist < scan.stopDist - 1 && scan.maDist < tr.v * tr.v / (2 * bPlan) + 60 });
    // slid past the stopping point on wet rail: brake to a stand (ats.ts then decides)
    if (adh.brake < Infinity && tr.v > 0 && tr.tasks[0]?.k === 'stop' && stopError(sim, tr) < -0.3) c = -PERF.bService;
    // in traction a falling grade is a bonus, not something to brake off
    // (coasting is motors off: gravity is left to act)
    a = tr.coast && c === -PERF.resist ? c : c > 0 ? Math.max(c - aG, c) : c - aG;
    // standing with nothing asked for: the brakes hold it against the grade
    if (tr.v === 0 && vT <= 0.01) a = 0;
    a = Math.max(-PERF.bService, Math.min(atoTractionAccel(tr.v) * (lowAdh ? LOW_ADH_TRACTION : 1), a));
  }
  // inverters cut out (vehicle.ts): less traction, braking blended out by the friction brake
  if (tr.tractionCut > 0 && a > 0) a = Math.min(a, tractionAccel(tr.v) * (1 - tr.tractionCut / TRACTION_UNITS));
  // traction and service braking build up and ease off at the jerk limit; the EB does not
  if (!tr.eb) a = jerkLimited(tr.a, a, dt);
  // no more than the wheels can transmit: anti-slip in traction, WSP in braking;
  // the emergency brake sands the rail and is not limited
  tr.slip = '';
  if (!tr.eb && a > adh.trac) { a = adh.trac; tr.slip = 'slip'; }
  else if (!tr.eb && a < -adh.brake) { a = -adh.brake; tr.slip = 'slide'; }
  tr.a = a;
  const v0 = tr.v;
  // at a stand the holding brake keeps it there until traction beats the grade (no roll-back)
  const net = v0 === 0 && a <= Math.max(0, -aG) ? 0 : a + aG;
  tr.v = Math.max(0, tr.v + net * dt);
  let ds = ((v0 + tr.v) / 2) * dt;
  if (tr.manual) {
    // the driver controls the stop; only physical obstacles stop the train regardless
    const hard = Math.max(0, scan.hardDist + 0.3);
    if (ds > hard) {
      // coupling up to a failed train: contact at no more than 3 km/h
      const coupling = scan.hardCode === 'RESCUE';
      if (tr.v > (coupling ? PERF.vCouple : 0.5)) {
        sim.metrics.safety.rmNearMiss++;
        sim.log('B', '列车', coupling
          ? `列车 ${tr.svc}-${tr.tripNo} 救援连挂速度 ${(tr.v * 3.6).toFixed(1)} km/h，超过 3 km/h`
          : `列车 ${tr.svc}-${tr.tripNo} 人工驾驶未能在障碍物前停车（${scan.maReason}），紧急停车`);
      }
      ds = hard;
      tr.v = 0;
    }
  } else {
    // never pass the stopping point / MA end
    // (a sliding train can go past it)
    const hard = tr.eb || tr.slip === 'slide' ? Infinity : Math.max(0, stopAt + 0.3);
    if (ds > hard) { ds = hard; tr.v = Math.min(tr.v, 0.3); }
    if (stopAt < 0.4 && tr.v < 0.35 && !tr.eb) tr.v = 0;
  }
  // at a stand the brakes hold it: nothing left to ease off, traction builds up from
  // nothing (on a rising grade it keeps building until it lifts the train)
  if (tr.v === 0 && tr.a <= 0) tr.a = 0;
  // Distinguish the new restrictive braking target from the authority already
  // issued. Do not replace an issued EOA with an unreachable one under a train.
  const prevEoa = tr.lastMa - tr.lastDs;
  if (!rm && tr.v > .01 && !tr.maCut && Number.isFinite(prevEoa) && scan.maDist < prevEoa - 0.5 && !canAcceptRestriction(v0, scan.maDist)) {
    tr.maCut = true;
    if (!tr.eb) triggerEB(sim, tr, `移动授权回撤(${scan.maReason})`, 'atp');
    sim.log('B', '信号', `列车 ${tr.svc}-${tr.tripNo} 移动授权被回撤（${scan.maReason}），紧急制动`, { key: `macut-${tr.id}`, code: scan.maCode, train: tr.id });
  }
  // Accept the restrictive replacement in this braking step as soon as the
  // train reaches standstill, rather than retaining a released route for
  // one more step until the next call's standstill check.
  if (tr.maCut && tr.v <= .01) tr.maCut = false;
  const issued = !rm && tr.maCut && tr.eb ? Math.max(0, prevEoa) : scan.maDist;
  if (!rm && tr.maCut && tr.eb) tr.maDist = issued;
  tr.lastDs = ds;
  tr.lastMa = tr.manual && rm ? Infinity : issued;
  if (ds > 0) {
    const ok = advance(sim, tr, ds);
    tr.maFar -= ds;
    if (tr.rmAuth > 0) tr.rmAuth = Math.max(0, tr.rmAuth - ds);
    if (!ok) {
      if (tr.manual && tr.v > 0.5) {
        sim.metrics.safety.rmNearMiss++;
        sim.log('A', '列车', `列车 ${tr.svc}-${tr.tripNo} 人工驾驶冒进至线路终端/道岔，紧急停车`);
      }
      tr.v = 0;
    }
  }
  computeBody(sim, tr);
}

/** One predicate for traction inhibition and the driver's standstill reason. */
export function manualTractionHold(sim: Sim, tr: Train): string {
  if (tr.pendingMode && tr.v < .05) return '等待驾驶模式转换';
  if (tr.stopUntil > sim.t) return tr.stopReason || '等待区间停车解除';
  if (tr.doorsOpen || tr.doorSide) return '等待车门关闭';
  if (sim.t < (tr.doorLockedAt ?? 0)) return '等待车门锁闭';
  if (tr.reverser === 0) return '换向器在零位';
  if (tr.retreat) {
    const permit = reversePermission(sim, tr);
    return permit.ok ? '过标停车，换向器打后退行对标' : permit.detail;
  }
  return '';
}

/** 一把闸: brake releases while moving in the last 200 m before a manual station stop */
function trackApproach(tr: Train) {
  const d = tr.drv;
  if (!(tr.stopDist < 200) || tr.tasks[0]?.k !== 'stop') return;
  if (tr.notch < 0 && tr.notch > -8) d.braking = true;
  else if (d.braking && tr.notch >= 0 && tr.v > 0.3) { d.releases++; d.braking = false; }
}

/** a route the MA relied on was released: recompute the train's authority now */
export function withdrawAuthority(sim: Sim, tr: Train) {
  const s = scanAhead(sim, tr, goalBerth(tr));
  tr.maFar = s.maDist;
  tr.maFarReason = s.maReason;
  tr.maFarCode = s.maCode;
  tr.maFarTrain = s.maTrain;
  tr.maSigs = s.maSignals;
  // A mode change can arrive between motion ticks. Refresh the protection
  // speeds along with its new authority, rather than retaining the speed
  // limit of the previous position/mode until the next motion calculation.
  tr.vPermit = tr.mode === 'RM' ? s.vBody : Math.max(0, Math.min(s.vBody, brakingSpeed(s.maDist,0,PERF.bPermit)));
  tr.vEbi = (tr.mode === 'RM' ? s.vBody : Math.max(0, Math.min(s.vBody, brakingSpeed(s.maDist,0,PERF.bEbGuaranteed)))) + PERF.atpTolerance;
  if (s.maDist < tr.maDist) {
    tr.maDist = s.maDist;
    tr.maReason = s.maReason;
    tr.maCode = s.maCode;
    tr.maTrain = s.maTrain;
  }
}

/** once a second: full-length movement authority for every train (see MA_NEAR) */
export function refreshAuthority(sim: Sim) {
  for (const tr of sim.trainList) {
    const s = scanAhead(sim, tr, goalBerth(tr));
    tr.maFar = s.maDist;
    tr.maFarReason = s.maReason;
    tr.maFarCode = s.maCode;
    tr.maFarTrain = s.maTrain;
    tr.maSigs = s.maSignals;
    const moving = tr.phase === 'run';
    // a moving train keeps this step's near scan; only the far end is taken over
    if (moving && tr.maReason !== MA_CAP_REASON) continue;
    tr.maDist = s.maDist;
    tr.maReason = s.maReason;
    tr.maCode = s.maCode;
    tr.maTrain = s.maTrain;
    if (moving) continue;
    tr.nextSignal = s.nextSignal;
    tr.nextSignalDist = s.nextSignalDist;
    tr.stopDist = s.stopDist;
    // standing: the permitted speed still follows the current movement authority
    tr.vPermit = tr.mode === 'RM' ? s.vBody : Math.max(0, Math.min(s.vBody, brakingSpeed(s.maDist, 0, PERF.bPermit)));
    tr.vEbi = (tr.mode === 'RM' ? s.vBody : Math.max(0, Math.min(s.vBody, brakingSpeed(s.maDist, 0, PERF.bEbGuaranteed)))) + PERF.atpTolerance;
  }
}

export function triggerEB(sim: Sim, tr: Train, reason: string, cause: EbCause) {
  applyEB(sim, tr, reason, cause);
}

/** Rebuild link → body segment index for scans. */
export function indexBodies(sim: Sim) {
  sim.linkBodies.clear();
  for (const tr of sim.trainList) {
    for (const b of tr.body) {
      let arr = sim.linkBodies.get(b.link);
      if (!arr) { arr = []; sim.linkBodies.set(b.link, arr); }
      arr.push({ train: tr.id, from: b.from, to: b.to });
    }
  }
}

/** Unhindered time (s) to stop `dist` metres ahead from speed `v`, cruising
 * at `cruise` with nominal traction and service braking. */
export const etaToStop = sectionEta;
