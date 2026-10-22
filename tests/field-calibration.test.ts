import { describe, expect, it } from 'vitest';
import { createProbeWorld, probeSection } from '../scripts/audio/field-model';
import { capture, restore } from '../src/sim/state';
import { STATIONS } from '../src/data/line2';
import { regulationDistance, regulationProfile, scanAhead, goalBerth, MA_NEAR, computeBody, indexBodies, updateTrainMotion } from '../src/sim/movement';
import { PERF, sectionEta, sectionCruise, staticLinkLimit } from '../src/sim/dynamics';
import { newTrain } from '../src/sim/ats';
import { buildStops, platformBerth, tripTasks } from '../src/sim/timetable';
import { releaseRoute } from '../src/sim/interlocking';

describe('field section measurement harness', () => {
  it('uses real departure, arrival and door clocks with ATO regulation enabled', () => {
    const sim = createProbeWorld();
    const from = STATIONS.findIndex(s => s.id === 'YDD'), to = STATIONS.findIndex(s => s.id === 'HTS');
    const row = probeSection(sim, from, to, 'DN', 20 * 3600 + 30 * 60);
    expect(row.completed).toBe(true);
    expect(row.violations).toEqual([]);
    expect(row.regulated).toBe(true);
    expect(row.samples).toBeGreaterThan(100);
    expect(row.departure!).toBeLessThan(row.arrival!);
    expect(row.opening!).toBeGreaterThan(row.arrival!);
    expect(row.locked!).toBeGreaterThan(row.opening!);
    expect(row.nextDeparture!).toBeGreaterThanOrEqual(row.locked!);
    expect(row.run).toBeCloseTo(row.arrival! - row.departure!, 6);
    expect(row.departureToDeparture).toBeCloseTo(row.run! + row.dwell!, 6);
    expect(row.peakKmh!).toBeGreaterThan(row.targetMedianKmh! - 5);
    // Arrival budgets now use the whole task path, while ATP retains its near scan.
    expect(row.stopDistanceUnavailableFraction).toBe(0);
    expect(row.cruiseMedianKmh!).toBeCloseTo(row.targetMedianKmh!, 0);
    expect(row.levels).toEqual([1]);
  });

  it('restoring the baseline prevents earlier probes from changing a measurement', () => {
    const sim = createProbeWorld(), baseline = capture(sim);
    // Name lookup keeps this regression independent of station numbering.
    const a = STATIONS.findIndex(s => s.name === '江苏路');
    const b = STATIONS.findIndex(s => s.name === '静安寺');
    const first = probeSection(sim, a, b, 'DN', 22 * 3600);
    restore(sim, baseline);
    probeSection(sim, b, a, 'UP', 12 * 3600);
    restore(sim, baseline);
    expect(probeSection(sim, a, b, 'DN', 22 * 3600)).toEqual(first);
  });

  it.each([['淞虹路', '虹桥2号航站楼', 'UP'], ['广兰路', '唐镇', 'DN']] as const)(
    'keeps the budget distance through unsignalled links on %s to %s', (from, to, dir) => {
      const sim = createProbeWorld();
      const row = probeSection(sim, STATIONS.findIndex(s => s.name === from), STATIONS.findIndex(s => s.name === to), dir, 43200);
      expect(row.completed).toBe(true);
      expect(row.violations).toEqual([]);
      expect(row.stopDistanceUnavailableFraction).toBe(0);
      expect(Math.abs(row.arrivalDeltaS!)).toBeLessThan(1);
    });

  it('keeps a full budget distance and live delay behind a red signal, without changing stopDist', () => {
    const sim = createProbeWorld();
    for (const tr of [...sim.trainList]) sim.removeTrain(tr);
    for (const id of [...sim.routes.keys()]) releaseRoute(sim, id);
    const from = STATIONS.findIndex(s => s.id === 'YDD'), to = STATIONS.findIndex(s => s.id === 'HTS');
    const berth = sim.topo.berths[platformBerth(sim.topo, from, 'DN')];
    sim.t = 43200;
    const stops = buildStops(sim.planCtx, 'DN', from, to, sim.t, true, 1);
    const trip = { ...sim.plan.trips[0], id: 0, from, to, dir: 'DN' as const, stops };
    sim.plan.trips[0] = trip;
    const tr = newTrain(sim, null, berth.link, berth.offset, berth.dir, [{link:berth.link,dir:berth.dir}], '0200');
    tr.tripId = 0; tr.inService = true; tr.mode = 'DTO'; tr.level = 'CBTC';
    tripTasks(sim.topo, trip, tr.tasks, false); tr.tasks.shift(); tr.phase = 'run';
    computeBody(sim, tr); indexBodies(sim);
    const near = scanAhead(sim, tr, goalBerth(tr), MA_NEAR);
    const full = regulationDistance(sim, tr);
    expect(near.stopDist).toBe(Infinity);
    expect(full).toBeGreaterThan(MA_NEAR);
    expect(near.maDist).toBeLessThan(full);
    const profile = regulationProfile(sim, tr);
    expect(profile.distance).toBe(full);
    expect(profile.limits.reduce((sum, s) => sum + s.length, 0)).toBeCloseTo(full, 6);
    const saved = capture(sim);
    tr.delay = 999;
    updateTrainMotion(sim, tr, .1);
    expect(tr.stopDist).toBe(Infinity);
    expect(tr.delay).not.toBe(999);
    restore(sim, saved);
    expect(regulationProfile(sim, sim.trains.get(tr.id)!)).toEqual(profile);
    // Replacing the stop task must immediately replace the distance; there is
    // no berth/timer cache to survive a task edit or carry into another day.
    const task = tr.tasks[0]; if (task.k !== 'stop') throw new Error('stop fixture');
    tr.tasks[0] = {...task, berth: berth.id, station: from};
    expect(regulationDistance(sim, tr)).toBe(0);
  });
});

