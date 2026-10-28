import {describe,expect,it} from 'vitest';
import {Sim} from '../src/sim/engine';
import {cmdTurnback,newTrain,turnbackOptions,signalAheadFrom} from '../src/sim/ats';
import {computeBody,indexBodies} from '../src/sim/movement';
import {blockTasks,depotTasks,platformBerth,turnbackAt} from '../src/sim/timetable';
import {ahead,reversedBerthPoint} from '../src/sim/topology';
import {walkRouteToBerth} from '../src/sim/routePath';
import type {Task} from '../src/sim/model';

function turnbackFixture(continues:boolean,needsDepot=false,returnBehind=false) {
  const sim=new Sim({dayType:'weekend',dateLabel:'turnback-block-end',startTime:14400,seed:7,noPossessions:true});
  for(const tr of [...sim.trainList])sim.removeTrain(tr);
  for(const block of sim.plan.blocks) {
    const trips=block.trips.map(id=>sim.plan.trips[id]).filter(t=>!t.cancelled);
    for(let i=0;i+1+(continues?1:0)<trips.length;i++) {
      const cur=trips[i],next=trips[i+1],later=trips[i+2];
      if(cur.dir===next.dir)continue;
      if(returnBehind && (next.to!==30 || next.dir!=='DN' || !turnbackAt(sim.topo,next.to,next.dir)))continue;
      const berth=sim.topo.berths[platformBerth(sim.topo,cur.from,cur.dir)];
      const tr=newTrain(sim,null,berth.link,berth.offset,berth.dir,[{link:berth.link,dir:berth.dir}],'turnback-end');
      Object.assign(tr,{block:block.id,tripId:cur.id,phase:'run',inService:true,v:0,a:0,tasks:[]});
      computeBody(sim,tr);indexBodies(sim);
      const station=turnbackOptions(sim,tr).find(st=>ahead(next.dir,st,next.to)&&!!turnbackAt(sim.topo,st,cur.dir)
        &&(!needsDepot||sim.topo.depots.some(d=>ahead(cur.dir,cur.from,d.station)&&ahead(cur.dir,d.station,st))));
      if(station===undefined){sim.removeTrain(tr);continue;}
      block.trips=continues?[cur.id,next.id,later.id]:[cur.id,next.id];
      // The command reads the train's own remaining calls (D14x progress).
      tr.tasks=blockTasks(sim.topo,sim.plan,block,0);
      return {sim,tr,block,cur,next,later,station};
    }
  }
  throw Error('No turnback continuation fixture');
}

