import './helpers/midline-storage';
import {describe,it,expect} from 'vitest';
import {Sim} from '../src/sim/engine';
import {LINE_INFO} from '../src/data/current';
import {appendBlockEndTasks,hotStandbyPlaces,platformBerth,storageArrivalBerth} from '../src/sim/timetable';
import type {Block,Task} from '../src/sim/model';
import {computeBody,indexBodies} from '../src/sim/movement';
import {computeOccupancy,releaseRoute} from '../src/sim/interlocking';
import {arbitrateResources} from '../src/sim/resourceArbitration';
import {berthFits,reversedBerthPoint,safeWaitingPoint} from '../src/sim/topology';
import {routePathStart,walkRouteToBerth} from '../src/sim/routePath';
import { fixtureTrains } from './helpers/fixture-train';
import { storageExit } from './helpers/storage-exit';

function scene(blocked=false, incoming: 'UP' | 'DN' = 'UP') {
 const s=new Sim({dayType:'weekday',date:'2026-10-19',dateLabel:'local shunt',startTime:14400,seed:1,noPossessions:true,autoRadio:true});
 s.checkIntegrity=true;for(const id of [...s.routes.keys()])releaseRoute(s,id);
 const [tr,second]=fixtureTrains(s, blocked?2:1),other=blocked?second:undefined;
 for(const x of [...s.trainList])if(x!==tr&&x!==other)s.removeTrain(x);
 for(const b of s.plan.blocks)s.blockDone.add(b.id);
 const place=hotStandbyPlaces(s.topo).find(x=>x.emptyCalloutToFirstPlatform&&x.incoming)!;
 expect(place).toBeDefined();const station=s.topo.stations[place.station], direction=incoming;
 const id=station.shuntEntries.find(entry=>entry.incoming===direction && entry.storageLink===s.topo.berths[place.berth].link)?.berth!;expect(id).toBeDefined();const shunt=s.topo.berths[id];
 const goal=storageArrivalBerth(s.topo,place.berth,direction==='UP'?'DN':'UP')!;
 const platform=s.topo.berths[platformBerth(s.topo,place.station,direction)];
 const tasks:Task[]=[];
 const block:Block={id:-1,svc:'',start:{kind:'stable',station:place.station},end:{kind:'stable',station:place.station,berth:place.berth},trips:[]};
 appendBlockEndTasks(s.topo,s.plan,block,{...s.plan.trips[0],to:place.station,dir:direction},tasks);
 expect(tasks).toMatchObject([{k:'reverse',chosen:id},{k:'stable',berth:goal}]);
 Object.assign(tr,{link:platform.link,off:platform.offset,dir:platform.dir,hist:[{link:platform.link,dir:platform.dir}],phase:'run',phaseSince:s.t,v:0,a:0,mode:'DTO',manual:false,failed:false,eb:false,block:-1,tripId:-1,inService:false,tbStage:'none',load:0,
   tasks});
 computeBody(s,tr);
 if(other){Object.assign(other,{link:shunt.link,off:90,dir:shunt.dir,hist:[{link:shunt.link,dir:shunt.dir}],phase:'stabled',v:0,a:0,tasks:[],block:-1,failed:false});computeBody(s,other)}
 indexBodies(s);computeOccupancy(s);return{s,tr,other,shunt,goal,platform};
}

