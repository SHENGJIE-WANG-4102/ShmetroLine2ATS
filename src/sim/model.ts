/**
 * Dynamic simulation state types (worker side) and the message protocol
 * shared with the UI thread.
 */
import type { Dir } from './topology';
import type { HaltCode, Halt, ArsWait } from './halt';
import type { TurnbackState, DepotState, PsdState, FaultState } from './fsm';

export type DayType = 'weekday' | 'weekend';
export type Level = 'CBTC' | 'TBTC';
/**
 * Driving mode. DTO = 有人值守的列车自动运行 (CBTC level only, P4);
 * AM = TBTC-level ATO (P2 §2.1.1); CM = ATP-protected manual; RM = restricted manual.
 */
export type Mode = 'DTO' | 'AM' | 'CM' | 'RM';
/** cause of an emergency brake application (decides how it may be released) */
export type EbCause = '' | 'atp' | 'overspeed' | 'comm' | 'zc' | 'spad' | 'rm' | 'driver';
/** train-level control mode selection (P1 表3: 自动 / 强制CBTC / 强制TBTC) */
export type ForceLevel = 'AUTO' | 'CBTC' | 'TBTC';
export type TrackDir = 'DN' | 'UP';
export type ZoneState = 'CBTC' | 'TBTC' | 'ZCFAIL';
export type Aspect = 'R' | 'G' | 'Y' | 'GUIDE' | 'DARK' | 'FAIL';

// ---------------------------------------------------------------- plan

export interface PlanStop {
  st: number;
  arr: number;
  dep: number;
  /** ATO level on the interval departing this stop (D74); absent in old plans = 1. */
  runLevel?: number;
  /** Diagram-only interval time adjustment, not a physical controller rule. */
  diagramRunAdjustmentS?: number;
  /** stops (doors) here; false = passes */
  stop: boolean;
  /** set-down only: passengers may alight but not board (定点班车) */
  noBoard?: boolean;
}

export type TripKind = 'big' | 'small' | 'late' | 'extra' | 'ins' | 'wd' | 'empty' | 'adj';

export interface Trip {
  id: number;
  no: string;
  dir: TrackDir;
  kind: TripKind;
  from: number;
  to: number;
  stops: PlanStop[];
  revenue: boolean;
  block: number;
  /** Revenue endpoint reached; rescue cancellation preserves already completed trips. */
  completed?: boolean;
  cancelled?: boolean;
  cancelReason?: string;
  /** label of the overlay template that created it */
  overlay?: string;
  /** after this trip the train stands as hot standby (热备) in a turnback
   *  track at `to` until its next trip (D70) */
  standby?: boolean;
}

/** Cancel a trip with its specific reason. The first reason given is kept
 * (a later, broader cancellation does not overwrite why it was dropped). */
export function cancelTrip(trip: Trip, reason: string) {
  if (!trip.cancelled || !trip.cancelReason) trip.cancelReason = trip.cancelReason ?? reason;
  trip.cancelled = true;
}

export type BlockEnd =
  | { kind: 'depot'; depot: number }
  | { kind: 'stable'; station: number; berth?: number }
  | { kind: 'none' };

export interface Block {
  id: number;
  svc: string;
  start: { kind: 'depot'; depot: number; time: number } | { kind: 'stable'; station: number; berth?: number };
  end: BlockEnd;
  trips: number[];
  /** A standby took over its later trips (R1, D45): the trips it keeps end
   * in a withdrawal, not at `end`, so no standby takes them over in turn. */
  relieved?: boolean;
  /** Actual withdrawal supersedes this train's former night home. `end`
   * remains the planned home inherited by a replacement taking its duty. */
  withdrawal?: { depot: number; at: number };
  /** train that is running this block (filled at runtime) */
  train?: number;
  /** Attached state for an integrity alarm. */
}

export interface Plan {
  dayType: DayType;
  /** Actual inventory inherited at rollover, absent for the normal initial day. */
  initialStock?: number[];
  trips: Trip[];
  blocks: Block[];
  /** service template periods for display */
  periods: { from: number; to: number; template: string; label: string }[];
  /** `requested`: trips of the added-service grid (a↔b) put into the plan;
   * `peak`: grid trips not requested because the base plan already runs at
   * line capacity on their path (D47) */
  overlays: { id: string; label: string; from: number; to: number; requested?: number; peak?: number }[];
  fleetPeak: number;
}

