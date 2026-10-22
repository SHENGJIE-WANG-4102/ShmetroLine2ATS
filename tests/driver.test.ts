import {describe,it,expect} from 'vitest';
import {Sim} from '../src/sim/engine';
import {platformBerth} from '../src/sim/timetable';
import {driverDoor,doorEnable,updateTrainTasks,answerOverrun,atoStartReady} from '../src/sim/ats';
import {computeBody,indexBodies,updateTrainMotion,reversePermission} from '../src/sim/movement';
import {doorMotionTick} from '../src/sim/psd';
import {capture,restore} from '../src/sim/state';
import {carryWorld,nextOperatingConfig,DAY_S} from '../src/sim/operatingDay';
import {dmiTick,availableMode} from '../src/sim/dmi';
import {classify} from '../src/sim/halt';
import {DOOR_CLOSE_S} from '../src/sim/calibration';
import {sectionCruise,sectionEta,computeRunTimes} from '../src/sim/dynamics';
import {closeDoors} from '../src/sim/psd';
import {OPERATIONS} from '../src/data/line2';
import {setMode} from '../src/sim/onboard';
const make=()=>new Sim({dayType:'weekday',date:'2026-10-22',dateLabel:'driver',startTime:14400,seed:7,noPossessions:true,autoRadio:false});
function fixture(){
 const s=make(),t=s.trainList[0],b=s.topo.berths[platformBerth(s.topo,12,'DN')];
 for(const other of [...s.trainList])if(other!==t)s.removeTrain(other);
 Object.assign(t,{link:b.link,off:b.offset,dir:b.dir,hist:[{link:b.link,dir:b.dir}],recentBody:undefined,
  phase:'dwell',phaseSince:s.t,arrivedAt:s.t,v:0,a:0,manual:true,mode:'CM',doorsAwait:true,doorsOpen:false,doorSide:'',
  doorMotion:undefined,doorLockedAt:0,vfault:null,eb:false,failed:false,hold:false,block:-1,tripId:-1,lastStation:b.station,
  tbStage:'none',depotStage:'none',reverser:1,stopUntil:0,stopDist:0,maDist:1000,maFar:1000,lastMa:Infinity,lastDs:0});
 t.tasks=[{k:'stop',station:b.station,berth:b.id,trip:-1,arr:s.t,dep:s.t+60,doors:true,revenue:true},
  {k:'stop',station:13,berth:platformBerth(s.topo,13,'DN'),trip:-1,arr:s.t+200,dep:s.t+250,doors:true,revenue:true}];
 computeBody(s,t);indexBodies(s);return {s,t,b,side:doorEnable(s,t).L?'L' as const:'R' as const};
}
describe('driver controls and physical enable',()=>{
 it('adds the existing driver turnback budget when DTO converts to AM during reversal, only once',()=>{
  const {s,t,b}=fixture();t.mode='DTO';t.manual=false;t.level='CBTC';t.phase='reversing';t.phaseSince=s.t-10;
  t.tasks=[{k:'reverse',station:b.station,berths:[b.id],chosen:b.id,minTime:40}];t.dwellUntil=t.phaseSince+40;
  expect(setMode(s,t,'AM','CBTC','')).toBe(true);
  expect(t.dwellUntil).toBe(t.phaseSince+40+OPERATIONS.atoEndChange);
  const ready=t.dwellUntil;s.t+=1;expect(setMode(s,t,'AM','CBTC','')).toBe(true);expect(t.dwellUntil).toBe(ready);
 });
 it.each(['CM','RM'] as const)('%s reopens without a second passenger exchange or wrong-door event',mode=>{
  const {s,t,b,side}=fixture();t.mode=mode;
  expect(driverDoor(s,t,side).ok).toBe(true);
  const load=t.load,served=s.passengersServed,wrong=s.metrics.safety.wrongDoor;
  s.t+=.3;doorMotionTick(s);expect(driverDoor(s,t,side).ok).toBe(true);
  const locked=t.doorLockedAt!;expect(driverDoor(s,t,side).ok).toBe(false);
  s.t=locked;doorMotionTick(s);expect(doorEnable(s,t)[side]).toBe(true);
  expect(driverDoor(s,t,side).ok).toBe(true);expect(t.load).toBe(load);expect(s.passengersServed).toBe(served);
  expect(s.metrics.safety.wrongDoor).toBe(wrong);s.t+=.3;doorMotionTick(s);
  expect(driverDoor(s,t,side).ok).toBe(true);expect(t.doorLockedAt).toBeGreaterThan(locked);
  expect(b.platform).toBeGreaterThanOrEqual(0);
 });
 it.each(['BZL','LYD','CSD'])('%s enables the exit test point only, both sides, without PSD or passengers',key=>{
  const {s,t}=fixture();t.phase='run';t.depotStage='out';const load=t.load;
  const depot=s.topo.depots.find(d=>d.key===key)!;
   const path=depot.transferPaths.find(p=>p.exitSignal===depot.exitSignal)!;
   const sig=s.topo.signals[path.exitSignal];
   const link=path.links.map(id=>s.topo.links[id]).find(l=>l.id!==sig.link&&(l.a===sig.node||l.b===sig.node))!;
   t.link=link.id;t.dir=link.b===sig.node?1:-1;
   t.off=t.dir===1?link.len-OPERATIONS.depotDoorTests[key].beforeSignal:OPERATIONS.depotDoorTests[key].beforeSignal;
   expect(doorEnable(s,t)).toEqual({L:true,R:true,depot:true});
   for(const side of ['L','R'] as const){expect(driverDoor(s,t,side).ok).toBe(true);expect(t.doorMotion).toBeUndefined();
    expect(driverDoor(s,t,side).ok).toBe(true);s.t=t.doorLockedAt!;doorMotionTick(s);}
   t.dir=t.dir===1?-1:1;expect(doorEnable(s,t)).toEqual({L:false,R:false,depot:false});t.dir=t.dir===1?-1:1;
   t.off-=t.dir*10;expect(doorEnable(s,t)).toEqual({L:false,R:false,depot:false});expect(driverDoor(s,t,'L').ok).toBe(false);
  expect(t.load).toBe(load);expect(s.metrics.safety.wrongDoor).toBe(0);
 });
 it('reverser is zero-speed only, a 3m overrun moves physically and arrival waits for standstill',()=>{
  const {s,t,b}=fixture();t.phase='run';t.off=b.offset-8;computeBody(s,t);t.off=b.offset+3;computeBody(s,t);indexBodies(s);
  updateTrainTasks(s,t);expect(t.phase).toBe('run');expect(t.off).toBe(b.offset+3);expect(t.retreat?.authorised).toBe(true);
  expect(s.command({c:'reverser',train:t.id,position:-1}).ok).toBe(true);expect(s.inputLog.at(-1)).toHaveProperty('cmd.c','reverser');
  expect(reversePermission(s,t),JSON.stringify(reversePermission(s,t))).toMatchObject({ok:true});t.notch=1;let moved=false;
  for(let i=0;i<120&&t.phase==='run';i++){
   if(t.off<=b.offset+1.5)t.notch=-7;s.t+=.1;updateTrainMotion(s,t,.1);indexBodies(s);updateTrainTasks(s,t,.1);if(t.v>=.05){moved=true;expect(s.command({c:'reverser',train:t.id,position:1}).ok).toBe(false);}
  }
  expect(moved).toBe(true);expect(t.phase).toBe('dwell');expect(Math.abs(t.off-b.offset)).toBeLessThanOrEqual(1);
  expect(t.drv.stops.at(-1)?.note).toBe('过标退行');expect(t.eb,t.ebReason).toBe(false);
 });
 it('8m overrun calls dispatch and only grants driving permission, with no teleport',()=>{
  const {s,t,b}=fixture();t.phase='run';t.off=b.offset-20;computeBody(s,t);t.off=b.offset+8;computeBody(s,t);indexBodies(s);
  updateTrainTasks(s,t);expect(s.calls.some(c=>c.kind==='overrun')).toBe(true);expect(reversePermission(s,t).ok).toBe(false);
  expect(answerOverrun(s,t,'back').ok).toBe(true);expect(t.off).toBe(b.offset+8);expect(t.phase).toBe('run');
  expect(reversePermission(s,t), JSON.stringify(reversePermission(s,t))).toMatchObject({ok:true});expect(s.metrics.safety.overrun).toBe(1);
 });
 it('reverse overspeed/overtravel trigger EB; a foreign rear occupant or route cannot be displaced',()=>{
  const {s,t,b}=fixture();t.phase='run';t.off=b.offset-20;computeBody(s,t);t.off=b.offset+8;computeBody(s,t);indexBodies(s);
  updateTrainTasks(s,t);answerOverrun(s,t,'back');t.reverser=-1;t.v=6/3.6;updateTrainMotion(s,t,.1);expect(t.eb).toBe(true);expect(t.ebReason).toContain('退行超速');
  t.eb=false;t.v=0;t.off=b.offset-1.1;updateTrainMotion(s,t,.1);expect(t.eb).toBe(true);expect(t.ebReason).toContain('退行越过');
  t.off=b.offset+8;t.eb=false;t.v=0;
  const sec=s.topo.links[t.link].section;s.sec[sec].lockRoute=0;
  s.routes.set(0,{owner:999,route:0,state:'locked'} as any);expect(reversePermission(s,t).ok).toBe(false);expect(s.routes.get(0)?.owner).toBe(999);
  s.routes.set(0,{owner:-1,arsTrain:999,route:0,state:'locked'} as any);expect(reversePermission(s,t)).toMatchObject({ok:false,train:999});
  s.routes.clear();s.sec[sec].lockRoute=-1;s.linkBodies.set(t.link,[{train:999,from:0,to:1}]);expect(reversePermission(s,t)).toMatchObject({ok:false,train:999});
 });
 it('AM waits for two current buttons, rejects early input and resets for each stop',()=>{
  const {s,t,b}=fixture();t.manual=false;t.doorsAwait=false;t.atoDriver=true;t.mode='AM';t.dwellUntil=s.t+2;t.doorsOpen=false;
  expect(s.command({c:'atoButton',train:t.id,button:'f',down:true}).ok).toBe(false);s.t+=3;
  t.tasks[0]={...t.tasks[0],dep:s.t-20} as typeof t.tasks[0];
  updateTrainTasks(s,t);expect(t.phase).toBe('dwell');expect(t.delay).toBe(20);expect(classify(s,t).detail).toBe('等待司机按 ATO 启动');
  expect(s.command({c:'atoButton',train:t.id,button:'g',down:true}).ok).toBe(true);updateTrainTasks(s,t);expect(t.phase).toBe('dwell');
  expect(s.command({c:'atoButton',train:t.id,button:'f',down:true}).ok).toBe(true);updateTrainTasks(s,t);expect(t.phase).toBe('run');
  expect(t.atoButtons).toEqual({f:false,g:false});expect(s.plat[b.platform].lastDep).toBe(s.t);
 });
 it('seeded automatic opening follows standstill by .5–1.5s without moving the departure target',()=>{
  const run=()=>{const {s,t}=fixture();t.phase='run';t.manual=false;t.mode='DTO';t.stopDist=0;
   updateTrainTasks(s,t);const arr=s.t,open=t.autoOpenAt!,ready=t.dwellUntil;expect(t.doorsOpen).toBe(false);
   s.t=open-.01;updateTrainTasks(s,t);expect(t.doorsOpen).toBe(false);s.t=open;updateTrainTasks(s,t);expect(t.doorsOpen).toBe(true);
   expect(t.dwellUntil).toBe(ready);return open-arr;};
  const a=run();expect(a).toBeGreaterThanOrEqual(.5);expect(a).toBeLessThanOrEqual(1.5);expect(run()).toBe(a);
 });
 it('queues cab/task messages every 15s, coalesces simultaneous changes and carries queues independently',()=>{
  const {s,t}=fixture();t.dmiLog=[];t.dmiPrev=null;t.dmiContext=undefined;dmiTick(s);
  const start=s.t;expect(t.dmiLog.map(m=>m.m)).toEqual(['DMI激活']);
  s.t=start+15;dmiTick(s);s.t=start+30;dmiTick(s);expect(t.dmiLog.map(m=>m.m)).toEqual(['DMI激活','定位已确认','ATPM模式可用']);
  t.dmiLog=[];t.depotStage='out';dmiTick(s);expect(t.dmiLog.map(m=>m.m)).toEqual(['定位已确认']);
  s.t+=15;dmiTick(s);expect(t.dmiLog.map(m=>m.m)).toEqual(['定位已确认','ATPM模式可用']);
  t.dmiLog=[];t.dmiCab=1;t.tbStage='reverse';t.depotStage='none';dmiTick(s);expect(t.dmiQueue).toHaveLength(2);
  const cp=capture(s);s.t+=15;dmiTick(s);expect(cp.trains[0].dmiQueue).toHaveLength(2);restore(s,cp);
  s.t=99900;const restored=s.trains.get(t.id)!;restored.dmiQueue=[{at:99915,message:'located'},{at:99930,message:'available'}];
  const next=new Sim(nextOperatingConfig(s));carryWorld(next,s);const carried=next.trains.get(t.id)!;
  expect(carried.dmiQueue?.map(m=>m.at)).toEqual([99915-DAY_S,99930-DAY_S]);next.t=99915-DAY_S;dmiTick(next);
  expect(carried.dmiLog.at(-1)).toMatchObject({t:99915-DAY_S,m:'定位已确认'});
 });
 it.each(['AM','DTO'] as const)('%s uses one seeded 1.5–3.5s delay after the recorded door lock, without stacking AM time',mode=>{
  const sample=()=>{const {s,t,side}=fixture();driverDoor(s,t,side);s.t+=.3;doorMotionTick(s);
   t.manual=false;t.mode=mode;t.doorSide='';t.doorsAwait=false;t.dwellUntil=s.t;t.depReadyAt=s.t;
   const began=s.t;updateTrainTasks(s,t);expect(t.doorLockedAt!-began).toBeCloseTo(DOOR_CLOSE_S);
   const wait=t.autoStartAt!-t.doorLockedAt!;expect(wait).toBeGreaterThanOrEqual(1.5);expect(wait).toBeLessThanOrEqual(3.5);
   s.t=t.doorLockedAt!;doorMotionTick(s);updateTrainTasks(s,t);expect(t.phase).toBe('dwell');
   s.t=t.autoStartAt!-.01;updateTrainTasks(s,t);expect(t.phase).toBe('dwell');
   s.t=t.autoStartAt!;updateTrainTasks(s,t);expect(t.phase).toBe('run');return wait;};
  expect(sample()).toBe(sample());
 });
 it('taken AM waits only for lock and F/G, with no automatic random start timer',()=>{
  const {s,t,b,side}=fixture();driverDoor(s,t,side);s.t+=.3;doorMotionTick(s);t.manual=false;t.mode='AM';t.atoDriver=true;t.doorSide='';
  closeDoors(s,t,b.platform);expect(t.autoStartAt).toBeUndefined();t.dwellUntil=t.doorLockedAt!;
  s.t=t.doorLockedAt!;doorMotionTick(s);updateTrainTasks(s,t);expect(t.phase).toBe('dwell');
  expect(s.command({c:'atoButton',train:t.id,button:'f',down:true}).ok).toBe(true);
  expect(s.command({c:'atoButton',train:t.id,button:'g',down:true}).ok).toBe(true);updateTrainTasks(s,t);expect(t.phase).toBe('run');
 });
 it('spends the diagram running budget in the section, retaining the precision braking curve',()=>{
  const v=sectionCruise(1000,0,100,80/3.6);expect(v).toBeLessThan(80/3.6);expect(sectionEta(1000,0,v)).toBeCloseTo(100,0);
  expect(sectionCruise(1000,0,20,80/3.6)).toBe(80/3.6);
  expect(sectionCruise(20,10,50,80/3.6)).toBe(80/3.6);
  const slower=sectionCruise(1000,15,110,80/3.6);
  expect(slower).toBeLessThan(15);expect(sectionEta(1000,15,slower)).toBeCloseTo(110,0);
  expect(sectionCruise(1000,15,10000,80/3.6)).toBeCloseTo(OPERATIONS.sectionCruiseMinKmh/3.6,2);
  expect(sectionCruise(1000,0,10000,5/3.6)).toBe(5/3.6);
  const s=make(),minimum=computeRunTimes(s.topo,186,Infinity,1,true);
  const capped=computeRunTimes(s.topo,186,50,1,true);
  expect(capped.dn.reduce((a,b)=>a+b,0)-minimum.dn.reduce((a,b)=>a+b,0)).toBeCloseTo(141.5, 1);
  expect(OPERATIONS.platformPassKmh).toBe(45);expect(OPERATIONS.platformStopKmh).toBe(Infinity);
 });
 it('RM retains the TBTC AM offer when CBTC is unavailable',()=>{
  const {s,t}=fixture();t.mode='RM';t.comm=false;
  expect(availableMode(s,t)).toEqual({mode:'AM',level:'TBTC'});
 });

 it('taking AM after automatic lock removes simulated confirmation delay; a refused handback retains the driver',()=>{
  const {s,t,b}=fixture();t.manual=false;t.mode='DTO';t.doorsAwait=false;t.doorsOpen=false;
  t.doorLockedAt=s.t-.1;t.autoStartAt=s.t+3;t.dwellUntil=t.autoStartAt;
  expect(s.command({c:'manual',train:t.id,mode:'AM'}).ok).toBe(true);
  expect(t.autoStartAt).toBeUndefined();expect(t.dwellUntil).toBe(s.t);
  t.comm=false;expect(s.command({c:'manual',train:t.id,mode:'AUTO'}).ok).toBe(false);expect(t.atoDriver).toBe(true);
  t.comm=true;expect(s.command({c:'manual',train:t.id,mode:'CM'}).ok).toBe(true);expect(t.manual).toBe(true);
  expect(s.plat[b.platform].hold).toBe(false);
 });

 it('red departure authority keeps its real wait reason and EB prevents a previously confirmed ATO departure',()=>{
  const {s,t}=fixture();t.manual=false;t.mode='AM';t.atoDriver=true;t.doorsAwait=false;t.dwellUntil=s.t;
  t.maDist=0;t.maReason='出站信号关闭';
  expect(classify(s,t).detail).not.toBe('等待司机按 ATO 启动');
  t.maDist=100;t.atoButtons={f:true,g:true};t.eb=true;updateTrainTasks(s,t);expect(t.phase).toBe('dwell');
 });

 it('a later task switch queues behind an unfinished cab sequence without dropping its messages',()=>{
  const {s,t}=fixture();t.dmiContext=undefined;t.dmiLog=[];t.dmiQueue=[];dmiTick(s);
  const at=s.t;s.t+=2;t.depotStage='out';dmiTick(s);
  expect(t.dmiQueue?.map(m=>m.at)).toEqual([at+15,at+30,at+45,at+60]);
  s.t=at+60;dmiTick(s);
  expect(t.dmiLog.map(m=>m.m)).toEqual(['DMI激活','定位已确认','ATPM模式可用','定位已确认','ATPM模式可用']);
 });

 it('computes the final crowded stop target before opening and commits passengers only when doors open',()=>{
  const {s,t,b}=fixture();t.manual=false;t.phase='run';t.mode='DTO';t.load=1900;
  s.plat[b.platform].waiting=1300;t.tasks[0]={...t.tasks[0],arr:s.t-7,dep:s.t+23} as typeof t.tasks[0];
  const served=s.passengersServed;updateTrainTasks(s,t);
  expect(t.dwellUntil-s.t).toBeGreaterThan(30);const ready=t.dwellUntil;
  expect(t.load).toBe(1900);expect(s.passengersServed).toBe(served);expect(t.doorsOpen).toBe(false);
  const cp=capture(s);s.t=t.autoOpenAt!;updateTrainTasks(s,t);
  expect(t.dwellUntil).toBe(ready);expect(t.doorsOpen).toBe(true);expect(s.passengersServed).toBeGreaterThan(served);
  expect(cp.trains.find(x=>x.id===t.id)?.doorExchange).toBeDefined();expect(t.doorExchange).toBeUndefined();
 });
 it.each(['DTO','AM','CM','RM'] as const)('%s accrues departure lateness during a hold without takeover-specific logic',mode=>{
  const {s,t,b}=fixture();t.mode=mode;t.manual=mode==='CM'||mode==='RM';t.atoDriver=false;t.doorsAwait=false;t.hold=true;
  t.tasks[0]={...t.tasks[0],dep:s.t-20} as typeof t.tasks[0];t.delay=-7;
  updateTrainTasks(s,t);expect(t.delay).toBe(20);s.t+=5;updateTrainTasks(s,t);expect(t.delay).toBe(25);
  expect(s.plat[b.platform].psd).toBe('closed');
 });
 it('buttons and halt use the same first ATO readiness failure, without arming vehicle work in a read',()=>{
  const {s,t,b}=fixture();t.manual=false;t.mode='AM';t.atoDriver=true;t.doorsAwait=false;t.dwellUntil=s.t;
  const cases=[
   {patch:{eb:true,ebReason:'测试紧急制动'},code:'EB'},
   {patch:{pendingMode:'CM'},code:'MODE_CHANGE'},
   {patch:{hold:true},code:'HOLD'},
   {patch:{doorsOpen:true},code:'DWELL'},
   {patch:{maDist:0,maCode:'ROUTE_WAIT',maReason:'出站信号关闭'},code:'ROUTE_WAIT'},
  ];const cp=capture(s);
  for(const c of cases){restore(s,cp);const tr=s.trains.get(t.id)!;Object.assign(tr,c.patch);
   const ready=atoStartReady(s,tr);expect(ready.ready).toBe(false);expect(ready.code).toBe(c.code);
   expect(classify(s,tr)).toMatchObject({code:ready.code,detail:ready.detail});
   const r=s.command({c:'atoButton',train:tr.id,button:'f',down:true});expect(r.ok).toBe(false);expect(r.msg).toContain(ready.detail);
  }
  restore(s,cp);const tr=s.trains.get(t.id)!;
  tr.vfault={kind:'brake',stage:'armed',sev:1,car:1,door:1,until:0,fault:-1,recover:true};
  expect(atoStartReady(s,tr).ready).toBe(false);expect(tr.vfault!.stage).toBe('armed');expect(classify(s,tr).detail).toContain('制动缓解');
  expect(s.plat[b.platform].hold).toBe(false);
 });

});





