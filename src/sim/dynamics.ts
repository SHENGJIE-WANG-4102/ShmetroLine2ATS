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
  /** 【假设】2025-08-04 改造后 02113 两段录音；低速拟合
   * 0.893/0.804，均值 0.8485，0.85 为折中【假设】。 */
  atoAccelMax: 0.85,
  /** 【假设】Comfort thresholds, pending comparison with the measured coast. */
  atoSpeedHysteresis: 3 / 3.6,
  atoNeutralS: .5,
  /** 【假设】Each brake ramp occupies 10% of braking time. The recording
   * supports a gentle ~2 s build-up, but its weak low-frequency tail cannot
   * establish the release fraction. Symmetry preserves bPlan and distance. */
  atoBrakeRampFraction: .1,
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

/** Automatic effort only: the manual master controller retains full traction. */
export const atoTractionAccel = (v: number): number => Math.min(PERF.atoAccelMax, tractionAccel(v));

export type AtoPhase = 'traction' | 'hold' | 'coast' | 'brake';
export interface AtoState {
  phase: AtoPhase; recovered: boolean; neutral: number; plannedCoast?: boolean;
  brakeEntrySpeed?: number; brakeEntryDistance?: number; brakeEntryGrade?: number;
  /** Last distance during terminal preparation; an authority moving farther
   * away releases the latch, but shedding our own traction cannot release it. */
  terminalApproachDistance?: number;
}
export interface SectionPlan {
  cutoff: number;
  /** Begin coasting at this remaining distance; negative means no planned coast. */
  coastAt: number;
  coastFloor: number;
  eta: number;
  samples: { remaining: number; speed: number }[];
  coastValid?: boolean;
  completed?: boolean;
}
export interface AtoInput {
  v: number; a: number; target: number; cruise: number; stopDist: number;
  remaining: number; plan?: SectionPlan; grade?: number; dt?: number; protecting?: boolean; brakeRate?: number;
}

/** Symmetric brake effort: linear build-up, constant middle, linear release.
 * Its feasible average is bPlan and its distance vEntry²/(2*bPlan), while the
 * low-speed tail follows v ∝ remainingDistance^(2/3). ATP is independent. */
function brakeShape(entrySpeed:number,grade=0):{r:number;average:number}{
  const ratio=PERF.bPlan**2/(PERF.jerk*Math.max(.001,entrySpeed));
  const netBrake=Math.max(0,PERF.bService-grade);
  const required=ratio<=.25?(1-Math.sqrt(1-4*ratio))/2:Infinity;
  const serviceRamp=netBrake>0?Math.min(.5,1-PERF.bPlan/netBrake):-Infinity;
  // Preserve bPlan whenever some ramp can satisfy both jerk and brake force.
  // The measured/assumed ramp fraction is only clipped by physical bounds.
  if(required<=serviceRamp){
    const r=Math.max(required,Math.min(PERF.atoBrakeRampFraction,serviceRamp));
    return{r,average:PERF.bPlan};
  }
  // Otherwise the maximal feasible average is at the intersection of the
  // jerk and force bounds: J*v*r*(1-r) = netBrake²*(1-r)².
  const optimum=netBrake*netBrake/(PERF.jerk*Math.max(.001,entrySpeed)+netBrake*netBrake);
  const r=Math.max(Number.EPSILON,Math.min(.5,optimum));
  return{r,average:Math.min(PERF.bPlan,Math.sqrt(PERF.jerk*entrySpeed*r*(1-r)),netBrake*(1-r))};
}

export function atoBrakeDistance(entrySpeed:number,grade=0):number{
  if(entrySpeed<=0)return 0;
  return entrySpeed*entrySpeed/(2*brakeShape(entrySpeed,grade).average);
}