// ---------------------------------------------------------------- tasks

/** a hot standby (热备, D70) is called up to its departure platform this long before it is due (s) */
export const STANDBY_CALL = 240;

export interface StopTask {
  k: 'stop';
  berth: number;
  station: number;
  trip: number; // trip id, -1 when unplanned
  arr: number | null;
  dep: number | null;
  doors: boolean;
  /** passenger service at this stop (false for empty / clear-out) */
  revenue: boolean;
  /** minimum dwell override */
  minDwell?: number;
  note?: string;
  /** set-down only (定点班车): nobody boards here */
  noBoard?: boolean;
  /** the departure after a hot standby (热备): the train keeps to its
   *  turnback track until shortly before it (D70) */
  standby?: boolean;
  /** the first departure of a train stabled overnight: it keeps to its
   *  stabling place until shortly before it, like a hot standby (D72) */
  stabledOut?: boolean;
}
export interface ReverseTask { k: 'reverse'; berths: number[]; chosen: number; station: number; minTime: number }
export interface DepotTask { k: 'depot'; depot: number; /** 入段 berth of the lead used (default: the depot's) */ berth?: number }
export interface StableTask { k: 'stable'; berth: number; reason: string; /** station whose tracks a berth of -1 is chosen from (default: the train's last station) */ station?: number }
export interface RescueTask { k: 'rescue'; target: number }
export type Task = StopTask | ReverseTask | DepotTask | StableTask | RescueTask;

// ---------------------------------------------------------------- trains

/** a door / brake fault in progress on a train (vehicle.ts, D64) */
export interface VehicleFault {
  kind: 'door' | 'brake';
  /** 1: the driver can isolate / cut it out; 2: he cannot */
  sev: 1 | 2;
  /** armed: waits for the next door close / departure */
  stage: 'armed' | 'stuck' | 'decide' | 'maintainer' | 'lock';
  until: number;
  fault: number;
  /** brake: a release attempt succeeds */
  recover: boolean;
  car: number;
  door: number;
}

export interface BodySeg { link: number; from: number; to: number }

export type TrainPhase =
  | 'run'
  | 'dwell'
  | 'reversing'
  | 'stabled'
  | 'failed'
  | 'coupling'
  | 'depotExit';

