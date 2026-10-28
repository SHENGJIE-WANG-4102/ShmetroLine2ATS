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

  function fixture(nextDestination:number,currentFrom=24,currentTo=30) {
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
    const current:Trip={id:currentId,no:'1265',dir:'DN',kind:'big',from:currentFrom,to:currentTo,
      stops:timetable.buildStops(sim.planCtx,'DN',currentFrom,currentTo,sim.t,true,1),revenue:true,block:blockId};
    const next:Trip={id:currentId+1,no:'0020',dir:'UP',kind:nextDestination===30?'empty':'big',from:currentTo,to:nextDestination,
      stops:timetable.buildStops(sim.planCtx,'UP',currentTo,nextDestination,sim.t+1200,nextDestination!==30,1),revenue:nextDestination!==30,block:blockId};
    sim.plan.trips.push(current,next);
    // A continuation ending at the western terminal must return to its
    // western depot; reaching the eastern depot needs another real turn.
    sim.plan.blocks.push({id:blockId,svc:'035',start:{kind:'depot',depot:1,time:sim.t-300},end:{kind:'depot',depot:nextDestination===0?0:1},trips:[current.id,next.id]});
    sim.blockDone.add(blockId);
    const tr=ats.newTrain(sim,null,berth.link,berth.offset,berth.dir,[{link:berth.link,dir:berth.dir}],vehicle);
    Object.assign(tr,{block:blockId,svc:'035',tripId:current.id,tripNo:current.no,inService:true,phase:'dwell',phaseSince:sim.t,
      arrivedAt:sim.t,dwellUntil:sim.t,depReadyAt:sim.t,doorsAwait:false,doorsOpen:false,doorLockedAt:sim.t,manual:false,mode:'DTO'});
    sim.plan.blocks[blockId].train=tr.id;
    tr.tasks=[];timetable.tripTasks(sim.topo,current,tr.tasks,false);
    tr.tasks=tr.tasks.filter(t=>t.k!=='stop'||t.station===24||topology.ahead('DN',24,t.station));
    movement.indexBodies(sim);
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
    next.stops.find(s=>s.st===10)!.stop=false;
    next.stops.find(s=>s.st===9)!.noBoard=true;
    expect(sim.command({c:'turnback',train:tr.id,station:25}).ok).toBe(true);
    const adjusted=sim.plan.trips.at(-1)!;
    expect(sim.plan.trips).toHaveLength(beforeTrips+1);
    expect(adjusted).toMatchObject({dir:'UP',kind:'adj',from:25,to:0,revenue:true});
    expect(next.cancelled).toBe(true);
    expect(adjusted.stops.map(s=>s.st)).toEqual(topology.stationRange('UP',25,0));
    expect(adjusted.stops.find(s=>s.st===10)?.stop).toBe(false);
    expect(adjusted.stops.find(s=>s.st===9)?.noBoard).toBe(true);
    const continuation=tr.tasks.filter((t):t is StopTask=>t.k==='stop'&&t.trip===adjusted.id);
    expect(continuation.map(t=>t.station)).toEqual(adjusted.stops.filter(s=>s.stop).map(s=>s.st));
    expect(continuation.find(t=>t.station===9)?.noBoard).toBe(true);
    expect(continuation.every(t=>t.k==='stop'&&t.revenue&&sim.topo.berths[t.berth].dir===sim.topo.berths[timetable.platformBerth(sim.topo,t.station,'UP')].dir)).toBe(true);
  });

  it('changes ends at the west terminal before positioning to a depot beyond the other end (D145)',()=>{
    const {tr}=fixture(0),block=sim.plan.blocks[tr.block];
    // The adjusted passenger run terminates west; the east depot is reached
    // after another change of ends and an eastbound positioning run.
    block.end={kind:'depot',depot:1};
    const result=sim.command({c:'turnback',train:tr.id,station:25});
    expect(result.ok,result.msg).toBe(true);
    const adjusted=sim.plan.trips.at(-1)!;
    const arrival=tr.tasks.findIndex(t=>t.k==='stop'&&t.trip===adjusted.id&&t.station===adjusted.to);
    expect(tr.tasks.findIndex((t,i)=>i>arrival&&t.k==='reverse')).toBeGreaterThan(arrival);
    expect(tr.tasks.at(-1)).toMatchObject({k:'depot',depot:1});
  });

  it('preserves normal berth alternatives at a later planned turn',()=>{
    const {tr}=fixture(0),block=sim.plan.blocks[tr.block];
    const empty:Trip={id:sim.plan.trips.length,no:'0098',dir:'DN',kind:'empty',from:0,to:30,
      stops:timetable.buildStops(sim.planCtx,'DN',0,30,sim.t+8000,false,1),revenue:false,block:block.id};
    sim.plan.trips.push(empty);block.trips.push(empty.id);block.end={kind:'depot',depot:1};
    const result=sim.command({c:'turnback',train:tr.id,station:25});
    expect(result.ok,result.msg).toBe(true);
    const turns=tr.tasks.filter(t=>t.k==='reverse');
    const requested=turns.find(t=>t.station===25)!;
    const later=turns.find(t=>t.station===0)!;
    expect(requested.berths).toEqual([requested.chosen]);
    // Compare to the block's ordinary builder, which remains the source of
    // truth for future choices once the immediate intervention is complete.
    const adjusted=sim.plan.trips.at(-1)!;
    const ordinary=timetable.blockTasks(sim.topo,sim.plan,block,block.trips.indexOf(adjusted.id))
      .find(t=>t.k==='reverse'&&t.station===0);
    expect(ordinary?.k).toBe('reverse');
    if(ordinary?.k!=='reverse')throw Error('missing later turn');
    expect(ordinary.berths.length).toBeGreaterThan(1);
    expect(later.berths).toEqual(ordinary.berths);
  });

  function remainder(direction:'DN'|'UP') {
    const {tr,next}=fixture(5,5,25),block=sim.plan.blocks[tr.block];
    sim.plan.trips[tr.tripId].kind='small';next.kind='small';
    const empty:Trip={id:sim.plan.trips.length,no:'0098',dir:direction,kind:'empty',from:5,to:direction==='UP'?0:25,
      stops:timetable.buildStops(sim.planCtx,direction,5,direction==='UP'?0:25,sim.t+4000,false,1),revenue:false,block:block.id};
    sim.plan.trips.push(empty);block.trips.push(empty.id);block.end={kind:'depot',depot:direction==='UP'?0:1};
    return{tr,next,empty,before:structuredClone(empty)};
  }
  it('continues the adjusted UP service into its original UP positioning trip without changing ends again',()=>{
    const {tr,next,empty,before}=remainder('UP'),probability=data.OPERATIONS.atoRandomOverrunProbability;
    try {
      data.OPERATIONS.atoRandomOverrunProbability=0;
      expect(sim.command({c:'turnback',train:tr.id,station:25}).ok).toBe(true);
      const adjusted=sim.plan.trips.at(-1)!;
      expect(adjusted).toMatchObject({dir:'UP',kind:'adj',from:25,to:5,revenue:true});
      expect(next.cancelled).toBe(true);expect(empty).toEqual(before);
      expect(tr.tasks.some(t=>t.k==='reverse'&&t.station===25)).toBe(true);
      expect(tr.tasks.some(t=>t.k==='reverse'&&t.station===5)).toBe(false);
      const join=tr.tasks.filter((t):t is StopTask=>t.k==='stop'&&t.station===5);
      expect(join).toHaveLength(2);expect(join[0].berth).toBe(join[1].berth);
      expect(join[1]).toMatchObject({trip:empty.id,dep:empty.stops[0].dep,revenue:false});
      let joined=false;
      for(let n=0;n<90000&&sim.trains.has(tr.id);n++){
        sim.step();
        if(tr.tripId===empty.id){joined=true;expect(topology.travelDirection(sim.topo,tr)).toBe('UP');}
      }
      expect(joined).toBe(true);
      expect(sim.trains.has(tr.id),`${tr.halt.detail}; ${tr.arsWait?.detail}; ${tr.tasks[0]?.k}`).toBe(false);
      expect(sim.vehicles.get(tr.vehicle)?.depot).toBe(0);
      expect(sim.integrity.violations).toEqual([]);
    } finally {data.OPERATIONS.atoRandomOverrunProbability=probability;}
  },60000);
  it('retains the real direction change before an opposite-direction remainder',()=>{
    const {tr,empty,before}=remainder('DN');
    expect(sim.command({c:'turnback',train:tr.id,station:25}).ok).toBe(true);
    expect(empty).toEqual(before);
    const turn=tr.tasks.find(t=>t.k==='reverse'&&t.station===5);
    expect(turn?.k).toBe('reverse');
    if(turn?.k!=='reverse')throw new Error('Missing opposite-direction turnback');
    const stop=tr.tasks.find((t):t is StopTask=>t.k==='stop'&&t.trip===empty.id)!;
    expect(stop).toMatchObject({station:5,berth:timetable.platformBerth(sim.topo,5,'DN')});
    expect(turn.berths.some(berth=>{
      const point=topology.reversedBerthPoint(sim.topo,berth,tr.len);if(!point)return false;
      return Number.isFinite(ats.distanceToBerthFrom(sim,point.link,point.off,point.dir,stop.berth));
    })).toBe(true);
  });
  it('retains a stable block ending after replacing the last positioning trip and physically parks there',()=>{
    const {tr,next}=fixture(14),current=sim.plan.trips[tr.tripId],block=sim.plan.blocks[tr.block];
    const berth=sim.topo.berths[timetable.platformBerth(sim.topo,1,'UP')];
    Object.assign(current,{dir:'UP',from:2,to:0,stops:timetable.buildStops(sim.planCtx,'UP',2,0,sim.t,true,1)});
    Object.assign(next,{dir:'DN',kind:'empty',from:0,to:14,revenue:false,
      stops:timetable.buildStops(sim.planCtx,'DN',0,14,sim.t+1200,false,1)});
    // This overnight feeder runs directly to the siding, without stopping
    // at the passenger platform beyond the siding's entrance.
    next.stops=next.stops.map(stop=>({...stop,stop:false}));
    const originalEnding=sim.plan.blocks.find(b=>b.end.kind==='stable'&&b.end.station===14)!.end;
    if(originalEnding.kind!=='stable'||originalEnding.berth===undefined)throw new Error('Missing planned overnight arrival');
    const parking=sim.topo.berths[originalEnding.berth];
    block.end=structuredClone(originalEnding);
    const ending=structuredClone(block.end);
    Object.assign(tr,{link:berth.link,off:berth.offset,dir:berth.dir,hist:[{link:berth.link,dir:berth.dir}],
      recentBody:undefined,lastStation:1});
    tr.tasks=[];timetable.tripTasks(sim.topo,current,tr.tasks,false);
    tr.tasks=tr.tasks.filter(t=>t.k!=='stop'||t.station===1||topology.ahead('UP',1,t.station));
    movement.computeBody(sim,tr);movement.indexBodies(sim);
    const probability=data.OPERATIONS.atoRandomOverrunProbability;
    try {
      data.OPERATIONS.atoRandomOverrunProbability=0;
      expect(sim.command({c:'turnback',train:tr.id,station:0}).ok).toBe(true);
      const adjusted=sim.plan.trips.at(-1)!;
      expect(adjusted).toMatchObject({dir:'DN',kind:'adj',from:0,to:14,revenue:false});
      expect(adjusted.stops.every(s=>!s.stop)).toBe(true);
      expect(tr.tasks.some(t=>t.k==='stop'&&t.trip===adjusted.id)).toBe(false);
      expect(next.cancelled).toBe(true);expect(block.end).toEqual(ending);
      expect(tr.tasks.at(-1)).toMatchObject({k:'stable',station:14,berth:parking.id});
      expect(tr.tasks.some(t=>t.k==='depot')).toBe(false);
      for(let n=0;n<90000&&tr.phase!=='stabled';n++)sim.step();
      expect(tr.phase,JSON.stringify({link:tr.link,off:tr.off,dir:tr.dir,signal:sim.topo.signals[tr.nextSignal]?.name,
        halt:tr.halt,ars:tr.arsWait,task:tr.tasks[0],goal:parking})).toBe('stabled');
      const goal=parking;
      expect(tr.link).toBe(goal.link);expect(Math.abs(tr.off-goal.offset)).toBeLessThanOrEqual(1.5);
      expect(sim.integrity.violations).toEqual([]);
    } finally {data.OPERATIONS.atoRandomOverrunProbability=probability;}
  },60000);
});
