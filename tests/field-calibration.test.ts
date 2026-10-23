import { describe, expect, it } from 'vitest';
import { createProbeWorld, probeSection } from '../scripts/audio/field-model';
import { capture, restore } from '../src/sim/state';
import { STATIONS, LINE_INFO, OPERATIONS } from '../src/data/line2';
import { regulationDistance, regulationProfile, scanAhead, goalBerth, MA_NEAR, computeBody, indexBodies, updateTrainMotion } from '../src/sim/movement';
import { PERF, computeRunTimes, sectionEta, sectionPlan, staticLinkLimit } from '../src/sim/dynamics';
import { newTrain } from '../src/sim/ats';
import { buildStops, platformBerth, tripTasks } from '../src/sim/timetable';
import { releaseRoute } from '../src/sim/interlocking';

describe('field section measurement harness', () => {
  it.each([['HTS','PDA','DN'],['PDA','HTS','UP']] as const)(
    'keeps the user-confirmed airport speed restriction in data and live motion %s → %s', (from,to,dir) => {
      const sim=createProbeWorld();
      const a=sim.topo.stations.find(s=>s.id===from)!;
      const b=sim.topo.stations.find(s=>s.id===to)!;
      const lo=Math.min(a.chain,b.chain),hi=Math.max(a.chain,b.chain);
      const links=sim.topo.links.filter(l=>l.track===dir&&(l.chainA+l.chainB)/2>=lo&&(l.chainA+l.chainB)/2<hi);
      expect(links.length).toBeGreaterThan(0);
      expect(links.every(l=>l.limit<=60)).toBe(true);
      const row=probeSection(sim,a.index,b.index,dir,43200);
      expect(row.completed).toBe(true);expect(row.violations).toEqual([]);
      expect(row.peakKmh).toBeGreaterThan(40);expect(row.peakKmh).toBeLessThanOrEqual(60);
    });
  it('CM advisory shares the ATO target, responds to the budget, and never controls manual effort or delay', () => {
    const sim=createProbeWorld();
    probeSection(sim,STATIONS.findIndex(s=>s.id==='YDD'),STATIONS.findIndex(s=>s.id==='HTS'),'DN',43200);
    for(let i=0;i<300;i++)sim.step();
    const tr=sim.trainList[0];
    expect(sim.command({c:'manual',train:tr.id,mode:'CM'}).ok).toBe(true);sim.drive(tr.id,1);
    const saved=capture(sim),id=tr.id;
    updateTrainMotion(sim,tr,.1);
    const cm=tr.vRecommended!,motion={v:tr.v,a:tr.a,off:tr.off,link:tr.link,delay:tr.delay};
    expect(cm).toBeGreaterThan(0);expect(cm).toBeLessThanOrEqual(tr.vPermit);
    expect(sim.snapshot().trains.find(t=>t.id===id)?.vRecommended).toBe(cm);
    restore(sim,saved);const auto=sim.trains.get(id)!;auto.manual=false;auto.mode='DTO';
    updateTrainMotion(sim,auto,.1);expect(auto.vTarget).toBeCloseTo(cm,8);expect(auto.vRecommended).toBeUndefined();
    restore(sim,saved);const manual=sim.trains.get(id)!;const task=manual.tasks[0];
    if(task.k!=='stop'||task.arr===null)throw Error('expected onward arrival');
    manual.tasks[0]={...task,arr:task.arr+120};updateTrainMotion(sim,manual,.1);
    // More slack first lengthens the coast; it no longer has to lower the
    // recommendation at this exact position in the initial traction curve.
    expect(manual.ato!.plan.cutoff).toBeLessThanOrEqual(saved.trains.find(t=>t.id===id)!.ato?.plan.cutoff ?? PERF.vMax);
    expect(manual.ato!.plan.eta).toBeGreaterThan(auto.ato!.plan.eta);
    expect({v:manual.v,a:manual.a,off:manual.off,link:manual.link,delay:manual.delay}).toEqual(motion);
    const cp=capture(sim);manual.vRecommended=99;restore(sim,cp);
    expect(sim.trains.get(id)!.vRecommended).toBe(cp.trains.find(t=>t.id===id)!.vRecommended);
  });
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
    // The stored cutoff stays above the falling coast reference.
    expect(row.cruiseMedianKmh!).toBeGreaterThanOrEqual(row.targetMedianKmh!);
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
  it('gives short and long stopping sections the same seconds at every running level', () => {
    const sim=createProbeWorld();
    const minimum=computeRunTimes(sim.topo,LINE_INFO.trainLength,OPERATIONS.platformStopKmh,1,true);
    for(const level of [1,2,3,4]) {
      const planned=level===1?sim.rt:sim.rt.byLevel![level];
      const physical=level===1?minimum:minimum.byLevel![level];
      for(const dir of ['dn','up'] as const) for(let i=0;i<planned[dir].length;i++) {
        const allowance=planned[dir][i]-physical[dir][i];
        // The existing 0.1-second truncation may remove a fraction of a tick.
        expect(allowance,`level ${level} ${dir} section ${i}`).toBeGreaterThan(OPERATIONS.sectionRunAllowanceS-.10000001);
        expect(allowance,`level ${level} ${dir} section ${i}`).toBeLessThanOrEqual(OPERATIONS.sectionRunAllowanceS+.00000001);
      }
    }
  });
  it('spends a turnout limit only on that segment, carrying speed into the main line', () => {
    const slow = 30 / 3.6, fast = PERF.vMax;
    const limits = [{ length: 100, limit: slow }, { length: 1900, limit: fast }];
    const eta = sectionEta(2000, slow, fast, limits);
    expect(eta).toBeCloseTo(100 / slow + sectionEta(1900, slow, fast), 8);
    expect(eta).toBeLessThan(sectionEta(2000, slow, slow) - 100);
  });

  it('anticipates a future lower limit and uses the same estimate in cruise inversion', () => {
    const fast = PERF.vMax, slow = 30 / 3.6;
    const limits = [{ length: 1900, limit: fast }, { length: 100, limit: slow }];
    const eta = sectionEta(2000, 0, fast, limits);
    expect(eta).toBeGreaterThan(sectionEta(2000, 0, fast));
    const budget = eta + 20;
    const plan = sectionPlan(2000, 0, budget, fast, limits);
    expect(plan.completed).toBe(true);
    expect(plan.eta).toBeCloseTo(budget, 0);
    expect(plan.samples.every(p=>p.remaining>100 || p.speed<=slow+.1)).toBe(true);
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