export interface Train {
  id: number;
  vehicle: string;
  svc: string;
  tripNo: string;
  tripId: number;
  block: number;
  destText: string;
  destStation: number;
  // kinematics
  link: number;
  off: number;
  dir: Dir;
  hist: { link: number; dir: Dir }[];
  body: BodySeg[];
  len: number;
  v: number;
  a: number;
  // control
  level: Level;
  comm: boolean;
  mode: Mode;
  eb: boolean;
  ebReason: string;
  ebSince: number;
  ebCause: EbCause;
  /** EB release authorised by the dispatcher (driver report → authorisation → release) */
  ebAuth: boolean;
  /** last time the driver reported the EB / asked for its release */
  ebCallAt: number;
  /** train-level CBTC/TBTC selection */
  forceLevel: ForceLevel;
  /** why this train may not run DTO ('' = it may): under CBTC it runs ATO
   *  with the driver in the cab (AM) instead (DTO degraded, D52) */
  dtoInhibit: string;
  /** section where CBTC became available again; the upgrade waits for the next section boundary (relocalisation) */
  relocSec: number;
  /** last mode / level change */
  modeSince: number;
  /** signal the RM authorisation is bound to (-1 = none: RM gives no authority to pass a signal at danger) */
  rmSig: number;
  /** signal passed at danger (-1 none), until the incident is closed */
  spadSig: number;
  /** turnback and depot-move stages (fsm.ts TURNBACK / DEPOT) */
  tbStage: TurnbackState;
  tbExitSig: number;
  tbCallAt: number;
  depotStage: DepotState;
  maDist: number;
  maReason: string;
  /** machine-readable cause of the MA end and the train causing it (-1 none) */
  maCode: HaltCode;
  maTrain: number;
  maFarCode: HaltCode;
  maFarTrain: number;
  /** distance moved and MA in force during the last fixed step (invariant checks) */
  lastDs: number;
  lastMa: number;
  /** the EOA was pulled back under the moving train further than it can stop (MA withdrawn: ESP, axle disturbance, ZC/interlocking); cleared at standstill */
  maCut: boolean;
  /** signals the current movement authority passes (MA approach locking of their routes) */
  maSigs: number[];
  /** ATS route-setting wait (why the next route is not set) */
  arsWait: ArsWait | null;
  /** current stop reason */
  halt: Halt;
  /** full-length MA from the last 1 s refresh, reduced by the distance travelled since */
  maFar: number;
  maFarReason: string;
  vTarget: number;
  vPermit: number;
  stopDist: number;
  /** RM authorisation remaining metres (0 = none), and reason */
  rmAuth: number;
  rmReason: string;
  /** when > now, a mode transition (driver action) is pending */
  pendingModeAt: number;
  pendingMode: Mode | null;
  pendingLevel: Level | null;
  // service
  tasks: Task[];
  phase: TrainPhase;
  phaseSince: number;
  dwellUntil: number;
  doorsOpen: boolean;
  /** Actual close/lock confirmation time, independent of the planned departure.
   * Optional for saved worlds written before this clock was introduced. */
  doorLockedAt?: number;
  /** Physical door sequence. PSD leads train-door closure; opening is offset.
   * Train-owned clocks carry across midnight with the real vehicle. */
  doorMotion?: { kind: 'opening' | 'closing'; platform: number; psdAt: number; trainAt: number; psl?: boolean; psdDone?: boolean };
  /** manual driving: side whose doors the driver has opened ('' all closed) */
  doorSide: '' | 'L' | 'R';
  /** manual driving: stopped at the mark, waiting for the driver to open the doors */
  doorsAwait: boolean;
  arrivedAt: number;
  depReadyAt: number;
  /** Door cycle complete; DEP is recorded only when wheels start. */
  pendingDeparture?: StopTask;
  /** Last platform retained until five seconds after the head leaves it.
   * Physical distance is integrated by the simulator, never by UI frames. */
  departureDisplay?: { stop: StopTask; remaining?: number; side: '' | 'L' | 'R'; headLeftAt?: number };
  load: number;
  delay: number;
  hold: boolean;
  /** Dispatcher release bypasses interval metering for this station departure only. */
  intervalRelease?: number;
  intervalWait?: { train: number; detail: string };
  skipStations: Set<number>;
  /** vehicle faults (vehicle.ts): inverters cut out, doors isolated, speed cap from a cut-out brake (m/s) */
  tractionCut: number;
  doorsCut: number;
  vCap: number;
  vfault: VehicleFault | null;
  /** withdraw at the end of the current trip (终点站下线) */
  withdrawAtEnd: boolean;
  /** wheels at the adhesion limit this step: spinning in traction, sliding under braking */
  slip: '' | 'slip' | 'slide';
  /** metres past the stopping point after sliding (ATO), 0 none (adhesion.ts) */
  overrun: number;
  /** ATO coasting in its run-level band (energy.ts) */
  coast: boolean;
  /** train status flags */
  failed: boolean;
  failRecoverAt: number;
  failRecoverable: boolean;
  rescueBy: number;
  /** Stationary change of ends made for an opposing terminal-tail rescue. */
  rescueReverse?: boolean;
  rescuing: number;
  coupledLen: number;
  inService: boolean;
  /** next signal ahead (for display / ARS) */
  nextSignal: number;
  nextSignalDist: number;
  lastStation: number;
  /** recorded actual graph points since last snapshot */
  trace: number[];
  lastTraceT: number;
  lastTraceCh: number;
  stopsMade: number;
  overspeedEvents: number;
  passedRed: number;
  withdrawn: boolean;
  /** duty (表号) of the standby that took over this train's remaining trips (D45) */
  relievedBy?: string;
  /** psd bypass extra dwell */
  extraDwell: number;
  // manual driving (人工驾驶接管)
  manual: boolean;
  /** master controller: -7..-1 brake, 0 coast, 1..4 traction; -8 = driver emergency brake */
  notch: number;
  /** most restrictive target ahead (DMI): speed m/s and distance m */
  tgtV: number;
  tgtD: number;
  tgtReason: string;
  /** vehicle coupled behind during a rescue move */
  coupledVehicle: string;
  /** per-stop accuracy records while driven manually */
  drv: DriveRecord;
  /** dispatcher-imposed stop in section (passenger alarm etc.), until sim time */
  stopUntil: number;
  stopReason: string;
  /** set while the train has been standing at an obstacle (for driver calls) */
  waitSince: number;
  /** emergency brake intervention speed (permitted speed + ATP tolerance), m/s */
  vEbi: number;
  /** cab DMI message log (oldest first) and the state it was last compared against */
  dmiLog: DmiMsg[];
  dmiPrev: DmiPrev | null;
}

