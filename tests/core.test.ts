import { describe, it, expect } from 'vitest';
import { Sim } from '../src/sim/engine';
import { capture, restore, fingerprint } from '../src/sim/state';
import { exportDiagnostics, stringifyDiagnostics, parseDiagnostics, replayDiagnostics, compactCheckpoints } from '../src/sim/diagnostics';
import { checkSafety, violate } from '../src/sim/invariants';
import { MACHINES, MODE, EB, allowed } from '../src/sim/fsm';
import type { Command, Task, Train, Trip } from '../src/sim/model';
import { openCall, answerCall, unsafeAhead, rescuerFor, callRescue, radioTick } from '../src/sim/radio';
import { trySetRoute, cancelRoute, committedTrain, bindRouteApproach, updateInterlocking, releaseRoute, computeOccupancy } from '../src/sim/interlocking';
import { setMode, grantRM, updateOnboard, applyEB, ebCauseCleared, answerEbRelease, authoriseEBRelease } from '../src/sim/onboard';
import { parseTime } from '../src/sim/calendar';
import { computeBody, indexBodies, rescueRouteReady, scanAhead } from '../src/sim/movement';
import { distanceToBerth, updateTrainTasks, rescueApproach, trainDesire, runARS, spawnDue, setTripFromTasks, intervalDepartureHold, cancelArsRoute, arsReadyAt } from '../src/sim/ats';
import { dispatcherTick } from '../src/sim/dispatcher';
import { faultsTick } from '../src/sim/faults';
import { updateHalts, rootCause } from '../src/sim/halt';
import { platformBerth, tripTasks, addTurnback, blockTasks, depotTasks, turnbackAt, validatePlan } from '../src/sim/timetable';
import { predictedLateness, RELIEF_DELAY } from '../src/sim/standby';
import { OPERATIONS } from '../src/data/current';
import { arbitrateResources } from '../src/sim/resourceArbitration';
import { DOOR_CLOSE_S, PLANNED_CLOSE_BUDGET } from '../src/sim/calibration';
import { doorMotionTick } from '../src/sim/psd';
import { makeSim } from './helpers';
import { reversedBerthPoint, safeWaitingPoint } from '../src/sim/topology';

const make = () => new Sim({ dayType: 'weekday', dateLabel: 'core', startTime: 14400, seed: 7, noPossessions: true });
const advance = (sim: Sim, seconds: number) => { const end = sim.t + seconds; while (sim.t < end - 1e-6) sim.step(); };
/** The UP-direction home signal at the east end of 淞虹路 UP platform (the long UP approach from the east). */
const upHomeEastOfStation4 = (sim: Sim) => sim.topo.signals.filter(s => s.station === 4 && s.role === 'home' && s.dir === -1 && sim.topo.links[s.link].track === 'UP').sort((a, b) => b.chain - a.chain)[0];
/** The signal that starts a train's route into the BZL depot: the UP-platform departure signal at the
 * depot's station (the two depot leads lie west of 淞虹路 between the mains), and the UP link the train
 * waits on in front of it (it governs the next link; the train runs west, dir -1, from the link's a end). */
const depotApproach = (sim: Sim, depot = 0) => {
  const topo = sim.topo;
  const signal = topo.signals.find(s => s.station === topo.depots[depot].station && s.role === 'start' && s.dir === -1 && topo.links[s.link].track === 'UP')!;
  const link = topo.links.find(l => l.a === signal.node && l.track === 'UP')!;
  return { signal, link };
};

describe('ATO interval departure metering', () => {
  const fixture = (dir: 'DN' | 'UP' = 'DN') => {
    const sim = make(); advance(sim, 1);
    const [rear, front] = sim.trainList;
    for (const tr of [...sim.trainList]) if (tr !== rear && tr !== front) sim.removeTrain(tr);
    const station = sim.topo.stations.find(s => s.id === (dir === 'DN' ? 'NJD' : 'LJZ'))!.index;
    const next = station + (dir === 'DN' ? 1 : -1);
    const berth = sim.topo.berths[platformBerth(sim.topo, station, dir)];
    const stop = { k: 'stop' as const, berth: berth.id, station, trip: -1, arr: sim.t - 40, dep: sim.t, doors: true, revenue: true };
    Object.assign(rear, { link: berth.link, off: berth.offset, dir: berth.dir, phase: 'dwell', mode: 'DTO', manual: false,
      rescuing: -1, coupledLen: 0, failed: false, hold: false, v: 0, doorsOpen: true, doorSide: '', doorsAwait: false, dwellUntil: sim.t });
    rear.tasks = [stop, { ...stop, berth: platformBerth(sim.topo, next, dir), station: next, dep: null }];
    const lo = Math.min(sim.topo.stations[station].chain, sim.topo.stations[next].chain) + 400;
    const link = sim.topo.links.find(l => l.track === dir && Math.min(l.chainA, l.chainB) <= lo && Math.max(l.chainA, l.chainB) >= lo)!;
    const off = (lo - link.chainA) / (link.chainB - link.chainA) * link.len;
    front.body = [{ link: link.id, from: off, to: Math.min(link.len, off + 10) }];
    front.pendingDeparture = undefined;
    return { sim, rear, front, stop, next, dir, link, off };
  };
  it.each(['DN', 'UP'] as const)('%s: keeps the doors open until the entire preceding train clears, then departs', dir => {
    const { sim, rear, front, next, link, off } = fixture(dir);
    const plan = JSON.stringify([sim.plan.trips, sim.plan.blocks]);
    updateTrainTasks(sim, rear);
    expect(rear.phase).toBe('dwell'); expect(rear.doorsOpen).toBe(true);
    updateHalts(sim); expect(rear.halt.code).toBe('INTERVAL_LIMIT');
    sim.t += 21; updateHalts(sim);
    expect(sim.events.some(e => e.code === 'INTERVAL_LIMIT')).toBe(true);
    const p = sim.topo.links[sim.topo.berths[platformBerth(sim.topo, next, dir)].link];
    // The head has arrived but the rear still occupies the interstation track.
    front.body = [{ link: p.id, from: 0, to: 100 }, { link: link.id, from: off, to: off + 1 }];
    updateTrainTasks(sim, rear); expect(rear.phase).toBe('dwell');
    front.body = [{ link: p.id, from: 0, to: p.len }];
    updateTrainTasks(sim, rear); expect(rear.doorsOpen).toBe(true); expect(rear.doorMotion?.kind).toBe('closing');
    sim.t = rear.dwellUntil + 1; doorMotionTick(sim); updateTrainTasks(sim, rear);
    expect(rear.phase).toBe('run'); expect(rear.intervalWait).toBeUndefined();
    expect(JSON.stringify([sim.plan.trips, sim.plan.blocks])).toBe(plan);
  });
  it('keeps CM/RM subject to metering and allows an explicit dispatcher release or rescue', () => {
    const { sim, rear, stop } = fixture();
    expect(intervalDepartureHold(sim, rear, stop)).toBeDefined();
    for (const mode of ['CM', 'RM'] as const) {
      rear.mode = mode; rear.manual = true;
      expect(intervalDepartureHold(sim, rear, stop)).toBeDefined();
      rear.doorsOpen=false;rear.doorLockedAt=sim.t-1;rear.dwellUntil=sim.t+300;
      updateTrainTasks(sim,rear);expect(rear.phase).toBe('dwell');expect(rear.intervalWait).toBeDefined();
    }
    rear.manual=false;rear.dwellUntil=sim.t;rear.mode = 'DTO'; rear.rescuing = 99; expect(intervalDepartureHold(sim, rear, stop)).toBeUndefined();
    rear.rescuing = -1;
    expect(sim.command({ c: 'trainHold', train: rear.id, on: false }).ok).toBe(true);
    expect(intervalDepartureHold(sim, rear, stop)).toBeUndefined();
    rear.doorsOpen = false; updateTrainTasks(sim, rear);
    expect(rear.intervalRelease).toBeUndefined();
  });
  it('counts a departure granted this tick, while the opposite running line remains independent', () => {
    const { sim, rear, front, stop, link } = fixture();
    sim.plat[sim.topo.stations[stop.station+1].platforms.DN].hold=true;
    front.body = []; front.pendingDeparture = stop;
    front.link = rear.link; front.dir = rear.dir;
    expect(intervalDepartureHold(sim, rear, stop)).toBeDefined();
    front.pendingDeparture = undefined;
    front.phase='run';front.lastStation=stop.station;front.tasks=[rear.tasks[1]];
    expect(intervalDepartureHold(sim,rear,stop)).toBeDefined(); // wheels moved, head still within the platform approach
    front.lastStation=-1;
    const other = sim.topo.links.find(l => l.track === 'UP' && l.chainA <= link.chainB && l.chainB >= link.chainA)!;
    front.body = [{ link: other.id, from: 0, to: other.len }];
    expect(intervalDepartureHold(sim, rear, stop)).toBeUndefined();
  });
  it('leaves normal moving traffic unrestricted and enables metering for a held downstream platform',()=>{
    const {sim,rear,front,stop,next}=fixture();
    front.phase='run';front.v=10;
    expect(intervalDepartureHold(sim,rear,stop)).toBeUndefined();
    sim.plat[sim.topo.stations[next].platforms.DN].hold=true;
    expect(intervalDepartureHold(sim,rear,stop)).toBeDefined();
    sim.plat[sim.topo.stations[next].platforms.DN].hold=false;
    sim.plat[sim.topo.stations[next].platforms.UP].hold=true;
    expect(intervalDepartureHold(sim,rear,stop)).toBeUndefined();
  });
  it('does not mistake an overnight siding train waiting to start for a granted departure',()=>{
    const {sim,rear,front,stop}=fixture();
    const siding=sim.topo.links.find(l=>l.track==='SID')!;
    Object.assign(front,{link:siding.id,off:0,phase:'run',v:0,lastStation:stop.station,dir:rear.dir});
    front.tasks=[{...rear.tasks[1] as any,stabledOut:true}];
    front.body=[{link:siding.id,from:0,to:Math.min(siding.len,front.len)}];
    expect(intervalDepartureHold(sim,rear,stop)).toBeUndefined();
    // A returning train which has changed ends behind this platform is
    // also not ahead, even though lastStation still names this station.
    const origin=sim.topo.links[rear.link];
    const approach=sim.topo.links.filter(l=>l.track==='DN'&&l.chainB<=origin.chainA).sort((a,b)=>b.chainB-a.chainB)[0];
    Object.assign(front,{link:approach.id,off:approach.len-1});
    front.tasks=[{...rear.tasks[1] as any,stabledOut:false}];
    front.body=[{link:approach.id,from:0,to:approach.len}];
    expect(intervalDepartureHold(sim,rear,stop)).toBeUndefined();
  });
  it('keeps an unrouted middle-platform departure from reserving the interval against the main-platform train it must follow',()=>{
    const {sim,rear:main,front:middle}=fixture('UP');
    const station=sim.topo.stations.find(s=>s.id==='GLL')!.index;
    const next=platformBerth(sim.topo,station-1,'UP'),mainBerth=sim.topo.berths[platformBerth(sim.topo,station,'UP')];
    const middleBerth=sim.topo.berths.find(b=>b.station===station&&b.kind==='platform'&&sim.topo.links[b.link].track==='SID'&&b.dir===-1)!;
    const setup=(tr:Train,berth:typeof mainBerth)=>{
      Object.assign(tr,{link:berth.link,off:berth.offset,dir:berth.dir,phase:'dwell',v:0,mode:'DTO',manual:false,failed:false,
        doorsOpen:false,doorSide:'',doorsAwait:false,hold:false,dwellUntil:sim.t,lastStation:station,pendingDeparture:undefined});
      const stop={k:'stop' as const,station,berth:berth.id,trip:-1,arr:sim.t-40,dep:sim.t,doors:true,revenue:true};
      tr.tasks=[stop,{...stop,station:station-1,berth:next,dep:null}];
      computeBody(sim,tr);return stop;
    };
    const onMain=setup(main,mainBerth),onMiddle=setup(middle,middleBerth);
    middle.nextSignal=sim.topo.signals.find(s=>s.dir===middle.dir&&sim.topo.nodes[s.node].links.includes(middle.link))!.id;
    for(const rid of [...sim.routes.keys()])releaseRoute(sim,rid);
    sim.plat[sim.topo.stations[station-1].platforms.UP].hold=true;
    expect(intervalDepartureHold(sim,middle,onMiddle)?.detail).toContain('汇入正线');
    updateTrainTasks(sim,middle);expect(middle.phase).toBe('dwell');
    expect(intervalDepartureHold(sim,main,onMain)).toBeUndefined();
    updateTrainTasks(sim,main);expect(main.phase).toBe('run');
  });
});

describe('depot berth selection before the first entry route',()=>{
  const arbitratedDesire=(sim:Sim,tr:Train)=>{arbitrateResources(sim);return trainDesire(sim,tr);};
  const fixture=(remote=false)=>{
    const sim=make();advance(sim,1);
    const [rear,turning,other]=sim.trainList;
    for(const tr of [...sim.trainList])if(![rear,turning,other].includes(tr))sim.removeTrain(tr);
    for(const rid of [...sim.routes.keys()])releaseRoute(sim,rid);
    sim.berthRes.clear();sim.resourceTransit.clear();for(const block of sim.plan.blocks)sim.blockDone.add(block.id);sim.t=7.95*3600;
    const yard=sim.topo.depots[0],station=remote?6:yard.station,berth=sim.topo.berths[platformBerth(sim.topo,station,'UP')];
    Object.assign(rear,{link:berth.link,off:100,dir:berth.dir,hist:[{link:berth.link,dir:berth.dir}],v:0,phase:'run',block:-1,tripId:-1,manual:false,failed:false,hold:false,dwellUntil:sim.t+5,stopDist:0});
    computeBody(sim,rear);
    rear.tasks=[{k:'depot',depot:0,berth:yard.entryBerths[0]}];
    const sig=sim.topo.signals.find(s=>s.station===station&&s.role==='start'&&s.dir===-1)!;
    rear.nextSignal=sig.id;rear.nextSignalDist=100;
    for(const [n,tr] of [turning,other].entries()){
      const stub=yard.transferPaths[n].stub,b=sim.topo.berths.find(b=>b.link===stub&&b.kind==='siding')!;
      Object.assign(tr,{link:stub,off:b.offset,dir:b.dir,phase:'stabled',v:0});
      tr.body=[{link:stub,from:Math.max(0,b.offset-10),to:Math.min(sim.topo.links[stub].len,b.offset+10)}];
      sim.berthRes.set(b.id,tr.id);
    }
    indexBodies(sim);computeOccupancy(sim);
    const branch=sim.topo.routes[sim.routeTable.next.get(yard.entryBerths[0])![sig.id]];
    return {sim,rear,turning,other,yard,branch};
  };
  it('leaves the remote main line unrestricted, then waits at the depot throat and chooses the empty lead',()=>{
    const remote=fixture(true);
    expect(Math.abs(remote.sim.trainChain(remote.rear)-remote.sim.topo.stations[remote.yard.station].chain)).toBeGreaterThan(2500);
    expect(arbitratedDesire(remote.sim,remote.rear)?.ready).toBe(true);
    expect([...remote.sim.berthRes.values()]).not.toContain(remote.rear.id);
    const {sim,rear,turning,other,yard,branch}=fixture();
    expect(arbitratedDesire(sim,rear)?.ready).toBe(false);
    expect(sim.sig[branch.start].route).toBe(-1);
    expect(rear.arsWait?.detail).toContain('实占');
    expect(rear.arsWait?.train).toBe(turning.id);
    sim.removeTrain(other);indexBodies(sim);computeOccupancy(sim);
    expect(arbitratedDesire(sim,rear)).not.toBeNull();
    expect(rear.tasks.at(-1)).toMatchObject({k:'depot',berth:yard.entryBerths[1]});
    expect(sim.berthRes.get(yard.entryBerths[1])).toBe(rear.id); // admission commits the chosen lead at the throat
  });
  it.each([false,true])('cancels an idle old branch before switching, but never switches an entered branch (entered=%s)',entered=>{
    const {sim,rear,turning,other,yard,branch}=fixture();sim.removeTrain(other);
    // Block the complete movement downstream of the old entry route. An
    // occupant of that route itself would legitimately prevent cancellation.
    const path=yard.transferPaths[0];
    Object.assign(turning,{link:path.links[1],off:5,dir:-1,hist:[{link:path.links[2],dir:-1},{link:path.links[1],dir:-1}]});
    computeBody(sim,turning);indexBodies(sim);computeOccupancy(sim);
    expect(trySetRoute(sim,branch.id,{train:rear.id}).ok).toBe(true);
    const ar=sim.routes.get(branch.id)!;ar.entered=entered;if(entered)ar.owner=rear.id;
    arbitratedDesire(sim,rear);
    expect(rear.tasks.at(-1)).toMatchObject({berth:yard.entryBerths[entered?0:1]});
    expect(sim.routes.has(branch.id)).toBe(entered);
  });
  it('keeps the selected berth while the original branch is approach locked',()=>{
    const {sim,rear,turning,other,yard,branch}=fixture();sim.removeTrain(other);turning.body=[];
    indexBodies(sim);computeOccupancy(sim);
    expect(trySetRoute(sim,branch.id,{train:rear.id}).ok).toBe(true);
    rear.nextSignal=branch.start;rear.nextSignalDist=100;rear.v=5;
    arbitratedDesire(sim,rear);
    expect(rear.tasks.at(-1)).toMatchObject({berth:yard.entryBerths[0]});
    expect(sim.routes.has(branch.id)).toBe(true);
  });
  it('protects the occupied reversal platform ahead of an unused opposite-platform depot booking',()=>{
    const sim=make();advance(sim,1);const [waiting,booked]=sim.trainList;
    for(const tr of [...sim.trainList])if(tr!==waiting&&tr!==booked)sim.removeTrain(tr);
    for(const rid of [...sim.routes.keys()])releaseRoute(sim,rid);
    sim.berthRes.clear();sim.resourceTransit.clear();for(const block of sim.plan.blocks)sim.blockDone.add(block.id);const yard=sim.topo.depots[2],goal=yard.entryBerths[0];
    for(const [tr,dir]of [[waiting,'UP'],[booked,'DN']]as const){
      const b=sim.topo.berths[platformBerth(sim.topo,yard.station,dir)];
      Object.assign(tr,{link:b.link,off:b.offset,dir:b.dir,phase:'run',v:0,block:-1,tripId:-1,failed:false,manual:false,
        tbStage:'depart',depotStage:'none',hold:false,lastStation:yard.station});
      tr.tasks=[];depotTasks(sim.topo,yard.id,dir,tr.tasks);
      if(tr.tasks[0]?.k==='stop'){tr.phase='dwell';tr.dwellUntil=sim.t;}
      tr.hist=[];computeBody(sim,tr);
      const scan=scanAhead(sim,tr,goal);tr.nextSignal=scan.nextSignal;tr.nextSignalDist=scan.nextSignalDist;
    }
    const stub=sim.topo.berths.find(b=>b.link===yard.transferPaths[0].stub&&b.kind==='siding')!;
    sim.berthRes.set(stub.id,booked.id);indexBodies(sim);computeOccupancy(sim);
    const allocation=arbitrateResources(sim);runARS(sim,true);
    expect(allocation.decisions.get(waiting.id)).toMatchObject({admitted:true});
    expect(allocation.decisions.get(booked.id)).toMatchObject({admitted:false,blocker:waiting.id});
    expect(waiting.arsWait?.detail).not.toBe('进路资源预留给优先列车');
    expect(sim.sig[booked.nextSignal].route).toBe(-1);
  });
  it('does not let a following return book the empty lead against the train physically ahead',()=>{
    const sim=make();advance(sim,1);const [front,rear]=sim.trainList;
    for(const tr of [...sim.trainList])if(tr!==front&&tr!==rear)sim.removeTrain(tr);
    for(const rid of [...sim.routes.keys()])releaseRoute(sim,rid);
    sim.berthRes.clear();sim.resourceTransit.clear();for(const block of sim.plan.blocks)sim.blockDone.add(block.id);const yard=sim.topo.depots[1],goal=yard.entryBerths[0];
    const b=sim.topo.berths[platformBerth(sim.topo,yard.station,'DN')],platform=sim.topo.links[b.link];
    const approach=sim.topo.links.filter(l=>l.track==='DN'&&l.chainB<=platform.chainA).sort((a,b)=>b.chainB-a.chainB)[0];
    for(const tr of [front,rear]){
      Object.assign(tr,{link:tr===front?b.link:approach.id,off:tr===front?b.offset:approach.len-10,dir:1,
        phase:'run',v:0,block:-1,tripId:-1,failed:false,manual:false,hold:false,tbStage:'none',depotStage:'none'});
      tr.tasks=[{k:'depot',depot:yard.id,berth:goal}];tr.hist=[];computeBody(sim,tr);
      const scan=scanAhead(sim,tr,goal);tr.nextSignal=scan.nextSignal;tr.nextSignalDist=scan.nextSignalDist;
    }
    const stub=sim.topo.berths.find(b=>b.link===yard.transferPaths[0].stub&&b.kind==='siding')!;
    sim.berthRes.set(stub.id,rear.id);indexBodies(sim);computeOccupancy(sim);
    expect(arbitratedDesire(sim,front)).not.toBeNull();expect(sim.berthRes.get(goal)).toBe(front.id);
    sim.berthRes.set(stub.id,rear.id);rear.body=[{link:stub.link,from:0,to:10}];indexBodies(sim);computeOccupancy(sim);
    expect(arbitratedDesire(sim,front)?.ready).toBe(false); // an actual occupied lead remains protected
  });
});

