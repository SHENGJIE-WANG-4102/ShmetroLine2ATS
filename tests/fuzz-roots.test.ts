import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { capture, restore, type Checkpoint } from '../src/sim/state';
import { berthBusy, berthHolder, cancelArsRoute, routeFaultCode, runARS, routeBlocker, updateTrainTasks, signalAheadFrom, newTrain } from '../src/sim/ats';
import { cancelRoute, committedTrain, computeOccupancy, releaseRoute, trySetRoute, updateInterlocking, signalPassed } from '../src/sim/interlocking';
import { computeBody, indexBodies, scanAhead, stopError, updateTrainMotion, withdrawAuthority } from '../src/sim/movement';
import { canAcceptRestriction, signalStopDistance, restrictionDistance, canStopBeforeSignal, restrictionDistanceAt, type RestrictionBrake } from '../src/sim/protection';
import { checkSafety, checkLiveness } from '../src/sim/invariants';
import { updateHalts } from '../src/sim/halt';
import { faultProcedure } from '../src/sim/faults';
import { generatePlan, overnightPlaces, platformBerth, turnbackAt, validatePlan, departureBerthAfterReverse } from '../src/sim/timetable';
import { carryWorld, nextOperatingConfig } from '../src/sim/operatingDay';
import { PERF } from '../src/sim/dynamics';
import { WEATHER_RULES, LINE_INFO } from '../src/data/current';
import { validateCommand } from '../src/sim/commands';
import type { Command } from '../src/sim/model';
import { openCall } from '../src/sim/radio';
import { allowed, TURNBACK } from '../src/sim/fsm';
import { arbitrateResources, collectResourceRequests, routePhysicalPredecessors, routeResourceBlocker, resourceAdmissionBlocked, resourceAllocation, type ResourceRequest } from '../src/sim/resourceArbitration';
import { blockTasks, depotTasks } from '../src/sim/timetable';
import { reversedBerthPoint, downstreamTerminal, orderedStations, safeWaitingPoint, buildTopology, linkChain, travelDirection, type Dir, type Topology } from '../src/sim/topology';
import { profileOf, chainSense, gradeAccelAt, G, type Profile } from '../src/sim/gradient';

let checkpoint: Checkpoint | undefined;
function fixture(keepThird = false) {
  const sim = new Sim({dayType:'weekday', date:'2026-10-19', dateLabel:'roots', startTime:14400, seed:7, noPossessions:true});
  if (checkpoint) restore(sim, checkpoint);
  else { for (let i=0;i<20;i++) sim.step(); checkpoint=capture(sim); }
  const [front, rear, third] = sim.trainList;
  for (const tr of [...sim.trainList]) if (tr !== front && tr !== rear && !(keepThird && tr === third)) sim.removeTrain(tr);
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
  return {sim,front,rear,third,signal,link};
}

