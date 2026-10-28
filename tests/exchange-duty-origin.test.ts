import {describe,it,expect} from 'vitest';
import {Sim} from '../src/sim/engine';
import type {Trip,StopTask} from '../src/sim/model';
import {exchangePartner} from '../src/sim/ats';
import {buildStops,tripTasks,platformBerth,blockTasks} from '../src/sim/timetable';
import {computeBody,indexBodies} from '../src/sim/movement';

function fixture(station:number){
 const sim=new Sim({dayType:'weekday',date:'2026-10-19',dateLabel:'exchange-origin',startTime:14400,seed:129,noPossessions:true,autoDispatch:false});
 sim.t=32100;
 const late=sim.trainList[0],rear=structuredClone(late);
 for(const tr of [...sim.trainList])if(tr!==late)sim.removeTrain(tr);
 rear.id=999;rear.vehicle='02092';sim.addTrain(rear);
 const first=sim.plan.trips.length,block=sim.plan.blocks.length;
 const makeTrip=(id:number,from:number,departure:number,blockId:number):Trip=>{
  const stops=buildStops(sim.planCtx,'DN',from,30,0,true,1);
  const shift=departure-stops.find(s=>s.st===station)!.dep;
  return{id,no:String(id+1000),dir:'DN',kind:'big',from,to:30,revenue:true,block:blockId,
   stops:stops.map(s=>({...s,arr:s.arr+shift,dep:s.dep+shift}))};
 };
 const old=makeTrip(first,28,sim.t-900,block),timely=makeTrip(first+1,0,sim.t,block+1);
 sim.plan.trips.push(old,timely);
 sim.plan.blocks.push({id:block,svc:'070',start:{kind:'depot',depot:2,time:28000},end:{kind:'depot',depot:0},trips:[old.id],train:late.id},
  {id:block+1,svc:'041',start:{kind:'depot',depot:0,time:20000},end:{kind:'depot',depot:1},trips:[timely.id],train:rear.id});
 for(const [tr,trip,phase]of [[late,old,'dwell'],[rear,timely,'run']]as const){
  const berth=sim.topo.berths[platformBerth(sim.topo,station,'DN')];
  Object.assign(tr,{block:trip.block,svc:sim.plan.blocks[trip.block].svc,tripId:trip.id,tripNo:trip.no,
   phase,link:berth.link,off:berth.offset,dir:berth.dir,hist:[{link:berth.link,dir:berth.dir}],
   recentBody:undefined,inService:true,failed:false,manual:false,mode:'DTO',coupledLen:0,withdrawn:false,
   relievedBy:undefined,rescuing:-1,rescueBy:-1,doorsOpen:false,doorsAwait:false});
  tr.tasks=[];tripTasks(sim.topo,trip,tr.tasks,false);
  tr.tasks=tr.tasks.slice(tr.tasks.findIndex(t=>t.k==='stop'&&t.station===station));
  const current=tr.tasks[0]as StopTask;current.arr=trip.stops.find(s=>s.st===station)!.arr;
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
 return{sim,late,rear,old,timely};
}

describe('online duty exchange joins the actual service call',()=>{
 it.each([2,0])('keeps the actual unfinished depot exit when the incoming duty has depot %s as its source',incomingDepot=>{
  const {sim,late,rear,old,timely}=fixture(29),block=sim.plan.blocks[rear.block];
  sim.plan.blocks[late.block].start={kind:'depot',depot:incomingDepot,time:sim.t-300};
  block.start={kind:'depot',depot:2,time:sim.t-300};
  timely.from=28;timely.stops=timely.stops.filter(s=>s.st>=28);
  rear.tasks=blockTasks(sim.topo,sim.plan,block);
  const prefix=rear.tasks[0]as StopTask;
  expect(prefix).toMatchObject({station:28,trip:timely.id,revenue:false,note:'出段换端'});
  const berth=sim.topo.berths[prefix.berth];
  Object.assign(rear,{phase:'dwell',link:berth.link,off:berth.offset,dir:berth.dir,
   hist:[{link:berth.link,dir:berth.dir}],recentBody:undefined});
  computeBody(sim,rear);indexBodies(sim);
  expect(exchangePartner(sim,late)).toBe(rear);
  const reverse=structuredClone(rear.tasks[1]);
  expect(sim.command({c:'exchangeDuty',train:late.id,with:rear.id}).ok).toBe(true);
  expect(rear.tasks[0]).toMatchObject({k:'stop',station:28,trip:old.id,revenue:false,arr:null,dep:null});
  expect(rear.tasks[1]).toEqual(reverse);
  expect(rear.tasks[2]).toMatchObject({k:'stop',station:28,trip:old.id,revenue:true});
  expect(rear.tasks.at(-1)).toMatchObject({k:'depot',depot:0});
 });
 it.each([28,29])('does not replay the depot departure prefix when the rear train takes over at station %s',station=>{
  const {sim,late,rear,old,timely}=fixture(station);
  const generated=blockTasks(sim.topo,sim.plan,sim.plan.blocks[old.block]);
  expect(generated.some(t=>t.k==='stop'&&t.note==='出段换端')).toBe(true);
  expect(exchangePartner(sim,late)).toBe(rear);
  const positions=[late,rear].map(t=>({link:t.link,off:t.off,dir:t.dir}));
  expect(sim.command({c:'exchangeDuty',train:late.id,with:rear.id}).ok).toBe(true);
  expect([late.tripId,rear.tripId]).toEqual([timely.id,old.id]);
  const head=rear.tasks[0]as StopTask,call=old.stops.find(s=>s.st===station)!;
  expect(head).toMatchObject({k:'stop',station,trip:old.id,arr:call.arr,dep:call.dep,revenue:true,doors:true});
  expect(rear.tasks.some(t=>t.k==='stop'&&t.note==='出段换端')).toBe(false);
  expect(rear.tasks[1]).toMatchObject({k:'stop',station:station+1,trip:old.id,revenue:true});
  expect(rear.tasks.at(-1)).toMatchObject({k:'depot',depot:0});
  expect([late,rear].map(t=>({link:t.link,off:t.off,dir:t.dir}))).toEqual(positions);
  expect(old.cancelled).not.toBe(true);expect(timely.cancelled).not.toBe(true);
 });
});
