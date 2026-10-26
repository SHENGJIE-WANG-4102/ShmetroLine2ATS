import { describe, expect, it } from 'vitest';
import { distanceToBerth } from '../src/sim/ats';
import type { Sim } from '../src/sim/engine';
import { walkRouteToBerth, type RouteTable, type TaskPathVisitor } from '../src/sim/routePath';
import type { Dir, RouteStep, TBerth, TLink, Topology, TRoute } from '../src/sim/topology';

type Geometry = Pick<Topology, 'links' | 'routes' | 'berths'>;
type Segment = [number, number, number];
const steps = (...links: number[]): RouteStep[] => links.map(link => ({ link, dir: 1 }));
function fixture(routes: { start: number; end: number; steps: RouteStep[] }[], next: number[],
  goal: { link: number; offset: number; dir: Dir } = { link: 2, offset: 30, dir: 1 }): { topo: Geometry; table: RouteTable } {
  const lengths = [100, 200, 300, 400];
  const links: TLink[] = lengths.map((len, id) => ({ id, len, a: id, b: id + 1, track: 'DN', normalDir: 1,
    section: id, chainA: 0, chainB: len, limit: 80, zone: 0, platform: -1 }));
  const berth: TBerth = { ...goal, id: 0, kind: 'platform', platform: 0, station: 0, depot: -1, reverse: false, name: 'goal' };
  const fullRoutes: TRoute[] = routes.map((route, id) => ({ ...route, id, name: String(id), endNode: -1,
    sections: [], switches: [], length: route.steps.reduce((n, s) => n + lengths[s.link], 0),
    wrongDir: false, diverging: false, fleeting: false, berths: [], limit: 80 }));
  return { topo: { links, routes: fullRoutes, berths: [berth] },
    table: { next: new Map([[0, Int32Array.from(next)]]), dist: new Map() } };
}

function collect() {
  const path: Segment[] = [];
  const visit: TaskPathVisitor = (link, from, to) => path.push([link, from, to]);
  return { path, visit };
}

