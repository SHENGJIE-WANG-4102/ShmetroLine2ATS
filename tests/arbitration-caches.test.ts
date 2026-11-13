/**
 * Resource arbitration speed-ups (stage 5) must not change any result: each
 * cached, indexed or reused lookup is compared with its direct computation,
 * also after the inputs change underneath it (tasks edited in place, a task
 * replaced, a route cancelled, a train withdrawn).
 */
import { describe, expect, it } from 'vitest';
import { makeSim, runFor } from './helpers';
import { checkArbitration } from './helpers/arbitration-check';
import { arbitrateResources, arbitrationInternals } from '../src/sim/resourceArbitration';
import { buildTopology, safeWaitingPoint, topologyResourceLinks } from '../src/sim/topology';
import { committedTo, committedTrain } from '../src/sim/interlocking';
import { restrictionDistanceAt } from '../src/sim/protection';
import { cowTask, distanceToBerth } from '../src/sim/ats';
import { walkRouteToBerth } from '../src/sim/routePath';
import type { StopTask } from '../src/sim/model';

describe('resource arbitration lookups', () => {
  it('equal their direct computation across allocations and after changed inputs', () => {
    const sim = makeSim('weekday', 8 * 3600);
    const totals = { stops: 0, found: 0, routes: 0, blocked: 0, occupancy: 0, decisions: 0 };
    const add = (r: typeof totals) => { for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += r[k]; };
    // reuse across allocations while trains run, dwell and turn
    for (let i = 0; i < 6; i++) { add(checkArbitration(sim)); runFor(sim, 15); }
    // tasks edited in place: a later stop removed from the same array
    const running = sim.trainList.filter(t => t.phase === 'run' && t.tasks.filter(k => k.k === 'stop').length > 4);
    expect(running.length).toBeGreaterThan(2);
    const a = running[0], removed = a.tasks.findIndex((t, i) => i > 1 && t.k === 'stop');
    a.tasks.splice(removed, 1);
    add(checkArbitration(sim));
    // a task replaced in its slot (cowTask) with another platform
    const b = running[1], stop = b.tasks.find((t, i): t is StopTask => i > 0 && t.k === 'stop')!;
    const other = sim.topo.berths.find(x => x.kind === 'platform' && x.station === stop.station && x.id !== stop.berth);
    expect(other).toBeDefined();
    cowTask(b, stop).berth = other!.id;
    add(checkArbitration(sim));
    // the same task objects in a new array; the run test changed
    const c = running[2];
    c.tasks = c.tasks.slice();
    add(checkArbitration(sim));
    c.phase = 'dwell';
    add(checkArbitration(sim));
    c.phase = 'run';
    add(checkArbitration(sim));
    // a set route cancelled by the dispatcher
    const sig = sim.sig.findIndex(s => s.route >= 0 && !sim.routes.get(s.route)?.entered);
    expect(sig).toBeGreaterThanOrEqual(0);
    sim.command({ c: 'cancelRoute', signal: sig });
    add(checkArbitration(sim));
    // a train withdrawn from service, then the line runs on
    const w = sim.trainList.find(t => t.inService && t.phase === 'run')!;
    expect(sim.command({ c: 'withdraw', train: w.id }).ok).toBe(true);
    for (let i = 0; i < 8; i++) { runFor(sim, 20); add(checkArbitration(sim)); }
    expect(totals.found).toBeGreaterThan(200);
    expect(totals.blocked).toBeGreaterThan(50);
    expect(totals.decisions).toBeGreaterThan(10);
  }, 300000);

  it('safeRunningLink is safeWaitingPoint over the whole link with those protected links', () => {
    const sim = makeSim('weekday', 8 * 3600), topo = sim.topo, inventory = topologyResourceLinks(topo);
    let rng = 1;
    const random = () => (rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648;
    const sets: ReadonlySet<number>[] = [new Set(), inventory, new Set(topo.links.filter(() => random() < .3).map(l => l.id))];
    let checked = 0;
    for (const l of topo.links) for (const dir of [1, -1] as const) {
      for (const set of [...sets, new Set([l.id]), new Set([...inventory, l.id])]) {
        const direct = safeWaitingPoint(topo, { link: l.id, off: dir === 1 ? l.len : 0, dir }, l.len, { protectedLinks: set });
        expect(arbitrationInternals.safeRunningLink(sim, l.id, dir, set)).toBe(direct);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('copies options exactly as structuredClone does, shared references included', () => {
    const sim = makeSim('weekday', 8 * 3600), result = arbitrateResources(sim);
    const shape = (root: unknown) => {
      const seen = new Map<object, number>(), out: unknown[] = [];
      const walk = (v: unknown): void => {
        if (typeof v !== 'object' || v === null) { out.push(typeof v, Object.is(v, -0) ? '-0' : v); return; }
        if (seen.has(v)) { out.push('ref', seen.get(v)); return; }
        seen.set(v, seen.size);
        if (v instanceof Set) { out.push('Set', v.size); v.forEach(walk); return; }
        if (v instanceof Map) { out.push('Map', v.size); v.forEach((x, k) => { walk(k); walk(x); }); return; }
        out.push(Array.isArray(v) ? 'Array' : Object.getPrototypeOf(v) === Object.prototype ? 'Object' : 'other', Object.keys(v).join(','));
        for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k]);
      };
      walk(root);
      return JSON.stringify(out);
    };
    let options = 0;
    for (const d of result.decisions.values()) for (const o of d.request.options) {
      const copy = arbitrationInternals.cloneData(o);
      expect(copy).not.toBe(o);
      expect(shape(copy)).toBe(shape(structuredClone(o)));
      options++;
    }
    expect(options).toBeGreaterThan(5);
    const shared = { p: { link: 1, off: -0 } }, data = { a: shared, b: [shared, shared.p], s: new Set([shared]), m: new Map([[1, shared]]), u: undefined };
    expect(shape(arbitrationInternals.cloneData(data))).toBe(shape(structuredClone(data)));
    class Box { x = 1; }
    expect(shape(arbitrationInternals.cloneData({ box: new Box() }))).toBe(shape(structuredClone({ box: new Box() })));
    expect(() => arbitrationInternals.cloneData({ f: () => 1 })).toThrow();
  });

  it('replays the same route walk to a visitor', () => {
    const sim = makeSim('weekday', 8 * 3600);
    let walks = 0;
    for (let sig = 0; sig < sim.topo.signals.length; sig += 3) for (let goal = 0; goal < sim.topo.berths.length; goal += 7) {
      const direct: number[] = [], first: number[] = [], again: number[] = [];
      const d = walkRouteToBerth(sim.topo, sim.routeTable, { signal: sig }, goal, (l, f, t) => direct.push(l, f, t));
      expect(distanceToBerth(sim, sig, goal, (l, f, t) => first.push(l, f, t))).toBe(d);
      expect(distanceToBerth(sim, sig, goal, (l, f, t) => again.push(l, f, t))).toBe(d);
      expect(first).toEqual(direct); expect(again).toEqual(direct);
      walks++;
    }
    expect(walks).toBeGreaterThan(500);
  });

  it('answers a repeated restriction query like a fresh one', () => {
    const sim = makeSim('weekday', 8 * 3600), fresh = buildTopology();
    let checked = 0;
    for (const tr of sim.trainList) for (const speed of [0, 3.5, tr.v, 22]) for (const brake of ['emergency', 'supervision'] as const) {
      const value = restrictionDistanceAt(sim.topo, tr, speed, brake);
      expect(restrictionDistanceAt(sim.topo, tr, speed, brake)).toBe(value);
      expect(restrictionDistanceAt(fresh, { link: tr.link, off: tr.off, dir: tr.dir, len: tr.len }, speed, brake)).toBe(value);
      checked++;
    }
    // the same object asking with changed fields gets the changed answer
    const tr = sim.trainList.find(t => t.v > 1)!, saved = { off: tr.off, len: tr.len };
    const before = restrictionDistanceAt(sim.topo, tr, 15, 'emergency');
    tr.off = Math.max(0, tr.off - 50);
    expect(restrictionDistanceAt(sim.topo, tr, 15, 'emergency')).toBe(restrictionDistanceAt(fresh, { link: tr.link, off: tr.off, dir: tr.dir, len: tr.len }, 15, 'emergency'));
    tr.len = saved.len / 2;
    expect(restrictionDistanceAt(sim.topo, tr, 15, 'emergency')).toBe(restrictionDistanceAt(fresh, { link: tr.link, off: tr.off, dir: tr.dir, len: tr.len }, 15, 'emergency'));
    Object.assign(tr, saved);
    expect(restrictionDistanceAt(sim.topo, tr, 15, 'emergency')).toBe(before);
    expect(checked).toBeGreaterThan(100);
  });

  it('names a committed train only when that train is committed itself', () => {
    const sim = makeSim('weekday', 8 * 3600);
    let committed = 0;
    for (let i = 0; i < 4; i++) {
      for (let sig = 0; sig < sim.topo.signals.length; sig++) {
        const id = committedTrain(sim, sig);
        expect(id).toBe(sim.trainList.find(t => committedTo(sim, t, sig))?.id ?? -1);
        if (id >= 0) { committed++; expect(committedTo(sim, sim.trains.get(id)!, sig)).toBe(true); }
      }
      runFor(sim, 7);
    }
    expect(committed).toBeGreaterThan(10);
  });
});
