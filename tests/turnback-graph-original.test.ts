import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Trip } from '../src/sim/model';

const draw = vi.hoisted(() => ({ lines: [] as Array<{ kind: string; x: number; y: number }> }));
vi.mock('pixi.js', () => {
  class Container {
    children: unknown[] = [];
    position = { set() {} };
    visible = true;
    addChild(...items: unknown[]) { this.children.push(...items); }
    removeChildren() { return this.children.splice(0); }
    destroy() {}
  }
  class Graphics extends Container {
    moveTo(x: number, y: number) { draw.lines.push({ kind: 'move', x, y }); return this; }
    lineTo(x: number, y: number) { draw.lines.push({ kind: 'line', x, y }); return this; }
    stroke() { return this; }
    rect() { return this; }
    fill() { return this; }
    clear() { return this; }
  }
  class Text extends Container { anchor = { set() {} }; constructor(_options: unknown) { super(); } }
  return { Container, Graphics, Text };
});

describe('actual graph rendering after dispatcher turnback', () => {
  beforeAll(() => { vi.stubEnv('ATS_LINE', '14'); vi.resetModules(); });
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('keeps the original plan polyline and draws only real trace samples', async () => {
    const { Sim } = await import('../src/sim/engine');
    const ats = await import('../src/sim/ats');
    const timetable = await import('../src/sim/timetable');
    const movement = await import('../src/sim/movement');
    const { TrainGraph } = await import('../src/ui/graph');
    const sim = new Sim({ dayType: 'weekend', date: '2026-10-24', dateLabel: 'graph cut',
      startTime: 14400, seed: 71, noPossessions: true, autoRadio: true, autoDispatch: false });
    for (const tr of [...sim.trainList]) sim.removeTrain(tr);
    for (const b of sim.plan.blocks) sim.blockDone.add(b.id);
    const berth = sim.topo.berths[timetable.platformBerth(sim.topo, 24, 'DN')];
    const vehicle = [...sim.vehicles.keys()][0], record = sim.vehicles.get(vehicle)!;
    for (const [i, yard] of sim.yards.entries()) {
      for (const track of yard.tracks) { const index = track.indexOf(vehicle); if (index >= 0) track.splice(index, 1); }
      sim.depotStock[i] = yard.tracks.flat().length;
    }
    record.depot = -1;
    record.uto = { stage: 'ready', until: 0, cycles: 0, lastTakeoverDay: sim.config.date };
    const block = sim.plan.blocks.length, id = sim.plan.trips.length;
    const trip: Trip = { id, no: '1265', dir: 'DN', kind: 'big', from: 24, to: 30,
      stops: timetable.buildStops(sim.planCtx, 'DN', 24, 30, sim.t, true, 1), revenue: true, block };
    const next: Trip = { id: id + 1, no: '0020', dir: 'UP', kind: 'big', from: 30, to: 0,
      stops: timetable.buildStops(sim.planCtx, 'UP', 30, 0, sim.t + 1200, true, 1), revenue: true, block };
    sim.plan.trips.push(trip, next);
    sim.plan.blocks.push({ id: block, svc: '035', start: { kind: 'depot', depot: 1, time: sim.t - 300 }, end: { kind: 'depot', depot: 0 }, trips: [id, id + 1] });
    sim.blockDone.add(block);
    const train = ats.newTrain(sim, null, berth.link, berth.offset, berth.dir, [{ link: berth.link, dir: berth.dir }], vehicle);
    Object.assign(train, { block, svc: '035', tripId: id, tripNo: trip.no, inService: true, phase: 'dwell', phaseSince: sim.t,
      arrivedAt: sim.t, dwellUntil: sim.t, depReadyAt: sim.t, doorsAwait: false, doorsOpen: false, doorLockedAt: sim.t, manual: false, mode: 'DTO' });
    sim.plan.blocks[block].train = train.id;
    train.tasks = []; timetable.tripTasks(sim.topo, trip, train.tasks, false); movement.indexBodies(sim);

    const store = { traces: new Map<number, number[]>(), emit() {} };
    const graph = new TrainGraph(sim.topo, store as never);
    const internals = graph as unknown as { yOf: number[]; pxPerSec: number; buildPlan(plan: typeof sim.plan): void; flushActual(): void };
    internals.yOf = sim.topo.stations.map(s => s.chain);
    internals.pxPerSec = 1;
    const renderPlan = () => { draw.lines.length = 0; internals.buildPlan({ ...sim.plan, trips: [trip], periods: [] }); return structuredClone(draw.lines); };
    const before = renderPlan(), originalStops = structuredClone(trip.stops);
    const result = sim.command({ c: 'turnback', train: train.id, station: 25 });
    expect(result.ok, result.msg).toBe(true);
    expect(trip.cut).toMatchObject({ station: 25, cause: 'turnback' });
    expect(trip.stops).toEqual(originalStops);
    expect(renderPlan()).toEqual(before);
    expect(before).toContainEqual({ kind: 'line', x: trip.stops.at(-1)!.arr, y: sim.topo.stations[30].chain });

    train.trace.length = 0;
    ats.recordTrace(sim, train, true);
    for (let i = 0; i < 20; i++) sim.step();
    ats.recordTrace(sim, train, true);
    const trace = train.trace.slice();
    expect(trace.length).toBeGreaterThanOrEqual(8);
    store.traces.set(train.id, trace);
    draw.lines.length = 0;
    internals.flushActual();
    const expected = [];
    for (let i = 0; i + 4 < trace.length; i += 4) {
      expected.push({ kind: 'move', x: trace[i], y: trace[i + 1] }, { kind: 'line', x: trace[i + 4], y: trace[i + 5] });
    }
    expect(draw.lines).toEqual(expected);
    expect(draw.lines.some(p => p.y === sim.topo.stations[25].chain)).toBe(false);
  }, 30000);
});
