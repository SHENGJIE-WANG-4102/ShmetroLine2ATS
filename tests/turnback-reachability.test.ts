import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sim as Simulator } from '../src/sim/engine';
import type { StopTask } from '../src/sim/model';

describe('dispatcher turnback reachability on the test line', () => {
  let Sim: typeof Simulator;
  let ats: typeof import('../src/sim/ats');
  let movement: typeof import('../src/sim/movement');
  let state: typeof import('../src/sim/state');
  let diagnostics: typeof import('../src/sim/diagnostics');
  beforeAll(async () => {
    vi.stubEnv('ATS_LINE','test'); vi.resetModules();
    Sim=(await import('../src/sim/engine')).Sim;
    ats=await import('../src/sim/ats');
    movement=await import('../src/sim/movement');
    state=await import('../src/sim/state');
    diagnostics=await import('../src/sim/diagnostics');
  });
  afterAll(()=>{vi.unstubAllEnvs();vi.resetModules();});

  function tailFixture() {
    const sim=new Sim({dayType:'weekday',date:'2026-10-20',dateLabel:'turnback-reachability',
      startTime:14400,seed:142033,randomFaults:0,noPossessions:true,autoDispatch:false,autoRadio:false});
    for(const old of [...sim.trainList])sim.removeTrain(old);
    const berth=sim.topo.berths.find(b=>b.kind==='tail'&&b.station===5&&b.dir===1)!;
    expect(berth).toBeDefined();
    // Exact body location from the replayed command-time 142032 state.
    expect(berth.link).toBe(33);
    const trip=sim.plan.trips.find(t=>t.from===5&&t.dir==='UP'&&t.revenue)!;
    const platform=sim.topo.berths.find(b=>b.station===5&&b.kind==='platform'&&b.platform===sim.topo.stations[5].platforms.UP&&b.dir===-1)!;
    const vehicle=[...sim.vehicles.keys()][0];
    const tr=ats.newTrain(sim,null,berth.link,248.87737005985474,-1,[{link:berth.link,dir:-1}],vehicle);
    Object.assign(tr,{block:trip.block,tripId:trip.id,tripNo:trip.no,svc:'010',phase:'run',tbStage:'depart',lastStation:5,
      manual:false,mode:'DTO',v:0,lastDs:0});
    const first:StopTask={k:'stop',berth:platform.id,station:5,trip:trip.id,arr:null,dep:76200,
      doors:true,revenue:true,turnbackWaitBerth:berth.id};
    tr.tasks=[first];sim.t=75851.7;
    movement.computeBody(sim,tr);movement.indexBodies(sim);
    return {sim,tr,first};
  }

  it('recognizes the completed turn at the same station without changing the queued trip', () => {
    const {sim,tr}=tailFixture();
    const before={tasks:structuredClone(tr.tasks),plan:structuredClone(sim.plan),routes:structuredClone(sim.routes),reservations:structuredClone(sim.berthRes)};
    sim.startState=state.capture(sim);
    const result=sim.command({c:'turnback',train:tr.id,station:5});
    expect(result).toMatchObject({ok:true,reasonCode:'TURNBACK_ALREADY_SATISFIED'});
    expect(tr.tasks).toEqual(before.tasks);expect(sim.plan).toEqual(before.plan);
    expect(sim.routes).toEqual(before.routes);expect(sim.berthRes).toEqual(before.reservations);
    expect(sim.inputLog.at(-1)).toMatchObject({cmd:{c:'turnback',train:tr.id,station:5},reasonCode:'TURNBACK_ALREADY_SATISFIED'});
    const replay=diagnostics.replayDiagnostics(diagnostics.exportDiagnostics(sim));
    expect(replay.trains.get(tr.id)!.tasks).toEqual(before.tasks);
    expect(replay.inputLog.at(-1)).toMatchObject({reasonCode:'TURNBACK_ALREADY_SATISFIED'});
  });

  it('recognizes the same completed turn without a long-wait marker',()=>{
    const {sim,tr}=tailFixture();
    delete (tr.tasks[0] as StopTask).turnbackWaitBerth;
    const before=structuredClone(tr.tasks);
    const result=sim.command({c:'turnback',train:tr.id,station:5});
    expect(result).toMatchObject({ok:true,reasonCode:'TURNBACK_ALREADY_SATISFIED'});
    expect(tr.tasks).toEqual(before);
  });

  it('recognizes a completed non-revenue turn without a plan trip or waiting marker',()=>{
    const {sim,tr}=tailFixture();
    tr.tripId=-1;
    tr.tasks[0]={...(tr.tasks[0] as StopTask),trip:-1,arr:null,dep:null,doors:false,revenue:false,turnbackWaitBerth:undefined};
    const before=structuredClone(tr.tasks);
    const result=sim.command({c:'turnback',train:tr.id,station:5});
    expect(result).toMatchObject({ok:true,reasonCode:'TURNBACK_ALREADY_SATISFIED'});
    expect(tr.tasks).toEqual(before);
  });

  it('does not claim a non-revenue turn is satisfied with a mismatched departure direction',()=>{
    const {sim,tr}=tailFixture();
    const wrong=sim.topo.berths.find(b=>b.station===5&&b.kind==='platform'&&b.dir===1)!;
    tr.tripId=-1;
    tr.tasks[0]={...(tr.tasks[0] as StopTask),trip:-1,arr:null,dep:null,doors:false,revenue:false,
      berth:wrong.id,turnbackWaitBerth:undefined};
    const result=sim.command({c:'turnback',train:tr.id,station:5});
    expect(result.reasonCode).not.toBe('TURNBACK_ALREADY_SATISFIED');
  });

  it('recognizes a real turn while the vehicle is physically changing ends',()=>{
    const {sim,tr,first}=tailFixture();
    const tail=sim.topo.berths[first.turnbackWaitBerth!];
    Object.assign(tr,{link:tail.link,off:tail.offset,dir:tail.dir,hist:[{link:tail.link,dir:tail.dir}],phase:'reversing',tbStage:'reverse'});
    tr.tasks=[{k:'reverse',berths:[tail.id],chosen:tail.id,station:5,minTime:40},{...first,turnbackWaitBerth:undefined}];
    movement.computeBody(sim,tr);movement.indexBodies(sim);
    const before=structuredClone(tr.tasks);
    const result=sim.command({c:'turnback',train:tr.id,station:5});
    expect(result).toMatchObject({ok:true,reasonCode:'TURNBACK_ALREADY_SATISFIED'});
    expect(tr.tasks).toEqual(before);
  });

  it('does not claim a reversing turn is satisfied if its marked next stop names another station',()=>{
    const {sim,tr,first}=tailFixture();
    const tail=sim.topo.berths[first.turnbackWaitBerth!];
    Object.assign(tr,{link:tail.link,off:tail.offset,dir:tail.dir,hist:[{link:tail.link,dir:tail.dir}],phase:'reversing',tbStage:'reverse'});
    tr.tasks=[{k:'reverse',berths:[tail.id],chosen:tail.id,station:5,minTime:40},{...first,station:4}];
    movement.computeBody(sim,tr);movement.indexBodies(sim);
    expect((tr.tasks[1] as StopTask).turnbackWaitBerth).toBe(tail.id);
    const result=sim.command({c:'turnback',train:tr.id,station:5});
    expect(result.reasonCode).not.toBe('TURNBACK_ALREADY_SATISFIED');
  });

  it('does not claim the existing turn is satisfied when the next trip points the wrong way',()=>{
    const {sim,tr}=tailFixture();
    sim.plan.trips[tr.tripId].dir='DN';
    const result=sim.command({c:'turnback',train:tr.id,station:5});
    expect(result.reasonCode).not.toBe('TURNBACK_ALREADY_SATISFIED');
  });

  it('does not trust a same-station stop whose berth physically belongs to another station',()=>{
    const {sim,tr}=tailFixture();
    const wrong=sim.topo.berths.find(b=>b.station===4&&b.kind==='platform'&&b.dir===-1)!;
    tr.tasks[0]={...(tr.tasks[0] as StopTask),berth:wrong.id};
    expect((tr.tasks[0] as StopTask).station).toBe(5);
    expect((tr.tasks[0] as StopTask).turnbackWaitBerth).toBeDefined();
    const result=sim.command({c:'turnback',train:tr.id,station:5});
    expect(result.reasonCode).not.toBe('TURNBACK_ALREADY_SATISFIED');
  });

  it('does not trust a reversing continuation whose berth belongs to another station',()=>{
    const {sim,tr,first}=tailFixture();
    const tail=sim.topo.berths[first.turnbackWaitBerth!];
    const wrong=sim.topo.berths.find(b=>b.station===4&&b.kind==='platform'&&b.dir===-1)!;
    Object.assign(tr,{link:tail.link,off:tail.offset,dir:tail.dir,hist:[{link:tail.link,dir:tail.dir}],phase:'reversing',tbStage:'reverse'});
    tr.tasks=[{k:'reverse',berths:[tail.id],chosen:tail.id,station:5,minTime:40},{...first,berth:wrong.id}];
    movement.computeBody(sim,tr);movement.indexBodies(sim);
    const result=sim.command({c:'turnback',train:tr.id,station:5});
    expect(result.reasonCode).not.toBe('TURNBACK_ALREADY_SATISFIED');
  });

  it('does not trust a station-5 wait marker when the current stop names station 4',()=>{
    const {sim,tr}=tailFixture();
    const original=tr.tasks[0] as StopTask;
    tr.tasks[0]={...original,station:4};
    expect((tr.tasks[0] as StopTask).turnbackWaitBerth).toBeDefined();
    expect(tr.lastStation).toBe(5);
    const result=sim.command({c:'turnback',train:tr.id,station:5});
    expect(result.reasonCode).not.toBe('TURNBACK_ALREADY_SATISFIED');
  });

  it('does not claim an unrelated existing destination is the requested turn', () => {
    const {sim,tr}=tailFixture();
    const different=sim.topo.berths.find(b=>b.station===4&&b.kind==='platform'&&b.dir===-1)!;
    tr.tasks[0]={...(tr.tasks[0] as StopTask),station:4,berth:different.id,turnbackWaitBerth:undefined};
    tr.lastStation=4;
    sim.startState=state.capture(sim);
    const before={tasks:structuredClone(tr.tasks),plan:structuredClone(sim.plan),routes:structuredClone(sim.routes),reservations:structuredClone(sim.berthRes)};
    const result=sim.command({c:'turnback',train:tr.id,station:5});
    expect(result).toMatchObject({ok:false,reasonCode:'TURNBACK_UNREACHABLE'});
    expect(tr.tasks).toEqual(before.tasks);expect(sim.plan).toEqual(before.plan);
    expect(sim.routes).toEqual(before.routes);expect(sim.berthRes).toEqual(before.reservations);
    expect(sim.inputLog.at(-1)).toMatchObject({cmd:{c:'turnback',train:tr.id,station:5},reasonCode:'TURNBACK_UNREACHABLE'});
    const replay=diagnostics.replayDiagnostics(diagnostics.exportDiagnostics(sim));
    expect(replay.trains.get(tr.id)!.tasks).toEqual(before.tasks);
    expect(replay.inputLog.at(-1)).toMatchObject({reasonCode:'TURNBACK_UNREACHABLE'});
  });
});
describe('static turnback preflight on line 14',()=>{
 let Sim:typeof Simulator,ats:typeof import('../src/sim/ats'),timetable:typeof import('../src/sim/timetable');
 let state:typeof import('../src/sim/state'),diagnostics:typeof import('../src/sim/diagnostics');
 beforeAll(async()=>{vi.stubEnv('ATS_LINE','14');vi.resetModules();
  Sim=(await import('../src/sim/engine')).Sim;ats=await import('../src/sim/ats');timetable=await import('../src/sim/timetable');
  state=await import('../src/sim/state');diagnostics=await import('../src/sim/diagnostics');});
 afterAll(()=>{vi.unstubAllEnvs();vi.resetModules();});
 function validFront(withOccupant:boolean){
  const sim=new Sim({dayType:'weekday',date:'2026-10-19',dateLabel:'front-valid',startTime:14400,seed:71,noPossessions:true,randomFaults:0,autoDispatch:false,autoRadio:false});
  for(const old of [...sim.trainList])sim.removeTrain(old);
  for(const block of sim.plan.blocks)sim.blockDone.add(block.id);
  const source=sim.topo.berths[timetable.platformBerth(sim.topo,4,'DN')];
  const tb=timetable.turnbackAt(sim.topo,5,'DN');
  expect(tb?.kind).toBe('front');if(!tb||tb.kind!=='front')throw Error('front fixture');
  const target=sim.topo.berths[tb.arrBerth],vehicle=[...sim.vehicles.keys()][0];
  const tr=ats.newTrain(sim,null,source.link,source.offset,source.dir,[{link:source.link,dir:source.dir}],vehicle);
  tr.tripId=-1;tr.tasks=[];
  if(withOccupant){
   const holder=ats.newTrain(sim,null,target.link,target.offset,target.dir,[{link:target.link,dir:target.dir}],vehicle);
   expect(holder.id).not.toBe(tr.id);
  }
  return {sim,tr,target};
 }
 function checkRejectedReason(sim:Simulator,tr:Simulator['trainList'][number],station:number,reasonCode:string){
  sim.startState=state.capture(sim);
  const tasks=structuredClone(tr.tasks),plan=structuredClone(sim.plan);
  const result=sim.command({c:'turnback',train:tr.id,station});
  expect(result).toMatchObject({ok:false,reasonCode});
  expect(tr.tasks).toEqual(tasks);expect(sim.plan).toEqual(plan);
  expect(sim.inputLog.at(-1)).toMatchObject({cmd:{c:'turnback',train:tr.id,station},reasonCode});
  const replay=diagnostics.replayDiagnostics(diagnostics.exportDiagnostics(sim));
  expect(replay.inputLog.at(-1)).toMatchObject({reasonCode});
  expect(replay.trains.get(tr.id)!.tasks).toEqual(tasks);
  expect(replay.plan).toEqual(plan);
 }
 it('records and replays the reason when no direction-specific turnback facility exists',()=>{
  const {sim,tr}=validFront(false);
  const unavailable=sim.topo.stations.find(st=>!timetable.turnbackAt(sim.topo,st.index,'DN'));
  expect(unavailable).toBeDefined();
  checkRejectedReason(sim,tr,unavailable!.index,'TURNBACK_UNAVAILABLE');
 });
 it('records and replays the TBTC front-turn refusal',()=>{
  const {sim,tr}=validFront(false);
  tr.level='TBTC';
  checkRejectedReason(sim,tr,5,'TURNBACK_TBTC_UNAVAILABLE');
 });
 it('accepts a real front turn whose entire return is reachable',()=>{
  const {sim,tr,target}=validFront(false);
  const result=sim.command({c:'turnback',train:tr.id,station:5});
  expect(result.ok,result.msg).toBe(true);
  expect(tr.tasks.some(t=>t.k==='reverse'&&t.chosen===target.id)).toBe(true);
  expect(tr.tasks.at(-1)?.k).toBe('depot');
 });
 it('accepts an actually reachable point after passing the station centre',async()=>{
  const {sim,tr,target}=validFront(false);
  const movement=await import('../src/sim/movement');
  Object.assign(tr,{link:target.link,off:target.offset-target.dir,dir:target.dir,
   hist:[{link:target.link,dir:target.dir}]});
  movement.computeBody(sim,tr);
  expect(sim.trainChain(tr)).toBeGreaterThan(sim.topo.stations[5].chain+20);
  const result=sim.command({c:'turnback',train:tr.id,station:5});
  expect(result.ok,result.msg).toBe(true);
 });
 it('accepts that same reachable turn when another actual train occupies the destination',()=>{
  const {sim,tr,target}=validFront(true);
  expect(sim.trainList.some(other=>other.id!==tr.id&&other.body.some(part=>part.link===target.link))).toBe(true);
  const result=sim.command({c:'turnback',train:tr.id,station:5});
  expect(result.ok,result.msg).toBe(true);
  expect(tr.tasks.some(t=>t.k==='reverse'&&t.chosen===target.id)).toBe(true);
  expect(tr.tasks.at(-1)?.k).toBe('depot');
 });
 it('accepts a mapped rear turn even when a route switch is currently set the other way',()=>{
  const sim=new Sim({dayType:'weekday',date:'2026-10-19',dateLabel:'preflight-switch',startTime:14400,seed:71,noPossessions:true,randomFaults:0,autoDispatch:false,autoRadio:false});
  for(const tr of [...sim.trainList])sim.removeTrain(tr);
  for(const block of sim.plan.blocks)sim.blockDone.add(block.id);
  const trip=sim.plan.trips.find(t=>t.dir==='DN'&&t.from<=24&&t.to>=25&&t.revenue)!;
  const berth=sim.topo.berths[timetable.platformBerth(sim.topo,24,'DN')];
  const vehicle=[...sim.vehicles.keys()][0];
  const tr=ats.newTrain(sim,null,berth.link,berth.offset,berth.dir,[{link:berth.link,dir:berth.dir}],vehicle);
  tr.block=trip.block;tr.tripId=trip.id;tr.tripNo=trip.no;tr.phase='dwell';
  tr.tasks=[];timetable.tripTasks(sim.topo,trip,tr.tasks,false);
  tr.tasks=tr.tasks.filter(t=>t.k!=='stop'||t.station>=24);
  const tb=timetable.turnbackAt(sim.topo,25,'DN');
  expect(tb?.kind).toBe('rear');if(!tb||tb.kind!=='rear')throw Error('rear fixture');
  expect(tb.berths.length).toBeGreaterThan(1);
  const ahead=ats.signalAheadFrom(sim,tr.link,tr.off,tr.dir,Infinity);
  expect(ahead).toBeTruthy();
  const table=sim.routeTable.next.get(tb.berths[0])!;
  let sig=ahead!.sig, chosen:{sw:number;pos:'N'|'R'}|undefined;
  const seen=new Set<number>();
  while(sig>=0&&!seen.has(sig)){
   seen.add(sig);const rid=table[sig];if(rid<0)break;const route=sim.topo.routes[rid];
   chosen??=route.switches[0];if(route.berths.includes(tb.berths[0]))break;sig=route.end;
  }
  expect(chosen,'the mapped approach contains a real switch').toBeDefined();
  sim.sw[chosen!.sw].pos=chosen!.pos==='N'?'R':'N';
  const result=sim.command({c:'turnback',train:tr.id,station:25});
  expect(result.ok,result.msg).toBe(true);
  const reverse=tr.tasks.find(t=>t.k==='reverse');
  expect(reverse?.k).toBe('reverse');
  if(reverse?.k==='reverse')expect(reverse.berths).toEqual([reverse.chosen]);
 });
});
