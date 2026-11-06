import './helpers/midline-storage';
// Mid-line storage and hot-standby mechanisms (moved from round3 in D178: Line 2
// data no longer stores trains on the main line; the fixture restores the old entries).
import {beforeAll,describe,expect,it} from 'vitest';
import {Sim} from '../src/sim/engine';
import {platformBerth} from '../src/sim/timetable';
import {scanAhead} from '../src/sim/movement';
import {capture,restore} from '../src/sim/state';
import {unfinishedAtRollover} from '../src/sim/operatingDay';
import {storageExit} from './helpers/storage-exit';
import {hotStandby} from '../src/sim/duty/live';
import {depotLedger} from '../src/sim/timetable';
import {makeSim,runFor,runUntil,assertNoCollision,assertIntegrity} from './helpers';
import {checkSafety} from '../src/sim/invariants';
import {releaseRoute} from '../src/sim/interlocking';
import {computeBody,indexBodies} from '../src/sim/movement';

const H=(h:number,m=0)=>h*3600+m*60;
const create=(dayType:'weekday'|'weekend'='weekday')=>new Sim({dayType,dateLabel:'round3',startTime:H(4),seed:1});

describe('registered storage positions',()=>{
  it.each(['weekday','weekend'] as const)('%s: holds overnight heads at their spawn berths',day=>{
    const sim=create(day), positions=sim.trainList.map(tr=>({id:tr.id,link:tr.link,off:tr.off}));
    expect(positions.length).toBe(6);
    while(sim.t<H(4,2)) sim.step();
    for(const p of positions) {
      const tr=sim.trains.get(p.id)!;
      expect(tr.link).toBe(p.link);
      expect(Math.abs(tr.off-p.off)).toBeLessThan(.01);
    }
  });
  it('keeps authority at the hot berth while the next task is on a distant platform',()=>{
    const sim=create(), tr=sim.trainList.find(tr=>sim.topo.berths.some(b=>b.station===24&&b.link===tr.link))!;
    expect(tr).toBeDefined();
    sim.t=H(12);
    const berth=platformBerth(sim.topo,24,'DN');
    tr.tasks=[{k:'stop',berth,station:24,trip:-1,arr:null,dep:H(13),standby:true,revenue:true,doors:true}];
    const scan=scanAhead(sim,tr,berth);
    expect(scan.maDist).toBe(0);
    expect(scan.maCode).toBe('REGULATION');
  });
});

// moved from operating-day in D178
describe('operating day boundaries with mid-line storage',()=>{
 let sim:Sim;
 beforeAll(()=>{sim=new Sim({dayType:'weekday',date:'2026-10-19',dateLabel:'test',startTime:14400,seed:3,noPossessions:true,instructorEvents:['severe-wind-sequence']});},60000);
 it('accepts the opening overnight cars at their legal departure or arrival berths',()=>{
  expect(sim.trainList).toHaveLength(6);
  expect(unfinishedAtRollover(sim)).toEqual([]);
 });
 it('counts a storage shunt as unfinished once its scheduled release arrives',()=>{
  const saved=capture(sim),{tr}=storageExit(sim);
  expect(tr.tasks[0]?.k).toBe('reverse');expect(tr.tasks.some(task=>task.k==='stop'&&task.stabledOut)).toBe(true);expect(unfinishedAtRollover(sim).join(' ')).not.toContain(tr.vehicle);
  const stop=tr.tasks.find(task=>task.k==='stop'&&task.stabledOut)!;
  if(stop.k!=='stop'||stop.dep===null)throw new Error('missing scheduled departure');
  sim.t=stop.dep;expect(unfinishedAtRollover(sim).join(' ')).toContain(tr.vehicle);
  restore(sim,saved);
 });
});

