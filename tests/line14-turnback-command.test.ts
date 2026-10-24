import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Sim as Simulator} from '../src/sim/engine';
import type {Checkpoint} from '../src/sim/state';
import type {StopTask,Trip} from '../src/sim/model';

describe('line 14 dispatcher turnback continuation',()=>{
  let sim:Simulator,base:Checkpoint;
  let ats:typeof import('../src/sim/ats'),state:typeof import('../src/sim/state');
  let timetable:typeof import('../src/sim/timetable'),movement:typeof import('../src/sim/movement');
  let topology:typeof import('../src/sim/topology'),data:typeof import('../src/data/current');
  beforeAll(async()=>{
    vi.stubEnv('ATS_LINE','14');vi.resetModules();
    const {Sim}=await import('../src/sim/engine');
    ats=await import('../src/sim/ats');state=await import('../src/sim/state');
    timetable=await import('../src/sim/timetable');movement=await import('../src/sim/movement');
    topology=await import('../src/sim/topology');data=await import('../src/data/current');
    sim=new Sim({dayType:'weekend',date:'2026-10-24',dateLabel:'turnback',startTime:14400,seed:71,noPossessions:true,autoRadio:true,autoDispatch:false});
    base=state.capture(sim);
  },120000);
  beforeEach(()=>{state.restore(sim,base);sim.startState=null;});
  afterAll(()=>{vi.unstubAllEnvs();vi.resetModules();});

  function fixture(nextDestination:number) {
    for(const tr of [...sim.trainList])sim.removeTrain(tr);
    for(const block of sim.plan.blocks)sim.blockDone.add(block.id);
    const berth=sim.topo.berths[timetable.platformBerth(sim.topo,24,'DN')];
    const vehicle=[...sim.vehicles.keys()][0],record=sim.vehicles.get(vehicle)!;
    for(const [i,yard]of sim.yards.entries()){
      for(const track of yard.tracks){const index=track.indexOf(vehicle);if(index>=0)track.splice(index,1);}
      sim.depotStock[i]=yard.tracks.flat().length;
    }
    record.depot=-1;record.uto={stage:'ready',until:0,cycles:0,lastTakeoverDay:sim.config.date};
    const blockId=sim.plan.blocks.length,currentId=sim.plan.trips.length;
    const current:Trip={id:currentId,no:'1265',dir:'DN',kind:'big',from:24,to:30,
      stops:timetable.buildStops(sim.planCtx,'DN',24,30,sim.t,true,1),revenue:true,block:blockId};
    const next:Trip={id:currentId+1,no:'0020',dir:'UP',kind:nextDestination===30?'empty':'big',from:30,to:nextDestination,
      stops:timetable.buildStops(sim.planCtx,'UP',30,nextDestination,sim.t+1200,nextDestination!==30,1),revenue:nextDestination!==30,block:blockId};
    sim.plan.trips.push(current,next);
    sim.plan.blocks.push({id:blockId,svc:'035',start:{kind:'depot',depot:1,time:sim.t-300},end:{kind:'depot',depot:1},trips:[current.id,next.id]});
    sim.blockDone.add(blockId);
    const tr=ats.newTrain(sim,null,berth.link,berth.offset,berth.dir,[{link:berth.link,dir:berth.dir}],vehicle);
    Object.assign(tr,{block:blockId,svc:'035',tripId:current.id,tripNo:current.no,inService:true,phase:'dwell',phaseSince:sim.t,
      arrivedAt:sim.t,dwellUntil:sim.t,depReadyAt:sim.t,doorsAwait:false,doorsOpen:false,doorLockedAt:sim.t,manual:false,mode:'DTO'});
    sim.plan.blocks[blockId].train=tr.id;
    tr.tasks=[];timetable.tripTasks(sim.topo,current,tr.tasks,false);movement.indexBodies(sim);
    return {tr,next,beforeTrips:sim.plan.trips.length};
  }

  it('turns back and returns to depot when the next empty positioning trip lies behind the new direction',()=>{
    const {tr,next,beforeTrips}=fixture(30),probability=data.OPERATIONS.atoRandomOverrunProbability;
    try{
      data.OPERATIONS.atoRandomOverrunProbability=0;
      expect(sim.command({c:'turnback',train:tr.id,station:25}).ok).toBe(true);
      expect(sim.plan.trips).toHaveLength(beforeTrips);
      expect(next.cancelled).not.toBe(true);expect(next.revenue).toBe(false);
      expect(tr.tasks.filter((t):t is StopTask=>t.k==='stop'&&t.revenue).map(t=>t.station)).toEqual([24,25]);
      expect(tr.tasks.some(t=>t.k==='reverse'&&t.station===25)).toBe(true);
      expect(tr.tasks.at(-1)?.k).toBe('depot');
      let reversed=false;
      for(let n=0;n<60000&&sim.trains.has(tr.id);n++){
        sim.step();
        if(topology.travelDirection(sim.topo,tr)==='UP')reversed=true;
      }
      expect(reversed).toBe(true);
      expect(sim.trains.has(tr.id),`${tr.halt.detail}; ${tr.arsWait?.detail}; ${tr.tasks[0]?.k}`).toBe(false);
      expect(sim.vehicles.get(tr.vehicle)?.depot).toBe(ats.nearestDepot(sim,25,'UP'));
      expect(sim.integrity.violations).toEqual([]);
    }finally{data.OPERATIONS.atoRandomOverrunProbability=probability;}
  },60000);

  it('keeps the existing adjusted passenger continuation when its destination is ahead after turning back',()=>{
    const {tr,next,beforeTrips}=fixture(0);
    expect(sim.command({c:'turnback',train:tr.id,station:25}).ok).toBe(true);
    const adjusted=sim.plan.trips.at(-1)!;
    expect(sim.plan.trips).toHaveLength(beforeTrips+1);
    expect(adjusted).toMatchObject({dir:'UP',kind:'adj',from:25,to:0,revenue:true});
    expect(next.cancelled).toBe(true);
    expect(adjusted.stops.map(s=>s.st)).toEqual(topology.stationRange('UP',25,0));
    const continuation=tr.tasks.filter((t):t is StopTask=>t.k==='stop'&&t.trip===adjusted.id);
    expect(continuation.map(t=>t.station)).toEqual(adjusted.stops.filter(s=>s.stop).map(s=>s.st));
    expect(continuation.every(t=>t.k==='stop'&&t.revenue&&sim.topo.berths[t.berth].dir===sim.topo.berths[timetable.platformBerth(sim.topo,t.station,'UP')].dir)).toBe(true);
  });
});
