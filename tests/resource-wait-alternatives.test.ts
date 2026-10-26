import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import type { Train } from '../src/sim/model';
import { newHalt, rootCause, updateHalts, type WaitAlternative } from '../src/sim/halt';
import { checkLiveness, DEADLOCK_LIMIT, newIntegrity } from '../src/sim/invariants';
import { arbitrateResources, invalidateResourceAllocation, peekResourceAllocation, type ResourceOption, type ResourceRequest } from '../src/sim/resourceArbitration';
import { computeBody, indexBodies } from '../src/sim/movement';
import { computeOccupancy, releaseRoute } from '../src/sim/interlocking';
import { capture, restore } from '../src/sim/state';
import { carryTrains, DAY_S } from '../src/sim/operatingDay';
import { platformBerth } from '../src/sim/timetable';
import { parseDiagnostics, stringifyDiagnostics, topologySignature } from '../src/sim/diagnostics';
import { runARS } from '../src/sim/ats';

function fixture() {
  const sim = new Sim({ dayType: 'weekday', date: '2026-10-19', dateLabel: 'test', startTime: 14400, seed: 7, noPossessions: true });
  const [a, b, c] = sim.trainList;
  expect(c).toBeDefined();
  for (const tr of [...sim.trainList]) if (![a, b, c].includes(tr)) sim.removeTrain(tr);
  for (const rid of [...sim.routes.keys()]) releaseRoute(sim, rid);
  sim.resourceTransit.clear(); sim.berthRes.clear(); sim.integrity = newIntegrity();
  for (const tr of [a, b, c]) Object.assign(tr, { phase: 'run', tasks: [], v: 0, halt: newHalt(), arsWait: null });
  return { sim, a, b, c };
}
const alternatives = (...ids: number[]): WaitAlternative[] => ids.map((train, i) => ({
  entrySignal: 0, choices: [{ index: 0, berth: i }], blockers: [{ train, code: 'BERTH_WAIT', detail: `actual blocker ${train}` }],
}));
function wait(sim: Sim, train: Train, blocker: number, options?: WaitAlternative[]) {
  train.halt = { ...newHalt(), code: 'BERTH_WAIT', train: blocker, since: sim.t, unplannedSince: sim.t, alternatives: options };
}
function afterLimit(sim: Sim) { checkLiveness(sim); sim.t += DEADLOCK_LIMIT; checkLiveness(sim); }

