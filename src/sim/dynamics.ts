/**
 * Train performance model (8-car A-type, approximations) and the planning
 * run-time calculator. The same controller drives simulated trains and the
 * run-time pre-computation, so planned times are achievable in the sim.
 */
import type { Topology } from './topology';
import { OPERATIONS } from '../data/line2';
import { profileOf, heightAt, gradeAccelAt, brakingSpeedH, type Profile } from './gradient';

export const PERF = {
  /** max traction acceleration at low speed (m/s²) */
  aMax: 1.0,
  /** longitudinal jerk limit in traction and service braking; not under EB (m/s³, GB/T 7928 6.13) */
  jerk: 0.75,
  /** max service brake (m/s²) */
  bService: 1.0,
  /** braking rate used by ATO planning (comfort) */
  bPlan: 0.75,
  /** guaranteed emergency brake used by ATP curves */
  bEbGuaranteed: 0.95,
  /** the permitted-speed curve shown to the driver (overspeed warning): below
   *  the EB intervention curve so that a driver following it with the service
   *  brake has room before the EB 【假设】 */
  bPermit: 0.8,
  /** actual emergency brake */
  bEb: 1.25,
  /** line / train ceiling: 02A05 design speed and the Line 2 line speed (80 km/h) */
  vMax: 80 / 3.6,
  /** RM speed ceiling (25 km/h) */
  vRM: 25 / 3.6,
  /** coupling approach speed */
  vCouple: 3 / 3.6,
  /** ATO margin below permitted speed (m/s) */
  atoMargin: 3 / 3.6,
  /** Highest ATO performance margin, also used for minimum planning runs. */
  atoFastMargin: .25,
  /** ATP overspeed tolerance before EB (m/s) */
  atpTolerance: 5 / 3.6,
  /** running resistance when coasting */
  resist: 0.03,
};

/**
 * Traction force against speed, as a fraction of the starting force: the AW2
 * curve of the Line 2 study (560 kN flat to 40 km/h, 420 at 50, 180 at 80;
 * reference/…Rolling_Stock_Research.md 图3(b), read off the figure), normalised.
 * Beyond 80 km/h it falls as constant power. Points are (m/s, fraction).
 */
const TRACTION: [number, number][] = [[0, 1], [40 / 3.6, 1], [50 / 3.6, 420 / 560], [80 / 3.6, 180 / 560]];

export function tractionAccel(v: number): number {
  const last = TRACTION[TRACTION.length - 1];
  if (v >= last[0]) return PERF.aMax * last[1] * last[0] / Math.max(v, last[0]);
  let i = 1;
  while (TRACTION[i][0] < v) i++;
  const [v0, f0] = TRACTION[i - 1], [v1, f1] = TRACTION[i];
  return PERF.aMax * (f0 + (f1 - f0) * (v - v0) / (v1 - v0));
}

/** the acceleration actually reached one step on from `prev` towards `cmd` under the jerk limit */
export function jerkLimited(prev: number, cmd: number, dt: number): number {
  const s = PERF.jerk * dt;
  return Math.max(prev - s, Math.min(prev + s, cmd));
}

/** the speed a train will have reached once its traction has been shed at the
 * jerk limit: the controller looks at this, not the present speed, so that it
 * starts easing off early enough not to overshoot a target. */
export function speedAfterEasing(v: number, a: number): number {
  return a > 0 ? v + (a * a) / (2 * PERF.jerk) : v;
}

/** Speed allowed at the current point given a constraint `d` metres ahead with end speed vEnd. */
export function brakingSpeed(d: number, vEnd: number, b: number): number {
  if (d <= 0) return vEnd;
  return Math.sqrt(vEnd * vEnd + 2 * b * d);
}

/** ATO / driver controller: returns commanded acceleration. */
export function controlAccel(v: number, vTarget: number, stopDist: number): number {
  // precision stop: follow the braking parabola to the stopping point
  if (stopDist < 60 && stopDist >= 0) {
    const need = (v * v) / (2 * Math.max(0.05, stopDist));
    if (need > PERF.bPlan * 0.92) return -Math.min(PERF.bService, need);
  }
  const err = vTarget - v;
  if (err > 0.25) return Math.min(tractionAccel(v), err * 1.2 + 0.15);
  if (err < -0.05) return -Math.min(PERF.bService, Math.max(0.15, -err * 1.6));
  return v > 0.1 ? -PERF.resist : 0;
}

/** Coasting band and cruise reduction (m/s); levels 1/2 retain D67 values.
 * 【假设】D121 recalibrates slow grades after removing the platform stop cap,
 * preserving their previous whole-line diagram running times with one margin. */
