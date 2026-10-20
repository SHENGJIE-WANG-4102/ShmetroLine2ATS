import {describe,it,expect,vi} from 'vitest';
import {INSTRUCTOR_EVENTS,scheduleInstructorEvents,scheduleRandomFaults,randomTick,scenarioTick,type InstructorEvent} from '../src/sim/scenario';
import {drawDailyRidership,RIDERSHIP_RANGE} from '../src/sim/calibration';
import {Sim} from '../src/sim/engine';
import {capture,restore} from '../src/sim/state';
import {OPERATIONS} from '../src/data/line2';

describe('daily random-fault budgets',()=>{
 const make=()=>new Sim({dayType:'weekday',dateLabel:'daily fault budget',startTime:14400,seed:17,noPossessions:true});
 it('draws the configured count deterministically, with at most one rare major fault and correct windows',()=>{
  const sim=make(),rules=OPERATIONS.randomFaults;
  for(let level=1;level<=3;level++)for(let seed=1;seed<=100;seed++){
   const schedule=scheduleRandomFaults(seed,14400,level,sim.plan);
   expect(schedule).toHaveLength(rules.levels[level-1].count);
   expect(schedule).toEqual(scheduleRandomFaults(seed,14400,level,sim.plan));
   expect(schedule.filter(e=>e.major).length).toBeLessThanOrEqual(1);
   for(const entry of schedule){
    expect(entry.windows.some(([a,b])=>entry.at>=a&&entry.at<b)).toBe(true);
    if(entry.kind==='surge')expect(rules.crowdWindows.some(([a,b])=>entry.at>=a&&entry.at<b)).toBe(true);
    if(entry.vehicle||['psd','pecu','surge'].includes(entry.kind))expect(entry.at).toBeLessThan(Math.max(...sim.plan.trips.filter(t=>t.revenue&&!t.cancelled).map(t=>t.stops.at(-1)!.arr)));
   }
  }
 });
 it('defers a missing target, never faults the same vehicle twice, and restores pending entries through checkpoints',()=>{
  const sim=make(),[first,second]=sim.trainList;
  for(const tr of sim.trainList)tr.inService=false;
  sim.t=6*3600;sim.randomLevel=2;sim.nextRandomAt=sim.t;
  sim.randomSchedule=['trainComm','door'].map((kind,i)=>({event:`test-${kind}`,kind,major:false,vehicle:true,at:sim.t+i,windows:[[sim.t,sim.t+600]],status:'pending'}));
  randomTick(sim);expect(sim.randomSchedule[0].status).toBe('pending');expect(sim.randomSchedule[0].retryAt).toBe(sim.t+30);
  Object.assign(first,{inService:true,phase:'run',manual:false,failed:false,level:'CBTC',comm:true,mode:'DTO'});
  sim.t+=30;randomTick(sim);
  expect(sim.randomSchedule[0].status).toBe('fired');expect(sim.randomSchedule[0].vehicleId).toBe(first.vehicle);
  expect(sim.randomSchedule[1].status).toBe('pending');
  const cp=capture(sim);
  Object.assign(second,{inService:true,phase:'run',manual:false,failed:false,comm:true,mode:'DTO'});
  sim.t+=30;randomTick(sim);
  expect(sim.randomSchedule[1].status).toBe('fired');expect(sim.randomSchedule[1].vehicleId).toBe(second.vehicle);
  const after=structuredClone(sim.randomSchedule),vehicles=sim.randomFaultVehicles.slice();
  restore(sim,cp);Object.assign(sim.trains.get(second.id)!,{inService:true,phase:'run',manual:false,failed:false,comm:true,mode:'DTO'});
  sim.t+=30;randomTick(sim);expect(sim.randomSchedule).toEqual(after);expect(sim.randomFaultVehicles).toEqual(vehicles);
 });
});

