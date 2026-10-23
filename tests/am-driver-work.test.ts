import {describe,it,expect}from'vitest';
import {Sim}from'../src/sim/engine';
import {capture,restore,fingerprint}from'../src/sim/state';
import {exportDiagnostics,stringifyDiagnostics,parseDiagnostics,replayDiagnostics}from'../src/sim/diagnostics';
import {closeDoors,doorMotionTick}from'../src/sim/psd';
import {updateTrainTasks,atoStartReady,simulatedAmDoorWork}from'../src/sim/ats';
import {setMode,turnbackDwell,simulatedAmDriver}from'../src/sim/onboard';
import {platformBerth}from'../src/sim/timetable';
import {computeBody,indexBodies}from'../src/sim/movement';
import {carryWorld,nextOperatingConfig,DAY_S}from'../src/sim/operatingDay';
import {OPERATIONS,STATIONS}from'../src/data/current';
import {DOOR_CLOSE_S}from'../src/sim/calibration';
import {runAmTurnback}from'./helpers/am-turnback';

function fixture(mode:'DTO'|'AM'='DTO',stationId='RMG',dir:'DN'|'UP'='DN'){
 const sim=new Sim({dayType:'weekday',date:'2026-10-23',dateLabel:'am-driver-work',startTime:14400,seed:7,noPossessions:true,autoRadio:false});
 const tr=sim.trainList[0],st=STATIONS.findIndex(s=>s.id===stationId),b=sim.topo.berths[platformBerth(sim.topo,st,dir)];
 for(const other of[...sim.trainList])if(other!==tr)sim.removeTrain(other);
 for(const t of sim.plan.trips)t.completed=true;for(const block of sim.plan.blocks)sim.blockDone.add(block.id);
 Object.assign(tr,{link:b.link,off:b.offset,dir:b.dir,hist:[{link:b.link,dir:b.dir}],recentBody:undefined,phase:'dwell',phaseSince:sim.t,
  arrivedAt:sim.t,v:0,a:0,manual:false,atoDriver:false,mode,doorsAwait:false,doorsOpen:true,doorSide:'',doorMotion:undefined,
  doorLockedAt:0,autoStartAt:undefined,autoOpenAt:undefined,atoButtons:{f:false,g:false},vfault:null,eb:false,failed:false,hold:false,
  block:-1,tripId:-1,lastStation:st,tbStage:'none',depotStage:'none',reverser:1,stopUntil:0,stopDist:0,maDist:1000,maFar:1000,lastMa:Infinity,lastDs:0,
  dwellUntil:sim.t,depReadyAt:sim.t,load:0});
 tr.tasks=[{k:'stop',station:st,berth:b.id,trip:-1,arr:sim.t,dep:sim.t,doors:true,revenue:true}];
 sim.plat[b.platform].psd='open';sim.plat[b.platform].psdTrain=tr.id;
 computeBody(sim,tr);indexBodies(sim);return{sim,tr,b};
}