export function levelBand(level: number): { band: number; lower: number } {
  if (level === 4) return { band: 10 / 3.6, lower: 9.5 / 3.6 }; // diagram-only night level (D74, D121)
  if (level >= 3) return { band: 10 / 3.6, lower: 6.5 / 3.6 };
  if (level === 2) return { band: 5 / 3.6, lower: 0 };
  return { band: 0, lower: 0 };
}

/** Shared ATO level controller for diagram calculation and live motion.
 * Above any braking target coasting stops; no braking curve is changed. */
export function levelAccel(state: { v: number; a: number; coast: boolean }, level: number, vT: number, vCruise: number, stopAt: number): number {
  if (level === 1 || state.v < 5) {
    state.coast = false;
    return controlAccel(speedAfterEasing(state.v, state.a), vT, stopAt);
  }
  const { band } = levelBand(level);
  const vc = levelTarget(level, vT, vCruise);
  if (state.coast && state.v < vc - band) state.coast = false;
  else if (!state.coast && state.v >= vc - 0.3) state.coast = true;
  if (state.coast && state.v <= vc) return -PERF.resist;
  return controlAccel(speedAfterEasing(state.v, state.a), vc, stopAt);
}

/** The same cruise reduction for traction control and the CM recommendation. */
export function levelTarget(level: number, target: number, cruise: number, speed = Infinity): number {
  return level > 1 && speed >= 5 && target >= cruise - .1 ? target - levelBand(level).lower : target;
}

// ---------------------------------------------------------------- planning run times

export interface RunTimes {
  /** stop-to-stop run time from station i to i+1 eastbound (DN) */
  dn: number[];
  /** stop-to-stop run time from station i+1 to i westbound (UP) */
  up: number[];
  /** pass-through times between station centres (non-stopping runs) */
  passDn: number[];
  passUp: number[];
  /** Calibrated ATO interval tables; level 1 remains the top-level legacy table. */
  byLevel?: Record<number, Omit<RunTimes, 'byLevel'>>;
  /** the same for a train in passenger service, which passes platforms at
   *  OPERATIONS.platformPassKmh at most (跨站/跳停) */
}

interface LimitSeg { from: number; to: number; v: number }

/** Static limit source shared by diagram profiles and task-path regulation. */
export function staticLinkLimit(topo: Topology, link: number, platformKmh = Infinity): number {
  const l = topo.links[link];
  return Math.min(l.limit, l.platform >= 0 ? platformKmh : Infinity) / 3.6;
}

/** A stopping/origin platform keeps its stop limit; other platforms are passed. */
export function taskPlatformLimit(topo: Topology, platform: number, originStation: number, goalPlatform: number): number {
  return platform < 0 ? Infinity : platform !== goalPlatform && topo.platforms[platform].station !== originStation
    ? OPERATIONS.platformPassKmh / 3.6 : OPERATIONS.platformStopKmh / 3.6;
}

function trackProfile(topo: Topology, track: 'DN' | 'UP', platformKmh = Infinity): LimitSeg[] {
  return topo.links
    .filter((l) => l.track === track)
    .map((l) => ({ from: Math.min(l.chainA, l.chainB), to: Math.max(l.chainA, l.chainB), v: staticLinkLimit(topo, l.id, platformKmh) }))
    .sort((a, b) => a.from - b.from);
}

/** limit (m/s) at chainage */
function limitAt(prof: LimitSeg[], ch: number): number {
  let lo = 0;
  let hi = prof.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (prof[m].from <= ch) lo = m; else hi = m - 1;
  }
  return prof[lo].v;
}

/**
 * Simulate a run along a main track in direction sgn from chainage `start`
 * (standstill) to `end` (standstill if stopAtEnd). Returns elapsed seconds.
 * `marks` are chainages where the pass time is recorded.
 */
