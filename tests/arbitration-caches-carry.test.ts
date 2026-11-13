// Stage 5: the arbitration lookups after a continuous rollover (carryWorld). The
// carried night world is the mid-line overnight one (fixture data, as in
// continuous-day.test.ts).
import './helpers/midline-storage';
import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { nextOperatingConfig } from '../src/sim/operatingDay';
import { overnightPlaces } from '../src/sim/timetable';
import { computeBody, indexBodies } from '../src/sim/movement';
import { runUntil, assertIntegrity } from './helpers';
import { checkArbitration } from './helpers/arbitration-check';

describe('resource arbitration lookups across operating days', () => {
  it('equal their direct computation for carried trains and transits', () => {
    let s = new Sim({ dayType: 'weekday', date: '2026-10-19', dateLabel: 'test', startTime: 26.5 * 3600, seed: 3, noPossessions: true });
    const places = overnightPlaces(s.topo);
    s.trainList.forEach((tr, i) => {
      const b = s.topo.berths[places[i].arrivalBerth];
      Object.assign(tr, { link: b.link, off: b.offset, dir: b.dir, hist: [{ link: b.link, dir: b.dir }], tasks: [], phase: 'stabled', inService: false, v: 0 });
      computeBody(s, tr);
    });
    s.berthRes.clear(); s.blockDone = new Set(s.plan.blocks.map(b => b.id)); s.t = 26.5 * 3600; indexBodies(s);
    // an extra still running when the day ends
    expect(s.command({ c: 'addTrain', depot: 0, dir: 'DN', to: 12, time: 27.5 * 3600 }).ok).toBe(true);
    runUntil(s, 27.7 * 3600);
    checkArbitration(s);
    runUntil(s, 27.75 * 3600);
    s = new Sim(nextOperatingConfig(s), s);
    let found = 0, decisions = 0;
    for (let t = s.t; t < 5.5 * 3600; t += 120) {
      runUntil(s, t);
      const r = checkArbitration(s);
      found += r.found; decisions += r.decisions;
    }
    assertIntegrity(s);
    expect(found).toBeGreaterThan(20);
    expect(decisions).toBeGreaterThan(5);
  }, 300000);
});
