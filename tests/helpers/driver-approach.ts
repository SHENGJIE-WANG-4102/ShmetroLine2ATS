import { Sim } from '../../src/sim/engine';
import { newTrain } from '../../src/sim/ats';
import { buildStops, tripTasks, platformBerth, dwellFactorAt } from '../../src/sim/timetable';
import { computeBody, indexBodies, stopError } from '../../src/sim/movement';
import { releaseRoute } from '../../src/sim/interlocking';
import { STATIONS } from '../../src/data/current';

/** Full physical airport → Haitian approach; no head-position edits after spawning.
 * edgeMark is an explicit boundary fixture, not a real-world stopping mark. */
export function driveOverrun(metres = 2, edgeMark = false) {
  const s = new Sim({dayType:'weekday',date:'2026-10-22',dateLabel:'driver-approach',startTime:14400,seed:7,noPossessions:true,autoRadio:false});
  s.step();
  for (const t of [...s.trainList]) s.removeTrain(t);
  for (const id of [...s.routes.keys()]) releaseRoute(s,id);
  for (const b of s.plan.blocks) s.blockDone.add(b.id);
  s.t=7.75*3600-60;
  const from=STATIONS.findIndex(x=>x.id==='PDA'),to=STATIONS.findIndex(x=>x.id==='HTS'),on=STATIONS.findIndex(x=>x.id==='YDD');
  const berth=platformBerth(s.topo,to,'UP');
  if(edgeMark) {
    s.topo={...s.topo,berths:s.topo.berths.map(b=>b.id===berth?{...b,offset:3}:b)};
  }
  const b=s.topo.berths[platformBerth(s.topo,from,'UP')],id=s.plan.trips.length,blockId=s.plan.blocks.length;
  const trip={...s.plan.trips[0],id,no:'approach',from,to:on,dir:'UP' as const,block:blockId,
    stops:buildStops(s.planCtx,'UP',from,on,s.t+60,true,t=>dwellFactorAt('weekday',t)),cancelled:false,completed:false};
  s.plan.trips.push(trip);
  const block={...s.plan.blocks[0],id:blockId,svc:'approach',start:{kind:'stable' as const,station:from,berth:b.id},end:{kind:'none' as const},trips:[id]};
  s.plan.blocks.push(block);s.blockDone.add(blockId);
  const t=newTrain(s,block,b.link,b.offset,b.dir,[{link:b.link,dir:b.dir}],'0200');
  Object.assign(t,{tripId:id,tripNo:trip.no,inService:true,mode:'DTO',level:'CBTC',load:200});
  tripTasks(s.topo,trip,t.tasks,false);computeBody(s,t);indexBodies(s);
  let taken=false,braking=false;
  for(let n=0;n<8000;n++) {
    const err=stopError(s,t),task=t.tasks[0];
    if(task?.k==='stop'&&task.station===to&&t.phase==='run') {
      if(!taken&&err<35&&err>0) {
        if(!s.command({c:'manual',train:t.id,mode:'CM'}).ok)throw Error('CM takeover refused');
        taken=true;
      }
      if(taken) {
        if(err<-(metres-.9))braking=true;
        s.drive(t.id,braking?-7:t.v>1.2?-7:t.v<.8?1:0);
        if(t.v<.01&&t.retreat)return {s,t,berth:s.topo.berths[berth]};
      }
    }
    s.step();
  }
  throw Error(`No physical overrun: ${JSON.stringify({err:stopError(s,t),v:t.v,eb:t.eb,task:t.tasks[0]})}`);
}

export function reverseToMark(s:Sim,t:Sim['trainList'][number]) {
  s.command({c:'reverser',train:t.id,position:-1});
  for(let n=0;n<1200&&t.phase==='run';n++) {
    const err=stopError(s,t);
    s.drive(t.id,err> -1.5?-7:t.v>.8?-2:1);
    s.step();
  }
  return stopError(s,t);
}
