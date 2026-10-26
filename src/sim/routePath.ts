import type { Topology } from './topology';

import type { RouteTable } from './routeTable';
export type { RouteTable };

export type TaskPathVisitor = (link: number, from: number, to: number) => void;

type RoutePathStart = { signal: number } | { route: number; index: number; offset?: number };

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
