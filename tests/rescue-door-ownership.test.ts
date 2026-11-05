import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { rescueCouplingDoorWait, updateTrainTasks } from '../src/sim/ats';
import { classify } from '../src/sim/halt';
import { computeBody, indexBodies } from '../src/sim/movement';
import { platformBerth } from '../src/sim/timetable';
import { closeDoors, doorMotionTick, openDoors, psdRepaired, psdTick } from '../src/sim/psd';
import { fixtureTrains } from './helpers/fixture-train';

function fixture() {
  const sim = new Sim({ dayType: 'weekday', dateLabel: 'rescue-door-owner', startTime: 14400,
    seed: 7, noPossessions: true, autoRadio: false, autoDispatch: false });
  const [rescuer, failed] = fixtureTrains(sim, 2);
  for (const tr of [...sim.trainList]) if (tr !== rescuer && tr !== failed) sim.removeTrain(tr);
  const berth = sim.topo.berths[platformBerth(sim.topo, 8, 'DN')];
  const link = sim.topo.links[berth.link];
  const previous = sim.topo.links.find(l => l.track === link.track
    && (berth.dir === 1 ? l.b === link.a : l.a === link.b))!;
  for (const tr of [rescuer, failed]) Object.assign(tr, { block: -1, tripId: -1, v: 0,
    eb: false, failed: false, hold: false, vfault: null, manual: false, atoDriver: false,
    doorsOpen: false, doorsAwait: false, doorSide: '', doorMotion: undefined, doorLockedAt: 0,
    tbStage: 'none', depotStage: 'none', recentBody: undefined, inService: false });
  Object.assign(failed, { link: berth.link, off: berth.offset, dir: berth.dir,
    hist: [{ link: berth.link, dir: berth.dir }], failed: true, phase: 'dwell' });
  failed.tasks = [{ k: 'stop', berth: berth.id, station: berth.station, trip: -1,
    arr: sim.t, dep: sim.t, doors: true, revenue: true }];
  Object.assign(rescuer, { link: previous.id, off: berth.dir === 1 ? previous.len - 1 : 1,
    dir: berth.dir, hist: [{ link: previous.id, dir: berth.dir }], phase: 'coupling',
    dwellUntil: sim.t, rescuing: failed.id });
  failed.rescueBy = rescuer.id;
  rescuer.tasks = [{ k: 'rescue', target: failed.id }];
  computeBody(sim, failed); computeBody(sim, rescuer); indexBodies(sim);
  openDoors(sim, failed, berth.platform);
  sim.t += .3; doorMotionTick(sim);
  return { sim, rescuer, failed, ps: sim.plat[berth.platform], berth };
}

describe('rescue keeps the failed train as door owner until physical lock', () => {
  it('closes the failed train and PSD before merging, leaving no orphan open platform', () => {
    const { sim, rescuer, failed, ps } = fixture(), originalLength = rescuer.len;
    updateTrainTasks(sim, rescuer);
    expect(sim.trains.has(failed.id)).toBe(true);
    expect(rescuer.len).toBe(originalLength);
    expect(rescuer.tasks[0]).toMatchObject({ k: 'rescue', target: failed.id });
    expect(failed.doorMotion?.kind).toBe('closing');
    expect(classify(sim, rescuer)).toMatchObject({ code: 'PSD_FAULT' });
    sim.t = failed.doorMotion!.psdAt; doorMotionTick(sim);
    expect(ps.psd).toBe('closed'); expect(failed.doorsOpen).toBe(true);
    expect(classify(sim, rescuer)).toMatchObject({ code: 'DWELL' });
    updateTrainTasks(sim, rescuer); expect(sim.trains.has(failed.id)).toBe(true);
    sim.t = failed.doorLockedAt!; doorMotionTick(sim); updateTrainTasks(sim, rescuer);
    expect(sim.trains.has(failed.id)).toBe(false);
    expect(rescuer.len).toBe(originalLength + failed.len + 1);
    psdTick(sim); expect(ps.psd).toBe('closed'); expect(ps.psdTrain).toBe(-1);
  });

  it('keeps the failed train and true PSD cause while a door fault prevents closure', () => {
    const { sim, rescuer, failed, ps, berth } = fixture(), originalLength = rescuer.len;
    ps.psdFault = true;
    updateTrainTasks(sim, rescuer);
    expect(ps.psd).toBe('closeFail'); expect(ps.psdTrain).toBe(failed.id);
    expect(classify(sim, rescuer)).toMatchObject({ code: 'PSD_FAULT', train: -1 });
    expect(classify(sim, rescuer).detail).toContain(sim.topo.platforms[berth.platform].name);
    sim.t += 120; doorMotionTick(sim); updateTrainTasks(sim, rescuer);
    expect(sim.trains.has(failed.id)).toBe(true); expect(rescuer.len).toBe(originalLength);
    expect(ps.psdBypass).toBe(false); expect(sim.inputLog).toEqual([]);
    psdRepaired(sim, berth.platform);
    expect(rescueCouplingDoorWait(sim, rescuer)?.code).toBe('DWELL');
    sim.t = failed.doorLockedAt!; doorMotionTick(sim); updateTrainTasks(sim, rescuer);
    expect(sim.trains.has(failed.id)).toBe(false); expect(ps.psd).toBe('closed');
  });

  it('preserves an in-progress physical close instead of restarting its clock', () => {
    const { sim, rescuer, failed, berth } = fixture();
    closeDoors(sim, failed, berth.platform);
    const motion = failed.doorMotion, deadline = failed.doorLockedAt;
    updateTrainTasks(sim, rescuer);
    expect(failed.doorMotion).toBe(motion); expect(failed.doorLockedAt).toBe(deadline);
    expect(sim.trains.has(failed.id)).toBe(true);
    sim.t = deadline!; doorMotionTick(sim);
    expect(rescueCouplingDoorWait(sim, rescuer)).toBeUndefined();
    expect(classify(sim, rescuer)).toMatchObject({ code: 'COUPLING' });
  });
});
