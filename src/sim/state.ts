/**
 * Simulation checkpoints for rewind / replay (回放).
 *
 * A checkpoint is a deep copy of all dynamic state except the trains' task
 * lists, which are shared structurally: task objects are treated as
 * immutable (see cowTask in ats.ts), so only the arrays are copied. The plan
 * includes every trip and circulation so a fresh simulator can restore
 * timetable edits, together with events and integrity observation history.
 */
import type { Sim } from './engine';
import type { Train, Plan, SimEvent } from './model';
import { indexBodies } from './movement';
import { initVehicles } from './yard';

export interface Checkpoint {
  t: number;
  secAcc: number;
  rngState: number;
  nextEventId: number;
  depLogLen: number;
  drivingStopsLen: number;
  inputCursor: number;
  inputs: Sim['inputLog'];
  data: Record<string, unknown>;
  trains: Train[];
  plan: Plan;
  events: SimEvent[];
  depLog: Sim['depLog'];
  drivingStops: Sim['drivingStops'];
}

export const CLONED = [
  'sw', 'sec', 'sig', 'plat', 'zoneState', 'routes', 'routeUnlockedSw', 'berthRes', 'depotStock', 'depotShortLogged', 'blockDone',
  'faults', 'alarms', 'noRouteLogged', 'truncatedTrips', 'yards', 'vehicles', 'stabledPool', 'calls', 'pendingCalls', 'env', 'possessions',
  'instructorSchedule', 'instructorOccurred', 'randomSchedule', 'randomFaultVehicles', 'ridership', 'metrics', 'scenario', 'dispatcher', 'integrity', 'bookmarks', 'incidents', 'connections', 'vehicleResets', 'energy',
] as const;

export const SCALARS = [
  'ridershipTarget', 'instructorFired', 'dailyEvaluationEnded', 'passengerScale', 'nextTrainId', 'nextFaultId', 'passengersServed', 'passengersCleared', 'passengersStranded', 'depTotal', 'depOnTime', 'tripsDone',
  'nextCallId', 'autoRadio', 'autoDispatch', 'atoLine', 'scenarioFired', 'holidayFired', 'runLevel', 'randomLevel', 'nextRandomAt', 'nextBookmarkId', 'planRev',
] as const;

/** Train-owned state (doors, reverser, retreat, ATO buttons, DMI sequence) carries
 * with trains; their clocks are shifted by carryTrain, without Sim top-level fields. */
/** Every checkpoint field must explicitly declare its operating-day ownership. */
export const DAY_STATE: Record<(typeof CLONED)[number] | (typeof SCALARS)[number], 'carry' | 'daily'> = {
  sw: 'carry',
  sec: 'carry',
  sig: 'carry',
  plat: 'carry',
  zoneState: 'carry',
  routes: 'carry',
  routeUnlockedSw: 'carry',
  berthRes: 'carry',
  depotStock: 'carry',
  depotShortLogged: 'daily',
  blockDone: 'daily',
  faults: 'carry',
  alarms: 'carry',
  noRouteLogged: 'daily',
  truncatedTrips: 'daily',
  yards: 'carry',
  vehicles: 'carry',
  stabledPool: 'carry',
  calls: 'carry',
  pendingCalls: 'carry',
  env: 'carry',
  possessions: 'carry',
  instructorSchedule: 'daily',
  instructorOccurred: 'daily',
  randomSchedule: 'daily',
  randomFaultVehicles: 'daily',
  ridership: 'daily',
  metrics: 'daily',
  scenario: 'daily',
  dispatcher: 'carry',
  integrity: 'carry',
  bookmarks: 'daily',
  incidents: 'daily',
  connections: 'daily',
  vehicleResets: 'carry',
  energy: 'daily',
  ridershipTarget: 'daily',
  instructorFired: 'daily',
  dailyEvaluationEnded: 'daily',
  passengerScale: 'daily',
  nextTrainId: 'carry',
  nextFaultId: 'carry',
  passengersServed: 'daily',
  passengersCleared: 'daily',
  passengersStranded: 'daily',
  depTotal: 'daily',
  depOnTime: 'daily',
  tripsDone: 'daily',
  nextCallId: 'carry',
  autoRadio: 'carry',
  autoDispatch: 'carry',
  atoLine: 'carry',
  scenarioFired: 'daily',
  holidayFired: 'daily',
  runLevel: 'carry',
  randomLevel: 'daily',
  nextRandomAt: 'daily',
  nextBookmarkId: 'carry',
  planRev: 'daily',
};

