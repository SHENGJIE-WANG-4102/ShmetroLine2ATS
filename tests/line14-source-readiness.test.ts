import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import type {Sim as Simulator} from '../src/sim/engine';
import type {StopTask} from '../src/sim/model';

describe('overnight positioning source readiness',()=>{
  beforeAll(()=>{vi.stubEnv('ATS_LINE','14');vi.resetModules();});
  afterAll(()=>{vi.unstubAllEnvs();vi.resetModules();});
  async function fixture(dayType:'weekday'|'weekend'='weekday'){
    const {Sim}=await import('../src/sim/engine');
    const sim=new Sim({dayType,date:'2026-10-19',dateLabel:'source-readiness',startTime:14400,seed:14201,noPossessions:true});
    const tr=sim.trainList.find(t=>t.tasks[0]?.k==='stop'&&t.tasks[0].stabledOut&&t.tasks[0].dep===null)!;
    return {sim,tr,task:tr.tasks[0] as StopTask};
  }
  it.each(['weekday','weekend'] as const)('%s uses the positioning origin at the actual overnight station, and keeps its existing call-out window',async day=>{
    const {sim,tr,task}=await fixture(day);
    const {sourceDepartureAt,sourceReadyAt}=await import('../src/sim/resourceArbitration');
    const {scanAhead}=await import('../src/sim/movement');
    const {STANDBY_CALL}=await import('../src/sim/model');
    const trip=sim.plan.trips[task.trip],block=sim.plan.blocks[tr.block];
    expect(task.dep).toBeNull();expect(block.start.kind).toBe('stable');
    expect(block.start).toHaveProperty('station',trip.from);
    expect(sim.topo.berths[(block.start as {berth:number}).berth].station).toBe(trip.stops[0].st);
    expect(sourceDepartureAt(sim,task)).toBe(trip.stops[0].dep);
    const at=trip.stops[0].dep-STANDBY_CALL;
    expect(sourceReadyAt(sim,task)).toBe(at);
    sim.t=at-.1;expect(scanAhead(sim,tr,task.berth)).toMatchObject({maDist:0,maCode:'REGULATION'});
    sim.t=at;expect(sourceReadyAt(sim,task)).toBe(sim.t);
    expect(scanAhead(sim,tr,task.berth).maCode).not.toBe('REGULATION');
  });
  it('leaves every finite live departure and the unmarked task behavior unchanged',async()=>{
    const {sim,task}=await fixture();
    const {sourceDepartureAt,sourceReadyAt}=await import('../src/sim/resourceArbitration');
    const {STANDBY_CALL}=await import('../src/sim/model');
    for(const dep of [-100,0,20000]){
      const live={...task,dep};
      expect(sourceDepartureAt(sim,live)).toBe(dep);expect(sourceReadyAt(sim,live)).toBe(dep-STANDBY_CALL);
    }
    expect(sourceReadyAt(sim,{...task,stabledOut:false,dep:20000})).toBe(-Infinity);
    expect(sourceDepartureAt(sim,{...task,stabledOut:false})).toBeNull();
  });
  it('reports an unknown origin once and preserves the previous release behavior without throwing',async()=>{
    const {sim,task}=await fixture();const {sourceDepartureAt,sourceReadyAt}=await import('../src/sim/resourceArbitration');
    const missing={...task,trip:-1};
    expect(sourceDepartureAt(sim,missing)).toBeNull();expect(sourceReadyAt(sim,missing)).toBe(-Infinity);
    expect(sim.events.filter(e=>e.code==='SOURCE_DEPARTURE_UNKNOWN')).toHaveLength(1);
    const trip=sim.plan.trips[task.trip],block=sim.plan.blocks[trip.block];
    block.start={kind:'stable',station:trip.to};
    expect(sourceDepartureAt(sim,task)).toBeNull();
  });
  it('looks up the remapped carried trip and its shifted clock rather than yesterday or a same-number new trip',async()=>{
    const {sim,tr,task}=await fixture();const {sourceDepartureAt}=await import('../src/sim/resourceArbitration');
    const {Sim}=await import('../src/sim/engine');const {carryWorld,nextOperatingConfig,DAY_S}=await import('../src/sim/operatingDay');
    const departure=sourceDepartureAt(sim,task)!;sim.t=99900;
    const next:Simulator=new Sim(nextOperatingConfig(sim));carryWorld(next,sim);
    const carried=next.trains.get(tr.id)!,current=carried.tasks[0] as StopTask;
    expect(current.trip).not.toBe(task.trip);expect(carried.block).not.toBe(tr.block);
    expect(sourceDepartureAt(next,current)).toBeCloseTo(departure-DAY_S,8);
    expect(sourceDepartureAt(next,current)).toBe(next.plan.trips[current.trip].stops[0].dep);
  });
});
