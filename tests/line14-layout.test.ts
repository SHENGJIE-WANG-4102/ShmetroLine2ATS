import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Topology } from '../src/sim/topology';

describe('14号线PDF配线拓扑', () => {
  let topo: Topology;
  beforeAll(async () => {
    vi.stubEnv('ATS_LINE', '14'); vi.resetModules();
    topo = (await import('../src/sim/topology')).buildTopology();
  });
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('真新新村、蓝天路各有两条独立且容纳8A的折返线，两端均接正线', () => {
    for (const key of ['ZXX', 'LTN']) {
      const station = topo.stations.find(st => st.id === key)!;
      expect(station.turnbackBerths).toHaveLength(2);
      const berthLinks = station.turnbackBerths.map(id => topo.berths[id].link);
      expect(new Set(berthLinks).size).toBe(2);
      for (const lid of berthLinks) {
        expect(topo.links[lid].len).toBeGreaterThan(185.6 + 30);
        // A route enters this physical berth from each throat, in opposite
        // travel directions. This catches a drawn connector without graph edges.
        const directions = new Set(topo.routes.flatMap(route => route.steps.filter(s => s.link === lid).map(s => s.dir)));
        expect([...directions].sort()).toEqual([-1, 1]);
        expect(topo.berths.filter(berth => berth.link === lid).map(berth => berth.dir).sort()).toEqual([-1, 1]);
      }
    }
  });

  it('三处中间存车线各只登记一个存车位，联络线不登记任何泊位', () => {
    for (const key of ['CYL', 'HPN', 'YSL']) {
      const station = topo.stations.find(st => st.id === key)!;
      expect(station.storageBerths).toHaveLength(1);
      expect(station.turnbackBerths).toHaveLength(0);
    }
    expect(topo.berths.some(b => b.name.includes('联络线'))).toBe(false);
    expect(topo.links.every(l => l.section >= 0 && topo.sections[l.section].links.includes(l.id))).toBe(true);
  });

  it('两基地都有双向出入段路径且库位只算14号线部分', () => {
    expect(topo.depots.map(d => [d.key, d.capacity])).toEqual([['FBD', 16], ['GQD', 36]]);
    for (const yard of topo.depots) for (const dir of ['DN', 'UP'] as const) {
      expect(yard.portals.exit[dir].path).toBeGreaterThanOrEqual(0);
      expect(yard.portals.entry[dir].path).toBeGreaterThanOrEqual(0);
    }
  });
});
