import {describe,it,expect} from 'vitest';
import {Sim} from '../src/sim/engine';
import type {Trip,StopTask} from '../src/sim/model';
import {exchangePartner} from '../src/sim/ats';
import {buildStops,tripTasks,platformBerth} from '../src/sim/timetable';
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


describe('duty exchange uses the actual cut service',()=>{
 it('rebuilds both duties only through their cut station',()=>{
  const {sim,late,rear,old,timely}=fixture(29);
  for(const trip of [old,timely]){
   const index=trip.stops.findIndex(s=>s.st===29);
   trip.cut={station:29,stopIndex:index,cause:'turnback'};
  }
  expect(exchangePartner(sim,late)).toBe(rear);
  expect(sim.command({c:'exchangeDuty',train:late.id,with:rear.id}).ok).toBe(true);
  for(const [train,trip] of [[late,timely],[rear,old]] as const){
   const calls=train.tasks.filter(t=>t.k==='stop'&&t.trip===trip.id&&t.revenue);
   expect(calls.length).toBeGreaterThan(0);
   expect(calls.at(-1)).toMatchObject({station:29,stopIndex:trip.cut!.stopIndex});
   expect(calls.some(t=>t.k==='stop'&&t.station===30)).toBe(false);
   expect(trip.to).toBe(30);
  }
 });
});