describe('dispatcher boundary', () => {
  it('rejects invalid objects and non-finite values without partial writes', () => {
    const sim = make();
    const before = sim.zoneState.slice();
    expect(sim.command({ c: 'zoneLevel', zones: [0, 999], level: 'TBTC' }).ok).toBe(false);
    expect(sim.zoneState).toEqual(before);
    expect(sim.command({ c: 'setTsr', sections: [0, 9999], kmh: 25 }).ok).toBe(false);
    expect(sim.sec[0].tsr).toBe(0);
    expect(sim.command({ c: 'setTsr', sections: [0], kmh: NaN }).ok).toBe(false);
    expect(sim.command({ c: 'fault', kind: 'signal', target: -1, duration: 30 }).ok).toBe(false);
    expect(sim.faults).toHaveLength(0);
    expect(() => sim.command({ c: 'setRoute' } as Command)).not.toThrow();
    expect(sim.command({ c: 'sectionBlock', on: false } as Command).ok).toBe(false);
  });
  it('accepts only a positive, bounded passenger surge and keeps passenger counts non-negative', () => {
    const sim = make();
    for (const param of [-3, 0, 0.5, 21]) expect(sim.command({ c: 'fault', kind: 'surge', target: 5, duration: 60, param }).ok).toBe(false);
    expect(sim.faults).toHaveLength(0);
    expect(sim.command({ c: 'fault', kind: 'surge', target: 5, duration: 60, param: 4 }).ok).toBe(true);
    expect(sim.plat[sim.topo.stations[5].platforms.DN].surge).toBe(4);
    sim.plat[0].waiting = -1;
    checkSafety(sim);
    expect(sim.integrity.violations.some(v => v.kind === 'NEGATIVE_COUNT')).toBe(true);
  });
  it('treats any station headway under the 90 s design headway as a plan error', () => {
    const sim = make();
    const plan = structuredClone(sim.plan);
    const t = plan.trips.find(x => x.revenue && x.dir === 'DN' && x.stops.length > 10 && x.stops[0].dep > 8 * 3600)!;
    const twin = { ...structuredClone(t), id: plan.trips.length, no: 'T999' };
    for (const s of twin.stops) { s.arr += 75; s.dep += 75; }
    plan.trips.push(twin);
    plan.blocks[t.block].trips = [...plan.blocks[t.block].trips];
    const issues = validatePlan(sim.planCtx, plan).filter(i => i.code === 'HEADWAY');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every(i => i.severity === 'error')).toBe(true);
  });
  it('validates a complete zone restoration before changing any zone', () => {
    const sim = make();
    sim.command({ c: 'zoneLevel', zones: [0], level: 'TBTC' });
    sim.command({ c: 'fault', kind: 'zcFail', target: 1, duration: 60 });
    expect(sim.command({ c: 'zoneLevel', zones: [0, 1], level: 'CBTC' }).ok).toBe(false);
    expect(sim.zoneState[0]).toBe('TBTC');
  });
});

