/** Offline evidence for waits between adjacent live trips. No reservations or
 * runtime decisions are read or written. Depot-source approach times are not
 * inferred: a depot gate time alone is not a platform arrival time. */
import { LINE_INFO } from '../data/current';
import { buildRouteTable } from './ats';
import { walkRouteToBerth, type RouteTable } from './routePath';
import { plannedDwell } from './calibration';
import type { Plan, Task, Trip } from './model';
import { blockTasks, departureBerthAfterReverse, dwellFactorAt, minTurn, platformBerth, terminalOccupancy, turnbackAt } from './timetable';
import { reversedBerthPoint, safeWaitingPoint, type Dir, type RouteStep, type Topology, type TrackPoint } from './topology';

export interface PlannedWait {
  block: number; arrival: number; departure: number; station: number;
  from: number; to: number; gap: number; normalWork: number;
  berths: number[]; safeBerths: number[]; safe: boolean;
  reason: 'NORMAL_WORK' | 'SAFE_WAITING_POINT' | 'NO_SAFE_WAITING_POINT' | 'BLOCK_BREAK';
}
export interface PlannedWaitingIssue {
  severity: 'error'; code: 'UNSAFE_WAIT'; t: number; blocks: number[];
  arrival: number; departure: number; text: string;
}
export interface PlannedWaitingResult {
  waits: PlannedWait[]; issues: PlannedWaitingIssue[];
  /** Explicit gaps in this check, not exceptions to a discovered violation. */
  uncovered: readonly ['depot-start-approach', 'final-stabling'];
}

type Path = { link: number; from: number; to: number }[];
const tables = new WeakMap<Topology, RouteTable>();

/** Existing normal station-work budget, with no extra layover allowance.
 * A longer gap needs the separate whole-train safe-waiting proof. */
export function plannedNormalWork(dayType: Plan['dayType'], arrival: Pick<Trip, 'dir' | 'to' | 'stops'>,
  departure: Pick<Trip, 'dir'>): number {
  const from = arrival.stops.at(-1)!.arr;
  return arrival.dir !== departure.dir ? minTurn(arrival.to)
    : plannedDwell(dayType, arrival.to, departure.dir, from, dwellFactorAt(dayType, from));
}

/** Project existing interlocking routes, using the existing route table for
 * route choice. This supplies geometry only; safeWaitingPoint judges safety.
 * No switch-state routing, new route weights, or fake simulator is involved. */
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
    if (goal === undefined || goal < 0) return;
    if (task.k === 'stop' && topo.berths[goal].platform === platform) continue;
    return goal;
  }
}

/** Only adjacent-trip waits are covered. `from` includes waits crossing the
 * boundary; it never edits or exempts earlier issues in a full-plan call.
 * Normal work uses the existing diagram dwell/turn budget, with no extra
 * layover allowance. One physically safe actual berth is sufficient. */
export function plannedWaiting(ctx: { topo: Topology }, plan: Plan, options: { from?: number; connection?: { block:number; arrival:number; departure:number } } = {}): PlannedWaitingResult {
  const { topo } = ctx, length = LINE_INFO.trainLength;
  const waits: PlannedWait[] = [], issues: PlannedWaitingIssue[] = [];
  const occupancy = terminalOccupancy(plan, topo);
  for (const block of plan.blocks) {
    if(options.connection&&options.connection.block!==block.id)continue;
    const trips = block.trips.map(id => plan.trips[id]).filter(t => !t.cancelled);
    const tasks = blockTasks(topo, plan, block);
    for (let i = 1; i < trips.length; i++) {
      const a = trips[i - 1], d = trips[i], from = a.stops.at(-1)!.arr, to = d.stops[0].dep;
      if(options.connection&&(options.connection.arrival!==a.id||options.connection.departure!==d.id))continue;
      if (to < (options.from ?? -Infinity)) continue;
      const turning = a.dir !== d.dir;
      const normalWork = plannedNormalWork(plan.dayType, a, d);
      const wait: PlannedWait = { block: block.id, arrival: a.id, departure: d.id, station: a.to,
        from, to, gap: to - from, normalWork, berths: [], safeBerths: [], safe: false, reason: 'NO_SAFE_WAITING_POINT' };
      waits.push(wait);
      if (a.to !== d.from) { wait.reason = 'BLOCK_BREAK'; continue; }
      const turn = turning ? turnbackAt(topo, a.to, a.dir) : null;
      const hold = occupancy.get(a.to)?.find(h => h.block === block.id && h.arrival === a.id && h.departure === d.id);
      const lastArrival = tasks.map(t => t.k === 'stop' && t.trip === a.id).lastIndexOf(true);
      const firstDeparture = tasks.findIndex((t, index) => index > lastArrival && t.k === 'stop' && t.trip === d.id);
      const reverse = tasks.findIndex((t, index) => index > lastArrival && index < firstDeparture && t.k === 'reverse');
      const reverseTask = tasks[reverse];
      wait.berths = turning ? hold?.berths?.length ? hold.berths.slice()
        : reverseTask?.k === 'reverse' ? reverseTask.berths.slice() : turn?.kind === 'front' ? [turn.arrBerth] : []
        : [platformBerth(topo, a.to, a.dir)];
      const approachStop = a.stops.slice(0, -1).reverse().find(s => s.stop);
      for (const berth of wait.berths) {
        const b = topo.berths[berth];
        const source = approachStop === undefined ? undefined : topo.berths[platformBerth(topo, approachStop.st, a.dir)];
        const incoming = source && project(topo, { link: source.link, off: source.offset, dir: source.dir }, berth);
        const routeHistory = history(incoming);
        if (turning && b.kind === 'platform') {
          const point = reversedBerthPoint(topo, berth, length, routeHistory), goal = nextGoal(topo, tasks, reverse + 1, berth);
          if (point && goal !== undefined && safeWaitingPoint(topo, { ...point,
            incoming: routeHistory.slice().reverse().map(s => ({ link: s.link, dir: -s.dir as Dir })),
          }, length, { afterTurn: true, destination: goal, path: project(topo, point, goal) })) wait.safeBerths.push(berth);
        } else if (safeWaitingPoint(topo, { link: b.link, off: b.offset, dir: b.dir, incoming: routeHistory }, length))
          wait.safeBerths.push(berth);
      }
      wait.safe = wait.gap <= normalWork + 1e-6 || wait.safeBerths.length > 0;
      wait.reason = wait.gap <= normalWork + 1e-6 ? 'NORMAL_WORK' : wait.safe ? 'SAFE_WAITING_POINT' : 'NO_SAFE_WAITING_POINT';
      if (!wait.safe) issues.push({ severity: 'error', code: 'UNSAFE_WAIT', t: from, blocks: [block.id], arrival: a.id, departure: d.id,
        text: `${topo.stations[a.to].name} ${a.no}→${d.no} 候班 ${wait.gap.toFixed(1)} s，正常作业 ${normalWork.toFixed(1)} s，实际候选泊位无全列安全等待点` });
    }
  }
  return { waits, issues, uncovered: ['depot-start-approach', 'final-stabling'] };
}
