import {describe,it,expect} from 'vitest';
import {Sim} from '../src/sim/engine';
import type {StopTask,Train} from '../src/sim/model';
import {depotBerth,intervalDepartureHold} from '../src/sim/ats';
import {newHalt,rootCause} from '../src/sim/halt';
import {platformBerth} from '../src/sim/timetable';
import {OPERATIONS} from '../src/data/current';
import {capture,restore} from '../src/sim/state';

function fixture(){
 const sim=new Sim({dayType:'weekday',date:'2026-10-19',dateLabel:'interval-feedback',startTime:14400,seed:7,noPossessions:true});
 const [rear,front,turn]=sim.trainList;expect(turn).toBeDefined();
 for(const tr of [...sim.trainList])if(![rear,front,turn].includes(tr))sim.removeTrain(tr);
 const rule=OPERATIONS.intervalTrainLimits.find(r=>sim.topo.stations.findIndex(s=>s.id===r.from)>=2)!;
 const station=sim.topo.stations.findIndex(s=>s.id===rule.from),next=station+1;
 const berth=sim.topo.berths[platformBerth(sim.topo,station,'DN')],target=platformBerth(sim.topo,next,'DN');
 const stop:StopTask={k:'stop',berth:berth.id,station,trip:-1,arr:sim.t-40,dep:sim.t,doors:true,revenue:true};
 for(const tr of [rear,front,turn])Object.assign(tr,{v:0,manual:false,mode:'DTO',failed:false,hold:false,eb:false,pendingMode:null,
  stopUntil:0,comm:true,uto:undefined,vfault:null,pendingDeparture:undefined,rescuing:-1,coupledLen:0,nextSignal:-1,arsWait:null,body:[],halt:newHalt()});
 Object.assign(rear,{link:berth.link,off:berth.offset,dir:berth.dir,phase:'dwell',tasks:[stop,{...stop,station:next,berth:target,dep:null}],maDist:500});
 const a=sim.topo.links[berth.link],b=sim.topo.links[sim.topo.berths[target].link];
 const chain=(Math.max(a.chainA,a.chainB)+Math.min(b.chainA,b.chainB))/2;
 const link=sim.topo.links.find(l=>l.track==='DN'&&Math.min(l.chainA,l.chainB)<=chain&&Math.max(l.chainA,l.chainB)>=chain)!;
 const off=(chain-link.chainA)/(link.chainB-link.chainA)*link.len;
 Object.assign(front,{phase:'run',link:link.id,off,dir:1,body:[{link:link.id,from:off,to:Math.min(link.len,off+10)}],tasks:[{...stop,station:next,berth:target}]});
 Object.assign(turn,{phase:'run',tasks:[{...stop}],link:berth.link,off:berth.offset,dir:berth.dir});
 const wait=(tr:Train,other:Train,code:'INTERVAL_LIMIT'|'TRAIN_AHEAD'|'BERTH_WAIT')=>tr.halt={...newHalt(),code,train:other.id,since:sim.t,unplannedSince:sim.t};
 wait(rear,front,'INTERVAL_LIMIT');wait(front,turn,'TRAIN_AHEAD');wait(turn,rear,'BERTH_WAIT');
 return {sim,rear,front,turn,stop,wait};
}

