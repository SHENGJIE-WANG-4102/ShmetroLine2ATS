import {afterEach,describe,expect,it,vi} from 'vitest';
import {Sim} from '../src/sim/engine';
import {canExchangeStabling} from '../src/sim/standby';
import {departureBerthAfterReverse,platformBerth} from '../src/sim/timetable';
import type {Block,Plan,StopTask,Trip} from '../src/sim/model';
import * as planning from '../src/sim/planning';
import {capture,restore} from '../src/sim/state';
import {applyInput} from '../src/sim/diagnostics';
import {newTrain} from '../src/sim/ats';
import {takeVehicle} from '../src/sim/yard';

afterEach(()=>vi.restoreAllMocks());
function fixture(until=14400){
 const s=new Sim({dayType:'weekday',dateLabel:'slot',startTime:14400,seed:3,noPossessions:true});s.t=20000;s.autoDispatch=true;
 // Synthetic reservation: the generic exchange contract remains valid even
 // when the selected line does not schedule overnight platform stabling.
 const place=s.topo.stations.flatMap(st=>st.turnbackBerths.filter(b=>s.topo.berths[b].kind==='platform')
  .map(berth=>({station:st.index,berth:departureBerthAfterReverse(s.topo,berth,platformBerth(s.topo,st.index,'UP'))}))).at(0)!;
 const berth=s.topo.berths[place.berth],st=place.station,template=s.plan.trips[0];
 const trip=(id:number,dir:'DN'|'UP',from:number,to:number,dep:number,block:number):Trip=>({...template,id,no:`T${id}`,dir,from,to,block,cancelled:false,completed:false,revenue:true,
  stops:[{st:from,arr:dep,dep,stop:true},{st:to,arr:dep+180,dep:dep+180,stop:true}]});
 const old=trip(0,'DN',st-1,st,-780,0);old.completed=true;
 const incoming=trip(1,'DN',st-1,st,19800,1),next=trip(2,'UP',st,st-1,20400,1);
 const blocks:Block[]=[{id:0,svc:'A',start:{kind:'stable',station:st,berth:place.berth},end:{kind:'stable',station:st,berth:place.berth,holdFrom:-600,holdUntil:until},trips:[0]},
  {id:1,svc:'B',start:{kind:'stable',station:st-1},end:{kind:'depot',depot:0},trips:[1,2]}];
 s.plan={...s.plan,trips:[old,incoming,next],blocks,overlays:[]} as Plan;
 // D178: no train stands on the main line overnight; both fixture trains are real yard cars
 const car=(at:number)=>{const b=s.topo.berths[at];return newTrain(s,null,b.link,b.offset,b.dir,[{link:b.link,dir:b.dir}],takeVehicle(s,0)!);};
 const held=car(place.berth),approaching=car(platformBerth(s.topo,st-1,'DN'));
 const arrival:StopTask={k:'stop',station:st,berth:place.berth,trip:1,arr:19980,dep:null,doors:true,revenue:true};
 const departure:StopTask={k:'stop',station:st,berth:place.berth,trip:2,arr:null,dep:20400,doors:true,revenue:true};
 Object.assign(held,{phase:'stabled',link:berth.link,off:berth.offset,dir:berth.dir,block:0,tripId:0,tasks:[],failed:false,manual:false,withdrawn:false,coupledLen:0});
 Object.assign(approaching,{phase:'run',block:1,tripId:1,tasks:[arrival,{k:'reverse',station:st,berths:[place.berth],chosen:place.berth,minTime:40},departure],failed:false,manual:false,withdrawn:false,coupledLen:0,
  halt:{...approaching.halt,train:held.id}});
 return {s,held,approaching,place};
}

