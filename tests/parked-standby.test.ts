import './helpers/midline-storage';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {Sim} from '../src/sim/engine';
import {newTrain} from '../src/sim/ats';
import {computeBody,indexBodies} from '../src/sim/movement';
import {computeOccupancy,releaseRoute} from '../src/sim/interlocking';
import {hotStandby,standbyTakeover} from '../src/sim/standby';
import {hotStandbyPlaces,storageArrivalBerth} from '../src/sim/timetable';
import * as planning from '../src/sim/planning';

afterEach(()=>vi.restoreAllMocks());
describe('dispatch of a passenger-arrival hot spare',()=>{
 it.each([['KJG','UP'],['CXZ','UP'],['CXZ','DN']] as const)('uses the parked %s spare for an actual %s callout',(station,dir)=>{
  const s=new Sim({dayType:'weekend',dateLabel:'parked spare',startTime:14400,seed:1,noPossessions:true,autoRadio:true});
  s.autoDispatch=true;s.checkIntegrity=true;s.t=10*3600;
  for(const tr of [...s.trainList])s.removeTrain(tr);for(const id of [...s.routes.keys()])releaseRoute(s,id);
  for(const b of s.plan.blocks)s.blockDone.add(b.id);
  const place=hotStandbyPlaces(s.topo).find(p=>s.topo.stations[p.station].id===station)!;
  const incoming=s.plan.trips.find(t=>t.standby&&t.to===place.station)!;
  const hb=s.plan.blocks[incoming.block];expect(hb.end.kind).toBe('stable');
  const id=storageArrivalBerth(s.topo,place.berth,'DN')??place.berth,berth=s.topo.berths[id];
  const hot=newTrain(s,null,berth.link,berth.offset,berth.dir,[{link:berth.link,dir:berth.dir}],[...s.vehicles.keys()][0]);
  Object.assign(hot,{block:hb.id,phase:'stabled',v:0,tasks:[],manual:false,withdrawn:false,tripId:incoming.id});
  computeBody(s,hot);indexBodies(s);computeOccupancy(s);
  expect(hotStandby(s,hot)).toMatchObject({station:place.station,parked:true});
  const original=s.plan.trips.filter(t=>t.block!==hb.id&&t.dir===dir&&t.revenue&&!t.cancelled&&t.stops.some((p,i)=>
    p.st===place.station&&i>0&&i<t.stops.length-2&&p.stop&&p.dep>s.t+900))
    .sort((a,b)=>a.stops.find(p=>p.st===place.station)!.dep-b.stops.find(p=>p.st===place.station)!.dep)[0]!;
  expect(original).toBeDefined();const source=s.plan.blocks[original.block];source.trips=[original.id];source.relieved=false;original.cancelled=true;
  s.t=original.stops.find(p=>p.st===place.station)!.dep-500;
  s.depotStock.fill(0);vi.spyOn(planning,'noWorse').mockReturnValue(true);
  const taken=standbyTakeover(s,source.id,[original.id],'test');expect(taken?.id).toBe(hb.id);
  expect(hot.phase).toBe('run');const suffix=s.plan.trips.find(t=>t.no===`${original.no}续`)!;expect(suffix).toBeDefined();
  expect(hotStandby(s,hot)).toBeNull();
  if(station==='CXZ'){
   expect(suffix.hotCallout).toEqual({from:place.station,firstBoardable:suffix.stops.find((p,i)=>i>0&&p.stop&&!p.noBoard)!.st});
   expect(suffix.stops[0]).toMatchObject({stop:false,noBoard:true});
  }
  const target=suffix.hotCallout?.firstBoardable??place.station;let reached=false;
  for(let i=0;i<12000;i++){s.step();if(hot.tasks.some(t=>t.k==='stop'&&t.station===target)&&hot.phase==='dwell'){reached=true;break;}}
  if(!reached)console.log(JSON.stringify({station,dir,t:s.t,phase:hot.phase,link:hot.link,off:hot.off,heading:hot.dir,v:hot.v,tasks:hot.tasks.slice(0,3),halt:hot.halt,ars:hot.arsWait,events:s.events.slice(-5).map(e=>e.text),violations:s.integrity.counts}));
  expect(reached).toBe(true);expect(s.integrity.violations).toEqual([]);
 });
});
