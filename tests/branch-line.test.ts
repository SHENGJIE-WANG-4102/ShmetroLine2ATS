import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sim as Simulator } from '../src/sim/engine';

/** Fictional branched test line: 支线西(0)-支线一(1) joins 试验西(2)…试验东(7) at 试验二(4);
 * main-run and branch trains alternate to 试验东. */
describe('fictional branched test line', () => {
  let Sim: typeof Simulator;
  let validatePlan: typeof import('../src/sim/timetable').validatePlan;
  let nextConfig: typeof import('../src/sim/operatingDay').nextOperatingConfig;
  beforeAll(async () => {
    vi.stubEnv('ATS_LINE', 'testbranch');
    vi.resetModules();
    Sim = (await import('../src/sim/engine')).Sim;
    validatePlan = (await import('../src/sim/timetable')).validatePlan;
    nextConfig = (await import('../src/sim/operatingDay')).nextOperatingConfig;
  });
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  for (const dayType of ['weekday', 'weekend'] as const) it(`${dayType}: plans both routes along the line and validates every trip`, () => {
    const sim = new Sim({ dayType, dateLabel: '测试', startTime: 14400, seed: 7 });
    const paths = (dir: 'DN' | 'UP') => {
      const count = new Map<string, number>();
      for (const trip of sim.plan.trips) if (trip.revenue && trip.dir === dir) { const key = trip.stops.map(stop => stop.st).join(' '); count.set(key, (count.get(key) ?? 0) + 1); }
      return count;
    };
    // no trip calls at a station that is not on its way
    expect([...paths('DN').keys()].sort()).toEqual(['0 1 4 5 6 7', '2 3 4 5 6 7']);
    expect([...paths('UP').keys()].sort()).toEqual(['7 6 5 4 1 0', '7 6 5 4 3 2']);
    for (const dir of ['DN', 'UP'] as const) for (const n of paths(dir).values()) expect(n).toBeGreaterThan(40);
    // the two routes alternate on the shared section
    const shared = sim.plan.trips.filter(trip => trip.revenue && trip.dir === 'DN').sort((a, b) => a.stops.at(-1)!.arr - b.stops.at(-1)!.arr).map(trip => trip.from);
    expect(shared.slice(4, 44).filter((from, i, all) => i > 0 && from === all[i - 1])).toEqual([]);
    expect(validatePlan(sim.planCtx, sim.plan)).toEqual([]);
  });

  it('runs a complete day and its successor with weather, fleet conservation and no integrity violations', async () => {
    let sim = new Sim({ dayType: 'weekday', date: '2026-10-23', dateLabel: '测试', startTime: 14400, seed: 7, autoDispatch: true, autoRadio: true });
    const fleet = () => [...sim.vehicles.keys()].sort();
    const original = fleet();
    for (let day = 0; day < 2; day++) {
      sim.command({ c: 'env', wind: 2, rain: true, duration: 86400 });
      let nextYield = sim.t + 3600;
      while (sim.t < 27.75 * 3600) {
        sim.step();
        if (sim.integrity.violations.length) break;
        if (sim.t >= nextYield) { await new Promise<void>(resolve => setTimeout(resolve, 0)); nextYield += 3600; }
      }
      expect(sim.integrity.violations.map(v => v.detail)).toEqual([]);
      expect(fleet()).toEqual(original);
      const revenue = sim.plan.trips.filter(trip => trip.revenue && !trip.cancelled);
      expect(revenue.length).toBeGreaterThan(180);
      expect(revenue.filter(trip => !trip.completed).map(trip => trip.no)).toEqual([]);
      if (!day) sim = new Sim(nextConfig(sim), sim);
    }
  }, 400_000);
});
