import { describe, expect, it } from 'vitest';
import { depotStockRequirements } from '../src/sim/timetable';
import type { Plan, Trip, Block } from '../src/sim/model';
import type { Topology } from '../src/sim/topology';

describe('库存来源的真实前缀账本', () => {
  it('过夜实车不是出段来源，改派截止取首次真实欠额时刻', () => {
    const trip = (id: number, arr: number): Trip => ({ id, block: id, dir: 'DN', from: 0, to: 1,
      stops: [{ st: 0, arr: 0, dep: 0, stop: true }, { st: 1, arr, dep: arr, stop: true }] } as Trip);
    const trips = [trip(0, 6000), trip(1, 7000), trip(2, 8000), trip(3, 9000)];
    const blocks: Block[] = [
      { id: 0, svc: '', start: { kind: 'stable', station: 0 }, end: { kind: 'depot', depot: 0 }, trips: [0] },
      { id: 1, svc: '', start: { kind: 'depot', depot: 0, time: 1000 }, end: { kind: 'depot', depot: 0 }, trips: [1] },
      { id: 2, svc: '', start: { kind: 'depot', depot: 0, time: 2000 }, end: { kind: 'depot', depot: 0 }, trips: [2] },
      { id: 3, svc: '', start: { kind: 'depot', depot: 0, time: 3000 }, end: { kind: 'depot', depot: 0 }, trips: [3] },
    ];
    const topo = { depots: [{ capacity: 1 }] } as Topology;
    const result = depotStockRequirements(topo, { trips, blocks } as Plan);
    expect(result.need).toEqual([3]);
    expect(result.deadlines).toEqual([[2000, 3000]]);
    expect(result.events.filter(move => move.delta < 0).map(move => move.block)).toEqual([1, 2, 3]);
  });
});
