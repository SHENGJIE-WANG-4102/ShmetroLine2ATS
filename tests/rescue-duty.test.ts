import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import type { StopTask, Train, Trip } from '../src/sim/model';
import { cmdRescue, cmdWithdraw, cmdTurnback, cmdRecoverService, recoverTrain, updateTrainTasks, setTripFromTasks } from '../src/sim/ats';
import { computeBody, indexBodies, reverseTrain } from '../src/sim/movement';
import { releaseRoute } from '../src/sim/interlocking';
import { platformBerth, tripTasks, buildStops, entryStation, TEMPLATES } from '../src/sim/timetable';
import { capture, restore } from '../src/sim/state';
import { carryTrains, DAY_S } from '../src/sim/operatingDay';
import { closeDoors, openDoors, doorMotionTick } from '../src/sim/psd';
import { cmdStandbyRelief } from '../src/sim/standby';
import { vehicleTick } from '../src/sim/vehicle';
import { fixtureTrains } from './helpers/fixture-train';

function fixture(peak: boolean, dwell = false) {
  const sim = new Sim({ dayType: 'weekday', dateLabel: 'rescue-duty', startTime: 14400,
    seed: 7, noPossessions: true, autoRadio: false, autoDispatch: false });
  const [rescuer, failed] = fixtureTrains(sim, 2);
  for (const tr of [...sim.trainList]) if (tr !== rescuer && tr !== failed) sim.removeTrain(tr);
  for (const rid of [...sim.routes.keys()]) releaseRoute(sim, rid);
  const period = sim.plan.periods.find(p => !!TEMPLATES[p.template]?.peak === peak)!;
  expect(period).toBeDefined();
  sim.t = (period.from + period.to) / 2;
  for (const [tr, station] of [[rescuer, 29], [failed, 28]] as const) {
    const berth = sim.topo.berths[platformBerth(sim.topo, station, 'UP')];
    // Keep an intermediate clearing platform and a reachable failed rake.
    // HTS→LKL exceeds the existing 8 km rescue search; place the failure just
    // beyond YDD instead of bypassing the command's physical-path guard.
    const chain = sim.topo.stations[station].chain - 400;
    const link = tr === failed ? sim.topo.links.find(link => link.track === 'UP'
      && Math.min(link.chainA, link.chainB) <= chain && chain <= Math.max(link.chainA, link.chainB))!
      : sim.topo.links[berth.link];
    const off = tr === failed ? (chain - link.chainA) / (link.chainB - link.chainA) * link.len : berth.offset;
    Object.assign(tr, { block: -1, tripId: -1, v: 0, eb: false, failed: tr === failed,
      hold: false, vfault: null, manual: false, atoDriver: false, inService: true,
      doorsOpen: false, doorsAwait: false, doorSide: '', doorMotion: undefined, doorLockedAt: 0,
      tbStage: 'none', depotStage: 'none', recentBody: undefined, phase: 'run',
      link: link.id, off, dir: berth.dir, hist: [{ link: link.id, dir: berth.dir }],
      rescuing: -1, rescueBy: -1, coupledLen: 0, rescueDuty: undefined, mode: 'DTO',
      load: tr === failed ? 700 : 450, svc: tr === failed ? 'F' : 'R' });
    tr.tasks = [{ k: 'stop', station: 26, berth: platformBerth(sim.topo, 26, 'UP'),
      trip: -1, arr: sim.t + 300, dep: sim.t + 330, doors: true, revenue: true }];
    computeBody(sim, tr);
  }
  if (dwell) {
    const berth = platformBerth(sim.topo, 29, 'UP');
    rescuer.tasks.unshift({ k: 'stop', berth, station: 29, trip: -1, arr: sim.t - 10,
      dep: sim.t + 30, doors: true, revenue: true });
    rescuer.phase = 'dwell'; rescuer.dwellUntil = sim.t + 30;
  }
  indexBodies(sim);
  return { sim, rescuer, failed, period };
}

