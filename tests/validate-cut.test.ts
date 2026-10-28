import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { effectiveEnd, effectiveStops, validatePlan } from '../src/sim/timetable';

describe('runtime plan validation after a turnback', () => {
  it('checks the effective trip while preserving the original plan geometry', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'cut validation', startTime: 14400, seed: 19 });
    const block = sim.plan.blocks.find(b => b.trips.length > 1 && b.trips.every(id => !sim.plan.trips[id].cancelled)
      && sim.plan.trips[b.trips[0]].stops.length > 3)!;
    const trip = sim.plan.trips[block.trips[0]], next = sim.plan.trips[block.trips[1]];
    const original = structuredClone(trip);
    trip.cut = { station: trip.stops[1].st, stopIndex: 1, cause: 'turnback' };
    const actualPlan = structuredClone(sim.plan);
    const projected = actualPlan.trips[trip.id];
    projected.stops = structuredClone(effectiveStops(trip));
    projected.to = effectiveEnd(trip)!;
    delete projected.cut;
    const relevant = (plan: typeof sim.plan) => validatePlan(sim.planCtx, plan, false).filter(i =>
      i.code === 'BLOCK_BREAK' && i.text.includes(`车底 ${block.svc}：${trip.no}`));
    expect(relevant(sim.plan)).toEqual(relevant(actualPlan));
    expect(relevant(sim.plan)).toHaveLength(1);
    expect(effectiveEnd(trip)).not.toBe(next.from);
    expect(trip.to).toBe(original.to);
    expect(trip.stops).toEqual(original.stops);
  });
});
