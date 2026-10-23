import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sim as Simulator } from '../src/sim/engine';

describe('fictional test line', () => {
  let Sim: typeof Simulator;
  let validatePlan: typeof import('../src/sim/timetable').validatePlan;
  let nextConfig: typeof import('../src/sim/operatingDay').nextOperatingConfig;
  beforeAll(async () => {
    vi.stubEnv('ATS_LINE', 'test');
    vi.resetModules();
    Sim = (await import('../src/sim/engine')).Sim;
    validatePlan = (await import('../src/sim/timetable')).validatePlan;
    nextConfig = (await import('../src/sim/operatingDay')).nextOperatingConfig;
  });
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  for (const dayType of ['weekday', 'weekend'] as const) it(`${dayType}: builds topology and validates every planned trip`, () => {
    const sim = new Sim({ dayType, dateLabel: '测试', startTime: 14400, seed: 7 });
    expect(sim.topo.stations).toHaveLength(6);
    expect(sim.topo.depots).toHaveLength(1);
    expect(sim.topo.stations[0].turnbackBerths.length).toBeGreaterThan(0);
    expect(sim.topo.stations.at(-1)!.turnbackBerths.length).toBeGreaterThan(0);
    expect(sim.plan.trips.length).toBeGreaterThan(90);
    expect(validatePlan(sim.planCtx, sim.plan)).toEqual([]);
    expect(sim.config.scope?.lineIds).toEqual(['test']);
  });

  it('runs a complete day and its successor with weather, fleet conservation and no integrity violations', () => {
    let sim = new Sim({ dayType: 'weekday', date: '2026-10-23', dateLabel: '测试', startTime: 14400, seed: 7, autoDispatch: true, autoRadio: true });
    const fleet = () => [...sim.vehicles.keys()].sort();
    const original = fleet();
    const served: number[] = [];
    for (let day = 0; day < 2; day++) {
      sim.command({ c: 'env', wind: 2, rain: true, duration: 86400 });
      while (sim.t < 27.75 * 3600) {
        sim.step();
        if (sim.integrity.violations.length) break;
      }
      expect(sim.integrity.violations).toEqual([]);
      expect(sim.t).toBeGreaterThanOrEqual(27.75 * 3600);
      expect(fleet()).toEqual(original);
      expect(sim.plan.trips.filter(t => t.revenue && t.completed).length).toBeGreaterThan(80);
      served.push(sim.tripsDone);
      if (!day) sim = new Sim(nextConfig(sim), sim);
    }
    expect(served.every(n => n > 80)).toBe(true);
    expect(sim.config.date).toBe('2026-10-24');
    expect(sim.config.dayType).toBe('weekend');
    expect(sim.config.scope?.lineIds).toEqual(['test']);
  }, 180_000);
});