function ownDuty(sim: Sim, tr: Train) {
  const block = sim.plan.blocks.length, id = sim.plan.trips.length;
  const trip: Trip = { id, no: '原车次', dir: 'UP', kind: 'big', from: 29, to: 0,
    stops: buildStops(sim.planCtx, 'UP', 29, 0, sim.t, true, 1), revenue: true, block };
  sim.plan.trips.push(trip);
  sim.plan.blocks.push({ id: block, svc: '原表', start: { kind: 'depot', depot: 2, time: sim.t - 500 },
    end: { kind: 'depot', depot: 0 }, trips: [id], train: tr.id });
  tr.block = block; tr.tripId = id; tr.tripNo = trip.no; tr.svc = '原表';
  tr.tasks = []; tripTasks(sim.topo, trip, tr.tasks, false);
  return trip;
}

/** Put the current stop at its real mark and run arrival without advancing
 * the pending door clock. This exposes cancellation during autoOpenAt. */
function arriveBeforeOpening(sim: Sim, tr: Train) {
  if (tr.doorsOpen) {
    closeDoors(sim, tr, sim.plat.findIndex(p => p.psdTrain === tr.id));
    sim.t = tr.doorLockedAt!; doorMotionTick(sim);
  }
  const task = tr.tasks[0] as StopTask, berth = sim.topo.berths[task.berth];
  Object.assign(tr, { link: berth.link, off: berth.offset, dir: berth.dir,
    hist: [{ link: berth.link, dir: berth.dir }], phase: 'run', v: 0, stopDist: 0,
    doorsOpen: false, doorsAwait: false, doorMotion: undefined, autoOpenAt: undefined });
  computeBody(sim, tr); indexBodies(sim);
  updateTrainTasks(sim, tr);
}

/** Perform the real delayed opening after physical arrival. */
function openAtCurrentStop(sim: Sim, tr: Train) {
  arriveBeforeOpening(sim, tr);
  if (tr.autoOpenAt !== undefined) {
    sim.t = tr.autoOpenAt;
    updateTrainTasks(sim, tr);
    doorMotionTick(sim);
  }
}