export function atoBrakeProfile(entrySpeed: number, remaining: number, entryDistance?:number,grade=0): { speed: number; decel: number } {
  entryDistance??=atoBrakeDistance(entrySpeed,grade);
  if(entrySpeed<=0||entryDistance<=0||remaining<=0)return{speed:0,decel:0};
  if(remaining>=entryDistance)return{speed:entrySpeed,decel:0};
  const {r}=brakeShape(entrySpeed,grade),k=1/(1-r);
  const wanted=remaining/(2*entryDistance);
  let q:number;
  if(wanted>=.5-r+k*r*r/6){
    q=.5-wanted;
    for(let i=0;i<4;i++)q-=(.5-q+k*q*q*q/(6*r)-wanted)/(-1+k*q*q/(2*r));
  }else if(wanted<=k*r*r/6)q=1-Math.cbrt(wanted*6*r/k);
  else{
    const coefficient=-1-k*r/2,constant=.5+k*r*r/6-wanted;
    q=(-coefficient-Math.sqrt(Math.max(0,coefficient*coefficient-2*k*constant)))/k;
  }
  const fraction=q<r?1-k*q*q/(2*r):q<=1-r?1-k*(q-r/2):k*(1-q)**2/(2*r);
  const ramp=q<r?q/r:q<=1-r?1:(1-q)/r;
  return{speed:entrySpeed*fraction,decel:entrySpeed*entrySpeed/(2*entryDistance)*k*ramp};
}

function terminalBrakeRequest(state:AtoState,v:number,stopDist:number,brakeRate:number):number{
  if(brakeRate<PERF.bPlan)return -Math.min(PERF.bService,Math.max(.08,v*v/(2*Math.max(.05,stopDist))));
  const entry=state.brakeEntrySpeed??v;
  const shaped=atoBrakeProfile(entry,stopDist,state.brakeEntryDistance,state.brakeEntryGrade);
  const request=shaped.decel+(v-shaped.speed)*.8;
  // Precision stopping remains an explicit exception to comfort shaping.
  return -Math.min(PERF.bService,Math.max(0,request,stopDist<.5?v*v/(2*Math.max(.05,stopDist)):0));
}

/** Stateful section control, also used to integrate the budget's reference run.
 * `target` retains authority/line/weather protection; no operational rule is
 * allowed to hold another train's route or weaken its braking curve. */