describe('interval metering does not create its own blocking source',()=>{
 it('does not reactivate capacity against a closed following/platform-clearance dependency',()=>{
  const {sim,rear,front,stop}=fixture();expect(rootCause(sim,front).cycle).not.toBeNull();
  expect(intervalDepartureHold(sim,rear,stop)).toBeUndefined();expect(rear.maDist).toBe(500);
 });
 it('handles the 140243 22-train closed dependency without selecting a privileged train',()=>{
  const {sim,rear,front,turn,stop,wait}=fixture();let last=turn;
  for(let i=0;i<19;i++){const tr={...turn,id:1000+i,body:[],tasks:turn.tasks.map(t=>({...t})),halt:newHalt()};sim.trains.set(tr.id,tr);sim.trainList.push(tr);wait(last,tr,i%2?'INTERVAL_LIMIT':'TRAIN_AHEAD');last=tr;}
  wait(last,rear,'BERTH_WAIT');expect(rootCause(sim,front).cycle).toHaveLength(22);
  expect(intervalDepartureHold(sim,rear,stop)).toBeUndefined();
 });
 it('keeps an ordinary acyclic stopped interval train at the original capacity',()=>{
  const {sim,rear,front,stop}=fixture();front.halt={...newHalt(),code:'ROUTE_WAIT',train:-1};
  expect(intervalDepartureHold(sim,rear,stop)?.train).toBe(front.id);
 });
 it('uses the same physical feedback for a staffed computer cab but keeps unknown human input conservative',()=>{
  const {sim,rear,front,turn,stop}=fixture();
  Object.assign(turn,{manual:true,mode:'CM',uto:{target:'CM',computer:true,stage:'manual',until:0,detail:'protected driving'}});
  expect(intervalDepartureHold(sim,rear,stop)).toBeUndefined();
  turn.uto=undefined;expect(intervalDepartureHold(sim,rear,stop)?.train).toBe(front.id);
 });
 it.each(['signal','section','switch']as const)('retains a same-tick live %s condition on the current wait path',kind=>{
  const {sim,rear,front,turn,stop}=fixture();
  const route=sim.topo.routes.find(r=>r.switches.length>0)!;turn.nextSignal=route.start;
  sim.sig[route.start].route=route.id;
  if(kind==='signal')sim.sig[route.start].failed=true;
  else if(kind==='section')sim.sec[route.sections[0]].blocked=true;
  else sim.sw[route.switches[0].sw].failed=true;
  expect(intervalDepartureHold(sim,rear,stop)?.train).toBe(front.id);
 });
 it.each(['singleLock','fieldLock','moving']as const)('does not hide a live %s point restriction behind a stored traffic cycle',kind=>{
  const {sim,rear,front,turn,stop}=fixture();const route=sim.topo.routes.find(r=>r.switches.length>0)!;
  turn.nextSignal=route.start;sim.sig[route.start].route=route.id;
  for(const x of route.switches)Object.assign(sim.sw[x.sw],{pos:x.pos,target:x.pos,moveUntil:0,failed:false,blocked:false});
  const point=route.switches[0],sw=sim.sw[point.sw],opposite=point.pos==='N'?'R':'N';
  if(kind==='moving'){sw.target=opposite;sw.moveUntil=sim.t+5;}
  else Object.assign(sw,{[kind]:true,pos:opposite,target:opposite});
  expect(intervalDepartureHold(sim,rear,stop)?.train).toBe(front.id);
 });
 it('keeps an unarranged ARS-off entrance independent, without treating an already arranged route as stopped',()=>{
  const {sim,rear,front,turn,stop}=fixture();const route=sim.topo.routes.find(r=>r.switches.length===0)!;
  turn.nextSignal=route.start;sim.sig[route.start].ars=false;sim.sig[route.start].route=-1;
  expect(intervalDepartureHold(sim,rear,stop)?.train).toBe(front.id);
  sim.sig[route.start].route=route.id;
  expect(intervalDepartureHold(sim,rear,stop)).toBeUndefined();
 });
 it('does not infer an external fault from a different unselected route at the same entrance',()=>{
  const {sim,rear,turn,stop}=fixture(),paths=sim.routeTable.next.get(stop.berth)!;
  const pair=sim.topo.signals.flatMap(sig=>{
   const desired=sim.topo.routes[paths[sig.id]];
   if(!desired)return[];
   return sig.routes.flatMap(id=>sim.topo.routes[id].sections.filter(s=>!desired.sections.includes(s)).map(section=>({sig,desired,section})));
  })[0];expect(pair).toBeDefined();turn.nextSignal=pair.sig.id;
  sim.sig[pair.sig.id].ars=true;sim.sig[pair.sig.id].route=-1;
  for(const x of pair.desired.switches)Object.assign(sim.sw[x.sw],{pos:x.pos,target:x.pos,moveUntil:0,failed:false,blocked:false});
  sim.sec[pair.section].blocked=true;
  expect(intervalDepartureHold(sim,rear,stop)).toBeUndefined();
 });
 it('uses the published next-movement choice when a dwelling train still names its reached platform',()=>{
  const {sim,rear,turn,stop}=fixture(),current=sim.routeTable.next.get(stop.berth)!;
  const pair=sim.topo.berths.flatMap(berth=>{
   const paths=sim.routeTable.next.get(berth.id);if(!paths)return[];
   return sim.topo.signals.filter(sig=>paths[sig.id]>=0&&!(current[sig.id]>=0)).map(sig=>({berth,sig,route:sim.topo.routes[paths[sig.id]]}));
  })[0];expect(pair).toBeDefined();turn.phase='dwell';turn.nextSignal=pair.sig.id;
  turn.tasks=[{...stop},{k:'reverse',berths:[pair.berth.id],chosen:pair.berth.id,station:stop.station,minTime:40}];
  turn.halt.alternatives=[{entrySignal:pair.sig.id,choices:[{index:1,berth:pair.berth.id}],blockers:[{code:'BERTH_WAIT',train:rear.id,detail:'actual next berth'}]}];
  sim.sig[pair.sig.id].ars=true;sim.sig[pair.sig.id].route=-1;
  for(const x of pair.route.switches)Object.assign(sim.sw[x.sw],{pos:x.pos,target:x.pos,moveUntil:0,failed:false,blocked:false});
  expect(intervalDepartureHold(sim,rear,stop)).toBeUndefined();
 });
 it.each([true,false])('resolves a real depot task through its existing path lookup (explicit berth %s)',explicit=>{
  const {sim,rear,turn,stop}=fixture(),dp=sim.topo.depots[0];
  const task={k:'depot' as const,depot:dp.id,...(explicit?{berth:dp.entryBerths[0]}:{})},goal=depotBerth(sim.topo,task);
  const paths=sim.routeTable.next.get(goal)!,signal=sim.topo.signals.find(sig=>paths[sig.id]>=0)!,route=sim.topo.routes[paths[signal.id]];
  turn.tasks=[task];turn.nextSignal=signal.id;sim.sig[signal.id].ars=true;sim.sig[signal.id].route=-1;
  for(const x of route.switches)Object.assign(sim.sw[x.sw],{pos:x.pos,target:x.pos,moveUntil:0,failed:false,blocked:false});
  expect(rootCause(sim,turn,true).external).toBe(false);
  expect(intervalDepartureHold(sim,rear,stop)).toBeUndefined();expect(turn.tasks[0]).toEqual(task);
 });
 it('keeps a depot task conservative when the real route table has no path from its entrance',()=>{
  const {sim,rear,front,turn,stop}=fixture(),dp=sim.topo.depots[0],task={k:'depot' as const,depot:dp.id};
  const paths=sim.routeTable.next.get(depotBerth(sim.topo,task))!,signal=sim.topo.signals.find(sig=>paths[sig.id]<0)!;
  turn.tasks=[task];turn.nextSignal=signal.id;sim.sig[signal.id].ars=true;sim.sig[signal.id].route=-1;
  expect(intervalDepartureHold(sim,rear,stop)?.train).toBe(front.id);
 });
 it('keeps a real device obstruction on the same known depot route independent of the traffic cycle',()=>{
  const {sim,rear,front,turn,stop}=fixture(),dp=sim.topo.depots[0],task={k:'depot' as const,depot:dp.id,berth:dp.entryBerths[0]};
  const paths=sim.routeTable.next.get(depotBerth(sim.topo,task))!,signal=sim.topo.signals.find(sig=>paths[sig.id]>=0)!,route=sim.topo.routes[paths[signal.id]];
  turn.tasks=[task];turn.nextSignal=signal.id;sim.sig[signal.id].ars=true;sim.sig[signal.id].route=-1;
  for(const x of route.switches)Object.assign(sim.sw[x.sw],{pos:x.pos,target:x.pos,moveUntil:0,failed:false,blocked:false});
  sim.sec[route.sections[0]].blocked=true;
  expect(intervalDepartureHold(sim,rear,stop)?.train).toBe(front.id);
 });
 it.each(['hold','failed','eb']as const)('keeps same-tick live %s despite an older internally closed halt graph',field=>{
  const {sim,rear,front,turn,stop}=fixture();Object.assign(turn,{[field]:true});
  expect(intervalDepartureHold(sim,rear,stop)?.train).toBe(front.id);
 });
 it.each(['hold','esp','psd']as const)('keeps a live platform %s hidden behind the stored capacity wait',field=>{
  const {sim,rear,front,turn,stop}=fixture();const ps=sim.plat[sim.topo.berths[stop.berth].platform];
  turn.body=[{link:stop.berth>=0?sim.topo.berths[stop.berth].link:rear.link,from:0,to:1}];
  if(field==='psd'){ps.psdFault=true;ps.psd='closeFail';}else ps[field]=true;
  expect(intervalDepartureHold(sim,rear,stop)?.train).toBe(front.id);
 });
 it('retains a real external AND condition even when its other blocker closes the same SCC',()=>{
  const {sim,rear,front,turn,stop}=fixture();
  turn.halt.alternatives=[{choices:[],blockers:[{code:'BERTH_WAIT',train:rear.id,detail:'platform occupied'},{code:'PSD_FAULT',train:-1,detail:'real independent fault'}]}];
  expect(rootCause(sim,front).cycle).not.toBeNull();expect(intervalDepartureHold(sim,rear,stop)?.train).toBe(front.id);
 });
 it('does not treat a selected cycle with a moving alternative as a closed sink',()=>{
  const {sim,rear,front,turn,stop}=fixture();front.halt.alternatives=[{choices:[],blockers:[{code:'BERTH_WAIT',train:rear.id,detail:'selected'}]},{choices:[],blockers:[{code:'BERTH_WAIT',train:turn.id,detail:'alternative'}]}];
  turn.halt=newHalt();turn.v=4;expect(rootCause(sim,front).cycle).toBeNull();
  expect(intervalDepartureHold(sim,rear,stop)?.train).toBe(front.id);
 });
 it('keeps a fault-rooted queue and does not reuse a pure-cycle result through restore',()=>{
  const {sim,rear,front,turn,stop}=fixture(),saved=capture(sim);
  turn.failed=true;turn.halt={...newHalt(),code:'FAILED',train:-1};expect(rootCause(sim,front).code).toBe('FAILED');
  expect(intervalDepartureHold(sim,rear,stop)?.train).toBe(front.id);
  restore(sim,saved);const r=sim.trains.get(rear.id)!,f=sim.trains.get(front.id)!;
  expect(intervalDepartureHold(sim,r,stop)).toBeUndefined();f.hold=true;expect(intervalDepartureHold(sim,r,stop)?.train).toBe(front.id);
 });
});
