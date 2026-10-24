import { arbitrateResources, type ResourceTransit } from './resourceArbitration';
/**
 * Simulation engine: owns all dynamic state and advances it with a fixed
 * time step. Runs inside a Web Worker (src/sim/worker.ts) or headless in
 * tests.
 */
import { energyTick, newEnergy, type EnergyState } from './energy';
import { gradePermille } from './gradient';
import { buildTopology, linkChain, type Topology } from './topology';
import { computeRunTimes, type RunTimes } from './dynamics';
import {
  generatePlan, initialDepotStock, terminalReuseRejections, type PlanContext,
} from './timetable';
import type {
  ActiveRoute, AlarmLevel, Command, DayType, Fault, Plan, PlatformState, SectionState, SignalState, SimConfig,
  SimEvent, Snapshot, SwitchState, Train, TrainSnap, ZoneState, StopTask, RadioCall, Possession, EnvState, YardState, VehicleRecord,
  Metrics, ScenarioState, ScenarioReport, StopScore, Bookmark, Incident,
} from './model';
import { SEC, SW, SIGF, PLT, SIG_ASPECT } from './model';
import {
  computeOccupancy, updateInterlocking, trySetRoute, cancelRoute, moveSwitch, sectionUnlock, signalPassed, type CmdResult,
} from './interlocking';
import { updateTrainMotion, indexBodies, refreshAuthority, withdrawAuthority } from './movement';
import {
  buildRouteTable, type RouteTable, spawnDue, updateTrainTasks, runARS, driverRM, recordTrace,
  cmdTrainHold, cmdSkip, cmdTurnback, cmdWithdraw, cmdRecoverService, cmdExchangeDuty, cmdAuthRM, cmdRescue, trainLabel,
  extendTrainTasks, driverDoor, platformSide, doorEnable, atoButton,
} from './ats';
import { stopError } from './movement';
import { initYards, vehicleName, initVehicles, maintainFleet, arrangeYard } from './yard';
import { carryWorld, carryTrains, availableStock } from './operatingDay';
import { capture, type Checkpoint } from './state';
import { radioTick, answerCall, type CallSpec } from './radio';
import { dispatcherTick, newDispatcher, type DispatcherState } from './dispatcher';
import { exposureOf, envTick, initPossessions, setWeather, setLowAdhesion } from './env';
import { holidayOf, holidayFixedRuns, holidayTick, type HolidayDay } from './holiday';
import { vehicleTick, vehicleNote } from './vehicle';
import { initConnections, connectionDeparture, type Connection } from './connections';
import { scheduleInstructorEvents, type InstructorScheduleEntry, type InstructorOccurrence, type RandomFaultEntry, newMetrics, scenarioTick, startScenario, endScenario, randomTick, setRandomFaults, SCENARIOS } from './scenario';
import { computePis } from './pis';
import { computeDmi, dmiTick } from './dmi';
import { drawDailyRidership } from './calibration';
import { passengersTick } from './passengers';
import { injectFault, repairFault, requestTrainMaintenance, faultsTick, FAULT_LABELS, faultProcedure, updateFaultLifecycle } from './faults';
import { updateOnboard, setManual, cmdTrainLevel, cmdTrainDto, cmdLineAto, authoriseEBRelease, turnbackSignalPassed } from './onboard';
import { psdTick, psdOpen, setBypass, doorMotionTick } from './psd';
import { updateHalts, HALT } from './halt';
import { newIntegrity, checkSafety, checkLiveness, type IntegrityState } from './invariants';
import { LINE_INFO, STATIONS, supportsSignalSystem } from '../data/current';
import { assertScope, currentScope } from '../data/scope';
import { validateCommand } from './commands';
import { preparePlan } from './planning';
import { cmdStandbyRelief, standbyTick } from './standby';
import type { RecordedInput } from './diagnostics';

export const FIXED_DT = 0.1;
/** acceleration limit while a CM / RM train runs (see Sim.speedCap) */
export const MANUAL_SPEED_CAP = 5;

let sharedTopo: Topology | null = null;
let sharedRt: RunTimes | null = null;
let sharedTable: RouteTable | null = null;

export class Sim {
  topo: Topology;
  rt: RunTimes;
  planCtx: PlanContext;
  plan: Plan;
  routeTable: RouteTable;
  config: SimConfig;

  t = 0;
  dayStart = 4 * 3600;
  speed = 1;
  paused = false;

  sw: SwitchState[];
  sec: SectionState[];
  sig: SignalState[];
  plat: PlatformState[];
  zoneState: ZoneState[];
  routes = new Map<number, ActiveRoute>();
  routeUnlockedSw = new Map<number, Set<number>>();

  trains = new Map<number, Train>();
  trainList: Train[] = [];
  nextTrainId = 1;
  linkBodies = new Map<number, { train: number; from: number; to: number }[]>();
  berthRes = new Map<number, number>();
  resourceTransit = new Map<number, ResourceTransit>();
  depotStock: number[];
  depotShortLogged = new Set<number>();
  blockDone = new Set<number>();

  faults: Fault[] = [];
  nextFaultId = 1;
  events: SimEvent[] = [];
  newEvents: SimEvent[] = [];
  alarms = new Map<string, SimEvent>();
  alarmsDirty = true;
  nextEventId = 1;
  noRouteLogged = new Set<number>();
  truncatedTrips = new Map<number, number>();
  planDirty = false;
  removedTraces: { train: number; pts: number[] }[] = [];

