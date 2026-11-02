import {describe,expect,it} from 'vitest';
import {Sim} from '../src/sim/engine';
import {FIRST_LAST,STATIONS} from '../src/data/current';

const seconds=(clock:string)=>{const [h,m]=clock.split(':').map(Number);return h*3600+m*60;};

describe('directional first-service opening',()=>{
 it.each(['weekday','weekend'] as const)('%s: every empty mainline approach precedes that direction’s first service',(dayType)=>{
  const sim=new Sim({dayType,dateLabel:'directional opening',startTime:14400,seed:1,noPossessions:true});
  const violations:string[]=[];let beforeOwnAfterOpposite=0;
  for(const trip of sim.plan.trips.filter(t=>!t.cancelled)){
   for(const stop of trip.stops){
    if(trip.revenue&&stop.stop&&!stop.noBoard&&stop.st!==trip.to)break;
    if(stop.st===trip.to)continue;
    const row=FIRST_LAST.find(x=>x.station===STATIONS[stop.st].name)!;
    const own=seconds(trip.dir==='DN'?row.firstE:row.firstW);
    const opposite=seconds(trip.dir==='DN'?row.firstW:row.firstE);
    if(stop.arr>=own)violations.push(`${trip.no} ${trip.dir} ${STATIONS[stop.st].id}`);
    if(stop.arr>=opposite&&stop.arr<own)beforeOwnAfterOpposite++;
   }
  }
  expect(beforeOwnAfterOpposite).toBeGreaterThan(0);
  expect(violations).toEqual([]);
 });
});
