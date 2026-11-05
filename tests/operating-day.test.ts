import {beforeAll,describe,expect,it} from 'vitest';
import {Sim} from '../src/sim/engine';
import {capture,restore,fingerprint} from '../src/sim/state';
import {nextOperatingConfig,unfinishedAtRollover,carryTrains,DAY_S} from '../src/sim/operatingDay';
import {preparePlan} from '../src/sim/planning';
import {OPERATING_DAY} from '../src/sim/dayRandom';
import {scheduleInstructorEvents} from '../src/sim/scenario';
import {exportDiagnostics,parseDiagnostics,stringifyDiagnostics,replayDiagnostics} from '../src/sim/diagnostics';
import {initialDepotStock,yardNeed,depotLedger,validatePlan} from '../src/sim/timetable';
import {LINE_INFO} from '../src/data/current';
import { fixtureTrain } from './helpers/fixture-train';

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
  expect(next.depotStock.map((n,d)=>n+[...next.vehicles.values()].filter(r=>r.work&&r.depot===d).length)).toEqual(stock);
  expect(initialDepotStock(next.topo,next.plan)).toEqual(next.depotStock);
  expect(yardNeed(next.topo,next.plan).every((n,d)=>n<=next.depotStock[d])).toBe(true);
  expect(depotLedger(next.topo,next.plan).final).toEqual(next.depotStock);
 },60000);
 it('accepts a service crossing the rollover without a removal warning',()=>{
  const preview=preparePlan(sim,{c:'addTrain',depot:0,dir:'DN',to:12,time:27.5*3600});
  expect(preview.ok,preview.msg).toBe(true);
  expect(preview.warnings?.join('') ?? '').not.toContain('收掉');
  expect(preview.plan.trips.some(t=>t.revenue&&t.stops.at(-1)!.arr>OPERATING_DAY.to)).toBe(true);
 });
 it('excludes workshop vehicles from the ready-stock ledger and still reports actual parking overflow',()=>{
  const workshop=[...sim.vehicles.values()].filter(record=>record.work).length;
  expect(workshop).toBeGreaterThan(0);
  expect(initialDepotStock(sim.topo,sim.plan)).toEqual(sim.depotStock);
  expect(sim.depotStock.reduce((sum,n)=>sum+n,0)+workshop+sim.plan.blocks.filter(b=>b.start.kind==='stable').length)
   .toBe(LINE_INFO.fleet);
  const full=structuredClone(sim.plan);full.initialStock![0]=sim.topo.depots[0].capacity+1;
  expect(validatePlan(sim.planCtx,full).some(issue=>issue.code==='YARD_CAPACITY'&&issue.depot===0)).toBe(true);
 });
 it('copies a section phase through checkpoints and carries its arrival clock into the next day',()=>{
  const saved=capture(sim),tr=fixtureTrain(sim);
  tr.ato={state:{phase:'coast',recovered:false,neutral:2},plan:{cutoff:20,coastAt:800,coastFloor:15,
   eta:100,samples:[{remaining:1000,speed:20},{remaining:0,speed:0}]},berth:0,arrival:sim.t+200,
   level:1,ceiling:20,manual:false,distance:700,obstructed:false};
  const cp=capture(sim);
  tr.ato.plan.samples[0].speed=99;tr.ato.state.phase='brake';
  restore(sim,cp);
  const restored=sim.trains.get(tr.id)!;
  expect(restored.ato!.state.phase).toBe('coast');
  expect(restored.ato!.plan.samples[0].speed).toBe(20);
  const next=new Sim(nextOperatingConfig(sim));carryTrains(next,sim);
  const carried=next.trains.get(tr.id)!;
  expect(carried.ato!.arrival).toBe(restored.ato!.arrival!-DAY_S);
  expect(carried.ato!.state).toEqual(restored.ato!.state);
  carried.ato!.plan.samples[0].speed=10;
  expect(restored.ato!.plan.samples[0].speed).toBe(20);
  restore(sim,saved);
 },60000);
 it('identifies a moving train in the interval with its vehicle, location and task',()=>{
  const cp=capture(sim),train=fixtureTrain(sim);
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
