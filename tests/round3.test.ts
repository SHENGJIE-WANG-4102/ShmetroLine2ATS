import {describe,expect,it} from 'vitest';
import {Sim} from '../src/sim/engine';
import {applyOverlay,depotLedger,OVERLAY_PRESETS,storageOccupancy,validatePlan,platformBerth} from '../src/sim/timetable';
import {scanAhead,updateTrainMotion} from '../src/sim/movement';
import {captureWarmup,readWarmup,restoreWarmup,warmupKey,writeWarmup} from '../src/sim/warmupCache';
import {capture,restore,type Checkpoint} from '../src/sim/state';
import {makeSim,runFor,assertIntegrity,assertNoCollision} from './helpers';
import {envTick} from '../src/sim/env';
import {newTrain} from '../src/sim/ats';
import {checkSafety} from '../src/sim/invariants';

const H=(h:number,m=0)=>h*3600+m*60;
const create=(dayType:'weekday'|'weekend'='weekday')=>new Sim({dayType,dateLabel:'round3',startTime:H(4),seed:1});

describe('registered storage positions',()=>{
  it('checks restored and disappeared state machines after rebuilding observation indices',()=>{
    const sim=create();runFor(sim,2);checkSafety(sim);
    const cp=capture(sim),rid=sim.topo.routes.length+10,key=`route:${rid}`;
    // A diagnostic checkpoint can contain an entity no longer in the
    // live collection. Its terminal transition still needs supervision.
    cp.data.integrity=(structuredClone(cp.data.integrity)as typeof sim.integrity);
    (cp.data.integrity as typeof sim.integrity).fsm.set(key,'invalid');
    restore(sim,cp);checkSafety(sim);
    expect(sim.integrity.fsm.has(key)).toBe(false);
    expect(sim.integrity.violations.some(v=>v.kind==='FSM'&&v.detail.includes(`进路[${rid}]`))).toBe(true);
    restore(sim,capture(create()));runFor(sim,2);checkSafety(sim);
    expect(sim.integrity.violations).toEqual([]);
    const tr=sim.trainList[0];tr.mode='DTO';tr.level='TBTC';checkSafety(sim);
    expect(sim.integrity.violations.some(v=>v.kind==='FSM')).toBe(true);
  });
  it('accepts a restrictive authority in the braking step that reaches standstill',()=>{
    const sim=create(),tr=sim.trainList[0];
    tr.phase='run';tr.v=.02;tr.eb=true;tr.maCut=true;tr.lastMa=1400;tr.lastDs=0;
    updateTrainMotion(sim,tr,.1);
    expect(tr.v).toBeLessThanOrEqual(.01);
    expect(tr.maCut).toBe(false);
    expect(tr.maDist).toBe(0);
    expect(tr.lastMa).toBe(0);
  });
  it('does not let a following depot return reserve the arriving turner’s only tail',()=>{
    const sim=makeSim('weekday',35700,{seed:5});
    runFor(sim,300,s=>{assertIntegrity(s);assertNoCollision(s);});
    expect(sim.trainList.filter(t=>t.phase==='dwell'&&sim.t-t.dwellUntil>300&&t.tasks[1]?.k==='reverse')).toEqual([]);
  });
  it.each(['weekday','weekend'] as const)('%s: holds overnight heads at their spawn berths',day=>{
    const sim=create(day), positions=sim.trainList.map(tr=>({id:tr.id,link:tr.link,off:tr.off}));
    expect(positions.length).toBe(8);
    while(sim.t<H(4,2)) sim.step();
    for(const p of positions) {
      const tr=sim.trains.get(p.id)!;
      expect(tr.link).toBe(p.link);
      expect(Math.abs(tr.off-p.off)).toBeLessThan(.01);
    }
  });
  it('keeps authority at the hot berth while the next task is on a distant platform',()=>{
    const sim=create(), tr=sim.trainList.find(tr=>sim.topo.berths.some(b=>b.station===24&&b.link===tr.link))!;
    expect(tr).toBeDefined();
    sim.t=H(12);
    const berth=platformBerth(sim.topo,24,'DN');
    tr.tasks=[{k:'stop',berth,station:24,trip:-1,arr:null,dep:H(13),standby:true,revenue:true,doors:true}];
    const scan=scanAhead(sim,tr,berth);
    expect(scan.maDist).toBe(0);
    expect(scan.maCode).toBe('REGULATION');
  });
  it('rejects an overnight reservation on a platform-kind middle track against a turn',()=>{
    const sim=create(),plan=structuredClone(sim.plan);
    const overnight=plan.blocks.find(b=>b.end.kind==='stable'&&b.end.station===22&&b.end.berth!==undefined
      &&sim.topo.stations[22].turnbackBerths.includes(b.end.berth))!;
    const turn=storageOccupancy(sim.topo,plan).find(o=>o.station===22&&o.block!==overnight.id&&o.from>H(8)&&o.to<H(20))!;
    const last=plan.trips[overnight.trips.at(-1)!];
    last.stops.at(-1)!.arr=turn.from-1;
    expect(validatePlan(sim.planCtx,plan).some(i=>i.code==='STABLE_CONFLICT'&&i.blocks?.includes(overnight.id)&&i.blocks.includes(turn.block))).toBe(true);
  });
});