function simulateRun(prof: LimitSeg[], hp: Profile, sgn: 1 | -1, start: number, end: number, trainLen: number, stopAtEnd: boolean, marks: number[] = [], runLevel = 1): { t: number; markTimes: number[] } {
  const dt = 0.1;
  let x = start;
  let v = 0;
  let a = 0;
  let t = 0;
  const controller = { v: 0, a: 0, coast: false };
  const markTimes: number[] = marks.map(() => NaN);
  const totalDist = Math.abs(end - start);
  // A whole-line pass at a slow level can legitimately take over an hour.
  // Keep the level-1 bound unchanged; do not turn uncaptured marks into 20 s.
  const timeLimit = runLevel === 1 ? 3600 : Math.max(3600, totalDist / 5 + 120);
  let travelled = 0;
  while (travelled < totalDist - 0.05 || (stopAtEnd && v > 0.01)) {
    // current limit: min over body
    let vLim = Infinity;
    for (let k = 0; k <= trainLen; k += 25) vLim = Math.min(vLim, limitAt(prof, x - sgn * k));
    vLim = Math.min(vLim, limitAt(prof, x - sgn * trainLen));
    // look ahead up to 600 m for lower limits
    let vT = vLim - PERF.atoFastMargin;
    const h0 = heightAt(hp, x);
    for (let d = 10; d <= 600; d += 10) {
      const lim = limitAt(prof, x + sgn * d);
      vT = Math.min(vT, brakingSpeed(d - 5, lim - PERF.atoFastMargin, PERF.bPlan));
      // the permitted-speed curve, which brakes against the grade (movement.ts)
      vT = Math.min(vT, brakingSpeedH(d, lim, PERF.bPermit, heightAt(hp, x + sgn * d) - h0));
    }
    const remaining = totalDist - travelled;
    let stopDist = Infinity;
    if (stopAtEnd) {
      stopDist = remaining;
      vT = Math.min(vT, brakingSpeed(remaining - 0.3, 0, PERF.bPlan));
    }
    // effort against the grade, as in movement.ts
    const aG = gradeAccelAt(hp, x, sgn, trainLen);
    controller.v = v; controller.a = a;
    const c = levelAccel(controller, runLevel, Math.max(0, vT), vLim - PERF.atoFastMargin, stopDist);
    const want = controller.coast && c === -PERF.resist ? c : c > 0 ? Math.max(c - aG, c) : c - aG;
    a = jerkLimited(a, Math.max(-PERF.bService, Math.min(tractionAccel(v), want)), dt);
    const net = v === 0 && a <= Math.max(0, -aG) ? 0 : a + aG;
    v = Math.max(0, v + net * dt);
    const ds = v * dt;
    travelled += ds;
    x += sgn * ds;
    t += dt;
    for (let i = 0; i < marks.length; i++) {
      if (Number.isNaN(markTimes[i]) && (sgn > 0 ? x >= marks[i] : x <= marks[i])) markTimes[i] = t;
    }
    if (stopAtEnd && remaining < 0.5 && v < 0.5) break;
    if (t > timeLimit) break;
  }
  return { t, markTimes };
}

/** stopping runs enter and leave the platforms at no more than `stopPlatformKmh` */
export function computeRunTimes(topo: Topology, trainLen: number, stopPlatformKmh = OPERATIONS.platformStopKmh, runLevel = 1, minimum = false): RunTimes {
  const ch = topo.stations.map((s) => s.chain);
  const n = ch.length;
  const half = trainLen / 2;
  const hp = profileOf(topo);
  const profDn = trackProfile(topo, 'DN', stopPlatformKmh);
  const profUp = trackProfile(topo, 'UP', stopPlatformKmh);
  const dn: number[] = [];
  const up: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    dn.push(simulateRun(profDn, hp, 1, ch[i] + half, ch[i + 1] + half, trainLen, true, [], runLevel).t);
    up.push(simulateRun(profUp, hp, -1, ch[i + 1] - half, ch[i] - half, trainLen, true, [], runLevel).t);
  }
  const pass = (pDn: LimitSeg[], pUp: LimitSeg[]) => {
    const passD = simulateRun(pDn, hp, 1, ch[0], ch[n - 1], trainLen, false, ch, runLevel).markTimes;
    const passU = simulateRun(pUp, hp, -1, ch[n - 1], ch[0], trainLen, false, [...ch].reverse(), runLevel).markTimes.reverse();
    const passDn: number[] = [];
    const passUp: number[] = [];
    for (let i = 0; i + 1 < n; i++) {
      passDn.push(Math.max(20, (passD[i + 1] || 0) - (passD[i] || 0)));
      passUp.push(Math.max(20, (passU[i] || 0) - (passU[i + 1] || 0)));
    }
    return [passDn, passUp];
  };
  // a train not stopping passes every platform at the platform pass limit
  // (PSD glass vs. the pressure wave), loaded or empty
  const k = OPERATIONS.platformPassKmh;
  const [passDn, passUp] = pass(trackProfile(topo, 'DN', k), trackProfile(topo, 'UP', k));
  // planning margin over the minimum ATO run (OPERATIONS.runMargin)
  const pad = (a: number[], margin: number) => a.map(t => minimum ? t : Math.floor(t * (1 + margin) * 10) / 10);
  const result: RunTimes = { dn: pad(dn, OPERATIONS.runMargin), up: pad(up, OPERATIONS.runMargin),
    passDn: pad(passDn, OPERATIONS.passRunMargin), passUp: pad(passUp, OPERATIONS.passRunMargin) };
  if (runLevel === 1) result.byLevel = Object.fromEntries([2, 3, 4].map(level => [level, computeRunTimes(topo, trainLen, stopPlatformKmh, level, minimum)]));
  return result;
}

