import { describe, expect, it } from 'vitest';
import { makeSim, runFor, assertIntegrity, assertNoCollision } from './helpers';
import { entryStation } from '../src/sim/timetable';

// D150 (用户决定): a minor vehicle fault carries its passengers on and comes
// off at the first station where it can leave for a yard, not the terminus.
describe('minor vehicle fault withdrawal', () => {
  it('comes off at the first yard-entry station ahead', () => {
    const sim = makeSim('weekday', 10 * 3600, { seed: 3, noPossessions: true });
    const entry = (dir: 'UP' | 'DN') => new Set(sim.topo.depots.map((_, d) => entryStation(sim.topo, d, dir)));
    const pick = sim.trainList.map(tr => {
      const t = tr.tasks[0];
      if (!tr.inService || tr.phase !== 'run' || t?.k !== 'stop' || t.trip < 0) return undefined;
      const trip = sim.plan.trips[t.trip];
      const ahead = tr.tasks.filter(x => x.k === 'stop' && x.trip === t.trip && x.dep !== null).map(x => (x as { station: number }).station);
      const first = ahead.find(st => entry(trip.dir).has(st));
      return first !== undefined && first !== trip.to ? { tr, first, to: trip.to } : undefined;
    }).find(x => x);
    expect(pick).toBeDefined();
    const { tr, first, to } = pick!;
    tr.withdrawAtEnd = true;
    let at = -1;
    for (let i = 0; i < 120 && !tr.withdrawn; i++) runFor(sim, 30);
    at = tr.lastStation;
    assertIntegrity(sim); assertNoCollision(sim);
    expect(tr.withdrawn).toBe(true);
    expect(at).toBe(first);
    expect(at).not.toBe(to);
  }, 300_000);
});
