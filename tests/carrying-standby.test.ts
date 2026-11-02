import {describe,it,expect} from 'vitest';
import {Sim} from '../src/sim/engine';
import {standbyCandidate,applyStandby} from '../src/sim/timetable';

describe('carrying yard standby movements',()=>{
 it('takes passengers on a feasible daytime approach and preserves it when applied',()=>{
  const s=new Sim({dayType:'weekend',dateLabel:'carrying standby',startTime:14400,seed:1,noPossessions:true});
  let found:ReturnType<typeof standbyCandidate>=null,block=-1,tail:number[]=[];
  for(const b of s.plan.blocks){
   for(let i=0;i<b.trips.length&&!found;i++){
    const t=s.plan.trips[b.trips[i]];
    if(!t.revenue||t.stops[0].dep<11*3600||t.stops[0].dep>18*3600)continue;
    const remaining=b.trips.slice(i);
    for(let depot=0;depot<s.topo.depots.length;depot++){
      const c=standbyCandidate(s.planCtx,s.plan,remaining,depot,t.stops[0].dep-3600);
      if(c?.stops&&c.revenue){found=c;block=b.id;tail=remaining;break;}
    }
   }
   if(found)break;
  }
  expect(found).not.toBeNull();expect(found!.stops!.some((p,i)=>i<found!.stops!.length-1&&p.stop&&!p.noBoard)).toBe(true);
  const plan=structuredClone(s.plan),chosen=applyStandby(plan,block,tail,found!);
  const movement=plan.trips[chosen.trips[0]];expect(movement.kind).toBe('ins');expect(movement.revenue).toBe(true);
  expect(movement.stops).toEqual(found!.stops);
 });
});
