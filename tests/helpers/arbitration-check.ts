/**
 * Direct (uncached, unindexed) computations of the resource-arbitration
 * lookups that resourceArbitration.ts now caches, indexes or reuses across
 * allocations. Written from the plain definitions, not from the
 * cached code, so a check against them catches a missed input.
 */
import { expect } from 'vitest';
import type { Sim } from '../../src/sim/engine';
import type { StopTask, Task, Train } from '../../src/sim/model';
import { approachLocked } from '../../src/sim/interlocking';
import { arbitrateResources, arbitrationInternals, routeNeedsResourceProtection, routeResourceBlocker,
  type ResourceAllocation, type ResourceDecision, type ResourceOption } from '../../src/sim/resourceArbitration';

/** earlierOrigin/originPrecedence's stop of the current movement, walked afresh. */
export function directMovementStop(sim: Sim, tr: Train, platform: number): StopTask | null {
  const tasks = tr.tasks, first = tasks[0];
  let trip = first?.k === 'stop' ? first.trip : -1;
  const station = first && 'station' in first ? first.station : undefined;
  let sameStation = station !== undefined && (tr.phase !== 'run' || first?.k === 'reverse');
  const ends = new Map<number, number>();
  tasks.forEach((t, i) => { if (t.k === 'stop') ends.set(t.trip, i); });
  for (let i = 0; i < tasks.length; i++) {
    const t: Task = tasks[i];
    if ('station' in t && t.station !== station) sameStation = false;
    if (sameStation && t.k === 'stop' && t.dep !== null && (t.arr === null || t.arr === t.dep)) trip = t.trip;
    if (t.k === 'stop' && (t === first || sameStation || trip >= 0 && t.trip === trip)
      && t.dep !== null && sim.topo.berths[t.berth].platform === platform) return t;
    if (!sameStation && i > 0 && (trip < 0 || i >= (ends.get(trip) ?? -1))) break;
  }
  return null;
}

export function directOccupies(train: Train, option: ResourceOption): boolean {
  return option.phases.some(p => p.path.some(s => train.body.some(b => b.link === s.link
    && b.to > Math.min(s.from, s.to) && b.from < Math.max(s.from, s.to))));
}

function needs(order: Map<number, Set<number>>, train: number, owner: number, seen = new Set<number>()): boolean {
  if (seen.has(train)) return false;
  seen.add(train);
  for (const id of order.get(train) ?? []) if (id === owner || needs(order, id, owner, seen)) return true;
  return false;
}

/** routeResourceBlocker as a plain scan of claims, switch grants and origin entrants. */
export function directRouteBlocker(sim: Sim, result: ResourceAllocation, train: Train, rid: number): ResourceDecision | undefined {
  const route = sim.topo.routes[rid];
  for (const sec of route.sections) {
    const claim = result.claims.get(sec);
    if (!claim || claim.request.id === train.id || !routeNeedsResourceProtection(sim, rid, claim.option)) continue;
    if (!directOccupies(train, claim.option)) return claim;
  }
  for (const sw of route.switches) for (const prior of result.switches.get(sw.sw) ?? []) {
    if (prior.decision.request.id === train.id || ![...prior.positions].some(pos => pos !== sw.pos)) continue;
    if (!directOccupies(train, prior.decision.option)) return prior.decision;
  }
  if (!result.origins || train.failed) return undefined;
  for (const step of route.steps) {
    const platform = sim.topo.links[step.link].platform, entrants = result.origins.get(platform);
    if (!entrants) continue;
    if (sim.sig[route.start].route === rid && approachLocked(sim, route.start)) return undefined;
    const stop = directMovementStop(sim, train, platform);
    if (!stop) return undefined;
    const waits = (id: number) => id === train.id || id !== -1 && needs(result.physical!, id, train.id);
    const first = entrants.find(e => e.decision.request.id !== train.id && e.dep <= stop.dep!
      && !waits(e.decision.request.id) && !waits(e.decision.blocker));
    return first && { ...first.decision, precedence: true };
  }
}

const same = (a: ResourceDecision | undefined, b: ResourceDecision | undefined) =>
  a === b || !!a && !!b && !!a.precedence && !!b.precedence && a.request === b.request && a.blocker === b.blocker && a.detail === b.detail;

/** Allocate now, then compare every cached/indexed lookup with its direct
 * computation for every train, platform and route. Returns the numbers checked. */
export function checkArbitration(sim: Sim) {
  const result = arbitrateResources(sim);
  let stops = 0, found = 0, routes = 0, blocked = 0, occupancy = 0;
  for (const tr of sim.trainList) {
    for (let p = 0; p < sim.topo.platforms.length; p++) {
      const direct = directMovementStop(sim, tr, p);
      expect(arbitrationInternals.movementStopAt(sim, tr, p), `train ${tr.id} platform ${p}`).toBe(direct);
      stops++; if (direct) found++;
    }
    for (const d of result.decisions.values()) for (const option of d.request.options) {
      expect(arbitrationInternals.occupiesMovement(tr, option)).toBe(directOccupies(tr, option));
      occupancy++;
    }
    for (let rid = 0; rid < sim.topo.routes.length; rid++) {
      const direct = directRouteBlocker(sim, result, tr, rid);
      const indexed = routeResourceBlocker(sim, tr, rid), scan = routeResourceBlocker(sim, tr, rid, false);
      expect(same(indexed, direct), `train ${tr.id} route ${rid}`).toBe(true);
      expect(same(scan, direct), `train ${tr.id} route ${rid} (scan)`).toBe(true);
      routes++; if (direct) blocked++;
    }
  }
  return { stops, found, routes, blocked, occupancy, decisions: result.decisions.size };
}