describe('shared route-table physical path', () => {
  it('visits successive routes in order, stopping inside the goal link', () => {
    const { topo, table } = fixture([{ start: 0, end: 1, steps: steps(0) },
      { start: 1, end: -1, steps: steps(1, 2, 3) }], [0, 1]);
    const { path, visit } = collect();
    expect(walkRouteToBerth(topo, table, { signal: 0 }, 0, visit)).toBe(330);
    expect(path).toEqual([[0, 0, 100], [1, 0, 200], [2, 0, 30]]);
    // The public ATS wrapper has the same distance and ordered callbacks;
    // no simulator construction or runtime state is needed for this contract.
    const ats = collect();
    expect(distanceToBerth({ topo, routeTable: table } as Sim, 0, 0, ats.visit)).toBe(330);
    expect(ats.path).toEqual(path);
  });

  it('measures reverse travel from the far end and truncates at the berth', () => {
    const { topo, table } = fixture([{ start: 0, end: -1,
      steps: [{ link: 0, dir: -1 }, { link: 2, dir: -1 }, { link: 3, dir: -1 }] }], [0],
    { link: 2, offset: 40, dir: -1 });
    const { path, visit } = collect();
    expect(walkRouteToBerth(topo, table, { signal: 0 }, 0, visit)).toBe(360);
    expect(path).toEqual([[0, 100, 0], [2, 300, 40]]);
  });

  it('does not stop on the goal link when travelling in the wrong direction', () => {
    const { topo, table } = fixture([{ start: 0, end: -1,
      steps: [{ link: 2, dir: -1 }, { link: 1, dir: 1 }, { link: 2, dir: 1 }] }], [0]);
    const { path, visit } = collect();
    expect(walkRouteToBerth(topo, table, { signal: 0 }, 0, visit)).toBe(530);
    expect(path).toEqual([[2, 300, 0], [1, 0, 200], [2, 0, 30]]);
  });

  it.each([1, -1] as const)('starts partway through an existing route in direction %s', dir => {
    const { topo, table } = fixture([{ start: 0, end: 1,
      steps: [{ link: 3, dir }, { link: 0, dir }] }, { start: 1, end: -1, steps: [{ link: 2, dir }] }], [0, 1],
    { link: 2, offset: 30, dir });
    const { path, visit } = collect();
    expect(walkRouteToBerth(topo, table, { route: 0, index: 1, offset: 40 }, 0, visit)).toBe(dir === 1 ? 90 : 310);
    expect(path).toEqual(dir === 1 ? [[0, 40, 100], [2, 0, 30]] : [[0, 40, 0], [2, 300, 30]]);
  });

  it('can finish on the first partial link without visiting the rest of the route', () => {
    const { topo, table } = fixture([{ start: 0, end: -1, steps: steps(2, 3) }], [0]);
    const { path, visit } = collect();
    expect(walkRouteToBerth(topo, table, { route: 0, index: 0, offset: 20 }, 0, visit)).toBe(10);
    expect(path).toEqual([[2, 20, 30]]);
  });

  it('keeps the goal callback even when no distance remains on the first link', () => {
    const { topo, table } = fixture([{ start: 0, end: -1, steps: steps(2, 3) }], [0]);
    const { path, visit } = collect();
    expect(walkRouteToBerth(topo, table, { route: 0, index: 0, offset: 30 }, 0, visit)).toBe(0);
    expect(path).toEqual([[2, 30, 30]]);
  });

  it('does not run backwards to a goal behind a partial start', () => {
    const { topo, table } = fixture([{ start: 0, end: 1, steps: steps(2) },
      { start: 1, end: -1, steps: steps(1, 2) }], [0, 1]);
    const { path, visit } = collect();
    expect(walkRouteToBerth(topo, table, { route: 0, index: 0, offset: 40 }, 0, visit)).toBe(490);
    expect(path).toEqual([[2, 40, 300], [1, 0, 200], [2, 0, 30]]);
  });

  it('keeps the selected initial route, then uses only the existing next table', () => {
    const { topo, table } = fixture([{ start: 0, end: 1, steps: steps(0) },
      { start: 0, end: 1, steps: steps(3) }, { start: 1, end: -1, steps: steps(2) }], [0, 2]);
    const { path, visit } = collect();
    expect(walkRouteToBerth(topo, table, { route: 1, index: 0 }, 0, visit)).toBe(430);
    expect(path).toEqual([[3, 0, 400], [2, 0, 30]]);
  });

  it('returns Infinity for missing and unreachable next entries without inventing a path', () => {
    const { topo, table } = fixture([{ start: 0, end: 1, steps: steps(0) }], [0, -1]);
    const { path, visit } = collect();
    expect(walkRouteToBerth(topo, table, { signal: 0 }, 0, visit)).toBe(Infinity);
    expect(path).toEqual([[0, 0, 100]]);
    table.next.clear();
    expect(walkRouteToBerth(topo, table, { signal: 0 }, 0)).toBe(Infinity);
    expect(walkRouteToBerth(topo, table, { signal: -1 }, 0)).toBe(Infinity);
  });

  it('keeps the visited prefix when a route ends before the goal', () => {
    const { topo, table } = fixture([{ start: 0, end: -1, steps: steps(0, 1) }], [0]);
    const { path, visit } = collect();
    expect(walkRouteToBerth(topo, table, { signal: 0 }, 0, visit)).toBe(Infinity);
    expect(path).toEqual([[0, 0, 100], [1, 0, 200]]);
  });

  it.each([{ signal: 0 }, { route: 0, index: 0 }])('stops a route-table cycle for %j', start => {
    const { topo, table } = fixture([{ start: 0, end: 1, steps: steps(0) },
      { start: 1, end: 0, steps: steps(1) }], [0, 1]);
    const { path, visit } = collect();
    expect(walkRouteToBerth(topo, table, start, 0, visit)).toBe(Infinity);
    expect(path).toEqual([[0, 0, 100], [1, 0, 200]]);
  });

  it('detects a return to a selected initial route before adding its full link again', () => {
    const { topo, table } = fixture([{ start: 0, end: 1, steps: steps(0) }], [0, 0]);
    const { path, visit } = collect();
    expect(walkRouteToBerth(topo, table, { route: 0, index: 0, offset: 40 }, 0, visit)).toBe(Infinity);
    expect(path).toEqual([[0, 40, 100]]);
    const signal = collect();
    expect(walkRouteToBerth(topo, table, { signal: 0 }, 0, signal.visit)).toBe(Infinity);
    expect(signal.path).toEqual([[0, 0, 100], [0, 0, 100]]);
  });
});
