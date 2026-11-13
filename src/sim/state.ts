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
import { invalidateResourceAllocation } from './resourceArbitration';
import { assertScope, currentScope, type LineScope } from '../data/scope';
import { copyWaitAlternatives } from './halt';

export interface Checkpoint {
  scope?: LineScope;
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

/** Sim's own data fields: its methods and the rng closure are not state. */
type SimField = { [K in keyof Sim]: Sim[K] extends (...args: never[]) => unknown ? never : K }[keyof Sim];

export const CLONED = [
  'sw', 'sec', 'sig', 'plat', 'zoneState', 'routes', 'routeUnlockedSw', 'berthRes', 'resourceTransit', 'depotStock', 'depotShortLogged', 'blockDone',
  'faults', 'alarms', 'noRouteLogged', 'yards', 'vehicles', 'stabledPool', 'calls', 'pendingCalls', 'env', 'possessions',
  'instructorSchedule', 'instructorOccurred', 'randomSchedule', 'randomFaultVehicles', 'ridership', 'metrics', 'scenario', 'dispatcher', 'integrity', 'bookmarks', 'incidents', 'connections', 'vehicleResets', 'energy',
] as const satisfies readonly SimField[];

export const SCALARS = [
  'ridershipTarget', 'instructorFired', 'dailyEvaluationEnded', 'passengerScale', 'nextTrainId', 'nextFaultId', 'passengersServed', 'passengersCleared', 'passengersStranded', 'depTotal', 'depOnTime', 'tripsDone',
  'nextCallId', 'autoRadio', 'autoDispatch', 'atoLine', 'scenarioFired', 'holidayFired', 'runLevel', 'randomLevel', 'nextRandomAt', 'nextBookmarkId', 'planRev',
] as const satisfies readonly SimField[];
type CheckpointField = (typeof CLONED)[number] | (typeof SCALARS)[number];

/** Train-owned state (doors, rescue duty/load, reverser, retreat, recent path, CM advisory, ATO buttons, DMI sequence,
 * departureDisplay.at/readyAt, UTO control/door warning/acknowledgement clocks) is carry: cloneTrain saves it with the vehicle and carryTrain shifts its clocks.
 * DAY_STATE below lists Sim-owned fields only; no duplicate top-level display clock is needed. */
/** Every checkpoint field must explicitly declare its operating-day ownership. */
export const DAY_STATE: Record<CheckpointField, 'carry' | 'daily'> = {
  sw: 'carry',
  sec: 'carry',
  sig: 'carry',
  plat: 'carry',
  zoneState: 'carry',
  routes: 'carry',
  routeUnlockedSw: 'carry',
  berthRes: 'carry',
  resourceTransit: 'carry',
  depotStock: 'carry',
  depotShortLogged: 'daily',
  blockDone: 'daily',
  faults: 'carry',
  alarms: 'carry',
  noRouteLogged: 'daily',
  yards: 'carry',
  vehicles: 'carry', // VehicleRecord.uto work and daily selection follow the real vehicle; carryWorld shifts its clock.
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

/**
 * The other Sim fields (the checkpoint's top level, indexes, worker/UI
 * settings). Together with DAY_STATE every Sim data field is declared: a new
 * field that is in neither does not compile (tests/continuous-day.test.ts
 * also checks the live object).
 *   carry   — moved explicitly by carryWorld / carryTrains (clocks shifted, ids kept)
 *   mixed   — the new day's own, plus what carryTrains appends
 *   daily   — built for each day from its config, or the day's own record (archived with the old day)
 *   derived — rebuilt from the topology or from other state, never carried by itself
 *   session — worker / UI settings, counters and flags of the running worker; worker.ts rollover
 *             re-applies speed, paused, pisStation and dmiTrain to the new day
 */
export const SIM_STATE: Record<Exclude<SimField, CheckpointField>, 'carry' | 'mixed' | 'daily' | 'derived' | 'session'> = {
  t: 'carry', // carryWorld: minus one day
  secAcc: 'carry',
  nextEventId: 'carry', // event ids stay unique across the archived days
  trains: 'carry', // carryTrains: ids kept, clocks shifted, trip/block ids remapped (carryTrain)
  trainList: 'carry',
  checkIntegrity: 'carry', // a run setting like autoDispatch
  plan: 'mixed', // the new diagram plus the remaining duties of running trains (appendDuty)
  config: 'daily', // nextOperatingConfig: next date, session settings carried
  planCtx: 'daily',
  holiday: 'daily',
  rngState: 'daily', // seeded from the next config
  events: 'daily',
  newEvents: 'daily',
  inputLog: 'daily',
  depLog: 'daily',
  drivingStops: 'daily',
  startState: 'daily',
  removedTraces: 'daily',
  reportReady: 'daily',
  topo: 'derived',
  rt: 'derived',
  routeTable: 'derived',
  dayStart: 'derived',
  exposure: 'derived',
  linkBodies: 'derived', // indexBodies on addTrain
  bodyDirty: 'derived',
  alarmsDirty: 'derived',
  planDirty: 'derived',
  speed: 'session',
  paused: 'session',
  pisStation: 'session',
  dmiTrain: 'session', // a train id; train ids are kept
  replaying: 'session',
  stepsThisSecond: 'session',
  stepsPerSec: 'session',
  speedWanted: 'session',
  droppedPerSec: 'session',
};

/** Alarm keys numbered by the day's plan: block ids, trip ids (the last part
 * of the hot-standby / first-ready keys), and fleet-short's block-or-depot.
 * The new day numbers its plan from 0 again, so a carried one names another
 * duty and, while uncleared, swallows that duty's own alarm (Sim.log skips a
 * key already present; most of these are never cleared). Their record leaves
 * with the archived day; a condition still in force is raised again under the
 * new ids. */
export const DAILY_ALARM_KEY = /^(short|lost|stable-missing|standby|standby-short|fleet-short|hot|hotswap|firstready|source-departure)-[-\d]+$/;

function cloneTrain(tr: Train): Train {
  return {
    ...tr,
    ...(tr.lastCompletedCall ? { lastCompletedCall: { ...tr.lastCompletedCall } } : {}),
    uto: tr.uto && {...tr.uto},
    dmiAcknowledged: tr.dmiAcknowledged?.slice(),
    hist: tr.hist.slice(),
    vfault: tr.vfault ? { ...tr.vfault } : null,
    body: tr.body.map((b) => ({ ...b })),
    tasks: tr.tasks.slice(),
    rescueDuty: tr.rescueDuty && { ...tr.rescueDuty, tasks: tr.rescueDuty.tasks.slice(),
      targetTurnback: tr.rescueDuty.targetTurnback && { ...tr.rescueDuty.targetTurnback } },
    departureDisplay: tr.departureDisplay && { ...tr.departureDisplay },
    doorExchange: tr.doorExchange && { ...tr.doorExchange },
    doorMotion: tr.doorMotion && { ...tr.doorMotion },
    recentBody: tr.recentBody?.map(b => ({ ...b })),
    retreat: tr.retreat && { ...tr.retreat },
    atoButtons: tr.atoButtons && { ...tr.atoButtons },
    ato: tr.ato && structuredClone(tr.ato),
    atoMove: tr.atoMove && { ...tr.atoMove },
    dmiQueue: tr.dmiQueue?.map(m => ({ ...m })),
    dmiContext: tr.dmiContext && { ...tr.dmiContext },
    skipStations: new Set(tr.skipStations),
    trace: [],
    drv: { ...tr.drv, stops: tr.drv.stops.slice() },
    dmiLog: tr.dmiLog.slice(),
    dmiPrev: tr.dmiPrev && { ...tr.dmiPrev },
    halt: { ...tr.halt, alternatives: copyWaitAlternatives(tr.halt.alternatives) },
    arsWait: tr.arsWait && { ...tr.arsWait, alternatives: copyWaitAlternatives(tr.arsWait.alternatives) },
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
    scope: currentScope(),
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
    plan: { ...plan, trips: plan.trips.map(t => ({ ...t, ...(t.cut ? { cut: { ...t.cut } } : {}) })), blocks: structuredClone(plan.blocks),
      periods: plan.periods.slice(), overlays: plan.overlays.slice() },
    events: sim.events.slice(),
    depLog: sim.depLog.slice(),
    drivingStops: sim.drivingStops.slice(),
  };
}

export function restore(sim: Sim, cp: Checkpoint) {
  invalidateResourceAllocation(sim);
  assertScope(cp.scope);
  for (const input of cp.inputs ?? []) assertScope(input.scope);
  const rec = sim as unknown as Record<string, unknown>;
  for (const k of CLONED) if (k in cp.data) rec[k] = structuredClone(cp.data[k]);
  if (!('resourceTransit' in cp.data)) sim.resourceTransit.clear();
  for (const k of SCALARS) if (k in cp.data) rec[k] = cp.data[k];
  // D74: old checkpoints used a line-wide default of 1. Missing mode means
  // migrate to diagram operation; new manual overrides retain their level.
  sim.runLevel = cp.data.runLevelMode === 'override' && [1, 2, 3].includes(Number(cp.data.runLevel))
    ? Number(cp.data.runLevel) : 0;
  sim.t = cp.t;
  sim.secAcc = cp.secAcc;
  sim.rngState = cp.rngState;
  sim.inputLog = cp.inputs?.map(input => ({ ...input, scope: currentScope() })) ?? [];
  // trains
  sim.trains.clear();
  sim.trainList = cp.trains.map(cloneTrain);
  for (const tr of sim.trainList) sim.trains.set(tr.id, tr);
  indexBodies(sim);
  // plan
  sim.plan = { ...cp.plan, trips: cp.plan.trips.map(t => ({ ...t, ...(t.cut ? { cut: { ...t.cut } } : {}) })), blocks: structuredClone(cp.plan.blocks),
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
