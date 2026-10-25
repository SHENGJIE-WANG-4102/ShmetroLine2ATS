import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import type {Sim as Simulator} from '../src/sim/engine';
import type {DayType,TrackDir} from '../src/sim/model';

describe('14号线官方窗口与完整交路',()=>{
 let Sim:typeof Simulator, data:typeof import('../src/data/current'), tt:typeof import('../src/sim/timetable');
 const sims=new Map<DayType,Simulator>();
 beforeAll(async()=>{vi.stubEnv('ATS_LINE','14');vi.resetModules();Sim=(await import('../src/sim/engine')).Sim;data=await import('../src/data/current');tt=await import('../src/sim/timetable');});
 afterAll(()=>{vi.unstubAllEnvs();vi.resetModules();});
 const get=(dayType:DayType)=>{if(!sims.has(dayType))sims.set(dayType,new Sim({dayType,dateLabel:'官方窗口',startTime:14400,seed:3}));return sims.get(dayType)!;};
 for(const dayType of ['weekday','weekend'] as const){
  it(`${dayType}：不丢服务、配线/库存/间隔全部可行`,()=>{
   const sim=get(dayType);
   const issues=tt.validatePlan(sim.planCtx,sim.plan);
   expect(issues.filter(issue=>issue.severity==='error')).toEqual([]);
   expect(issues.filter(issue=>issue.severity==='warn')).toEqual(dayType==='weekday'?[{
    severity:'warn',code:'UNASSIGNED',t:35100,text:'蓝天路热备无可行基地库存时隙，未开行该热备运用'
   }]:[]);
   const revenue=sim.plan.trips.filter(t=>t.revenue&&!t.cancelled);
   for(const trip of revenue)expect([[0,30],[30,0],[5,25],[25,5]]).toContainEqual([trip.from,trip.to]);
   expect(sim.plan.trips.every(t=>!t.cancelled)).toBe(true);
   for (const row of data.FIRST_LAST) for (const [key,dir,last] of [['firstE','DN',false],['firstW','UP',false],['lastE','DN',true],['lastW','UP',true]] as const) {
    const station=data.STATIONS.findIndex(s=>s.name===row.station), terminal=dir==='DN'?30:0;
    // Terminal entries in the source are arrivals for alighting. noBoard
    // excludes boarding at intermediate calls, not that terminal arrival.
    const clocks=revenue.filter(t=>t.dir===dir&&t.to===terminal).flatMap(t=>t.stops.filter(p=>p.st===station&&p.stop&&(station===terminal||!p.noBoard)).map(p=>station===terminal?p.arr:p.dep));
    const actual=last?Math.max(...clocks):Math.min(...clocks),[h,m]=row[key].split(':').map(Number);
    expect(Math.abs(actual-h*3600-m*60),`${row.station} ${key}`).toBeLessThanOrEqual(60);
   }
   if(dayType==='weekend')expect(revenue.some(t=>t.kind==='small')).toBe(false);
   else for(const dir of ['DN','UP'])expect(revenue.some(t=>t.dir===dir&&t.kind==='small')).toBe(true);
   for(const dir of ['DN','UP'] as const){
    const from=dir==='DN'?0:30,to=dir==='DN'?30:0;
    const first=revenue.filter(t=>t.dir===dir&&t.from===from&&t.to===to).sort((a,b)=>a.stops[0].dep-b.stops[0].dep)[0];
    expect(first.stops[0].dep).toBe(19800);
    const block=sim.plan.blocks[first.block];expect(block.start.kind).toBe('depot');
    if(block.start.kind==='depot')expect(sim.topo.depots[block.start.depot].station).toBe(from);
   }
  });
  it(`${dayType}：官方区段×方向×时间窗，中心测点车数偏差≤1列`,()=>{
   const sim=get(dayType), rows=data.OFFICIAL_HEADWAYS[dayType], report:string[]=[];
   for(const row of rows){
    if(!row.from||!row.to)continue;
    const clock=(v:string)=>{const [h,m]=v.split(':').map(Number);return h*3600+m*60;};
    const start=clock(row.from),end=clock(row.to);
    const directions:TrackDir[]=row.name.includes('往桂桥路')?['DN']:row.name.includes('往封浜')?['UP']:['DN','UP'];
    for(const [a,b,headway] of row.sections){
     if(typeof headway!=='number')continue;
     const from=data.STATIONS.findIndex(s=>s.id===a),to=data.STATIONS.findIndex(s=>s.id===b);
     const middle=(sim.topo.stations[from].chain+sim.topo.stations[to].chain)/2;
     // 每段按几何中心最近的营业站取同一测点，两方向共用，不按结果挑点。
     const station=sim.topo.stations.filter(s=>data.stationOpened(s.index)&&s.chain>Math.min(sim.topo.stations[from].chain,sim.topo.stations[to].chain)&&s.chain<Math.max(sim.topo.stations[from].chain,sim.topo.stations[to].chain))
      .sort((x,y)=>Math.abs(x.chain-middle)-Math.abs(y.chain-middle))[0];
     const expected=Math.round((end-start)/headway);
     for(const dir of directions){
      const count=sim.plan.trips.filter(t=>t.revenue&&!t.cancelled&&t.dir===dir&&t.to!==station.index)
       .filter(t=>t.stops.some(p=>p.st===station.index&&p.stop&&!p.noBoard&&p.dep>=start&&p.dep<end)).length;
      report.push(`${row.name} ${a}—${b} ${dir} @${station.name}: ${count}/${expected}`);
      expect(Math.abs(count-expected),report.at(-1)).toBeLessThanOrEqual(1);
     }
    }
   }
   console.log(report.join('\n'));
  });
  it(`${dayType}：三处过夜各一列，源端与夜间入位均有实际运用`,()=>{
   const sim=get(dayType),places=tt.overnightPlaces(sim.topo);
   expect(places.map(p=>data.STATIONS[p.station].id).sort()).toEqual(['CYL','HPN','YSL']);
   for(const p of places){
    expect(sim.plan.blocks.filter(b=>b.start.kind==='stable'&&b.start.station===p.station)).toHaveLength(1);
    expect(sim.plan.blocks.filter(b=>b.end.kind==='stable'&&b.end.station===p.station)).toHaveLength(1);
   }
  });
  it(`${dayType}：白天三处存车线热备有真实车底和进出位任务`,()=>{
   const sim=get(dayType), hot=tt.hotStandbyPlaces(sim.topo);
   for(const station of ['CYL','HPN','YSL']){
    const place=hot.find(p=>data.STATIONS[p.station].id===station)!;
    expect(place,station).toBeDefined();
    const duties=sim.plan.blocks.filter(b=>b.trips.some(id=>{
     const arrival=sim.plan.trips[id];
     return arrival.standby&&arrival.to===place.station&&!arrival.cancelled;
    }));
    expect(duties,station).toHaveLength(1);
    const block=duties[0], trips=block.trips.map(id=>sim.plan.trips[id]);
    const arrival=trips.find(t=>t.standby&&t.to===place.station)!;
    const departure=trips.find(t=>t.from===place.station&&t.dir!==arrival.dir)!;
    expect(arrival.revenue).toBe(false);
    expect(departure.revenue).toBe(false);
    expect(arrival.stops.at(-1)!.arr).toBeLessThan(11*3600);
    expect(departure.stops[0].dep).toBeGreaterThanOrEqual(22*3600);
    const tasks=tt.blockTasks(sim.topo,sim.plan,block);
    expect(tasks.some(t=>t.k==='reverse'&&t.berths.some(b=>sim.topo.berths[b].link===sim.topo.berths[place.berth].link))).toBe(true);
   }
  });
 }
 it('双休日日间网格对齐两处PIS的六个到站观测，保持七分钟而不追逐实拍瞬时间隔',()=>{
  const sim=get('weekend');
  for(const row of [
   {station:'ZR',dir:'DN',times:[19*3600+6*60+31,19*3600+13*60+31,19*3600+20*60+31]},
   {station:'PDD',dir:'UP',times:[19*3600+33*60+58,19*3600+40*60+47,19*3600+47*60+47]},
  ]){
   const station=data.STATIONS.findIndex(s=>s.id===row.station);
   const times=sim.plan.trips.filter(t=>t.revenue&&!t.cancelled&&t.dir===row.dir)
    .flatMap(t=>t.stops.filter(p=>p.st===station&&p.stop&&!p.noBoard).map(p=>p.arr));
   const matched=row.times.map(observed=>times.reduce((a,b)=>Math.abs(a-observed)<Math.abs(b-observed)?a:b));
   for(let i=0;i<matched.length;i++)expect(Math.abs(matched[i]-row.times[i]),`${row.station} 第${i+1}班`).toBeLessThanOrEqual(20);
   expect(matched[1]-matched[0]).toBeCloseTo(420,5);
   expect(matched[2]-matched[1]).toBeCloseTo(420,5);
  }
 });
 it('双休日早间并入不插短班、不留超过750秒的空档，首末班保持官方',()=>{
  const sim=get('weekend');
  for(const dir of ['DN','UP'] as const){
   const station=data.STATIONS.findIndex(s=>s.id===data.SIMULATION.timetable.reference![dir]);
   const calls=sim.plan.trips.filter(t=>t.revenue&&!t.cancelled&&t.dir===dir)
    .flatMap(t=>t.stops.filter(p=>p.st===station&&p.stop).map(p=>p.dep)).sort((a,b)=>a-b);
   const join=calls.findIndex(t=>t>=7*3600);
   for(let i=join-2;i<=join+2;i++){
    const gap=calls[i]-calls[i-1];
    expect(gap,`${dir} 并入间隔`).toBeGreaterThanOrEqual(420-.001);
    expect(gap,`${dir} 并入间隔`).toBeLessThanOrEqual(750);
   }
   const daytime=calls.filter(t=>t>=7*3600&&t<21*3600);
   const anchor=data.SIMULATION.timetable.serviceData.weekend.peaks.weekend[dir]!;
   for(let i=0;i<daytime.length;i++){
    expect((daytime[i]-anchor)/420).toBeCloseTo(Math.round((daytime[i]-anchor)/420),5);
    if(i)expect(daytime[i]-daytime[i-1]).toBeCloseTo(420,5);
   }
  }
 });
 it('未开通站不产生候车人，也不成为任何图定停车点',async()=>{
  const sim=get('weekday'),st=data.STATIONS.findIndex(s=>s.id==='LJL');
  expect(sim.plan.trips.flatMap(t=>t.stops.filter(p=>p.st===st)).every(p=>!p.stop)).toBe(true);
  expect(tt.buildStops(sim.planCtx,'DN',st,st+1,0,true,1)[0].stop).toBe(false);
  sim.t=8*3600;
  const {passengersTick}=await import('../src/sim/passengers');
  for(let i=0;i<100;i++)passengersTick(sim,1);
  expect(sim.possessions.every(p=>p.sections.length>0)).toBe(true);
  for(const platform of Object.values(sim.topo.stations[st].platforms))expect(sim.plat[platform].waiting).toBe(0);
 });
});