describe('rescue orders retain a cancellable original duty', () => {
  it.each([true, false])('restores both orders and the original live plan before coupling (peak=%s)', peak => {
    const { sim, rescuer, failed } = fixture(peak);
    const trip = ownDuty(sim, rescuer), original = structuredClone(rescuer.tasks);
    const before = JSON.stringify([sim.plan.trips, sim.plan.blocks]);
    expect(cmdRescue(sim, failed, rescuer).ok).toBe(true);
    expect(JSON.stringify([sim.plan.trips, sim.plan.blocks])).toBe(before);
    expect(trip.cancelled).not.toBe(true);
    expect(cmdRescue(sim, failed, rescuer).ok).toBe(false);
    Object.assign(rescuer, { mode: 'RM', rmAuth: 300, rmSig: 3, rmReason: '救援连挂', phase: 'coupling' });
    recoverTrain(sim, failed);
    expect(failed.failed).toBe(false); expect(failed.rescueBy).toBe(-1);
    expect(rescuer.rescuing).toBe(-1); expect(rescuer.rescueDuty).toBeUndefined();
    expect(rescuer.tasks).toEqual(original); expect(rescuer.tripNo).toBe(trip.no);
    expect(rescuer.inService).toBe(true); expect(rescuer.mode).toBe('DTO');
    expect(rescuer.rmAuth).toBe(0); expect(rescuer.rmSig).toBe(-1); expect(rescuer.rmReason).toBe('');
    expect(rescuer.phase).toBe('run');
    expect(JSON.stringify([sim.plan.trips, sim.plan.blocks])).toBe(before);
  });

  it('restores the current passenger stop if recovery precedes the actual clear-out', () => {
    const { sim, rescuer, failed } = fixture(false, true), load = rescuer.load;
    arriveBeforeOpening(sim, rescuer);
    const original = structuredClone(rescuer.tasks), openAt = rescuer.autoOpenAt!;
    expect(rescuer.phase).toBe('dwell'); expect(rescuer.doorsAwait).toBe(true);
    expect(cmdRescue(sim, failed, rescuer).ok).toBe(true);
    expect(rescuer.rescueDuty?.cleared).not.toBe(true);
    expect(rescuer.tasks[0]).toMatchObject({k:'stop',revenue:false,note:'救援清客'});
    recoverTrain(sim, failed);
    expect(rescuer.tasks).toEqual(original); expect(rescuer.load).toBe(load);
    expect(rescuer.rescueDuty).toBeUndefined(); expect(rescuer.inService).toBe(true);
    expect(rescuer.phase).toBe('dwell'); expect(rescuer.autoOpenAt).toBe(openAt);
    sim.t = openAt; updateTrainTasks(sim, rescuer); doorMotionTick(sim);
    expect(rescuer.tasks[0]).toMatchObject({k:'stop',revenue:true});
    expect(rescuer.load).toBeGreaterThan(0); expect(sim.passengersCleared).toBe(0);
  });

  it('cancels an unopened temporary station X without opening the original farther station Y', () => {
    const { sim, rescuer, failed } = fixture(false), original = structuredClone(rescuer.tasks), load = rescuer.load;
    expect(cmdRescue(sim, failed, rescuer).ok).toBe(true);
    const x = rescuer.tasks[0] as StopTask, y = original[0] as StopTask;
    expect(x.station).not.toBe(y.station);
    arriveBeforeOpening(sim, rescuer);
    const openAt = rescuer.autoOpenAt!, xp = sim.topo.berths[x.berth].platform, yp = sim.topo.berths[y.berth].platform;
    expect(rescuer.doorsAwait).toBe(true); expect(rescuer.rescueDuty?.cleared).not.toBe(true);
    recoverTrain(sim, failed);
    expect(rescuer.tasks).toEqual(original); expect(rescuer.phase).toBe('run');
    expect(rescuer.doorsAwait).toBe(false); expect(rescuer.autoOpenAt).toBeUndefined();
    expect(rescuer.doorExchange).toBeUndefined(); expect(rescuer.stopDist).toBe(Infinity);
    sim.t = openAt; updateTrainTasks(sim, rescuer); doorMotionTick(sim);
    expect(rescuer.phase).toBe('run'); expect(rescuer.load).toBe(load); expect(rescuer.doorsOpen).toBe(false);
    expect(sim.passengersCleared).toBe(0); expect(sim.passengersServed).toBe(0);
    expect(sim.plat[xp]).toMatchObject({ psd: 'closed', psdTrain: -1 });
    expect(sim.plat[yp]).toMatchObject({ psd: 'closed', psdTrain: -1 });
    expect(rescuer.link).toBe(sim.topo.berths[x.berth].link);
  });

  it('keeps an existing physical door cycle at temporary X without clearing or boarding before Y', () => {
    const { sim, rescuer, failed } = fixture(false), original = structuredClone(rescuer.tasks), load = rescuer.load;
    expect(cmdRescue(sim, failed, rescuer).ok).toBe(true);
    const x = rescuer.tasks[0] as StopTask, y = original[0] as StopTask;
    arriveBeforeOpening(sim, rescuer);
    const xp = sim.topo.berths[x.berth].platform, yp = sim.topo.berths[y.berth].platform;
    // A physical door operation can exist independently of the ATS exchange.
    // Do not replace it with a fake open/exchange at the restored remote task.
    rescuer.doorsAwait = false; openDoors(sim, rescuer, xp);
    sim.t += .3; doorMotionTick(sim);
    const queue = sim.topo.platforms[xp].pool ?? xp; sim.plat[queue].waiting = 100;
    recoverTrain(sim, failed);
    expect(rescuer.phase).toBe('dwell');
    expect(rescuer.tasks[0]).toMatchObject({ k: 'stop', berth: x.berth, doors: false, revenue: true, noBoard: true });
    expect(rescuer.tasks.slice(1)).toEqual(original);
    expect(rescuer.autoOpenAt).toBeUndefined(); expect(rescuer.doorExchange).toBeUndefined();
    updateTrainTasks(sim, rescuer);
    // The recovered leading train still physically occupies the restricted
    // interval. Keep that ordinary closing hold until its body has moved on.
    expect(rescuer.intervalWait?.train).toBe(failed.id);
    expect(rescuer.doorsOpen).toBe(true); expect(rescuer.doorMotion).toBeUndefined();
    expect(rescuer.load).toBe(load); expect(sim.plat[queue].waiting).toBe(100);
    expect(sim.passengersCleared).toBe(0); expect(sim.passengersServed).toBe(0);
    const ahead = sim.topo.berths[y.berth];
    Object.assign(failed, { link: ahead.link, off: ahead.offset, dir: ahead.dir,
      hist: [{ link: ahead.link, dir: ahead.dir }] });
    computeBody(sim, failed); indexBodies(sim);
    updateTrainTasks(sim, rescuer);
    expect(rescuer.intervalWait).toBeUndefined();
    expect(rescuer.doorMotion?.kind).toBe('closing');
    expect(rescuer.load).toBe(load); expect(sim.passengersCleared).toBe(0); expect(sim.passengersServed).toBe(0);
    expect(sim.plat[yp]).toMatchObject({ psd: 'closed', psdTrain: -1 });
    sim.t = Math.max(rescuer.doorLockedAt!, rescuer.autoStartAt ?? 0);
    doorMotionTick(sim); updateTrainTasks(sim, rescuer);
    expect(rescuer.phase).toBe('run'); expect(rescuer.tasks).toEqual(original);
    expect(rescuer.load).toBe(load); expect(sim.plat[queue].waiting).toBe(100);
  });

  it('retains a completed temporary X clear-out and resumes boarding only at the next station', () => {
    const { sim, rescuer, failed } = fixture(false), original = structuredClone(rescuer.tasks);
    expect(cmdRescue(sim, failed, rescuer).ok).toBe(true);
    const x = rescuer.tasks[0] as StopTask;
    openAtCurrentStop(sim, rescuer);
    expect(rescuer.rescueDuty?.cleared).toBe(true); expect(rescuer.load).toBe(0);
    recoverTrain(sim, failed);
    expect(rescuer.phase).toBe('dwell'); expect(rescuer.tasks[0]).toMatchObject({ berth: x.berth, revenue: false });
    expect(rescuer.tasks[1]).toMatchObject({ station: 27, doors: true, revenue: true });
    expect(rescuer.tasks[2]).toEqual(original[0]);
    updateTrainTasks(sim, rescuer);
    expect(rescuer.load).toBe(0); expect(sim.passengersCleared).toBe(450); expect(sim.passengersServed).toBe(0);
  });

  it('resumes at the next station after a completed clear-out without boarding at the cleared platform', () => {
    const { sim, rescuer, failed } = fixture(false, true);
    const original = structuredClone(rescuer.tasks);
    rescuer.doorsOpen = true;
    expect(cmdRescue(sim, failed, rescuer).ok).toBe(true);
    expect(rescuer.load).toBe(0); expect(rescuer.rescueDuty?.cleared).toBe(true);
    expect(rescuer.rescueDuty?.tasks).toEqual(original);
    recoverTrain(sim, failed);
    expect(rescuer.tasks[0]).toMatchObject({ k: 'stop', station: 29, revenue: false });
    expect(rescuer.tasks[1]).toMatchObject({ k: 'stop', station: 28, revenue: true, doors: true });
    expect(rescuer.tasks[2]).toEqual(original[1]);
    expect(rescuer.load).toBe(0);
    rescuer.tasks.shift();
    const platform = sim.topo.berths[(rescuer.tasks[0] as StopTask).berth].platform;
    const queue = sim.topo.platforms[platform].pool ?? platform;
    sim.plat[queue].waiting = 100;
    openAtCurrentStop(sim, rescuer);
    expect(rescuer.load).toBe(100); expect(sim.passengersServed).toBe(100);
  });

  it('preserves passengers during a peak station dwell and excludes rescue from normal duty takeover', () => {
    const { sim, rescuer, failed } = fixture(true, true);
    const original = rescuer.tasks[0];
    expect(cmdRescue(sim, failed, rescuer).ok).toBe(true);
    expect(rescuer.tasks[0]).toEqual(original);
    expect(rescuer.load).toBe(450); expect(rescuer.inService).toBe(true);
    expect(rescuer.tasks.filter(t => t.k === 'stop' && !t.revenue)).toHaveLength(0);
    expect(cmdStandbyRelief(sim, rescuer).ok).toBe(false);
    expect(rescuer.rescuing).toBe(failed.id);
  });

  it('clears stale target references even if the assigned rescuer is no longer present', () => {
    const { sim, failed } = fixture(false);
    failed.rescueBy = 987654;
    recoverTrain(sim, failed);
    expect(failed.rescueBy).toBe(-1); expect(failed.failed).toBe(false);
  });

  it('takes the peak decision from the current line period data', () => {
    const { sim, rescuer, failed } = fixture(false);
    const peak = sim.plan.periods.find(p => TEMPLATES[p.template]?.peak)!;
    sim.plan.periods = [{ ...peak, from: sim.t - 10, to: sim.t + 10 }];
    expect(cmdRescue(sim, failed, rescuer).ok).toBe(true);
    expect(rescuer.rescueDuty?.peak).toBe(true);
    expect(rescuer.tasks.every(t => t.k === 'rescue')).toBe(true);
    expect(rescuer.load).toBe(450);
  });

  it('restores the failed terminal-tail train to its original cab, tasks and turnback stage', () => {
    const { sim, rescuer, failed } = fixture(true);
    const station = sim.topo.stations.length - 1;
    const tail = sim.topo.stations[station].rescueBerths.map(id => sim.topo.berths[id])
      .find(b => b.dir === 1 && sim.topo.sections[sim.topo.links[b.link].section].kind === 'tail')!;
    const platform = sim.topo.berths[platformBerth(sim.topo, station, 'DN')];
    Object.assign(failed, { link: tail.link, off: tail.offset, dir: tail.dir,
      hist: [{ link: tail.link, dir: tail.dir }], tbStage: 'manual', tbExitSig: 123 });
    computeBody(sim, failed); reverseTrain(sim, failed);
    Object.assign(rescuer, { link: platform.link, off: platform.offset, dir: platform.dir,
      hist: [{ link: platform.link, dir: platform.dir }] });
    computeBody(sim, rescuer);
    failed.tasks = [{ k: 'stop', berth: platformBerth(sim.topo, station, 'UP'), station,
      trip: -1, arr: null, dep: sim.t, doors: true, revenue: true }];
    indexBodies(sim);
    const body = structuredClone(failed.body), direction = failed.dir, tasks = structuredClone(failed.tasks);
    expect(cmdRescue(sim, failed, rescuer).ok).toBe(true);
    expect(failed.rescueReverse).toBe(true); expect(failed.dir).not.toBe(direction);
    recoverTrain(sim, failed);
    expect(failed.dir).toBe(direction); expect(failed.body).toEqual(body); expect(failed.tasks).toEqual(tasks);
    expect(failed.tbStage).toBe('manual'); expect(failed.tbExitSig).toBe(123);
    expect(failed.rescueReverse).toBe(false); expect(failed.rescueBy).toBe(-1);
  });
});

