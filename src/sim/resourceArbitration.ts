/** Whole-movement admission. Logical phases share one grant; interlocking
 * still sets and releases each physical route separately. No driving mode or
 * automation grade participates in resource ownership. */
import type { Sim } from './engine';
import { STANDBY_CALL, type Task, type Train, type StopTask } from './model';
import type { TrackPoint, RouteStep, WaitingStage } from './topology';
import { pointAhead, reversedBerthPoint, downstreamTerminal, safeWaitingPoint, topologyResourceLinks, sharedTransferLink } from './topology';
import { approachLocked, committedTrain } from './interlocking';
import { canStopBeforeSignal } from './protection';
import { SIGNAL_MARGIN } from './protection';
import type { HaltCode, WaitAlternative } from './halt';
import { blockTasks, departureBerthAfterReverse } from './timetable';
import { MIN_DWELL } from './calibration';
import { LINE_INFO } from '../data/current';
import { peekVehicle } from './yard';
import { distanceToBerthFrom, signalAheadFrom, depotBerth, berthHolder, cowTask, applyDepotChoice, routeUser, routeOccupant, trainLabel, depotSourceBusy, arsReadyAt } from './ats';

export interface ResourcePhase {
  goal: number;
  start: TrackPoint;
  routes: number[];
  path: { link: number; from: number; to: number }[];
  distance: number;
}
export interface ResourceOption {
  phases: ResourcePhase[];
  sections: Set<number>;
  choices: { index: number; berth: number }[];
  readyAt?: number;
  /** Entry signal at the last safe waiting point; -1 if already inside. */
  entry?: number;
  entryDistance?: number;
  /** Physical queue before entry. Inspected for predecessors, never claimed. */
  approach?: ResourcePhase['path'];
  resourceLinks?: Set<number>;
  /** Rule 2: reachable entry geometry whose later stage has no route.
   * It can reject admission, never grant or reserve an incomplete movement. */
  unreachable?: { start: TrackPoint; goal: number };
}
export interface ResourceRequest {
  /** Existing train id, or -(block.id+1) for a vehicle still inside the yard. */
  id: number;
  train?: Train;
  tasks: Task[];
  options: ResourceOption[];
  time: number;
  origin?: StopTask;
  inside: boolean;
  committed: boolean;
  readyAt: number;
  /** A complete consist can wait here without occupying a shared throat. */
  safeHere?: boolean;
}
export interface ResourceDecision {
  request: ResourceRequest;
  option: ResourceOption;
  admitted: boolean;
  blocker: number;
  detail: string;
  code?: HaltCode;
  /** Actual first limiting cause for each attempted option, from this allocation. */
  alternatives?: WaitAlternative[];
}
export interface ResourceAllocation {
  decisions: Map<number, ResourceDecision>;
  claims: Map<number, ResourceDecision>;
  switches: Map<number, { decision: ResourceDecision; positions: Set<'N' | 'R'> }[]>;
}

/** Carry only topology IDs and geometry, never timetable IDs or clocks. */
export interface ResourceTransit {
  option: ResourceOption;
  entered: boolean;
  visited: boolean;
}

// Allocation is derived each tick. The physical movement's geometry is carried
// separately in Sim.resourceTransit until its entire body clears the throat.
const allocations = new WeakMap<Sim, ResourceAllocation>();
/** Geometry for approaching trains, without admission or ownership. */
const approaches = new WeakMap<Sim, Map<number, ResourceRequest>>();
const chains = new WeakMap<Sim['routeTable'], Map<string, number[]>>();
/** These pure geometry queries are shared within one allocation only. */
const queryCaches = new WeakMap<Sim, ReturnType<typeof newQueryCache>>();
function newQueryCache() {
  return {
    protection: new WeakMap<ResourceOption, Map<number, boolean>>(),
    running: new WeakMap<ReadonlySet<number>, Map<number, boolean>>(),
    switches: new WeakMap<ResourcePhase, Sim['topo']['routes'][number]['switches']>(),
  };
}
function queryCache(sim: Sim) {
  let cache = queryCaches.get(sim);
  if (!cache) queryCaches.set(sim, cache = newQueryCache());
  return cache;
}

