import { expect, it } from 'vitest';
import { canStopBeforeSignal } from '../src/sim/protection';
import { Sim } from '../src/sim/engine';
import { depotTasks, platformBerth } from '../src/sim/timetable';
import { signalAheadFrom, runARS, routeOccupant, cancelArsRoute, distanceToBerthFrom } from '../src/sim/ats';
import { releaseRoute, computeOccupancy, signalPassed, updateInterlocking, trySetRoute } from '../src/sim/interlocking';
import { computeBody, indexBodies, moveBack } from '../src/sim/movement';
import { arbitrateResources, collectResourceRequests, resourceAdmissionBlocked, routeNeedsResourceProtection } from '../src/sim/resourceArbitration';
import { orderedStations, topologyResourceLinks, ahead, reversedBerthPoint } from '../src/sim/topology';

it.each([true, false])('collects a consist already occupying its return exit, but leaves a distant approach unclaimed (%s)', near => {
  const sim = new Sim({ dayType: 'weekday', date: '2026-10-19', dateLabel: 'resource ownership', startTime: 14400, seed: 7, noPossessions: true });
  const tr = sim.trainList[0];
  for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
  for (const rid of [...sim.routes.keys()]) releaseRoute(sim, rid);
  for (const b of sim.plan.blocks) sim.blockDone.add(b.id);
  sim.resourceTransit.clear();
  const depot = sim.topo.depots.find(dp => (['DN', 'UP'] as const).some(dir => dp.portals.entry[dir].reverse
    && dp.transferPaths[dp.portals.entry[dir].path].flow === 'shared'))!;
  const direction = (['DN', 'UP'] as const).find(dir => depot.portals.entry[dir].reverse
    && depot.transferPaths[depot.portals.entry[dir].path].flow === 'shared')!;
  const tasks: typeof tr.tasks = []; depotTasks(sim.topo, depot.id, direction, tasks);
  const arrival = tasks[0]; if (arrival.k !== 'stop') throw Error('expected turn-platform arrival');
  const berth = sim.topo.berths[arrival.berth], platform = sim.topo.links[berth.link];
  const at = berth.dir === 1 ? platform.a : platform.b;
  const before = sim.topo.nodes[at].links.map(id => sim.topo.links[id])
    .find(l => l.id !== platform.id && l.track === platform.track && l.normalDir === berth.dir)!;
  const history = [before];
  let length = 0;
  while (length < tr.len * 2) {
    const last = history[0], node = berth.dir === 1 ? last.a : last.b;
    const previous = sim.topo.nodes[node].links.map(id => sim.topo.links[id])
      .find(l => l.id !== last.id && l.track === platform.track && l.normalDir === berth.dir);
    if (!previous) break;
    history.unshift(previous); length += previous.len;
  }
  const approachStation = orderedStations(direction === 'DN' ? 'UP' : 'DN', arrival.station)[2];
  const distant = sim.topo.berths[platformBerth(sim.topo, approachStation, direction)];
  const current = near ? before : sim.topo.links[distant.link];
  expect(current).toBeDefined();
  const off = near ? (berth.dir === 1 ? current.len : 0) : distant.offset;
  Object.assign(tr, { link: current.id, off, dir: berth.dir,
    hist: (near ? history.slice(0, history.indexOf(current) + 1) : [current]).map(l => ({ link: l.id, dir: berth.dir })),
    tasks, phase: 'run', block: -1, tripId: -1, v: 0, a: 0, maSigs: [], lastMa: Infinity, lastDs: 0 });
  if (near) moveBack(sim, tr, 6.6);
  expect(tr.off).toBeGreaterThanOrEqual(0);
  expect(tr.off).toBeLessThanOrEqual(sim.topo.links[tr.link].len);
  computeBody(sim, tr); indexBodies(sim); computeOccupancy(sim);
  expect(tr.body.reduce((n, b) => n + b.to - b.from, 0)).toBeCloseTo(tr.len);
  expect(tr.body.some(b => topologyResourceLinks(sim.topo).has(b.link))).toBe(false);
  const signal = signalAheadFrom(sim, tr.link, tr.off, tr.dir, Infinity)!;
  tr.nextSignal = signal.sig; tr.nextSignalDist = signal.dist;
  const request = collectResourceRequests(sim).find(r => r.id === tr.id);
  const allocation = arbitrateResources(sim), decision = allocation.decisions.get(tr.id);
  if (near) {
    expect(request?.inside).toBe(true);
    expect(decision?.admitted).toBe(true);
    expect(decision?.option.entry).toBe(-1);
    const rid = decision!.option.phases[0].routes[0];
    expect(resourceAdmissionBlocked(sim, tr, rid)).toBe(false);
    runARS(sim, true);
    expect(sim.routes.has(rid)).toBe(true);
  } else {
    expect(request).toBeUndefined();
    expect(decision).toBeUndefined();
    expect(allocation.claims.size).toBe(0);
  }
  expect(sim.integrity.violations).toEqual([]);
});