describe('paper AM driver work',()=>{
 it('keeps DTO random sampling identical and adds 20 seconds only once after physical lock for a simulated AM driver',()=>{
  const dto=fixture('DTO'),am=fixture('AM'),began=dto.sim.t;
  updateTrainTasks(dto.sim,dto.tr);updateTrainTasks(am.sim,am.tr);
  expect(am.tr.doorLockedAt).toBe(dto.tr.doorLockedAt);expect(am.tr.doorLockedAt!-began).toBeCloseTo(DOOR_CLOSE_S);
  const base=dto.tr.autoStartAt!-dto.tr.doorLockedAt!;
  expect(base).toBeGreaterThanOrEqual(1.5);expect(base).toBeLessThanOrEqual(3.5);
  expect(am.tr.autoStartAt!-am.tr.doorLockedAt!-base).toBeCloseTo(20);
  expect(am.sim.rng()).toBe(dto.sim.rng());
  am.sim.t=am.tr.doorLockedAt!;doorMotionTick(am.sim);updateTrainTasks(am.sim,am.tr);
  expect(am.tr.phase).toBe('dwell');expect(atoStartReady(am.sim,am.tr).detail).toContain('司机');
  am.sim.t=am.tr.autoStartAt!-.01;updateTrainTasks(am.sim,am.tr);expect(am.tr.phase).toBe('dwell');
  am.sim.t=am.tr.autoStartAt!;updateTrainTasks(am.sim,am.tr);expect(am.tr.phase).toBe('run');
  expect(am.tr.atoButtons).toEqual({f:false,g:false});expect(am.sim.inputLog).toEqual([]);
 });
 it('applies a mid-close DTO to AM conversion once, and keeps player F/G and legacy manual reversal work',()=>{
  const{sim,tr,b}=fixture();closeDoors(sim,tr,b.platform);tr.dwellUntil=tr.autoStartAt!;
  const initial=tr.autoStartAt!;expect(setMode(sim,tr,'AM','CBTC','')).toBe(true);
  expect(tr.autoStartAt).toBe(initial+20);expect(setMode(sim,tr,'AM','CBTC','')).toBe(true);expect(tr.autoStartAt).toBe(initial+20);
  expect(sim.command({c:'manual',train:tr.id,mode:'AM'}).ok).toBe(false); // physical closing still in progress
  sim.t=tr.doorLockedAt!;doorMotionTick(sim);
  expect(sim.command({c:'manual',train:tr.id,mode:'AM'}).ok).toBe(true);expect(tr.autoStartAt).toBeUndefined();
  tr.maDist=1000; // Restore this door-only fixture's clear onward authority after the takeover scan.
  updateTrainTasks(sim,tr);expect(tr.phase).toBe('dwell');
  expect(sim.command({c:'atoButton',train:tr.id,button:'f',down:true}).ok).toBe(true);
  expect(sim.command({c:'atoButton',train:tr.id,button:'g',down:true}).ok).toBe(true);updateTrainTasks(sim,tr);expect(tr.phase).toBe('run');
  expect(turnbackDwell('AM',40,'rear',false)).toBe(40+OPERATIONS.atoDriverWork.legacyEndChangeS);
  expect(turnbackDwell('CM',40,'front',false)).toBe(85);expect(turnbackDwell('RM',40,'rear',false)).toBe(85);
 });
 it('does not bypass holds, PSD faults, brake faults or a missing authority when the simulated driver presses start',()=>{
  const{sim,tr,b}=fixture('AM');updateTrainTasks(sim,tr);sim.t=tr.autoStartAt!;doorMotionTick(sim);
  for(const change of[()=>{tr.hold=true;},()=>{tr.hold=false;sim.plat[b.platform].psd='closeFail';},()=>{sim.plat[b.platform].psd='closed';tr.maDist=0;}]){
   change();updateTrainTasks(sim,tr);expect(tr.phase).toBe('dwell');expect(tr.atoButtons).toEqual({f:false,g:false});
  }
  tr.maDist=1000;tr.vfault={kind:'brake',stage:'armed',sev:1,car:1,door:1,until:0,fault:-1,recover:true};
  updateTrainTasks(sim,tr);expect(tr.phase).toBe('dwell');expect(tr.vfault.stage).toBe('stuck');expect(tr.atoButtons).toEqual({f:false,g:false});
  tr.vfault=null;updateTrainTasks(sim,tr);expect(tr.phase).toBe('run');
 });
 it('advances a closed-door in-place depot reversal without waiting for an irrelevant forward authority',()=>{
  const{sim,tr,b}=fixture('AM');
  Object.assign(tr,{doorsOpen:false,doorLockedAt:undefined,autoStartAt:undefined,maDist:6,stopDist:0});
  tr.tasks=[{k:'stop',station:b.station,berth:b.id,trip:-1,arr:null,dep:null,doors:false,revenue:false,note:'出段换端'},
   {k:'reverse',station:b.station,berths:[b.id],chosen:b.id,minTime:40}];
  sim.plat[b.platform].psd='closed';
  expect(simulatedAmDoorWork(tr)).toBe(false);updateTrainTasks(sim,tr);
  expect(tr.phase).toBe('run');expect(tr.tasks[0].k).toBe('reverse');
  updateTrainTasks(sim,tr);expect(tr.phase).toBe('reversing');
 });
 it('keeps real clear-out door work and start guards after all passengers have alighted',()=>{
  const{sim,tr}=fixture('AM');
  Object.assign(tr.tasks[0],{doors:false,revenue:false});tr.load=0;
  expect(simulatedAmDoorWork(tr)).toBe(true);updateTrainTasks(sim,tr);
  expect(tr.autoStartAt!-tr.doorLockedAt!).toBeGreaterThanOrEqual(21.5);
  sim.t=tr.doorLockedAt!;doorMotionTick(sim);expect(simulatedAmDoorWork(tr)).toBe(true);
  sim.t=tr.autoStartAt!;tr.maDist=6;updateTrainTasks(sim,tr);expect(tr.phase).toBe('dwell');
  expect(tr.atoButtons).toEqual({f:false,g:false});tr.maDist=1000;updateTrainTasks(sim,tr);expect(tr.phase).toBe('run');
 });
 it.each([['DTO','front'],['DTO','rear'],['AM','front'],['AM','rear']]as const)('preserves the legacy player reversal work on %s to AM takeover at a %s reversal',(mode,kind)=>{
  const{sim,tr}=fixture(mode),station=sim.topo.stations.find(s=>s.id===(kind==='front'?'GLL':'PXL'))!;
  const berth=sim.topo.berths[station.turnbackBerths.find(id=>sim.topo.berths[id].kind===(kind==='front'?'platform':'siding'))!];
  Object.assign(tr,{link:berth.link,off:berth.offset,dir:berth.dir,hist:[{link:berth.link,dir:berth.dir}],recentBody:undefined,
   phase:'run',v:0,a:0,stopDist:0,doorsOpen:false,doorsAwait:false,doorSide:'',doorMotion:undefined});
  tr.tasks=[{k:'reverse',station:station.index,berths:[berth.id],chosen:berth.id,minTime:40}];
  computeBody(sim,tr);indexBodies(sim);updateTrainTasks(sim,tr);expect(tr.phase).toBe('reversing');
  const began=tr.phaseSince;sim.t+=5;
  expect(sim.command({c:'manual',train:tr.id,mode:'AM'}).ok).toBe(true);
  expect(tr.atoDriver).toBe(true);expect(tr.dwellUntil).toBe(began+40+45);
  sim.t+=1;expect(sim.command({c:'manual',train:tr.id,mode:'AM'}).ok).toBe(true);
  expect(tr.dwellUntil).toBe(began+40+45);
 });
 it.each(['CM','RM']as const)('does not turn the previous stop lock into new door work on %s handback at a closed-door reversal',mode=>{
  const{sim,tr,b}=fixture('AM');sim.atoLine=true;
  Object.assign(tr,{mode,manual:true,doorsOpen:false,doorLockedAt:sim.t-5,autoStartAt:undefined,maDist:6,stopDist:0});
  tr.tasks=[{k:'stop',station:b.station,berth:b.id,trip:-1,arr:null,dep:null,doors:false,revenue:false,note:'出段换端'},
   {k:'reverse',station:b.station,berths:[b.id],chosen:b.id,minTime:40}];
  sim.plat[b.platform].psd='closed';
  expect(sim.command({c:'manual',train:tr.id,mode:'AUTO'}).ok).toBe(true);
  expect(tr.autoStartAt).toBeUndefined();updateTrainTasks(sim,tr);expect(tr.phase).toBe('run');
  expect(tr.tasks[0].k).toBe('reverse');
 });
 it.each(['AM','CM','RM']as const)('restores only the remaining post-lock confirmation on %s handback to the simulated AM driver',mode=>{
  for(const elapsed of[1,30]){
   const{sim,tr,b}=fixture('AM');sim.atoLine=true;
   tr.mode=mode;tr.manual=mode!=='AM';tr.atoDriver=mode==='AM';
   closeDoors(sim,tr,b.platform);tr.dwellUntil=tr.doorLockedAt!;
   expect(tr.autoStartAt).toBeUndefined();sim.t=tr.doorLockedAt!+elapsed;doorMotionTick(sim);
   const random=sim.rngState,lock=tr.doorLockedAt!;
   expect(sim.command({c:'manual',train:tr.id,mode:'AUTO'}).ok).toBe(true);
   expect(tr.autoStartAt).toBe(lock+22.5);expect(sim.rngState).toBe(random);
   tr.maDist=1000;updateTrainTasks(sim,tr);expect(tr.phase).toBe(elapsed<22.5?'dwell':'run');
   if(elapsed<22.5){sim.t=lock+22.5;updateTrainTasks(sim,tr);expect(tr.phase).toBe('run');}
  }
 });
 it.each(['CM','RM']as const)('retains the original AM confirmation sample across a %s takeover and automatic handback',mode=>{
  for(const elapsed of[3,30]){
   const{sim,tr}=fixture('AM');sim.atoLine=true;updateTrainTasks(sim,tr);
   const deadline=tr.autoStartAt!,lock=tr.doorLockedAt!;sim.t=lock+elapsed;doorMotionTick(sim);
   const random=sim.rngState;
   expect(sim.command({c:'manual',train:tr.id,mode}).ok).toBe(true);
   expect(sim.command({c:'manual',train:tr.id,mode:'AUTO'}).ok).toBe(true);
   expect(tr.autoStartAt).toBe(deadline);expect(sim.rngState).toBe(random);
   tr.maDist=1000;updateTrainTasks(sim,tr);expect(tr.phase).toBe(sim.t<deadline?'dwell':'run');
   if(sim.t<deadline){sim.t=deadline;updateTrainTasks(sim,tr);expect(tr.phase).toBe('run');}
  }
 });
 it('restores and replays automatic AM work without recording duplicate simulated button commands',()=>{
  const{sim,tr}=fixture();tr.tasks.push({k:'stop',station:13,berth:platformBerth(sim.topo,13,'DN'),trip:-1,arr:sim.t+200,dep:sim.t+240,doors:true,revenue:true});
  sim.startState=capture(sim);expect(sim.command({c:'lineAto',on:true}).ok).toBe(true);
  const checkpoint=capture(sim);
  const run=()=>{for(let i=0;i<500;i++)sim.step();return fingerprint(sim);};
  const expected=run();expect(sim.inputLog.map(i=>'cmd'in i?i.cmd.c:'drive')).toEqual(['lineAto']);
  const replay=replayDiagnostics(parseDiagnostics(stringifyDiagnostics(exportDiagnostics(sim))));expect(fingerprint(replay)).toBe(expected);
  restore(sim,checkpoint);expect(run()).toBe(expected);
 });
 it('carries an in-progress driver confirmation clock into the next operating day',()=>{
  const{sim,tr,b}=fixture('AM');sim.t=99900;closeDoors(sim,tr,b.platform);tr.dwellUntil=tr.autoStartAt!;
  const until=tr.autoStartAt!,next=new Sim(nextOperatingConfig(sim));carryWorld(next,sim);
  const carried=next.trains.get(tr.id)!;expect(carried.autoStartAt).toBe(until-DAY_S);expect(carried.doorLockedAt).toBe(tr.doorLockedAt!-DAY_S);
  expect(carried.dwellUntil).toBe(until-DAY_S);expect(simulatedAmDriver(carried)).toBe(true);
 });
 it.each([['PXL','UP',60,75,2],['GLL','DN',28,32,1]]as const)('measures the complete %s turn without timetable idle or duplicated door work',(station,dir,lower,upper,cycles)=>{
  const dto=runAmTurnback('DTO',station,dir),am=runAmTurnback('AM',station,dir);
  expect(dto.violations).toEqual([]);expect(am.violations).toEqual([]);
  // The paper reports an approximate whole-turn delta. Existing seeded door
  // confirmation (1.5–3.5 s) and route ticks vary with the shifted clock.
  expect(am.elapsed-dto.elapsed).toBeGreaterThanOrEqual(lower);expect(am.elapsed-dto.elapsed).toBeLessThanOrEqual(upper);
  expect(am.closes.length).toBe(cycles);
  expect(am.closes.at(-1)!.departure!-am.closes.at(-1)!.locked).toBeGreaterThanOrEqual(21.5);
  expect(am.closes.at(-1)!.departure!-am.closes.at(-1)!.locked).toBeLessThan(24);
 });
});
