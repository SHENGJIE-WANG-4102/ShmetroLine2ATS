import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { newTrain, updateTrainTasks, doorEnable, serviceDutyTail } from '../src/sim/ats';
import { classify } from '../src/sim/halt';
import { computeBody, indexBodies } from '../src/sim/movement';
import { blockTasks, depotTasks, platformBerth } from '../src/sim/timetable';
import type { StopTask, Task } from '../src/sim/model';
import { assertNoCollision } from './helpers';
import { carryWorld, DAY_S } from '../src/sim/operatingDay';
import { collectResourceRequests } from '../src/sim/resourceArbitration';
import { recordTransition } from '../src/sim/invariants';
import { TURNBACK } from '../src/sim/fsm';
import { openDoors } from '../src/sim/psd';

function primeDepart(sim:Sim,train:ReturnType<typeof newTrain>) {
  for (const [from,to] of [['none','arrive'],['arrive','reverse'],['reverse','depart']] as const) {
    recordTransition(sim,TURNBACK,train.id,from,to,train); train.tbStage=to;
  }
}

describe('fixed depot work', () => {
  it('starts same-platform inbound work in AM without demanding a movement authority', () => {
    const sim=new Sim({dayType:'weekend',dateLabel:'same-platform-work',startTime:14400,seed:7,noPossessions:true});
    for(const train of [...sim.trainList])sim.removeTrain(train);
    const depot=sim.topo.depots.find(d=>d.key==='LYD')!,dir='DN' as const;
    const berth=sim.topo.berths[platformBerth(sim.topo,depot.station,dir)],tasks:Task[]=[];
    const last:StopTask={k:'stop',berth:berth.id,station:depot.station,trip:-1,arr:sim.t-60,dep:null,doors:true,revenue:false};
    tasks.push(last);depotTasks(sim.topo,depot.id,dir,tasks);
    const work=tasks[1];if(work.k!=='stop'||!work.depotWork)throw Error('expected same-platform work');
    expect(work.berth).toBe(berth.id);
    const train=newTrain(sim,null,berth.link,berth.offset,berth.dir,[{link:berth.link,dir:berth.dir}],'same-platform');
    Object.assign(train,{tasks,phase:'dwell',dwellUntil:sim.t,depReadyAt:sim.t,arrivedAt:sim.t-60,doorLockedAt:sim.t-1,
      mode:'AM',manual:false,atoDriver:false,doorsOpen:false,doorSide:'',maDist:5,hold:true,v:0,a:0});
    computeBody(sim,train);indexBodies(sim);
    updateTrainTasks(sim,train);expect(train.tasks[0]).toBe(last);
    train.hold=false;updateTrainTasks(sim,train);
    expect(train.tasks[0]).toBe(work);expect(train.phase).toBe('dwell');expect(train.dwellUntil).toBe(sim.t+30);
    expect(train.link).toBe(berth.link);expect(train.off).toBe(berth.offset);
  });
  it('keeps the open-door shortcut when the next stop really is on a platform', () => {
    const sim=new Sim({dayType:'weekday',dateLabel:'platform-door-turn',startTime:14400,seed:7,noPossessions:true});
    for(const train of [...sim.trainList])sim.removeTrain(train);
    const depot=sim.topo.depots.find(d=>d.key==='CSD')!,dir='DN' as const;
    const berth=sim.topo.berths[platformBerth(sim.topo,depot.station,dir)];
    const last:StopTask={k:'stop',berth:berth.id,station:depot.station,trip:-1,arr:null,dep:null,doors:false,revenue:false};
    const next:StopTask={k:'stop',berth:platformBerth(sim.topo,depot.station,'UP'),station:depot.station,
      trip:-1,arr:null,dep:sim.t+120,doors:false,revenue:false};
    const train=newTrain(sim,null,berth.link,berth.offset,berth.dir,[{link:berth.link,dir:berth.dir}],'platform-turn');
    Object.assign(train,{tasks:[last,{k:'reverse',berths:[berth.id],chosen:berth.id,station:depot.station,minTime:40},next],
      phase:'dwell',dwellUntil:sim.t,depReadyAt:sim.t,arrivedAt:sim.t,manual:false,v:0,a:0});
    openDoors(sim,train,berth.platform);computeBody(sim,train);indexBodies(sim);
    updateTrainTasks(sim,train);
    expect(train.tasks[0]).toMatchObject({k:'stop',station:depot.station,dep:next.dep});expect(train.doorsOpen).toBe(true);
    expect(sim.topo.berths[(train.tasks[0] as StopTask).berth].platform).toBe(berth.platform);
  });
  it.each(['BZL','CSD'])('%s closes the passenger doors before reversing into the separate depot lead', key => {
    const sim=new Sim({dayType:'weekend',dateLabel:'open-door-return',startTime:14400,seed:7,noPossessions:true});
    for(const train of [...sim.trainList])sim.removeTrain(train);
    for(const block of sim.plan.blocks)sim.blockDone.add(block.id);
    const depot=sim.topo.depots.find(d=>d.key===key)!;
    const dir=(['UP','DN'] as const).find(d=>depot.portals.entry[d].reverse)!;
    const berth=sim.topo.berths[platformBerth(sim.topo,depot.station,dir)];
    const last:StopTask={k:'stop',berth:berth.id,station:depot.station,trip:-1,arr:null,dep:null,doors:false,revenue:false};
    const tasks:Task[]=[last];depotTasks(sim.topo,depot.id,dir,tasks);
    const work=tasks.find((t):t is StopTask=>t.k==='stop'&&t.depotWork?.kind==='in')!;
    expect(sim.topo.berths[work.berth].kind).not.toBe('platform');
    expect(tasks[1].k).toBe('reverse');
    const train=newTrain(sim,null,berth.link,berth.offset,berth.dir,[{link:berth.link,dir:berth.dir}],'open-door-return');
    Object.assign(train,{tasks,phase:'dwell',dwellUntil:sim.t,depReadyAt:sim.t,arrivedAt:sim.t,manual:false,v:0,a:0});
    openDoors(sim,train,berth.platform);computeBody(sim,train);indexBodies(sim);
    updateTrainTasks(sim,train);
    expect(train.tasks[0]).toBe(last);
    expect(work.depotWork!.berths).toContain(work.berth);
    let sawWork=false,entered=false;
    for(let i=0;i<12000&&!entered;i++){
      sim.step();const task=train.tasks[0];
      if(train.phase==='dwell'&&task?.k==='stop'&&task.depotWork?.kind==='in'){
        sawWork=true;expect(task.depotWork.berths).toContain(task.berth);
        expect(train.doorsOpen).toBe(false);
      }
      entered=!sim.trains.has(train.id);
    }
    expect(sawWork).toBe(true);expect(entered).toBe(true);
  },30000);
  it.each(['BZL', 'LYD', 'CSD'])('%s waits for the fixed work and closed doors, independent of route availability', key => {
    const sim = new Sim({ dayType:'weekday', dateLabel:'depot-work', startTime:14400, seed:7, noPossessions:true });
    for (const train of [...sim.trainList]) sim.removeTrain(train);
    const depot = sim.topo.depots.find(d => d.key === key)!;
    const path = depot.transferPaths.find(p => p.exitWorkBerth !== undefined)!;
    const berth = sim.topo.berths[path.exitWorkBerth!];
    const train = newTrain(sim, null, berth.link, berth.offset, berth.dir, [{link:berth.link,dir:berth.dir}], 'test');
    const task:StopTask = {k:'stop',berth:berth.id,station:depot.station,trip:-1,arr:null,dep:null,doors:false,revenue:false,
      minDwell:30,depotWork:{kind:'out',depot:depot.id,berths:[berth.id]}};
    train.tasks=[task]; train.depotStage='out'; train.manual=true; train.mode='CM'; train.stopDist=0; primeDepart(sim,train);
    computeBody(sim,train); indexBodies(sim);
    expect(doorEnable(sim,train)).toMatchObject({L:true,R:true,depot:true});
    updateTrainTasks(sim,train);
    expect(train.phase).toBe('dwell');expect(train.tbStage).toBe('none');
    expect(classify(sim,train)).toMatchObject({code:'DWELL',detail:'出段固定作业'});
    train.hold=true;expect(classify(sim,train).code).toBe('HOLD');train.hold=false;
    train.eb=true;train.ebCause='spad';train.ebReason='越过信号';expect(classify(sim,train)).toMatchObject({code:'SPAD',detail:'越过信号'});train.eb=false;
    expect(() => sim.snapshot()).not.toThrow();
    sim.t+=29; updateTrainTasks(sim,train); expect(train.tasks[0]).toBe(task);
    sim.t+=1; train.doorsOpen=true; updateTrainTasks(sim,train); expect(train.tasks[0]).toBe(task);
    expect(classify(sim,train)).toMatchObject({code:'MANUAL',detail:'等待车门关闭锁闭'});
    train.doorsOpen=false; updateTrainTasks(sim,train); expect(train.phase).toBe('run'); expect(train.tasks).toHaveLength(0);
  });
  it.each(['BZL', 'LYD', 'CSD'])('%s performs the inbound work before entering inventory', key => {
    const sim = new Sim({ dayType:'weekday', dateLabel:'entry-work', startTime:14400, seed:7, noPossessions:true });
    for (const train of [...sim.trainList]) sim.removeTrain(train);
    const depot = sim.topo.depots.find(d => d.key === key)!, tasks:Task[] = [];
    depotTasks(sim.topo, depot.id, 'DN', tasks);
    const work = tasks.find((t): t is StopTask => t.k === 'stop' && t.depotWork?.kind === 'in')!;
    const berth = sim.topo.berths[work.berth];
    const train = newTrain(sim,null,berth.link,berth.offset,berth.dir,[{link:berth.link,dir:berth.dir}],'test');
    train.tasks=[work,{k:'depot',depot:depot.id,berth:depot.entryBerths[depot.portals.entry.DN.path]}];
    train.stopDist=0; computeBody(sim,train); indexBodies(sim);
    const stock=sim.depotStock[depot.id]; updateTrainTasks(sim,train);
    expect(train.phase).toBe('dwell'); expect(classify(sim,train)).toMatchObject({code:'DWELL',detail:'入段固定作业'});
    sim.t+=29; updateTrainTasks(sim,train); expect(sim.depotStock[depot.id]).toBe(stock); expect(train.tasks[0]).toBe(work);
    sim.t+=1; updateTrainTasks(sim,train); expect(train.tasks[0]).toMatchObject({k:'depot',depot:depot.id});
    expect(sim.depotStock[depot.id]).toBe(stock);
  });
  it.each(['BZL','LYD','CSD'])('%s real departure completes fixed work and physically proceeds', key => {
    const sim = new Sim({dayType:'weekday', dateLabel:'exit-work-chain',startTime:14400,seed:7,noPossessions:true});
    for (const train of [...sim.trainList]) sim.removeTrain(train);
    const depot=sim.topo.depots.find(d=>d.key===key)!;
    const block=sim.plan.blocks.find(b=>b.start.kind==='depot'&&b.start.depot===depot.id)!;
    if (block.start.kind!=='depot') throw Error('missing depot block');
    for (const b of sim.plan.blocks) if (b.id!==block.id) sim.blockDone.add(b.id);
    block.train=undefined; sim.t=block.start.time;
    let atWork=false,completed=false, workLink=-1, workAt=0;
    for (let i=0;i<6000&&!completed;i++) {
      sim.step();
      const train=sim.trainList.find(t=>t.block===block.id),task=train?.tasks[0];
      if (train?.phase==='dwell'&&task?.k==='stop'&&task.depotWork?.kind==='out') {
        if (!atWork) {workAt=sim.t;workLink=train.link;}
        atWork=true;
      }
      if (atWork&&train?.phase==='run'&&train.link!==workLink) completed=true;
    }
    const train=sim.trainList.find(t=>t.block===block.id);
    const details=JSON.stringify({start:block.start, now:sim.t, stock:sim.depotStock[depot.id],
      train:train&&{phase:train.phase,link:train.link,off:train.off,v:train.v,stopDist:train.stopDist,ma:train.maReason,task:train.tasks[0],halt:train.halt},
      events:sim.events.slice(-4).map(e=>e.text)});
    expect(atWork,details).toBe(true); expect(completed,details).toBe(true);
    expect(sim.t-workAt).toBeGreaterThanOrEqual(30); expect(train?.eb,details).toBe(false);
  }, 30000);
  it.each(['BZL','LYD','CSD'])('%s real return completes fixed work before the vehicle enters the yard', key => {
    const sim=new Sim({dayType:'weekday',dateLabel:'entry-work-chain',startTime:14400,seed:7,noPossessions:true});
    for(const train of [...sim.trainList])sim.removeTrain(train);
    for(const block of sim.plan.blocks)sim.blockDone.add(block.id);
    const depot=sim.topo.depots.find(d=>d.key===key)!,dir='DN' as const;
    const berth=sim.topo.berths[platformBerth(sim.topo,depot.station,dir)],tasks:Task[]=[];
    depotTasks(sim.topo,depot.id,dir,tasks);
    const train=newTrain(sim,null,berth.link,berth.offset,berth.dir,[{link:berth.link,dir:berth.dir}],'test-return');
    train.tasks=tasks;train.inService=false;computeBody(sim,train);indexBodies(sim);
    const stock=sim.depotStock[depot.id]; let atWork=false,entered=false,workAt=0;
    for(let i=0;i<12000&&!entered;i++){
      sim.step();const task=train.tasks[0];
      if(train.phase==='dwell'&&task?.k==='stop'&&task.depotWork?.kind==='in'){
        if(!atWork)workAt=sim.t;atWork=true;expect(sim.depotStock[depot.id]).toBe(stock);
      }
      entered=!sim.trains.has(train.id);
    }
    const details=JSON.stringify({now:sim.t,stock:sim.depotStock[depot.id],phase:train.phase,link:train.link,off:train.off,
      v:train.v,ma:train.maReason,eb:train.eb,task:train.tasks[0],halt:train.halt,events:sim.events.slice(-4).map(e=>e.text)});
    expect(atWork,details).toBe(true);expect(entered,details).toBe(true);
    expect(sim.t-workAt).toBeGreaterThanOrEqual(30);expect(sim.depotStock[depot.id]).toBe(stock+1);expect(train.eb,details).toBe(false);
  },30000);
  it('retains the other shared BZL entry when its preferred lead is occupied', () => {
    const sim=new Sim({dayType:'weekday',dateLabel:'entry-alternative',startTime:14400,seed:7,noPossessions:true});
    for(const train of [...sim.trainList])sim.removeTrain(train);
    for(const block of sim.plan.blocks)sim.blockDone.add(block.id);
    const depot=sim.topo.depots.find(d=>d.key==='BZL')!,tasks:Task[]=[];
    depotTasks(sim.topo,depot.id,'UP',tasks);
    const work=tasks.find((t):t is StopTask=>t.k==='stop'&&t.depotWork?.kind==='in')!;
    const preferred=sim.topo.berths[work.berth],alternative=work.depotWork!.berths.find(b=>b!==preferred.id)!;
    const blocked=newTrain(sim,null,preferred.link,preferred.offset,preferred.dir,[{link:preferred.link,dir:preferred.dir}],'occupant');
    blocked.phase='stabled';blocked.inService=false;
    const origin=sim.topo.berths[platformBerth(sim.topo,depot.station,'UP')];
    const returning=newTrain(sim,null,origin.link,origin.offset,origin.dir,[{link:origin.link,dir:origin.dir}],'return');
    returning.tasks=tasks;returning.inService=false;computeBody(sim,blocked);computeBody(sim,returning);indexBodies(sim);
    let chosen=-1,entered=false;
    for(let i=0;i<12000&&!entered;i++){
      sim.step();const task=returning.tasks[0];
      if(returning.phase==='dwell'&&task?.k==='stop'&&task.depotWork?.kind==='in')chosen=task.berth;
      entered=!sim.trains.has(returning.id);
    }
    const details=JSON.stringify({preferred:preferred.id,alternative,chosen,phase:returning.phase,task:returning.tasks[0],halt:returning.halt,
      ma:returning.maReason,events:sim.events.slice(-3).map(e=>e.text)});
    expect(chosen,details).toBe(alternative);expect(entered,details).toBe(true);expect(returning.eb,details).toBe(false);
  },30000);
  it('allows a normal CSD entry and its separate westbound exit at the same time', () => {
    const sim=new Sim({dayType:'weekday',dateLabel:'independent-leads',startTime:14400,seed:7,noPossessions:true});
    for(const train of [...sim.trainList])sim.removeTrain(train);
    const depot=sim.topo.depots.find(d=>d.key==='CSD')!;
    const block=sim.plan.blocks.find(b=>b.start.kind==='depot'&&b.start.depot===depot.id&&sim.plan.trips[b.trips[0]].dir==='UP')!;
    if(block.start.kind!=='depot')throw Error('missing westbound departure');
    for(const b of sim.plan.blocks)if(b.id!==block.id)sim.blockDone.add(b.id);
    block.train=undefined;sim.t=block.start.time;
    const tasks:Task[]=[];depotTasks(sim.topo,depot.id,'DN',tasks);
    const inbound=tasks.find((t):t is StopTask=>t.k==='stop'&&t.depotWork?.kind==='in')!;
    const berth=sim.topo.berths[inbound.berth];
    const train=newTrain(sim,null,berth.link,berth.offset,berth.dir,[{link:berth.link,dir:berth.dir}],'entry');
    train.tasks=tasks.slice(tasks.indexOf(inbound));train.inService=false;train.stopDist=0;computeBody(sim,train);indexBodies(sim);
    const outgoing=blockTasks(sim.topo,sim.plan,block)[0] as StopTask;
    expect(sim.topo.berths[outgoing.berth].link).not.toBe(berth.link);
    let overlap=false,entered=false,left=false;
    for(let i=0;i<12000&&!(entered&&left);i++){
      sim.step();const exit=sim.trainList.find(t=>t.block===block.id);
      if(train.phase==='dwell'&&exit?.phase==='dwell'&&exit.tasks[0]?.k==='stop'&&exit.tasks[0].depotWork?.kind==='out')overlap=true;
      entered=!sim.trains.has(train.id);
      if(exit&&exit.link!==sim.topo.berths[outgoing.berth].link)left=true;
    }
    const exit=sim.trainList.find(t=>t.block===block.id);
    const details=JSON.stringify({overlap,entered,left,inbound:train.halt,exit:exit?.halt,events:sim.events.slice(-3).map(e=>e.text)});
    expect(overlap,details).toBe(true);expect(entered,details).toBe(true);expect(left,details).toBe(true);
    expect(train.eb,details).toBe(false);expect(exit?.eb,details).toBe(false);
  },30000);
  it('keeps an eastbound reverse exit behind an inbound train on the same CSD lead', () => {
    const sim=new Sim({dayType:'weekday',dateLabel:'shared-csd-lead',startTime:14400,seed:7,noPossessions:true});
    for(const train of [...sim.trainList])sim.removeTrain(train);
    const depot=sim.topo.depots.find(d=>d.key==='CSD')!;
    const block=sim.plan.blocks.find(b=>b.start.kind==='depot'&&b.start.depot===depot.id&&sim.plan.trips[b.trips[0]].dir==='DN')!;
    if(block.start.kind!=='depot')throw Error('missing eastbound departure');
    for(const b of sim.plan.blocks)if(b.id!==block.id)sim.blockDone.add(b.id);
    block.train=undefined;sim.t=block.start.time;
    const tasks:Task[]=[];depotTasks(sim.topo,depot.id,'DN',tasks);
    const work=tasks.find((t):t is StopTask=>t.k==='stop'&&t.depotWork?.kind==='in')!;
    const berth=sim.topo.berths[work.berth],train=newTrain(sim,null,berth.link,berth.offset,berth.dir,[{link:berth.link,dir:berth.dir}],'entry');
    train.tasks=tasks.slice(tasks.indexOf(work));train.inService=false;train.stopDist=0;computeBody(sim,train);indexBodies(sim);
    let entered=false,left=false;
    for(let i=0;i<12000&&!(entered&&left);i++){
      sim.step();if(i%10===0)assertNoCollision(sim);
      entered=!sim.trains.has(train.id);
      const exit=sim.trainList.find(t=>t.block===block.id);
      if(exit&&exit.link!==depot.transferPaths[depot.portals.exit.DN.path].links[1])left=true;
      if(!entered&&exit)expect(exit.body.some(b=>b.link===berth.link)).toBe(false);
    }
    const exit=sim.trainList.find(t=>t.block===block.id);
    const details=JSON.stringify({entered,left,inbound:train.halt,exit:exit?.halt,events:sim.events.slice(-3).map(e=>e.text)});
    expect(entered,details).toBe(true);expect(left,details).toBe(true);
    expect(train.eb,details).toBe(false);expect(exit?.eb,details).toBe(false);
  },30000);
  it('carries remaining fixed work across the operating-day boundary', () => {
    const from=new Sim({dayType:'weekday',date:'2026-10-19',dateLabel:'carry-work',startTime:14400,seed:7,noPossessions:true});
    const next=new Sim({dayType:'weekday',date:'2026-10-20',dateLabel:'carry-work-next',startTime:14400,seed:8,noPossessions:true});
    const train=from.trainList[0];for(const other of [...from.trainList])if(other!==train)from.removeTrain(other);
    const depot=from.topo.depots.find(d=>d.key==='CSD')!,path=depot.transferPaths.find(p=>p.exitWorkBerth!==undefined)!;
    const berth=from.topo.berths[path.exitWorkBerth!];from.t=DAY_S+13500;
    const work:StopTask={k:'stop',berth:berth.id,station:depot.station,trip:-1,arr:null,dep:null,doors:false,revenue:false,
      minDwell:30,depotWork:{kind:'out',depot:depot.id,berths:[berth.id]}};
    Object.assign(train,{link:berth.link,off:berth.offset,dir:berth.dir,hist:[{link:berth.link,dir:berth.dir}],
      phase:'dwell',phaseSince:from.t-13,dwellUntil:from.t+17,depReadyAt:from.t+17,tasks:[work],block:-1,tripId:-1,
      failed:false,eb:false,hold:false,doorsOpen:false,doorSide:'',doorMotion:undefined,doorLockedAt:0,v:0,a:0});
    computeBody(from,train);indexBodies(from);carryWorld(next,from);
    const carried=next.trains.get(train.id)!;
    expect(carried.phase).toBe('dwell');expect(carried.dwellUntil-next.t).toBe(17);
    expect(carried.tasks[0]).toMatchObject({depotWork:work.depotWork,berth:work.berth});
    next.t+=16;updateTrainTasks(next,carried);expect(carried.phase).toBe('dwell');
    next.t+=1;updateTrainTasks(next,carried);expect(carried.phase).toBe('run');expect(carried.tasks).toHaveLength(0);
  });
  it.each([true,false])('protects the full platform-to-depot turn after work (turn chosen: %s)', chosen => {
    const sim=new Sim({dayType:'weekday',dateLabel:'work-turn-admission',startTime:14400,seed:7,noPossessions:true});
    const train=sim.trainList[0];for(const other of [...sim.trainList])if(other!==train)sim.removeTrain(other);
    for(const block of sim.plan.blocks)sim.blockDone.add(block.id);sim.resourceTransit.clear();
    const depot=sim.topo.depots.find(d=>d.key==='LYD')!,berth=sim.topo.berths[platformBerth(sim.topo,depot.station,'UP')];
    const tasks:Task[]=[{k:'stop',berth:berth.id,station:depot.station,trip:-1,arr:null,dep:null,doors:true,revenue:true}];
    depotTasks(sim.topo,depot.id,'UP',tasks);
    expect(tasks[1]).toMatchObject({k:'stop',berth:berth.id,depotWork:{kind:'in'}});
    expect(tasks[2]).toMatchObject({k:'reverse',chosen:berth.id});
    if(!chosen&&tasks[2].k==='reverse')tasks[2].chosen=-1;
    Object.assign(train,{link:berth.link,off:berth.offset,dir:berth.dir,hist:[{link:berth.link,dir:berth.dir}],
      phase:'dwell',dwellUntil:sim.t+30,tasks,block:-1,tripId:-1,v:0,a:0,hold:false,failed:false,eb:false});
    computeBody(sim,train);indexBodies(sim);
    const request=collectResourceRequests(sim).find(r=>r.id===train.id);
    expect(request).toBeDefined();
    const destination=depot.entryBerths[depot.portals.entry.UP.path];
    expect(request!.options.some(o=>o.phases.some(p=>p.goal===destination)&&!o.unreachable)).toBe(true);
  });
  it('finishes a previous turn before fixed work and permits the next depot turn', () => {
    const sim=new Sim({dayType:'weekday',dateLabel:'work-after-turn',startTime:14400,seed:7,noPossessions:true});
    const train=sim.trainList[0];for(const other of [...sim.trainList])if(other!==train)sim.removeTrain(other);
    const depot=sim.topo.depots.find(d=>d.key==='LYD')!,tasks:Task[]=[];depotTasks(sim.topo,depot.id,'UP',tasks);
    const work=tasks[0];if(work.k!=='stop'||!work.depotWork)throw Error('missing work stop');
    const berth=sim.topo.berths[work.berth];
    Object.assign(train,{link:berth.link,off:berth.offset,dir:berth.dir,hist:[{link:berth.link,dir:berth.dir}],
      phase:'run',tbStage:'none',tasks,block:-1,tripId:-1,v:0,a:0,stopDist:0,hold:false,failed:false,eb:false});
    primeDepart(sim,train);
    computeBody(sim,train);indexBodies(sim);updateTrainTasks(sim,train);
    expect(train.phase).toBe('dwell');expect(train.tbStage).toBe('none');
    sim.t+=work.minDwell!;updateTrainTasks(sim,train);expect(train.tasks[0]).toMatchObject({k:'reverse'});
    train.stopDist=0;updateTrainTasks(sim,train);
    expect(train.phase).toBe('reversing');expect(train.tbStage).toBe('reverse');
    expect(sim.integrity.violations.filter(v=>v.kind==='FSM')).toEqual([]);
  });
  it('anchors a duty exchange at the passenger stop after the depot cab change', () => {
    const sim=new Sim({dayType:'weekday',dateLabel:'exchange-source-anchor',startTime:14400,seed:7,noPossessions:true});
    const block=sim.plan.blocks.find(b=>{
      if(b.start.kind!=='depot')return false;
      const trip=sim.plan.trips[b.trips[0]],depot=sim.topo.depots[b.start.depot];
      return trip.revenue&&depot.portals.exit[trip.dir].reverse&&trip.stops.some(s=>s.st===depot.station&&s.stop);
    })!;
    expect(block).toBeDefined();if(block.start.kind!=='depot')throw Error('expected depot');
    const trip=sim.plan.trips[block.trips[0]],station=sim.topo.depots[block.start.depot].station;
    const original=blockTasks(sim.topo,sim.plan,block);
    expect(original.some(t=>t.k==='stop'&&t.trip===trip.id&&t.station===station&&t.note==='出段换端')).toBe(true);
    const tail=serviceDutyTail(sim,block,trip,station)!;
    expect(tail[0]).toMatchObject({k:'stop',trip:trip.id,station,revenue:true,doors:true});
    expect(tail[0]).not.toHaveProperty('note','出段换端');
    expect(tail.some(t=>t.k==='stop'&&t.trip===trip.id&&t.station===trip.to)).toBe(true);
    expect(serviceDutyTail(sim,block,trip,-1)).toBeUndefined();
  });
  it('still releases the platform boundary before a later ordinary departure after same-platform work', () => {
    const sim=new Sim({dayType:'weekday',dateLabel:'work-turn-boundary',startTime:14400,seed:7,noPossessions:true});
    const train=sim.trainList[0];for(const other of [...sim.trainList])if(other!==train)sim.removeTrain(other);
    for(const block of sim.plan.blocks)sim.blockDone.add(block.id);sim.resourceTransit.clear();
    const plans=sim.plan.blocks.map(b=>blockTasks(sim.topo,sim.plan,b));
    const selected=plans.flatMap(tasks=>tasks.flatMap((t,i)=>t.k==='reverse'&&i>0&&tasks[i-1]?.k==='stop'
      &&sim.topo.berths[t.chosen]?.kind==='platform'&&tasks[i+1]?.k==='stop'&&tasks[i+2]?.k==='stop'
      ? [{tasks,index:i}] : []))[0];
    expect(selected).toBeDefined();
    const tasks=structuredClone(selected.tasks.slice(selected.index-1));
    const arrival=tasks[0];if(arrival.k!=='stop')throw Error('expected platform arrival');
    const berth=sim.topo.berths[arrival.berth],next=tasks[3];if(next.k!=='stop')throw Error('expected later departure');
    const laterBerth=next.berth;
    tasks.splice(1,0,{k:'stop',berth:berth.id,station:arrival.station,trip:-1,arr:null,dep:null,doors:false,revenue:false,minDwell:30,
      depotWork:{kind:'in',depot:0,berths:[berth.id]}});
    Object.assign(train,{link:berth.link,off:berth.offset,dir:berth.dir,hist:[{link:berth.link,dir:berth.dir}],
      phase:'dwell',dwellUntil:sim.t+30,tasks,block:-1,tripId:-1,v:0,a:0,hold:false,failed:false,eb:false});
    computeBody(sim,train);indexBodies(sim);
    const request=collectResourceRequests(sim).find(r=>r.id===train.id);
    expect(request).toBeDefined();
    const details=JSON.stringify(request!.options.map(o=>({goals:o.phases.map(p=>p.goal),unreachable:o.unreachable,choices:o.choices})));
    expect(request!.options.some(o=>!o.unreachable&&o.phases.at(-1)?.goal===berth.id),details).toBe(true);
    expect(request!.options.every(o=>o.phases.every(p=>p.goal!==laterBerth)),details).toBe(true);
  });
});
