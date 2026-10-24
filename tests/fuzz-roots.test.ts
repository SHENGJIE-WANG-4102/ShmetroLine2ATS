import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { capture, restore, type Checkpoint } from '../src/sim/state';
import { berthBusy, berthHolder, cancelArsRoute, routeFaultCode, runARS, routeBlocker, updateTrainTasks } from '../src/sim/ats';
import { cancelRoute, committedTrain, computeOccupancy, releaseRoute, trySetRoute, updateInterlocking } from '../src/sim/interlocking';
import { computeBody, indexBodies, scanAhead, stopError, updateTrainMotion } from '../src/sim/movement';
import { canAcceptRestriction, signalStopDistance } from '../src/sim/protection';
import { checkSafety, checkLiveness } from '../src/sim/invariants';
import { updateHalts } from '../src/sim/halt';
import { faultProcedure } from '../src/sim/faults';
import { generatePlan, overnightPlaces, platformBerth, turnbackAt, validatePlan } from '../src/sim/timetable';
import { nextOperatingConfig } from '../src/sim/operatingDay';
import { PERF } from '../src/sim/dynamics';
import { WEATHER_RULES } from '../src/data/current';
import { validateCommand } from '../src/sim/commands';
import type { Command } from '../src/sim/model';
import { openCall } from '../src/sim/radio';
import { allowed, TURNBACK } from '../src/sim/fsm';

let checkpoint: Checkpoint | undefined;
function fixture() {
  const sim = new Sim({dayType:'weekday', date:'2026-10-19', dateLabel:'roots', startTime:14400, seed:7, noPossessions:true});
  if (checkpoint) restore(sim, checkpoint);
  else { for (let i=0;i<20;i++) sim.step(); checkpoint=capture(sim); }
  const [front, rear] = sim.trainList;
  for (const tr of [...sim.trainList]) if (tr !== front && tr !== rear) sim.removeTrain(tr);
  for (const rid of [...sim.routes.keys()]) releaseRoute(sim,rid);
  for (const b of sim.plan.blocks) sim.blockDone.add(b.id);
  sim.integrity.violations=[]; sim.integrity.fsm.clear();
  const signal=sim.topo.signals.find(s=>s.station===sim.topo.depots[0].station && s.role==='start' && s.dir===-1 && sim.topo.links[s.link].track==='UP')!;
  const link=sim.topo.links.find(l=>l.a===signal.node && l.track==='UP')!;
  for (const [tr,off] of [[front,6.1],[rear,Math.min(212.1,link.len-.1)]] as const) {
    Object.assign(tr,{link:link.id,off,dir:-1,hist:[{link:link.id,dir:-1}],v:0,a:0,eb:false,phase:'run',block:-1,tripId:-1,
      nextSignal:signal.id,nextSignalDist:off,stopDist:Infinity,maSigs:[],lastDs:0,lastMa:Infinity});
    computeBody(sim,tr);
  }
  front.tasks=[{k:'stop',berth:platformBerth(sim.topo,3,'UP'),station:3,trip:-1,arr:sim.t+100,dep:null,doors:false,revenue:false}];
  rear.tasks=[{k:'depot',depot:0}]; indexBodies(sim);computeOccupancy(sim);
  return {sim,front,rear,signal,link};
}