describe('rescue assignments survive routine task replacement', () => {
  it.each(['rescuer', 'failed'] as const)('rejects single-train withdrawal, turnback and timetable recovery for the uncoupled %s', role => {
    const { sim, rescuer, failed } = fixture(true, true);
    expect(cmdRescue(sim, failed, rescuer).ok).toBe(true);
    const tr = role === 'rescuer' ? rescuer : failed;
    const before = structuredClone({ tasks: tr.tasks, duty: rescuer.rescueDuty,
      rescuing: rescuer.rescuing, rescueBy: failed.rescueBy, trips: sim.plan.trips, blocks: sim.plan.blocks });
    for (const result of [cmdWithdraw(sim, tr), cmdTurnback(sim, tr, 0), cmdRecoverService(sim, tr)]) {
      expect(result.ok).toBe(false); expect(result.msg).toContain('救援');
    }
    expect({ tasks: tr.tasks, duty: rescuer.rescueDuty, rescuing: rescuer.rescuing, rescueBy: failed.rescueBy,
      trips: sim.plan.trips, blocks: sim.plan.blocks }).toEqual(before);
  });

  it('keeps a routine minor-fault withdrawal pending until the rescue is released', () => {
    const { sim, rescuer, failed } = fixture(true, true), trip = ownDuty(sim, rescuer);
    const current = rescuer.tasks[0] as StopTask;
    rescuer.tasks[0] = { ...current, dep: null }; trip.completed = true;
    rescuer.withdrawAtEnd = true;
    expect(cmdRescue(sim, failed, rescuer).ok).toBe(true);
    const tasks = structuredClone(rescuer.tasks), original = structuredClone(rescuer.rescueDuty);
    vehicleTick(sim);
    expect(rescuer.tasks).toEqual(tasks); expect(rescuer.rescueDuty).toEqual(original);
    expect(rescuer.withdrawAtEnd).toBe(true); expect(rescuer.withdrawn).toBe(false);
    expect(rescuer.rescuing).toBe(failed.id); expect(failed.rescueBy).toBe(rescuer.id);
    expect(trip.cancelled).not.toBe(true);
    recoverTrain(sim, failed); vehicleTick(sim);
    expect(rescuer.rescuing).toBe(-1); expect(failed.rescueBy).toBe(-1);
    expect(rescuer.withdrawAtEnd).toBe(false); expect(rescuer.withdrawn).toBe(true);
    expect(rescuer.tasks.some(t => t.k === 'depot')).toBe(true);
  });

  it('still applies a severe brake failure while routine withdrawal is deferred', () => {
    const { sim, rescuer, failed } = fixture(true, true);
    expect(cmdRescue(sim, failed, rescuer).ok).toBe(true);
    rescuer.withdrawAtEnd = true;
    rescuer.vfault = { kind: 'brake', sev: 2, stage: 'stuck', until: sim.t,
      fault: -1, recover: false, car: 1, door: 0 };
    vehicleTick(sim);
    expect(rescuer.failed).toBe(true); expect(rescuer.vfault).toBeNull();
    expect(rescuer.withdrawAtEnd).toBe(true); expect(rescuer.rescuing).toBe(failed.id);
    expect(rescuer.tasks.some(t => t.k === 'rescue' && t.target === failed.id)).toBe(true);
    expect(sim.faults.some(f => f.kind === 'trainFail' && f.target === rescuer.id && !f.repaired)).toBe(true);
  });

  it.each(['run', 'dwell'] as const)('continues to accept an explicit clear-out and return command for a coupled rescue formation (%s)', phase => {
    const { sim, rescuer, failed } = fixture(true);
    expect(cmdRescue(sim, failed, rescuer).ok).toBe(true);
    rescuer.tasks = [{ k: 'rescue', target: failed.id }];
    rescuer.phase = 'coupling'; rescuer.dwellUntil = sim.t;
    updateTrainTasks(sim, rescuer);
    expect(rescuer.coupledLen).toBe(failed.len);
    if (phase === 'dwell') openAtCurrentStop(sim, rescuer);
    expect(cmdWithdraw(sim, rescuer, '人工明确清客回段').ok).toBe(true);
    expect(rescuer.withdrawn).toBe(true); expect(rescuer.coupledLen).toBe(failed.len);
    expect(rescuer.tasks.some(t => t.k === 'depot')).toBe(true);
    if (phase === 'run') openAtCurrentStop(sim, rescuer);
    expect(rescuer.load).toBe(0); expect(rescuer.rescueFailedLoad).toBe(0);
    expect(sim.passengersCleared).toBe(1150);
  });
});

