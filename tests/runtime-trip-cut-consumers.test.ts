import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { computePis } from '../src/sim/pis';
import { planPassengerExchange } from '../src/sim/passengers';
import { capture, restore } from '../src/sim/state';
import { effectiveEnd, effectiveStops } from '../src/sim/timetable';
import { plannedWaitLong, plannedNormalWork } from '../src/sim/plannedWaitBerth';
import { plannedWaiting } from '../src/sim/plannedWaiting';
import type { StopTask, Train } from '../src/sim/model';

const make = () => new Sim({ dayType: 'weekday', dateLabel: 'runtime cut', startTime: 14400, seed: 19 });

describe('runtime trip cut consumers', () => {
  it('uses the complete original service when there has been no turnback', () => {
    const sim = make();
    const trip = sim.plan.trips.find(t => t.revenue && t.dir === 'DN' && t.stops.length > 5)!;
    for (const t of sim.plan.trips) if (t.id !== trip.id) t.cancelled = true;
    sim.t = trip.stops[0].dep - 60;
    expect(effectiveStops(trip)).toEqual(trip.stops);
    expect(effectiveEnd(trip)).toBe(trip.to);
    expect(Number.isFinite(plannedNormalWork(sim.plan.dayType, trip, trip))).toBe(true);
    expect(plannedWaitLong(sim.plan.dayType, trip, trip)).toBe(false);
    expect(computePis(sim, trip.stops[1].st).next?.DN).toBe(trip.stops[1].dep);
  });

  it('uses the shortened endpoint when checking a terminal connection', () => {
    const sim = make();
    const block = sim.plan.blocks.find(b => b.trips.length >= 2 && b.trips.every(id => !sim.plan.trips[id].cancelled))!;
    const arrival = sim.plan.trips[block.trips[0]], departure = sim.plan.trips[block.trips[1]];
    arrival.cut = { station: arrival.stops[0].st, stopIndex: 0, cause: 'turnback' };
    const result = plannedWaiting({ topo: sim.topo }, sim.plan, { connection: { block: block.id, arrival: arrival.id, departure: departure.id } });
    expect(result.waits).toContainEqual(expect.objectContaining({station: arrival.stops[0].st, reason:'BLOCK_BREAK'}));
  });
  it('copies the last completed call across checkpoints and accepts older checkpoints without it', () => {
    const sim = make();
    const train = sim.trainList[0];
    expect(train).toBeDefined();
    train.lastCompletedCall = { trip: 1, stopIndex: 2 };
    const checkpoint = capture(sim);
    expect(checkpoint.trains.find(t => t.id === train.id)?.lastCompletedCall).not.toBe(train.lastCompletedCall);
    train.lastCompletedCall = { trip: 3, stopIndex: 4 };
    restore(sim, checkpoint);
    const restored = sim.trains.get(train.id)!;
    expect(restored.lastCompletedCall).toEqual({ trip: 1, stopIndex: 2 });
    expect(restored.lastCompletedCall).not.toBe(checkpoint.trains.find(t => t.id === train.id)?.lastCompletedCall);
    delete checkpoint.trains.find(t => t.id === train.id)!.lastCompletedCall;
    restore(sim, checkpoint);
    expect(sim.trains.get(train.id)!.lastCompletedCall).toBeUndefined();
  });
  it('leaves the diagram and old checkpoints intact while omitting later PIS calls', () => {
    const sim = make();
    const trip = sim.plan.trips.find(t => t.revenue && t.dir === 'DN' && t.stops.length > 5 && t.stops.every(s => s.stop))!;
    const original = structuredClone(trip.stops);
    for (const t of sim.plan.trips) if (t.id !== trip.id) t.cancelled = true;
    const before = capture(sim);
    const cut = { station: trip.stops[2].st, stopIndex: 2, cause: 'turnback' as const };
    trip.cut = cut;
    sim.planRev++;
    const after = capture(sim);
    expect(after.plan.trips[trip.id].cut).toEqual(cut);
    expect(after.plan.trips[trip.id].cut).not.toBe(trip.cut);
    expect(before.plan.trips[trip.id].cut).toBeUndefined();
    expect(trip.stops).toEqual(original);
    sim.t = trip.stops[0].dep - 60;
    expect(computePis(sim, trip.stops[1].st).next?.DN).toBe(trip.stops[1].dep);
    expect(computePis(sim, trip.stops[3].st).next?.DN).toBeUndefined();
    restore(sim, before);
    expect(sim.plan.trips[trip.id].cut).toBeUndefined();
    expect(sim.plan.trips[trip.id].stops).toEqual(original);
    restore(sim, after);
    expect(sim.plan.trips[trip.id].cut).toEqual(cut);
    expect(sim.plan.trips[trip.id].cut).not.toBe(after.plan.trips[trip.id].cut);
  });

  it('allocates alighting against the real remaining stops after a short turn', () => {
    const sim = make();
    const trip = sim.plan.trips.find(t => t.revenue && t.dir === 'DN' && t.stops.length > 5 && t.stops.every(s => s.stop))!;
    const station = trip.stops[1].st;
    const platform = sim.topo.stations[station].platforms.DN;
    const tr = { load: 100 } as Train;
    const task = { k: 'stop', trip: trip.id, station, dep: trip.stops[1].dep, revenue: true } as StopTask;
    const original = planPassengerExchange(sim, tr, platform, task);
    trip.cut = { station: trip.stops[2].st, stopIndex: 2, cause: 'turnback' };
    const actual = planPassengerExchange(sim, tr, platform, task);
    expect(actual.alight).toBeGreaterThan(original.alight);
    expect(trip.stops.length).toBeGreaterThan(3);
  });
});