describe('whole-movement resource admission', () => {
  it('does not invent a physical predecessor when an alternate route to the same berth is free', () => {
    const sim=new Sim({dayType:'weekday',dateLabel:'physical-route-or',startTime:14400,seed:7,noPossessions:true});
    for(const tr of [...sim.trainList])sim.removeTrain(tr);
    const signal=sim.topo.signals.find(s=>s.name==='X0905')!;
    const goal=sim.topo.berths.find(b=>b.name==='江苏路 下行站台')!;
    const straight=sim.topo.routes.find(r=>r.name==='X0905→X0911')!;
    const side=sim.topo.routes.find(r=>r.name==='X0905→X0911(侧向)')!;
    expect(sim.routeTable.next.get(goal.id)![signal.id]).toBe(straight.id);
    const first=sim.topo.links.find(l=>sim.topo.sections[l.section].name==='G0909')!;
    const second=sim.topo.links.find(l=>sim.topo.sections[l.section].name==='G0910')!;
    expect(straight.sections).toContain(first.section);expect(side.sections).not.toContain(first.section);
    const applicant=newTrain(sim,null,signal.link,0,signal.dir,[{link:signal.link,dir:signal.dir}],'applicant');
    applicant.nextSignal=signal.id;applicant.len=10;
    expect(routePhysicalPredecessors(sim,applicant,sim.topo.berths.length)).toEqual([]);
    const blocker=newTrain(sim,null,first.id,70,1,[{link:first.id,dir:1}],'first-blocker');blocker.len=10;
    const origin=(dep:number)=>({k:'stop' as const,berth:goal.id,station:goal.station,trip:-1,arr:null,dep,doors:false,revenue:false});
    applicant.tasks=[origin(sim.t+10)];blocker.tasks=[origin(sim.t+20)];
    const request:ResourceRequest={id:blocker.id,train:blocker,tasks:blocker.tasks,inside:true,safeHere:true,committed:false,
      time:sim.t,readyAt:sim.t,options:[{phases:[{goal:goal.id,start:{link:first.id,off:70,dir:1},routes:[],
        path:[{link:goal.link,from:0,to:goal.offset}],distance:100}],sections:new Set([first.section]),
        choices:[{index:0,berth:goal.id}],resourceLinks:new Set()}]};
    computeBody(sim,applicant);computeBody(sim,blocker);indexBodies(sim);computeOccupancy(sim);
    expect(routePhysicalPredecessors(sim,applicant,goal.id)).toEqual([]);
    expect(arbitrateResources(sim,[request]).decisions.get(blocker.id)).toMatchObject({admitted:false,code:'REGULATION',blocker:applicant.id});
    const other=newTrain(sim,null,second.id,20,1,[{link:second.id,dir:1}],'second-blocker');other.len=10;
    computeBody(sim,other);indexBodies(sim);computeOccupancy(sim);
    expect(new Set(routePhysicalPredecessors(sim,applicant,goal.id))).toEqual(new Set([blocker.id,other.id]));
    expect(arbitrateResources(sim,[request]).decisions.get(blocker.id)).toMatchObject({admitted:true});
  });
  it('lets the physical predecessor clear when an earlier ordinary origin is blocked at its first route', () => {
    const sim=new Sim({dayType:'weekend',date:'2026-10-24',dateLabel:'physical-origin',startTime:14400,seed:7,noPossessions:true});
    for(const tr of [...sim.trainList])sim.removeTrain(tr);
    for(const block of sim.plan.blocks)sim.blockDone.add(block.id);
    const depot=sim.topo.depots.find(d=>d.key==='CSD')!,station=depot.station;
    const link=(name:string)=>sim.topo.links.find(l=>sim.topo.sections[l.section].name===name)!;
    const signal=(name:string)=>sim.topo.signals.find(s=>s.name===name)!;
    const a=link('G2919'),b=link('G2927');expect(a).toBeDefined();expect(b).toBeDefined();
    const front=newTrain(sim,null,a.id,6.35,-1,[{link:a.id,dir:-1}],'front');
    const rear=newTrain(sim,null,b.id,5,-1,[{link:b.id,dir:-1}],'rear');
    const goal=platformBerth(sim.topo,station,'UP');sim.t=80608;
    const stop=(dep:number)=>({k:'stop' as const,berth:goal,station,trip:-1,arr:dep,dep,doors:false,revenue:false});
    Object.assign(front,{tasks:[stop(72447)],nextSignal:signal('S2916').id,nextSignalDist:.35,phase:'run',maCode:'ROUTE_WAIT',maTrain:-1});
    Object.assign(rear,{tasks:[stop(69826)],nextSignal:signal('DCSD2').id,nextSignalDist:0,phase:'run',maCode:'ROUTE_WAIT',maTrain:-1});
    computeBody(sim,front);computeBody(sim,rear);indexBodies(sim);computeOccupancy(sim);
    expect(collectResourceRequests(sim).some(r=>r.id===rear.id)).toBe(false);
    expect(arbitrateResources(sim).decisions.get(front.id)).toMatchObject({admitted:true});
  });
  it('preserves the complete admission rejection cause through ARS at its current entrance', () => {
    const { sim, front, rear, third, signal } = fixture(true); sim.resourceTransit.clear();
    const depot = sim.topo.depots[0];
    front.tasks = [{ k: 'depot', depot: depot.id }];
    for (const [train, berthId] of [[rear, depot.entryBerths[0]], [third, depot.entryBerths[1]]] as const) {
      const berth = sim.topo.berths[berthId];
      Object.assign(train, { link: berth.link, off: berth.offset, dir: berth.dir,
        hist: [{ link: berth.link, dir: berth.dir }], phase: 'stabled', tasks: [], v: 0, maSigs: [] });
      computeBody(sim, train);
    }
    indexBodies(sim); computeOccupancy(sim);
    const decision = arbitrateResources(sim).decisions.get(front.id)!;
    expect(decision).toBeDefined();
    expect(decision.admitted).toBe(false);
    expect([rear.id, third.id]).toContain(decision.blocker);
    expect(decision.code).toBe('BERTH_WAIT');
    expect(decision.detail).not.toBe('');
    expect(decision.option.entry).toBe(signal.id);
    runARS(sim, true);
    expect(front.arsWait).toMatchObject({ code: decision.code, train: decision.blocker,
      detail: decision.detail, entrySignal: signal.id, t: sim.t });
    expect(sim.integrity.violations).toEqual([]);
  });

  it.each([true, false])('orders only executable virtual sources ahead of independent-tail occupants (%s blocked)', (blocked) => {
    const { sim, front, rear } = fixture(); sim.resourceTransit.clear();
    const station = downstreamTerminal('DN'), tails = sim.topo.stations[station].turnbackBerths;
    const first = sim.topo.berths[tails[0]], second = sim.topo.berths[tails[1]];
    const goal = sim.topo.berths[platformBerth(sim.topo, station, 'UP')];
    const origin = (dep: number) => ({ k: 'stop' as const, berth: goal.id, station, trip: -1,
      arr: null, dep: sim.t + dep, doors: false, revenue: false });
    for (const [train, berth, dep] of [[front, first, 100], [rear, second, 200]] as const) {
      const point = reversedBerthPoint(sim.topo, berth.id, train.len)!;
      Object.assign(train, { ...point, hist: [{ link: point.link, dir: point.dir }], tasks: [origin(dep)], phase: 'run', v: 0,
        maSigs: [], maTrain: -1, intervalWait: undefined });
      computeBody(sim, train);
    }
    indexBodies(sim); computeOccupancy(sim);
    const virtualOrigin = origin(50);
    const request = (id: number, train: typeof front | undefined, task: typeof virtualOrigin, inside: boolean): ResourceRequest => ({
      id, train, tasks: [task], inside, safeHere: inside, committed: false, readyAt: sim.t, time: sim.t, origin: task,
      options: [{ phases: [{ goal: goal.id, start: { link: goal.link, off: sim.topo.links[goal.link].len, dir: goal.dir },
        routes: [], path: [{ link: goal.link, from: sim.topo.links[goal.link].len, to: goal.offset }], distance: 12 }],
        sections: new Set([sim.topo.links[goal.link].section]), choices: [{ index: 0, berth: goal.id }], resourceLinks: new Set() }],
    });
    const frontRequest = request(front.id, front, front.tasks[0] as typeof virtualOrigin, true);
    const rearRequest = request(rear.id, rear, rear.tasks[0] as typeof virtualOrigin, true);
    const virtual = request(-42, undefined, virtualOrigin, false);
    if (blocked) {
      const body = rear.body[0];
      virtual.options[0].phases.unshift({ goal: second.id, start: { link: body.link, off: body.from, dir: 1 },
        routes: [], path: [{ link: body.link, from: body.from, to: body.to }], distance: body.to - body.from });
      virtual.options[0].sections.add(sim.topo.links[body.link].section);
    }
    expect(sim.plan.blocks[41].svc).toBe('042');
    const result = arbitrateResources(sim, [frontRequest, rearRequest, virtual]);
    if (blocked) {
      expect(result.decisions.get(front.id)?.admitted).toBe(true);
      expect(result.decisions.get(rear.id)).toMatchObject({ admitted: false, blocker: front.id });
      expect(result.decisions.get(-42)).toMatchObject({ admitted: false, blocker: rear.id, code: 'BERTH_WAIT' });
    } else {
      expect(result.decisions.get(-42)?.admitted).toBe(true);
      expect(result.decisions.get(front.id)).toMatchObject({ admitted: false, blocker: -42, code: 'REGULATION' });
      expect(result.decisions.get(front.id)?.detail).toContain('042');
    }
    expect(sim.integrity.violations).toEqual([]);
  });

  it.each(['unset', 'own-unused', 'other-unused', 'other-owned'] as const)('does not bind a distant resource entrance without a current whole-movement grant (%s)', (existing) => {
    const { sim, front, rear } = fixture(); sim.resourceTransit.clear();
    const station = orderedStations('UP').find(st => turnbackAt(sim.topo, st, 'UP')?.kind === 'front' && orderedStations('DN', st).length > 2)!;
    const turn = turnbackAt(sim.topo, station, 'UP')!;
    if (turn.kind !== 'front') throw new Error('expected front-turn resource');
    const approachStation = orderedStations('DN', station)[2];
    const start = sim.topo.berths[platformBerth(sim.topo, approachStation, 'UP')];
    Object.assign(front, { link: start.link, off: start.offset, dir: start.dir, hist: [{ link: start.link, dir: start.dir }],
      tasks: [{ k: 'stop', berth: turn.arrBerth, station, trip: -1, arr: null, dep: null, doors: false, revenue: false },
        { k: 'reverse', berths: [turn.arrBerth], chosen: turn.arrBerth, station, minTime: 40 },
        { k: 'stop', berth: turn.depBerth, station, trip: -1, arr: null, dep: sim.t + 500, doors: false, revenue: false },
        { k: 'stop', berth: platformBerth(sim.topo, approachStation, 'DN'), station: approachStation, trip: -1,
          arr: null, dep: null, doors: false, revenue: false }], phase: 'run', v: 0 });
    rear.phase = 'stabled'; rear.tasks = [];
    computeBody(sim, front); indexBodies(sim); computeOccupancy(sim);
    const next = signalAheadFrom(sim, front.link, front.off, front.dir, Infinity)!;
    front.nextSignal = next.sig; front.nextSignalDist = next.dist;
    const allocation = arbitrateResources(sim);
    expect(allocation.decisions.has(front.id)).toBe(false);
    expect(allocation.claims.size).toBe(0);
    const entrance = sim.topo.routes.find(r => resourceAdmissionBlocked(sim, front, r.id)
      && r.sections.every(s => !sim.sec[s].trainOcc) && trySetRoute(sim, r.id, { train: front.id }).ok)!;
    expect(entrance).toBeDefined();
    if (existing === 'unset') releaseRoute(sim, entrance.id);
    else if (existing === 'other-owned' || existing === 'other-unused') {
      const active = sim.routes.get(entrance.id)!;
      active.arsTrain = rear.id; active.owner = rear.id; active.entered = existing === 'other-owned';
    }
    runARS(sim, true);
    expect(resourceAdmissionBlocked(sim, front, entrance.id)).toBe(true);
    expect(resourceAllocation(sim).claims.size).toBe(0);
    if (existing === 'other-owned' || existing === 'other-unused') expect(sim.routes.get(entrance.id)).toMatchObject({ arsTrain: rear.id, owner: rear.id, entered: existing === 'other-owned', cancelAt: 0 });
    else expect(sim.routes.has(entrance.id)).toBe(false);
    expect(sim.integrity.violations).toEqual([]);
  });

  it('retries an unselected reverse after its occupied alternative clears', () => {
    const { sim, front, rear } = fixture(); sim.resourceTransit.clear();
    const station = downstreamTerminal('UP'), tail = sim.topo.berths[sim.topo.stations[station].turnbackBerths[0]];
    const arrival = sim.topo.berths[platformBerth(sim.topo, station, 'UP')];
    Object.assign(front, { link: arrival.link, off: arrival.offset, dir: arrival.dir,
      hist: [{ link: arrival.link, dir: arrival.dir }], phase: 'run', v: 0, tasks: [
        { k: 'reverse', chosen: -1, berths: [tail.id], station, minTime: 40 },
        { k: 'stop', berth: platformBerth(sim.topo, station, 'DN'), station, trip: -1,
          arr: null, dep: sim.t + 300, doors: false, revenue: false },
      ] });
    Object.assign(rear, { link: tail.link, off: tail.offset, dir: tail.dir,
      hist: [{ link: tail.link, dir: tail.dir }], phase: 'stabled', v: 0 });
    for (const tr of [front, rear]) computeBody(sim, tr);
    indexBodies(sim); computeOccupancy(sim);
    const signal = signalAheadFrom(sim, front.link, front.off, front.dir, Infinity)!;
    front.nextSignal = signal.sig; front.nextSignalDist = signal.dist;
    const first = arbitrateResources(sim).decisions.get(front.id);
    expect(first).toMatchObject({ admitted: false, blocker: rear.id });
    expect(front.tasks[0]).toMatchObject({ k: 'reverse', chosen: -1 });
    sim.removeTrain(rear); indexBodies(sim); computeOccupancy(sim);
    expect(arbitrateResources(sim).decisions.get(front.id)?.admitted).toBe(true);
    expect(front.tasks[0]).toMatchObject({ k: 'reverse', chosen: tail.id });
    expect(sim.integrity.violations).toEqual([]);
  });
  it('keeps an ordinary single-train route without requiring a resource admission', () => {
    const { sim, front, rear, signal } = fixture(); sim.removeTrain(rear); sim.resourceTransit.clear();
    const task = front.tasks[0] as Extract<(typeof front.tasks)[number], { k: 'stop' }>;
    const rid = sim.routeTable.next.get(task.berth)![signal.id];
    expect(sim.topo.routes[rid].fleeting).toBe(true);
    expect(trySetRoute(sim, rid, { train: front.id }).ok).toBe(true);
    front.maSigs = [];
    runARS(sim);
    expect(sim.routes.has(rid)).toBe(true);
    expect(sim.routes.get(rid)).toMatchObject({ fleeting: false, arsTrain: front.id });
    expect(sim.integrity.violations).toEqual([]);
  });
  it('keeps moving-block following on a long ordinary route after the resource exit has been clipped inside it', () => {
    const { sim, front } = fixture();
    const route = sim.topo.routes.filter(r => r.fleeting && r.switches.length === 0
      && r.steps.some(s => sim.topo.sections[sim.topo.links[s.link].section].kind === 'plain'))
      .sort((a, b) => b.length - a.length)[0];
    const link = route.steps.map(s => sim.topo.links[s.link]).sort((a, b) => b.len - a.len)[0];
    const dir = route.steps.find(s => s.link === link.id)!.dir, goal = route.berths[0];
    Object.assign(front, { link: link.id, off: link.len / 2, dir, hist: [{ link: link.id, dir }], v: 0 });
    computeBody(sim, front); indexBodies(sim); computeOccupancy(sim);
    front.tasks = [{ k: 'stop', berth: goal, station: sim.topo.berths[goal].station, trip: -1,
      arr: null, dep: null, doors: false, revenue: false }];
    expect(trySetRoute(sim, route.id, { fleeting: true, train: front.id }).ok).toBe(true);
    const request: ResourceRequest = { id: front.id, train: front, tasks: front.tasks, inside: true,
      committed: false, readyAt: sim.t, time: sim.t, options: [{ phases: [{ goal,
        start: { link: front.link, off: front.off, dir: front.dir }, routes: [], distance: 10,
        path: [{ link: link.id, from: front.off, to: front.off + dir * 10 }] }],
        sections: new Set([link.section]), choices: [], resourceLinks: new Set(),
      }] };
    expect(arbitrateResources(sim, [request]).decisions.get(front.id)?.admitted).toBe(true);
    runARS(sim, true);
    expect(sim.routes.get(route.id)?.fleeting).toBe(true);
  });

  it('consumes an admitted automatic resource entrance for its own train without cancelling its issued authority', () => {
    const { sim, front } = fixture();
    const route = sim.topo.routes.find(r => r.fleeting && r.berths.length > 0
      && r.sections.every(s => !sim.sec[s].trainOcc) && trySetRoute(sim, r.id, { fleeting: true, train: front.id }).ok)!;
    expect(route).toBeDefined();
    const goal = route.berths[0];
    front.tasks = [{ k: 'stop', berth: goal, station: sim.topo.berths[goal].station, trip: -1,
      arr: null, dep: null, doors: false, revenue: false }];
    const request: ResourceRequest = { id: front.id, train: front, tasks: front.tasks, inside: false,
      committed: false, readyAt: sim.t, time: sim.t, options: [{ phases: [{ goal,
        start: { link: front.link, off: front.off, dir: front.dir }, routes: [route.id], distance: route.length,
        path: route.steps.map(s => ({ link: s.link, from: s.dir === 1 ? 0 : sim.topo.links[s.link].len,
          to: s.dir === 1 ? sim.topo.links[s.link].len : 0 })) }],
        sections: new Set(route.sections), choices: [], entry: route.start, resourceLinks: new Set([sim.topo.berths[goal].link]),
      }] };
    const before = { ma: front.maDist, sigs: [...front.maSigs] };
    expect(arbitrateResources(sim, [request]).decisions.get(front.id)?.admitted).toBe(true);
    runARS(sim, true);
    const active = sim.routes.get(route.id)!;
    expect(active).toMatchObject({ fleeting: false, entered: false, arsTrain: front.id });
    expect({ ma: front.maDist, sigs: front.maSigs }).toEqual(before);
    signalPassed(sim, front.id, route.start);
    expect(active).toMatchObject({ entered: true, owner: front.id });
  });
  it('reserves a future exit logically without binding its automatic route before the current phase', () => {
    const { sim, front } = fixture();
    const route = sim.topo.routes.find(r => r.fleeting && r.berths.length > 0
      && r.sections.every(s => !sim.sec[s].trainOcc) && trySetRoute(sim, r.id, { fleeting: true }).ok)!;
    expect(route).toBeDefined();
    const goal = route.berths[0], start = { link: front.link, off: front.off, dir: front.dir };
    front.tasks = [{ k: 'stop', berth: goal, station: sim.topo.berths[goal].station, trip: -1,
      arr: null, dep: null, doors: false, revenue: false }];
    const request: ResourceRequest = { id: front.id, train: front, tasks: front.tasks, inside: false,
      committed: false, readyAt: sim.t, time: sim.t, options: [{ phases: [
        { goal, start, routes: [], distance: 0, path: [] },
        { goal, start, routes: [route.id], distance: route.length,
          path: route.steps.map(s => ({ link: s.link, from: s.dir === 1 ? 0 : sim.topo.links[s.link].len,
            to: s.dir === 1 ? sim.topo.links[s.link].len : 0 })) },
      ], sections: new Set(route.sections), choices: [], entry: route.start,
      resourceLinks: new Set([sim.topo.berths[goal].link]),
    }] };
    expect(arbitrateResources(sim, [request]).decisions.get(front.id)?.admitted).toBe(true);
    runARS(sim, true);
    expect(sim.routes.get(route.id)).toMatchObject({ fleeting: true, entered: false });
    expect(sim.routes.get(route.id)?.resourceBound).toBeUndefined();
    expect(sim.integrity.violations).toEqual([]);
  });
  it.each([[false, 'run'], [false, 'dwell'], [true, 'run']] as const)('compares the current local departure, but never a later remote circulation (%s, %s)', (localTurn, phase) => {
    const { sim, front, rear } = fixture(); sim.resourceTransit.clear();
    const goal = sim.topo.berths[platformBerth(sim.topo, 3, 'UP')], terminal = downstreamTerminal('DN');
    const origin = { k: 'stop' as const, berth: goal.id, station: goal.station, trip: 900,
      arr: null, dep: sim.t + 200, doors: true, revenue: true };
    front.tasks = [origin]; rear.maTrain = -1; rear.intervalWait = undefined; rear.phase = phase;
    const start = sim.topo.berths[platformBerth(sim.topo, terminal, 'UP')];
    const remoteStation = orderedStations('UP', terminal)[2];
    const tail = sim.topo.stations[terminal].turnbackBerths[0];
    const departure = { ...origin, berth: start.id, station: terminal, trip: 901, dep: sim.t + 50 };
    rear.tasks = localTurn ? [
      { k: 'reverse', chosen: tail, berths: [tail], station: terminal, minTime: 40 },
      departure, { ...origin, trip: 901, arr: sim.t + 80, dep: sim.t + 100 },
    ] : [
      { ...origin, berth: platformBerth(sim.topo, remoteStation, 'DN'), station: remoteStation,
        trip: 902, arr: sim.t + 20, dep: sim.t + 30 },
      { ...departure, berth: platformBerth(sim.topo, terminal, 'DN'), trip: 902, dep: null },
      { k: 'reverse', chosen: tail, berths: [tail], station: terminal, minTime: 40 },
      departure, { ...origin, trip: 901, arr: sim.t + 80, dep: sim.t + 100 },
    ];
    const request: ResourceRequest = { id: front.id, train: front, tasks: front.tasks, inside: true, safeHere: true,
      committed: false, readyAt: sim.t, time: sim.t, origin, options: [{
        phases: [{ goal: goal.id, start: { link: front.link, off: front.off, dir: front.dir }, routes: [],
          path: [{ link: goal.link, from: sim.topo.links[goal.link].len, to: goal.offset }], distance: 100 }],
        sections: new Set([sim.topo.links[goal.link].section]), choices: [{ index: 0, berth: goal.id }],
      }] };
    const decision = arbitrateResources(sim, [request]).decisions.get(front.id)!;
    expect(decision.admitted).toBe(!localTurn);
    if (localTurn) expect(decision).toMatchObject({ code: 'REGULATION', blocker: rear.id });
  });

  it('finishes a platform-turn exit before inspecting a later cab change at another station', () => {
    const { sim, front, rear } = fixture(); sim.removeTrain(rear); sim.resourceTransit.clear();
    const tasks = sim.plan.blocks.map(b => blockTasks(sim.topo, sim.plan, b)).find(tasks => {
      const turns = tasks.flatMap((t, i) => t.k === 'reverse' && sim.topo.berths[t.chosen].kind === 'platform' ? [i] : []);
      return turns.length > 1 && tasks[turns[0] - 1]?.k === 'stop';
    })!;
    expect(tasks).toBeDefined();
    const index = tasks.findIndex(t => t.k === 'reverse' && sim.topo.berths[t.chosen].kind === 'platform');
    const task = tasks[index] as Extract<(typeof tasks)[number], { k: 'reverse' }>;
    const berth = sim.topo.berths[task.chosen], point = reversedBerthPoint(sim.topo, berth.id, front.len)!;
    // Stand at the source cab-change platform; its protected exit must not
    // depend on a later task after already reaching safe ordinary line.
    Object.assign(front, { link: berth.link, off: berth.offset, dir: berth.dir, hist: [{ link: berth.link, dir: berth.dir }],
      phase: 'reversing', tasks: structuredClone(tasks.slice(index)), v: 0 });
    const projected = front.tasks[1];
    if (projected.k === 'stop') projected.berth = departureBerthAfterReverse(sim.topo, berth.id, projected.berth);
    computeBody(sim, front); indexBodies(sim); computeOccupancy(sim);
    sim.resourceTransit.set(front.id, { entered: true, visited: true, option: {
      phases: [{ goal: berth.id, start: point, routes: [], path: [], distance: 0 }],
      sections: new Set([sim.topo.links[berth.link].section]), choices: [], resourceLinks: new Set([berth.link]),
    } });
    const request = collectResourceRequests(sim).find(r => r.id === front.id)!;
    expect(request).toBeDefined();
    const last = request.options[0].phases.at(-1)!;
    expect(last.path.at(-1)!.link).not.toBe(sim.topo.berths[last.goal].link);
    expect(request.options[0].choices.length).toBeLessThan(front.tasks.length);
  });
  it('releases its own unused downstream route together with denied whole-movement entry', () => {
    const { sim, rear } = fixture();
    const route = sim.topo.routes.find(r => r.wrongDir && r.sections.every(s => !sim.sec[s].trainOcc)
      && trySetRoute(sim, r.id, { train: rear.id }).ok)!;
    expect(route).toBeDefined(); sim.sig[route.start].autoPass = false;
    const goal = sim.topo.berths.find(b => b.kind === 'platform' && !sim.linkBodies.has(b.link))!;
    const request: ResourceRequest = { id: rear.id, train: rear, tasks: rear.tasks, inside: false, committed: false,
      readyAt: sim.t + 100, time: sim.t, options: [{ phases: [{ goal: goal.id,
        start: { link: rear.link, off: rear.off, dir: rear.dir }, routes: [route.id], path: [], distance: 0 }],
        sections: new Set(), choices: [] }] };
    expect(arbitrateResources(sim, [request]).decisions.get(rear.id)?.admitted).toBe(false);
    expect(sim.routes.has(route.id)).toBe(true);
    runARS(sim, true);
    expect(sim.routes.has(route.id)).toBe(false);
    expect(sim.integrity.violations).toEqual([]);
  });
  it('keeps an occupied depot source out of the applicant pool while its existing departure clears', () => {
    const { sim, front, rear } = fixture(); sim.removeTrain(rear); sim.resourceTransit.clear();
    const block = sim.plan.blocks.find(b => b.start.kind === 'depot' && sim.topo.depots[b.start.depot].transferPaths
      [sim.topo.depots[b.start.depot].portals.exit[sim.plan.trips[b.trips[0]].dir].path].flow === 'shared')!;
    if (block.start.kind !== 'depot') throw new Error('expected depot block');
    const depot = sim.topo.depots[block.start.depot], path = depot.transferPaths[depot.portals.exit[sim.plan.trips[block.trips[0]].dir].path];
    const gate = sim.topo.links[path.links[2]], link = sim.topo.nodes[gate.a].links.find(id => id !== gate.id)!;
    sim.t = Math.max(sim.t, block.start.time); sim.blockDone.delete(block.id); delete block.train;
    Object.assign(front, { link, off: 15, dir: -1, hist: [{ link, dir: -1 }], phase: 'run', v: 0,
      tasks: blockTasks(sim.topo, sim.plan, block) });
    computeBody(sim, front); indexBodies(sim); computeOccupancy(sim);
    expect(collectResourceRequests(sim).some(r => r.id === -(block.id + 1))).toBe(false);
    sim.removeTrain(front); indexBodies(sim); computeOccupancy(sim);
    expect(collectResourceRequests(sim).some(r => r.id === -(block.id + 1))).toBe(true);
  });

  it('does not treat a following body outside the scoped path as permission to enter the claim', () => {
    const { sim, front, rear } = fixture();
    const goal = sim.topo.berths.find(b => b.kind === 'platform' && !sim.linkBodies.has(b.link) && b.offset > 10)!;
    const request: ResourceRequest = { id: front.id, train: front, tasks: front.tasks, inside: true, committed: false,
      readyAt: sim.t, time: sim.t, options: [{ phases: [{ goal: goal.id,
        start: { link: front.link, off: front.off, dir: front.dir }, routes: [],
        path: [{ link: goal.link, from: 0, to: 10 }], distance: 10 }],
        sections: new Set([sim.topo.links[goal.link].section]), choices: [] }] };
    request.options[0].resourceLinks = new Set([goal.link]);
    rear.body = [{ link: goal.link, from: 20, to: 100 }];
    sim.linkBodies.set(goal.link, [{ train: rear.id, from: 20, to: 100 }]);
    expect(arbitrateResources(sim, [request]).decisions.get(front.id)?.admitted).toBe(true);
    const route = sim.topo.routes.find(r => r.sections.includes(sim.topo.links[goal.link].section))!;
    expect(routeResourceBlocker(sim, rear, route.id)?.request.id).toBe(front.id);
    rear.body = [{ link: goal.link, from: 0, to: 5 }];
    expect(routeResourceBlocker(sim, rear, route.id)).toBeUndefined();
  });

  it.each(['authority', 'berth', 'applicant-authority', 'applicant-interval'] as const)('keeps actual resource ownership ahead of an earlier service queued behind its entrant (%s)', dependency => {
    const { sim, front, rear, third } = fixture(true); sim.resourceTransit.clear();
    const station = downstreamTerminal('DN'), tail = sim.topo.berths[sim.topo.stations[station].turnbackBerths[0]];
    const incoming = sim.topo.berths[platformBerth(sim.topo, station, 'DN')];
    const point = reversedBerthPoint(sim.topo, tail.id, front.len)!;
    sim.t = 30000;
    const origin = { k: 'stop' as const, berth: platformBerth(sim.topo, station, 'UP'), station,
      trip: -1, arr: null, dep: sim.t + 300, doors: true, revenue: true };
    Object.assign(front, { ...point, hist: [{ link: point.link, dir: point.dir }], phase: 'run', tasks: [origin], v: 0 });
    Object.assign(rear, { link: incoming.link, off: incoming.offset, dir: incoming.dir,
      hist: [{ link: incoming.link, dir: incoming.dir }], phase: 'run', v: 0, tasks: [
        { k: 'reverse', chosen: tail.id, berths: [tail.id], station, minTime: 40 }, { ...origin, dep: sim.t + 200 },
      ] });
    // The upstream service has no resource request yet. Its real following
    // authority makes the physical queue depend on the siding occupant.
    const previous = sim.topo.stations.find(s => s.index !== station && s.turnbackBerths.length === 0)!;
    const b = sim.topo.berths[platformBerth(sim.topo, previous.index, 'DN')];
    Object.assign(third, { link: b.link, off: b.offset, dir: b.dir, hist: [{ link: b.link, dir: b.dir }], phase: 'run', v: 0,
      maCode: dependency.includes('authority') ? 'TRAIN_AHEAD' : 'ROUTE_WAIT', maTrain: dependency.includes('authority') ? rear.id : -1, tasks: [
        { k: 'stop', berth: incoming.id, station, trip: -1, arr: null, dep: null, doors: false, revenue: false },
        { k: 'reverse', chosen: tail.id, berths: [tail.id], station, minTime: 40 }, { ...origin, dep: sim.t + 100 },
      ] });
    for (const train of [front, rear, third]) {
      computeBody(sim, train);
      const signal = signalAheadFrom(sim, train.link, train.off, train.dir, Infinity);
      train.nextSignal = signal?.sig ?? -1; train.nextSignalDist = signal?.dist ?? Infinity;
    }
    indexBodies(sim); computeOccupancy(sim);
    const requests = collectResourceRequests(sim);
    expect(requests.some(r => r.id === third.id)).toBe(false);
    if (dependency.startsWith('applicant')) {
      if (dependency === 'applicant-interval') third.intervalWait = { train: rear.id, detail: '实际区间占用' };
      const goal = sim.topo.berths[origin.berth];
      requests.push({ id: third.id, train: third, tasks: third.tasks, inside: false, committed: false,
        readyAt: sim.t, time: sim.t, options: [{ phases: [{ goal: goal.id,
          start: { link: third.link, off: third.off, dir: third.dir }, routes: [],
          path: [{ link: goal.link, from: goal.offset + goal.dir, to: goal.offset }], distance: 1 }],
          sections: new Set([sim.topo.links[goal.link].section]), choices: [{ index: 2, berth: goal.id }],
        }] });
    }
    expect(arbitrateResources(sim, requests).decisions.get(front.id)?.admitted).toBe(true);
  });

  it('keeps an origin applicant behind an earlier through departure without claiming the ordinary train', () => {
    const { sim, front, rear } = fixture();
    const goal = sim.topo.berths[platformBerth(sim.topo, 3, 'UP')];
    const origin = { k: 'stop' as const, berth: goal.id, station: goal.station, trip: -1,
      arr: null, dep: sim.t + 200, doors: true, revenue: true };
    rear.tasks = [{ ...origin, arr: sim.t + 60, dep: sim.t + 100 }];
    front.tasks = [origin];
    const request: ResourceRequest = { id: front.id, train: front, tasks: front.tasks, inside: false,
      committed: false, readyAt: sim.t, time: sim.t, origin, options: [{
        phases: [{ goal: goal.id, start: { link: front.link, off: front.off, dir: front.dir }, routes: [],
          path: [{ link: goal.link, from: sim.topo.links[goal.link].len, to: goal.offset }], distance: 100 }],
        sections: new Set([sim.topo.links[goal.link].section]), choices: [{ index: 0, berth: goal.id }],
      }] };
    const result = arbitrateResources(sim, [request]);
    expect(result.decisions.get(front.id)).toMatchObject({ admitted: false, code: 'REGULATION', blocker: rear.id });
    expect(result.decisions.has(rear.id)).toBe(false);
    expect(result.claims.size).toBe(0);
  });

  it('does not reserve a later platform berth beyond the exit whole-body safe point', () => {
    const { sim, front, rear } = fixture();
    const berth = sim.topo.berths[platformBerth(sim.topo, downstreamTerminal('DN'), 'UP')];
    const length = sim.topo.links[berth.link].len;
    front.tasks = [{ k: 'stop', berth: berth.id, station: berth.station, trip: -1,
      arr: null, dep: sim.t + 100, doors: true, revenue: true }];
    // The leading train is beyond this clipped exit. Its tail still occupies
    // the eventual stopping berth, which ordinary CBTC will handle later.
    sim.linkBodies.set(berth.link, [{ train: rear.id, from: 0, to: berth.offset + 1 }]);
    const request: ResourceRequest = { id: front.id, train: front, tasks: front.tasks, inside: true,
      safeHere: true, committed: false, readyAt: sim.t, time: sim.t, options: [{
        phases: [{ goal: berth.id, start: { link: front.link, off: front.off, dir: front.dir }, routes: [],
          path: [{ link: berth.link, from: length, to: length / 2 }], distance: length / 2 }],
        sections: new Set([sim.topo.links[berth.link].section]), choices: [{ index: 0, berth: berth.id }],
      }] };
    expect(arbitrateResources(sim, [request]).decisions.get(front.id)?.admitted).toBe(true);
    expect(sim.berthRes.has(berth.id)).toBe(false);
  });

  it('holds a later independent-tail exit for the earlier service still completing its current turn', () => {
    const { sim, front, rear } = fixture(); sim.resourceTransit.clear();
    const station = downstreamTerminal('DN'), tails = sim.topo.stations[station].turnbackBerths;
    const first = sim.topo.berths[tails[0]], second = sim.topo.berths[tails[1]];
    const point = reversedBerthPoint(sim.topo, first.id, front.len)!;
    sim.t = 30000;
    const origin = { k: 'stop' as const, berth: platformBerth(sim.topo, station, 'UP'), station,
      trip: -1, arr: null, dep: sim.t + 400, doors: true, revenue: true };
    Object.assign(front, { ...point, hist: [{ link: point.link, dir: point.dir }], phase: 'run', tasks: [origin], v: 0 });
    Object.assign(rear, { link: second.link, off: second.offset - second.dir * 10, dir: second.dir,
      hist: [{ link: second.link, dir: second.dir }], phase: 'run', v: 0, tasks: [
        { k: 'reverse', chosen: second.id, berths: [second.id], station, minTime: 40 }, { ...origin, dep: sim.t + 200 },
      ] });
    for (const train of [front, rear]) {
      computeBody(sim, train);
      const signal = signalAheadFrom(sim, train.link, train.off, train.dir, Infinity);
      train.nextSignal = signal?.sig ?? -1; train.nextSignalDist = signal?.dist ?? Infinity;
    }
    indexBodies(sim); computeOccupancy(sim);
    const requests = collectResourceRequests(sim);
    expect(requests.find(r => r.id === rear.id)?.origin).toBeUndefined();
    const result = arbitrateResources(sim, requests);
    expect(result.decisions.get(front.id)).toMatchObject({ admitted: false, code: 'REGULATION', blocker: rear.id });
    expect(result.decisions.get(rear.id)?.admitted).toBe(true);
  });

  it('waits for the existing stabling call at the independent source without reserving its exit', () => {
    const { sim, front, rear } = fixture(); sim.removeTrain(rear);
    const station = downstreamTerminal('DN'), tail = sim.topo.berths[sim.topo.stations[station].turnbackBerths[0]];
    const point = reversedBerthPoint(sim.topo, tail.id, front.len)!;
    const departure = { k: 'stop' as const, berth: platformBerth(sim.topo, station, 'UP'), station,
      trip: -1, arr: sim.t + 950, dep: sim.t + 1000, doors: true, revenue: true, stabledOut: true };
    Object.assign(front, { ...point, hist: [{ link: point.link, dir: point.dir }], phase: 'run', tasks: [departure], v: 0 });
    computeBody(sim, front); indexBodies(sim); computeOccupancy(sim);
    const signal = signalAheadFrom(sim, front.link, front.off, front.dir, Infinity)!;
    front.nextSignal = signal.sig; front.nextSignalDist = signal.dist;
    const request = collectResourceRequests(sim).find(r => r.id === front.id)!;
    expect(request.safeHere).toBe(true);
    expect(request.readyAt).toBe(departure.dep - 240);
    const result = arbitrateResources(sim, [request]);
    expect(result.decisions.get(front.id)).toMatchObject({ admitted: false, code: 'REGULATION' });
    expect(result.claims.size).toBe(0);
    sim.t = request.readyAt;
    expect(arbitrateResources(sim).decisions.get(front.id)?.admitted).toBe(true);
  });

  it('carries an entered movement through restore and rollover, and releases only after its tail is safe', () => {
    const { sim, front, rear } = fixture(); sim.removeTrain(rear);
    const route = sim.topo.routes.find(r => {
      const first = sim.topo.links[r.steps[0].link], last = r.steps.at(-1)!;
      const node = last.dir === 1 ? sim.topo.links[last.link].b : sim.topo.links[last.link].a;
      return sim.topo.sections[first.section].kind === 'siding' && sim.topo.nodes[node].links.some(id => {
        const l = sim.topo.links[id], dir = l.a === node ? 1 : -1;
        return id !== last.link && l.normalDir === dir && l.len > front.len + 1 && sim.topo.sections[l.section].kind === 'plain';
      });
    })!;
    expect(route).toBeDefined();
    const first = route.steps[0], entry = first.dir === 1 ? sim.topo.links[first.link].a : sim.topo.links[first.link].b;
    const behind = sim.topo.nodes[entry].links.find(id => id !== first.link)!;
    const previous = { link: behind, dir: (sim.topo.links[behind].b === entry ? 1 : -1) as 1 | -1 };
    const last = route.steps.at(-1)!, node = last.dir === 1 ? sim.topo.links[last.link].b : sim.topo.links[last.link].a;
    const exit = sim.topo.nodes[node].links.map(id => sim.topo.links[id]).find(l => l.id !== last.link
      && l.len > front.len + 1 && sim.topo.sections[l.section].kind === 'plain')!;
    const dir = (exit.a === node ? 1 : -1) as 1 | -1;
    const goal = sim.topo.berths.find(b => b.kind === 'platform' && !b.reverse)!;
    const resources = new Set(route.steps.map(s => s.link));
    const option = { phases: [{ goal: goal.id, start: { link: first.link, off: first.dir === 1 ? 0 : sim.topo.links[first.link].len, dir: first.dir },
      routes: [route.id], path: route.steps.map(s => ({ link: s.link, from: s.dir === 1 ? 0 : sim.topo.links[s.link].len,
        to: s.dir === 1 ? sim.topo.links[s.link].len : 0 })), distance: route.length }],
      sections: new Set(route.sections), choices: [], resourceLinks: resources };
    Object.assign(front, { link: exit.id, off: dir === 1 ? 20 : exit.len - 20, dir,
      hist: [previous, ...route.steps, { link: exit.id, dir }] });
    computeBody(sim, front);
    expect(front.body.some(p => resources.has(p.link))).toBe(true);
    sim.resourceTransit.set(front.id, { option, entered: true, visited: true });
    const cp = capture(sim); sim.resourceTransit.clear(); restore(sim, cp);
    arbitrateResources(sim, []);
    expect(sim.resourceTransit.get(front.id)?.option.sections).toEqual(option.sections);
    sim.t = 99900;
    const tomorrow = new Sim(nextOperatingConfig(sim));
    carryWorld(tomorrow, sim);
    expect(tomorrow.resourceTransit.get(front.id)).toEqual(sim.resourceTransit.get(front.id));
    const carried = sim.trains.get(front.id)!;
    carried.off = dir === 1 ? carried.len + 1 : exit.len - carried.len - 1;
    computeBody(sim, carried);
    expect(carried.body.every(p => p.link === exit.id)).toBe(true);
    arbitrateResources(sim, []);
    expect(sim.resourceTransit.has(front.id)).toBe(false);
  });

  it('does not let a rear booking stop an ordinary front train outside the claimed resource', () => {
    const { sim, front, rear } = fixture();
    const goal = sim.topo.berths.find(b => b.kind === 'platform' && !sim.linkBodies.has(b.link))!;
    const section = sim.topo.links[goal.link].section;
    rear.tasks = [{ k: 'stop', berth: goal.id, station: goal.station, trip: -1, arr: sim.t + 300, dep: null, doors: false, revenue: false }];
    const request: ResourceRequest = { id: rear.id, train: rear, tasks: rear.tasks, inside: false, committed: false,
      readyAt: sim.t, time: sim.t - 100, options: [{ phases: [{ goal: goal.id, start: { link: rear.link, off: rear.off, dir: rear.dir },
        routes: [], path: [], distance: 100 }], approach: [{ link: rear.link, from: rear.off, to: 0 }],
        sections: new Set([section]), choices: [{ index: 0, berth: goal.id }] }] };
    sim.berthRes.set(goal.id, rear.id);
    const result = arbitrateResources(sim, [request]);
    expect(result.decisions.get(rear.id)).toMatchObject({ admitted: false, code: 'TRAIN_AHEAD', blocker: front.id });
    expect(result.claims.size).toBe(0);
    const route = sim.topo.routes.find(r => r.sections.includes(section))!;
    expect(routeResourceBlocker(sim, front, route.id)).toBeUndefined();
  });

  it.each([60, 400])('allocates a siding occupant whole exit before an arrival due in %s seconds, without contradictory claim fragments', (incomingDeparture) => {
    const { sim, front, rear } = fixture();
    const station = downstreamTerminal('DN'), tail = sim.topo.berths[sim.topo.stations[station].turnbackBerths[0]];
    const out = platformBerth(sim.topo, station, 'UP'), incoming = sim.topo.berths[platformBerth(sim.topo, station, 'DN')];
    const point = reversedBerthPoint(sim.topo, tail.id, front.len)!;
    sim.t = 30000;
    const origin = { k: 'stop' as const, berth: out, station, trip: -1, arr: null, dep: sim.t + 120, doors: false, revenue: false };
    Object.assign(front, { ...point, hist: [{ link: point.link, dir: point.dir }], phase: 'run', tasks: [origin], tbStage: 'depart', v: 0 });
    Object.assign(rear, { link: incoming.link, off: incoming.offset, dir: incoming.dir,
      hist: [{ link: incoming.link, dir: incoming.dir }], phase: 'run', v: 0, tasks: [
        { k: 'reverse', chosen: tail.id, berths: [tail.id], station, minTime: 40 }, { ...origin, dep: sim.t + incomingDeparture },
      ] });
    for (const train of [front, rear]) {
      computeBody(sim, train);
      const signal = signalAheadFrom(sim, train.link, train.off, train.dir, Infinity)!;
      train.nextSignal = signal.sig; train.nextSignalDist = signal.dist;
    }
    indexBodies(sim); computeOccupancy(sim);
    const requests = collectResourceRequests(sim);
    expect(requests.map(r => r.id)).toEqual(expect.arrayContaining([front.id, rear.id]));
    const result = arbitrateResources(sim, requests);
    expect(result.decisions.get(front.id)?.admitted).toBe(true);
    expect(result.decisions.get(rear.id)).toMatchObject({ admitted: false, blocker: front.id });
    for (const phase of result.decisions.get(front.id)!.option.phases) for (const rid of phase.routes)
      expect(routeResourceBlocker(sim, front, rid)).toBeUndefined();
  });

  it('ignores an occupied source lock without cancelling it, and reports a forward lock truthfully', () => {
    const { sim, front, rear } = fixture(); sim.removeTrain(rear);
    const goal = sim.topo.berths.find(b => b.kind === 'platform' && !sim.linkBodies.has(b.link))!;
    const source = sim.topo.links[front.link].section, target = sim.topo.links[goal.link].section;
    const incoming = sim.topo.routes.find(r => r.sections.length === 1 && r.sections[0] === source)!;
    const lock = (rid: number) => {
      const route = sim.topo.routes[rid];
      sim.routes.set(rid, { route: rid, state: 'locked', fleeting: false, manual: true, guide: false,
        guideUntil: 0, occSeen: route.sections.map(() => false), released: route.sections.map(() => false),
        entered: false, owner: -1, cancelAt: 0, committed: -1, setAt: sim.t });
    };
    const request: ResourceRequest = { id: front.id, train: front, tasks: front.tasks, inside: true, committed: false,
      readyAt: sim.t, time: sim.t, options: [{ phases: [{ goal: goal.id, start: { link: front.link, off: front.off, dir: front.dir },
        routes: [], path: [{ link: front.link, from: front.off, to: 0 }], distance: 100 }],
        sections: new Set([source, target]), choices: [] }] };
    lock(incoming.id); sim.sec[source].lockRoute = incoming.id;
    expect(arbitrateResources(sim, [request]).decisions.get(front.id)?.admitted).toBe(true);
    expect(sim.routes.get(incoming.id)?.manual).toBe(true);
    const forward = sim.topo.routes.find(r => r.sections.includes(target))!;
    lock(forward.id); sim.sec[target].lockRoute = forward.id;
    expect(arbitrateResources(sim, [request]).decisions.get(front.id)).toMatchObject({
      admitted: false, code: 'ROUTE_CONFLICT', detail: `${forward.name} 已发授权/锁闭`,
    });
  });

  it('does not apply a future origin clock or order to an arrival before an independent tail', () => {
    const { sim, front, rear } = fixture();
    const end = downstreamTerminal('DN');
    const tasks = sim.plan.blocks.map(b => blockTasks(sim.topo, sim.plan, b)).find(tasks => tasks.some((t, i) =>
      t.k === 'stop' && t.station === end && tasks[i - 1]?.k === 'stop' && tasks[i + 1]?.k === 'reverse'
      && tasks[i + 2]?.k === 'stop' && (tasks[i + 2] as { dep: number | null }).dep !== null))!;
    const index = tasks.findIndex((t, i) => t.k === 'stop' && t.station === end && tasks[i - 1]?.k === 'stop'
      && tasks[i + 1]?.k === 'reverse');
    const arrival = tasks[index], previous = tasks[index - 1], origin = tasks[index + 2];
    if (arrival.k !== 'stop' || previous.k !== 'stop' || origin.k !== 'stop') throw new Error('expected terminal turn fixture');
    const incoming = sim.topo.berths[previous.berth], outgoing = sim.topo.berths[origin.berth];
    sim.t = arrival.arr! - 300;
    Object.assign(front, { link: incoming.link, off: incoming.offset, dir: incoming.dir,
      hist: [{ link: incoming.link, dir: incoming.dir }], tasks: tasks.slice(index), phase: 'run', v: 0 });
    // The earlier departure really occupies the opposite platform. It does
    // not own the arrival platform or the independent turnback waiting place.
    Object.assign(rear, { link: outgoing.link, off: outgoing.offset, dir: outgoing.dir,
      hist: [{ link: outgoing.link, dir: outgoing.dir }], tasks: [{ ...origin, dep: origin.dep! - 200 }], phase: 'dwell', v: 0 });
    computeBody(sim, front); computeBody(sim, rear); indexBodies(sim); computeOccupancy(sim);
    expect(collectResourceRequests(sim).find(r => r.id === front.id)).toBeUndefined();
    // Ordinary running from the previous station remains outside arbitration.
    // Only reaching the final approach signal creates the resource request.
    const homeRoute = sim.topo.routes.find(r => r.berths.includes(arrival.berth) && !r.wrongDir)!;
    const home = sim.topo.signals[homeRoute.start];
    const approach = sim.topo.nodes[home.node].links.map(id => sim.topo.links[id]).find(link => link.id !== home.link
      && sim.topo.sections[link.section].kind === 'plain')!;
    const dir = approach.b === home.node ? 1 : -1;
    Object.assign(front, { link: approach.id, off: dir === 1 ? approach.len - 50 : 50, dir,
      hist: [{ link: approach.id, dir }], nextSignal: home.id, nextSignalDist: 50 });
    computeBody(sim, front); indexBodies(sim); computeOccupancy(sim);
    expect(collectResourceRequests(sim).find(r => r.id === front.id)).toBeUndefined();
    // This normal-direction arrival can wait clear of the opposite exit.
    // Admission belongs to its later departure from the platform into the tail.
    const arrived = sim.topo.berths[arrival.berth];
    Object.assign(front, { link: arrived.link, off: arrived.offset, dir: arrived.dir,
      hist: [{ link: arrived.link, dir: arrived.dir }], phase: 'dwell' });
    const departureSignal = signalAheadFrom(sim, front.link, front.off, front.dir, Infinity)!;
    front.nextSignal = departureSignal.sig; front.nextSignalDist = departureSignal.dist;
    computeBody(sim, front); indexBodies(sim); computeOccupancy(sim);
    const request = collectResourceRequests(sim).find(r => r.id === front.id)!;
    expect(request.options.every(o => !o.sections.has(sim.topo.links[incoming.link].section))).toBe(true);
    expect(request.options.every(o => o.phases.every(p => sim.topo.berths[p.goal].platform !== outgoing.platform))).toBe(true);
    expect(request.origin).toBeUndefined();
    expect(request.readyAt).toBe(sim.t);
    expect(request.time).toBe(front.halt.since || sim.t);
    expect(arbitrateResources(sim, [request]).decisions.get(front.id)?.admitted).toBe(true);
  });

  it('keeps an occupant exit ahead of a distant booking, independently of driving mode', () => {
    const { sim, front, rear } = fixture();
    const berth = sim.topo.berths.find(b => b.kind === 'platform' && !sim.linkBodies.has(b.link))!;
    const sec = sim.topo.links[berth.link].section;
    const request = (train: typeof front, inside: boolean, time: number): ResourceRequest => ({
      id: train.id, train, tasks: train.tasks, inside, committed: false, readyAt: sim.t, time,
      options: [{ phases: [{ goal: berth.id, start: { link: train.link, off: train.off, dir: train.dir },
        routes: [], path: [{ link: berth.link, from: 0, to: sim.topo.links[berth.link].len }], distance: 100 }],
        sections: new Set([sec]), choices: [], resourceLinks: new Set([berth.link]) }],
    });
    for (const mode of ['AM', 'DTO'] as const) {
      front.mode = mode;
      sim.berthRes.set(berth.id, rear.id);
      const result = arbitrateResources(sim, [request(rear, false, sim.t - 100), request(front, true, sim.t)]);
      expect(result.decisions.get(front.id)?.admitted).toBe(true);
      expect(result.decisions.get(rear.id)).toMatchObject({ admitted: false, blocker: front.id });
      const route = sim.topo.routes.find(r => r.sections.includes(sec))!;
      expect(routeResourceBlocker(sim, rear, route.id)?.request.id).toBe(front.id);
    }
  });

  it('ends a shared-yard entrance at a whole cab-change platform before an ordinary departure', () => {
    const { sim } = fixture();
    for (const train of [...sim.trainList]) sim.removeTrain(train);
    const block = sim.plan.blocks.find(b => {
      if (b.start.kind !== 'depot') return false;
      const first = sim.plan.trips[b.trips[0]], dp = sim.topo.depots[b.start.depot];
      return dp.portals.exit[first.dir].reverse && dp.transferPaths[dp.portals.exit[first.dir].path].flow === 'shared';
    })!;
    if (block.start.kind !== 'depot') throw new Error('expected depot fixture');
    sim.blockDone.delete(block.id); sim.t = block.start.time;
    const request = collectResourceRequests(sim).find(r => r.id === -(block.id + 1))!;
    const tasks = blockTasks(sim.topo, sim.plan, block);
    const work = tasks[0], arrival = tasks[1], origin = tasks[3];
    if (work.k !== 'stop' || arrival.k !== 'stop') throw new Error('expected depot work and platform arrival');
    expect(work.depotWork).toMatchObject({kind:'out',depot:block.start.depot});
    if (origin.k !== 'stop') throw new Error('expected source trip origin');
    // User C: the whole train can wait on this cab-change platform. Its
    // later ordinary departure must not reserve the incoming yard motion.
    expect(request.options[0].phases).toHaveLength(2);
    expect(request.options[0].phases[0].goal).toBe(work.berth);
    expect(request.options[0].phases[1].goal).toBe(arrival.berth);
    expect(request.origin).toMatchObject({ trip: block.trips[0], berth: origin.berth, dep: origin.dep });
    expect(sim.topo.berths[request.options[0].phases[1].goal].platform).toBe(sim.topo.berths[origin.berth].platform);
    expect(request.options[0].choices).toEqual([{index:0,berth:work.berth},{index:1,berth:arrival.berth}]);
    expect(request.readyAt).toBe(sim.t);
    expect(arbitrateResources(sim, [request]).decisions.get(request.id)?.admitted).toBe(true);
    expect(sim.trainList).toHaveLength(0);
  });

  it('separates a whole-platform cab change from its later ordinary departure window', () => {
    const { sim, front, rear } = fixture(); sim.removeTrain(rear); sim.resourceTransit.clear();
    const tasks = sim.plan.blocks.map(b => blockTasks(sim.topo, sim.plan, b)).find(tasks => tasks.some((t, i) =>
      t.k === 'reverse' && sim.topo.berths[t.chosen].kind === 'platform'
      && tasks[i + 1]?.k === 'stop' && tasks[i + 2]?.k === 'stop'))!;
    const index = tasks.findIndex(t => t.k === 'reverse' && sim.topo.berths[t.chosen].kind === 'platform');
    const turn = tasks[index] as Extract<(typeof tasks)[number], { k: 'reverse' }>;
    const berth = sim.topo.berths[turn.chosen], point = reversedBerthPoint(sim.topo, berth.id, front.len)!;
    const departure = structuredClone(tasks.slice(index + 1));
    if (departure[0].k !== 'stop' || departure[1].k !== 'stop') throw new Error('expected ordinary departure');
    departure[0].berth = departureBerthAfterReverse(sim.topo, berth.id, departure[0].berth);
    departure[0].dep = sim.t + 600;
    Object.assign(front, { ...point, hist: [{ link: point.link, dir: point.dir }], phase: 'dwell', tasks: departure, dwellUntil: departure[0].dep,
      stopBerth: departure[0].berth, stopArrived: true, v: 0 });
    computeBody(sim, front); indexBodies(sim); computeOccupancy(sim);
    const option = { phases: [{ goal: berth.id, start: point, routes: [], path: [], distance: 0 }],
      sections: new Set([sim.topo.links[berth.link].section]), choices: [], resourceLinks: new Set([berth.link]) };
    sim.resourceTransit.set(front.id, { entered: true, visited: true, option });
    const request = collectResourceRequests(sim).find(r => r.id === front.id)!;
    expect(request.safeHere).toBe(true);
    expect(request.readyAt).toBeGreaterThan(sim.t);
    const waiting = arbitrateResources(sim, [request]);
    expect(waiting.decisions.get(front.id)).toMatchObject({ admitted: false, code: 'REGULATION' });
    expect(waiting.claims.size).toBe(0);
    const outgoing = request.options[0].phases.flatMap(p => p.path);
    expect(safeWaitingPoint(sim.topo, { ...point, incoming: front.hist }, front.len,
      { afterTurn: true, destination: departure[1].berth, path: outgoing })).toBe(true);
    expect(safeWaitingPoint(sim.topo, { ...point, incoming: front.hist }, front.len * 2,
      { afterTurn: true, destination: departure[1].berth, path: outgoing })).toBe(false);
    sim.t = request.readyAt;
    expect(arbitrateResources(sim, [request]).decisions.get(front.id)?.admitted).toBe(true);
  });

  it('keeps the complete platform-to-shared-depot cab change protected', () => {
    const { sim, front, rear, third } = fixture(true); sim.resourceTransit.clear();
    const depot = sim.topo.depots.find(dp => (['DN', 'UP'] as const).some(dir => dp.portals.entry[dir].reverse
      && dp.transferPaths[dp.portals.entry[dir].path].flow === 'shared'))!;
    const direction = (['DN', 'UP'] as const).find(dir => depot.portals.entry[dir].reverse
      && depot.transferPaths[depot.portals.entry[dir].path].flow === 'shared')!;
    const tasks: typeof front.tasks = []; depotTasks(sim.topo, depot.id, direction, tasks);
    const arrival = tasks[0]; if (arrival.k !== 'stop') throw new Error('expected depot cab-change platform');
    const berth = sim.topo.berths[arrival.berth], point = reversedBerthPoint(sim.topo, berth.id, front.len)!;
    Object.assign(front, { link: berth.link, off: berth.offset, dir: berth.dir, hist: [{ link: berth.link, dir: berth.dir }],
      phase: 'run', tasks, v: 0 });
    const destination = tasks.at(-1)!;
    if (destination.k !== 'depot') throw new Error('expected depot destination');
    const held = sim.topo.berths[depot.entryBerths[depot.portals.entry[direction].path]];
    Object.assign(rear, { link: held.link, off: held.offset, dir: held.dir,
      hist: [{ link: held.link, dir: held.dir }], phase: 'stabled', tasks: [], v: 0 });
    const other = sim.topo.berths[depot.entryBerths.find(id => id !== held.id)!];
    Object.assign(third, { link: other.link, off: other.offset, dir: other.dir,
      hist: [{ link: other.link, dir: other.dir }], phase: 'stabled', tasks: [], v: 0 });
    for (const tr of [front, rear, third]) computeBody(sim, tr);
    indexBodies(sim); computeOccupancy(sim);
    const request = collectResourceRequests(sim).find(r => r.id === front.id)!;
    expect(request).toBeDefined();
    expect(request.options.every(o => o.phases.length >= 2 && o.phases.some(p =>
      p.path.some(step => depot.transferPaths.some(path => path.links.includes(step.link) || step.link === path.stub))))).toBe(true);
    expect(safeWaitingPoint(sim.topo, { ...point, incoming: [{ link: point.link, dir: point.dir }] }, front.len,
      { afterTurn: true, destination: held.id, path: request.options[0].phases.flatMap(p => p.path) })).toBe(false);
    const decision = arbitrateResources(sim, [request]).decisions.get(front.id)!;
    expect(decision.admitted).toBe(false);
    expect([rear.id, third.id]).toContain(decision.blocker);
  });

  it('treats a real cab-change platform with an unberthed SID exit connector as a safe ordinary-line boundary', () => {
    const { sim, front, rear } = fixture(); sim.removeTrain(rear); sim.resourceTransit.clear();
    const seen = new Set<string>();
    let selected: { point: NonNullable<ReturnType<typeof reversedBerthPoint>>; destination: number;
      path: ResourceRequest['options'][number]['phases'][number]['path'] } | undefined;
    for (const block of sim.plan.blocks) {
      const tasks = blockTasks(sim.topo, sim.plan, block);
      for (let i = 0; i < tasks.length - 2; i++) {
        const turn = tasks[i], origin = tasks[i + 1], next = tasks[i + 2];
        if (turn.k !== 'reverse' || sim.topo.berths[turn.chosen].kind !== 'platform'
          || origin.k !== 'stop' || next.k !== 'stop') continue;
        const key = `${turn.chosen}:${next.berth}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const point = reversedBerthPoint(sim.topo, turn.chosen, front.len)!;
        const departure = structuredClone(tasks.slice(i + 1));
        if (departure[0].k !== 'stop') throw new Error('expected departure stop');
        departure[0].berth = departureBerthAfterReverse(sim.topo, turn.chosen, departure[0].berth);
        Object.assign(front, { ...point, hist: [{ link: point.link, dir: point.dir }], phase: 'dwell', tasks: departure,
          dwellUntil: sim.t + 600, stopBerth: departure[0].berth, stopArrived: true, v: 0 });
        computeBody(sim, front); indexBodies(sim); computeOccupancy(sim);
        sim.resourceTransit.set(front.id, { entered: true, visited: true, option: {
          phases: [{ goal: turn.chosen, start: point, routes: [], path: [], distance: 0 }],
          sections: new Set([sim.topo.links[point.link].section]), choices: [], resourceLinks: new Set([point.link]),
        } });
        const request = collectResourceRequests(sim).find(r => r.id === front.id);
        const path = request?.options[0].phases.flatMap(phase => phase.path);
        if (path?.some(step => sim.topo.links[step.link].track === 'SID'
          && !sim.topo.berths.some(b => b.link === step.link && (b.kind === 'tail' || b.kind === 'siding')))) {
          selected = { point, destination: next.berth, path };
          break;
        }
      }
      if (selected) break;
    }
    expect(selected).toBeDefined();
    const { point, destination, path } = selected!;
    expect(sim.topo.links[point.link].platform).toBeGreaterThanOrEqual(0);
    expect(sim.topo.berths[destination]).toMatchObject({ kind: 'platform', reverse: false });
    expect(safeWaitingPoint(sim.topo, { ...point, incoming: front.hist }, front.len,
      { afterTurn: true, destination, path })).toBe(true);
    expect(sim.integrity.violations).toEqual([]);
  });

  it('does not call a long rescue formation safe merely because its head reaches a cab-change platform', () => {
    const { sim, front } = fixture();
    const berth = sim.topo.berths.find(b => b.kind === 'platform' && b.reverse)!;
    const route = sim.topo.routes.find(r => r.berths.includes(berth.id))!;
    const entry = berth.dir === 1 ? sim.topo.links[berth.link].a : sim.topo.links[berth.link].b;
    const previous = sim.topo.nodes[entry].links.find(id => id !== berth.link)!;
    const incoming = [{ link: previous, dir: (sim.topo.links[previous].b === entry ? 1 : -1) as 1 | -1 },
      { link: berth.link, dir: berth.dir }];
    const length = front.len * 2;
    expect(length).toBeGreaterThan(sim.topo.links[berth.link].len);
    const point = { link: berth.link, off: berth.offset, dir: berth.dir, incoming };
    const ordinary = sim.topo.berths.find(b => b.kind === 'platform' && !b.reverse && b.id !== berth.id)!;
    expect(safeWaitingPoint(sim.topo, point, length)).toBe(false);
    expect(safeWaitingPoint(sim.topo, point, length,
      { afterTurn: true, destination: ordinary.id, path: [{ link: berth.link, from: berth.offset, to: berth.offset + berth.dir }] })).toBe(false);
    // It also cannot release a carried grant with its tail still on this real approach.
    Object.assign(front, { link: berth.link, off: berth.offset, dir: berth.dir, hist: incoming, len: length });
    computeBody(sim, front);
    const protectedLinks = new Set(front.body.filter(p => p.link !== berth.link).map(p => p.link));
    expect(protectedLinks.size).toBeGreaterThan(0);
    sim.resourceTransit.set(front.id, { entered: true, visited: true, option: {
      phases: [{ goal: ordinary.id, start: point, routes: [route.id], path: [], distance: 0 }],
      sections: new Set(route.sections), choices: [], resourceLinks: protectedLinks,
    } });
    arbitrateResources(sim, []);
    expect(sim.resourceTransit.has(front.id)).toBe(true);
    expect(front.body.some(p => p.link !== berth.link)).toBe(true);
  });

  it('projects the whole rescue formation through the incoming path after reversal', () => {
    const { sim } = fixture();
    const route = sim.topo.routes.find(r => r.steps.length > 1 && r.berths.some(id => {
      const b = sim.topo.berths[id]; return b.link === r.steps.at(-1)!.link && b.dir === r.steps.at(-1)!.dir;
    }))!;
    const berth = route.berths.find(id => sim.topo.berths[id].link === route.steps.at(-1)!.link)!;
    const b = sim.topo.berths[berth], onLink = b.dir === 1 ? b.offset : sim.topo.links[b.link].len - b.offset;
    const point = reversedBerthPoint(sim.topo, berth, onLink + 10, route.steps)!;
    const previous = route.steps.at(-2)!;
    expect(point).toEqual({ link: previous.link, off: previous.dir === 1 ? sim.topo.links[previous.link].len - 10 : 10, dir: -previous.dir });
    expect(reversedBerthPoint(sim.topo, berth, onLink + 10)).toBeUndefined();
  });
});

describe('issued authority and shared restriction boundary',()=>{
  it('reports the real occupant on a conflicting route remote section outside the candidate path', () => {
    const { sim, front, rear, third } = fixture(true);
    for (const train of sim.trainList) train.maSigs = [];
    const pair = sim.topo.routes.flatMap(old => {
      if (old.sections.some(s => sim.sec[s].trainOcc)) return [];
      const candidate = sim.topo.routes.find(r => r.id !== old.id
        && (r.sections.some(s => old.sections.includes(s))
          || r.switches.some(sw => old.switches.some(other => other.sw === sw.sw && other.pos !== sw.pos)))
        && old.steps.some(step => !r.sections.includes(sim.topo.links[step.link].section)
          && sim.topo.links[step.link].len > rear.len * 2));
      return candidate ? [{ old, candidate }] : [];
    }).find(({ old }) => trySetRoute(sim, old.id, { train: third.id }).ok);
    expect(pair).toBeDefined();
    const { old, candidate } = pair!;
    const step = old.steps.find(s => !candidate.sections.includes(sim.topo.links[s.link].section)
      && sim.topo.links[s.link].len > rear.len * 2)!;
    const link = sim.topo.links[step.link];
    Object.assign(rear, { link: link.id, off: link.len / 2, dir: step.dir, hist: [{ link: link.id, dir: step.dir }], v: 0 });
    computeBody(sim, rear); indexBodies(sim); computeOccupancy(sim);
    const active = sim.routes.get(old.id)!;
    Object.assign(active, { arsTrain: third.id, owner: -1, committed: -1, entered: false, manual: false });
    expect(candidate.steps.some(s => s.link === link.id)).toBe(false);
    expect(candidate.sections).not.toContain(link.section);
    expect(rear.body.every(part => !candidate.sections.includes(sim.topo.links[part.link].section))).toBe(true);
    expect(committedTrain(sim, old.start)).toBe(-1);
    const blocked = routeBlocker(sim, candidate.id, front.id);
    expect(blocked.train).toBe(rear.id);
    expect(blocked.train).not.toBe(third.id);
    expect(sim.routes.get(old.id)).toBe(active);
    expect(active).toMatchObject({ entered: false, manual: false, committed: -1, cancelAt: 0, arsTrain: third.id });
    expect(sim.integrity.violations).toEqual([]);
  });
  it('reports an actual body before a stale logical ARS applicant when refusing cancellation', () => {
    const { sim, front, rear, third } = fixture(true);
    const route = sim.topo.routes.find(r => r.fleeting && r.sections.every(s => !sim.sec[s].trainOcc)
      && r.steps.some(step => sim.topo.links[step.link].len > rear.len * 2)
      && trySetRoute(sim, r.id, { train: third.id }).ok)!;
    expect(route).toBeDefined();
    const step = route.steps.find(step => sim.topo.links[step.link].len > rear.len * 2)!;
    const link = sim.topo.links[step.link];
    Object.assign(rear, { link: link.id, off: link.len / 2, dir: step.dir, hist: [{ link: link.id, dir: step.dir }], v: 0, maSigs: [] });
    third.maSigs = []; front.maSigs = [];
    computeBody(sim, rear); indexBodies(sim); computeOccupancy(sim);
    const active = sim.routes.get(route.id)!;
    Object.assign(active, { arsTrain: third.id, owner: -1, committed: -1, entered: false });
    const refused = cancelArsRoute(sim, front, route.start);
    expect(refused).toMatchObject({ ok: false, blocker: rear.id });
    expect(refused.msg).toContain('实占');
    expect(sim.routes.get(route.id)).toBe(active);
    expect(active.cancelAt).toBe(0);
    expect(sim.integrity.violations).toEqual([]);
  });
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
    bindFlatTopology(sim); // This unit case explicitly compares two flat braking curves.
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
  it('releases the original uphill 0.16 m scenario without commitment while preserving its independent overspeed protection',()=>{
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
    expect(restrictionDistanceAt(sim.topo,rear,rear.v,'emergency')).toBeLessThanOrEqual(target);
    // This is the emergency commitment boundary, not ARS permission to cut a supervision curve.
    expect(restrictionDistanceAt(sim.topo,rear,rear.v,'supervision')).toBeGreaterThan(target);
    expect(committedTrain(sim,signal.id)).toBe(-1);
    // The generic approaching-train lock still waits for its normal release delay.
    expect(cancelRoute(sim,signal.id,{source:'dispatcher'}).ok).toBe(true);
    expect(ar.committed).toBe(-1);expect(ar.cancelAt).toBeGreaterThan(sim.t);
    expect(sim.routes.has(route)).toBe(true);expect(rear.eb).toBe(false);
    sim.t=ar.cancelAt;updateInterlocking(sim);
    expect(sim.routes.has(route)).toBe(false);expect(sim.sig[signal.id].route).toBe(-1);
    expect(rear.maDist).toBe(target);expect(rear.maCut).toBe(false);
    const scan=scanAhead(sim,rear,-1);
    expect(scan.vBody).toBe(12.5);expect(rear.v).toBeGreaterThan(scan.vBody);
    expect(rear.eb).toBe(true);expect(rear.ebCause).toBe('overspeed');expect(rear.ebReason).toBe('超速防护');
    expect(sim.integrity.violations).toEqual([]);
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

function resourceEntranceFixture(reachable: boolean, keepCaller = false) {
  const { sim, front: tr, rear: caller } = fixture();
  if (!keepCaller) sim.removeTrain(caller);
  sim.resourceTransit.clear();
  const station = 6;
  const arrival = sim.topo.berths.find(b => b.station === station && b.kind === 'platform' && b.reverse && b.dir === -1)!;
  const departure = sim.topo.berths.find(b => b.platform === arrival.platform && b.dir === 1 && !b.reverse)!;
  const gate = sim.topo.signals.find(s => s.station === station && s.role === 'home' && s.dir === -1
    && s.routes.some(r => sim.topo.routes[r].diverging))!;
  const link = sim.topo.nodes[gate.node].links.map(id => sim.topo.links[id])
    .find(l => l.id !== gate.link && l.normalDir === -1)!;
  Object.assign(tr, { link: link.id, off: 50, dir: -1, hist: [{ link: link.id, dir: -1 }], phase: 'run', v: 0, a: 0,
    block: -1, tripId: -1, maSigs: [], maTrain: -1, intervalWait: undefined, failed: false, manual: false, eb: false,
    tasks: [
      { k: 'stop', berth: arrival.id, station, trip: -1, arr: sim.t + 100, dep: null, doors: false, revenue: false },
      { k: 'reverse', station, chosen: arrival.id, berths: [arrival.id], minTime: 40 },
      { k: 'stop', berth: departure.id, station, trip: -1, arr: null, dep: sim.t + 200, doors: false, revenue: false },
      { k: 'stop', berth: platformBerth(sim.topo, reachable ? 7 : 5, 'DN'), station: reachable ? 7 : 5,
        trip: -1, arr: sim.t + 400, dep: null, doors: false, revenue: false },
    ] });
  computeBody(sim, tr); indexBodies(sim); computeOccupancy(sim);
  const next = signalAheadFrom(sim, tr.link, tr.off, tr.dir, Infinity)!;
  tr.nextSignal = next.sig; tr.nextSignalDist = next.dist;
  expect(next.sig).toBe(gate.id);
  sim.integrity.violations = [];
  return { sim, tr, caller, gate, rid: sim.routeTable.next.get(arrival.id)![gate.id], arrival };
}


describe('complete resource movement with an unreachable later stage', () => {
  it('denies the reachable entrance with an explicit reason, without claiming the partial path', () => {
    const { sim, tr, rid } = resourceEntranceFixture(false);
    const allocation = arbitrateResources(sim), decision = allocation.decisions.get(tr.id)!;
    expect(decision).toBeDefined();
    expect(decision).toMatchObject({ admitted: false, code: 'ROUTE_MISMATCH', blocker: -1 });
    expect(decision.detail).toContain(sim.topo.berths[(tr.tasks[3] as Extract<typeof tr.tasks[number], { k: 'stop' }>).berth].name);
    expect(decision.option.unreachable).toBeDefined();
    expect(resourceAdmissionBlocked(sim, tr, rid)).toBe(true);
    expect([...allocation.claims.values()].some(d => d.request.id === tr.id)).toBe(false);
    expect(sim.resourceTransit.has(tr.id)).toBe(false);
    runARS(sim, true);
    expect(sim.routes.has(rid)).toBe(false);
    expect(tr.arsWait).toMatchObject({ code: 'ROUTE_MISMATCH', detail: decision.detail });
    expect(sim.integrity.violations).toEqual([]);
  });

  it('keeps the approved platform boundary when the same cab change has a reachable ordinary exit', () => {
    const { sim, tr, rid, arrival } = resourceEntranceFixture(true);
    const allocation = arbitrateResources(sim), decision = allocation.decisions.get(tr.id)!;
    expect(decision).toMatchObject({ admitted: true });
    expect(decision.option.unreachable).toBeUndefined();
    expect(decision.option.phases.map(p => p.goal)).toEqual([arrival.id]);
    expect(resourceAdmissionBlocked(sim, tr, rid)).toBe(false);
    runARS(sim, true);
    expect(sim.routes.get(rid)?.arsTrain).toBe(tr.id);
    expect(sim.integrity.violations).toEqual([]);
  });
});


function resourceEntranceFollowing(resource: boolean) {
  const { sim, tr, caller, gate, rid, arrival } = resourceEntranceFixture(true, true);
  for (const route of [rid, 253, 48]) expect(trySetRoute(sim, route, { fleeting: true }).ok).toBe(true);
  sim.t += 3;
  updateInterlocking(sim);
  // The lawful predecessor still occupies the shared route behind its head.
  Object.assign(caller, { link: arrival.link, off: 150, dir: -1, v: 8, phase: 'run',
    hist: [281, 280, 467, 466, 48, 47, arrival.link].map(link => ({ link, dir: -1 })),
    tasks: [{ k: 'stop', berth: arrival.id, station: arrival.station, trip: -1, arr: null,
      dep: null, doors: false, revenue: false }], maSigs: [], maTrain: -1, failed: false, manual: false });
  Object.assign(tr, { off: 200, v: 8, nextSignalDist: 200, maSigs: [] });
  if (!resource) tr.tasks = [tr.tasks[0]];
  computeBody(sim, caller); computeBody(sim, tr); indexBodies(sim); computeOccupancy(sim);
  const active = sim.routes.get(rid)!;
  Object.assign(active, { state: 'locked', fleeting: true, arsTrain: -1, owner: -1, committed: -1 });
  for (const sw of sim.topo.routes[rid].switches) Object.assign(sim.sw[sw.sw], { pos: sw.pos, target: sw.pos, moveUntil: 0 });
  const allocation = arbitrateResources(sim);
  return { sim, tr, caller, gate, rid, arrival, active, allocation };
}

describe('per-train resource admission on an occupied automatic route', () => {
  it('holds the denied follower at its entry without cancelling the predecessor route', () => {
    const { sim, tr, caller, gate, rid, arrival, active, allocation } = resourceEntranceFollowing(true);
    expect(allocation.decisions.get(tr.id)).toMatchObject({ admitted: false, blocker: caller.id });
    expect(caller.body.some(b => sim.topo.routes[rid].steps.some(s => s.link === b.link))).toBe(true);
    const authority = scanAhead(sim, tr, arrival.id);
    expect(authority.maSignals).not.toContain(gate.id);
    expect(authority.maDist).toBeLessThan(tr.nextSignalDist);
    expect(authority.maTrain, JSON.stringify({ authority, level: tr.level, comm: tr.comm, route: active })).toBe(caller.id);
    expect(sim.routes.get(rid)).toBe(active);
    expect(active).toMatchObject({ cancelAt: 0, fleeting: true });
    expect(sim.integrity.violations).toEqual([]);
  });

  it('keeps ordinary moving-block following through the same occupied route', () => {
    const { sim, tr, gate, arrival, allocation } = resourceEntranceFollowing(false);
    expect(allocation.decisions.has(tr.id)).toBe(false);
    const authority = scanAhead(sim, tr, arrival.id);
    expect(authority.maSignals).toContain(gate.id);
    expect(authority.maDist).toBeGreaterThan(tr.nextSignalDist);
    expect(sim.integrity.violations).toEqual([]);
  });

  it('keeps existing authority when the denied follower cannot accept its shrink', () => {
    const { sim, tr, gate, arrival } = resourceEntranceFollowing(true);
    tr.v = 25; tr.maSigs = [gate.id];
    const authority = scanAhead(sim, tr, arrival.id);
    expect(authority.maSignals).toContain(gate.id);
    expect(authority.maDist).toBeGreaterThan(tr.nextSignalDist);
    expect(sim.integrity.violations).toEqual([]);
  });
});


describe('source origin at the same physical safe-platform boundary', () => {
  it('leaves the source departure window on the safe platform after arrival admission ends', () => {
    const { sim, tr, arrival } = resourceEntranceFixture(true);
    const first = tr.tasks[0], origin = tr.tasks[2];
    if (first.k !== 'stop' || origin.k !== 'stop') throw Error('Invalid test scene');
    first.trip = 1000; first.arr = null; origin.trip = 1000; origin.dep = sim.t + 500;
    const decision = arbitrateResources(sim).decisions.get(tr.id)!;
    expect(decision.request.origin?.trip).toBe(1000);
    expect(decision.option.phases.map(p => p.goal)).toEqual([arrival.id]);
    expect(arrival.id).not.toBe(origin.berth);
    expect(decision.option.readyAt).toBeLessThanOrEqual(sim.t);
    expect(decision.admitted).toBe(true);
    expect(sim.integrity.violations).toEqual([]);
  });

  it.each([true, false])('restores only the source trip origin after a same-platform turn (%s same trip)', sameTrip => {
    const { sim, tr, caller, arrival } = resourceEntranceFixture(true, true);
    const first = tr.tasks[0], origin = tr.tasks[2];
    if (first.k !== 'stop' || origin.k !== 'stop') throw Error('Invalid test scene');
    first.trip = 1000; first.arr = null;
    origin.trip = sameTrip ? 1000 : 1001; origin.dep = sim.t + 500;
    Object.assign(caller, { link: 44, off: 200, dir: 1, hist: [{ link: 44, dir: 1 }], phase: 'run',
      tasks: [{ k: 'stop', berth: origin.berth, station: origin.station, trip: 600, arr: sim.t + 100,
        dep: sim.t + 100, doors: false, revenue: true }], v: 0, maSigs: [], maTrain: -1,
      maCode: 'NONE', intervalWait: undefined, failed: false, manual: false });
    computeBody(sim, caller); indexBodies(sim); computeOccupancy(sim);
    const decision = arbitrateResources(sim).decisions.get(tr.id)!;
    expect(decision.option.phases.map(p => p.goal)).toEqual([arrival.id]);
    expect(decision.option.choices.map(c => c.index)).toEqual([0]);
    if (sameTrip) {
      expect(decision.request.origin).toMatchObject({ trip: 1000, berth: origin.berth, dep: origin.dep });
      expect(decision).toMatchObject({ admitted: false, code: 'REGULATION', blocker: caller.id });
    } else {
      expect(decision.request.origin).toBeUndefined();
      expect(decision.admitted).toBe(true);
    }
    expect(sim.integrity.violations).toEqual([]);
  });
});


function authorityFaultFixture(speed: number) {
  const { sim, tr, gate, rid, arrival } = resourceEntranceFixture(true);
  tr.tasks = [tr.tasks[0]];
  for (const route of [rid, 253, 48]) expect(trySetRoute(sim, route, { fleeting: true }).ok).toBe(true);
  sim.t += 6; updateInterlocking(sim);
  Object.assign(tr, { off: 60, v: speed, a: 0, mode: 'DTO', manual: false, comm: true, level: 'CBTC',
    eb: false, maCut: false, maSigs: [], nextSignal: gate.id, nextSignalDist: 60 });
  computeBody(sim, tr); indexBodies(sim); computeOccupancy(sim); arbitrateResources(sim);
  const before = scanAhead(sim, tr, arrival.id);
  expect(before.maDist).toBeGreaterThan(60);
  Object.assign(tr, { maDist: before.maDist + 1.4, lastMa: before.maDist + 1.4, lastDs: 1.4,
    maSigs: before.maSignals, maFar: before.maDist, vEbi: 25 });
  sim.integrity.violations = []; sim.integrity.fsm.clear();
  checkSafety(sim);
  expect(sim.integrity.violations).toEqual([]);
  return { sim, tr, gate, rid, arrival, beforeSignals: before.maSignals, sw: sim.topo.routes[rid].switches[0].sw };
}

// Use the existing real approach and its actual home signal, without changing
// topology, train length or any checker. The 90 m point must be certified first.
function authorityCancelFixture(speed: number) {
  const { sim, tr, gate, rid, arrival } = authorityFaultFixture(0);
  Object.assign(tr, { off: 90, tbStage: undefined, lastStation: -1 });
  computeBody(sim, tr); indexBodies(sim); computeOccupancy(sim);
  const next = signalAheadFrom(sim, tr.link, tr.off, tr.dir, Infinity)!;
  expect(next.sig).toBe(gate.id); expect(next.dist).toBe(90);
  expect(tr.body.reduce((length, part) => length + Math.abs(part.to - part.from), 0)).toBe(tr.len);
  const before = scanAhead(sim, tr, arrival.id);
  expect(before.maSignals).toContain(gate.id);
  expect(before.maDist).toBeGreaterThan(90);
  Object.assign(tr, { nextSignal: next.sig, nextSignalDist: next.dist,
    maDist: before.maDist + 1.4, lastMa: before.maDist + 1.4, lastDs: 1.4,
    maSigs: before.maSignals, maFar: before.maDist, maCut: false, eb: false,
    tbStage: 'arrive', lastStation: arrival.station });
  // Record the lawful standstill cab-change history before the test speed.
  // Keep these observations so the original FSM checker remains active.
  checkSafety(sim); expect(sim.integrity.violations).toEqual([]);
  tr.tbStage = 'reverse';
  checkSafety(sim); expect(sim.integrity.violations).toEqual([]);
  tr.tbStage = 'depart';
  checkSafety(sim); expect(sim.integrity.violations).toEqual([]);
  tr.v = speed;
  expect(canStopBeforeSignal(sim, tr, gate.id, 'emergency')).toBe(true);
  expect(sim.sig[gate.id].route).toBe(rid);
  expect(sim.command({ c: 'ars', signal: gate.id, on: false }).ok).toBe(true);
  checkSafety(sim);
  expect(sim.integrity.violations, JSON.stringify(sim.integrity.violations)).toEqual([]);
  return { sim, tr, gate, rid, arrival };
}

describe('event-time restrictive authority ATP handoff', () => {
  it.each([14, 6])('supervises an actual switch fault immediately (%s m/s)', speed => {
    const { sim, tr, gate, beforeSignals, sw } = authorityFaultFixture(speed);
    const before = { lastMa: tr.lastMa, lastDs: tr.lastDs };
    // Find a real, already granted far route which emergency braking can
    // safely release. The retained authority must end before this signal.
    const far = beforeSignals.find(signal => signal !== gate.id
      && sim.sig[signal].route >= 0 && canStopBeforeSignal(sim, tr, signal, 'emergency'));
    if (speed === 14) expect(far).toBeDefined();
    expect(sim.command({ c: 'fault', kind: 'switch', target: sw, duration: 100, recoverable: false }).ok).toBe(true);
    expect(tr.maFarCode).toBe('SWITCH_FAULT');
    expect(tr.maFar).toBeLessThan(60);
    expect(tr.lastMa).toBe(before.lastMa);
    expect(tr.lastDs).toBe(before.lastDs);
    if (speed === 14) {
      expect(tr.v).toBeGreaterThan(tr.vEbi + .15);
      expect(tr.eb).toBe(true);
      expect(tr.maCut).toBe(true);
      const stopping = restrictionDistanceAt(sim.topo, tr, tr.v, 'emergency');
      const currentPrefix = Math.max(tr.maFar, stopping);
      expect(before.lastMa - before.lastDs).toBeGreaterThan(currentPrefix);
      expect(tr.maDist).toBe(Math.min(before.lastMa, currentPrefix + before.lastDs));
      expect(tr.maDist).toBeLessThan(before.lastMa);
      // Kinematics use the current-position prefix; maDist stores the
      // preceding-position coordinate, including the unchanged lastDs.
      let actualBrakeTravel = 0;
      expect(sim.command({ c: 'ars', signal: far!, on: false }).ok).toBe(true);
      expect(sim.command({ c: 'cancelRoute', signal: far! }).ok).toBe(true);
      expect(sim.sig[far!].route).toBe(-1);
      const issued = tr.maDist, since = tr.ebSince, cause = tr.ebCause;
      withdrawAuthority(sim, tr);
      expect(tr.ebSince).toBe(since); expect(tr.ebCause).toBe(cause);
      expect(tr.maDist).toBe(issued);
      expect(tr.lastMa).toBe(before.lastMa); expect(tr.lastDs).toBe(before.lastDs);
      checkSafety(sim);
      expect(sim.integrity.violations).toEqual([]);
      for (let i = 0; i < 200 && tr.v > .01; i++) { sim.step(); actualBrakeTravel += tr.lastDs; }
      expect(actualBrakeTravel).toBeLessThanOrEqual(currentPrefix);
      expect(tr.v).toBeLessThanOrEqual(.01);
      expect(tr.maCut).toBe(false);
    } else {
      expect(tr.v).toBeLessThan(tr.vEbi);
      expect(tr.eb).toBe(false);
      expect(tr.maCut).toBe(false);
      expect(tr.maDist).toBe(tr.maFar);
    }
    checkSafety(sim);
    expect(sim.integrity.violations).toEqual([]);
  });

  it('does not erase a previous beyond-authority movement during a fault refresh', () => {
    const { sim, tr, sw } = authorityFaultFixture(14);
    tr.lastMa = .2; tr.lastDs = 1.4;
    expect(sim.command({ c: 'fault', kind: 'switch', target: sw, duration: 100, recoverable: false }).ok).toBe(true);
    expect(tr.lastMa).toBe(.2); expect(tr.lastDs).toBe(1.4);
    checkSafety(sim);
    expect(sim.integrity.violations.some(v => v.kind === 'BEYOND_MA' && v.trains.includes(tr.id))).toBe(true);
  });

  it.each([0, .4])('does not create EB on a stoppable actual route cancellation (%s m/s)', speed => {
    const { sim, tr, gate } = authorityCancelFixture(speed);
    const before = { lastMa: tr.lastMa, lastDs: tr.lastDs };
    expect(sim.command({ c: 'cancelRoute', signal: gate.id }).ok).toBe(true);
    expect(sim.sig[gate.id].route).toBe(-1);
    expect(tr.eb).toBe(false); expect(tr.maCut).toBe(false);
    expect(tr.maDist).toBe(tr.maFar);
    expect(tr.lastMa).toBe(before.lastMa); expect(tr.lastDs).toBe(before.lastDs);
    if (speed === 0) expect(tr.maFar).toBe(0);
    else expect(canAcceptRestriction(speed, tr.maFar, 'emergency')).toBe(true);
    checkSafety(sim);
    expect(sim.integrity.violations).toEqual([]);
  });

  it('keeps the 140241 creeping prefix before a safely closed signal 90 m away', () => {
    const { sim, tr, gate } = authorityCancelFixture(.045);
    const before = { lastMa: tr.lastMa, lastDs: tr.lastDs };
    expect(sim.command({ c: 'cancelRoute', signal: gate.id }).ok).toBe(true);
    expect(sim.sig[gate.id].route).toBe(-1);
    expect(tr.maFar).toBe(0);
    const stopping = restrictionDistanceAt(sim.topo, tr, tr.v, 'emergency');
    expect(tr.maDist).toBe(Math.min(before.lastMa, Math.max(tr.maFar, stopping) + before.lastDs));
    expect(tr.maDist - before.lastDs).toBeLessThan(signalStopDistance(90));
    expect(tr.lastMa).toBe(before.lastMa); expect(tr.lastDs).toBe(before.lastDs);
    // The reviewed candidate still produces one EB for the logical zero at
    // .045 m/s. This observation is reported separately from the prefix fix.
    expect(tr.eb).toBe(true); expect(tr.maCut).toBe(true);
    const issued = tr.maDist, cause = tr.ebCause, since = tr.ebSince;
    withdrawAuthority(sim, tr);
    expect(tr.maDist).toBe(issued);
    expect(tr.ebCause).toBe(cause); expect(tr.ebSince).toBe(since);
    expect(tr.lastMa).toBe(before.lastMa); expect(tr.lastDs).toBe(before.lastDs);
    checkSafety(sim);
    expect(sim.integrity.violations).toEqual([]);
  });
});


// Independent controlled profiles; each topology is fresh before the first distance query.
function bindFlatTopology(sim: Sim) {
  const topo = buildTopology();
  const profile = profileOf(topo);
  profile.ch = [-1000000, 1000000]; profile.h = [0, 0];
  Object.freeze(profile.ch); Object.freeze(profile.h);
  sim.topo = topo; sim.planCtx = { ...sim.planCtx, topo };
}

function controlledProfile(topo: Topology, head: number, sense: number, x: number[], height: number[]): Profile {
  if (sense !== 1 && sense !== -1) throw Error('Profile fixture needs a chainage direction');
  const points = x.map((distance, index) => ({ chain: head + sense * distance, height: height[index] }))
    .sort((a, b) => a.chain - b.chain);
  const profile = profileOf(topo);
  profile.ch = points.map(point => point.chain);
  profile.h = points.map(point => point.height);
  Object.freeze(profile.ch); Object.freeze(profile.h);
  return profile;
}

function distanceFixture(direction: Dir, x: number[], height: number[], len = LINE_INFO.trainLength) {
  const topo = buildTopology();
  const link = topo.links.find(item => item.track === 'DN' && item.len >= 400
    && item.chainB > item.chainA && Math.abs(item.chainB - item.chainA - item.len) < 1e-6)!;
  if (!link) throw Error('No plain unit-chainage link for the controlled profile');
  const position = { link: link.id, off: link.len / 2, dir: direction, len };
  const head = linkChain(topo, position.link, position.off), sense = chainSense(topo, position.link, direction);
  const profile = controlledProfile(topo, head, sense, x, height);
  return { topo, position, profile, head, sense };
}

function odeStop(profile: Profile, head: number, sense: number, len: number, speed: number, brake: number) {
  let distance = 0, velocity = speed;
  const acceleration = (x: number) => gradeAccelAt(profile, head + sense * x, sense, len) - brake;
  const advance = (dt: number) => {
    const a1 = acceleration(distance), v1 = velocity;
    const a2 = acceleration(distance + v1 * dt / 2), v2 = velocity + a1 * dt / 2;
    const a3 = acceleration(distance + v2 * dt / 2), v3 = velocity + a2 * dt / 2;
    const a4 = acceleration(distance + v3 * dt), v4 = velocity + a3 * dt;
    return { distance: distance + dt * (v1 + 2 * v2 + 2 * v3 + v4) / 6,
      velocity: velocity + dt * (a1 + 2 * a2 + 2 * a3 + a4) / 6 };
  };
  for (let tick = 0; tick < 100000; tick++) {
    const next = advance(.002);
    if (next.velocity <= 0) {
      let lo = 0, hi = .002;
      for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (advance(mid).velocity > 0) lo = mid; else hi = mid; }
      return advance(hi).distance;
    }
    distance = next.distance; velocity = next.velocity;
  }
  throw Error('Controlled physical braking did not stop within 200 s');
}

describe('graded authority distance independent physics', () => {
  const rows = ([1, -1] as Dir[]).flatMap(direction => (['emergency', 'supervision'] as RestrictionBrake[])
    .flatMap(brake => [-.024, 0, .024].map(slope => ({ direction, brake, slope }))));
  it.each(rows)('uses the actual $direction direction and $slope grade with $brake', ({ direction, brake, slope }) => {
    const speed = 14;
    const fixture = distanceFixture(direction, [-4000, 4000], [-4000 * slope, 4000 * slope]);
    expect(travelDirection(fixture.topo, fixture.position)).toBe(direction === 1 ? 'DN' : 'UP');
    const b = brake === 'emergency' ? PERF.bEbGuaranteed : PERF.bPermit;
    const expected = speed * speed / (2 * (b + G * slope));
    const actual = restrictionDistanceAt(fixture.topo, fixture.position, speed, brake);
    expect(actual).toBeCloseTo(expected, 5);
    if (slope < 0) expect(actual).toBeGreaterThan(restrictionDistance(speed, brake));
    if (slope > 0) expect(actual).toBeLessThan(restrictionDistance(speed, brake));
    expect(actual).toBeCloseTo(odeStop(fixture.profile, fixture.head, fixture.sense, fixture.position.len, speed, b), 4);
  });

  it('uses opposite physical directions on the same immutable profile', () => {
    const { topo, position } = distanceFixture(1, [-4000, 4000], [96, -96]);
    const downhill = restrictionDistanceAt(topo, position, 14);
    const uphill = restrictionDistanceAt(topo, { ...position, dir: -1 }, 14);
    expect(downhill).toBeGreaterThan(restrictionDistance(14));
    expect(uphill).toBeLessThan(restrictionDistance(14));
    expect(downhill).toBeCloseTo(14 * 14 / (2 * (PERF.bEbGuaranteed - G * .024)), 5);
    expect(uphill).toBeCloseTo(14 * 14 / (2 * (PERF.bEbGuaranteed + G * .024)), 5);
  });

  it('accounts for a downhill tail while the head has already reached level track', () => {
    const fixture = distanceFixture(1, [-800, -10, 1000], [23.7, 0, 0]);
    const whole = restrictionDistanceAt(fixture.topo, fixture.position, 14);
    const headOnly = restrictionDistanceAt(fixture.topo, { ...fixture.position, len: 0 }, 14);
    expect(whole).toBeGreaterThan(headOnly);
    expect(headOnly).toBeCloseTo(restrictionDistance(14), 5);
    const independent = odeStop(fixture.profile, fixture.head, fixture.sense, fixture.position.len, 14, PERF.bEbGuaranteed);
    expect(whole).toBeCloseTo(independent, 4);
  });

  it('crosses both head and tail slope breaks with DN/UP mirror equivalence', () => {
    const distances: number[] = [];
    for (const direction of [1, -1] as Dir[]) {
      const fixture = distanceFixture(direction, [-800, -120, -10, 100, 1000], [20.4, 0, 0, -3.3, -3.3]);
      const actual = restrictionDistanceAt(fixture.topo, fixture.position, 14);
      const independent = odeStop(fixture.profile, fixture.head, fixture.sense, fixture.position.len, 14, PERF.bEbGuaranteed);
      expect(actual).toBeGreaterThan(100);
      expect(actual).toBeGreaterThan(fixture.position.len - 120);
      expect(actual).toBeGreaterThan(restrictionDistance(14));
      expect(actual).toBeCloseTo(independent, 4);
      distances.push(actual);
    }
    expect(distances[0]).toBeCloseTo(distances[1], 5);
  });
});

function nativeGradeFixture(slope: number, speed: number, distance: number) {
  const { sim, tr, gate, rid, arrival } = resourceEntranceFixture(true);
  // buildTopology returns entirely new maps, links and closures. Set its
  // private test profile before any distance-cache query on this identity.
  const fresh = buildTopology();
  sim.topo = fresh; sim.planCtx = { ...sim.planCtx, topo: fresh };
  tr.tasks = [tr.tasks[0]];
  Object.assign(tr, { off: distance, v: 0, a: 0, mode: 'DTO', manual: false,
    comm: true, level: 'CBTC', eb: false, maCut: false, maSigs: [], nextSignal: gate.id, nextSignalDist: distance });
  const head = linkChain(fresh, tr.link, tr.off), sense = chainSense(fresh, tr.link, tr.dir);
  const profile = controlledProfile(fresh, head, sense, [-4000, 4000], [-4000 * slope, 4000 * slope]);
  computeBody(sim, tr); indexBodies(sim); computeOccupancy(sim);
  for (const route of [rid, 253, 48]) expect(trySetRoute(sim, route, { fleeting: true }).ok).toBe(true);
  sim.t += 6; updateInterlocking(sim);
  const open = scanAhead(sim, tr, arrival.id);
  expect(open.maSignals).toContain(gate.id);
  expect(open.maDist).toBeGreaterThan(distance);
  expect(open.vBody).toBeGreaterThan(speed);
  Object.assign(tr, { v: speed, maDist: open.maDist + 1.4, lastMa: open.maDist + 1.4,
    lastDs: 1.4, maFar: open.maDist, maSigs: open.maSignals,
    vPermit: open.vBody, vEbi: open.vBody + PERF.atpTolerance });
  sim.integrity.violations = []; sim.integrity.fsm.clear();
  checkSafety(sim); expect(sim.integrity.violations).toEqual([]);
  return { sim, tr, gate, rid, arrival, profile, sw: fresh.routes[rid].switches[0].sw };
}

describe('graded retained authority native events', () => {
  it('keeps the real open route and grades before a restrictive event', () => {
    const { sim, tr, gate, rid } = nativeGradeFixture(-.024, 6, 12);
    expect(sim.sig[gate.id].route).toBe(rid);
    expect(sim.routes.get(rid)?.state).toBe('locked');
    expect(tr.maSigs).toContain(gate.id);
    expect(tr.eb).toBe(false); expect(tr.maCut).toBe(false);
    expect(restrictionDistanceAt(sim.topo, tr, tr.v)).toBeGreaterThan(restrictionDistance(tr.v));
    checkSafety(sim); expect(sim.integrity.violations).toEqual([]);
  });

  it('brakes under an actually failed locked point with enough downhill prefix', () => {
    const travel: number[] = [];
    for (const slope of [0, -.024]) {
      const { sim, tr, rid, sw } = nativeGradeFixture(slope, 6, 12);
      const before = { lastMa: tr.lastMa, lastDs: tr.lastDs, speed: tr.v };
      const required = restrictionDistanceAt(sim.topo, tr, tr.v);
      if (slope < 0) expect(required).toBeGreaterThan(restrictionDistance(tr.v));
      expect(sim.command({ c: 'fault', kind: 'switch', target: sw, duration: 100, recoverable: false }).ok).toBe(true);
      expect(sim.routes.get(rid)?.state).toBe('locked');
      expect(sim.sw[sw].lockCount).toBeGreaterThan(0);
      expect(tr.maFarCode).toBe('SWITCH_FAULT');
      expect(tr.eb).toBe(true); expect(tr.maCut).toBe(true);
      expect(tr.lastMa).toBe(before.lastMa); expect(tr.lastDs).toBe(before.lastDs);
      expect(tr.maDist).toBe(Math.min(before.lastMa, Math.max(tr.maFar, required) + before.lastDs));
      expect(tr.maDist).toBeLessThan(before.lastMa);
      let moved = 0;
      for (let tick = 0; tick < 300 && tr.v > .01; tick++) {
        sim.step(); moved += tr.lastDs;
        expect(sim.integrity.violations).toEqual([]);
      }
      expect(tr.v).toBeLessThanOrEqual(.01);
      expect(moved).toBeLessThanOrEqual(required);
      expect(tr.maCut).toBe(false);
      travel.push(moved);
      checkSafety(sim); expect(sim.integrity.violations).toEqual([]);
    }
    expect(travel[1]).toBeGreaterThan(travel[0]);
  });

  it.each([{ slope: -.024, speed: .4, distance: 90 }, { slope: .024, speed: .4, distance: 6.07 }])
  ('really cancels a stoppable $slope route at $distance m without EB or retaining beyond it', ({ slope, speed, distance }) => {
    const { sim, tr, gate } = nativeGradeFixture(slope, speed, distance);
    const before = { lastMa: tr.lastMa, lastDs: tr.lastDs, oldMa: tr.maDist };
    const required = restrictionDistanceAt(sim.topo, tr, tr.v);
    if (slope < 0) expect(required).toBeGreaterThan(restrictionDistance(tr.v));
    else {
      expect(required).toBeLessThan(restrictionDistance(tr.v));
      expect(signalStopDistance(distance)).toBeLessThan(restrictionDistance(tr.v));
    }
    expect(signalStopDistance(distance)).toBeGreaterThan(required);
    expect(canStopBeforeSignal(sim, tr, gate.id, 'emergency')).toBe(true);
    expect(sim.command({ c: 'ars', signal: gate.id, on: false }).ok).toBe(true);
    expect(sim.command({ c: 'cancelRoute', signal: gate.id }).ok).toBe(true);
    expect(sim.sig[gate.id].route).toBe(-1);
    expect(tr.maSigs).not.toContain(gate.id);
    expect(tr.maDist).toBeLessThan(before.oldMa);
    expect(tr.maDist).toBe(tr.maFar);
    expect(tr.maDist).toBeLessThanOrEqual(signalStopDistance(distance));
    expect(tr.lastMa).toBe(before.lastMa); expect(tr.lastDs).toBe(before.lastDs);
    expect(tr.eb).toBe(false); expect(tr.maCut).toBe(false);
    checkSafety(sim); expect(sim.integrity.violations).toEqual([]);
  });
});
