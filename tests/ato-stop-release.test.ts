import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Sim } from '../src/sim/engine';
import { newTrain, preciseAtoStationStop, updateTrainTasks } from '../src/sim/ats';
import { computeBody, indexBodies, scanAhead, stopError, updateTrainMotion } from '../src/sim/movement';
import { computeOccupancy, releaseRoute } from '../src/sim/interlocking';
import { platformBerth } from '../src/sim/timetable';
import { profileOf } from '../src/sim/gradient';
import { PERF, atoBrakeDistance, atoBrakeProfile, atoControl, atoStopMargin, atoStopReady,
  sectionPlan, type AtoState } from '../src/sim/dynamics';

const restoreProfiles: (() => void)[] = [];
afterEach(() => { for (const restore of restoreProfiles.splice(0).reverse()) restore(); });

function approach(distance = 50) {
  const sim = new Sim({ dayType: 'weekday', dateLabel: 'ato-stop-release', startTime: 14400,
    seed: 7, noPossessions: true, autoDispatch: false, autoRadio: false });
  for (const tr of [...sim.trainList]) sim.removeTrain(tr);
  for (const id of [...sim.routes.keys()]) releaseRoute(sim, id);
  for (const b of sim.plan.blocks) sim.blockDone.add(b.id);
  // Sim reuses its topology. Restore the shared cached profile after each
  // controlled flat-section fixture so this test cannot change another world.
  const profile = profileOf(sim.topo), heights = profile.h.slice();
  restoreProfiles.push(() => { profile.h.splice(0, profile.h.length, ...heights); });
  profile.h.fill(0);
  const berth = sim.topo.berths[platformBerth(sim.topo, 12, 'DN')];
  const off = berth.offset - berth.dir * distance;
  const tr = newTrain(sim, null, berth.link, off, berth.dir,
    [{ link: berth.link, dir: berth.dir }], 'stop-release-fixture');
  tr.tasks = [{ k: 'stop', station: berth.station, berth: berth.id, trip: -1,
    arr: null, dep: null, doors: false, revenue: false }];
  tr.inService = false;
  const entry = 10, brakeDistance = atoBrakeDistance(entry);
  const point = atoBrakeProfile(entry, distance, brakeDistance);
  Object.assign(tr, { v: point.speed, a: -point.decel,
    atoMove: { phase: 'brake', recovered: false, neutral: 1, brakeEntrySpeed: entry,
      brakeEntryDistance: brakeDistance, brakeEntryGrade: 0, terminalApproachDistance: distance } });
  computeBody(sim, tr); indexBodies(sim); computeOccupancy(sim);
  const scan = scanAhead(sim, tr, berth.id);
  tr.maDist = tr.lastMa = scan.maDist; tr.lastDs = 0; tr.maSigs = scan.maSignals;
  tr.stopDist = scan.stopDist;
  return { sim, tr, berth, scan };
}

