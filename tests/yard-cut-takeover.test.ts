import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { newTrain } from '../src/sim/ats';
import { blockTasks, platformBerth } from '../src/sim/timetable';
import { computeBody, indexBodies } from '../src/sim/movement';

function fixture() {
  const sim = new Sim({ dayType: 'weekday', dateLabel: 'yard cut recovery', startTime: 14400, seed: 19, autoDispatch: true });
  for (const train of [...sim.trainList]) sim.removeTrain(train);
  const block = sim.plan.blocks.find(b => b.end.kind === 'depot' && b.trips.some(id => sim.plan.trips[id].no === '2002'))!;
  expect(block).toBeDefined();
  block.trips = block.trips.slice(block.trips.findIndex(id => sim.plan.trips[id].no === '2002'));
  const first = sim.plan.trips[block.trips[0]], nextId = block.trips[1];
  const berth = sim.topo.berths[platformBerth(sim.topo, first.from, first.dir)];
  const vehicle = [...sim.vehicles.keys()][0];
  const train = newTrain(sim, block, berth.link, berth.offset, berth.dir, [{ link: berth.link, dir: berth.dir }], vehicle);
  Object.assign(train, { block: block.id, tripId: first.id, tripNo: first.no, svc: block.svc, phase: 'run',
    lastStation: first.from, inService: true, lastCompletedCall: { trip: first.id, stopIndex: -1 } });
  train.tasks = blockTasks(sim.topo, sim.plan, block);
  block.train = train.id;
  return { sim, block, first, nextId, train, vehicle };
}

describe('yard standby after withdrawal', () => {
  it('restores an unstarted trip and keeps its following duty after a real withdrawal', () => {
    const { sim, block, first, nextId, train } = fixture();
    const originalStops = structuredClone(first.stops);
    const result = sim.command({ c: 'withdraw', train: train.id });
    expect(result.ok, result.msg).toBe(true);
    const recovered = sim.plan.trips[first.id];
    expect(recovered.cut).toBeUndefined();
    expect(recovered.cancelled).toBe(false);
    expect(recovered.stops).toEqual(originalStops);
    expect(recovered.block).not.toBe(block.id);
    const newBlock = sim.plan.blocks[recovered.block];
    expect(newBlock.trips).toContain(nextId);
    const tasks = blockTasks(sim.topo, sim.plan, newBlock);
    expect(tasks.some(t => t.k === 'stop' && t.trip === first.id)).toBe(true);
    expect(tasks.some(t => t.k === 'stop' && t.trip === nextId)).toBe(true);
  });

  it('starts a real yard replacement after the last completed station', () => {
    const { sim, block, first, train } = fixture();
    const done = 2, next = first.stops[done + 1];
    const berth = sim.topo.berths[platformBerth(sim.topo, first.stops[done].st, first.dir)];
    Object.assign(train, { link: berth.link, off: berth.offset, dir: berth.dir,
      hist: [{ link: berth.link, dir: berth.dir }], recentBody: undefined,
      lastStation: first.stops[done].st, lastCompletedCall: { trip: first.id, stopIndex: done } });
    const index = train.tasks.findIndex(t => t.k === 'stop' && t.trip === first.id && t.revenue && (t.stopIndex ?? -1) > done);
    expect(index).toBeGreaterThanOrEqual(0);
    train.tasks = train.tasks.slice(index);
    computeBody(sim, train); indexBodies(sim);
    const count = sim.plan.trips.length;
    const result = sim.command({ c: 'withdraw', train: train.id });
    expect(result.ok, result.msg).toBe(true);
    const suffix = sim.plan.trips.slice(count).find(t => t.no === `${first.no}续` && !t.cancelled);
    expect(suffix).toBeDefined();
    expect(suffix!.from).toBe(next.st);
    expect(suffix!.stops.map(s => s.st)).toEqual(first.stops.slice(done + 1).map(s => s.st));
    expect(suffix!.block).not.toBe(block.id);
    expect(first.cancelled).toBe(true);
    const calls = blockTasks(sim.topo, sim.plan, sim.plan.blocks[suffix!.block])
      .filter(t => t.k === 'stop' && t.trip === suffix!.id && t.revenue);
    expect(calls[0]).toMatchObject({ station: next.st });
  });

});