/** Unhindered section ETA, including acceleration/braking rather than a fixed reserve.
 * 【假设】80% nominal acceleration/braking retains the existing ATS estimate. */
export interface SectionLimit { length: number; limit: number }

export function sectionEta(dist: number, v: number, cruise: number, limits?: readonly SectionLimit[], margin = 0): number {
  if (limits?.length) return profileEta(dist, v, cruise, limits, margin);
  const a = PERF.aMax * .8, b = PERF.bService * .8;
  if (dist <= 0) return 0;
  // A lower target needs deceleration first. Using max(cruise,v) here would
  // make every target below current speed have the same ETA.
  if (cruise < v) return v / b + Math.max(0, dist - v * v / (2 * b)) / Math.max(.1, cruise);
  const vc = Math.max(cruise, v);
  const da = (vc * vc - v * v) / (2 * a), db = vc * vc / (2 * b);
  if (da + db <= dist) return (vc - v) / a + vc / b + (dist - da - db) / vc;
  const vp = Math.sqrt(Math.max(v * v, (dist + v * v / (2 * a)) / (1 / (2 * a) + 1 / (2 * b))));
  return (vp - v) / a + vp / b;
}

/** Trapezoidal integration with the same 80% acceleration/service braking as
 * sectionEta. The backward pass anticipates future lower limits and the final
 * stop; the forward pass carries speed across boundaries without extra stops.
 * Limits already include the distance until the whole body clears each link. */
function profileEta(dist: number, v: number, cruise: number, limits: readonly SectionLimit[], margin: number): number {
  if (dist <= 0) return 0;
  const caps = limits.map(s => Math.min(cruise, Math.max(.1, s.limit - margin)));
  if (caps.every(c => c === caps[0])) return sectionEta(dist, v, caps[0]);
  const a = PERF.aMax * .8, b = PERF.bService * .8;
  const boundary = new Float64Array(limits.length + 1);
  for (let i = limits.length - 1; i >= 0; i--)
    boundary[i] = Math.min(caps[i], i ? caps[i - 1] : Infinity,
      Math.sqrt(boundary[i + 1] ** 2 + 2 * b * limits[i].length));
  let elapsed = 0;
  for (let i = 0; i < limits.length; i++) {
    const d = limits[i].length, cap = caps[i];
    const end = Math.max(Math.sqrt(Math.max(0, v * v - 2 * b * d)),
      Math.min(boundary[i + 1], Math.sqrt(v * v + 2 * a * d)));
    if (v > cap) {
      elapsed += (v - end) / b + Math.max(0, d - (v * v - end * end) / (2 * b)) / cap;
    } else {
      const peak = Math.min(cap, Math.sqrt((2 * a * b * d + b * v * v + a * end * end) / (a + b)));
      const accelerating = Math.max(0, (peak * peak - v * v) / (2 * a));
      const braking = Math.max(0, (peak * peak - end * end) / (2 * b));
      elapsed += Math.max(0, peak - v) / a + Math.max(0, peak - end) / b
        + Math.max(0, d - accelerating - braking) / Math.max(.1, peak);
    }
    v = end;
  }
  return elapsed + v / b;
}

/** ATS consumes the actual diagram section budget. No added station dwell.
 * Bisection finds the cruise speed whose ETA matches time left; ATP, route,
 * weather, running level and braking curves can still require a lower speed. */
export function sectionCruise(dist: number, v: number, budget: number, ceiling: number, limits?: readonly SectionLimit[], margin = 0): number {
  if (!Number.isFinite(dist) || budget <= 0 || sectionEta(dist, v, ceiling, limits, margin) >= budget) return ceiling;
  // Near the stopping point the precision controller must keep its own curve.
  const brakeDistance = v * v / (2 * PERF.bPlan);
  if (dist <= brakeDistance + 1) return ceiling;
  let lo = Math.min(ceiling, OPERATIONS.sectionCruiseMinKmh / 3.6), hi = ceiling;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (sectionEta(dist, v, mid, limits, margin) > budget) lo = mid; else hi = mid;
  }
  return hi;
}