export interface DmiMsg { t: number; m: string; k: 'info' | 'warn' | 'alarm' }
export interface DmiPrev { avail: string; comm: boolean; mode: string; eb: boolean; hold: boolean; stop: boolean; failed: boolean; over: boolean }

/** what the cab DMI needs beyond the train snapshot */
export interface DmiData {
  train: number;
  /** "T" + 4 digits */
  trainNo: string;
  vehicleType: string;
  dest: string;
  next: string;
  /** newest first */
  log: DmiMsg[];
  /** departure time at the current / next stop (sim s), -1 when none */
  dep: number;
  /** total dwell (s) while dwelling, for the countdown bar, else 0 */
  dwellTotal: number;
  /** highest mode the equipment could offer now */
  avail: { mode: Mode; level: Level };
  psd: 'none' | 'closed' | 'open' | 'fault' | 'bypass';
  trainDoor: 'closed' | 'closing' | 'open' | 'fault' | 'isolated';
  /** Platform sign, located from the departure signal; never a DMI countdown. */
  departureBoard?: { at: number; signalName: string; signalOffset: number; aspect: Aspect;
    held: boolean; headLeftAt?: number; remaining: number; side: '' | 'L' | 'R'; station: number };
  /** stopping window indicator (hexagon) */
  stopWin: 'none' | 'ahead' | 'aligned' | 'short' | 'over';
  vEbi: number;
  /** movement authority length (m), -1 when not supervised */
  maDist: number;
  /** calendar date of the current sim time, YYYY/MM/DD ('' when unknown) */
  date: string;
}

export interface StopScore { t: number; station: number; err: number; score: number; note: string }
export interface DriveRecord {
  stops: StopScore[]; overspeed: number; spad: number; since: number;
  /** current station approach: brake releases while moving (0 at the stop = 一把闸), braking now, stopped short once (二次对标) */
  releases: number; braking: boolean; restop: boolean;
}

// ---------------------------------------------------------------- infrastructure state

export interface SwitchState {
  pos: 'N' | 'R';
  target: 'N' | 'R';
  moveUntil: number;
  failed: boolean;
  fieldLock: boolean;
  singleLock: boolean;
  lockCount: number;
  /** 道岔封锁: no route may be set over it (single operation still possible) */
  blocked: boolean;
}

export interface SectionState {
  occ: boolean; // axle counter occupied (incl. fault)
  trainOcc: boolean; // physically occupied by any train body
  commOnly: boolean; // occupied only by communicating CBTC trains
  disturbed: boolean; // axle counter fault (受扰/故障占用)
  preset: boolean; // 预复位, awaiting sweep
  presetSeen: boolean;
  lockRoute: number; // active route id or -1
  tsr: number; // km/h, 0 = none
  /** 区段封锁 (no routes, no movement authority into it) */
  blocked: boolean;
  /** engineering possession id holding this section (-1 = none) */
  poss: number;
  /** environmental speed restriction (wind / rain), km/h, 0 = none; -1 = suspended */
  envTsr: number;
  /** CI direction control for a reverse turnback protection region (P3). */
  td: -1 | 0 | 1;
  tdRoute: number;
  tdTrain: number;
  directionEsp: boolean;
}

export interface ActiveRoute {
  route: number;
  state: 'setting' | 'locked';
  fleeting: boolean;
  /** former automatic route switched to one-shot by ARS */
  defleeted?: boolean;
  manual: boolean;
  guide: boolean;
  guideUntil: number;
  occSeen: boolean[];
  released: boolean[];
  entered: boolean;
  /** train that passed the start signal and owns the route (-1 = none) */
  owner: number;
  /** Train for which ARS requested this route, before it passes the start signal (-1 none). */
  arsTrain?: number;
  cancelAt: number; // delayed cancellation time (0 = none)
  /** train that could no longer stop before the signal when the route was cancelled: keeps its authority (-1 none) */
  committed: number;
  setAt: number;
  directionTrain?: number;
  directionReverse?: boolean;
  directionPullout?: boolean;
  directionGoal?: number;
}

export interface SignalState {
  aspect: Aspect;
  route: number; // active route id or -1
  failed: boolean;
  ars: boolean; // automatic route setting allowed at this signal
  autoPass: boolean; // fleeting (自动通过) enabled
}