export function routesToBerth(sim: Sim, signal: number, goal: number): number[] {
  let cache = chains.get(sim.routeTable);
  if (!cache) chains.set(sim.routeTable, cache = new Map());
  const key = `${signal}/${goal}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const table = sim.routeTable.next.get(goal), out: number[] = [], seen = new Set<number>();
  while (table && signal >= 0 && !seen.has(signal)) {
    seen.add(signal);
    const rid = table[signal];
    if (rid < 0) break;
    out.push(rid);
    const route = sim.topo.routes[rid];
    if (route.berths.includes(goal)) break;
    signal = route.end;
  }
  cache.set(key, out);
  return out;
}

function taskBerth(sim: Sim, task: Task): number {
  return task.k === 'stop' ? task.berth : task.k === 'reverse' ? task.chosen
    : task.k === 'depot' ? depotBerth(sim.topo, task) : task.k === 'stable' ? task.berth : -1;
}

function sharedLink(sim: Sim, link: number): boolean {
  return sharedTransferLink(sim.topo, link);
}

function unsafeBerth(sim: Sim, berth: number): boolean {
  const b = sim.topo.berths[berth];
  return sharedLink(sim, b.link) || b.reverse;
}

function safeRunningLink(sim: Sim, link: number, dir: number, resources: ReadonlySet<number>): boolean {
  const cache = queryCache(sim).running;
  let results = cache.get(resources);
  if (!results) cache.set(resources, results = new Map());
  const key = link * 2 + (dir === 1 ? 0 : 1), cached = results.get(key);
  if (cached !== undefined) return cached;
  const l = sim.topo.links[link];
  const safe = safeWaitingPoint(sim.topo, { link, off: dir === 1 ? l.len : 0, dir: dir as 1 | -1 },
    l.len, { protectedLinks: resources });
  results.set(key, safe);
  return safe;
}

/** Rule 2: the grant ends when the WHOLE body reaches a safe place, rather
 * than when its head leaves the siding or when a later passenger stop ends. */
function refreshTransits(sim: Sim) {
  for (const [id, transit] of sim.resourceTransit) {
    const tr = sim.trains.get(id), option = transit.option, resources = option.resourceLinks ?? new Set<number>();
    if (!tr) { sim.resourceTransit.delete(id); continue; }
    transit.entered ||= tr.body.some(b => option.sections.has(sim.topo.links[b.link].section));
    transit.visited ||= tr.body.some(b => resources.has(b.link));
    if (!transit.entered) continue;
    const goal = sim.topo.berths[option.phases.at(-1)!.goal];
    const point = { link: tr.link, off: tr.off, dir: tr.dir, incoming: tr.hist };
    const independent = safeWaitingPoint(sim.topo, point, tr.len);
    const parked = (goal.kind === 'tail' || goal.kind === 'siding') && independent && tr.body.some(b => b.link === goal.link);
    // A turn-platform boundary retains only its physical context until the
    // separate departure; its next allocation no longer owns the old exit.
    const platform = goal.kind === 'platform' && !resources.has(goal.link) && independent
      && tr.dir === goal.dir && tr.body.every(b => b.link === goal.link);
    const clear = transit.visited && safeWaitingPoint(sim.topo, point, tr.len, { protectedLinks: resources });
    if (parked || platform || clear || tr.phase === 'stabled' && independent) sim.resourceTransit.delete(id);
  }
}

/** Rule 1: physical resource inventory, independent of train priority. */
function resourceLinks(sim: Sim): ReadonlySet<number> {
  return topologyResourceLinks(sim.topo);
}

/** The same physical platform remains a resource through its cab change
 * and origin stop, even though its two directional berths are different. */
function optionResourceLinks(sim: Sim, option: ResourceOption, tasks: Task[]): Set<number> {
  const links = new Set(resourceLinks(sim));
  for (const c of option.choices) {
    const task = tasks[c.index], next = tasks[c.index + 1], berth = sim.topo.berths[c.berth];
    const turn = next?.k === 'reverse' && sim.topo.berths[option.choices.find(v => v.index === c.index + 1)?.berth ?? next.chosen];
    if (task.k === 'stop' && turn && berth.platform >= 0 && turn.platform === berth.platform
      || task.k === 'reverse' && berth.kind === 'platform' || task.k === 'stable') links.add(berth.link);
  }
  return links;
}

/** Rule 2: room for the whole consist before a signal, clear of resources,
 * exit paths and switches. A short approach moves admission to the previous
 * signal; it never introduces a distance threshold. */
function safeApproach(sim: Sim, phase: ResourcePhase, index: number, length: number, hazards: Set<number>): boolean {
  const path = phase.path.slice(0, index), head = path.at(-1);
  return !!head && safeWaitingPoint(sim.topo, { link: head.link, off: head.to,
    dir: head.to >= head.from ? 1 : -1,
    incoming: path.map(p => ({ link: p.link, dir: p.to >= p.from ? 1 : -1 })),
  }, length + SIGNAL_MARGIN, { protectedLinks: hazards });
}

/** Rule 2: finish building at the first whole-body safe exit, before
 * considering any later stop or resource in the circulation. */
function clipSafeExit(sim: Sim, option: ResourceOption, resources: Set<number>, length: number, tr?: Train): boolean {
  let visited = !!tr && !!sim.resourceTransit.get(tr.id)?.visited, clear = 0;
  if (visited && tr) for (const b of tr.body) {
    const dir = tr.hist.find(h => h.link === b.link)?.dir ?? tr.dir;
    if (!safeRunningLink(sim, b.link, dir, resources)) break;
    clear += b.to - b.from;
  }
  for (let pi = 0; pi < option.phases.length; pi++) {
    const phase = option.phases[pi];
    for (let i = 0; i < phase.path.length; i++) {
      const step = phase.path[i], dir = step.to >= step.from ? 1 : -1;
      if (resources.has(step.link)) visited = true;
      if (!safeRunningLink(sim, step.link, dir, resources)) { clear = 0; continue; }
      if (!visited) continue;
      const distance = Math.abs(step.to - step.from), needed = length + SIGNAL_MARGIN - clear;
      if (distance >= needed) {
        // Candidate branches share their prefix; clipping one must never
        // truncate another candidate's geometry.
        const path = [...phase.path.slice(0, i), { ...step, to: step.from + dir * Math.max(0, needed) }];
        const clipped = { ...phase, path, routes: phase.routes.filter(rid =>
          sim.topo.routes[rid].steps.some(s => path.some(v => v.link === s.link))) };
        option.phases = [...option.phases.slice(0, pi), clipped];
        const goals = new Set(option.phases.map(v => v.goal));
        option.choices = option.choices.filter(c => goals.has(c.berth));
        return true;
      }
      clear += distance;
    }
  }
  return false;
}

/** Rules 1/2: restrict the first approach to its last safe signal. Later
 * phases are the exit promised with admission, never the upstream main line. */
function scopeOption(sim: Sim, option: ResourceOption, tasks: Task[], first: number, length: number, tr?: Train): boolean {
  const resources = optionResourceLinks(sim, option, tasks);
  const transit = tr ? sim.resourceTransit.get(tr.id) : undefined;
  if (transit?.entered) for (const link of transit.option.resourceLinks ?? []) resources.add(link);
  // A platform being vacated by a cab change remains part of this same
  // movement until its tail and exit throat have cleared.
  const source = tasks[first - 1];
  const reversing = tasks[first];
  const turn = reversing?.k === 'reverse'
    ? sim.topo.berths[option.choices.find(c => c.index === first)?.berth ?? reversing.chosen] : undefined;
  if (source?.k === 'stop' && turn && sim.topo.berths[source.berth].platform >= 0
    && sim.topo.berths[source.berth].platform === turn.platform)
    resources.add(sim.topo.berths[source.berth].link);
  if (tr && turn?.kind === 'platform') {
    for (const b of tr.body) {
      const platform = sim.topo.links[b.link].platform;
      if (platform >= 0 && platform === turn.platform) resources.add(b.link);
    }
  }
  clipSafeExit(sim, option, resources, length, tr);
  if (!transit?.entered && !option.phases.some(p => p.path.some(s => resources.has(s.link)))) return false;
  const hazards = new Set(resources);
  const resourcePhase = option.phases.findIndex(p => p.path.some(s => resources.has(s.link)));
  for (const p of option.phases.slice(resourcePhase + 1)) for (const s of p.path) hazards.add(s.link);
  const path = option.phases.flatMap(p => p.path), boundaries: { rid: number; signal: number; index: number; phase: number; local: number }[] = [];
  let offset = 0;
  option.phases.forEach((p, phase) => {
    for (const rid of p.routes) {
      const r = sim.topo.routes[rid], local = p.path.findIndex(s => s.link === r.steps[0].link);
      if (local >= 0) boundaries.push({ rid, signal: r.start, index: offset + local, phase, local });
    }
    offset += p.path.length;
  });
  const hit = path.findIndex(p => hazards.has(p.link));
  let candidate = boundaries.length - 1;
  while (candidate >= 0 && boundaries[candidate].index > hit) candidate--;
  while (candidate >= 0 && !safeApproach(sim, { ...option.phases[0], path }, boundaries[candidate].index, length, hazards)) candidate--;
  const entry = hit === 0 || transit?.entered ? undefined : boundaries[Math.max(0, candidate)];
  const index = entry?.index ?? 0;
  option.entry = entry?.signal ?? -1;
  option.entryDistance = path.slice(0, index).reduce((sum, p) => sum + Math.abs(p.to - p.from), 0);
  option.approach = path.slice(0, index);
  const dropped = new Set(option.phases.slice(0, entry?.phase ?? 0).map(p => p.goal));
  option.phases = option.phases.slice(entry?.phase ?? 0);
  option.choices = option.choices.filter(c => !dropped.has(c.berth));
  const phase = option.phases[0];
  option.phases[0] = { ...phase, path: phase.path.slice(entry?.local ?? 0),
    routes: entry ? phase.routes.slice(phase.routes.indexOf(entry.rid)) : phase.routes };
  option.resourceLinks = resources;
  option.sections.clear();
  for (const p of option.phases) {
    for (const s of p.path) option.sections.add(sim.topo.links[s.link].section);
  }
  return true;
}

function phaseTo(sim: Sim, start: TrackPoint, goal: number): ResourcePhase | undefined {
  const path: ResourcePhase['path'] = [];
  const distance = distanceToBerthFrom(sim, start.link, start.off, start.dir, goal,
    (link, from, to) => path.push({ link, from, to }));
  if (!Number.isFinite(distance)) return undefined;
  const signal = signalAheadFrom(sim, start.link, start.off, start.dir, Infinity);
  // A stopping point reached on this link precedes the next signal.
  const routes = signal && signal.dist < distance ? routesToBerth(sim, signal.sig, goal) : [];
  return { goal, start, path, routes, distance };
}

/** Describe the next movement geometrically; the topology helper alone
 * decides whether the platform can wait. Same-platform stops do not move it. */
function stageBeyondPlatform(sim: Sim, tasks: Task[], first: number, start: TrackPoint, platform: number): WaitingStage {
  const arrival = sim.topo.berths.find(b => b.platform === platform && b.dir === -start.dir);
  for (let index = first; index < tasks.length; index++) {
    const task = tasks[index];
    let destination = taskBerth(sim, task);
    if (destination < 0) return { afterTurn: true };
    // Arrival commits this same projection when the ends change; describe
    // the actual source platform before considering the following movement.
    if (index === first && task.k === 'stop' && arrival)
      destination = departureBerthAfterReverse(sim.topo, arrival.id, destination);
    if (task.k === 'stop' && sim.topo.berths[destination].platform === platform) continue;
    return { afterTurn: true, destination, path: phaseTo(sim, start, destination)?.path };
  }
  return { afterTurn: true };
}

/** Rule 2: a route may extend past the next safe point; only the switches
 * physically traversed by this protected movement belong to its grant. */
function phaseSwitches(sim: Sim, phase: ResourcePhase) {
  const cache = queryCache(sim).switches, cached = cache.get(phase);
  if (cached) return cached;
  const sections = new Set(phase.path.map(p => sim.topo.links[p.link].section));
  const switches = phase.routes.flatMap(rid => sim.topo.routes[rid].switches)
    .filter(sw => sim.topo.switches[sw.sw].sections.some(sec => sections.has(sec)));
  cache.set(phase, switches);
  return switches;
}

/** Alternatives are collected without changing tasks or writing reservations. */
function optionsFor(sim: Sim, tasks: Task[], start: TrackPoint, length: number, first: number, history: RouteStep[], held: Set<number>, tr?: Train): ResourceOption[] {
  const incomplete: ResourceOption[] = [];
  const build = (index: number, point: TrackPoint, option: ResourceOption, depth: number, incoming: RouteStep[], projected?: number): ResourceOption[] => {
    const task = tasks[index];
    if (!task || depth > tasks.length) return [];
    let candidates = [projected ?? taskBerth(sim, task)];
    if (task.k === 'reverse') {
      const kind = sim.topo.sections[sim.topo.links[point.link].section].kind;
      const physical = (kind === 'tail' || kind === 'siding') && sim.topo.stations[task.station].turnbackBerths.find(id => {
        const b = sim.topo.berths[id];
        return b.dir === point.dir && (b.link === point.link || kind === 'tail' && b.kind === 'tail'
          && sim.topo.links[b.link].track === sim.topo.links[point.link].track);
      });
      candidates = physical !== false && physical !== undefined ? [physical] : [task.chosen, ...task.berths.filter(b => b !== task.chosen)];
    } else if (task.k === 'depot') {
      const dp = sim.topo.depots[task.depot];
      // Once physically on the selected branch it cannot change underneath us.
      const actual = dp.transferPaths.findIndex(p => p.stub === point.link || p.links.includes(point.link));
      candidates = actual >= 0 ? [dp.entryBerths[actual]] : [depotBerth(sim.topo, task), ...dp.entryBerths.filter(b => b !== depotBerth(sim.topo, task))];
    } else if (task.k === 'stable' && task.berth < 0) {
      const station = task.station ?? sim.topo.sections[sim.topo.links[point.link].section].station;
      candidates = sim.topo.stations[station]?.turnbackBerths ?? [];
    }
    const out: ResourceOption[] = [];
    for (const goal of candidates) {
      if (goal < 0) continue;
      const phase = phaseTo(sim, point, goal);
      if (!phase) {
        if (option.phases.length) incomplete.push({ ...option, unreachable: { start: point, goal } });
        continue;
      }
      // scopeOption builds sections once from the final clipped geometry.
      const next: ResourceOption = { phases: [...option.phases, phase], sections: new Set(),
        choices: [...option.choices, { index, berth: goal }] };
      const resources = optionResourceLinks(sim, next, tasks);
      for (const link of held) resources.add(link);
      if (clipSafeExit(sim, next, resources, length, tr)) { out.push(next); continue; }
      const berth = sim.topo.berths[goal];
      const path = incoming.slice();
      for (const p of phase.path) if (path.at(-1)?.link !== p.link)
        path.push({ link: p.link, dir: (p.to >= p.from ? 1 : -1) as 1 | -1 });
      const reversed = () => reversedBerthPoint(sim.topo, goal, length, path);
      const canWaitAfterTurn = (nextIndex: number) => {
        const rear = reversed();
        return !!rear && safeWaitingPoint(sim.topo, { ...rear,
          incoming: path.slice().reverse().map(s => ({ link: s.link, dir: -s.dir as 1 | -1 })),
        }, length, stageBeyondPlatform(sim, tasks, nextIndex, rear, berth.platform));
      };
      // The common topology rule ends at an independent siding, or at a
      // whole-platform cab change whose next movement is ordinary main line.
      // A turn continuing into another resource still includes its exit.
      const nextTask = tasks[index + 1];
      const reverseNext = task.k === 'stop' && nextTask?.k === 'reverse' && nextTask.station === task.station;
      if (reverseNext) {
        if (nextTask.chosen === goal) {
          if (canWaitAfterTurn(index + 2)) { out.push(next); continue; }
          const rear = reversed();
          const stop = tasks[index + 2];
          const berth = stop?.k === 'stop' && stop.station === task.station
            ? departureBerthAfterReverse(sim.topo, goal, stop.berth) : undefined;
          if (rear) out.push(...build(index + 2, rear, next, depth + 1, [], berth));
        } else out.push(...build(index + 1, { link: berth.link, off: berth.offset, dir: berth.dir }, next, depth + 1, path));
      } else if (task.k === 'reverse') {
        if (canWaitAfterTurn(index + 1)) { out.push(next); continue; }
        const rear = reversed();
        const berth = nextTask?.k === 'stop' && nextTask.station === task.station
          ? departureBerthAfterReverse(sim.topo, goal, nextTask.berth) : undefined;
        if (rear) out.push(...build(index + 1, rear, next, depth + 1, [], berth));
      } else if (task.k === 'stop' && held.has(berth.link) && berth.platform >= 0
        && sim.topo.links[point.link].platform === berth.platform
        && safeWaitingPoint(sim.topo, { link: berth.link, off: berth.offset, dir: berth.dir, incoming: path }, length,
          stageBeyondPlatform(sim, tasks, index + 1, { link: berth.link, off: berth.offset, dir: berth.dir }, berth.platform))) {
        out.push(next);
      } else if (task.k === 'stop' && (unsafeBerth(sim, goal) || held.has(berth.link)
        || resources.has(berth.link)) && tasks[index + 1]) {
        out.push(...build(index + 1, { link: berth.link, off: berth.offset, dir: berth.dir }, next, depth + 1, path));
      } else out.push(next);
    }
    return out;
  };
  const complete = build(first, start, { phases: [], sections: new Set(), choices: [] }, 0, history);
  return complete.length ? complete : incomplete;
}

function firstTaskIndex(tr: Train): number {
  // An on-platform cab change has not released the platform while dwelling.
  if (tr.phase === 'dwell' && tr.tasks[1]?.k === 'reverse' && tr.tasks[0]?.k === 'stop'
    && tr.tasks[1].chosen === tr.tasks[0].berth) return 0;
  return tr.phase === 'dwell' || tr.phase === 'reversing' ? 1 : 0;
}

/** A positioning trip can omit its origin stop task. Its diagram origin is
 * still the departure clock, provided it is the actual overnight location.
 * Read the current plan so carried trip ids/times use the current day. */
export function sourceDepartureAt(sim: Sim, task: Task): number | null {
  if (task.k !== 'stop') return null;
  if (task.dep !== null) return task.dep;
  if (!task.stabledOut) return null;
  const trip = sim.plan.trips[task.trip], block = trip && sim.plan.blocks[trip.block];
  const origin = trip?.stops[0], start = block?.start;
  if (trip && !trip.cancelled && !trip.completed && origin && Number.isFinite(origin.dep)
    && start?.kind === 'stable' && start.station === origin.st && trip.from === origin.st
    && (start.berth === undefined || sim.topo.berths[start.berth]?.station === origin.st)) return origin.dep;
  // Do not invent a departure or stop the simulation for incomplete plans.
  sim.log('B', '运营', `存车首动时刻无法对应实际过夜位置（车次${task.trip}）`,
    { key: `source-departure-${task.trip}`, code: 'SOURCE_DEPARTURE_UNKNOWN' });
  return null;
}

/** Existing source readiness, shared by admission, ordinary ARS and onboard. */
export function sourceReadyAt(sim: Sim, task: Task): number {
  if (task.k !== 'stop' || !(task.standby || task.stabledOut)) return -Infinity;
  const departure = sourceDepartureAt(sim, task);
  return departure === null ? -Infinity : departure - STANDBY_CALL;
}

/** Scheduling at an origin applies only to a motion entering its physical
 * platform. An arrival followed by an independent tail ends before it. */
function entersOrigin(sim: Sim, option: ResourceOption, origin: StopTask): boolean {
  const platform = sim.topo.berths[origin.berth].platform;
  return platform >= 0 && option.phases.some(p => sim.topo.berths[p.goal].platform === platform
    && p.path.some(s => sim.topo.links[s.link].platform === platform));
}

/** Project the same departure platform that arrival will commit after a
 * cab change, without mutating a future stop during admission. */
function optionOrigin(sim: Sim, option: ResourceOption, tasks: Task[]): { task: StopTask; index: number } | undefined {
  for (const choice of option.choices) {
    const task = tasks[choice.index];
    if (task.k !== 'stop' || task.dep === null || task.arr !== null && task.arr !== task.dep) continue;
    const projected = choice.berth === task.berth ? task : { ...task, berth: choice.berth };
    if (entersOrigin(sim, option, projected)) return { task: projected, index: choice.index };
  }
  // A source trip's arrival and its same-platform cab change enter its real
  // origin even when the safe-platform boundary clips the later stop phase.
  // A different trip is a later movement and keeps the independent boundary.
  for (const choice of option.choices) {
    const arrival = tasks[choice.index];
    if (arrival.k !== 'stop' || arrival.trip < 0) continue;
    const platform = sim.topo.berths[choice.berth].platform;
    if (platform < 0) continue;
    let turned = false;
    for (let index = choice.index + 1; index < tasks.length; index++) {
      const task = tasks[index];
      if (task.k === 'reverse') {
        const berth = option.choices.find(c => c.index === index)?.berth ?? task.chosen;
        if (berth < 0 || sim.topo.berths[berth].platform !== platform) break;
        turned = true; continue;
      }
      if (task.k !== 'stop' || task.trip !== arrival.trip) break;
      const berth = turned ? departureBerthAfterReverse(sim.topo, choice.berth, task.berth) : task.berth;
      if (sim.topo.berths[berth].platform !== platform) break;
      if (turned && task.dep !== null && (task.arr === null || task.arr === task.dep)) {
        const projected = berth === task.berth ? task : { ...task, berth };
        if (entersOrigin(sim, option, projected)) return { task: projected, index };
      }
    }
  }
}

function makeRequest(sim: Sim, id: number, tasks: Task[], point: TrackPoint, length: number, first: number, tr?: Train): ResourceRequest | undefined {
  const task = tasks[first];
  if (!task || task.k === 'rescue') return undefined;
  const goal = taskBerth(sim, task);
  // An unselected reverse still has real berth alternatives. Refusing its
  // first grant must not prevent collecting those alternatives next tick.
  if (goal < 0 && task.k !== 'stable' && task.k !== 'reverse') return undefined;
  const nextTask = tasks[first + 1];
  const reverse = nextTask?.k === 'reverse' && task.k === 'stop' && nextTask.station === task.station;
  const physical = resourceLinks(sim);
  const transit = tr ? sim.resourceTransit.get(tr.id) : undefined;
  const departing = !!tr && (!!transit || tr.body.some(p => physical.has(p.link)));
  if (tr && task.k === 'stop' && !reverse && !departing && !unsafeBerth(sim, goal)) return undefined;
  const options = optionsFor(sim, tasks, point, length, first, tr?.hist ?? [{ link: point.link, dir: point.dir }], transit?.option.resourceLinks ?? new Set(), tr)
    .filter(option => scopeOption(sim, option, tasks, first, length, tr));
  // No distance cutoff: a remote request can never outrank real occupancy.
  // Collection distance must not become an additional operating rule.
  if (!options.length) return undefined;
  // Rule 3: use the actual motion's stops, never a fixed number of later
  // tasks or a future circulation which the motion does not enter.
  const origin = options.map(o => optionOrigin(sim, o, tasks)).find(Boolean)?.task;
  const firstPhase = options[0].phases[0];
  const inside = !!tr && (!!transit?.entered || options.some(option => occupiesMovement(tr, option))
    || tr.body.some(p => options.some(o => o.resourceLinks!.has(p.link))));
  const turnPlatform = !!tr && sim.topo.links[tr.link].platform >= 0 && !!transit?.option.resourceLinks?.has(tr.link);
  const safeHere = !!tr && safeWaitingPoint(sim.topo,
    { link: tr.link, off: tr.off, dir: tr.dir, incoming: tr.hist }, length,
    turnPlatform ? stageBeyondPlatform(sim, tasks, first, { link: tr.link, off: tr.off, dir: tr.dir }, sim.topo.links[tr.link].platform) : {});
  const committed = !!tr && firstPhase.routes.some(rid => {
    const ar = sim.routes.get(rid);
    return ar && (committedTrain(sim, sim.topo.routes[rid].start) === tr.id
      || tr.maSigs.includes(sim.topo.routes[rid].start) && !canStopBeforeSignal(sim, tr, sim.topo.routes[rid].start, 'supervision'));
  });
  for (const option of options) {
    option.readyAt = sim.t;
    // The separate platform departure uses the existing ARS stage window;
    // waiting for its timetable must not reserve the whole ordinary exit.
    if (tr && turnPlatform && safeHere) option.readyAt = Math.max(option.readyAt, arsReadyAt(tr));
    const planned = optionOrigin(sim, option, tasks);
    // A safe-platform arrival may retain its source-trip origin for order,
    // while the origin stop itself belongs to the separate departure stage.
    if (!planned || !option.choices.some(c => c.index === planned.index) || inside && !safeHere) continue;
    const { task: origin, index: ix } = planned;
    const prep = tasks.slice(first, ix).reduce((n, t) => n + (t.k === 'reverse' ? t.minTime : t.k === 'stop' ? MIN_DWELL : 0), 0);
    // The existing arrival window is measured to the origin stop. The
    // protected exit after that stop must not move its clock earlier.
    const originPhase = option.phases.findIndex(p => sim.topo.berths[p.goal].platform === sim.topo.berths[origin.berth].platform);
    const distance = option.phases.slice(0, originPhase + 1).reduce((n, p) => n + p.distance, 0);
    const station = sim.topo.stations[origin.station];
    const terminal = station.turnbackBerths.length > 0;
    const edge = ['DN', 'UP'].some(dir => downstreamTerminal(dir as 'DN' | 'UP') === origin.station);
    // Existing origin arrival windows, applied once before the shared motion.
    if (!terminal || !edge || !tr) option.readyAt = Math.max(option.readyAt,
      origin.dep! - distance / 15 - 30 - prep - (terminal ? 90 : 40));
  }
  const readyAt = Math.min(...options.map(o => o.readyAt!));
  // Existing standby/stabling release is a source-readiness condition, not a
  // reservation lasting until a future service. The shared throat cannot wait.
  const callAt = !inside || safeHere ? Math.max(sim.t, sourceReadyAt(sim, task)) : sim.t;
  for (const option of options) option.readyAt = Math.max(option.readyAt!, callAt);
  const request = { id, train: tr, tasks, options, inside, committed, readyAt: Math.max(readyAt, callAt), origin, safeHere,
    time: tr?.halt.since || sim.t };
  approaches.get(sim)?.set(id, request);
  // Keep the prospective geometry for ARS, but a distant train cannot
  // acquire ownership across intervening ordinary signals.
  if (tr && !inside && !committed && !options.some(o => o.entry === tr.nextSignal)) return undefined;
  return request;
}

export function collectResourceRequests(sim: Sim): ResourceRequest[] {
  const requests: ResourceRequest[] = [];
  for (const tr of sim.trainList) {
    if (tr.failed && !sim.resourceTransit.get(tr.id)?.entered || !['run', 'dwell', 'reversing'].includes(tr.phase)) continue;
    const first = firstTaskIndex(tr);
    const reverse = tr.phase === 'reversing' && tr.tasks[0]?.k === 'reverse' ? tr.tasks[0] : undefined;
    const point = reverse ? reversedBerthPoint(sim.topo, reverse.chosen, tr.len, tr.hist) : { link: tr.link, off: tr.off, dir: tr.dir };
    const transit = sim.resourceTransit.get(tr.id);
    const r = point ? makeRequest(sim, tr.id, tr.tasks, point, tr.len, first, tr) : undefined;
    if (r) requests.push(r);
    else if (transit?.entered) requests.push({ id: tr.id, train: tr, tasks: tr.tasks,
      options: [structuredClone(transit.option)], inside: true, committed: false,
      readyAt: sim.t, time: tr.halt.since || sim.t });
  }
  for (const b of sim.plan.blocks) {
    if (b.start.kind !== 'depot' || b.train !== undefined || sim.blockDone.has(b.id) || b.start.time > sim.t) continue;
    const first = b.trips.map(id => sim.plan.trips[id]).find(t => !t.cancelled);
    if (!first) continue;
    // Rule 2: a duty without an available source consist cannot execute a
    // whole movement and therefore receives no reservation on the line.
    if (!peekVehicle(sim, b.start.depot, b)) continue;
    const dp = sim.topo.depots[b.start.depot], path = dp.transferPaths[dp.portals.exit[first.dir].path];
    const outGate = sim.topo.links[path.links[2]];
    const link = sim.topo.nodes[outGate.a].links.find(l => l !== outGate.id)!;
    // Rule 2: a source still holding the previous consist cannot execute
    // another departure, so it cannot reserve that consist's forward exit.
    if (depotSourceBusy(sim, outGate.id, link)) continue;
    const r = makeRequest(sim, -(b.id + 1), blockTasks(sim.topo, sim.plan, b), { link, off: 15, dir: -1 }, LINE_INFO.trainLength, 0);
    if (r) { r.time = b.start.time; requests.push(r); }
  }
  return requests;
}

interface ResourceBlocker { train: number; detail: string; code: HaltCode }
/** Rule 2: a clipped exit may enter a platform but finish safely before its
 * stopping berth. That later berth is not part of this resource movement. */
function reachesBerth(sim: Sim, phase: ResourcePhase, berth = phase.goal): boolean {
  const b = sim.topo.berths[berth];
  return phase.path.some(p => p.link === b.link && Math.min(p.from, p.to) <= b.offset && Math.max(p.from, p.to) >= b.offset);
}

function bodyBlocker(sim: Sim, option: ResourceOption, self: number): ResourceBlocker | undefined {
  // Rule 3: an actual predecessor must clear before a rear applicant can
  // receive this entry. Its ordinary approach is inspected, never reserved.
  for (const p of option.approach ?? []) {
    const low = Math.min(p.from, p.to), high = Math.max(p.from, p.to);
    const front = sim.linkBodies.get(p.link)?.find(b => b.train !== self && b.to > low && b.from < high);
    if (front) return { train: front.train, detail: `${sim.topo.sections[sim.topo.links[p.link].section].name} 入口前车`, code: 'TRAIN_AHEAD' };
  }
  for (const phase of option.phases) {
    const holder = reachesBerth(sim, phase)
      ? berthHolder(sim, phase.goal, self, true) : -1;
    if (holder >= 0) return { train: holder, detail: `${sim.topo.berths[phase.goal].name} 实占`, code: 'BERTH_WAIT' };
    for (const p of phase.path) {
      const oriented = { link: p.link, off: p.from, dir: (p.to >= p.from ? 1 : -1) as 1 | -1 };
      const body = sim.linkBodies.get(p.link)?.find(b => b.train !== self
        && (pointAhead(oriented, p.from, b.to) || pointAhead(oriented, p.from, b.from))
        && Math.max(b.from, Math.min(p.from, p.to)) <= Math.min(b.to, Math.max(p.from, p.to)));
      if (body) return { train: body.train, detail: `${sim.topo.sections[sim.topo.links[p.link].section].name} 实占`, code: 'TRAIN_AHEAD' };
    }
  }
}

function authorityBlocker(sim: Sim, option: ResourceOption, self: number): ResourceBlocker | undefined {
  const ownRoutes = new Set(option.phases.flatMap(p => p.routes));
  const own = new Set(sim.trains.get(self)?.body.map(b => sim.topo.links[b.link].section));
  const locked = new Set<number>();
  for (const sec of option.sections) {
    if (own.has(sec)) continue;
    const rid = sim.sec[sec].lockRoute;
    if (rid >= 0) locked.add(rid);
  }
  for (const phase of option.phases) for (const sw of phaseSwitches(sim, phase)) {
    if (!sim.sw[sw.sw].lockCount || sim.sw[sw.sw].pos === sw.pos) continue;
    for (const [other] of sim.routes)
      if (sim.topo.routes[other].switches.some(s => s.sw === sw.sw && s.pos !== sw.pos)) locked.add(other);
  }
  for (const rid of new Set([...locked, ...ownRoutes])) {
    const ar = sim.routes.get(rid);
    if (!ar) continue;
    if (ownRoutes.has(rid) && ar.fleeting && !routeNeedsResourceProtection(sim, rid, option)) continue;
    const signal = sim.topo.routes[rid].start;
    const promised = sim.trainList.find(t => t.id !== self && t.maSigs.includes(signal)
      && !canStopBeforeSignal(sim, t, signal, 'supervision'));
    if (promised) return { train: promised.id, detail: `${sim.topo.routes[rid].name} 已发授权/锁闭`, code: 'ROUTE_CONFLICT' };
    if (ownRoutes.has(rid)) continue;
    // A conflicting route cannot be withdrawn while any of its remaining
    // sections holds a real body, including a section off this option's path.
    const occupied = routeOccupant(sim, rid, self);
    if (occupied) return { train: occupied.train,
      detail: `${sim.topo.routes[rid].name} 的${sim.topo.sections[occupied.section].name} 实占`, code: 'ROUTE_CONFLICT' };
    if (sim.topo.routes[rid].sections.every(sec => own.has(sec))) continue;
    const owner = routeUser(sim, rid);
    if (owner === self) continue;
    if (ar.manual || ar.entered || approachLocked(sim, signal))
      return { train: owner ?? -1, detail: `${sim.topo.routes[rid].name} 已发授权/锁闭`, code: 'ROUTE_CONFLICT' };
  }
}

function physicalBlocker(sim: Sim, option: ResourceOption, self: number): ResourceBlocker | undefined {
  return bodyBlocker(sim, option, self) ?? authorityBlocker(sim, option, self);
}

type PhysicalOrder = Map<number, Set<number>>;

/** Rule 3: only actual occupancy/following creates these dependencies. No
 * reservation, scheduling wait, driving grade or wait-message text is read. */
function physicalOrder(sim: Sim, requests: ResourceRequest[]): PhysicalOrder {
  const order: PhysicalOrder = new Map();
  const applicants = new Set(requests.map(r => r.id));
  for (const request of requests) {
    const blockers = request.options.map(o => physicalBlocker(sim, o, request.id));
    order.set(request.id, new Set(blockers.every(Boolean) ? blockers.flatMap(b => b!.train >= 0 ? [b!.train] : []) : []));
  }
  for (const tr of sim.trainList) {
    // Applying for a resource does not remove a real following/interval
    // dependency. Keep the same physical queue for all trains.
    const predecessors = order.get(tr.id) ?? new Set<number>();
    if (tr.maCode === 'TRAIN_AHEAD' && tr.maTrain >= 0) predecessors.add(tr.maTrain);
    if (tr.intervalWait && tr.intervalWait.train >= 0) predecessors.add(tr.intervalWait.train);
    if (!applicants.has(tr.id)) {
      // Applicants already checked all reachable berth alternatives above.
      const task = tr.tasks[firstTaskIndex(tr)], goal = task ? taskBerth(sim, task) : -1;
      const occupant = goal >= 0 ? berthHolder(sim, goal, tr.id, true) : -1;
      if (occupant >= 0) predecessors.add(occupant);
    }
    order.set(tr.id, predecessors);
  }
  return order;
}

function physicallyNeeds(order: PhysicalOrder, train: number, owner: number, seen = new Set<number>()): boolean {
  if (seen.has(train)) return false;
  seen.add(train);
  return [...order.get(train) ?? []].some(id => id === owner || physicallyNeeds(order, id, owner, seen));
}

function earlierOrigin(sim: Sim, requests: ResourceRequest[], physical: PhysicalOrder, request: ResourceRequest, option: ResourceOption): { id: number } | undefined {
  if (request.inside && !request.safeHere || request.committed) return undefined;
  const origin = optionOrigin(sim, option, request.tasks)?.task;
  if (!origin || !entersOrigin(sim, option, origin)) return undefined;
  const platform = sim.topo.berths[origin.berth].platform;
  // Rule 3 is per resource. Timetable order cannot make its occupant wait
  // for an entrant whose every reachable movement needs that occupied place.
  const needsThisOccupant = (id: number) => physicallyNeeds(physical, id, request.id);
  const first = requests.find(other => other.id !== request.id && other.options.some(o => !o.unreachable) && other.options.some(o => {
    const candidate = optionOrigin(sim, o, other.tasks)?.task;
    return candidate && candidate.dep! < origin.dep! && sim.topo.berths[candidate.berth].platform === platform;
  })
    // A vehicle already occupying this movement must clear before scheduling
    // priority can apply, rather than waiting for someone queued behind it.
    && !other.train?.body.some(b => option.sections.has(sim.topo.links[b.link].section)) && !needsThisOccupant(other.id)
    // Only an executable unentered demand can order an actual resource
    // occupant. A source blocked by another occupant must let them clear,
    // rather than ordering an occupant before it can ever leave its source.
    && !(request.inside && !other.inside && !other.committed
      && other.options.every(o => !!physicalBlocker(sim, o, other.id))));
  if (first) return first;
  // Rule 3 concerns this applicant entering its origin platform. A through
  // service with an earlier departure from that same platform also precedes
  // it. Inspect only the service's current movement, never later circulations;
  // ordinary through trains receive no resource claim of their own.
  return sim.trainList.find(tr => {
    if (tr.id === request.id || tr.failed || tr.body.some(b => option.sections.has(sim.topo.links[b.link].section))) return false;
    // Only the current service or the contiguous turn at its current stop
    // can compete here. A future return trip from several stations away
    // does not reserve this origin ahead of an actual siding occupant.
    // DWELL still belongs to its actual current stop, not the next station.
    // An ordinary running service has not begun its destination's cab change.
    const tasks = tr.tasks, first = tasks[0];
    let trip = first?.k === 'stop' ? first.trip : -1;
    const station = first && 'station' in first ? first.station : undefined;
    let sameStation = station !== undefined && (tr.phase !== 'run' || first?.k === 'reverse');
    const task = tasks.find((t): t is StopTask => {
      if ('station' in t && t.station !== station) sameStation = false;
      // Finishing a local cab change starts this same movement's service;
      // it does not expose a later turn at another station to the queue.
      if (sameStation && t.k === 'stop' && t.dep !== null && (t.arr === null || t.arr === t.dep)) trip = t.trip;
      return t.k === 'stop' && (t === first || sameStation || trip >= 0 && t.trip === trip)
        && t.dep !== null && sim.topo.berths[t.berth].platform === platform;
    });
    return !!task && task.dep! < origin.dep! && !needsThisOccupant(tr.id);
  });
}

/** Rules 2/3: an allocation is a whole movement. A denied occupant cannot
 * leave fragments which conflict with an already allocated owner's exit. */
function allocationBlocker(sim: Sim, result: ResourceAllocation, option: ResourceOption, self: number): ResourceBlocker | undefined {
  for (const sec of option.sections) {
    const prior = result.claims.get(sec);
    if (prior && prior.request.id !== self)
      return { train: prior.request.id, detail: `${sim.topo.sections[sec].name} 完整动作准入：${resourceApplicantLabel(sim, prior.request.id)}`, code: 'ROUTE_WAIT' };
  }
  for (const phase of option.phases) for (const sw of phaseSwitches(sim, phase)) {
    const prior = result.switches.get(sw.sw)?.find(p => p.decision.request.id !== self && [...p.positions].some(pos => pos !== sw.pos));
    if (prior) return { train: prior.decision.request.id, detail: `${sim.topo.switches[sw.sw].name} 完整动作准入：${resourceApplicantLabel(sim, prior.decision.request.id)}`, code: 'ROUTE_WAIT' };
  }
}

/** Rule 3 is per physical resource: its occupant precedes an applicant
 * needing it, even if that applicant is occupying a different resource. */
function occupantsFirst(requests: ResourceRequest[], physical: PhysicalOrder): ResourceRequest[] {
  const byId = new Map(requests.map(r => [r.id, r])), ordered: ResourceRequest[] = [], seen = new Set<number>();
  const visiting = new Set<number>();
  const visit = (request: ResourceRequest) => {
    if (seen.has(request.id) || visiting.has(request.id)) return;
    visiting.add(request.id);
    for (const id of physical.get(request.id) ?? []) {
      const owner = byId.get(id);
      if (owner?.inside) visit(owner);
    }
    visiting.delete(request.id); seen.add(request.id); ordered.push(request);
  };
  requests.forEach(visit);
  return ordered;
}

/** One decision for entry, every intermediate cab change and the safe exit. */
export function arbitrateResources(sim: Sim, requests?: ResourceRequest[]): ResourceAllocation {
  queryCaches.set(sim, newQueryCache());
  refreshTransits(sim);
  const result: ResourceAllocation = { decisions: new Map(), claims: new Map(), switches: new Map() };
  // Route releases can refresh a train's authority while this allocation is
  // being built. Publish its current view rather than recursively allocating.
  allocations.set(sim, result);
  approaches.set(sim, new Map());
  requests ??= collectResourceRequests(sim);
  for (const request of requests) approaches.get(sim)!.set(request.id, request);
  const physical = physicalOrder(sim, requests);
  const previous = new Map(sim.berthRes);
  // These are views of this allocation, never inputs to the next one.
  sim.berthRes.clear();
  const booked = (r: ResourceRequest) => r.options.some(o => o.choices.some(c => previous.get(c.berth) === r.id));
  const distance = (r: ResourceRequest) => Math.min(...r.options.map(o => o.entryDistance ?? Infinity));
  requests.sort((a, b) => {
    const physical = Number(b.inside) - Number(a.inside) || Number(b.committed) - Number(a.committed);
    if (physical) return physical;
    if (a.origin && b.origin && sim.topo.berths[a.origin.berth].platform === sim.topo.berths[b.origin.berth].platform)
      return a.origin.dep! - b.origin.dep! || a.id - b.id;
    return Number(booked(b)) - Number(booked(a)) || a.time - b.time || distance(a) - distance(b) || a.id - b.id;
  });
  for (const request of occupantsFirst(requests, physical)) {
    const train = request.train;
    // A safe departure consumes the existing physical interval queue before
    // claiming its exit. An unsafe occupant still keeps its clearing path.
    const interval = request.safeHere && train?.phase === 'dwell' && train.tasks[0]?.k === 'stop'
      && train.intervalWait && train.intervalWait.train >= 0
      && physical.get(request.id)?.has(train.intervalWait.train) ? train.intervalWait : undefined;
    let decision: ResourceDecision | undefined;
    const alternatives: WaitAlternative[] = [];
    for (const option of request.options) {
      const missing = option.unreachable;
      let blocker: ResourceBlocker | undefined = missing ? { train: -1, code: 'ROUTE_MISMATCH',
        detail: `${sim.topo.sections[sim.topo.links[missing.start.link].section].name} 至 ${sim.topo.berths[missing.goal].name} 无可达后续阶段，整段动作未获准入` }
        : interval ? { train: interval.train, code: 'INTERVAL_LIMIT', detail: interval.detail }
        : physicalBlocker(sim, option, request.id);
      blocker ??= allocationBlocker(sim, result, option, request.id);
      const first = earlierOrigin(sim, requests, physical, request, option);
      if (!blocker && first) blocker = { train: first.id,
        detail: `按图先发列车先进入始发站台：${resourceApplicantLabel(sim, first.id)}`, code: 'REGULATION' };
      if (!blocker && (option.readyAt ?? request.readyAt) > sim.t && !request.committed) blocker = { train: -1, detail: '在安全等候点等待始发窗口', code: 'REGULATION' };
      const alternative: WaitAlternative = { entrySignal: option.entry,
        choices: option.choices.map(c => ({ ...c })),
        blockers: blocker ? [{ ...blocker, train: Math.max(-1, blocker.train) }] : [] };
      alternatives.push(alternative);
      const current: ResourceDecision = { request, option, admitted: !blocker, blocker: blocker?.train ?? -1, detail: blocker?.detail ?? '', code: blocker?.code };
      decision ??= current;
      if (!current.admitted) continue;
      if (request.train) {
        const tr = request.train;
        let changed = true;
        for (const c of option.choices) {
          const task = tr.tasks[c.index];
          if (task.k === 'depot' && depotBerth(sim.topo, task) !== c.berth && !applyDepotChoice(sim, tr, task, c.berth)) { changed = false; break; }
        }
        if (!changed) {
          current.admitted = false; current.code = 'ROUTE_CONFLICT';
          const task = tr.tasks.find((t): t is Extract<Task, { k: 'depot' }> => t.k === 'depot');
          current.detail = `${task ? sim.topo.berths[depotBerth(sim.topo, task)].name : '原入段支路'} 尚未解锁`;
          alternative.blockers = [{ train: -1, code: current.code, detail: current.detail }];
          decision = current; continue;
        }
        for (const c of option.choices) {
          const task = tr.tasks[c.index];
          if (task.k === 'reverse' && task.chosen !== c.berth) cowTask(tr, task).chosen = c.berth;
          if (task.k === 'stable' && task.berth !== c.berth) cowTask(tr, task).berth = c.berth;
          if (option.phases.some(p => reachesBerth(sim, p, c.berth))) sim.berthRes.set(c.berth, tr.id);
        }
      }
      decision = current;
      break;
    }
    if (!decision) continue;
    if (!decision.admitted) decision.alternatives = alternatives;
    result.decisions.set(request.id, decision);
    if (decision.admitted && request.train) rememberTransit(sim, request.train, decision.option);
    else if (!sim.resourceTransit.get(request.id)?.entered) sim.resourceTransit.delete(request.id);
    // An actual occupant must retain its exit even while its next stage is
    // blocked. A distant, denied request owns no resources at all.
    if (!decision.option.unreachable && (decision.admitted || (request.inside && !request.safeHere || request.committed)
      && !allocationBlocker(sim, result, decision.option, request.id))) {
      for (const sec of decision.option.sections) if (!result.claims.has(sec)) result.claims.set(sec, decision);
      const positions = new Map<number, Set<'N' | 'R'>>();
      for (const phase of decision.option.phases) for (const sw of phaseSwitches(sim, phase)) {
        let set = positions.get(sw.sw);
        if (!set) positions.set(sw.sw, set = new Set());
        set.add(sw.pos);
      }
      for (const [sw, set] of positions) {
        const list = result.switches.get(sw) ?? [];
        list.push({ decision, positions: set }); result.switches.set(sw, list);
      }
    }
  }
  allocations.set(sim, result);
  return result;
}

export function invalidateResourceAllocation(sim: Sim) { allocations.delete(sim); approaches.delete(sim); queryCaches.delete(sim); }

function rememberTransit(sim: Sim, tr: Train, option: ResourceOption) {
  if (!option.resourceLinks) return;
  const previous = sim.resourceTransit.get(tr.id), saved = structuredClone(option);
  delete saved.readyAt;
  saved.choices = []; // task-array indices are not carried into another day
  const entered = previous?.entered || tr.body.some(b => option.sections.has(sim.topo.links[b.link].section));
  const visited = previous?.visited || tr.body.some(b => option.resourceLinks!.has(b.link));
  sim.resourceTransit.set(tr.id, { option: saved, entered, visited });
}

/** Read an already derived view only; diagnostics/checkers must never allocate. */
export function peekResourceAllocation(sim: Sim): ResourceAllocation | undefined { return allocations.get(sim); }

export function resourceAllocation(sim: Sim): ResourceAllocation {
  return peekResourceAllocation(sim) ?? arbitrateResources(sim);
}

/** Rules 2/5: a route that enters this train's protected movement needs
 * its own current whole-movement grant, even if nobody else has a claim. */
export function resourceAdmissionBlocked(sim: Sim, train: Train, rid: number): boolean {
  const decision = resourceAllocation(sim).decisions.get(train.id);
  const request = approaches.get(sim)?.get(train.id) ?? decision?.request;
  if (!request?.options.some(o => routeNeedsResourceProtection(sim, rid, o))) return false;
  return !decision?.admitted || !decision.option.phases[0]?.routes.includes(rid);
}

/** Rules 2/3/4: an open shared automatic route does not grant every following
 * applicant entry. Restrict this train's new authority, keeping the physical
 * route available for a predecessor which is already clearing it. */
export function resourceAuthorityBlocker(sim: Sim, train: Train, rid: number): ResourceBlocker | undefined {
  const decision = resourceAllocation(sim).decisions.get(train.id);
  if (resourceAdmissionBlocked(sim, train, rid)) return {
    train: decision?.blocker ?? -1, code: decision?.code ?? 'ROUTE_WAIT',
    detail: decision?.detail || `${sim.topo.signals[sim.topo.routes[rid].start].name} 等待本车当前整段动作准入`,
  };
  const claim = routeResourceBlocker(sim, train, rid);
  if (claim) return { train: claim.request.id, code: 'ROUTE_WAIT', detail: resourceWaitDetail(sim, rid, claim) };
}

export function adoptSpawnResources(sim: Sim, block: number, tr: Train) {
  const result = resourceAllocation(sim), decision = result.decisions.get(-(block + 1));
  if (!decision) return;
  result.decisions.delete(-(block + 1));
  decision.request.id = tr.id; decision.request.train = tr; decision.request.tasks = tr.tasks;
  result.decisions.set(tr.id, decision);
  rememberTransit(sim, tr, decision.option);
  for (const c of decision.option.choices) {
    const task = tr.tasks[c.index];
    if (task.k === 'reverse' && task.chosen !== c.berth) cowTask(tr, task).chosen = c.berth;
    if (task.k === 'depot' && task.berth !== c.berth) cowTask(tr, task).berth = c.berth;
    if (task.k === 'stable' && task.berth !== c.berth) cowTask(tr, task).berth = c.berth;
    if (decision.option.phases.some(p => reachesBerth(sim, p, c.berth))) sim.berthRes.set(c.berth, tr.id);
  }
}

/** Rules 1/2: ordinary, same-direction running beyond the resource is still
 * moving-block following, even when a long track circuit shares its section
 * number with the clipped exit. Only the admission gate, resource/throat or
 * opposing movement needs exclusive route use. */
export function routeNeedsResourceProtection(sim: Sim, rid: number, option: ResourceOption): boolean {
  const cache = queryCache(sim).protection;
  let results = cache.get(option);
  if (!results) cache.set(option, results = new Map());
  const cached = results.get(rid);
  if (cached !== undefined) return cached;
  const protectedRoute = needsResourceProtection(sim, rid, option);
  results.set(rid, protectedRoute);
  return protectedRoute;
}

function needsResourceProtection(sim: Sim, rid: number, option: ResourceOption): boolean {
  const route = sim.topo.routes[rid];
  if (option.entry !== undefined && option.entry >= 0 && route.start === option.entry) return true;
  for (const phase of option.phases) for (const p of phase.path) {
    if (p.from === p.to) continue;
    const step = route.steps.find(s => s.link === p.link);
    if (!step) continue;
    if (option.resourceLinks?.has(p.link) || sim.topo.sections[sim.topo.links[p.link].section].kind === 'switch'
      || step.dir !== (p.to > p.from ? 1 : -1)) return true;
  }
  return false;
}

/** Rule 3: a consist already occupying the scoped movement also owns its
 * exit. The exit may return through ordinary track before a cab change;
 * membership in the physical resource inventory alone is insufficient. */
function occupiesMovement(train: Train, option: ResourceOption): boolean {
  return option.phases.some(p => p.path.some(s => train.body.some(b => b.link === s.link
    && b.to > Math.min(s.from, s.to) && b.from < Math.max(s.from, s.to))));
}

/** All ARS routes, including ordinary through traffic, obey the same grants. */
export function routeResourceBlocker(sim: Sim, train: Train, rid: number): ResourceDecision | undefined {
  const result = resourceAllocation(sim);
  // Rule 3 protects actual occupancy of the movement's geometry. Merely
  // sharing a long section behind its entry does not authorize a fresh entry.
  const occupies = (claim: ResourceDecision) => occupiesMovement(train, claim.option);
  for (const sec of sim.topo.routes[rid].sections) {
    const claim = result.claims.get(sec);
    if (!claim || claim.request.id === train.id) continue;
    if (!routeNeedsResourceProtection(sim, rid, claim.option)) continue;
    // A body/issued authority which predates allocation must be allowed to
    // clear. This exemption cannot create a fresh entry from outside.
    if (occupies(claim)) continue;
    return claim;
  }
  for (const sw of sim.topo.routes[rid].switches) for (const prior of result.switches.get(sw.sw) ?? []) {
    if (prior.decision.request.id === train.id || ![...prior.positions].some(pos => pos !== sw.pos)) continue;
    if (!occupies(prior.decision)) return prior.decision;
  }
}

export function resourceRouteReserved(sim: Sim, rid: number): boolean {
  const result = resourceAllocation(sim), route = sim.topo.routes[rid];
  return route.sections.some(s => {
    const claim = result.claims.get(s);
    return claim && routeNeedsResourceProtection(sim, rid, claim.option);
  }) || route.switches.some(sw =>
    result.switches.get(sw.sw)?.some(p => [...p.positions].some(pos => pos !== sw.pos)));
}

/** Rule 4: virtual yard requests also name the precise affected route. */
export function resourceWaitDetail(sim: Sim, rid: number, decision: ResourceDecision): string {
  const owner = resourceApplicantLabel(sim, decision.request.id);
  return `${sim.topo.routes[rid].name} 等待完整动作退出：${owner}`;
}

function resourceApplicantLabel(sim: Sim, id: number): string {
  const train = sim.trains.get(id);
  if (train) return trainLabel(train);
  const block = id < 0 ? sim.plan.blocks[-id - 1] : undefined;
  return block ? `待出段表号${block.svc}` : `来源${id}`;
}

