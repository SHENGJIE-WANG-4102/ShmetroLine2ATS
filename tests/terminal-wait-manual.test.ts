import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sim as Simulator } from '../src/sim/engine';
import type { ReverseTask, StopTask } from '../src/sim/model';

describe('terminal waiting with a real manual departure', () => {
  let Sim: typeof Simulator;
  let ats: typeof import('../src/sim/ats');
  let movement: typeof import('../src/sim/movement');
  let interlocking: typeof import('../src/sim/interlocking');
  let timetable: typeof import('../src/sim/timetable');
  let arbitration: typeof import('../src/sim/resourceArbitration');
  let topology: typeof import('../src/sim/topology');
  let chooser: typeof import('../src/sim/plannedWaitBerth');
  let STANDBY_CALL: number;
  beforeAll(async () => {
    vi.stubEnv('ATS_LINE', '2'); vi.resetModules();
    Sim = (await import('../src/sim/engine')).Sim;
    ats = await import('../src/sim/ats');
    movement = await import('../src/sim/movement');
    interlocking = await import('../src/sim/interlocking');
    timetable = await import('../src/sim/timetable');
    arbitration = await import('../src/sim/resourceArbitration');
    topology = await import('../src/sim/topology');
    chooser = await import('../src/sim/plannedWaitBerth');
    STANDBY_CALL = (await import('../src/sim/model')).STANDBY_CALL;
  });
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  function fixture() {
    const sim = new Sim({ dayType:'weekday', date:'2026-10-19', dateLabel:'terminal-manual',
      startTime:14400, seed:14201, noPossessions:true, randomFaults:0, autoDispatch:false, autoRadio:false });
    let selected: { block: typeof sim.plan.blocks[number]; a: typeof sim.plan.trips[number];
      d: typeof sim.plan.trips[number]; tasks: ReturnType<typeof timetable.blockTasks>; reverseIndex: number } | undefined;
    for (const block of sim.plan.blocks) {
      const trips = block.trips.map(id => sim.plan.trips[id]).filter(t => !t.cancelled);
      for (let i = 1; i < trips.length; i++) {
        const a = trips[i-1], d = trips[i];
        if (a.to !== d.from || a.dir === d.dir || a.standby || d.stops[0].dep - a.stops.at(-1)!.arr < 600) continue;
        const tasks = timetable.blockTasks(sim.topo, sim.plan, block);
        const arrival = tasks.findIndex(t => t.k === 'stop' && t.trip === a.id && t.station === a.to);
        const ri = tasks.findIndex((t,index) => index > arrival && t.k === 'reverse');
        const reverse = tasks[ri], next = tasks[ri+1];
        if (arrival < 0 || reverse?.k !== 'reverse' || next?.k !== 'stop' || next.trip !== d.id) continue;
        const berth = sim.topo.berths[reverse.chosen];
        if (berth.kind !== 'tail' && berth.kind !== 'siding') continue;
        if (!chooser.plannedWaitBerth(sim.topo,a,d,tasks,ri,[berth.id],berth.id).safe) continue;
        selected = { block, a, d, tasks, reverseIndex:ri }; break;
      }
      if (selected) break;
    }
    expect(selected, 'a real two-line long turn with an independent tail').toBeDefined();
    const { block,a,d,tasks,reverseIndex } = selected!;
    const reverse = tasks[reverseIndex] as ReverseTask, berth = sim.topo.berths[reverse.chosen];
    for (const other of [...sim.trainList]) sim.removeTrain(other);
    for (const rid of [...sim.routes.keys()]) interlocking.releaseRoute(sim,rid);
    for (const b of sim.plan.blocks) sim.blockDone.add(b.id);
    sim.blockDone.delete(block.id);
    const vehicle = [...sim.vehicles.keys()][0];
    const tr = ats.newTrain(sim, block, berth.link, berth.offset, berth.dir,
      [{ link:berth.link, dir:berth.dir }], vehicle);
    block.train = tr.id;
    tr.tasks = structuredClone(tasks.slice(reverseIndex));
    tr.tripId = a.id; tr.stopDist = 0; tr.v = 0; tr.manual = false; tr.mode = 'DTO';
    sim.t = a.stops.at(-1)!.arr + 20;
    movement.computeBody(sim,tr); movement.indexBodies(sim); interlocking.computeOccupancy(sim);
    ats.updateTrainTasks(sim,tr);
    expect(tr.phase).toBe('reversing');
    expect((tr.tasks[1] as StopTask).turnbackWaitBerth).toBe(berth.id);
    sim.t = tr.dwellUntil; ats.updateTrainTasks(sim,tr);
    expect(tr.phase).toBe('run');
    const task = tr.tasks[0] as StopTask, call = d.stops[0].dep - STANDBY_CALL;
    expect(sim.t).toBeLessThan(call - 100);
    expect(arbitration.sourceReadyAt(sim,task,tr)).toBe(call);
    movement.computeBody(sim,tr); movement.indexBodies(sim); interlocking.computeOccupancy(sim);
    return {sim,tr,task,call,berth,block,a,d,tasks,reverseIndex};
  }

  it('consumes the wait during a commanded CM departure and does not stop a later AUTO handback', () => {
    const {sim,tr,call} = fixture();
    const tailLink = tr.link, tailOff = tr.off;
    expect(sim.command({c:'manual',train:tr.id,mode:'CM'}).ok).toBe(true);
    // A real dispatcher route (including its normal switch/lock work), not a
    // fabricated green signal or authority, permits the manual pull-out.
    movement.refreshAuthority(sim);
    const ahead = ats.signalAheadFrom(sim,tr.link,tr.off,tr.dir,Infinity);
    expect(ahead).toBeTruthy();
    const next = tr.tasks[0] as StopTask;
    const rid = sim.routeTable.next.get(next.berth)?.[ahead!.sig] ?? -1;
    expect(rid).toBeGreaterThanOrEqual(0);
    const route = sim.command({c:'setRoute',route:rid});
    expect(route.ok,route.msg).toBe(true);
    expect(sim.drive(tr.id,1)).toBe(true);
    let notch = 1;
    for (let i=0;i<3000 && tr.link===tailLink;i++) {
      const nextNotch = tr.v > 1.4 ? 0 : tr.v < 0.8 ? 1 : notch;
      if (nextNotch !== notch) { expect(sim.drive(tr.id,nextNotch)).toBe(true); notch = nextNotch; }
      sim.step();
      expect(tr.eb,tr.ebReason).toBe(false);
    }
    expect(tr.link, `tail movement: off=${tr.off}, original=${tailOff}, v=${tr.v}, MA=${tr.maReason}`).not.toBe(tailLink);
    expect(sim.t).toBeLessThan(call);
    expect((tr.tasks[0] as StopTask).turnbackWaitBerth).toBeUndefined();
    expect(sim.drive(tr.id,0)).toBe(true);
    const handback = sim.command({c:'manual',train:tr.id,mode:'AUTO'});
    expect(handback.ok,handback.msg).toBe(true);
    const scan = movement.scanAhead(sim,tr,(tr.tasks[0] as StopTask).berth);
    expect(scan.maReason).not.toBe('折返线图定候班');
    expect(tr.eb,tr.ebReason).toBe(false);
    const inputs = sim.inputLog.map(x => 'cmd' in x ? x.cmd.c : 'drive' in x ? 'drive' : 'other');
    expect(inputs[0]).toBe('manual');
    expect(inputs).toContain('setRoute'); expect(inputs).toContain('drive');
    expect(inputs.at(-1)).toBe('manual');
  });

  it('arbitrates the other safe tail when a real train occupies the preferred tail', async () => {
    vi.stubEnv('ATS_LINE','14'); vi.resetModules();
    const LineSim = (await import('../src/sim/engine')).Sim;
    const lineAts = await import('../src/sim/ats');
    const lineMovement = await import('../src/sim/movement');
    const lineInterlocking = await import('../src/sim/interlocking');
    const lineTimetable = await import('../src/sim/timetable');
    const lineArbitration = await import('../src/sim/resourceArbitration');
    const sim = new LineSim({ dayType:'weekend', date:'2026-10-24', dateLabel:'terminal-choice',
      startTime:14400, seed:14201, noPossessions:true, randomFaults:0, autoDispatch:false, autoRadio:false });
    const a = sim.plan.trips.find(t => t.no === '0001')!;
    const d = sim.plan.trips.find(t => t.no === '1004')!;
    const block = sim.plan.blocks[d.block];
    const tasks = lineTimetable.blockTasks(sim.topo,sim.plan,block);
    const arrivalIndex = tasks.findIndex(t => t.k === 'stop' && t.trip === a.id && t.station === a.to);
    const reverseIndex = tasks.findIndex((t,i) => i > arrivalIndex && t.k === 'reverse');
    for (const other of [...sim.trainList]) sim.removeTrain(other);
    for (const rid of [...sim.routes.keys()]) lineInterlocking.releaseRoute(sim,rid);
    for (const b of sim.plan.blocks) sim.blockDone.add(b.id);
    const vehicle = [...sim.vehicles.keys()][0];
    const initial = sim.topo.berths[(tasks[reverseIndex] as ReverseTask).chosen];
    const tr = lineAts.newTrain(sim,block,initial.link,initial.offset,initial.dir,
      [{link:initial.link,dir:initial.dir}],vehicle);
    sim.t = a.stops.at(-1)!.arr + 20;
    const reverse = tasks[reverseIndex] as ReverseTask;
    const stop = tasks[arrivalIndex] as StopTask;
    const platform = sim.topo.berths[stop.berth];
    const occupied = sim.topo.berths[reverse.chosen];
    const alternative = reverse.berths.find(id => id !== occupied.id)!;
    expect(topology.safeWaitingPoint(sim.topo,occupied.id,tr.len)).toBe(true);
    expect(topology.safeWaitingPoint(sim.topo,alternative,tr.len)).toBe(true);
    Object.assign(tr, { link: platform.link, off: platform.offset, dir: platform.dir,
      hist: [{link:platform.link,dir:platform.dir}], phase:'dwell', doorsOpen:false,
      doorsAwait:false, doorSide:'', doorMotion:undefined, doorLockedAt:0,
      dwellUntil:sim.t-1, depReadyAt:sim.t-1, lastStation:a.to });
    tr.tasks = structuredClone(tasks.slice(arrivalIndex));
    const holder = lineAts.newTrain(sim,null,occupied.link,occupied.offset,occupied.dir,
      [{link:occupied.link,dir:occupied.dir}],tr.vehicle);
    holder.tasks = []; holder.phase = 'run';
    lineMovement.computeBody(sim,tr); lineMovement.computeBody(sim,holder);
    lineMovement.indexBodies(sim); lineInterlocking.computeOccupancy(sim);
    lineMovement.refreshAuthority(sim);
    // A separately dispatched route on another part of the real line must
    // survive the allocator's decision unchanged.
    const unrelated = sim.topo.routes.find(r => Math.abs(sim.topo.signals[r.start].station - a.to) > 3
      && sim.command({c:'setRoute',route:r.id}).ok);
    expect(unrelated).toBeDefined();
    const beforeRoutes = [...sim.routes.keys()];
    const beforeRoute = structuredClone(sim.routes.get(unrelated!.id));
    const beforeSignalRoute = sim.sig[unrelated!.start].route;
    const holderBefore = {link:holder.link,off:holder.off,dir:holder.dir,maSigs:[...holder.maSigs]};
    const allocation = lineArbitration.arbitrateResources(sim);
    const decision = allocation.decisions.get(tr.id);
    expect(decision, 'arrival train has a real resource request').toBeDefined();
    expect(decision!.admitted, decision!.detail).toBe(true);
    expect((tr.tasks[1] as ReverseTask).chosen).toBe(alternative);
    expect(sim.berthRes.get(alternative)).toBe(tr.id);
    expect([...sim.routes.keys()]).toEqual(beforeRoutes);
    expect(sim.routes.get(unrelated!.id)).toEqual(beforeRoute);
    expect(sim.sig[unrelated!.start].route).toBe(beforeSignalRoute);
    expect(holder).toMatchObject(holderBefore);
  });

  it('runs the 1063 to 1084 turn from alighting through the tail and its scheduled call', async () => {
    vi.stubEnv('ATS_LINE','14'); vi.resetModules();
    const LineSim = (await import('../src/sim/engine')).Sim;
    const lineAts = await import('../src/sim/ats');
    const lineMovement = await import('../src/sim/movement');
    const lineInterlocking = await import('../src/sim/interlocking');
    const lineTimetable = await import('../src/sim/timetable');
    const lineArbitration = await import('../src/sim/resourceArbitration');
    const sim = new LineSim({ dayType:'weekday', date:'2026-10-19', dateLabel:'1063-1084',
      startTime:14400, seed:14201, noPossessions:true, randomFaults:0, autoDispatch:false, autoRadio:false });
    const a=sim.plan.trips.find(t => t.no==='1063')!;
    const d=sim.plan.trips.find(t => t.no==='1084')!;
    expect(a).toBeDefined(); expect(d).toBeDefined();
    const block=sim.plan.blocks[a.block];
    expect(block.trips.indexOf(d.id)).toBe(block.trips.indexOf(a.id)+1);
    const tasks=lineTimetable.blockTasks(sim.topo,sim.plan,block);
    const ai=tasks.findIndex(t => t.k==='stop' && t.trip===a.id && t.station===a.to);
    const arrival=tasks[ai] as StopTask, platform=sim.topo.berths[arrival.berth];
    const reverse=tasks[ai+1] as ReverseTask;
    expect(reverse.k).toBe('reverse');
    const tail=sim.topo.berths[reverse.chosen];
    expect(['tail','siding']).toContain(tail.kind);
    for(const old of [...sim.trainList]) sim.removeTrain(old);
    for(const rid of [...sim.routes.keys()]) lineInterlocking.releaseRoute(sim,rid);
    for(const b of sim.plan.blocks) sim.blockDone.add(b.id);
    const vehicle=[...sim.vehicles.keys()][0];
    sim.vehicles.get(vehicle)!.uto={stage:'ready',until:0,cycles:0};
    const tr=lineAts.newTrain(sim,block,platform.link,platform.offset,platform.dir,
      [{link:platform.link,dir:platform.dir}],vehicle);
    block.train=tr.id; tr.tripId=a.id; tr.tasks=structuredClone(tasks.slice(ai));
    tr.stopDist=0; tr.load=300; sim.t=a.stops.at(-1)!.arr;
    lineMovement.computeBody(sim,tr); lineMovement.indexBodies(sim); lineInterlocking.computeOccupancy(sim);
    let arrivalSeen=false, alighted=false, tailSeen=false, waited=false, callDeparted=false, departurePlatform=false;
    let waitBegan=-1, movedAt=-1, intoTailRoute=false, outTailRoute=false;
    const call=d.stops[0].dep-STANDBY_CALL;
    for(let i=0;i<20000 && sim.t<d.stops[0].dep+300;i++) {
      sim.step();
      if(tr.phase==='dwell' && tr.tasks[0]?.k==='stop' && tr.tasks[0].trip===a.id) {
        arrivalSeen=true; if(tr.load<1) alighted=true;
      }
      if(tr.tasks[0]?.k==='reverse' && tr.maSigs.some(sig => sim.sig[sig].route>=0)) intoTailRoute=true;
      if(waited && sim.t>=call && tr.maSigs.some(sig => sim.sig[sig].route>=0)) outTailRoute=true;
      const marked=tr.tasks.find(t => t.k==='stop' && t.trip===d.id) as StopTask | undefined;
      if(marked?.turnbackWaitBerth!==undefined && tr.phase==='run') {
        tailSeen=true;
        if(lineArbitration.sourceReadyAt(sim,marked,tr)===call && tr.v<0.05) {
          waited=true; if(waitBegan<0) waitBegan=sim.t;
        }
      }
      if(waited && movedAt<0 && tr.v>=0.05) {movedAt=sim.t; callDeparted=true;}
      if(callDeparted && tr.phase==='dwell' && tr.tasks[0]?.k==='stop' && tr.tasks[0].trip===d.id) {
        departurePlatform=true; break;
      }
      expect(tr.eb,tr.ebReason).toBe(false);
    }
    const status=`t=${sim.t} call=${call} phase=${tr.phase} task=${JSON.stringify(tr.tasks[0])} link=${tr.link} off=${tr.off} v=${tr.v} reason=${tr.maReason} wait=${tr.arsWait?.detail}`;
    expect(arrivalSeen,status).toBe(true); expect(alighted,status).toBe(true);
    expect(tailSeen,status).toBe(true); expect(waited,status).toBe(true);
    expect(callDeparted,status).toBe(true); expect(movedAt,status).toBeGreaterThanOrEqual(call);
    expect(waitBegan,status).toBeLessThan(call-100);
    expect(departurePlatform,status).toBe(true);
    expect(intoTailRoute,status).toBe(true); expect(outTailRoute,status).toBe(true);
  },60000);

  it('does not apply the new wait to a changed unsafe body or a different physical platform', () => {
    const {sim,tr,task,call,berth} = fixture();
    expect(arbitration.sourceReadyAt(sim,task,tr)).toBe(call);
    const originalLength = tr.len;
    tr.len = sim.topo.links[tr.link].len + 500;
    expect(arbitration.sourceReadyAt(sim,task,tr)).toBe(-Infinity);
    tr.len = originalLength;
    const platform = sim.topo.berths.find(b => b.kind === 'platform' && b.station !== berth.station)!;
    tr.link=platform.link; tr.off=platform.offset; tr.dir=platform.dir;
    tr.hist=[{link:platform.link,dir:platform.dir}];
    movement.computeBody(sim,tr);
    expect(arbitration.sourceReadyAt(sim,task,tr)).toBe(-Infinity);
    // A genuine geometrically safe tail at another station cannot inherit
    // this stale marker just because lastStation still has its old value.
    const otherTail = sim.topo.berths.find(b => (b.kind === 'tail' || b.kind === 'siding')
      && b.station !== berth.station
      && topology.safeWaitingPoint(sim.topo,b.id,tr.len));
    expect(otherTail).toBeDefined();
    tr.link=otherTail!.link; tr.off=otherTail!.offset; tr.dir=otherTail!.dir;
    tr.hist=[{link:otherTail!.link,dir:otherTail!.dir}];
    movement.computeBody(sim,tr);
    expect(tr.lastStation).toBe(berth.station);
    expect(topology.safeWaitingPoint(sim.topo,{link:tr.link,off:tr.off,dir:tr.dir,incoming:tr.hist},tr.len)).toBe(true);
    expect(arbitration.sourceReadyAt(sim,task,tr)).toBe(-Infinity);
  });
});
