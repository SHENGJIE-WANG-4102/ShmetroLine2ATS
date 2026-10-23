import {describe,it,expect} from 'vitest';
import {Sim} from '../src/sim/engine';
import {platformBerth,dayPeriods,OUTER_BAND_MARGIN,TEMPLATES,dwellFactorAt,buildStops,tripTasks} from '../src/sim/timetable';
import {DOOR_CYCLE, DOOR_CLOSE_S, PLANNED_CLOSE_BUDGET, PLANNED_DOOR_BUDGET, MIN_DWELL, MAX_DWELL_BUSY, plannedDwell, passengerMinimum, RIDERSHIP_TARGET} from '../src/sim/calibration';
import {RIDE_LOG} from '../src/data/ridelog';
import {OPERATIONS,STATIONS} from '../src/data/line2';
import {updateTrainTasks,newTrain} from '../src/sim/ats';
import {releaseRoute} from '../src/sim/interlocking';
import {computeBody,indexBodies} from '../src/sim/movement';
import {classify} from '../src/sim/halt';
import {computeDmi} from '../src/sim/dmi';
import {trainLevel,LEVEL_LATE,levelAccel,levelBand} from '../src/sim/energy';
import {PERF,type AtoState} from '../src/sim/dynamics';
import {capture,restore} from '../src/sim/state';

const advance=(s:Sim,t:number)=>{const end=s.t+t;while(s.t<end-1e-6)s.step();};