// A real shared depot mouth, selected by topology capability rather than site id.
function newApplicantRoute(keepPeer = false) {
  const sim = new Sim({ dayType: 'weekday', date: '2026-10-19', dateLabel: 'resource route lifecycle', startTime: 14400, seed: 7, noPossessions: true });
  const tr = sim.trainList[0];
  const peer = keepPeer ? sim.trainList[1] : undefined;
  for (const other of [...sim.trainList]) if (other !== tr && other !== peer) sim.removeTrain(other);
  if (peer) { peer.tasks = []; peer.phase = 'stabled'; peer.maSigs = []; }
  for (const rid of [...sim.routes.keys()]) releaseRoute(sim, rid);
  for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
  sim.resourceTransit.clear();
  const candidates = sim.topo.depots.flatMap(depot => (['DN','UP'] as const).flatMap(direction => {
    if (!depot.portals.entry[direction].reverse || depot.transferPaths[depot.portals.entry[direction].path].flow !== 'shared') return [];
    const tasks: typeof tr.tasks = []; depotTasks(sim.topo,depot.id,direction,tasks);
    const arrival=tasks[0]; if(arrival.k !== 'stop') return [];
    const berth=sim.topo.berths[arrival.berth], platform=sim.topo.links[berth.link];
    const ordinaryDir=direction;
    const station=orderedStations(ordinaryDir,arrival.station)[1];
    if(station === undefined) return [];
    const goal=platformBerth(sim.topo,station,ordinaryDir), dir=-berth.dir as 1|-1;
    const reverseBerth=sim.topo.berths.find(b=>b.link===platform.id&&b.dir===dir&&b.kind==='platform');
    const after=reverseBerth&&reversedBerthPoint(sim.topo,reverseBerth.id,tr.len,[{link:platform.id,dir}]);
    return after&&Number.isFinite(distanceToBerthFrom(sim,after.link,after.off,after.dir,goal))
      ? [{depot,direction,tasks,arrival,berth,platform,reverseBerth:reverseBerth!,after}] : [];
  }));
  expect(candidates.length).toBeGreaterThan(0);
  const {depot,direction,tasks,arrival,berth,platform,reverseBerth,after}=candidates[0];
  const exitDir = -berth.dir as 1 | -1;
  const ordinaryDir = direction;
  const station = orderedStations(ordinaryDir, arrival.station)[1];
  expect(ahead(ordinaryDir,arrival.station,station)).toBe(true);
  const ordinaryTasks: typeof tr.tasks = [
    {k:'reverse',station:arrival.station,berths:[reverseBerth.id],chosen:reverseBerth.id,minTime:40},
    { ...arrival, station, berth:platformBerth(sim.topo,station,ordinaryDir), note:'ordinary alternative' }];
  tasks.splice(0,2);
  Object.assign(tr, { link: platform.id, off:reverseBerth.offset, dir:exitDir,
    hist: [{link:platform.id,dir:exitDir}], tasks, phase: 'run', block: -1,
    tripId: -1, v: 0, a: 0, maSigs: [], lastMa: Infinity, lastDs: 0 });
  computeBody(sim, tr); indexBodies(sim); computeOccupancy(sim);
  const signal = signalAheadFrom(sim, tr.link, tr.off, tr.dir, Infinity)!;
  tr.nextSignal = signal.sig; tr.nextSignalDist = signal.dist;
  const decision = arbitrateResources(sim).decisions.get(tr.id)!;
  expect(decision.admitted).toBe(true);
  const rid = decision.option.phases[0].routes[0];
  const first = sim.topo.routes[rid].steps[0], firstLink = sim.topo.links[first.link];
  expect(tr.dir === 1 ? platform.b : platform.a).toBe(first.dir === 1 ? firstLink.a : firstLink.b);
  expect(routeNeedsResourceProtection(sim,rid,decision.option)).toBe(true);
  expect(sim.routes.has(rid)).toBe(false);
  runARS(sim, true);
  const route = sim.routes.get(rid)!;
  expect(route).toBeDefined();
  expect(route.arsTrain).toBe(tr.id);
  expect(route.fleeting).toBe(false);
  expect(sim.topo.routes[rid].fleeting).toBe(false);
  expect(route.entered).toBe(false);
  expect(routeOccupant(sim, rid)).toBeUndefined();
  expect(tr.body.reduce((n, b) => n + b.to - b.from, 0)).toBeCloseTo(tr.len);
  expect(tr.body.every(b => b.from >= 0 && b.to <= sim.topo.links[b.link].len && b.to >= b.from)).toBe(true);
  sim.t += 6; updateInterlocking(sim);
  expect(route.state).toBe('locked');
  expect(['G','Y']).toContain(sim.sig[sim.topo.routes[rid].start].aspect);
  expect(tr.off).toBeCloseTo(reverseBerth.offset);
  expect(reverseBerth.dir).toBe(tr.dir);
  expect(after.link).toBe(tr.link);
  expect(after.dir).toBe(-tr.dir);
  expect(distanceToBerthFrom(sim,tr.link,tr.off,tr.dir,reverseBerth.id)).toBe(0);
  const ordinaryGoal = ordinaryTasks[1]; if (ordinaryGoal.k !== 'stop') throw Error('ordinary stop required');
  const ordinaryDistance = distanceToBerthFrom(sim,after.link,after.off,after.dir,ordinaryGoal.berth);
  expect(Number.isFinite(ordinaryDistance)).toBe(true);
  expect(ordinaryDistance).toBeGreaterThan(0);
  console.log(JSON.stringify({ fixture: 'fresh shared-mouth applicant', depot:depot.id, rid, signal: sim.topo.routes[rid].start,
    defaultFleeting: sim.topo.routes[rid].fleeting, body: tr.body, tasks: tr.tasks, ordinaryGoal,ordinaryDistance }));
  return { sim, tr, rid, route, start: sim.topo.routes[rid].start, ordinaryTasks, peer };
}

