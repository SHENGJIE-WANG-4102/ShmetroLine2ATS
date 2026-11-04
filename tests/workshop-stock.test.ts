import {describe,expect,it,vi} from 'vitest';
import {Sim} from '../src/sim/engine';
import {dayNumber,initVehicles,maintainFleet,type FleetState} from '../src/sim/yard';
import {yardNeed} from '../src/sim/timetable';

const make=(seed=3,dayType:'weekday'|'weekend'='weekday')=>new Sim({dayType,date:dayType==='weekday'?'2026-10-19':'2026-10-24',dateLabel:'workshop stock',startTime:14400,seed,noPossessions:true});
function fixture(){
 const s=make(),today=dayNumber(s.config);
 const fleet:FleetState={topo:s.topo,plan:{...s.plan,trips:[],blocks:[]},config:s.config,t:s.t,log:vi.fn(),
  vehicles:structuredClone(s.vehicles),depotStock:s.topo.depots.map(()=>0),
  yards:s.yards.map(y=>({...y,tracks:y.tracks.map(()=>[] as string[])}))};
 for(const record of fleet.vehicles.values())Object.assign(record,{work:'',until:0,monthly:today-10,daily:today});
 const names=[...fleet.vehicles.keys()];
 const park=(depot:number,nos:string[])=>{nos.forEach((no,i)=>fleet.yards[depot].tracks[i%fleet.yards[depot].tracks.length].push(no));fleet.depotStock[depot]+=nos.length;};
 const work=(no:string,depot:number,kind:'monthly'|'overhaul',until=today+10)=>Object.assign(fleet.vehicles.get(no)!,{work:kind,depot,until});
 return {s,fleet,today,names,park,work};
}