export function atoControl(state: AtoState, input: AtoInput): number {
  const { v, a, stopDist, remaining, plan } = input;
  const dt = input.dt ?? .1;
  const brakeRate=input.brakeRate??PERF.bPlan;
  const cutoff = Math.min(input.cruise, plan?.cutoff ?? input.cruise);
  const target = Math.min(input.target,cutoff);
  if(state.terminalApproachDistance!==undefined){
    if(!Number.isFinite(stopDist)||stopDist>state.terminalApproachDistance+.3){
      state.terminalApproachDistance=undefined;
      state.brakeEntrySpeed=undefined;state.brakeEntryDistance=undefined;state.brakeEntryGrade=undefined;
      state.phase='coast';state.neutral=0;state.plannedCoast=false;
    }else state.terminalApproachDistance=stopDist;
  }
  const terminal = state.phase==='brake' && state.brakeEntrySpeed!==undefined
    || state.terminalApproachDistance!==undefined
    || Number.isFinite(stopDist) && stopDist <= atoStopApproachDistance(v,a,input.grade);
  const needsBrake = target < v - .2 || terminal && v > .1;
  if (v < .05 && target > .1) {
    state.phase = 'traction'; state.neutral = 0;
    state.brakeEntrySpeed=undefined;state.brakeEntryDistance=undefined;state.brakeEntryGrade=undefined;
    state.terminalApproachDistance=undefined;
  }
  if (input.protecting && target < v - .2) {
    if(terminal&&v>.1){
      state.terminalApproachDistance=stopDist;state.phase='brake';
      if(state.brakeEntrySpeed===undefined){state.brakeEntrySpeed=v;state.brakeEntryGrade=input.grade??0;state.brakeEntryDistance=atoBrakeDistance(v,state.brakeEntryGrade);}
    }
    const protective=-Math.min(PERF.bService,Math.max(.15,(v-target)*1.6));
    // Protection can demand more braking, but cannot release service effort
    // that this train's already-latched stop shape still needs.
    const normal=state.brakeEntrySpeed!==undefined?terminalBrakeRequest(state,v,stopDist,brakeRate)
      :state.phase==='brake'?-Math.min(PERF.bService,Math.max(brakeRate,(v-target)*1.6)):0;
    return Math.min(protective,normal);
  }
  if (needsBrake) {
    if(terminal)state.terminalApproachDistance=stopDist;
    // Planned runs release traction before braking. Restrictive authority and
    // precision stopping must never wait for a comfort transition.
    if (state.phase === 'traction' || state.phase === 'hold') {
      state.phase = 'coast'; state.neutral = 0; state.plannedCoast=false;
    }
    if (input.protecting || stopDist < 60 || state.neutral >= PERF.atoNeutralS || a <= -PERF.resist) state.phase = 'brake';
    if (state.phase !== 'brake') { state.neutral += dt; return -PERF.resist; }
    if (terminal) {
      if(state.brakeEntrySpeed===undefined){state.brakeEntrySpeed=v;state.brakeEntryGrade=input.grade??0;state.brakeEntryDistance=atoBrakeDistance(v,state.brakeEntryGrade);}
      return terminalBrakeRequest(state,v,stopDist,brakeRate);
    }
    // A moving braking envelope falls at bPlan. A proportional-only request
    // would need a permanent positive speed error to supply that deceleration
    // and would carry it over the lower-limit boundary.
    return -Math.min(PERF.bService, Math.max(brakeRate, (v - target) * 1.6));
  }
  if (state.phase === 'brake') {
    if (v < .05 || target >= v - .1 && !terminal) { state.phase = 'coast'; state.neutral = 0; state.plannedCoast=false;state.brakeEntrySpeed=undefined;state.brakeEntryDistance=undefined;state.brakeEntryGrade=undefined; }
    else return -PERF.resist;
  }
  const floor = Math.min(cutoff, plan?.coastFloor ?? cutoff);
  if (plan && plan.coastAt >= 0 && remaining <= plan.coastAt && v >= cutoff - .1 && state.phase !== 'coast') {
    state.phase = 'coast'; state.neutral = 0; state.plannedCoast=true;
  }
  if (state.phase === 'coast') {
    state.neutral += dt;
    if(!state.plannedCoast&&state.neutral>=PERF.atoNeutralS){state.phase=v<target-PERF.atoSpeedHysteresis?'traction':'hold';}
    else {
      // A single recovery is allowed after a grade-induced speed loss; the
      // regular flat-track coast never chatters across the cruise threshold.
      const recover = plan ? (input.grade ?? 0) < 0 && v < floor - PERF.atoSpeedHysteresis && !state.recovered : target > v + PERF.atoSpeedHysteresis;
      if (recover && state.neutral >= PERF.atoNeutralS && remaining > v * v / (2 * PERF.bPlan) + 60) {
        state.phase = 'traction'; state.recovered = true;
      } else return v > .1 ? -PERF.resist : 0;
    }
  }
  const aim = Math.max(0, Math.min(target, cutoff));
  if (state.phase === 'traction' && speedAfterEasing(v, a) >= aim - .1) state.phase = 'hold';
  if (state.phase === 'hold') {
    if (v < aim - PERF.atoSpeedHysteresis) state.phase = 'traction';
    else return Math.max(-PERF.resist, Math.min(atoTractionAccel(v), (aim - v) * .6));
  }
  return Math.min(atoTractionAccel(v), Math.max(0, (aim - speedAfterEasing(v, a)) * 1.2 + .15));
}

/** CM follows the entire reference curve, including its falling coast speed. */
export function sectionRecommended(plan: SectionPlan, remaining: number): number {
  const samples = plan.samples;
  if (!samples.length) return plan.cutoff;
  if (remaining >= samples[0].remaining) return samples[0].speed;
  let lo = 0, hi = samples.length - 1;
  while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (samples[mid].remaining >= remaining) lo = mid; else hi = mid; }
  const a = samples[lo], b = samples[hi];
  return Math.max(0, a.speed + (b.speed - a.speed) * Math.max(0, Math.min(1, (a.remaining - remaining) / Math.max(.001, a.remaining - b.remaining))));
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

/** ATO anticipation of a lower static limit. Reserve the physical neutral
 * transition and the distance lost while service effort builds at its jerk
 * limit. The ATP permission and intervention curves remain independent. */
export function atoLimitSpeed(distance:number,endSpeed:number,v:number,a:number,brakeRate=PERF.bPlan):number{
  return brakingSpeed(distance-atoTransitionDistance(v,a,brakeRate),endSpeed,brakeRate);
}

function atoTransitionDistance(v:number,a:number,brakeRate:number):number{
  const initial=Math.max(-brakeRate,a),ramp=(initial+brakeRate)/PERF.jerk;
  const after=v+initial*ramp-PERF.jerk*ramp*ramp/2;
  const rampDistance=v*ramp+initial*ramp*ramp/2-PERF.jerk*ramp*ramp*ramp/6;
  // This is the same approach envelope throughout the transition. Switching
  // its neutral allowance off when brake effort first appears would raise the
  // target, release the brake, and switch the allowance straight back on.
  const reserve=Math.max(0,rampDistance+(after*after-v*v)/(2*brakeRate))
    +v*PERF.atoNeutralS;
  return reserve;
}

