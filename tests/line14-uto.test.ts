import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import type {Sim as Simulator} from '../src/sim/engine';
import type {Checkpoint} from '../src/sim/state';
import type {Train,UtoAction} from '../src/sim/model';

describe('unattended line operating procedures',()=>{
  let sim:Simulator,Sim:typeof Simulator,base:Checkpoint;
  let ats:typeof import('../src/sim/ats'),uto:typeof import('../src/sim/uto');
  let movement:typeof import('../src/sim/movement'),state:typeof import('../src/sim/state');
  let timetable:typeof import('../src/sim/timetable'),onboard:typeof import('../src/sim/onboard');
  let psd:typeof import('../src/sim/psd'),data:typeof import('../src/data/current');
  beforeAll(async()=>{
    vi.stubEnv('ATS_LINE','14');vi.resetModules();
    Sim=(await import('../src/sim/engine')).Sim;
    ats=await import('../src/sim/ats');uto=await import('../src/sim/uto');
    movement=await import('../src/sim/movement');state=await import('../src/sim/state');
    timetable=await import('../src/sim/timetable');onboard=await import('../src/sim/onboard');
    psd=await import('../src/sim/psd');data=await import('../src/data/current');
    sim=new Sim({dayType:'weekday',date:'2026-10-23',dateLabel:'UTO',startTime:14400,seed:71,noPossessions:true,autoRadio:false});
    base=state.capture(sim);
  },120000);
  beforeEach(()=>{state.restore(sim,base);sim.startState=null;});
  afterAll(()=>{vi.unstubAllEnvs();vi.resetModules();});
  function fixture(station=22) {
    for(const t of [...sim.trainList])sim.removeTrain(t);
    const b=sim.topo.berths[timetable.platformBerth(sim.topo,station,'DN')];
    const vehicle=[...sim.vehicles.keys()][0],r=sim.vehicles.get(vehicle)!;
    for(const [i,y]of sim.yards.entries()) {for(const track of y.tracks){const index=track.indexOf(vehicle);if(index>=0)track.splice(index,1);}sim.depotStock[i]=y.tracks.flat().length;}
    r.depot=-1;r.uto={stage:'ready',until:0,cycles:0};
    const tr=ats.newTrain(sim,null,b.link,b.offset,b.dir,[{link:b.link,dir:b.dir}],vehicle);
    Object.assign(tr,{phase:'dwell',phaseSince:sim.t,arrivedAt:sim.t,dwellUntil:sim.t+30,depReadyAt:sim.t+30,doorsAwait:false,
      doorsOpen:false,doorLockedAt:sim.t,maDist:1000,maFar:1000,lastMa:Infinity,manual:false,mode:'DTO',inService:true});
    tr.tasks=[{k:'stop',station,berth:b.id,trip:-1,arr:sim.t,dep:sim.t+30,doors:true,revenue:true},
      {k:'stop',station:station+2,berth:timetable.platformBerth(sim.topo,station+2,'DN'),trip:-1,arr:sim.t+180,dep:sim.t+210,doors:true,revenue:true}];
    movement.indexBodies(sim);return tr;
  }
  function sequence(tr:Train) {
    for(let n=0;n<30&&tr.uto?.stage!=='manual'&&tr.uto;n++) {
      sim.t=Math.max(sim.t,tr.uto.until)+.001;uto.utoTrainTick(sim,tr);
    }
  }
  it('wakes through power/pantograph/self-test before becoming eligible for depot exit',()=>{
    const block=sim.plan.blocks.find(b=>b.start.kind==='depot')!;
    const first=timetable.depotMoves([block],sim.plan.trips).find(m=>m.delta<0)!;
    sim.t=first.time-data.OPERATIONS.uto!.wakeLeadS;uto.utoFleetTick(sim);
    const depotVehicles=[...sim.vehicles.values()].filter(r=>r.depot===first.depot&&!r.work);
    expect(depotVehicles.some(r=>r.uto?.stage==='power')).toBe(true);
    sim.t+=data.OPERATIONS.uto!.powerS;uto.utoFleetTick(sim);
    expect(depotVehicles.some(r=>r.uto?.stage==='pantograph')).toBe(true);
    sim.t+=data.OPERATIONS.uto!.pantographS;uto.utoFleetTick(sim);
    expect(depotVehicles.some(r=>r.uto?.stage==='selfTest')).toBe(true);
    sim.t+=data.OPERATIONS.uto!.selfTestS;uto.utoFleetTick(sim);
    expect(depotVehicles.some(r=>r.uto?.stage==='ready')).toBe(true);
  });
  it('requires ordered player operations, adds dwell, and returns to FAM through the same sequence',()=>{
    const tr=fixture(),before=tr.dwellUntil;
    expect(sim.command({c:'manual',train:tr.id,mode:'CM'}).ok).toBe(true);
    expect(sim.command({c:'utoStep',train:tr.id,action:'key'}).ok).toBe(false);
    for(const action of ['report','key','famOff','brake','confirm'] as UtoAction[]) {
      expect(sim.command({c:'utoStep',train:tr.id,action}).ok).toBe(true);
      expect(tr.mode).toBe('DTO');sim.t=tr.uto!.until;
    }
    uto.utoTrainTick(sim,tr);expect(tr.manual).toBe(true);expect(tr.mode).toBe('CM');
    expect(tr.dwellUntil).toBeGreaterThanOrEqual(before+18);
    expect(sim.command({c:'manual',train:tr.id,mode:'AUTO'}).ok).toBe(true);
    for(const action of ['restoreReport','neutral','famOn'] as UtoAction[]) {
      expect(sim.command({c:'utoStep',train:tr.id,action}).ok).toBe(true);sim.t=tr.uto!.until;
    }
    uto.utoTrainTick(sim,tr);expect(tr.mode).toBe('DTO');expect(tr.manual).toBe(false);expect(tr.uto).toBeUndefined();
    expect(sim.inputLog.filter(i=>'cmd'in i&&i.cmd.c==='utoStep')).toHaveLength(9);
  });
  it('player takeover during the opening delay completes shared door opening before manual closing',()=>{
    const tr=fixture();tr.doorsAwait=true;tr.autoOpenAt=sim.t+1;
    const stop=tr.tasks[0] as {berth:number};
    expect(sim.command({c:'manual',train:tr.id,mode:'CM'}).ok).toBe(true);
    expect(sim.command({c:'utoStep',train:tr.id,action:'report'}).ok).toBe(false);
    sim.t=tr.autoOpenAt;ats.updateTrainTasks(sim,tr);
    expect(tr.doorsAwait).toBe(false);expect(tr.doorMotion?.kind).toBe('opening');
    sim.t=tr.doorMotion!.trainAt;psd.doorMotionTick(sim);
    expect(tr.doorsOpen).toBe(true);expect(tr.phase).toBe('dwell');
    const side=ats.platformSide(sim,tr,sim.topo.berths[stop.berth].platform);
    expect(sim.command({c:'door',train:tr.id,side}).ok).toBe(true);
    sim.t=tr.doorLockedAt!;psd.doorMotionTick(sim);
    expect(sim.command({c:'utoStep',train:tr.id,action:'report'}).ok).toBe(true);
  });
  it('computer attendant closes the physical doors before taking ATPM, then departs with that mode',()=>{
    const tr=fixture();tr.doorsOpen=true;sim.plat[sim.topo.berths[(tr.tasks[0] as {berth:number}).berth].platform].psd='open';
    expect(sim.command({c:'manual',train:tr.id,mode:'CM',computer:true}).ok).toBe(true);
    uto.utoTrainTick(sim,tr);expect(tr.uto!.stage).toBe('doors');expect(tr.mode).toBe('DTO');
    sim.t=tr.uto!.closeAt!;uto.utoTrainTick(sim,tr);expect(tr.doorMotion?.kind).toBe('closing');
    sim.t=tr.doorLockedAt!;psd.doorMotionTick(sim);sequence(tr);
    expect(tr.mode).toBe('CM');expect(tr.manual).toBe(true);
    sim.t=Math.max(sim.t,tr.dwellUntil)+1;ats.updateTrainTasks(sim,tr);
    expect(tr.phase).toBe('run');
  });
  it('computer ATPM drives with the manual handle, stops at the next mark and works the doors',()=>{
    const tr=fixture(20);for(const b of sim.plan.blocks)sim.blockDone.add(b.id);
    expect(sim.command({c:'manual',train:tr.id,mode:'CM',computer:true}).ok).toBe(true);sequence(tr);
    sim.t=tr.dwellUntil;ats.updateTrainTasks(sim,tr);
    let moved=false;
    for(let n=0;n<6000;n++) {
      sim.step();moved ||= tr.v>1;
      if(tr.phase==='dwell'&&(tr.tasks[0] as {station?:number})?.station===22&&tr.doorsOpen)break;
    }
    expect(moved).toBe(true);expect(tr.mode).toBe('CM');expect(tr.manual).toBe(true);
    expect(tr.phase,`${tr.halt.detail} ${tr.ebReason} ${movement.stopError(sim,tr)}`).toBe('dwell');
    expect(tr.doorsOpen).toBe(true);expect(tr.drv.stops.at(-1)?.station).toBe(22);
    expect(Math.abs(movement.stopError(sim,tr))).toBeLessThanOrEqual(1);
    expect(sim.integrity.violations).toEqual([]);
  });
  it('weather-independent overrun uses RM takeover and the protected physical retreat path',()=>{
    const tr=fixture(20);for(const b of sim.plan.blocks)sim.blockDone.add(b.id);
    const probability=data.OPERATIONS.atoRandomOverrunProbability;
    data.OPERATIONS.atoRandomOverrunProbability=1;
    try {
      sim.t=tr.dwellUntil;ats.updateTrainTasks(sim,tr);sim.t+=data.OPERATIONS.uto!.doorWarningS;ats.updateTrainTasks(sim,tr);
      for(let n=0;n<6000&&!tr.overrun;n++)sim.step();
      expect(tr.overrun).toBeGreaterThan(.8);expect(sim.env.rain).toBe(false);
      const call=sim.calls.find(c=>c.kind==='overrun'&&c.train===tr.id&&c.state==='ringing')!;
      expect(call.from).toContain('随车人员');expect(sim.command({c:'radio',call:call.id,option:'back'}).ok).toBe(true);
      let maxReverse=0,sawRm=false;
      for(let n=0;n<2500;n++) {
        sim.step();if(tr.reverser===-1){maxReverse=Math.max(maxReverse,tr.v);sawRm ||= tr.mode==='RM';}
        if(tr.phase==='dwell')break;
      }
      expect(sawRm).toBe(true);expect(maxReverse*3.6).toBeLessThanOrEqual(data.OPERATIONS.reverseKmh+.1);
      expect(tr.phase,`${tr.halt.detail} ${tr.ebReason} ${movement.stopError(sim,tr)}`).toBe('dwell');
      expect(Math.abs(movement.stopError(sim,tr))).toBeLessThanOrEqual(1);
      expect(tr.drv.stops.at(-1)?.note).toBe('过标退行');expect(sim.integrity.violations).toEqual([]);
    } finally {data.OPERATIONS.atoRandomOverrunProbability=probability;}
  });
  it('full-auto equipment failure degrades to ATPM and exposes the remote reset command',()=>{
    const tr=fixture();expect(sim.command({c:'fault',kind:'trainUto',target:tr.id,duration:0}).ok).toBe(true);
    uto.utoTrainTick(sim,tr);sequence(tr);
    expect(tr.mode).toBe('CM');expect(tr.uto?.detail).toContain('ATPM');
    expect(sim.command({c:'utoReset',train:tr.id}).ok).toBe(true);
    expect(tr.uto?.stage).toBe('reset');expect(tr.uto?.until).toBe(sim.t+data.OPERATIONS.uto!.resetS);
  });
  it('successful remote reset repairs the equipment and completes the guarded FAM restoration',()=>{
    const tr=fixture();sim.command({c:'fault',kind:'trainUto',target:tr.id,duration:0});uto.utoTrainTick(sim,tr);sequence(tr);
    const rng=vi.spyOn(sim,'rng').mockReturnValue(0);
    try {expect(sim.command({c:'utoReset',train:tr.id}).ok).toBe(true);} finally {rng.mockRestore();}
    sim.t=tr.uto!.until;uto.utoTrainTick(sim,tr);
    expect(tr.dtoInhibit).toBe('');expect(tr.uto?.stage).toBe('manual');
    expect(sim.faults.find(f=>f.kind==='trainUto'&&f.target===tr.id)?.repaired).toBe(true);
    uto.utoTrainTick(sim,tr);sequence(tr);
    expect(tr.mode).toBe('DTO');expect(tr.manual).toBe(false);expect(tr.uto).toBeUndefined();
  });
  it('failed remote reset survives an independent traction reset and clears service at the scheduled terminus',async()=>{
    const {vehicleTick}=await import('../src/sim/vehicle');
    const tr=fixture();sim.command({c:'fault',kind:'trainUto',target:tr.id,duration:0});uto.utoTrainTick(sim,tr);sequence(tr);
    const rng=vi.spyOn(sim,'rng').mockReturnValue(.999);
    try {expect(sim.command({c:'utoReset',train:tr.id}).ok).toBe(true);} finally {rng.mockRestore();}
    sim.t=tr.uto!.until;uto.utoTrainTick(sim,tr);
    expect(tr.mode).toBe('CM');expect(tr.withdrawAtEnd).toBe(true);expect(tr.uto?.returnAt).toBe(Infinity);
    expect(tr.dtoInhibit).toBe('车载全自动功能故障');
    expect(sim.command({c:'manual',train:tr.id,mode:'RM',computer:true}).ok).toBe(true);sequence(tr);
    expect(tr.uto?.resetSuccess).toBe(false);
    // A separate recovering inverter must clear only its own withdrawal cause.
    sim.command({c:'fault',kind:'traction',target:tr.id,duration:0,param:1,recoverable:true});
    const reset=sim.vehicleResets.find(r=>r.train===tr.id)!;sim.t=reset.at;vehicleTick(sim);
    expect(tr.withdrawAtEnd).toBe(true);expect(tr.inService).toBe(true);
    // Advance the existing service to its actual final stop; no routing or
    // stock is manufactured by the test. The shared withdrawal builds the return.
    const end=data.STATIONS.length-1,berth=sim.topo.berths[timetable.platformBerth(sim.topo,end,'DN')];
    Object.assign(tr,{link:berth.link,off:berth.offset,dir:berth.dir,phase:'dwell',v:0,load:250,lastStation:end,block:-1});
    tr.tasks=[{k:'stop',station:end,berth:berth.id,trip:0,arr:sim.t,dep:null,doors:true,revenue:true}];
    movement.indexBodies(sim);vehicleTick(sim);
    expect(tr.withdrawn).toBe(true);expect(tr.inService).toBe(false);expect(tr.load).toBe(0);
    expect(tr.tasks.some(t=>t.k==='depot')).toBe(true);expect(tr.uto?.target).toBe('RM');
  });
  it.each(['','车载DTO功能故障'])('traction-only withdrawal still cancels after recovery with legacy inhibit %s',async(inhibit)=>{
    const {vehicleTick}=await import('../src/sim/vehicle');const tr=fixture();
    tr.dtoInhibit=inhibit;tr.withdrawAtEnd=true;
    sim.command({c:'fault',kind:'traction',target:tr.id,duration:0,param:1,recoverable:true});
    sim.t=sim.vehicleResets.find(r=>r.train===tr.id)!.at;vehicleTick(sim);
    expect(tr.withdrawAtEnd).toBe(false);
  });
  it('CBTC loss uses RM, refuses ATPM, and retains the shared RM speed limit',()=>{
    const tr=fixture();tr.comm=false;
    expect(sim.command({c:'manual',train:tr.id,mode:'CM'}).ok).toBe(false);
    onboard.updateOnboard(sim);sequence(tr);expect(tr.mode).toBe('RM');
    expect(movement.scanAhead(sim,tr,(tr.tasks[0] as {berth:number}).berth).vBody).toBeLessThanOrEqual((awaitedPerf()));
  });
  function awaitedPerf(){return data.SIMULATION.physics.performance.vRM;}
  it('computer RM under lost CBTC obeys the shared ceiling and reaches the next platform',()=>{
    const tr=fixture(20);for(const b of sim.plan.blocks)sim.blockDone.add(b.id);
    tr.comm=false;onboard.updateOnboard(sim);sequence(tr);expect(tr.mode).toBe('RM');
    sim.t=tr.dwellUntil;ats.updateTrainTasks(sim,tr);let maximum=0;
    for(let n=0;n<7000;n++){
      sim.step();maximum=Math.max(maximum,tr.v);
      if(tr.phase==='dwell'&&(tr.tasks[0] as {station?:number})?.station===22&&tr.doorsOpen)break;
    }
    expect(maximum).toBeGreaterThan(1);expect(maximum).toBeLessThanOrEqual(awaitedPerf());
    expect(tr.phase,`${tr.halt.detail} ${tr.ebReason}`).toBe('dwell');expect(tr.doorsOpen).toBe(true);
    expect(sim.integrity.violations).toEqual([]);
  });
  it('CBTC loss during ATPM takeover restarts the guarded sequence as RM',()=>{
    const tr=fixture();sim.command({c:'manual',train:tr.id,mode:'CM',computer:true});
    uto.utoTrainTick(sim,tr);expect(tr.uto?.stage).toBe('report');
    tr.comm=false;uto.utoTrainTick(sim,tr);expect(tr.uto?.target).toBe('RM');sequence(tr);
    expect(tr.mode).toBe('RM');expect(tr.manual).toBe(true);
  });
  it('ATPM takeover leaves the shared emergency brake report and authorised release active',()=>{
    const tr=fixture();sim.command({c:'manual',train:tr.id,mode:'CM',computer:true});sequence(tr);
    onboard.applyEB(sim,tr,'随车人员紧急制动','driver');sim.t+=onboard.EB_REPORT_DELAY+1;
    onboard.updateOnboard(sim);
    const call=sim.calls.find(c=>c.kind==='ebRelease'&&c.train===tr.id&&c.state==='ringing')!;
    expect(call).toBeDefined();expect(call.from).toContain('随车人员');
    expect(sim.command({c:'radio',call:call.id,option:'release'}).ok).toBe(true);
    expect(tr.eb).toBe(false);expect(tr.mode).toBe('CM');
  });
  it('replays computer control procedures once while retaining every player command',async()=>{
    const tr=fixture();for(const b of sim.plan.blocks)sim.blockDone.add(b.id);
    sim.startState=state.capture(sim);
    sim.command({c:'manual',train:tr.id,mode:'CM',computer:true});
    for(let n=0;n<500&&tr.uto?.stage!=='manual';n++)sim.step();
    expect(tr.mode).toBe('CM');
    sim.command({c:'manual',train:tr.id,mode:'AUTO',computer:true});
    for(let n=0;n<500&&tr.uto;n++)sim.step();
    expect(tr.mode).toBe('DTO');
    const diagnostics=await import('../src/sim/diagnostics');
    const replay=diagnostics.replayDiagnostics(diagnostics.exportDiagnostics(sim));
    expect(state.fingerprint(replay)).toBe(state.fingerprint(sim));
    expect(replay.trains.get(tr.id)?.uto).toEqual(tr.uto);
    expect(replay.trains.get(tr.id)?.mode).toBe('DTO');
    expect(sim.inputLog.filter(i=>'cmd'in i).map(i=>'cmd'in i?i.cmd.c:'')).toEqual(['manual','manual']);
  });
  it('random takeover follows the configured start and spacing instead of an embedded clock',()=>{
    const tr=fixture(),rule=data.OPERATIONS.uto!;
    const original={from:rule.randomTakeoverFromS,spacing:rule.randomTakeoverSpacingS,count:rule.randomTakeoversPerDay};
    try {
      rule.randomTakeoversPerDay=sim.vehicles.size;
      rule.randomTakeoverFromS=sim.t+60;rule.randomTakeoverSpacingS=0;
      sim.t=rule.randomTakeoverFromS-1;uto.utoTrainTick(sim,tr);
      expect(tr.uto).toBeUndefined();
      sim.t=rule.randomTakeoverFromS;uto.utoTrainTick(sim,tr);
      expect(tr.uto?.target).toBe('CM');expect(tr.uto?.computer).toBe(true);
      expect(sim.vehicles.get(tr.vehicle)?.uto?.lastTakeoverDay).toBe(sim.config.date);
    } finally {
      rule.randomTakeoverFromS=original.from;rule.randomTakeoverSpacingS=original.spacing;rule.randomTakeoversPerDay=original.count;
    }
  });
  it('random takeover also runs once per operating day when the config has no calendar date',()=>{
    const tr=fixture(),rule=data.OPERATIONS.uto!,date=sim.config.date,seed=sim.config.seed;
    const original={from:rule.randomTakeoverFromS,spacing:rule.randomTakeoverSpacingS,count:rule.randomTakeoversPerDay};
    try {
      delete sim.config.date;
      rule.randomTakeoversPerDay=sim.vehicles.size;rule.randomTakeoverFromS=sim.t;rule.randomTakeoverSpacingS=0;
      uto.utoTrainTick(sim,tr);
      expect(tr.uto?.target).toBe('CM');expect(tr.uto?.reason).toBe('random');
      expect(sim.vehicles.get(tr.vehicle)?.uto?.lastTakeoverDay).toBe(`seed:${sim.config.seed}`);
      sequence(tr);sim.command({c:'manual',train:tr.id,mode:'AUTO',computer:true});sequence(tr);
      expect(tr.mode).toBe('DTO');expect(tr.uto).toBeUndefined();
      uto.utoTrainTick(sim,tr);expect(tr.uto).toBeUndefined();
      // nextDayConfig advances the seed, including worlds without a calendar.
      sim.config.seed++;
      uto.utoTrainTick(sim,tr);expect(tr.uto?.reason).toBe('random');
    } finally {
      sim.config.date=date;sim.config.seed=seed;
      rule.randomTakeoverFromS=original.from;rule.randomTakeoverSpacingS=original.spacing;rule.randomTakeoversPerDay=original.count;
    }
  });
  it('return work clears passengers, washes selected vehicles, then sleeps until a pending duty needs it',async()=>{
    const {takeVehicle,peekVehicle}=await import('../src/sim/yard');
    // This world has finished today's work. Advancing the clock alone would
    // leave every morning departure unexecuted, correctly requesting a wake-up.
    for(const block of sim.plan.blocks)sim.blockDone.add(block.id);
    const candidate=sim.yards[0].tracks.flat()[0],r=sim.vehicles.get(candidate)!;
    r.uto={stage:'ready',until:0,cycles:data.OPERATIONS.uto!.washEvery-1};
    const stock=sim.depotStock[0],vehicle=takeVehicle(sim,0);
    expect(vehicle).toBe(candidate);expect(sim.depotStock[0]).toBe(stock-1);
    sim.t=27*3600;
    const berth=sim.topo.berths[sim.topo.depots[0].berth];
    const train=ats.newTrain(sim,null,berth.link,berth.offset,berth.dir,[{link:berth.link,dir:berth.dir}],vehicle!);
    train.tasks=[{k:'depot',depot:0}];
    ats.updateTrainTasks(sim,train);
    expect(sim.trains.has(train.id)).toBe(false);expect(sim.depotStock[0]).toBe(stock);
    expect(r.uto.stage).toBe('clear');
    sim.t=r.uto.until;uto.utoFleetTick(sim);expect(r.uto.stage).toBe('wash');
    sim.t=r.uto.until;uto.utoFleetTick(sim);expect(r.uto.stage).toBe('sleep');
    uto.utoFleetTick(sim);expect(r.uto.stage).toBe('sleep');
    // A real unexecuted departure changes the demand, including an overdue one.
    const pending=sim.plan.blocks.find(b=>b.start.kind==='depot'&&b.start.depot===0)!;
    sim.blockDone.delete(pending.id);uto.utoFleetTick(sim);
    expect(r.uto.stage).toBe('power');
    for(const duration of [data.OPERATIONS.uto!.powerS,data.OPERATIONS.uto!.pantographS,data.OPERATIONS.uto!.selfTestS]){
      sim.t+=duration;uto.utoFleetTick(sim);
    }
    expect(r.uto.stage).toBe('ready');expect(peekVehicle(sim,0,pending)).not.toBeNull();
  });
  it('carries active control, depot wash, warning and acknowledgement clocks into the second day',async()=>{
    const tr=fixture(),day=await import('../src/sim/operatingDay');
    sim.t=27*3600;tr.uto={target:'CM',computer:true,stage:'key',detail:'插入主控钥匙',until:sim.t+3,returnAt:sim.t+300,closeAt:sim.t-2};
    tr.utoDoorWarningAt=sim.t-10;tr.dmiAcknowledged=[`${sim.t-5}|测试`];
    const yardRecord=[...sim.vehicles.values()].find(r=>r.depot>=0)!;
    yardRecord.uto={stage:'wash',cycles:4,until:sim.t+180};
    const next=new Sim({...sim.config,date:'2026-10-24',dayType:'weekend'},sim);
    const carried=next.trains.get(tr.id)!;
    expect(carried.uto!.until).toBe(sim.t+3-day.DAY_S);expect(carried.uto!.returnAt).toBe(sim.t+300-day.DAY_S);
    expect(carried.utoDoorWarningAt).toBe(sim.t-10-day.DAY_S);
    expect(carried.dmiAcknowledged).toEqual([`${sim.t-5-day.DAY_S}|测试`]);
    expect([...next.vehicles.values()].some(r=>r.uto?.stage==='wash'&&r.uto.until===sim.t+180-day.DAY_S)).toBe(true);
  },120000);
});


