/** Shared physical choice for a planned connection; no runtime reservations. */
import { LINE_INFO, OPERATIONS, STATIONS } from '../data/current';
import { plannedDwell } from './calibration';
import type { Plan, Task, Trip } from './model';
import { walkRouteToBerth } from './routePath';
import { buildRouteTable, type RouteTable } from './routeTable';
import { departureBerthAfterReverse, dwellFactorAt, effectiveEnd, effectiveStops, minTurn, platformBerth } from './timetable';
import { reversedBerthPoint, safeWaitingPoint, type Dir, type RouteStep, type Topology, type TrackPoint } from './topology';

type Path = { link: number; from: number; to: number }[];
const tables = new WeakMap<Topology, RouteTable>();
// Topology is shared and immutable during a simulation. Cache only geometry,
// never a plan, its live choices, occupancy, clocks or a train's state.
const geometry = new WeakMap<Topology, Map<string, boolean>>();

export function plannedNormalWork(dayType: Plan['dayType'], arrival: Pick<Trip, 'dir' | 'to' | 'stops'>,
  departure: Pick<Trip, 'dir'>): number {
  const last = effectiveStops(arrival as Trip).at(-1);
  const to = effectiveEnd(arrival as Trip);
  if (!last || to === undefined) return Infinity;
  const from = last.arr;
  return arrival.dir !== departure.dir ? minTurn(to)
    : plannedDwell(dayType, to, departure.dir, from, dwellFactorAt(dayType, from));
}

export function plannedWaitLong(dayType: Plan['dayType'], arrival: Trip, departure: Trip): boolean {
  const first = effectiveStops(departure)[0], last = effectiveStops(arrival).at(-1);
  return !!first && !!last && first.dep - last.arr > plannedNormalWork(dayType, arrival, departure) + 1e-6;
}

function project(topo: Topology, start: TrackPoint, goal: number): Path | undefined {
  const target = topo.berths[goal];
  if (!target) return;
  if (start.link === target.link && start.dir === target.dir && (target.offset - start.off) * start.dir >= 0)
    return [{ link: start.link, from: start.off, to: target.offset }];
  let table = tables.get(topo);
  if (!table) tables.set(topo, table = buildRouteTable(topo));
  const endNode = start.dir === 1 ? topo.links[start.link].b : topo.links[start.link].a;
  const candidates = topo.routes.flatMap(route => {
    const index = route.steps.findIndex(s => s.link === start.link && s.dir === start.dir);
    const first = route.steps[0], link = first && topo.links[first.link];
    if (index >= 0) return [{ route, index, prefix: false }];
    if (link && (first.dir === 1 ? link.a : link.b) === endNode) return [{ route, index: 0, prefix: true }];
    return [];
  }).filter(c => c.route.berths.includes(goal) || c.route.end >= 0 && Number.isFinite(table!.dist.get(goal)?.[c.route.end]))
    .sort((a, b) => (table!.dist.get(goal)?.[a.route.start] ?? Infinity) - (table!.dist.get(goal)?.[b.route.start] ?? Infinity));
  for (const candidate of candidates) {
    const path: Path = candidate.prefix ? [{ link: start.link, from: start.off, to: start.dir === 1 ? topo.links[start.link].len : 0 }] : [];
    const distance = walkRouteToBerth(topo, table, { route: candidate.route.id, index: candidate.index,
      offset: candidate.prefix ? undefined : start.off }, goal, (link, from, to) => path.push({ link, from, to }));
    if (Number.isFinite(distance)) return path;
  }
}

function history(path: Path | undefined): RouteStep[] {
  return (path ?? []).filter(p => p.from !== p.to).map(p => ({ link: p.link, dir: (p.to > p.from ? 1 : -1) as Dir }));
}

function nextGoal(topo: Topology, tasks: readonly Task[], first: number, berth: number): number | undefined {
  const platform = topo.berths[berth].platform;
  for (let i = first; i < tasks.length; i++) {
    const task = tasks[i];
    const goal = task.k === 'stop' ? i === first ? departureBerthAfterReverse(topo, berth, task.berth) : task.berth
      : task.k === 'reverse' ? task.chosen : task.k === 'stable' ? task.berth
        : task.k === 'depot' ? task.berth ?? topo.depots[task.depot].berth : undefined;
    if (goal === undefined || goal < 0 || !topo.berths[goal]) return;
    if (task.k === 'stop' && topo.berths[goal].platform === platform) continue;
    return goal;
  }
}

/** Candidates come from the real reverse task (whose choices use the same
 * dutyTurnBerths as terminalOccupancy). A single choice is made in task order;
 * alternatives are retained only if independently safe under this same rule. */
export function plannedWaitBerth(topo: Topology, arrival: Trip, departure: Trip, tasks: readonly Task[],
  reverseIndex: number, candidates: readonly number[], preferred?: number,
  actual?: { point: TrackPoint; incoming: RouteStep[]; length: number }) {
  const turning = arrival.dir !== departure.dir;
  const arrivalEnd = effectiveEnd(arrival);
  const platformAllowed = arrivalEnd !== undefined && (OPERATIONS.longWaitPlatformStations ?? []).includes(STATIONS[arrivalEnd]?.id);
  const approach = effectiveStops(arrival).slice(0, -1).reverse().find(s => s.stop);
  const ordered = preferred !== undefined && candidates.includes(preferred)
    ? [preferred, ...candidates.filter(b => b !== preferred)] : [...candidates];
  let cache = geometry.get(topo);
  if (!cache) geometry.set(topo, cache = new Map());
  const safe = (berth: number): boolean => {
    const b = topo.berths[berth];
    if (!b) return false;
    // A normal long terminal turn must wait off-platform. Explicit station
    // exceptions and same-direction continuations use their actual platform.
    if (turning && !platformAllowed && b.kind === 'platform') return false;
    const goal = turning && b.kind === 'platform' ? nextGoal(topo, tasks, reverseIndex + 1, berth) : undefined;
    const key = `${arrival.dir}/${approach?.st ?? -1}/${berth}/${turning ? 1 : 0}/${goal ?? -1}/${LINE_INFO.trainLength}`;
    const cached = cache!.get(key);
    if (cached !== undefined) return cached;
    const source = approach === undefined ? undefined : topo.berths[platformBerth(topo, approach.st, arrival.dir)];
    const routeHistory = history(source && project(topo, { link: source.link, off: source.offset, dir: source.dir }, berth));
    let result: boolean;
    if (turning && b.kind === 'platform') {
      const point = reversedBerthPoint(topo, berth, LINE_INFO.trainLength, routeHistory);
      result = !!point && goal !== undefined && safeWaitingPoint(topo, { ...point,
        incoming: routeHistory.slice().reverse().map(s => ({ link: s.link, dir: -s.dir as Dir })),
      }, LINE_INFO.trainLength, { afterTurn: true, destination: goal, path: project(topo, point, goal) });
    } else result = safeWaitingPoint(topo, { link: b.link, off: b.offset, dir: b.dir, incoming: routeHistory }, LINE_INFO.trainLength);
    cache!.set(key, result);
    return result;
  };
  const safeBerths = ordered.filter(safe);
  const selectedBerth = safeBerths[0] ?? ordered[0];
  const policyRejected = selectedBerth !== undefined && turning && !platformAllowed
    && topo.berths[selectedBerth]?.kind === 'platform';
  const actualSafe = !actual || safeWaitingPoint(topo, { ...actual.point, incoming: actual.incoming }, actual.length);
  return { selectedBerth, safeBerths, safe: selectedBerth !== undefined && safe(selectedBerth) && actualSafe, platformAllowed, policyRejected };
}