describe('issued authority and shared restriction boundary',()=>{
  it('keeps the applicant route and authority at 0.3 m/s when a nearer train requests another route',()=>{
    const {sim,front,rear,signal}=fixture();
    const route=sim.routeTable.next.get(sim.topo.depots[0].berth)![signal.id];
    expect(trySetRoute(sim,route,{train:rear.id}).ok).toBe(true);
    rear.off=6.02;rear.nextSignalDist=6.02;front.nextSignalDist=6.01;
    rear.v=.3; rear.maSigs=[signal.id]; rear.maDist=500; rear.lastMa=500;
    const before={ma:rear.maDist,last:rear.lastMa,sigs:[...rear.maSigs]};
    runARS(sim);
    expect(sim.sig[signal.id].route).toBe(route);
    expect(sim.routes.get(route)?.cancelAt).toBe(0);
    expect({ma:rear.maDist,last:rear.lastMa,sigs:rear.maSigs}).toEqual(before);
    expect(rear.arsWait == null).toBe(true); // relinquishing is not waiting for the front train's route
    expect(front.arsWait).toBeDefined();
    expect(sim.integrity.violations).toEqual([]);
  });
  it('refuses unassigned automatic routes too, and independently audits an accepted cancellation of own issued MA',()=>{
    const {sim,rear,signal}=fixture();const route=signal.routes[0];
    expect(trySetRoute(sim,route,{fleeting:true}).ok).toBe(true);
    rear.off=6.02;rear.maSigs=[signal.id]; rear.v=.3;
    const refused=cancelArsRoute(sim,rear,signal.id);
    expect(refused.ok).toBe(false);expect(refused.msg).toContain('允许速度曲线');
    expect(rear.arsWait == null).toBe(true);
    expect(cancelRoute(sim,signal.id,{source:'ars',train:rear.id}).ok).toBe(true);
    expect(sim.integrity.violations).toContainEqual(expect.objectContaining({kind:'ARS_AUTHORITY_CANCEL',trains:[rear.id]}));
  });
  it('releases a distant issued route within the replacement supervision curve',()=>{
    const {sim,rear,signal}=fixture();const route=signal.routes[0];
    expect(trySetRoute(sim,route,{fleeting:true}).ok).toBe(true);
    rear.maSigs=[signal.id];rear.maDist=500;rear.v=.3;
    expect(cancelArsRoute(sim,rear,signal.id).ok).toBe(true);
    expect(sim.routes.has(route)).toBe(false);
    expect(rear.maDist).toBeLessThan(500);
    expect(sim.integrity.violations).toEqual([]);
  });
  it('refuses ARS cancellation between the service and permitted-speed curves without causing EB',()=>{
    const {sim,front,rear,signal}=fixture();sim.removeTrain(front);
    const route=signal.routes[0];expect(trySetRoute(sim,route,{fleeting:true}).ok).toBe(true);
    rear.off=6.1;rear.v=.42;rear.maSigs=[signal.id];rear.maDist=500;rear.lastMa=500;
    expect(rear.v**2/(2*PERF.bService)).toBeLessThan(.1);
    expect(canAcceptRestriction(rear.v,.1,'supervision')).toBe(false);
    expect(canAcceptRestriction(rear.v,.1,'emergency')).toBe(true);
    const refused=cancelArsRoute(sim,rear,signal.id);
    expect(refused.ok).toBe(false);expect(refused.msg).toContain('允许速度曲线');
    expect(sim.sig[signal.id].route).toBe(route);expect(rear.maDist).toBe(500);
    computeBody(sim,rear);indexBodies(sim);computeOccupancy(sim);
    updateTrainMotion(sim,rear,.1);expect(rear.eb).toBe(false);
    expect(sim.integrity.violations).toEqual([]);
  });
  it('protects the 0.16 m gap between the old service-brake and guaranteed-EB criteria',()=>{
    const {sim,front,rear,signal,link}=fixture();sim.removeTrain(front);
    const distance=Math.min(156.8067,link.len-1), target=signalStopDistance(distance);
    rear.off=distance;rear.nextSignalDist=distance;
    rear.v=Math.sqrt(2*PERF.bEbGuaranteed*(target+.16));
    rear.maSigs=[signal.id];rear.maDist=1200;
    computeBody(sim,rear);indexBodies(sim);computeOccupancy(sim);
    const route=signal.routes[0];expect(trySetRoute(sim,route,{fleeting:true}).ok).toBe(true);
    const ar=sim.routes.get(route)!;ar.fleeting=false;ar.defleeted=true;
    expect(rear.v*rear.v/(2*PERF.bService)+2).toBeLessThan(distance);
    expect(canAcceptRestriction(rear.v,target)).toBe(false);
    expect(committedTrain(sim,signal.id)).toBe(rear.id);
    updateInterlocking(sim);expect(sim.routes.has(route)).toBe(true);
    // The stopped train can accept the exact same restrictive target.
    rear.v=0;expect(canAcceptRestriction(rear.v,target)).toBe(true);
    updateInterlocking(sim);expect(sim.routes.has(route)).toBe(false);
  });
});