// moved from dispatcher in D178 (the middle hot spares are fixture data now)
describe('dispatcher commands with middle hot spares',()=>{
  function stepCheck(sim: Sim) { assertNoCollision(sim); assertIntegrity(sim); }
  it('middle hot spares recover the downstream part of a withdrawn core train over real routes', () => {
    const sim = makeSim('weekday', 9 * 3600 + 55 * 60, { seed: 5 });
    // (the 科技馆 spare of the fixture is in place from 12:32 on the pool-planned base)
    runUntil(sim, 12.75 * 3600, stepCheck);
    expect(sim.trainList.flatMap(t => hotStandby(sim, t)?.station ?? []).sort((a,b) => a-b)).toEqual([0,17,24,30]);
    const checkpoint = capture(sim);
    for (const [station, dir, home] of [[17, 'UP', 0], [24, 'DN', 2]] as const) {
      restore(sim, checkpoint);
      const pick = () => sim.trainList.find(t => t.inService && !t.withdrawn && t.block >= 0
        && sim.plan.blocks[t.block].end.kind === 'depot' && (sim.plan.blocks[t.block].end as {depot:number}).depot === home
        && sim.plan.trips[t.tripId]?.dir === dir && sim.plan.trips[t.tripId].stops.some(s => s.st === station && s.dep > sim.t + 300 && s.dep < sim.t + 1000));
      // Depot reuse changes which duty carries the next call. Choose the
      // incident from actual traffic, retaining the same short response window.
      // (D178: the pool spreads the duties' homes, so a duty ending at the
      // spare's own yard may pass a little later)
      const until=sim.t+3600;
      while(!pick()&&sim.t<until) runFor(sim,30,stepCheck);
      const lost=pick()!;
      expect(lost, `middle ${station}`).toBeDefined();
      const incident=capture(sim);
      const trip = structuredClone(sim.plan.trips[lost.tripId]);
      const lostDuty = sim.plan.blocks[lost.block].trips.slice();
      const cut = trip.stops.findIndex(s => s.st === station);
      const now = sim.t;
      // Same incident with only the end-terminal hot spares available.
      for (const h of sim.trainList) if ([17,24].includes(hotStandby(sim,h)?.station ?? -1)) h.manual = true;
      sim.autoDispatch = true;
      expect(sim.command({c:'withdraw',train:lost.id}).ok).toBe(true);
      expect(sim.plan.trips[trip.id].cancelled).toBe(true);
      const baseline = lostDuty.map(id=>sim.plan.trips[id]).filter(t => t.revenue && !t.cancelled && !t.completed && t.block !== lost.block && t.stops[0].dep >= now)
        .sort((a,b) => a.stops[0].dep-b.stops[0].dep)[0]?.stops[0].dep ?? Infinity;

      // A relieved duty (a standby already took its later trips) keeps trips
      // that end in a withdrawal, not at the duty's end: no hot spare takes
      // them, or it would inherit an end it cannot reach (soak weekday base
      // seed 6, 087-1187 sent from the airport straight to 淞虹路).
      restore(sim, incident); sim.autoDispatch = true;
      sim.plan.blocks[lost.block].relieved = true;
      const before = sim.plan.trips.length;
      expect(sim.command({c:'withdraw',train:lost.id}).ok).toBe(true);
      expect(sim.plan.trips.slice(before).some(t => t.revenue && t.from === station)).toBe(false);
      expect(sim.trainList.some(t => hotStandby(sim,t)?.station === station)).toBe(true);

      restore(sim, incident); sim.autoDispatch = true;
      const hot = sim.trainList.find(t => hotStandby(sim,t)?.station === station)!;
      const originalCount = sim.plan.trips.length;
      expect(sim.command({c:'withdraw',train:lost.id}).ok).toBe(true);
      const suffix = sim.plan.trips.slice(originalCount).find(t => t.revenue && t.from === station)!;
      expect(suffix).toBeDefined();
      expect(sim.plan.trips[trip.id].cancelled).toBe(true);
      expect(suffix.stops.slice(1)).toEqual(trip.stops.slice(cut + 1));
      expect(suffix.stops[0].dep).toBe(trip.stops[cut].dep);
      if (station === 24) expect(suffix.stops[0]).toMatchObject({stop:false,noBoard:true});
      // D184 (user decision 2026-11-06, A): the spare's place is refilled from
      // the yard the withdrawn train goes to, by a move like a planned spare's
      const cover=sim.plan.trips.slice(originalCount).find(t=>t.standby&&t.to===station&&t.block!==hot.block)!;
      expect(cover, `refill ${station}`).toBeDefined();
      const refill=sim.plan.blocks[cover.block], lostBlock=sim.plan.blocks[lost.block];
      expect(refill.start.kind==='depot'&&refill.start.depot).toBe(lostBlock.withdrawal?.depot);
      expect(refill.end.kind==='stable'&&refill.end.berth!==undefined&&sim.topo.berths[refill.end.berth].link).toBe(hot.link);
      const ledger = depotLedger(sim.topo,sim.plan);
      expect(ledger.final).toEqual(ledger.initial);
      expect(suffix.stops[0].dep-now).toBeLessThan(1000);
      expect(baseline-suffix.stops[0].dep).toBeGreaterThan(1800);
      const routes = new Set<string>();
      const departureStation = suffix.stops.find(s => s.stop)!.st;
      const scheduled = suffix.stops.find(s => s.st === departureStation)!.dep;
      runFor(sim, scheduled-sim.t+120, s => {
        stepCheck(s);
        if (hot.nextSignal >= 0 && s.sig[hot.nextSignal].route >= 0) routes.add(s.topo.routes[s.sig[hot.nextSignal].route].name);
      });
      expect(routes.size).toBeGreaterThan(0);
      const departure = sim.depLog.find(d => d.trip === suffix.id && d.st === departureStation);
      expect(departure).toBeDefined();
      expect(departure!.delay).toBeLessThan(60);
    }
  },600_000); // both incidents run to the recovered departure after some 10 000 simulated seconds of warm-up

});

