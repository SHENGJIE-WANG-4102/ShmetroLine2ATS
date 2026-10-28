import { expect, it, vi } from 'vitest';
import type { StopTask, ReverseTask } from '../src/sim/model';

it('keeps a real Guanglan Road long turn on the platform', async () => {
  vi.stubEnv('ATS_LINE','2'); vi.resetModules();
  try {
    const {Sim}=await import('../src/sim/engine');
    const ats=await import('../src/sim/ats');
    const movement=await import('../src/sim/movement');
    const interlocking=await import('../src/sim/interlocking');
    const timetable=await import('../src/sim/timetable');
    const { plannedWaitLong }=await import('../src/sim/plannedWaitBerth');
    const { STATIONS }=await import('../src/data/current');
    const sim=new Sim({dayType:'weekday',date:'2026-10-19',dateLabel:'gll-platform',startTime:14400,
      seed:14201,noPossessions:true,randomFaults:0,autoDispatch:false,autoRadio:false});
    const station=STATIONS.findIndex(s=>s.id==='GLL');
    let selected: {a:typeof sim.plan.trips[number];d:typeof sim.plan.trips[number];
      block:typeof sim.plan.blocks[number];tasks:ReturnType<typeof timetable.blockTasks>;ai:number}|undefined;
    for (const block of sim.plan.blocks) {
      const live=block.trips.map(id=>sim.plan.trips[id]).filter(t=>!t.cancelled);
      for(let i=1;i<live.length;i++) {
        const a=live[i-1], d=live[i];
        const gap=d.stops[0].dep-a.stops.at(-1)!.arr;
        if(a.to!==station || d.from!==station || a.dir===d.dir || gap>2000 || !plannedWaitLong(sim.plan.dayType,a,d)) continue;
        const tasks=timetable.blockTasks(sim.topo,sim.plan,block);
        const ai=tasks.findIndex(t=>t.k==='stop'&&t.trip===a.id&&t.station===station);
        const st=tasks[ai], rev=tasks[ai+1], next=tasks[ai+2];
        if(st?.k!=='stop'||rev?.k!=='reverse'||next?.k!=='stop'||next.trip!==d.id
          ||sim.topo.berths[rev.chosen].kind!=='platform'||!rev.berths.every(id=>id===st.berth)) continue;
        selected={a,d,block,tasks,ai}; break;
      }
      if(selected) break;
    }
    expect(selected,'a real Guanglan long platform turn').toBeDefined();
    const {a,d,block,tasks,ai}=selected!;
    const stop=tasks[ai] as StopTask, reverse=tasks[ai+1] as ReverseTask;
    const berth=sim.topo.berths[stop.berth], platform=berth.platform;
    expect(reverse.berths).toEqual([berth.id]);
    for(const old of [...sim.trainList]) sim.removeTrain(old);
    for(const rid of [...sim.routes.keys()]) interlocking.releaseRoute(sim,rid);
    for(const b of sim.plan.blocks) sim.blockDone.add(b.id);
    const vehicle=[...sim.vehicles.keys()][0];
    const tr=ats.newTrain(sim,block,berth.link,berth.offset,berth.dir,
      [{link:berth.link,dir:berth.dir}],vehicle);
    block.train=tr.id;tr.tripId=a.id;tr.tasks=structuredClone(tasks.slice(ai));
    tr.stopDist=0;tr.load=300;sim.t=a.stops.at(-1)!.arr;
    movement.computeBody(sim,tr);movement.indexBodies(sim);interlocking.computeOccupancy(sim);
    let arriving=false, alighted=false, turned=false, waited=false;
    for(let i=0;i<21000 && sim.t<d.stops[0].dep-1;i++) {
      sim.step();
      const current=tr.tasks[0];
      if(current?.k==='stop'&&current.trip===a.id&&tr.phase==='dwell') {
        arriving=true; if(tr.load<1) alighted=true;
      }
      if(current?.k==='stop'&&current.trip===d.id&&tr.phase==='dwell') {
        turned=true;
        expect(tr.dir).toBe(-berth.dir);
        expect(sim.topo.links[tr.link].platform).toBe(platform);
        expect(current.turnbackWaitBerth).toBeUndefined();
        if(sim.t<d.stops[0].dep-10) waited=true;
      }
      expect(tr.tasks.some(t=>t.k==='stop'&&t.turnbackWaitBerth!==undefined)).toBe(false);
      expect(tr.eb,tr.ebReason).toBe(false);
    }
    const context=`${a.no}→${d.no}, t=${sim.t}, dep=${d.stops[0].dep}, phase=${tr.phase}, task=${JSON.stringify(tr.tasks[0])}`;
    expect(arriving,context).toBe(true);expect(alighted,context).toBe(true);
    expect(turned,context).toBe(true);expect(waited,context).toBe(true);
  } finally {vi.unstubAllEnvs();vi.resetModules();}
},60000);
