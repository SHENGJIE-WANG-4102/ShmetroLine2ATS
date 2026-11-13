/**
 * Per-step speed-ups that must not change any result (stage 2b): each cache,
 * shortcut or skip is checked against the direct computation it replaces.
 */
import { describe, expect, it } from 'vitest';
import { PERF, atoBrakeDistance, atoBrakeProfile, atoStopApproachDistance, sectionPlan, withinStopApproach } from '../src/sim/dynamics';
import { buildTopology, sigEntryKey, signalAtEntry } from '../src/sim/topology';
import { buildRouteTable } from '../src/sim/routeTable';
import { walkRouteToBerth } from '../src/sim/routePath';
import { distanceToBerth } from '../src/sim/ats';
import { gradeAlong, profileOf } from '../src/sim/gradient';
import { checkpointDroppedAfterRunUp, compactCheckpoints } from '../src/sim/diagnostics';
import type { Sim } from '../src/sim/engine';
import type { Checkpoint } from '../src/sim/state';

describe('stop-approach fast reject', () => {
  it('is exactly stopDist <= atoStopApproachDistance, also right at the threshold', () => {
    let checked = 0;
    for (const grade of [-.4, -.15, 0, .05, .214547, .6, .95, 1.2])
      for (let v = 0; v <= 26; v += .37)
        for (const a of [-1.25, -.75, -.2, 0, .3, .85, 1]) {
          const exact = atoStopApproachDistance(v, a, grade);
          const probes = [0, 1, exact * .5, exact, exact * (1 + 1e-12), exact + 1e-9, exact + .002, exact * 1.0000005, exact * 1.01, exact + 1, exact * 2, 5000];
          for (const d of probes) { expect(withinStopApproach(d, v, a, grade)).toBe(d <= exact); checked++; }
        }
    expect(checked).toBeGreaterThan(30000);
  });
});

describe('soft-stop shape reuse', () => {
  it('gives each (speed, grade) the same answer in any call order', () => {
    const args: [number, number][] = [];
    for (const v of [2.5, 6.11, 6.11, 17, 22.2, 17]) for (const g of [0, -.1, .2, 0]) args.push([v, g]);
    const forward = args.map(([v, g]) => [atoBrakeDistance(v, g), atoBrakeProfile(v, 3, undefined, g).speed]);
    const backward = args.slice().reverse().map(([v, g]) => [atoBrakeDistance(v, g), atoBrakeProfile(v, 3, undefined, g).speed]).reverse();
    expect(backward).toEqual(forward);
  });
  it('keys on the performance data it reads, not only on its arguments', () => {
    const soft = PERF.atoSoftStop!;
    const fields: [object, string][] = [[PERF, 'jerk'], [PERF, 'bPlan'], [PERF, 'bService'], [soft, 'releaseS']];
    for (const [owner, key] of fields) {
      const rec = owner as Record<string, number>, saved = rec[key];
      // (a grade at which bService still bounds the peak)
      const before = atoBrakeDistance(17, .5);
      expect(atoBrakeDistance(17, .5)).toBe(before);
      rec[key] = saved * 1.2;
      try {
        const changed = atoBrakeDistance(17, .5);
        expect(changed).not.toBe(before);
        expect(atoBrakeDistance(17, .5)).toBe(changed);
      } finally { rec[key] = saved; }
      expect(atoBrakeDistance(17, .5)).toBe(before);
    }
  });
});