  passengerScale = 0;
  ridershipTarget = 0;
  instructorSchedule: InstructorScheduleEntry[] = [];
  instructorOccurred: InstructorOccurrence[] = [];
  instructorFired = 0;
  dailyEvaluationEnded = false;
  ridership = { generated: 0, boardings: STATIONS.map(() => Array(28).fill(0) as number[]), alightings: STATIONS.map(() => Array(28).fill(0) as number[]), maxLoad: 0, peakSectionLoad: 0 };
  passengersServed = 0;
  passengersCleared = 0;
  passengersStranded = 0;
  depTotal = 0;
  depOnTime = 0;
  tripsDone = 0;
  rngState = 0;
  rng = (): number => {
    this.rngState = (this.rngState + 0x6d2b79f5) >>> 0;
    let t = this.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  secAcc = 0;

  // ---- revision 2 state
  yards: YardState[] = [];
  /** maintenance record of every vehicle (D112) */
  vehicles = new Map<string, VehicleRecord>();
  stabledPool: string[] = [];
  calls: RadioCall[] = [];
  nextCallId = 1;
  pendingCalls: { at: number; spec: CallSpec }[] = [];
  autoRadio = true;
  /** automatic dispatcher (soak / probe runs): works the recovery procedures through dispatcher commands */
  autoDispatch = false;
  /** the line runs ATO with drivers instead of DTO (DTO compatibility mode, D52) */
  atoLine = false;
  dispatcher: DispatcherState = newDispatcher();
  /** integrity checker state (invariants.ts) */
  integrity: IntegrityState = newIntegrity();
  /** run the invariant checks (on by default; the perf budget includes them) */
  checkIntegrity = true;
  env: EnvState = { wind: 0, rain: false, windUntil: 0, rainUntil: 0, dryAt: 0, slick: [], lowAdh: false };
  exposure: Uint8Array;
  possessions: Possession[] = [];
  metrics: Metrics;
  scenario: ScenarioState | null = null;
  scenarioFired = 0;
  /** the holiday programme of the operating day (holiday.ts), null on an ordinary day */
  holiday: HolidayDay | null = null;
  holidayFired = 0;
  /** last-train connections with the other lines tonight (connections.ts) */
  connections: Connection[] = [];
  /** traction energy (energy.ts) and the line's ATO run level */
  energy: EnergyState = newEnergy();
  /** 0 follows each planned interval; 1/2/3 override the whole line. */
  runLevel = 0;
  /** pending driver resets of cut-out inverters (vehicle.ts) */
  vehicleResets: { train: number; at: number; fault: number }[] = [];
  reportReady: ScenarioReport | null = null;
  randomLevel = 0;
  randomSchedule: RandomFaultEntry[] = [];
  randomFaultVehicles: string[] = [];
  nextRandomAt = Infinity;
  drivingStops: StopScore[] = [];
  bookmarks: Bookmark[] = [];
  nextBookmarkId = 1;
  incidents = new Map<string, Incident>();
  pisStation = -1;
  /** train whose cab DMI is open in the UI, -1 none */
  dmiTrain = -1;
  /** bumped on every structural plan change (replay checkpoints) */
  planRev = 0;
  stepsThisSecond = 0;
  stepsPerSec = 0;
  /** acceleration the worker was asked for and simulated seconds per second it
   *  had to drop because the steps did not fit the frame budget (worker.ts) */
  speedWanted = 0;
  droppedPerSec = 0;
  inputLog: RecordedInput[] = [];
  /** a day that carries on from the previous one starts from this state, not from its config (D111) */
  startState: Checkpoint | null = null;
  replaying = false;

  /** highest acceleration while a CM / RM train runs on the line (driven by the
   *  player or by a degraded-mode driver): speed changes fast, radio calls come
   *  often and a missed one stops a train; Infinity otherwise */
  speedCap(): number {
    for (const tr of this.trains.values()) if ((tr.mode === 'CM' || tr.mode === 'RM') && tr.phase !== 'stabled') return MANUAL_SPEED_CAP;
    return Infinity;
  }

  drive(train: number, notch: number) {
    const tr = this.trains.get(train);
    if (!tr?.manual || !Number.isFinite(notch)) return false;
    tr.notch = Math.max(-8, Math.min(4, Math.round(notch)));
    if (!this.replaying) this.inputLog.push({ scope: currentScope(), t: this.t, drive: { train, notch: tr.notch } });
    return true;
  }

  /** `from`: the previous operating day at its rollover, whose world carries on (D111) */
  constructor(config: SimConfig, from?: Sim) {
    if (config.scope) assertScope(config.scope);
    if (from) assertScope(from.config.scope);
    this.config = config = { ...config, scope: currentScope() };
    if (!sharedTopo) {
      sharedTopo = buildTopology();
      sharedRt = computeRunTimes(sharedTopo, LINE_INFO.trainLength);
      sharedTable = buildRouteTable(sharedTopo);
    }
    this.topo = sharedTopo;
    this.rt = sharedRt!;
    this.routeTable = sharedTable!;
    this.rngState = config.seed >>> 0;
    this.ridershipTarget = drawDailyRidership(config.dayType,config.seed);
    this.instructorSchedule = config.scenario ? [] : scheduleInstructorEvents(config.seed,config.startTime,config.instructorEvents??[]);
    this.autoRadio = config.autoRadio ?? true;
    this.autoDispatch = config.autoDispatch ?? false;
    this.metrics = newMetrics(config.startTime);
    // a scenario may run its own fixed-time special trains (加班车)
    // and a holiday its own planned ones (holiday.ts)
    this.holiday = config.scenario ? null : holidayOf(config.date);
    const fixedRuns = config.scenario ? SCENARIOS.find((x) => x.id === config.scenario)?.fixedRuns : holidayFixedRuns(this.holiday);
    this.atoLine = config.driveMode === 'ATO';
    this.planCtx = { topo: this.topo, rt: this.rt, dayType: config.dayType, ...(fixedRuns ? { fixedRuns } : {}),
      ...(config.depotStock ? { initialStock: config.depotStock.slice() } : {}) };
    this.plan = generatePlan(this.planCtx);
    const { topo } = this;
    this.sw = topo.switches.map(() => ({ pos: 'N', target: 'N', moveUntil: 0, failed: false, fieldLock: false, singleLock: false, lockCount: 0, blocked: false }));
    this.sec = topo.sections.map(() => ({ occ: false, trainOcc: false, commOnly: false, disturbed: false, preset: false, presetSeen: false, lockRoute: -1, tsr: 0, blocked: false, poss: -1, envTsr: 0,
      td: 0, tdRoute: -1, tdTrain: -1, directionEsp: false }));
    this.sig = topo.signals.map(() => ({ aspect: 'R', route: -1, failed: false, ars: true, autoPass: true }));
    this.plat = topo.platforms.map(() => ({ hold: false, skip: false, esp: false, psd: 'closed', psdFault: false, psdBypass: false, psdLinkFault: false, psdTrain: -1, waiting: 0, surge: 1, stranded: 0, lastDep: 0, lastArr: 0, limitUntil: 0 }));
    this.zoneState = topo.zones.map(() => 'CBTC');
    this.exposure = exposureOf(this);
    this.depotStock = this.initialDepotStock();
    // vehicles: the first numbers stand overnight at the terminals, the rest in the depot yards
    const stabled = this.plan.blocks.filter((b) => b.start.kind === 'stable').length;
    for (let i = 1; i <= stabled; i++) this.stabledPool.push(vehicleName(i));
    this.yards = initYards(this, this.depotStock, stabled + 1);
    this.t = this.dayStart;
    const carried = from ? carryWorld(this, from) : undefined;
    if (!from) initVehicles(this);
    maintainFleet(this, !!from, false);
    if (from) {
      const stock = availableStock(this);
      this.config = { ...this.config, depotStock: stock };
      this.planCtx = { ...this.planCtx, initialStock: stock };
      this.plan = generatePlan(this.planCtx);
      carryTrains(this, from);
      for (const depot of this.topo.depots) arrangeYard(this, depot.id);
    }
    // night possessions use their own random stream so the passenger model is unaffected
    {
      const keep = this.rngState;
      this.rngState = (config.seed ^ 0x5eed1234) >>> 0;
      initPossessions(this, carried);
      this.rngState = keep;
    }
    // planning decisions the dispatcher should see: duties not joined on the line (D99)
    for (const text of terminalReuseRejections(this.plan)) this.log('I', '运营', `运行图：${text}`);
    // set the automatic (fleeting) routes
    if (!from) {
      for (const r of topo.routes) if (r.fleeting && this.sig[r.start].route < 0) trySetRoute(this, r.id, { fleeting: true });
      for (const s of this.sw) s.moveUntil = 0;
    }
    this.log('I', '系统', `ATS 启动：${config.dateLabel}（${config.dayType === 'weekday' ? '工作日' : '双休日/节假日'}运行图，计划车次 ${this.plan.trips.length}，最大上线 ${this.plan.fleetPeak} 列）`);
    if (!from) for (const p of this.possessions) if (p.state === 'active') this.log('B', '施工', `${p.name} 施工封锁中（计划 ${String(Math.floor(p.to / 3600)).padStart(2, '0')}:${String(Math.floor((p.to % 3600) / 60)).padStart(2, '0')} 销点）`, { key: `poss-${p.id}` });
    this.log('I','客流',`当日客流目标 ${this.ridershipTarget.toLocaleString('zh-CN')} 人次`);
    if (config.randomFaults) setRandomFaults(this, config.randomFaults);
    initConnections(this);
    arbitrateResources(this);
    spawnDue(this);
    if (from) this.startState = capture(this);
  }

  bookmark(label: string, auto: boolean): Bookmark {
    const b: Bookmark = { id: this.nextBookmarkId++, t: this.t, label, auto };
    this.bookmarks.push(b);
    if (this.bookmarks.length > 200) this.bookmarks.splice(0, this.bookmarks.length - 200);
    return b;
  }

  private initialDepotStock(): number[] {
    return initialDepotStock(this.topo, this.plan);
  }

  // ------------------------------------------------------------ bookkeeping

  addTrain(tr: Train) {
    this.trains.set(tr.id, tr);
    this.trainList.push(tr);
    indexBodies(this);
  }

  removeTrain(tr: Train) {
    if (tr.trace.length) this.removedTraces.push({ train: tr.id, pts: tr.trace.splice(0) });
    this.trains.delete(tr.id);
    this.trainList = this.trainList.filter((x) => x.id !== tr.id);
    for (const [b, t] of this.berthRes) if (t === tr.id) this.berthRes.delete(b);
    this.resourceTransit.delete(tr.id);
    // the occupancy map is rebuilt next step; until then nobody may see the removed train
    for (const [l, segs] of this.linkBodies) if (segs.some((x) => x.train === tr.id)) this.linkBodies.set(l, segs.filter((x) => x.train !== tr.id));
    for (const k of ['eb', 'comm', 'tf', 'tfr', 'spad', 'late']) this.clearAlarm(`${k}-${tr.id}`);
    for (const c of this.calls) if (c.state === 'ringing' && c.train === tr.id) c.state = 'withdrawn';
  }

  log(level: AlarmLevel, cat: string, text: string, opts: { key?: string; manual?: boolean; code?: string; train?: number; snapshot?: import('./invariants').DiagSnapshot } = {}) {
    if (opts.key && this.alarms.has(opts.key)) return;
    const ev: SimEvent = { id: this.nextEventId++, t: this.t, level, cat, text, manual: opts.manual };
    if (opts.code) ev.code = opts.code;
    if (opts.train !== undefined) ev.train = opts.train;
    if (opts.snapshot) ev.snapshot = opts.snapshot;
    if (opts.key && level !== 'I') {
      ev.alarm = true;
      ev.key = opts.key;
      ev.ack = false;
      this.alarms.set(opts.key, ev);
      const type = opts.code ?? opts.key.replace(/-(-?\d+)$/, '');
      if (!this.incidents.has(type)) this.incidents.set(type, { type, t: this.t, eventId: ev.id, text });
      this.alarmsDirty = true;
      if (level === 'A' || level === 'B') this.bookmark(text, true);
    }
    this.events.push(ev);
    if (this.events.length > 20000) this.events.splice(0, 5000);
    this.newEvents.push(ev);
  }

  clearAlarm(key: string) {
    const a = this.alarms.get(key);
    if (!a) return;
    this.replaceEvent(a.id, { ...a, cleared: this.t });
    this.alarms.delete(key);
    this.alarmsDirty = true;
    this.log('I', a.cat, `【恢复】${a.text}`);
  }

  /** Published events are immutable so checkpoints can share their history. */
  private replaceEvent(id: number, event: SimEvent) {
    const index = this.events.findIndex(e => e.id === id);
    if (index >= 0) this.events[index] = event;
    const pending = this.newEvents.findIndex(e => e.id === id);
    if (pending >= 0) this.newEvents[pending] = event;
  }

  trainChain(tr: Train): number {
    return linkChain(this.topo, tr.link, tr.off);
  }

  /** goal berth used while a rescue train heads for a failed train */
  rescueGoal(_tr: Train): number {
    return -1;
  }

  onSignalPassed(tr: Train, sig: number) {
    signalPassed(this, tr.id, sig);
    turnbackSignalPassed(this, tr, sig);
  }

  // ------------------------------------------------------------ stepping

  step(dt = FIXED_DT) {
    if (this.config.scenario && !this.scenario && this.t >= this.config.startTime - 1e-6) startScenario(this, this.config.scenario);
    this.t += dt;
    doorMotionTick(this);
    indexBodies(this);
    for (const tr of this.trainList) {
      updateTrainMotion(this, tr, dt);
      const display = tr.departureDisplay;
      if (display) {
        if (display.remaining !== undefined) display.remaining -= tr.lastDs;
        const platform = this.topo.berths[display.stop.berth].platform;
        if (display.headLeftAt === undefined && this.topo.links[tr.link].platform !== platform) display.headLeftAt = this.t;
        if (display.headLeftAt !== undefined && this.t - display.headLeftAt >= 5) tr.departureDisplay = undefined;
      }
      if (tr.lastDs > 0) {
        const km = tr.lastDs / 1000, record = this.vehicles.get(tr.vehicle);
        if (record) record.km += km;
        const coupled = tr.coupledVehicle && this.vehicles.get(tr.coupledVehicle);
        if (coupled) coupled.km += km;
      }
      const departure = tr.pendingDeparture;
      if (departure && tr.v > 0) {
        tr.pendingDeparture = undefined;
        if (departure.dep !== null) tr.delay = this.t - departure.dep;
        if (tr.manual && departure.dep !== null && this.t < departure.dep)
          this.log('I', '运营', `列车 ${trainLabel(tr)} 早发 ${Math.ceil(departure.dep - this.t)} 秒`, { code: 'EARLY_DEPARTURE', train: tr.id });
        this.noteDeparture(departure);
        connectionDeparture(this, tr, departure);
        if (departure.dep !== null && departure.trip >= 0 && departure.revenue) {
          this.metrics.departures++;
          if (this.t - departure.dep > 120) this.metrics.departuresLate++;
          const platform = this.topo.berths[departure.berth].platform;
          const waiting = this.plat[platform].waiting;
          if (waiting > 30 && tr.load >= LINE_INFO.crushCapacity - 5) {
            this.metrics.stranded += waiting;
            this.passengersStranded += waiting;
          }
        }
        recordTrace(this, tr, true);
      }
    }
    energyTick(this, dt);
    indexBodies(this);
    computeOccupancy(this);
    updateInterlocking(this);
    for (const tr of this.trainList.slice()) {
      const phase = tr.phase;
      updateTrainTasks(this, tr, dt);
      // A departure may occur between ZC refreshes. Do not carry a dwell-time
      // authority into running after the task (and therefore its route) changed.
      if (phase !== 'run' && tr.phase === 'run') withdrawAuthority(this, tr);
    }
    this.stepsThisSecond++;
    this.secAcc += dt;
    if (this.secAcc >= 1 - 1e-9) {
      const acc = this.secAcc;
      this.secAcc = 0;
      this.secondTick(acc);
    }
    if (this.checkIntegrity) checkSafety(this);
  }

  private secondTick(dt: number) {
    refreshAuthority(this);
    arbitrateResources(this);
    spawnDue(this);
    updateOnboard(this);
    psdTick(this);
    driverRM(this);
    runARS(this, true);
    passengersTick(this, dt);
    faultsTick(this);
    envTick(this);
    dispatcherTick(this);
    standbyTick(this);
    radioTick(this);
    dmiTick(this);
    scenarioTick(this);
    holidayTick(this);
    vehicleTick(this);
    randomTick(this);
    updateFaultLifecycle(this);
    updateHalts(this);
    if (this.checkIntegrity) checkLiveness(this);
    for (const tr of this.trainList) {
      recordTrace(this, tr);
      this.trackDelay(tr);
    }
    // axle alarms clear after successful reset & sweep
    for (const [key] of this.alarms) {
      if (key.startsWith('axle-')) {
        const s = Number(key.slice(5));
        if (!this.sec[s].disturbed && !this.sec[s].preset) this.clearAlarm(key);
      }
    }
  }

  private trackDelay(tr: Train) {
    const t = tr.tasks[0];
    if (!t || t.k !== 'stop' || tr.phase !== 'run' || !tr.inService) return;
    if (t.arr !== null && this.t > t.arr + 0) tr.delay = Math.max(tr.delay, this.t - t.arr);
    const key = `late-${tr.id}`;
    if (tr.delay > 300 && !this.alarms.has(key)) this.log('C', '运营', `列车 ${trainLabel(tr)} 晚点 ${Math.round(tr.delay / 60)} 分钟`, { key });
    else if (tr.delay < 120 && this.alarms.has(key)) this.clearAlarm(key);
  }

  /** called on each departure for punctuality statistics */
  depLog: { t: number; st: number; trip: number; delay: number }[] = [];
  noteDeparture(task: StopTask) {
    if (task.dep === null || task.trip < 0) return;
    this.depTotal++;
    if (this.t - task.dep <= 120) this.depOnTime++;
    if (this.depLog.length < 50000) this.depLog.push({ t: this.t, st: task.station, trip: task.trip, delay: this.t - task.dep });
  }

  // ------------------------------------------------------------ commands

  /** a dispatcher command; `by` names a non-human issuer (自动调度) in the log */
  command(cmd: Command, by?: string): CmdResult {
    if (!by && !this.replaying) this.inputLog.push({ scope: currentScope(), t: this.t, cmd: structuredClone(cmd) });
    const error = validateCommand(this, cmd);
    if (error) {
      this.log('C', '调度', `命令拒绝：${error}`, { manual: !by });
      return { ok: false, msg: error };
    }
    const r = this.execCommand(cmd);
    if (r.ok) faultProcedure(this, cmd);
    const text = describeCommand(this, cmd);
    this.log(r.ok ? 'I' : 'C', '调度', `${by ? `【${by}】` : ''}${text}：${r.msg}`, { manual: !by });
    return r;
  }

  private execCommand(cmd: Command): CmdResult {
    const { topo } = this;
    switch (cmd.c) {
      case 'setRoute': {
        const res = trySetRoute(this, cmd.route, { manual: true });
        return res;
      }
      case 'cancelRoute': {
        const sg = this.sig[cmd.signal];
        if (sg.route >= 0) this.routes.get(sg.route)!.fleeting = false;
        return cancelRoute(this, cmd.signal, { manual: true });
      }
      case 'guideRoute':
        return trySetRoute(this, cmd.route, { manual: true, guide: true });
      case 'autoPass': {
        const sg = this.sig[cmd.signal];
        sg.autoPass = cmd.on;
        if (!cmd.on && sg.route >= 0) {
          const ar = this.routes.get(sg.route)!;
          if (ar.fleeting) { ar.fleeting = false; cancelRoute(this, cmd.signal); }
        }
        return { ok: true, msg: `${topo.signals[cmd.signal].name} 自动通过${cmd.on ? '开启' : '关闭'}` };
      }
      case 'ars':
        this.sig[cmd.signal].ars = cmd.on;
        return { ok: true, msg: `${topo.signals[cmd.signal].name} ${cmd.on ? '恢复自动排列进路' : '改为人工排列进路'}` };
      case 'switchMove':
        return moveSwitch(this, cmd.sw, cmd.pos);
      case 'switchLock':
        this.sw[cmd.sw].singleLock = cmd.on;
        return { ok: true, msg: `道岔 ${topo.switches[cmd.sw].name} ${cmd.on ? '单锁' : '单解'}` };
      case 'switchFieldLock': {
        const s = this.sw[cmd.sw];
        if (cmd.on && !s.failed) return { ok: false, msg: '道岔表示正常，无需钩锁' };
        s.fieldLock = cmd.on;
        return { ok: true, msg: `道岔 ${topo.switches[cmd.sw].name} ${cmd.on ? `现场钩锁于${s.pos === 'N' ? '定位' : '反位'}（可办理引导进路通过）` : '取消钩锁'}` };
      }
      case 'axleReset': {
        const s = this.sec[cmd.section];
        if (!s.disturbed) return { ok: false, msg: '区段未处于故障占用状态' };
        const f = this.faults.find((x) => x.kind === 'axle' && x.target === cmd.section && !x.repaired);
        if (f && this.t < f.repairAt) return { ok: false, msg: '计轴复位失败（设备故障未排除）' };
        if (s.trainOcc) return { ok: false, msg: '区段内有列车，不能复位' };
        s.disturbed = false;
        s.preset = true;
        s.presetSeen = false;
        return { ok: true, msg: `区段 ${topo.sections[cmd.section].name} 预复位成功，首列车以RM模式压道后出清` };
      }
      case 'sectionUnlock':
        return sectionUnlock(this, cmd.section);
      case 'setTsr': {
        if (cmd.kmh < 5 || cmd.kmh > 75) return { ok: false, msg: '限速值须在 5–75 km/h' };
        for (const s of cmd.sections) this.sec[s].tsr = cmd.kmh;
        this.log('B', '调度', `设置临时限速 ${cmd.kmh}km/h：${cmd.sections.map((s) => topo.sections[s].name).join('、')}`, { key: `tsr-${cmd.sections[0]}` });
        return { ok: true, msg: `临时限速 ${cmd.kmh}km/h 已生效（${cmd.sections.length} 个区段）` };
      }
      case 'cancelTsr': {
        for (const s of cmd.sections) {
          this.sec[s].tsr = 0;
          this.clearAlarm(`tsr-${s}`);
        }
        return { ok: true, msg: '临时限速已取消' };
      }
      case 'platformHold':
        this.plat[cmd.platform].hold = cmd.on;
        return { ok: true, msg: `${topo.platforms[cmd.platform].name} ${cmd.on ? '扣车' : '取消扣车'}` };
      case 'platformSkip':
        this.plat[cmd.platform].skip = cmd.on;
        return { ok: true, msg: `${topo.platforms[cmd.platform].name} ${cmd.on ? '跳停' : '取消跳停'}` };
      case 'platformEsp': {
        this.plat[cmd.platform].esp = cmd.on;
        if (cmd.on) this.log('A', '车站', `${topo.platforms[cmd.platform].name} 紧急关闭`, { key: `esp-${cmd.platform}` });
        else this.clearAlarm(`esp-${cmd.platform}`);
        return { ok: true, msg: `${topo.platforms[cmd.platform].name} ${cmd.on ? '紧急关闭' : '取消紧急关闭'}` };
      }
      case 'psdBypass': return setBypass(this, cmd.platform, cmd.on);
      case 'trainHold': return this.withTrain(cmd.train, (tr) => cmdTrainHold(this, tr, cmd.on));
      case 'trainSkip': return this.withTrain(cmd.train, (tr) => cmdSkip(this, tr, cmd.station, cmd.on));
      case 'recoverService': return this.withTrain(cmd.train, tr => cmdRecoverService(this, tr));
      case 'exchangeDuty': return this.withTrain(cmd.train, tr => cmdExchangeDuty(this, tr, cmd.with));
      case 'standby': return this.withTrain(cmd.train, tr => cmdStandbyRelief(this, tr));
      case 'turnback': return this.withTrain(cmd.train, (tr) => cmdTurnback(this, tr, cmd.station));
      case 'withdraw': return this.withTrain(cmd.train, (tr) => cmdWithdraw(this, tr, cmd.reason));
      case 'authRM': return this.withTrain(cmd.train, (tr) => cmdAuthRM(this, tr, cmd.signal));
      case 'ebRelease': return this.withTrain(cmd.train, (tr) => authoriseEBRelease(this, tr, '调度'));
      case 'trainLevel': return this.withTrain(cmd.train, (tr) => cmdTrainLevel(this, tr, cmd.level));
      case 'trainDto': return this.withTrain(cmd.train, (tr) => cmdTrainDto(this, tr, cmd.on));
      case 'atoButton': return this.withTrain(cmd.train, tr => atoButton(this, tr, cmd.button, cmd.down));
      case 'reverser': return this.withTrain(cmd.train, tr => {
        if (!tr.manual || tr.v >= 0.05) return { ok: false, msg: '换向器只能在人工驾驶零速时操作' };
        if (![-1, 0, 1].includes(cmd.position)) return { ok: false, msg: '无效换向器位置' };
        tr.reverser = cmd.position;
        return { ok: true, msg: `换向器：${cmd.position === 1 ? '前' : cmd.position === 0 ? '零' : '后'}` };
      });
      case 'door': return this.withTrain(cmd.train, (tr) => driverDoor(this, tr, cmd.side));
      case 'lineAto': return cmdLineAto(this, cmd.on);
      case 'rescue': {
        const f = this.trains.get(cmd.failed);
        const r = this.trains.get(cmd.rescuer);
        if (!f || !r) return { ok: false, msg: '列车不存在' };
        return cmdRescue(this, f, r);
      }
      case 'addTrain':
      case 'overlay': {
        const preview = preparePlan(this, cmd);
        if (!preview.ok) return { ok: false, msg: preview.msg };
        this.plan = preview.plan;
        this.planDirty = true;
        this.planRev++;
        for (const x of preview.extended ?? []) {
          const id = this.plan.blocks[x.block].train;
          const tr = id === undefined ? undefined : this.trains.get(id);
          if (tr) extendTrainTasks(this, tr, x.last);
        }
        if (preview.skipped) this.log('C', '运营', preview.msg);
        for(const warning of preview.warnings??[])this.log('B','运营',warning);
        return { ok: true, msg: preview.msg };
      }
      case 'zoneLevel': {
        if (!supportsSignalSystem(cmd.level)) return { ok: false, msg: `当前线路不支持 ${cmd.level} 信号制式` };
        const names: string[] = [];
        for (const z of cmd.zones) {
          const cur = this.zoneState[z];
          if (cmd.level === 'TBTC') {
            this.zoneState[z] = 'TBTC';
            names.push(topo.zones[z].key);
          } else {
            const f = this.faults.find((x) => x.kind === 'zcFail' && (x.target === z || x.target < 0) && !x.repaired);
            if (f) return { ok: false, msg: `${topo.zones[z].name} ZC 故障未修复，不能恢复CBTC` };
            if (cur !== 'CBTC') { this.zoneState[z] = 'CBTC'; names.push(topo.zones[z].key); }
          }
        }
        // trains inside degrade at their next station stop / upgrade on the move (onboard.ts)
        return { ok: true, msg: `${names.join('、') || '所选区域'} 切换至 ${cmd.level}` };
      }
      case 'ack': {
        for (const [key, a] of this.alarms) if (cmd.ids.includes(a.id)) {
          const updated = { ...a, ack: true };
          this.alarms.set(key, updated);
          this.replaceEvent(a.id, updated);
        }
        this.alarmsDirty = true;
        return { ok: true, msg: `确认报警 ${cmd.ids.length} 条` };
      }
      case 'fault': return injectFault(this, cmd.kind, cmd.target, cmd.duration, cmd.param, cmd.recoverable);
      case 'repair': return repairFault(this, cmd.fault);
      case 'trainMaintenance': return requestTrainMaintenance(this,cmd.fault);
      case 'sectionBlock': {
        for (const s of cmd.sections) {
          const st = this.sec[s];
          if (!cmd.on && st.poss >= 0) return { ok: false, msg: `区段 ${topo.sections[s].name} 为施工封锁，须施工销点后解封` };
          st.blocked = cmd.on;
        }
        const names = cmd.sections.map((s) => topo.sections[s].name).join('、');
        if (cmd.on) this.log('B', '调度', `区段封锁：${names}`, { key: `blk-${cmd.sections[0]}` });
        else for (const s of cmd.sections) this.clearAlarm(`blk-${s}`);
        return { ok: true, msg: `${names} ${cmd.on ? '封锁' : '解封'}` };
      }
      case 'switchBlock':
        this.sw[cmd.sw].blocked = cmd.on;
        return { ok: true, msg: `道岔 ${topo.switches[cmd.sw].name} ${cmd.on ? '封锁（不能办理经过该道岔的进路）' : '解封'}` };
      case 'manual': return this.withTrain(cmd.train, (tr) => setManual(this, tr, cmd.mode));
      case 'radio': return answerCall(this, cmd.call, cmd.option);
      case 'radioAuto':
        this.autoRadio = cmd.on;
        return { ok: true, msg: cmd.on ? '通话自动应答（演示）' : '通话需人工应答' };
      case 'env': return setWeather(this, { wind: cmd.wind, rain: cmd.rain, duration: cmd.duration });
      case 'lowAdhesion': return setLowAdhesion(this, cmd.on);
      case 'runLevel': {
        const lv = cmd.level;
        if (lv === this.runLevel) return { ok: false, msg: lv === 0 ? '已按运行图选择等级' : `已是运行等级 ${lv}` };
        this.runLevel = lv;
        const msg = lv === 0 ? 'ATO 按运行图逐区间选择等级，晚点列车自动按等级 1 运行'
          : `全线 ATO 运行等级 ${lv}${lv === 1 ? '（全性能）' : lv === 2 ? '（惰行节能）' : '（低速惰行，节能最多）'}，晚点列车自动按等级 1 运行`;
        this.log('C', '调度', msg);
        return { ok: true, msg };
      }
      case 'randomFaults': return setRandomFaults(this, cmd.level);
      case 'scenarioEnd': {
        const r = endScenario(this);
        return { ok: true, msg: `${r.title}评分：${r.score}` };
      }
      case 'bookmark': {
        const b = this.bookmark(cmd.label || '书签', false);
        return { ok: true, msg: `已添加书签 ${b.label}` };
      }
    }
  }

  private withTrain(id: number, fn: (tr: Train) => CmdResult): CmdResult {
    const tr = this.trains.get(id);
    if (!tr) return { ok: false, msg: '列车不存在' };
    return fn(tr);
  }

  // ------------------------------------------------------------ snapshot

  snapshot(): Snapshot {
    const { topo } = this;
    const sections = new Uint16Array(this.sec.length);
    const sectionTsr = new Uint8Array(this.sec.length);
    this.sec.forEach((s, i) => {
      let f = 0;
      if (s.occ) f |= SEC.OCC;
      if (s.commOnly) f |= SEC.COMM;
      if (s.lockRoute >= 0) {
        f |= SEC.LOCK;
        const ar = this.routes.get(s.lockRoute);
        if (ar?.fleeting) f |= SEC.ROUTEFLEET;
        if (ar?.manual) f |= SEC.ROUTEMAN;
        if (ar?.guide) f |= SEC.GUIDE;
      }
      if (s.disturbed) f |= SEC.DIST;
      if (s.preset) f |= SEC.PRESET;
      if (s.tsr > 0) f |= SEC.TSR;
      if (s.trainOcc) f |= SEC.TRAIN;
      if (s.blocked) f |= SEC.BLOCK;
      if (s.poss >= 0) f |= SEC.POSS;
      if (s.envTsr !== 0) f |= SEC.ENV;
      sections[i] = f;
      sectionTsr[i] = s.tsr > 0 ? s.tsr : s.envTsr > 0 ? s.envTsr : 0;
    });
    const switches = new Uint8Array(this.sw.length);
    this.sw.forEach((s, i) => {
      let f = 0;
      if (s.pos === 'R') f |= SW.R;
      if (s.pos !== s.target || this.t < s.moveUntil) f |= SW.MOVING;
      if (s.failed) f |= SW.FAILED;
      if (s.lockCount > 0) f |= SW.LOCKED;
      if (s.singleLock) f |= SW.SINGLE;
      if (s.fieldLock) f |= SW.FIELD;
      if (s.target === 'R') f |= SW.TARGET_R;
      if (s.blocked) f |= SW.BLOCKED;
      switches[i] = f;
    });
    const signals = new Uint8Array(this.sig.length);
    this.sig.forEach((s, i) => {
      let f = SIG_ASPECT.indexOf(s.aspect);
      if (s.route >= 0) {
        f |= SIGF.ROUTE;
        if (this.routes.get(s.route)?.manual) f |= SIGF.MANUAL;
      }
      if (!s.ars) f |= SIGF.ARSOFF;
      if (s.autoPass) f |= SIGF.AUTOPASS;
      if (s.failed) f |= SIGF.FAILED;
      signals[i] = f;
    });
    const platforms = new Uint8Array(this.plat.length);
    const platformWaiting = new Uint16Array(this.plat.length);
    this.plat.forEach((p, i) => {
      let f = 0;
      if (p.hold) f |= PLT.HOLD;
      if (p.skip) f |= PLT.SKIP;
      if (p.esp) f |= PLT.ESP;
      if (psdOpen(p)) f |= PLT.PSDOPEN;
      if (p.psdFault) f |= PLT.PSDFAULT;
      if (p.psdBypass) f |= PLT.BYPASS;
      if (p.surge > 1) f |= PLT.SURGE;
      platforms[i] = f;
      // a face sharing another platform's queue (广兰路 middle track) shows that queue
      platformWaiting[i] = Math.min(65535, Math.round(this.plat[topo.platforms[i].pool ?? i].waiting));
    });
    for (const tr of this.trainList) {
      const sp = topo.links[tr.link].platform;
      if (sp >= 0 && tr.phase === 'dwell') platforms[sp] |= PLT.TRAIN;
    }
    const trains: TrainSnap[] = this.trainList.map((tr) => {
      const body: number[] = [];
      for (const b of tr.body) body.push(b.link, b.from, b.to);
      const t0 = tr.tasks[0];
      return {
        id: tr.id, dto: tr.dtoInhibit, vehicle: tr.vehicle, svc: tr.svc, trip: tr.tripNo, tripId: tr.tripId, vehicleNote: vehicleNote(tr), dest: tr.destText, link: tr.link, off: tr.off, dir: tr.dir,
        body, v: tr.v, level: tr.level, comm: tr.comm, mode: tr.mode, eb: tr.eb, phase: tr.phase, delay: tr.delay,
        tbStage: tr.tbStage, depotStage: tr.depotStage,
        load: tr.load, hold: tr.hold, failed: tr.failed, doors: tr.doorsOpen, doorClosing: tr.doorMotion?.kind === 'closing', doorSide: tr.doorSide, doorsAwait: tr.doorsAwait,
        platSide: t0?.k === 'stop' && (tr.phase === 'dwell' || (tr.stopDist >= 0 && tr.stopDist < 400)) ? platformSide(this, tr, this.topo.berths[t0.berth].platform) : '',
        inService: tr.inService, hot: hotMark(tr), chain: this.trainChain(tr),
        maReason: tr.maReason, maDist: tr.maDist, vPermit: tr.vPermit, nextSig: tr.nextSignal,
        task: t0 ? describeTask(this, t0) : '—', kind: tr.tripId >= 0 ? this.plan.trips[tr.tripId].kind : '',
        rm: tr.mode === 'RM',
        vTarget: tr.vTarget, tgtV: tr.tgtV, tgtD: Number.isFinite(tr.tgtD) ? tr.tgtD : -1, tgtReason: tr.tgtReason,
        vRecommended: tr.manual && tr.mode === 'CM' ? tr.vRecommended ?? 0 : undefined,
        atoPhase: (tr.ato?.state ?? tr.atoMove)?.phase, runStartedAt: tr.phaseSince,
        grade: gradePermille(this.topo, tr.link, tr.off, tr.dir), slip: tr.slip,
        stopDist: Number.isFinite(tr.stopDist) ? tr.stopDist : -1, a: tr.a, manual: tr.manual, notch: tr.notch, atoDriver: tr.atoDriver, reverser: tr.reverser ?? 1, doorEnable: doorEnable(this, tr),
        dwellLeft: tr.phase === 'dwell' || tr.phase === 'reversing' ? Math.max(0, tr.dwellUntil - this.t) : 0,
        nextStation: nextStopStation(tr), ebReason: tr.eb ? tr.ebReason : tr.stopUntil > this.t ? tr.stopReason : '',
        nextStopSkipped: t0?.k === 'stop' && t0.revenue && t0.dep !== null &&
          (tr.skipStations.has(t0.station) || this.plat[this.topo.berths[t0.berth].platform].skip),
        halt: tr.halt.code === 'NONE' ? null : {
          code: tr.halt.code, label: HALT[tr.halt.code].label, detail: tr.halt.detail, since: tr.halt.since,
          blocker: tr.halt.train >= 0 ? (() => { const o = this.trains.get(tr.halt.train); return o ? `${o.svc}-${o.tripNo}` : ''; })() : '',
        },
        stopErr: stopError(this, tr), drv: tr.manual || tr.drv.stops.length ? tr.drv : null, len: tr.len,
      };
    });
    const traces: { train: number; pts: number[] }[] = this.removedTraces.splice(0);
    for (const tr of this.trainList) if (tr.trace.length) traces.push({ train: tr.id, pts: tr.trace.splice(0) });
    const late = this.trainList.filter((t) => t.inService && t.delay > 120).length;
    const maxDelay = this.trainList.reduce((m, t) => (t.inService ? Math.max(m, t.delay) : m), 0);
    const tripsPlanned = this.plan.trips.filter((t) => t.revenue && !t.cancelled).length;
    return {
      t: this.t, speed: this.speed, paused: this.paused, dayType: this.plan.dayType, dateLabel: this.config.dateLabel,
      sections, sectionTsr, switches, signals, platforms, platformWaiting, zones: this.zoneState.slice(), atoLine: this.atoLine, trains,
      depotCounts: this.depotStock.slice(), traces,
      stats: {
        online: this.trainList.length, inService: this.trainList.filter((t) => t.inService).length, late, maxDelay,
        punctuality: this.depTotal ? this.depOnTime / this.depTotal : 1, tripsDone: this.tripsDone, tripsPlanned,
        passengers: this.passengersServed, stepsPerSec: this.stepsPerSec, speedWanted: this.speedWanted, speedActual: this.stepsPerSec * FIXED_DT, droppedPerSec: this.droppedPerSec, speedCap: this.speedCap(),
      },
      activeRoutes: Array.from(this.routes.keys()),
      faults: this.faults.filter((f) => !f.repaired || this.t - f.repairAt < 600),
      calls: this.calls.filter((c) => c.state === 'ringing' || this.t - (c.answeredAt ?? c.deadline) < 30),
      env: { ...this.env },
      possessions: this.possessions.filter((p) => p.state !== 'planned' && p.state !== 'done' && p.state !== 'cancelled'),
      yards: this.yards, vehicles: this.vehicles,
      pis: this.pisStation >= 0 ? computePis(this, this.pisStation) : null,
      dmi: this.dmiTrain >= 0 ? computeDmi(this, this.dmiTrain) : null,
      scenario: this.scenario,
      randomLevel: this.randomLevel,
      autoRadio: this.autoRadio,
      ridership: this.ridership,
      connections: this.t >= 20.5 * 3600 ? this.connections : [],
      energy: { ...this.energy },
      runLevel: this.runLevel,
      metrics: this.metrics,
      replay: { from: 0, to: 0, replaying: false, pending: 0 },
      bookmarks: this.bookmarks.slice(-60),
      incidents: [...this.incidents.values()],
    };
  }
}

function nextStopStation(tr: Train): number {
  for (const t of tr.tasks) if (t.k === 'stop') return t.station;
  return -1;
}

export function describeTask(sim: Sim, t: import('./model').Task): string {
  switch (t.k) {
    case 'stop': return `${t.note ?? (t.doors ? '停站' : '停车')} ${STATIONS[t.station].name}`;
    case 'reverse': return `折返 ${sim.topo.berths[t.chosen].name}`;
    case 'depot': return `回 ${sim.topo.depots[t.depot].name}`;
    case 'stable': return `存车 ${t.berth >= 0 ? sim.topo.berths[t.berth].name : ''}`;
    case 'rescue': return '救援连挂';
  }
}

export function describeCommand(sim: Sim, cmd: Command): string {
  const { topo } = sim;
  const tn = (id: number) => { const t = sim.trains.get(id); return t ? `列车 ${t.svc}-${t.tripNo}` : `列车#${id}`; };
  switch (cmd.c) {
    case 'setRoute': return `办理进路 ${topo.routes[cmd.route].name}`;
    case 'cancelRoute': return `取消进路 ${topo.signals[cmd.signal].name}`;
    case 'guideRoute': return `引导进路 ${topo.routes[cmd.route].name}`;
    case 'autoPass': return `自动通过 ${topo.signals[cmd.signal].name}`;
    case 'ars': return `自动排列 ${topo.signals[cmd.signal].name}`;
    case 'switchMove': return `道岔单操 ${topo.switches[cmd.sw].name}→${cmd.pos === 'N' ? '定位' : '反位'}`;
    case 'switchLock': return `道岔${cmd.on ? '单锁' : '单解'} ${topo.switches[cmd.sw].name}`;
    case 'switchFieldLock': return `道岔${cmd.on ? '钩锁确认' : '取消钩锁'} ${topo.switches[cmd.sw].name}`;
    case 'axleReset': return `计轴预复位 ${topo.sections[cmd.section].name}`;
    case 'sectionUnlock': return `区段故障解锁 ${topo.sections[cmd.section].name}`;
    case 'setTsr': return `设置临时限速 ${cmd.kmh}km/h`;
    case 'cancelTsr': return '取消临时限速';
    case 'platformHold': return `${cmd.on ? '扣车' : '取消扣车'} ${topo.platforms[cmd.platform].name}`;
    case 'platformSkip': return `${cmd.on ? '跳停' : '取消跳停'} ${topo.platforms[cmd.platform].name}`;
    case 'platformEsp': return `${cmd.on ? '紧急关闭' : '取消紧急关闭'} ${topo.platforms[cmd.platform].name}`;
    case 'psdBypass': return `站台门互锁${cmd.on ? '解除' : '恢复'} ${topo.platforms[cmd.platform].name}`;
    case 'trainHold': return `${cmd.on ? '扣车' : '放行'} ${tn(cmd.train)}`;
    case 'trainSkip': return `跳停 ${tn(cmd.train)} ${STATIONS[cmd.station].name}`;
    case 'turnback': return `人工折返 ${tn(cmd.train)} @${STATIONS[cmd.station].name}`;
    case 'recoverService': return `故障恢复接续 ${tn(cmd.train)}`;
    case 'exchangeDuty': return `车次调整 ${tn(cmd.train)} ↔ ${tn(cmd.with)}`;
    case 'standby': return `备车接替 ${tn(cmd.train)}`;
    case 'withdraw': return `退出服务 ${tn(cmd.train)}`;
    case 'authRM': return `授权RM ${tn(cmd.train)}${cmd.signal !== undefined ? ` 越过 ${topo.signals[cmd.signal].name}` : ''}`;
    case 'ebRelease': return `授权缓解紧急制动 ${tn(cmd.train)}`;
    case 'trainLevel': return `列车控制级别 ${tn(cmd.train)} → ${cmd.level === 'AUTO' ? '自动' : cmd.level}`;
    case 'trainDto': return `${cmd.on ? '恢复DTO' : '降级ATO'} ${tn(cmd.train)}`;
    case 'atoButton': return `${tn(cmd.train)} ATO启动${cmd.button.toUpperCase()}${cmd.down ? '按下' : '释放'}`;
    case 'reverser': return `${tn(cmd.train)} 换向器${cmd.position}`;
    case 'door': return `${tn(cmd.train)} ${cmd.side === 'L' ? '左' : '右'}侧车门`;
    case 'lineAto': return cmd.on ? '全线转ATO运营（DTO兼容模式）' : '全线恢复DTO运营';
    case 'rescue': return `组织救援 ${tn(cmd.rescuer)}→${tn(cmd.failed)}`;
    case 'addTrain': return `加开列车 ${topo.depots[cmd.depot].short}`;
    case 'overlay': return '加开运行图';
    case 'zoneLevel': return `系统切换 ${cmd.zones.map((z) => topo.zones[z].key).join('/')} → ${cmd.level}`;
    case 'ack': return '报警确认';
    case 'fault': return `【教员】注入故障 ${FAULT_LABELS[cmd.kind]}`;
    case 'repair': return '【教员】故障修复';
    case 'trainMaintenance': return '多故障现场抢修';
    case 'sectionBlock': return `区段${cmd.on ? '封锁' : '解封'} ${cmd.sections.map((x) => topo.sections[x].name).join('、')}`;
    case 'switchBlock': return `道岔${cmd.on ? '封锁' : '解封'} ${topo.switches[cmd.sw].name}`;
    case 'manual': return `${cmd.mode === 'AUTO' ? '恢复自动驾驶' : `人工驾驶${cmd.mode}`} ${tn(cmd.train)}`;
    case 'radio': return '通话应答';
    case 'radioAuto': return '通话应答方式';
    case 'env': return '【教员】环境设置';
    case 'lowAdhesion': return `${cmd.on ? '设置' : '取消'}低粘着模式`;
    case 'runLevel': return cmd.level === 0 ? '运行等级按图' : `运行等级 ${cmd.level}`;
    case 'randomFaults': return '【教员】随机故障';
    case 'scenarioEnd': return '【教员】结束评估';
    case 'bookmark': return '添加书签';
  }
}

export type { DayType };

/** standing as a hot standby, or turning back into its track to do so (D70) */
function hotMark(tr: Train): boolean {
  const t = tr.phase === 'reversing' ? tr.tasks[1] : tr.tasks[0];
  return t?.k === 'stop' && !!t.standby && tr.phase !== 'dwell';
}
