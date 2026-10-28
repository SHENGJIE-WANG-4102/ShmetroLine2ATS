/**
 * Operating-day rollover (D111). The world runs on: trains, vehicle numbers,
 * line stabling, possessions, faults, routes and the weather all carry over.
 * Only what belongs to one day is new: the diagram, the daily figures, the
 * day's random events and tonight's possessions. Each day keeps its own
 * clock (04:00–27:45), so carried state has its times moved back one day.
 */
import { describeTask, type Sim } from './engine';
import { DAY_STATE } from './state';
import { yardCount, dayNumber } from './yard';
import { dateLabel, dayTypeOf, isoDate, parseIso } from './calendar';
import type { Block, Possession, SimConfig, StopTask, Task, Train, Trip } from './model';
import { copyWaitAlternatives } from './halt';

export const DAY_S = 86400;
/** a time of the old day on the new day's clock; unset markers (0, -1, ∞) stay */
const back = (v: number) => Number.isFinite(v) && v > 0 ? v - DAY_S : v;

/** Carry every session setting through one shared config, then refresh the date. */
export function nextOperatingConfig(sim: Sim): SimConfig {
  const date=parseIso(sim.config.date!); date.setDate(date.getDate()+1);
  const {scenario: _scenario,...config}=sim.config;
  return {...config,date:isoDate(date),dateLabel:dateLabel(date,false),dayType:dayTypeOf(date,false),
    depotStock: availableStock(sim, dayNumber(sim.config) + 1),
    startTime:4*3600,seed:sim.config.seed+1,autoRadio:sim.autoRadio,randomFaults:sim.randomLevel,driveMode:sim.atoLine?'ATO':'DTO'};
}

/** Vehicles each depot can send out tomorrow: those in its yard and the
 * trains on their way home to it. */
export function availableStock(sim: Sim, day = dayNumber(sim.config)): number[] {
  const stock = sim.yards.map(yardCount);
  for (const tr of sim.trainList) {
    const task = tr.tasks.find(t => t.k === 'depot');
    if (task?.k === 'depot') stock[task.depot] += tr.coupledVehicle ? 2 : 1;
  }
  for (const record of sim.vehicles.values()) if (record.work && record.until <= day) stock[record.depot]++;
  return stock;
}

/** trains still running at the rollover: they carry on into the new day */
export function unfinishedAtRollover(sim: Sim): string[] {
  return sim.trainList.filter(t => t.v >= .05 || (t.tasks.length && t.tasks[0].k !== 'stable' && !(t.tasks[0].k === 'stop' && t.tasks[0].stabledOut)))
    .map(t=>`${t.vehicle}（${t.svc}-${t.tripNo}，${sim.topo.sections[sim.topo.links[t.link].section].name}，${t.tasks[0]?describeTask(sim,t.tasks[0]):'无后续任务'}）`);
}

/** Is the train's body on the slot of berth `id`? (changing ends moves the
 * head, not the occupied slot) */
export function standsAt(sim: Sim, tr: Train, id: number): boolean {
  const b = sim.topo.berths[id];
  return tr.link === b.link && Math.abs((tr.off - tr.dir * tr.len / 2) - (b.offset - b.dir * tr.len / 2)) < 5;
}

/**
 * Move the world of `from` (the old day, at its rollover) into `sim`, a new
 * day freshly built from the next config. Running trains keep their duty: its
 * remaining trips are appended to the new plan. Trains standing idle wait for
 * the new day's duty that starts where they stand (spawnStabled adopts them).
 * Returns the possessions still in force, for initPossessions.
 */