describe('daily independent randomness',()=>{
 const ids=INSTRUCTOR_EVENTS.map(e=>e.id);
 it('repeats the same day and ignores checkbox ordering; another seed differs',()=>{
  const a=scheduleInstructorEvents(1234,14400,ids);
  expect(a).toEqual(scheduleInstructorEvents(1234,14400,ids.slice().reverse()));
  expect(a).not.toEqual(scheduleInstructorEvents(1235,14400,ids));
  expect(drawDailyRidership('weekday',1234)).toBe(drawDailyRidership('weekday',1234));
  expect(drawDailyRidership('weekday',1234)).not.toBe(drawDailyRidership('weekday',1235));
 });
 it('draws each event only in the remaining available windows',()=>{
  const library:InstructorEvent[]=[{id:'windows',name:'windows',category:'test',probability:1,windows:[[14400,15000],[18000,19000]],run:()=>{}}];
  for(let seed=1;seed<=100;seed++) {
   const schedule=scheduleInstructorEvents(seed,18500,['windows'],library);
   expect(schedule).toHaveLength(1);
   expect(schedule[0].at).toBeGreaterThanOrEqual(18500);
   expect(schedule[0].at).toBeLessThan(19000);
  }
  expect(scheduleInstructorEvents(1,19000,['windows'],library)).toEqual([]);
  expect(scheduleInstructorEvents(1,14400,[],library)).toEqual([]);
 });
 it('draws a dependent process once and keeps its steps in order within the operating day',()=>{
  const event=INSTRUCTOR_EVENTS.find(e=>e.id==='severe-wind-sequence')!;
  expect(INSTRUCTOR_EVENTS.filter(e=>e.category==='天气')).toEqual([event]);
  expect(event.steps?.map(s=>s.after)).toEqual([6*60,13*60,25*60]);
  const certain={...event,probability:1};
  const steps=scheduleInstructorEvents(42,14400,[event.id],[certain]);
  expect(steps.map(s=>s.step??0)).toEqual([0,1,2,3]);
  expect(steps.map(s=>s.at-steps[0].at)).toEqual([0,360,780,1500]);
  expect(steps.every(s=>s.event===event.id&&s.at<27.75*3600)).toBe(true);
  expect(scheduleInstructorEvents(42,27.7*3600,[event.id],[certain])).toEqual([]);
  expect(scheduleInstructorEvents(42,14400,['storm-4'],[certain])).toEqual(steps);
 });
 it('executes every dependent action in order rather than drawing a standalone recovery',()=>{
  const calls:string[]=[];
  const event:InstructorEvent={id:'batch-dependent',name:'process',category:'test',probability:1,windows:[[15000,16000]],
   run:()=>{calls.push('start');},steps:[{after:10,name:'escalate',run:()=>{expect(calls).toEqual(['start']);calls.push('escalate');}},
    {after:20,name:'recover',run:()=>{expect(calls).toEqual(['start','escalate']);calls.push('recover');}}]};
  INSTRUCTOR_EVENTS.push(event);
  try {
   const schedule=scheduleInstructorEvents(8,14400,[event.id],[event]);
   const sim={t:14400,instructorSchedule:schedule,instructorFired:0,instructorOccurred:[],faults:[],calls:[],possessions:[],env:{},
    config:{instructorEvents:[event.id]},dailyEvaluationEnded:true,scenario:null,log:vi.fn(),bookmark:vi.fn()} as unknown as Sim;
   scenarioTick(sim);expect(calls).toEqual([]);
   for(const entry of schedule){sim.t=entry.at;scenarioTick(sim);}
   expect(calls).toEqual(['start','escalate','recover']);
  } finally {INSTRUCTOR_EVENTS.pop();}
 });
 it('runs the full weather process in the simulator and resumes its remaining steps after replay',()=>{
  const event=INSTRUCTOR_EVENTS.find(e=>e.id==='severe-wind-sequence')!;
  const config={dayType:'weekday' as const,dateLabel:'weather process',startTime:14400,seed:42,
   noPossessions:true,instructorEvents:[event.id]};
  const sim=new Sim(config),start=14401;
  sim.instructorSchedule=[{event:event.id,at:start},...event.steps!.map((step,i)=>({event:event.id,at:start+step.after,step:i+1}))];
  sim.instructorFired=0;
  const advance=(s:Sim,until:number)=>{while(s.t<until)s.step();};
  advance(sim,start+1);expect([sim.env.wind,sim.env.rain]).toEqual([2,false]);
  advance(sim,start+6*60+1);expect([sim.env.wind,sim.env.rain]).toEqual([2,true]);
  const cp=capture(sim);
  advance(sim,start+13*60+1);expect([sim.env.wind,sim.env.rain]).toEqual([4,true]);
  advance(sim,start+25*60+1);expect([sim.env.wind,sim.env.rain]).toEqual([2,true]);
  expect(sim.instructorOccurred.map(e=>e.step??0)).toEqual([0,1,2,3]);
  const replay=new Sim(config);restore(replay,cp);advance(replay,sim.t);
  expect(replay.instructorOccurred).toEqual(sim.instructorOccurred);
  expect(replay.env).toEqual(sim.env);
  expect(replay.integrity.violations).toEqual([]);
 });
 it('never fires a missed lottery, fires a selected event once, and reveals no future event in logs',()=>{
  const fired=vi.fn();
  const library:InstructorEvent[]=[{id:'batch-test-hit',name:'test hit',category:'test',probability:1,windows:[[15000,16000]],run:fired},
   {id:'batch-test-miss',name:'test miss',category:'test',probability:0,windows:[[15000,16000]],run:()=>{throw new Error('miss fired');}}];
  INSTRUCTOR_EVENTS.push(...library);
  try {
   const schedule=scheduleInstructorEvents(51,14400,library.map(e=>e.id),library),log=vi.fn();
   const sim={t:14400,instructorSchedule:schedule,instructorFired:0,instructorOccurred:[],faults:[],calls:[],possessions:[],env:{},
    config:{instructorEvents:library.map(e=>e.id)},dailyEvaluationEnded:true,scenario:null,log,bookmark:vi.fn()} as unknown as Sim;
   scenarioTick(sim);expect(log).not.toHaveBeenCalled();expect(fired).not.toHaveBeenCalled();
   sim.t=schedule[0].at;scenarioTick(sim);expect(fired).toHaveBeenCalledTimes(1);
   sim.t=28*3600;scenarioTick(sim);expect(fired).toHaveBeenCalledTimes(1);
   expect(sim.instructorOccurred.map(e=>e.event)).toEqual(['batch-test-hit']);
  } finally {INSTRUCTOR_EVENTS.splice(-library.length);}
 });
 it('keeps both day types inside the data ranges',()=>{
  for(const day of ['weekday','weekend'] as const) for(let seed=1;seed<100;seed++) {
   const n=drawDailyRidership(day,seed),r=RIDERSHIP_RANGE[day];
   expect(n).toBeGreaterThanOrEqual(r.min);expect(n).toBeLessThanOrEqual(r.max);
  }
 });
});
