import {describe,it,expect} from 'vitest';
import {Sim} from '../src/sim/engine';
import {nextOperatingConfig,carryWorld,DAY_S} from '../src/sim/operatingDay';
import {capture,restore,DAY_STATE} from '../src/sim/state';
import {exportDiagnostics,parseDiagnostics,stringifyDiagnostics,replayDiagnostics} from '../src/sim/diagnostics';
import {computeBody,indexBodies} from '../src/sim/movement';
import {spawnDue,updateTrainTasks} from '../src/sim/ats';
import {overnightPlaces} from '../src/sim/timetable';
import {runUntil,assertIntegrity} from './helpers';

/** Stage a settled shutdown; the integration below runs only 26:30–05:30. */
function night(){
 const s=new Sim({dayType:'weekday',date:'2026-10-19',dateLabel:'test',startTime:26.5*3600,seed:3,noPossessions:true});
 const places=overnightPlaces(s.topo);
 s.trainList.forEach((tr,i)=>{const b=s.topo.berths[places[i].arrivalBerth];Object.assign(tr,{link:b.link,off:b.offset,dir:b.dir,hist:[{link:b.link,dir:b.dir}],tasks:[],phase:'stabled',inService:false,v:0});computeBody(s,tr);});
 s.berthRes.clear();s.blockDone=new Set(s.plan.blocks.map(b=>b.id));s.t=26.5*3600;indexBodies(s);
 return s;
}
describe('continuous operating days',()=>{
 it('keeps the real cars and remaining tasks through 03:45, then finishes a 27:30 extra',()=>{
  let s=night();
  const result=s.command({c:'addTrain',depot:0,dir:'DN',to:12,time:27.5*3600});
  expect(result.ok,result.msg).toBe(true);
  runUntil(s,27.75*3600);assertIntegrity(s);
  const running=s.trainList.find(t=>t.tasks.length)!;
  expect(running).toBeDefined();
  expect(s.vehicles.get(running.vehicle)!.km).toBeGreaterThan(0);
  const original={id:running.id,vehicle:running.vehicle,link:running.link,off:running.off,dir:running.dir};
  const yards=structuredClone(s.yards),oldIds=s.trainList.map(t=>t.id),stock=nextOperatingConfig(s).depotStock!;
  expect(stock.reduce((a,b)=>a+b,0)).toBe(s.depotStock.reduce((a,b)=>a+b,0)+1);
  const homes=s.trainList.filter(t=>!t.tasks.length).map(t=>({id:t.id,vehicle:t.vehicle}));
  // World transfer preserves every track; the subsequent maintenance step
  // explicitly performs the authorized night shunt.
  const transferred=new Sim(nextOperatingConfig(s));carryWorld(transferred,s);
  expect(transferred.yards).toEqual(yards);
  s=new Sim(nextOperatingConfig(s),s);
  expect(s.t).toBeCloseTo(3.75*3600,4);
  expect(s.trains.get(original.id)).toMatchObject(original);
  expect(s.trainList.map(t=>t.id)).toEqual(oldIds);expect(s.yards.map(y=>y.tracks.flat().sort())).toEqual(yards.map(y=>y.tracks.flat().sort()));
  for(const home of homes){expect(s.trains.get(home.id)?.vehicle).toBe(home.vehicle);expect(s.trains.get(home.id)?.block).toBeGreaterThanOrEqual(0);}
  const remaining=s.trains.get(original.id)!;
  for(const task of remaining.tasks)if(task.k==='stop'&&task.trip>=0)expect(s.plan.trips[task.trip].block).toBe(remaining.block);
  runUntil(s,5.5*3600);assertIntegrity(s);
  expect(s.trains.has(original.id)).toBe(false);
  expect(s.events.some(e=>e.text.includes(original.vehicle)&&/入.*(段|场)/.test(e.text))).toBe(true);
  expect(s.events.some(e=>e.text.includes('存车位无车'))).toBe(false);
 },120000);
 it('adopts a real overnight arrival which only finishes after 04:00',()=>{
  let s=night();s.t=99900;
  const place=overnightPlaces(s.topo)[0],old=s.trainList[0];
  old.tasks=[{k:'stable',berth:place.arrivalBerth,reason:'late overnight'}];old.phase='run';
  const id=old.id,vehicle=old.vehicle;
  s=new Sim(nextOperatingConfig(s),s);
  const waiting=s.plan.blocks.find(b=>b.start.kind==='stable'&&b.start.berth===place.berth)!;
  expect(waiting.train).toBeUndefined();
  // Complete a carried duty at its actual berth after the former opening-only window.
  const tr=s.trains.get(id)!;const carried={...waiting,id:s.plan.blocks.length,trips:[],train:id};
  s.plan.blocks.push(carried);tr.block=carried.id;
  s.t=4.2*3600;tr.stopDist=0;updateTrainTasks(s,tr,0);
  expect(s.blockDone.has(carried.id)).toBe(true);
  spawnDue(s);
  expect(waiting.train).toBe(id);expect(s.trains.get(id)?.vehicle).toBe(vehicle);
  expect(tr.block).toBe(waiting.id);
 });
 it('rebases every carried clock and preserves routes, faults, calls and weather',()=>{
  const s=night();s.t=99900;
  const stamp=100000;
  Object.assign(s.trainList[0],{ebSince:stamp,ebCallAt:stamp,modeSince:stamp,tbCallAt:stamp,pendingModeAt:stamp,phaseSince:stamp,dwellUntil:stamp,doorLockedAt:stamp,arrivedAt:stamp,depReadyAt:stamp,failRecoverAt:stamp,lastTraceT:stamp,stopUntil:stamp,waitSince:stamp});
  const berth=s.topo.berths.find(b=>b.kind==='platform')!;
  s.trainList[0].departureDisplay={stop:{k:'stop',berth:berth.id,station:berth.station,trip:-1,arr:stamp,dep:stamp,doors:true,revenue:true},at:stamp,remaining:-2,side:'L',headLeftAt:stamp};
  s.trainList[0].vRecommended=11;
  s.trainList[0].doorMotion={kind:'closing',platform:berth.platform,trainAt:stamp,psdAt:stamp-.3};
  s.sw[0].moveUntil=stamp;s.plat[0].lastDep=stamp;s.plat[0].lastArr=stamp;s.plat[0].limitUntil=stamp;
  const ar=[...s.routes.values()][0];ar.committed=70001;ar.arsTrain=70002;ar.guideUntil=stamp;ar.cancelAt=stamp;ar.setAt=stamp;
  s.command({c:'fault',kind:'signal',target:0,duration:0});
  s.faults[0].stageAt=stamp;
  s.env.wind=2;s.env.windUntil=stamp;s.env.rainUntil=stamp;s.env.dryAt=stamp;
  s.possessions=[{id:9,name:'test',sections:[0],from:90000,to:stamp,state:'active'}];s.sec[0].poss=9;s.sec[0].blocked=true;
  s.calls=[{id:7,t:stamp,deadline:stamp,kind:'possRel',target:9,from:'test',text:'test',options:[],auto:'',state:'ringing',repeats:0}];
  s.pendingCalls=[{at:stamp,spec:{kind:'possReq',target:9,from:'test',text:'test',options:[],auto:'',timeout:10}}];
  s.dispatcher.next.set('test',stamp);s.vehicleResets=[{train:s.trainList[0].id,at:stamp,fault:1}];
  s.log('B','test','persist',{key:'test'});const eid=s.nextEventId;
  const n=new Sim({...nextOperatingConfig(s),noPossessions:false},s);
  expect(n.trainList[0].departureDisplay?.at).toBe(stamp-DAY_S);
  expect(n.trainList[0].vRecommended).toBe(11);
  expect(n.faults[0].repairAt).toBe(Infinity);expect(n.faults[0].stageAt).toBe(stamp-DAY_S);expect(n.sig[0].failed).toBe(true);
  expect(n.routes.get(ar.route)?.committed).toBe(70001);
  expect(n.routes.get(ar.route)?.arsTrain).toBe(70002);
  expect(n.sec[0].poss).toBe(0);expect(n.calls[0].target).toBe(0);expect(n.pendingCalls[0].spec.target).toBe(0);
  expect(n.alarms.get('test')?.t).toBe(13500);expect(n.events[0].id).toBeGreaterThanOrEqual(eid);
  // Scan all carried numbers. These keys are identifiers, physical metres
  // or counters, not second-of-day timestamps; daily schedules are not carried.
  const nonTimes=new Set(['arsTrain','committed','lastTraceCh','km','id','owner','train','target','nextTrainId','nextFaultId','nextCallId','nextBookmarkId']);
  function scan(x:unknown,key='',path=''){
   if(typeof x==='number'&&Number.isFinite(x)&&!nonTimes.has(key))expect(x>=12*3600&&x<=30*3600,`unshifted ${path}: ${x}`).toBe(false);
   else if(x instanceof Map)for(const [k,v]of x)scan(v,key,`${path}.${k}`);
   else if(x instanceof Set)for(const v of x)scan(v,key,path);
   else if(Array.isArray(x))for(const v of x)scan(v,key,path+'[]');
   else if(x&&typeof x==='object')for(const [k,v]of Object.entries(x))scan(v,k,path+'.'+k);
  }
  for(const [key,policy]of Object.entries(DAY_STATE))if(policy==='carry'&&key!=='possessions')scan((n as any)[key],key,key);
  scan(n.possessions.slice(0,1));
  // Opening duties are new schedules; scan the trains before those are assigned.
  const raw=new Sim({...nextOperatingConfig(s),noPossessions:true});carryWorld(raw,s);scan(raw.trainList);
  expect(n.possessions[0].to).toBe(stamp-DAY_S);
  expect(n.sw[1].moveUntil).toBe(0);
 });
 it('drops completed daily data and saves/replays the inherited start, including old saves',()=>{
  let s=night();const sizes=[];
  for(let i=0;i<3;i++){
   s.t=99900;s.trainList.forEach(t=>{t.tasks=[];s.blockDone.add(t.block);});
   s.integrity.prevV.set(1000+i,0);s.dispatcher.next.set(`expired-${i}`,s.t-1);
   s.events=Array.from({length:500},(_,id)=>({id,t:s.t,level:'I' as const,cat:'test',text:'old'}));
   s=new Sim(nextOperatingConfig(s),s);sizes.push([s.plan.trips.length,s.plan.blocks.length,s.events.length,s.depLog.length,s.integrity.prevV.size,s.dispatcher.next.size]);
  }
  expect(sizes[1]).toEqual(sizes[0]);expect(sizes[2]).toEqual(sizes[0]);
  const bundle=parseDiagnostics(stringifyDiagnostics(exportDiagnostics(s)));
  const loaded=replayDiagnostics(bundle);
  expect(capture(loaded).data).toEqual(capture(s).data);
  expect(capture(loaded).trains).toEqual(capture(s).trains);
  const old=capture(s);delete old.data.vehicles;
  const fresh=new Sim(s.config);restore(fresh,old);expect(fresh.trainList.map(t=>t.vehicle)).toEqual(s.trainList.map(t=>t.vehicle));
 });
});