export interface PlatformState {
  hold: boolean;
  skip: boolean;
  esp: boolean; // emergency close
  psd: PsdState;
  psdFault: boolean;
  /** door / PSD linkage (联动) failure: doors worked from the PSL by station staff */
  psdLinkFault: boolean;
  psdBypass: boolean;
  /** train whose doors the PSD is currently linked to (-1 none) */
  psdTrain: number;
  waiting: number;
  surge: number; // multiplier
  stranded: number;
  lastDep: number;
  lastArr: number;
  /** station inflow control (限流) until sim time */
  limitUntil: number;
}

// ---------------------------------------------------------------- events

export type AlarmLevel = 'A' | 'B' | 'C' | 'I';

export interface SimEvent {
  id: number;
  t: number;
  level: AlarmLevel;
  cat: string;
  text: string;
  /** manual (dispatcher) event */
  manual?: boolean;
  /** true while it is an active alarm */
  alarm?: boolean;
  key?: string;
  ack?: boolean;
  cleared?: number;
  /** machine-readable code (stop reason / integrity violation kind) */
  code?: string;
  /** train concerned */
  train?: number;
  /** integrity alarm evidence, retained in diagnostics and replay */
  snapshot?: import('./invariants').DiagSnapshot;
}

export type FaultKind =
  | 'trainComm'
  | 'trainDto'
  | 'zcFail'
  | 'axle'
  | 'switch'
  | 'signal'
  | 'psd'
  | 'psdLink'
  | 'trainFail'
  | 'traction'
  | 'door'
  | 'brake'
  | 'surge'
  | 'pecu'
  | 'trackPerson';

export interface Fault {
  id: number;
  kind: FaultKind;
  target: number; // index of object (train id, zone, section, switch, signal, platform, station)
  since: number;
  /** maintenance completes at this time (Infinity = until "立即修复") */
  repairAt: number;
  repaired: boolean;
  text: string;
  /** extra parameters */
  param?: number;
  recoverable?: boolean;
  /** Timed field intervention for a failed train blocking an existing rescue. */
  maintenanceAt?: number;
  /** inject → effect → procedure → recovery → closed (fsm.ts FAULT) */
  stage: FaultState;
  /** when the stage was entered */
  stageAt: number;
}

// ---------------------------------------------------------------- commands (UI → worker)

export type Command =
  | { c: 'setRoute'; route: number }
  | { c: 'cancelRoute'; signal: number }
  | { c: 'guideRoute'; route: number }
  | { c: 'autoPass'; signal: number; on: boolean }
  | { c: 'ars'; signal: number; on: boolean }
  | { c: 'switchMove'; sw: number; pos: 'N' | 'R' }
  | { c: 'switchLock'; sw: number; on: boolean }
  | { c: 'switchFieldLock'; sw: number; on: boolean }
  | { c: 'axleReset'; section: number }
  | { c: 'sectionUnlock'; section: number }
  | { c: 'setTsr'; sections: number[]; kmh: number }
  | { c: 'cancelTsr'; sections: number[] }
  | { c: 'platformHold'; platform: number; on: boolean }
  | { c: 'platformSkip'; platform: number; on: boolean }
  | { c: 'platformEsp'; platform: number; on: boolean }
  | { c: 'psdBypass'; platform: number; on: boolean }
  | { c: 'trainHold'; train: number; on: boolean }
  | { c: 'trainSkip'; train: number; station: number; on: boolean }
  | { c: 'turnback'; train: number; station: number }
  | { c: 'withdraw'; train: number; reason?: string }
  | { c: 'recoverService'; train: number }
  | { c: 'exchangeDuty'; train: number; with: number }
  | { c: 'standby'; train: number }
  | { c: 'authRM'; train: number; signal?: number }
  | { c: 'ebRelease'; train: number }
  | { c: 'trainLevel'; train: number; level: ForceLevel }
  /** DTO allowed for the train (on) or degraded to ATO with the driver (off) */
  | { c: 'trainDto'; train: number; on: boolean }
  | { c: 'door'; train: number; side: 'L' | 'R' }
  /** whole line: ATO with drivers (on) or back to DTO (off) */
  | { c: 'lineAto'; on: boolean }
  | { c: 'rescue'; failed: number; rescuer: number }
  | { c: 'addTrain'; depot: number; dir: TrackDir; to: number; time: number }
  | { c: 'overlay'; id: string; from: number; to: number; headway: number }
  | { c: 'zoneLevel'; zones: number[]; level: 'CBTC' | 'TBTC' }
  | { c: 'ack'; ids: number[] }
  | { c: 'fault'; kind: FaultKind; target: number; duration: number; param?: number; recoverable?: boolean }
  | { c: 'repair'; fault: number }
  | { c: 'trainMaintenance'; fault: number }
  | { c: 'sectionBlock'; sections: number[]; on: boolean }
  | { c: 'switchBlock'; sw: number; on: boolean }
  | { c: 'manual'; train: number; mode: 'CM' | 'RM' | 'AUTO' }
  | { c: 'radio'; call: number; option: string }
  | { c: 'radioAuto'; on: boolean }
  | { c: 'env'; wind?: number; rain?: boolean; duration: number }
  | { c: 'lowAdhesion'; on: boolean }
  | { c: 'runLevel'; level: number }
  | { c: 'randomFaults'; level: number }
  | { c: 'scenarioEnd' }
  | { c: 'bookmark'; label: string };

