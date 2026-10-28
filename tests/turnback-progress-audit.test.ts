import {afterEach,describe,expect,it,vi} from 'vitest';
import {Sim} from '../src/sim/engine';
import {newTrain} from '../src/sim/ats';
import {standbyTakeover} from '../src/sim/standby';
import * as timetable from '../src/sim/timetable';
import * as planning from '../src/sim/planning';
afterEach(()=>vi.restoreAllMocks());

describe('standby progress from an old checkpoint',()=>{
 it.each(['old-checkpoint','assignment-reset'] as const)('does not take over an already passed hot station after %s',kind=>{
  const sim=new Sim({dayType:'weekday',dateLabel:'old-checkpoint-progress',startTime:14400,seed:19,autoDispatch:true});
  for(const train of [...sim.trainList])sim.removeTrain(train);
  const place=timetable.hotStandbyPlaces(sim.topo).find(p=>p.station===17)!;
  const original=sim.plan.trips.find(t=>t.revenue&&t.dir==='UP'&&t.stops.some((s,i)=>s.st===place.station&&s.stop&&s.dep>sim.t+240&&i>0&&i+3<t.stops.length))!;
  const i=original.stops.findIndex(s=>s.st===place.station),cutIndex=i+2;
  original.cut={station:original.stops[cutIndex].st,stopIndex:cutIndex,cause:'turnback'};original.cancelled=true;
  const source=sim.plan.blocks[original.block];source.trips=[original.id];source.relieved=false;
  const own=sim.plan.trips.find(t=>t.block!==original.block&&t.dir===original.dir&&!t.cancelled)!;
  const hotBlock=sim.plan.blocks[own.block];hotBlock.trips=[own.id];
  const hotBerth=sim.topo.berths[place.berth],vehicle=[...sim.vehicles.keys()][0];
  const hot=newTrain(sim,null,hotBerth.link,hotBerth.offset,hotBerth.dir,[{link:hotBerth.link,dir:hotBerth.dir}],vehicle);
  Object.assign(hot,{block:hotBlock.id,tripId:own.id,phase:'run',v:0,manual:false,withdrawn:false,relievedBy:undefined,lastCompletedCall:{trip:own.id,stopIndex:-1}});
  hot.tasks=[{k:'stop',berth:place.berth,station:place.station,trip:own.id,arr:null,dep:sim.t+1000,doors:false,revenue:false,standby:true}];
  const next=original.stops[i+1],nextBerth=sim.topo.berths[timetable.platformBerth(sim.topo,next.st,original.dir)];
  const sourceVehicle=[...sim.vehicles.keys()].find(v=>v!==vehicle)!;
  const tr=newTrain(sim,null,nextBerth.link,nextBerth.offset,nextBerth.dir,[{link:nextBerth.link,dir:nextBerth.dir}],sourceVehicle);
  Object.assign(tr,{block:source.id,tripId:original.id,phase:'run',lastStation:place.station});
  if(kind==='old-checkpoint') delete tr.lastCompletedCall;
  else tr.lastCompletedCall={trip:original.id,stopIndex:-1}; // assignment reset after a mid-trip exchange
  tr.tasks=[];timetable.tripTasks(sim.topo,original,tr.tasks,false);
  tr.tasks=tr.tasks.slice(tr.tasks.findIndex(t=>t.k==='stop'&&t.station===next.st));
  if(kind==='old-checkpoint') for(const task of tr.tasks)if(task.k==='stop')delete task.stopIndex;
  vi.spyOn(timetable,'standbyCandidate').mockImplementation((_ctx,_plan,_tail,depot,notBefore)=>
   ({depot,k:0,start:notBefore,dir:original.dir,from:place.station,to:place.station,stops:null}));
  vi.spyOn(planning,'noWorse').mockReturnValue(true);
  const before=sim.plan.trips.length,result=standbyTakeover(sim,source.id,[original.id],'audit');
  expect(result?.id).not.toBe(hotBlock.id);
  const suffix=sim.plan.trips.slice(before).find(t=>t.no===`${original.no}续`)!;
  expect(suffix).toBeDefined();expect(suffix.from).toBe(next.st);
  expect(suffix.to).toBe(original.stops[cutIndex].st);
  expect(suffix.stops.map(s=>s.st)).toEqual(original.stops.slice(i+1,cutIndex+1).map(s=>s.st));
 });
});