describe('peak rescue clears each rake at its own stop', () => {
  it('does not clear the rescuing passengers while PSD failure or its bypass holds the first clear-out', () => {
    const { sim, rescuer, failed } = fixture(true);
    expect(cmdRescue(sim, failed, rescuer).ok).toBe(true);
    rescuer.tasks = [{ k: 'rescue', target: failed.id }];
    rescuer.phase = 'coupling'; rescuer.dwellUntil = sim.t;
    updateTrainTasks(sim, rescuer); openAtCurrentStop(sim, rescuer);
    sim.t += .3; doorMotionTick(sim);
    const platform = sim.topo.berths[(rescuer.tasks[0] as StopTask).berth].platform;
    sim.plat[platform].psdFault = true;
    expect(closeDoors(sim, rescuer, platform)).toBe(-1);
    expect(sim.plat[platform].psd).toBe('closeFail');
    sim.t += 180; updateTrainTasks(sim, rescuer);
    expect(rescuer.phase).toBe('dwell'); expect(rescuer.load).toBe(450);
    expect(sim.passengersCleared).toBe(700);
    expect(sim.command({ c: 'psdBypass', platform, on: true }).ok).toBe(true);
    updateTrainTasks(sim, rescuer);
    expect(rescuer.load).toBe(450); expect(sim.passengersCleared).toBe(700);
  });

  it('cancels the rescuing duty at physical coupling while retaining completed trips', () => {
    const { sim, rescuer, failed } = fixture(true);
    const current = ownDuty(sim, rescuer), block = sim.plan.blocks[rescuer.block];
    const completed: Trip = { ...current, id: sim.plan.trips.length, no: '已完成', completed: true };
    sim.plan.trips.push(completed); block.trips.unshift(completed.id);
    expect(cmdRescue(sim, failed, rescuer).ok).toBe(true);
    expect(current.cancelled).not.toBe(true); expect(completed.cancelled).not.toBe(true);
    rescuer.tasks = [{ k: 'rescue', target: failed.id }];
    rescuer.phase = 'coupling'; rescuer.dwellUntil = sim.t;
    updateTrainTasks(sim, rescuer);
    expect(current.cancelled).toBe(true); expect(current.cancelReason).toContain('救援');
    expect(completed.completed).toBe(true); expect(completed.cancelled).not.toBe(true);
    expect(rescuer.rescueDuty).toBeUndefined(); expect(sim.trains.has(failed.id)).toBe(false);
  });

  it.each([true, false])('derives the final clear-out from the actual depot portal (peak=%s)', peak => {
    const { sim, rescuer, failed } = fixture(peak);
    expect(cmdRescue(sim, failed, rescuer).ok).toBe(true);
    // Complete only the physical coupling event; a station-clear task from
    // the off-peak approach must not be mistaken for a coupling instruction.
    rescuer.tasks = [{ k: 'rescue', target: failed.id }];
    rescuer.phase = 'coupling'; rescuer.dwellUntil = sim.t;
    updateTrainTasks(sim, rescuer);
    expect(sim.trains.has(failed.id)).toBe(false);
    expect(rescuer.rescueDuty).toBeUndefined(); expect(rescuer.coupledLen).toBe(failed.len);
    expect(rescuer.load).toBe(1150); expect(rescuer.rescueFailedLoad).toBe(700);
    const stops = rescuer.tasks.filter((t): t is StopTask => t.k === 'stop' && !t.depotWork);
    expect(stops[0].rescueClear).toBe(peak ? 'failed' : 'all');
    if (peak) {
      const final = stops.find(t => t.rescueClear === 'all')!;
      const home = rescuer.tasks.find(t => t.k === 'depot')!;
      expect(home.k).toBe('depot');
      if (home.k !== 'depot') throw new Error('rescue has no actual depot task');
      const dir = sim.topo.platforms[sim.topo.berths[final.berth].platform].track as 'DN' | 'UP';
      expect(final.station).toBe(entryStation(sim.topo, home.depot, dir));
      openAtCurrentStop(sim, rescuer);
      expect(rescuer.load).toBe(450); expect(rescuer.rescueFailedLoad).toBe(0);
      expect(sim.passengersCleared).toBe(700); expect(sim.metrics.cleared).toBe(700);
      // Repeated dwell ticks cannot clear the rescuing rake or double count.
      updateTrainTasks(sim, rescuer);
      expect(rescuer.load).toBe(450); expect(sim.passengersCleared).toBe(700);
      rescuer.tasks = rescuer.tasks.slice(rescuer.tasks.indexOf(final));
      openAtCurrentStop(sim, rescuer);
      expect(rescuer.load).toBe(0); expect(rescuer.inService).toBe(false);
      expect(sim.passengersCleared).toBe(1150); expect(sim.metrics.cleared).toBe(1150);
    } else {
      openAtCurrentStop(sim, rescuer);
      expect(rescuer.load).toBe(0); expect(sim.passengersCleared).toBe(1150);
      expect(stops.filter(t => t.rescueClear === 'all')).toHaveLength(1);
    }
    // A coupled formation cannot restore a passenger duty through the
    // pre-coupling cancellation branch when its own fault is repaired.
    const tasks = structuredClone(rescuer.tasks);
    rescuer.failed = true; recoverTrain(sim, rescuer);
    expect(rescuer.tasks).toEqual(tasks); expect(rescuer.coupledLen).toBe(failed.len);
  });
});

