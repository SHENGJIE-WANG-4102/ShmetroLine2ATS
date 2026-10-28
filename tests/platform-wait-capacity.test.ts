import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Plan, TrackDir, Trip } from '../src/sim/model';

const start = 32387.2;
const finish = 32837.2;

async function context(line: '2' | '14') {
  vi.stubEnv('ATS_LINE', line);
  vi.resetModules();
  const [current, topology, timetable] = await Promise.all([
    import('../src/data/current'), import('../src/sim/topology'), import('../src/sim/timetable'),
  ]);
  const topo = topology.buildTopology();
  const station = current.STATIONS.findIndex(s => s.id === (line === '14' ? 'LTN' : 'GLL'));
  expect(station).toBeGreaterThanOrEqual(0);
  const nearest = (dir: TrackDir, before: boolean) => topo.stations.filter(s =>
    before ? topology.ahead(dir, s.index, station) : topology.ahead(dir, station, s.index))
    .sort((a, b) => Math.abs(a.chain - topo.stations[station].chain) - Math.abs(b.chain - topo.stations[station].chain))[0].index;
  return { topo, timetable, station, nearest };
}

function makeTrip(id: number, block: number, no: string, dir: TrackDir, from: number, to: number,
  stops: { st: number; arr: number; dep: number; stop: boolean }[]): Trip {
  return { id, no, dir, from, to, stops, kind: 'small', revenue: true, block };
}

/** Real LTN 2033→0017 clocks, with a deliberately conflicting following call. */
function fixture(station: number, before: number, after: number, turning = false) {
  const a = makeTrip(0, 0, '2033', 'DN', before, station, [
    { st: before, arr: start - 200, dep: start - 190, stop: true },
    { st: station, arr: start, dep: start, stop: true },
  ]);
  const d = makeTrip(1, 0, '0017', turning ? 'UP' : 'DN', station, turning ? before : after, [
    { st: station, arr: finish, dep: finish, stop: true },
    { st: turning ? before : after, arr: finish + 180, dep: finish + 180, stop: true },
  ]);
  const through = makeTrip(2, 1, '1053', 'DN', before, after, [
    { st: before, arr: start + 100, dep: start + 110, stop: true },
    { st: station, arr: start + 200, dep: start + 220, stop: true },
    { st: after, arr: finish + 180, dep: finish + 180, stop: true },
  ]);
  const plan: Plan = { dayType: 'weekday', trips: [a, d, through], blocks: [
    { id: 0, svc: '001', start: { kind: 'stable', station: before }, end: { kind: 'none' }, trips: [0, 1] },
    { id: 1, svc: '002', start: { kind: 'stable', station: before }, end: { kind: 'none' }, trips: [2] },
  ], periods: [], overlays: [], fleetPeak: 2 };
  return { plan, through };
}

describe('planned long-wait platform capacity', () => {
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('reports a later train stopped or passing through the same LTN platform', async () => {
    const { topo, timetable, station, nearest } = await context('14');
    const { plan, through } = fixture(station, nearest('DN', true), nearest('DN', false));
    const check = () => timetable.validatePlan({ topo, dayType: 'weekday', rt: {} as never }, plan, false, false, { checkWaiting: true })
      .filter(i => i.code === 'STABLE_CONFLICT' && i.text.includes('候班'));
    const stop = through.stops[1];
    expect(check()).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', blocks: [0, 1] })]));
    stop.stop = false; stop.dep = stop.arr;
    expect(check()).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', blocks: [0, 1] })]));
    // Validation of the plan must not mutate its trips or the default storage calendar.
    const before = JSON.stringify(timetable.storageOccupancy(topo, plan));
    check();
    expect(JSON.stringify(timetable.storageOccupancy(topo, plan))).toBe(before);
    expect(timetable.validatePlan({ topo, dayType: 'weekday', rt: {} as never }, plan, false)
      .some(i => i.code === 'STABLE_CONFLICT' && i.text.includes('候班'))).toBe(false);
  });

  it('does not report the same duty, the opposite platform, or exact boundary handoff', async () => {
    const { topo, timetable, station, nearest } = await context('14');
    const { plan, through } = fixture(station, nearest('DN', true), nearest('DN', false));
    const check = () => timetable.validatePlan({ topo, dayType: 'weekday', rt: {} as never }, plan, false, false, { checkWaiting: true })
      .filter(i => i.code === 'STABLE_CONFLICT' && i.text.includes('候班'));
    through.block = 0;
    expect(check()).toEqual([]);
    through.block = 1;
    through.dir = 'UP'; through.from = nearest('UP', true); through.to = nearest('UP', false);
    through.stops[0].st = through.from; through.stops[2].st = through.to;
    expect(check()).toEqual([]);
    through.dir = 'DN'; through.from = nearest('DN', true); through.to = nearest('DN', false);
    through.stops[0].st = through.from; through.stops[2].st = through.to;
    through.stops[1].arr = finish; through.stops[1].dep = finish;
    expect(check()).toEqual([]);
    through.stops[1].arr = start - 10; through.stops[1].dep = start;
    expect(check()).toEqual([]);
  });

  it('detects a GLL middle-platform arrival without mistaking the adjacent main platform', async () => {
    const { topo, timetable, station, nearest } = await context('2');
    const { plan, through } = fixture(station, nearest('DN', true), nearest('DN', false), true);
    // The other duty actually terminates here and reverses on the middle platform.
    through.to = station;
    through.stops = through.stops.slice(0, 2);
    const dep = makeTrip(3, 1, '1054', 'UP', station, nearest('UP', false), [
      { st: station, arr: start + 300, dep: start + 300, stop: true },
      { st: nearest('UP', false), arr: start + 480, dep: start + 480, stop: true },
    ]);
    plan.trips.push(dep); plan.blocks[1].trips.push(dep.id);
    const check = () => timetable.validatePlan({ topo, dayType: 'weekday', rt: {} as never }, plan, false, false, { checkWaiting: true })
      .filter(i => i.code === 'STABLE_CONFLICT' && i.text.includes('候班'));
    expect(check()).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', blocks: [0, 1] })]));
    // Even a sub-millisecond overlap is a real passing arrival; do not let
    // the storage calendar's existing tolerance suppress that diagnosis.
    through.stops[1].arr = finish - 0.0005; through.stops[1].dep = finish - 0.0005;
    dep.stops[0].arr = finish + 100; dep.stops[0].dep = finish + 100;
    expect(check()).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', blocks: [0, 1] })]));
    // Through traffic on the DN main is a different physical platform.
    plan.blocks[1].trips = [through.id]; plan.trips.pop();
    through.to = nearest('DN', false);
    through.stops[1].arr = start + 200; through.stops[1].dep = start + 220;
    through.stops.push({ st: through.to, arr: finish + 180, dep: finish + 180, stop: true });
    expect(check()).toEqual([]);
  });
});