describe('stabling reservation exchange',()=>{
 it('transfers duties transactionally and preserves the original hold window',()=>{
  const {s,held,approaching}=fixture();vi.spyOn(planning,'noWorse').mockReturnValue(true);
  const before={link:held.link,off:held.off},checkpoint=capture(s);expect(canExchangeStabling(s,approaching)).toBe(true);
  const result=s.command({c:'standby',train:approaching.id});expect(result.ok).toBe(true);
  expect(s.plan.blocks[held.block].trips).toEqual([0,2]);expect(s.plan.blocks[approaching.block].trips).toEqual([1]);
  expect(s.plan.blocks[approaching.block].end).toMatchObject({kind:'stable',holdFrom:-600,holdUntil:14400});
  expect({link:held.link,off:held.off}).toEqual(before);expect(held.phase).toBe('run');
  const input=s.inputLog.at(-1);
  expect(input&&'cmd' in input?input.cmd:undefined).toMatchObject({c:'standby',train:approaching.id});
  const replay=new Sim(s.config);restore(replay,checkpoint);applyInput(replay,input!);
  expect(replay.plan).toEqual(s.plan);expect(replay.trains.get(held.id)?.tasks).toEqual(held.tasks);
  expect(replay.trains.get(approaching.id)?.tasks).toEqual(approaching.tasks);
 });
 it('does not steal an unexpired reservation from the train that owns it',()=>{
  const {s,approaching}=fixture(21000);expect(canExchangeStabling(s,approaching)).toBe(false);
 });
 it('does not discard an approaching train’s rescue task',()=>{
  const {s,approaching}=fixture();approaching.tasks.push({k:'rescue',target:42});
  expect(canExchangeStabling(s,approaching)).toBe(false);
 });
 it('includes a reactivated block in yard stock previews without changing live completion state',()=>{
  const {s,held}=fixture();const depot=2;
  s.depotStock.fill(0);s.blockDone.add(held.block);
  s.plan.blocks[0].end={kind:'depot',depot};s.plan.trips[0].stops.at(-1)!.arr=s.t+10;
  s.plan.blocks[1].start={kind:'depot',depot,time:s.t+500};s.plan.blocks[1].end={kind:'stable',station:0};
  expect(planning.yardShortfall(s,s.plan)?.code).toBe('FLEET');
  expect(planning.yardShortfall(s,s.plan,new Set([held.block]))).toBeUndefined();
  expect(s.blockDone.has(held.block)).toBe(true);
 });
 it('rolls back the complete transaction if its preview is rejected',()=>{
  const {s,approaching}=fixture();vi.spyOn(planning,'noWorse').mockReturnValue(false);
  const before=structuredClone(s.plan);const result=s.command({c:'standby',train:approaching.id},'系统');
  expect(result.ok).toBe(false);expect(result.msg).toContain('原接续未通过预检');expect(s.plan).toEqual(before);
 });
 it('releases an expired slot by a boardable depot-bound trip when the approaching final trip has no successor',()=>{
  const {s,held,approaching,place}=fixture();vi.spyOn(planning,'noWorse').mockReturnValue(true);
  s.t=30000;
  const b=s.plan.blocks[approaching.block];b.trips=[1];b.end={kind:'depot',depot:2};b.relieved=true;
  s.plan.trips[2].cancelled=true;approaching.tasks=approaching.tasks.slice(0,1);approaching.relievedBy='other';
  s.blockDone.add(held.block);const checkpoint=capture(s);expect(canExchangeStabling(s,approaching)).toBe(true);
  const result=s.command({c:'standby',train:approaching.id});expect(result.ok,result.msg).toBe(true);
  expect(s.blockDone.has(held.block)).toBe(false);
  const move=s.plan.trips.at(-1)!;
  expect(move).toMatchObject({revenue:true,from:place.station,block:held.block,kind:'wd'});
  expect(move.stops[0]).toMatchObject({st:place.station,stop:true});expect(move.stops[0].noBoard).not.toBe(true);
  const boarding=held.tasks.find(task=>task.k==='stop');expect(boarding).toMatchObject({k:'stop',trip:move.id,revenue:true});
  if(boarding?.k==='stop')expect(s.topo.berths[boarding.berth].link).toBe(s.topo.berths[place.berth].link);
  expect(s.plan.blocks[approaching.block].end).toMatchObject({kind:'stable',berth:place.berth,holdFrom:-600,holdUntil:14400});
  expect(approaching.relievedBy).toBeUndefined();expect(s.inputLog.at(-1)).toMatchObject({cmd:{c:'standby',train:approaching.id}});
  const replay=new Sim(s.config);restore(replay,checkpoint);applyInput(replay,s.inputLog.at(-1)!);
  expect(replay.plan).toEqual(s.plan);expect(replay.trains.get(held.id)?.tasks).toEqual(held.tasks);
  expect(replay.trains.get(approaching.id)?.tasks).toEqual(approaching.tasks);
 });
 it('keeps both vehicles and both reservations untouched if no passenger connection is permitted',()=>{
  const {s,held,approaching}=fixture();vi.spyOn(planning,'noWorse').mockReturnValue(false);
  s.t=30000;
  const b=s.plan.blocks[approaching.block];b.trips=[1];b.end={kind:'depot',depot:2};s.plan.trips[2].cancelled=true;approaching.tasks=approaching.tasks.slice(0,1);
  const plan=structuredClone(s.plan),heldTasks=structuredClone(held.tasks),incomingTasks=structuredClone(approaching.tasks);
  const result=s.command({c:'standby',train:approaching.id});expect(result.ok).toBe(false);
  expect(result.msg).toContain('没有可行载客回段接续');expect(s.plan).toEqual(plan);
  expect(held.tasks).toEqual(heldTasks);expect(approaching.tasks).toEqual(incomingTasks);
 });
 it('uses the yard’s opposite-direction portal when that is the available passenger return',()=>{
  const {s,held,approaching,place}=fixture();vi.spyOn(planning,'noWorse').mockReturnValue(true);
  held.dir=held.dir===1?-1:1;
  s.t=30000;const b=s.plan.blocks[approaching.block];b.trips=[1];b.end={kind:'depot',depot:1};
  s.plan.trips[2].cancelled=true;approaching.tasks=approaching.tasks.slice(0,1);
  const result=s.command({c:'standby',train:approaching.id});expect(result.ok,result.msg).toBe(true);
  const move=s.plan.trips.at(-1)!;
  expect(move).toMatchObject({revenue:true,dir:'UP',from:place.station,block:held.block});
  expect(move.to).toBe(s.topo.depots[1].portals.entry.UP.station);
  expect(held.tasks[0]).toMatchObject({k:'reverse',station:place.station});
  const boarding=held.tasks.find(t=>t.k==='stop');expect(boarding).toMatchObject({k:'stop',revenue:true,trip:move.id});
  if(boarding?.k==='stop')expect(s.topo.berths[boarding.berth].link).toBe(s.topo.berths[place.berth].link);
 });
});
