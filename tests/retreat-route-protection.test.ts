import {describe,it,expect} from 'vitest';
import {Sim} from '../src/sim/engine';
import {answerOverrun,runARS,updateTrainTasks} from '../src/sim/ats';
import {advance,computeBody,indexBodies,reversePermission,scanAhead,updateTrainMotion,retreatOccupancy,moveBack} from '../src/sim/movement';
import {computeOccupancy,releaseRoute,trySetRoute,updateInterlocking,bindRouteApproach} from '../src/sim/interlocking';
import {capture,restore} from '../src/sim/state';
import {arbitrateResources} from '../src/sim/resourceArbitration';

function fixture(metres=40){
 const sim=new Sim({dayType:'weekday',date:'2026-10-19',dateLabel:'retreat-route',startTime:14400,seed:107,noPossessions:true,autoRadio:false});
 const lead=sim.trainList[0];
 for(const other of [...sim.trainList])if(other!==lead)sim.removeTrain(other);
 for(const rid of [...sim.routes.keys()])releaseRoute(sim,rid);
 for(const b of sim.plan.blocks)sim.blockDone.add(b.id);
 const route=sim.topo.routes[76],berth=sim.topo.berths[44];
 expect(route.name).toBe('X1201→X1205');expect(route.steps).toEqual([{link:berth.link,dir:1}]);
 Object.assign(lead,{link:berth.link,off:berth.offset,dir:1,hist:[{link:76,dir:1},{link:77,dir:1}],
  recentBody:undefined,block:-1,tripId:-1,phase:'run',v:0,a:0,manual:true,mode:'CM',level:'CBTC',
  doorsAwait:false,doorsOpen:false,doorSide:'',doorLockedAt:0,stopUntil:0,failed:false,eb:false,
  hold:false,retreat:undefined,overrun:0,tbStage:'none',maDist:0,lastMa:0,lastDs:0});
 lead.tasks=[{k:'stop',berth:berth.id,station:berth.station,trip:-1,arr:sim.t,dep:null,doors:false,revenue:false}];
 computeBody(sim,lead);indexBodies(sim);computeOccupancy(sim);
 expect(trySetRoute(sim,sim.topo.signals[route.end].routes[0],{train:lead.id}).ok).toBe(true);
 updateInterlocking(sim);
 for(let remaining=metres;remaining>0;remaining-=5){expect(advance(sim,lead,Math.min(5,remaining))).toBe(true);computeBody(sim,lead);}
 expect(lead.eb,lead.ebReason).toBe(false);indexBodies(sim);
 updateTrainTasks(sim,lead);expect(lead.overrun).toBeCloseTo(metres);
 expect(answerOverrun(sim,lead,'back').ok).toBe(true);
 const follower=structuredClone(lead);
 Object.assign(follower,{id:999,vehicle:'0202',link:76,off:sim.topo.links[76].len-120,dir:1,
  hist:[{link:76,dir:1}],recentBody:undefined,retreat:undefined,manual:false,mode:'DTO',
  nextSignal:route.start,nextSignalDist:120,stopDist:Infinity,reverser:1});
 follower.tasks=[{k:'stop',berth:48,station:sim.topo.berths[48].station,trip:-1,arr:sim.t+400,dep:null,doors:false,revenue:false}];
 computeBody(sim,follower);sim.addTrain(follower);indexBodies(sim);computeOccupancy(sim);
 expect(reversePermission(sim,lead).ok).toBe(true);
 // Actual reverse kinematics precede the new ARS request; bodies stay indexed.
 expect(sim.command({c:'reverser',train:lead.id,position:-1}).ok).toBe(true);sim.drive(lead.id,1);
 for(let i=0;i<40;i++){sim.t+=.1;updateTrainMotion(sim,lead,.1);indexBodies(sim);computeOccupancy(sim);}
 expect(reversePermission(sim,lead).ok).toBe(true);
 expect(lead.lastDs,JSON.stringify({off:lead.off,v:lead.v,reverser:lead.reverser,notch:lead.notch,eb:lead.eb,reason:lead.ebReason,permit:reversePermission(sim,lead)})).toBeGreaterThan(0);
 return {sim,lead,follower,route};
}