export interface SimConfig {
  dayType: DayType;
  depotStock?: number[];
  dateLabel: string;
  /** ISO date of the operating day (YYYY-MM-DD), used for the day rollover */
  date?: string;
  startTime: number;
  seed: number;
  /** answer radio calls automatically with their default response (headless runs) */
  autoRadio?: boolean;
  /** automatic dispatcher works the fault recovery procedures (soak / probe runs) */
  autoDispatch?: boolean;
  /** scenario to run (instructor mode) */
  scenario?: string;
  /** random fault level 0..3 */
  randomFaults?: number;
  /** Selected event IDs; future timings stay inside the simulation checkpoint. */
  instructorEvents?: string[];
  /** no night engineering possessions (tests) */
  noPossessions?: boolean;
  /** 'ATO': the line runs ATO with drivers (DTO compatibility mode, D52) */
  driveMode?: 'DTO' | 'ATO';
}

export type ToWorker =
  | { type: 'init'; config: SimConfig }
  | { type: 'speed'; speed: number }
  | { type: 'pause'; paused: boolean }
  | { type: 'jump'; to: number }
  | { type: 'cmd'; id: number; cmd: Command }
  | { type: 'drive'; train: number; notch: number }
  | { type: 'pis'; station: number }
  | { type: 'dmi'; train: number }
  | { type: 'rewind'; to: number; replay: boolean }
  | { type: 'takeover' }
  | { type: 'diagnostics' }
  | { type: 'planPreview'; id: number; cmd: Extract<Command, { c: 'overlay' | 'addTrain' }> }
  | { type: 'restart'; config: SimConfig };

export interface TrainSnap {
  id: number;
  /** why DTO is not allowed for the train ('' = it is) */
  dto: string;
  vehicle: string;
  svc: string;
  trip: string;
  /** plan trip id (-1 none) */
  tripId: number;
  /** vehicle fault state for the train list ('' none): 牵引切除 / 门切除 / 限速 / 终点下线 */
  vehicleNote: string;
  dest: string;
  link: number;
  off: number;
  dir: Dir;
  body: number[]; // flat [link, from, to, ...]
  v: number;
  level: Level;
  comm: boolean;
  mode: Mode;
  eb: boolean;
  phase: TrainPhase;
  tbStage: TurnbackState;
  depotStage: DepotState;
  delay: number;
  load: number;
  hold: boolean;
  failed: boolean;
  doors: boolean;
  /** Close sequence is active; doors stays open/unlocked until confirmation. */
  doorClosing: boolean;
  doorSide: '' | 'L' | 'R';
  doorsAwait: boolean;
  /** side of the platform at the stop the train stands at or approaches ('' none) */
  platSide: '' | 'L' | 'R';
  inService: boolean;
  /** hot standby (热备, D70): standing for, or turning into, a standby departure */
  hot: boolean;
  chain: number;
  maReason: string;
  maDist: number;
  vPermit: number;
  nextSig: number;
  task: string;
  kind: string;
  rm: boolean;
  vTarget: number;
  tgtV: number;
  tgtD: number;
  tgtReason: string;
  /** grade under the head in the direction of travel (‰, + = climbing) */
  grade: number;
  slip: '' | 'slip' | 'slide';
  stopDist: number;
  a: number;
  manual: boolean;
  notch: number;
  dwellLeft: number;
  nextStation: number;
  /** Upcoming passenger call is bypassed by train/platform skip-stop; UI audio only. */
  nextStopSkipped?: boolean;
  ebReason: string;
  /** machine-readable stop reason while standing (halt.ts), null when running */
  halt: { code: string; label: string; detail: string; blocker: string; since: number } | null;
  /** signed distance to the stopping point (m, + = short) when near one, else NaN */
  stopErr: number;
  drv: DriveRecord | null;
  len: number;
}