describe('ongoing workshop stock',()=>{
 for(const dayType of ['weekday','weekend'] as const)it.each([1,3,7,103,142031])(`${dayType} seed%s: keeps real parking and workshops within their separate contracts`,seed=>{
  const s=make(seed,dayType),working=[...s.vehicles].filter(([,r])=>r.work);
  expect(working.length).toBeGreaterThanOrEqual(2);
  expect(working.length).toBeLessThanOrEqual(3);
  for(const [depot,yard]of s.yards.entries()){
   expect(s.depotStock[depot]).toBeLessThanOrEqual(s.topo.depots[depot].capacity);
   expect(yard.tracks.every(track=>track.length<=yard.perTrack)).toBe(true);
  }
  const parked=s.yards.flatMap(y=>y.tracks.flat());
  for(const [no,r]of working){expect(parked).not.toContain(no);expect(s.topo.depots[r.depot].work[r.work as 'monthly'|'overhaul']).toBe(true);}
  const ids=[...parked,...working.map(([no])=>no),...s.stabledPool,...s.trainList.map(t=>t.vehicle)];
  expect(ids).toHaveLength(100);expect(new Set(ids).size).toBe(100);
  expect(s.plan.blocks.filter(b=>b.start.kind==='stable')).toHaveLength(6);
  expect(s.plan.initialStock).toEqual(s.depotStock);
 });
 it('admits the oldest eligible spare, never an online or incapable-yard car, and is idempotent',()=>{
  const {fleet,today,names,park,work}=fixture();
  const repair=fleet.topo.depots.find(d=>d.work.overhaul)!.id,monthly=fleet.topo.depots.find(d=>d.work.monthly&&!d.work.overhaul)!.id;
  const other=fleet.topo.depots.find(d=>!d.work.monthly)!.id;
  work(names[0],repair,'overhaul');park(monthly,[names[1],names[2]]);park(other,[names[3]]);
  fleet.vehicles.get(names[1])!.monthly=today-20;
  fleet.vehicles.get(names[3])!.monthly=today-59;fleet.vehicles.get(names[4])!.monthly=today-59;
  maintainFleet(fleet,false);
  expect(fleet.vehicles.get(names[1])).toMatchObject({work:'monthly',monthly:today-20,depot:monthly});
  expect(fleet.vehicles.get(names[3])!.work).toBe('');expect(fleet.vehicles.get(names[4])!.work).toBe('');
  const before=structuredClone({vehicles:fleet.vehicles,yards:fleet.yards,stock:fleet.depotStock});
  maintainFleet(fleet,false);
  expect({vehicles:fleet.vehicles,yards:fleet.yards,stock:fleet.depotStock}).toEqual(before);
 });
 it('preserves every due monthly admission when the ongoing count is already three',()=>{
  const {fleet,today,names,park,work}=fixture(),d=fleet.topo.depots.find(d=>d.work.monthly)!.id;
  work(names[0],d,'overhaul');park(d,[names[1],names[2],names[3]]);
  fleet.vehicles.get(names[1])!.monthly=today-60;fleet.vehicles.get(names[2])!.monthly=today-61;
  const result=maintainFleet(fleet,false);
  expect(result.monthly).toBe(2);expect([...fleet.vehicles.values()].filter(r=>r.work)).toHaveLength(3);
 });
 it('defers the minimum when all capable-yard cars are needed for service',()=>{
  const {s,fleet,names,park,work}=fixture();fleet.plan=structuredClone(s.plan);
  const d=fleet.topo.depots.find(x=>x.work.monthly&&!x.work.overhaul)!.id,need=yardNeed(fleet.topo,fleet.plan);
  work(names[0],fleet.topo.depots.find(x=>x.work.overhaul)!.id,'overhaul');park(d,names.slice(1,need[d]+1));
  const before=fleet.depotStock.slice(),result=maintainFleet(fleet,false);
  expect(result.deferred).toBeGreaterThan(0);expect(fleet.depotStock).toEqual(before);
  expect([...fleet.vehicles.values()].filter(r=>r.work)).toHaveLength(1);
 });
 it('limits initial placement exchanges to new worlds and preserves both inspection histories',()=>{
  const {fleet,today,names,park}=fixture(),source=fleet.topo.depots.find(d=>!d.work.monthly)!.id,target=fleet.topo.depots.find(d=>d.work.monthly&&!d.work.overhaul)!.id;
  park(source,[names[0]]);park(target,[names[1]]);Object.assign(fleet.vehicles.get(names[0])!,{monthly:today-60,km:1234});
  const old=structuredClone(fleet.vehicles.get(names[0])!),donor=structuredClone(fleet.vehicles.get(names[1])!);
  initVehicles(fleet);
  expect(fleet.yards[source].tracks.flat()).toEqual([names[0]]);
  initVehicles(fleet,true);
  expect(fleet.yards[target].tracks.flat()).toEqual([names[0]]);expect(fleet.yards[source].tracks.flat()).toEqual([names[1]]);
  expect(fleet.vehicles.get(names[0])).toEqual({...old,depot:target});expect(fleet.vehicles.get(names[1])).toEqual({...donor,depot:source});
 });
 it('does not move the due car when a capable destination has no spare',()=>{
  const {s,fleet,today,names,park}=fixture();fleet.plan=structuredClone(s.plan);
  const source=fleet.topo.depots.find(d=>!d.work.monthly)!.id,target=fleet.topo.depots.find(d=>d.work.monthly&&!d.work.overhaul)!.id,need=yardNeed(fleet.topo,fleet.plan);
  park(source,[names[0]]);park(target,names.slice(1,need[target]+1));fleet.vehicles.get(names[0])!.monthly=today-60;
  const before=structuredClone({yards:fleet.yards,vehicles:fleet.vehicles});initVehicles(fleet,true);
  expect({yards:fleet.yards,vehicles:fleet.vehicles}).toEqual(before);
 });
 it('replaces completed work before its car enters a full parking yard',()=>{
  const {fleet,today,names,park,work}=fixture(),d=fleet.topo.depots.find(x=>x.work.monthly&&!x.work.overhaul)!.id;
  const overhaul=fleet.topo.depots.find(x=>x.work.overhaul)!.id;
  work(names[0],overhaul,'overhaul');work(names[1],d,'monthly',today);
  park(d,names.slice(2,fleet.topo.depots[d].capacity+2));fleet.vehicles.get(names[2])!.monthly=today-59;
  maintainFleet(fleet,false);
  expect(fleet.depotStock[d]).toBe(fleet.topo.depots[d].capacity);
  expect(fleet.vehicles.get(names[1])).toMatchObject({work:'',monthly:today,until:0});
  expect(fleet.vehicles.get(names[2])).toMatchObject({work:'monthly',monthly:today-59});
  expect(fleet.log).not.toHaveBeenCalledWith('B','车辆',expect.stringContaining('超容停放'),expect.anything());
 });
});
