import { describe, expect, it } from 'vitest';
import type { Plan, StopTask, TrackDir, Trip } from '../src/sim/model';
import { addTurnback, blockTasks, depotMoves, DEPOT_ENTRY_CLEAR, effectiveEnd, effectiveStops, effectiveTrip, inboundWindow, minTurn, platformBerth, serviceEnd, terminalOccupancy, turnbackAt } from '../src/sim/timetable';
import { ahead, buildTopology } from '../src/sim/topology';
import { plannedNormalWork } from '../src/sim/plannedWaitBerth';

function fixture() {
  const topo = buildTopology();
  const dir: TrackDir = 'DN';
  const station = topo.stations.find(s => turnbackAt(topo, s.index, dir)
    && topo.stations.some(before => ahead(dir, before.index, s.index))
    && topo.stations.some(after => ahead(dir, s.index, after.index)))!.index;
  const before = topo.stations.find(s => ahead(dir, s.index, station))!.index;
  const after = topo.stations.find(s => ahead(dir, station, s.index))!.index;
  const trip: Trip = { id: 0, no: '0001', block: 0, from: before, to: after, dir, kind: 'small', revenue: true,
    stops: [{ st: before, arr: 10000, dep: 10000, stop: true }, { st: station, arr: 10100, dep: 10130, stop: true },
      { st: after, arr: 10200, dep: 10200, stop: true }], cut: { station, stopIndex: 1, cause: 'turnback' } };
  const departure: Trip = { id: 1, no: '0002', block: 0, from: station, to: before, dir: 'UP', kind: 'small', revenue: true,
    stops: [{ st: station, arr: 10100 + minTurn(station), dep: 10100 + minTurn(station), stop: true },
      { st: before, arr: 10400 + minTurn(station), dep: 10400 + minTurn(station), stop: true }] };
  const plan: Plan = { dayType: 'weekday', trips: [trip, departure], blocks: [{ id: 0, svc: '001',
    start: { kind: 'stable', station: before, berth: platformBerth(topo, before, dir) },
    end: { kind: 'none' }, trips: [0, 1] }], periods: [], overlays: [], fleetPeak: 1 };
  return { topo, trip, departure, plan, station, after };
}

describe('actual trip view', () => {
  it('slices through the cut stop without changing any original stop fields', () => {
    const { trip, station, after } = fixture(), original = structuredClone(trip);
    const stops = effectiveStops(trip), view = effectiveTrip(trip);
    expect(stops).toEqual(trip.stops.slice(0, 2));
    expect(stops.at(-1)).toMatchObject({ st: station, dep: 10130, stop: true });
    expect(effectiveEnd(trip)).toBe(station); expect(view?.to).toBe(station);
    expect(trip).toEqual(original); expect(trip.to).toBe(after); expect(trip.stops).toHaveLength(3);
    const noCut = { ...trip, cut: undefined }; expect(effectiveTrip(noCut)).toBe(noCut);
    const through = { ...trip, stops: trip.stops.map((s, i) => i === 1 ? { ...s, stop: false } : s) };
    expect(effectiveStops(through).at(-1)).toMatchObject({ stop: true, dep: 10130 });
    expect(through.stops[1].stop).toBe(false);
    const once = effectiveTrip(through);
    if (!once) throw Error('fixture should have a nonempty cut');
    const twice = effectiveTrip(once);
    if (!twice) throw Error('second view should remain nonempty');
    expect(twice).toEqual(once);
    expect(plannedNormalWork('weekday', once, { dir: 'UP' })).toBe(plannedNormalWork('weekday', twice, { dir: 'UP' }));
  });
  it('rebuilds the stop, reversal and following duty at the cut endpoint', () => {
    const { topo, trip, plan, station, after } = fixture();
    const tasks = blockTasks(topo, plan, plan.blocks[0]);
    expect(tasks.filter((t): t is StopTask => t.k === 'stop' && t.trip === trip.id).map(t => t.station)).not.toContain(after);
    expect(tasks).toContainEqual(expect.objectContaining({ k: 'stop', trip: trip.id, station, dep: null }));
    expect(tasks).toContainEqual(expect.objectContaining({ k: 'reverse', station }));
    expect(tasks).toContainEqual(expect.objectContaining({ k: 'stop', trip: 1, station }));
    expect(serviceEnd(plan, trip)).toBe(station);
    const direct: typeof tasks = []; addTurnback(topo, trip, direct);
    expect(direct).toContainEqual(expect.objectContaining({ k: 'reverse', station }));
    const hold = terminalOccupancy(plan, topo).get(station)!.find(x => x.arrival === trip.id && x.departure === 1);
    expect(hold).toMatchObject({ from: 10100, to: 10100 + minTurn(station) });
    expect(terminalOccupancy(plan, topo).get(after) ?? []).not.toContainEqual(expect.objectContaining({ arrival: trip.id }));
  });
  it('keeps each repeated station tied to its original stop index', () => {
    const { topo, trip, plan, station } = fixture();
    trip.stops = [trip.stops[0], { ...trip.stops[1], arr: 10050, dep: 10070 },
      { ...trip.stops[1], arr: 10100, dep: 10130 }, trip.stops[2]];
    trip.cut = { station, stopIndex: 2, cause: 'turnback' };
    const calls = blockTasks(topo, plan, plan.blocks[0]).filter((t): t is StopTask => t.k === 'stop' && t.trip === trip.id);
    expect(calls.map(t => t.stopIndex)).toEqual([0, 1, 2]);
    expect(calls.filter(t => t.station === station).map(t => t.stopIndex)).toEqual([1, 2]);
    expect(calls.at(-1)?.dep).toBeNull();
  });
  it('keeps a legacy stop without a stopIndex valid for standalone turnback', () => {
    const { topo, trip, station } = fixture();
    const legacy: StopTask = { k: 'stop', berth: platformBerth(topo, station, trip.dir), station,
      trip: trip.id, arr: 10100, dep: null, doors: true, revenue: true };
    const tasks = [legacy]; addTurnback(topo, trip, tasks);
    expect(tasks[0].stopIndex).toBeUndefined();
    expect(tasks).toContainEqual(expect.objectContaining({ k: 'reverse', station }));
  });
  it('predicts a depot return from a nonempty cut using its actual last call', () => {
    const { topo, trip, plan } = fixture();
    const depot = topo.depots.findIndex(d => d.transferPaths[d.portals.entry[trip.dir].path].flow === 'shared');
    expect(depot).toBeGreaterThanOrEqual(0);
    const block = { ...plan.blocks[0], trips: [trip.id], start: { kind: 'depot' as const, depot, time: 9800 }, end: { kind: 'depot' as const, depot } };
    const moves = depotMoves([block], plan.trips, { topo });
    expect(moves.find(x => x.delta < 0)).toMatchObject({ time: 9800, trip: trip.id });
    expect(moves.find(x => x.delta > 0)).toMatchObject({ time: 10100 + DEPOT_ENTRY_CLEAR, trip: trip.id });
    expect(trip.to).not.toBe(trip.cut?.station);
    const actual = effectiveTrip(trip);
    if (!actual) throw Error('fixture should have an actual arrival');
    expect(moves.find(x => x.delta > 0)?.window).toEqual(inboundWindow(topo, depot, actual));
    expect(inboundWindow(topo, depot, actual)).not.toEqual(inboundWindow(topo, depot, trip));
  });
});
