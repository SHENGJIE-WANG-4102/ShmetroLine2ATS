import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { newTrain } from '../src/sim/ats';
import { blockTasks, platformBerth } from '../src/sim/timetable';
import { computeBody, indexBodies } from '../src/sim/movement';
import { findStandby } from '../src/sim/duty/live';
import { capture, restore } from '../src/sim/state';

/** `done`: index of the trip's last completed call (-1: not started). */
function fixture(done = -1) {
  const config = { dayType: 'weekday', dateLabel: 'yard cut recovery', startTime: 14400, seed: 19, autoDispatch: true } as const;
  const sim = new Sim(config);
  for (const train of [...sim.trainList]) sim.removeTrain(train);
  // A depot-bound duty whose mid-morning revenue trip has a following revenue
  // trip, with the train standing at its call `done`, where a yard standby
  // can take the remaining calls. Its earlier trips are not part of the
  // scenario; cancelled, they leave their paths free.
  const { plan, topo } = sim;
  const vehicle = [...sim.vehicles.keys()][0];
  for (const block of plan.blocks) for (let i = 0; i + 1 < block.trips.length; i++) {
    if (block.end.kind !== 'depot') break;
    const trips = block.trips, t = plan.trips[trips[i]], n = plan.trips[trips[i + 1]];
    if (!t.revenue || !n.revenue || t.stops.length <= done + 2 || t.stops[0].dep < 9 * 3600 || t.stops[0].dep > 11 * 3600) continue;
    for (const id of trips.slice(0, i)) plan.trips[id].cancelled = true;
    block.trips = trips.slice(i);
    const first = plan.trips[block.trips[0]], nextId = block.trips[1];
    const at = first.stops[Math.max(done, 0)].st;
    const berth = topo.berths[platformBerth(topo, at, first.dir)];
    const train = newTrain(sim, block, berth.link, berth.offset, berth.dir, [{ link: berth.link, dir: berth.dir }], vehicle);
    Object.assign(train, { block: block.id, tripId: first.id, tripNo: first.no, svc: block.svc, phase: 'run',
      lastStation: at, inService: true, lastCompletedCall: { trip: first.id, stopIndex: done } });
    const tasks = blockTasks(topo, plan, block);
    train.tasks = done < 0 ? tasks
      : tasks.slice(tasks.findIndex(t => t.k === 'stop' && t.trip === first.id && t.revenue && (t.stopIndex ?? -1) > done));
    computeBody(sim, train); indexBodies(sim);
    // The withdrawal cancels the duty's trips before it looks for a standby.
    for (const id of block.trips) plan.trips[id].cancelled = true;
    const standby = findStandby(sim, block.id, block.trips);
    for (const id of block.trips) plan.trips[id].cancelled = false;
    // (D178: the withdrawal's own return also enters the yard ledger, and at
    // the fixture's 04:00 clock a yard can still be full; keep a duty the
    // real command does hand over from its first trip, when not yet started)
    const handedOver = () => { block.train = train.id; const trial = new Sim(config); restore(trial, capture(sim)); block.train = undefined;
      trial.command({ c: 'withdraw', train: train.id }); return !trial.plan.trips[first.id].cancelled; };
    if (standby?.k === 0 && (done >= 0 || handedOver())) {
      block.train = train.id;
      return { sim, block, first, nextId, train, vehicle };
    }
    sim.removeTrain(train);
    for (const id of trips.slice(0, i)) plan.trips[id].cancelled = false;
    block.trips = trips;
  }
  throw Error('No yard standby takeover fixture');
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
    const done = 2;
    const { sim, block, first, train } = fixture(done);
    const next = first.stops[done + 1];
    expect(train.tasks[0]).toMatchObject({ k: 'stop', trip: first.id });
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
