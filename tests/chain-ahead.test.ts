import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Topology } from '../src/sim/topology';

/** Fictional branched test line: 支线西(0)-支线一(1) joins 试验西(2)…试验东(7) at 试验二(4).
 * Across a branch a larger chainage is not further DN; every direction comparison of positions
 * goes through chainAhead. */
describe('direction of positions on a branched line', () => {
  let topo: Topology;
  let chainAhead: typeof import('../src/sim/topology').chainAhead;
  let ats: typeof import('../src/sim/ats');
  beforeAll(async () => {
    vi.stubEnv('ATS_LINE', 'testbranch'); vi.resetModules();
    const topology = await import('../src/sim/topology');
    topo = topology.buildTopology(); chainAhead = topology.chainAhead;
    ats = await import('../src/sim/ats');
  });
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  const at = (station: number) => topo.stations[station].chain;

  it('compares along one run by chainage', () => {
    expect(chainAhead('DN', at(2), at(3))).toBeGreaterThan(0);
    expect(chainAhead('UP', at(2), at(3))).toBeLessThan(0);
    expect(chainAhead('DN', at(0), at(1))).toBeCloseTo(at(1) - at(0));
  });

  it('runs from the branch onto the main past the join, not onto the main before it', () => {
    expect(chainAhead('DN', at(1), at(5))).toBeGreaterThan(0);
    expect(chainAhead('UP', at(5), at(1))).toBeGreaterThan(0);
    expect(chainAhead('DN', at(5), at(1))).toBeLessThan(0);
    for (const main of [2, 3]) {
      expect(chainAhead('DN', at(1), at(main))).toBeNull();
      expect(chainAhead('UP', at(main), at(0))).toBeNull();
      expect(chainAhead('UP', at(0), at(main))).toBeNull();
    }
  });

  it('measures the distance across the join along the track', () => {
    // 支线一 → 试验二 is 1500 m centre to centre, 试验二 → 试验三 follows on the main
    expect(chainAhead('DN', at(1), at(4))).toBeCloseTo(1500);
    expect(chainAhead('DN', at(1), at(5))).toBeCloseTo(1500 + at(5) - at(4));
  });

  it('picks the depot ahead on the train\'s own part of the line', () => {
    const sim = { topo } as Parameters<typeof ats.nearestDepot>[0];
    const branchDepot = topo.depots.findIndex(d => d.key === 'BD');
    expect(ats.nearestDepot(sim, 1, 'UP')).toBe(branchDepot);
    // running UP on the main before the join, the branch depot is not ahead
    expect(ats.nearestDepot(sim, 3, 'UP')).not.toBe(branchDepot);
  });
});
