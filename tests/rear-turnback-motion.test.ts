import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { newTrain } from '../src/sim/ats';
import { platformBerth, turnbackAt } from '../src/sim/timetable';
import { computeBody, indexBodies, regulationDistance, updateTrainMotion } from '../src/sim/movement';
import { computeOccupancy, releaseRoute } from '../src/sim/interlocking';
import { capture, restore } from '../src/sim/state';

function heldRearEntry() {
  const sim = new Sim({ dayType: 'weekday', dateLabel: 'rear clock', startTime: 14400,
    seed: 7, noPossessions: true, autoDispatch: false, autoRadio: false });
  for (const other of [...sim.trainList]) sim.removeTrain(other);
  for (const route of [...sim.routes.keys()]) releaseRoute(sim, route);
  for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
  const station = sim.topo.stations.at(-1)!;
  const berth = sim.topo.berths[platformBerth(sim.topo, station.index, 'DN')];
  const turn = turnbackAt(sim.topo, station.index, 'DN')!;
  if (turn.kind !== 'rear') throw Error('Fixture requires a rear turnback');
  const tr = newTrain(sim, null, berth.link, berth.offset, berth.dir,
    [{ link: berth.link, dir: berth.dir }], 'rear-clock-fixture');
  Object.assign(tr, { hold: true, inService: false, tbStage: 'arrive', lastStation: station.index,
    doorsOpen: false, doorSide: '', v: 0, a: 0, lastDs: 0 });
  tr.tasks = [{ k: 'reverse', station: station.index, berths: turn.berths,
    chosen: turn.berths[0], minTime: 40 }];
  computeBody(sim, tr); indexBodies(sim); computeOccupancy(sim);
  return { sim, tr };
}

describe('rear physical running clock', () => {
  it('does not spend its entry budget while held before the first wheel movement', () => {
    const { sim, tr } = heldRearEntry(), start = sim.t;
    expect(regulationDistance(sim, tr)).toBeGreaterThan(0);
    expect(Number.isFinite(regulationDistance(sim, tr))).toBe(true);
    for (let i = 0; i < 100; i++) {
      updateTrainMotion(sim, tr, .1);
      expect(tr.v).toBe(0); expect(tr.lastDs).toBe(0);
      expect(tr.ato?.arrival! - sim.t).toBeCloseTo(41, 6);
      expect(tr.ato?.started).toBe(false);
      sim.t += 1;
    }
    expect(sim.t - start).toBeGreaterThan(41);
    expect(tr.eb).toBe(false);
  });

  it('pauses an already-started physical leg during a stationary hold and restores its clock independently', () => {
    const { sim, tr } = heldRearEntry();
    updateTrainMotion(sim, tr, .1);
    tr.ato!.started = true;
    tr.ato!.arrival = sim.t + 18;
    const checkpoint = capture(sim), savedArrival = tr.ato!.arrival;
    for (let i = 0; i < 20; i++) { sim.t += .1; updateTrainMotion(sim, tr, .1); }
    expect(tr.ato!.arrival! - sim.t).toBeCloseTo(18, 6);
    expect(tr.eb).toBe(false);
    restore(sim, checkpoint);
    const restored = sim.trains.get(tr.id)!;
    expect(restored.ato?.turnbackLeg).toBe('entry');
    expect(restored.ato?.started).toBe(true);
    expect(restored.ato?.arrival).toBe(savedArrival);
    restored.ato!.arrival! += 5;
    expect(checkpoint.trains.find(t => t.id === tr.id)!.ato?.arrival).toBe(savedArrival);
  });
});