describe('early and late added-service reservations',()=>{
  it('rejects a duty that reverses in an unavailable arrival direction',()=>{
    const sim=create(),plan=structuredClone(sim.plan);
    const block=plan.blocks.find(b=>b.trips.some((id,i)=>plan.trips[id].dir==='DN'&&plan.trips[id].to===30&&plan.trips[b.trips[i+1]]?.dir==='UP'))!;
    const i=block.trips.findIndex(id=>plan.trips[id].dir==='DN'&&plan.trips[id].to===30);
    const arrival=plan.trips[block.trips[i]],departure=plan.trips[block.trips[i+1]];
    arrival.to=4;arrival.stops=arrival.stops.filter(s=>s.st<=4);
    departure.from=4;departure.stops=departure.stops.filter(s=>s.st<=4);
    expect(validatePlan(sim.planCtx,plan).some(i=>i.code==='TURN_UNAVAILABLE'&&i.blocks?.includes(block.id))).toBe(true);
  });
  it('clears the shared depot lead before a following through train, without a circular priority wait',()=>{
    const sim=makeSim('weekend',H(4,43),{seed:2901});
    expect(sim.command({c:'overlay',id:'ciie',from:H(5),to:H(6),headway:600}).ok).toBe(true);
    runFor(sim,H(8,10)-sim.t,s=>{assertIntegrity(s);assertNoCollision(s);});
    expect(sim.trainList.filter(t=>t.halt.unplannedSince>0&&sim.t-t.halt.unplannedSince>300)).toEqual([]);
    const through=sim.plan.trips.find(t=>t.no==='1005')!;
    expect(sim.depLog.some(d=>d.trip===through.id&&d.st===28)).toBe(true);
    // This covers the entire 04:43–08:10 shared-lead sequence with safety checks.
  },180_000);
  it('continues beyond a briefly occupied tail while retaining every fitted call and reporting omitted requests',()=>{
    const sim=create(),plan=structuredClone(sim.plan);
    const result=applyOverlay(sim.planCtx,plan,{...OVERLAY_PRESETS.find(p=>p.id==='ciie')!,from:H(5),to:H(6),headway:600},{now:H(4,43),canExtend:()=>true});
    const through=plan.trips.filter(t=>t.overlay&&!t.cancelled&&t.revenue&&t.from===1&&t.to>22&&t.stops[0].dep<=H(6));
    // D119's physical timings, then D135/D138, changed the feasible slots.
    // Pin the current full-plan result without dropping any requested calls.
    expect(through).toHaveLength(1);
    for(const trip of through) for(let station=1;station<=22;station++)
      expect(trip.stops.find(s=>s.st===station)?.stop).toBe(true);
    expect(result.skipped).toBe(4);
    const omitted=plan.trips.filter(t=>t.overlay&&t.cancelled&&t.revenue);
    expect(omitted).toHaveLength(4);
    expect(omitted.every(t=>!!t.cancelReason)).toBe(true);
    expect(validatePlan(sim.planCtx,plan).filter(i=>i.severity==='error')).toEqual([]);
  });
  it('keeps work behind the entire remaining path of a non-stopping empty delivery',()=>{
    const sim=create();
    sim.trainList=[];sim.trains.clear();sim.plan.blocks=[];
    const start=sim.topo.berths[platformBerth(sim.topo,1,'DN')];
    const tr=newTrain(sim,null,start.link,start.offset,start.dir,[{link:start.link,dir:start.dir}],'test-empty');
    tr.tasks=[{k:'stop',berth:platformBerth(sim.topo,22,'DN'),station:22,trip:-1,arr:H(26),dep:null,doors:false,revenue:false}];
    tr.inService=false;
    const section=sim.topo.sections.find(s=>s.track==='DN'&&s.station===7&&s.kind==='plain')!;
    sim.t=H(25);
    sim.possessions=[{id:0,name:'empty path',sections:[section.id],from:sim.t,to:H(27),state:'planned'}];
    envTick(sim);
    expect(sim.possessions[0].state).toBe('planned');
    tr.phase='stabled';
    envTick(sim);
    expect(sim.possessions[0].state).toBe('requested');
  });
  for(const [id,now,from,to] of [['hongqiao',H(18,38),H(20),H(24,30)],['ciie',H(4,43),H(5),H(6)]] as const) {
    it(`${id} ordered at ${now}: closes all yards and reserves overnight slots`,()=>{
      const sim=create(),plan=structuredClone(sim.plan),original=plan.trips.map(t=>({from:t.from,to:t.to,stops:structuredClone(t.stops)}));
      const result=applyOverlay(sim.planCtx,plan,{...OVERLAY_PRESETS.find(p=>p.id===id)!,from,to,headway:600},{now,canExtend:()=>true});
      expect(result.trips).toBeGreaterThan(0);
      expect(validatePlan(sim.planCtx,plan).filter(i=>i.severity==='error')).toEqual([]);
      expect(depotLedger(sim.topo,plan).final).toEqual(depotLedger(sim.topo,plan).initial);
      expect(plan.trips.slice(0,original.length).map(t=>({from:t.from,to:t.to,stops:t.stops}))).toEqual(original);
      expect(plan.blocks.filter(b=>b.end.kind==='stable'&&b.end.station===22&&b.trips.some(id=>!plan.trips[id].cancelled))).toHaveLength(2);
    });
  }
});