describe('whole-movement alternative wait evidence', () => {
  it('publishes the natural two-berth denial through ARS and halt, and drops stale or out-of-scope alternatives', () => {
    const { sim, a, b, c } = fixture();
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    const depot = sim.topo.depots.find(d => d.entryBerths.length >= 2)!;
    const signal = sim.topo.signals.find(s => s.station === depot.station && s.role === 'start'
      && s.dir === -1 && sim.topo.links[s.link].track === 'UP')!;
    const link = sim.topo.links.find(l => l.a === signal.node && l.track === 'UP')!;
    Object.assign(a, { link: link.id, off: 6.1, dir: -1, hist: [{ link: link.id, dir: -1 }],
      block: -1, tripId: -1, nextSignal: signal.id, nextSignalDist: 6.1, maSigs: [], maCode: 'ROUTE_WAIT',
      maTrain: -1, maDist: 0.1, stopDist: Infinity, tasks: [{ k: 'depot', depot: depot.id }], manual: false,
      pendingMode: null, stopUntil: 0, hold: false, eb: false });
    computeBody(sim, a);
    for (const [train, berthId] of [[b, depot.entryBerths[0]], [c, depot.entryBerths[1]]] as const) {
      const berth = sim.topo.berths[berthId];
      Object.assign(train, { link: berth.link, off: berth.offset, dir: berth.dir,
        hist: [{ link: berth.link, dir: berth.dir }], phase: 'stabled', tasks: [], v: 0, maSigs: [] });
      computeBody(sim, train);
    }
    indexBodies(sim); computeOccupancy(sim);
    const allocation = arbitrateResources(sim), decision = allocation.decisions.get(a.id)!;
    expect(decision.admitted).toBe(false);
    expect(new Set(decision.alternatives?.flatMap(x => x.blockers.map(b => b.train)))).toEqual(new Set([b.id, c.id]));
    expect(decision.alternatives?.length).toBe(decision.request.options.length);
    runARS(sim, true);
    expect(a.arsWait?.alternatives).toEqual(decision.alternatives);
    updateHalts(sim);
    expect(a.halt.alternatives).toEqual(decision.alternatives);
    const stored = structuredClone(a.arsWait!);
    for (const age of [-0.1, 2.6]) {
      a.arsWait = { ...stored, t: sim.t - age }; updateHalts(sim);
      expect(a.halt.alternatives).toBeUndefined();
    }
    a.arsWait = { ...stored, entrySignal: (signal.id + 1) % sim.sig.length }; updateHalts(sim);
    expect(a.halt.alternatives).toBeUndefined();
    a.arsWait = stored; a.maCode = stored.code; a.maTrain = stored.train; a.maReason = 'physical MA cause';
    updateHalts(sim);
    expect(a.halt.detail).toBe('physical MA cause');
    expect(a.halt.alternatives).toEqual(decision.alternatives);
    a.arsWait = stored; a.maCode = 'TRAIN_AHEAD'; a.maTrain = b.id; updateHalts(sim);
    expect(a.halt).toMatchObject({ code: 'TRAIN_AHEAD', train: b.id });
    expect(a.halt.alternatives).toBeUndefined();
  });

  it('keeps every denied option actual blocker and exposes the cached allocation without deriving', () => {
    const { sim, a, b, c } = fixture();
    const groups = sim.topo.berths.filter(x => x.kind === 'tail' && sim.topo.links[x.link].len >= a.len)
      .map(x => sim.topo.berths.filter(y => y.kind === 'tail' && y.station === x.station && y.link !== x.link && sim.topo.links[y.link].len >= a.len).map(y => [x, y]))
      .flat();
    const [first, second] = groups[0]; expect(second).toBeDefined();
    const at = sim.topo.berths[platformBerth(sim.topo, first.station, 'DN')];
    Object.assign(a, { link: at.link, off: at.offset, dir: at.dir, block: -1, tripId: -1,
      body: [{ link: at.link, from: at.offset - a.len, to: at.offset }],
      tasks: [{ k: 'reverse', berths: [first.id, second.id], chosen: first.id, station: first.station, minTime: 40 }] });
    for (const [tr, berth] of [[b, first], [c, second]] as const) {
      const from = Math.max(0, berth.offset - tr.len);
      Object.assign(tr, { link: berth.link, off: berth.offset, body: [{ link: berth.link, from, to: from + tr.len }], block: -1, tripId: -1 });
    }
    indexBodies(sim);
    const options: ResourceOption[] = [first, second].map(berth => ({
      entry: 0, choices: [{ index: 0, berth: berth.id }], sections: new Set([sim.topo.links[berth.link].section]),
      phases: [{ goal: berth.id, start: { link: a.link, off: a.off, dir: a.dir }, distance: 100,
        routes: [], path: [{ link: berth.link, from: 0, to: berth.offset }] }],
    }));
    const request: ResourceRequest = { id: a.id, train: a, tasks: a.tasks, options, time: sim.t, readyAt: sim.t, inside: false, committed: false, safeHere: true };
    invalidateResourceAllocation(sim);
    const rng = sim.rngState, booking = [...sim.berthRes];
    expect(peekResourceAllocation(sim)).toBeUndefined();
    expect(sim.rngState).toBe(rng); expect([...sim.berthRes]).toEqual(booking);
    const allocation = arbitrateResources(sim, [request]);
    expect(peekResourceAllocation(sim)).toBe(allocation);
    const decision = allocation.decisions.get(a.id)!;
    expect(decision.admitted).toBe(false);
    expect(decision.alternatives?.map(x => x.blockers[0].train)).toEqual([b.id, c.id]);
    expect(decision.alternatives?.map(x => x.choices[0].berth)).toEqual([first.id, second.id]);
    expect(decision.alternatives?.every(x => x.blockers[0].code === 'BERTH_WAIT')).toBe(true);
    a.phase = 'dwell'; a.dwellUntil = sim.t - 1; a.intervalWait = undefined;
    a.tasks = [{ k: 'stop', berth: at.id, station: at.station, trip: -1, arr: null, dep: null, doors: false, revenue: false }];
    a.nextSignal = 0;
    a.arsWait = { code: 'BERTH_WAIT', train: b.id, signal: 0, entrySignal: 0, t: sim.t, detail: decision.detail, alternatives: decision.alternatives };
    updateHalts(sim);
    expect(a.halt.alternatives).toEqual(decision.alternatives);
    a.arsWait.t = sim.t - 3; updateHalts(sim);
    expect(a.halt.alternatives).toBeUndefined();
  });

  it('does not report the selected-edge cycle when another option waits for a moving train', () => {
    const { sim, a, b, c } = fixture();
    wait(sim, a, b.id, alternatives(b.id, c.id)); wait(sim, b, a.id);
    c.v = 10; c.halt = newHalt();
    invalidateResourceAllocation(sim);
    expect(rootCause(sim, a)).toMatchObject({ root: c, code: 'NONE', cycle: null });
    expect(rootCause(sim, b).cycle).toBeNull();
    afterLimit(sim);
    expect(sim.integrity.violations.filter(x => x.kind === 'DEADLOCK')).toEqual([]);
    expect(peekResourceAllocation(sim)).toBeUndefined();
  });

  it('still reports a true closed set when both choices return to the applicant', () => {
    const { sim, a, b, c } = fixture();
    wait(sim, a, b.id, alternatives(b.id, c.id)); wait(sim, b, a.id); wait(sim, c, a.id);
    expect(rootCause(sim, a).cycle).toEqual([a.id, b.id, c.id].sort((x, y) => x - y));
    checkLiveness(sim); sim.t += DEADLOCK_LIMIT - 0.1; checkLiveness(sim);
    expect(sim.integrity.violations.filter(x => x.kind === 'DEADLOCK')).toHaveLength(0);
    sim.t += 0.1; checkLiveness(sim);
    expect(sim.integrity.violations.some(x => x.kind === 'DEADLOCK')).toBe(true);
  });

  it('still reports a true two-train cycle when distinct options require the same blocked train', () => {
    const { sim, a, b } = fixture();
    wait(sim, a, b.id, alternatives(b.id, b.id)); wait(sim, b, a.id);
    expect(rootCause(sim, a).cycle).toEqual([a.id, b.id].sort((x, y) => x - y));
    afterLimit(sim);
    expect(sim.integrity.violations.some(x => x.kind === 'DEADLOCK')).toBe(true);
  });

  it('does not add a queued ancestor to the circular core or restart its original deadline', () => {
    const { sim, a, b, c } = fixture();
    wait(sim, a, b.id, alternatives(b.id, b.id)); wait(sim, b, a.id); wait(sim, c, a.id);
    sim.trainList = [a, b]; checkLiveness(sim);
    const key = [a.id, b.id].sort((x, y) => x - y).join(',');
    const originalFirst = sim.integrity.cycles.get(key);
    sim.t += DEADLOCK_LIMIT - 0.1; sim.trainList.push(c);
    expect(rootCause(sim, c).cycle).toEqual([a.id, b.id].sort((x, y) => x - y));
    checkLiveness(sim);
    expect([...sim.integrity.cycles.keys()]).toEqual([key]);
    expect(sim.integrity.cycles.get(key)).toBe(originalFirst);
    expect(sim.integrity.violations.some(x => x.kind === 'DEADLOCK')).toBe(false);
    sim.t += 0.1; checkLiveness(sim);
    expect(sim.integrity.violations.some(x => x.kind === 'DEADLOCK' && x.trains.length === 2)).toBe(true);
  });

  it('retains both independent closed cores when the alternatives lead to different true cycles', () => {
    const { sim, a, b, c } = fixture();
    const id = Math.max(...sim.trains.keys()) + 1;
    const d = { ...b, id }, e = { ...c, id: id + 1 };
    sim.trains.set(d.id, d); sim.trains.set(e.id, e);
    sim.trainList.push(d, e);
    wait(sim, a, b.id, alternatives(b.id, c.id));
    wait(sim, b, d.id); wait(sim, d, b.id); wait(sim, c, e.id); wait(sim, e, c.id);
    expect(rootCause(sim, a).cycle).toEqual([b.id, c.id, d.id, e.id].sort((x, y) => x - y));
    d.v = 10; d.halt = newHalt();
    expect(rootCause(sim, a)).toMatchObject({ root: d, code: 'NONE', cycle: null });
  });

  it('keeps a real non-train condition instead of inventing an edge or a moving root', () => {
    const { sim, a, b } = fixture();
    const options = alternatives(b.id, -1);
    options[1].blockers[0] = { train: -1, code: 'REGULATION', detail: 'actual departure window' };
    wait(sim, a, b.id, options); wait(sim, b, a.id);
    expect(rootCause(sim, a)).toMatchObject({ root: a, code: 'REGULATION', cycle: null });
    afterLimit(sim);
    expect(sim.integrity.violations.some(x => x.kind === 'DEADLOCK')).toBe(false);
  });

  it('keeps legacy no-alternative cycle and moving-root behavior', () => {
    const { sim, a, b } = fixture(); wait(sim, a, b.id); wait(sim, b, a.id);
    expect(rootCause(sim, a).cycle).toEqual([a.id, b.id]);
    afterLimit(sim);
    expect(sim.integrity.violations.some(x => x.kind === 'DEADLOCK' && !x.detail.includes('可选'))).toBe(true);
    b.halt = newHalt(); b.v = 10;
    expect(rootCause(sim, a)).toMatchObject({ root: b, code: 'NONE', cycle: null });
  });

  it('serializes independent nested evidence and carries stable IDs with only the existing clocks shifted', () => {
    const { sim, a, b } = fixture(); wait(sim, a, b.id, alternatives(b.id, -1));
    a.arsWait = { code: 'BERTH_WAIT', train: b.id, signal: 0, entrySignal: 0, t: sim.t, detail: 'occupied', alternatives: alternatives(b.id, -1) };
    const original = structuredClone(a.halt.alternatives);
    const cp = capture(sim), captured = cp.trains.find(x => x.id === a.id)!;
    a.halt.alternatives![0].blockers[0].train = -1;
    a.arsWait.alternatives![0].choices[0].berth = 100;
    expect(captured.halt.alternatives).toEqual(original);
    expect(captured.arsWait?.alternatives?.[0].choices[0].berth).toBe(0);
    const bundle = parseDiagnostics(stringifyDiagnostics({ version: 2, topology: topologySignature(sim.topo), dt: 0.1,
      config: sim.config, inputs: [], until: sim.t, startState: cp, state: cp }));
    restore(sim, bundle.state);
    const restored = sim.trains.get(a.id)!;
    expect(restored.halt.alternatives).toEqual(original);
    const next = new Sim({ ...sim.config, date: '2026-10-20' });
    carryTrains(next, sim);
    const carried = next.trains.get(a.id)!;
    expect(carried.halt.alternatives).toEqual(original);
    expect(carried.halt.alternatives).not.toBe(restored.halt.alternatives);
    expect(carried.arsWait?.alternatives).not.toBe(restored.arsWait?.alternatives);
    expect(carried.arsWait?.t).toBe(sim.t - DAY_S);
    expect(carried.halt.since).toBe(restored.halt.since - DAY_S);
  });
});