describe('calibrated ATO physical stop release', () => {
  it('uses finite numerical stop tolerances without turning an MA margin into a station target', () => {
    expect(atoStopReady(.029, .029)).toBe(true);
    expect(atoStopReady(.04, .01)).toBe(false);
    expect(atoStopReady(.02, .04)).toBe(false);
    expect(atoStopReady(.01, Infinity)).toBe(false);
    expect(atoStopReady(NaN, .01)).toBe(false);
    expect(atoStopMargin(.3)).toBe(.01);
  });

  it('retains a terminal latch below .05m/s but releases it for a truly extended target', () => {
    const entry = 10, state: AtoState = { phase: 'brake', recovered: false, neutral: 1,
      brakeEntrySpeed: entry, brakeEntryDistance: atoBrakeDistance(entry), brakeEntryGrade: 0,
      terminalApproachDistance: .02 };
    const request = atoControl(state, { v: .04, a: -.1, target: .2, cruise: 10,
      stopDist: .02, remaining: .02 });
    expect(request).toBeLessThanOrEqual(0);
    expect(state.phase).toBe('brake'); expect(state.brakeEntrySpeed).toBe(entry);
    expect(state.terminalApproachDistance).toBe(.02);
    const released = atoControl(state, { v: 0, a: 0, target: 10, cruise: 10,
      stopDist: 100, remaining: 100 });
    expect(released).toBeGreaterThan(0); expect(state.phase).toBe('traction');
    expect(state.terminalApproachDistance).toBeUndefined();
  });

  it.each([.03836986094094641, .07])('physically completes the final %s m after an early standstill', distance => {
    const { sim, tr } = approach(distance);
    Object.assign(tr, { v: 0, a: 0, atoMove: { phase: 'hold', recovered: false,
      neutral: .5, terminalApproachDistance: distance } });
    for (let i = 0; i < 300 && tr.phase === 'run'; i++) {
      updateTrainMotion(sim, tr, .1); updateTrainTasks(sim, tr); sim.t += .1;
    }
    expect(tr.phase).toBe('dwell');
    expect(Math.abs(stopError(sim, tr))).toBeLessThanOrEqual(PERF.atoStopSnap!.distance);
  });

  it('restarts and stops within the national ±0.3 m accuracy after an emergency brake left it 13.9 m short', () => {
    // Fuzz 142031: the stale approach latched 0.045 m/s as its entry speed and
    // crept for ten minutes. Accuracy: national signalling spec, ATO ±0.3 m.
    const { sim, tr } = approach(13.9);
    Object.assign(tr, { v: 0, a: 0, atoMove: { phase: 'brake', recovered: false,
      neutral: 0, terminalApproachDistance: 13.9 } });
    for (let i = 0; i < 600 && tr.phase === 'run'; i++) {
      updateTrainMotion(sim, tr, .1); updateTrainTasks(sim, tr); sim.t += .1;
    }
    expect(tr.phase).toBe('dwell');
    expect(Math.abs(stopError(sim, tr))).toBeLessThanOrEqual(.3);
  });

  it('shares the station-only capability scope without applying it to rescue, manual or protection stops', () => {
    const { sim, tr } = approach(1);
    expect(preciseAtoStationStop(sim.topo, tr)).toBe(true);
    const original = { mode: tr.mode, manual: tr.manual, eb: tr.eb, failed: tr.failed,
      randomOverrunM: tr.randomOverrunM, rescuing: tr.rescuing, rescueBy: tr.rescueBy,
      coupledLen: tr.coupledLen, overrun: tr.overrun };
    for (const patch of [{ mode: 'RM' }, { manual: true }, { eb: true }, { failed: true },
      { randomOverrunM: 2 }, { rescuing: 1 }, { rescueBy: 1 }, { coupledLen: 186 }, { overrun: 2 }]) {
      Object.assign(tr, original, patch);
      expect(preciseAtoStationStop(sim.topo, tr)).toBe(false);
    }
    Object.assign(tr, original);
    tr.tasks = [{ k: 'depot', depot: 0 }];
    expect(preciseAtoStationStop(sim.topo, tr)).toBe(false);
  });

  it('travels through the low-speed release with declining actual brake effort before physical arrival', () => {
    const { sim, tr, scan } = approach();
    expect(scan.stopDist).toBeLessThanOrEqual(scan.maDist);
    const trace: { v: number; a: number; ds: number; error: number }[] = [];
    for (let i = 0; i < 300 && tr.phase === 'run'; i++) {
      const previousA = tr.a;
      updateTrainMotion(sim, tr, .1); sim.t += .1;
      if (tr.v > 0) expect(Math.abs(tr.a - previousA)).toBeLessThanOrEqual(PERF.jerk * .1 + 1e-9);
      expect(tr.a).toBeGreaterThanOrEqual(-PERF.bService - 1e-9);
      expect(tr.eb).toBe(false);
      trace.push({ v: tr.v, a: tr.a, ds: tr.lastDs, error: stopError(sim, tr) });
      const beforeArrival = tr.v;
      indexBodies(sim); computeOccupancy(sim); updateTrainTasks(sim, tr);
      if (String(tr.phase) === 'dwell') expect(beforeArrival).toBeLessThan(PERF.atoStopSnap!.speed);
    }
    expect(tr.phase).toBe('dwell'); expect(tr.v).toBe(0);
    expect(Math.abs(stopError(sim, tr))).toBeLessThanOrEqual(PERF.atoStopSnap!.distance + .004);
    const early = trace.filter(p => p.v > .25 && p.v < .5);
    const late = trace.filter(p => p.v > PERF.atoStopSnap!.speed && p.v < .1);
    expect(early.length).toBeGreaterThan(0); expect(late.length).toBeGreaterThan(0);
    const meanBrake = (rows: typeof trace) => rows.reduce((sum, p) => sum - p.a, 0) / rows.length;
    expect(meanBrake(late)).toBeLessThan(meanBrake(early));
    expect(trace.filter(p => p.v > 0 && p.v < .35).reduce((sum, p) => sum + p.ds, 0)).toBeGreaterThan(.03);
    expect(tr.doorsOpen).toBe(false); // no extra open-door or stationary waiting phase was added
  });

  it('does not let ATS consume the release or enter dwell ahead of a nearer MA', () => {
    const { sim, tr } = approach(.02);
    Object.assign(tr, { v: .04, stopDist: .02, maDist: 100 });
    updateTrainTasks(sim, tr); expect(tr.phase).toBe('run');
    Object.assign(tr, { v: 0, stopDist: .02, maDist: .01 });
    updateTrainTasks(sim, tr); expect(tr.phase).toBe('run'); expect(tr.doorsOpen).toBe(false);
    tr.stopDist = Infinity;
    updateTrainTasks(sim, tr); expect(tr.phase).toBe('run');
    Object.assign(tr, { stopDist: .02, maDist: 100 });
    updateTrainTasks(sim, tr); expect(tr.phase).toBe('dwell');
  });

  it('keeps the legacy non-station reversal arrival boundary', () => {
    const { sim, tr, berth } = approach(.1);
    tr.tasks = [{ k: 'reverse', station: berth.station, berths: [berth.id], chosen: berth.id, minTime: 40 }];
    Object.assign(tr, { v: .04, stopDist: .1, maDist: 100 });
    updateTrainTasks(sim, tr);
    expect(tr.phase).toBe('reversing');
  });

  it('completes the section reference without the old .2m zero target or a time-limit standstill', () => {
    const plan = sectionPlan(300, 0, 0, 12);
    expect(plan.completed).toBe(true);
    expect(plan.eta).toBeLessThan(200);
    expect(plan.samples.at(-1)).toEqual({ remaining: 0, speed: 0 });
    expect(plan.samples.some(s => s.speed > 0 && s.remaining > 0)).toBe(true);
  });
});

