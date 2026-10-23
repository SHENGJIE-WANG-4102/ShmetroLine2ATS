/**
 * Revision-2 simulation features: blocking, manual driving with ATP and
 * stop scoring, radio calls and their consequences, weather restrictions,
 * night possessions, yards, PIS, scenarios and replay determinism.
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { makeSim, runFor, runUntil, assertNoCollision, assertIntegrity, dirOf } from './helpers';
import { capture, restore, fingerprint } from '../src/sim/state';
import { computePis } from '../src/sim/pis';
import { yardCount } from '../src/sim/yard';
import { LINE_INFO, FLEET, fleetEntry } from '../src/data/line2';
import { nextLink } from '../src/sim/topology';
import { scanAhead, goalBerth, refreshAuthority, MA_NEAR } from '../src/sim/movement';
import { dmiTrainNo, computeDmi } from '../src/sim/dmi';
import { PERF } from '../src/sim/dynamics';
import { platformBerth } from '../src/sim/timetable';
import { platformSide } from '../src/sim/ats';
import type { Train } from '../src/sim/model';
import { DOOR_CLOSE_S } from '../src/sim/calibration';
import { closeDoors } from '../src/sim/psd';
import { updateTrainTasks } from '../src/sim/ats';

const H = 8 * 3600;
const st = (sim: Sim, name: string) => sim.topo.stations.find((s) => s.name === name)!;
const check = (sim: Sim) => { assertNoCollision(sim); assertIntegrity(sim); };
/** the platform side of the stop a train stands at */
const platSideOf = (sim: Sim, tr: Train) => platformSide(sim, tr, sim.topo.berths[(tr.tasks[0] as { berth: number }).berth].platform);
/** a driver at a stop: opens the platform-side doors, closes them when the countdown runs out */
const workDoors = (sim: Sim, tr: Train) => {
  if (tr.phase !== 'dwell' || tr.tasks[0]?.k !== 'stop') return;
  if (!tr.doorMotion && (tr.doorsAwait || (tr.doorsOpen && sim.t >= tr.dwellUntil - 2))) sim.command({ c: 'door', train: tr.id, side: platSideOf(sim, tr) });
};
/** a simple driver: traction to ~55 km/h, brake on a 0.7 m/s² curve to the stopping point */
const driveToNextStop = (sim: Sim, tr: Train, guardSteps = 6000) => {
  const startStops = tr.stopsMade;
  let guard = 0;
  while (tr.stopsMade === startStops && guard++ < guardSteps) {
    workDoors(sim, tr);
    if (tr.phase === 'run') {
      const err = Number.isFinite(tr.stopDist) ? tr.stopDist : Infinity;
      const need = err < Infinity ? (tr.v * tr.v) / (2 * Math.max(0.1, err - 0.1)) : 0;
      const vCap = Math.min(55 / 3.6, tr.vPermit - 2);
      if (need > 0.75 || (err < 1.5 && tr.v > 0.2)) tr.notch = Math.max(-7, -Math.ceil((need / PERF.bService) * 7));
      else if (err < 0.6) tr.notch = -7;
      else if (tr.v < vCap - 1) tr.notch = 4;
      else if (tr.v > vCap) tr.notch = -2;
      else tr.notch = 0;
    }
    sim.step();
    check(sim);
  }
};