/** Enter the stop approach early enough to release traction and cross the
 * neutral phase. The stop shape itself retains its physical braking distance. */
export function atoStopApproachDistance(v:number,a:number,grade=0):number{
  return atoBrakeDistance(v,grade)+atoTransitionDistance(v,a,PERF.bPlan)+.3;
}

/** ATO / driver controller: returns commanded acceleration. */
export function controlAccel(v: number, vTarget: number, stopDist: number): number {
  // precision stop: follow the braking parabola to the stopping point
  if (stopDist < 60 && stopDist >= 0) {
    const need = (v * v) / (2 * Math.max(0.05, stopDist));
    if (need > PERF.bPlan * 0.92) return -Math.min(PERF.bService, need);
  }
  const err = vTarget - v;
  if (err < -0.2) return -Math.min(PERF.bService, Math.max(0.15, -err * 1.6));
  return Math.max(-PERF.resist, Math.min(atoTractionAccel(v), err * .6));
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
export function levelAccel(state: { v: number; a: number; coast: boolean }, level: number, vT: number, vCruise: number, stopAt: number,
  controller: AtoState = { phase: 'traction', recovered: false, neutral: 0 }, options: {brakeRate?:number;protecting?:boolean;grade?:number} = {}): number {
  const vc = levelTarget(level, vT, vCruise, state.v);
  const result=atoControl(controller, { v: state.v, a: state.a, target: vc, cruise: vc, stopDist: stopAt, remaining: stopAt,
    protecting: options.protecting ?? false, brakeRate: options.brakeRate,grade:options.grade });
  state.coast=controller.phase==='coast';
  return result;
}

/** The same cruise reduction for traction control and the CM recommendation. */
export function levelCruise(level: number, ceiling: number): number {
  const {lower,band}=levelBand(level);
  // 【假设】Continuous holding takes the midpoint of the existing coast band:
  // under constant resistance its speed falls linearly with time. Preserve
  // the grade's existing average-speed meaning without retuning its data.
  return Math.max(.1,ceiling-lower-band/2);
}

export function levelTarget(level: number, target: number, cruise: number, speed = Infinity): number {
  return level > 1 && speed >= 5 && target >= cruise - .1 ? levelCruise(level,target) : target;
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
  const controller = { v: 0, a: 0, coast: false, ato: { phase: 'traction', recovered: false, neutral: 0 } as AtoState };
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
      vT = Math.min(vT, atoLimitSpeed(d - 5, lim - PERF.atoFastMargin, v, a));
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
    const c = levelAccel(controller, runLevel, Math.max(0, vT), vLim - PERF.atoFastMargin, stopDist, controller.ato,{grade:aG});
    const want = controller.coast && c === -PERF.resist ? c : c > 0 ? Math.max(c - aG, c) : c - aG;
    a = jerkLimited(a, Math.max(-PERF.bService, Math.min(atoTractionAccel(v), want)), dt);
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


/** Task-path limits include the distance until the complete train clears. */
export interface SectionLimit { length: number; limit: number }

/** 【假设】Fallback where the recording cannot resolve the coast-end floor.
 * Kept in operational data rather than a station-specific control branch. */
const coastFloor = (): number => OPERATIONS.sectionCoastMinKmh / 3.6;

function integrateSection(dist: number, initialV: number, initialA: number, cutoff: number, coastAt: number,
  limits: readonly SectionLimit[] | undefined, margin: number, keepSamples: boolean): SectionPlan {
  const plan: SectionPlan = { cutoff, coastAt, coastFloor: Math.min(cutoff, coastFloor()), eta: 0, samples: [], coastValid:true, completed:false };
  if (!(dist > 0) || !Number.isFinite(dist)) return plan;
  const dt = .1;
  const boundaries: { end: number; cap: number }[] = [];
  let length = 0;
  for (const s of limits ?? []) { length += s.length; boundaries.push({end:length,cap:Math.max(.1,s.limit-margin)}); }
  if (!boundaries.length || length < dist) boundaries.push({end:dist,cap:cutoff});
  const state: AtoState = { phase:'traction', recovered:false, neutral:0 };
  let x = 0, v = Math.max(0, initialV), a = initialA, segment = 0;
  const maxTime = Math.max(3600, dist / Math.max(.1, cutoff) + 300);
  if (keepSamples) plan.samples.push({remaining:dist,speed:v});
  while (plan.eta < maxTime) {
    const remaining = Math.max(0, dist - x);
    if (remaining < .4 && v < .35) { plan.completed=x<=dist+.3; break; }
    while (segment + 1 < boundaries.length && boundaries[segment].end <= x) segment++;
    let target = Math.min(cutoff, boundaries[segment].cap, brakingSpeed(remaining - .2, 0, PERF.bPlan));
    for (let i = segment + 1; i < boundaries.length; i++) {
      const d = boundaries[i-1].end - x;
      if (d > 1000) break;
      target = Math.min(target, atoLimitSpeed(d - 3, boundaries[i].cap, v, a));
    }
    const command = atoControl(state,{v,a,target:Math.max(0,target),cruise:cutoff,stopDist:remaining,remaining,plan,dt});
    if (state.phase === 'coast' && remaining > v*v/(2*PERF.bPlan)+Math.max(3,v*.8) && v < plan.coastFloor-.1) plan.coastValid=false;
    a = jerkLimited(a, Math.max(-PERF.bService, Math.min(atoTractionAccel(v), command)), dt);
    const nextV = Math.max(0,v+a*dt);
    const travelled = (v+nextV)*dt/2;
    x += travelled; v=nextV;
    plan.eta += dt;
    if (keepSamples && (plan.samples.length === 1 || dist-x < plan.samples.at(-1)!.remaining-10)) plan.samples.push({remaining:Math.max(0,dist-x),speed:v});
    // A restrictive plan can become unachievable from a moving initial state;
    // return its bounded physical estimate, never throw in the worker.
    if (v < .001 && target <= 0 && remaining > .4) break;
  }
  if (keepSamples) plan.samples.push({remaining:0,speed:0});
  return plan;
}

// Cumulative acceleration time/distance for the same capped traction curve.
// Interpolation retains the exact input state: no quantised controller cache.
const ACCEL_STEP=.05;
const ACCEL_T=[0], ACCEL_D=[0];
for(let i=1;i<=Math.ceil(PERF.vMax/ACCEL_STEP)+1;i++){
  const mid=(i-.5)*ACCEL_STEP,dt=ACCEL_STEP/atoTractionAccel(mid);
  ACCEL_T.push(ACCEL_T[i-1]+dt);ACCEL_D.push(ACCEL_D[i-1]+mid*dt);
}
function accelerationIntegral(table: number[],v: number): number {
  const q=Math.max(0,Math.min(table.length-1,v/ACCEL_STEP)),i=Math.min(table.length-2,Math.floor(q));
  return table[i]+(table[i+1]-table[i])*(q-i);
}

/** Fast unhindered ETA from the same physical traction curve and bPlan.
 * Segment integration is analytical between traction-table boundaries. Full
 * budget trajectories additionally integrate jerk and phase transitions. */
export function sectionEta(dist: number, v: number, cruise: number, limits?: readonly SectionLimit[], margin = 0): number {
  if(!(dist>0)||!Number.isFinite(dist))return 0;
  const pieces: SectionLimit[]=[];
  for(const source of limits?.length?limits:[{length:dist,limit:cruise+margin}]){
    const limit=Math.max(.1,Math.min(cruise,source.limit-margin)),previous=pieces.at(-1);
    if(previous?.limit===limit)previous.length+=source.length;
    else pieces.push({length:source.length,limit});
  }
  const caps=pieces.map(s=>s.limit);
  const ends=new Float64Array(pieces.length+1),b=PERF.bPlan;
  for(let i=pieces.length-1;i>=0;i--)ends[i]=Math.min(caps[i],i?caps[i-1]:Infinity,Math.sqrt(ends[i+1]**2+2*b*pieces[i].length));
  let elapsed=v<.05?PERF.atoAccelMax/(2*PERF.jerk):0;
  for(let i=0;i<pieces.length;i++){
    const d=pieces[i].length,cap=caps[i];
    let end=Math.max(Math.sqrt(Math.max(0,v*v-2*b*d)),ends[i+1]);
    // A short preceding segment must not conjure the boundary's speed before
    // the train has the distance to accelerate to it.
    const distance0=accelerationIntegral(ACCEL_D,v);
    if(end>v&&accelerationIntegral(ACCEL_D,end)-distance0>d){let lo=v,hi=end;for(let k=0;k<12;k++){const mid=(lo+hi)/2;if(accelerationIntegral(ACCEL_D,mid)-distance0>d)hi=mid;else lo=mid;}end=(lo+hi)/2;}
    if(v>cap){elapsed+=(v-end)/b+Math.max(0,d-(v*v-end*end)/(2*b))/cap;v=end;continue;}
    const da=(p:number)=>Math.max(0,accelerationIntegral(ACCEL_D,p)-accelerationIntegral(ACCEL_D,v));
    let peak=cap;
    if(da(peak)+Math.max(0,(peak*peak-end*end)/(2*b))>d){let lo=Math.max(v,end),hi=cap;for(let k=0;k<12;k++){const m=(lo+hi)/2;if(da(m)+Math.max(0,(m*m-end*end)/(2*b))>d)hi=m;else lo=m;}peak=(lo+hi)/2;}
    const braking=Math.max(0,(peak*peak-end*end)/(2*b));
    elapsed+=Math.max(0,accelerationIntegral(ACCEL_T,peak)-accelerationIntegral(ACCEL_T,v))+Math.max(0,peak-end)/b+Math.max(0,d-da(peak)-braking)/Math.max(.1,peak);
    v=end;
  }
  return elapsed+v/b;
}

/** Spend slack on a longer coast first, then a lower cutoff. Night levels
 * retain continuous speed holding, with their existing lower-speed data. */
export function sectionPlan(dist: number, v: number, budget: number, ceiling: number,
  limits?: readonly SectionLimit[], margin = 0, a = 0, level = 1): SectionPlan {
  ceiling = levelCruise(level,ceiling);
  const fast = integrateSection(dist,v,a,Math.max(.1,ceiling),-1,limits,margin,false);
  if (!Number.isFinite(dist) || !(dist > 0) || budget <= fast.eta)
    return integrateSection(dist,v,a,Math.max(.1,ceiling),-1,limits,margin,true);
  let cutoff = Math.max(.1,ceiling), coastAt = -1, lowerCutoff = level !== 1;
  const earliestLegal = (speed: number): SectionPlan => {
    let lo=0,hi=dist;
    const earliest=integrateSection(dist,v,a,speed,hi,limits,margin,false);
    if(earliest.coastValid)return earliest;
    for(let i=0;i<10;i++){const mid=(lo+hi)/2;if(integrateSection(dist,v,a,speed,mid,limits,margin,false).coastValid)lo=mid;else hi=mid;}
    return integrateSection(dist,v,a,speed,lo,limits,margin,false);
  };
  if (level === 1) {
    const earliest = earliestLegal(cutoff);
    if (earliest.eta >= budget) {
      let lo = 0, hi = earliest.coastAt;
      for (let i=0;i<11;i++) { const mid=(lo+hi)/2; if(integrateSection(dist,v,a,cutoff,mid,limits,margin,false).eta<budget)lo=mid;else hi=mid; }
      coastAt=hi;
    } else { coastAt=earliest.coastAt; lowerCutoff=true; }
  }
  if (lowerCutoff) {
    let lo = Math.min(cutoff,OPERATIONS.sectionCruiseMinKmh/3.6), hi = cutoff;
    for(let i=0;i<11;i++){const mid=(lo+hi)/2;const candidate=level===1?earliestLegal(mid):integrateSection(dist,v,a,mid,-1,limits,margin,false);if(candidate.eta>budget)lo=mid;else hi=mid;}
    cutoff=(lo+hi)/2;
    coastAt=level===1?earliestLegal(cutoff).coastAt:-1;
  }
  return integrateSection(dist,v,a,cutoff,coastAt,limits,margin,true);
}

/** Compatibility for callers needing only the solved traction cutoff. */
export function sectionCruise(dist: number, v: number, budget: number, ceiling: number, limits?: readonly SectionLimit[], margin = 0): number {
  if (!Number.isFinite(dist) || budget <= 0 || dist <= v*v/(2*PERF.bPlan)+1) return ceiling;
  return sectionPlan(dist,v,budget,ceiling,limits,margin).cutoff;
}
