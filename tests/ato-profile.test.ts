import { describe, expect, it } from 'vitest';
import { PERF, atoBrakeDistance, atoBrakeProfile, atoControl, atoLimitSpeed, atoStopApproachDistance, atoTractionAccel, jerkLimited, levelAccel, levelCruise, sectionEta, sectionPlan, sectionRecommended, tractionAccel, type AtoState } from '../src/sim/dynamics';
import {createProbeWorld,probeSection}from'../scripts/audio/field-model';
import {STATIONS}from'../src/data/line2';
import {capture,restore}from'../src/sim/state';

describe('section ATO trajectory', () => {
  it('eases both ends of a normal stop while preserving the nominal average and distance', () => {
    const entry=17,distance=atoBrakeDistance(entry);
    expect(distance).toBe(entry*entry/(2*PERF.bPlan));
    expect(atoBrakeProfile(entry,distance).decel).toBe(0);
    const middle=atoBrakeProfile(entry,distance/2),tail=atoBrakeProfile(entry,.05);
    expect(middle.decel).toBeGreaterThan(PERF.bPlan);expect(middle.decel).toBeLessThanOrEqual(PERF.bService);
    expect(tail.decel).toBeLessThan(middle.decel/2);
    let remaining=distance,seconds=0;
    while(remaining>1e-6&&seconds<30){remaining-=atoBrakeProfile(entry,remaining).speed*.001;seconds+=.001;}
    expect(Math.abs(seconds-entry/PERF.bPlan)).toBeLessThan(.05);
  });
  it('fits its brake shape within the actual downhill net force and jerk limits',()=>{
    for(const grade of[-.15,0,.214547])for(const v of[1,3,6.11,17,22]){
      const distance=atoBrakeDistance(v,grade),average=v*v/(2*distance),capacity=PERF.bService-grade;
      expect(average).toBeLessThanOrEqual(PERF.bPlan+1e-10);
      for(let i=1;i<100;i++){
        const d=distance*i/100,delta=distance*1e-5;
        const point=atoBrakeProfile(v,d,distance,grade);
        const before=atoBrakeProfile(v,d-delta,distance,grade),after=atoBrakeProfile(v,d+delta,distance,grade);
        expect(point.decel).toBeLessThanOrEqual(capacity+1e-8);
        expect(Math.abs(after.decel-before.decel)/(2*delta)*point.speed).toBeLessThanOrEqual(PERF.jerk+.001);
      }
    }
    const grade=.214547;
    expect(atoBrakeDistance(22,grade)).toBe(22*22/(2*PERF.bPlan)); // A feasible nominal stop only changes its ramp.
    expect(atoBrakeDistance(6.11,grade)).toBeGreaterThan(atoBrakeDistance(6.11));
  });
  it('stops from a full downhill depot acceleration with the real motor brake force clamped',()=>{
    const grade=.214547,goal=215;
    for(const start of[0,150]){
      const state:AtoState={phase:'traction',recovered:false,neutral:0};
      let x=start,v=0,a=0;
      for(let tick=0;tick<1500;tick++){
        const remaining=goal-x;
        if(remaining<.4&&v<.35)break;
        const permit=Math.sqrt(Math.max(0,2*PERF.bPermit*(goal+2-x)));
        const target=Math.min(22/3.6,permit);
        const c=atoControl(state,{v,a,target,cruise:22/3.6,stopDist:remaining,remaining,grade,protecting:v>=permit-.1});
        const requested=state.phase==='coast'&&c===-PERF.resist?c:c>0?Math.max(c-grade,c):c-grade;
        const effort=Math.max(-PERF.bService,Math.min(atoTractionAccel(v),requested));
        a=jerkLimited(a,effort,.1);const nv=Math.max(0,v+(a+grade)*.1);x+=(v+nv)*.05;v=nv;
      }
      expect(Math.abs(goal-x)).toBeLessThan(1.5);expect(v).toBeLessThan(.35);
      expect(state.brakeEntryGrade).toBe(grade);
    }
  });
  it('caps automatic requests without reducing the manual traction characteristic', () => {
    expect(tractionAccel(0)).toBe(PERF.aMax);
    for (const v of [0, 5, 10, 15, 20]) {
      expect(atoTractionAccel(v)).toBe(Math.min(PERF.atoAccelMax, tractionAccel(v)));
      const state: AtoState={phase:'traction',recovered:false,neutral:0};
      expect(atoControl(state,{v,a:0,target:22,cruise:22,stopDist:5000,remaining:5000})).toBeLessThanOrEqual(PERF.atoAccelMax);
    }
  });
  it('holds speed with continuous balancing effort instead of a coast/traction pulse', () => {
    const state: AtoState={phase:'hold',recovered:false,neutral:0};
    let v=18,a=0;
    for(let i=0;i<1000;i++){
      const request=atoControl(state,{v,a,target:18,cruise:18,stopDist:Infinity,remaining:4000});
      a=jerkLimited(a,request,.1);v+=a*.1;
      expect(state.phase).toBe('hold');expect(v).toBeCloseTo(18,8);
    }
  });
  it('uses the soft wet-rail braking rate for a falling target without applying the dry feedforward', () => {
    const state:AtoState={phase:'brake',recovered:false,neutral:1};
    const wet=atoControl(state,{v:15,a:-.45,target:14.75,cruise:22,stopDist:3000,remaining:3000,brakeRate:.45});
    expect(wet).toBe(-.45);
    const dry=atoControl({...state},{v:15,a:-.45,target:14.75,cruise:22,stopDist:3000,remaining:3000});
    expect(dry).toBe(-PERF.bPlan);
  });
  it('uses the normal brake shape in planning and reserves protection for an explicit override', () => {
    const motion={v:17,a:-PERF.resist,coast:true};
    const state:AtoState={phase:'coast',recovered:false,neutral:1};
    const distance=atoBrakeDistance(motion.v);
    levelAccel(motion,1,16.5,22,distance,state);
    expect(state.phase).toBe('brake');expect(state.brakeEntrySpeed).toBe(17);
    const protectedState:AtoState={phase:'hold',recovered:false,neutral:0};
    expect(levelAccel({...motion},1,16.5,22,distance+500,protectedState,{protecting:true})).toBeLessThan(0);
    expect(protectedState.phase).toBe('hold');expect(protectedState.brakeEntrySpeed).toBeUndefined();
  });
  it('enters the terminal transition before consuming the physical brake distance',()=>{
    const v=6.112,a=.2,physical=atoBrakeDistance(v),approach=atoStopApproachDistance(v,a);
    expect(approach-physical).toBeGreaterThan(v*PERF.atoNeutralS);
    const state:AtoState={phase:'hold',recovered:false,neutral:0};
    atoControl(state,{v,a,target:v,cruise:v,stopDist:physical+2,remaining:physical+2});
    expect(state.phase).toBe('brake');expect(state.brakeEntryDistance).toBe(physical);
  });
  it('never lets an ATP protection request weaken an already required terminal service brake',()=>{
    const state:AtoState={phase:'brake',recovered:false,neutral:0,brakeEntrySpeed:6.1111111112,brakeEntryDistance:24.8971193424};
    const input={v:5.82866,a:-.55428,target:5.5618,cruise:6.1111111112,stopDist:19.037,remaining:19.037};
    const normal=atoControl({...state},input),protectedState={...state};
    const protectedRequest=atoControl(protectedState,{...input,protecting:true});
    expect(normal).toBeLessThan(-PERF.bPlan);
    expect(protectedRequest).toBeLessThanOrEqual(normal);
    expect(protectedState.phase).toBe('brake');
    expect(protectedState.brakeEntrySpeed).toBe(state.brakeEntrySpeed);
    expect(protectedState.brakeEntryDistance).toBe(state.brakeEntryDistance);
  });
  it('latches the terminal shape even when ATP protection is the first request to brake',()=>{
    const v=6,state:AtoState={phase:'hold',recovered:false,neutral:0};
    atoControl(state,{v,a:0,target:5.7,cruise:v,stopDist:atoBrakeDistance(v)+1,remaining:atoBrakeDistance(v)+1,protecting:true});
    expect(state.phase).toBe('brake');expect(state.brakeEntrySpeed).toBe(v);
    expect(state.terminalApproachDistance).toBeDefined();
  });
  it('keeps terminal preparation latched while releasing traction, and releases it for a genuinely extended authority',()=>{
    const state:AtoState={phase:'hold',recovered:false,neutral:0},v=15;
    let distance=atoStopApproachDistance(v,.6)-.1;
    atoControl(state,{v,a:.6,target:22,cruise:22,stopDist:distance,remaining:distance});
    expect(state.terminalApproachDistance).toBeDefined();
    for(let i=0;i<6;i++){
      distance-=.1;
      atoControl(state,{v,a:0,target:22,cruise:22,stopDist:distance,remaining:distance});
      expect(['coast','brake']).toContain(state.phase);
    }
    atoControl(state,{v:0,a:0,target:22,cruise:22,stopDist:distance+100,remaining:distance+100});
    expect(state.phase).toBe('traction');expect(state.terminalApproachDistance).toBeUndefined();
  });
  it('spends moderate slack on coasting before lowering the traction cutoff', () => {
    const fast=sectionEta(4000,0,22);
    const plan=sectionPlan(4000,0,fast+15,22);
    expect(plan.cutoff).toBe(22);expect(plan.coastAt).toBeGreaterThan(0);
    expect(Math.abs(plan.eta-fast-15)).toBeLessThan(1.5);
    const coast=plan.samples.filter(s=>s.remaining<plan.coastAt&&s.speed>16);
    expect(coast.length).toBeGreaterThan(5);
    expect(coast.at(-1)!.speed).toBeLessThan(coast[0].speed);
    expect(sectionRecommended(plan,coast.at(-1)!.remaining)).toBeLessThan(sectionRecommended(plan,coast[0].remaining));
  });
  it('keeps night grades on continuous holding and lowers their cutoff for slack', () => {
    const fast=sectionEta(4000,0,levelCruise(4,18));
    const plan=sectionPlan(4000,0,fast+20,18,undefined,0,0,4);
    expect(plan.coastAt).toBe(-1);expect(plan.cutoff).toBeLessThan(18);
    expect(Math.abs(plan.eta-fast-20)).toBeLessThan(1.5);
  });
  it('recovers after a temporary authority stop without retaining a brake latch', () => {
    const state: AtoState={phase:'traction',recovered:false,neutral:0};
    expect(atoControl(state,{v:15,a:.5,target:0,cruise:22,stopDist:100,remaining:3000,protecting:true})).toBeLessThan(0);
    expect(atoControl(state,{v:0,a:0,target:22,cruise:22,stopDist:3000,remaining:3000})).toBeGreaterThan(0);
    expect(state.phase).toBe('traction');
  });
  it('finishes moving replans below current speed instead of latching into an unpowered stop', () => {
    const normal=sectionPlan(1000,15,110,PERF.vMax);
    expect(normal.cutoff).toBeLessThan(15);expect(normal.completed).toBe(true);expect(normal.coastValid).toBe(true);
    expect(Math.abs(normal.eta-110)).toBeLessThan(.5);
    const excessive=sectionPlan(1000,15,10000,PERF.vMax);
    expect(excessive.completed).toBe(true);expect(excessive.coastValid).toBe(true);
    expect(excessive.eta).toBeLessThan(1000);
    expect(excessive.cutoff).toBeGreaterThan(0);
  });
  it('does not put every low-speed turnout limit over the whole remaining section', () => {
    const local=sectionEta(2000,8,22,[{length:100,limit:8},{length:1900,limit:22}]);
    expect(local).toBeLessThan(sectionEta(2000,8,8)-60);
    expect(sectionEta(2000,0,22,[{length:1,limit:22},{length:1999,limit:22}])).toBe(sectionEta(2000,0,22));
  });
  it('finishes the neutral and jerk transition before entering a lower static limit', () => {
    const slow=30/3.6,limits=[{length:1900,limit:PERF.vMax},{length:100,limit:slow}];
    const budget=sectionEta(2000,0,PERF.vMax,limits)+20;
    const plan=sectionPlan(2000,0,budget,PERF.vMax,limits);
    expect(plan.completed).toBe(true);
    expect(plan.samples.filter(s=>s.remaining<=100).every(s=>s.speed<=slow+.1)).toBe(true);
    expect(Math.abs(plan.eta-budget)).toBeLessThan(.5);
  });
  it('keeps an ordinary neutral transition below a terminal static limit out of the planned-coast floor check',()=>{
    // Actual YDD→HTS profile: the last 198 m are 60 km/h. Its normal ATO
    // target is 57, below the scheduled-coast floor of 60.
    const limits=[{length:5720,limit:80/3.6},{length:198,limit:60/3.6}];
    const plan=sectionPlan(5918,0,323,77/3.6,limits,3/3.6);
    expect(plan.completed).toBe(true);expect(plan.coastValid).toBe(true);
    expect(plan.cutoff*3.6).toBeGreaterThanOrEqual(75);
    expect(plan.coastAt).toBeGreaterThan(0);
    expect(Math.abs(plan.eta-323)).toBeLessThan(.5);
    expect(plan.samples.filter(p=>p.remaining<=198).every(p=>p.speed<=57/3.6+.1)).toBe(true);
    const state:AtoState={phase:'brake',recovered:false,neutral:0};
    const v=57.350808203125/3.6,remaining=206.5667957861;
    atoControl(state,{v,a:-.675,target:57/3.6,cruise:plan.cutoff,stopDist:remaining,remaining,plan});
    expect(v).toBeLessThan(plan.coastFloor-.1);
    expect(state.phase).toBe('coast');expect(state.plannedCoast).toBe(false);
    expect(state.brakeEntrySpeed).toBeUndefined();
  });
  it('still rejects an early planned coast that falls below its floor before terminal braking',()=>{
    const dist=4000,plan=sectionPlan(dist,0,240,22);
    const minScheduledCoast=(coastAt:number)=>{
      const reference={...plan,coastAt},state:AtoState={phase:'traction',recovered:false,neutral:0};
      let x=0,v=0,a=0,minimum=Infinity;
      for(let i=0;i<4000;i++){
        const remaining=dist-x;if(remaining<.4&&v<.35)break;
        const target=Math.min(reference.cutoff,Math.sqrt(Math.max(0,2*PERF.bPlan*(remaining-.2))));
        const c=atoControl(state,{v,a,target,cruise:reference.cutoff,stopDist:remaining,remaining,plan:reference});
        if(state.phase==='coast'&&state.plannedCoast&&remaining>atoStopApproachDistance(v,a))minimum=Math.min(minimum,v);
        a=jerkLimited(a,c,.1);const nv=Math.max(0,v+a*.1);x+=(v+nv)*.05;v=nv;
      }
      return minimum;
    };
    expect(plan.completed).toBe(true);expect(plan.coastValid).toBe(true);
    expect(plan.cutoff).toBeLessThan(22);expect(plan.coastAt).toBeLessThan(dist);
    expect(minScheduledCoast(plan.coastAt)).toBeGreaterThanOrEqual(plan.coastFloor-.1);
    // Scheduling the same cutoff's coast at the section entrance is physically
    // too early. The solver must retain its floor rather than accepting this.
    expect(minScheduledCoast(dist)).toBeLessThan(plan.coastFloor-.1);
  });
  it('keeps the two real daytime elevated directions close with the terminal 60 limit intact',()=>{
    const sim=createProbeWorld(),checkpoint=capture(sim),peaks:number[]=[];
    for(const [origin,destination,dir]of[['YDD','HTS','DN'],['HTS','YDD','UP']]as const){
      restore(sim,checkpoint);
      const from=STATIONS.findIndex(s=>s.id===origin),to=STATIONS.findIndex(s=>s.id===destination);
      const row=probeSection(sim,from,to,dir,43200);
      expect(row.completed).toBe(true);expect(row.violations).toEqual([]);
      expect(row.peakKmh).not.toBeNull();
      peaks.push(row.peakKmh!);
    }
    // On-time speed follows the remaining arrival budget, without a minimum
    // peak-speed requirement. The old false coast rejection split these by 5.
    expect(Math.abs(peaks[0]-peaks[1])).toBeLessThan(1);
  });
  it('keeps the restriction envelope continuous as coasting effort becomes braking effort',()=>{
    const before=atoLimitSpeed(30,14.4,15,-PERF.resist+.001);
    const after=atoLimitSpeed(30,14.4,15,-PERF.resist-.001);
    expect(Math.abs(after-before)).toBeLessThan(.01);
  });
  it.each([['GJH','PXL','UP',72278,false],['LYL','ZJG','DN',43200,true]]as const)(
    'keeps the real %s → %s approach to a few stages without frame-by-frame brake cycling',(origin,destination,dir,clock,expectCeilingChange)=>{
    const sim=createProbeWorld(),step=sim.step.bind(sim),phases:string[]=[],ceilings=new Set<number>();
    const from=STATIONS.findIndex(s=>s.id===origin),to=STATIONS.findIndex(s=>s.id===destination);
    sim.step=()=>{step();const tr=sim.trainList.find(t=>t.svc==='probe');
      if(tr?.tasks[0]?.k!=='stop'||tr.tasks[0].station!==to)return;
      const phase=tr.ato?.state.phase;if(tr.ato)ceilings.add(tr.ato.ceiling);
      if(phase&&phase!==phases.at(-1))phases.push(phase);
    };
    const row=probeSection(sim,from,to,dir,clock);
    expect(row.completed).toBe(true);expect(row.violations).toEqual([]);
    expect(phases.length).toBeLessThanOrEqual(9);
    expect(phases.filter(p=>p==='traction').length).toBeLessThanOrEqual(2);
    if(expectCeilingChange)expect(ceilings.size).toBeGreaterThan(1);
    expect(phases.join(',')).not.toContain('brake,coast,brake,coast,brake');
  });
  it('keeps a full live section to a few stages and respects the coast-end floor', () => {
    const dist=4000,plan=sectionPlan(dist,0,sectionEta(dist,0,22)+15,22);
    const state:AtoState={phase:'traction',recovered:false,neutral:0};
    let x=0,v=0,a=0,changes=0,previous=state.phase,minCoast=Infinity;
    for(let i=0;i<4000;i++){
      const remaining=dist-x;
      if(remaining<.4&&v<.35)break;
      const target=Math.min(22,Math.sqrt(Math.max(0,2*PERF.bPlan*(remaining-.2))));
      const c=atoControl(state,{v,a,target,cruise:22,stopDist:remaining,remaining,plan,dt:.1});
      if(state.phase!==previous){changes++;previous=state.phase;}
      if(state.phase==='coast'&&remaining>v*v/(2*PERF.bPlan)+Math.max(3,v*.8))minCoast=Math.min(minCoast,v);
      a=jerkLimited(a,c,.1);const nv=Math.max(0,v+a*.1);x+=(v+nv)*.05;v=nv;
    }
    expect(changes).toBeLessThanOrEqual(6);expect(minCoast).toBeGreaterThanOrEqual(plan.coastFloor-.15);
    expect(x).toBeLessThanOrEqual(dist+.3);expect(dist-x).toBeLessThan(.4);expect(v).toBeLessThan(.35);
  });
});