describe('blocking (封锁)', () => {
  it('a blocked section refuses routes and stops trains before it; unblocking restores service', () => {
    const sim = makeSim('weekday', H);
    const a = st(sim, '江苏路').chain;
    const b = st(sim, '静安寺').chain;
    const secs = sim.topo.sections.filter((s) => s.track === 'DN' && s.kind === 'plain' && s.chainFrom > a + 200 && s.chainTo < b - 200).map((s) => s.id);
    expect(secs.length).toBeGreaterThan(0);
    // wait until nothing occupies them, then block
    runFor(sim, 1, check);
    expect(sim.command({ c: 'sectionBlock', sections: secs, on: true }).ok).toBe(true);
    runFor(sim, 240, check);
    const before = sim.trainList.filter((t) => t.maReason === '区段封锁');
    expect(before.length).toBeGreaterThan(0);
    // nobody entered a blocked section after blocking (trains already inside may leave)
    const route = sim.topo.routes.find((r) => r.sections.some((s) => secs.includes(s)))!;
    if (sim.sig[route.start].route < 0) expect(sim.command({ c: 'setRoute', route: route.id }).ok).toBe(false);
    expect(sim.command({ c: 'sectionBlock', sections: secs, on: false }).ok).toBe(true);
    runFor(sim, 300, check);
    expect(sim.trainList.filter((t) => t.maReason === '区段封锁').length).toBe(0);
  });

  it('a blocked switch cannot be used by routes but can still be operated singly', () => {
    const sim = makeSim('weekday', H);
    const sw = sim.topo.switches.find((s) => s.kind === 'crossover' && s.station === st(sim, '人民广场').index)!;
    expect(sim.command({ c: 'switchBlock', sw: sw.id, on: true }).ok).toBe(true);
    const r = sim.topo.routes.find((x) => x.switches.some((y) => y.sw === sw.id) && sim.sig[x.start].route < 0)!;
    const res = sim.command({ c: 'setRoute', route: r.id });
    expect(res.ok).toBe(false);
    expect(res.msg).toContain('封锁');
    expect(sim.command({ c: 'switchBlock', sw: sw.id, on: false }).ok).toBe(true);
  });
});

describe('manual driving', () => {
  it('CM driving: traction and brake to the next platform, stop accuracy is scored', () => {
    const sim = makeSim('weekday', H);
    // a DN train dwelling at a station with a plain interval ahead
    let tr = sim.trainList.find((t) => t.phase === 'dwell' && t.inService && dirOf(sim, t) === 'DN' && sim.trainChain(t) > 9000 && sim.trainChain(t) < 20000);
    while (!tr) { runFor(sim, 5); tr = sim.trainList.find((t) => t.phase === 'dwell' && t.inService && dirOf(sim, t) === 'DN' && sim.trainChain(t) > 9000 && sim.trainChain(t) < 20000); }
    expect(sim.command({ c: 'manual', train: tr.id, mode: 'CM' }).ok).toBe(true);
    expect(tr.manual).toBe(true);
    const startStops = tr.stopsMade;
    driveToNextStop(sim, tr);
    expect(tr.stopsMade).toBe(startStops + 1);
    expect(tr.drv.stops.length).toBe(1);
    expect(Math.abs(tr.drv.stops[0].err)).toBeLessThanOrEqual(1);
    expect(tr.drv.stops[0].score).toBeGreaterThan(0);
    expect(tr.drv.overspeed).toBe(0);
    expect(sim.command({ c: 'manual', train: tr.id, mode: 'AUTO' }).ok).toBe(true);
  });

  it('ATP: overspeed in CM triggers an emergency brake and counts as a safety violation', () => {
    const sim = makeSim('weekday', H);
    const find = () => sim.trainList.find((t) => t.inService && t.phase === 'run' && dirOf(sim, t) === 'DN' && sim.trainChain(t) > 5000 && sim.trainChain(t) < 30000 && t.v > 8);
    let tr = find();
    while (!tr) { runFor(sim, 2); tr = find(); }
    expect(sim.command({ c: 'manual', train: tr.id, mode: 'CM' }).ok).toBe(true);
    tr.notch = 4;
    let guard = 0;
    while (!tr.eb && guard++ < 3000) { sim.step(); check(sim); }
    expect(tr.eb).toBe(true);
    expect(tr.drv.overspeed).toBeGreaterThanOrEqual(1);
    expect(sim.metrics.safety.overspeed).toBeGreaterThanOrEqual(1);
  });

  it('RM is capped at 25 km/h and never closes up on the train ahead', () => {
    const sim = makeSim('weekday', H);
    const tr = sim.trainList.find((t) => t.phase === 'dwell' && t.inService && dirOf(sim, t) === 'UP' && sim.trainChain(t) > 9000)!;
    // Take over while it is still stopped; advancing can start departure.
    expect(sim.command({ c: 'manual', train: tr.id, mode: 'RM' }).ok).toBe(true);
    tr.notch = 4;
    let maxV = 0;
    for (let i = 0; i < 3000; i++) {
      workDoors(sim, tr);
      sim.step();
      check(sim);
      maxV = Math.max(maxV, tr.v);
    }
    // the EB trips 0.15 m/s over the EBI speed; the step before it can still add one step of
    // full traction, plus gravity on the steepest falling grade (30‰, gradient.ts)
    expect(maxV).toBeLessThan(PERF.vRM + PERF.atpTolerance + 0.15 + (PERF.aMax + 9.81 * 0.03) * 0.1 + 1e-6);
  });
});