export function carryWorld(sim: Sim, from: Sim): Possession[] {
  // the new day's own spawns (fresh vehicles) give way to the real ones
  for (const tr of sim.trainList.slice()) sim.removeTrain(tr);
  for (const b of sim.plan.blocks) delete b.train;
  sim.removedTraces = [];
  const dest = sim as unknown as Record<string, unknown>, src = from as unknown as Record<string, unknown>;
  for (const [key, policy] of Object.entries(DAY_STATE)) if (policy === 'carry') dest[key] = structuredClone(src[key]);
  sim.t = from.t - DAY_S;
  sim.secAcc = from.secAcc;
  sim.nextEventId = from.nextEventId;
  sim.sw = from.sw.map(s => ({ ...s, moveUntil: back(s.moveUntil) }));
  sim.sec = from.sec.map(s => ({ ...s, poss: -1 }));
  sim.sig = from.sig.map(s => ({ ...s }));
  sim.plat = from.plat.map(p => ({ ...p, lastDep: back(p.lastDep), lastArr: back(p.lastArr), limitUntil: back(p.limitUntil) }));
  sim.zoneState = from.zoneState.slice();
  sim.routes = new Map([...from.routes].map(([k, r]) => [k, { ...r, guideUntil: back(r.guideUntil), cancelAt: back(r.cancelAt), setAt: back(r.setAt),
    occSeen: r.occSeen.slice(), released: r.released.slice() }]));
  sim.routeUnlockedSw = new Map([...from.routeUnlockedSw].map(([k, s]) => [k, new Set(s)]));
  sim.berthRes = new Map(from.berthRes);
  sim.yards = from.yards.map(y => ({ ...y, tracks: y.tracks.map(t => t.slice()) }));
  sim.depotStock = sim.yards.map(yardCount);
  sim.stabledPool = [];
  sim.faults = from.faults.filter(f => !f.repaired).map(f => ({ ...f, since: back(f.since), repairAt: back(f.repairAt), stageAt: back(f.stageAt),
    ...(f.maintenanceAt !== undefined ? { maintenanceAt: back(f.maintenanceAt) } : {}) }));
  sim.nextFaultId = from.nextFaultId;
  sim.alarms = new Map([...from.alarms].map(([k, e]) => [k, { ...e, t: back(e.t) }]));
  // possessions in force become this morning's, numbered first (initPossessions)
  const poss = from.possessions.filter(p => p.state !== 'done' && p.state !== 'cancelled' && (p.state !== 'planned' || p.to > from.t));
  sim.possessions = [];
  const pid = new Map(poss.map((p, i) => [p.id, i]));
  const target = <T extends { kind: string; target?: number }>(c: T): T | null => !c.kind.startsWith('poss') ? c
    : pid.has(c.target!) ? { ...c, target: pid.get(c.target!) } : null;
  sim.calls = from.calls.filter(c => c.state === 'ringing').flatMap(c => target({ ...c, t: back(c.t), deadline: back(c.deadline), ...(c.answeredAt !== undefined ? { answeredAt: back(c.answeredAt) } : {}) }) ?? []);
  sim.pendingCalls = from.pendingCalls.flatMap(c => { const spec = target(c.spec); return spec ? [{ at: back(c.at), spec }] : []; });
  sim.nextCallId = from.nextCallId;
  sim.env = { ...from.env, windUntil: back(from.env.windUntil), rainUntil: back(from.env.rainUntil), dryAt: back(from.env.dryAt), slick: from.env.slick.map(s => ({ ...s })) };
  sim.vehicles = new Map([...from.vehicles].map(([no,r])=>[no,{...r,uto:r.uto&&{...r.uto,until:r.uto.until-DAY_S}}]));
  sim.vehicleResets = from.vehicleResets.map(r => ({ ...r, at: back(r.at) }));
  sim.dispatcher = { next: new Map([...from.dispatcher.next].filter(([,t]) => t > from.t).map(([k, t]) => [k, back(t)])) };
  sim.integrity.prevV = new Map([...from.integrity.prevV].filter(([id]) => from.trains.has(id)));
  sim.integrity.violations = [];
  sim.integrity.counts = {};
  for (const key of ['lastAt', 'cycles', 'stuckSince', 'heldSince'] as const) {
    const timers = sim.integrity[key] as Map<string | number, number>;
    for (const [id, time] of timers) timers.set(id, back(time));
  }
  // Alarm evidence belongs to the archived day. Rebuild keys together so
  // renumbering possession 5->0 cannot overwrite an old possession-0 alarm.
  sim.alarms = new Map([...sim.alarms].flatMap(([key, alarm]) => {
    if (alarm.cleared !== undefined) alarm.cleared = back(alarm.cleared);
    delete alarm.snapshot;
    if (!key.startsWith('poss-')) return [[key, alarm] as const];
    const id = pid.get(Number(key.slice(5)));
    return id === undefined ? [] : [[`poss-${id}`, { ...alarm, key: `poss-${id}` }] as const];
  }));

  carryTrains(sim, from);
  sim.planDirty = true;
  return poss.map(p => ({ ...p, sections: p.sections.slice(), from: back(p.from), to: back(p.to) }));
}