describe('weather command contract',()=>{
  it('routes every command discriminator through validation and the logged dispatcher entry',()=>{
    const {sim,front,rear,signal}=fixture(),train=front.id;
    sim.command({c:'fault',kind:'trainDto',target:train,duration:300});
    const call=openCall(sim,{train,kind:'contract',from:'司机',text:'契约检查',options:[{key:'wait',label:'等待'}],auto:'wait',timeout:60});
    const fault=sim.faults.at(-1)!.id;
    // Mapped by discriminator: adding a UI/worker command requires a sample.
    const commands: {[K in Command['c']]: Extract<Command,{c:K}>}={
      utoStep:{c:'utoStep',train,action:'report'},utoReset:{c:'utoReset',train},dmiAck:{c:'dmiAck',train,message:'测试告警',at:sim.t},
      reverser:{c:'reverser',train,position:0},atoButton:{c:'atoButton',train,button:'f',down:false},
      setRoute:{c:'setRoute',route:signal.routes[0]},cancelRoute:{c:'cancelRoute',signal:signal.id},guideRoute:{c:'guideRoute',route:signal.routes[0]},
      autoPass:{c:'autoPass',signal:signal.id,on:true},ars:{c:'ars',signal:signal.id,on:true},switchMove:{c:'switchMove',sw:0,pos:'N'},
      switchLock:{c:'switchLock',sw:0,on:false},switchFieldLock:{c:'switchFieldLock',sw:0,on:false},axleReset:{c:'axleReset',section:0},
      sectionUnlock:{c:'sectionUnlock',section:0},setTsr:{c:'setTsr',sections:[0],kmh:40},cancelTsr:{c:'cancelTsr',sections:[0]},
      platformHold:{c:'platformHold',platform:0,on:false},platformSkip:{c:'platformSkip',platform:0,on:false},platformEsp:{c:'platformEsp',platform:0,on:false},
      psdBypass:{c:'psdBypass',platform:0,on:false},trainHold:{c:'trainHold',train,on:false},trainSkip:{c:'trainSkip',train,station:0,on:false},
      turnback:{c:'turnback',train,station:0},withdraw:{c:'withdraw',train},recoverService:{c:'recoverService',train},
      exchangeDuty:{c:'exchangeDuty',train,with:rear.id},standby:{c:'standby',train},authRM:{c:'authRM',train},ebRelease:{c:'ebRelease',train},
      trainLevel:{c:'trainLevel',train,level:'AUTO'},trainDto:{c:'trainDto',train,on:true},door:{c:'door',train,side:'L'},lineAto:{c:'lineAto',on:false},
      rescue:{c:'rescue',failed:rear.id,rescuer:train},addTrain:{c:'addTrain',depot:0,dir:'DN',to:30,time:sim.t+3600},
      overlay:{c:'overlay',id:'ciie',from:sim.t+3600,to:sim.t+7200,headway:600},zoneLevel:{c:'zoneLevel',zones:[0],level:'CBTC'},ack:{c:'ack',ids:[]},
      fault:{c:'fault',kind:'trainDto',target:train,duration:300},repair:{c:'repair',fault},trainMaintenance:{c:'trainMaintenance',fault},
      sectionBlock:{c:'sectionBlock',sections:[0],on:false},switchBlock:{c:'switchBlock',sw:0,on:false},manual:{c:'manual',train,mode:'AUTO'},
      radio:{c:'radio',call:call!.id,option:'wait'},radioAuto:{c:'radioAuto',on:true},env:{c:'env',wind:4,rain:true,duration:300},
      lowAdhesion:{c:'lowAdhesion',on:true},runLevel:{c:'runLevel',level:1},randomFaults:{c:'randomFaults',level:0},scenarioEnd:{c:'scenarioEnd'},bookmark:{c:'bookmark',label:'契约'},
    };
    const start=capture(sim);
    for (const command of Object.values(commands)) {
      restore(sim,start);
      expect(validateCommand(sim,command),command.c).toBeNull();
      // Context-dependent operational refusals remain valid; registration and
      // validation must still accept the command and reach its handler.
      const before=sim.inputLog.length,result=sim.command(command);
      expect(result.msg,command.c).not.toContain('无效调度命令');
      expect(sim.inputLog.length).toBe(before+1);
    }
  });
  it('accepts every UI wind level, simultaneous rain and low adhesion through the logged command entry',()=>{
    const {sim}=fixture();
    for (const wind of [0,...WEATHER_RULES.wind.map(rule=>rule.level)]) {
      expect(sim.command({c:'env',wind,rain:true,duration:300}).ok).toBe(true);
      expect(sim.env).toMatchObject({wind,rain:true,windUntil:wind?sim.t+300:0,rainUntil:sim.t+300});
    }
    expect(sim.sec.some((sec,i)=>sim.exposure[i]===1 && sec.envTsr===-1)).toBe(true);
    for (const on of [true,false]) {
      expect(sim.command({c:'lowAdhesion',on}).ok).toBe(true);expect(sim.env.lowAdh).toBe(on);
    }
    expect(sim.inputLog.slice(-7).map(input=>'cmd' in input?input.cmd.c:'')).toEqual(['env','env','env','env','env','lowAdhesion','lowAdhesion']);
    expect(sim.command({c:'env',wind:4.5,duration:1}).ok).toBe(false);
  });
});

