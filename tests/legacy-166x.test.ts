import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { newTrain, taskGoal, updateTrainTasks } from '../src/sim/ats';
import { dispatcherTick } from '../src/sim/dispatcher';
import { releaseRoute } from '../src/sim/interlocking';
import { computeBody, goalBerth, indexBodies } from '../src/sim/movement';
import { doorMotionTick, openDoors } from '../src/sim/psd';
import { depotTasks, platformBerth } from '../src/sim/timetable';
import type { DepotTask, StopTask, Task } from '../src/sim/model';

function emptySim() {
  const sim = new Sim({ dayType: 'weekday', dateLabel: 'legacy-wait-rules', startTime: 14400,
    seed: 7, noPossessions: true, autoDispatch: true });
  for (const train of [...sim.trainList]) sim.removeTrain(train);
  for (const route of [...sim.routes.keys()]) releaseRoute(sim, route);
  sim.resourceTransit.clear(); sim.berthRes.clear(); indexBodies(sim);
  return sim;
}

describe('saved 16601/16602 wait rules', () => {
  it.each(['clear', 'occupied', 'unlocked-switch'] as const)(
    'uses the depot destination for an axle sweep and keeps %s protection', condition => {
      const sim = emptySim(), depot = sim.topo.depots.find(d => d.key === 'LYD')!;
      const tasks: Task[] = []; depotTasks(sim.topo, depot.id, 'DN', tasks);
      const task = tasks.at(-1) as DepotTask;
      const goal = taskGoal(sim, task), signal = sim.topo.signals.find(s => s.name === 'X2005')!;
      const rid = sim.routeTable.next.get(goal)![signal.id], route = sim.topo.routes[rid];
      const berth = sim.topo.berths[platformBerth(sim.topo, depot.station, 'DN')];
      const train = newTrain(sim, null, berth.link, berth.offset, berth.dir,
        [{ link: berth.link, dir: berth.dir }], 'saved-axle-return');
      Object.assign(train, { tasks: [task], phase: 'run', inService: false, withdrawn: true,
        block: -1, tripId: -1, nextSignal: signal.id, nextSignalDist: 7, v: 0,
        halt: { code: 'AXLE_PRESET', train: -1, detail: 'saved sweep', since: sim.t - 61,
          plannedUntil: 0, logged: true, unplannedSince: 0 } });
      expect(goalBerth(train)).toBe(-1); // Depot entry is not an ATO stopping target.
      expect(goal).toBe(task.berth);
      expect(route.switches.length).toBeGreaterThan(0);
      sim.sec[route.sections[0]].preset = true;
      if (condition === 'occupied') {
        const step = route.steps.find(s => s.link !== berth.link)!;
        const link = sim.topo.links[step.link];
        const other = newTrain(sim, null, link.id, link.len / 2, step.dir,
          [{ link: link.id, dir: step.dir }], 'sweep-obstruction');
        other.inService = false; computeBody(sim, other);
      }
      if (condition === 'unlocked-switch') {
        const sw = sim.sw[route.switches[0].sw]; sw.failed = true; sw.fieldLock = false;
      }
      computeBody(sim, train); indexBodies(sim);
      dispatcherTick(sim);
      if (condition === 'clear') {
        expect(sim.sig[signal.id].route).toBe(rid);
        expect(sim.routes.get(rid)?.guide).toBe(true);
        expect(sim.sec[route.sections[0]].preset).toBe(true);
      } else expect(sim.sig[signal.id].route).toBe(-1);
    });

  it.each([true, false])('only a passenger continuation inherits open doors (depot work=%s)', fixedWork => {
    const sim = emptySim(), depot = sim.topo.depots.find(d => d.key === 'LYD')!;
    const target = sim.topo.berths[platformBerth(sim.topo, depot.station, 'DN')];
    const arrival = sim.topo.berths.find(b => b.link === target.link && b.dir !== target.dir && b.kind === 'platform')!;
    const last: StopTask = { k: 'stop', berth: arrival.id, station: depot.station, trip: -1,
      arr: null, dep: null, doors: false, revenue: false };
    const next: StopTask = { k: 'stop', berth: target.id, station: depot.station, trip: -1,
      arr: null, dep: null, doors: false, revenue: false, minDwell: 30,
      ...(fixedWork ? { depotWork: { kind: 'in' as const, depot: depot.id, berths: [target.id] } } : {}) };
    const train = newTrain(sim, null, arrival.link, arrival.offset, arrival.dir,
      [{ link: arrival.link, dir: arrival.dir }], 'saved-open-door-return');
    Object.assign(train, { tasks: [last, { k: 'reverse', berths: [arrival.id], chosen: arrival.id,
      station: depot.station, minTime: 40 }, next], phase: 'dwell', arrivedAt: sim.t - 60,
      dwellUntil: sim.t, depReadyAt: sim.t, maDist: 500, mode: 'DTO', manual: false,
      block: -1, tripId: -1, load: 0, v: 0, a: 0 });
    computeBody(sim, train); indexBodies(sim); openDoors(sim, train, arrival.platform);
    updateTrainTasks(sim, train);
    if (!fixedWork) {
      expect(train.tasks[0]).toMatchObject({ k: 'stop', berth: target.id });
      expect(train.doorsOpen).toBe(true);
      return;
    }
    expect(train.tasks[0]).toBe(last);
    expect(train.doorMotion?.kind).toBe('closing');
    expect(train.doorsOpen).toBe(true);
    sim.t = Math.max(train.dwellUntil, train.autoStartAt ?? 0, train.doorLockedAt ?? 0);
    doorMotionTick(sim); updateTrainTasks(sim, train);
    expect(train.doorsOpen).toBe(false);
    expect(train.tasks[0].k).toBe('reverse');
    train.stopDist = 0; updateTrainTasks(sim, train);
    expect(train.phase).toBe('reversing');
    sim.t = train.dwellUntil; updateTrainTasks(sim, train);
    train.stopDist = 0; updateTrainTasks(sim, train);
    expect(train.tasks[0]).toBe(next);
    expect(train.phase).toBe('dwell');
    expect(train.doorsOpen).toBe(false);
    expect(train.dwellUntil).toBe(sim.t + 30);
    sim.t += 29; updateTrainTasks(sim, train); expect(train.tasks[0]).toBe(next);
    sim.t += 1; updateTrainTasks(sim, train); expect(train.tasks).toHaveLength(0);
  });
});