// moved from core in D178 (needs the train stabled overnight in the 蟠祥路 tail)
describe('paper-based turnback with an overnight tail train',()=>{
  const advance = (sim: Sim, seconds: number) => { const end = sim.t + seconds; while (sim.t < end - 1e-6) sim.step(); };
  it('holds a CBTC train inside the tail until a complete pull-out path is locked', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'core', startTime: 14400, seed: 7, noPossessions: true }); advance(sim, 2);
    const berth = sim.topo.berths[sim.topo.stations[0].turnbackBerths[0]];
    // (the train stabled there overnight: one moved in from elsewhere would keep its old authority)
    const tr = sim.trainList.find(t => t.link === berth.link)!;
    expect(tr).toBeDefined();
    for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
    const platform = sim.topo.berths.find(b => b.station === 0 && b.kind === 'platform' && b.dir === 1)!;
    tr.link = berth.link; tr.off = berth.offset; tr.dir = berth.dir; tr.hist = [{ link: berth.link, dir: berth.dir }];
    tr.v = 0; tr.phase = 'reversing'; tr.dwellUntil = sim.t; tr.tbStage = 'arrive'; tr.block = -1; tr.tripId = -1;
    tr.tasks = [{ k: 'reverse', berths: [berth.id], chosen: berth.id, station: 0, minTime: 0 },
      { k: 'stop', berth: platform.id, station: 0, trip: -1, arr: null, dep: sim.t + 300, doors: false, revenue: false }];
    computeBody(sim, tr); indexBodies(sim); checkSafety(sim); tr.tbStage = 'reverse'; checkSafety(sim);
    for (const rid of [...sim.routes.keys()]) releaseRoute(sim, rid);
    for (const signal of sim.sig) signal.ars = false;
    sim.step(); const point = { link: tr.link, off: tr.off }; advance(sim, 20);
    expect(tr.tbStage).toBe('depart'); expect(tr.v).toBe(0);
    expect({ link: tr.link, off: tr.off }).toEqual(point);
    expect(tr.maDist).toBe(0); expect(tr.eb).toBe(false);
    expect(sim.integrity.violations).toHaveLength(0);
  });
});
