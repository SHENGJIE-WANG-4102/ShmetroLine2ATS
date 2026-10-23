import {Sim}from'../../src/sim/engine';
import {STATIONS}from'../../src/data/current';
import {platformBerth,addTurnback}from'../../src/sim/timetable';
import {computeBody,indexBodies}from'../../src/sim/movement';
import {ahead}from'../../src/sim/topology';
import type{Task}from'../../src/sim/model';

/** A real, empty-line terminal arrival with an already-due next departure.
 * No timetable wait is available to absorb driver work. */
export function runAmTurnback(mode:'DTO'|'AM',stationId:string,incoming:'DN'|'UP'){
 const sim=new Sim({dayType:'weekday',date:'2026-10-23',dateLabel:'am-turnback',startTime:14400,seed:7,noPossessions:true,autoRadio:true});
 const tr=sim.trainList[0],station=STATIONS.findIndex(s=>s.id===stationId);
 const outgoing:'DN'|'UP'=incoming==='DN'?'UP':'DN';
 const next=sim.topo.stations.find(s=>ahead(outgoing,station,s.index)&&Math.abs(s.index-station)===1)!.index;
 for(const other of[...sim.trainList])if(other!==tr)sim.removeTrain(other);
 for(const trip of sim.plan.trips)trip.completed=true;for(const block of sim.plan.blocks)sim.blockDone.add(block.id);
 const start=sim.t,arrivalId=sim.plan.trips.length,departureId=arrivalId+1,block=sim.plan.blocks.length;
 const arrival={...sim.plan.trips[0],id:arrivalId,no:'am-arr',from:next,to:station,dir:incoming,block,completed:false,cancelled:false,revenue:true,
  stops:[{st:next,arr:start-200,dep:start-200,stop:true},{st:station,arr:start,dep:start,stop:true}]};
 const departure={...arrival,id:departureId,no:'am-dep',from:station,to:next,dir:outgoing,
  stops:[{st:station,arr:start,dep:start,stop:true},{st:next,arr:start+1000,dep:start+1000,stop:true}]};
 sim.plan.trips.push(arrival,departure);
 const tasks:Task[]=[{k:'stop',station,berth:platformBerth(sim.topo,station,incoming),trip:arrivalId,arr:start,dep:null,doors:true,revenue:true}];
 addTurnback(sim.topo,arrival,tasks);
 const reverse=tasks.find((t):t is Extract<Task,{k:'reverse'}>=>t.k==='reverse')!;
 tasks.push({k:'stop',station,berth:platformBerth(sim.topo,station,outgoing),trip:departureId,arr:null,dep:start,doors:true,revenue:true},
  {k:'stop',station:next,berth:platformBerth(sim.topo,next,outgoing),trip:departureId,arr:start+1000,dep:null,doors:true,revenue:true});
 const first=tasks[0] as Extract<Task,{k:'stop'}>,berth=sim.topo.berths[first.berth];
 sim.plan.blocks.push({...sim.plan.blocks[0],id:block,svc:'am-turn',trips:[arrivalId,departureId],start:{kind:'stable',station,berth:berth.id},end:{kind:'none'},train:tr.id});
 sim.blockDone.add(block);
 Object.assign(tr,{link:berth.link,off:berth.offset,dir:berth.dir,hist:[{link:berth.link,dir:berth.dir}],recentBody:undefined,
  phase:'run',phaseSince:start,arrivedAt:start,v:0,a:0,mode,manual:false,atoDriver:false,doorsAwait:false,doorsOpen:false,doorSide:'',
  doorMotion:undefined,doorLockedAt:0,autoStartAt:undefined,autoOpenAt:undefined,atoButtons:{f:false,g:false},vfault:null,eb:false,failed:false,
  hold:false,block,tripId:arrivalId,svc:'am-turn',tripNo:arrival.no,inService:true,tasks,load:0,tbStage:'none',depotStage:'none',
  stopUntil:0,stopDist:0,maDist:1000,maFar:1000,lastMa:Infinity,lastDs:0,stopsMade:0});
 sim.atoLine=mode==='AM';for(const p of sim.plat)p.waiting=0;
 computeBody(sim,tr);indexBodies(sim);
 let lastClose=0;const closes:{at:number;locked:number;departure:number|null}[]=[],reversals:{at:number;until:number}[]=[];
 let reversalSeen=false;
 while(sim.t<start+1200){
  sim.step();
  if(tr.doorMotion?.kind==='closing'&&tr.doorLockedAt!==lastClose){lastClose=tr.doorLockedAt!;closes.push({at:sim.t,locked:lastClose,departure:null});}
  if(tr.phase==='reversing'&&!reversalSeen){reversals.push({at:sim.t,until:tr.dwellUntil});reversalSeen=true;}
  const left=sim.depLog.find(d=>d.trip===departureId&&d.st===station);
  if(left){closes.at(-1)!.departure=left.t;return{mode,stationId,incoming,start,departure:left.t,elapsed:left.t-start,closes,reversals,
    reverseBerthKind:sim.topo.berths[reverse.chosen].kind,violations:sim.integrity.violations.slice(),halt:tr.halt};}
 }
 throw Error(`Turnback did not finish ${mode}/${stationId}: ${JSON.stringify({phase:tr.phase,task:tr.tasks[0],halt:tr.halt,closes,reversals})}`);
}
