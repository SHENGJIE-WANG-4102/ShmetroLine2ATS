import { describe, it, expect } from 'vitest';
import { Sim } from '../src/sim/engine';
import type { StopTask } from '../src/sim/model';
import { computeBody, indexBodies } from '../src/sim/movement';
import { computeOccupancy, trySetRoute, updateInterlocking } from '../src/sim/interlocking';
import { intervalDepartureHold, runARS } from '../src/sim/ats';
import { arbitrateResources, routeResourceBlocker } from '../src/sim/resourceArbitration';

function fixture() {
  const sim = new Sim({dayType:'weekday',date:'2026-10-19',dateLabel:'interval readiness',startTime:14400,seed:111,noPossessions:true});
  const [main, middle] = sim.trainList;
  for (const tr of [...sim.trainList]) if (tr !== main && tr !== middle) sim.removeTrain(tr);
  for (const rid of [...sim.routes.keys()]) sim.routes.has(rid) && sim.command({c:'cancelRoute',signal:sim.topo.routes[rid].start});
  // No initial route has approaching authority in the cold fixture.
  expect(sim.routes.size).toBe(0);
  for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
  sim.t = 38841;
  const stop = (berth:number, station:number): StopTask => ({k:'stop',berth,station,trip:-1,arr:null,dep:null,doors:false,revenue:false,minDwell:10});
  const common = {len:186,v:0,a:0,block:-1,tripId:-1,inService:false,mode:'DTO',level:'CBTC',forceLevel:'AUTO',manual:false,failed:false,comm:true,
    eb:false,ebCause:'',maCut:false,pendingMode:null,pendingLevel:null,doorsOpen:false,doorsAwait:false,doorSide:'',doorMotion:null,
    hold:false,reverser:1,retreat:null,tbStage:'none',maSigs:[],lastMa:0,lastDs:0,lastStation:22,pendingDeparture:undefined};
  Object.assign(main, common, {link:377,off:6.4,dir:-1,hist:[{link:377,dir:-1}],phase:'run',phaseSince:38727.7,
    maDist:.4,maFar:.4,maCode:'ROUTE_WAIT',maTrain:-1,nextSignal:105,nextSignalDist:6.4});
  main.tasks = [stop(87,21),stop(83,20)];
  Object.assign(middle, common, {link:587,off:12,dir:-1,hist:[{link:587,dir:-1}],phase:'dwell',phaseSince:38773,
    dwellUntil:38783,depReadyAt:38783,maDist:6,maFar:6,maCode:'ROUTE_WAIT',maTrain:-1,nextSignal:260,nextSignalDist:12});
  middle.tasks = [stop(125,22),stop(87,21),stop(83,20)];
  // The cab change already used the middle platform. Retain that carried
  // geometry while the native collector builds its separate departure.
  sim.resourceTransit.set(middle.id,{entered:true,visited:true,option:{
    phases:[{goal:87,start:{link:587,off:12,dir:-1},routes:[331,289],distance:2056.9625714304607,
      path:[{link:587,from:12,to:0},{link:586,from:50,to:0},{link:584,from:15,to:0},
        {link:589,from:0,to:sim.topo.links[589].len},{link:590,from:0,to:sim.topo.links[590].len},
        {link:374,from:15,to:0},{link:373,from:431.25,to:239.25}]}],
    sections:new Set([460,459,457,342,341]),choices:[],entry:-1,resourceLinks:new Set([587]),
  }});
  for (const tr of [main,middle]) computeBody(sim,tr);
  indexBodies(sim);computeOccupancy(sim);
  for (const sw of sim.topo.routes[331].switches) Object.assign(sim.sw[sw.sw], {pos:sw.pos,target:sw.pos,moveUntil:0});
  expect(trySetRoute(sim,331,{train:middle.id}).ok).toBe(true);
  updateInterlocking(sim);
  middle.intervalWait = intervalDepartureHold(sim,middle,middle.tasks[0] as StopTask);
  expect(middle.intervalWait?.train).toBe(main.id);
  expect(sim.integrity.violations).toEqual([]);
  return {sim,main,middle};
}