describe('driver doors and the acceleration limit', () => {
  it('CM departs after the 5.7s lock sequence after actual lock confirmation and records one negative-delay departure', () => {
    const sim=makeSim('weekday',H),tr=dwellingDN(sim);
    const stop=tr.tasks[0];expect(stop.k).toBe('stop');if(stop.k!=='stop')return;
    const p=sim.topo.berths[stop.berth].platform;
    tr.tasks[0]={...stop,dep:sim.t+32};tr.dwellUntil=sim.t+32;
    expect(closeDoors(sim,tr,p)).toBe(0);
    expect(sim.command({c:'manual',train:tr.id,mode:'CM'}).ok).toBe(true);
    sim.drive(tr.id,4);
    runFor(sim,DOOR_CLOSE_S-.2);expect(tr.v).toBe(0);expect(tr.phase).toBe('dwell');
    expect(computeDmi(sim,tr.id)?.trainDoor).toBe('closing');
    runFor(sim,1);expect(tr.v).toBeGreaterThan(0);expect(tr.delay).toBeLessThan(-24);
    expect(computeDmi(sim,tr.id)?.trainDoor).toBe('closed');
    const early=()=>sim.events.filter(e=>e.code==='EARLY_DEPARTURE'&&e.train===tr.id);
    expect(early()).toHaveLength(1);expect(early()[0].text).toMatch(/早发 (26|27) 秒/);
    expect(sim.depLog.at(-1)?.delay).toBeLessThan(0);
    expect(tr.departureDisplay).toBeDefined();
    const deadline=sim.t+20;
    while(sim.t<deadline&&tr.departureDisplay?.headLeftAt===undefined)runFor(sim,.1);
    expect(tr.departureDisplay?.headLeftAt).toBeDefined();
    const cp=capture(sim),remaining=tr.departureDisplay!.remaining;
    runFor(sim,2);expect(early()).toHaveLength(1);
    expect(cp.trains.find(t=>t.id===tr.id)?.departureDisplay?.remaining).toBe(remaining);
    runFor(sim,5);expect(tr.departureDisplay).toBeUndefined();
  });
  it.each(['CM','RM','DTO','AM'] as const)('%s obeys physical locks and dispatch holds; only manual ignores planned time',mode=>{
    const sim=makeSim('weekday',H),tr=dwellingDN(sim),st=tr.tasks[0];if(st.k!=='stop')throw Error('fixture');
    const ps=sim.plat[sim.topo.berths[st.berth].platform];
    tr.mode=mode;tr.manual=mode==='CM'||mode==='RM';tr.doorsOpen=false;tr.doorSide='';tr.doorsAwait=false;
    ps.psd='closed';tr.dwellUntil=sim.t+100;tr.doorLockedAt=sim.t+12;
    updateTrainTasks(sim,tr);expect(tr.phase).toBe('dwell');
    tr.doorLockedAt=sim.t-1;tr.hold=true;updateTrainTasks(sim,tr);expect(tr.phase).toBe('dwell');
    tr.hold=false;ps.hold=true;updateTrainTasks(sim,tr);expect(tr.phase).toBe('dwell');
    ps.hold=false;ps.psd='closeFail';updateTrainTasks(sim,tr);expect(tr.phase).toBe('dwell');
    ps.psd='closed';updateTrainTasks(sim,tr);expect(tr.phase).toBe(tr.manual?'run':'dwell');
  });
  const dwellingDN = (sim: Sim) => {
    const find = () => sim.trainList.find((t) => t.phase === 'dwell' && t.inService && t.doorsOpen && dirOf(sim, t) === 'DN' && sim.trainChain(t) > 9000 && sim.trainChain(t) < 20000);
    let tr = find();
    while (!tr) { runFor(sim, 5); tr = find(); }
    return tr;
  };

  it('CM: the ATP enables only the platform side of a train at its mark; no traction with doors open', () => {
    const sim = makeSim('weekday', H);
    expect(sim.speedCap()).toBe(Infinity);
    const tr = dwellingDN(sim);
    expect(sim.command({ c: 'manual', train: tr.id, mode: 'CM' }).ok).toBe(true);
    expect(sim.speedCap()).toBe(5);
    // one cab at a time
    const other = sim.trainList.find((t) => t !== tr && t.inService && t.phase === 'dwell')!;
    expect(sim.command({ c: 'manual', train: other.id, mode: 'CM' }).ok).toBe(false);
    // the doors the signalling opened stay open until the driver closes them
    runFor(sim, 120, check);
    expect(tr.phase).toBe('dwell');
    expect(tr.doorsOpen).toBe(true);
    driveToNextStop(sim, tr);
    expect(tr.phase).toBe('dwell');
    expect(tr.doorsAwait).toBe(true);
    expect(tr.doorsOpen).toBe(false);
    const side = platSideOf(sim, tr);
    // 2号线 islands: the platform is on the left of a DN train at an ordinary station
    expect(side).toBe('L');
    const wrong = sim.command({ c: 'door', train: tr.id, side: 'R' });
    expect(wrong.ok).toBe(false);
    expect(wrong.msg).toContain('门使能');
    expect(tr.doorSide).toBe('');
    expect(sim.command({ c: 'door', train: tr.id, side }).ok).toBe(true);
    expect(tr.doorsOpen).toBe(true);
    const p = sim.topo.berths[(tr.tasks[0] as { berth: number }).berth].platform;
    runFor(sim,.4,check);
    expect(sim.plat[p].psd).toBe('open');
    tr.notch = 4;
    runFor(sim, 30, check);
    expect(tr.v).toBe(0);
    expect(tr.phase).toBe('dwell');
    tr.notch = 0;
    expect(sim.command({ c: 'door', train: tr.id, side }).ok).toBe(true);
    expect(tr.doorsOpen).toBe(true);
    expect(tr.doorMotion?.kind).toBe('closing');
    // Closing uses the shared recorded warning + mechanism sequence (5.7 s).
    runFor(sim, 15, check);
    expect(tr.doorsOpen).toBe(false);expect(sim.plat[p].psd).toBe('closed');
    expect(tr.phase).toBe('run');
    expect(sim.command({ c: 'manual', train: tr.id, mode: 'AUTO' }).ok).toBe(true);
    expect(sim.speedCap()).toBe(Infinity);
  });

  it('CM: an empty run stopping at its mark gets no door enable, and says why', () => {
    const sim = makeSim('weekday', H);
    const tr = dwellingDN(sim);
    expect(sim.command({ c: 'manual', train: tr.id, mode: 'CM' }).ok).toBe(true);
    runFor(sim, 120, check);
    // the next call made into one with no passenger work, on an empty train
    const next = tr.tasks.find((t, i) => i > 0 && t.k === 'stop') as { doors: boolean; revenue: boolean };
    next.doors = false; next.revenue = false;
    tr.load = 0;
    driveToNextStop(sim, tr);
    expect(tr.phase).toBe('dwell');
    expect(tr.doorsAwait).toBe(false);
    const r = sim.command({ c: 'door', train: tr.id, side: platSideOf(sim, tr) });
    expect(r.ok).toBe(false);
    expect(r.msg).toContain('不办理客运');
  });

  it('RM: door enable for the platform side only; the PSD is worked from the PSL', () => {
    const sim = makeSim('weekday', H);
    const tr = dwellingDN(sim);
    expect(sim.command({ c: 'manual', train: tr.id, mode: 'RM' }).ok).toBe(true);
    driveToNextStop(sim, tr, 12000);
    expect(tr.doorsAwait).toBe(true);
    const side = platSideOf(sim, tr);
    const other = side === 'L' ? 'R' : 'L';
    const r = sim.command({ c: 'door', train: tr.id, side: other });
    expect(r.ok).toBe(false);
    expect(tr.doorSide).toBe('');
    expect(sim.metrics.safety.wrongDoor).toBe(0);
    expect(sim.command({ c: 'door', train: tr.id, side }).ok).toBe(true);
    const p = sim.topo.berths[(tr.tasks[0] as { berth: number }).berth].platform;
    runFor(sim,.4,check);
    expect(sim.plat[p].psd).toBe('pslOpen');
    // handing back to automatic driving: the signalling closes the doors and the train leaves
    const stops = tr.stopsMade;
    expect(sim.command({ c: 'manual', train: tr.id, mode: 'AUTO' }).ok).toBe(true);
    runFor(sim, 240, check);
    expect(tr.doorsOpen).toBe(false);
    expect(tr.phase === 'run' || tr.stopsMade > stops).toBe(true);
  });
});

