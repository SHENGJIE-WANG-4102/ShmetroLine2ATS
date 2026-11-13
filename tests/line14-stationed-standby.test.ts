import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sim as Simulator } from '../src/sim/engine';

describe('14号线驻站热备运用、未开通站与首班车来源', () => {
  let sim: Simulator;
  let tt: typeof import('../src/sim/timetable');
  let data: typeof import('../src/data/current');
  beforeAll(async () => {
    vi.stubEnv('ATS_LINE', '14'); vi.resetModules();
    const { Sim } = await import('../src/sim/engine');
    tt = await import('../src/sim/timetable'); data = await import('../src/data/current');
    sim = new Sim({ dayType: 'weekend', dateLabel: '驻站热备', startTime: 14400, seed: 3 });
  });
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('每个热备位一张独立运用：同一基地出、窗口内到位、窗口后空车回同一基地', () => {
    const places = tt.hotStandbyPlaces(sim.topo).filter(place => place.depot && place.incoming);
    expect(places.length).toBeGreaterThan(0);
    for (const place of places) for (const window of tt.standbyWindows('weekend', place)) {
      const name = data.STATIONS[place.station].name;
      const arrival = sim.plan.trips.find(trip => trip.standby && trip.to === place.station)!;
      expect(arrival, name).toBeDefined();
      const block = sim.plan.blocks[arrival.block];
      expect(block.trips, name).toHaveLength(2);
      const departure = sim.plan.trips[block.trips[1]];
      expect(block.trips[0], name).toBe(arrival.id);
      expect(block.start.kind, name).toBe('depot');
      expect(block.end, name).toEqual({ kind: 'depot', depot: (block.start as { depot: number }).depot });
      expect([arrival.revenue, departure.revenue], name).toEqual([false, false]);
      expect(departure.from, name).toBe(place.station);
      expect(departure.dir, name).not.toBe(arrival.dir);
      const at = arrival.stops.at(-1)!.arr;
      expect(at, name).toBeGreaterThanOrEqual(window.from - 1e-6);
      expect(at, name).toBeLessThanOrEqual(window.from + 3600);
      expect(departure.stops[0].dep, name).toBeGreaterThanOrEqual(window.to);
      expect(departure.stops[0].dep, name).toBeLessThanOrEqual(window.to + 3600);
    }
  });

  it('未开通的车站没有开站时刻，空车可以在首班车之前通过', () => {
    const closed = data.STATIONS.findIndex((_, index) => !data.stationOpened(index));
    expect(closed).toBeGreaterThanOrEqual(0);
    for (const dir of ['UP', 'DN'] as const) expect(tt.stationOpening(closed, dir, sim.plan.trips)).toBe(Infinity);
    expect(sim.plan.trips.some(trip => trip.stops.some(stop => stop.st === closed && stop.stop))).toBe(false);
    // the night cars stabled on the line all go out in the morning, the one beyond the closed station too
    const stabled = sim.plan.blocks.filter(block => block.start.kind === 'stable');
    expect(stabled.length).toBeGreaterThan(0);
    for (const block of stabled) expect(block.trips.length).toBeGreaterThan(0);
  });

  it('公布的首班车从基地出车，不拿正线过夜车顶', () => {
    const anchors = tt.openingAnchors(sim.plan.trips);
    expect(anchors.length).toBeGreaterThan(0);
    for (const trip of anchors) expect(sim.plan.blocks[trip.block].start.kind, trip.no).toBe('depot');
  });
});