it('releases its own unused resource route when only its tasks leave that resource', () => {
  const { sim, tr, rid, route, start, ordinaryTasks } = newApplicantRoute();
  const posture = JSON.stringify({ link: tr.link, off: tr.off, dir: tr.dir, body: tr.body, ma: tr.maSigs });
  tr.tasks = ordinaryTasks;
  runARS(sim);
  expect(sim.trains.get(tr.id)).toBe(tr);
  expect(JSON.stringify({ link: tr.link, off: tr.off, dir: tr.dir, body: tr.body, ma: tr.maSigs })).toBe(posture);
  // A default automatic route may legitimately be restored. The old applicant's
  // nonfleeting lock must be gone, not just a bookkeeping flag on that lock.
  expect(sim.routes.get(rid)).not.toBe(route);
  const restored = sim.routes.get(rid);
  if (restored) {
    expect(restored.fleeting).toBe(true);
    expect(restored.arsTrain ?? -1).toBe(-1);
  } else {
    expect(sim.sig[start].route).not.toBe(rid);
    for (const section of sim.topo.routes[rid].sections) expect(sim.sec[section].lockRoute).not.toBe(rid);
  }
});

it('keeps an entered resource route after its applicant changes tasks', () => {
  const { sim, tr, rid, route, start, ordinaryTasks } = newApplicantRoute();
  const first = sim.topo.routes[rid].steps[0];
  tr.hist.push({ link: first.link, dir: first.dir });
  tr.link = first.link; tr.dir = first.dir;
  tr.off = first.dir === 1 ? 2 : sim.topo.links[first.link].len - 2;
  computeBody(sim, tr); indexBodies(sim); computeOccupancy(sim);
  signalPassed(sim, tr.id, start);
  expect(routeOccupant(sim, rid)?.train).toBe(tr.id);
  expect(route.entered).toBe(true);
  expect(tr.body.reduce((n,b)=>n+b.to-b.from,0)).toBeCloseTo(tr.len);
  tr.tasks = ordinaryTasks;
  runARS(sim);
  expect(sim.routes.get(rid)).toBe(route);
  expect(routeOccupant(sim, rid)?.train).toBe(tr.id);
  expect(sim.sig[start].route).toBe(rid);
});

it('keeps the issued authority when its applicant cannot safely stop at the entrance', () => {
  const { sim, tr, rid, route, start, ordinaryTasks } = newApplicantRoute();
  tr.v = 15; tr.maSigs = [start];
  expect(canStopBeforeSignal(sim, tr, start, 'supervision')).toBe(false);
  const ma = [...tr.maSigs];
  tr.tasks = ordinaryTasks;
  runARS(sim);
  expect(sim.routes.get(rid)).toBe(route);
  expect(sim.sig[start].route).toBe(rid);
  expect(tr.maSigs).toEqual(ma);
  expect(route.cancelAt).toBe(0);
});

it('cannot cancel a nonfleeting route assigned to another extant train', () => {
  const { sim, tr, rid, route, start, ordinaryTasks, peer } = newApplicantRoute(true);
  expect(peer).toBeDefined();
  releaseRoute(sim,rid);
  expect(trySetRoute(sim,rid,{fleeting:false,train:peer!.id}).ok).toBe(true);
  const foreign = sim.routes.get(rid)!;
  expect(foreign).not.toBe(route);
  tr.tasks = ordinaryTasks;
  const result = cancelArsRoute(sim,tr,start);
  expect(result.ok).toBe(false);
  expect(result.blocker).toBe(peer!.id);
  expect(sim.trains.get(peer!.id)).toBe(peer);
  expect(sim.routes.get(rid)).toBe(foreign);
  expect(sim.sig[start].route).toBe(rid);
  expect(foreign.arsTrain).toBe(peer!.id);
  expect(sim.integrity.violations).toEqual([]);
});