describe('radio calls', () => {
  it('without an answer a comm-loss train waits under EB; authorising release with degrade lets it run in AM-T', () => {
    const sim = makeSim('weekday', H, { autoRadio: false });
    const tr = sim.trainList.find((t) => t.inService && t.phase === 'run' && t.v > 5 && sim.trainChain(t) > 9000 && sim.trainChain(t) < 30000)!;
    sim.command({ c: 'fault', kind: 'trainComm', target: tr.id, duration: 3000 });
    runFor(sim, 60, check);
    const call = sim.calls.find((c) => c.kind === 'ebRelease' && c.train === tr.id);
    expect(call).toBeDefined();
    expect(tr.level).toBe('CBTC');
    expect(tr.eb).toBe(true);
    runFor(sim, 140, check);
    expect(sim.metrics.callsExpired).toBeGreaterThanOrEqual(1);
    expect(tr.v).toBeLessThan(0.1);
    // the driver calls again
    runFor(sim, 80, check);
    const again = sim.calls.find((c) => c.kind === 'ebRelease' && c.train === tr.id && c.state === 'ringing');
    expect(again).toBeDefined();
    expect(sim.command({ c: 'radio', call: again!.id, option: 'degrade' }).ok).toBe(true);
    runFor(sim, 30, check);
    expect(tr.level).toBe('TBTC');
    expect(tr.mode).toBe('AM');
    expect(tr.eb).toBe(false);
  });

  it('an unanswered passenger alarm makes the driver stop in section', () => {
    const sim = makeSim('weekday', H, { autoRadio: false });
    const tr = sim.trainList.find((t) => t.inService && t.phase === 'run' && t.v > 5)!;
    sim.command({ c: 'fault', kind: 'pecu', target: tr.id, duration: 0 });
    runFor(sim, 50, check);
    expect(tr.stopUntil).toBeGreaterThan(sim.t);
    // service brake from line speed takes up to ~30 s
    const t0 = sim.t;
    while (tr.v >= 0.5 && sim.t - t0 < 40) runFor(sim, 1, check);
    expect(tr.v).toBeLessThan(0.5);
    expect(tr.stopUntil).toBeGreaterThan(sim.t);
  });
});