/** a last-train connection with another line at an interchange (connections.ts, D63) */
export interface Connection {
  id: number;
  kind: 'feed' | 'onward';
  /** interchange station index */
  st: number;
  line: string;
  toward: string;
  /** other line, as planned: last arrival (feed) or departure (onward) */
  planned: number;
  /** the same with the day's delay (onward: plus any wait agreed) */
  actual: number;
  walk: number;
  dir: TrackDir;
  /** Line 2 trip and its planned departure (feed) or arrival (onward) here */
  trip: number;
  l2: number;
  pax: number;
  state: 'pending' | 'asked' | 'held' | 'waiting' | 'made' | 'missed' | 'void';
  /** we set the platform hold (feed, until the transfer is done) */
  holdUntil?: number;
}

export interface PisRow {
  dwellRemaining?: number; dest: string; /** destination station index (-1 unknown) */ destSt: number; /** set-down only here */ noBoard?: boolean; eta: number; status: 'eta' | 'arriving' | 'at' | 'departing'; trip: string; load: number }
export interface PisData {
  station: number; DN: PisRow[]; UP: PisRow[]; notice: string;
  /** the platform is passed by every train (跳停 / 封站) */
  skip?: Partial<Record<'DN' | 'UP', boolean>>;
  /** next planned departure with boarding (s), none: no more today */
  next?: Partial<Record<'DN' | 'UP', number>>;
  /** a planned departure with boarding already went today */
  done?: Partial<Record<'DN' | 'UP', boolean>>;
  /** planned departures with boarding still to come */
  ahead?: Partial<Record<'DN' | 'UP', number>>;
}

export interface RadioCall {
  id: number;
  t: number;
  from: string;
  kind: string;
  text: string;
  train?: number;
  station?: number;
  target?: number;
  options: { key: string; label: string; critical?: boolean }[];
  /** response chosen automatically in auto-answer mode / headless */
  auto: string;
  deadline: number;
  state: 'ringing' | 'answered' | 'expired' | 'withdrawn';
  answer?: string;
  answeredAt?: number;
  repeats: number;
}

export interface Possession { id: number; name: string; sections: number[]; from: number; to: number; state: 'planned' | 'requested' | 'active' | 'releasing' | 'done' | 'cancelled' }

export interface EnvState {
  wind: number; rain: boolean; windUntil: number; rainUntil: number;
  /** the exposed rail stays wet until then after the rain (adhesion.ts) */
  dryAt: number;
  /** slippery spots of the current wet spell, by main track and chainage */
  slick: { track: string; from: number; to: number }[];
  /** low-adhesion mode set by the dispatcher (低粘着模式) */
  lowAdh: boolean;
}

export interface YardState { tracks: string[][]; perTrack: number }
/** One vehicle's maintenance record (D112). Days are operating-day numbers
 * (`dayNumber`); `work` is what keeps it in the depot's workshop until `until`. */
export interface VehicleRecord { daily: number; monthly: number; km: number; work: '' | 'monthly' | 'overhaul'; depot: number; until: number }

export interface Metrics {
  since: number;
  /** final-arrival delays of revenue trips (s) */
  tripDelays: number[];
  tripsCompleted: number;
  /** passengers boarded in the window (base of the affected-passenger share) */
  boarded: number;
  departures: number;
  departuresLate: number;
  boardedDelayed: number;
  stranded: number;
  cleared: number;
  limited: number;
  safety: { spad: number; overspeed: number; rmNearMiss: number; unsafeAuth: number; espIgnored: number; overrun: number; wrongDoor: number };
  callsAnswered: number;
  callsExpired: number;
  faults: number;
}

export interface ScenarioState {
  id: string;
  name: string;
  start: number;
  end: number;
  objectives: string[];
  ended: boolean;
  report?: ScenarioReport;
}