/** Rebind the continuing trains after the new day has reserved its workshop cars. */
export function carryTrains(sim: Sim, from: Sim) {
  sim.trains.clear(); sim.trainList = [];
  sim.nextTrainId = from.nextTrainId;
  for (const tr of from.trainList) {
    const done = !tr.tasks.length || tr.block < 0 || from.blockDone.has(tr.block);
    const map = done ? null : appendDuty(sim, from, tr);
    sim.addTrain(carryTrain(tr, map));
  }
}

/** Append the rest of a running train's duty to the new plan (new ids, the
 * new day's clock). Returns the trip id map and the new block id. */
function appendDuty(sim: Sim, from: Sim, tr: Train): { trips: Map<number, number>; block: number } {
  const old = from.plan.blocks[tr.block];
  const own = new Set(tr.tasks.flatMap(t => t.k === 'stop' && t.trip >= 0 ? [t.trip] : []));
  const at = old.trips.indexOf(tr.tripId);
  const keep = old.trips.filter((id, i) => own.has(id) || (at >= 0 && i >= at && !from.plan.trips[id].cancelled));
  // Allocate the complete map first: both ends of a retained link may be later
  // in the duty. Links outside this carried remainder end at its boundary.
  const block = sim.plan.blocks.length;
  const trips = new Map(keep.map((id, index) => [id, sim.plan.trips.length + index]));
  for (const id of keep) {
    const t = from.plan.trips[id] as Trip & { prev?: number; next?: number };
    const nid = trips.get(id)!;
    const carried: typeof t = { ...t, id: nid, block,
      prev: t.prev === undefined ? undefined : trips.get(t.prev),
      next: t.next === undefined ? undefined : trips.get(t.next),
      ...(t.cut ? { cut: { ...t.cut } } : {}),
      stops: t.stops.map(s => ({ ...s, arr: back(s.arr), dep: back(s.dep) })) };
    sim.plan.trips.push(carried);
  }
  const b: Block = { ...old, id: block, trips: keep.map(id => trips.get(id)!), train: tr.id,
    start: old.start.kind === 'depot' ? { ...old.start, time: back(old.start.time) } : old.start,
    ...(old.withdrawal ? { withdrawal: { ...old.withdrawal, at: back(old.withdrawal.at) } } : {}) };
  sim.plan.blocks.push(b);
  return { trips, block };
}