describe('movement and radio regressions', () => {
  it('admits a front turn to its safe platform and holds its ordinary departure behind the same exit occupant', () => {
    const sim = make(); advance(sim,2); const [tr,other] = sim.trainList;
    for (const train of [...sim.trainList]) if (train !== tr && train !== other) sim.removeTrain(train);
    for (const id of [...sim.routes.keys()]) releaseRoute(sim,id);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    sim.t=20*3600;
    const tb = turnbackAt(sim.topo,6,'UP')!; expect(tb.kind).toBe('front');
    if (tb.kind !== 'front') throw new Error('expected 威宁路 front turn');
    const signal = sim.topo.signals.find(s => s.name === 'S0902')!;
    const entry = sim.topo.links.find(l => l.a === signal.node && l.track === 'UP')!;
    tr.link=entry.id;tr.off=6.4;tr.dir=-1;tr.hist=[{link:entry.id,dir:-1}];
    tr.phase='run';tr.v=0;tr.eb=false;tr.block=-1;tr.tripId=-1;tr.inService=false;tr.depotStage='none';
    tr.load=1000;
    sim.plat[sim.topo.berths[tb.depBerth].platform].waiting=1000;
    tr.tasks=[{k:'stop',berth:tb.arrBerth,station:6,trip:-1,arr:null,dep:null,doors:true,revenue:true},
      {k:'reverse',berths:[tb.arrBerth],chosen:tb.arrBerth,station:6,minTime:40},
      {k:'stop',berth:tb.depBerth,station:6,trip:-1,arr:null,dep:sim.t+180,doors:true,revenue:true},
      {k:'stop',berth:platformBerth(sim.topo,7,'DN'),station:7,trip:-1,arr:null,dep:null,doors:false,revenue:false}];
    tr.nextSignal=signal.id;tr.nextSignalDist=6.4;tr.stopDist=Infinity;
    tr.maDist=tr.maFar=0;tr.maSigs=[];tr.lastDs=0;tr.lastMa=Infinity;
    const link = sim.topo.links.filter(l=>l.track==='DN'&&l.normalDir===1&&l.chainA>sim.topo.stations[6].chain
      &&sim.topo.sections[l.section].kind==='plain'&&l.len>=tr.len+6).sort((a,b)=>a.chainA-b.chainA)[0];
    const downstream=sim.topo.routes.find(r=>r.steps.some(step=>step.link===link.id&&step.dir===1))!;
    expect(trySetRoute(sim,downstream.id,{fleeting:true}).ok).toBe(true);
    other.link=link.id;other.off=tr.len;other.dir=1;other.hist=[{link:link.id,dir:1}];
    other.phase='failed';other.failed=true;other.v=0;other.tasks=[];other.block=-1;other.tripId=-1;
    computeBody(sim,tr);computeBody(sim,other);indexBodies(sim);computeOccupancy(sim);
    expect(other.body.every(body => sim.topo.links[body.link].platform !== sim.topo.berths[tb.arrBerth].platform)).toBe(true);
    arbitrateResources(sim);
    expect(trainDesire(sim,tr)?.ready).toBe(true); // S0902 is ordinary main line before admission.
    const home=sim.topo.signals.find(s=>s.name==='S0716')!;
    const approach=sim.topo.links.find(l=>l.a===home.node&&l.track==='UP')!;
    Object.assign(tr,{link:approach.id,off:6.4,hist:[{link:approach.id,dir:-1}],nextSignal:home.id,nextSignalDist:6.4});
    computeBody(sim,tr);indexBodies(sim);computeOccupancy(sim);
    const allocation=arbitrateResources(sim),decision=allocation.decisions.get(tr.id);
    // User C: the arrival ends at this whole cab-change platform. The
    // existing ordinary-exit occupant must block the later departure only.
    expect(decision).toMatchObject({admitted:true,blocker:-1});
    expect(decision!.option.phases).toHaveLength(1);
    expect(decision!.option.phases[0].goal).toBe(tb.arrBerth);
    expect(decision!.request.origin).toBeUndefined();
    expect(trainDesire(sim,tr)?.ready).toBe(true);
    runARS(sim,true);
    const first = sim.routeTable.next.get(tb.arrBerth)![home.id];
    expect(sim.sig[home.id].route).toBe(first);
    let arrival = 0, departure = 0, exitBlocked = false;
    const end = sim.t+600;
    while (sim.t < end && !exitBlocked) {
      sim.step();
      const current = sim.trains.get(tr.id)!;
      if (!arrival && current.phase==='dwell' && current.dir===-1 && current.lastStation===6) {
        arrival=sim.t;
        tr.tasks=tr.tasks.map(task => task.k==='stop' && task.berth===tb.depBerth ? {...task,dep:arrival+120} : task);
      }
      if (!arrival || current.phase!=='dwell' || current.dir!==1 || sim.t<arsReadyAt(current)) continue;
      const exit=arbitrateResources(sim).decisions.get(tr.id)!;
      expect(exit).toMatchObject({admitted:false,blocker:other.id});
      const next=current.tasks[1];expect(next.k).toBe('stop');if(next.k!=='stop')throw new Error('expected ordinary exit');
      expect(current.body.every(part=>sim.topo.links[part.link].platform===sim.topo.berths[tb.arrBerth].platform)).toBe(true);
      expect(safeWaitingPoint(sim.topo,{link:current.link,off:current.off,dir:current.dir,incoming:current.hist},current.len,
        {afterTurn:true,destination:next.berth,path:exit.option.phases.flatMap(phase=>phase.path)})).toBe(true);
      expect(trainDesire(sim,current)?.ready).toBe(false);
      runARS(sim,true);
      expect(current.arsWait?.train).toBe(other.id);
      expect(current.v).toBe(0);
      exitBlocked=true;
    }
    expect(exitBlocked).toBe(true);
    sim.removeTrain(other);indexBodies(sim);computeOccupancy(sim);
    while (sim.t < end && !departure) {
      sim.step();
      const current = sim.trains.get(tr.id)!;
      if (!arrival && current.phase==='dwell' && current.dir===-1 && current.lastStation===6) {
        arrival=sim.t;
        tr.tasks=tr.tasks.map(task => task.k==='stop' && task.berth===tb.depBerth ? {...task,dep:arrival+120} : task);
      }
      if (arrival && current.dir===1 && tr.v>0.05 && tr.tasks[0]?.k==='stop' && tr.tasks[0].station===7) departure=sim.t;
    }
    expect(arrival).toBeGreaterThan(0);expect(departure-arrival).toBeGreaterThanOrEqual(120 - PLANNED_CLOSE_BUDGET + DOOR_CLOSE_S + OPERATIONS.autoStartDelay[0] - .2);
    expect(departure-arrival).toBeLessThan(120 - PLANNED_CLOSE_BUDGET + DOOR_CLOSE_S + OPERATIONS.autoStartDelay[1] + .5);
    expect(sim.passengersServed).toBeGreaterThanOrEqual(1000);
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it.each(['CBTC', 'TBTC'] as const)('revalidates the sighting scan immediately when RM ends into %s', level => {
    const sim = make(); advance(sim,2); const tr = sim.trainList[0];
    for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
    for (const id of [...sim.routes.keys()]) releaseRoute(sim,id);
    const { link: entry } = depotApproach(sim);
    tr.link = entry.id; tr.off = 50; tr.dir = -1; tr.hist = [{link:entry.id,dir:-1}];
    tr.tasks = [{k:'depot',depot:0}]; tr.phase = 'run'; tr.v = 0; tr.eb = false;
    tr.depotStage = 'none'; tr.manual = false; tr.tbStage = 'none';
    tr.lastDs = 0; tr.lastMa = Infinity; tr.maSigs = []; tr.maDist = tr.maFar = 0;
    computeBody(sim,tr); indexBodies(sim); checkSafety(sim);
    expect(grantRM(sim,tr,0,-1,'test exhausted RM')).toBe(true);
    tr.maDist = tr.maFar = 9000; tr.maReason = tr.maFarReason = '前车';
    tr.v = 1; tr.forceLevel = level; tr.rmAuth = 0;
    updateOnboard(sim);
    expect(tr.mode).toBe(level==='CBTC'?'DTO':'AM'); expect(tr.level).toBe(level);
    expect(tr.maDist).toBeLessThanOrEqual(44); expect(tr.maFar).toBeLessThanOrEqual(44);
    expect(tr.maSigs).toHaveLength(0);
    checkSafety(sim); expect(sim.integrity.violations).toHaveLength(0);
  });
  it('follows occupancy behind a red signal even when the desired route is already set', () => {
    const sim = make(); advance(sim,2); const [tr,other] = sim.trainList;
    for (const id of [...sim.routes.keys()]) releaseRoute(sim,id);
    const { signal, link: entry } = depotApproach(sim);
    const rid = sim.routeTable.next.get(sim.topo.depots[0].berth)![signal.id], route = sim.topo.routes[rid];
    expect(trySetRoute(sim,rid,{train:tr.id}).ok).toBe(true);
    const ar = sim.routes.get(rid)!; ar.state = 'locked';
    tr.link = entry.id; tr.off = 6.1; tr.dir = -1; tr.hist = [{link:entry.id,dir:-1}];
    tr.tasks = [{k:'depot',depot:0}]; tr.phase = 'run'; tr.v = 0; tr.eb = false;
    tr.nextSignal = signal.id; tr.nextSignalDist = 6.1; tr.stopDist = Infinity;
    tr.maDist = 0; tr.maCode = 'ROUTE_WAIT'; tr.maTrain = -1; tr.arsWait = null;
    // The failed train stands where both leads' routes still share track: on the lead's own stub the ATS
    // would simply send the depot train in by the other lead.
    const at = route.steps.length >> 1, last = route.steps[at]; other.link = last.link; other.off = sim.topo.links[last.link].len-6;
    other.dir = last.dir; other.hist = route.steps.slice(0,at+1).map(step => ({...step})); other.failed = true; other.phase = 'failed'; other.v = 0;
    computeBody(sim,tr); computeBody(sim,other); indexBodies(sim); computeOccupancy(sim); sim.sig[signal.id].aspect = 'R';
    runARS(sim); updateHalts(sim);
    expect(tr.arsWait).toMatchObject({code:'TRAIN_AHEAD',train:other.id,t:sim.t});
    expect(rootCause(sim,tr).code).toBe('FAILED');
    expect(sim.sig[signal.id].route).toBe(rid);
  });
  it('retains the live blocker while cancellation of an occupied route is refused', () => {
    const sim = make(); advance(sim,2); const [tr,other] = sim.trainList;
    for (const id of [...sim.routes.keys()]) releaseRoute(sim,id);
    const { signal, link } = depotApproach(sim);
    const wanted = sim.routeTable.next.get(sim.topo.depots[0].berth)![signal.id];
    const actual = signal.routes.find(id => id !== wanted && sim.topo.routes[id].fleeting)!;
    expect(trySetRoute(sim,actual,{train:other.id}).ok).toBe(true);
    const ar = sim.routes.get(actual)!; ar.entered = true; ar.owner = other.id;
    sim.sec[sim.topo.routes[actual].sections[0]].trainOcc = true;
    tr.link = link.id; tr.off = 6.1; tr.dir = -1; tr.hist = [{link:link.id,dir:-1}];
    tr.tasks = [{k:'depot',depot:0}]; tr.phase = 'run'; tr.v = 0; tr.eb = false;
    tr.nextSignal = signal.id; tr.nextSignalDist = 6.1; tr.stopDist = Infinity;
    tr.maDist = 0; tr.maCode = 'ROUTE_WAIT'; tr.maTrain = -1; tr.arsWait = null;
    other.failed = true; other.phase = 'failed'; other.v = 0;
    runARS(sim); updateHalts(sim);
    expect(tr.arsWait).toMatchObject({code:'ROUTE_CONFLICT',train:other.id,t:sim.t});
    expect(rootCause(sim,tr).code).toBe('FAILED');
    expect(sim.sig[signal.id].route).toBe(actual);
  });
  it('brakes within the issued MA when an ESP creates an unreachable shorter target', () => {
    const sim = make();
    let tr: Sim['trainList'][number] | undefined;
    while (!tr && sim.t < 20400) { // overnight trains leave their stabling ~05:20 (D72)
      sim.step();
      tr = sim.trainList.find(t => t.v > 5 && t.body.some(b => sim.topo.links[b.link].platform >= 0));
    }
    expect(tr).toBeDefined();
    const train = tr!;
    const p = sim.topo.links[train.body.find(b => sim.topo.links[b.link].platform >= 0)!.link].platform;
    sim.command({ c: 'platformEsp', platform: p, on: true });
    sim.step();
    expect(train.eb).toBe(true);
    expect(train.maCut).toBe(true);
    expect(train.lastMa).toBeGreaterThan(train.lastDs);
    advance(sim, 15);
    expect(train.v).toBe(0);
    expect(train.maCut).toBe(false);
    expect(sim.integrity.violations.filter(v => v.kind === 'BEYOND_MA')).toHaveLength(0);
  });
  it('expires the retained ZC authority at standstill without reusing released routes', () => {
    const sim = make(); sim.autoRadio = false;
    let tr = sim.trainList.find(t => t.v > 5);
    while (!tr && sim.t < 20400) { sim.step(); tr = sim.trainList.find(t => t.v > 5); }
    expect(tr).toBeDefined(); const train = tr!;
    train.manual = true; train.mode = 'CM'; train.notch = 0;
    const protectedSignals = train.maSigs.slice();
    expect(sim.command({ c: 'fault', kind: 'zcFail', target: sim.topo.links[train.link].zone, duration: 120 }).ok).toBe(true);
    advance(sim, 20); expect(train.v).toBe(0); expect(train.eb).toBe(true);
    expect(train.maDist).toBe(0); expect(train.maFar).toBe(0); expect(train.maSigs).toHaveLength(0);
    for (const signal of protectedSignals) cancelRoute(sim, signal);
    advance(sim, 5); expect(sim.integrity.violations).toHaveLength(0);
  });
  it('never exempts an issued-MA overrun merely because EB and withdrawal are active', () => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    tr.phase = 'run'; tr.eb = true; tr.maCut = true; tr.lastMa = 10; tr.lastDs = 11;
    checkSafety(sim);
    expect(sim.integrity.violations.some(v => v.kind === 'BEYOND_MA')).toBe(true);
  });
  it('preserves an issued authority when occupancy prevents cancellation of a failed signal route', () => {
    const sim = make();
    let tr: Sim['trainList'][number] | undefined;
    let signal = -1;
    while (!tr && sim.t < 20400) { // overnight trains leave their stabling ~05:20 (D72)
      sim.step();
      for (const candidate of sim.trainList) for (const sig of candidate.maSigs) {
        const route = sim.sig[sig].route;
        if (candidate.v > 5 && route >= 0 && committedTrain(sim, sig) === candidate.id) { tr = candidate; signal = sig; break; }
      }
    }
    expect(tr).toBeDefined();
    const route = sim.sig[signal].route;
    // Isolate the occupied-route branch of the CI interface. Its occupancy
    // input may include a train further inside the same protected section.
    sim.sec[sim.topo.routes[route].sections[0]].trainOcc = true;
    expect(sim.command({ c: 'fault', kind: 'signal', target: signal, duration: 30 }).ok).toBe(true);
    expect(sim.routes.get(route)?.committed).toBe(tr!.id);
    advance(sim, 5);
    expect(tr!.passedRed).toBe(0);
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it('revalidates a stopped train authority on departure between ZC refreshes', () => {
    const sim = make(); advance(sim, 2);
    const tr = sim.trainList.find(t => t.tasks[0]?.k === 'stop')!;
    expect(tr).toBeDefined();
    tr.phase = 'dwell'; tr.v = 0; tr.doorsOpen = false; tr.dwellUntil = sim.t - 1;
    tr.maDist = tr.maFar = 99000;
    sim.step();
    expect(tr.phase).toBe('run');
    expect(tr.maDist).toBeLessThanOrEqual(25000);
    expect(sim.integrity.violations.filter(v => v.kind === 'MA_NO_ROUTE')).toHaveLength(0);
  });
  it('keeps the nearest train route when a farther route is still occupied by a preceding train', () => {
    const sim = make(); advance(sim, 2); const [front, rear, preceding] = sim.trainList;
    for (const other of [...sim.trainList]) if (![front,rear,preceding].includes(other)) sim.removeTrain(other);
    for (const rid of [...sim.routes.keys()]) releaseRoute(sim, rid);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    // the UP home signal east of 淞虹路 platform: the long UP approach, several routes before 虹桥2号航站楼
    const sig = upHomeEastOfStation4(sim);
    const link = sim.topo.links.find(l => l.a === sig.node && l.track === 'UP')!;
    const previous = sim.topo.links.find(l => l.a === link.b && l.track === 'UP')!;
    for (const [tr,l,off] of [[front,link,6.4],[rear,previous,58]] as const) {
      tr.link=l.id;tr.off=off;tr.dir=-1;tr.hist=[{link:l.id,dir:-1}];tr.v=0;tr.eb=false;tr.phase='run';tr.block=-1;tr.tripId=-1;tr.inService=false;tr.manual=false;tr.depotStage='none';
      tr.maDist=tr.maFar=0;tr.maSigs=[];tr.lastMa=Infinity;tr.lastDs=0;computeBody(sim,tr);
    }
    const goal=platformBerth(sim.topo,3,'UP');
    front.tasks=[{k:'stop',berth:goal,station:3,trip:-1,arr:null,dep:null,doors:false,revenue:false}];
    rear.tasks=[{k:'depot',depot:0}];
    front.nextSignal=rear.nextSignal=sig.id;front.nextSignalDist=6.4;rear.nextSignalDist=previous.len+58;front.stopDist=rear.stopDist=Infinity;
    const berth=sim.topo.berths[goal];preceding.link=berth.link;preceding.off=berth.offset;preceding.dir=berth.dir;preceding.hist=[{link:berth.link,dir:berth.dir}];
    preceding.v=0;preceding.eb=false;preceding.phase='dwell';preceding.dwellUntil=sim.t+9999;preceding.hold=true;preceding.tasks=[{k:'stop',berth:goal,station:3,trip:-1,arr:null,dep:null,doors:false,revenue:false}];preceding.block=-1;preceding.tripId=-1;preceding.inService=false;preceding.depotStage='none';
    preceding.maDist=preceding.maFar=0;preceding.maSigs=[];preceding.lastMa=Infinity;preceding.lastDs=0;computeBody(sim,preceding);indexBodies(sim);
    const table=sim.routeTable.next.get(goal)!;let next=sig.id;let first=-1;
    for(let i=0;i<10;i++){
      const rid=table[next];expect(rid).toBeGreaterThanOrEqual(0);if(i===0)first=rid;
      expect(trySetRoute(sim,rid,{train:front.id}).ok).toBe(true);
      if(sim.topo.routes[rid].berths.includes(goal)){const ar=sim.routes.get(rid)!;ar.entered=true;ar.owner=preceding.id;break;}
      next=sim.topo.routes[rid].end;
    }
    expect(trainDesire(sim,front)?.signal).toBe(sig.id);
    for(let i=0;i<10;i++){sim.t+=1;updateInterlocking(sim);runARS(sim);}
    expect(sim.sig[sig.id].route).toBe(first);expect(sim.routes.get(first)?.cancelAt).toBe(0);
    const position=sim.trainChain(front);advance(sim,60);
    expect(position-sim.trainChain(front)).toBeGreaterThan(50);
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it('gives the physical front train a shared route despite the rear train earlier plan', () => {
    const sim = make(); advance(sim, 2); const [front, rear] = sim.trainList;
    for (const other of [...sim.trainList]) if (other !== front && other !== rear) sim.removeTrain(other);
    for (const rid of [...sim.routes.keys()]) releaseRoute(sim, rid);
    // the UP platform departure signal at 淞虹路: its first route (towards 虹桥2号航站楼) crosses a point
    const sig = depotApproach(sim).signal;
    const link = sim.topo.links.find(l => l.a === sig.node && l.track === 'UP')!;
    const goal = platformBerth(sim.topo, 3, 'UP');
    for (const [tr, off, arr] of [[front,6.1,sim.t+100],[rear,Math.min(212.1,link.len-0.1),sim.t-100]] as const) {
      tr.link=link.id;tr.off=off;tr.dir=-1;tr.hist=[{link:link.id,dir:-1}];tr.v=0;tr.eb=false;tr.phase='run';
      tr.tasks=[{k:'stop',berth:goal,station:3,trip:-1,arr,dep:arr+40,doors:false,revenue:false}];
      tr.nextSignal=sig.id;tr.nextSignalDist=off;tr.stopDist=Infinity;computeBody(sim,tr);
    }
    indexBodies(sim);
    const route=sim.routeTable.next.get(goal)![sig.id];
    sim.sw[sim.topo.routes[route].switches[0].sw].failed=true;
    runARS(sim);
    expect(front.arsWait).toMatchObject({code:'SWITCH_FAULT',train:-1});
    expect(rear.arsWait).toMatchObject({code:'ROUTE_WAIT',train:front.id});
  });
  it('restores a repaired point in place while its route remains locked and occupied', () => {
    const sim = make(); advance(sim, 2);
    const sw = sim.sw.findIndex(s => s.lockCount > 0 && s.pos === s.target);
    expect(sw).toBeGreaterThanOrEqual(0);
    const section = sim.topo.switches[sw].sections[0];
    sim.sec[section].trainOcc = true;
    const pos = sim.sw[sw].pos;
    expect(sim.command({ c: 'fault', kind: 'switch', target: sw, duration: 1 }).ok).toBe(true);
    expect(sim.command({ c: 'switchMove', sw, pos }).ok).toBe(false);
    advance(sim, 2);
    sim.autoDispatch = true; sim.t = Math.ceil(sim.t / 5) * 5;
    faultsTick(sim);
    // Keep the occupied CI input in place while the dispatcher acts; a full
    // simulation step would overwrite this isolated field input.
    sim.sec[section].trainOcc = sim.sec[section].occ = true;
    dispatcherTick(sim);
    expect(sim.sec[section].trainOcc).toBe(true);
    expect(sim.sw[sw].failed).toBe(false);
    expect(sim.sw[sw].pos).toBe(pos);
    expect(sim.sw[sw].target).toBe(pos);
    expect(sim.sw[sw].lockCount).toBeGreaterThan(0);
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it('never lets auto-answer grant RM or consume a refused call', () => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    const call = openCall(sim, { kind: 'stuck', from: 'driver', train: tr.id, text: 'test',
      options: [{ key: 'rm', label: 'RM' }, { key: 'wait', label: 'wait' }], auto: 'wait', timeout: 120 })!;
    expect(answerCall(sim, call.id, 'rm', true).ok).toBe(false);
    expect(call.state).toBe('ringing');
    expect(tr.mode).not.toBe('RM');
    expect(answerCall(sim, call.id, 'rm').ok).toBe(false);
    expect(call.state).toBe('ringing');
  });
  it('refuses authority towards a preceding train even under a signal failure', () => {
    const sim = make(); advance(sim, 2); const [tr, ahead] = sim.trainList;
    // the other train sits just ahead of tr in tr's own running direction
    sim.linkBodies.set(tr.link, [tr.dir === 1 ? { train: ahead.id, from: tr.off + 1, to: tr.off + 20 } : { train: ahead.id, from: tr.off - 20, to: tr.off - 1 }]);
    expect(unsafeAhead(sim, tr)).toContain('列车');
    tr.v = 0; tr.maCode = 'SIGNAL_FAULT';
    expect(sim.command({ c: 'authRM', train: tr.id }).ok).toBe(false);
  });
  it.each([false, true])('an already-RM train reports and sweeps a preset block (coupled=%s)', coupled => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    const sig = sim.topo.signals.find(s => s.name === 'S0802')!;
    const link = sim.topo.links.find(l => l.a === sig.node && l.track === 'UP')!;
    const previous = sim.topo.links.find(l => l.a === link.b && l.track === 'UP')!;
    tr.link = link.id; tr.off = 6.4; tr.dir = -1;
    tr.hist = [{ link: previous.id, dir: -1 }, { link: link.id, dir: -1 }];
    tr.phase = 'run'; tr.v = 0; tr.block = -1; tr.tripId = -1; tr.inService = false;
    tr.len = coupled ? 373 : 186; tr.coupledLen = coupled ? 186 : 0;
    tr.tasks = [{ k: 'depot', depot: 0 }]; tr.eb = false;
    computeBody(sim, tr); indexBodies(sim);
    expect(grantRM(sim, tr, 0, -1, 'test rescue/guide continuation')).toBe(true);
    const rid = sim.sig[sig.id].route;
    expect(rid).toBeGreaterThanOrEqual(0);
    const section = sim.topo.routes[rid].sections.at(-1)!;
    expect(sim.command({ c: 'fault', kind: 'axle', target: section, duration: 1 }).ok).toBe(true);
    advance(sim, 2);
    expect(sim.command({ c: 'axleReset', section }).ok).toBe(true);
    sim.autoDispatch = true;
    const chain = sim.trainChain(tr);
    advance(sim, 400);
    const call = sim.calls.find(c => c.train === tr.id && c.kind === 'rmPreset');
    expect(call?.answer).toBe('approve');
    expect(Math.abs(sim.trainChain(tr) - chain)).toBeGreaterThan(500);
    expect(sim.sec[section].preset).toBe(false);
    expect(tr.passedRed).toBe(0);
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it('locks a guide path and sweeps a preset that prevented ARS from setting the route', () => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
    for (const rid of [...sim.routes.keys()]) releaseRoute(sim, rid);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    // an eastbound signal whose route runs into a turnback stub (上海科技馆)
    const kjg = sim.topo.stations.find(s => s.name === '上海科技馆')!;
    const intoStub = (id: number) => sim.topo.routes[id].berths.some(b => kjg.turnbackBerths.includes(b));
    const sig = sim.topo.signals.find(s => sim.topo.links[s.link].track === 'DN' && s.dir === 1 && s.routes.some(intoStub))!;
    const route = sim.topo.routes[sig.routes.find(intoStub)!];
    const berth = sim.topo.berths[route.berths.find(b => kjg.turnbackBerths.includes(b))!];
    const link = sim.topo.links.find(l => l.b === sig.node && l.track === 'DN')!;
    const previous = sim.topo.links.find(l => l.b === link.a && l.track === 'DN')!;
    tr.link = link.id; tr.off = link.len - 6.4; tr.dir = 1;
    tr.hist = [{ link: previous.id, dir: 1 }, { link: link.id, dir: 1 }];
    tr.phase = 'run'; tr.v = 0; tr.eb = false; tr.block = -1; tr.tripId = -1; tr.inService = false;
    tr.tasks = [{ k: 'reverse', berths: [berth.id], chosen: berth.id, station: berth.station, minTime: 40 },
      { k: 'stop', berth: platformBerth(sim.topo, berth.station, 'UP'), station: berth.station, trip: -1, arr: null, dep: null, doors: false, revenue: false, minDwell: 10 }, { k: 'depot', depot: 1 }];
    tr.maDist = tr.maFar = 0; tr.maSigs = []; tr.lastDs = 0; tr.lastMa = Infinity;
    computeBody(sim, tr); indexBodies(sim);
    expect(sim.command({ c: 'fault', kind: 'axle', target: route.sections[0], duration: 1 }).ok).toBe(true);
    advance(sim, 2);
    expect(sim.command({ c: 'axleReset', section: route.sections[0] }).ok).toBe(true);
    expect(sim.sig[sig.id].route).toBe(-1);
    sim.autoDispatch = true; advance(sim, 400);
    expect(sim.sec[route.sections[0]].preset).toBe(false);
    expect(sim.events.some(e => e.text.includes('引导') && e.text.includes(sig.name))).toBe(true);
    expect(tr.passedRed).toBe(0);
    expect(sim.integrity.violations).toHaveLength(0);
  });
});

describe('occupied-route rescue',()=>{
  it.each([
    ['S2402→S2322',false],['S2402→S2322',true],
    ['S0102→尽头(侧向)',false],['S0102→尽头(侧向)',true],
  ] as const)('admits only the assigned rescuer and retains locks through coupling (%s, preset=%s)',(name,preset)=>{
    const sim=make();advance(sim,2);const [rescuer,failed]=sim.trainList;
    for(const other of [...sim.trainList])if(other!==rescuer&&other!==failed)sim.removeTrain(other);
    for(const id of [...sim.routes.keys()])releaseRoute(sim,id);
    for(const block of sim.plan.blocks)sim.blockDone.add(block.id);
    rescuer.tasks=[];failed.tasks=[];rescuer.hold=failed.hold=true;
    const route=sim.topo.routes.find(r=>r.name===name)!;
    const signal=sim.topo.signals[route.start];
    expect(trySetRoute(sim,route.id,{train:failed.id}).ok).toBe(true);advance(sim,5);
    const entry=sim.topo.links.find(l=>l.a===signal.node&&l.track==='UP')!;
    rescuer.link=entry.id;rescuer.off=6.1;rescuer.dir=-1;rescuer.hist=[{link:entry.id,dir:-1}];
    let remaining=250,index=0;
    while(remaining>sim.topo.links[route.steps[index].link].len){remaining-=sim.topo.links[route.steps[index].link].len;index++;}
    const step=route.steps[index];failed.link=step.link;failed.dir=step.dir;
    failed.off=step.dir===1?remaining:sim.topo.links[step.link].len-remaining;
    failed.hist=route.steps.slice(0,index+1).map(s=>({...s}));
    for(const tr of [rescuer,failed]){
      tr.phase='run';tr.v=0;tr.eb=false;tr.manual=false;tr.block=-1;tr.tripId=-1;tr.hold=false;
      tr.tbStage='none';tr.depotStage='none';tr.maDist=tr.maFar=0;tr.lastMa=Infinity;tr.lastDs=0;tr.maSigs=[];
      computeBody(sim,tr);
    }
    const station=name.startsWith('S0102')?0:22;
    failed.tasks=[{k:'stop',berth:platformBerth(sim.topo,station,'UP'),station,trip:-1,arr:null,dep:null,doors:false,revenue:false}];
    rescuer.tasks=[{k:'rescue',target:failed.id}];rescuer.inService=false;
    rescuer.nextSignal=signal.id;rescuer.nextSignalDist=6.1;rescuer.stopDist=Infinity;
    indexBodies(sim);computeOccupancy(sim);const ar=sim.routes.get(route.id)!;
    ar.state='locked';ar.entered=true;ar.owner=failed.id;ar.fleeting=false;sim.sig[signal.id].aspect='R';
    ar.released[0]=true;sim.sec[route.sections[0]].lockRoute=-1;
    if(preset){sim.sec[route.sections[0]].preset=true;sim.sec[route.sections[0]].presetSeen=false;}
    expect(sim.command({c:'fault',kind:'trainFail',target:failed.id,duration:0,recoverable:false}).ok).toBe(true);checkSafety(sim);
    expect(rescueRouteReady(sim,rescuer,signal.id)).toBe(false);
    expect(scanAhead(sim,rescuer,-1).maDist).toBeLessThanOrEqual(6.1);
    rescuer.rescuing=failed.id;failed.rescueBy=rescuer.id;
    expect(rescueRouteReady(sim,rescuer,signal.id)).toBe(true);
    ar.owner=999;expect(rescueRouteReady(sim,rescuer,signal.id)).toBe(false);ar.owner=failed.id;
    updateTrainTasks(sim,rescuer);expect(rescuer.mode).toBe('RM');expect(rescuer.rmSig).toBe(signal.id);
    expect(ar.released[0]).toBe(false);expect(sim.sec[route.sections[0]].lockRoute).toBe(route.id);
    expect(scanAhead(sim,rescuer,-1).maCode).toBe('RESCUE');
    let approachMax=0;
    let coupled=false,reversed=false;
    for(let i=0;i<6000;i++){
      sim.step();if(sim.trains.has(failed.id))approachMax=Math.max(approachMax,rescuer.v);
      else if(!coupled){coupled=true;expect(sim.routes.get(route.id)?.owner).toBe(rescuer.id);}
      if(coupled&&rescuer.phase==='reversing')reversed=true;
    }
    expect(approachMax).toBeLessThanOrEqual(3/3.6+.1);expect(sim.trains.has(failed.id)).toBe(false);
    expect(rescuer.coupledLen).toBe(186);expect(rescuer.len).toBe(373);
    if(route.end<0)expect(reversed).toBe(true);
    if(preset)expect(sim.sec[route.sections[0]].preset).toBe(false);
    expect(sim.integrity.violations.map(v=>({kind:v.kind,detail:v.detail}))).toEqual([]);
  });
});

describe('multiple-failure maintenance escalation', () => {
  function fixture(coupled: boolean) {
    const sim = make(); advance(sim,2); const [rescuer,failed] = sim.trainList;
    for (const other of [...sim.trainList]) if (other !== rescuer && other !== failed) sim.removeTrain(other);
    for (const id of [...sim.routes.keys()]) releaseRoute(sim,id);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    const links = sim.topo.links.filter(l => l.track === 'UP' && l.normalDir === -1).sort((a,b) => a.chainA-b.chainA);
    const place = (tr: typeof failed, chain: number) => {
      const index = links.findIndex(l => l.chainA <= chain && l.chainB > chain), link = links[index];
      tr.link = link.id; tr.off = (chain-link.chainA)*link.len/(link.chainB-link.chainA); tr.dir = -1;
      tr.hist = links.slice(index,index+5).reverse().map(l => ({link:l.id,dir:-1 as const}));
      tr.phase = 'run'; tr.v = 0; tr.eb = false; tr.manual = false; tr.block = -1; tr.tripId = -1;
      tr.tbStage = 'none'; tr.depotStage = 'none'; tr.lastMa = Infinity; tr.lastDs = 0; tr.maDist = tr.maFar = 0; tr.maSigs = [];
      computeBody(sim,tr);
    };
    rescuer.len = coupled ? 373 : 186; rescuer.coupledLen = coupled ? 186 : 0;
    place(failed,56000); place(rescuer,56206);
    failed.tasks = [{k:'stop',berth:platformBerth(sim.topo,28,'UP'),station:28,trip:-1,arr:null,dep:null,doors:true,revenue:true}];
    rescuer.tasks = [{k:'depot',depot:2}]; rescuer.inService = false;
    setMode(sim,rescuer,'RM','CBTC','test'); indexBodies(sim);
    sim.command({c:'fault',kind:'trainFail',target:failed.id,duration:0,recoverable:false});
    advance(sim,30);
    return {sim,failed,rescuer,fault:sim.faults[0]};
  }
  it('keeps ordinary failures on the rescue path', () => {
    const {sim,failed,rescuer,fault} = fixture(false);
    expect(rescuerFor(sim,failed)?.id).toBe(rescuer.id);
    expect(sim.command({c:'trainMaintenance',fault:fault.id}).ok).toBe(false);
    expect(fault.maintenanceAt).toBeUndefined(); expect(failed.failed).toBe(true);
  });
  it('waits the full field-work time and withdraws the repaired blocker without moving its footprint', () => {
    const {sim,failed,fault} = fixture(true); const body = structuredClone(failed.body);
    expect(sim.command({c:'trainMaintenance',fault:fault.id}).ok).toBe(true);
    expect(fault.maintenanceAt).toBeCloseTo(sim.t+1200,4); expect(fault.stage).toBe('procedure');
    const cp = capture(sim); advance(sim,1199);
    expect(failed.failed).toBe(true); expect(failed.body).toEqual(body); expect(fault.repaired).toBe(false);
    advance(sim,1.1); expect(failed.failed).toBe(false); expect(failed.inService).toBe(false);
    expect(fault.repaired).toBe(true); expect(sim.trainChain(failed)).toBeGreaterThan(55999);
    const replay = make(); restore(replay,cp); advance(replay,1200.1);
    expect(fingerprint(replay)).toBe(fingerprint(sim));
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it('repairs a failed train straddling the scissors without moving a point beneath it, then restores its original cab',()=>{
    const sim=make();advance(sim,2);const [failed,rescuer]=sim.trainList;
    for(const other of [...sim.trainList])if(other!==failed&&other!==rescuer)sim.removeTrain(other);
    for(const id of [...sim.routes.keys()])releaseRoute(sim,id);
    for(const block of sim.plan.blocks)sim.blockDone.add(block.id);
    failed.tasks=[];rescuer.tasks=[];failed.hold=rescuer.hold=true;
    const pullout=sim.topo.routes.find(r=>r.name==='S3116→S3112(侧向)')!;
    expect(trySetRoute(sim,pullout.id,{manual:true,train:failed.id}).ok).toBe(true);advance(sim,5);
    // Real airport scissors footprint from the failing seed; the point
    // positions were established before this body occupied their sections.
    // (links found by track and chainage: their ids move with the layout)
    const at=(track:string,a:number,b:number)=>sim.topo.links.find(l=>l.track===track&&Math.abs(l.chainA-a)<.2&&Math.abs(l.chainB-b)<.2)!.id;
    const up=[[61835,62045],[62045,62125],[62125,62140],[62140,62155],[62155,62195],[62195,62210]].map(([a,b])=>at('UP',a,b));
    const dn=[at('DN',61419.6,61835),at('DN',61835,62045)];
    failed.link=up[5];failed.off=4.17072387;failed.dir=1;
    failed.hist=up.map(link=>({link,dir:1 as const}));
    rescuer.link=dn[1];rescuer.off=203.6220205;rescuer.dir=1;
    rescuer.hist=dn.map(link=>({link,dir:1 as const}));
    for(const tr of [failed,rescuer]){
      tr.v=0;tr.eb=false;tr.manual=false;tr.block=-1;tr.tripId=-1;tr.phase='run';tr.hold=false;
      tr.maDist=tr.maFar=0;tr.maSigs=[];tr.lastMa=Infinity;tr.lastDs=0;computeBody(sim,tr);
    }
    failed.tasks=[{k:'stop',berth:platformBerth(sim.topo,30,'UP'),station:30,trip:-1,arr:null,dep:null,doors:false,revenue:false}];
    failed.tbStage='arrive';failed.rescueReverse=true;failed.rescueBy=rescuer.id;
    rescuer.tasks=[{k:'rescue',target:failed.id}];rescuer.rescuing=failed.id;rescuer.nextSignal=sim.topo.signals.find(x=>x.name==='X3105')!.id;rescuer.inService=false;
    indexBodies(sim);computeOccupancy(sim);
    expect(sim.command({c:'fault',kind:'trainFail',target:failed.id,duration:0,recoverable:false}).ok).toBe(true);
    checkSafety(sim); // observe fault creation before the next procedure command
    const fault=sim.faults.at(-1)!;const body=structuredClone(failed.body);const positions=sim.sw.map(sw=>sw.pos);
    expect(sim.command({c:'trainMaintenance',fault:fault.id}).ok).toBe(true);
    advance(sim,1199);expect(failed.body).toEqual(body);expect(sim.sw.map(sw=>sw.pos)).toEqual(positions);
    advance(sim,1.1);expect(failed.failed).toBe(false);expect(failed.dir).toBe(-1);
    expect(failed.rescueBy).toBe(-1);expect(rescuer.rescuing).toBe(-1);expect(failed.inService).toBe(false);
    const chain=sim.trainChain(failed);advance(sim,300);
    expect(sim.trainChain(failed)).toBeLessThan(chain-100);
    expect(sim.integrity.violations.map(v=>({kind:v.kind,detail:v.detail}))).toEqual([]);
  });
});

describe('paper-based turnback and depot procedures', () => {
  // 蟠祥路 no longer has terminal tails to turn back on (its turnback is the PXL1/PXL2 middle tracks and the two
  // main-line tails are storage only), so the physical-tail rule is checked on both 浦东1号2号航站楼 tails.
  it.each([[30, 1], [30, 0]])('keeps a coupled rescue on its physical terminal tail (station %s, tail %s)', (station, physicalIndex) => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
    for (const rid of [...sim.routes.keys()]) releaseRoute(sim, rid);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    const berths = sim.topo.stations[station].turnbackBerths;
    expect(berths.every(id => sim.topo.berths[id].kind === 'tail')).toBe(true);
    const physical = sim.topo.berths[berths[physicalIndex]];
    const other = berths[1 - physicalIndex];
    const link = sim.topo.links[physical.link];
    const inner = sim.topo.links.find(l => l.track === link.track && (physical.dir === 1 ? l.b === link.a : l.a === link.b))!;
    tr.link = link.id; tr.off = physical.offset - physical.dir * 40; tr.dir = physical.dir;
    tr.hist = [{ link: inner.id, dir: physical.dir }, { link: link.id, dir: physical.dir }];
    tr.len = 373; tr.coupledLen = 186; tr.v = 0; tr.eb = false; tr.phase = 'run';
    tr.block = -1; tr.tripId = -1; tr.inService = false; tr.tbStage = 'arrive';
    tr.tasks = [{ k: 'reverse', berths: [other], chosen: other, station, minTime: 40 },
      { k: 'stop', berth: platformBerth(sim.topo, station, 'UP'), station, trip: -1, arr: null, dep: sim.t + 1800, doors: false, revenue: false }];
    sim.berthRes.set(other, tr.id); computeBody(sim, tr); indexBodies(sim);
    tr.maDist = tr.maFar = 0; tr.maSigs = []; tr.lastMa = Infinity; tr.stopDist = Infinity;
    updateTrainTasks(sim, tr);
    expect(tr.tasks[0]).toMatchObject({ chosen: physical.id });
    expect(sim.berthRes.has(other)).toBe(false);
    advance(sim, 150);
    expect(tr.dir).toBe(-physical.dir);
    expect(tr.tasks[0].k).toBe('stop');
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it('returns a rescue coupled at the western terminal to depot without fouling its tail crossover', () => {
    const sim = make(); advance(sim, 2); const [tr, failed] = sim.trainList;
    for (const other of [...sim.trainList]) if (other !== tr && other !== failed) sim.removeTrain(other);
    for (const rid of [...sim.routes.keys()]) releaseRoute(sim, rid);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    const berth = sim.topo.berths[platformBerth(sim.topo, 0, 'UP')];
    const link = sim.topo.links[berth.link];
    const previous = sim.topo.links.find(l => l.a === link.b && l.track === 'UP')!;
    failed.link = link.id; failed.off = berth.offset; failed.dir = -1;
    failed.hist = [{ link: link.id, dir: -1 }]; failed.v = 0; failed.failed = true;
    failed.block = -1; failed.tripId = -1; computeBody(sim, failed);
    tr.link = previous.id; tr.off = 5; tr.dir = -1; tr.hist = [{ link: previous.id, dir: -1 }];
    tr.tasks = [{ k: 'rescue', target: failed.id }]; tr.rescuing = failed.id;
    tr.phase = 'coupling'; tr.dwellUntil = sim.t; tr.v = 0; tr.eb = false;
    tr.block = -1; tr.tripId = -1; tr.inService = false; tr.load = 10;
    computeBody(sim, tr); indexBodies(sim); updateTrainTasks(sim, tr);
    expect(tr.len).toBe(373);
    expect(tr.tasks.some(t => t.k === 'reverse')).toBe(true);
    expect(tr.tasks.at(-1)?.k).toBe('depot');
    const vehicles = [tr.vehicle, tr.coupledVehicle];
    // 373 m does not fit the change of ends at 淞虹路 (DN entry): it runs on to 龙阳路
    advance(sim, 6600);
    expect(sim.trains.has(tr.id)).toBe(false);
    for (const vehicle of vehicles) expect(sim.yards.some(y => y.tracks.some(track => track.includes(vehicle!)))).toBe(true);
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it.each(['manual','none'] as const)('rescues an opposing failed terminal-tail train without selecting its parallel tail neighbour (stage=%s)', stage => {
    const sim = make(); advance(sim, 2); const [tr, failed, parallel] = sim.trainList;
    for (const other of [...sim.trainList]) if (![tr, failed, parallel].includes(other)) sim.removeTrain(other);
    for (const rid of [...sim.routes.keys()]) releaseRoute(sim, rid);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    // the east end: 浦东1号2号航站楼 has the terminal tails (蟠祥路's tails are storage only); the failed train has
    // changed ends in the DN tail and faces the platform (west), the rescuer arrives from the DN platform
    const station = 30;
    const tail = sim.topo.berths[sim.topo.stations[station].turnbackBerths[0]];
    expect(tail.kind).toBe('tail');
    const outer = sim.topo.links[tail.link];
    failed.link = outer.id; failed.off = 78; failed.dir = -1;
    failed.hist = [{ link: outer.id, dir: -1 }];
    failed.v = 0; failed.eb = false; failed.block = -1; failed.tripId = -1; failed.tbStage = stage === 'none' ? 'none' : 'arrive';
    failed.phase = 'run'; computeBody(sim, failed);
    const platform = sim.topo.berths[platformBerth(sim.topo, station, 'DN')];
    tr.link = platform.link; tr.off = sim.topo.links[platform.link].len - 6; tr.dir = 1; tr.hist = [{ link: platform.link, dir: 1 }];
    tr.v = 0; tr.eb = false; tr.phase = 'run'; tr.block = -1; tr.tripId = -1; tr.inService = false;
    const otherTail = sim.topo.berths[sim.topo.stations[station].turnbackBerths[1]];
    parallel.link = otherTail.link; parallel.off = sim.topo.links[otherTail.link].len - 201; parallel.dir = -1; parallel.hist = [{ link: otherTail.link, dir: -1 }];
    parallel.v = 0; parallel.phase = 'run'; parallel.block = -1; parallel.tripId = -1;
    parallel.tasks = [{ k: 'stop', berth: platformBerth(sim.topo, station, 'UP'), station, trip: -1, arr: null, dep: sim.t + 3600, doors: false, revenue: false }];
    computeBody(sim, tr); computeBody(sim, parallel); indexBodies(sim);
    for (const train of [tr, failed, parallel]) { train.maDist = train.maFar = 0; train.maSigs = []; train.lastDs = 0; train.lastMa = Infinity; }
    checkSafety(sim);
    if(stage==='manual'){ failed.tbStage = 'reverse'; checkSafety(sim); failed.tbStage = 'manual'; checkSafety(sim); }
    expect(sim.command({ c: 'fault', kind: 'trainFail', target: failed.id, duration: 0, recoverable: false }).ok).toBe(true);
    expect(rescueApproach(sim, failed, parallel)).toBeNull();
    expect(rescuerFor(sim, failed)?.id).toBe(tr.id);
    const call = callRescue(sim, failed)!;
    checkSafety(sim); // observe creation before the dispatcher answers
    expect(answerCall(sim, call.id, 'wait').ok).toBe(true);
    checkSafety(sim);
    sim.t += 121; radioTick(sim);
    checkSafety(sim);
    expect(sim.calls.some(c => c.kind === 'rescue' && c.train === failed.id && c.state === 'ringing')).toBe(true);
    const footprint = structuredClone(failed.body);
    expect(sim.command({ c: 'rescue', failed: failed.id, rescuer: tr.id }).ok).toBe(true);
    expect(failed.body.slice().sort((a, b) => a.link - b.link)).toEqual(footprint.sort((a, b) => a.link - b.link));
    sim.removeTrain(parallel);
    const vehicles = [tr.vehicle, failed.vehicle];
    // 373 m does not fit the change of ends at 远东大道 (UP entry): it runs on to 龙阳路
    advance(sim, 6600);
    expect(sim.trains.has(failed.id)).toBe(false);
    expect(sim.trains.has(tr.id)).toBe(false);
    for (const vehicle of vehicles) expect(sim.yards.some(y => y.tracks.some(track => track.includes(vehicle)))).toBe(true);
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it('holds a CBTC train inside the tail until a complete pull-out path is locked', () => {
    const sim = make(); advance(sim, 2);
    const berth = sim.topo.berths[sim.topo.stations[0].turnbackBerths[0]];
    // (the train stabled there overnight: one moved in from elsewhere would keep its old authority)
    const tr = sim.trainList.find(t => t.link === berth.link) ?? sim.trainList[0];
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
  it('protects the reverse-platform arrival before the cab-change task starts and refuses TBTC', () => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    const r = sim.topo.routes.find(r => r.wrongDir && r.berths.some(b => sim.topo.berths[b].kind === 'platform' && sim.topo.berths[b].reverse))!;
    const berth = r.berths.find(b => sim.topo.berths[b].kind === 'platform' && sim.topo.berths[b].reverse)!;
    tr.tasks = [{ k: 'stop', berth, station: sim.topo.berths[berth].station, trip: -1, arr: null, dep: null, doors: false, revenue: false }];
    for (const id of [...sim.routes.keys()]) releaseRoute(sim, id);
    tr.level = 'TBTC';
    expect(trySetRoute(sim, r.id, { train: tr.id }).ok).toBe(false);
    expect(sim.routes.has(r.id)).toBe(false);
    tr.level = 'CBTC';
    expect(trySetRoute(sim, r.id, { train: tr.id }).ok).toBe(true);
    expect(sim.routes.get(r.id)?.directionReverse).toBe(true);
    expect(r.sections.every(s => sim.sec[s].directionEsp && sim.sec[s].td === 0)).toBe(true);
  });
  it('uses the full physical depot insertion path rather than half the terminal route cost', () => {
    const sim = make(); const depot = sim.topo.depots.find(d => d.key === 'CSD')!;
    // CSD's exit joins the UP main east of 远东大道 and runs west (dir -1): the first platform it reaches is that
    // station's UP platform
    const goal = sim.topo.berths.find(b => b.station === depot.station && b.kind === 'platform' && b.dir === -1 && sim.topo.links[b.link].track === 'UP')!;
    const distance = distanceToBerth(sim, depot.exitSignal, goal.id);
    // the junction to the platform plus the transfer track and turnouts
    const span = Math.abs(sim.topo.stations[depot.station].chain - depot.junctionChain);
    expect(distance).toBeGreaterThan(span);
    expect(distance).toBeLessThan(span + 600);
    // The weighted route-choice cost counts the route holding the berth at half length (and adds a penalty per
    // diverging route); the physical path is the plain length of the routes before it plus most of that route.
    const table = sim.routeTable.next.get(goal.id)!;
    let before = 0, sig = depot.exitSignal, terminal = sim.topo.routes[table[sig]];
    for (let guard = 0; guard < 20 && !terminal.berths.includes(goal.id); guard++) {
      before += terminal.length; sig = terminal.end; terminal = sim.topo.routes[table[sig]];
    }
    expect(terminal.berths).toContain(goal.id);
    expect(before).toBeGreaterThan(0);
    expect(distance).toBeGreaterThan(before + 0.5 * terminal.length);
    expect(distance).toBeLessThanOrEqual(before + terminal.length);
  });
  it('does not apply reverse-interval TD protection to an ordinary terminal tail move', () => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    const r = sim.topo.routes.find(r => r.wrongDir && r.berths.some(b => sim.topo.berths[b].kind === 'tail'))!;
    const tail = r.berths.find(b => sim.topo.berths[b].kind === 'tail')!;
    tr.tasks = [{ k: 'reverse', berths: [tail], chosen: tail, station: 0, minTime: 40 }];
    for (const id of [...sim.routes.keys()]) releaseRoute(sim, id);
    expect(trySetRoute(sim, r.id, { train: tr.id }).ok).toBe(true);
    expect(sim.routes.get(r.id)?.directionReverse).toBe(false);
    expect(r.sections.some(s => sim.sec[s].directionEsp)).toBe(false);
  });
  it('rebinds an already locked pull-out route and clears protection only after cab change and platform clearance', () => {
    const sim = make(); advance(sim, 2); const [tr, other] = sim.trainList;
    const goal = sim.topo.berths.find(b => b.kind === 'platform' && b.station === 0 && b.dir === 1)!;
    const r = sim.topo.routes.find(r => r.berths.includes(goal.id))!;
    for (const id of [...sim.routes.keys()]) releaseRoute(sim, id);
    expect(trySetRoute(sim, r.id).ok).toBe(true);
    const ar = sim.routes.get(r.id)!; ar.state = 'locked';
    const protectedSection = r.sections[0];
    Object.assign(sim.sec[protectedSection], { td: -1, tdRoute: r.id, tdTrain: tr.id, directionEsp: true });
    tr.phase = 'reversing'; tr.tbStage = 'reverse'; tr.v = 0;
    tr.tasks = [{ k: 'reverse', berths: [], chosen: -1, station: 0, minTime: 40 },
      { k: 'stop', berth: goal.id, station: 0, trip: -1, arr: null, dep: sim.t + 60, doors: false, revenue: false }];
    bindRouteApproach(sim, r.id, tr.id); updateInterlocking(sim);
    expect(sim.sec[protectedSection].directionEsp).toBe(true);
    tr.tasks.shift(); tr.phase = 'run'; tr.tbStage = 'depart';
    sim.linkBodies.set(goal.link, [{ train: other.id, from: 0, to: 100 }]);
    bindRouteApproach(sim, r.id, tr.id); updateInterlocking(sim);
    expect(sim.sec[protectedSection].directionEsp).toBe(true);
    sim.linkBodies.set(goal.link, []); updateInterlocking(sim);
    expect(sim.sec[protectedSection].directionEsp).toBe(false);
    expect(ar.directionTrain).toBe(tr.id);
  });
  it('locks independent LYD entry and exit routes without sharing conversion sections', () => {
    const sim = make(); const depot = sim.topo.depots.find(d => d.key === 'LYD')!;
    expect(depot.outGateLink).not.toBe(depot.gateLink);
    const incoming = sim.topo.routes.find(r => r.endNode === depot.gateNode)!;
    const outgoing = sim.topo.routes.find(r => r.start === depot.exitSignal && !r.sections.some(s => incoming.sections.includes(s)))!;
    expect(outgoing).toBeDefined();
    for (const ar of [...sim.routes.values()]) cancelRoute(sim, sim.topo.routes[ar.route].start);
    expect(trySetRoute(sim, incoming.id).ok).toBe(true);
    expect(trySetRoute(sim, outgoing.id).ok).toBe(true);
    expect(sim.topo.routes.some(r => r.endNode === depot.outGateNode)).toBe(false);
  });
  it('keeps a TBTC forward turnback stopped until a driver instruction and signal passage', () => {
    const sim = make(); advance(sim, 2); sim.autoRadio = false;
    const station = sim.topo.stations[0];
    const berth = sim.topo.berths[station.turnbackBerths[0]];
    const tr = sim.trainList.find(t => t.link === berth.link) ?? sim.trainList[0];
    const platform = sim.topo.berths.find(b => b.station === 0 && b.kind === 'platform' && b.dir === 1)!;
    tr.link = berth.link; tr.off = berth.offset; tr.dir = berth.dir; tr.hist = [{ link: berth.link, dir: berth.dir }];
    // This fixture starts after the driver's change of ends; it exercises the signal/RM procedure.
    tr.v = 0; tr.phase = 'reversing'; tr.phaseSince = sim.t - OPERATIONS.atoDriverWork.legacyEndChangeS; tr.dwellUntil = sim.t; tr.tbStage = 'arrive';
    tr.forceLevel = 'TBTC'; tr.block = -1; tr.tripId = -1;
    tr.tasks = [{ k: 'reverse', berths: [berth.id], chosen: berth.id, station: 0, minTime: 0 },
      { k: 'stop', berth: platform.id, station: 0, trip: -1, arr: null, dep: sim.t + 300, doors: false, revenue: false }];
    computeBody(sim, tr); indexBodies(sim); setMode(sim, tr, 'AM', 'TBTC', 'test'); checkSafety(sim);
    tr.tbStage = 'reverse'; advance(sim, 20);
    expect(tr.tbStage).toBe('manual'); expect(tr.v).toBe(0);
    const call = sim.calls.find(c => c.kind === 'turnback' && c.train === tr.id && c.state === 'ringing')!;
    expect(call).toBeDefined(); expect(answerCall(sim, call.id, 'rm', true).ok).toBe(false);
    expect(sim.command({ c: 'radio', call: call.id, option: 'rm' }).ok).toBe(true);
    const until = sim.t + 100;
    while (tr.mode === 'RM' && sim.t < until) sim.step();
    expect(tr.tbStage).toBe('depart'); expect(tr.mode).toBe('AM'); expect(tr.level).toBe('TBTC');
    expect(sim.integrity.violations).toHaveLength(0);
  });
});

describe('withdrawal approach continuity', () => {
  it('clears passengers before choosing a forward turnback after leaving 淞虹路', () => {
    const sim = make(); advance(sim,2); const tr = sim.trainList[0];
    for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
    for (const id of [...sim.routes.keys()]) releaseRoute(sim,id);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    const berth=sim.topo.berths[platformBerth(sim.topo,4,'UP')];
    tr.link=berth.link; tr.off=berth.offset-6; tr.dir=-1; tr.hist=[{link:tr.link,dir:-1}];
    tr.phase='run'; tr.v=0; tr.eb=false; tr.load=500; tr.lastStation=4;
    tr.block=-1; tr.tripId=-1; tr.inService=true; tr.depotStage='none';
    tr.tasks=[{k:'stop',berth:platformBerth(sim.topo,3,'UP'),station:3,trip:-1,arr:null,dep:sim.t+300,doors:true,revenue:true}];
    tr.maDist=tr.maFar=0; tr.maSigs=[]; tr.lastMa=Infinity; tr.lastDs=0;
    computeBody(sim,tr); indexBodies(sim); checkSafety(sim);
    expect(sim.command({c:'withdraw',train:tr.id}).ok).toBe(true);
    const stops=tr.tasks.filter(t=>t.k==='stop');
    // the DN entry to BZL changes ends on the 淞虹路 DN platform (the leads lie west of the station), so the
    // return after the turnback at 1 ends with that 回段换端 stop
    const entry=sim.topo.depots[0].portals.entry.DN;
    expect(entry).toMatchObject({station:4,reverse:true});
    expect(stops.map(t=>t.station)).toEqual([3,1,entry.station]);
    expect(tr.tasks.find(t=>t.k==='reverse')).toMatchObject({station:1});
    expect(tr.tasks.filter(t=>t.k==='reverse').at(-1)).toMatchObject({station:entry.station});
    const vehicle=tr.vehicle; const cleared=sim.passengersCleared;
    advance(sim,2500);
    expect(sim.trains.has(tr.id)).toBe(false);
    expect(sim.yards.some(y=>y.tracks.some(track=>track.includes(vehicle)))).toBe(true);
    expect(sim.passengersCleared-cleared).toBe(500);
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it.each(['BZL', 'LYD', 'CSD'])('preserves an entered %s depot path during recovery and repeated withdrawal', key => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
    for (const id of [...sim.routes.keys()]) releaseRoute(sim, id);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    const depot = sim.topo.depots.find(d => d.key === key)!;
    const berth = sim.topo.berths[depot.berth];
    // far enough up the gate link for the train to settle on its braking curve: from 10 m the BZL leads (3‰ down
    // towards the gate) overshoot the berth by more than the 1.5 m arrival tolerance and the train waits at 段界
    tr.link = berth.link; tr.off = berth.offset - berth.dir * 80; tr.dir = berth.dir;
    tr.hist = [{link:tr.link,dir:tr.dir}]; tr.v = 0; tr.eb = false; tr.phase = 'run';
    tr.block = -1; tr.tripId = -1; tr.inService = true; tr.delay = 1000; tr.load = 0;
    tr.tasks = [{k:'depot',depot:depot.id}]; tr.depotStage = 'none';
    tr.maDist = tr.maFar = 0; tr.maSigs = []; tr.lastMa = Infinity; tr.lastDs = 0;
    computeBody(sim,tr); indexBodies(sim); checkSafety(sim);
    const tasks = structuredClone(tr.tasks);
    expect(sim.command({c:'recoverService',train:tr.id}).ok).toBe(false);
    expect(tr.tasks).toEqual(tasks);
    setTripFromTasks(sim,tr); expect(tr.inService).toBe(false);
    expect(sim.command({c:'withdraw',train:tr.id}).ok).toBe(true);
    expect(tr.tasks).toEqual(tasks); expect(tr.inService).toBe(false);
    const vehicle = tr.vehicle;
    advance(sim,60);
    expect(sim.trains.has(tr.id)).toBe(false);
    expect(sim.yards[depot.id].tracks.some(track=>track.includes(vehicle))).toBe(true);
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it('goes straight to the tail when an empty terminal train has already departed its clear-out mark', () => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    const berth = sim.topo.berths[platformBerth(sim.topo, 0, 'UP')];
    for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
    for (const id of [...sim.routes.keys()]) releaseRoute(sim,id);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    tr.link = berth.link; tr.off = berth.offset-6; tr.dir = -1; tr.hist = [{link:tr.link,dir:-1}];
    tr.phase = 'run'; tr.v = 0; tr.eb = false; tr.load = 0; tr.lastStation = 0;
    tr.block = -1; tr.tripId = -1; tr.inService = true;
    tr.tasks = [{k:'stop',berth:platformBerth(sim.topo,0,'DN'),station:0,trip:-1,arr:null,dep:sim.t-200,doors:true,revenue:true}];
    tr.lastMa = Infinity; tr.maDist = tr.maFar = 0; tr.lastDs = 0; tr.maSigs = [];
    computeBody(sim,tr); indexBodies(sim);
    expect(sim.command({c:'withdraw',train:tr.id}).ok).toBe(true);
    expect(tr.tasks[0]).toMatchObject({k:'reverse',station:0});
    advance(sim,300);
    expect(tr.dir).toBe(1);
    // no clear-out stop at 蟠祥路: what remains is the DN entry to BZL, which changes ends on the 淞虹路 platform
    // (the leads lie west of that station) and then goes in
    const entry=sim.topo.depots[0].portals.entry.DN;
    expect(entry).toMatchObject({station:4,reverse:true});
    expect(tr.tasks.some(t=>t.k==='stop'&&t.station===0)).toBe(false);
    expect(tr.tasks.map(t=>t.k)).toEqual(['stop','reverse','depot']);
    expect(tr.tasks[0]).toMatchObject({k:'stop',station:entry.station,note:'回段换端'});
    expect(tr.tasks.at(-1)).toMatchObject({k:'depot',depot:0});
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it('keeps the normal clear-out platform when the depot is behind a moving train', () => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    const berth = sim.topo.berths[platformBerth(sim.topo, 2, 'UP')];
    tr.link = berth.link; tr.off = sim.topo.links[berth.link].len - 1; tr.dir = -1;
    tr.hist = [{link:tr.link,dir:-1}]; tr.phase = 'run'; tr.v = 3;
    tr.inService = true; tr.lastStation = 3;
    tr.tasks = [{k:'stop',berth:berth.id,station:2,trip:tr.tripId,arr:sim.t+10,dep:sim.t+40,doors:true,revenue:true}];
    computeBody(sim,tr); indexBodies(sim);
    expect(sim.command({c:'withdraw',train:tr.id}).ok).toBe(true);
    expect(tr.tasks[0]).toMatchObject({k:'stop',station:2,berth:berth.id});
    expect(tr.tasks.find(t=>t.k==='reverse')).toMatchObject({station:1});
    expect(tr.tasks.at(-1)?.k).toBe('depot');
    expect(sim.plan.trips[tr.tripId].cancelled).toBe(true);
    expect(sim.plan.trips[tr.tripId].cancelReason).toBe(`列车${tr.svc}退出服务（调度命令）`);
  });
});

describe('depot selection after clear-out', () => {
  it('does not choose a depot entrance before the passenger clear-out station', () => {
    const sim = make(); advance(sim,2); const tr = sim.trainList[0];
    const link = sim.topo.links.find(l=>l.track==='UP'&&l.chainA<33510&&l.chainB>33510)!;
    tr.link=link.id;tr.off=33510-link.chainA;tr.dir=-1;tr.hist=[{link:tr.link,dir:-1}];
    tr.phase='run';tr.inService=true;tr.lastStation=20;tr.v=3;computeBody(sim,tr);indexBodies(sim);
    expect(sim.command({c:'withdraw',train:tr.id}).ok).toBe(true);
    expect(tr.tasks[0]).toMatchObject({k:'stop',station:19});
    const depot=tr.tasks.at(-1);expect(depot?.k).toBe('depot');
    if(depot?.k!=='depot')return;
    // LYD's leads lie east of 龙阳路: the junction is between the train and the clear-out station. Its UP entry
    // changes ends on that platform, so the depot is entered only after the clear-out stop there (the entrance
    // before the station is never taken ahead of the clear-out).
    const lyd=sim.topo.depots[depot.depot];
    expect(lyd.key).toBe('LYD');
    expect(lyd.junctionChain).toBeGreaterThan(sim.topo.stations[19].chain);
    expect(lyd.junctionChain).toBeLessThan(sim.trainChain(tr));
    expect(lyd.portals.entry.UP).toMatchObject({station:19,reverse:true});
    expect(tr.tasks.map(t=>t.k)).toEqual(['stop','reverse','depot']);
    expect(tr.tasks[1]).toMatchObject({k:'reverse',station:19});
  });
});

describe('fault recovery service regulation', () => {
  const fixture = () => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
    for (const rid of [...sim.routes.keys()]) releaseRoute(sim, rid);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    const makeTrip = (id: number, dir: 'DN' | 'UP', dep: number): Trip => {
      const from = dir === 'DN' ? 0 : 1; const to = dir === 'DN' ? 1 : 0;
      return {id,no:`R${id}`,dir,kind:'big',from,to,block:0,revenue:true,
        stops:[{st:from,arr:dep,dep,stop:true},{st:to,arr:dep+200,dep:dep+200,stop:true}]};
    };
    const trips = [makeTrip(0,'UP',sim.t-1200),makeTrip(1,'DN',sim.t-900),makeTrip(2,'UP',sim.t-500),makeTrip(3,'DN',sim.t+300)];
    trips[0].completed = true;
    sim.plan.trips = trips; sim.plan.blocks = [{id:0,svc:tr.svc,start:{kind:'stable',station:0},end:{kind:'depot',depot:0},trips:[0,1,2,3],train:tr.id}];
    const tasks: Task[] = [];
    tasks.push({k:'stop',berth:platformBerth(sim.topo,0,'UP'),station:0,trip:0,arr:sim.t-1000,dep:null,doors:true,revenue:true});
    for (let id=1;id<trips.length;id++) {addTurnback(sim.topo,trips[id-1],tasks);tripTasks(sim.topo,trips[id],tasks,false);}
    tasks.push({k:'depot',depot:0});
    tr.tasks=tasks;tr.phase='dwell';tr.dwellUntil=sim.t+18;tr.v=0;tr.eb=false;tr.manual=false;
    tr.block=0;tr.tripId=0;tr.tripNo='R0';tr.inService=true;tr.delay=1000;tr.lastStation=0;tr.load=0;tr.doorsOpen=false;tr.depotStage='none';tr.tbStage='none';
    const berth=sim.topo.berths[platformBerth(sim.topo,0,'UP')];tr.link=berth.link;tr.off=berth.offset;tr.dir=-1;tr.hist=[{link:berth.link,dir:-1}];
    tr.maDist=tr.maFar=0;tr.maSigs=[];tr.lastMa=Infinity;tr.lastDs=0;computeBody(sim,tr);indexBodies(sim);
    sim.tripsDone=1;sim.metrics.tripsCompleted=1;sim.metrics.tripDelays=[1000];
    return {sim,tr};
  };
  it('cancels only missed whole cycles and takes a future original slot without erasing lateness', () => {
    const {sim,tr}=fixture();const original=structuredClone(sim.plan.trips.map(t=>t.stops));
    expect(sim.command({c:'recoverService',train:tr.id}).ok).toBe(true);
    expect(sim.plan.trips.map(t=>!!t.cancelled)).toEqual([false,true,true,false]);
    expect(sim.plan.trips[0].completed).toBe(true);expect(sim.metrics.tripDelays).toEqual([1000]);
    expect(sim.plan.trips.map(t=>t.stops)).toEqual(original);
    expect(tr.tasks[1].k).toBe('reverse');expect(tr.tasks[2].k==='stop'&&tr.tasks[2].trip).toBe(3);
    advance(sim,400);
    expect(sim.depLog.some(d=>d.trip===3&&d.st===0&&Math.abs(d.delay)<=120)).toBe(true);
    expect(tr.delay).toBeLessThanOrEqual(120);expect(sim.integrity.violations).toHaveLength(0);
  });
  it('rejects cancellation during an active journey without altering its plan', () => {
    const {sim,tr}=fixture();tr.phase='run';const before=stringifyDiagnostics(exportDiagnostics(sim));
    expect(sim.command({c:'recoverService',train:tr.id}).ok).toBe(false);
    expect(sim.plan.trips.every(t=>!t.cancelled)).toBe(true);
    // Rejected command adds an audit event but preserves tasks, history and trip state.
    expect(sim.metrics.tripDelays).toEqual([1000]);expect(tr.tasks[0].k==='stop'&&tr.tasks[0].trip).toBe(0);expect(before).toContain('R0');
  });
  it('repositions a severely late train for a later original slot when the missed cycle cannot be skipped', () => {
    const {sim,tr}=fixture();sim.plan.trips[3].stops[0].dep=sim.t+3600;
    tr.tasks=tr.tasks.map(t=>t.k==='stop'&&t.trip===3&&t.arr===null?{...t,dep:sim.t+3600}:t);
    expect(sim.command({c:'recoverService',train:tr.id}).ok).toBe(true);
    expect(sim.plan.trips.map(t=>!!t.cancelled)).toEqual([false,true,true,false]);
    expect(sim.plan.trips[1].cancelReason).toContain('定位');
    expect(tr.tasks.filter(t=>t.k==='stop'&&t.revenue).every(t=>t.k==='stop'&&t.trip===3)).toBe(true);
    expect(sim.metrics.tripDelays).toEqual([1000]);
  });
  it('returns the vehicle to a yard when withdrawn, keeping completed trips', () => {
    const {sim,tr}=fixture();
    expect(sim.command({c:'withdraw',train:tr.id}).ok).toBe(true);
    expect(sim.plan.trips[0].cancelled).toBeUndefined();expect(sim.plan.trips.slice(1).every(t=>t.cancelled)).toBe(true);
    expect(sim.plan.trips.slice(1).every(t=>t.cancelReason?.includes('退出服务'))).toBe(true);
    const vehicle=tr.vehicle;advance(sim,2500);
    expect(sim.trains.has(tr.id)).toBe(false);expect(sim.yards.some(y=>y.tracks.some(track=>track.includes(vehicle)))).toBe(true);
    expect(sim.metrics.tripDelays).toEqual([1000]);expect(sim.integrity.violations).toHaveLength(0);
  });
  it.each([false, true])('R1 depends on the train, not on any incident or clearance timer (future reachable=%s)', reachable => {
    const {sim,tr}=fixture();
    for (const id of [1,2,3]) {
      const dep = reachable && id === 3 ? sim.t + 3600 : sim.t - 900;
      sim.plan.trips[id].stops[0].dep = dep;
      tr.tasks = tr.tasks.map(t=>t.k==='stop'&&t.trip===id&&t.arr===null?{...t,dep}:t);
    }
    // An open incident does not hold the rule back, and nothing records a clearance time.
    expect(sim.command({c:'fault',kind:'signal',target:0,duration:3600}).ok).toBe(true);
    tr.load=200;const before=structuredClone(sim.plan.trips.map(t=>t.stops));
    expect(sim.command({c:'recoverService',train:tr.id}).ok).toBe(true);
    expect(tr.inService).toBe(false);expect(tr.load).toBe(0);
    expect(sim.plan.trips[0].completed).toBe(true);expect(sim.plan.trips[0].cancelled).toBeUndefined();
    expect(sim.metrics.tripDelays).toEqual([1000]);expect(sim.plan.trips.map(t=>t.stops)).toEqual(before);
    if(reachable){
      expect(sim.plan.trips[3].cancelled).toBeUndefined();
      expect(sim.plan.trips[1].cancelReason).toContain('定位');
      expect(tr.tasks.some(t=>t.k==='reverse')).toBe(true);
    }else{
      expect(tr.withdrawn).toBe(true);
      expect(sim.plan.trips.slice(1).every(t=>t.cancelReason?.includes('不可达'))).toBe(true);
    }
    expect([...sim.dispatcher.next.keys()].some(k=>k.includes('cleared'))).toBe(false);
    const cp=capture(sim);const replay=make();restore(replay,cp);expect(fingerprint(replay)).toBe(fingerprint(sim));
  });
  it('leaves a moderately late train in service', () => {
    const {sim,tr}=fixture();tr.delay=130;
    for(const id of [1,2,3]){const dep=sim.t+60+200*id;sim.plan.trips[id].stops[0].dep=dep;
      tr.tasks=tr.tasks.map(t=>t.k==='stop'&&t.trip===id&&t.arr===null?{...t,dep}:t);}
    tr.tasks[0]={...tr.tasks[0],arr:sim.t-130} as Task;
    expect(sim.command({c:'recoverService',train:tr.id}).ok).toBe(false);
    expect(sim.plan.trips.every(t=>!t.cancelled)).toBe(true);expect(tr.inService).toBe(true);
  });
});

describe('standby trains (D45)', () => {
  const live = () => {
    const sim = makeSim('weekday',7*3600,{dateLabel:'standby',seed:7,noPossessions:true,autoDispatch:true});
    advance(sim, 600);
    return sim;
  };
  const errors = (sim: Sim) => validatePlan(sim.planCtx, sim.plan).filter(i => i.severity === 'error' && i.t >= sim.t).map(i => i.text);
  it('a standby takes over the trips a withdrawn train leaves, from the first one it can start on time', () => {
    const sim = live();
    const tr = sim.trainList.find(t => t.inService && t.block >= 0 && sim.plan.blocks[t.block].trips.indexOf(t.tripId) < sim.plan.blocks[t.block].trips.length - 3)!;
    const b = sim.plan.blocks[tr.block];
    const tail = b.trips.slice(b.trips.indexOf(tr.tripId) + 1).filter(id => !sim.plan.trips[id].cancelled);
    const before = errors(sim); const nBlocks = sim.plan.blocks.length; const rev = sim.planRev;
    expect(sim.command({ c: 'withdraw', train: tr.id, reason: '测试' }).ok).toBe(true);
    expect(sim.plan.blocks.length).toBe(nBlocks + 1);
    const sb = sim.plan.blocks[nBlocks];
    expect(sb.start.kind).toBe('depot');
    if (sb.start.kind === 'depot') expect(sb.start.time).toBeGreaterThanOrEqual(sim.t + 300);
    const taken = sb.trips.filter(id => tail.includes(id));
    expect(taken.filter(id => sim.plan.trips[id].revenue).length).toBeGreaterThan(0);
    expect(tail.slice(tail.length - taken.length)).toEqual(taken);
    expect(taken.every(id => !sim.plan.trips[id].cancelled && !sim.plan.trips[id].cancelReason)).toBe(true);
    // trips before the takeover stay cancelled, each with its reason
    expect(tail.slice(0, tail.length - taken.length).every(id => sim.plan.trips[id].cancelReason?.includes('退出服务'))).toBe(true);
    expect(errors(sim).filter(e => !before.includes(e))).toEqual([]);
    expect(sim.planRev).toBe(rev + 1);
    expect(sim.events.some(e => e.text.startsWith('备车顶替'))).toBe(true);
    // the standby leaves the yard and runs its first taken trip (the exit may
    // wait on the lead behind planned exits, D79: by the trip's departure)
    advance(sim, Math.max(...sb.trips.slice(0, 2).map(id => sim.plan.trips[id].stops[0].dep)) - sim.t);
    expect(sb.train).toBeDefined();
    expect(sim.integrity.violations, JSON.stringify(sim.integrity.violations)).toHaveLength(0);
    // Follow the real yard exit through the first inherited departure.
  }, 180_000);
  it('without the automatic dispatcher a withdrawal does not call a standby', () => {
    const sim = live(); sim.autoDispatch = false;
    const tr = sim.trainList.find(t => t.inService && t.block >= 0)!;
    const nBlocks = sim.plan.blocks.length;
    expect(sim.command({ c: 'withdraw', train: tr.id }).ok).toBe(true);
    expect(sim.plan.blocks.length).toBe(nBlocks);
  });
  it('relieves a late train: the standby runs its next departure on time, the late train goes home after its current trip', () => {
    const sim = live();
    // (the one whose current trip ends first: the test runs to its end)
    const candidates = sim.trainList.filter(t => t.inService && t.block >= 0 && t.tasks.some(x => x.k === 'stop' && x.trip === t.tripId && x.dep === null)
      && sim.plan.blocks[t.block].trips.indexOf(t.tripId) < sim.plan.blocks[t.block].trips.length - 3)
      .sort((a, b) => sim.plan.trips[a.tripId].stops.at(-1)!.arr - sim.plan.trips[b.tripId].stops.at(-1)!.arr);
    // Select a spare that takes the very next trip. A later takeover can
    // retain several more trips and turn this case into five hours of running.
    const incident=capture(sim),nBlocks=sim.plan.blocks.length;
    let tr=candidates[0],lateness=0,r={ok:false,msg:'no reachable candidate'};
    for(const candidate of candidates) {
      restore(sim,incident);tr=sim.trains.get(candidate.id)!;tr.delay=1200;
      lateness=predictedLateness(sim,tr);
      r=sim.command({c:'standby',train:tr.id});
      const end=tr.tasks.at(-1);
      if(r.ok&&end?.k==='stop'&&end.trip===tr.tripId) break;
    }
    // The accepted command removes the next own departure from its tasks.
    expect(lateness).toBeGreaterThan(RELIEF_DELAY);
    const current = tr.tripId;
    expect(r.ok, r.msg).toBe(true);
    expect(tr.relievedBy).toBe(sim.plan.blocks[nBlocks].svc);
    // the late train keeps no stop of a trip it handed over
    const taken = new Set(sim.plan.blocks[nBlocks].trips);
    expect(tr.tasks.some(t => t.k === 'stop' && taken.has(t.trip))).toBe(false);
    expect(tr.tasks.at(-1)).toMatchObject({ k: 'stop', trip: current, dep: null });
    expect(sim.plan.trips.filter(t => taken.has(t.id)).every(t => !t.cancelled)).toBe(true);
    expect(sim.command({ c: 'standby', train: tr.id }).ok).toBe(false);
    const end = tr.tasks.at(-1)!; advance(sim, (end.k === 'stop' && end.arr !== null ? end.arr : sim.t) - sim.t + 600);
    expect(sim.plan.trips[current].cancelled).toBeUndefined();
    expect(tr.withdrawn || !sim.trains.has(tr.id)).toBe(true);
    expect(sim.integrity.violations).toHaveLength(0);
  }, 120_000);
});

describe('shared depot admission',()=>{
  it.each(['BZL','CSD'])('starts from %s only at source time and waits on its safe platform for the ordinary exit window',key=>{
    const sim=make();const depot=sim.topo.depots.find(d=>d.key===key)!;
    // D72's first CSD movement may use its dedicated UP exit or be an
    // empty positioning trip. Select the shared lead's scheduled origin,
    // which is the admission contract this test exercises.
    const block=sim.plan.blocks.find(b=>{
      if(b.start.kind!=='depot'||b.start.depot!==depot.id)return false;
      const trip=sim.plan.trips[b.trips[0]],tasks=blockTasks(sim.topo,sim.plan,b),first=tasks[0];
      return trip.kind==='ins'&&depot.transferPaths[depot.portals.exit[trip.dir].path].flow==='shared'
        &&first?.k==='stop'&&tasks.some(t=>t.k==='stop'&&t.station===first.station&&t.dep!==null&&(t.arr===null||t.arr===t.dep));
    })!;
    expect(block).toBeDefined();
    expect(block.start.kind).toBe('depot');if(block.start.kind!=='depot')return;
    sim.plan.blocks=[block];sim.t=block.start.time-1;
    const tasks=blockTasks(sim.topo,sim.plan,block),first=tasks[0];expect(first.k).toBe('stop');if(first.k!=='stop')return;
    const index=tasks.findIndex(t=>t.k==='stop'&&t.station===first.station&&t.dep!==null&&(t.arr===null||t.arr===t.dep));
    const origin=tasks[index];if(origin.k!=='stop'||origin.dep===null)throw new Error('origin');
    const initial=sim.trainList.length;
    const stock=sim.depotStock[depot.id];
    expect(arbitrateResources(sim).decisions.has(-(block.id+1))).toBe(false);spawnDue(sim);
    expect(block.train).toBeUndefined();expect(sim.trainList).toHaveLength(initial);expect(sim.depotStock[depot.id]).toBe(stock);
    sim.t=block.start.time;
    const admission=arbitrateResources(sim).decisions.get(-(block.id+1))!;
    expect(admission).toMatchObject({admitted:true,blocker:-1});
    expect(admission.option.phases).toHaveLength(1);
    expect(admission.option.phases[0].goal).toBe(first.berth);
    expect(first.trip).toBe(block.trips[0]);
    expect(origin.trip).toBe(block.trips[0]);
    expect(admission.request.origin).toMatchObject({trip:block.trips[0],berth:origin.berth,dep:origin.dep});
    expect(sim.topo.berths[first.berth].platform).toBeGreaterThanOrEqual(0);
    expect(sim.topo.berths[origin.berth].platform).toBe(sim.topo.berths[first.berth].platform);
    expect(admission.option.choices).toEqual([{index:0,berth:first.berth}]);
    expect(admission.request.readyAt).toBe(sim.t);
    spawnDue(sim);
    expect(block.train).toBeDefined();expect(sim.depotStock[depot.id]).toBe(stock-1);
    expect(sim.trainList).toHaveLength(initial+1);
    const train=sim.trains.get(block.train!)!;
    expect(train.body.every(body=>sim.topo.links[body.link].track==='DEP')).toBe(true);

    // Derive the completed cab-change pose from that actual arrival path;
    // do not invent an unrelated platform or shorten the consist.
    const phase=admission.option.phases[0];
    const incoming=phase.path.map(step=>({link:step.link,dir:(step.to>step.from?1:-1) as 1|-1}));
    const point=reversedBerthPoint(sim.topo,first.berth,train.len,incoming)!;
    expect(point).toBeDefined();
    expect(point.link).toBe(sim.topo.berths[first.berth].link);
    train.tasks=structuredClone(tasks.slice(index));
    const departure=train.tasks[0];if(departure.k!=='stop')throw new Error('expected origin stop');
    departure.berth=sim.topo.berths.find(b=>b.platform===sim.topo.berths[first.berth].platform&&b.dir===point.dir)!.id;
    Object.assign(train,{...point,hist:[{link:point.link,dir:point.dir}],phase:'dwell',v:0,a:0,
      stopBerth:departure.berth,stopArrived:true,dwellUntil:origin.dep,doorsOpen:false,doorsAwait:false,maSigs:[]});
    computeBody(sim,train);indexBodies(sim);computeOccupancy(sim);
    expect(train.body.every(body=>sim.topo.links[body.link].platform===sim.topo.berths[first.berth].platform)).toBe(true);
    const next=train.tasks[1];if(next.k!=='stop')throw new Error('expected ordinary next stop');
    const scan=scanAhead(sim,train,next.berth);train.nextSignal=scan.nextSignal;train.nextSignalDist=scan.nextSignalDist;
    const ready=arsReadyAt(train);expect(sim.t).toBeLessThan(ready);
    sim.t=ready-.1;
    const waiting=arbitrateResources(sim),outgoing=waiting.decisions.get(train.id)!;
    expect(outgoing).toMatchObject({admitted:false,code:'REGULATION'});
    expect(outgoing.request.safeHere).toBe(true);
    expect(outgoing.request.readyAt).toBe(ready);
    expect([...waiting.claims.values()].some(claim=>claim.request.id===train.id)).toBe(false);
    expect(safeWaitingPoint(sim.topo,{...point,incoming:train.hist},train.len,
      {afterTurn:true,destination:next.berth,path:outgoing.option.phases.flatMap(p=>p.path)})).toBe(true);
    const exitRoute=sim.routeTable.next.get(next.berth)![train.nextSignal];
    runARS(sim,true);
    expect(sim.sig[train.nextSignal].route).not.toBe(exitRoute);
    expect(train.v).toBe(0);
    sim.t=ready;
    expect(arbitrateResources(sim).decisions.get(train.id)?.admitted).toBe(true);
    expect(sim.depotStock[depot.id]).toBe(stock-1);expect(sim.trainList).toHaveLength(initial+1);
  });
});

describe('diagnostics and replay', () => {
  it('keeps checkpoint alarm history immutable across acknowledgment and clearance', () => {
    const sim = make(); sim.command({ c: 'fault', kind: 'signal', target: 0, duration: 30 });
    const cp = capture(sim); const alarm = sim.alarms.get('sig-0')!;
    expect(alarm).toBeDefined();
    sim.command({ c: 'ack', ids: [alarm.id] }); sim.clearAlarm('sig-0');
    const recovery = sim.events.find(e => e.text === `【恢复】${alarm.text}`);
    expect(recovery).toBeDefined();
    expect(sim.newEvents.find(e => e.id === recovery!.id)).toEqual(recovery);
    expect(cp.events.find(e => e.id === alarm.id)?.ack).toBe(false);
    expect(cp.events.find(e => e.id === alarm.id)?.cleared).toBeUndefined();
    expect(sim.events.find(e => e.id === alarm.id)?.ack).toBe(true);
    expect(sim.events.find(e => e.id === alarm.id)?.cleared).toBe(sim.t);
  });
  it('round-trips sets, maps and infinity and reproduces commands at identical timestamps', () => {
    const sim = make();
    sim.command({ c: 'fault', kind: 'signal', target: 0, duration: 0 });
    sim.command({ c: 'zoneLevel', zones: [1], level: 'TBTC' });
    advance(sim, 60);
    sim.command({ c: 'platformHold', platform: 0, on: true });
    const bundle = parseDiagnostics(stringifyDiagnostics(exportDiagnostics(sim)));
    expect(bundle.state.data.routes).toBeInstanceOf(Map);
    expect((bundle.state.data.faults as Sim['faults'])[0].repairAt).toBe(Infinity);
    const replayed = replayDiagnostics(bundle);
    expect(fingerprint(replayed)).toBe(fingerprint(sim));
    expect(capture(replayed).data).toEqual(capture(sim).data);
    expect(replayed.events).toEqual(sim.events);
    expect(replayed.plan).toEqual(sim.plan);
  });
  it('restores added timetable data and integrity history into a fresh simulator', () => {
    const sim = make();
    advance(sim, 10);
    const cp = capture(sim);
    sim.command({ c: 'platformHold', platform: 0, on: true });
    restore(sim, cp);
    const fresh = make();
    restore(fresh, cp);
    advance(sim, 20); advance(fresh, 20);
    expect(capture(fresh).data).toEqual(capture(sim).data);
  });
  it('keeps service-day start and coarse early checkpoints beyond two hours', () => {
    const cp = capture(make());
    const checkpoints = Array.from({ length: 600 }, (_, i) => ({ ...cp, t: 14400 + i * 60 }));
    const kept = compactCheckpoints(checkpoints, 14400 + 599 * 60);
    expect(kept[0].t).toBe(14400);
    expect(kept.filter(x => x.t >= 14400 + 479 * 60)).toHaveLength(121);
    expect(kept.filter(x => x.t < 14400 + 479 * 60).length).toBeLessThanOrEqual(49);
  });
});

describe('state-machine contracts', () => {
  for (const machine of MACHINES) it(`${machine.name} has declared states and reachable transitions`, () => {
    const states: readonly string[] = machine.states;
    for (const entry of machine.table) {
      expect(states).toContain(entry.from);
      expect(states).toContain(entry.to);
      expect(entry.on.length).toBeGreaterThan(0);
    }
    const reached = new Set<string>(machine.initial);
    for (let i = 0; i < states.length; i++) for (const edge of machine.table) if (reached.has(edge.from)) reached.add(edge.to);
    expect([...reached].sort()).toEqual([...states].sort());
  });
  it('refuses moving degradation and unauthorised EB release', () => {
    const sim = make();
    advance(sim, 2);
    const tr = sim.trainList[0];
    expect(tr).toBeDefined();
    tr.v = 10;
    expect(allowed(sim, MODE, 'DTO-C', 'AM-T', tr).ok).toBe(false);
    tr.v = 0; tr.ebAuth = false;
    expect(allowed(sim, EB, 'standstill', 'off', tr).ok).toBe(false);
    tr.ebAuth = true;
    expect(allowed(sim, EB, 'standstill', 'off', tr).ok).toBe(true);
  });
  it('raises an A-level alarm with a snapshot for an illegal transition', () => {
    const sim = make(); advance(sim, 2);
    const tr = sim.trainList[0];
    checkSafety(sim);
    tr.mode = 'DTO'; tr.level = 'TBTC'; // no such state (DTO needs CBTC)
    checkSafety(sim);
    expect(sim.integrity.violations.some(v => v.kind === 'FSM' && v.snapshot.trains[0].id === tr.id)).toBe(true);
    const alarms = [...sim.alarms.values()].filter(a => a.key?.startsWith('integrity-FSM-'));
    expect(alarms.length).toBe(sim.integrity.counts.FSM);
    expect(alarms.every(a => a.level === 'A')).toBe(true);
  });
});

describe('safety review fixes', () => {
  function line(sim: Sim) {
    for (const id of [...sim.routes.keys()]) releaseRoute(sim, id);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    const links = sim.topo.links.filter(l => l.track === 'UP' && l.normalDir === -1).sort((a, b) => a.chainA - b.chainA);
    return (tr: Train, chain: number) => {
      const index = links.findIndex(l => l.chainA <= chain && l.chainB > chain), link = links[index];
      tr.link = link.id; tr.off = (chain - link.chainA) * link.len / (link.chainB - link.chainA); tr.dir = -1;
      tr.hist = links.slice(index, index + 5).reverse().map(l => ({ link: l.id, dir: -1 as const }));
      tr.phase = 'run'; tr.v = 0; tr.eb = false; tr.manual = false; tr.block = -1; tr.tripId = -1; tr.hold = false;
      tr.tbStage = 'none'; tr.depotStage = 'none'; tr.lastMa = Infinity; tr.lastDs = 0; tr.maDist = tr.maFar = 0; tr.maSigs = [];
      computeBody(sim, tr);
    };
  }
  it('refuses a desk EB release after a SPAD; only the SPAD procedure releases it', () => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    tr.v = 0; applyEB(sim, tr, 'test SPAD', 'spad');
    expect(ebCauseCleared(sim, tr)).toBe(false);
    const desk = sim.command({ c: 'ebRelease', train: tr.id });
    expect(desk.ok).toBe(false);
    expect(tr.eb).toBe(true); expect(tr.ebAuth).toBe(false);
    expect(answerEbRelease(sim, tr, 'release').ok).toBe(false);
    expect(tr.eb).toBe(true);
  });
  it('refuses a plain EB release while the comm-loss cause persists under CBTC', () => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    tr.v = 0; tr.comm = false; tr.level = 'CBTC'; applyEB(sim, tr, 'test comm', 'comm');
    expect(sim.command({ c: 'ebRelease', train: tr.id }).ok).toBe(false);
    expect(tr.eb).toBe(true);
    tr.comm = true;
    expect(sim.command({ c: 'ebRelease', train: tr.id }).ok).toBe(true);
    expect(tr.eb).toBe(false);
  });
  it('raises one A-level alarm per violation instance and suppresses only identical repeats', () => {
    const sim = make(); advance(sim, 2); const [a, b] = sim.trainList;
    violate(sim, 'OVERSPEED', [a.id], 'x 1');
    violate(sim, 'OVERSPEED', [a.id], 'x 2');
    violate(sim, 'OVERSPEED', [b.id], 'y 1');
    expect(sim.integrity.counts.OVERSPEED).toBe(2);
    advance(sim, 11);
    violate(sim, 'OVERSPEED', [a.id], 'x 3');
    expect(sim.integrity.counts.OVERSPEED).toBe(3);
    const alarms = [...sim.alarms.values()].filter(e => e.code === 'INTEGRITY_OVERSPEED');
    expect(alarms).toHaveLength(3);
    expect(alarms.every(e => e.level === 'A')).toBe(true);
  });
  it('checks a rescue pair for overlap except couplers in contact while coupling', () => {
    const sim = make(); advance(sim, 2); const [rescuer, failed] = sim.trainList;
    for (const other of [...sim.trainList]) if (other !== rescuer && other !== failed) sim.removeTrain(other);
    const place = line(sim);
    place(failed, 56000); place(rescuer, 56000 + failed.len - 3);
    rescuer.rescuing = failed.id; failed.rescueBy = rescuer.id; indexBodies(sim);
    checkSafety(sim);
    expect(sim.integrity.violations.map(v => v.kind)).toContain('OVERLAP');
    const sim2 = make(); advance(sim2, 2); const [r2, f2] = sim2.trainList;
    for (const other of [...sim2.trainList]) if (other !== r2 && other !== f2) sim2.removeTrain(other);
    const place2 = line(sim2);
    place2(f2, 56000); place2(r2, 56000 + f2.len - 0.5);
    r2.rescuing = f2.id; f2.rescueBy = r2.id; r2.phase = 'coupling'; indexBodies(sim2);
    checkSafety(sim2);
    expect(sim2.integrity.violations).toHaveLength(0);
  });
  it('checks an automatic rescue RM approach against its authority', () => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    tr.phase = 'run'; tr.mode = 'RM'; tr.manual = false; tr.rescuing = 99;
    tr.lastMa = 2; tr.lastDs = 3;
    checkSafety(sim);
    expect(sim.integrity.violations.map(v => v.kind)).toContain('BEYOND_MA');
  });
  it('grants rescue RM only when the failed train itself withholds the authority', () => {
    const sim = make(); advance(sim, 2); const [rescuer, blocker, failed] = sim.trainList;
    for (const other of [...sim.trainList]) if (![rescuer, blocker, failed].includes(other)) sim.removeTrain(other);
    const place = line(sim);
    place(failed, 56000); place(blocker, 56250); place(rescuer, 56500);
    for (const tr of [blocker, failed]) tr.tasks = [];
    blocker.hold = true;
    indexBodies(sim);
    sim.command({ c: 'fault', kind: 'trainFail', target: failed.id, duration: 0, recoverable: false });
    rescuer.tasks = [{ k: 'rescue', target: failed.id }]; rescuer.inService = false;
    rescuer.rescuing = failed.id; failed.rescueBy = rescuer.id;
    rescuer.maDist = 20; rescuer.maReason = '前车'; rescuer.maTrain = blocker.id; rescuer.nextSignal = -1; rescuer.nextSignalDist = Infinity;
    updateTrainTasks(sim, rescuer);
    expect(rescuer.mode).not.toBe('RM');
    sim.removeTrain(blocker); indexBodies(sim);
    rescuer.maReason = '救援连挂'; rescuer.maTrain = failed.id;
    updateTrainTasks(sim, rescuer);
    expect(rescuer.mode).toBe('RM');
  });
});

describe('ATO with a driver under CBTC (D52)', () => {
  it('a DTO fault degrades the train to CBTC AM at its next stop and the repair restores DTO', () => {
    const sim = make(); advance(sim, 7200);
    const tr = sim.trainList.find(t => t.inService && t.phase === 'run' && t.mode === 'DTO' && t.level === 'CBTC')!;
    expect(sim.command({ c: 'fault', kind: 'trainDto', target: tr.id, duration: 0 }).ok).toBe(true);
    expect(sim.command({ c: 'trainDto', train: tr.id, on: true }).ok).toBe(false);
    expect(tr.mode).toBe('DTO');
    for (let i = 0; i < 6000 && tr.mode === 'DTO'; i++) sim.step();
    expect([tr.mode, tr.level, tr.phase]).toEqual(['AM', 'CBTC', 'dwell']);
    const fault = sim.faults.find(f => f.kind === 'trainDto')!;
    expect(sim.command({ c: 'repair', fault: fault.id }).ok).toBe(true);
    expect(tr.dtoInhibit).toBe('');
    for (let i = 0; i < 6000 && tr.mode === 'AM'; i++) sim.step();
    expect([tr.mode, tr.level]).toEqual(['DTO', 'CBTC']);
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it('line-wide ATO: trains change to AM at their stops, drivers change ends at turnbacks, and DTO comes back', () => {
    const sim = make(); advance(sim, 9000);
    expect(sim.command({ c: 'lineAto', on: true }).ok).toBe(true);
    expect(sim.command({ c: 'lineAto', on: true }).ok).toBe(false);
    let reversals = 0;
    for (let i = 0; i < 9000; i++) {
      sim.step();
      for (const t of sim.trainList) if (t.phase === 'reversing' && t.phaseSince === sim.t) {
        const task = t.tasks[0];
        if (task?.k === 'reverse' && t.mode === 'AM') {
          reversals++;
          // Paper whole-turn increments include one/two 20s door departures:
          // front 30-20=10s, rear 67.5-40=27.5s at the reversal itself.
          const increment = sim.topo.berths[task.chosen].kind === 'platform' ? 10 : 27.5;
          expect(t.dwellUntil - sim.t).toBeCloseTo(task.minTime + increment, 6);
        }
      }
    }
    expect(reversals).toBeGreaterThan(0);
    const cbtc = sim.trainList.filter(t => t.inService && t.level === 'CBTC' && !t.manual);
    expect(cbtc.length).toBeGreaterThan(10);
    expect(cbtc.every(t => t.mode === 'AM')).toBe(true);
    expect(sim.command({ c: 'lineAto', on: false }).ok).toBe(true);
    advance(sim, 600);
    expect(sim.trainList.filter(t => t.inService && t.level === 'CBTC' && !t.manual).every(t => t.mode === 'DTO')).toBe(true);
    expect(sim.integrity.violations).toHaveLength(0);
  }, 240_000);
  it('starts an operating day in ATO operation on the same plan', () => {
    const dto = make();
    const ato = new Sim({ dayType: 'weekday', dateLabel: 'core', startTime: 14400, seed: 7, noPossessions: true, driveMode: 'ATO' });
    expect(ato.atoLine).toBe(true);
    expect(ato.plan.trips.length).toBe(dto.plan.trips.length);
    advance(ato, 3600);
    expect(ato.trainList.filter(t => t.level === 'CBTC').every(t => t.mode === 'AM')).toBe(true);
    expect(MODE.states).toContain('AM-C');
  });
});

describe('audit hardening (D54)', () => {
  it('section fault unlock never releases a lock that still protects a train', () => {
    const sim = make(); advance(sim, 9000);
    // a section a train stands on or occupies
    const occ = sim.sec.findIndex(x => x.trainOcc && x.lockRoute >= 0);
    if (occ >= 0) expect(sim.command({ c: 'sectionUnlock', section: occ }).ok).toBe(false);
    // the route ahead of a running train (authority issued over it)
    const tr = sim.trainList.find(t => t.phase === 'run' && t.v > 5 && t.maSigs.some(sg => sim.sig[sg].route >= 0))!;
    const route = sim.topo.routes[sim.sig[tr.maSigs.find(sg => sim.sig[sg].route >= 0)!].route];
    const free = route.sections.find(x => !sim.sec[x].trainOcc && sim.sec[x].lockRoute === route.id)!;
    expect(sim.command({ c: 'sectionUnlock', section: free }).ok).toBe(false);
    expect(sim.sec[free].lockRoute).toBe(route.id);
    // a residual lock with no train anywhere near is released, and logged
    for (const t of [...sim.trainList]) sim.removeTrain(t);
    for (const id of [...sim.routes.keys()]) releaseRoute(sim, id);
    for (const x of sim.sec) { x.occ = false; x.trainOcc = false; }
    const r = sim.topo.routes.find(x => !x.fleeting && x.sections.length > 1)!;
    expect(trySetRoute(sim, r.id).ok).toBe(true);
    const last = r.sections.at(-1)!;
    expect(sim.command({ c: 'sectionUnlock', section: last }).ok).toBe(true);
    expect(sim.sec[last].lockRoute).toBe(-1);
    expect(sim.events.some(e => e.text.includes('区段故障解锁'))).toBe(true);
  });
  it('a train failing on the move brakes to a stand under its EB', () => {
    const sim = make(); advance(sim, 9000);
    const tr = sim.trainList.find(t => t.phase === 'run' && t.v > 15 && !t.failed)!;
    const v0 = tr.v;
    expect(sim.command({ c: 'fault', kind: 'trainFail', target: tr.id, duration: 0, recoverable: false }).ok).toBe(true);
    expect([tr.failed, tr.eb, tr.phase]).toEqual([true, true, 'run']);
    expect(tr.v).toBe(v0);
    const t0 = sim.t;
    for (let i = 0; i < 600 && tr.phase === 'run'; i++) sim.step();
    expect(tr.phase).toBe('failed');
    expect(tr.v).toBe(0);
    expect(sim.t - t0).toBeGreaterThan(v0 / 2);
    expect(sim.integrity.violations).toHaveLength(0);
  });
  it('an EB from a ZC failure is released only after the ZC recovers or the train degrades to TBTC', () => {
    const sim = make(); advance(sim, 9000);
    const tr = sim.trainList.find(t => t.phase === 'run' && t.v > 5 && t.level === 'CBTC')!;
    const zone = sim.topo.links[tr.link].zone;
    expect(sim.command({ c: 'fault', kind: 'zcFail', target: zone, duration: 0 }).ok).toBe(true);
    for (let i = 0; i < 600 && !(tr.eb && tr.v <= 0.01); i++) sim.step();
    expect(tr.ebCause).toBe('zc');
    expect(ebCauseCleared(sim, tr)).toBe(false);
    expect(authoriseEBRelease(sim, tr, '调度').ok).toBe(false);
    expect(tr.eb).toBe(true);
    expect(answerEbRelease(sim, tr, 'degrade').ok).toBe(true);
    expect(tr.eb).toBe(false);
    advance(sim, 15);
    expect(tr.level).toBe('TBTC');
  });
  it('reads only real operating-day times', () => {
    expect(parseTime('07:40')).toBe(27600);
    expect(parseTime('7')).toBe(25200);
    expect(parseTime('01:00')).toBe(90000);
    for (const bad of ['Infinity', 'Infinity:00', '1e9', '30:00', '07:75', '', 'NaN']) expect(parseTime(bad)).toBeNaN();
  });
});

describe('ARS rule conflicts', () => {
  it('creeps the last five metres to a stop within its short red-signal authority, opens and resumes', () => {
    const sim = make(); advance(sim, 2); const tr = sim.trainList[0];
    for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
    for (const rid of [...sim.routes.keys()]) releaseRoute(sim, rid);
    for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
    const station = sim.topo.stations.at(-1)!, berth = sim.topo.berths[platformBerth(sim.topo, station.index, 'DN')];
    const turn = turnbackAt(sim.topo, station.index, 'DN')!; expect(turn.kind).toBe('rear');
    if (turn.kind !== 'rear') return;
    Object.assign(tr, {link:berth.link,off:berth.offset-berth.dir*5.6,dir:berth.dir,hist:[{link:berth.link,dir:berth.dir}],
      v:0,a:0,eb:false,phase:'run',mode:'DTO',manual:false,block:-1,tripId:-1,inService:true,hold:false,
      tbStage:'none',depotStage:'none',lastMa:Infinity,lastDs:0,maDist:0,maFar:0,maSigs:[],doorsOpen:false});
    tr.tasks=[{k:'stop',berth:berth.id,station:station.index,trip:-1,arr:null,dep:sim.t+30,doors:true,revenue:true},
      {k:'reverse',station:station.index,berths:turn.berths,chosen:turn.berths[0],minTime:40},
      {k:'stop',berth:platformBerth(sim.topo,station.index,'UP'),station:station.index,trip:-1,arr:null,dep:null,doors:true,revenue:true}];
    computeBody(sim,tr);indexBodies(sim);computeOccupancy(sim);
    const scan=scanAhead(sim,tr,berth.id);expect(scan.stopDist).toBeCloseTo(5.6,1);expect(scan.maDist).toBeLessThan(15);expect(scan.maDist).toBeGreaterThan(scan.stopDist);
    tr.stopDist=scan.stopDist;tr.maDist=scan.maDist;tr.maCode=scan.maCode;updateHalts(sim);expect(tr.halt.code).toBe('STOP_POINT');
    expect(trainDesire(sim,tr)).toBeNull();
    const startStops=tr.stopsMade;let opened=false;
    const end=sim.t+300;while(sim.t<end&&(!opened||tr.tasks[0]?.k==='stop')){sim.step();opened ||= tr.doorsOpen;}
    expect(opened).toBe(true);expect(tr.stopsMade).toBeGreaterThan(startStops);expect(tr.tasks[0]?.k).not.toBe('stop');
    expect(sim.integrity.violations).toHaveLength(0);
  });
  const sharedLead = () => {
    const sim=make();advance(sim,2);const [exit,arrival]=sim.trainList;
    for(const other of [...sim.trainList])if(other!==exit&&other!==arrival)sim.removeTrain(other);
    for(const rid of [...sim.routes.keys()])releaseRoute(sim,rid);
    sim.resourceTransit.clear();for(const block of sim.plan.blocks)sim.blockDone.add(block.id);
    const depot=sim.topo.depots.find(d=>d.transferPaths.some(p=>p.flow==='shared')&&d.portals.entry.UP.reverse)!;
    const path=depot.transferPaths.find(p=>p.flow==='shared')!,goal=platformBerth(sim.topo,depot.station,'UP');
    const table=sim.routeTable.next.get(goal)!;
    const signal=sim.topo.signals.filter(s=>s.station===depot.station&&s.dir===-1&&sim.topo.links[s.link].track==='UP')
      .find(s=>table[s.id]>=0&&sim.topo.links[s.link].chainA>sim.topo.stations[depot.station].chain+100)!;
    const route=table[signal.id],approach=sim.topo.links.find(l=>l.a===signal.node&&l.track==='UP')!;
    Object.assign(exit,{link:path.stub,off:sim.topo.links[path.stub].len-10,dir:1,hist:[{link:path.stub,dir:1}],v:0,phase:'run',block:-1,tripId:-1});
    exit.tasks=[{k:'stop',berth:goal,station:depot.station,trip:-1,arr:null,dep:null,doors:false,revenue:false}];computeBody(sim,exit);
    Object.assign(arrival,{link:approach.id,off:Math.min(approach.len-1,200),dir:-1,hist:[{link:approach.id,dir:-1}],v:0,phase:'run',block:-1,tripId:-1,
      nextSignal:signal.id,nextSignalDist:200,stopDist:Infinity});
    arrival.tasks=[{k:'stop',berth:goal,station:depot.station,trip:-1,arr:null,dep:null,doors:false,revenue:false},
      {k:'reverse',berths:[goal],chosen:goal,station:depot.station,minTime:40},{k:'depot',depot:depot.id}];computeBody(sim,arrival);
    indexBodies(sim);computeOccupancy(sim);
    const result=trySetRoute(sim,route,{train:exit.id});expect(result.ok,result.msg).toBe(true);
    return {sim,exit,arrival,signal,route};
  };
  it('leaves the departure route intact while the returning train yields on a shared depot lead',()=>{
    const {sim,exit,arrival,signal,route}=sharedLead();const active=sim.routes.get(route)!;
    expect(active.arsTrain).toBe(exit.id);expect(active.owner).toBe(-1);
    arbitrateResources(sim);
    const desire=trainDesire(sim,arrival);expect(desire?.ready).toBe(false);expect(arrival.arsWait?.train).toBe(exit.id);
    expect(sim.sig[signal.id].route).toBe(route);expect(active.cancelAt).toBe(0);expect(sim.integrity.violations).toHaveLength(0);
    expect(cancelArsRoute(sim,arrival,signal.id).ok).toBe(false);
  });
  it('audits an accepted foreign ARS cancellation immediately, but permits dispatcher and fault cancellation',()=>{
    for(const source of ['ars','dispatcher','fault','recovery'] as const){
      const {sim,exit,arrival,signal}=sharedLead();
      expect(cancelRoute(sim,signal.id,{source,train:arrival.id}).ok).toBe(true);
      if(source==='ars'){expect(sim.integrity.violations[0]).toMatchObject({kind:'ARS_FOREIGN_CANCEL',t:sim.t,trains:[arrival.id,exit.id]});expect(sim.integrity.violations[0].detail).toContain(signal.name);}
      else expect(sim.integrity.violations).toHaveLength(0);
    }
  });
});

it('the applicant relinquishes an unused reservation when a physical front train needs another route',()=>{
  const sim=make();advance(sim,2);const [front,rear]=sim.trainList;
  for(const other of [...sim.trainList])if(other!==front&&other!==rear)sim.removeTrain(other);
  for(const rid of [...sim.routes.keys()])releaseRoute(sim,rid);
  const {signal,link}=depotApproach(sim),depot=sim.topo.depots[0],goal=platformBerth(sim.topo,3,'UP');
  for(const [tr,off]of [[front,6.1],[rear,Math.min(212.1,link.len-.1)]]as const){
    Object.assign(tr,{link:link.id,off,dir:-1,hist:[{link:link.id,dir:-1}],v:0,eb:false,phase:'run',block:-1,tripId:-1,
      nextSignal:signal.id,nextSignalDist:off,stopDist:Infinity});computeBody(sim,tr);
  }
  front.tasks=[{k:'stop',berth:goal,station:3,trip:-1,arr:sim.t+100,dep:null,doors:false,revenue:false}];
  rear.tasks=[{k:'depot',depot:depot.id}];indexBodies(sim);computeOccupancy(sim);
  const old=sim.routeTable.next.get(depot.berth)![signal.id],next=sim.routeTable.next.get(goal)![signal.id];
  expect(old).not.toBe(next);expect(trySetRoute(sim,old,{train:rear.id}).ok).toBe(true);
  expect(cancelArsRoute(sim,front,signal.id).ok).toBe(false);
  runARS(sim);
  expect(sim.sig[signal.id].route).toBe(next);expect(sim.routes.get(next)?.arsTrain).toBe(front.id);
  expect(sim.integrity.violations).toHaveLength(0);
});

describe('whole-movement halt reason scope', () => {
  const stoppedAtEntry = () => {
    const sim = make(); advance(sim, 2);
    const tr = sim.trainList[0];
    const route = sim.topo.routes.find(r => r.start !== r.end && r.end >= 0 && sim.topo.signals[r.end].routes.length)!;
    expect(route).toBeDefined();
    Object.assign(tr, { phase: 'run', v: 0, eb: false, pendingMode: null, stopUntil: 0,
      hold: false, manual: false, doorsOpen: false, doorSide: '', doorLockedAt: 0,
      reverser: 1, retreat: null, maDist: 0, maCode: 'ROUTE_WAIT', maTrain: -1,
      maReason: '信号/进路未开放', nextSignal: route.start, stopDist: Infinity });
    sim.sig[route.start].ars = true;
    return { sim, tr, entrance: route.start, downstream: route.end };
  };

  it('retains a fresh downstream device cause within the current complete-movement entrance', () => {
    const { sim, tr, entrance, downstream } = stoppedAtEntry();
    for (const manual of [false, true]) {
      tr.manual = manual;
      tr.arsWait = { code: 'AXLE_PRESET', train: -1, signal: downstream,
        entrySignal: entrance, t: sim.t - 2.5, detail: '下游计轴预复位待压道' };
      updateHalts(sim);
      expect(tr.halt).toMatchObject({ code: 'AXLE_PRESET', train: -1, detail: '下游计轴预复位待压道' });
      expect(tr.arsWait.signal).toBe(downstream);
      expect(tr.arsWait.entrySignal).toBe(entrance);
    }
  });

  it.each([0, 2.5])('retains the existing no-next-signal ARS explanation while it is %s seconds old', age => {
    const { sim, tr, entrance, downstream } = stoppedAtEntry();
    tr.nextSignal = -1;
    for (const manual of [false, true]) {
      tr.manual = manual;
      tr.arsWait = { code: 'AXLE_PRESET', train: -1, signal: downstream,
        entrySignal: entrance, t: sim.t - age, detail: '前方无信号时仍保留计轴预复位原因' };
      updateHalts(sim);
      expect(tr.halt).toMatchObject({ code: 'AXLE_PRESET', train: -1,
        detail: '前方无信号时仍保留计轴预复位原因' });
    }
  });

  it.each([-0.1, 2.6])('rejects a no-next-signal ARS explanation outside the freshness window (%s seconds old)', age => {
    const { sim, tr, entrance } = stoppedAtEntry();
    tr.nextSignal = -1;
    for (const manual of [false, true]) {
      tr.manual = manual;
      tr.arsWait = { code: 'AXLE_PRESET', train: -1, signal: entrance, t: sim.t - age, detail: '无效时刻的设备原因' };
      updateHalts(sim);
      expect(tr.halt.code).toBe('ROUTE_WAIT');
    }
  });

  it.each(['ROUTE_WAIT', 'ROUTE_MISMATCH'] as const)('merges %s into the same ARS cause during manual driving without a traction hold', code => {
    const { sim, tr, entrance } = stoppedAtEntry();
    tr.manual = true; tr.maCode = code;
    tr.arsWait = { code: 'REGULATION', train: sim.trainList[1].id, signal: entrance,
      t: sim.t, detail: '按图先发列车先进入始发站台' };
    updateHalts(sim);
    expect(tr.halt).toMatchObject({ code: 'REGULATION', train: sim.trainList[1].id,
      detail: '按图先发列车先进入始发站台' });
  });

  it('keeps a real manual traction hold ahead of an otherwise applicable ARS reason', () => {
    const { sim, tr, entrance } = stoppedAtEntry();
    tr.manual = true; tr.doorsOpen = true;
    tr.arsWait = { code: 'AXLE_PRESET', train: -1, signal: entrance, t: sim.t, detail: '计轴预复位' };
    updateHalts(sim);
    expect(tr.halt).toMatchObject({ code: 'MANUAL', train: -1, detail: '等待车门关闭' });
  });

  it.each(['expired', 'future', 'other-entrance', 'unscoped-downstream'] as const)('rejects %s ARS explanations in both driving modes', reason => {
    const { sim, tr, entrance, downstream } = stoppedAtEntry();
    for (const manual of [false, true]) {
      tr.manual = manual;
      tr.arsWait = { code: 'AXLE_PRESET', train: -1, signal: entrance, t: sim.t, detail: '无关设备' };
      if (reason === 'expired') tr.arsWait.t = sim.t - 2.6;
      if (reason === 'future') tr.arsWait.t = sim.t + .1;
      if (reason === 'other-entrance') tr.arsWait.entrySignal = downstream;
      if (reason === 'unscoped-downstream') tr.arsWait.signal = downstream;
      updateHalts(sim);
      expect(tr.halt.code).toBe('ROUTE_WAIT');
    }
  });

  it('uses the same entrance and freshness guard when dwell has actually finished', () => {
    const { sim, tr, entrance, downstream } = stoppedAtEntry();
    const berth = sim.topo.berths.find(b => b.platform >= 0)!;
    tr.tasks = [{ k: 'stop', berth: berth.id, station: berth.station, trip: -1,
      arr: sim.t - 60, dep: sim.t - 1, doors: false, revenue: false }];
    Object.assign(tr, { phase: 'dwell', dwellUntil: sim.t - 1, atoDriver: false, manual: false,
      doorsAwait: false, mode: 'DTO', intervalWait: null });
    tr.arsWait = { code: 'AXLE_PRESET', train: -1, signal: downstream,
      entrySignal: entrance, t: sim.t, detail: '下游计轴预复位待压道' };
    updateHalts(sim);
    expect(tr.halt.code).toBe('AXLE_PRESET');
    tr.arsWait.entrySignal = downstream;
    updateHalts(sim);
    expect(tr.halt.code).toBe('ROUTE_WAIT');
  });
});