describe('block ending after an adjusted turnback service',()=>{
  it.each(['stable','depot'] as const)('finishes the last adjusted service with the block %s end',kind=>{
    const {sim,tr,block,next,station}=turnbackFixture(false);
    const berth=platformBerth(sim.topo,next.to,next.dir),depot=sim.topo.depots[0].id;
    block.end=kind==='stable'?{kind:'stable',station:next.to,berth}:{kind:'depot',depot};
    const result=cmdTurnback(sim,tr,station);expect(result.ok,result.msg).toBe(true);
    const adjustedStop=tr.tasks.find(t=>t.k==='stop'&&t.trip>=0&&sim.plan.trips[t.trip]?.kind==='adj');
    if(adjustedStop?.k!=='stop')throw Error('Missing adjusted service');
    const adjusted=sim.plan.trips[adjustedStop.trip];
    expect(adjusted.to).toBe(next.to);
    if(kind==='stable')expect(tr.tasks.filter(t=>t.k==='stable')).toEqual([{k:'stable',berth,reason:'存车',station:next.to}]);
    else expect(tr.tasks.filter(t=>t.k==='depot')).toMatchObject([{k:'depot',depot}]);
  });
  it('continues the remaining service and appends its end only once',()=>{
    const {sim,tr,block,next,later,station}=turnbackFixture(true);
    const berth=platformBerth(sim.topo,later.to,later.dir);
    block.end={kind:'stable',station:later.to,berth};
    const result=cmdTurnback(sim,tr,station);expect(result.ok,result.msg).toBe(true);
    expect(next.cancelled).toBe(true);
    expect(tr.tasks.some(t=>t.k==='stop'&&t.trip===later.id)).toBe(true);
    expect(tr.tasks.filter(t=>t.k==='stable')).toEqual([{k:'stable',berth,reason:'存车',station:later.to}]);
  });
  it('drops a superseded depot-work stop before the selected turnback',()=>{
    const {sim,tr,cur,station}=turnbackFixture(false,true);
    const depot=sim.topo.depots.find(d=>ahead(cur.dir,cur.from,d.station)&&ahead(cur.dir,d.station,station))!;
    const old:Task[]=[];depotTasks(sim.topo,depot.id,cur.dir,old);
    const work=old.find(t=>t.k==='stop'&&t.depotWork)!;tr.tasks=[work,...tr.tasks];
    const result=cmdTurnback(sim,tr,station);expect(result.ok,result.msg).toBe(true);
    expect(tr.tasks[0]).toMatchObject({k:'stop',station,note:'人工折返'});
  });
  it('turns the adjusted terminal arrival back before positioning to a depot behind it',()=>{
    const {sim,tr,block,next,station}=turnbackFixture(false,false,true);
    const depot=sim.topo.depots.find(d=>d.station===28)!;
    block.end={kind:'depot',depot:depot.id};
    expect(cmdTurnback(sim,tr,station).ok).toBe(true);
    const reverseIndex=[...tr.tasks].reverse().findIndex(t=>t.k==='stop'&&t.station===next.to&&t.trip>=0);
    expect(reverseIndex).toBeGreaterThanOrEqual(0);
    const lastArrival=tr.tasks.length-1-reverseIndex;
    const turn=tr.tasks.slice(lastArrival+1).find(t=>t.k==='reverse');
    expect(turn?.k).toBe('reverse');
    if(turn?.k!=='reverse')return;
    expect(turn.station).toBe(next.to);
    const point=reversedBerthPoint(sim.topo,turn.chosen,tr.len);
    expect(point).toBeDefined();
    if(!point)return;
    const after=tr.tasks.slice(lastArrival+1);
    expect(after.map(t=>t.k)).toEqual(['reverse','stop','stop','reverse','stop','depot']);
    const departure=after[1],junction=after[2],junctionTurn=after[3],work=after[4];
    if(departure.k!=='stop'||junction.k!=='stop'||junctionTurn.k!=='reverse'||work.k!=='stop')throw Error('Incomplete positioning');
    const canReach=(from: typeof point, goal:number)=>{
      const signal=signalAheadFrom(sim,from.link,from.off,from.dir,1000);
      expect(signal).toBeDefined();
      if(signal)expect(Number.isFinite(walkRouteToBerth(sim.topo,sim.routeTable,{signal:signal.sig},goal))).toBe(true);
    };
    canReach(point,departure.berth);
    const d=sim.topo.berths[departure.berth];
    canReach({link:d.link,off:d.offset,dir:d.dir},junction.berth);
    const afterJunction=reversedBerthPoint(sim.topo,junctionTurn.chosen,tr.len);
    expect(afterJunction).toBeDefined();
    if(afterJunction)canReach(afterJunction,work.berth);
  });
  it('positions an adjusted terminal arrival to its assigned overnight berth',()=>{
    const {sim,tr,block,next,station}=turnbackFixture(false,false,true);
    const berth=platformBerth(sim.topo,28,'UP');
    block.end={kind:'stable',station:28,berth};
    expect(cmdTurnback(sim,tr,station).ok).toBe(true);
    const turn=tr.tasks.find(t=>t.k==='reverse'&&t.station===next.to);
    expect(turn?.k).toBe('reverse');
    expect(tr.tasks.at(-1)).toMatchObject({k:'stable',station:28,berth});
    const position=tr.tasks.at(-2);
    expect(position).toMatchObject({k:'stop',station:28,berth});
    if(turn?.k!=='reverse'||position?.k!=='stop')return;
    const point=reversedBerthPoint(sim.topo,turn.chosen,tr.len);
    expect(point).toBeDefined();
    if(!point)return;
    const signal=signalAheadFrom(sim,point.link,point.off,point.dir,1000);
    expect(signal).toBeDefined();
    if(signal)expect(Number.isFinite(walkRouteToBerth(sim.topo,sim.routeTable,{signal:signal.sig},position.berth))).toBe(true);
  });
});