describe('local storage-entry pull-out',()=>{
 it.each(['weekday','weekend'] as const)('%s: leaves a middle-track overnight berth by a protected local shunt and boards at its origin',(dayType)=>{
  const s=new Sim({dayType,date:'2026-10-19',dateLabel:'local departure',startTime:14400,seed:1,noPossessions:true});
  s.checkIntegrity=true;
  const {block,trip,tr}=storageExit(s);
  expect(tr.tasks.slice(0,3).map(t=>t.k)).toEqual(['reverse','reverse','stop']);
  for(const other of [...s.trainList])if(other!==tr)s.removeTrain(other);
  for(const b of s.plan.blocks)if(b.id!==block.id)s.blockDone.add(b.id);
  s.t=trip.stops[0].dep-600;
  const initial=tr.link, initialOff=tr.off;
  for(let i=0;i<1000;i++)s.step();
  expect(tr.link).toBe(initial);expect(tr.off).toBeCloseTo(initialOff,3);
  for(let i=0;i<7000&&!(tr.phase==='dwell'&&tr.tasks[0]?.k==='stop'&&tr.tasks[0].station===trip.from);i++)s.step();
  expect(tr.phase).toBe('dwell');expect(tr.tasks[0]).toMatchObject({k:'stop',station:trip.from,revenue:true});
  expect(s.integrity.violations).toEqual([]);
 });
 it('keeps the overnight departure in storage when its local shunt is occupied',()=>{
  const s=new Sim({dayType:'weekday',date:'2026-10-19',dateLabel:'blocked local departure',startTime:14400,seed:1,noPossessions:true});
  const {block,trip,tr}=storageExit(s),other=s.trainList.find(t=>t!==tr)!;
  for(const x of [...s.trainList])if(x!==tr&&x!==other)s.removeTrain(x);
  for(const b of s.plan.blocks)if(b.id!==block.id)s.blockDone.add(b.id);
  const task=tr.tasks[0];expect(task.k).toBe('reverse');if(task.k!=='reverse')return;
  const berth=s.topo.berths[task.chosen];
  Object.assign(other,{link:berth.link,off:berth.offset,dir:berth.dir,hist:[{link:berth.link,dir:berth.dir}],phase:'stabled',v:0,a:0,tasks:[],block:-1,failed:false});
  computeBody(s,other);indexBodies(s);computeOccupancy(s);s.t=trip.stops[0].dep-180;
  const start=tr.link;
  for(let i=0;i<100;i++)s.step();
  const decision=arbitrateResources(s).decisions.get(tr.id);
  expect(decision).toBeDefined();expect(decision!.admitted).toBe(false);
  expect(decision!.blocker).toBe(other.id);expect(tr.link).toBe(start);
 });
 it.each(['UP','DN'] as const)('clears the complete %s consist, reverses behind its signal and reaches storage',(direction)=>{
  const {s,tr,shunt,goal,platform}=scene(false,direction);const reversed=reversedBerthPoint(s.topo,shunt.id,LINE_INFO.trainLength)!;
  const onward=routePathStart(s.topo,reversed,goal)!;expect('start' in onward).toBe(true);
  if(!('start' in onward))throw new Error('missing protected shunt signal');
  expect(onward.approach).toBeGreaterThanOrEqual(6);
  expect(Number.isFinite(walkRouteToBerth(s.topo,s.routeTable,onward.start,goal))).toBe(true);
  const start=routePathStart(s.topo,{link:platform.link,off:platform.offset,dir:platform.dir},shunt.id)!;
  expect('start' in start).toBe(true);
  let protectedBoth=false,reverse=false;
  for(let i=0;i<4000&&tr.phase!=='stabled';i++){
   s.step();
   if(i===10){const q=arbitrateResources(s).decisions.get(tr.id);protectedBoth=!!q?.admitted&&!!q.option&&q.option.phases.some(x=>x.goal===shunt.id)&&q.option.phases.some(x=>x.goal===goal);}
   if(tr.phase==='reversing')reverse=true;
   expect(s.integrity.violations).toEqual([]);
  }
  expect(protectedBoth).toBe(true);expect(reverse).toBe(true);expect(tr.phase).toBe('stabled');
  expect(tr.link).toBe(s.topo.berths[goal].link);
 });
 it('does not grant entry when another train occupies the shunt',()=>{
  const {s,tr,other,platform}=scene(true);for(let i=0;i<10;i++)s.step();
  const q=arbitrateResources(s).decisions.get(tr.id);expect(q).toBeDefined();expect(q!.admitted).toBe(false);expect(q!.blocker).toBe(other!.id);
  expect(tr.link).toBe(platform.link);
  expect(s.integrity.violations).toEqual([]);
 });
 it('does not admit a coupled consist whose rear cannot clear the reverse signal',()=>{
  const {s,tr,shunt,platform}=scene();
  expect(berthFits(s.topo,shunt.id,LINE_INFO.trainLength)).toBe(true);
  expect(berthFits(s.topo,shunt.id,LINE_INFO.trainLength*2)).toBe(false);
  expect(safeWaitingPoint(s.topo,shunt.id,LINE_INFO.trainLength*2)).toBe(false);
  tr.len=LINE_INFO.trainLength*2;
  tr.coupledLen=LINE_INFO.trainLength;
  computeBody(s,tr);indexBodies(s);computeOccupancy(s);
  for(let i=0;i<10;i++)s.step();
  const q=arbitrateResources(s).decisions.get(tr.id);
  expect(q?.admitted ?? false).toBe(false);
  expect(tr.link).toBe(platform.link);
  expect(tr.arsWait?.detail).toContain('不足以容纳整列车');
 });
});

