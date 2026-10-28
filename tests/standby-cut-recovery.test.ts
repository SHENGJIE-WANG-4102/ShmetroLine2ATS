import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sim } from '../src/sim/engine';
import { newTrain } from '../src/sim/ats';
import { hotStandby, standbyTakeover } from '../src/sim/standby';
import * as timetable from '../src/sim/timetable';
import * as planning from '../src/sim/planning';

afterEach(() => vi.restoreAllMocks());

describe('hot standby recovery of a shortened trip', () => {
  it.each([false, true])('publishes only unserved effective calls (hot station already served: %s)', (alreadyServed) => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'cut hot standby', startTime: 14400, seed: 19 });
    for (const train of [...sim.trainList]) sim.removeTrain(train);
    sim.autoDispatch = true;
    const place = timetable.hotStandbyPlaces(sim.topo).find(p => p.station === 17)!;
    const original = sim.plan.trips.find(t => t.revenue && t.dir === 'UP' && t.stops.some((s, i) =>
      s.st === place.station && s.stop && s.dep > sim.t + 240 && i > 0 && i + 3 < t.stops.length))!;
    expect(original).toBeDefined();
    const hotIndex = original.stops.findIndex(s => s.st === place.station);
    const cutIndex = hotIndex + 2;
    const diagram = structuredClone(original.stops);
    original.cut = { station: original.stops[cutIndex].st, stopIndex: cutIndex, cause: 'turnback' };
    original.cancelled = true;
    const source = sim.plan.blocks[original.block];
    source.trips = [original.id];
    source.relieved = false;
    const own = sim.plan.trips.find(t => t.block !== original.block && t.dir === original.dir && !t.cancelled)!;
    const hotBlock = sim.plan.blocks[own.block];
    hotBlock.trips = [own.id];
    const berth = sim.topo.berths[place.berth];
    const vehicle = [...sim.vehicles.keys()][0];
    const hot = newTrain(sim, null, berth.link, berth.offset, berth.dir, [{ link: berth.link, dir: berth.dir }], vehicle);
    Object.assign(hot, { block: hotBlock.id, tripId: own.id, phase: 'run', v: 0, manual: false, withdrawn: false, relievedBy: undefined });
    hot.tasks = [{ k: 'stop', berth: place.berth, station: place.station, trip: own.id, arr: null,
      dep: sim.t + 1000, doors: false, revenue: false, standby: true }];
    if (alreadyServed) {
      const sourceVehicle = [...sim.vehicles.keys()].find(v => v !== vehicle)!;
      const sourceTrain = newTrain(sim, null, berth.link, berth.offset, berth.dir, [{ link: berth.link, dir: berth.dir }], sourceVehicle);
      Object.assign(sourceTrain, { block: source.id, tripId: original.id,
        lastCompletedCall: { trip: original.id, stopIndex: hotIndex } });
    }
    expect(hotStandby(sim, hot)?.station).toBe(place.station);
    // Isolate the hot-standby transfer itself from the unrelated yard capacity
    // search; real blockTasks and the actual transfer still run.
    vi.spyOn(timetable, 'standbyCandidate').mockImplementation((_ctx, _plan, _tail, depot, notBefore) =>
      ({ depot, k: 0, start: notBefore, dir: original.dir, from: place.station, to: place.station, stops: null }));
    vi.spyOn(planning, 'noWorse').mockReturnValue(true);
    const count = sim.plan.trips.length;
    const result = standbyTakeover(sim, source.id, [original.id], 'test');
    if (alreadyServed) {
      expect(result?.id).not.toBe(hotBlock.id);
      const suffix = sim.plan.trips.slice(count).find(t => t.no === `${original.no}续`);
      expect(suffix?.from).toBe(diagram[hotIndex + 1].st);
      expect(suffix?.to).toBe(original.cut.station);
      return;
    }
    expect(result?.id).toBe(hotBlock.id);
    const suffix = sim.plan.trips.slice(count).find(t => t.no === `${original.no}续`)!;
    expect(suffix).toBeDefined();
    expect(suffix.from).toBe(place.station);
    expect(suffix.to).toBe(original.cut.station);
    expect(suffix.stops.map(s => s.st)).toEqual(diagram.slice(hotIndex, cutIndex + 1).map(s => s.st));
    expect(suffix.cut).toBeUndefined();
    expect(original.stops).toEqual(diagram);
    expect(original.cut.stopIndex).toBe(cutIndex);
    expect(hot.tasks.filter(t => t.k === 'stop' && t.trip === suffix.id).at(-1)).toMatchObject({ station: suffix.to, dep: null });
  });
});
