import type { Topology, TrackPoint, Dir } from './topology';

import type { RouteTable } from './routeTable';
export type { RouteTable };

export type TaskPathVisitor = (link: number, from: number, to: number) => void;
export type RoutePathSegment = { link: number; from: number; to: number };

export type RoutePathStart = { signal: number } | { route: number; index: number; offset?: number };

/** Resolve one physical point to the existing route-table path without live
 * switch, fault or occupancy state. `route` is the caller's already selected
 * registered route, not an invitation to search alternative routes. The
 * approach excludes the signal's entry link; a goal reached on it is reported
 * directly. A trailing switch has one physical successor; facing switches,
 * ambiguous joints and loops remain conservative. */
export function routePathStart(topo: Pick<Topology, 'nodes' | 'links' | 'routes' | 'berths' | 'signalByEntry'>,
  point: TrackPoint, goal: number, route?: number):
  { start: RoutePathStart; approach: number; segments: RoutePathSegment[] }
  | { reached: true; distance: number; segments: RoutePathSegment[] } | undefined {
  const current = topo.links[point.link], berth = topo.berths[goal];
  if (!current || !berth || !Number.isFinite(point.off) || point.off < 0 || point.off > current.len
    || (point.dir !== 1 && point.dir !== -1)) return;
  const selected = route === undefined ? undefined : topo.routes[route];
  if (selected) {
    const indexes = selected.steps.flatMap((s, index) => s.link === point.link && s.dir === point.dir ? [index] : []);
    if (indexes.length === 1) return { start: { route: selected.id, index: indexes[0], offset: point.off }, approach: 0, segments: [] };
    if (indexes.length > 1) return;
  }
  let link = current, off = point.off, dir: Dir = point.dir, distance = 0;
  const segments: RoutePathSegment[] = [];
  const add = (to: number) => { if (off !== to) segments.push({ link: link.id, from: off, to }); };
  const seen = new Set<string>();
  for (;;) {
    const key = `${link.id}/${dir}`;
    if (seen.has(key)) return;
    seen.add(key);
    const entry = dir === 1 ? link.a : link.b;
    if (off === (dir === 1 ? 0 : link.len)) {
      const signal = topo.signalByEntry.get(entry * 65536 + link.id);
      if (signal !== undefined) return { start: { signal }, approach: distance, segments };
    }
    if (berth.link === link.id && berth.dir === dir && (berth.offset - off) * dir >= 0) {
      add(berth.offset);
      return { reached: true, distance: distance + (berth.offset - off) * dir, segments };
    }
    add(dir === 1 ? link.len : 0);
    distance += dir === 1 ? link.len - off : off;
    const exit = dir === 1 ? link.b : link.a, node = topo.nodes[exit];
    if (!node) return;
    const nextId = node.kind === 'switch'
      ? (node.toe !== undefined && node.normal !== undefined && node.reverse !== undefined
        && node.links.length === 3 && node.links.includes(node.toe)
        && node.links.includes(node.normal) && node.links.includes(node.reverse)
        && node.normal !== node.reverse && node.toe !== node.normal && node.toe !== node.reverse
        && (link.id === node.normal || link.id === node.reverse) ? node.toe : undefined)
      : node.kind === 'joint' && node.links.length === 2 && node.links.includes(link.id)
        ? node.links.find(id => id !== link.id) : undefined;
    const next = nextId === undefined ? undefined : topo.links[nextId];
    if (!next || next.a !== exit && next.b !== exit) return;
    dir = next.a === exit ? 1 : -1;
    link = next; off = dir === 1 ? 0 : link.len;
  }
}

/** Follow the existing route table, visiting physical link segments up to the
 * goal berth. A selected route may start partway through a link; callers add
 * any approach before that route themselves. Infinity keeps the visited
 * prefix on an unreachable path, just as a signal-start task distance does.
 * Signal starts detect repeated signals; selected routes detect repeated
 * routes, including the initial route that may differ from the table choice. */
export function walkRouteToBerth(topo: Pick<Topology, 'links' | 'routes' | 'berths'>, routeTable: RouteTable,
  start: RoutePathStart, goal: number, visit?: TaskPathVisitor): number {
  const berth = topo.berths[goal], table = routeTable.next.get(goal);
  const selected = 'route' in start;
  let signal = selected ? -1 : start.signal;
  let rid = selected ? start.route : table?.[signal] ?? -1;
  let index = selected ? start.index : 0;
  let offset = selected ? start.offset : undefined;
  const seen = new Set<number>();
  let distance = 0;
  while ((selected ? rid : signal) >= 0) {
    const key = selected ? rid : signal;
    if (seen.has(key) || rid < 0) return Infinity;
    seen.add(key);
    const route = topo.routes[rid];
    for (let i = index; i < route.steps.length; i++) {
      const step = route.steps[i], link = topo.links[step.link];
      const from = offset ?? (step.dir === 1 ? 0 : link.len);
      offset = undefined;
      if (step.link === berth.link && step.dir === berth.dir && (berth.offset - from) * step.dir >= 0) {
        visit?.(step.link, from, berth.offset);
        return distance + (berth.offset - from) * step.dir;
      }
      const to = step.dir === 1 ? link.len : 0;
      visit?.(step.link, from, to);
      distance += (to - from) * step.dir;
    }
    signal = route.end;
    rid = signal >= 0 ? table?.[signal] ?? -1 : -1;
    index = 0;
  }
  return Infinity;
}