describe('optional persistent warm-up cache',()=>{
  it('restores the same initial graph history without draining or sharing the warm-up buffers',()=>{
    const sim=create();runFor(sim,120);
    const removed=sim.trainList.find(t=>t.trace.length)!;
    expect(removed).toBeDefined();sim.removeTrain(removed);
    const saved=captureWarmup(sim),expected=structuredClone(saved.warmupTraces!);
    expect(expected.length).toBeGreaterThan(0);
    const cold=sim.snapshot().traces;
    expect(cold).toEqual(expected);
    expect(saved.warmupTraces).toEqual(expected);
    const hit=create();
    expect(()=>restoreWarmup(hit,{...saved,warmupTraces:undefined})).toThrow();
    restoreWarmup(hit,saved);
    expect(hit.snapshot().traces).toEqual(cold);
    expect(hit.snapshot().traces).toEqual([]);
  });
  it('invalidates for code, plan, day, seed and start time, independent of property order',async()=>{
    const sim=create(),config=sim.config,source={'engine.ts':'v1'};
    const key=await warmupKey(config,sim.plan,source);
    expect(await warmupKey({...config},structuredClone(sim.plan),{...source})).toBe(key);
    for(const changed of [{...config,seed:2},{...config,dayType:'weekend' as const},{...config,startTime:H(7,40)}])
      expect(await warmupKey(changed,sim.plan,source)).not.toBe(key);
    expect(await warmupKey(config,sim.plan,{'engine.ts':'v2'})).not.toBe(key);
    const plan=structuredClone(sim.plan);plan.trips[0].stops[0].dep++;
    expect(await warmupKey(config,plan,source)).not.toBe(key);
  });
  it('falls back cleanly when IndexedDB is unavailable',async()=>{
    expect(await readWarmup('unavailable')).toBeNull();
    await expect(writeWarmup('unavailable',{} as Checkpoint)).resolves.toBeUndefined();
  });
});
