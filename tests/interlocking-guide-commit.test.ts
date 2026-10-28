import { assert, describe, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import type { Train } from '../src/sim/model';
import * as ci from '../src/sim/interlocking';
import * as motion from '../src/sim/movement';
import * as checks from '../src/sim/invariants';
import * as protection from '../src/sim/protection';
import * as resources from '../src/sim/resourceArbitration';
import * as diagnostics from '../src/sim/diagnostics';
const signatures = new Set<string>();
const fields=(tr: Train)=>Object.fromEntries(['id','vehicle','link','off','dir','v','maDist','maFar','maSigs','lastMa','lastDs','maCut','vPermit','vEbi','eb','nextSignal','nextSignalDist'].map(k=>[k,structuredClone((tr as unknown as Record<string, unknown>)[k])]));
function fixture(speed:number){
 const sim=new Sim({dayType:'weekday',date:'2026-10-19',dateLabel:'ordinary-guide-command',startTime:14400,seed:105,noPossessions:true});
 const tr=sim.trainList[0]!;
 const signature=diagnostics.topologySignature(sim.topo);assert.equal(signature,'f279e2b3');signatures.add(signature);
 for(const other of [...sim.trainList])if(other!==tr)sim.removeTrain(other);
 for(const rid of [...sim.routes.keys()])ci.releaseRoute(sim,rid);
 for(const block of sim.plan.blocks)sim.blockDone.add(block.id);
 assert.deepEqual(sim.integrity.violations,[],'fixture does not clear historical violations');
 const route=sim.topo.routes[76],goal=route.berths.find((id:number)=>sim.topo.berths[id].dir===1&&!sim.topo.berths[id].reverse);
 assert.equal(route.name,'X1201→X1205');assert.equal(route.switches.length,0);assert.equal(goal,44);
 sim.t=27933.8;
 Object.assign(tr,{link:76,off:397.2272502264795,dir:1,hist:[{link:76,dir:1}],v:speed,a:0,phase:'run',
  block:-1,tripId:-1,inService:false,mode:'DTO',level:'CBTC',forceLevel:'AUTO',manual:false,failed:false,comm:true,
  eb:false,ebCause:'',maCut:false,pendingMode:null,pendingLevel:null,stopUntil:0,doorsOpen:false,doorsAwait:false,
  doorSide:'',reverser:1,retreat:null,tbStage:'none',maSigs:[],lastMa:Infinity,lastDs:0,
  nextSignal:route.start,nextSignalDist:sim.topo.links[76].len-397.2272502264795,stopDist:Infinity});
 tr.tasks=[{k:'stop',berth:goal!,station:sim.topo.berths[goal!].station,trip:-1,arr:null,dep:null,doors:false,revenue:false}];
 motion.computeBody(sim,tr);motion.indexBodies(sim);ci.computeOccupancy(sim);
 assert.equal(ci.trySetRoute(sim,76,{fleeting:true}).ok,true);ci.updateInterlocking(sim);
 assert.equal(sim.routes.get(76)!.state,'locked');
 const scan=motion.scanAhead(sim,tr,goal!);
 Object.assign(tr,{maDist:scan.maDist,maFar:scan.maDist,maReason:scan.maReason,maCode:scan.maCode,maTrain:scan.maTrain,
  maFarReason:scan.maReason,maFarCode:scan.maCode,maFarTrain:scan.maTrain,maSigs:scan.maSignals,stopDist:scan.stopDist});
 sim.step();checks.checkSafety(sim);
 assert.deepEqual(sim.integrity.violations,[],'pre-command authority valid');
 assert.equal(resources.arbitrateResources(sim).claims.size,0);
 assert.equal(sim.resourceTransit.size,0);
 return {sim,tr,route,goal};
}
describe('normal route guide conversion commitment', () => {
it('refuses conversion while the issued route cannot be safely withdrawn', () => {
 const {sim,tr,route}=fixture(14.4);
 const before={t:sim.t,train:fields(tr),route:structuredClone(sim.routes.get(76))};
 assert.equal(protection.canStopBeforeSignal(sim,tr,route.start,'emergency'),false);
 assert.equal(ci.committedTrain(sim,route.start),tr.id);
 const command={c:'guideRoute',route:76}as const,result=sim.command(command);
 assert.equal(result.ok,false);
 assert(result.msg.includes(`${tr.svc}-${tr.tripNo}`));assert(result.msg.includes(tr.vehicle));
 assert.deepEqual(sim.routes.get(76),before.route,'refusal precedes bind/fleeting/guide mutations');
 assert.deepEqual(fields(tr),before.train,'refusal keeps current MA/EB/lastMa/lastDs');
 const input=sim.inputLog.at(-1);
 if(!input||!('cmd' in input))throw new Error('Rejected operation missing from inputLog');
 assert.deepEqual(input.cmd,command,'rejected operation remains replayable');
 sim.step();checks.checkSafety(sim);
 assert.deepEqual(sim.integrity.violations,[]);assert.equal(tr.eb,false);assert.equal(tr.maCut,false);
});
it('allows conversion when the approaching train can stop', () => {
 const {sim,tr,route}=fixture(4);
 assert.equal(sim.routes.get(76)!.guide,false);
 assert.equal(protection.canStopBeforeSignal(sim,tr,route.start,'emergency'),true);
 assert.equal(ci.committedTrain(sim,route.start),-1);
 const command={c:'guideRoute',route:76}as const,result=sim.command(command);
 assert.equal(result.ok,true);assert.equal(sim.routes.get(76)!.guide,true);
 assert.equal(sim.routes.get(76)!.fleeting,false);assert.equal(sim.routes.get(76)!.manual,true);
 assert.equal(sim.routes.get(76)!.guideUntil,sim.t+ci.GUIDE_TIME);
 sim.step();checks.checkSafety(sim);
 assert.deepEqual(sim.integrity.violations,[]);assert.equal(tr.eb,false);assert.equal(tr.maCut,false);
});
it('allows conversion without trains and keeps guide idempotent', () => {
 const {sim,tr}=fixture(4);sim.removeTrain(tr);ci.computeOccupancy(sim);
 assert.equal(sim.trainList.length,0);assert.equal(ci.committedTrain(sim,sim.topo.routes[76].start),-1);
 assert.equal(sim.routes.get(76)!.guide,false);
 const command={c:'guideRoute',route:76}as const,result=sim.command(command);
 assert.equal(result.ok,true);assert.equal(sim.routes.get(76)!.guide,true);
 sim.step();checks.checkSafety(sim);assert.deepEqual(sim.integrity.violations,[]);
 const repeated=sim.command(command);assert.equal(repeated.ok,true);
});
});