describe('honest dwell and route diagnostics',()=>{
  it('reports weather protection through the route rejection and halt chain',()=>{
    const {sim,front,signal}=fixture(),route=signal.routes[0];
    const section=sim.topo.routes[route].sections[0];sim.sec[section].envTsr=-1;
    expect(routeFaultCode(sim,route)).toBe('WEATHER');
    front.v=0;front.phase='run';front.maCode='ROUTE_WAIT';front.maDist=0;
    front.arsWait={code:routeFaultCode(sim,route)!,train:-1,signal:signal.id,t:sim.t,detail:'大风停运'};
    updateHalts(sim);expect(front.halt.code).toBe('WEATHER');
    sim.t+=301;front.arsWait.t=sim.t;updateHalts(sim);checkLiveness(sim);
    expect(sim.integrity.violations.filter(v=>v.kind==='LIVENESS')).toEqual([]);
    sim.sec[section].envTsr=0;expect(routeFaultCode(sim,route)).toBeNull();
  });
  it('gets the busy flag and blocking train from the same complete transfer-path query',()=>{
    const {sim,front,rear}=fixture();sim.linkBodies.clear();sim.berthRes.clear();
    const entry=sim.topo.depots.flatMap(d=>d.transferPaths.map(path=>({d,path}))).find(({path})=>
      sim.topo.berths.some(b=>b.kind==='siding'&&b.link===path.stub)&&path.links.some(l=>l!==path.stub))!;
    const b=sim.topo.berths.find(b=>b.kind==='siding'&&b.link===entry.path.stub)!;
    const link=entry.path.links.find(l=>l!==b.link)!;
    sim.linkBodies.set(link,[{train:rear.id,from:0,to:1}]);
    expect(berthHolder(sim,b.id,front.id)).toBe(rear.id);expect(berthBusy(sim,b.id,front.id)).toBe(true);
    sim.linkBodies.clear();expect(berthHolder(sim,b.id,front.id)).toBe(-1);expect(berthBusy(sim,b.id,front.id)).toBe(false);
    sim.berthRes.set(b.id,rear.id);expect(berthHolder(sim,b.id,front.id)).toBe(rear.id);
    expect(berthBusy(sim,b.id,front.id,true)).toBe(false);
  });
  it('turns expired dwell into a real berth wait and detects its two-train cycle after 60 seconds',()=>{
    const {sim,front,rear}=fixture();
    const berth=sim.topo.berths[platformBerth(sim.topo,4,'UP')];
    front.tasks=[{k:'stop',berth:berth.id,station:4,trip:-1,arr:null,dep:null,doors:false,revenue:false},
      {k:'reverse',berths:[berth.id],chosen:berth.id,station:4,minTime:40}];
    Object.assign(front,{phase:'dwell',dwellUntil:sim.t+1,doorsOpen:false,doorsAwait:false,doorSide:'',intervalWait:undefined});
    sim.berthRes.set(berth.id,rear.id);
    updateHalts(sim);expect(front.halt.code).toBe('DWELL');
    sim.t+=2; updateTrainTasks(sim,front);updateHalts(sim);
    expect(front.halt).toMatchObject({code:'BERTH_WAIT',train:rear.id,unplannedSince:sim.t});
    rear.halt={...front.halt,train:front.id};checkLiveness(sim);
    sim.t+=61;checkLiveness(sim);
    expect(sim.integrity.violations.some(v=>v.kind==='DEADLOCK')).toBe(true);
  });
  it('identifies the actual occupant before a third train approaching an unassigned route',()=>{
    const {sim,front,rear,signal}=fixture();const route=signal.routes[0];
    expect(trySetRoute(sim,route,{fleeting:true}).ok).toBe(true);
    const r=sim.topo.routes[route],section=r.sections[0],link=sim.topo.sections[section].links[0];
    sim.linkBodies.set(link,[{train:front.id,from:0,to:1}]);
    sim.sec[section].trainOcc=true;
    const conflict=sim.topo.routes.find(x=>x.id!==route && x.sections.includes(section))!;
    rear.nextSignal=signal.id;rear.nextSignalDist=1;
    expect(routeBlocker(sim,conflict.id,-1).train).toBe(front.id);
  });
});

