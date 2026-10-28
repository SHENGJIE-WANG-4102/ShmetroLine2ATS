import {describe,it,expect} from 'vitest';
import {Sim} from '../src/sim/engine';
import {computeDmi,dmiTick} from '../src/sim/dmi';
import {STATIONS} from '../src/data/current';
import {platformBerth,turnbackAt,serviceEnd} from '../src/sim/timetable';
import {setTripFromTasks} from '../src/sim/ats';
import {openDoors,closeDoors,doorMotionTick,DOOR_STAGGER_S,psdRepaired} from '../src/sim/psd';
import {DOOR_CLOSE_S} from '../src/sim/calibration';
import {capture} from '../src/sim/state';

describe('Line 2 photographed cab content',()=>{
 it('publishes physical doors with offset opening and PSD-first closure, without changing the lock deadline',()=>{
  const s=new Sim({dayType:'weekday',dateLabel:'sequence',startTime:14400,seed:7,noPossessions:true});
  const t=s.trainList[0],b=s.topo.berths[platformBerth(s.topo,12,'DN')],ps=s.plat[b.platform];
  t.link=b.link;t.doorSide='';t.doorsOpen=false;t.vfault=null;
  openDoors(s,t,b.platform);const opened=s.t;
  expect(t.doorsOpen).toBe(true);expect(ps.psd).toBe('closed');
  s.t=opened+DOOR_STAGGER_S-.1;doorMotionTick(s);expect(ps.psd).toBe('closed');
  s.t=opened+DOOR_STAGGER_S;doorMotionTick(s);expect(ps.psd).toBe('open');
  expect(DOOR_STAGGER_S).toBeGreaterThan(0);expect(DOOR_STAGGER_S).toBeLessThanOrEqual(.5);
  const close=s.t;expect(closeDoors(s,t,b.platform)).toBe(0);
  const deadline=t.doorLockedAt!;expect(deadline-close).toBeCloseTo(DOOR_CLOSE_S);
  expect(t.doorsOpen).toBe(true);expect(ps.psd).toBe('open');
  expect(s.snapshot().trains.find(x=>x.id===t.id)).toMatchObject({doors:true,doorClosing:true});
  const cp=capture(s);s.t=deadline-DOOR_STAGGER_S;doorMotionTick(s);
  expect(ps.psd).toBe('closed');expect(t.doorsOpen).toBe(true);
  expect(computeDmi(s,t.id)).toMatchObject({trainDoor:'closing',psd:'closed'});
  expect(cp.trains.find(x=>x.id===t.id)?.doorMotion?.psdDone).toBeUndefined();
  s.t=deadline;doorMotionTick(s);expect(t.doorsOpen).toBe(false);expect(t.doorMotion).toBeUndefined();
  expect(s.snapshot().trains.find(x=>x.id===t.id)).toMatchObject({doors:false,doorClosing:false});
  expect(computeDmi(s,t.id)?.trainDoor).toBe('closed');
  openDoors(s,t,b.platform);s.t+=.3;doorMotionTick(s);ps.psdFault=true;
  expect(closeDoors(s,t,b.platform)).toBe(-1);expect(t.doorsOpen).toBe(true);expect(ps.psd).toBe('closeFail');
  psdRepaired(s,b.platform);expect(ps.psd).toBe('closed');expect(t.doorsOpen).toBe(true);
  s.t=t.doorLockedAt!;doorMotionTick(s);expect(t.doorsOpen).toBe(false);
  openDoors(s,t,b.platform);ps.psdFault=true;
  expect(closeDoors(s,t,b.platform)).toBe(0);expect(ps.psd).toBe('closed');
 });
 it('uses station data for cab spelling and marks only the actual change of ends',()=>{
  const s=new Sim({dayType:'weekday',date:'2026-10-21',dateLabel:'cab',startTime:14400,seed:7,noPossessions:true});
  for(let i=0;i<20;i++)s.step();
  const t=s.trainList[0];
  const airport=STATIONS.findIndex(st=>st.id==='PDA');
  const turn=turnbackAt(s.topo,airport,'DN')!;
  if(turn.kind!=='rear')throw Error('airport rear turnback');
  const berth=platformBerth(s.topo,airport,'DN'),depBerth=platformBerth(s.topo,airport,'UP');
  t.destStation=airport;
  t.tasks=[{k:'stop',station:airport,berth,trip:-1,arr:null,dep:null,doors:true,revenue:true},
   {k:'reverse',station:airport,berths:turn.berths,chosen:turn.berths[0],minTime:40}];
  t.phase='run';
  expect(computeDmi(s,t.id)?.next).toBe('浦东1_2航站楼');
  expect(computeDmi(s,t.id)?.dest).toBe('浦东1_2航站楼');
  t.phase='dwell';t.link=s.topo.berths[berth].link;
  expect(computeDmi(s,t.id)?.next).toBe('浦东1_2航站楼折');
  expect(computeDmi(s,t.id)?.dest).toBe('浦东1_2航站楼折');
  const departure=s.plan.trips.find(p=>p.from===airport&&p.revenue)!;
  const rev=t.tasks[1];
  t.tasks=[rev,{k:'stop',station:airport,berth:depBerth,trip:departure.id,arr:null,dep:s.t+60,doors:true,revenue:true},
   {k:'stop',station:departure.to,berth:platformBerth(s.topo,departure.to,'UP'),trip:departure.id,arr:null,dep:null,doors:true,revenue:true}];
  t.phase='run';
  expect(computeDmi(s,t.id)?.next).toBe('浦东1_2航站楼折');
  // still moving into the tail: not yet changed
  t.link=s.topo.berths[turn.berths[0]].link;
  expect(computeDmi(s,t.id)?.next).toBe('浦东1_2航站楼折');
  expect(computeDmi(s,t.id)?.dest).toBe('浦东1_2航站楼折');
  // standing in the tail, and pulling out to the departure platform: that platform's station
  t.phase='reversing';t.lastStation=airport;
  expect(computeDmi(s,t.id)?.next).toBe('浦东1_2航站楼');
  expect(computeDmi(s,t.id)?.dest).toBe('浦东1_2航站楼');
  t.tasks.shift();t.tbStage='depart';t.phase='run';setTripFromTasks(s,t);
  expect(computeDmi(s,t.id)?.next).toBe('浦东1_2航站楼');
  expect(computeDmi(s,t.id)?.dest).toBe('浦东1_2航站楼');
  // standing at the departure platform: the real terminus
  t.link=s.topo.berths[depBerth].link;t.phase='dwell';t.tbStage='none';
  expect(computeDmi(s,t.id)?.next).toBe(STATIONS[departure.to].dmiName??STATIONS[departure.to].name);
  const end=serviceEnd(s.plan,departure);
  expect(end).toBeDefined();
  expect(computeDmi(s,t.id)?.dest).toBe(STATIONS[end!].dmiName??STATIONS[end!].name);
  // stabled overnight in the tail: turned back there, the same until it stands at the platform
  t.link=s.topo.berths[turn.berths[0]].link;t.phase='run';t.tbStage='none';t.v=0;
  t.tasks=[{k:'stop',station:airport,berth:depBerth,trip:departure.id,arr:null,dep:s.t+3600,doors:true,revenue:true,stabledOut:true},
   {k:'stop',station:departure.to,berth:platformBerth(s.topo,departure.to,'UP'),trip:departure.id,arr:null,dep:null,doors:true,revenue:true}];
  expect(computeDmi(s,t.id)).toMatchObject({next:'浦东1_2航站楼',dest:'浦东1_2航站楼'});
  t.link=s.topo.berths[depBerth].link;
  expect(computeDmi(s,t.id)?.next).toBe(STATIONS[departure.to].dmiName??STATIONS[departure.to].name);
  t.tasks=[{k:'stop',station:airport,berth,trip:-1,arr:null,dep:null,doors:true,revenue:true}];t.destStation=airport;
  expect(computeDmi(s,t.id)?.next).toBe('浦东1_2航站楼');
  expect(computeDmi(s,t.id)?.dest).toBe('浦东1_2航站楼');
  const other=STATIONS.findIndex(st=>st.id==='SHR');
  t.tasks[0]={...t.tasks[0],k:'stop',station:other,berth:platformBerth(s.topo,other,'UP'),trip:-1,arr:null,dep:null,doors:true,revenue:true};
  t.destStation=other;
  expect(computeDmi(s,t.id)?.next).toBe(STATIONS[other].name);
  t.dmiPrev=null; t.dmiLog=[]; t.dmiContext=undefined; t.dmiQueue=[];
  dmiTick(s);
  expect(t.dmiLog.map(m=>m.m)).toEqual(['DMI激活']);
  s.t+=15;dmiTick(s);
  expect(t.dmiLog.map(m=>m.m)).toContain('定位已确认');
  s.t+=15;dmiTick(s);
  expect(t.dmiLog.map(m=>m.m)).toContain('ATPM模式可用');
  const n=t.dmiLog.length;dmiTick(s);expect(t.dmiLog).toHaveLength(n);
 });
 it('keeps train doors independent of PSD and shows PSD only on a platform',()=>{
  const s=new Sim({dayType:'weekday',dateLabel:'doors',startTime:14400,seed:7,noPossessions:true});
  const t=s.trainList[0],b=s.topo.berths[platformBerth(s.topo,12,'DN')];
  t.link=b.link;t.phase='run';t.v=8;t.doorsOpen=false;t.doorSide='';
  s.plat[b.platform].psd='open';
  expect(computeDmi(s,t.id)).toMatchObject({trainDoor:'closed',psd:'open'});
  t.doorsOpen=true;s.plat[b.platform].psd='closed';
  expect(computeDmi(s,t.id)).toMatchObject({trainDoor:'open',psd:'closed'});
  t.doorsOpen=false;t.doorLockedAt=s.t+12;
  expect(computeDmi(s,t.id)?.trainDoor).toBe('closing');
  t.vfault={kind:'door',sev:1,stage:'stuck',until:s.t+60,fault:-1,recover:false,car:1,door:1};
  s.plat[b.platform].psdFault=true;
  expect(computeDmi(s,t.id)).toMatchObject({trainDoor:'fault',psd:'fault'});
  t.link=s.topo.links.find(l=>l.platform<0&&l.track==='DN')!.id;
  expect(computeDmi(s,t.id)).toMatchObject({trainDoor:'fault',psd:'none'});
 });
 it('shows no fold for a platform change of ends and derives signs from each departure signal',()=>{
  const s=new Sim({dayType:'weekday',dateLabel:'platform',startTime:14400,seed:7,noPossessions:true});
  const t=s.trainList[0],turn=turnbackAt(s.topo,6,'UP')!;
  if(turn.kind!=='front')throw Error('front turnback');
  const trip=s.plan.trips.find(p=>p.dir==='DN'&&p.revenue)!;
  t.phase='reversing';t.link=s.topo.berths[turn.arrBerth].link;
  t.tasks=[{k:'reverse',station:6,berths:[turn.arrBerth],chosen:turn.arrBerth,minTime:30},
   {k:'stop',station:6,berth:turn.depBerth,trip:trip.id,arr:null,dep:s.t+60,doors:true,revenue:true},
   {k:'stop',station:7,berth:platformBerth(s.topo,7,'DN'),trip:trip.id,arr:null,dep:null,doors:true,revenue:true}];
  expect(computeDmi(s,t.id)?.next).toBe(STATIONS[7].name);
  expect(computeDmi(s,t.id)?.dest).not.toContain('折');
  for(const p of s.topo.platforms){
   const b=s.topo.berths.find(b=>b.platform===p.id&&!b.reverse)!;
   if(!b)continue;
   t.tasks=[{k:'stop',berth:b.id,station:b.station,trip:-1,arr:null,dep:s.t+28,doors:true,revenue:true}];
   t.dwellUntil=s.t+28;
   const board=computeDmi(s,t.id)!.departureBoard;
   expect(board, p.name).toBeDefined();expect(board!.signalOffset).toBeGreaterThanOrEqual(0);
   expect(board!.at).toBe(s.t+28);
  }
 });
 it('uses the ATS departure clock for both displays after a late arrival and retains it on departure',()=>{
  const s=new Sim({dayType:'weekday',dateLabel:'late-board',startTime:14400,seed:7,noPossessions:true});
  const t=s.trainList[0],b=s.topo.berths[platformBerth(s.topo,12,'DN')];
  t.link=b.link;t.off=b.offset;t.dir=b.dir;t.hist=[{link:b.link,dir:b.dir}];t.phase='dwell';
  const stop={k:'stop' as const,berth:b.id,station:b.station,trip:-1,arr:s.t-5,dep:s.t-15,doors:true,revenue:true};
  t.tasks=[stop];t.dwellUntil=s.t+14;t.departureDisplay=undefined;
  const d=computeDmi(s,t.id)!;expect(d.dep-s.t).toBe(14);expect(d.departureBoard!.at).toBe(d.dep);
  t.hold=true;t.dwellUntil+=9;expect(computeDmi(s,t.id)!.departureBoard).toMatchObject({at:t.dwellUntil,held:true});
  t.phase='run';t.tasks=[];t.departureDisplay={stop,at:t.dwellUntil,remaining:0,side:'L'};
  expect(computeDmi(s,t.id)).toMatchObject({dep:t.dwellUntil,departureBoard:{at:t.dwellUntil}});
 });
});