describe('environment', () => {
  it('wind restricts the elevated section and trains respect it', () => {
    const sim = makeSim('weekday', H);
    expect(sim.command({ c: 'env', wind: 2, duration: 1800 }).ok).toBe(true);
    const elevated = sim.topo.sections.filter((_, i) => sim.exposure[i] === 1);
    expect(elevated.length).toBeGreaterThan(10);
    expect(elevated.every((s) => sim.sec[s.id].envTsr === 45)).toBe(true);
    runFor(sim, 240, check);
    for (const tr of sim.trainList) {
      if (tr.body.every((b) => sim.exposure[sim.topo.links[b.link].section] === 1)) expect(tr.v).toBeLessThan(45 / 3.6 + PERF.atpTolerance);
    }
    runFor(sim, 1600, check);
    expect(sim.sec[elevated[0].id].envTsr).toBe(0);
  });

  it('morning possessions block their sections until the station asks to release them', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 't', startTime: 4 * 3600, seed: 3, autoRadio: false });
    const active = sim.possessions.filter((p) => p.state === 'active');
    expect(active.length).toBe(2);
    const s0 = active[0].sections[0];
    expect(sim.sec[s0].blocked).toBe(true);
    runUntil(sim, 4 * 3600 + 21 * 60);
    const call = sim.calls.find((c) => c.kind === 'possRel' && c.target === active[0].id && c.state === 'ringing');
    expect(call).toBeDefined();
    expect(sim.command({ c: 'sectionBlock', sections: [s0], on: false }).ok).toBe(false);
    expect(sim.command({ c: 'radio', call: call!.id, option: 'approve' }).ok).toBe(true);
    expect(sim.sec[s0].blocked).toBe(false);
  });
});