describe('remaining retreat occupancy protects route admission',()=>{
 it('keeps live ARS from assigning the approaching follower a route through the remaining sweep',()=>{
  const {sim,lead,follower,route}=fixture();
  expect(sim.sig[route.start].ars).toBe(true);
  runARS(sim);updateInterlocking(sim);
  expect(sim.routes.get(route.id)?.arsTrain).not.toBe(follower.id);
  expect(sim.routes.get(route.id)?.owner).not.toBe(follower.id);
  expect(reversePermission(sim,lead).ok).toBe(true);
  const scan=scanAhead(sim,follower,48);
  expect(scan.maDist).toBeLessThanOrEqual(120+12);
 });
 it('admits the same ordinary CBTC following route after the authorised return is removed',()=>{
  const {sim,lead,follower,route}=fixture();lead.retreat=undefined;
  runARS(sim);updateInterlocking(sim);
  expect(sim.routes.get(route.id)?.arsTrain).toBe(follower.id);
 });
 it('applies the same protection to explicit route requests without changing physical bodies',()=>{
  const {sim,lead,follower,route}=fixture(),bodies=structuredClone(sim.linkBodies);
  expect(trySetRoute(sim,route.id,{train:follower.id}).ok).toBe(false);
  expect(sim.linkBodies).toEqual(bodies);expect(reversePermission(sim,lead).ok).toBe(true);
 });
 it('protects an existing unowned fleeting route from ARS rebinding and new entrance MA',()=>{
  const {sim,lead,follower,route}=fixture(),consent=lead.retreat;
  lead.retreat=undefined;follower.nextSignal=-1;
  expect(trySetRoute(sim,route.id,{fleeting:true}).ok).toBe(true);updateInterlocking(sim);
  const ar=sim.routes.get(route.id)!;expect(ar.directionTrain).toBe(-1);expect(ar.arsTrain).toBe(-1);
  lead.retreat=consent;follower.nextSignal=route.start;
  expect(reversePermission(sim,lead).ok).toBe(true);
  bindRouteApproach(sim,route.id,follower.id);runARS(sim);
  expect(ar.directionTrain).toBe(-1);expect(ar.arsTrain).toBe(-1);expect(ar.owner).toBe(-1);
  const scan=scanAhead(sim,follower,48);
  expect(scan.maDist).toBeLessThan(120);expect(scan).toMatchObject({maCode:'TRAIN_AHEAD',maTrain:lead.id});
  expect(reversePermission(sim,lead).ok).toBe(true);
  lead.retreat=undefined;bindRouteApproach(sim,route.id,follower.id);
  expect(ar.directionTrain).toBe(follower.id);
 });
 it('detects same-clock new consent, permission mutation and physical motion without a time-only empty cache',()=>{
  const {sim,lead}=fixture(),consent=lead.retreat!;
  lead.retreat=undefined;const empty=retreatOccupancy(sim);
  expect(retreatOccupancy(sim)).toBe(empty);expect(empty).toHaveLength(0);
  lead.retreat={...consent,authorised:false};expect(retreatOccupancy(sim)).toBe(empty);
  lead.retreat.authorised=true;const first=retreatOccupancy(sim)[0];expect(first.train).toBe(lead.id);
  expect(retreatOccupancy(sim)[0]).toBe(first);
  const time=sim.t;moveBack(sim,lead,.25);
  expect(sim.t).toBe(time);expect(retreatOccupancy(sim)[0]).not.toBe(first);
  lead.retreat.authorised=false;expect(retreatOccupancy(sim)).toBe(empty);
 });
 it('does not adopt an existing fleeting resource entrance for a follower inside the remaining projected return',()=>{
  // A longer explicitly authorised return leaves the platform physically
  // empty, so existing physical resource checks can admit the follower.
  const {sim,lead,follower,route}=fixture(300),consent=lead.retreat;
  expect(lead.body.some(b=>b.link===77)).toBe(false);
  lead.retreat=undefined;follower.nextSignal=-1;
  expect(trySetRoute(sim,route.id,{fleeting:true}).ok).toBe(true);updateInterlocking(sim);
  follower.nextSignal=route.start;
  follower.tasks=[{k:'stable',station:11,berth:44,reason:'存车'}];
  lead.retreat=consent;
  const allocation=arbitrateResources(sim),decision=allocation.decisions.get(follower.id);
  expect(decision?.admitted).toBe(true);expect(decision?.option.phases[0].routes).toContain(route.id);
  const ar=sim.routes.get(route.id)!;expect(ar.fleeting).toBe(true);expect(ar.arsTrain).toBe(-1);
  runARS(sim,true);
  expect(ar.fleeting).toBe(true);expect(ar.arsTrain).toBe(-1);expect(ar.owner).toBe(-1);
  expect(reversePermission(sim,lead).ok).toBe(true);
  lead.retreat=undefined;runARS(sim,true);
  expect(ar.fleeting).toBe(false);expect(ar.arsTrain).toBe(follower.id);
 });
 it('does not reuse a prior train object projection after restoring a checkpoint at the same clock',()=>{
  const {sim}=fixture(),before=retreatOccupancy(sim)[0],checkpoint=capture(sim);
  restore(sim,checkpoint);const after=retreatOccupancy(sim)[0];
  expect(after).not.toBe(before);expect(after).toEqual(before);
 });
});
