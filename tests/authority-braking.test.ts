import {describe,expect,it} from 'vitest';
import {Sim} from '../src/sim/engine';
import {newTrain} from '../src/sim/ats';
import {computeBody,indexBodies,scanAhead,updateTrainMotion} from '../src/sim/movement';
import {platformBerth} from '../src/sim/timetable';

function approach(number:string,time:number,off=22.0104,speed=3.33774) {
  const sim=new Sim({dayType:'weekday',date:'2026-10-19',dateLabel:'authority-approach',startTime:14400,seed:14201,noPossessions:true,autoDispatch:false});
  for(const tr of [...sim.trainList])sim.removeTrain(tr);
  sim.t=time;
  const trip=sim.plan.trips.find(t=>t.no===number)!;expect(trip).toBeDefined();
  const goal=platformBerth(sim.topo,trip.from,trip.dir);
  const signal=sim.topo.signals.find(s=>s.name==='S2916')!;
  const link=sim.topo.links.find(l=>sim.topo.sections[l.section].name==='G2919')!;
  const tr=newTrain(sim,null,link.id,off,-1,[{link:link.id,dir:-1}],'authority-case');
  const stop=trip.stops[0];
  Object.assign(tr,{tasks:[{k:'stop',berth:goal,station:trip.from,trip:trip.id,arr:stop.arr,dep:stop.dep,doors:true,revenue:true}],
    tripId:trip.id,block:trip.block,inService:true,mode:'DTO',manual:false,phase:'run',v:speed,a:.09,vCap:3.33774,
    nextSignal:signal.id,nextSignalDist:off,eb:false,hold:false,failed:false});
  sim.sig[signal.id].ars=false;computeBody(sim,tr);indexBodies(sim);
  const initial=scanAhead(sim,tr,goal);
  tr.maDist=tr.lastMa=initial.maDist;tr.lastDs=0;tr.maSigs=initial.maSignals;
  return {sim,tr,initial};
}

describe('automatic approach to a restrictive authority',()=>{
  it.each([
    {number:'4098',time:31737.1},
    {number:'4118',time:34411.1},
  ])('stops before the red signal for the $number observed approach without EB',({number,time})=>{
    const {sim,tr,initial}=approach(number,time);expect(initial.maDist).toBeLessThan(17);
    let lowest=initial.maDist;
    for(let i=0;i<200&&tr.v>.01;i++){
      updateTrainMotion(sim,tr,.1);sim.t+=.1;indexBodies(sim);
      lowest=Math.min(lowest,tr.maDist);
      expect(tr.eb,`time ${sim.t}, v ${tr.v}, MA ${tr.maDist}`).toBe(false);
    }
    expect(tr.v).toBeLessThanOrEqual(.01);expect(lowest).toBeGreaterThan(0);
  });
  it('still applies ATP emergency braking when moving at the authority end',()=>{
    const {sim,tr,initial}=approach('4098',31743.1,5.7,.5);
    expect(initial.maDist).toBe(0);
    updateTrainMotion(sim,tr,.1);
    expect(tr.vEbi).toBe(0);expect(tr.eb).toBe(true);
  });
});