export interface ScenarioReport {
  title: string;
  from: number;
  to: number;
  delayMinutes: number;
  affected: number;
  delivery: number;
  plannedTrips: number;
  deliveredTrips: number;
  punctuality: number;
  safety: Metrics['safety'];
  safetyTotal: number;
  callsAnswered: number;
  callsExpired: number;
  driving: { stops: number; avgErr: number; avgScore: number } | null;
  score: number;
  grade: string;
  notes: string[];
}

export interface Bookmark { id: number; t: number; label: string; auto: boolean }
export interface Incident { type: string; t: number; eventId: number; text: string }

export interface Ridership {
  generated: number;
  boardings: number[][];
  alightings: number[][];
  maxLoad: number;
  peakSectionLoad: number;
}

export interface Snapshot {
  t: number;
  speed: number;
  paused: boolean;
  dayType: DayType;
  dateLabel: string;
  sections: Uint16Array;
  sectionTsr: Uint8Array;
  switches: Uint8Array;
  signals: Uint8Array;
  platforms: Uint8Array;
  platformWaiting: Uint16Array;
  zones: ZoneState[];
  /** line-wide ATO operation (DTO compatibility mode) */
  atoLine: boolean;
  trains: TrainSnap[];
  depotCounts: number[];
  traces: { train: number; pts: number[] }[];
  ridership: Ridership;
  /** tonight's last-train connections, from 20:30 */
  connections: Connection[];
  energy: import('./energy').EnergyState;
  runLevel: number;
  stats: {
    online: number;
    inService: number;
    late: number;
    maxDelay: number;
    punctuality: number;
    tripsDone: number;
    tripsPlanned: number;
    passengers: number;
    stepsPerSec: number;
    /** requested acceleration over the last second (0 when paused) */
    speedWanted: number;
    /** acceleration achieved over the last second */
    speedActual: number;
    /** simulated seconds per wall second dropped: the CPU did not keep up */
    droppedPerSec: number;
    /** acceleration limit while a CM / RM train runs (Infinity: none) */
    speedCap: number;
  };
  activeRoutes: number[];
  faults: Fault[];
  calls: RadioCall[];
  env: EnvState;
  possessions: Possession[];
  yards: YardState[];
  vehicles: Map<string, VehicleRecord>;
  pis: PisData | null;
  dmi: DmiData | null;
  scenario: ScenarioState | null;
  randomLevel: number;
  autoRadio: boolean;
  metrics: Metrics;
  replay: { from: number; to: number; replaying: boolean; pending: number };
  bookmarks: Bookmark[];
  incidents: Incident[];
}

export type FromWorker =
  | { type: 'ready'; plan: Plan; config?: SimConfig }
  | { type: 'snap'; snap: Snapshot }
  | { type: 'events'; events: SimEvent[] }
  | { type: 'alarms'; alarms: SimEvent[] }
  | { type: 'plan'; plan: Plan }
  | { type: 'cmdResult'; id: number; ok: boolean; msg: string }
  | { type: 'progress'; t: number; target: number }
  | { type: 'startup'; phase:'diagram'|'cache'|'warmup'|'complete'; elapsed:number }
  | { type: 'rewound'; t: number; nextEventId: number }
  | { type: 'report'; report: ScenarioReport }
  | { type: 'call'; call: RadioCall }
  | { type: 'diagnostics'; json: string }
  | { type: 'dayArchive'; date:string; json:string }
  | { type: 'dayChanged'; text:string }
  | { type: 'planPreview'; id: number; preview: import('./planning').PlanPreview };

// bit flags for packed state arrays
export const SEC = { OCC: 1, COMM: 2, LOCK: 4, DIST: 8, PRESET: 16, TSR: 32, TRAIN: 64, ROUTEFLEET: 128, BLOCK: 256, POSS: 512, ENV: 1024, ROUTEMAN: 2048, GUIDE: 4096 } as const;
export const SW = { R: 1, MOVING: 2, FAILED: 4, LOCKED: 8, SINGLE: 16, FIELD: 32, TARGET_R: 64, BLOCKED: 128 } as const;
export const SIG_ASPECT: Aspect[] = ['R', 'G', 'Y', 'GUIDE', 'DARK', 'FAIL'];
export const SIGF = { ROUTE: 8, ARSOFF: 16, AUTOPASS: 32, FAILED: 64, MANUAL: 128 } as const;
export const PLT = { HOLD: 1, SKIP: 2, ESP: 4, PSDOPEN: 8, PSDFAULT: 16, BYPASS: 32, TRAIN: 64, SURGE: 128 } as const;