describe('resource source readiness respects its existing physical interval predecessor', () => {
  it('keeps a safe waiting departure from claiming the exit needed by its real predecessor', () => {
    const {sim,main,middle} = fixture();
    const allocation = arbitrateResources(sim), decision = allocation.decisions.get(middle.id)!;
    expect(allocation.decisions.has(main.id)).toBe(false);
    expect(decision.request.safeHere).toBe(true);
    expect(decision.request.inside).toBe(true);
    expect(decision.admitted).toBe(false);
    expect(decision.code).toBe('INTERVAL_LIMIT');
    expect(decision.blocker).toBe(main.id);
    expect(decision.detail).toBe(middle.intervalWait!.detail);
    expect(allocation.claims.get(342)?.request.id).not.toBe(middle.id);
    expect(routeResourceBlocker(sim,main,132)).toBeUndefined();
    runARS(sim);
    expect(sim.routes.has(331)).toBe(false);
    expect(sim.sig[105].route).toBe(132);
    expect(middle.eb).toBe(false);
    expect(sim.integrity.violations).toEqual([]);
  });

  it('preserves the clearing grant of a consist already in an unsafe resource', () => {
    const {sim,middle,main} = fixture();
    Object.assign(middle,{link:586,off:25,dir:-1,hist:[{link:587,dir:-1},{link:586,dir:-1}],phase:'run'});
    middle.tasks.shift();
    middle.intervalWait = {train:main.id,detail:'carried interval context is not a current safe departure'};
    computeBody(sim,middle);indexBodies(sim);computeOccupancy(sim);
    const allocation = arbitrateResources(sim), decision = allocation.decisions.get(middle.id)!;
    expect(decision.request.inside).toBe(true);
    expect(decision.request.safeHere).toBe(false);
    expect(decision.admitted).toBe(true);
    expect(allocation.claims.get(342)?.request.id).toBe(middle.id);
    expect(middle.eb).toBe(false);
  });

  it('admits the same safe departure normally without an interval wait', () => {
    const {sim,middle} = fixture();middle.intervalWait = undefined;
    const allocation = arbitrateResources(sim), decision = allocation.decisions.get(middle.id)!;
    expect(decision.request.safeHere).toBe(true);
    expect(decision.admitted).toBe(true);
    expect(allocation.claims.get(342)?.request.id).toBe(middle.id);
  });

  it('does not turn the waiting-for-route bootstrap condition into a fictitious predecessor', () => {
    const {sim,middle} = fixture();middle.intervalWait = {train:-1,detail:'等待汇入正线的出站进路'};
    const allocation = arbitrateResources(sim), decision = allocation.decisions.get(middle.id)!;
    expect(decision.request.safeHere).toBe(true);
    expect(decision.admitted).toBe(true);
  });
});

describe('physical interval predecessor survives the missing-route bootstrap', () => {
  function withoutSourceRoute() {
    const scene = fixture();
    expect(scene.sim.command({c:'cancelRoute',signal:260}).ok).toBe(true);
    expect(scene.sim.routes.has(331)).toBe(false);
    expect(scene.sim.sig[260].route).toBe(-1);
    return scene;
  }

  it('reports the actual full-capacity predecessor even when the source route is absent', () => {
    const {sim,main,middle} = withoutSourceRoute();
    expect(main.phase).toBe('run');
    expect(main.v).toBe(0);
    expect(main.lastStation).toBe(22);
    expect(main.tasks[0]).toMatchObject({k:'stop',station:21});
    expect(intervalDepartureHold(sim,middle,middle.tasks[0] as StopTask)).toEqual({
      train:main.id,detail:'广兰路—金科路 1/1列',
    });
    expect(sim.sig[260].route).toBe(-1);
    expect(sim.integrity.violations).toEqual([]);
  });

  it('retains the route bootstrap when the blocked interval is below capacity', () => {
    const {sim,main,middle} = withoutSourceRoute();
    sim.removeTrain(main);
    indexBodies(sim);computeOccupancy(sim);
    const targetPlatform = sim.topo.berths[87].platform;
    expect(sim.command({c:'platformHold',platform:targetPlatform,on:true}).ok).toBe(true);
    expect(sim.trainList).toHaveLength(1);
    expect(sim.plat[targetPlatform].hold).toBe(true);
    expect(intervalDepartureHold(sim,middle,middle.tasks[0] as StopTask)).toEqual({
      train:-1,detail:'等待汇入正线的出站进路',
    });
    expect(sim.sig[260].route).toBe(-1);
    expect(sim.integrity.violations).toEqual([]);
  });

  it('does not impose the interval limit on a normally moving predecessor', () => {
    const {sim,main,middle} = withoutSourceRoute();
    main.v = 5;
    expect(main.phase).toBe('run');
    expect(main.failed).toBe(false);
    expect(main.hold).toBe(false);
    expect(sim.plat[sim.topo.berths[87].platform].hold).toBe(false);
    expect(intervalDepartureHold(sim,middle,middle.tasks[0] as StopTask)).toBeUndefined();
    expect(main.v).toBe(5);
    expect(sim.sig[260].route).toBe(-1);
    expect(sim.integrity.violations).toEqual([]);
  });
});