describe('D74 diagram ATO levels',()=>{
 const make=()=>new Sim({dayType:'weekday',dateLabel:'night levels',startTime:14400,seed:1,noPossessions:true});
 it('keeps the recalibrated continuous night-grade tables and unchanged level data',()=>{
  const s=make();
  // D137: each stopping interval adds the same 22.5 s; the airport 60 km/h
  // limit and continuous night-grade performance data stay in the physical run.
  for(const [level,dn,up] of [[3,4763.2,4765.4],[4,4897.1,4900.4]]){
   const rt=s.rt.byLevel![level];
   expect(Math.abs(rt.dn.reduce((a,b)=>a+b,0)-dn),`level ${level} DN`).toBeLessThanOrEqual(10);
   expect(Math.abs(rt.up.reduce((a,b)=>a+b,0)-up),`level ${level} UP`).toBeLessThanOrEqual(10);
  }
  expect(levelBand(1)).toEqual({band:0,lower:0});expect(levelBand(2)).toEqual({band:5/3.6,lower:0});
  expect(levelBand(3)).toEqual({band:10/3.6,lower:6.5/3.6});expect(levelBand(4)).toEqual({band:10/3.6,lower:9.5/3.6});
  expect(OPERATIONS.sectionRunAllowanceS).toBe(22.5);
 });
 it('chooses levels at interval departure, including a trip crossing into the night band',()=>{
  const s=make(),departure=21*3600+39*60+55;
  expect(buildStops(s.planCtx,'DN',0,2,0,true,.95)[0].runLevel).toBe(1); // elapsed-time solver probe, not night service
  const stops=buildStops(s.planCtx,'DN',22,26,departure,true,.45);
  expect(stops[0].runLevel).toBe(3);expect(stops[1].runLevel).toBe(4);
  expect(stops[1].arr-stops[0].dep).toBeCloseTo(s.rt.byLevel![3].dn[22],5);
  expect(stops[2].arr-stops[1].dep).toBeCloseTo(s.rt.byLevel![4].dn[23],5);
  const trip={...s.plan.trips[0],id:s.plan.trips.length,from:22,to:26,stops};s.plan.trips.push(trip);
  const tr=s.trainList[0];tr.tripId=trip.id;tr.delay=0;
  tr.tasks=[];tripTasks(s.topo,trip,tr.tasks,false);tr.tasks.shift();
  s.t=22*3600;expect(trainLevel(s,tr)).toBe(3); // interval retains its departure grade
  tr.tasks.shift();expect(trainLevel(s,tr)).toBe(4);
 });
 it('defaults to diagram operation, supports a whole-line manual override and keeps late recovery',()=>{
  const s=make(),night=s.plan.trips.find(t=>t.from===30&&t.stops[0].dep===22.5*3600)!;
  expect(s.runLevel).toBe(0);expect(s.snapshot().runLevel).toBe(0);
  for(const level of [NaN,Infinity,-1,1.5,4]){expect(s.command({c:'runLevel',level}).ok).toBe(false);expect(s.runLevel).toBe(0);}
  for(const tr of s.trainList){tr.tripId=night.id;tr.tasks=[];tripTasks(s.topo,night,tr.tasks,false);tr.tasks.shift();tr.delay=0;expect(trainLevel(s,tr)).toBe(4);}
  expect(s.command({c:'runLevel',level:1}).ok).toBe(true);
  for(const tr of s.trainList)expect(trainLevel(s,tr)).toBe(1);
  expect(s.command({c:'runLevel',level:0}).ok).toBe(true);
  const tr=s.trainList[0];tr.delay=LEVEL_LATE;expect(trainLevel(s,tr)).toBe(4);
  tr.delay=LEVEL_LATE+.01;expect(trainLevel(s,tr)).toBe(1);
  expect(s.command({c:'runLevel',level:3}).ok).toBe(true);expect(trainLevel(s,tr)).toBe(1);
 });
 it('preserves new overrides in checkpoints and migrates old saves to diagram operation',()=>{
  const s=make();s.command({c:'runLevel',level:2});const cp=capture(s);
  s.command({c:'runLevel',level:0});restore(s,cp);expect(s.runLevel).toBe(2);
  const old:typeof cp={...cp,data:{...cp.data,runLevel:3}};delete old.data.runLevelMode;
  restore(s,old);expect(s.runLevel).toBe(0);
  restore(s,capture(s));expect(s.runLevel).toBe(0);
 });
 it('plans short night dwells and completes slow whole-line pass timings without truncation',()=>{
  const s=make(),night=s.plan.trips.find(t=>t.from===30&&t.stops[0].dep===22.5*3600)!;
  for(const [i,stop] of night.stops.entries()){
   if(i<night.stops.length-1)expect(stop.runLevel).toBe(4);
   if(i>0&&i<night.stops.length-1&&STATIONS[stop.st].demand<1.4){expect(stop.dep-stop.arr).toBeGreaterThanOrEqual(25);expect(stop.dep-stop.arr).toBeLessThanOrEqual(30);}
  }
  expect(s.rt.byLevel![4].passDn[28]).toBeGreaterThan(s.rt.passDn[28]);
  expect(s.rt.byLevel![4].passDn[29]).toBeGreaterThan(100);
  const state={v:15,a:0,coast:true};
  const phase:AtoState={phase:'traction',recovered:false,neutral:0};
  expect(levelAccel(state,4,5,20,100,phase)).toBe(-PERF.resist);
  expect(phase.phase).toBe('coast'); // normal braking first releases traction
  phase.neutral=PERF.atoNeutralS;
  expect(levelAccel(state,4,5,20,100,phase)).toBeLessThan(-PERF.resist);
 });
 it('runs the first two night intervals on the slow grade without inventing lateness',()=>{
  const s=make();advance(s,.2);
  for(const tr of [...s.trainList])s.removeTrain(tr);
  for(const id of [...s.routes.keys()])releaseRoute(s,id);
  for(const block of s.plan.blocks)s.blockDone.add(block.id);
  s.connections=[];s.t=22.5*3600-60;
  const full=s.plan.trips.find(t=>t.from===30&&t.stops[0].dep===22.5*3600)!;
  const trip={...full,to:28,stops:full.stops.slice(0,3)};s.plan.trips[trip.id]=trip;
  const b=s.topo.berths[platformBerth(s.topo,30,'UP')];
  const tr=newTrain(s,s.plan.blocks[trip.block],b.link,b.offset,b.dir,[{link:b.link,dir:b.dir}],'0200');
  tr.tripId=trip.id;tr.tripNo=trip.no;tr.inService=true;tripTasks(s.topo,trip,tr.tasks,false);computeBody(s,tr);indexBodies(s);
  let samples=0,worst=0;const end=s.t+900;
  while(tr.stopsMade<3&&s.t<end){s.step();if(tr.phase==='run'&&tr.v>.1){samples++;worst=Math.max(worst,tr.delay);expect(trainLevel(s,tr)).toBe(4);}}
  expect(tr.stopsMade).toBe(3);expect(samples).toBeGreaterThan(100);expect(worst).toBeLessThan(LEVEL_LATE);
  expect(s.integrity.violations).toHaveLength(0);
 });
});
function fixture(station:number,delay:number,dwell:number,waiting=0,load=0){
 const s=new Sim({dayType:'weekday',dateLabel:'calibration',startTime:14400,seed:7,noPossessions:true});advance(s,2);const tr=s.trainList[0];
 for(const other of [...s.trainList])if(other!==tr)s.removeTrain(other);
 for(const id of [...s.routes.keys()])releaseRoute(s,id);
 for(const b of s.plan.blocks)s.blockDone.add(b.id);
 // A controlled passenger arrival scenario: all new demand is disabled while
 // the specified platform queues use the real boarding and door code.
 for(const t of s.plan.trips)t.cancelled=true;s.planRev++;s.t=8*3600;
 for(const p of s.plat)p.waiting=0;
 const berth=s.topo.berths[platformBerth(s.topo,station,'DN')];
 tr.link=berth.link;tr.off=berth.offset;tr.dir=1;tr.hist=[{link:berth.link,dir:1}];tr.v=0;tr.a=0;tr.eb=false;tr.phase='run';tr.block=-1;tr.tripId=-1;tr.inService=true;tr.load=load;tr.tbStage='none';tr.depotStage='none';
 const arr=s.t-delay;let dep=arr+dwell;
 tr.tasks=[{k:'stop',berth:berth.id,station,trip:-1,arr,dep,doors:true,revenue:true}];
 for(let st=station+1;st<=Math.min(22,station+5);st++){
  const arrival=dep+s.rt.dn[st-1];dep=arrival+25;
  tr.tasks.push({k:'stop',berth:platformBerth(s.topo,st,'DN'),station:st,trip:-1,arr:arrival,dep,doors:true,revenue:true});
 }
 tr.maDist=tr.maFar=0;tr.maSigs=[];tr.lastMa=Infinity;tr.stopDist=0;tr.lastDs=0;
 computeBody(s,tr);indexBodies(s);s.plat[berth.platform].waiting=waiting;updateTrainTasks(s,tr);
 return {s,tr,p:berth.platform};
}
describe('automatic dwell and ATO regulation',()=>{
 it('uses the recorded lock and expected random opening/start times with the preserved dwell floor',()=>{
  expect(DOOR_CLOSE_S).toBeCloseTo(5.7,12);expect(DOOR_CYCLE).toBeCloseTo(1+3+5.7+2.5,12);
  expect(PLANNED_DOOR_BUDGET).toBe(15);expect(MIN_DWELL).toBe(22);
  expect(passengerMinimum(0,0,false)).toBe(MIN_DWELL);
 });
 it('calibrates the evening sample independently from peak and late-night stops without changing daily demand',()=>{
  const paired=RIDE_LOG.filter(r=>r.recording==='ride-east'&&r.stop!==null&&r.start!==null&&r.evidence.stop?.confidence!=='low');
  expect(paired).toHaveLength(7);
  const actual=paired.reduce((sum,r)=>sum+r.start!-r.stop!,0)/paired.length;
  const model=paired.reduce((sum,r)=>sum+plannedDwell('weekday',STATIONS.findIndex(s=>s.name===r.station),'DN',20*3600,dwellFactorAt('weekday',20*3600)),0)/paired.length;
  expect(Math.abs(model-actual)).toBeLessThanOrEqual(3);
  expect(dwellFactorAt('weekday',20*3600)).toBeGreaterThan(dwellFactorAt('weekday',8*3600));
  expect(dwellFactorAt('weekday',20*3600)).toBeGreaterThan(dwellFactorAt('weekday',23*3600));
  expect(RIDERSHIP_TARGET).toEqual({weekday:1_090_000,weekend:763_000});
 });
 it('recovers seven seconds at an ordinary station and closes before countdown zero',()=>{
  const {s,tr}=fixture(5,7,32,40,100);const arrived=s.t;
  expect(tr.dwellUntil-arrived).toBeCloseTo(25,1);expect(computeDmi(s,tr.id)?.dwellTotal).toBeCloseTo(25,1);
  advance(s,13.5);expect(tr.doorsOpen).toBe(false);expect(tr.phase).toBe('dwell');expect(tr.dwellUntil-s.t).toBeGreaterThan(0);
  advance(s,11.8);expect(tr.phase).toBe('run');expect(Math.abs(tr.delay)).toBeLessThan(.3);expect(tr.v).toBeGreaterThan(0);
  expect(s.integrity.violations).toHaveLength(0);
 });
 it('records DEP at wheel start after a dispatcher hold, rather than at door closure',()=>{
  const {s,tr}=fixture(5,0,25);const task=tr.tasks[0];if(task.k!=='stop')throw new Error('fixture stop');task.trip=0;
  while(tr.phase==='dwell')s.step();const heldAt=s.t;tr.hold=true;expect(tr.pendingDeparture).toBeDefined();expect(s.depLog).toHaveLength(0);
  advance(s,5);expect(tr.v).toBe(0);expect(s.depLog).toHaveLength(0);
  const releasedAt=s.t;tr.hold=false;advance(s,.2);expect(tr.v).toBeGreaterThan(0);expect(s.depLog).toHaveLength(1);
  expect(releasedAt-heldAt).toBeCloseTo(5,5);
  expect(s.depLog[0].t).toBeGreaterThan(releasedAt);
  expect(s.depLog[0].delay).toBeCloseTo(s.depLog[0].t-task.dep!,8);
 });
 it('keeps the peak passenger minimum and recovers at following stops',()=>{
  const {s,tr}=fixture(12,7,30,1300,1900);const minimum=tr.dwellUntil-s.t;
  expect(minimum).toBeGreaterThan(30);advance(s,minimum+.2);expect(tr.delay).toBeGreaterThan(7);
  const atDeparture=tr.delay;
  let departures=0,phase=tr.phase;const until=s.t+1000;
  while(s.t<until&&departures<3){s.step();if(phase==='dwell'&&tr.phase==='run')departures++;phase=tr.phase;}
  expect(departures).toBe(3);expect(tr.delay).toBeLessThan(atDeparture);expect(tr.delay).toBeGreaterThanOrEqual(DOOR_CLOSE_S + OPERATIONS.autoStartDelay[0] - PLANNED_CLOSE_BUDGET);
  expect(tr.delay).toBeLessThan(1);
  expect(s.integrity.violations).toHaveLength(0);
 });
 it('does not give 047-2006 a long LAYOVER at 世纪大道 while seven seconds early',()=>{
  const {s,tr}=fixture(16,-7,25,80,500);tr.svc='047';tr.tripNo='2006';
  const task=tr.tasks[0];if(task.k!=='stop')throw new Error('fixture stop');task.trip=0;
  expect(tr.dwellUntil-s.t).toBeCloseTo(32,1);expect(classify(s,tr).code).toBe('DWELL');
  advance(s,32.2);expect(tr.phase).toBe('run');
  const departure=s.depLog.find(d=>d.st===16)!;expect(departure).toBeDefined();
  expect(departure.delay).toBeGreaterThanOrEqual(DOOR_CLOSE_S+OPERATIONS.autoStartDelay[0]-PLANNED_CLOSE_BUDGET);
  expect(departure.delay).toBeLessThanOrEqual(DOOR_CLOSE_S+OPERATIONS.autoStartDelay[1]-PLANNED_CLOSE_BUDGET+.2);
 });
 it('caps early platform regulation at ten seconds and keeps ATP speed supervision',()=>{
  const {s,tr}=fixture(5,-60,25,0,0);expect(tr.dwellUntil-s.t).toBeCloseTo(35,1);
  advance(s,35.3);expect(tr.delay).toBeLessThan(-49);advance(s,20);
  expect(tr.vTarget).toBeLessThanOrEqual(tr.vPermit);expect(tr.v).toBeLessThanOrEqual(tr.vPermit+.15);expect(tr.eb).toBe(false);
 });
});
describe('calibrated plan structure',()=>{
 it.each(['weekday','weekend'] as const)('%s dwells never exceed the planned dwell ceiling',dayType=>{
  const s=new Sim({dayType,dateLabel:'calibration',startTime:14400,seed:1});
  for(const t of s.plan.trips.filter(t=>t.revenue&&!t.cancelled))for(const p of t.stops)expect(p.dep-p.arr).toBeLessThanOrEqual(MAX_DWELL_BUSY+.001);
 });
 // Every train counts, including depot moves and non-revenue positioning:
 // passengers on a platform see each one. At the far end of the core the
 // terminating small-route trains do not depart, so arrivals are compared.
 const peakTimes=(s:Sim,dir:'DN'|'UP',st:number)=>s.plan.trips.filter(t=>{
  if(t.cancelled||t.dir!==dir)return false;
  const b=s.plan.blocks[t.block],next=b&&s.plan.trips[b.trips[b.trips.indexOf(t.id)+1]];
  // A same-direction positioning trip and its onward service are one train
  // at their shared station, matching the timetable validator's convention.
  return !(t.to===st&&next?.from===st&&next.dir===dir);
 })
  .flatMap(t=>t.stops.filter(p=>p.st===st).map(p=>({
   // LYL withdrawals have an arrival and no departure. Compare their slot
   // with the unchanged normal dwell, instead of mixing arrival/departure
   // events; the validator still checks the real arrival's safety headway.
   t:dir==='UP'&&st===19&&t.to===19?p.arr+plannedDwell('weekday',19,'UP',p.arr,p.arr<9.5*3600?.8:1)
    :st===(dir==='DN'?22:4)?p.arr:p.dep,trip:t})))
  .sort((a,b)=>a.t-b.t);
 it('keeps core peak spacing and accounts for planned LYL returns, depot moves included',()=>{
  const s=new Sim({dayType:'weekday',dateLabel:'calibration',startTime:14400,seed:1});
  const peaks=dayPeriods('weekday').filter(p=>p.template==='weekdayAM'||p.template==='weekdayPM');
  const portalReturns=s.plan.trips.filter(t=>!t.cancelled&&t.dir==='UP'&&t.from>=22&&t.to===19&&t.kind==='wd');
  let intervals=0;
  for(const peak of peaks)for(const dir of ['DN','UP'] as const)for(let st=4;st<=22;st++){
   const hw=TEMPLATES[peak.template].headway;
   // D73: cumulative station/direction demand changes propagate from the
   // exact reference grid; diagram phasing adds a small bounded spread.
   const tolerance=20; // D83 restores the D73 bound after balanced diagram phasing; safety remains 90 s.
   const times=peakTimes(s,dir,st).map(x=>x.t);
   // the band starts with the wave already through the core
   const start=peak.template==='weekdayAM'?(8*60+55)*60:18.5*3600;
   const at=times.findIndex(t=>t>=start);
   expect(at,`${dir} station ${st}, band start`).toBeGreaterThan(0);
   const end=peak.template==='weekdayAM'?(9*60+25)*60:(19*60+15)*60;
   for(let i=at;i<times.length&&times[i]<end;i++){
    intervals++;
    const gap=times[i]-times[i-1],where=`${dir} station ${st} at ${(times[i]/3600).toFixed(3)}`;
    if(Math.abs(gap-hw)<=tolerance)continue;
    // A planned LYL withdrawal keeps the eastern slot but omits its western
    // leg. Project that slot with the unchanged D73 dwell model before
    // accepting one doubled gap; all other gaps retain the normal bound.
    const factor=(t:number)=>t>=6*3600+50*60&&t<9.5*3600||t>=16*3600+50*60&&t<19.5*3600?.8:1;
    const omitted=dir==='UP'&&st<19&&portalReturns.some(t=>{
      const p=t.stops.at(-1)!,dep=p.arr+plannedDwell('weekday',19,'UP',p.arr,factor(p.arr));
      const q=buildStops(s.planCtx,'UP',19,st,dep,true,factor).at(-1)!;
      const projected=q.arr+plannedDwell('weekday',st,'UP',q.arr,factor(q.arr));
      return projected>times[i-1]+tolerance&&projected<times[i]-tolerance;
    });
    expect(omitted&&Math.abs(gap-2*hw)<=tolerance,where).toBe(true);
   }
   // the westbound ramp is complete at 龙阳路, where its origins there and at
   // GLL merge; GLL alone is held to one middle-track cycle (D75)
  }
  expect(intervals).toBeGreaterThan(1000);
 });
 it('bounds west-end peak gaps when portal origins replace some outer legs, depot moves included',()=>{
  const s=new Sim({dayType:'weekday',dateLabel:'calibration',startTime:14400,seed:1});
  const peaks=dayPeriods('weekday').filter(p=>p.template==='weekdayAM'||p.template==='weekdayPM');
  let intervals=0;
  // The west end lags (UP) or leads (DN) the core by its running time.
  for(const peak of peaks)for(const dir of ['DN','UP'] as const)for(let st=0;st<=3;st++){
   const hw=TEMPLATES[peak.template].headway;
   const all=s.plan.trips.filter(t=>!t.cancelled&&t.dir===dir).flatMap(t=>t.stops.filter(p=>p.st===st).map(p=>t.to===st?p.arr:p.dep)).sort((a,b)=>a-b);
   const firstAirport=s.plan.trips.find(t=>t.dir==='UP'&&t.from===30&&Math.abs(t.stops[0].dep-6*3600)<1)!;
   const openingEnd=Math.max(...s.plan.trips.filter(t=>!t.cancelled&&t.dir==='UP'&&t.kind==='ins'&&t.from===22&&t.to===0&&t.stops[0].dep<7*3600).map(t=>t.stops.at(-1)!.arr));
   const start=dir==='UP'&&peak.template==='weekdayAM'?Math.max(8.75*3600,firstAirport.stops.at(-1)!.arr+2*hw,openingEnd+2*hw):peak.template==='weekdayAM'?8.75*3600:peak.from+OUTER_BAND_MARGIN;
   const times=all.filter(t=>t>=start&&t<peak.to-OUTER_BAND_MARGIN);
   const gaps=times.slice(1).map((t,i)=>t-times[i]);
   expect(gaps.length).toBeGreaterThan(peak.template === 'weekdayAM' ? 10 : 6);
   for(let i=0;i<gaps.length;i++){
    intervals++;
    const where=`${dir} station ${st} at ${(times[i+1]/3600).toFixed(3)}: ${gaps[i]}`;
    const tol=22; // D73: same propagated dwell variation at the outer stations
    // D79/D80 portal-origin services preserve core slots while omitting an
    // outer leg; accept a doubled headway, but never a third headway.
    expect(gaps[i],where).toBeGreaterThanOrEqual(hw-tol);
    expect(gaps[i],where).toBeLessThanOrEqual(2*hw+tol);
   }
  }
  expect(intervals).toBeGreaterThan(150);
 });
});