function carryTrain(tr: Train, duty: { trips: Map<number, number>; block: number } | null): Train {
  const trip = (id: number) => id < 0 ? id : duty?.trips.get(id) ?? -1;
  const lastCallTrip = tr.lastCompletedCall ? trip(tr.lastCompletedCall.trip) : -1;
  const task = <T extends Task>(k: T): T => k.k !== 'stop' ? structuredClone(k)
    : { ...k, trip: trip(k.trip), arr: k.arr === null ? null : back(k.arr), dep: k.dep === null ? null : back(k.dep) };
  return {
    ...tr,
    lastCompletedCall: tr.lastCompletedCall && lastCallTrip >= 0
      ? { ...tr.lastCompletedCall, trip: lastCallTrip } : undefined,
    uto: tr.uto && {...tr.uto,until:tr.uto.until-DAY_S,returnAt:tr.uto.returnAt===undefined?undefined:tr.uto.returnAt-DAY_S,closeAt:tr.uto.closeAt===undefined?undefined:tr.uto.closeAt-DAY_S},
    utoDoorWarningAt: tr.utoDoorWarningAt===undefined?undefined:tr.utoDoorWarningAt-DAY_S,
    dmiAcknowledged: tr.dmiAcknowledged?.map(key=>{const i=key.indexOf('|');return `${Number(key.slice(0,i))-DAY_S}${key.slice(i)}`;}),
    block: duty?.block ?? -1, tripId: trip(tr.tripId),
    ebSince: back(tr.ebSince), ebCallAt: back(tr.ebCallAt), modeSince: back(tr.modeSince), tbCallAt: back(tr.tbCallAt),
    pendingModeAt: back(tr.pendingModeAt), phaseSince: back(tr.phaseSince), dwellUntil: back(tr.dwellUntil),
    arrivedAt: back(tr.arrivedAt), depReadyAt: back(tr.depReadyAt), doorLockedAt: back(tr.doorLockedAt ?? 0), failRecoverAt: back(tr.failRecoverAt),
    doorExchange: tr.doorExchange && { ...tr.doorExchange },
    doorMotion: tr.doorMotion && { ...tr.doorMotion, trainAt: back(tr.doorMotion.trainAt), psdAt: back(tr.doorMotion.psdAt) },
    lastTraceT: back(tr.lastTraceT), stopUntil: back(tr.stopUntil), waitSince: back(tr.waitSince),
    halt: { ...tr.halt, alternatives: copyWaitAlternatives(tr.halt.alternatives), since: back(tr.halt.since), plannedUntil: back(tr.halt.plannedUntil), unplannedSince: back(tr.halt.unplannedSince) },
    arsWait: tr.arsWait && { ...tr.arsWait, alternatives: copyWaitAlternatives(tr.arsWait.alternatives), t: back(tr.arsWait.t) },
    drv: { ...tr.drv, since: back(tr.drv.since), stops: [] },
    vfault: tr.vfault && { ...tr.vfault, until: back(tr.vfault.until) },
    tasks: tr.tasks.map(task),
    ...(tr.pendingDeparture ? { pendingDeparture: task(tr.pendingDeparture) as StopTask } : {}),
    departureDisplay: tr.departureDisplay && { ...tr.departureDisplay, stop: task(tr.departureDisplay.stop),
      at: tr.departureDisplay.at === undefined ? undefined : back(tr.departureDisplay.at),
      readyAt: tr.departureDisplay.readyAt === undefined ? undefined : back(tr.departureDisplay.readyAt),
      headLeftAt: tr.departureDisplay.headLeftAt === undefined ? undefined : back(tr.departureDisplay.headLeftAt) },
    hist: tr.hist.slice(), body: tr.body.map(b => ({ ...b })), skipStations: new Set(tr.skipStations),
    autoStartAt: tr.autoStartAt === undefined ? undefined : tr.autoStartAt - DAY_S,
    autoOpenAt: tr.autoOpenAt === undefined ? undefined : tr.autoOpenAt - DAY_S,
    recentBody: tr.recentBody?.map(b => ({ ...b })),
    retreat: tr.retreat && { ...tr.retreat }, atoButtons: tr.atoButtons && { ...tr.atoButtons },
    ato: tr.ato && { ...structuredClone(tr.ato), arrival: tr.ato.arrival === null ? null : tr.ato.arrival - DAY_S },
    atoMove: tr.atoMove && { ...tr.atoMove },
    dmiQueue: tr.dmiQueue?.map(m => ({ ...m, at: m.at - DAY_S })),
    dmiContext: tr.dmiContext && { ...tr.dmiContext },
    trace: [], dmiLog: tr.dmiLog.map(m => ({ ...m, t: m.t - DAY_S })), dmiPrev: tr.dmiPrev && { ...tr.dmiPrev },
  };
}
