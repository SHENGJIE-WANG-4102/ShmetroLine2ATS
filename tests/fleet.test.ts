import {describe,it,expect} from 'vitest';
import {Sim} from '../src/sim/engine';
import {dayNumber,chooseVehicle,takeVehicle,putVehicle,maintainFleet,initVehicles,type FleetState} from '../src/sim/yard';
import {generatePlan,depotMoves,overnightPlaces,yardNeed,validatePlan} from '../src/sim/timetable';
import {dayTypeOf,parseIso,isoDate} from '../src/sim/calendar';
import {capture,restore} from '../src/sim/state';
import {OPERATIONS} from '../src/data/line2';
import type {Block,VehicleRecord} from '../src/sim/model';

const make=()=>new Sim({dayType:'weekday',date:'2026-10-19',dateLabel:'fleet',startTime:14400,seed:3,noPossessions:true});
const record=(monthly:number,daily=0):VehicleRecord=>({monthly,daily,km:0,work:'',depot:-1,until:0});

describe('fleet maintenance and assignment',()=>{
 it('uses workshop capability and inspection headroom in one pure selection rule',()=>{
  const s=make(),today=100;
  const vehicles=new Map([['old',record(30,99)],['new',record(90,99)],['line',record(80,86)],['work', {...record(0),work:'monthly' as const}]]);
  const block={...s.plan.blocks[0],end:{kind:'depot',depot:s.topo.depots.find(d=>d.work.monthly)!.id}} as Block;
  expect(chooseVehicle(vehicles,[...vehicles.keys()],s.topo,block,today)).toBe('old');
  block.end={kind:'depot',depot:s.topo.depots.find(d=>!d.work.monthly)!.id};
  expect(chooseVehicle(vehicles,[...vehicles.keys()],s.topo,block,today)).toBe('new');
  block.end={kind:'stable',station:0};
  expect(chooseVehicle(vehicles,['line','new'],s.topo,block,today)).toBe('new');
  expect(chooseVehicle(vehicles,['line','work'],s.topo,block,today)).toBeNull();
 });
 it('takes only exposed track heads and parks arrivals behind earlier departures',()=>{
  const s=make(),d=0,block={...s.plan.blocks.find(b=>b.start.kind==='depot'&&b.start.depot===d)!};
  const [head,hidden,other]=s.yards[d].tracks.flat();
  s.yards[d].tracks=s.yards[d].tracks.map(()=>[]);s.yards[d].tracks[0]=[head,hidden];s.yards[d].tracks[1]=[other];
  s.vehicles.set(head,record(20));s.vehicles.set(hidden,record(0));s.vehicles.set(other,record(10));
  block.end={kind:'depot',depot:d};
  expect(takeVehicle(s,d,block)).toBe(other);expect(s.yards[d].tracks[0]).toEqual([head,hidden]);
  s.yards[d].tracks=[[head],[other]];s.yards[d].perTrack=2;
  s.vehicles.get(head)!.monthly=0;s.vehicles.get(hidden)!.monthly=10;s.vehicles.get(other)!.monthly=20;
  s.plan.blocks=s.plan.blocks.filter(b=>b.start.kind==='depot'&&b.start.depot===d).slice(0,3).map((b,id)=>({...b,id,end:{kind:'depot' as const,depot:d}}));
  putVehicle(s,d,hidden);expect(s.yards[d].tracks).toEqual([[head,hidden],[other]]);
  const no=takeVehicle(s,d,{...block,end:{kind:'depot',depot:s.topo.depots.find(d=>!d.work.monthly)!.id}});
  expect(s.events.some(e=>e.text.includes(no!)&&e.text.includes('月检已超')&&e.text.includes('不回具备月检能力'))).toBe(true);
  expect(s.yards[d].tracks.every(t=>t.length<=s.yards[d].perTrack)).toBe(true);
 });
 it('defers work when yardNeed consumes the stock, completes it next day and migrates old saves',()=>{
  const s=make(),day=dayNumber(s.config),need=yardNeed(s.topo,s.plan),d=s.topo.depots.find(d=>d.work.monthly)!.id;
  const keep=s.yards[d].tracks.flat().slice(0,need[d]);s.yards[d].tracks.forEach(t=>t.splice(0));keep.forEach((v,i)=>s.yards[d].tracks[i%s.yards[d].tracks.length].push(v));s.depotStock[d]=keep.length;
  s.vehicles.get(keep[0])!.monthly=day-61;
  const report=maintainFleet(s,true);expect(report.deferred).toBeGreaterThan(0);expect(s.vehicles.get(keep[0])!.work).toBe('');
  expect(s.events.some(e=>e.text.includes(keep[0])&&e.text.includes('yardNeed'))).toBe(true);
  const cp=capture(s),old=structuredClone(cp);delete old.data.vehicles;
  restore(s,old);expect(s.vehicles.size).toBe(100);
  const seeded=structuredClone(s.vehicles);s.vehicles.clear();initVehicles(s);expect(s.vehicles).toEqual(seeded);
  restore(s,cp);expect(s.vehicles).toEqual(cp.data.vehicles);
 });
 it('projects 120 calendar days with the live yard functions and the available stock',()=>{
  const sim=make();
  const fleet:FleetState={topo:sim.topo,plan:sim.plan,config:sim.config,t:14400,yards:structuredClone(sim.yards),depotStock:sim.depotStock.slice(),vehicles:structuredClone(sim.vehicles),log:()=>{}};
  const slots=overnightPlaces(sim.topo);
  const slotFor=(berth:number|undefined,station:number,used=new Map<number,string>())=>slots.findIndex((p,i)=>p.berth===berth||p.arrivalBerth===berth||(berth===undefined&&p.station===station&&!used.has(i)));
  let stabled=new Map(sim.trainList.map(t=>{const start=sim.plan.blocks[t.block].start;if(start.kind!=='stable')throw Error('opening');return [slotFor(start.berth,start.station),t.vehicle];}));
  const cache=new Map<string,ReturnType<typeof generatePlan>>(),normal=new Map<string,ReturnType<typeof generatePlan>>();
  const monthly:number[]=[],nights=new Map<string,number>();let maxNights=0,alternate=0,maxDaily=0,maxMonthly=0,deferred=0;
  for(let n=0;n<120;n++){
   const date=parseIso('2026-10-19');date.setDate(date.getDate()+n);
   fleet.config={...fleet.config,date:isoDate(date),dayType:dayTypeOf(date,false)};fleet.t=13500;
   const today=dayNumber(fleet.config),complete=[...fleet.vehicles.values()].filter(r=>r.work&&r.until<=today);
   const stock=fleet.depotStock.map((v,i)=>v+complete.filter(r=>r.depot===i).length);
   const key=`${fleet.config.dayType}-${stock}`;
   let plan=cache.get(key);if(!plan){plan=generatePlan({...sim.planCtx,dayType:fleet.config.dayType,initialStock:stock});cache.set(key,plan);}
   expect(validatePlan({...sim.planCtx,dayType:fleet.config.dayType,initialStock:stock},plan).filter(i=>i.severity==='error'),`day ${n} morning plan`).toEqual([]);
   fleet.plan=structuredClone(plan);
   const before=fleet.depotStock.reduce((a,b)=>a+b,0)+complete.length;
   const maintained=n===0?{monthly:[...fleet.vehicles.values()].filter(r=>r.work==='monthly').length,deferred:0,need:yardNeed(sim.topo,fleet.plan)}:maintainFleet(fleet,true);
   monthly.push(maintained.monthly);deferred+=maintained.deferred;
   expect(fleet.depotStock.every((v,d)=>v>=maintained.need[d]),`day ${n} spare`).toBe(true);
   expect(maintained.monthly).toBeLessThanOrEqual(before-maintained.need.reduce((a,b)=>a+b,0));
   // Regenerate using only the cars left available after workshop admissions.
   const actualKey=`${fleet.config.dayType}-${fleet.depotStock}`;
   let actual=cache.get(actualKey);if(!actual){actual=generatePlan({...sim.planCtx,dayType:fleet.config.dayType,initialStock:fleet.depotStock.slice()});cache.set(actualKey,actual);}
   expect(validatePlan({...sim.planCtx,dayType:fleet.config.dayType,initialStock:fleet.depotStock.slice()},actual).filter(i=>i.severity==='error'),`day ${n} available plan`).toEqual([]);
   fleet.plan=structuredClone(actual);
   let baseline=normal.get(fleet.config.dayType);if(!baseline){baseline=generatePlan({...sim.planCtx,dayType:fleet.config.dayType});normal.set(fleet.config.dayType,baseline);}
   const sig=(p:typeof actual,b:Block)=>{const t=b.trips.map(id=>p.trips[id]).find(t=>t.revenue&&!t.cancelled);return t?`${t.no}/${t.from}/${t.stops[0].dep}`:undefined;};
   const sources=new Map(baseline.blocks.filter(b=>b.start.kind==='depot').map(b=>[sig(baseline!,b),(b.start as {depot:number}).depot]));
   for(const b of actual.blocks)if(b.start.kind==='depot'&&sources.has(sig(actual,b))&&sources.get(sig(actual,b))!==b.start.depot)alternate++;
   const assigned=new Map<number,string>();
   for(const b of fleet.plan.blocks)if(b.start.kind==='stable'){
    const slot=slotFor(b.start.berth,b.start.station),car=stabled.get(slot);expect(car,`day ${n} line slot ${slot}`).toBeDefined();assigned.set(b.id,car!);stabled.delete(slot);
   }
   for(const move of depotMoves(fleet.plan.blocks,fleet.plan.trips)){
    fleet.t=move.time;const b=fleet.plan.blocks[move.block];
    if(move.delta<0){const no=takeVehicle(fleet,move.depot,b);expect(no,`day ${n} depot ${move.depot}`).not.toBeNull();assigned.set(b.id,no!);b.train=b.id;}
    else{expect(assigned.has(b.id)).toBe(true);putVehicle(fleet,move.depot,assigned.get(b.id)!);}
   }
   for(const b of fleet.plan.blocks)if(b.end.kind==='stable'){
    const slot=slotFor(b.end.berth,b.end.station,stabled);expect(slot).toBeGreaterThanOrEqual(0);expect(stabled.has(slot)).toBe(false);stabled.set(slot,assigned.get(b.id)!);
   }
   for(const [no,r]of fleet.vehicles){
    maxDaily=Math.max(maxDaily,today-r.daily);if(!r.work)maxMonthly=Math.max(maxMonthly,today-r.monthly);
    expect(today-r.daily,`${n} ${no} daily`).toBeLessThanOrEqual(OPERATIONS.maintenance.dailyLimit);
    if(!r.work)expect(today-r.monthly,`${n} ${no} monthly`).toBeLessThanOrEqual(OPERATIONS.maintenance.monthlyLimit);
    const count=[...stabled.values()].includes(no)?(nights.get(no)??0)+1:0;nights.set(no,count);maxNights=Math.max(maxNights,count);
   }
   const ids=[...fleet.yards.flatMap(y=>y.tracks.flat()),...stabled.values(),...[...fleet.vehicles].filter(([,r])=>r.work).map(([no])=>no)];
   expect(ids).toHaveLength(100);expect(new Set(ids).size).toBe(100);
  }
  const result={days:120,min:Math.min(...monthly),max:Math.max(...monthly),average:monthly.reduce((a,b)=>a+b,0)/monthly.length,maxNights,alternate,maxDaily,maxMonthly,deferred,plans:cache.size};
  console.log('120天车辆推演',JSON.stringify(result));
  expect(deferred).toBe(0);expect(maxNights).toBeLessThan(OPERATIONS.maintenance.dailyLimit);expect(monthly.reduce((a,b)=>a+b,0)).toBeGreaterThan(100);
 },120000);
});
