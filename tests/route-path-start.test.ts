import { describe, expect, it } from 'vitest';
import { routePathStart, walkRouteToBerth } from '../src/sim/routePath';
import type { TBerth, TLink, TNode, Topology, TRoute } from '../src/sim/topology';
import type { RouteTable } from '../src/sim/routeTable';

function fixture() {
  const nodes: TNode[] = Array.from({ length: 5 }, (_, id) => ({ id, kind: id === 0 || id === 4 ? 'end' : 'joint',
    links: id === 0 ? [0] : id === 4 ? [3] : [id - 1, id], chain: id * 100, pos: [] }));
  const links: TLink[] = Array.from({ length: 4 }, (_, id) => ({ id, a: id, b: id + 1, len: 100,
    track: 'DN', normalDir: 1, section: id, chainA: id * 100, chainB: (id + 1) * 100, limit: 80, zone: 0, platform: -1 }));
  const routes: TRoute[] = [{ id: 0, name: 'registered', start: 0, end: -1, endNode: 4,
    steps: [{ link: 1, dir: 1 }, { link: 2, dir: 1 }, { link: 3, dir: 1 }], sections: [], switches: [],
    length: 300, wrongDir: false, diverging: false, fleeting: false, berths: [0], limit: 80 }];
  const berths: TBerth[] = [{ id: 0, kind: 'platform', link: 3, offset: 40, dir: 1, platform: 0,
    station: 0, depot: -1, reverse: false, name: 'goal' }];
  const topo: Pick<Topology, 'nodes' | 'links' | 'routes' | 'berths' | 'signalByEntry'> =
    { nodes, links, routes, berths, signalByEntry: new Map([[1 * 65536 + 1, 0]]) };
  const table: RouteTable = { next: new Map([[0, Int32Array.from([0])]]), dist: new Map() };
  return { topo, table };
}

describe('pure physical route path start', () => {
  it('uses the supplied registered route from the actual offset, independent of switch positions', () => {
    const { topo, table } = fixture(); topo.nodes[2].kind = 'switch';
    const result = routePathStart(topo, { link: 2, off: 60, dir: 1 }, 0, 0);
    expect(result).toEqual({ start: { route: 0, index: 1, offset: 60 }, approach: 0, segments: [] });
    if (!result || !('start' in result)) throw Error('missing selected route');
    expect(walkRouteToBerth(topo, table, result.start, 0)).toBe(80);
  });
  it('finds the first same-direction signal after an unprotected straight approach', () => {
    const { topo, table } = fixture();
    const result = routePathStart(topo, { link: 0, off: 30, dir: 1 }, 0);
    expect(result).toEqual({ start: { signal: 0 }, approach: 70, segments: [{ link: 0, from: 30, to: 100 }] });
    if (!result || !('start' in result)) throw Error('missing signal');
    expect(result.approach + walkRouteToBerth(topo, table, result.start, 0)).toBe(310);
  });
  it('reaches a goal before any signal, on the current link or a straight continuation', () => {
    const { topo } = fixture(); topo.signalByEntry.clear(); topo.berths[0].link = 1; topo.berths[0].offset = 25;
    expect(routePathStart(topo, { link: 0, off: 80, dir: 1 }, 0)).toEqual({ reached: true, distance: 45,
      segments: [{ link: 0, from: 80, to: 100 }, { link: 1, from: 0, to: 25 }] });
    expect(routePathStart(topo, { link: 1, off: 10, dir: 1 }, 0)).toEqual({ reached: true, distance: 15, segments: [{ link: 1, from: 10, to: 25 }] });
    expect(routePathStart(topo, { link: 1, off: 30, dir: 1 }, 0)).toBeUndefined();
  });
  it('returns the entry signal even when the point is exactly at the signal', () => {
    const { topo } = fixture(); topo.berths[0].link = 1; topo.berths[0].offset = 20;
    expect(routePathStart(topo, { link: 1, off: 0, dir: 1 }, 0)).toEqual({ start: { signal: 0 }, approach: 0, segments: [] });
  });
  it('refuses a switch before any signal rather than choosing a branch', () => {
    const { topo } = fixture(); topo.nodes[1].kind = 'switch';
    expect(routePathStart(topo, { link: 0, off: 80, dir: 1 }, 0)).toBeUndefined();
  });
  it('follows a unique trailing merge to the next same-direction signal', () => {
    const { topo, table } = fixture();
    topo.nodes.push({id:5,kind:'end',links:[4],chain:0,pos:[]});
    topo.links.push({...topo.links[0],id:4,a:5,b:1});
    Object.assign(topo.nodes[1],{kind:'switch',links:[0,1,4],sw:0,toe:1,normal:0,reverse:4});
    const result=routePathStart(topo,{link:0,off:80,dir:1},0);
    expect(result).toEqual({start:{signal:0},approach:20,segments:[{link:0,from:80,to:100}]});
    if (!result || !('start' in result)) throw Error('missing signal');
    expect(result.approach+walkRouteToBerth(topo,table,result.start,0)).toBe(260);
  });
  it('rejects a facing switch with two physical successors', () => {
    const { topo } = fixture();
    topo.nodes.push({id:5,kind:'end',links:[4],chain:0,pos:[]});
    topo.links.push({...topo.links[0],id:4,a:5,b:1});
    Object.assign(topo.nodes[1],{kind:'switch',links:[0,1,4],sw:0,toe:1,normal:0,reverse:4});
    topo.berths[0].link=0;topo.berths[0].dir=-1;topo.berths[0].offset=20;
    expect(routePathStart(topo,{link:1,off:50,dir:-1},0)).toBeUndefined();
  });
  it('walks reversed link orientation without using station indices', () => {
    const { topo } = fixture(); topo.signalByEntry.clear(); topo.berths[0].link = 0;
    topo.berths[0].dir = -1; topo.berths[0].offset = 20;
    expect(routePathStart(topo, { link: 1, off: 10, dir: -1 }, 0)).toEqual({ reached: true, distance: 90,
      segments: [{ link: 1, from: 10, to: 0 }, { link: 0, from: 100, to: 20 }] });
  });
  it('refuses ambiguous repeated steps and invalid points', () => {
    const { topo } = fixture(); topo.routes[0].steps.push({ link: 2, dir: 1 });
    expect(routePathStart(topo, { link: 2, off: 20, dir: 1 }, 0, 0)).toBeUndefined();
    expect(routePathStart(topo, { link: 0, off: -1, dir: 1 }, 0)).toBeUndefined();
  });
});
