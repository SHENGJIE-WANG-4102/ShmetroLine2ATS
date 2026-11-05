// D178: the planner sends a storage car off in its berth's own direction, so a
// reversing exit through a protected local shunt is built for the mechanism
// tests: the stored car's first trip becomes a boarding UP departure from its
// own station. Needs the mid-line storage fixture (import that first).
import { expect } from 'vitest';
import type { Sim } from '../../src/sim/engine';
import type { Trip } from '../../src/sim/model';
import { spawnDue } from '../../src/sim/ats';

export function storageExit(s: Sim) {
  const block = s.plan.blocks.find(b => b.start.kind === 'stable' && b.start.berth !== undefined && s.topo.stations[b.start.station].shuntEntries.length > 0)!;
  expect(block).toBeDefined();
  if (block.start.kind !== 'stable') throw new Error('no storage start');
  const from = block.start.station;
  const svc = s.plan.trips.find(t => t.dir === 'UP' && t.revenue && t.kind !== 'ins' && t.stops[0].dep > 6 * 3600 && t.stops.some(p => p.st === from && p.stop))!;
  const i = svc.stops.findIndex(p => p.st === from);
  const trip: Trip = { ...svc, id: s.plan.trips.length, no: 'X001', kind: 'ins', from, block: block.id, stops: svc.stops.slice(i).map((p, k) => k ? { ...p } : { ...p, arr: p.dep - 30 }) };
  s.plan.trips.push(trip); block.trips = [trip.id];
  // the stored car is set up afresh for its new first trip, as at the start of the day
  Object.assign(s.trainList.find(t => t.block === block.id)!, { block: -1, tasks: [], phase: 'stabled', v: 0 }); block.train = undefined; spawnDue(s);
  const tr = s.trainList.find(t => t.block === block.id)!;
  expect(tr).toBeDefined();
  return { block, trip, tr };
}
