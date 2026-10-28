import {describe,it,expect} from 'vitest';
import {Sim} from '../src/sim/engine';
import type {Trip,StopTask} from '../src/sim/model';
import {exchangePartner} from '../src/sim/ats';
import {buildStops,tripTasks,platformBerth,effectiveEnd} from '../src/sim/timetable';
import {computeBody,indexBodies} from '../src/sim/movement';
import {capture,restore} from '../src/sim/state';

describe('turnback then duty exchange',()=>{
 it('rebuilds the earlier shortened trip through its actual terminal',()=>{
  const sim=new Sim({dayType:'weekday',date:'2026-10-19',dateLabel:'turnback-exchange',startTime:14400,seed:125,noPossessions:true,autoDispatch:false});
  sim.t=31000;
  const late=sim.trainList[0],rear=structuredClone(late);
  for(const tr of [...sim.trainList])if(tr!==late)sim.removeTrain(tr);
  rear.id=999;rear.vehicle='02092';sim.addTrain(rear);
  const first=sim.plan.trips.length,block=sim.plan.blocks.length;
  const makeTrip=(id:number,from:number,to:number,departure:number,blockId:number):Trip=>{
   const stops=buildStops(sim.planCtx,'DN',from,to,0,true,1);
   const shift=departure-stops.find(s=>s.st===27)!.dep;
   return{id,no:String(id+1000),dir:'DN',kind:'big',from,to,revenue:true,block:blockId,
    stops:stops.map(s=>({...s,arr:s.arr+shift,dep:s.dep+shift}))};
  };
  const old=makeTrip(first,27,30,31200,block), timely=makeTrip(first+1,0,28,32100,block+1);
  const next:Trip={id:first+2,no:'1040',dir:'UP',kind:'big',from:30,to:19,
   stops:buildStops(sim.planCtx,'UP',30,19,33000,true,1),revenue:true,block};
  sim.plan.trips.push(old,timely,next);
  sim.plan.blocks.push({id:block,svc:'070',start:{kind:'depot',depot:2,time:27000},end:{kind:'depot',depot:1},trips:[old.id,next.id],train:late.id},
   {id:block+1,svc:'041',start:{kind:'depot',depot:0,time:20000},end:{kind:'depot',depot:0},trips:[timely.id],train:rear.id});
  for(const [tr,trip,phase]of [[late,old,'dwell'],[rear,timely,'run']]as const){
   const berth=sim.topo.berths[platformBerth(sim.topo,27,'DN')];
   Object.assign(tr,{block:trip.block,svc:sim.plan.blocks[trip.block].svc,tripId:trip.id,tripNo:trip.no,
    phase,link:berth.link,off:berth.offset,dir:berth.dir,hist:[{link:berth.link,dir:berth.dir}],
    recentBody:undefined,inService:true,failed:false,manual:false,mode:'DTO',coupledLen:0,withdrawn:false,
    relievedBy:undefined,rescuing:-1,rescueBy:-1,doorsOpen:false,doorsAwait:false});
   tr.tasks=[];tripTasks(sim.topo,trip,tr.tasks,false);
   tr.tasks=tr.tasks.slice(tr.tasks.findIndex(t=>t.k==='stop'&&t.station===27));
   const current=tr.tasks[0]as StopTask;current.arr=trip.stops.find(s=>s.st===27)!.arr;
   if(tr===rear){
    const platform=sim.topo.links[berth.link];
    const approach=sim.topo.links.filter(l=>l.track==='DN'&&l.len>tr.len+20
     &&Math.max(l.chainA,l.chainB)<Math.min(platform.chainA,platform.chainB))
     .sort((a,b)=>Math.max(b.chainA,b.chainB)-Math.max(a.chainA,a.chainB))[0];
    tr.link=approach.id;tr.dir=approach.chainB>approach.chainA?1:-1;
    tr.off=tr.dir===1?approach.len-10:10;tr.hist=[{link:tr.link,dir:tr.dir}];
   }
   computeBody(sim,tr);
  }
  indexBodies(sim);
  const original=structuredClone(old.stops);
  const result=sim.command({c:'turnback',train:late.id,station:28});
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(old.cut).toMatchObject({station:28});
  expect(old.stops).toEqual(original);
  const checkpoint=capture(sim), savedTasks=structuredClone(late.tasks), cut=structuredClone(old.cut);
  const turnTask=late.tasks.find(t=>t.k==='stop'&&t.trip===old.id&&t.station===27) as StopTask;
  expect(turnTask).toBeDefined();
  turnTask.arr=old.stops.find(s=>s.st===27)!.arr;
  sim.t=32100;
  expect(exchangePartner(sim,late)).toBe(rear);
  expect(sim.command({c:'exchangeDuty',train:late.id,with:rear.id})).toMatchObject({ok:true});
  const calls=rear.tasks.filter((t):t is StopTask=>t.k==='stop'&&t.trip===old.id&&t.revenue);
  expect(calls.at(-1)).toMatchObject({station:28,dep:null,stopIndex:old.cut!.stopIndex});
  expect(calls.some(t=>t.station===30)).toBe(false);
  expect(effectiveEnd(old)).toBe(28);expect(old.to).toBe(30);expect(old.stops).toEqual(original);
  const adjusted=sim.plan.trips.find(t=>t.kind==='adj'&&t.from===28&&t.dir==='UP');
  expect(adjusted).toBeDefined();
  expect(rear.tasks.some(t=>t.k==='stop'&&t.trip===adjusted!.id&&t.station===28)).toBe(true);
  restore(sim,checkpoint);
  expect(sim.plan.trips[old.id].cut).toEqual(cut);
  expect(sim.plan.trips[old.id].stops).toEqual(original);
  expect(sim.trains.get(late.id)?.tasks).toEqual(savedTasks);
 });
});