describe('section plan memo and trace sharing', () => {
  it('returns the same plan alone, repeated and interleaved with other plans', () => {
    const topo = buildTopology(), prof = profileOf(topo), head = topo.stations[3].chain;
    const cases: Parameters<typeof sectionPlan>[] = [
      [1260, 0, 105.3, 22.2, [{ length: 300, limit: 16.7 }, { length: 960, limit: 22.2 }], .25, 0, 1, gradeAlong(prof, head, 1)],
      [1260, 0, 140, 22.2, [{ length: 1260, limit: 22.2 }], .25, 0, 1, gradeAlong(prof, head, 1)],
      [2100, 3.2, 190, 21.4, undefined, 3 / 3.6, .4, 1, gradeAlong(prof, head, -1)],
      [900, 0, 120, 22.2, undefined, .25, 0, 2, undefined],
      [1500, 12, 85, 22.2, [{ length: 700, limit: 13.9 }, { length: 800, limit: 22.2 }], .25, -.3, 1, gradeAlong(prof, head, 1)],
    ];
    const alone = cases.map(c => JSON.stringify(sectionPlan(...c)));
    const again = cases.map(c => JSON.stringify(sectionPlan(...c)));
    const reversed = cases.slice().reverse().map(c => JSON.stringify(sectionPlan(...c))).reverse();
    expect(again).toEqual(alone);
    expect(reversed).toEqual(alone);
    // a coasting plan exercises the bisection (memo hits and resumed traces)
    expect(cases.some(c => sectionPlan(...c).coastAt >= 0)).toBe(true);
  });
});

describe('topology lookups', () => {
  it('signalAtEntry equals the signal map for every link end, and falls back off the link', () => {
    const topo = buildTopology();
    let signals = 0;
    topo.links.forEach((l, i) => {
      for (const node of [l.a, l.b]) {
        const expected = topo.signalByEntry.get(sigEntryKey(node, i)) ?? -1;
        expect(signalAtEntry(topo, node, i)).toBe(expected);
        if (expected >= 0) signals++;
      }
      expect(signalAtEntry(topo, -7, i)).toBe(-1);
    });
    expect(signals).toBe(topo.signals.length);
  });
  it('distanceToBerth (memoised) equals the route-table walk for every signal and berth', () => {
    const topo = buildTopology(), routeTable = buildRouteTable(topo), sim = { topo, routeTable } as unknown as Sim;
    for (let pass = 0; pass < 2; pass++)
      for (const s of topo.signals) for (const b of topo.berths)
        expect(distanceToBerth(sim, s.id, b.id)).toBe(walkRouteToBerth(topo, routeTable, { signal: s.id }, b.id));
    // a visitor still sees the walk
    const seen: number[] = [];
    const s = topo.signals.find(x => x.routes.length)!, goal = topo.routes[s.routes[0]].berths[0] ?? topo.berths[0].id;
    distanceToBerth(sim, s.id, goal, link => seen.push(link));
    const direct: number[] = [];
    walkRouteToBerth(topo, routeTable, { signal: s.id }, goal, link => direct.push(link));
    expect(seen).toEqual(direct);
  });
});

describe('run-up checkpoints', () => {
  it('skipping the ones compaction drops leaves the same rewind list', () => {
    const cadence = (from: number, target: number, skip: boolean) => {
      let list: Checkpoint[] = [{ t: from } as Checkpoint], lastDue = from, captured = 1;
      for (let t = from + .1; t < target; t += .1) {
        if (t - Math.max(list[list.length - 1].t, lastDue) < 60 - 1e-6) continue;
        lastDue = t;
        if (skip && checkpointDroppedAfterRunUp(list, t, target)) continue;
        list.push({ t } as Checkpoint); captured++;
        list = compactCheckpoints(list, t);
      }
      list.push({ t: target } as Checkpoint);
      return { times: compactCheckpoints(list, target).map(c => c.t), captured };
    };
    for (const target of [4.5 * 3600, 6 * 3600 + 17.3, 10 * 3600, 18 * 3600 + 600.1]) {
      const all = cadence(4 * 3600, target, false), skipped = cadence(4 * 3600, target, true);
      expect(skipped.times).toEqual(all.times);
      if (target - 4 * 3600 > 3 * 3600) expect(skipped.captured).toBeLessThan(all.captured / 2);
    }
  });
});