describe('yards, PIS', () => {
  it('vehicles are conserved between yards, the line and terminal stabling', () => {
    const sim = makeSim('weekday', H);
    // Workshop admissions remove a physical car from the available yard stock.
    const count = () => sim.yards.reduce((a, y) => a + yardCount(y), 0) + sim.trainList.reduce((a, t) => a + 1 + (t.coupledVehicle ? 1 : 0), 0)
      + sim.stabledPool.length + [...sim.vehicles.values()].filter(v => v.work).length;
    expect(count()).toBe(LINE_INFO.fleet);
    runFor(sim, 3600, check);
    expect(count()).toBe(LINE_INFO.fleet);
    const ids = new Set<string>();
    for (const y of sim.yards) for (const t of y.tracks) for (const v of t) ids.add(v);
    for (const t of sim.trainList) { ids.add(t.vehicle); if (t.coupledVehicle) ids.add(t.coupledVehicle); }
    for (const no of sim.stabledPool) ids.add(no);
    for (const [no, v] of sim.vehicles) if (v.work) ids.add(no);
    expect(ids.size).toBe(LINE_INFO.fleet);
  });

  it('PIS lists the next trains with destinations at a busy station', () => {
    const sim = makeSim('weekday', H);
    const pis = computePis(sim, st(sim, '人民广场').index);
    expect(pis.DN.length).toBeGreaterThan(0);
    expect(pis.UP.length).toBeGreaterThan(0);
    expect(pis.DN[0].eta).toBeLessThan(600);
    expect(pis.DN.every((r, i) => i === 0 || r.eta >= pis.DN[i - 1].eta)).toBe(true);
  });
});

describe('scenario & replay', () => {
  it('a scenario fires its events and produces a scored report', () => {
    const start = 9 * 3600 + 55 * 60;
    const sim = makeSim('weekday', start, { seed: 5, scenario: 'cbtc-tbtc' });
    runUntil(sim, start + 200);
    expect(sim.scenario?.id).toBe('cbtc-tbtc');
    expect(sim.zoneState[1]).toBe('ZCFAIL');
    expect(sim.command({ c: 'zoneLevel', zones: [1], level: 'TBTC' }).ok).toBe(true);
    runFor(sim, 600, check);
    const r = sim.command({ c: 'scenarioEnd' });
    expect(r.ok).toBe(true);
    const rep = sim.scenario!.report!;
    expect(rep.score).toBeGreaterThanOrEqual(0);
    expect(rep.score).toBeLessThanOrEqual(100);
    expect(rep.plannedTrips).toBeGreaterThan(0);
    expect(rep.delivery).toBeGreaterThan(0.5);
  });

  it('a scenario with manual radio starts on a clean line (warm-up is auto-answered)', () => {
    const start = 7 * 3600 + 40 * 60;
    const sim = makeSim('weekday', start, { seed: 13, scenario: 'shr-switch', autoRadio: false });
    expect(sim.autoRadio).toBe(false);
    expect(sim.calls.filter((c) => c.state === 'ringing').length).toBe(0);
    expect(sim.possessions.some((p) => p.state === 'active' || p.state === 'releasing')).toBe(false);
    expect(sim.trainList.filter((t) => t.inService && t.delay > 120).length).toBeLessThanOrEqual(2);
  });

  it('restoring a checkpoint and re-running reproduces the same state', () => {
    const sim = makeSim('weekday', H);
    const cp = capture(sim);
    runFor(sim, 400);
    const a = fingerprint(sim);
    restore(sim, cp);
    expect(sim.t).toBe(cp.t);
    runFor(sim, 400);
    expect(fingerprint(sim)).toBe(a);
    // a command after restore branches the future
    restore(sim, cp);
    const tr = sim.trainList.find((t) => t.inService && t.phase === 'run')!;
    sim.command({ c: 'trainHold', train: tr.id, on: true });
    runFor(sim, 400);
    expect(fingerprint(sim)).not.toBe(a);
  });

  it('platform berth of a station is reachable for PIS / stop logic', () => {
    const sim = makeSim('weekday', H);
    expect(platformBerth(sim.topo, 12, 'DN')).toBeGreaterThanOrEqual(0);
  });
});