function cloneTrain(tr: Train): Train {
  return {
    ...tr,
    hist: tr.hist.slice(),
    vfault: tr.vfault ? { ...tr.vfault } : null,
    body: tr.body.map((b) => ({ ...b })),
    tasks: tr.tasks.slice(),
    departureDisplay: tr.departureDisplay && { ...tr.departureDisplay },
    doorExchange: tr.doorExchange && { ...tr.doorExchange },
    doorMotion: tr.doorMotion && { ...tr.doorMotion },
    recentBody: tr.recentBody?.map(b => ({ ...b })),
    retreat: tr.retreat && { ...tr.retreat },
    atoButtons: tr.atoButtons && { ...tr.atoButtons },
    dmiQueue: tr.dmiQueue?.map(m => ({ ...m })),
    dmiContext: tr.dmiContext && { ...tr.dmiContext },
    skipStations: new Set(tr.skipStations),
    trace: [],
    drv: { ...tr.drv, stops: tr.drv.stops.slice() },
    dmiLog: tr.dmiLog.slice(),
    dmiPrev: tr.dmiPrev && { ...tr.dmiPrev },
    halt: { ...tr.halt },
    arsWait: tr.arsWait && { ...tr.arsWait },
  };
}

export function capture(sim: Sim): Checkpoint {
  const rec = sim as unknown as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const k of CLONED) data[k] = structuredClone(rec[k]);
  for (const k of SCALARS) data[k] = rec[k];
  data.runLevelMode = sim.runLevel === 0 ? 'diagram' : 'override';
  const plan = sim.plan;
  return {
    t: sim.t,
    secAcc: sim.secAcc,
    rngState: sim.rngState,
    nextEventId: sim.nextEventId,
    depLogLen: sim.depLog.length,
    drivingStopsLen: sim.drivingStops.length,
    inputCursor: sim.inputLog.length,
    inputs: sim.inputLog.slice(),
    data,
    trains: sim.trainList.map(cloneTrain),
    // Stop arrays are immutable; cancellation and block assignment live on trip objects.
    plan: { ...plan, trips: plan.trips.map(t => ({ ...t })), blocks: structuredClone(plan.blocks),
      periods: plan.periods.slice(), overlays: plan.overlays.slice() },
    events: sim.events.slice(),
    depLog: sim.depLog.slice(),
    drivingStops: sim.drivingStops.slice(),
  };
}

export function restore(sim: Sim, cp: Checkpoint) {
  const rec = sim as unknown as Record<string, unknown>;
  for (const k of CLONED) if (k in cp.data) rec[k] = structuredClone(cp.data[k]);
  for (const k of SCALARS) if (k in cp.data) rec[k] = cp.data[k];
  // D74: old checkpoints used a line-wide default of 1. Missing mode means
  // migrate to diagram operation; new manual overrides retain their level.
  sim.runLevel = cp.data.runLevelMode === 'override' && [1, 2, 3].includes(Number(cp.data.runLevel))
    ? Number(cp.data.runLevel) : 0;
  sim.t = cp.t;
  sim.secAcc = cp.secAcc;
  sim.rngState = cp.rngState;
  sim.inputLog = cp.inputs?.slice() ?? [];
  // trains
  sim.trains.clear();
  sim.trainList = cp.trains.map(cloneTrain);
  for (const tr of sim.trainList) sim.trains.set(tr.id, tr);
  indexBodies(sim);
  // plan
  sim.plan = { ...cp.plan, trips: cp.plan.trips.map(t => ({ ...t })), blocks: structuredClone(cp.plan.blocks),
    periods: cp.plan.periods.slice(), overlays: cp.plan.overlays.slice() };
  sim.planDirty = true;
  // logs
  sim.events = cp.events.slice();
  sim.nextEventId = cp.nextEventId;
  sim.newEvents = [];
  sim.alarmsDirty = true;
  sim.depLog = cp.depLog.slice();
  sim.drivingStops = cp.drivingStops.slice();
  sim.removedTraces = [];
  sim.reportReady = null;
  if (!(cp.data.vehicles instanceof Map)) { sim.vehicles.clear(); initVehicles(sim); }
}

/** compact fingerprint of the dynamic state (tests: replay determinism) */
export function fingerprint(sim: Sim): string {
  return sim.trainList.map((tr) => `${tr.id}:${tr.link}:${tr.off.toFixed(3)}:${tr.v.toFixed(4)}:${tr.phase}:${tr.tasks.length}`).join('|')
    + `#${sim.t.toFixed(1)}#${sim.rngState}#${sim.tripsDone}`;
}
