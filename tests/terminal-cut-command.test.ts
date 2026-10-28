import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Sim as Simulator} from '../src/sim/engine';
import type {Checkpoint} from '../src/sim/state';
import type {Trip} from '../src/sim/model';

describe('runtime trip cut through dispatcher turnback',()=>{
  let sim:Simulator,base:Checkpoint;
  let ats:typeof import('../src/sim/ats'),state:typeof import('../src/sim/state');
  let timetable:typeof import('../src/sim/timetable'),movement:typeof import('../src/sim/movement');
  let diagnostics:typeof import('../src/sim/diagnostics');
  let day:typeof import('../src/sim/operatingDay');
  let Sim:typeof import('../src/sim/engine').Sim;
  beforeAll(async()=>{
    vi.stubEnv('ATS_LINE','14');vi.resetModules();
    ({Sim}=await import('../src/sim/engine'));
    day=await import('../src/sim/operatingDay');
    ats=await import('../src/sim/ats');state=await import('../src/sim/state');
    timetable=await import('../src/sim/timetable');movement=await import('../src/sim/movement');
    diagnostics=await import('../src/sim/diagnostics');
    sim=new Sim({dayType:'weekend',date:'2026-10-24',dateLabel:'cut',startTime:14400,seed:71,noPossessions:true,autoRadio:true,autoDispatch:false});
    base=state.capture(sim);
  },120000);
  beforeEach(()=>{state.restore(sim,base);sim.startState=null;});
  afterAll(()=>{vi.unstubAllEnvs();vi.resetModules();});
  function fixture(){
    for(const tr of [...sim.trainList])sim.removeTrain(tr);
    for(const b of sim.plan.blocks)sim.blockDone.add(b.id);
    const berth=sim.topo.berths[timetable.platformBerth(sim.topo,24,'DN')];
    const vehicle=[...sim.vehicles.keys()][0],record=sim.vehicles.get(vehicle)!;
    for(const [i,yard] of sim.yards.entries()){
      for(const track of yard.tracks){const index=track.indexOf(vehicle);if(index>=0)track.splice(index,1);}
      sim.depotStock[i]=yard.tracks.flat().length;
    }
    record.depot=-1;record.uto={stage:'ready',until:0,cycles:0,lastTakeoverDay:sim.config.date};
    const block=sim.plan.blocks.length,id=sim.plan.trips.length;
    const current:Trip={id,no:'1265',dir:'DN',kind:'big',from:24,to:30,
      stops:timetable.buildStops(sim.planCtx,'DN',24,30,sim.t,true,1),revenue:true,block};
    const next:Trip={id:id+1,no:'0020',dir:'UP',kind:'big',from:30,to:0,
      stops:timetable.buildStops(sim.planCtx,'UP',30,0,sim.t+1200,true,1),revenue:true,block};
    sim.plan.trips.push(current,next);
    sim.plan.blocks.push({id:block,svc:'035',start:{kind:'depot',depot:1,time:sim.t-300},end:{kind:'depot',depot:0},trips:[id,id+1]});
    sim.blockDone.add(block);
    const tr=ats.newTrain(sim,null,berth.link,berth.offset,berth.dir,[{link:berth.link,dir:berth.dir}],vehicle);
    Object.assign(tr,{block,svc:'035',tripId:id,tripNo:current.no,inService:true,phase:'dwell',phaseSince:sim.t,
      arrivedAt:sim.t,dwellUntil:sim.t,depReadyAt:sim.t,doorsAwait:false,doorsOpen:false,doorLockedAt:sim.t,manual:false,mode:'DTO'});
    sim.plan.blocks[block].train=tr.id;
    tr.tasks=[];timetable.tripTasks(sim.topo,current,tr.tasks,false);movement.indexBodies(sim);
    return {tr,current};
  }
  it('preserves the original diagram and checkpoint while recording a cut through command/replay',()=>{
    const {tr,current}=fixture(), original=structuredClone(current.stops),rev=sim.planRev;
    const checkpoint=state.capture(sim);sim.startState=checkpoint;
    const cmd={c:'turnback' as const,train:tr.id,station:25};
    expect(sim.command(cmd).ok).toBe(true);
    expect(current.cut).toEqual({station:25,stopIndex:1,cause:'turnback'});
    expect(current.stops).toEqual(original);expect(sim.planRev).toBeGreaterThan(rev);
    expect(sim.inputLog.at(-1)).toMatchObject({cmd});
    const first=structuredClone(current.cut);
    const after=state.capture(sim), expectedTasks=structuredClone(tr.tasks);
    delete current.cut;tr.tasks=[];
    state.restore(sim,after);
    expect(sim.plan.trips[current.id].cut).toEqual(first);
    expect(sim.plan.trips[current.id].stops).toEqual(original);
    expect(sim.trains.get(tr.id)?.tasks).toEqual(expectedTasks);
    const replay=diagnostics.replayDiagnostics(diagnostics.exportDiagnostics(sim));
    expect(replay.plan.trips[current.id].cut).toEqual(first);
    state.restore(sim,checkpoint);
    expect(sim.plan.trips[current.id].cut).toBeUndefined();
    expect(sim.command(cmd).ok).toBe(true);
    expect(sim.plan.trips[current.id].cut).toEqual(first);
  });
  it('keeps the turnback terminal when rescue is followed by a hot standby takeover',async()=>{
    const {tr:failed,current}=fixture();
    current.from=17;
    current.stops=timetable.buildStops(sim.planCtx,'DN',17,30,sim.t-30,true,1);
    const start=sim.topo.berths[timetable.platformBerth(sim.topo,17,'DN')];
    Object.assign(failed,{link:start.link,off:start.offset,dir:start.dir,hist:[{link:start.link,dir:start.dir}],recentBody:undefined,phase:'run'});
    failed.tasks=[];timetable.tripTasks(sim.topo,current,failed.tasks,false);
    movement.computeBody(sim,failed);movement.indexBodies(sim);
    const turned=sim.command({c:'turnback',train:failed.id,station:25});
    expect(turned.ok,turned.msg).toBe(true);
    expect(timetable.effectiveEnd(current)).toBe(25);

    const place=timetable.hotStandbyPlaces(sim.topo).find(p=>p.station===20)!;
    const own=sim.plan.trips.find(t=>t.block!==current.block&&t.dir==='DN'&&!t.cancelled)!;
    const hotBlock=sim.plan.blocks[own.block];hotBlock.trips=[own.id];hotBlock.relieved=false;
    const hotBerth=sim.topo.berths[place.berth];
    const vehicles=[...sim.vehicles.keys()].filter(v=>v!==failed.vehicle);
    for(const vehicle of vehicles.slice(0,2)) sim.vehicles.get(vehicle)!.uto={stage:'ready',until:0,cycles:0,lastTakeoverDay:sim.config.date};
    const hot=ats.newTrain(sim,null,hotBerth.link,hotBerth.offset,hotBerth.dir,[{link:hotBerth.link,dir:hotBerth.dir}],vehicles[0]);
    Object.assign(hot,{block:hotBlock.id,tripId:own.id,phase:'run',v:0,manual:false,withdrawn:false,relievedBy:undefined});
    hot.tasks=[{k:'stop',berth:place.berth,station:20,trip:own.id,arr:null,dep:sim.t+1000,doors:false,revenue:false,standby:true}];
    const rescuer=ats.newTrain(sim,null,failed.link,failed.off,failed.dir,[{link:failed.link,dir:failed.dir}],vehicles[1]);
    Object.assign(rescuer,{inService:false,block:-1,tripId:-1});
    Object.assign(failed,{failed:true,phase:'run',v:0});
    let found=false;
    for(const link of sim.topo.links.filter(l=>l.track==='DN'&&l.len>300)){
      const dir=link.chainB>link.chainA?1:-1;
      Object.assign(rescuer,{link:link.id,off:dir===1?125:link.len-125,dir,hist:[{link:link.id,dir}],phase:'run',recentBody:undefined});
      Object.assign(failed,{link:link.id,off:dir===1?link.len-5:5,dir,hist:[{link:link.id,dir}],recentBody:undefined});
      movement.computeBody(sim,rescuer);movement.computeBody(sim,failed);movement.indexBodies(sim);
      if(ats.rescueApproach(sim,failed,rescuer)){found=true;break;}
    }
    expect(found).toBe(true);
    const rescue=sim.command({c:'rescue',failed:failed.id,rescuer:rescuer.id});
    expect(rescue.ok,rescue.msg).toBe(true);
    vi.spyOn(timetable,'standbyCandidate').mockImplementation((_ctx,_plan,_tail,depot,notBefore)=>
      ({depot,k:0,start:notBefore,dir:'DN',from:20,to:20,stops:null}));
    sim.autoDispatch=true;
    rescuer.off=failed.off-(failed.len+.25)*failed.dir;
    rescuer.recentBody=undefined;movement.computeBody(sim,rescuer);movement.indexBodies(sim);
    Object.assign(rescuer,{maReason:'救援连挂',maDist:.25,maTrain:failed.id,v:0,mode:'RM'});
    ats.updateTrainTasks(sim,rescuer);expect(rescuer.phase).toBe('coupling');
    sim.t=rescuer.dwellUntil;ats.updateTrainTasks(sim,rescuer);
    const suffix=sim.plan.trips.find(t=>t.no===`${current.no}续`&&!t.cancelled);
    expect(suffix).toBeDefined();
    expect(timetable.effectiveEnd(suffix!)).toBe(25);
    expect(suffix!.stops.at(-1)?.st).toBe(25);
    expect(current.cut).toMatchObject({station:25,cause:'turnback'});
    vi.restoreAllMocks();
  });
  it('rejects a later cut atomically',()=>{
    const {tr,current}=fixture();
    current.cut={station:24,stopIndex:0,cause:'turnback'};
    const before=structuredClone(sim.plan),tasks=structuredClone(tr.tasks);
    const result=sim.command({c:'turnback',train:tr.id,station:25});
    expect(result).toMatchObject({ok:false,reasonCode:'TURNBACK_UNREACHABLE'});
    expect(sim.plan).toEqual(before);expect(tr.tasks).toEqual(tasks);
  });
  it('can turn at a physically reachable scheduled pass station before the next stopping call',()=>{
    const {tr,current}=fixture();
    current.stops[1].stop=false;
    tr.tasks=[];timetable.tripTasks(sim.topo,current,tr.tasks,false);
    expect(tr.tasks[0]).toMatchObject({k:'stop',station:24,stopIndex:0});
    tr.tasks.shift();
    expect(tr.tasks[0]).toMatchObject({k:'stop',station:26,stopIndex:2});
    Object.assign(tr,{phase:'run',lastCompletedCall:{trip:current.id,stopIndex:0}});
    const result=sim.command({c:'turnback',train:tr.id,station:25});
    expect(result.ok,result.msg).toBe(true);
    expect(current.cut).toEqual({station:25,stopIndex:1,cause:'turnback'});
    expect(current.stops[1].stop).toBe(false);
    expect(tr.tasks.find(t=>t.k==='stop'&&t.station===25)).toMatchObject({stopIndex:1,dep:null});
  });
  it('uses physical route preflight when the planned pass station is already behind the train',()=>{
    const {tr,current}=fixture();
    current.stops[1].stop=false;
    tr.tasks=[];timetable.tripTasks(sim.topo,current,tr.tasks,false);tr.tasks.shift();
    const berth=sim.topo.berths[timetable.platformBerth(sim.topo,26,'DN')];
    Object.assign(tr,{phase:'run',lastCompletedCall:{trip:current.id,stopIndex:0},link:berth.link,off:berth.offset,dir:berth.dir,hist:[{link:berth.link,dir:berth.dir}],recentBody:undefined});
    movement.computeBody(sim,tr);movement.indexBodies(sim);
    const before=structuredClone(sim.plan),tasks=structuredClone(tr.tasks);
    expect(sim.command({c:'turnback',train:tr.id,station:25})).toMatchObject({ok:false,reasonCode:'TURNBACK_UNREACHABLE'});
    expect(sim.plan).toEqual(before);expect(tr.tasks).toEqual(tasks);
  });
  it('includes a skipped scheduled stop before the next remaining task',()=>{
    const {tr,current}=fixture();
    tr.tasks=[];timetable.tripTasks(sim.topo,current,tr.tasks,false);
    tr.tasks.shift();tr.tasks.shift();
    expect(tr.tasks[0]).toMatchObject({station:26,stopIndex:2});
    Object.assign(tr,{phase:'run',lastCompletedCall:{trip:current.id,stopIndex:0}});
    const result=sim.command({c:'turnback',train:tr.id,station:25});
    expect(result.ok,result.msg).toBe(true);
    expect(current.cut).toEqual({station:25,stopIndex:1,cause:'turnback'});
  });
  it('uses the pending call index when the original trip has repeated stations',()=>{
    const {tr,current}=fixture();
    current.stops.unshift({...current.stops[0],arr:current.stops[0].arr-600,dep:current.stops[0].dep-600});
    tr.tasks=[];timetable.tripTasks(sim.topo,current,tr.tasks,false);
    tr.tasks.shift();
    expect(sim.command({c:'turnback',train:tr.id,station:25}).ok).toBe(true);
    expect(current.cut).toEqual({station:25,stopIndex:2,cause:'turnback'});
  });
  it('does not crash while ranking a stable duty whose first trip is shortened',()=>{
    const stable=sim.plan.blocks.find(b=>b.start.kind==='stable' && b.trips.length>0)!;
    expect(stable).toBeDefined();
    for(const b of sim.plan.blocks)sim.blockDone.add(b.id);
    sim.blockDone.delete(stable.id);delete stable.train;
    const original=sim.plan.trips[stable.trips[0]];
    original.cut={station:original.stops[0].st,stopIndex:0,cause:'turnback'};
    const peer={...stable,id:sim.plan.blocks.length,trips:[original.id]};
    sim.plan.blocks.push(peer);sim.blockDone.add(peer.id);
    expect(()=>ats.spawnDue(sim)).not.toThrow();
  });
  it('records the call only after the train actually departs',()=>{
    const {tr,current}=fixture();
    tr.lastCompletedCall={trip:current.id,stopIndex:-1};
    tr.intervalRelease=24;tr.autoStartAt=0;tr.dwellUntil=sim.t;tr.depReadyAt=sim.t;
    ats.updateTrainTasks(sim,tr);
    expect(tr.phase).toBe('run');
    expect(tr.lastCompletedCall).toEqual({trip:current.id,stopIndex:0});
  });
  it('withdraws without inventing a service-end cut',()=>{
    const {tr,current}=fixture();
    tr.lastCompletedCall={trip:current.id,stopIndex:0};
    const result=sim.command({c:'withdraw',train:tr.id});
    expect(result.ok,result.msg).toBe(true);
    expect(current.cut).toBeUndefined();
    expect(current.to).toBe(30);
  });
  it('does not extend an existing cut when withdrawing',()=>{
    const {tr,current}=fixture();
    current.cut={station:25,stopIndex:1,cause:'turnback'};
    tr.lastCompletedCall={trip:current.id,stopIndex:3};
    expect(sim.command({c:'withdraw',train:tr.id}).ok).toBe(true);
    expect(current.cut).toEqual({station:25,stopIndex:1,cause:'turnback'});
  });
  it('does not extend an existing cut when a following train is sent to rescue',()=>{
    const {tr,current}=fixture();
    current.cut={station:25,stopIndex:1,cause:'turnback'};
    tr.lastCompletedCall={trip:current.id,stopIndex:3};
    const otherVehicle=[...sim.vehicles.keys()].find(v=>v!==tr.vehicle)!;
    const failed=ats.newTrain(sim,null,tr.link,tr.off,tr.dir,[{link:tr.link,dir:tr.dir}],otherVehicle);
    failed.failed=true;failed.phase='run';failed.v=0;
    let found=false;
    for(const link of sim.topo.links.filter(l=>l.track==='DN' && l.len>300)) {
      const dir=link.chainB>link.chainA?1:-1;
      const back=dir===1?125:link.len-125,front=dir===1?link.len-5:5;
      Object.assign(tr,{link:link.id,off:back,dir,hist:[{link:link.id,dir}],phase:'run',recentBody:undefined});
      Object.assign(failed,{link:link.id,off:front,dir,hist:[{link:link.id,dir}],recentBody:undefined});
      movement.computeBody(sim,tr);movement.computeBody(sim,failed);movement.indexBodies(sim);
      if(ats.rescueApproach(sim,failed,tr)){found=true;break;}
    }
    expect(found,'no physical same-direction rescue approach').toBe(true);
    const result=sim.command({c:'rescue',failed:failed.id,rescuer:tr.id});
    expect(result.ok,result.msg).toBe(true);
    expect(current.cut).toEqual({station:25,stopIndex:1,cause:'turnback'});
  });
  it.each([
    { name:'completed call', completed:2, prior:undefined, expected:undefined },
    { name:'no completed call', completed:-1, prior:undefined, expected:undefined },
    { name:'previous cut', completed:3, prior:1, expected:{station:25,stopIndex:1,cause:'turnback'} },
  ] as const)('preserves the service end after real coupling: $name',({completed,prior,expected})=>{
    const {tr,current}=fixture();
    const id=sim.plan.trips.length,block=sim.plan.blocks.length;
    const failedTrip:Trip={...current,id,no:'1267',block,stops:structuredClone(current.stops)};
    if(prior!==undefined) failedTrip.cut={station:failedTrip.stops[prior].st,stopIndex:prior,cause:'turnback'};
    sim.plan.trips.push(failedTrip);
    sim.plan.blocks.push({id:block,svc:'037',start:{kind:'depot',depot:1,time:sim.t-300},end:{kind:'depot',depot:1},trips:[id]});
    const otherVehicle=[...sim.vehicles.keys()].find(v=>v!==tr.vehicle)!;
    const failed=ats.newTrain(sim,null,tr.link,tr.off,tr.dir,[{link:tr.link,dir:tr.dir}],otherVehicle);
    Object.assign(failed,{failed:true,phase:'run',v:0,block,tripId:id,tripNo:failedTrip.no,svc:'037',lastCompletedCall:{trip:id,stopIndex:completed}});
    sim.plan.blocks[block].train=failed.id;
    let found=false;
    for(const link of sim.topo.links.filter(l=>l.track==='DN' && l.len>300)) {
      const dir=link.chainB>link.chainA?1:-1;
      const back=dir===1?125:link.len-125,front=dir===1?link.len-5:5;
      Object.assign(tr,{link:link.id,off:back,dir,hist:[{link:link.id,dir}],phase:'run',recentBody:undefined});
      Object.assign(failed,{link:link.id,off:front,dir,hist:[{link:link.id,dir}],recentBody:undefined});
      movement.computeBody(sim,tr);movement.computeBody(sim,failed);movement.indexBodies(sim);
      if(ats.rescueApproach(sim,failed,tr)){found=true;break;}
    }
    expect(found,'no physical rescue approach').toBe(true);
    const result=sim.command({c:'rescue',failed:failed.id,rescuer:tr.id});
    expect(result.ok,result.msg).toBe(true);
    expect(tr.tasks[0]).toMatchObject({k:'rescue',target:failed.id});
    expect(failedTrip.cut?.cause).not.toBe('rescue');
    // Position both full-length consists with a real 0.25 m coupling gap.
    tr.off=failed.off-(failed.len+.25)*failed.dir;
    tr.recentBody=undefined;movement.computeBody(sim,tr);movement.indexBodies(sim);
    Object.assign(tr,{maReason:'救援连挂',maDist:.25,maTrain:failed.id,v:0,mode:'RM'});
    ats.updateTrainTasks(sim,tr);
    expect(tr.phase).toBe('coupling');
    sim.t=tr.dwellUntil;
    ats.updateTrainTasks(sim,tr);
    expect(sim.trains.has(failed.id)).toBe(false);
    expect(tr.coupledVehicle).toBe(otherVehicle);
    expect(failedTrip.cut).toEqual(expected);
    expect(sim.planDirty).toBe(true);
  });
  it('does not create a cut when no call has been completed',()=>{
    const {tr,current}=fixture();
    delete tr.lastCompletedCall;
    const result=sim.command({c:'withdraw',train:tr.id});
    expect(result.ok,result.msg).toBe(true);
    expect(current.cut).toBeUndefined();
    expect(timetable.effectiveStops(current)).toEqual(current.stops);
  });
  it('does not log a missing historical index for a fresh service with no completed calls',()=>{
    const {tr,current}=fixture();
    tr.tripId=-1;tr.lastStation=24;delete tr.lastCompletedCall;
    ats.setTripFromTasks(sim,tr);
    expect(tr.lastCompletedCall).toEqual({trip:current.id,stopIndex:-1});
    const from=sim.events.length;
    expect(sim.command({c:'withdraw',train:tr.id}).ok).toBe(true);
    expect(current.cut).toBeUndefined();
    expect(sim.events.slice(from).some(e=>e.text.includes('已完成停站索引缺失'))).toBe(false);
  });
  it('accepts a withdrawal after an old checkpoint without inventing a cut',()=>{
    const {tr,current}=fixture();
    const departed=structuredClone(tr.tasks[0]);
    if(departed.k!=='stop') throw Error('expected stop');
    delete departed.stopIndex;
    tr.pendingDeparture=departed;tr.lastStation=24;delete tr.lastCompletedCall;
    const from=sim.events.length;
    expect(sim.command({c:'withdraw',train:tr.id}).ok).toBe(true);
    expect(current.cut).toBeUndefined();
    expect(sim.events.slice(from).some(e=>e.text.includes('已完成停站索引缺失'))).toBe(false);
  });
  it('extends a live duty from the actual cut endpoint rather than the diagram endpoint',()=>{
    const {tr,current}=fixture();
    current.cut={station:25,stopIndex:1,cause:'turnback'};
    const actual=timetable.effectiveTrip(current)!;
    const stops:import('../src/sim/model').Task[]=[];
    timetable.tripTasks(sim.topo,actual,stops,false);
    tr.tasks=stops;
    ats.extendTrainTasks(sim,tr,current.id);
    const reverse=tr.tasks.find(t=>t.k==='reverse');
    expect(reverse).toMatchObject({station:25});
    expect(tr.tasks.some(t=>t.k==='stop'&&t.trip===current.id&&t.station===30)).toBe(false);
    expect(current.to).toBe(30);
  });
  it('carries the active trip cut and last completed call with remapped trip id',()=>{
    // Ensure the carried duty cannot coincidentally keep its old numeric id.
    sim.plan.trips.push({...sim.plan.trips[0],id:sim.plan.trips.length});
    const {tr,current}=fixture();
    current.cut={station:25,stopIndex:1,cause:'turnback'};
    tr.lastCompletedCall={trip:current.id,stopIndex:0};
    sim.blockDone.delete(tr.block);
    sim.t=99900;
    const next=new Sim(day.nextOperatingConfig(sim));
    day.carryWorld(next,sim);
    const carried=next.trains.get(tr.id)!;
    expect(carried.tripId).not.toBe(current.id);
    expect(carried.lastCompletedCall).toEqual({trip:carried.tripId,stopIndex:0});
    expect(next.plan.trips[carried.tripId].cut).toEqual(current.cut);
    expect(next.plan.trips[carried.tripId].stops[1].arr).toBe(current.stops[1].arr-day.DAY_S);
  });
});