describe('overdue UTO depot readiness',()=>{
  beforeAll(()=>{vi.stubEnv('ATS_LINE','14');vi.resetModules();});
  afterAll(()=>{vi.unstubAllEnvs();vi.resetModules();});
  it('keeps an overdue unexecuted departure as wake-up demand, excluding assigned and completed duties',async()=>{
    const {utoFleetTick}=await import('../src/sim/uto');
    const {buildTopology}=await import('../src/sim/topology');
    const {peekVehicle,dayNumber}=await import('../src/sim/yard');
    const {OPERATIONS}=await import('../src/data/current');
    const topo=buildTopology(),config={date:'2026-10-23'},today=dayNumber(config);
    // One real parked vehicle and one pending departure; no whole-day diagram
    // is needed to exercise readiness after a dispatcher/resource delay.
    const vehicle='14001',record={depot:0,work:'' as const,daily:today,monthly:today,km:0,until:0,
      uto:{stage:'sleep' as import('../src/sim/model').UtoVehicleState['stage'],until:0,cycles:1}};
    const block:import('../src/sim/model').Block={id:0,svc:'001',start:{kind:'depot',depot:0,time:100},end:{kind:'none'},trips:[0]};
    const trip={id:0,cancelled:false} as import('../src/sim/model').Trip;
    const world={t:700,topo,config,plan:{blocks:[block],trips:[trip]},blockDone:new Set([0]),vehicles:new Map([[vehicle,record]]),
      yards:topo.depots.map((_,depot)=>({tracks:depot===0?[[vehicle]]:[[]],perTrack:1})),trainList:[]} as unknown as Simulator;
    utoFleetTick(world);expect(record.uto.stage).toBe('sleep');
    world.blockDone.clear();block.train=99;
    utoFleetTick(world);expect(record.uto.stage).toBe('sleep');
    delete block.train;
    utoFleetTick(world);expect(record.uto.stage).toBe('power');
    for(const duration of [OPERATIONS.uto!.powerS,OPERATIONS.uto!.pantographS,OPERATIONS.uto!.selfTestS]){
      world.t+=duration;utoFleetTick(world);
    }
    expect(record.uto.stage).toBe('ready');
    expect(peekVehicle(world,0,block)).toBe(vehicle);
  });
});