describe('pending stopping target after a moving overrun',()=>{
  it.each(['DN','UP'] as const)('keeps the target beyond 3 m under %s and enters the existing overrun procedure instead of arriving',dir=>{
    const {sim,front,rear}=fixture();sim.removeTrain(rear);
    const b=sim.topo.berths[platformBerth(sim.topo,12,dir)];
    front.tasks=[{k:'stop',berth:b.id,station:b.station,trip:-1,arr:sim.t,dep:sim.t+30,doors:true,revenue:true}];
    Object.assign(front,{link:b.link,dir:b.dir,off:b.offset+b.dir*3.2,hist:[{link:b.link,dir:b.dir}],phase:'run',v:1,stopDist:0,overrun:0});
    computeBody(sim,front);indexBodies(sim);computeOccupancy(sim);
    expect(stopError(sim,front)).toBeCloseTo(-3.2);expect(scanAhead(sim,front,b.id).stopDist).toBe(0);
    front.v=0;front.stopDist=0;updateTrainTasks(sim,front);
    expect(front.overrun).toBeCloseTo(3.2);expect(front.phase).toBe('run');expect(front.tasks[0].k).toBe('stop');
    expect(sim.calls.some(c=>c.kind==='overrun')).toBe(true);expect(front.doorsOpen).toBe(false);
  });
});