describe('static task-path ETA', () => {
  it('spends a turnout limit only on that segment, carrying speed into the main line', () => {
    const slow = 30 / 3.6, fast = PERF.vMax;
    const limits = [{ length: 100, limit: slow }, { length: 1900, limit: fast }];
    const eta = sectionEta(2000, slow, fast, limits);
    expect(eta).toBeCloseTo(100 / slow + sectionEta(1900, slow, fast), 8);
    expect(eta).toBeLessThan(sectionEta(2000, slow, slow) - 100);
  });

  it('anticipates a future lower limit and uses the same estimate in cruise inversion', () => {
    const fast = PERF.vMax, slow = 30 / 3.6, a = PERF.aMax * .8, b = PERF.bService * .8;
    const limits = [{ length: 1900, limit: fast }, { length: 100, limit: slow }];
    const expected = fast / a + (fast - slow) / b
      + (1900 - fast ** 2 / (2 * a) - (fast ** 2 - slow ** 2) / (2 * b)) / fast
      + 100 / slow + slow / (2 * b);
    const eta = sectionEta(2000, 0, fast, limits);
    expect(eta).toBeCloseTo(expected, 8);
    expect(eta).toBeGreaterThan(sectionEta(2000, 0, fast));
    const budget = eta + 20;
    const cruise = sectionCruise(2000, 0, budget, fast, limits);
    expect(sectionEta(2000, 0, cruise, limits)).toBeCloseTo(budget, 1);
  });

  it('keeps uniform profiles equivalent to the original estimate, including deceleration', () => {
    for (const v of [0, 10, 22]) for (const cruise of [5, 15, PERF.vMax])
      expect(sectionEta(2000, v, cruise, [{length: 500, limit: PERF.vMax}, {length: 1500, limit: PERF.vMax}]))
        .toBe(sectionEta(2000, v, cruise));
  });

  it('keeps the tail on a turnout limited until it clears, then releases the main line', () => {
    const sim = createProbeWorld();
    const from = STATIONS.findIndex(s => s.name === '广兰路'), to = STATIONS.findIndex(s => s.name === '金科路');
    const turnout = sim.topo.links.find(l => l.track === 'SID' && l.limit === 30 && l.len >= 50
      && l.platform < 0 && sim.topo.sections[l.section].station === from)!;
    expect(turnout).toBeDefined();
    const berth = sim.topo.berths[platformBerth(sim.topo, to, 'UP')];
    const route = sim.topo.routes.find(r => r.steps.some(s => s.link === turnout.id && s.dir === -1)
      && sim.routeTable.next.get(berth.id)?.[r.start] === r.id)!;
    expect(route).toBeDefined();
    for (const point of route.switches) Object.assign(sim.sw[point.sw], {pos:point.pos,target:point.pos,moveUntil:0});
    const tr = sim.trainList[0];
    // The head starts on the middle-track turnout; the forward restriction
    // must remain in force until the tail clears. No issued MA is required.
    tr.link = turnout.id; tr.off = turnout.len / 2;
    tr.dir = turnout.chainB < turnout.chainA ? 1 : -1;
    tr.hist = [{ link: turnout.id, dir: tr.dir }];
    tr.tasks = [{k:'stop',berth:berth.id,station:to,trip:-1,arr:sim.t+200,dep:null,doors:true,revenue:true}];
    tr.body = [{link:turnout.id,from:turnout.len/2,to:turnout.len}]; tr.lastStation = from;
    const profile = regulationProfile(sim, tr);
    expect(Number.isFinite(profile.distance)).toBe(true);
    expect(profile.limits[0].limit).toBe(staticLinkLimit(sim.topo, turnout.id));
    expect(profile.limits[0].length).toBeGreaterThanOrEqual(turnout.len / 2 + tr.len);
    expect(profile.limits.at(-1)!.limit).toBe(PERF.vMax);
  });
});
