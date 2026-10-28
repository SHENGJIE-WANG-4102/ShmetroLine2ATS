import type { Topology } from './topology';

export interface RouteTable {
  /** per berth: best next route id for each signal (-1 = unreachable) */
  next: Map<number, Int32Array>;
  dist: Map<number, Float64Array>;
}

export function buildRouteTable(topo: Topology): RouteTable {
  const next = new Map<number, Int32Array>();
  const dist = new Map<number, Float64Array>();
  const nS = topo.signals.length;
  const cost = (rid: number) => {
    const r = topo.routes[rid];
    return r.length + (r.wrongDir ? 6000 : 0) + (r.diverging ? 250 : 0);
  };
  for (const b of topo.berths) {
    const d = new Float64Array(nS).fill(Infinity);
    const nx = new Int32Array(nS).fill(-1);
    for (const r of topo.routes) {
      if (r.berths.includes(b.id)) {
        const c = cost(r.id) * 0.5;
        if (c < d[r.start]) { d[r.start] = c; nx[r.start] = r.id; }
      }
    }
    // Bellman-Ford style relaxation (graph is small)
    for (let iter = 0; iter < 60; iter++) {
      let changed = false;
      for (const r of topo.routes) {
        if (r.end < 0 || d[r.end] === Infinity) continue;
        const c = cost(r.id) + d[r.end];
        if (c < d[r.start] - 1e-6) { d[r.start] = c; nx[r.start] = r.id; changed = true; }
      }
      if (!changed) break;
    }
    next.set(b.id, nx);
    dist.set(b.id, d);
  }
  return { next, dist };
}


/** The same selected directed route chain used by ATS; no reverse on a main line. */
export function routeReachesBerth(topo: Topology, table: RouteTable, signal: number, goal: number): boolean {
  const seen = new Set<number>();
  while (signal >= 0 && !seen.has(signal)) {
    seen.add(signal);
    const id = table.next.get(goal)?.[signal] ?? -1;
    if (id < 0) return false;
    const route = topo.routes[id];
    if (route.wrongDir) return false;
    if (route.berths.includes(goal)) return true;
    signal = route.end;
  }
  return false;
}

/** A reserved berth must admit the normal approach and depart to the normal
 * return stream after changing ends. Two head positions alone prove neither. */
export function berthRoundTripReachable(topo: Topology, table: RouteTable, from: number, arrival: number, departure: number, to: number): boolean {
  const approach = topo.routes.some(route => !route.wrongDir && route.berths.includes(from)
    && (route.berths.includes(arrival) || routeReachesBerth(topo, table, route.end, arrival)));
  if (!approach) return false;
  return topo.routes.some(route => !route.wrongDir && route.berths.includes(departure)
    && (route.berths.includes(to) || routeReachesBerth(topo, table, route.end, to)));
}