describe('event-observed state machines',()=>{
  it('permits rescue reorientation only for a stopped failed train on the validated rescue path',()=>{
    const {sim,front}=fixture();
    expect(allowed(sim,TURNBACK,'manual','arrive',front).ok).toBe(false);
    front.failed=true;expect(allowed(sim,TURNBACK,'manual','arrive',front).ok).toBe(false);
    front.rescueReverse=true;front.v=.3;expect(allowed(sim,TURNBACK,'manual','arrive',front).ok).toBe(false);
    front.v=0;expect(allowed(sim,TURNBACK,'manual','arrive',front).ok).toBe(true);
  });
  it.each(['CBTC','TBTC'] as const)('records the complete atomic platform turn under %s',level=>{
    const {sim,front,rear}=fixture();sim.removeTrain(rear);
    const turn=sim.topo.stations.flatMap(st=>['DN','UP'].flatMap(dir=>{
      const t=turnbackAt(sim.topo,st.index,dir as 'DN'|'UP');
      return t?.kind==='front' && sim.topo.berths[t.arrBerth].platform===sim.topo.berths[t.depBerth].platform?[{station:st.index,dir:dir as 'DN'|'UP',turn:t}]:[];
    }))[0];
    expect(turn).toBeDefined();const b=sim.topo.berths[turn.turn.arrBerth];
    front.tasks=[{k:'stop',berth:b.id,station:turn.station,trip:-1,arr:sim.t,dep:null,doors:false,revenue:false},
      {k:'reverse',berths:[b.id],chosen:b.id,station:turn.station,minTime:40},
      {k:'stop',berth:b.id,station:turn.station,trip:-1,arr:null,dep:sim.t+180,doors:false,revenue:false}];
    Object.assign(front,{phase:'dwell',link:b.link,off:b.offset,dir:b.dir,hist:[{link:b.link,dir:b.dir}],level,mode:level==='TBTC'?'AM':'DTO',
      tbStage:'none',dwellUntil:sim.t+4,doorsOpen:true,doorsAwait:false,doorSide:'',lastMa:0,maDist:0,v:0});
    computeBody(sim,front);indexBodies(sim);computeOccupancy(sim);checkSafety(sim);
    updateTrainTasks(sim,front);checkSafety(sim);
    expect(sim.integrity.fsm.get(`turnback:${front.id}`)).toBe(level==='TBTC'?'manual':'none'); // depart -> none on entering the new stop
    expect(sim.integrity.violations.filter(v=>v.kind==='FSM')).toEqual([]);
    expect(front.dir).toBe(-b.dir);
    expect(front.dwellUntil).toBeGreaterThan(sim.t+39);
  });
  it('records fault creation and immediate rescue procedure, while rejecting an unrelated initial manual turn',()=>{
    const {sim,front}=fixture();
    expect(sim.command({c:'fault',kind:'trainFail',target:front.id,duration:600,recoverable:false}).ok).toBe(true);
    faultProcedure(sim,{c:'rescue',failed:front.id,rescuer:sim.trainList[1].id});
    checkSafety(sim);
    expect(sim.faults.at(-1)?.stage).toBe('procedure');
    expect(sim.integrity.violations.filter(v=>v.kind==='FSM')).toEqual([]);
    front.tbStage='manual'; checkSafety(sim);
    expect(sim.integrity.violations.some(v=>v.kind==='FSM')).toBe(true);
  });
});

describe('real sources on inventory redirection',()=>{
  it.each([[27,21,22],[18,16,34]])('constructs the imbalanced next day with stock %j without losing intermediate overnight starts or throwing',(...stock)=>{
    const sim=new Sim({dayType:'weekday',date:'2026-10-19',dateLabel:'stock',startTime:14400,seed:111,noPossessions:true});
    const plan=generatePlan({...sim.planCtx,initialStock:stock});
    expect(plan.trips.some(t=>t.revenue && t.block<0)).toBe(false);
    for (const place of overnightPlaces(sim.topo))
      expect(plan.blocks.some(b=>b.start.kind==='stable' && b.start.berth===place.berth)).toBe(true);
    expect(validatePlan({...sim.planCtx,initialStock:stock},plan).every(i=>Number.isFinite(i.t))).toBe(true);
    expect(()=>new Sim({...nextOperatingConfig(sim),depotStock:stock})).not.toThrow();
  });
});
