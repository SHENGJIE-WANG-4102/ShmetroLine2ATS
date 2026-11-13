import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Topology, TRoute } from '../src/sim/topology';

/** Fictional branched test line: 支线西(0)-支线一(1) joins 试验西(2)…试验东(7) at 试验二(4). */
describe('a branch joining the main run', () => {
  let topo: Topology;
  let order: typeof import('../src/sim/topologyOrder');
  beforeAll(async () => {
    vi.stubEnv('ATS_LINE', 'testbranch'); vi.resetModules();
    order = await import('../src/sim/topologyOrder');
    topo = (await import('../src/sim/topology')).buildTopology();
  });
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  /** can a train get from one link to another by routes, running `dir` on the first */
  const reaches = (from: number, to: number): boolean => {
    const seen = new Set<number>(), queue: TRoute[] = topo.routes.filter(route => route.steps.some(step => step.link === from));
    while (queue.length) {
      const route = queue.pop()!;
      if (seen.has(route.id)) continue;
      seen.add(route.id);
      if (route.wrongDir) continue;
      if (route.steps.some(step => step.link === to)) return true;
      if (route.end >= 0) queue.push(...topo.signals[route.end].routes.map(id => topo.routes[id]));
    }
    return false;
  };
  const platform = (station: number, track: 'DN' | 'UP') => topo.platforms[topo.stations[station].platforms[track]].link;

  it('registers the running order', () => {
    expect(order.stationPath(0, 7)).toEqual([0, 1, 4, 5, 6, 7]);
    expect(order.ahead('DN', 1, 2)).toBe(false);
  });

  it('gives the branch its own DN face at the join station and no second UP face', () => {
    const own = topo.platforms.filter(p => p.from !== undefined);
    expect(own.map(p => [p.station, p.track, p.from])).toEqual([[4, 'DN', 1]]);
    expect(own[0].link).not.toBe(platform(4, 'DN'));
    expect(topo.berths.filter(b => b.platform === own[0].id)).toHaveLength(2);
  });

  it('runs DN from the branch through its own face onto the main, and never onto the stations before the join', () => {
    const own = topo.platforms.find(p => p.from !== undefined)!.link;
    expect(reaches(platform(1, 'DN'), own)).toBe(true);
    expect(reaches(own, platform(5, 'DN'))).toBe(true);
    expect(reaches(platform(1, 'DN'), platform(7, 'DN'))).toBe(true);
    expect(reaches(platform(1, 'DN'), platform(4, 'DN'))).toBe(false);
    expect(reaches(platform(1, 'DN'), platform(3, 'DN'))).toBe(false);
    // the main run still runs through
    expect(reaches(platform(2, 'DN'), platform(7, 'DN'))).toBe(true);
    expect(reaches(platform(3, 'DN'), topo.platforms.find(p => p.from !== undefined)!.link)).toBe(false);
  });

  it('runs UP from the shared platform to either run', () => {
    expect(reaches(platform(5, 'UP'), platform(4, 'UP'))).toBe(true);
    expect(reaches(platform(4, 'UP'), platform(3, 'UP'))).toBe(true);
    expect(reaches(platform(4, 'UP'), platform(1, 'UP'))).toBe(true);
    expect(reaches(platform(4, 'UP'), platform(0, 'UP'))).toBe(true);
    expect(reaches(platform(3, 'UP'), platform(1, 'UP'))).toBe(false);
  });

  it('measures the way from the branch to the join station by its own length', () => {
    const own = topo.platforms.find(p => p.from !== undefined)!.link;
    const start = topo.signals.find(signal => signal.link !== platform(1, 'DN') && topo.links[signal.link].a === topo.links[platform(1, 'DN')].b && signal.dir === 1)!;
    const route = start.routes.map(id => topo.routes[id]).find(candidate => !candidate.diverging)!;
    // platform end to platform end: 1500 m centre to centre less one platform length
    expect(topo.signals[route.end].link).toBe(own);
    expect(route.length).toBeCloseTo(1500 - 210, 0);
  });

  it('every link has a section and every section a station', () => {
    expect(topo.links.every(link => link.section >= 0)).toBe(true);
    expect(topo.sections.every(section => section.station >= 0 && section.links.length > 0)).toBe(true);
  });
});
