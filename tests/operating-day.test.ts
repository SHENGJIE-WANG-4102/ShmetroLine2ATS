import {beforeAll,describe,expect,it} from 'vitest';
import {Sim} from '../src/sim/engine';
import {capture,restore,fingerprint} from '../src/sim/state';
import {nextOperatingConfig,unfinishedAtRollover} from '../src/sim/operatingDay';
import {preparePlan} from '../src/sim/planning';
import {OPERATING_DAY} from '../src/sim/dayRandom';
import {scheduleInstructorEvents} from '../src/sim/scenario';
import {exportDiagnostics,parseDiagnostics,stringifyDiagnostics,replayDiagnostics} from '../src/sim/diagnostics';
import {initialDepotStock,yardNeed,depotLedger} from '../src/sim/timetable';

describe('operating day boundaries and replay',()=>{
 let sim:Sim;
 beforeAll(()=>{sim=new Sim({dayType:'weekday',date:'2026-10-19',dateLabel:'test',startTime:14400,seed:3,noPossessions:true,instructorEvents:['severe-wind-sequence']});},60000);
 it('carries the live driving/fault settings and selected events into the next date',()=>{
  sim.atoLine=true;sim.randomLevel=2;sim.autoRadio=false;
  const next=nextOperatingConfig(sim);
  expect(next).toMatchObject({date:'2026-10-20',startTime:14400,seed:4,driveMode:'ATO',randomFaults:2,autoRadio:false,instructorEvents:['severe-wind-sequence'],noPossessions:true});
  expect(sim.config.date).toBe('2026-10-19');
 });
 it.each([1,2])('starts the following day with actual yard counts and fits its exits to those counts (transfer %s)',transfer=>{
  const config=nextOperatingConfig(sim);
  const stock=sim.depotStock.slice();stock[0]+=transfer;stock[2]-=transfer;
  const next=new Sim({...config,depotStock:stock});
  expect(next.depotStock).toEqual(stock);
  expect(initialDepotStock(next.topo,next.plan)).toEqual(stock);
  expect(yardNeed(next.topo,next.plan).every((n,d)=>n<=stock[d])).toBe(true);
  expect(depotLedger(next.topo,next.plan).final).toEqual(stock);
 },60000);
 it('warns before accepting a service which will cross the rollover',()=>{
  const preview=preparePlan(sim,{c:'addTrain',depot:0,dir:'DN',to:12,time:27.5*3600});
  expect(preview.ok,preview.msg).toBe(true);
  expect(preview.warnings?.join('')).toContain('27:45');
  expect(preview.plan.trips.some(t=>t.revenue&&t.stops.at(-1)!.arr>OPERATING_DAY.to)).toBe(true);
 });
 it('accepts the opening overnight cars at their legal departure or arrival berths',()=>{
  expect(sim.trainList).toHaveLength(8);
  expect(unfinishedAtRollover(sim)).toEqual([]);
 });
 it('identifies a moving train in the interval with its vehicle, location and task',()=>{
  const cp=capture(sim),train=sim.trainList[0];
  const interval=sim.topo.links.find(l=>l.track==='DN'&&l.platform<0&&l.len>300)!;
  train.link=interval.id;train.off=interval.len/2;train.phase='run';
  train.v=1;
  const text=unfinishedAtRollover(sim).join('；');
  expect(text).toContain(train.vehicle);
  expect(text).toContain(sim.topo.sections[sim.topo.links[train.link].section].name);
  expect(text).toContain(train.svc);
  restore(sim,cp);
 });
 it('restores the hidden schedule and reproduces the triggered event through diagnostics',()=>{
  sim.instructorSchedule=[{event:'severe-wind-sequence',at:sim.t+1}];sim.instructorFired=0;
  const cp=capture(sim);
  for(let i=0;i<20;i++)sim.step();
  expect(sim.instructorOccurred.map(e=>e.event)).toEqual(['severe-wind-sequence']);
  const after=fingerprint(sim);
  restore(sim,cp);
  expect(sim.instructorSchedule).toEqual(cp.data.instructorSchedule);
  for(let i=0;i<20;i++)sim.step();
  expect(fingerprint(sim)).toEqual(after);
  // Use the real seeded schedule for an independently replayable diagnostic.
  restore(sim,cp);sim.instructorSchedule=scheduleInstructorEvents(3,14400,['severe-wind-sequence']);
  const bundle=parseDiagnostics(stringifyDiagnostics(exportDiagnostics(sim)));
  const replay=replayDiagnostics(bundle);
  expect(replay.instructorSchedule).toEqual(sim.instructorSchedule);
  expect(replay.ridershipTarget).toBe(sim.ridershipTarget);
  expect(replay.rngState).toBe(sim.rngState);
  expect([replay.plan.trips,replay.plan.blocks]).toEqual([sim.plan.trips,sim.plan.blocks]);
 },60000);
});
