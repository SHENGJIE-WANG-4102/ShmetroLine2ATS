import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Sim as Simulator} from '../src/sim/engine';
import type {Checkpoint} from '../src/sim/state';
import type {Train} from '../src/sim/model';

describe('computer attendant preset sweep',()=>{
  let sim:Simulator,Sim:typeof Simulator,base:Checkpoint;
  let ats:typeof import('../src/sim/ats'),uto:typeof import('../src/sim/uto');
  let motion:typeof import('../src/sim/movement'),ci:typeof import('../src/sim/interlocking');
  let timetable:typeof import('../src/sim/timetable'),state:typeof import('../src/sim/state');
  let radio:typeof import('../src/sim/radio');
  let operatingDay:typeof import('../src/sim/operatingDay');
  beforeAll(async()=>{
    vi.stubEnv('ATS_LINE','14');vi.resetModules();
    Sim=(await import('../src/sim/engine')).Sim;
    ats=await import('../src/sim/ats');uto=await import('../src/sim/uto');
    motion=await import('../src/sim/movement');ci=await import('../src/sim/interlocking');
    timetable=await import('../src/sim/timetable');state=await import('../src/sim/state');
    radio=await import('../src/sim/radio');
    operatingDay=await import('../src/sim/operatingDay');
    sim=new Sim({dayType:'weekday',date:'2026-10-23',dateLabel:'preset',startTime:14400,
      seed:71,noPossessions:true,autoRadio:false,autoDispatch:false});
    base=state.capture(sim);
  },120000);
  beforeEach(()=>{state.restore(sim,base);sim.startState=null;});
  afterAll(()=>{vi.unstubAllEnvs();vi.resetModules();});

  function fixture(){
    for(const other of [...sim.trainList])sim.removeTrain(other);
    for(const block of sim.plan.blocks)sim.blockDone.add(block.id);
    const berth=sim.topo.berths[timetable.platformBerth(sim.topo,10,'DN')];
    const goal=timetable.platformBerth(sim.topo,11,'DN');
    const vehicle=[...sim.vehicles.keys()][0],record=sim.vehicles.get(vehicle)!;
    for(const [i,yard]of sim.yards.entries()){
      for(const track of yard.tracks){const at=track.indexOf(vehicle);if(at>=0)track.splice(at,1);}
      sim.depotStock[i]=yard.tracks.flat().length;
    }
    record.depot=-1;record.uto={stage:'ready',until:0,cycles:0};
    const tr=ats.newTrain(sim,null,berth.link,berth.offset,berth.dir,[{link:berth.link,dir:berth.dir}],vehicle);
    Object.assign(tr,{phase:'run',phaseSince:sim.t,manual:true,mode:'CM',level:'CBTC',inService:false,
      doorsAwait:false,doorsOpen:false,doorLockedAt:0,doorSide:'',v:0,a:0,eb:false,failed:false,
      stopUntil:0,hold:false,dtoInhibit:'车载全自动功能故障',lastStation:10,
      uto:{target:'CM',computer:true,stage:'manual',until:sim.t,detail:'随车人员 ATPM 驾驶',reason:'fault',returnAt:sim.t}});
    tr.tasks=[{k:'stop',station:11,berth:goal,trip:-1,arr:sim.t+180,dep:null,doors:false,revenue:false}];
    motion.indexBodies(sim);ci.computeOccupancy(sim);motion.refreshAuthority(sim);
    const next=ats.signalAheadFrom(sim,tr.link,tr.off,tr.dir,1000)!;
    expect(next).not.toBeNull();
    const route=sim.topo.routes[sim.sig[next.sig].route];expect(route).toBeDefined();
    const section=route.sections.find(s=>!tr.body.some(b=>sim.topo.links[b.link].section===s))!;
    expect(section).toBeDefined();
    sim.sec[section].preset=true;sim.sec[section].presetSeen=false;
    ci.updateInterlocking(sim);motion.refreshAuthority(sim);motion.updateTrainMotion(sim,tr,.1);
    expect(tr.maCode).toBe('AXLE_PRESET');expect(tr.maDist).toBeLessThan(35);
    expect(tr.nextSignal).toBe(next.sig);
    return{tr,section,goal};
  }
  function request(tr:Train){
    ats.driverRM(sim);
    const call=sim.calls.find(c=>c.kind==='rmPreset'&&c.train===tr.id&&c.state==='ringing')!;
    expect(call).toBeDefined();sim.step();expect(call.state).toBe('ringing');return call;
  }
  function finish(tr:Train,section:number,goal:number){
    let seen=sim.sec[section].presetSeen,cleared=false,protectedAgain=false;
    for(let n=0;n<6000;n++){
      sim.step();seen ||= sim.sec[section].presetSeen;
      cleared ||= seen&&!sim.sec[section].preset;
      protectedAgain ||= cleared&&tr.mode==='CM'&&tr.rmAuth===0&&tr.maDist>1;
      if(tr.phase==='dwell'&&tr.tasks[0]?.k==='stop'&&tr.tasks[0].berth===goal)break;
    }
    expect(seen).toBe(true);expect(cleared).toBe(true);expect(protectedAgain).toBe(true);
    expect(tr.phase,`${tr.halt.detail} ${tr.ebReason}`).toBe('dwell');
    expect(tr.tasks[0]).toMatchObject({k:'stop',berth:goal});
    expect(tr.mode).toBe('CM');expect(tr.uto).toMatchObject({computer:true,target:'CM',stage:'manual'});
    expect(tr.dtoInhibit).toBe('车载全自动功能故障');expect(tr.manual).toBe(true);
    expect(tr.eb,tr.ebReason).toBe(false);expect(sim.integrity.violations).toEqual([]);
  }
  it('keeps the human manual cab outside automatic preset requests',()=>{
    const {tr}=fixture();expect(uto.computerCrew(tr)).toBe(true);tr.uto!.computer=false;
    expect(uto.computerCrew(tr)).toBe(false);
    ats.driverRM(sim);expect(sim.calls.some(c=>c.kind==='rmPreset'&&c.train===tr.id)).toBe(false);
    expect(tr.mode).toBe('CM');expect(tr.rmAuth).toBe(0);
  });
  it('keeps one pending section request and reuses the existing retry cadence after wait',()=>{
    const {tr,section}=fixture(),call=request(tr);
    expect(call.target).toBe(section);
    for(let n=0;n<20;n++)ats.driverRM(sim);
    expect(sim.calls.filter(c=>c.kind==='rmPreset'&&c.train===tr.id)).toHaveLength(1);
    expect(sim.command({c:'radio',call:call.id,option:'wait'}).ok).toBe(true);
    sim.t+=59;ats.driverRM(sim);expect(sim.calls.filter(c=>c.kind==='rmPreset'&&c.train===tr.id)).toHaveLength(1);
    sim.t++;ats.driverRM(sim);expect(sim.calls.filter(c=>c.kind==='rmPreset'&&c.train===tr.id)).toHaveLength(2);
  });
  it('keeps a single pending section request across different computer attendants',()=>{
    const {tr,section}=fixture(),call=request(tr);
    // Request coalescing is independent of which cab submitted it first.
    const other={...tr,id:tr.id+100,vehicle:'14099',uto:{...tr.uto!}};
    expect(uto.computerCrew(other)).toBe(true);
    expect(radio.callRmPreset(sim,other)).toBeNull();
    expect(sim.calls.filter(c=>c.kind==='rmPreset'&&c.state==='ringing'&&c.target===section)).toEqual([call]);
  });
  it('coalesces an expired queued retry when another attendant already requested the section',()=>{
    const {tr,section}=fixture(),first=request(tr);
    sim.t=first.deadline;radio.radioTick(sim);
    expect(first.state).toBe('expired');
    const retry=sim.pendingCalls.find(p=>p.spec.kind==='rmPreset'&&p.spec.train===tr.id)!;
    expect(retry.at).toBe(first.deadline+60);expect(retry.spec.target).toBe(section);
    const other={...tr,id:tr.id+100,vehicle:'14099',uto:{...tr.uto!}};
    sim.t++;const second=radio.callRmPreset(sim,other)!;
    expect(second).not.toBeNull();expect(second.state).toBe('ringing');
    sim.t=retry.at;radio.radioTick(sim);
    expect(sim.pendingCalls).not.toContain(retry);
    expect(sim.calls.filter(c=>c.kind==='rmPreset'&&c.state==='ringing'&&c.target===section)).toEqual([second]);
  });
  it('refuses unsafe approval, then sweeps under the original permission and returns to protected CM',()=>{
    const {tr,section,goal}=fixture(),call=request(tr),link=sim.topo.sections[section].links[0];
    const bodies=sim.linkBodies.get(link)??[];
    sim.linkBodies.set(link,[...bodies,{train:999,from:10,to:11}]);
    const refused=sim.command({c:'radio',call:call.id,option:'approve'});
    expect(refused.ok).toBe(false);expect(refused.msg).toContain('前方列车占用');
    expect(call.state).toBe('ringing');expect(tr.mode).toBe('CM');expect(tr.rmAuth).toBe(0);
    ats.driverRM(sim);expect(sim.calls.filter(c=>c.kind==='rmPreset'&&c.train===tr.id)).toHaveLength(1);
    sim.linkBodies.set(link,bodies);
    expect(sim.command({c:'radio',call:call.id,option:'approve'}).ok).toBe(true);
    expect(sim.inputLog.at(-1)).toHaveProperty('cmd.c','radio');
    expect(tr.mode).toBe('RM');expect(tr.rmAuth).toBeGreaterThan(0);expect(tr.uto!.target).toBe('CM');
    finish(tr,section,goal);
  });
  it('carries a sweep already occupying the preset section into the next operating day',()=>{
    const {tr,section,goal}=fixture(),call=request(tr);
    expect(sim.command({c:'radio',call:call.id,option:'approve'}).ok).toBe(true);
    for(let n=0;n<1000&&!sim.sec[section].presetSeen;n++)sim.step();
    expect(sim.sec[section].presetSeen).toBe(true);expect(tr.mode).toBe('RM');
    const remaining=tr.rmAuth,position={link:tr.link,off:tr.off};
    sim.t=99900;
    const next=new Sim(operatingDay.nextOperatingConfig(sim));operatingDay.carryWorld(next,sim);
    sim=next;sim.startState=null;for(const b of sim.plan.blocks)sim.blockDone.add(b.id);
    const carried=sim.trains.get(tr.id)!;
    expect(carried).toMatchObject({...position,mode:'RM',rmAuth:remaining});
    expect(carried.uto).toMatchObject({computer:true,target:'CM',stage:'manual'});
    expect(sim.sec[section]).toMatchObject({preset:true,presetSeen:true});
    finish(carried,section,goal);
  });
});