describe('uncalibrated line keeps its original numerical defaults', () => {
  let dynamics: typeof import('../src/sim/dynamics');
  beforeAll(async () => {
    vi.stubEnv('ATS_LINE', '14'); vi.resetModules();
    dynamics = await import('../src/sim/dynamics');
  });
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  it('retains separate planning and motion defaults, old margins and the old low-speed restart', () => {
    expect(dynamics.PERF.atoStopSnap).toBeUndefined();
    expect(dynamics.atoStopReady(.49, .49, .5, .5)).toBe(true);
    expect(dynamics.atoStopReady(.34, .39)).toBe(true);
    expect(dynamics.atoStopReady(.36, .39)).toBe(false);
    expect(dynamics.atoStopMargin(.3)).toBe(.3); expect(dynamics.atoStopMargin(.2)).toBe(.2);
    const state: AtoState = { phase: 'brake', recovered: false, neutral: 1,
      brakeEntrySpeed: 10, brakeEntryDistance: dynamics.atoBrakeDistance(10), terminalApproachDistance: .02 };
    const request = dynamics.atoControl(state, { v: .04, a: -.1, target: .2, cruise: 10,
      stopDist: .02, remaining: .02 });
    expect(request).toBeGreaterThan(0); expect(state.phase).toBe('traction');
  });
});
