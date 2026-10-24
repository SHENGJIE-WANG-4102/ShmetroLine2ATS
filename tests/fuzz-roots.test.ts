import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { capture, restore, type Checkpoint } from '../src/sim/state';
import { berthBusy, berthHolder, cancelArsRoute, routeFaultCode, runARS, routeBlocker, updateTrainTasks, signalAheadFrom } from '../src/sim/ats';
import { cancelRoute, committedTrain, computeOccupancy, releaseRoute, trySetRoute, updateInterlocking } from '../src/sim/interlocking';
import { computeBody, indexBodies, scanAhead, stopError, updateTrainMotion } from '../src/sim/movement';
import { canAcceptRestriction, signalStopDistance } from '../src/sim/protection';
import { checkSafety, checkLiveness } from '../src/sim/invariants';
import { updateHalts } from '../src/sim/halt';
import { faultProcedure } from '../src/sim/faults';
import { generatePlan, overnightPlaces, platformBerth, turnbackAt, validatePlan, departureBerthAfterReverse } from '../src/sim/timetable';
import { carryWorld, nextOperatingConfig } from '../src/sim/operatingDay';
import { PERF } from '../src/sim/dynamics';
import { WEATHER_RULES } from '../src/data/current';
import { validateCommand } from '../src/sim/commands';
import type { Command } from '../src/sim/model';
import { openCall } from '../src/sim/radio';
import { allowed, TURNBACK } from '../src/sim/fsm';
import { arbitrateResources, collectResourceRequests, routeResourceBlocker, type ResourceRequest } from '../src/sim/resourceArbitration';
import { blockTasks } from '../src/sim/timetable';
import { reversedBerthPoint, downstreamTerminal, orderedStations } from '../src/sim/topology';

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
  it.each([false, true])('compares the current local departure, but never a later remote circulation (%s)', localTurn => {
    const { sim, front, rear } = fixture(); sim.resourceTransit.clear();
    const goal = sim.topo.berths[platformBerth(sim.topo, 3, 'UP')], terminal = downstreamTerminal('DN');
    const origin = { k: 'stop' as const, berth: goal.id, station: goal.station, trip: 900,
      arr: null, dep: sim.t + 200, doors: true, revenue: true };
    front.tasks = [origin]; rear.maTrain = -1; rear.intervalWait = undefined;
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
    rear.body = [{ link: goal.link, from: 20, to: 100 }];
    sim.linkBodies.set(goal.link, [{ train: rear.id, from: 20, to: 100 }]);
    expect(arbitrateResources(sim, [request]).decisions.get(front.id)?.admitted).toBe(true);
    const route = sim.topo.routes.find(r => r.sections.includes(sim.topo.links[goal.link].section))!;
    expect(routeResourceBlocker(sim, rear, route.id)?.request.id).toBe(front.id);
    rear.body = [{ link: goal.link, from: 0, to: 5 }];
    expect(routeResourceBlocker(sim, rear, route.id)).toBeUndefined();
  });

  it.each(['authority', 'berth'] as const)('keeps actual resource ownership ahead of an earlier service queued behind its entrant (%s)', dependency => {
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
      maCode: dependency === 'authority' ? 'TRAIN_AHEAD' : 'ROUTE_WAIT', maTrain: dependency === 'authority' ? rear.id : -1, tasks: [
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
    const siding = sim.topo.berths.find(b => b.kind === 'siding')!;
    const exit = sim.topo.links.find(l => l.normalDir !== 0 && sim.topo.sections[l.section].kind === 'plain')!;
    const goal = sim.topo.berths.find(b => b.kind === 'platform' && !b.reverse)!;
    const option = { phases: [{ goal: goal.id, start: { link: front.link, off: front.off, dir: front.dir },
      routes: [], path: [{ link: exit.id, from: 0, to: front.len }], distance: front.len }],
      sections: new Set([sim.topo.links[siding.link].section, exit.section]), choices: [], resourceLinks: new Set([siding.link]) };
    front.body = [{ link: exit.id, from: 0, to: 100 }, { link: siding.link, from: 0, to: front.len - 100 }];
    front.hist = [{ link: siding.link, dir: 1 }, { link: exit.id, dir: exit.normalDir as 1 | -1 }];
    sim.resourceTransit.set(front.id, { option, entered: true, visited: true });
    const cp = capture(sim); sim.resourceTransit.clear(); restore(sim, cp);
    arbitrateResources(sim, []);
    expect(sim.resourceTransit.get(front.id)?.option.sections).toEqual(option.sections);
    sim.t = 99900;
    const tomorrow = new Sim(nextOperatingConfig(sim));
    carryWorld(tomorrow, sim);
    expect(tomorrow.resourceTransit.get(front.id)).toEqual(sim.resourceTransit.get(front.id));
    const carried = sim.trains.get(front.id)!;
    carried.body = [{ link: exit.id, from: 0, to: carried.len }];
    carried.hist = [{ link: exit.id, dir: exit.normalDir as 1 | -1 }];
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
        routes: [], path: [], distance: 100 }], sections: new Set([sec]), choices: [] }],
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

  it('keeps an exit in the yard until the complete cab-change motion is ready', () => {
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
    expect(request.options[0].phases.length).toBeGreaterThanOrEqual(2);
    const tasks = blockTasks(sim.topo, sim.plan, block);
    expect(request.options[0].phases[0].goal).toBe((tasks[0] as { berth: number }).berth);
    expect(request.options[0].phases[1].start.dir).toBe(-sim.topo.berths[request.options[0].phases[0].goal].dir);
    expect(request.options[0].phases.at(-1)!.goal).not.toBe(request.origin!.berth);
    expect(request.readyAt).toBeGreaterThan(sim.t);
    const waiting = arbitrateResources(sim, [request]);
    expect(waiting.decisions.get(request.id)).toMatchObject({ admitted: false, blocker: -1 });
    expect(waiting.claims.size).toBe(0);
    expect(sim.trainList).toHaveLength(0);
    sim.t = request.readyAt;
    expect(arbitrateResources(sim, [request]).decisions.get(request.id)?.admitted).toBe(true);
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
