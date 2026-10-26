import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { carryWorld, DAY_S } from '../src/sim/operatingDay';
import { blockTasks } from '../src/sim/timetable';
import type { Trip } from '../src/sim/model';

type LinkedTrip = Trip & { prev?: number; next?: number };
describe('cross-day overlay duty links', () => {
  it.each(['DN', 'UP'] as const)('remaps the retained %s duty before the next overlay without throwing', direction => {
    const from = new Sim({dayType:'weekend',date:'2026-10-24',dateLabel:'carry links',startTime:14400,seed:104,noPossessions:true});
    const overlay={c:'overlay' as const,id:'ciie',from:34200,to:63000,headway:900};
    expect(from.command(overlay).ok).toBe(true);
    const next = new Sim({dayType:'weekend',date:'2026-10-25',dateLabel:'next carry links',startTime:14400,seed:105,noPossessions:true});
    const baseCount=next.plan.trips.length;
    const duty=from.plan.blocks.find(b=>b.trips.length>=3 && from.plan.trips[b.trips[1]].dir===direction
      && b.trips.some(id=>((from.plan.trips[id] as LinkedTrip).next??-1)>=baseCount+b.trips.length)
      && b.trips.some(id=>from.plan.trips[id].overlay==='ciie@34200'))!;
    expect(duty).toBeDefined();
    const tr=from.trainList[0];for(const other of [...from.trainList])if(other!==tr)from.removeTrain(other);
    tr.block=duty.id;tr.tripId=duty.trips[1];tr.tasks=blockTasks(from.topo,from.plan,duty,1);
    from.blockDone.delete(duty.id);from.t=DAY_S+13500;
    const kept=duty.trips.slice(1).filter(id=>!from.plan.trips[id].cancelled || tr.tasks.some(t=>t.k==='stop'&&t.trip===id));
    expect(kept.length).toBeGreaterThan(1);
    const old=kept.map(id=>structuredClone(from.plan.trips[id] as LinkedTrip));
    const oldTasks=structuredClone(tr.tasks);
    carryWorld(next,from);
    const carried=next.trains.get(tr.id)!;
    const carriedDuty=next.plan.blocks[carried.block];
    const copied=carriedDuty.trips.map(id=>structuredClone(next.plan.trips[id] as LinkedTrip));
    const copiedById=new Map(copied.map(t=>[t.id,t]));
    const carriedTasks=structuredClone(carried.tasks);
    let result: ReturnType<Sim['command']> | undefined;
    expect(()=>{result=next.command(overlay);}).not.toThrow();
    expect(result!.ok).toBe(true);
    const idMap=new Map(kept.map((id,i)=>[id,carriedDuty.trips[i]]));
    expect(copied).toHaveLength(kept.length);
    expect(carriedTasks).toEqual(oldTasks.map(t=>t.k==='stop'?{...t,trip:idMap.get(t.trip)??-1,
      arr:t.arr===null?null:t.arr-DAY_S,dep:t.dep===null?null:t.dep-DAY_S}:t));
    for(let i=0;i<copied.length;i++){
      const t=copied[i], prior=old[i];
      expect(t.prev).toBe(prior.prev===undefined?undefined:idMap.get(prior.prev));
      expect(t.next).toBe(prior.next===undefined?undefined:idMap.get(prior.next));
      if(t.prev!==undefined)expect(copiedById.get(t.prev)!.next).toBe(t.id);
      if(t.next!==undefined)expect(copiedById.get(t.next)!.prev).toBe(t.id);
      expect(t.block).toBe(carriedDuty.id);
      expect(t.stops).toEqual(prior.stops.map(s=>({...s,arr:s.arr-DAY_S,dep:s.dep-DAY_S})));
    }
    expect(copied[0].prev).toBeUndefined();expect(copied.at(-1)!.next).toBeUndefined();
    for(const t of copied){
      const applied=next.plan.trips[t.id] as LinkedTrip;
      if(applied.cancelled)continue;
      if(applied.prev!==undefined)expect((next.plan.trips[applied.prev] as LinkedTrip).next).toBe(applied.id);
      if(applied.next!==undefined)expect((next.plan.trips[applied.next] as LinkedTrip).prev).toBe(applied.id);
    }
  });
});