describe('DMI logic: movement authority, permitted speed, fleet, message log', () => {
  /** independent walk: rear of the first train ahead (minus safety margin) or the end of the set route */
  const expectedMa = (sim: Sim, tr: import('../src/sim/model').Train) => {
    const { topo } = sim;
    let link = tr.link;
    let dir = tr.dir;
    let d = dir === 1 ? topo.links[link].len - tr.off : tr.off;
    const ahead = (lk: number, dr: number, base: number, sameLink: boolean) => {
      let best = Infinity;
      const len = topo.links[lk].len;
      for (const s of sim.linkBodies.get(lk) ?? []) {
        if (s.train === tr.id) continue;
        const near = dr === 1 ? s.from : len - s.to;
        const dist = base + near;
        if (sameLink && dist < -0.5) continue;
        const o = sim.trains.get(s.train)!;
        best = Math.min(best, dist - (o.comm && o.level === 'CBTC' ? 20 : 25));
      }
      return best;
    };
    const first = ahead(link, dir, -(dir === 1 ? tr.off : topo.links[link].len - tr.off), true);
    if (first < Infinity) return { d: first, why: 'train' };
    for (let guard = 0; guard < 600 && d < 25000; guard++) {
      const nx = nextLink(topo, link, dir, (sw) => sim.sw[sw].pos);
      const lk = topo.links[link];
      if (!nx) return { d: Infinity, why: 'end' };
      const sid = topo.signalByEntry.get((dir === 1 ? lk.b : lk.a) * 65536 + nx.link);
      if (sid !== undefined) {
        const sg = sim.sig[sid];
        const ar = sg.route >= 0 ? sim.routes.get(sg.route) : undefined;
        const set = ar && ar.state === 'locked' && ar.cancelAt === 0 && !(ar.entered && !ar.fleeting) && !ar.guide && !sg.failed;
        if (!set) return { d: d - 6, why: 'route' };
      }
      const t = ahead(nx.link, nx.dir, d, false);
      if (t < Infinity) return { d: t, why: 'train' };
      d += topo.links[nx.link].len;
      link = nx.link;
      dir = nx.dir;
    }
    return { d: Infinity, why: 'cap' };
  };

  it('MA runs to the preceding train rear or the end of the set route, never a fixed length', () => {
    const sim = makeSim('weekday', H);
    let matched = 0;
    let checked = 0;
    let beyondOld = 0;
    const lengths = new Set<number>();
    for (let k = 0; k < 40; k++) {
      runFor(sim, 15, check);
      for (const tr of sim.trainList) {
        if (tr.phase !== 'run' || tr.mode !== 'DTO' || tr.level !== 'CBTC' || !tr.comm || tr.failed || tr.manual) continue;
        const e = expectedMa(sim, tr);
        if (!Number.isFinite(e.d)) continue;
        checked++;
        const ma = scanAhead(sim, tr, goalBerth(tr)).maDist;
        expect(Number.isFinite(ma)).toBe(true);
        // within the per-step supervision range tr.maDist comes from this step's scan,
        // taken before the step's movement (own and preceding train: ≤ 25 m/s × 0.1 s);
        // a train not yet moving off keeps the 1 Hz refresh (movement.ts), up to a second old
        if (ma < MA_NEAR - 50) expect(Math.abs(ma - tr.maDist)).toBeLessThan((tr.v + 25) * (tr.v > 0 ? 0.1 : 1) + 1);
        // other protections (occupied non-CBTC sections, platform doors…) can only shorten it
        expect(ma).toBeLessThanOrEqual(Math.max(0, e.d) + 0.01);
        // a turnback waiting for its departure platform is held short by a
        // protection this model leaves out; the bound above still applies
        if (scanAhead(sim, tr, goalBerth(tr)).maReason === '折返发车站台有车，等待平台出清') { checked--; continue; }
        if (Math.abs(ma - Math.max(0, e.d)) < 0.01) matched++;
        lengths.add(Math.round(ma));
        if (ma > 1400) beyondOld++;
      }
      // the 1 Hz ZC refresh carries the full-length MA for every train
      refreshAuthority(sim);
      for (const tr of sim.trainList) {
        if (tr.phase !== 'run' || tr.manual) continue;
        const full = scanAhead(sim, tr, goalBerth(tr)).maDist;
        expect(tr.maFar).toBeCloseTo(full, 6);
      }
    }
    expect(checked).toBeGreaterThan(300);
    expect(matched / checked).toBeGreaterThan(0.95);
    expect(lengths.size).toBeGreaterThan(100);
    expect(beyondOld).toBeGreaterThan(0);
  });

  it('permitted speed never exceeds 80 km/h and the station approach target is the stopping point at 0 km/h', () => {
    const sim = makeSim('weekday', H);
    let approaches = 0;
    let maxP = 0;
    for (let k = 0; k < 1200; k++) {
      sim.step();
      for (const tr of sim.trainList) {
        maxP = Math.max(maxP, tr.vPermit);
        if (tr.phase !== 'run' || tr.mode !== 'DTO' || tr.v < 0.1) continue;
        expect(tr.vPermit).toBeLessThanOrEqual(tr.vEbi + 1e-9);
        if (Number.isFinite(tr.stopDist) && tr.stopDist < 120 && tr.stopDist < tr.maDist - 1 && tr.tgtReason !== '限速') {
          approaches++;
          expect(tr.tgtReason).toBe('停车点');
          expect(tr.tgtV).toBe(0);
          expect(Math.abs(tr.tgtD - tr.stopDist)).toBeLessThan(0.01);
        }
      }
    }
    expect(maxP).toBeLessThanOrEqual(80 / 3.6 + 1e-9);
    expect(maxP).toBeGreaterThan(75 / 3.6);
    expect(approaches).toBeGreaterThan(50);
  });

  it('fleet numbers are the real Line 2 numbers per type', () => {
    expect(FLEET.length).toBe(100);
    expect(new Set(FLEET.map((f) => f.no)).size).toBe(100);
    const a05 = FLEET.filter((f) => f.type === '02A05').map((f) => f.no);
    expect(a05[0]).toBe('02086');
    expect(a05[a05.length - 1]).toBe('02116');
    expect(a05.length).toBe(31);
    expect(FLEET.filter((f) => f.type === '02A01').map((f) => f.no)).toContain('0216');
    expect(FLEET.some((f) => f.no >= '0217' && f.no <= '0232' && f.no.length === 4)).toBe(false);
    const sim = makeSim('weekday', H);
    for (const tr of sim.trainList) expect(fleetEntry(tr.vehicle)).toBeDefined();
    expect(dmiTrainNo('0213')).toBe('T2013');
    expect(dmiTrainNo('02086')).toBe('T2086');
  });

  it('DMI log records link loss, emergency brake and availability; snapshot carries it', () => {
    const sim = makeSim('weekday', H);
    const tr = sim.trainList.find((t) => t.inService && t.phase === 'run' && t.v > 5 && sim.trainChain(t) > 9000 && sim.trainChain(t) < 30000)!;
    runFor(sim, 2);
    expect(tr.dmiLog.some((m) => m.m === 'DMI激活')).toBe(true);
    sim.command({ c: 'fault', kind: 'trainComm', target: tr.id, duration: 3000 });
    runFor(sim, 5, check);
    const msgs = tr.dmiLog.map((m) => m.m);
    expect(msgs).toContain('连接丢失');
    expect(msgs.some((m) => m.startsWith('紧急制动'))).toBe(true);
    expect(msgs).toContain('ATPM模式可用');
    expect(msgs).toContain('定位已确认');
    sim.dmiTrain = tr.id;
    const d = sim.snapshot().dmi!;
    expect(d.trainNo).toMatch(/^T\d{4}$/);
    expect(d.log[0].t).toBeGreaterThanOrEqual(d.log[d.log.length - 1].t);
    expect(d.avail).toEqual({ mode: 'AM', level: 'TBTC' });
  });
});