describe('rescue duty snapshots follow the real vehicle', () => {
  it('does not share saved task arrays across rewind checkpoints', () => {
    const { sim, rescuer, failed } = fixture(true);
    ownDuty(sim, rescuer);
    expect(cmdRescue(sim, failed, rescuer).ok).toBe(true);
    const cp = capture(sim), saved = structuredClone(rescuer.rescueDuty);
    rescuer.rescueDuty!.tasks.shift();
    restore(sim, cp);
    expect(sim.trains.get(rescuer.id)!.rescueDuty).toEqual(saved);
    sim.trains.get(rescuer.id)!.rescueDuty!.tasks.shift();
    restore(sim, cp);
    expect(sim.trains.get(rescuer.id)!.rescueDuty).toEqual(saved);
  });

  it('remaps suspended task trips and clocks at rollover, then restores that carried duty', () => {
    const { sim: old, rescuer, failed } = fixture(true);
    const trip = ownDuty(old, rescuer), time = trip.stops[0].dep;
    expect(cmdRescue(old, failed, rescuer).ok).toBe(true);
    const next = new Sim({ dayType: 'weekday', dateLabel: 'next-rescue-day', startTime: 14400,
      seed: 8, noPossessions: true, autoRadio: false, autoDispatch: false });
    for (const tr of [...next.trainList]) next.removeTrain(tr);
    next.t = old.t - DAY_S;
    carryTrains(next, old);
    const carried = next.trains.get(rescuer.id)!, target = next.trains.get(failed.id)!;
    const task = carried.rescueDuty!.tasks[0] as StopTask;
    expect(task.dep).toBe(time - DAY_S);
    expect(next.plan.trips[task.trip].block).toBe(carried.block);
    expect(next.plan.trips[task.trip].no).toBe(trip.no);
    expect(task.trip).toBe(carried.tripId);
    recoverTrain(next, target);
    expect(carried.rescuing).toBe(-1); expect(target.rescueBy).toBe(-1);
    expect(carried.tasks[0]).toEqual(task);
    expect(next.plan.trips[task.trip].cancelled).not.toBe(true);
    expect(old.trains.get(rescuer.id)!.rescueDuty!.tasks[0]).toMatchObject({ trip: trip.id, dep: time });
    setTripFromTasks(next, carried);
    expect(carried.tripNo).toBe(trip.no);
  });
});
