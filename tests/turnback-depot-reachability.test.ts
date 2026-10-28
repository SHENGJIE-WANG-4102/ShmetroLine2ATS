import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sim as Simulator } from '../src/sim/engine';
import type { Trip } from '../src/sim/model';

describe('dispatcher turnback block-end reachability', () => {
  let Sim: typeof Simulator, ats: typeof import('../src/sim/ats');
  let timetable: typeof import('../src/sim/timetable'), movement: typeof import('../src/sim/movement');
  beforeAll(async () => {
    vi.stubEnv('ATS_LINE', '2'); vi.resetModules();
    ({ Sim } = await import('../src/sim/engine'));
    ats = await import('../src/sim/ats'); timetable = await import('../src/sim/timetable');
    movement = await import('../src/sim/movement');
  });
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  // Same physical direction and destination relationship as seed 134:
  // UP service turns at station 4, adjusted DN service ends at 30,
  // while its original duty returns via depot 2 at station 28.
  function fixture(nextEnd: number, stable = false) {
    const sim = new Sim({ dayType: 'weekend', date: '2026-10-24', dateLabel: 'block-end',
      startTime: 64485, seed: 134, noPossessions: true, randomFaults: 0, autoRadio: false, autoDispatch: false });
    for (const train of [...sim.trainList]) sim.removeTrain(train);
    const tripId = sim.plan.trips.length, blockId = sim.plan.blocks.length;
    const current: Trip = { id: tripId, no: '1224', dir: 'UP', kind: 'big', from: 30, to: 0,
      stops: timetable.buildStops(sim.planCtx, 'UP', 30, 0, sim.t, true, 1), revenue: true, block: blockId };
    const next: Trip = { id: tripId + 1, no: '0279', dir: 'DN', kind: 'big', from: 0, to: nextEnd,
      stops: timetable.buildStops(sim.planCtx, 'DN', 0, nextEnd, sim.t + 5000, true, 1), revenue: true, block: blockId };
    sim.plan.trips.push(current, next);
    sim.plan.blocks.push({ id: blockId, svc: '139', start: { kind: 'depot', depot: 2, time: sim.t - 300 },
      end: stable ? { kind: 'stable', station: nextEnd } : { kind: 'depot', depot: 2 }, trips: [current.id, next.id] });
    const berth = sim.topo.berths[timetable.platformBerth(sim.topo, 30, 'UP')], vehicle = [...sim.vehicles.keys()][0];
    const tr = ats.newTrain(sim, null, berth.link, berth.offset, berth.dir, [{ link: berth.link, dir: berth.dir }], vehicle);
    Object.assign(tr, { block: blockId, svc: '139', tripId, tripNo: current.no, inService: true, phase: 'dwell',
      arrivedAt: sim.t, dwellUntil: sim.t, depReadyAt: sim.t, doorsAwait: false, doorsOpen: false, doorLockedAt: sim.t });
    sim.plan.blocks[blockId].train = tr.id;
    tr.tasks = []; timetable.tripTasks(sim.topo, current, tr.tasks, false); movement.indexBodies(sim);
    return { sim, tr, current, next };
  }

  it('turns back at the adjusted terminal and positions to a depot behind it (D145)', () => {
    const { sim, tr, next } = fixture(30);
    const result = sim.command({ c: 'turnback', train: tr.id, station: 4 });
    expect(result.ok, result.msg).toBe(true);
    const adjusted = sim.plan.trips.at(-1)!;
    expect(adjusted).toMatchObject({ from: 4, to: 30, dir: 'DN', kind: 'adj' });
    expect(next.cancelled).toBe(true);
    const arrival = tr.tasks.findIndex(t => t.k === 'stop' && t.trip === adjusted.id && t.station === 30);
    const turn = tr.tasks.findIndex((t, i) => i > arrival && t.k === 'reverse' && t.station === 30);
    expect(arrival).toBeGreaterThanOrEqual(0);
    expect(turn).toBeGreaterThan(arrival);
    expect(tr.tasks.at(-1)).toMatchObject({ k: 'depot', depot: 2 });
  });

  it('commits the adjusted trip and its reachable depot end', () => {
    const { sim, tr, next } = fixture(28);
    const result = sim.command({ c: 'turnback', train: tr.id, station: 4 });
    expect(result.ok, result.msg).toBe(true);
    const adjusted = sim.plan.trips.at(-1)!;
    expect(adjusted).toMatchObject({ from: 4, to: 28, dir: 'DN', kind: 'adj' });
    expect(next.cancelled).toBe(true);
    expect(tr.tasks.at(-1)).toMatchObject({ k: 'depot', depot: 2 });
    // D145: the fixed entry work stop sits between the last call and the yard.
    expect(tr.tasks.at(-2)).toMatchObject({ k: 'stop', depotWork: { kind: 'in', depot: 2 } });
    expect(tr.tasks.some(t => t.k === 'stop' && t.station === 28 && t.trip === adjusted.id)).toBe(true);
  });

  it('rejects an unrepresented overnight destination instead of dropping the block end', () => {
    const { sim, tr } = fixture(29, true);
    const before = structuredClone(sim.plan), tasks = structuredClone(tr.tasks);
    const cmd = { c: 'turnback' as const, train: tr.id, station: 4 };
    const result = sim.command(cmd);
    expect(result).toMatchObject({ ok: false, reasonCode: 'TURNBACK_UNREACHABLE' });
    expect(result.msg).toContain('车底终点作业未生成');
    expect(sim.plan).toEqual(before); expect(tr.tasks).toEqual(tasks);
    expect(sim.inputLog.at(-1)).toMatchObject({ cmd, reasonCode: 'TURNBACK_UNREACHABLE' });
  });

  it('allows a reachable explicitly assigned overnight platform', () => {
    const { sim, tr } = fixture(28);
    const berth = timetable.platformBerth(sim.topo, 28, 'DN');
    sim.plan.blocks[tr.block].end = { kind: 'stable', station: 28, berth };
    const result = sim.command({ c: 'turnback', train: tr.id, station: 4 });
    expect(result.ok, result.msg).toBe(true);
    expect(tr.tasks.at(-1)).toMatchObject({ k: 'stable', berth });
  });

  it('rejects a stable berth belonging to a different scheduled overnight station', () => {
    const { sim, tr } = fixture(28);
    const berth = timetable.platformBerth(sim.topo, 28, 'DN');
    sim.plan.blocks[tr.block].end = { kind: 'stable', station: 29, berth };
    const before = structuredClone(sim.plan), tasks = structuredClone(tr.tasks);
    const result = sim.command({ c: 'turnback', train: tr.id, station: 4 });
    expect(result).toMatchObject({ ok: false, reasonCode: 'TURNBACK_UNREACHABLE' });
    expect(sim.plan).toEqual(before); expect(tr.tasks).toEqual(tasks);
  });

  it('retains a reachable direct depot return without a duty', () => {
    const { sim, tr } = fixture(28);
    Object.assign(tr, { block: -1, tripId: -1, tasks: [] });
    const result = sim.command({ c: 'turnback', train: tr.id, station: 4 });
    expect(result.ok, result.msg).toBe(true);
    expect(tr.tasks.at(-1)?.k).toBe('depot');
  });

  it('retains a duty with no scheduled block end', () => {
    const { sim, tr } = fixture(28);
    sim.plan.blocks[tr.block].end = { kind: 'none' };
    const result = sim.command({ c: 'turnback', train: tr.id, station: 4 });
    expect(result.ok, result.msg).toBe(true);
    expect(tr.tasks.at(-1)).toMatchObject({ k: 'stop', station: 28 });
  });
});
