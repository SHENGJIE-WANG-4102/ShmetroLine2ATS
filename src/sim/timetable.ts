/**
 * Parametric timetable (运行图) generation.
 *
 * Templates describe route patterns and reference headways. Independent
 * clock tables select calibrated dwell factors and running grades. The
 * generator lays out departure streams at a reference station per direction,
 * builds trips, links them into train blocks (车底运用) by FIFO matching at
 * each terminal, and closes the gaps with depot insertions (出库) and
 * withdrawals (回库) — revenue partial trips placed into gaps of the stream,
 * or non-revenue moves before/after service.
 */
import type { Topology } from './topology';
import { ahead } from './topology';
import type { RunTimes } from './dynamics';
import { cancelTrip, type Block, type DayType, type Plan, type PlanStop, type StopTask, type Task, type Trip, type TripKind, type TrackDir } from './model';
import { plannedDwell } from './calibration';
import { STATIONS, OPERATIONS, LINE_INFO, type FixedRun } from '../data/line2';
import { FIXED_LATE_TRAINS } from '../data/firstlast';
import { FIRST_LAST } from '../data/firstlast';

export interface Template {
  id: string;
  name: string;
  desc: string;
  pattern: ('big' | 'small')[];
  /** headway between successive trains at the reference station (s) */
  headway: number;
  /** Leading peak wave and pattern phasing, read by the common stream rule. */
  peak?: boolean;
  openingAlternation?: boolean;
  phase?: Partial<Record<TrackDir, number>>;
  continuePattern?: boolean;
}

export const TEMPLATES: Record<string, Template> = {
  weekdayAM: {
    id: 'weekdayAM', name: '工作日早高峰', desc: '大小交路交替：大—大—小，淞虹路—广兰路 2\'30"，外段平均 3\'45"',
    pattern: ['big', 'big', 'small'], headway: 150, peak: true, openingAlternation: true, phase: { DN: 2 },
  },
  weekdayPM: {
    id: 'weekdayPM', name: '工作日晚高峰', desc: '大小交路交替：大—大—小，淞虹路—广兰路 3\'00"，外段 4\'30"',
    pattern: ['big', 'big', 'small'], headway: 180, peak: true, phase: { UP: 1 },
  },
  weekdayAMTail: {
    id: 'weekdayAMTail', name: '早高峰退出', desc: '2:1 交路逐步退出早高峰', // 【假设】
    pattern: ['big', 'big', 'small'], headway: 210,
  },
  weekdayOff: {
    id: 'weekdayOff', name: '工作日平峰', desc: '单一大交路 5\'00"', pattern: ['big'], headway: 300,
  },
  weekdayEvening: {
    id: 'weekdayEvening', name: '工作日夜间平峰', desc: '单一大交路 7\'00"', pattern: ['big'], headway: 420,
  },
  weekdayPMTail: {
    id: 'weekdayPMTail', name: '晚高峰延续', desc: '2:1 延至约20:55，间隔由2\'45"逐步增至4\'00"', // 【假设】 piecewise-linear interpolation
    pattern: ['big', 'big', 'small'], headway: 165, continuePattern: true,
  },
  weekdayNight: {
    id: 'weekdayNight', name: '晚间大交路', desc: '21:00附近原小交路时隙改开机场车，3\'00"向末班8\'00"插值', // 【假设】
    pattern: ['big'], headway: 180,
  },
  weekend: {
    id: 'weekend', name: '双休日/节假日', desc: '全天单一大交路，日间 4\'30"', pattern: ['big'], headway: 270,
  },
  firstLast: {
    id: 'firstLast', name: '首末班及收车', desc: '首班 05:25 起 7\'00"；21:57 后蟠祥路—广兰路 8\'00"，末班后回段/存车',
    pattern: ['big'], headway: 420,
  },
};

export interface Period { from: number; to: number; template: string; headway?: number; headwayTo?: number; label: string }

const H = (h: number, m = 0) => h * 3600 + m * 60;

const DAY_PERIODS: Record<DayType, Period[]> = {
  weekday: [
    { from: H(4), to: H(6, 5), template: 'firstLast', label: '首班/早间' },
    { from: H(6, 5), to: H(7, 40), template: 'weekdayOff', headway: 300, label: '早高峰前过渡' },
    { from: H(7, 40), to: H(10), template: 'weekdayAM', label: '早高峰' },
    { from: H(10), to: H(10, 40), template: 'weekdayAMTail', headway: 190, headwayTo: 270, label: '早高峰退出' }, // 【假设】
    { from: H(10, 40), to: H(18, 15), template: 'weekdayOff', label: '平峰' },
    { from: H(18, 15), to: H(19, 30), template: 'weekdayPM', label: '晚高峰' },
    // D72: 19:44 observed ~165 s, 20:43 observed ~240 s. The
    // interpolation between observations is 【假设】, with a 12-min 2:1
    // cycle by 20:45. This band does not pre-position a second peak wave.
    { from: H(19, 30), to: H(19, 45), template: 'weekdayPMTail', label: '晚高峰延续' },
    { from: H(19, 45), to: H(20, 45), template: 'weekdayPMTail', headway: 165, headwayTo: 240, label: '晚高峰间隔渐长' },
    { from: H(20, 45), to: H(20, 55), template: 'weekdayPMTail', headway: 240, label: '小交路收车前' },
    { from: H(20, 55), to: H(21), template: 'weekdayNight', headway: 240, headwayTo: 180, label: '机场车接替时隙' }, // 【假设】
    { from: H(21), to: H(21, 40), template: 'weekdayNight', headway: 240, label: '晚间大交路' }, // 【假设】
    { from: H(21, 40), to: H(28), template: 'firstLast', headway: 240, label: '末班/收车' },
  ],
  weekend: [
    { from: H(4), to: H(6, 40), template: 'firstLast', label: '首班/早间' },
    { from: H(6, 40), to: H(7, 40), template: 'weekend', headway: 360, label: '早间过渡' },
    { from: H(7, 40), to: H(21), template: 'weekend', label: '双休日日间' },
    { from: H(21), to: H(21, 40), template: 'weekdayEvening', label: '夜间' },
    { from: H(21, 40), to: H(28), template: 'firstLast', headway: 480, label: '末班/收车' },
  ],
};

/**
 * Service periods as shown to the dispatcher (header, timetable graph). The
 * generator's peak `from` is the time the whole core runs at peak, so the
 * reference stations densify well before it; these clocks are when the
 * passenger sees the change, read from the Gaode tables at 世纪公园 and
 * 张江高科 (reference/timetable-gaode/).
 */
const SHOWN_PERIODS: Record<DayType, Period[]> = {
  weekday: [
    { from: H(4), to: H(6, 5), template: 'firstLast', label: '首班/早间' },
    { from: H(6, 5), to: H(6, 45), template: 'weekdayOff', label: '早高峰前过渡' },
    { from: H(6, 45), to: H(10), template: 'weekdayAM', label: '早高峰' },
    { from: H(10), to: H(10, 45), template: 'weekdayAMTail', label: '早高峰退出' },
    { from: H(10, 45), to: H(17), template: 'weekdayOff', label: '平峰' },
    { from: H(17), to: H(17, 30), template: 'weekdayOff', label: '晚高峰前过渡' },
    { from: H(17, 30), to: H(20, 30), template: 'weekdayPM', label: '晚高峰' },
    { from: H(20, 30), to: H(21, 30), template: 'weekdayPMTail', label: '晚高峰退出' },
    { from: H(21, 30), to: H(22, 30), template: 'weekdayNight', label: '夜间' },
    { from: H(22, 30), to: H(28), template: 'firstLast', label: '末班/收车' },
  ],
  weekend: DAY_PERIODS.weekend,
};

export function dayPeriods(dayType: DayType): Period[] {
  return DAY_PERIODS[dayType].map(p => ({ ...p }));
}

interface ClockBand { from: number; to: number; value: number; valueTo?: number }
// D73/D74 calibration clocks are independent of service frequency and route patterns.
const DWELL_BANDS: Record<DayType, ClockBand[]> = {
  weekday: [
    { from: 0, to: H(6, 5), value: 0.95 },
    { from: H(6, 5), to: H(6, 50), value: 1 },
    { from: H(6, 50), to: H(9, 30), value: 0.8 },
    { from: H(9, 30), to: H(16, 50), value: 1 },
    { from: H(16, 50), to: H(19, 30), value: 0.8 },
    { from: H(19, 30), to: H(21), value: 1.1 },
    { from: H(21), to: H(21, 40), value: 1.1, valueTo: 0.43 },
    { from: H(21, 40), to: Infinity, value: 0.43 },
  ],
  weekend: [
    { from: 0, to: H(6, 40), value: 0.95 },
    { from: H(6, 40), to: H(21), value: 1.05 },
    { from: H(21), to: H(21, 40), value: 0.95 },
    { from: H(21, 40), to: Infinity, value: 0.43 },
  ],
};
const RUN_BANDS: Record<DayType, ClockBand[]> = {
  weekday: [
    { from: 0, to: H(21, 10), value: 1 },
    { from: H(21, 10), to: H(21, 25), value: 2 },
    { from: H(21, 25), to: H(21, 40), value: 3 },
    { from: H(21, 40), to: Infinity, value: 4 },
  ],
  weekend: [
    { from: 0, to: H(21, 40), value: 1 },
    { from: H(21, 40), to: Infinity, value: 4 },
  ],
};

interface ServiceData {
  openingUp?: { at: number; headway: number; template: string; label: string };
  denseUp?: number;
  openingDn?: { to: number; headway: number }[];
  peaks: Record<string, { DN?: number; UP?: number; upEnd?: number }>;
  overrides: (Period & { dir: TrackDir })[];
  openingSupplements: { from: number; to: number; headway: number; terminal: number }[];
  shortClose?: number;
  carryingClose?: { from: number; to: number };
  lateHeadway: number;
  standby: StandbyWindow[];
}
const SERVICE_DATA: Record<DayType, ServiceData> = {
  weekday: {
    openingUp: { at: H(5, 35) + 30, headway: 450, template: 'weekdayOff', label: '西行开班疏班' }, // 【假设】
    denseUp: H(6, 55),
    openingDn: [{ to: H(6, 10), headway: 225 }, { to: Infinity, headway: 180 }],
    peaks: { weekdayAM: {}, weekdayPM: { DN: H(17), UP: H(17, 24), upEnd: H(20, 20) } },
    overrides: [
      { dir: 'UP', from: H(18, 55), to: H(19, 25), template: 'weekdayNight', headway: 180, label: '西段退峰前三分钟连续大交路' }, // 【假设】由实拍S1/S2反推参考站波次
      { dir: 'DN', from: H(19, 45), to: H(21, 20), template: 'weekdayNight', headway: 180, label: '西段东行三分钟延续' }, // 【假设】
      { dir: 'DN', from: H(9, 45), to: H(10, 40), template: 'weekdayAMTail', headway: 200, headwayTo: 300, label: '东行早高峰退出' }, // 【假设】
    ],
    // 【假设】 LYL depot origins fill the western opening wave while GLL is sparse.
    openingSupplements: [
      { from: 0, to: H(5, 35), headway: 450, terminal: 0 },
      { from: H(5, 35), to: H(5, 50), headway: 225, terminal: 0 },
      { from: H(5, 50), to: H(6, 10), headway: 450, terminal: 0 },
      { from: H(6, 10), to: H(6, 30), headway: 225, terminal: 0 },
      { from: H(6, 30), to: H(6, 40), headway: 225, terminal: 4 },
      { from: H(6, 40), to: H(7, 10), headway: 150, terminal: 4 },
    ],
    shortClose: H(20, 55),
    carryingClose: { from: H(20, 50), to: H(21) },
    lateHeadway: 240,
    standby: [{ from: H(11, 30), need: H(16), to: H(20, 30) }],
  },
  weekend: {
    peaks: {}, overrides: [], openingSupplements: [], lateHeadway: 480,
    standby: [{ from: H(9), need: H(21), to: H(21) }],
  },
};

// Published opening duties and depot operating windows, shared by all day types.
const OPENING = {
  longyang: H(5, 20), century: H(5, 24), guanglanWest: H(5, 28), guanglanEast: H(6),
  outerAlternation: H(7, 10),
  stockUntil: H(10), redirectFrom: H(7), emptyFeedersFrom: H(20),
  feederUntil: H(26), stableUntil: H(10), dayStart: H(4),
};

/** Margin of the outer (west of 淞虹路) alternation window inside a peak band:
 * the outer end leads (DN) or lags (UP) the core by its ~11 min running time,
 * plus the transition into the pattern. */
export const OUTER_BAND_MARGIN = 1200;
/** whether a time at an outer station falls in a peak's 2'30"/5'00" pattern */
export function inOuterAlternation(periods: Period[], t: number): boolean {
  return periods.some(p => TEMPLATES[p.template].peak && t >= p.from + OUTER_BAND_MARGIN && t < p.to - OUTER_BAND_MARGIN);
}

// ---------------------------------------------------------------- overlays (加开)

export interface OverlayPreset { id: string; label: string; from: number; to: number; a: number; b: number; headway: number; desc: string }

export const OVERLAY_PRESETS: OverlayPreset[] = [
  { id: 'ciie', label: '进博会保障加开', from: H(9, 30), to: H(17, 30), a: 1, b: 22, headway: 900, desc: '国家会展中心 ↔ 广兰路 区间加开，平峰每15分钟一列（各方向）' },
  { id: 'hongqiao', label: '虹桥枢纽大客流加开', from: H(20), to: H(22, 30), a: 2, b: 22, headway: 720, desc: '虹桥火车站 ↔ 广兰路 区间加开，夜间每12分钟一列（虹桥火车站无折返条件，加开车延至国家会展中心折返）' },
];

// ---------------------------------------------------------------- helpers

/** fixedRuns: the fixed-time special trains of the day (default: the regular ones) */
export interface PlanContext { topo: Topology; rt: RunTimes; dayType: DayType; fixedRuns?: FixedRun[]; initialStock?: number[] }

const TERMINAL_DEPOT: Record<number, string> = { 0: 'BZL', 30: 'CSD', 4: 'BZL', 22: 'LYD', 1: 'BZL', 2: 'BZL', 19: 'LYD', 28: 'CSD' };
/** trains a terminal can hold at once: two tail tracks or paired stubs + the
 * departure platform; 广兰路 turns on its single middle-track platform */
const TERMINAL_CAP: Record<number, number> = { 0: 3, 30: 3, 4: 3, 22: 1, 1: 3, 2: 2 };
/**
 * trains the circulation lets lay over at a terminal at once. At the line ends
 * this is the full terminal: the peak cycle there leaves a turn just short of
 * the 240 s minimum, so each train waits for the next slot but one, and with
 * only two places that third train would be sent to the depot and replaced by
 * a fresh one every cycle, breaking the west-end 2'30"/5'00" pattern. An
 * insertion into a full terminal is caught by the validator (D7).
 */
const MAX_PRESENT: Record<number, number> = { 0: 3, 30: 3, 4: 2, 22: 1, 1: 3, 2: 2 };
/** longest a train may wait at a terminal between trips (s) */
const MAX_LAYOVER = 1500;
/**
 * Hot standby (热备车, D70): off-peak each line end keeps one train of its
 * turning cycle aside, crewed, in one of its two turnback tracks; the other
 * trains turn through the other track. From `from` the first train the line
 * end has to spare (a third one laying over there) stays; with none to spare
 * by an hour later the next arrival stays anyway and a train comes out of the
 * yard for the departure it would have taken. From `need` it takes the first
 * departure the line end has no train for (the peak build-up: both tracks
 * turn again); at `to` it rejoins the cycle, or goes back to the yard.
 */
interface StandbyWindow { from: number; need: number; to: number }
function standbyWindows(dayType: DayType): StandbyWindow[] {
  return SERVICE_DATA[dayType].standby;
}

export function hotStandbyPlaces(topo: Topology) {
  return OPERATIONS.hotStandby.map(rule => {
    const station = STATIONS.findIndex(st => st.id === rule.station);
    const st = topo.stations[station];
    const berth = (rule.track === 'storage' ? st.storageBerths : st.turnbackBerths)[rule.berth];
    return { ...rule, station, berth };
  });
}

/** The same physical slot has a stopping point for each permitted heading. */
export function storageArrivalBerth(topo: Topology, berth: number, dir: TrackDir): number | undefined {
  return topo.berths.find(b => b.link === topo.berths[berth].link
    && ((topo.links[b.link].chainB - topo.links[b.link].chainA) * b.dir > 0) === (dir === 'DN'))?.id;
}
/** longest an added train running on in its own direction may stand at an
 *  intermediate station's through platform before its next trip (s): any
 *  longer and the following train queues behind it */
const THROUGH_WAIT = 60;
/** spacing of a depot move from the neighbouring departures where it joins / leaves the line (s) */
const SLOT_GAP = 120;

export function depotIndex(topo: Topology, key: string): number {
  return topo.depots.findIndex((d) => d.key === key);
}

/** first station of a move out of `depot` heading `dir` (its first trip starts
 * there); the move may reach it against the direction and change ends there */
export function exitStation(topo: Topology, depot: number, dir: TrackDir): number {
  return topo.depots[depot].portals.exit[dir].station;
}
/** last station before `depot` for a train running `dir` */
export function entryStation(topo: Topology, depot: number, dir: TrackDir): number {
  return topo.depots[depot].portals.entry[dir].station;
}
/** extra time a depot move spends changing ends at its junction station (s) */
const PORTAL_REVERSE = 90;

export function minTurn(st: number): number {
  const id = STATIONS[st].id;
  return OPERATIONS.minTurnback[id] ?? 330;
}

export function overnightPlaces(topo: Topology) {
  return OPERATIONS.overnightStabling.flatMap(rule => {
    const station = STATIONS.findIndex(st => st.id === rule.station);
    const st = topo.stations[station];
    return Array.from({ length: rule.count }, (_, index) => {
      const berth = rule.kind === 'platform'
        ? rule.track === 'turnback' ? departureBerthAfterReverse(topo, st.turnbackBerths[index], platformBerth(topo, station, rule.departure))
          : platformBerth(topo, station, rule.departure)
        : (rule.kind === 'feeder' ? st.storageBerths : st.turnbackBerths)[index];
      if (berth === undefined) throw new Error(`${STATIONS[station].name} 缺少过夜泊位 ${index + 1}`);
      return { ...rule, station, berth, arrivalBerth: rule.kind === 'platform' && rule.track === 'turnback' ? st.turnbackBerths[index] : berth };
    });
  });
}

/** 【假设】图定，非物理规则：official opening propagation is direction-asymmetric.
 * Uniform early level 3 makes the PXL opener several minutes late. Keep
 * normal dwell/level 1, and state the two remaining diagram budgets (D74). */
export const FIRST_TRAIN_DIAGRAM_RUN_ADJUST_S = { guanglanEast: 15, longyangWest: -6 };

/** stations visited from a to b inclusive */
function seq(a: number, b: number): number[] {
  const out: number[] = [];
  if (a <= b) for (let i = a; i <= b; i++) out.push(i);
  else for (let i = a; i >= b; i--) out.push(i);
  return out;
}

/** dwellFactor: a constant, or the factor in force at each stop's arrival time. */
export function buildStops(ctx: PlanContext, dir: TrackDir, from: number, to: number, originDep: number, revenue: boolean, dwellFactor: number | ((t: number) => number), stopsAt?: (st: number) => boolean, diagramRunAdjustmentS = 0): PlanStop[] {
  const sts = seq(from, to);
  const stops: PlanStop[] = [];
  let t = originDep;
  // pass times already include the platform pass limit (any train, 跨站 or empty)
  for (let k = 0; k < sts.length; k++) {
    const st = sts[k];
    if (k === 0) { stops.push({ st, arr: t, dep: t, stop: true }); continue; }
    const prev = sts[k - 1];
    const idx = Math.min(prev, st);
    const prevStops = stops[k - 1].stop;
    const isLast = k === sts.length - 1;
    const stopHere = isLast || (stopsAt ? stopsAt(st) : revenue);
    const runLevel = plannedRunLevel(ctx.dayType, t);
    stops[k - 1].runLevel = runLevel;
    const rt = runLevel === 1 ? ctx.rt : ctx.rt.byLevel?.[runLevel] ?? ctx.rt;
    const pass = dir === 'DN' ? rt.passDn : rt.passUp;
    let run: number;
    if (prevStops && stopHere) run = dir === 'DN' ? rt.dn[idx] : rt.up[idx];
    else run = pass[idx] + (prevStops ? 10 : 0) + (stopHere ? 12 : 0);
    if (diagramRunAdjustmentS) {
      run += diagramRunAdjustmentS;
      stops[k - 1].diagramRunAdjustmentS = diagramRunAdjustmentS;
    }
    const arr = t + run;
    const dw = stopHere && !isLast ? plannedDwell(ctx.dayType, st, dir, arr, typeof dwellFactor === 'function' ? dwellFactor(arr) : dwellFactor) : 0;
    stops.push({ st, arr, dep: arr + dw, stop: stopHere });
    t = arr + dw;
  }
  return stops;
}

function periodAt(periods: Period[], t: number): Period {
  // Diagram solvers probe elapsed runs from t=0 before service opens.
  // Use the opening defaults there, rather than the final night's level.
  if (periods.length && t < periods[0].from) return periods[0];
  for (const p of periods) if (t >= p.from && t < p.to) return p;
  return periods[periods.length - 1];
}

function clockValue(bands: ClockBand[], t: number): number {
  const band = bands.find(b => t < b.to) ?? bands[bands.length - 1];
  if (band.valueTo === undefined) return band.value;
  const fraction = Math.max(0, Math.min(1, (t - band.from) / (band.to - band.from)));
  return band.value + (band.valueTo - band.value) * fraction;
}

export function dwellFactorAt(dayType: DayType, t: number): number {
  return clockValue(DWELL_BANDS[dayType], t);
}

export function plannedRunLevel(dayType: DayType, departure: number): number {
  return clockValue(RUN_BANDS[dayType], departure);
}

// ---------------------------------------------------------------- generation

interface GenTrip extends Trip { next?: number; prev?: number }
type DiagramClocks = { original: Map<number, number>; protected: ReadonlySet<number> };
/** Candidate depot moves dropped during matching have never been published. */
const UNUSED_DEPOT_MOVE = -2;
/** Select a route while drafting service data, before train matching. */
function trimRoute(trip: Pick<ServiceRequest, 'from' | 'to' | 'kind' | 'stops'>, from: number, to: number, kind: TripKind) {
  trip.from = from;
  trip.to = to;
  trip.kind = kind;
  trip.stops = trip.stops.filter(p => p.st >= Math.min(from, to) && p.st <= Math.max(from, to));
  trip.stops[0].arr = trip.stops[0].dep;
  trip.stops.at(-1)!.dep = trip.stops.at(-1)!.arr;
}

type ServiceIdentity = Pick<Trip, 'dir' | 'from' | 'to' | 'kind'> & { stations: number[] };
const laidOutService = new WeakMap<Plan, Map<Trip, ServiceIdentity>>();
const generationIssues = new WeakMap<Plan, PlanIssue[]>();
type RejectedTurn = { arrival: GenTrip; departure: GenTrip; conflicts: Trip[] };
const draftRejectedTurns = new WeakMap<Block[], RejectedTurn[]>();
const rejectedTurns = new WeakMap<Plan, string[]>();

/** Matching diagnostics, numbered only after publishing the retained trips. */
export function terminalReuseRejections(plan: Plan): readonly string[] {
  return rejectedTurns.get(plan) ?? [];
}

function serviceIdentity(trip: Trip): ServiceIdentity {
  return { dir: trip.dir, from: trip.from, to: trip.to, kind: trip.kind, stations: trip.stops.map(p => p.st) };
}

/** The same guard is used in generation and by regressions which mutate a plan. */
export function serviceStructureIssues(plan: Plan): PlanIssue[] {
  const service = laidOutService.get(plan);
  if (!service) return [];
  const present = new Set(plan.trips);
  const issues: PlanIssue[] = [];
  for (const [trip, expected] of service) {
    if (present.has(trip) && !trip.cancelled && JSON.stringify(serviceIdentity(trip)) === JSON.stringify(expected)) continue;
    issues.push({ severity: 'error', code: 'SERVICE_STRUCTURE', t: trip.stops[0].dep, blocks: [trip.block], text: '已铺画载客车次被取消或改变起终点、交路' });
  }
  return issues;
}

/** Added service may keep a train of the base plan in service instead of
 * bringing another out of the depot (延长运用, D47). `canExtend` says whether
 * the train of a block is still able to take more trips after `last`. */
export interface OverlayReuse {
  nightPlaces?: ReturnType<typeof overnightPlaces>;
  blocks: Block[];
  canExtend: (block: number, last: number) => boolean;
  now: number;
  /** filled in: blocks of the base plan that now continue into added trips */
  extended: { block: number; last: number; trips: number[]; tail: number[]; end: Block['end'] }[];
  /** Depot corrections already required by cancelled base duties. */
  returnShift?: number[];
  stock?: { at: number; levels: number[]; departed: number[]; done: number[] };
  /** filled in: base duties taken over by an added train (`into`, the added
   * block): `trips` moved over, `lead` its cancelled yard exit */
  absorbed?: { block: number; into: number; trips: number[]; lead: number[]; end: Block['end'] }[];
}

/** a train returning to the yard is counted in stock this long after its last arrival (s) */
export const DEPOT_ENTRY_CLEAR = 300;

export interface YardMove { time: number; depot: number; delta: number; block: number; trip?: number; berth?: number; link?: number; window?: [number, number] }

/** The yard exits and entries of every duty that still runs: an exit at its
 * start, an entry DEPOT_ENTRY_CLEAR after its last live arrival, or at its
 * actual withdrawal. One definition for planning, validation and live stock. */
export function depotMoves(blocks: readonly Block[], trips: readonly Trip[], ctx?: Pick<PlanContext, 'topo'>): YardMove[] {
  const out: YardMove[] = [];
  for (const block of blocks) {
    const live = block.trips.map(id => trips[id]).filter(trip => !trip.cancelled);
    if (!live.length && !block.withdrawal) continue;
    if (block.start.kind === 'depot') out.push({ time: block.start.time, depot: block.start.depot, delta: -1, block: block.id, trip: live[0]?.id });
    if (block.withdrawal) out.push({ time: block.withdrawal.at, depot: block.withdrawal.depot, delta: 1, block: block.id });
    else if (block.end.kind === 'depot') out.push({ time: live.at(-1)!.stops.at(-1)!.arr + DEPOT_ENTRY_CLEAR, depot: block.end.depot, delta: 1, block: block.id, trip: live.at(-1)!.id });
  }
  if (ctx) for (const move of out) {
    const trip = move.trip === undefined ? undefined : trips[move.trip];
    if (!trip) continue; // A live withdrawal has no scheduled approach window.
    const yard = ctx.topo.depots[move.depot];
    const portal = (move.delta > 0 ? yard.portals.entry : yard.portals.exit)[trip.dir];
    const path = yard.transferPaths[portal.path];
    if (path.flow !== 'shared') continue;
    // Entry tasks select this berth, which identifies the actual lead.
    if (move.delta > 0) move.berth = yard.entryBerths[portal.path];
    move.link = path.stub;
    move.window = move.delta > 0 ? inboundWindow(ctx.topo, move.depot, trip) : outboundWindow(ctx, move.depot, trip);
    if (move.delta < 0) move.window[0] = move.time;
  }
  return sortDepotMoves(out);
}

/** chronological; at the same instant exits before entries */
export function sortDepotMoves<T extends { time: number; delta: number }>(moves: T[]): T[] {
  return moves.sort((a, b) => a.time - b.time || a.delta - b.delta);
}

/** trains each yard must hold at the start of the day: its largest deficit of exits over returns */
export function yardNeed(topo: Topology, plan: Plan): number[] {
  const bal = topo.depots.map(() => 0), need = topo.depots.map(() => 0);
  for (const e of depotMoves(plan.blocks, plan.trips)) { bal[e.depot] += e.delta; need[e.depot] = Math.max(need[e.depot], -bal[e.depot]); }
  return need;
}

/** Physical morning stock, including unused spares. Shared by initialization
 * and the daily ledger, so validation cannot silently invent extra vehicles. */
export function initialDepotStock(topo: Topology, plan: Plan): number[] {
  if (plan.initialStock) return plan.initialStock.slice();
  const stock = yardNeed(topo, plan);
  let fleet = stock.reduce((a, b) => a + b, 0)
    + plan.blocks.filter(block => block.start.kind === 'stable').length;
  while (fleet < LINE_INFO.fleet) {
    let depot = 0;
    for (let d = 1; d < stock.length; d++)
      if (topo.depots[d].capacity - stock[d] > topo.depots[depot].capacity - stock[depot]) depot = d;
    stock[depot]++;
    fleet++;
  }
  return stock;
}

export function depotLedger(topo: Topology, plan: Plan) {
  const initial = initialDepotStock(topo, plan);
  const events = depotMoves(plan.blocks, plan.trips);
  const final = initial.slice(), peak = initial.slice(), peakAt = topo.depots.map(() => OPENING.dayStart);
  for (const event of events) {
    final[event.depot] += event.delta;
    if (final[event.depot] > peak[event.depot]) {
      peak[event.depot] = final[event.depot];
      peakAt[event.depot] = event.time;
    }
  }
  return { initial, final, peak, peakAt, events };
}

/** `shift`: per yard, how many of its earliest morning exits another yard
 *  takes (a second pass when the first one needed more than a yard holds) */
function layoutService(ctx: PlanContext) {
  const { topo } = ctx;
  const periods = dayPeriods(ctx.dayType);
  const service = SERVICE_DATA[ctx.dayType];
  const trips: ServiceRequest[] = [];
  const nS = topo.stations.length;
  const W = 0;
  const E = nS - 1;
  const SHR = 4;
  const GLL = 22;
  let upPhase = 10; // UP peak phase, aligned to the first airport train below.
  /** the published first trains from their origins: they open each station */
  const firstService: ServiceRequest[] = [];

  const addTrip = (dir: TrackDir, kind: TripKind, from: number, to: number, stops: PlanStop[], revenue: boolean, overlay?: string): ServiceRequest => {
    const tr: ServiceRequest = { id: trips.length, dir, kind, from, to, stops, revenue, overlay };
    trips.push(tr);
    return tr;
  };

  const factorAt = (t: number) => dwellFactorAt(ctx.dayType, t);
  // A peak is a whole-core promise, not an origin departure change. Allow
  // the complete core traversal plus one headway for its leading wave.
  const peaks = periods.filter(p => TEMPLATES[p.template].peak);
  const peakHw = (p: Period) => TEMPLATES[p.template].headway;
  const coreLead = new Map(peaks.map(p => {
    const hw = peakHw(p);
    const lead = Math.max(...(['DN', 'UP'] as const).map(dir => {
      const from = dir === 'DN' ? SHR : GLL, to = dir === 'DN' ? GLL : SHR;
      const stops = buildStops(ctx, dir, from, to, p.from, true, factorAt);
      return stops.at(-1)!.arr - p.from + hw + 30;
    }));
    return [p, Math.ceil(lead / hw) * hw] as const;
  }));
  if (peaks.length) {
    const first = buildStops(ctx, 'UP', E, W, OPERATIONS.firstEastTerminusDep, true, factorAt).find(s => s.st === GLL)!.dep;
    const anchor = peaks[0].from - coreLead.get(peaks[0])!;
    const hw = peakHw(peaks[0]);
    // Keep the official 06:00 origin on the AM core grid, instead of adding
    // an off-grid first train which disrupts the western 1:2 alternation.
    upPhase = ((first - anchor) % hw + hw) % hw;
  }
  const morningUpStart = service.denseUp === undefined ? undefined : service.denseUp + upPhase;
  const peakStart = (p: Period, dir: TrackDir) => service.peaks[p.template]?.[dir]
    ?? (dir === 'UP' && morningUpStart !== undefined ? morningUpStart : p.from - coreLead.get(p)!);
  /** Reference-station service waves; all directional differences come from data. */
  const streamAt = (t: number, dir: TrackDir): Period & { steady?: boolean } => {
    const override = service.overrides.find(p => p.dir === dir && t >= p.from && t < p.to);
    if (override) return override;
    if (morningUpStart !== undefined && t < morningUpStart) {
      if (dir === 'UP') return { ...service.openingUp!, from: service.openingUp!.at, to: morningUpStart };
      const start = peakStart(peaks[0], dir);
      if (t < start) return { from: 0, to: start, template: peaks[0].template, headway: service.openingDn!.find(p => t < p.to)!.headway, label: '东行开班过渡' }; // 【假设】
    }
    for (const peak of peaks) {
      const hw = peakHw(peak);
      const start = peakStart(peak, dir), transition = start - OUTER_BAND_MARGIN;
      const end = dir === 'UP' ? service.peaks[peak.template]?.upEnd ?? peak.to : peak.to;
      if (t >= start && t < end) return { ...peak, from: start, headway: hw, steady: true };
      if (t >= transition && t < start) {
        const before = periodAt(periods, transition);
        const prev = Math.max(hw, before.headway ?? TEMPLATES[before.template].headway);
        return { ...peak, from: transition, to: start, headway: hw + (prev - hw) * (start - t) / OUTER_BAND_MARGIN, label: `${peak.label}渐进预置` };
      }
    }
    return periodAt(periods, t);
  };
  const headwayAt = (t: number, dir: TrackDir) => {
    const p = streamAt(t, dir);
    const start = p.headway ?? TEMPLATES[p.template].headway;
    return p.headwayTo === undefined ? start : start + (p.headwayTo - start) * Math.max(0, Math.min(1, (t - p.from) / (p.to - p.from)));
  };

  // Solve the origin departure so every big/small train uses the same core
  // slot, with the demand at its actual stop times. Intermediate holds are
  // never used to achieve phasing.
  const atReference = (dir: TrackDir, from: number, to: number, ref: number, departure: number) => {
    let origin = departure;
    let stops = buildStops(ctx, dir, from, to, origin, true, factorAt);
    for (let i = 0; i < 8; i++) {
      const error = stops.find(x => x.st === ref)!.dep - departure;
      if (Math.abs(error) < .001) break;
      origin -= error;
      stops = buildStops(ctx, dir, from, to, origin, true, factorAt);
    }
    return stops;
  };
  const firstReference = (dir: TrackDir, from: number, to: number, ref: number, first: number) =>
    buildStops(ctx, dir, from, to, first, true, factorAt).find(x => x.st === ref)!.dep;
  const nextSlot = (t: number, dir: TrackDir) => {
    const p = streamAt(t, dir);
    const candidate = t + headwayAt(p.steady ? t : t + headwayAt(t, dir) / 2, dir);
    if (morningUpStart !== undefined && dir === 'UP' && t < morningUpStart && candidate >= morningUpStart) return morningUpStart;
    // Join the leading peak wave without a short insertion or a long gap.
    const join = peaks.map(p => ({ b: peakStart(p, dir), hw: peakHw(p) })).find(x => x.b > t && x.b <= candidate);
    if (join) return join.b - t >= 90 ? join.b : join.b + join.hw;
    return candidate;
  };

  // ---- DN stream (reference: 淞虹路 departure)
  {
    let idx = 0;
    let lastPeriod = '';
    let t = firstReference('DN', W, E, SHR, OPERATIONS.firstWestTerminusDep);
    for (let guard = 0; guard < 2000; guard++) {
      const p = streamAt(t, 'DN');
      const tpl = TEMPLATES[p.template];
      if (p.label !== lastPeriod) {
        if (!tpl.continuePattern) idx = tpl.phase?.DN ?? 0;
        lastPeriod = p.label;
      }
      if (p.steady) idx = Math.round((t - p.from) / peakHw(p)) + (tpl.phase?.DN ?? 0);
      let kind = tpl.pattern[idx % tpl.pattern.length] as 'big' | 'small' | 'late';
      // Pre-position the core with short routes, while the west outer
      // section still has one departure every 5 minutes (D73).
      if (tpl.openingAlternation && t < OPENING.outerAlternation) kind = idx % 2 === 0 ? 'big' : 'small';
      if (guard === 0) kind = 'big'; // preserve the published PXL 05:25 opener
      if (kind === 'big' || kind === 'late') {
        const originDep = atReference('DN', W, E, SHR, t)[0].dep;
        if (originDep > OPERATIONS.lastBigEastboundDep) break;
        const to = E;
        const stops = atReference('DN', W, to, SHR, t);
        addTrip('DN', kind, W, to, stops, true);
      } else {
        const stops = buildStops(ctx, 'DN', SHR, GLL, t, true, factorAt);
        // End the eastbound short route at its far end, rather than letting
        // another whole-core journey start at 20:55 (D72).
        if (service.shortClose !== undefined && stops.at(-1)!.arr >= service.shortClose) {
          // The train of the former short-route slot continues east from
          // SHR to the airport; adding a new PXL origin would require an
          // unrelated extra train at the west end during the withdrawal.
          addTrip('DN', 'big', SHR, E, buildStops(ctx, 'DN', SHR, E, t, true, factorAt), true);
        } else addTrip('DN', 'small', SHR, GLL, stops, true);
      }
      idx++;
      t = nextSlot(t, 'DN');
    }
  }
  // The closing stream is counted backwards from its official final origin.
  // Only feasible slots are laid out, so no surplus first late train exists.
  const lateCount = Math.floor((OPERATIONS.lastLateEastboundDep - OPERATIONS.lastBigEastboundDep - MIN_HEADWAY) / service.lateHeadway) + 1;
  for (let index = lateCount - 1; index >= 0; index--) {
    const departure = OPERATIONS.lastLateEastboundDep - index * service.lateHeadway;
    addTrip('DN', 'late', W, GLL, buildStops(ctx, 'DN', W, GLL, departure, true, factorAt), true);
  }
  // ---- UP stream (reference: 广兰路 departure)
  {
    let idx = 0;
    let lastPeriod = '';
    const lastBigWestDep = OPERATIONS.lastBigWestboundDep;
    const firstThrough = firstReference('UP', E, W, GLL, OPERATIONS.firstEastTerminusDep);
    // Explicit origin first trains below supply the early western section;
    // the airport stream starts with the published 06:00 departure.
    firstService.push(addTrip('UP', 'big', E, W, buildStops(ctx, 'UP', E, W, OPERATIONS.firstEastTerminusDep, true, factorAt), true));
    // Opening trains from GLL are fed by depot trains changing ends on its
    // single middle-track platform; one cycle there takes minTurn plus the
    // throat clearance. A slot that comes sooner starts at 龙阳路 instead,
    // where the depot train enters westbound service directly (the published
    // 05:20 first train does the same).
    const gllCycle = minTurn(GLL) + (OPERATIONS.platformTurnClear.GLL ?? 0) + 10;
    let lastGllOpening = -Infinity;
    let t = service.openingUp?.at ?? firstThrough;
    for (let guard = 0; guard < 2000; guard++) {
      const p = streamAt(t, 'UP');
      const tpl = TEMPLATES[p.template];
      if (p.label !== lastPeriod) {
        if (!tpl.continuePattern) idx = 0;
        lastPeriod = p.label;
      }
      if (p.steady) idx = Math.round((t - p.from - (tpl.openingAlternation ? upPhase : 0)) / peakHw(p));
      idx += tpl.phase?.UP ?? 0;
      let kind = tpl.pattern[idx % tpl.pattern.length] as 'big' | 'small' | 'late';
      if (tpl.openingAlternation && t < peaks[0].from) {
        // Anchor the outer 5-minute grid to the official airport first train.
        kind = Math.round((t - firstThrough) / peakHw(p)) % 2 === 0 ? 'big' : 'small';
      }
      if (tpl.openingAlternation && t >= peaks[0].from && t < peaks[0].from + peakHw(p)) kind = 'big';
      if (kind === 'big' && atReference('UP', E, W, GLL, t)[0].dep < OPERATIONS.firstEastTerminusDep - .01) kind = 'small';
      // The explicit 06:00 airport train occupies its full path. During
      // morning build-up do not insert another departure within 90 seconds.
      if (Math.abs(t - firstThrough) < 120) { idx++; t = nextSlot(t, 'UP'); continue; }
      if (kind === 'big') {
        const originDep = atReference('UP', E, W, GLL, t)[0].dep;
        if (originDep > lastBigWestDep) kind = 'late';
        else addTrip('UP', 'big', E, W, atReference('UP', E, W, GLL, t), true);
      }
      if (kind === 'late') {
        break; // official airport last train is also GLL's last westbound service
      }
      if (kind === 'small') {
        // Before the airport's first through train reaches GLL, western
        // first-service trains run to PXL. This supplies west-end turns
        // without queueing dozens of early depot feeders at PXL.
        const opening = t < firstThrough;
        if (opening && t - lastGllOpening < gllCycle) {
          const atLYL = buildStops(ctx, 'UP', GLL, W, t, true, factorAt).find(s => s.st === 19)!.dep;
          addTrip('UP', 'ins', 19, W, buildStops(ctx, 'UP', 19, W, atLYL, true, factorAt), true);
        } else {
          if (opening) lastGllOpening = t;
          const to=opening?W:SHR;
          addTrip('UP', opening ? 'ins' : 'small', GLL, to, buildStops(ctx, 'UP', GLL, to, t, true, factorAt), true);
        }
      }
      idx++;
      t = nextSlot(t, 'UP');
    }
  }

  // Official origin first trains, shared by both day types. Intermediate
  // station timing is calibrated separately; no run or dwell time is changed.
  // (淞虹路 05:58 westbound and 远东大道 06:24 eastbound are not origins: they
  // are the 龙阳路 and 广兰路 first trains passing.)
  const firstLYL = Math.max(OPENING.longyang, OPENING.century - buildStops(ctx, 'UP', 19, W, OPENING.longyang, true, factorAt).find(s => s.st === 17)!.dep + OPENING.longyang);
  for (const [dir, from, to, dep] of [
    ['UP', 19, W, firstLYL], ['UP', GLL, W, OPENING.guanglanWest],
    ['DN', GLL, E, OPENING.guanglanEast],
  ] as const) firstService.push(addTrip(dir, 'ins', from, to, buildStops(ctx, dir, from, to, dep, true, factorAt, undefined,
    dir === 'DN' ? FIRST_TRAIN_DIAGRAM_RUN_ADJUST_S.guanglanEast : from === 19 ? FIRST_TRAIN_DIAGRAM_RUN_ADJUST_S.longyangWest : 0), true));

  {
    for (let round = 0; round < 30; round++) {
      const calls = trips.filter(t => t.dir === 'UP' && t.revenue && t.to <= SHR)
        .flatMap(t => t.stops.filter(s => s.st === 19).map(s => s.dep)).sort((a, b) => a - b);
      let added = false;
      for (let i = 0; i + 1 < calls.length; i++) {
        const at = calls[i];
        const band = service.openingSupplements.find(p => at >= p.from && at < p.to);
        if (!band || calls[i + 1] - at < band.headway + MIN_HEADWAY) continue;
        const dep = at + band.headway;
        const terminal = service.openingSupplements.find(p => dep >= p.from && dep < p.to)?.terminal ?? band.terminal;
        const stops = buildStops(ctx, 'UP', 19, terminal, dep, true, factorAt);
        if (!new DepIndex(trips).clear(stops, 'UP')) continue;
        addTrip('UP', 'ins', 19, terminal, stops, true);
        added = true;
        break;
      }
      if (!added) break;
    }
  }

  if (service.shortClose !== undefined) {
    // The last two short-route duties finish carrying passengers: the final
    // westbound one goes to 蟠祥路 and the eastbound one to 龙阳路 depot.
    const distance = (trip: ServiceRequest) => Math.abs((trip.stops.find(stop => stop.st === GLL)?.dep ?? -Infinity) - service.shortClose!);
    const closingSlot = trips.filter(t => t.dir === 'UP' && distance(t) <= 180).sort((a, b) => distance(a) - distance(b))[0];
    if (closingSlot) {
      const dep = service.shortClose;
      closingSlot.locked = true;
      closingSlot.kind = 'wd';
      closingSlot.from = GLL;
      closingSlot.to = W;
      closingSlot.stops = buildStops(ctx, 'UP', GLL, W, dep, true, factorAt);
    }
    // The preceding short-route trains finish their trips and return at SHR;
    // classify these as withdrawals once they overlap the closing window.
    for (const t of trips) if (t.dir === 'UP' && t.kind === 'small' && t.stops.at(-1)!.arr > service.shortClose) t.kind = 'wd';
    const dn = trips.filter(t => t.dir === 'DN' && t.from === SHR && t.kind === 'big'
      && t.stops.find(s => s.st === 19)!.arr >= service.carryingClose!.from
      && t.stops.find(s => s.st === 19)!.arr <= service.carryingClose!.to).at(0);
    if (dn) {
      dn.kind = 'wd';
      dn.to = 19;
      dn.stops = buildStops(ctx, 'DN', SHR, 19, dn.stops[0].dep, true, factorAt);
    }
  }

  // 广兰路 turns trains on its one middle-track platform (配线图 PDF). A DN
  // arrival that would turn into an UP departure a slot or two later, but
  // whose platform the following arrival needs first, runs on to the eastern
  // terminal instead (延伸运行), where the tails have room.
  {
    const mt = minTurn(GLL);
    // the departing train is out of the west throat and the next arrival's
    // route into the middle track set within this time
    const GLL_CLEAR = 60;
    const arrAt = (t: ServiceRequest) => t.stops[t.stops.length - 1].arr;
    const arrivals = trips.filter((t) => t.dir === 'DN' && t.to === GLL && t.kind === 'small').sort((a, b) => arrAt(a) - arrAt(b));
    const deps = trips.filter((t) => t.dir === 'UP' && t.from === GLL).map((t) => t.stops[0].dep).sort((a, b) => a - b);
    for (let i = 0; i + 1 < arrivals.length; i++) {
      const A = arrivals[i];
      const d = deps.find((x) => x >= arrAt(A) + mt - 1e-6);
      // (no departure within a slot or two: the train is withdrawn to the depot as before)
      if (d !== undefined && d - arrAt(A) <= mt + 450 && d + GLL_CLEAR <= arrAt(arrivals[i + 1])) continue;
      // During morning opening, a short-route train with no middle-track
      // turn runs to CSD's entry at YDD rather than filling the airport tails.
      // This is a passenger-carrying withdrawal, not an extra airport origin.
      // 【假设】 when GLL has no turn slot, withdraw at CSD's YDD entry
      // rather than add an unplanned arrival to the airport turning cycle.
      A.to = 28; A.kind = 'wd';
      A.stops = buildStops(ctx, 'DN', A.from, A.to, A.stops[0].dep, true, factorAt);
    }
  }

  // Published last origins must be explicit, rather than the last slot before
  // a cutoff. Shift the last existing duty, keeping its preceding headway.
  for (const [dir, from, to, dep] of [
    ['DN', W, E, OPERATIONS.lastBigEastboundDep],
    ['DN', W, GLL, OPERATIONS.lastLateEastboundDep],
    ['UP', E, W, OPERATIONS.lastBigWestboundDep],
  ] as const) {
    const last = trips.filter(t => t.dir === dir && t.from === from && t.to === to && t.revenue)
      .sort((a, b) => a.stops[0].dep - b.stops[0].dep).at(-1)!;
    last.stops = buildStops(ctx, dir, from, to, dep, true, factorAt);
  }
  for (const [id, trip] of trips.entries()) trip.id = id;
  for (const place of overnightPlaces(topo).filter(place => place.kind === 'origin' || place.kind === 'platform')) {
    const candidate = trips.filter(trip => trip.stableBerth === undefined && trip.dir === place.departure
      && (place.kind === 'platform' ? trip.from === place.station
        : trip.from > place.station && !firstService.includes(trip) && !trip.locked)
      && trip.stops.some(stop => stop.st === place.station))
      .sort((a, b) => Number(STATIONS[b.from].id === place.origin) - Number(STATIONS[a.from].id === place.origin)
        || a.stops.find(stop => stop.st === place.station)!.dep - b.stops.find(stop => stop.st === place.station)!.dep)[0];
    if (!candidate) throw new Error(`${STATIONS[place.station].name} 无可用的过夜出车任务`);
    if (candidate.from !== place.station) trimRoute(candidate, place.station, candidate.to, 'ins');
    candidate.stableBerth = place.berth;
  }
  return { requests: trips, periods, firstService: new Set(firstService.map(service => service.id)) };
}


/** A service request fixes its core slot; outer legs are selected against
 * terminal places before any Trip is created. No request is cancelled. */
export interface ServiceRequest {
  id: number;
  dir: TrackDir;
  kind: TripKind;
  from: number;
  to: number;
  stops: PlanStop[];
  revenue: boolean;
  overlay?: string;
  standby?: boolean;
  locked?: boolean;
  stableBerth?: number;
}
interface DepotMove {
  dir: TrackDir;
  from: number;
  to: number;
  depot: number;
  stops: PlanStop[];
  revenue: boolean;
}
interface EndSupply {
  ends: Set<number>;
  pairs: Map<number, number>;
  stable: Map<number, number>;
  feeders: Map<number, DepotMove>;
  withdrawals: Map<number, DepotMove>;
  continuations: Map<number, number>;
}

/** Reserve actual terminal places and movements, rather than laying out
 * impossible full-route duties and repairing their endpoints afterwards.
 * Only the uncommitted outer legs can be selected here; the core calls stay
 * exactly as requested. The returned supply is used by circulation as-is. */
export function allocateTerminalServices(ctx: PlanContext, requests: readonly ServiceRequest[], published: ReadonlySet<number> = new Set()) {
  const { topo } = ctx;
  const services = requests.map(request => ({ ...request }));
  const supply: EndSupply = {
    ends: new Set([0, topo.stations.length - 1]), pairs: new Map(),
    stable: new Map(services.filter(service => service.stableBerth !== undefined).map(service => [service.id, service.stableBerth!])),
    feeders: new Map(), withdrawals: new Map(), continuations: new Map(),
  };
  const factor = (t: number) => dwellFactorAt(ctx.dayType, t);
  const arrival = (service: ServiceRequest) => service.stops.at(-1)!.arr;
  const departure = (service: ServiceRequest) => service.stops[0].dep;
  const locked = (service: ServiceRequest) => service.locked || published.has(service.id) || isPublishedOrigin(ctx, service);
  const places = new Map<number, { from: number; to: number }[]>();
  const standbyPlaces = new Map<number, { from: number; to: number }[]>();
  const periods = dayPeriods(ctx.dayType);
  const reserve = (station: number, from: number, to: number) => {
    const list = places.get(station) ?? [];
    if (terminalOverflows(topo, station, [...list, { from, to }]).length) return false;
    // Off-peak and while holding a standby, keep the arrival platform free.
    // Only a peak arrival wave may use the existing transient holding rule.
    const combined = [...list, { from, to }];
    const boundaries = [from, ...combined.map(place => place.from), ...periods.map(period => period.from), ...(standbyPlaces.get(station) ?? []).map(window => window.from)];
    if (boundaries.some(time => time >= from && time < to
      && (!TEMPLATES[periodAt(periods, time).template].peak || (standbyPlaces.get(station) ?? []).some(window => window.from <= time && window.to > time))
      && combined.filter(place => place.from <= time && place.to > time).length > (TERMINAL_CAP[station] ?? 2))) return false;
    list.push({ from, to });
    places.set(station, list);
    return true;
  };
  const selectRoute = (request: ServiceRequest, from: number, to: number, kind: TripKind) => {
    const stops = request.stops.filter(stop => stop.st >= Math.min(from, to) && stop.st <= Math.max(from, to)).map(stop => ({ ...stop }));
    stops[0].arr = stops[0].dep;
    stops.at(-1)!.dep = stops.at(-1)!.arr;
    services[request.id] = { ...request, from, to, kind, stops };
  };
  const movementIndex = (except?: number) => {
    const index = new DepIndex(services.filter(service => service.id !== except));
    for (const move of [...supply.feeders.values(), ...supply.withdrawals.values()]) index.add(move);
    return index;
  };
  const exitFree = (depot: number, dir: TrackDir, stops: PlanStop[]) => {
    const yard = topo.depots[depot], path = yard.portals.exit[dir].path;
    const [start, clear] = outboundWindow(ctx, depot, { dir, stops });
    const returns = [...services.filter(service => ![...supply.continuations.values()].includes(service.id)), ...supply.withdrawals.values()];
    return returns.every(service => {
      const portal = yard.portals.entry[service.dir];
      if (portal.station !== service.to || portal.path !== path) return true;
      const [approach, end] = inboundWindow(topo, depot, service);
      return clear <= approach || start >= end;
    });
  };
  for (const terminal of supply.ends) {
    const depot = depotIndex(topo, TERMINAL_DEPOT[terminal]);
    const turn = minTurn(terminal);
    const departures = services.filter(service => service.from === terminal).sort((a, b) => departure(a) - departure(b));
    const arrivals = services.filter(service => service.to === terminal).sort((a, b) => arrival(a) - arrival(b));
    if (!departures.length) continue;
    const places = overnightPlaces(topo).filter(place => place.station === terminal && place.kind === 'terminal');
    const overnight = places.length;
    const lastDeparture = departure(departures.at(-1)!);
    const night = new Set((overnight ? arrivals.filter(service => arrival(service) >= lastDeparture - 60).slice(-overnight) : []).map(service => service.id));
    // 【假设】 The existing overnight cars take the earliest duties. Storage
    // tails are freed before arrivals build up; no extra overnight car is added.
    const taken = new Set(departures.slice(0, overnight).map(service => service.id));
    for (const [index, id] of [...taken].entries()) supply.stable.set(id, places[index].berth);
    for (const window of hotStandbyPlaces(topo).some(place=>place.station===terminal) ? standbyWindows(ctx.dayType) : []) {
      const incoming = arrivals.find(service => arrival(service) >= window.from && arrival(service) < Math.min(window.need, window.to - 240)
        && !supply.pairs.has(service.id) && !night.has(service.id));
      const outgoing = incoming && departures.find(service => !taken.has(service.id) && departure(service) >= Math.max(window.need, arrival(incoming) + turn));
      if (!incoming || !outgoing || !reserve(terminal, arrival(incoming), departure(outgoing))) continue;
      services[incoming.id] = { ...incoming, standby: true };
      standbyPlaces.set(terminal, [...(standbyPlaces.get(terminal) ?? []), { from: arrival(incoming), to: departure(outgoing) }]);
      supply.pairs.set(incoming.id, outgoing.id);
      taken.add(outgoing.id);
    }
    for (const incoming of arrivals.filter(service => locked(service) && !night.has(service.id) && !supply.pairs.has(service.id))) {
      const outgoing = departures.find(service => !taken.has(service.id) && departure(service) >= arrival(incoming) + turn
        && departure(service) <= arrival(incoming) + MAX_LAYOVER);
      if (outgoing && reserve(terminal, arrival(incoming), departure(outgoing))) {
        supply.pairs.set(incoming.id, outgoing.id);
        taken.add(outgoing.id);
      }
    }
    // Meet each departure deadline with the most recent ready car. Assigning
    // every early arrival far into the future needlessly fills the tails and
    // then requires another yard feeder for a nearer departure.
    for (const outgoing of departures.filter(service => !taken.has(service.id))) {
      const ready = arrivals.filter(service => !night.has(service.id) && !supply.pairs.has(service.id)
        && arrival(service) + turn <= departure(outgoing) && arrival(service) >= departure(outgoing) - MAX_LAYOVER)
        .sort((a, b) => arrival(b) - arrival(a));
      const incoming = ready.find(service => reserve(terminal, arrival(service), departure(outgoing)));
      if (!incoming) continue;
      supply.pairs.set(incoming.id, outgoing.id);
      taken.add(outgoing.id);
    }
    for (const incoming of arrivals) {
      if (night.has(incoming.id) || supply.pairs.has(incoming.id)) continue;
      // A surplus car still serves the line end if a real withdrawal path
      // and a place until that departure are available.
      const dir: TrackDir = terminal === 0 ? 'DN' : 'UP';
      const to = entryStation(topo, depot, dir);
      const index = movementIndex();
      let withdrawing = false;
      for (let offset = 0; offset <= 2400 && !withdrawing; offset += 5) {
        const modes = arrival(incoming) >= lastDeparture - 60 ? [false] : terminal === 0 ? [true, false] : [false, true];
        for (const revenue of modes) {
          const stops = buildStops(ctx, dir, terminal, to, arrival(incoming) + turn + offset, revenue, factor);
          if (!index.clear(stops, dir)) continue;
          if (revenue && stops.some(stop => stop.st < 4 && inOuterAlternation(dayPeriods(ctx.dayType), stop.dep))) continue;
          if (!reserve(terminal, arrival(incoming), stops[0].dep)) continue;
          supply.withdrawals.set(incoming.id, { dir, from: terminal, to, depot, stops, revenue });
          withdrawing = true;
          break;
        }
      }
      if (withdrawing || locked(incoming)) continue;
      // No end-terminal place: finish carrying at the existing entry portal,
      // preserving every requested core call instead of creating a queue there.
      selectRoute(incoming, incoming.from, entryStation(topo, depot, incoming.dir), 'wd');
    }
    for (const outgoing of departures.filter(service => !taken.has(service.id))) {
      // A car finishing at the depot junction can continue in the same
      // direction to position at the line end. Reuse it before scheduling
      // a new yard exit against the return wave on that very lead.
      const direction = outgoing.dir === 'DN' ? 'UP' : 'DN';
      const junction = exitStation(topo, depot, direction);
      let continuing = false;
      for (const incoming of services.filter(service => service.to === junction && service.dir === direction
        && ![...supply.continuations.values()].includes(service.id)).sort((a, b) => arrival(b) - arrival(a))) {
        if (arrival(incoming) >= departure(outgoing) - turn) continue;
        // This is the same car's call at the junction, not a second train.
        const others = services.filter(service => service.id !== incoming.id && service.id !== outgoing.id);
        const throughIndex = new DepIndex(others);
        for (const move of [...supply.feeders.values(), ...supply.withdrawals.values()]) throughIndex.add(move);
        const boarding = plannedDwell(ctx.dayType, junction, direction, arrival(incoming), factor(arrival(incoming)));
        for (let wait = 20; wait <= THROUGH_WAIT && !continuing; wait += 5) {
          for (const revenue of [true, false]) {
            if (revenue && wait < boarding) continue;
            const stops = buildStops(ctx, direction, junction, terminal, arrival(incoming) + wait, revenue, factor);
            if (!revenue && stops.some(stop => stop.st < 4 && inOuterAlternation(periods, stop.dep))) continue;
            if (stops.at(-1)!.arr + turn > departure(outgoing) || departure(outgoing) - stops.at(-1)!.arr > MAX_LAYOVER) continue;
            if (!throughIndex.clear(stops, direction) || !reserve(terminal, stops.at(-1)!.arr, departure(outgoing))) continue;
            supply.feeders.set(outgoing.id, { dir: direction, from: junction, to: terminal, depot, stops, revenue });
            supply.continuations.set(outgoing.id, incoming.id);
            continuing = true;
            break;
          }
        }
        if (continuing) break;
      }
      if (continuing) continue;
      const origins = [terminal, ...topo.stations.map((_, station) => station).filter(station => station !== terminal
        && outgoing.stops.some(stop => stop.st === station)
        && (turnbackAt(topo, station, outgoing.dir === 'DN' ? 'UP' : 'DN') || exitStation(topo, depot, outgoing.dir) === station))]
        .filter(station => outgoing.dir === 'DN' ? station <= 4 : station >= 22);
      let supplied = false;
      for (const origin of locked(outgoing) ? [terminal] : origins) {
        const dep = outgoing.stops.find(stop => stop.st === origin)!.dep;
        const dir: TrackDir = topo.stations[origin].chain < topo.depots[depot].junctionChain ? 'UP' : 'DN';
        const from = exitStation(topo, depot, dir);
        if (from === origin) {
          if (!exitFree(depot, dir, outgoing.stops.filter(stop => stop.st >= Math.min(origin, outgoing.to) && stop.st <= Math.max(origin, outgoing.to)))) continue;
          selectRoute(outgoing, origin, outgoing.to, origin === terminal ? outgoing.kind : 'ins');
          supplied = true;
          break;
        }
        const reversing = dir !== outgoing.dir;
        const latest = dep - (reversing ? minTurn(origin) : 0) - 10;
        const index = movementIndex(outgoing.id);
        for (let offset = 0; offset <= (reversing ? MAX_LAYOVER : THROUGH_WAIT) && !supplied; offset += 5) {
          for (const revenue of [true, false]) {
            let start = latest - offset - buildStops(ctx, dir, from, origin, 0, revenue, factor).at(-1)!.arr;
            for (let k = 0; k < 8; k++) {
              const error = buildStops(ctx, dir, from, origin, start, revenue, factor).at(-1)!.arr - (latest - offset);
              start -= error;
              if (Math.abs(error) < .001) break;
            }
            const stops = buildStops(ctx, dir, from, origin, start, revenue, factor);
            if (!index.clear(stops, dir) || !exitFree(depot, dir, stops)
              || !frontTurnClear(ctx, services, { dir, to: origin, stops }, dep, new Set([outgoing.id]))) continue;
            if (!reserve(origin, stops.at(-1)!.arr, dep)) continue;
            if (origin !== terminal) selectRoute(outgoing, origin, outgoing.to, 'ins');
            supply.feeders.set(outgoing.id, { dir, from, to: origin, depot, stops, revenue });
            supplied = true;
            break;
          }
        }
        if (supplied) break;
      }
      // A locked/unreachable request is retained; feasibility errors remain
      // visible instead of dropping it or substituting an arbitrary service.
    }
  }
  return { services, supply };
}

/** Match draft requests to stock and daily homes, publish their final passenger
 * boundaries, then resolve bounded timing conflicts. Published routes are fixed. */
const generatedPlans = new Map<string, Plan>();
/** Cache only pristine diagrams; every caller gets its own mutable copy and
 * validation metadata. Include all mutable planning inputs in the key. */
export function generatePlan(ctx: PlanContext, shift?: number[], stock?: number[]): Plan {
  if (shift || stock) return buildPlan(ctx,shift,stock);
  const key=JSON.stringify([ctx,OPERATIONS,TEMPLATES,SHOWN_PERIODS,DWELL_BANDS,RUN_BANDS,FIXED_LATE_TRAINS,FIRST_LAST]);
  let pristine=generatedPlans.get(key);
  if(!pristine) {
    pristine=buildPlan(ctx);
    if(generatedPlans.size>=8)generatedPlans.delete(generatedPlans.keys().next().value!);
    generatedPlans.set(key,pristine);
  }
  const plan=structuredClone(pristine);
  const identities=laidOutService.get(pristine);
  if(identities)laidOutService.set(plan,new Map([...identities].map(([trip,identity])=>[plan.trips[trip.id],structuredClone(identity)])));
  generationIssues.set(plan,structuredClone(generationIssues.get(pristine)??[]));
  rejectedTurns.set(plan,[...(rejectedTurns.get(pristine)??[])]);
  return plan;
}

function buildPlan(ctx: PlanContext, shift?: number[], stock?: number[], sourceDepots?: ReadonlyMap<number, number>): Plan {
  const { topo } = ctx;
  const { requests, periods, firstService: published } = layoutService(ctx);
  const { services, supply } = allocateTerminalServices(ctx, requests, published);
  const drafts: GenTrip[] = [];
  const serviceStructure = new Map<Trip, ServiceIdentity>();
  const requestIssues: PlanIssue[] = [];
  for (const service of services) {
    const request = requests[service.id];
    const required = request.stops.filter(stop => stop.st >= Math.max(4, Math.min(request.from, request.to))
      && stop.st <= Math.min(22, Math.max(request.from, request.to)));
    const lastCore = request.dir === 'DN' ? 22 : 4;
    const retainsCore = service.dir === request.dir && required.every(stop => {
      const selected = service.stops.find(call => call.st === stop.st);
      return selected && (stop.st === lastCore ? selected.arr === stop.arr : selected.dep === stop.dep);
    });
    const locked = request.locked || published.has(request.id) || isPublishedOrigin(ctx, request);
    if (!retainsCore || (locked && (request.from !== service.from || request.to !== service.to))) {
      requestIssues.push({ severity: 'error', code: 'SERVICE_STRUCTURE', t: request.stops[0].dep,
        text: `服务请求 ${request.id} 的固定交路或核心时隙被改写` });
    }
    const trip = addTo(drafts, service.dir, service.kind, service.from, service.to, service.stops.map(stop => ({ ...stop })), service.revenue);
    if (service.standby) trip.standby = true;
  }
  const W = 0, E = topo.stations.length - 1;
  const requestedDepartures = new Map(drafts.map(trip => [trip.id, trip.stops[0].dep]));
  const anchors = new Set(published);
  for (const trip of drafts) if (isPublishedOrigin(ctx, trip)) anchors.add(trip.id);
  spaceServiceDepartures(drafts, anchors);
  const clocks = { original: new Map(requestedDepartures), protected: anchors };
  const blocks = circulate(ctx, drafts, [...new Set([W, E, 4, 22, 1, 19, 28, ...overnightPlaces(topo).map(place => place.station)])], periods, undefined, undefined, 0, undefined, undefined, shift, stock, supply, clocks, sourceDepots);
  addIntermediateStandbys(ctx, drafts, blocks);
  // This is the publication boundary. Matching above selects retirement
  // destinations; subsequent conflict handling cannot change those choices.
  const trips = drafts.map(trip => ({ ...trip, stops: trip.stops.map(stop => ({ ...stop })) }));
  const rejected = (draftRejectedTurns.get(blocks) ?? []).filter(r => r.arrival.next !== r.departure.id)
    .map(r => ({ arrival: trips[r.arrival.id], departure: trips[r.departure.id], conflicts: r.conflicts.map(t => trips[t.id]) }));
  const firstService = trips.filter(trip => published.has(trip.id));
  const anchorTrips = trips.filter(trip => anchors.has(trip.id));
  const originalDepartures = new Map(trips.filter(trip => clocks.original.has(trip.id))
    .map(trip => [trip, clocks.original.get(trip.id)!]));
  for (const trip of trips.slice(0, services.length)) serviceStructure.set(trip, serviceIdentity(trip));
  finishDepotMoves(trips, blocks);
  resolveTimingConflicts(ctx, trips, blocks, new Set(anchorTrips.map(t => t.id)), originalDepartures);
  addFixedRuns(ctx, trips, blocks, ctx.fixedRuns ?? FIXED_LATE_TRAINS);

  // Trains before a station opens cannot board there (positioning and depot
  // trips). A station opens when the first of the published first trains
  // passes it in the plan, not at the published clock time: those times are
  // whole minutes, and while run times are short of the real ones the first
  // train itself reaches the middle of the line early (D72). The clock time
  // is only the fallback where no first train passes.
  const firstDN = trips.filter(t => t.dir === 'DN' && t.from === W && t.revenue && !t.cancelled)
    .sort((a, b) => a.stops[0].dep - b.stops[0].dep)[0];
  const openers = [...firstService, ...(firstDN ? [firstDN] : [])].filter(t => !t.cancelled);
  const opening = (st: number, dir: TrackDir): number => {
    const own = openers.filter(t => t.dir === dir).flatMap(t => t.stops.filter(s => s.st === st && s.stop && s.st !== t.to).map(s => s.dep));
    if (own.length) return Math.min(...own);
    const row = FIRST_LAST.find(r => r.station === STATIONS[st].name);
    const clock = row && (dir === 'DN' ? row.firstE : row.firstW);
    if (!clock) return -Infinity;
    const [h, m] = clock.split(':').map(Number);
    return h * 3600 + m * 60;
  };
  for (const trip of trips) if (trip.revenue && !trip.cancelled) {
    for (const stop of trip.stops) if (stop.dep < opening(stop.st, trip.dir) - .001) stop.noBoard = true;
    if (!trip.stops.some(s => s.st !== trip.to && s.stop && !s.noBoard)) trip.revenue = false;
  }
  const plan: Plan = {
    dayType: ctx.dayType, trips, blocks,
    ...(ctx.initialStock ? { initialStock: ctx.initialStock.slice() } : {}),
    periods: SHOWN_PERIODS[ctx.dayType].map((p) => ({ from: p.from, to: p.to, template: p.template, label: p.label })),
    overlays: [], fleetPeak: 0,
  };
  laidOutService.set(plan, serviceStructure);
  generationIssues.set(plan, [...requestIssues, ...serviceStructureIssues(plan)]);
  numberPlan(plan);
  rejectedTurns.set(plan, [...new Set(rejected.map(r => `${r.arrival.no}→${r.departure.no}：折返待发与 ${r.conflicts.map(t => t.no).join('、')} 出入段共用线路或咽喉冲突，不采用该正线接续`))]);
  plan.fleetPeak = fleetPeak(plan);
  if (!shift) {
    const need = yardNeed(topo, plan);
    const over = need.map((n, d) => Math.max(0, n - (ctx.initialStock?.[d] ?? topo.depots[d].capacity)));
    if (over.some((n) => n > 0)) {
      const origins = new Map<number, number>();
      for (const move of depotMoves(plan.blocks, plan.trips)) if (move.delta < 0)
        for (const id of plan.blocks[move.block].trips) origins.set(id, move.depot);
      return buildPlan(ctx, over, need, origins);
    }
  }
  if (shift && ctx.initialStock) {
    const need = yardNeed(topo, plan);
    need.forEach((n, depot) => {
      const shortage = n - ctx.initialStock![depot];
      if (shortage > 0) generationIssues.get(plan)!.push({severity:'error',code:'YARD_BALANCE',depot,delta:shortage,t:OPENING.dayStart,
        text:`${topo.depots[depot].name} 日初需要 ${n} 列，实际 ${ctx.initialStock![depot]} 列；无可行改派来源，库存不足的出段任务延后`});
    });
  }
  return plan;
}

/** Planned crewed spares use genuine positioning paths and return to their
 * source yard before the overnight stock takes the same physical slots. */
function addIntermediateStandbys(ctx: PlanContext, trips: GenTrip[], blocks: Block[]) {
  const { topo } = ctx;
  const index = new DepIndex(trips);
  for (const place of hotStandbyPlaces(topo).filter(p => p.depot && p.incoming)) {
    const depot = depotIndex(topo, place.depot!);
    const dir = place.incoming!;
    const back = dir === 'DN' ? 'UP' : 'DN';
    const ex = exitStation(topo, depot, dir), en = entryStation(topo, depot, back);
    for (const window of standbyWindows(ctx.dayType)) {
      const choose = (heading: TrackDir, from: number, to: number, earliest: number, arriving: boolean) => {
        for (let offset = 0; offset <= 3600; offset += 10) {
          // Stopping empty trains keep the same progression as the passenger
          // stream; an express empty move cannot overtake it between stations.
          const stops = buildStops(ctx, heading, from, to, earliest + offset, false, 1, () => true);
          if (!index.clear(stops, heading)) continue;
          const test = { dir: heading, to, stops };
          const [start, clear] = arriving ? outboundWindow(ctx, depot, test) : inboundWindow(topo, depot, test);
          if (sharedLead(topo, depot) && blocks.some(b => {
            if (arriving && b.end.kind === 'depot' && b.end.depot === depot) {
              const last = trips[b.trips.at(-1)!];
              const [a, z] = inboundWindow(topo, depot, last);
              return start < z && clear > a;
            }
            if (!arriving && b.start.kind === 'depot' && b.start.depot === depot) {
              const [a, z] = outboundWindow(ctx, depot, trips[b.trips[0]]);
              return start < z && clear > a;
            }
            return false;
          })) continue;
          return stops;
        }
        throw new Error(`${STATIONS[place.station].name}热备无可行${arriving ? '进位' : '回段'}时隙`);
      };
      const run = buildStops(ctx, dir, ex, place.station, window.from, false, 1, () => true).at(-1)!.arr - window.from;
      const out = choose(dir, ex, place.station, window.from - run, true);
      const into = choose(back, place.station, en, window.need, false);
      if (place.track === 'storage') {
        // No platform on the middle track: enter it directly from the last
        // approach and leave towards the next station after changing ends.
        out.at(-1)!.stop = false;
        into[0].stop = false;
      }
      const arrival = addTo(trips, dir, 'empty', ex, place.station, out, false);
      arrival.standby = true;
      const departure = addTo(trips, back, 'empty', place.station, en, into, false);
      const b: Block = { id: blocks.length, svc: '', start: { kind: 'depot', depot, time: depotStartTime(ctx, depot, arrival) },
        end: { kind: 'depot', depot }, trips: [arrival.id, departure.id] };
      arrival.block = departure.block = b.id;
      blocks.push(b);
      index.add(arrival); index.add(departure);
    }
  }
}

/** Publish only the chosen depot moves after matching; unused feeder candidates
 * never become numbered train services. Primary services are protected above. */
function finishDepotMoves(trips: GenTrip[], blocks: Block[]) {
  const used = new Set(blocks.flatMap(b => b.trips));
  const retained = trips.filter(t => used.has(t.id));
  const ids = new Map(retained.map((t, id) => [t.id, id]));
  for (const trip of retained) {
    trip.id = ids.get(trip.id)!;
    if (trip.prev !== undefined) trip.prev = ids.get(trip.prev);
    if (trip.next !== undefined) trip.next = ids.get(trip.next);
  }
  for (const block of blocks) block.trips = block.trips.map(id => ids.get(id)!);
  trips.splice(0, trips.length, ...retained);
}

export function isPublishedOrigin(ctx: PlanContext, trip: Pick<Trip, 'from' | 'to' | 'dir' | 'stops'>): boolean {
  return (trip.from === 0 && [OPERATIONS.firstWestTerminusDep, OPERATIONS.lastBigEastboundDep, OPERATIONS.lastLateEastboundDep].includes(trip.stops[0].dep))
    || (trip.from === ctx.topo.stations.length - 1 && [OPERATIONS.firstEastTerminusDep, OPERATIONS.lastBigWestboundDep].includes(trip.stops[0].dep));
}

/** Resolve full-path headway drift before assigning trains and depot moves. */
function spaceServiceDepartures(trips: GenTrip[], protectedIds: Set<number>) {
  const original = trips.map(t => t.stops[0].dep);
  const shifted = (trip: GenTrip, delta: number) => trip.stops.map(p => ({ ...p, arr: p.arr + delta, dep: p.dep + delta }));
  const withinBudget = (trip: GenTrip, delta: number) => Math.abs(trip.stops[0].dep + delta - original[trip.id]) <= MAX_DIAGRAM_SHIFT_S;
  for (let round = 0; round < TIMING_ROUNDS; round++) {
    let moved = false;
    let index = new DepIndex(trips);
    for (const trip of trips) {
      if (protectedIds.has(trip.id) || index.clear(trip.stops, trip.dir, MIN_HEADWAY + 0.01, trip.stops)) continue;
      const others = new DepIndex(trips.filter(t => t !== trip));
      const neighbours = trips.filter(t => t !== trip && t.dir === trip.dir && !protectedIds.has(t.id)
        && !new DepIndex([t]).clear(trip.stops, trip.dir, MIN_HEADWAY + 0.01));
      let resolved = false;
      // Minimise the largest clock change. Sharing a correction between two
      // neighbours avoids moving an entire full-route path by twenty seconds.
      for (let amount = 1; amount <= MAX_DIAGRAM_SHIFT_S && !resolved; amount++) {
        for (const sign of [-1, 1]) {
          const delta = amount * sign;
          if (!withinBudget(trip, delta)) continue;
          const stops = shifted(trip, delta);
          if (others.clear(stops, trip.dir, MIN_HEADWAY + 0.01)) {
            trip.stops = stops;
            resolved = true;
            break;
          }
          for (const neighbour of neighbours) {
            if (!withinBudget(neighbour, -delta)) continue;
            const otherStops = shifted(neighbour, -delta);
            const index = new DepIndex(trips.filter(t => t !== trip && t !== neighbour));
            if (!index.clear(stops, trip.dir, MIN_HEADWAY + 0.01) || !index.clear(otherStops, neighbour.dir, MIN_HEADWAY + 0.01)
              || !new DepIndex([{ ...neighbour, stops: otherStops }]).clear(stops, trip.dir, MIN_HEADWAY + 0.01)) continue;
            trip.stops = stops;
            neighbour.stops = otherStops;
            resolved = true;
            break;
          }
          if (resolved) break;
        }
      }
      moved ||= resolved;
      if (resolved) index = new DepIndex(trips);
    }
    if (!moved) break;
  }
}

/** Only clock shifts are permitted once the service has been laid out. */
export const MAX_DIAGRAM_SHIFT_S = 20;
const TIMING_ROUNDS = 64;
function resolveTimingConflicts(ctx: PlanContext, trips: GenTrip[], blocks: Block[], protectedIds: Set<number>, serviceDepartures: Map<GenTrip, number>) {
  const original = trips.map(t => serviceDepartures.get(t) ?? t.stops[0].dep);
  const plan: Plan = { dayType: ctx.dayType, trips, blocks, periods: [], overlays: [], fleetPeak: 0 };
  // Fixed late runs have not been attached yet, so the daily stock ledger
  // is checked on the finished plan, not on this temporary timing draft.
  const errors = () => validatePlan(ctx, plan, false, true).filter(i => i.severity === 'error');
  const cost = (issues: PlanIssue[]) => issues.reduce((sum, issue) =>
    sum + (issue.code === 'HEADWAY' ? 100 + Math.max(0, MIN_HEADWAY - (issue.gap ?? 0)) : 1000), 0);
  for (let round = 0; round < TIMING_ROUNDS; round++) {
    const before = errors();
    if (!before.length) break;
    let moved = false;
    for (const issue of before) {
      const candidates = [...new Set((issue.blocks ?? []).flatMap(id => blocks[id].trips))]
        .map(id => trips[id]).filter(t => !t.cancelled && !protectedIds.has(t.id)
          && t.stops[0].dep <= issue.t && t.stops.at(-1)!.arr >= issue.t - 120);
      for (const trip of candidates) {
        const stops = trip.stops;
        const amounts = [...(issue.code === 'HEADWAY' && issue.gap !== undefined
          ? [Math.min(MAX_DIAGRAM_SHIFT_S, MIN_HEADWAY - issue.gap + 1e-6)] : []),
          ...Array.from({ length: MAX_DIAGRAM_SHIFT_S }, (_, index) => MAX_DIAGRAM_SHIFT_S - index)];
        for (const amount of amounts) {
          for (const sign of [-1, 1]) {
            const delta = amount * sign;
            if (Math.abs(stops[0].dep + delta - original[trip.id]) > MAX_DIAGRAM_SHIFT_S) continue;
            trip.stops = stops.map(p => ({ ...p, arr: p.arr + delta, dep: p.dep + delta }));
            const after = errors();
            if (cost(after) < cost(before) && !after.some(i => !before.some(b => b.code === i.code && b.blocks?.join() === i.blocks?.join()))) {
              moved = true;
              break;
            }
            trip.stops = stops;
          }
          if (moved) break;
        }
        if (moved) break;
      }
      if (moved) break;
    }
    if (!moved) break; // Unsolved conflicts stay visible to validatePlan.
  }
}

/**
 * Fixed-time special trains (定点班车, FixedRun): by default the regular
 * 虹桥火车站 → 龙阳路 trains after the last train; a scenario can give its own.
 *
 * The train is one already going empty past the origin in the run's
 * direction shortly before the departure (the 蟠祥路 → 北翟路 returns): it
 * stops there and waits in the platform, or one that has just arrived at a
 * terminal origin and would otherwise go empty into the depot (浦东机场 →
 * 川沙). It runs the service — boarding at the first stations, set-down only
 * at the listed ones, passing the rest at the platform pass limit — and goes
 * on empty into `depotTo`. Without such a train one comes out of
 * `depotFrom` and turns at the origin.
 */
function addFixedRuns(ctx: PlanContext, trips: GenTrip[], blocks: Block[], runs: FixedRun[]) {
  const { topo } = ctx;
  const idx = (id: string) => STATIONS.findIndex((x) => x.id === id);
  for (const F of runs) {
    const from = idx(F.from), to = idx(F.to);
    const dir: TrackDir = from < to ? 'DN' : 'UP';
    const back: TrackDir = dir === 'DN' ? 'UP' : 'DN';
    const fwd = (a: number, b: number) => (dir === 'DN' ? a < b : a > b);
    const board = new Set(F.board.map(idx)), alight = new Set(F.alight.map(idx));
    const depot = depotIndex(topo, F.depotFrom), home = depotIndex(topo, F.depotTo);
    const entry = entryStation(topo, home, dir);
    for (const dep of F.departures) {
      const run = buildStops(ctx, dir, from, to, dep, true, 1, (st) => board.has(st) || alight.has(st));
      for (const st of run) if (alight.has(st.st)) st.noBoard = true;
      const r0 = { dir, revenue: true, cancelled: false } as GenTrip;
      const others = (ex: GenTrip[]) => new DepIndex(trips.filter((t) => !t.cancelled && !ex.includes(t)));
      type Pick = { b: Block; last: GenTrip; stops?: PlanStop[]; arr: number; moved: { t: GenTrip; stops: PlanStop[] }[] };
      let best: Pick | undefined;
      for (const b of blocks) {
        const last = trips[b.trips.at(-1)!];
        if (b.end.kind !== 'depot' || last.revenue || last.cancelled || last.dir !== dir) continue;
        if (last.from === from) {
          // just arrived at the terminal origin: turns there into the run
          const prev = b.trips.length > 1 ? trips[b.trips.at(-2)!] : undefined;
          const arr = prev ? prev.stops.at(-1)!.arr : -Infinity;
          if (!prev || prev.to !== from || arr > dep - minTurn(from) || arr < dep - MAX_LAYOVER) continue;
          if (!best || arr > best.arr) best = { b, last, arr, moved: [] };
          continue;
        }
        if (!fwd(last.from, from) || !fwd(from, last.to)) continue;
        // going empty past the origin: ends there and waits in the platform.
        // One due just too late leaves its terminal a little earlier when its
        // turnaround has the slack; one following too close behind the
        // waiting train (a single platform track) is put back a little.
        let stops = buildStops(ctx, dir, last.from, from, last.stops[0].dep, false, 1);
        const late = stops.at(-1)!.arr - (dep - 45);
        if (late > 0) {
          const prev = b.trips.length > 1 ? trips[b.trips.at(-2)!] : undefined;
          const start = last.stops[0].dep - late;
          if (late > 120 || !prev || start < prev.stops.at(-1)!.arr + minTurn(last.from)) continue;
          stops = buildStops(ctx, dir, last.from, from, start, false, 1);
          if (!others([last]).clear(stops, dir)) continue;
        }
        const arr = stops.at(-1)!.arr;
        if (arr < dep - 600 || (best && arr <= best.arr)) continue;
        const moved: { t: GenTrip; stops: PlanStop[] }[] = [];
        let ok = true;
        for (const t of trips) {
          if (t === last || t.cancelled || t.dir !== dir) continue;
          const at = t.stops.find((p) => p.st === from);
          if (!at || at.dep < arr - MIN_HEADWAY || at.dep > dep + 3 * MIN_HEADWAY) continue;
          const tb = blocks[t.block];
          if (t.revenue || !tb || tb.trips.at(-1) !== t.id) { ok = false; break; }
          const index = others([last, t, ...moved.map((m) => m.t)]);
          index.add({ ...last, stops } as Trip);
          index.add({ ...r0, stops: run } as Trip);
          for (const m of moved) index.add({ ...m.t, stops: m.stops } as Trip);
          let fit: PlanStop[] | null = null;
          for (let k = 1; k <= 60 && !fit; k++) {
            const st = buildStops(ctx, dir, t.from, t.to, t.stops[0].dep + k * 10, false, 1);
            if (st.find((p) => p.st === from)!.dep > dep && index.clear(st, dir)) fit = st;
          }
          if (!fit) { ok = false; break; }
          moved.push({ t, stops: fit });
        }
        if (ok) best = { b, last, stops, arr, moved };
      }
      let blk: Block;
      let r: GenTrip;
      if (best?.stops) {
        best.last.to = from;
        best.last.stops = best.stops;
        for (const m of best.moved) m.t.stops = m.stops;
        r = addTo(trips, dir, 'extra', from, to, run, true);
        best.b.trips.push(r.id);
        blk = best.b;
      } else if (best) {
        // the empty move into the depot becomes the run
        r = best.last;
        Object.assign(r, { kind: 'extra', to, stops: run, revenue: true });
        blk = best.b;
      } else {
        // out of the depot empty to the origin and turn there
        r = addTo(trips, dir, 'extra', from, to, run, true);
        const ex = exitStation(topo, depot, back);
        const index = new DepIndex(trips.filter((t) => !t.cancelled && t !== r));
        const targetArrival = dep - minTurn(from) - 60;
        let latest = targetArrival - buildStops(ctx, back, ex, from, 0, false, 1).at(-1)!.arr;
        for (let k = 0; k < 8; k++) {
          const error = buildStops(ctx, back, ex, from, latest, false, 1).at(-1)!.arr - targetArrival;
          latest -= error;
          if (Math.abs(error) < .001) break;
        }
        let move: PlanStop[] | null = null;
        for (let k = 0; k <= 90 && !move; k++) {
          const st = buildStops(ctx, back, ex, from, latest - k * 10, false, 1);
          if (index.clear(st, back)) move = st;
        }
        const m = addTo(trips, back, 'ins', ex, from, move ?? buildStops(ctx, back, ex, from, latest, false, 1), false);
        blk = { id: blocks.length, svc: '', start: { kind: 'depot', depot, time: 0 }, end: { kind: 'depot', depot: home }, trips: [m.id, r.id] };
        m.block = blk.id;
        blk.start = { kind: 'depot', depot, time: depotStartTime(ctx, depot, m) };
        blocks.push(blk);
      }
      r.block = blk.id;
      blk.end = { kind: 'depot', depot: home };
      // running faster than a stopping train ahead: it keeps behind it, standing
      // longer at its last stop before (or running slower out of the origin)
      {
        const index = new DepIndex(trips.filter((t) => !t.cancelled && t !== r && !blk.trips.includes(t.id)));
        // A hold at an earlier stop also shifts sections already checked.
        // Re-check the entire path after each hold, including empty feeders.
        for (let n = 0; n < 360; n++) {
          const k = run.findIndex((stop, i) => i > 0 && !index.clear([stop], dir));
          if (k < 0) break;
          let s = k - 1;
          while (s > 0 && !run[s].stop) s--;
          if (s === 0) for (let j = 1; j < run.length; j++) { run[j].arr += 10; run[j].dep += 10; }
          else { run[s].dep += 10; for (let j = s + 1; j < run.length; j++) { run[j].arr += 10; run[j].dep += 10; } }
        }
      }
      // terminating short of the depot: on empty to its entry
      if (fwd(to, entry)) {
        const index = new DepIndex(trips.filter((t) => !t.cancelled && t !== r));
        const t0 = run.at(-1)!.arr + 60;
        let st = buildStops(ctx, dir, to, entry, t0, false, 1);
        for (let k = 1; k <= 60 && !index.clear(st, dir); k++) st = buildStops(ctx, dir, to, entry, t0 + k * 10, false, 1);
        const w = addTo(trips, dir, 'wd', to, entry, st, false);
        w.block = blk.id;
        blk.trips.push(w.id);
      }
    }
  }
}

/**
 * Link trips into blocks at the given terminals, adding depot insertions,
 * withdrawals and terminal stabling. Mutates `trips` (adds new trips) and
 * returns the new blocks.
 */
function circulate(ctx: PlanContext, trips: GenTrip[], terminals: number[], periods: Period[], overlay?: string, baseTrips?: Trip[], blockBase = 0, baseOcc?: Map<number, { from: number; to: number; block?: number }[]>, reuse?: OverlayReuse, shift?: number[], stock?: number[], supply?: EndSupply, clocks?: DiagramClocks, sourceDepots?: ReadonlyMap<number, number>): Block[] {
  const { topo } = ctx;
  const factorAt = (t: number) => dwellFactorAt(ctx.dayType, t);
  const pool = trips.filter((t) => t.overlay === overlay && !t.cancelled);
  const continuing = new Set(supply?.continuations.values());
  let movementCount = -1;
  let movementCache: GenTrip[] = [];
  const allForGaps = () => {
    if (movementCount !== trips.length) {
      movementCache = [...(baseTrips ?? []), ...trips.filter(t => t.block !== UNUSED_DEPOT_MOVE)];
      movementCount = trips.length;
    }
    return movementCache;
  };
  const nightPlaces = overlay ? reuse?.nightPlaces ?? [] : overnightPlaces(topo);
  const stablingNight: Record<number, number> = {};
  for (const place of nightPlaces) stablingNight[place.station] = (stablingNight[place.station] ?? 0) + 1;
  // Overnight cars take the earliest departures, including the storage-tail
  // cars. Their places are freed before the arrival wave reaches the ends.
  const stabling: Record<number, number> = Object.fromEntries(Object.entries(stablingNight)
    .map(([st, n]) => [st, nightPlaces.some(place => place.station === +st && place.kind === 'terminal') ? n : 0]));
  const W = 0;
  const sources: GenTrip[] = [];
  const sinks: GenTrip[] = [];

  /**
   * An added-service trip into a terminal the base plan already fills does not run: the
   * train goes back to the depot after the trip before (or the trip is simply not run).
   */
  const dropArrival = (X: GenTrip) => {
    cancelTrip(X, `加开：${STATIONS[X.to].name}终点站能力已满`);
    if (X.next !== undefined) { trips[X.next].prev = undefined; X.next = undefined; }
    if (X.prev !== undefined) {
      const P = trips[X.prev];
      P.next = undefined;
      X.prev = undefined;
      sinks.push(P);
    } else if (sources.includes(X)) sources.splice(sources.indexOf(X), 1);
  };
  /** turnbacks added by extensions, on top of the base plan's (baseOcc) */
  const extOcc: { st: number; from: number; to: number; block: number }[] = [];
  /** the station still has a place for a train standing there over [from, to) */
  const placeFree = (st: number, from: number, to: number, own: number) => {
    const clear = OPERATIONS.platformTurnClear[STATIONS[st].id] ?? 0;
    const list = [...(baseOcc?.get(st) ?? []), ...extOcc.filter(o => o.st === st)]
      .filter(o => o.block !== own).map(o => ({...o,from:o.from-clear,to:o.to+clear})).filter(o => o.from < to && o.to > from);
    const at = [from, ...list.map(o => o.from).filter(x => x > from)];
    const cap = TERMINAL_CAP[st] ?? (topo.stations[st].turnbackBerths.length || 1);
    return at.every(t => list.filter(o => o.from <= t && o.to > t).length < cap);
  };
  for (const T of terminals) {
    if (supply && supply.ends.has(T)) {
      for (const [arrival, departure] of supply.pairs) if (trips[arrival].to === T) {
        trips[arrival].next = departure;
        trips[departure].prev = arrival;
      }
      const paired = new Set(supply.pairs.values());
      sources.push(...pool.filter(t => t.from === T && !paired.has(t.id)));
      sinks.push(...pool.filter(t => t.to === T && !supply.pairs.has(t.id)));
      continue;
    }
    const arrivals = pool.filter((t) => t.to === T && !continuing.has(t.id)).map((t) => ({ trip: t, time: t.stops[t.stops.length - 1].arr }));
    const departures = pool.filter((t) => t.from === T).map((t) => ({ trip: t, time: t.stops[0].dep }));
    type Ev = { time: number; kind: 0 | 1; trip: GenTrip };
    const evs: Ev[] = [
      ...arrivals.map((a) => ({ time: a.time, kind: 0 as const, trip: a.trip })),
      ...departures.map((d) => ({ time: d.time, kind: 1 as const, trip: d.trip })),
    ].sort((a, b) => a.time - b.time || a.kind - b.kind);
    const cap = MAX_PRESENT[T] ?? 2;
    const mt = minTurn(T);
    // FIFO matching of arrivals to departures
    const pairs: { a: GenTrip; d: GenTrip }[] = [];
    const out: GenTrip[] = [];
    const src: GenTrip[] = [];
    const present: { trip: GenTrip; ready: number }[] = [];
    // An added departure placed in the turnback window of an added arrival
    // (applyOverlay) comes linked to it: that train takes it.
    const unlink = (a: GenTrip) => { if (a.next !== undefined) { trips[a.next].prev = undefined; a.next = undefined; } };
    for (let ei = 0; ei < evs.length; ei++) {
      const ev = evs[ei];
      // trains idle longer than the maximum layover go back to the depot
      for (let i = present.length - 1; i >= 0; i--) {
        if (ev.time - present[i].ready > (T > 0 && T < topo.stations.length - 1 ? 450 : MAX_LAYOVER)) { unlink(present[i].trip); out.push(present.splice(i, 1)[0].trip); }
      }
      if (ev.trip.cancelled) { if (ev.kind === 0) unlink(ev.trip); else if (ev.trip.prev !== undefined) unlink(trips[ev.trip.prev]); continue; }
      if (ev.kind === 0) {
        // trains of the base plan turning back here (when adding an overlay) take places too
        const base = (baseOcc?.get(T) ?? []).filter((o) => o.from <= ev.time + mt && o.to > ev.time).length;
        if (overlay && base >= cap) { unlink(ev.trip); out.push(ev.trip); continue; }
        present.push({ trip: ev.trip, ready: ev.time + mt });
        if (present.length + base > cap) { const x = present.shift()!.trip; unlink(x); out.push(x); }
      } else {
        const linked = ev.trip.prev;
        let i = linked === undefined ? -1 : present.findIndex(p => p.trip.id === linked && p.ready <= ev.time);
        if (i < 0 && linked !== undefined) unlink(trips[linked]);
        if (i >= 0 && !placeFree(T, present[i].ready-mt, ev.time, -1)) i = -1;
        if (i < 0) i = present.findIndex((p) => p.trip.next === undefined && p.ready <= ev.time && placeFree(T,p.ready-mt,ev.time,-1) && frontTurnClear(ctx, allForGaps(),
          p.trip, ev.time, new Set([p.trip.id, ev.trip.id])));
        if (i >= 0) pairs.push({ a: present.splice(i, 1)[0].trip, d: ev.trip });
        else src.push(ev.trip);
      }
    }
    for (const p of present) out.push(p.trip);
    const m = { pairs, out, src };
    for (const p of m.pairs) { p.a.next = p.d.id; p.d.prev = p.a.id;
      extOcc.push({st:T,from:p.a.stops.at(-1)!.arr,to:p.d.stops[0].dep,block:-p.a.id-2});
    }
    sinks.push(...m.out);
    sources.push(...m.src);
  }

  // stream departures at a station in a direction (for gap placement)
  const streamDeps = (st: number, dir: TrackDir): number[] => {
    const out: number[] = [];
    for (const t of allForGaps()) {
      if (t.dir !== dir || t.cancelled) continue;
      for (const s of t.stops) if (s.st === st) { out.push(s.dep); break; }
    }
    return out.sort((a, b) => a - b);
  };
  // departures per station and direction, rebuilt whenever trips were added
  const depIndex = new Map<string, number[]>();
  let depIndexN = -1;
  const depsAt = (st: number, dir: TrackDir): number[] => {
    // Appending a draft movement invalidates the stream. Do not repeatedly
    // allocate/filter the entire graph just to check its size in a slot search.
    if (depIndexN !== trips.length) { depIndex.clear(); depIndexN = trips.length; }
    const k = `${st}${dir}`;
    let v = depIndex.get(k);
    if (!v) { v = streamDeps(st, dir); depIndex.set(k, v); }
    return v;
  };
  /** a trip keeps the minimum headway to every other train at every station on its path (P1) */
  const pathClear = (stops: PlanStop[], dir: TrackDir) => stops.every(stop => {
    const departures = depsAt(stop.st, dir);
    let lo = 0, hi = departures.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (departures[mid] <= stop.dep - MIN_HEADWAY) lo = mid + 1;
      else hi = mid;
    }
    return lo === departures.length || departures[lo] >= stop.dep + MIN_HEADWAY;
  });
  /** stops of a move starting at or before `latest` that fit between the other trains along the whole path */
  const fitBefore = (dir: TrackDir, latest: number, build: (t0: number) => PlanStop[], continuation?: GenTrip, accept: (st: PlanStop[]) => boolean = () => true): PlanStop[] | null => {
    const protection = continuation ? new DepIndex(allForGaps().filter(t => t !== continuation)) : null;
    for (let k = 0; k <= 240; k++) {
      const st = build(latest - k * 10);
      if (accept(st) && (protection ? protection.clear(st,dir) : pathClear(st, dir))) return st;
    }
    return null;
  };
  /** stops of a move starting at or after `earliest` that fit between the other trains along the whole path */
  const fitAfter = (dir: TrackDir, earliest: number, build: (t0: number) => PlanStop[], accept: (st: PlanStop[]) => boolean = () => true): PlanStop[] | null => {
    let at = earliest;
    for (let k = 0; k <= 480 && at <= earliest + 2400; k++) {
      const st = build(at);
      if (accept(st) && pathClear(st, dir)) return st;
      // Jump to the end of an actual conflict. A ten-second grid can miss
      // the narrow safe gap between two trains during a peak transition.
      let push = 0;
      for (const stop of st) for (const other of depsAt(stop.st, dir))
        if (Math.abs(other - stop.dep) < MIN_HEADWAY) push = Math.max(push, other + MIN_HEADWAY - stop.dep);
      at += push > 0 ? push + .000001 : 10;
    }
    return null;
  };
  /** latest slot ≤ latest keeping ≥SLOT_GAP from neighbouring departures */
  const placeBefore = (st: number, dir: TrackDir, latest: number): number => {
    const deps = streamDeps(st, dir).filter((x) => x > latest - 2400 && x < latest + 900);
    if (!deps.length || latest > deps[deps.length - 1] + SLOT_GAP) return Math.round(latest);
    let best = -Infinity;
    const bounds = [-Infinity, ...deps, Infinity];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const cand = Math.min(latest, bounds[i + 1] - SLOT_GAP);
      if (cand >= bounds[i] + SLOT_GAP && cand > best) best = cand;
    }
    if (best === -Infinity) {
      // no clean slot: take the midpoint of the widest gap before `latest`
      let gap = 0;
      for (let i = 0; i + 1 < deps.length; i++) if (deps[i + 1] - deps[i] > gap && (deps[i] + deps[i + 1]) / 2 <= latest) { gap = deps[i + 1] - deps[i]; best = (deps[i] + deps[i + 1]) / 2; }
      if (best === -Infinity) best = latest;
    }
    return Math.round(best);
  };
  /** earliest slot ≥ earliest keeping ≥SLOT_GAP s from neighbouring departures */
  const placeAfter = (st: number, dir: TrackDir, earliest: number): number => {
    const deps = streamDeps(st, dir).filter((x) => x > earliest - 900 && x < earliest + 2400);
    // Round up: a slot may not start before `earliest` (the turnback minimum).
    if (!deps.length || earliest < deps[0] - SLOT_GAP) return Math.ceil(earliest - 1e-9);
    let best = Infinity;
    const bounds = [-Infinity, ...deps, Infinity];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const cand = Math.max(earliest, bounds[i] + SLOT_GAP);
      if (cand <= bounds[i + 1] - SLOT_GAP && cand < best) best = cand;
    }
    if (best === Infinity) {
      let gap = 0;
      for (let i = 0; i + 1 < deps.length; i++) if (deps[i + 1] - deps[i] > gap && (deps[i] + deps[i + 1]) / 2 >= earliest) { gap = deps[i + 1] - deps[i]; best = (deps[i] + deps[i + 1]) / 2; }
      if (best === Infinity) best = earliest;
    }
    return Math.ceil(best - 1e-9);
  };

  // West of 淞虹路 the peak runs big-route trains only, alternating 2'30" and
  // 5'00". A depot move there would split a 5'00" gap, so none is planned in
  // the outer alternation window (D30).
  const outerQuiet = (stops: PlanStop[]) => !stops.some(p => p.st < 4 && inOuterAlternation(periods, p.dep));
  const lastDepFrom = (T: number) => Math.max(...pool.filter((t) => t.from === T).map((t) => t.stops[0].dep), -Infinity);
  const firstDepFrom = (T: number) => Math.min(...pool.filter((t) => t.from === T).map((t) => t.stops[0].dep), Infinity);
  const startOf: Map<number, Block['start']> = new Map();
  const endOf: Map<number, Block['end']> = new Map();

  /**
   * Before an added-service train is brought out of the depot, a train of the
   * base plan that is about to go back to the same depot keeps running and
   * takes the added trip (延长运用, D47): its withdrawal is replaced by a move
   * to the origin, or by the added trip itself when it is already there. This
   * avoids a yard exit against the return wave on BZL/CSD's shared conversion
   * track, and serves 广兰路 while the core still runs at peak headway.
   */
  const reused = new Set<number>();
  /** Added moves through BZL/CSD's shared conversion track are planned
   * clear of the other trains' exits and returns (DEPOT_CONFLICT, D47). */
  const exitsPlanned: { depot: number; at: number; clear: number }[] = [];
  const shared = (depot: number) => sharedLead(topo, depot);
  const baseLive = (b: Block) => !reused.has(b.id) && b.trips.some(id => !trips[id].cancelled);
  const exitClear = (depot: number, start: number, first?: Pick<Trip,'dir'|'stops'>) => !reuse || !shared(depot)
    || reuse.blocks.every(b => !baseLive(b) || b.end.kind !== 'depot' || b.end.depot !== depot || (() => {
      const [approach, clear] = inboundWindow(topo, depot, b.trips.map(id => trips[id]).filter(t => !t.cancelled).at(-1)!);
      const exitEnd=first?outboundWindow(ctx,depot,first)[1]:start+topo.depots[depot].exitTime;
      return !(start < clear && exitEnd > approach);
    })());
  const entryClear = (depot: number, last: Trip) => {
    if (!reuse || !shared(depot)) return true;
    const [approach, clear] = inboundWindow(topo, depot, last);
    const exits = [...exitsPlanned.filter(x => x.depot === depot).map(x => [x.at,x.clear]),
      ...reuse.blocks.filter(b => baseLive(b) && b.start.kind === 'depot' && b.start.depot === depot)
        .map(b => outboundWindow(ctx,depot,trips[b.trips.find(id=>!trips[id].cancelled)!]))];
    return exits.every(([start,end]) => !(start < clear && end > approach));
  };
  const intermediate = (st: number) => st > 0 && st < topo.stations.length - 1;
  const orderOk = (st: number, from: number, to: number, own?: number) =>
    tailOrderClear(topo, st, [...(baseOcc?.get(st) ?? []), ...extOcc.filter(o => o.st === st)], from, to, own);
  const extendBase = (D: GenTrip, depot: number): boolean => {
    const T = D.from;
    const dep = D.stops[0].dep;
    const options: { block: Block; L: Trip; tail: Trip[]; tA: number }[] = [];
    for (const block of reuse!.blocks) {
      if (block.end.kind !== 'depot' || block.end.depot !== depot || reused.has(block.id)) continue;
      const live = block.trips.map(id => trips[id]).filter(t => !t.cancelled);
      let at = live.length - 1;
      while (at >= 0 && (live[at].kind === 'wd' || live[at].kind === 'empty')) at--;
      if (at < 0) continue;
      const L = live[at];
      const tail = live.slice(at + 1);
      const tA = L.stops.at(-1)!.arr;
      // still to come, close enough not to stand at the origin for long
      if (tA > dep || dep - tA > MAX_LAYOVER || tA < reuse!.now + 120 || L.overlay) continue;
      if (tail.some(t => t.stops[0].dep < reuse!.now + 120)) continue;
      if (!reuse!.canExtend(block.id, L.id)) continue;
      options.push({ block, L, tail, tA });
    }
    options.sort((a, b) => b.tA - a.tA);
    for (const { block, L, tail, tA } of options) {
      const P = L.to;
      // it stands at P no longer than the base plan already had it there
      const leave = (tail[0]?.stops[0].dep ?? tA + minTurn(P)) + 600;
      for (const t of tail) t.cancelled = true;
      let move: GenTrip | undefined;
      let ok: boolean;
      // It stands at P until it leaves: P must still have the place, and an
      // intermediate turnback holds it no longer than its turnback limit.
      const stand = (until: number, turning: boolean) => placeFree(P, tA, until, block.id)
        && (!turning || (!intermediate(P) || until <= tA + minTurn(P) + 450) && orderOk(P, tA, until, block.id));
      if (P === T) {
        ok = L.dir !== D.dir && !!turnbackAt(topo,T,L.dir) && tA + minTurn(T) <= dep && dep <= leave && stand(dep, true)
          && frontTurnClear(ctx, allForGaps(), L, dep, new Set([L.id, D.id]));
      } else {
        const dir: TrackDir = topo.stations[T].chain < topo.stations[P].chain ? 'UP' : 'DN';
        const mt = dir === D.dir ? 0 : minTurn(T);
        const turnAtP = dir === L.dir ? 30 : minTurn(P);
        const probe = buildStops(ctx, dir, P, T, 0, true, factorAt);
        const latest = dep - mt - probe.at(-1)!.arr;
        const physical = (dir===L.dir || !!turnbackAt(topo,P,L.dir)) && (dir===D.dir || !!turnbackAt(topo,T,dir));
        const st = !physical || latest < tA + turnAtP ? null : fitBefore(dir, latest, t0 => buildStops(ctx, dir, P, T, t0, true, factorAt), dir === D.dir ? D : undefined,
          stops => stops[0].dep >= tA + turnAtP && stops[0].dep <= leave && stops.at(-1)!.arr <= dep - mt + 1e-6 && outerQuiet(stops)
            && (dir !== D.dir || !intermediate(T) || stops.at(-1)!.arr >= dep - THROUGH_WAIT)
            && (dir !== L.dir || !intermediate(P) || stops[0].dep <= tA + THROUGH_WAIT)
            && stand(stops[0].dep, dir !== L.dir)
            && (dir === L.dir || frontTurnClear(ctx, allForGaps(), L, stops[0].dep, new Set([L.id])))
            && (dir === D.dir || frontTurnClear(ctx, allForGaps(), { dir, to: T, stops }, dep, new Set([D.id]))));
        ok = !!st;
        if (st) move = addTo(trips, dir, 'extra', P, T, st, true, overlay);
      }
      if (!ok) { for (const t of tail) delete t.cancelled; continue; }
      for (const t of tail) cancelTrip(t, `加开：车底延长运用，改担任${STATIONS[T].name}始发加开车次`);
      extOcc.push({ st: P, from: tA, to: (move ?? D).stops[0].dep, block: block.id });
      if (move) { move.prev = L.id; move.next = D.id; D.prev = move.id; }
      else D.prev = L.id;
      reused.add(block.id);
      reuse!.extended.push({ block: block.id, last: L.id, trips: [(move ?? D).id], tail: tail.map(t => t.id), end: block.end });
      return true;
    }
    return false;
  };

  // ---- sources
  const queue = sources.sort((a, b) => a.stops[0].dep - b.stops[0].dep);
  /**
   * An added-service train that cannot be brought out of the depot between the other
   * trains (peak headway) does not run its first trip; the train is brought out for the
   * next trip of its chain instead.
   */
  const dropSource = (D: GenTrip, reason = '加开：高峰间隔内无出段时隙') => {
    cancelTrip(D, reason);
    if (D.next !== undefined) {
      const N = trips[D.next];
      N.prev = undefined;
      D.next = undefined;
      const i = queue.findIndex((x) => x.stops[0].dep > N.stops[0].dep);
      queue.splice(i < 0 ? queue.length : i, 0, N);
    } else if (sinks.includes(D)) sinks.splice(sinks.indexOf(D), 1);
  };
  /** single platform turnback (广兰路): no other train turning there while one
   *  stands over [arr, dep] — a turn arriving in the 300 s before may still stand */
  const singlePlace = (T: number) => TERMINAL_CAP[T] === 1;
  const platformFree = (T: number, arr: number, dep: number) => !singlePlace(T)
    || !allForGaps().some((t) => !t.cancelled && t.to === T
      && t.stops[t.stops.length - 1].arr > arr - 300 && t.stops[t.stops.length - 1].arr < dep + MIN_HEADWAY);
  /** a positioning move from `depot` can turn at T before `dep` without crowding its platform */
  const turnPlaceFits = (T: number, towardDir: TrackDir, depot: number, dep: number) => {
    if (!singlePlace(T)) return true;
    const ex = exitStation(topo, depot, towardDir);
    const run = buildStops(ctx, towardDir, ex, T, 0, false, 1).at(-1)!.arr;
    const latest = dep - minTurn(T) - 60 - run;
    return fitBefore(towardDir, placeBefore(ex, towardDir, latest), (t0) => buildStops(ctx, towardDir, ex, T, t0, false, 1), undefined,
      (stops) => stops.at(-1)!.arr >= latest - 300 && platformFree(T, stops.at(-1)!.arr, dep)) !== null;
  };
  /** a move from `depot` running straight into D's departure fits between the other trains */
  const farFits = (T: number, D: GenTrip, depot: number) => {
    const ex = exitStation(topo, depot, D.dir);
    const dep = D.stops[0].dep;
    const run = buildStops(ctx, D.dir, ex, T, 0, true, factorAt).at(-1)!.arr;
    return fitBefore(D.dir, dep - run, (t0) => buildStops(ctx, D.dir, ex, T, t0, true, factorAt), D,
      (stops) => stops.at(-1)!.arr <= dep + 1e-6 && stops.at(-1)!.arr >= dep - THROUGH_WAIT) !== null;
  };
  /** nearest depot whose trains reach T already travelling `dir` */
  const farDepot = (T: number, dir: TrackDir): number | undefined => {
    const c = topo.stations[T].chain;
    return topo.depots.map((_, i) => i)
      .filter((i) => (dir === 'UP' ? topo.depots[i].junctionChain > c : topo.depots[i].junctionChain < c))
      .sort((i, j) => Math.abs(topo.depots[i].junctionChain - c) - Math.abs(topo.depots[j].junctionChain - c))[0];
  };
  // Added service ordered during the day: a train can leave the yard from now on.
  // A trip it cannot reach in time is dropped; the train comes out for the next.
  const now = reuse?.now ?? -Infinity;
  const inventoryFits = (depot: number, departure: number) => {
    if (!overlay || !reuse) return true;
    // (a duty already out has drawn its car; a finished one has returned it)
    const events: { time: number; delta: number }[] = depotMoves(reuse.blocks, trips)
      .filter(m => m.depot === depot && !reuse.stock?.done.includes(m.block) && !(m.delta < 0 && reuse.stock?.departed.includes(m.block)));
    for (const exit of exitsPlanned) if (exit.depot === depot) events.push({ time: exit.at, delta: -1 });
    events.push({ time: departure, delta: -1 });
    sortDepotMoves(events);
    let balance = reuse.stock?.levels[depot] ?? topo.depots[depot].capacity;
    for (const event of events) {
      if (reuse.stock && event.time < reuse.stock.at) continue;
      balance += event.delta; if (balance < 0) return false;
    }
    return true;
  };
  /** departures of trains brought into place by a positioning move, per station */
  const positioned = new Map<number, number[]>();
  // A yard can send out no more trains before the morning returns than it
  // holds. Its earliest exits past that (while the line still has room for a
  // longer move) come from the next nearest yard with room instead.
  const unsupplied = new Set<number>();
  // Stable starts consume a real overnight place; continued feeders do not draw
  // a second car. Only independent yard departures participate in redirection.
  const sourceDepot = (trip: GenTrip) => supply?.feeders.get(trip.id)?.depot
    ?? sourceDepots?.get(trip.id) ?? depotIndex(topo, TERMINAL_DEPOT[trip.from]);
  const redirect = new Map<number, number>();
  const redirectMoves = new Map<number, DepotMove>();
  if (!overlay && shift) {
    const left = { ...stabling };
    const byDepot = topo.depots.map(() => [] as GenTrip[]);
    for (const D of queue) {
      const T = D.from, dep = D.stops[0].dep;
      if (dep >= OPENING.stockUntil) break;
      if (D.prev !== undefined || supply?.stable.has(D.id) || supply?.continuations.has(D.id)) continue;
      if ((dep <= firstDepFrom(T) + 1500 || D.kind === 'small') && (left[T] ?? 0) > 0) { left[T]--; continue; }
      const depot = sourceDepot(D);
      if (depot < 0) continue; // The source loop retains it as an unassigned request.
      byDepot[depot].push(D);
    }
    const spare = topo.depots.map((dp, i) => (ctx.initialStock?.[i] ?? dp.capacity) - (stock?.[i] ?? byDepot[i].length));
    shift.forEach((n, d) => {
      // Redirect after opening: sending a BZL/LYD train to the airport before
      // 06:00 would cross GLL's occupied DN platform. Actual yardNeed, rather
      // than the raw source count, includes returns and far-side suppliers.
      for (const D of byDepot[d].filter(D => !supply?.feeders.has(D.id) && D.stops[0].dep >= OPENING.redirectFrom).slice(0, n)) {
        const c = topo.stations[D.from].chain;
        const alt = topo.depots.map((_, i) => i).filter((i) => i !== d && shift[i] === 0 && spare[i] > 0)
          .sort((i, j) => Math.abs(topo.depots[i].junctionChain - c) - Math.abs(topo.depots[j].junctionChain - c))[0];
        if (alt === undefined) break;
        // An alternative source is usable only with a complete fitted feeder.
        // Never force a long insertion through occupied service slots and then
        // ask the bounded clock solver to conceal an impossible stock move.
        const dir: TrackDir = ahead('DN', topo.depots[alt].junctionChain, c) ? 'DN' : 'UP';
        const from = exitStation(topo, alt, dir), mt = dir === D.dir ? 0 : minTurn(D.from);
        if (dir !== D.dir && !turnbackAt(topo, D.from, dir)) continue;
        if (from !== D.from) {
          const run = buildStops(ctx, dir, from, D.from, 0, true, factorAt).at(-1)!.arr;
          const dep = D.stops[0].dep;
          const stops = fitBefore(dir, dep - mt - run, t => buildStops(ctx, dir, from, D.from, t, true, factorAt), dir === D.dir ? D : undefined,
            stops => stops.at(-1)!.arr <= dep - mt + 1e-6
              && stops.at(-1)!.arr >= dep - mt - (intermediate(D.from) ? 450 : MAX_LAYOVER)
              && frontTurnClear(ctx, allForGaps(), {dir,to:D.from,stops}, dep, new Set([D.id]))
              && (dir === D.dir || placeFree(D.from, stops.at(-1)!.arr, dep, -1)));
          if (!stops) continue; // Keep the original source; report its stock shortage.
          redirectMoves.set(D.id, {depot:alt,dir,from,to:D.from,stops,revenue:true});
        }
        redirect.set(D.id, alt);
        spare[alt]--;
      }
    });
  }
  const triedDepots = new Map<number, Set<number>>();
  const triedOrigins = new Map<number, Set<number>>();
  const extendOrigin = (D: GenTrip) => {
    const tried=triedOrigins.get(D.id)??new Set<number>();
    tried.add(D.from);triedOrigins.set(D.id,tried);
    const step=D.dir==='DN'?-1:1, incoming=D.dir==='DN'?'UP':'DN';
    for(let station=D.from+step;station>=0&&station<topo.stations.length;station+=step) {
      if(tried.has(station)||turnbackAt(topo,station,incoming)?.kind!=='rear') continue;
      tried.add(station);
      let at=D.stops[0].dep;
      let stops=buildStops(ctx,D.dir,station,D.to,at,true,factorAt);
      for(let n=0;n<8;n++) {
        const error=stops.find(s=>s.st===D.from)!.dep-D.stops[0].dep;
        at-=error;stops=buildStops(ctx,D.dir,station,D.to,at,true,factorAt);
        if(Math.abs(error)<.001) break;
      }
      const k=stops.findIndex(s=>s.st===D.from);
      const extended=[...stops.slice(0,k),{...D.stops[0],arr:stops[k].arr},...D.stops.slice(1)];
      if(!new DepIndex(allForGaps().filter(t=>t!==D)).clear(extended,D.dir)) continue;
      D.from=station;D.stops=extended;
      depIndexN=movementCount=-1;triedDepots.delete(D.id);
      return true;
    }
    return false;
  };
  for (let qi = 0; qi < queue.length; qi++) {
    const D = queue[qi];
    if (D.prev !== undefined) continue;
    const T = D.from;
    const dep = D.stops[0].dep;
    if (supply?.stable.has(D.id)) {
      if (stabling[T] > 0) stabling[T]--;
      startOf.set(D.id, { kind: 'stable', station: T, berth: supply.stable.get(D.id)! });
      continue;
    }
    const prepared = redirectMoves.get(D.id) ?? supply?.feeders.get(D.id);
    if (prepared) {
      const feeder = addTo(trips, prepared.dir, prepared.revenue ? 'ins' : 'empty', prepared.from, T, prepared.stops, prepared.revenue);
      feeder.next = D.id;
      D.prev = feeder.id;
      const previous = supply?.continuations.get(D.id);
      if (previous !== undefined) {
        feeder.prev = previous;
        trips[previous].next = feeder.id;
      } else startOf.set(feeder.id, { kind: 'depot', depot: prepared.depot, time: 0 });
      continue;
    }
    let depot = depotIndex(topo, TERMINAL_DEPOT[T]);
    if (depot < 0) depot = sourceDepot(D);
    if (!overlay && depot < 0) {
      // Keep the service request visible to UNASSIGNED validation; never
      // fabricate a stable car or index a nonexistent yard at runtime.
      unsupplied.add(D.id);
      continue;
    }
    let early = !overlay && (dep <= firstDepFrom(T) + 1500 || D.kind === 'small');
    if (early && (stabling[T] ?? 0) > 0) {
      stabling[T]--;
      startOf.set(D.id, { kind: 'stable', station: T });
      continue;
    }
    if (overlay && reuse && extendBase(D, depot)) continue;
    if (overlay) {
      const unplacedSurplus = (d: number) => Math.max(0, -(reuse?.returnShift?.[d] ?? 0)
        - [...startOf.values()].filter(start => start.kind === 'depot' && start.depot === d).length);
      const candidates = topo.depots.map((_, d) => d).sort((a, b) =>
        unplacedSurplus(b) - unplacedSurplus(a)
        || Math.abs(topo.depots[a].junctionChain - topo.stations[T].chain) - Math.abs(topo.depots[b].junctionChain - topo.stations[T].chain));
      const available = candidates.find(d => {
        if (triedDepots.get(D.id)?.has(d)) return false;
        const dir: TrackDir = topo.stations[T].chain < topo.depots[d].junctionChain ? 'UP' : 'DN';
        const from = exitStation(topo, d, dir);
        const start = dep - (dir === D.dir ? 0 : minTurn(T)) - buildStops(ctx, dir, from, T, dep, false, 1).at(-1)!.arr + dep;
        return inventoryFits(d, depotStartTime(ctx, d, { dir, stops: [{ st: from, arr: start, dep: start, stop: true }] }));
      });
      if (available === undefined) {
        if(extendOrigin(D)) {qi--;continue;}
        dropSource(D, triedDepots.has(D.id) ? '加开：通知时间或沿途进路不足，后续班次继续尝试' : '加开：各段均无可用库存'); continue;
      }
      depot = available;
    }
    const alt = redirect.get(D.id);
    if (alt !== undefined) { depot = alt; early = true; }
    let towardDir: TrackDir = topo.stations[T].chain < topo.depots[depot].junctionChain ? 'UP' : 'DN';
    let farMove = false;
    if (!overlay && towardDir !== D.dir && !turnPlaceFits(T, towardDir, depot, dep)) {
      // a single platform turnback with no room for a positioning move to turn
      // in: come from the depot on the other side, arriving already facing D.dir
      const far = farDepot(T, D.dir);
      // (in service, stopping like the trains around it, straight into D)
      if (far !== undefined && farFits(T, D, far)) { depot = far; towardDir = D.dir; early = false; farMove = true; }
    }
    const ex = exitStation(topo, depot, towardDir);
    if (ex === T) {
      if (overlay && (depotStartTime(ctx, depot, D) < now || !exitClear(depot,depotStartTime(ctx,depot,D),D))) {
        const tried = triedDepots.get(D.id) ?? new Set<number>(); tried.add(depot); triedDepots.set(D.id, tried); qi--; continue;
      }
      startOf.set(D.id, { kind: 'depot', depot, time: 0 });
      if (overlay) exitsPlanned.push({ depot, at: depotStartTime(ctx, depot, D),clear:outboundWindow(ctx,depot,D)[1] });
      continue;
    }
    const mt = towardDir === D.dir ? 0 : minTurn(T);
    if (early) {
      // non-revenue positioning move before service
      const probe = buildStops(ctx, towardDir, ex, T, 0, false, 1);
      const run = probe[probe.length - 1].arr;
      // a single turnback place (广兰路): not in before the previous positioned train has left it
      const single = (TERMINAL_CAP[T] ?? topo.stations[T].turnbackBerths.length) === 1;
      const before = single ? Math.max(-Infinity, ...(positioned.get(T) ?? []).filter((x) => x <= dep)) : -Infinity;
      const st = fitBefore(towardDir, placeBefore(ex, towardDir, dep - mt - (towardDir === D.dir ? 0 : 60) - run), (t0) => buildStops(ctx, towardDir, ex, T, t0, false, 1), towardDir === D.dir ? D : undefined,
        (stops) => stops.at(-1)!.arr >= before)
        ?? fitBefore(towardDir, placeBefore(ex, towardDir, dep - mt - (towardDir === D.dir ? 0 : 60) - run), (t0) => buildStops(ctx, towardDir, ex, T, t0, false, 1), towardDir === D.dir ? D : undefined)
        ?? buildStops(ctx, towardDir, ex, T, dep - mt - (towardDir === D.dir ? 0 : 60) - run, false, 1);
      positioned.set(T, [...(positioned.get(T) ?? []), dep]);
      st[0].stop = false;
      if (towardDir === D.dir) st[st.length-1].stop = false;
      const e = addTo(trips, towardDir, 'empty', ex, T, st, false, overlay);
      e.next = D.id;
      D.prev = e.id;
      startOf.set(e.id, { kind: 'depot', depot, time: 0 });
    } else {
      const f = factorAt;
      const probe = buildStops(ctx, towardDir, ex, T, 0, true, f);
      const run = probe[probe.length - 1].arr;
      let latest = dep - mt - run;
      for (let k = 0; k < 8; k++) {
        const error = buildStops(ctx, towardDir, ex, T, latest, true, f).at(-1)!.arr - (dep - mt);
        latest -= error;
        if (Math.abs(error) < .001) break;
      }
      // Dwells depend on the time of day, so the run measured from 0 is only
      // an estimate: the arrival itself must leave the declared turnback.
      const turnOk = (stops: PlanStop[]) => stops.at(-1)!.arr <= dep - mt + 1e-6;
      const exitAt = (stops: PlanStop[]) => depotStartTime(ctx, depot, { stops } as Trip);
      const platformClear = (stops:PlanStop[]) => {
        if(!overlay || !reuse) return true;
        const turn=towardDir!==D.dir?turnbackAt(topo,T,towardDir):undefined;
        return storedPlatformsClear(topo,{trips,blocks:reuse.blocks} as Plan,{dir:towardDir,to:T,stops},turn?.kind==='rear'?turn.berths[0]:undefined);
      };
      // (an added train searches from the latest arrival: arriving earlier
      // only lengthens a front turn across the opposite platform)
      let st = fitBefore(towardDir, overlay || farMove ? latest : Math.min(latest, placeBefore(ex, towardDir, latest)), (t0) => buildStops(ctx, towardDir, ex, T, t0, true, f), (farMove || overlay && towardDir === D.dir) ? D : undefined,
        stops => turnOk(stops) && platformClear(stops) && outerQuiet(stops) && frontTurnClear(ctx, allForGaps(), { dir: towardDir, to: T, stops }, dep, new Set([D.id]))
          && (!overlay || exitClear(depot, exitAt(stops),{dir:towardDir,stops}) && inventoryFits(depot, exitAt(stops))) && exitAt(stops) >= now
          // (straight through into D: no standing on the through platform)
          && (!farMove || stops.at(-1)!.arr >= dep - THROUGH_WAIT)
          && (!overlay || (towardDir === D.dir || placeFree(T, stops.at(-1)!.arr, dep, -1))
            && stops.at(-1)!.arr >= dep - mt - (towardDir === D.dir ? THROUGH_WAIT : (intermediate(T) ? 450 : MAX_LAYOVER))));
      let feederRevenue = true;
      if (!st && overlay) {
        const emptyRun = buildStops(ctx, towardDir, ex, T, dep, false, 1).at(-1)!.arr - dep;
        st = fitBefore(towardDir, dep - mt - emptyRun, t0 => buildStops(ctx, towardDir, ex, T, t0, false, 1), towardDir === D.dir ? D : undefined,
          stops => turnOk(stops) && platformClear(stops) && exitAt(stops) >= now && exitClear(depot, exitAt(stops),{dir:towardDir,stops}) && inventoryFits(depot, exitAt(stops))
            && (towardDir === D.dir || placeFree(T, stops.at(-1)!.arr, dep, -1))
            && stops.at(-1)!.arr >= dep-mt-(intermediate(T) ? 450 : MAX_LAYOVER)
            && frontTurnClear(ctx, allForGaps(), {dir:towardDir,to:T,stops}, dep, new Set([D.id])));
        feederRevenue = false;
      }
      if (st && overlay) exitsPlanned.push({ depot, at: exitAt(st),clear:outboundWindow(ctx,depot,{dir:towardDir,stops:st})[1] });
      if (!st && overlay) {
        const tried = triedDepots.get(D.id) ?? new Set<number>(); tried.add(depot); triedDepots.set(D.id, tried); qi--;
        continue;
      }
      if (!st) {
        let t0 = placeBefore(ex, towardDir, latest);
        st = buildStops(ctx, towardDir, ex, T, t0, true, f);
        while (!turnOk(st)) { t0 -= Math.ceil(st.at(-1)!.arr - (dep - mt)); st = buildStops(ctx, towardDir, ex, T, t0, true, f); }
      }
      if (overlay && towardDir === D.dir) st.at(-1)!.stop = false;
      const ins = addTo(trips, towardDir, overlay ? 'extra' : 'ins', ex, T, st, feederRevenue, overlay);
      ins.next = D.id;
      D.prev = ins.id;
      startOf.set(ins.id, { kind: 'depot', depot, time: 0 });
      if(overlay && towardDir!==D.dir) extOcc.push({st:T,from:st.at(-1)!.arr,to:dep,block:-D.id-2});
    }
  }
  for (const place of nightPlaces.filter(place => place.kind === 'feeder')) {
    const opening = Math.min(...pool.filter(trip => trip.revenue && trip.dir === place.departure)
      .flatMap(trip => trip.stops.filter(stop => stop.st === place.station).map(stop => stop.arr)));
    const candidates = [...startOf.entries()].filter(([, start]) => start.kind === 'depot')
      .map(([id]) => trips[id]).filter(head => head.next !== undefined && !pool.includes(head)
        && head.dir === place.departure && (head.dir === 'DN' ? head.from >= place.station && head.to > place.station : head.from <= place.station && head.to < place.station))
      .sort((a, b) => trips[a.next!].stops[0].dep - trips[b.next!].stops[0].dep);
    for (const head of candidates) {
      const next = trips[head.next!];
      const latest = next.stops[0].dep - (head.dir === next.dir ? 0 : minTurn(head.to)) - 10;
      let at = latest - buildStops(ctx, head.dir, place.station, head.to, 0, true, factorAt).at(-1)!.arr;
      for (let i = 0; i < 8; i++) at -= buildStops(ctx, head.dir, place.station, head.to, at, true, factorAt).at(-1)!.arr - latest;
      const stops = buildStops(ctx, head.dir, place.station, head.to, at, true, factorAt);
      // The middle track joins beyond this station's platform. Start boarding
      // at the next call, without an impossible route back to this platform.
      stops[0].stop = false;
      stops[0].noBoard = true;
      if (at < opening || !new DepIndex(allForGaps().filter(trip => trip !== head && trip !== next)).clear(stops, head.dir)) continue;
      Object.assign(head, { from: place.station, stops, revenue: true, kind: 'ins' });
      startOf.set(head.id, { kind: 'stable', station: place.station, berth: place.berth });
      depIndexN = movementCount = -1;
      break;
    }
  }
  // Positioning moves are fitted one departure at a time and can reach an end
  // terminal out of order. Every train there leaves by the one departure
  // platform, in the order it arrived (a train standing on it for a later
  // departure blocks the earlier one), so pair turns first in, first out.
  for (const T of [0, topo.stations.length - 1]) {
    // (the hot standby stands aside in its own track)
    const turns = trips.filter((a) => a.overlay === overlay && !a.cancelled && !a.standby && a.to === T && a.next !== undefined && trips[a.next].from === T && trips[a.next].dir !== a.dir);
    if (turns.length < 2) continue;
    const deps = turns.map((a) => trips[a.next!]).sort((x, y) => x.stops[0].dep - y.stops[0].dep);
    turns.sort((x, y) => x.stops[x.stops.length - 1].arr - y.stops[y.stops.length - 1].arr)
      .forEach((a, i) => { a.next = deps[i].id; deps[i].prev = a.id; });
  }
  // ---- sinks
  // overnight stabling at terminal tails goes to the LAST arrivals, so that
  // earlier trains can still use the tails to turn back towards the depot
  const lastArr = (t: GenTrip) => t.stops[t.stops.length - 1].arr;
  if (overlay) {
    const used = new Set<number>();
    for (const place of nightPlaces.slice().reverse()) {
      const berth = topo.berths[place.arrivalBerth], rail = topo.links[berth.link];
      const dir: TrackDir = (rail.chainB-rail.chainA)*berth.dir > 0 ? 'DN' : 'UP';
      const candidate = sinks.filter(A => !used.has(A.id) && A.next === undefined && !A.cancelled
        && (dir === 'DN' ? A.to < place.station : A.to > place.station))
        .sort((a,b) => lastArr(b)-lastArr(a))[0];
      if (!candidate) continue;
      const turn = candidate.dir === dir ? 30 : minTurn(candidate.to);
      const stops = fitAfter(dir,lastArr(candidate)+turn,t0 => buildStops(ctx,dir,candidate.to,place.station,t0,false,1),
        stops => placeFree(candidate.to,lastArr(candidate),stops[0].dep,-1));
      if (!stops) continue;
      const move = addTo(trips,dir,'empty',candidate.to,place.station,stops,false,overlay);
      candidate.next = move.id; move.prev = candidate.id;
      endOf.set(move.id,{kind:'stable',station:place.station,berth:place.arrivalBerth});
      used.add(candidate.id);
    }
  }
  for (const A of sinks.slice().sort((a, b) => lastArr(b) - lastArr(a))) {
    const T = A.to;
    if (!overlay && A.revenue && lastArr(A) >= lastDepFrom(T) - 60 && (stablingNight[T] ?? 0) > 0) {
      stablingNight[T]--;
      // Last DN arrival stays on the side platform; the preceding arrival
      // moves into the middle track. No west-end empty positioning (D73).
      const places = nightPlaces.filter(place => place.station === T);
      endOf.set(A.id, { kind: 'stable', station: T, berth: places[stablingNight[T]].arrivalBerth });
    }
  }
  const retainedHomes = !overlay ? allocateDepotHomes(ctx, trips, pool, sinks.filter(A => A.next === undefined && !endOf.has(A.id)),
    startOf, endOf, allForGaps, factorAt) : new Map<number, number>();
  /**
   * An added train that cannot get back to the depot between the trains of
   * the peak build-up takes over a base duty whose train has not yet left
   * the depot (加开车底转入基本图运用, D47): it turns back at, or runs on
   * to, that duty's first origin. The base train stays in the depot; its
   * yard exit is cancelled. The duty's own trips keep their times.
   */
  const takenFrom = new Map<number, { block: Block; from: number }>();
  const rootOf = (trip: GenTrip) => {
    let head = trip;
    while (head.prev !== undefined) head = trips[head.prev];
    return head;
  };
  // Return quotas belong to the whole operating day, not to individual cars.
  // A cross-yard return consumes that yard's deficit; the other sink may
  // close the source yard later. Extensions inherit their displaced return.
  const returnQuota = topo.depots.map((_, depot) =>
    [...startOf.values()].filter(start => start.kind === 'depot' && start.depot === depot).length
      + (reuse?.returnShift?.[depot] ?? 0)
      + (reuse?.extended.filter(x => x.end.kind === 'depot' && x.end.depot === depot).length ?? 0));
  const reservedHomes = new Map<number, number>();
  const returnHome = (trip: GenTrip) => {
    const root = rootOf(trip).id;
    if (reservedHomes.has(root)) return reservedHomes.get(root)!;
    const home = topo.depots.filter(yard => returnQuota[yard.id] > 0)
      .sort((a,b) => Math.abs(a.junctionChain-topo.stations[trip.to].chain)-Math.abs(b.junctionChain-topo.stations[trip.to].chain))[0]?.id;
    return home;
  };
  const returned = (trip: GenTrip, depot: number) => {
    if (!overlay) return;
    returnQuota[depot]--;
    reservedHomes.set(rootOf(trip).id, depot);
  };
  const takeOver = (A: GenTrip): boolean => {
    if (!reuse) return false;
    const T = A.to;
    const arr = lastArr(A);
    const options: { B: Block; lead: GenTrip[]; D: GenTrip; k: number }[] = [];
    for (const B of reuse.blocks) {
      if (B.start.kind !== 'depot' || B.train !== undefined || B.relieved || reused.has(B.id)) continue;
      if (B.start.time < reuse.now + 120) continue;
      const k = B.trips.findIndex(id => !trips[id].cancelled && trips[id].revenue);
      if (k < 0) continue;
      const D = trips[B.trips[k]];
      if (!reuse.canExtend(B.id, D.id)) continue;
      const dep = D.stops[0].dep;
      if (!D.revenue || D.overlay || dep < arr + 30) continue;
      // Reachability and the complete path/headway search below decide the
      // distance: a short arbitrary station-count cutoff strands usable cars.
      options.push({ B, lead: B.trips.slice(0, k).map(id => trips[id]).filter(t => !t.cancelled), D, k });
    }
    options.sort((x, y) => x.D.stops[0].dep - y.D.stops[0].dep);
    for (const { B, lead, D, k } of options) {
      const P = D.from;
      const dep = D.stops[0].dep;
      const own = new Set([A.id, D.id, ...lead.map(t => t.id)]);
      const others = () => allForGaps().filter(t => !lead.includes(t as GenTrip));
      for (const t of lead) t.cancelled = true;
      let move: GenTrip | undefined;
      let ok: boolean;
      if (P === T) {
        ok = A.dir !== D.dir && !!turnbackAt(topo,T,A.dir) && arr + minTurn(T) <= dep && placeFree(T, arr, dep, B.id) && orderOk(T, arr, dep, B.id)
          && (!intermediate(T) || dep <= arr + minTurn(T) + 450)
          && frontTurnClear(ctx, others(), A, dep, own);
      } else {
        const dir: TrackDir = topo.stations[P].chain < topo.stations[T].chain ? 'UP' : 'DN';
        const mt = dir === D.dir ? 0 : minTurn(P);
        const turnAtT = dir === A.dir ? 30 : minTurn(T);
        const probe = buildStops(ctx, dir, T, P, 0, true, factorAt);
        const latest = dep - mt - probe.at(-1)!.arr;
        const physical = (dir===A.dir || !!turnbackAt(topo,T,A.dir)) && (dir===D.dir || !!turnbackAt(topo,P,dir));
        const st = !physical || latest < arr + turnAtT ? null : fitBefore(dir, latest, t0 => buildStops(ctx, dir, T, P, t0, true, factorAt), dir === D.dir ? D : undefined,
          stops => stops[0].dep >= arr + turnAtT && stops.at(-1)!.arr <= dep - mt + 1e-6 && outerQuiet(stops)
            && (dir !== D.dir || !intermediate(P) || stops.at(-1)!.arr >= dep - THROUGH_WAIT)
            && (dir !== A.dir || !intermediate(T) || stops[0].dep <= arr + THROUGH_WAIT)
            && placeFree(T, arr, stops[0].dep, B.id) && placeFree(P, stops.at(-1)!.arr, dep, B.id)
            && (dir === A.dir || (!intermediate(T) || stops[0].dep <= arr + minTurn(T) + 450) && orderOk(T, arr, stops[0].dep, B.id) && frontTurnClear(ctx, others(), A, stops[0].dep, own))
            && (dir === D.dir || orderOk(P, stops.at(-1)!.arr, dep, B.id) && frontTurnClear(ctx, others(), { dir, to: P, stops }, dep, own)));
        ok = !!st;
        if (st) move = addTo(trips, dir, 'extra', T, P, st, true, overlay);
      }
      if (!ok) { for (const t of lead) delete t.cancelled; continue; }
      for (const t of lead) cancelTrip(t, `加开：加开车底接续担任${STATIONS[P].name}始发车次，免出段`);
      if (move) { A.next = move.id; move.prev = A.id; }
      const last = move ?? A;
      extOcc.push({ st: T, from: arr, to: (move ?? D).stops[0].dep, block: B.id });
      reused.add(B.id);
      takenFrom.set(last.id, { block: B, from: k });
      endOf.set(last.id, B.end);
      returned(A, (B.start as {depot:number}).depot);
      return true;
    }
    return false;
  };
  const sinkQueue = sinks.sort((a, b) => lastArr(a) - lastArr(b));
  for (let qi = 0; qi < sinkQueue.length; qi++) {
    const A = sinkQueue[qi];
    if (endOf.has(A.id) || A.cancelled || A.next !== undefined) continue; // (queued twice: already sent on)
    // A surplus opening train from GLL (or 龙阳路, when GLL's middle track
    // is busy) can finish at SHR and enter BZL directly. Going all the way to
    // PXL and returning would insert a depot withdrawal into the AM core
    // slots and the outer alternation.
    const T = A.to;
    const planned = supply?.withdrawals.get(A.id);
    if (planned) {
      // Retaining the terminal does not discard its already fitted withdrawal
      // clocks/stops. Only clear the passenger flag after the terminal: a fresh
      // non-stop fit can reach the shared depot lead ahead of its reserved slot.
      const revenue = planned.revenue && !retainedHomes.has(A.id);
      const withdrawal = addTo(trips, planned.dir, revenue ? 'wd' : 'empty', T, planned.to, planned.stops, revenue);
      A.next = withdrawal.id;
      withdrawal.prev = A.id;
      endOf.set(withdrawal.id, { kind: 'depot', depot: planned.depot });
      continue;
    }
    const arr = lastArr(A);
    if (!overlay && !A.standby && (T === W || T === topo.stations.length - 1)) {
      // An end-terminal return can replace an already-positioned depot
      // feeder for the next duty. It arrives no earlier than that feeder,
      // so this reduces depot moves without adding terminal occupation.
      const next = pool.filter(D => D.from === T && D.dir !== A.dir && D.prev !== undefined
        && D.stops[0].dep >= arr + minTurn(T) && D.stops[0].dep <= arr + MAX_LAYOVER)
        .sort((a, b) => a.stops[0].dep - b.stops[0].dep).find(D => {
          const feeder = trips[D.prev!];
          return !pool.includes(feeder) && startOf.get(feeder.id)?.kind === 'depot' && (feeder.kind === 'ins' || feeder.kind === 'empty')
            && feeder.to === T && feeder.stops.at(-1)!.arr <= arr;
        });
      if (next) {
        const feeder = trips[next.prev!];
        feeder.block = UNUSED_DEPOT_MOVE;
        depIndexN = -1;
        movementCount = -1;
        feeder.next = undefined; startOf.delete(feeder.id);
        A.next = next.id; next.prev = A.id;
        continue;
      }
    }
    const depot = retainedHomes.get(A.id) ?? (overlay ? returnHome(A) ?? depotIndex(topo, TERMINAL_DEPOT[T]) : depotIndex(topo, TERMINAL_DEPOT[T]));
    // (an added service ends inside the day: its trains go back as ordinary withdrawals)
    const night = !overlay && arr >= lastDepFrom(T) - 60;
    if (night && T === 22 && A.dir === 'DN') {
      // 【假设】 earlier GLL closing services run on empty to CSD, avoiding
      // a westbound passenger departure after the official airport last train.
      const csd = depotIndex(topo, 'CSD'), en = entryStation(topo, csd, 'DN');
      const stops = fitAfter('DN', arr + 45, t0 => buildStops(ctx, 'DN', T, en, t0, false, 1))
        ?? buildStops(ctx, 'DN', T, en, arr + 45, false, 1);
      stops.at(-1)!.stop = false;
      const empty = addTo(trips, 'DN', 'empty', T, en, stops, false, overlay);
      A.next = empty.id; empty.prev = A.id;
      endOf.set(empty.id, { kind: 'depot', depot: csd });
      continue;
    }
    const awayDir: TrackDir = topo.stations[T].chain < topo.depots[depot].junctionChain ? 'DN' : 'UP';
    const en = entryStation(topo, depot, awayDir);
    if (en === T) { endOf.set(A.id, { kind: 'depot', depot }); returned(A, depot); continue; }
    const mt = minTurn(T);
    if (night) {
      const st = fitAfter(awayDir, arr + mt, (t0) => buildStops(ctx, awayDir, T, en, t0, false, 1)) ?? buildStops(ctx, awayDir, T, en, arr + mt, false, 1);
      st[st.length - 1].stop = false;
      const e = addTo(trips, awayDir, 'empty', T, en, st, false, overlay);
      A.next = e.id;
      e.prev = A.id;
      endOf.set(e.id, { kind: 'depot', depot });
    } else {
      const earliest = placeAfter(T, awayDir, arr + mt);
      // 【假设】 an airport train withdrawn to CSD has already set down
      // everyone; prefer an empty return so the evening arrival platform
      // is freed promptly, while retaining the full path/headway checks.
      let st = !overlay && T === topo.stations.length - 1 ? fitAfter(awayDir, arr + mt,
        t0 => buildStops(ctx, awayDir, T, en, t0, false, 1)) : null;
      // The retained working has already served its required terminal. Its
      // return stays empty even when stopping is needed to fit the UP stream.
      let withdrawalRevenue = !st && !retainedHomes.has(A.id);
      st ??= fitAfter(awayDir, overlay ? Math.max(arr+mt,earliest) : arr+mt, (t0) => buildStops(ctx, awayDir, T, en, t0, true, factorAt),
        stops => outerQuiet(stops) && frontTurnClear(ctx, allForGaps(), A, stops[0].dep, new Set([A.id]))
          && (!overlay || entryClear(depot, { to: en, stops } as unknown as Trip))
          // an intermediate turnback holds an added train no longer than its turnback limit
          && (!overlay || A.dir === awayDir || T === 0 || T === topo.stations.length - 1 || stops[0].dep <= arr + mt + 450)
          && (!overlay || A.dir === awayDir || orderOk(T, arr, stops[0].dep)));
      if (!st && !overlay) {
        // Passengers have already alighted at this terminal. If a stopping
        // withdrawal cannot fit, return empty using the existing pass times
        // instead of forcing another passenger trip into the core slots.
        st = fitAfter(awayDir, arr + mt, t0 => buildStops(ctx, awayDir, T, en, t0, false, 1),
          stops => outerQuiet(stops) && frontTurnClear(ctx, allForGaps(), A, stops[0].dep, new Set([A.id])));
        if (st) withdrawalRevenue = false;
      }
      if (!st && overlay) {
        // Empty withdrawals may stop to regulate behind the passenger
        // stream. Searching only an uninterrupted run falsely strands a
        // car when the peak begins while it is returning along the core.
        const regulate = (at: number) => {
          const stops = buildStops(ctx,awayDir,T,en,at,false,factorAt,()=>true);
          for (let n=0;n<300;n++) {
            const k = stops.findIndex(p => !pathClear([p],awayDir));
            if (k < 0) break;
            const prev = Math.max(0,k-1);
            stops[prev].dep += 10;
            for (let j=prev+1;j<stops.length;j++) {stops[j].arr+=10;stops[j].dep+=10;}
          }
          return stops;
        };
        st = fitAfter(awayDir,arr+mt,regulate,stops => entryClear(depot,{to:en,stops} as Trip)
          && (A.dir === awayDir || placeFree(T,arr,stops[0].dep,-1) && orderOk(T,arr,stops[0].dep))
          && stops[0].dep <= arr+mt+(intermediate(T)?450:MAX_LAYOVER)
          && frontTurnClear(ctx,allForGaps(),A,stops[0].dep,new Set([A.id])));
        if (st) withdrawalRevenue = false;
      }
      if (!st && overlay && takeOver(A)) continue;
      if (!st && overlay) {
        // a train that cannot turn back between the other trains (the single
        // tail track of an intermediate turnback in use) runs on in its own
        // direction, in service, to the next depot beyond the end of the added section
        const c = topo.stations[T].chain;
        const on = topo.depots.map((_, i) => i)
          .filter(i => i !== depot && returnQuota[i] > 0
            && (A.dir === 'DN' ? topo.depots[i].junctionChain > c : topo.depots[i].junctionChain < c))
          .sort((i, j) => Math.abs(topo.depots[i].junctionChain - c) - Math.abs(topo.depots[j].junctionChain - c))[0];
        const to = on === undefined ? T : entryStation(topo, on, A.dir);
        const others = new DepIndex(allForGaps().filter(t => t !== A));
        let s2: PlanStop[] | null = null;
        for (let w = STATIONS[T].dwell; to !== T && !s2 && w <= 60; w += 10) {
          const x = buildStops(ctx, A.dir, T, to, arr + w, true, factorAt);
          if (outerQuiet(x) && entryClear(on!, { to, stops: x } as unknown as Trip) && others.clear(x, A.dir)) s2 = x;
        }
        if (s2) {
          const wd = addTo(trips, A.dir, 'extra', T, to, s2, true, overlay);
          A.next = wd.id;
          wd.prev = A.id;
          endOf.set(wd.id, { kind: 'depot', depot: on! });
          returned(A, on!);
          continue;
        }
      }
      if (!st && overlay && A.prev !== undefined) {
        // an added-service train that cannot get back to the depot between the other trains
        // (peak headway) does not run its last trip: it goes back after the trip before
        const P = trips[A.prev];
        cancelTrip(A, '加开：高峰间隔内无回段时隙');
        A.prev = undefined;
        P.next = undefined;
        const i = sinkQueue.findIndex((x, k) => k > qi && lastArr(x) > lastArr(P));
        sinkQueue.splice(i < 0 ? sinkQueue.length : i, 0, P);
        continue;
      }
      if (!st && overlay) { dropArrival(A); continue; }
      st ??= buildStops(ctx, awayDir, T, en, placeAfter(T, awayDir, arr + mt), true, factorAt);
      if (overlay && A.dir !== awayDir) extOcc.push({ st: T, from: arr, to: st[0].dep, block: -1 });
      const wd = addTo(trips, awayDir, overlay ? 'extra' : 'wd', T, en, st, withdrawalRevenue, overlay);
      A.next = wd.id;
      wd.prev = A.id;
      endOf.set(wd.id, { kind: 'depot', depot });
      returned(A, depot);
    }
  }

  // ---- blocks
  /** the added train runs on into the base duty it took over */
  const takeRest = (cur: GenTrip, b: Block) => {
    const x = takenFrom.get(cur.id);
    if (!x) return false;
    const rest = x.block.trips.slice(x.from);
    reuse!.absorbed ??= [];
    reuse!.absorbed.push({ block: x.block.id, into: b.id, trips: rest, lead: x.block.trips.slice(0, x.from).filter(id => trips[id].cancelReason?.includes('免出段')), end: x.block.end });
    for (const id of rest) { trips[id].block = b.id; b.trips.push(id); }
    x.block.trips = x.block.trips.slice(0, x.from);
    b.end = x.block.end;
    return true;
  };
  const blocks: Block[] = [];
  const heads = trips.filter((t) => t.overlay === overlay && !t.cancelled && t.prev === undefined && t.block === -1 && !unsupplied.has(t.id));
  heads.sort((a, b) => a.stops[0].dep - b.stops[0].dep);
  for (const h of heads) {
    const b: Block = { id: blockBase + blocks.length, svc: '', start: startOf.get(h.id) ?? { kind: 'stable', station: h.from }, end: { kind: 'none' }, trips: [] };
    let cur: GenTrip | undefined = h;
    let guard = 0;
    while (cur && guard++ < 500) {
      cur.block = b.id;
      b.trips.push(cur.id);
      if (takeRest(cur, b)) break;
      if (cur.next === undefined) { b.end = endOf.get(cur.id) ?? { kind: 'none' }; break; }
      cur = trips[cur.next];
    }
    if (b.start.kind === 'depot') b.start.time = depotStartTime(ctx, b.start.depot, trips[b.trips[0]]);
    blocks.push(b);
  }
  for (const x of reuse?.extended ?? []) {
    const block = reuse!.blocks[x.block];
    let cur: GenTrip | undefined = trips[x.trips[0]];
    x.trips = [];
    while (cur) {
      cur.block = block.id;
      x.trips.push(cur.id);
      block.trips.push(cur.id);
      if (takeRest(cur, block)) break;
      if (cur.next === undefined) { block.end = endOf.get(cur.id) ?? { kind: 'none' }; break; }
      cur = trips[cur.next];
    }
  }
  spacePortalExits(ctx, blocks, trips, new Set(pool.map(t => t.id)));
  if (!overlay) relieveTerminals(ctx, blocks, trips, new Set(pool.map(t => t.id)));
  if (!overlay) fitOpeningFeeders(ctx, blocks, trips, new Set(pool.map(t => t.id)));
  if (!overlay) relieveTerminals(ctx, blocks, trips, new Set(pool.map(t => t.id)));
  if (!overlay) reuseTerminalReturns(ctx, blocks, trips, new Set(pool.map(t => t.id)), clocks);
  if (!overlay) reorderTerminalTurns(blocks, trips, [0, topo.stations.length - 1]);
  if (!overlay) {
    const requests = new Set(pool.map(trip => trip.id));
    for (const b of blocks) for (let i = 0; i + 1 < b.trips.length; i++) {
      const a = trips[b.trips[i]], d = trips[b.trips[i + 1]];
      if (!requests.has(a.id) || requests.has(d.id) || !a.revenue || !d.revenue || a.dir !== d.dir || a.to !== d.from) continue;
      // A short working running straight on as a carrying withdrawal is one
      // passenger train. Publish its final destination now, before freezing
      // service identities, instead of showing two trains fifty seconds apart.
      a.to = d.to; a.kind = d.kind;
      a.stops = [...a.stops.slice(0,-1), {...a.stops.at(-1)!,dep:d.stops[0].dep},...d.stops.slice(1)];
      a.next = d.next;
      if (d.next !== undefined) trips[d.next].prev = a.id;
      d.block = UNUSED_DEPOT_MOVE;
      b.trips.splice(i + 1,1); i--;
    }
  }
  void periods;
  return blocks;
}

/** Allocate daily homes during draft matching, without consulting validation
 * failures. Published services are frozen only after this allocation finishes. */
function allocateDepotHomes(ctx: PlanContext, trips: GenTrip[], services: GenTrip[], sinks: GenTrip[],
  starts: Map<number, Block['start']>, ends: Map<number, Block['end']>,
  movements: () => GenTrip[], factor: (t: number) => number) {
  const { topo } = ctx;
  const arrival = (trip: Trip) => trip.stops.at(-1)!.arr;
  const retainedHomes = new Map<number, number>();
  const rules: { depot: number; dir: TrackDir; station: number; berth?: number; after?: number; service?: { terminal: number; intervalMultiplier: number } }[] = OPERATIONS.depotReturns.map(rule => ({ depot: depotIndex(topo, rule.depot),
    dir: rule.dir, station: STATIONS.findIndex(st => st.id === rule.station),
    service: rule.service && { ...rule.service, terminal: STATIONS.findIndex(st => st.id === rule.service!.terminal) } }));
  // Snapshot the requested endpoint stream before selecting retirement homes.
  // Direct returns are preferred; retain a through working only when removing
  // it would exceed the local requested interval budget. This is a route
  // choice during matching, never a repair of a published/validated diagram.
  const coverage = new Map(rules.filter(rule => rule.service).map(rule => [rule.depot,
    services.filter(trip => trip.revenue && trip.dir === rule.dir && trip.to === rule.service!.terminal)
      .map(trip => ({ trip, at: arrival(trip) })).sort((a,b) => a.at - b.at)]));
  const needsThrough = (trip: GenTrip, rule: typeof rules[number]) => {
    if (!rule.service || trip.to !== rule.service.terminal || !turnbackAt(topo, trip.to, trip.dir)) return false;
    const requested = coverage.get(rule.depot)!;
    const current = requested.filter(call => call.trip !== trip && call.trip.to === rule.service!.terminal);
    const at = arrival(trip), before = current.filter(call => call.at < at).at(-1), after = current.find(call => call.at > at);
    if (!before || !after) return false;
    const span = requested.filter(call => call.at >= before.at && call.at <= after.at);
    const interval = Math.max(...span.slice(1).map((call,i) => call.at - span[i].at));
    return after.at - before.at > interval * rule.service.intervalMultiplier + .001;
  };
  for (const place of overnightPlaces(topo).filter(place => place.kind === 'origin' || place.kind === 'feeder')) {
    const berth = topo.berths[place.arrivalBerth], link = topo.links[berth.link];
    rules.push({ depot: rules.length, station: place.kind === 'feeder' ? place.station - 1 : place.station, berth: place.arrivalBerth, after: place.nightAfter,
      dir: (link.chainB - link.chainA) * berth.dir > 0 ? 'DN' : 'UP' });
  }
  const reachable = (trip: Trip, rule: typeof rules[number]) => trip.dir === rule.dir
    && (rule.berth === undefined || trip.stops.some(stop => stop.st === rule.station && stop.arr >= (rule.after ?? 0)))
    && (trip.dir === 'DN' ? trip.from < rule.station : trip.from > rule.station);
  // Reserve the actual cars supplying the fixed late trains. Their last
  // revenue destination and home belong to that fixed service's data.
  const special = new Map<number, number>();
  const fixedExits = topo.depots.map(() => 0), fixedReturns = topo.depots.map(() => 0);
  for (const run of ctx.fixedRuns ?? FIXED_LATE_TRAINS) {
    const origin = STATIONS.findIndex(st => st.id === run.from);
    const dir: TrackDir = STATIONS.findIndex(st => st.id === run.to) > origin ? 'DN' : 'UP';
    for (const departure of run.departures) {
      fixedReturns[depotIndex(topo, run.depotTo)]++;
      const candidate = sinks.filter(trip => !special.has(trip.id) && trip.dir !== dir
        && (trip.to === 0 || trip.to === topo.stations.length - 1)
        && (dir === 'DN' ? trip.to <= origin : trip.to >= origin)
        && arrival(trip) >= departure - MAX_LAYOVER
        && buildStops(ctx, dir, trip.to, origin, arrival(trip) + minTurn(trip.to), false, 1).at(-1)!.arr <= departure - 45)
        .sort((a, b) => arrival(b) - arrival(a))[0];
      if (candidate) special.set(candidate.id, depotIndex(topo, run.depotTo));
      else fixedExits[depotIndex(topo, run.depotFrom)]++;
    }
  }
  const returns = sinks.filter(trip => !special.has(trip.id));
  const quota = topo.depots.map((_, depot) => [...starts.values()].filter(start => start.kind === 'depot' && start.depot === depot).length);
  for (const depot of topo.depots) quota[depot.id] += fixedExits[depot.id] - fixedReturns[depot.id];

  for (const rule of rules.filter(rule => rule.berth !== undefined)) quota[rule.depot] = 1;

  // A yard with fewer reachable returns than exits cannot close its daily
  // account. Supply a draft positioning move from the nearest other yard;
  // revenue requests and their clocks stay intact. This is also needed when
  // mandatory fixed trains return more cars to a yard than it originally sent.
  const serviceIds = new Set(services.map(trip => trip.id));
  for (const rule of rules.filter(rule => rule.berth === undefined)) {
    let excess = quota[rule.depot] - returns.filter(trip => reachable(trip, rule)).length;
    if (excess <= 0) continue;
    const heads = [...starts.entries()].filter(([id, start]) => start.kind === 'depot'
      && start.depot === rule.depot && !serviceIds.has(id) && trips[id].next !== undefined)
      .map(([id]) => trips[id]).sort((a, b) => b.stops[0].dep - a.stops[0].dep);
    for (const head of heads) {
      if (excess <= 0) break;
      const next = trips[head.next!];
      const candidates = topo.depots.map((_, depot) => depot).filter(depot => depot !== rule.depot)
        .sort((a, b) => Number(quota[a] >= 0) - Number(quota[b] >= 0)
          || Math.abs(topo.depots[a].junctionChain - topo.stations[next.from].chain)
            - Math.abs(topo.depots[b].junctionChain - topo.stations[next.from].chain));
      for (const depot of candidates) {
        const dir: TrackDir = topo.stations[next.from].chain < topo.depots[depot].junctionChain ? 'UP' : 'DN';
        const from = exitStation(topo, depot, dir);
        const latest = next.stops[0].dep - (dir === next.dir ? 0 : minTurn(next.from)) - 10;
        const index = new DepIndex(movements().filter(trip => trip !== head && trip !== next));
        let fitted = false;
        for (const revenue of [true, false]) {
          let start = latest - buildStops(ctx, dir, from, next.from, 0, revenue, factor).at(-1)!.arr;
          for (let k = 0; k < 8; k++) start -= buildStops(ctx, dir, from, next.from, start, revenue, factor).at(-1)!.arr - latest;
          for (let offset = 0; offset <= 1200; offset += 5) {
            const stops = buildStops(ctx, dir, from, next.from, start - offset, revenue, factor);
            if (depotStartTime(ctx, depot, { dir, stops }) < OPENING.dayStart || !index.clear(stops, dir)) continue;
            if (!frontTurnClear(ctx, movements(), { dir, to: next.from, stops }, next.stops[0].dep, new Set([head.id, next.id]))) continue;
            Object.assign(head, { dir, from, stops, revenue, kind: revenue ? 'ins' : 'empty' });
            starts.set(head.id, { kind: 'depot', depot, time: 0 });
            fitted = true;
            break;
          }
          if (fitted) break;
        }
        if (fitted) { quota[rule.depot]--; quota[depot]++; excess--; break; }
      }
    }
  }
  // 【假设】 Distribute equivalent direct returns evenly through their
  // withdrawal stream. No day type, individual trip, or reference-bin rule.
  const total = quota.slice(), seen = rules.map(() => 0);
  const counts = new Map(rules.map(rule => [rule.depot, returns.filter(trip => reachable(trip, rule)).length]));
  const referenceTime = (trip: Trip) => {
    const portals = rules.filter(rule => reachable(trip, rule)).map(rule => trip.stops.find(stop => stop.st === rule.station)).filter(stop => stop !== undefined);
    return portals.length ? Math.min(...portals.map(stop => stop.arr)) : arrival(trip);
  };
  const ordered = returns.slice().sort((a, b) => referenceTime(a) - referenceTime(b));
  for (const trip of ordered) {
    const eligible = rules.filter(rule => reachable(trip, rule));
    for (const rule of eligible) seen[rule.depot]++;
    const deficit = (rule: typeof rules[number]) => {
      // Several overnight berths at one station share one retirement quota.
      // Treating each berth as a fresh single-car quota clusters its arrivals.
      const group = rule.berth === undefined ? [rule] : rules.filter(r => r.berth !== undefined && r.station === rule.station);
      const target = group.reduce((sum,r) => sum + total[r.depot],0);
      const left = group.reduce((sum,r) => sum + quota[r.depot],0);
      return target * seen[rule.depot] / counts.get(rule.depot)! - (target-left);
    };
    const home = eligible.filter(rule => quota[rule.depot] > 0).sort((a, b) => deficit(b) - deficit(a)
      || Math.abs(topo.stations[a.station].chain - topo.stations[trip.to].chain)
        - Math.abs(topo.stations[b.station].chain - topo.stations[trip.to].chain))[0];
    if (!home) continue; // An infeasible daily balance remains a validation error.
    quota[home.depot]--;
    if (needsThrough(trip, home)) {
      retainedHomes.set(trip.id, home.depot);
      continue; // Existing terminal withdrawal fitting supplies the empty return.
    }
    if (trip.stops.some(stop => stop.st === home.station)) trimRoute(trip, trip.from, home.station, 'wd');
    else {
      const stops = buildStops(ctx, trip.dir, trip.to, home.station, arrival(trip) + 45, true, factor);
      trip.to = home.station;
      trip.kind = 'wd';
      trip.stops = [...trip.stops.slice(0, -1), { ...trip.stops.at(-1)!, dep: stops[0].dep }, ...stops.slice(1)];
    }
    if (home.berth !== undefined && topo.berths[home.berth].station !== home.station) {
      const station = topo.berths[home.berth].station;
      const stops = buildStops(ctx, trip.dir, home.station, station, arrival(trip) + 30, false, 1);
      for (const stop of stops) stop.stop = false;
      const move = addTo(trips, trip.dir, 'empty', home.station, station, stops, false);
      trip.next = move.id; move.prev = trip.id;
      ends.set(move.id, { kind: 'stable', station, berth: home.berth });
    } else ends.set(trip.id, home.berth === undefined ? { kind: 'depot', depot: home.depot }
      : { kind: 'stable', station: home.station, berth: home.berth });
  }
  return retainedHomes;
}

/** A returning service replaces an earlier depot feeder for the same duty.
 * Run after feeder fitting/FIFO assignment as well: their order may change.
 * 【假设】 D79: keep the arriving train in service instead of a needless yard swap. */
function reuseTerminalReturns(ctx: PlanContext, blocks: Block[], trips: GenTrip[], fixed: Set<number>, clocks?: DiagramClocks) {
  if (clocks) for (const trip of trips) if (!clocks.original.has(trip.id)) clocks.original.set(trip.id, trip.stops[0].dep);
  const rejected: RejectedTurn[] = [];
  draftRejectedTurns.set(blocks, rejected);
  const ends = [0, ctx.topo.stations.length - 1, ...ctx.topo.depots.map(d => d.station)];
  for (let round = 0; round < blocks.length; round++) {
    let changed = false;
    for (const incoming of blocks) {
      if (incoming.end.kind !== 'depot' || !incoming.trips.length) continue;
      let index = incoming.trips.length - 1;
      while (index >= 0 && !(trips[incoming.trips[index]].revenue && ends.includes(trips[incoming.trips[index]].to))) index--;
      if (index < 0) continue;
      const arrival = trips[incoming.trips[index]], at = arrival.stops.at(-1)!.arr, terminal = arrival.to;
      if (arrival.standby) continue;
      const tail = incoming.trips.slice(index + 1).map(id => trips[id]);
      if (tail.length && (tail[0].from !== terminal || tail.some(t => fixed.has(t.id) || (t.kind !== 'wd' && t.kind !== 'empty')))) continue;
      const home = incoming.end.depot;
      const candidate = blocks.filter(b => b !== incoming && b.start.kind === 'depot' && b.start.depot === home)
        .map(block => {
          const first = trips[block.trips[0]];
          const feeder = !fixed.has(first.id) && ['ins', 'empty'].includes(first.kind) && first.to === terminal ? first : undefined;
          return { block, feeder, departure: feeder ? trips[block.trips[1]] : first,
            shift: undefined as { trip: GenTrip; stops: PlanStop[] } | undefined };
        })
        .filter(option => {
          const { block, feeder, departure } = option;
          if (!(departure && departure.from === terminal && departure.dir !== arrival.dir
          && (feeder ? feeder.stops.at(-1)!.arr <= at : ctx.topo.depots[(block.start as {depot:number}).depot].station === terminal)
          && departure.stops[0].dep >= at + minTurn(terminal) && departure.stops[0].dep <= at + MAX_LAYOVER
          && frontTurnClear(ctx, trips.filter(t => t.block !== UNUSED_DEPOT_MOVE), arrival, departure.stops[0].dep, new Set([...incoming.trips, ...block.trips]))
          && !terminalOverflows(ctx.topo, terminal, [...(terminalOccupancy({blocks,trips} as Plan).get(terminal) ?? []),
            {from:at,to:departure.stops[0].dep}]).length)) return false;
          // Test the proposed duty before linking it: its old return/feeder
          // cease to exist, but every other shared-lead move still reserves it.
          const continued = { ...incoming, end: block.end,
            trips: [...incoming.trips.slice(0, index + 1), ...block.trips.slice(feeder ? 1 : 0)] };
          const proposed = { trips, blocks: blocks.filter(b => b !== block).map(b => b === incoming ? continued : b) } as Plan;
          const berth = dutyTurnBerths(ctx.topo, proposed, continued, arrival, departure)[0];
          const conflicts = berth === undefined ? [] : depotMoves(proposed.blocks, trips, ctx).filter(move => move.block !== incoming.id
            && turnLeadConflict(ctx.topo, move, trips, arrival, departure, berth));
          if (conflicts.length && clocks) {
            const running = proposed.blocks.flatMap(b => b.trips.map(id => trips[id]));
            // Try the available physical routes first (dutyTurnBerths above),
            // then bounded whole-trip shifts before refusing this match.
            for (let amount = 1; amount <= MAX_DIAGRAM_SHIFT_S; amount++) for (const sign of [-1, 1]) {
              for (const trip of [arrival, departure]) {
                if (clocks.protected.has(trip.id)) continue;
                const stops = trip.stops, delta = amount * sign;
                if (Math.abs(stops[0].dep + delta - (clocks.original.get(trip.id) ?? stops[0].dep)) > MAX_DIAGRAM_SHIFT_S) continue;
                if (!headwayClear(running, trip, delta, MIN_HEADWAY)) continue;
                trip.stops = stops.map(stop => ({ ...stop, arr: stop.arr + delta, dep: stop.dep + delta }));
                const movements = depotMoves(proposed.blocks, trips, ctx);
                const occupancy = terminalOccupancy(proposed, ctx.topo);
                const holds = [...occupancy.values()].flat().filter(hold => hold.block === incoming.id
                  && (hold.arrival === trip.id || hold.departure === trip.id));
                const continuous = continued.trips.every((id, i) => {
                  const a = trips[id], d = trips[continued.trips[i + 1]];
                  return !d || a !== trip && d !== trip
                    || d.stops[0].dep >= a.stops.at(-1)!.arr + (a.dir === d.dir ? 0 : minTurn(a.to));
                });
                const clear = continuous && holds.every(hold => {
                  const a = trips[hold.arrival!], d = trips[hold.departure!], berth = hold.berths?.[0];
                  return hold.to >= hold.from + minTurn(a.to)
                    && frontTurnClear(ctx, running, a, hold.to, new Set(continued.trips))
                    && !terminalOverflows(ctx.topo, a.to, occupancy.get(a.to)!).length
                    && (berth === undefined || !movements.some(move => move.block !== incoming.id
                      && turnLeadConflict(ctx.topo, move, trips, a, d, berth)));
                });
                const shifted = trip.stops;
                trip.stops = stops;
                if (clear) { option.shift = { trip, stops: shifted }; return true; }
              }
            }
          }
          if (conflicts.length) rejected.push({ arrival, departure, conflicts: conflicts.map(move => trips[move.trip!]) });
          return !conflicts.length;
        })
        .sort((a, b) => a.departure.stops[0].dep - b.departure.stops[0].dep)[0];
      if (!candidate) continue;
      const { block, feeder, departure, shift } = candidate;
      if (shift) shift.trip.stops = shift.stops;
      for (const trip of [...tail, ...(feeder ? [feeder] : [])]) {
        trip.prev = undefined;
        trip.next = undefined;
        trip.block = UNUSED_DEPOT_MOVE;
      }
      arrival.next = departure.id;
      departure.prev = arrival.id;
      incoming.trips = [...incoming.trips.slice(0, index + 1), ...block.trips.slice(feeder ? 1 : 0)];
      incoming.end = block.end;
      blocks.splice(blocks.indexOf(block), 1);
      changed = true;
      break;
    }
    if (!changed) break;
  }
  for (const [id, block] of blocks.entries()) {
    block.id = id;
    for (const trip of block.trips) trips[trip].block = id;
  }
}

/** Depot feeder times can change after the initial FIFO matching. Reassign
 * the suffixes once more so later arrivals cannot delay an earlier turn. */
function reorderTerminalTurns(blocks: Block[], trips: GenTrip[], terminals: number[]) {
  const ends = new Map(blocks.map(b => [b.trips.at(-1)!, b.end]));
  const heads = blocks.map(b => b.trips[0]);
  for (const st of terminals) {
    const arrivals = trips.filter(t => !t.cancelled && !t.standby && t.to === st && t.next !== undefined
      && trips[t.next].from === st && trips[t.next].dir !== t.dir);
    const departures = arrivals.map(t => trips[t.next!]).sort((a, b) => a.stops[0].dep - b.stops[0].dep);
    arrivals.sort((a, b) => a.stops.at(-1)!.arr - b.stops.at(-1)!.arr);
    for (let i = 0; i < arrivals.length; i++) {
      arrivals[i].next = departures[i].id; departures[i].prev = arrivals[i].id;
    }
  }
  for (const [i, b] of blocks.entries()) {
    b.trips = [];
    let trip: GenTrip | undefined = trips[heads[i]];
    while (trip) {
      trip.block = b.id; b.trips.push(trip.id);
      if (trip.next === undefined) { b.end = ends.get(trip.id)!; break; }
      trip = trips[trip.next];
    }
  }
}

/** D73: long empty depot positioning must fit the calibrated stopping stream.
 * Search actual paths and terminal places; an approximate fallback from the
 * old, shorter running times can overtake service trains or fill a terminal. */
function fitOpeningFeeders(ctx: PlanContext, blocks: Block[], trips: GenTrip[], fixed: Set<number>) {
  const { topo } = ctx;
  const plan = { trips, blocks } as Plan;
  const factor = (t: number) => dwellFactorAt(ctx.dayType, t);
  const until = OPENING.feederUntil;
  const pending = new Set(blocks.filter(b => b.start.kind === 'depot' && b.trips.length > 1 && !fixed.has(b.trips[0])
    && trips[b.trips[0]].to === trips[b.trips[1]].from && trips[b.trips[0]].stops[0].dep < until).map(b => b.trips[0]));
  const ordered = [...blocks].sort((a, b) => (trips[a.trips[1]]?.stops[0].dep ?? 0) - (trips[b.trips[1]]?.stops[0].dep ?? 0));
  for (const b of ordered) {
    if (b.start.kind !== 'depot' || b.trips.length < 2) continue;
    const first = trips[b.trips[0]], next = trips[b.trips[1]];
    if (fixed.has(first.id) || first.to !== next.from || first.stops[0].dep >= until) continue;
    const target = next.from, departure = next.stops[0].dep;
    pending.delete(first.id);
    const others = trips.filter(t => t !== first && !t.cancelled && t.block !== UNUSED_DEPOT_MOVE && !pending.has(t.id));
    const index = new DepIndex(others.filter(t => t !== next));
    const occupied = (terminalOccupancy(plan).get(target) ?? []).filter(o => o.block !== b.id && !(pending.has(blocks[o.block].trips[0]) && trips[blocks[o.block].trips[0]].stops.at(-1)!.arr === o.from));
    const depots = topo.depots.map((_, d) => d).sort((a, z) =>
      Math.abs(topo.depots[a].junctionChain - topo.stations[target].chain) - Math.abs(topo.depots[z].junctionChain - topo.stations[target].chain));
    let fitted = false;
    for (const depot of depots) {
      if (b.start.kind === 'depot' && depot !== b.start.depot) continue;
      const dir: TrackDir = topo.stations[target].chain < topo.depots[depot].junctionChain ? 'UP' : 'DN';
      const origin = exitStation(topo, depot, dir);
      if (origin === target) continue;
      const reverse = dir !== next.dir, turn = reverse ? minTurn(target) : 0;
      for (const revenue of [true, false]) {
        const latest = departure - turn - (reverse ? 10 : 0);
        let start = latest - buildStops(ctx, dir, origin, target, 0, revenue, factor).at(-1)!.arr;
        for (let k = 0; k < 8; k++) {
          const error = buildStops(ctx, dir, origin, target, start, revenue, factor).at(-1)!.arr - latest;
          start -= error;
          if (Math.abs(error) < .001) break;
        }
        for (let offset = 0; offset <= (reverse ? 1200 : THROUGH_WAIT); offset += 5) {
          const stops = buildStops(ctx, dir, origin, target, start - offset, revenue, factor);
          const arrival = stops.at(-1)!.arr;
          if (arrival > departure - turn + .001 || !index.clear(stops, dir)) continue;
          // GLL's side-platform train does not leave before 06:00.
          const gll = stops.find(s => s.st === 22);
          if (dir === 'DN' && target > 22 && gll && gll.arr < OPENING.guanglanEast + MIN_HEADWAY) continue;
          if (reverse && terminalOverflows(topo, target, [...occupied, { from: arrival, to: departure }]).some(o => o.t >= arrival && o.t < departure + HOLD_CLEAR)) continue;
          const portal = topo.depots[depot].portals.exit[dir];
          if (portal.reverse && blocks.some(other => other !== b && !pending.has(other.trips[0]) && other.start.kind === 'depot' && other.start.depot === depot
            && trips[other.trips[0]].dir === dir && trips[other.trips[0]].from === origin
            && Math.abs(trips[other.trips[0]].stops[0].dep - stops[0].dep) < PORTAL_CYCLE)) continue;
          const [exitStart, exitClear] = outboundWindow(ctx, depot, { dir, stops });
          if (blocks.some(other => {
            if (other === b || other.end.kind !== 'depot' || other.end.depot !== depot) return false;
            const last = trips[other.trips.at(-1)!];
            if (topo.depots[depot].portals.entry[last.dir].path !== portal.path) return false;
            const [approach, clear] = inboundWindow(topo, depot, last);
            return exitStart < clear && exitClear > approach;
          })) continue;
          const candidate = { ...first, dir, from: origin, to: target, stops, revenue };
          if (!frontTurnClear(ctx, others, candidate, departure, new Set([first.id, next.id]))) continue;
          Object.assign(first, candidate, { kind: revenue ? 'ins' : 'empty' });
          if (!reverse) first.stops.at(-1)!.stop = false;
          b.start = { kind: 'depot', depot, time: depotStartTime(ctx, depot, first) };
          fitted = true; break;
        }
        if (fitted) break;
      }
      if (fitted) break;
    }
  }
}

/** how far a trip can move later / earlier and still keep `keep` s to every
 *  other train in its direction at each of its stops */
function headwayRoom(trips: Trip[], t: Trip, keep: number, skip: Set<number> = new Set()): { later: number; earlier: number } {
  let later = Infinity, earlier = Infinity;
  for (const u of trips) {
    if (u.dir !== t.dir || u.cancelled || u.block === UNUSED_DEPOT_MOVE || u.id === t.id || skip.has(u.id)) continue;
    for (const s of t.stops) {
      const us = u.stops.find((x) => x.st === s.st);
      if (!us) continue;
      if (us.dep >= s.dep) later = Math.min(later, us.dep - s.dep - keep);
      else earlier = Math.min(earlier, s.dep - us.dep - keep);
    }
  }
  return { later: Math.max(0, later), earlier: Math.max(0, earlier) };
}

/** `t` moved by `shift` keeps `keep` s to every other train in its direction at each of its stops */
function headwayClear(trips: Trip[], t: Trip, shift: number, keep: number, skip: Set<number> = new Set()): boolean {
  return trips.every((u) => {
    if (u.dir !== t.dir || u.cancelled || u.block === UNUSED_DEPOT_MOVE || u.id === t.id || skip.has(u.id)) return true;
    return t.stops.every((s) => {
      const us = u.stops.find((x) => x.st === s.st);
      return !us || Math.abs(us.dep - (s.dep + shift)) >= keep;
    });
  });
}

/**
 * A train brought out of the depot to start at a terminal that would make
 * more trains stand there at once than it holds comes later instead: within
 * its own turn there, clear of every other train on its way (it may drop in
 * behind one), and its exit spacing kept (later exits through the same
 * change-of-ends portal move up with it where they can).
 */
function relieveTerminals(ctx: PlanContext, blocks: Block[], trips: GenTrip[], fixedDepartures: Set<number> = new Set()) {
  const { topo } = ctx;
  const plan = { blocks, trips } as unknown as Plan;
  const clearAt = (t: Trip, delta: number, skip: Set<number>) => trips.every((u) => {
    if (u.dir !== t.dir || u.cancelled || u.block === UNUSED_DEPOT_MOVE || u.id === t.id || skip.has(u.id)) return true;
    return t.stops.every((s) => {
      const us = u.stops.find((x) => x.st === s.st);
      return !us || Math.abs(us.dep - (s.dep + delta)) >= MIN_HEADWAY;
    });
  });
  /** exits after `b` through the same reversing portal, in order */
  const portalFollowers = (b: Block): Block[] => {
    const a = trips[b.trips[0]];
    if (b.start.kind !== 'depot') return [];
    const depot = b.start.depot;
    const p = topo.depots[depot].portals.exit[a.dir];
    if (!p.reverse || a.stops[0].st !== p.station) return [];
    return blocks.filter((x) => x !== b && x.start.kind === 'depot' && x.start.depot === depot && !trips[x.trips[0]].cancelled
      && trips[x.trips[0]].dir === a.dir && trips[x.trips[0]].stops[0].st === p.station && trips[x.trips[0]].stops[0].dep >= a.stops[0].dep)
      .sort((x, y) => trips[x.trips[0]].stops[0].dep - trips[y.trips[0]].stops[0].dep);
  };
  const turnSlack = (b: Block) => {
    const a = trips[b.trips[0]], d = trips[b.trips[1]];
    return d && !d.cancelled && a.to === d.from ? d.stops[0].dep - a.stops[a.stops.length - 1].arr - minTurn(a.to) : 0;
  };
  /** move `b`'s first trip `delta` later, pushing the portal exits behind it; false (nothing moved) if it cannot */
  const plan2 = (b: Block, delta: number): Map<Block, number> | null => {
    const moves = new Map<Block, number>();
    let prevDep = trips[b.trips[0]].stops[0].dep + delta;
    moves.set(b, delta);
    for (const f of portalFollowers(b)) {
      const dep = trips[f.trips[0]].stops[0].dep;
      const push = prevDep + PORTAL_CYCLE - dep;
      if (push <= 0) break;
      moves.set(f, push);
      prevDep = dep + push;
    }
    const skip = new Set([...moves.keys()].map((x) => x.trips[0]));
    for (const [x, d] of moves) if (d > turnSlack(x) || !clearAt(trips[x.trips[0]], d, skip)) return null;
    return moves;
  };
  for (let iter = 0; iter < 30; iter++) {
    let moved = false;
    for (const [st, list] of terminalOccupancy(plan)) {
      const ov = terminalOverflows(topo, st, list)[0];
      const over = ov && list.find((o) => o.from === ov.t);
      if (!over) continue;
      const present = list.filter((x) => x.from <= over.from && x.to > over.from);
      // the latest arrivals first: they are the ones to hold back
      for (const o of present.sort((x, y) => y.from - x.from)) {
        const b = blocks.find((x) => x.id === o.block)!;
        const a = trips[b.trips[0]];
        if (b.start.kind !== 'depot' || fixedDepartures.has(a.id) || b.trips.length < 2 || a.to !== st || a.stops[a.stops.length - 1].arr !== o.from) continue;
        const need = Math.min(...present.filter((x) => x !== o).map((x) => x.to)) - o.from + 5;
        let moves: Map<Block, number> | null = null;
        for (let delta = Math.max(need, 1); delta <= turnSlack(b) && !moves; delta += 10) moves = plan2(b, delta);
        if (!moves) continue;
        for (const [x, d] of moves) {
          const t = trips[x.trips[0]];
          for (const p of t.stops) { p.arr += d; p.dep += d; }
          if (x.start.kind === 'depot') x.start.time = depotStartTime(ctx, x.start.depot, t);
        }
        moved = true;
        break;
      }
    }
    if (!moved) break;
  }

}

/** platform time a depot exit takes when it changes ends on the junction
 *  platform: in against the normal direction, change ends, board, away */
const PORTAL_CYCLE = 150;
/** spacing kept to the other trains when such an exit is moved (MIN_HEADWAY + margin) */
const HEADWAY_KEEP = 120;

/**
 * Exits that change ends on the junction platform (北翟路 trains for the UP
 * at 淞虹路, 川沙 trains for the DN at 远东大道) use that platform one after
 * another, PORTAL_CYCLE apart at least. A burst planned closer is spread:
 * later where the train's turn at the far end has the slack (it then stands
 * there for less), earlier only for what that slack cannot take.
 */
function spacePortalExits(ctx: PlanContext, blocks: Block[], trips: GenTrip[], fixedDepartures: Set<number> = new Set()) {
  const { topo } = ctx;
  topo.depots.forEach((dp, d) => {
    for (const dir of ['DN', 'UP'] as const) {
      const p = dp.portals.exit[dir];
      if (!p.reverse) continue;
      const group = blocks.filter((b) => b.start.kind === 'depot' && b.start.depot === d && trips[b.trips[0]]?.dir === dir
        && trips[b.trips[0]].stops[0].st === p.station && !trips[b.trips[0]].cancelled)
        .sort((a, b) => trips[a.trips[0]].stops[0].dep - trips[b.trips[0]].stops[0].dep);
      if (group.length < 2) continue;
      const first = group.map((b) => trips[b.trips[0]]);
      const dep0 = first.map((t) => t.stops[0].dep);
      const later = group.map((b, k) => {
        const t = first[k];
        const n = b.trips[1] !== undefined ? trips[b.trips[1]] : undefined;
        if (!n || n.cancelled) return 0;
        return Math.max(0, n.stops[0].dep - t.stops[t.stops.length - 1].arr - minTurn(t.to));
      });
      // as late as each train's turn at the far end allows (no longer layover
      // there than needed), working back from the last, PORTAL_CYCLE apart,
      // and clear of every other train on the way by HEADWAY_KEEP (it may drop
      // in behind one rather than stay ahead of it)
      const moving = new Set(first.map((t) => t.id));
      const dep = dep0.slice();
      for (let k = dep.length - 1; k >= 0; k--) {
        // A source may be a scheduled short-route or official first train,
        // already departing its depot junction. Moving that service here
        // breaks the core stream; only positioning moves have timing slack.
        if (fixedDepartures.has(first[k].id)) continue;
        let hi = dep0[k] + later[k];
        if (k < dep.length - 1) hi = Math.min(hi, dep[k + 1] - PORTAL_CYCLE);
        let at = NaN;
        for (let x = hi; x >= Math.min(dep0[k], hi) - 600; x -= 10) {
          if (headwayClear(trips, first[k], x - dep0[k], HEADWAY_KEEP, moving)) { at = x; break; }
          // where it was planned is good enough when nothing later is
          if (x - 10 < dep0[k] && dep0[k] <= hi) { at = dep0[k]; break; }
        }
        if (Number.isNaN(at)) {
          const room = headwayRoom(trips, first[k], HEADWAY_KEEP, moving);
          at = Math.min(dep0[k] + Math.min(later[k], room.later), hi);
        }
        dep[k] = at;
      }
      group.forEach((b, k) => {
        const shift = dep[k] - dep0[k];
        if (Math.abs(shift) < 0.5) return;
        for (const st of first[k].stops) { st.arr += shift; st.dep += shift; }
        if (b.start.kind === 'depot') b.start.time = depotStartTime(ctx, d, first[k]);
      });
    }
  });
}

function addTo(trips: GenTrip[], dir: TrackDir, kind: TripKind, from: number, to: number, stops: PlanStop[], revenue: boolean, overlay?: string): GenTrip {
  const t: GenTrip = { id: trips.length, no: '', dir, kind, from, to, stops, revenue, block: -1, overlay };
  trips.push(t);
  return t;
}

/** BZL/CSD share their conversion track: a returning train holds it from
 * 1500 m before the junction until it is clear inside the yard. */
/** some lead of the depot takes both trains going in and trains coming out
 *  (北翟路: each 出入段线 for its direction; 川沙: the 出入段线), so an added
 *  return can meet a planned exit on it */
export function sharedLead(topo: Topology, depot: number): boolean {
  const p = topo.depots[depot].portals;
  const ins = new Set([p.entry.DN.path, p.entry.UP.path]);
  return ins.has(p.exit.DN.path) || ins.has(p.exit.UP.path);
}

export function inboundWindow(topo: Topology, depot: number, last: Pick<Trip, 'to' | 'stops'>): [number, number] {
  const d = topo.depots[depot];
  const distance = Math.abs(topo.stations[last.to].chain - d.junctionChain);
  const arr = last.stops.at(-1)!.arr;
  const transfer = d.transferPaths[0].links.reduce((sum, id) => sum + topo.links[id].len, 0);
  return [arr + 15 + Math.max(0, distance - 1500) / 20, arr + 15 + distance / 20 + (transfer + LINE_INFO.trainLength) / (25 / 3.6) + 25];
}

/** A reversing exit occupies the conversion track until it can reach and
 * clear its junction platform. The yard's nominal exitTime alone omits the
 * change of ends and can place a return in front of the exiting car.
 * 【假设】 Retain the inbound model's 25 s clearing margin after departure. */
export function outboundWindow(ctx: Pick<PlanContext, 'topo'>, depot: number, first: Pick<Trip, 'dir' | 'stops'>): [number, number] {
  const yard = ctx.topo.depots[depot];
  const start = depotStartTime(ctx, depot, first);
  const portal = yard.portals.exit[first.dir];
  return [start, Math.max(start + yard.exitTime, portal.reverse ? first.stops[0].dep + 25 : -Infinity)];
}

/** time a train must leave the depot gate to make its first departure */
export function depotStartTime(ctx: Pick<PlanContext, 'topo'>, depot: number, first: Pick<Trip, 'stops'> & { dir?: TrackDir }): number {
  const { topo } = ctx;
  const J = topo.depots[depot].junctionChain;
  const st0 = first.stops[0].st;
  const dist = Math.abs(topo.stations[st0].chain - J);
  // Both the time and the distance must refer to the first station, even
  // when an empty feeder passes it without stopping.
  const refTime = first.stops[0].dep;
  // transfer track (~470 m at 25 km/h) + junction + run on the main line
  // (+ the change of ends where the lead reaches the line against `dir`)
  // (callers may pass bare stops: then the direction follows from their order)
  const dir: TrackDir = first.dir ?? (first.stops.length > 1 && first.stops[1].st < st0 ? 'UP' : 'DN');
  const travel = 95 + dist / 13 + 25 + (topo.depots[depot].portals.exit[dir].reverse ? PORTAL_REVERSE : 0);
  return Math.round(refTime - travel - (first.stops[0].stop ? 75 : 30));
}

function numberPlan(plan: Plan, startSvc = 1) {
  const cnt: Record<string, number> = {};
  const digit: Record<TripKind, string> = { big: '1', small: '2', late: '3', ins: '4', wd: '4', extra: '5', empty: '0', adj: '6' };
  for (const trip of plan.trips) if (/^\d{4}$/.test(trip.no)) {
    const key=trip.no[0]+trip.dir;
    cnt[key]=Math.max(cnt[key]??0,(Number(trip.no.slice(1))+(trip.dir==='DN'?1:0))/2);
  }
  const sorted = [...plan.trips].filter((t) => !t.no).sort((a, b) => a.stops[0].dep - b.stops[0].dep);
  for (const t of sorted) {
    const key = digit[t.kind] + t.dir;
    const n = (cnt[key] ?? 0) + 1;
    cnt[key] = n;
    const seqN = t.dir === 'DN' ? 2 * n - 1 : 2 * n;
    t.no = digit[t.kind] + String(seqN % 1000).padStart(3, '0');
  }
  const blocks = plan.blocks.filter((b) => !b.svc).sort((a, b) => blockStart(plan, a) - blockStart(plan, b));
  let svc = startSvc;
  for (const b of blocks) b.svc = String(svc++).padStart(3, '0');
}

function blockStart(plan: Plan, b: Block) {
  return b.start.kind === 'depot' ? b.start.time : plan.trips[b.trips[0]].stops[0].dep;
}

export function fleetPeak(plan: Plan): number {
  const ev: [number, number][] = [];
  for (const b of plan.blocks) {
    const live = b.trips.map(id => plan.trips[id]).filter(t => !t.cancelled);
    if (!live.length) continue;
    const first = live[0];
    const last = live[live.length - 1];
    const s = b.start.kind === 'depot' ? b.start.time : first.stops[0].dep - 600;
    const e = last.stops[last.stops.length - 1].arr + (b.end.kind === 'depot' ? 300 : 0);
    if (b.start.kind === 'stable' || b.end.kind === 'stable') continue;
    ev.push([s, 1], [e, -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of ev) { cur += d; max = Math.max(max, cur); }
  const stabled = plan.blocks.filter((b) => b.trips.some(id => !plan.trips[id].cancelled) && (b.start.kind === 'stable' || b.end.kind === 'stable')).length;
  return max + stabled;
}

// ---------------------------------------------------------------- overlays

export function applyOverlay(ctx: PlanContext, plan: Plan, preset: { id: string; label: string; a: number; b: number; from: number; to: number; headway: number },
  live?: Pick<OverlayReuse, 'canExtend' | 'now' | 'stock'>): { trips: number; blocks: number; skipped: number; extended: OverlayReuse['extended'] } {
  restoreCancelledHomes(ctx, plan, live?.now ?? OPENING.dayStart);
  const factorAt = (t: number) => dwellFactorAt(ctx.dayType, t);
  const trips = plan.trips as GenTrip[];
  const tag = `${preset.id}@${preset.from}`;
  const n0 = trips.length;
  const { a, b } = preset;
  const deferred: { block: Block; end: Block['end']; move: number; place: ReturnType<typeof overnightPlaces>[number] }[] = [];
  // If added services run beyond the planned night delivery, the arriving
  // car clears on to its yard. A later added arrival delivers the same slot.
  // The published passenger trip keeps its route and every call unchanged.
  for (const block of plan.blocks) {
    if (block.end.kind !== 'stable' || block.end.berth === undefined || block.train !== undefined && !live?.canExtend(block.id, block.trips.at(-1)!)) continue;
    const end = block.end, last = block.trips.map(id => trips[id]).filter(t => !t.cancelled).at(-1);
    const place = overnightPlaces(ctx.topo).find(p => p.arrivalBerth === end.berth);
    if (!last || !place || ctx.topo.berths[end.berth!].kind !== 'platform' || last.to < Math.min(a,b) || last.to > Math.max(a,b)
      || preset.to < last.stops.at(-1)!.arr - 1800 || last.stops.at(-1)!.arr < (live?.now ?? OPENING.dayStart)) continue;
    const rule = OPERATIONS.depotReturns.filter(r => r.dir === last.dir)
      .map(r => ({depot:depotIndex(ctx.topo,r.depot),station:STATIONS.findIndex(s => s.id === r.station)}))
      .filter(r => last.dir === 'DN' ? r.station >= last.to : r.station <= last.to)
      .sort((x,y) => Math.abs(x.station-last.to)-Math.abs(y.station-last.to))[0];
    if (!rule) continue;
    const index = new DepIndex(trips.filter(t => t !== last));
    let stops: PlanStop[] | undefined;
    for (let wait = 30; wait <= 180; wait += 10) {
      const candidate = buildStops(ctx,last.dir,last.to,rule.station,last.stops.at(-1)!.arr+wait,false,1);
      candidate[0].stop = false;
      candidate.at(-1)!.stop = false;
      if (index.clear(candidate,last.dir)) { stops = candidate; break; }
    }
    if (!stops) continue;
    const move = addTo(trips,last.dir,'empty',last.to,rule.station,stops,false);
    move.block = block.id;
    block.trips.push(move.id);
    block.end = {kind:'depot',depot:rule.depot};
    deferred.push({block,end,move:move.id,place});
  }
  const dirAB: TrackDir = a < b ? 'DN' : 'UP';
  const dirBA: TrackDir = dirAB === 'DN' ? 'UP' : 'DN';
  const existing = [...plan.trips];
  const stockBefore = depotLedger(ctx.topo, plan);
  // every added trip keeps the minimum headway (P1) to all other trains along its whole
  // path; it is moved by up to half the overlay headway to find such a slot, otherwise
  // it is not run (reported as a shortfall)
  const idx = new DepIndex(existing);
  // Added trains arriving at an end of the added section, waiting to turn
  // back. A departure is placed, where its slot allows, inside the turnback
  // window of such a train, so that the added trips form circulations rather
  // than each arrival waiting out the intermediate station's turnback limit
  // and going back to the depot while a fresh train comes out for the
  // departure (D47).
  const waiting = new Map<number, GenTrip[]>([[a, []], [b, []]]);
  const waitAt = (X: number) => { if (!waiting.has(X)) waiting.set(X, []); return waiting.get(X)!; };
  const occ0 = turnbackOccupancy(ctx.topo, plan);
  const paired: { st: number; from: number; to: number }[] = [];
  const turnWait = (X: number) => X > 0 && X < ctx.topo.stations.length - 1 ? 450 : MAX_LAYOVER;
  const turnFree = (station: number, from: number, to: number, own?: number) => {
    const clear = OPERATIONS.platformTurnClear[STATIONS[station].id] ?? 0;
    const pending = waitAt(station).filter(t => t.id !== own).map(t => ({from:t.stops.at(-1)!.arr,to:t.stops.at(-1)!.arr+minTurn(station)}));
    const list = [...(occ0.get(station) ?? []), ...paired.filter(o => o.st === station), ...pending]
      .map(o => ({from:o.from-clear,to:o.to+clear}));
    return !terminalOverflows(ctx.topo,station,[...list.filter(o=>o.from<to && o.to>from),{from,to}]).some(o=>o.t>=from && o.t<to);
  };
  let pairedWith: GenTrip | undefined;
  const fit = (dir: TrackDir, from: number, to: number, t: number, turn: boolean): PlanStop[] | null => {
    pairedWith = undefined;
    for (let k = 0; k * 10 <= preset.headway / 2; k++) {
      for (const t0 of k ? [t + k * 10, t - k * 10] : [t]) {
        let pair = -1;
        if (turn) {
          pair = waitAt(from).findIndex(A => t0 >= A.stops.at(-1)!.arr + minTurn(from) && t0 <= A.stops.at(-1)!.arr + minTurn(from) + turnWait(from)
            && turnFree(from,A.stops.at(-1)!.arr,t0,A.id)
            && tailOrderClear(ctx.topo, from, [...(occ0.get(from) ?? []), ...paired.filter(o => o.st === from)], A.stops.at(-1)!.arr, t0)
            && frontTurnClear(ctx, trips, A, t0, new Set([A.id])));
          if (pair < 0) continue;
        }
        const st = buildStops(ctx, dir, from, to, t0, true, factorAt);
        const rear = turnbackAt(ctx.topo,to,dir);
        if (!idx.clear(st, dir) || !storedPlatformsClear(ctx.topo,plan,{dir,to,stops:st},rear?.kind==='rear'?rear.berths[0]:undefined)) continue;
        if (!turnFree(to,st.at(-1)!.arr,st.at(-1)!.arr+minTurn(to))) continue;
        // Fit front-turn slots while placing the revenue streams, rather
        // than discovering after FIFO matching that every arrival occupies
        // a platform needed by the opposite stream.
        if (!frontTurnClear(ctx, trips, {dir,to,stops:st}, st.at(-1)!.arr+minTurn(to), new Set())) continue;
        const incoming = dir === 'DN' ? 'UP' : 'DN';
        // a train brought in to front-turn for it arrives between the
        // trains of its own direction, up to 2 min before its turnback
        // time, and holds the departure platform until it leaves
        const front = turnbackAt(ctx.topo, from, incoming)?.kind === 'front';
        const arrives = (w: number) => {
          const arrival = { ...st[0], arr: t0 - minTurn(from) - w, dep: t0 - minTurn(from) - w };
          return frontTurnClear(ctx, trips, { dir: incoming, to: from, stops: [arrival] }, t0, new Set())
            && (!front || idx.clear([arrival], incoming));
        };
        if (!turn && ![0, 10, 20, 30, 40, 50, 60, 80, 100, 120].some(arrives)) continue;
        if (turn) {
          pairedWith = waitAt(from).splice(pair, 1)[0];
          paired.push({ st: from, from: pairedWith.stops.at(-1)!.arr, to: t0 });
        }
        return st;
      }
    }
    return null;
  };
  // A grid trip the base plan alone leaves no room for — no time within
  // half the overlay headway at which its whole path keeps the minimum
  // headway and its front turns at both ends stay clear of the base trains
  // (the peak and its build-up; 虹桥火车站's front turnback while the base
  // runs closer than ~5 min) — cannot be added without retiming the base
  // plan. It is not requested; it is reported as such, not counted as a
  // shortfall of the added-service planning (D47).
  const baseTrips = existing.filter(t => !t.overlay && !t.cancelled);
  const base = new DepIndex(baseTrips);
  const baseRoom = (dir: TrackDir, from: number, to: number, t: number) => {
    for (let k = -preset.headway / 2; k <= preset.headway / 2; k += 10) {
      const st = buildStops(ctx, dir, from, to, t + k, true, factorAt);
      if (!base.clear(st, dir) || !frontTurnClear(ctx, baseTrips, { dir, to, stops: st }, st.at(-1)!.arr + minTurn(to), new Set())) continue;
      const arrival = { ...st[0], arr: st[0].dep - minTurn(from), dep: st[0].dep - minTurn(from) };
      if (frontTurnClear(ctx, baseTrips, { dir: dir === 'DN' ? 'UP' : 'DN', to: from, stops: [arrival] }, st[0].dep, new Set())) return true;
    }
    return false;
  };
  // An end of the added section that is a front turnback (虹桥火车站) turns
  // a train on a through platform: the platform must stay free of the base
  // trains of both directions from ~90 s before the arrival to ~90 s after
  // the departure, ≥300 s, and the arrival must keep the headway of its own
  // direction. With the base running every 4.5–7 min both ways there is no
  // such time (D47). The added trains run on to the nearest station beyond
  // it with a rear turnback (国家会展中心) and turn there, still serving the
  // whole requested section.
  // An end with no turnback at all (虹桥火车站 since the PDF layout) is served the same way.
  // (the duties are not touched while the grid is fitted: one storage calendar)
  const stored0 = storageOccupancy(ctx.topo, plan);
  const outward = (X: number, arrDir: TrackDir, at: number, next = false): number | undefined => {
    const available = (station: number) => {
      const rear = turnbackAt(ctx.topo, station, arrDir);
      if (rear?.kind !== 'rear') return false;
      const from = at - minTurn(station) - preset.headway/2;
      const to = at + minTurn(station) + preset.headway/2;
      const stored = stored0.filter(o => o.station === station && o.from < to && o.to > from
        && (o.from <= OPENING.dayStart || o.to >= OPENING.dayStart+86400 || o.to-o.from > MAX_LAYOVER));
      return rear.berths.some(b => !stored.some(o => o.link === ctx.topo.berths[b].link));
    };
    if (!next && available(X)) return undefined;
    const step = arrDir === 'DN' ? 1 : -1;
    for (let Y = X + step; Y >= 0 && Y < ctx.topo.stations.length; Y += step)
      if (available(Y)) return Y;
    return undefined;
  };
  const terminals = new Set([a, b]);
  const unfitted: {dir:TrackDir;from:number;to:number;at:number}[] = [];
  let requested = 0;
  let peak = 0;
  for (let t = preset.from; t <= preset.to; t += preset.headway) {
    for (const [dir, from, to, t0] of [[dirAB, a, b, t], [dirBA, b, a, t + preset.headway / 2]] as [TrackDir, number, number, number][]) {
      const back: TrackDir = dir === 'DN' ? 'UP' : 'DN';
      const run = buildStops(ctx, dir, from, to, t0, true, factorAt);
      const ends: [number, number][] = [[(turnbackAt(ctx.topo, from, back)?.kind === 'rear' ? from : outward(from, back, t0) ?? from), outward(to, dir, run.at(-1)!.arr) ?? to]];
      // the departure time is the one at the requested origin
      const at = (o: number) => o === from ? t0 : t0 - (buildStops(ctx, dir, o, to, t0, true, 1).find(p => p.st === from)!.dep - t0);
      const room = ends.filter(([o, d]) => baseRoom(dir, o, d, at(o)));
      if (!room.length) { peak++; continue; }
      requested++;
      let st: PlanStop[] | null = null, end = room[0];
      for (const [o, d] of room) {
        st = fit(dir, o, d, at(o), true) ?? fit(dir, o, d, at(o), false);
        if (st) { end = [o, d]; break; }
      }
      // A short turn already booked at the requested end can use its tail
      // even when no overnight car is there. Try the next physical turnback
      // before rejecting the request; keep serving the entire requested part.
      if (!st) {
        const beyond = outward(end[1], dir, run.at(-1)!.arr, true);
        if (beyond !== undefined && baseRoom(dir, end[0], beyond, at(end[0]))) {
          st = fit(dir, end[0], beyond, at(end[0]), true) ?? fit(dir, end[0], beyond, at(end[0]), false);
          if (st) end = [end[0], beyond];
        }
      }
      if (!st) { unfitted.push({dir,from:end[0],to:end[1],at:at(end[0])}); continue; }
      const trip = addTo(trips, dir, 'extra', end[0], end[1], st, true, tag);
      if (pairedWith) { pairedWith.next = trip.id; trip.prev = pairedWith.id; }
      idx.add(trip);
      waitAt(end[1]).push(trip);
      terminals.add(end[0]); terminals.add(end[1]);
    }
  }
  const reuse: OverlayReuse = { now: live?.now ?? -Infinity, canExtend: live?.canExtend ?? (() => false), blocks: plan.blocks, extended: [],
    returnShift: stockBefore.initial.map((n, d) => n - stockBefore.final[d]), stock: live?.stock, nightPlaces: deferred.map(x => x.place) };
  const blocks = circulate(ctx, trips, [...terminals], [], tag, existing, plan.blocks.length, occ0, reuse);
  plan.blocks.push(...blocks);
  plan.overlays.push({ id: tag, label: preset.label, from: preset.from, to: preset.to, requested, peak });
  const maxSvc = Math.max(0, ...plan.blocks.filter((x) => x.svc).map((x) => parseInt(x.svc, 10)));
  numberPlan(plan, maxSvc + 1);
  plan.fleetPeak = fleetPeak(plan);
  for (const block of blocks) {
    if (block.end.kind!=='stable' || block.end.berth===undefined) continue;
    const last=trips[block.trips.at(-1)!], previous=trips[block.trips.at(-2)!];
    if (!last || last.id<n0 || last.revenue || !previous) continue;
    const berth=ctx.topo.berths[block.end.berth];
    const nightStation = block.end.station;
    if (berth.platform!==ctx.topo.stations[nightStation].platforms[last.dir]) continue;
    const uses=trips.filter(t=>t!==last && !t.cancelled && t.dir===last.dir)
      .flatMap(t=>t.stops.filter(s=>s.st===nightStation).map(s=>s.dep));
    const after=Math.max(...uses,0)+MIN_HEADWAY;
    if (last.stops.at(-1)!.arr>=after) continue;
    const index=new DepIndex(trips.filter(t=>t!==last));
    for (let offset=10;offset<=450;offset+=10) {
      const stops=buildStops(ctx,last.dir,last.from,last.to,last.stops[0].dep+offset,false,1);
      if (stops.at(-1)!.arr<after || !index.clear(stops,last.dir)) continue;
      const other=(terminalOccupancy(plan).get(last.from)??[]).filter(o=>o.block!==block.id);
      if (terminalOverflows(ctx.topo,last.from,[...other,{from:previous.stops.at(-1)!.arr,to:stops[0].dep}]).length) continue;
      last.stops=stops;
      break;
    }
  }
  // Fault cancellations change the available gaps and terminal occupancy.
  // Check complete added circulations after matching, including every point
  // inside a layover, rather than only the occupancy at its arrival event.
  const extended = reuse?.extended ?? [];
  extended.push(...deferred.map(x => ({block:x.block.id,last:x.block.trips.at(-2)!,trips:[x.move],tail:[],end:x.end})));
  const absorbed = reuse?.absorbed ?? [];
  /** a base duty taken over by the train of `block` goes back to its own train */
  const giveBack = (block: Block) => {
    for (const x of absorbed.filter(x => x.into === block.id)) {
      const own = plan.blocks[x.block];
      block.trips = block.trips.filter(id => !x.trips.includes(id));
      own.trips.push(...x.trips);
      for (const id of x.trips) trips[id].block = own.id;
      for (const id of x.lead) { trips[id].cancelled = false; delete trips[id].cancelReason; }
      own.end = x.end;
      absorbed.splice(absorbed.indexOf(x), 1);
    }
  };
  const added = (id: number) => blocks.some(b => b.id === id && b.trips.some(t => !trips[t].cancelled))
    || extended.some(x => x.block === id);
  for (let attempt = 0; attempt < blocks.length + extended.length; attempt++) {
    const issue = validatePlan(ctx, plan).find(i => i.blocks?.some(added));
    if (!issue) break;
    const reason = `加开能力不足：${issue.text}`;
    const x = extended.filter(e => issue.blocks!.includes(e.block)).at(-1);
    if (x) {
      // give the base train back its own withdrawal
      const block = plan.blocks[x.block];
      giveBack(block);
      for (const id of x.trips) cancelTrip(trips[id], reason);
      block.trips = block.trips.filter(id => !x.trips.includes(id));
      for (const id of x.tail) { trips[id].cancelled = false; delete trips[id].cancelReason; }
      block.end = x.end;
      extended.splice(extended.indexOf(x), 1);
    } else {
      const block = blocks.filter(b => issue.blocks!.includes(b.id) && b.trips.some(t => !trips[t].cancelled)).at(-1)!;
      giveBack(block);
      for (const id of block.trips) cancelTrip(trips[id], reason);
    }
    plan.fleetPeak = fleetPeak(plan);
  }
  // A base car sent on to the yard only gives up its overnight berth when an
  // added arrival really stands there now. Otherwise it keeps its slot.
  for (const x of deferred) {
    const kept = extended.find(e => e.block === x.block.id && e.trips.includes(x.move));
    if (!kept) continue;
    const delivered = plan.blocks.some(b => b !== x.block && b.end.kind === 'stable' && b.end.berth === x.place.arrivalBerth
      && b.trips.some(id => !trips[id].cancelled));
    if (delivered) continue;
    const moved = x.block.trips, end = x.block.end;
    x.block.trips = moved.filter(id => id !== x.move);
    x.block.end = x.end;
    const link = ctx.topo.berths[x.place.arrivalBerth].link;
    const slot = storageOccupancy(ctx.topo, plan).filter(o => o.link === link);
    const own = slot.find(o => o.block === x.block.id);
    const platformBlocked = trips.some(trip => {
      if (trip.cancelled || trip.block === x.block.id) return false;
      const duty = plan.blocks[trip.block];
      const next = duty && trips[duty.trips[duty.trips.indexOf(trip.id) + 1]];
      const turn = next && next.dir !== trip.dir ? turnbackAt(ctx.topo, trip.to, trip.dir) : undefined;
      // (only the berth being restored: a conflict elsewhere is not this car's)
      return !storedPlatformsClear(ctx.topo, plan, trip, turn?.kind === 'rear' ? turn.berths[0] : undefined, x.block);
    });
    // (an added turnback now needs the slot: the car stays on its way to the
    // yard and the ledger reports the berth short, rather than a conflict)
    if (platformBlocked || own && slot.some(o => o.block !== x.block.id && o.from < own.to && own.from < o.to)) {
      x.block.trips = moved; x.block.end = end;
      continue;
    }
    cancelTrip(trips[x.move], '加开：过夜位无加开车接替，原车照常入位');
    extended.splice(extended.indexOf(kept), 1);
  }
  plan.fleetPeak = fleetPeak(plan);
  // a move linked behind a cancelled arrival but never put in a block (its
  // withdrawal, after the trip it followed was dropped) does not run either
  for (const t of trips.slice(n0) as GenTrip[]) {
    const P = t.prev === undefined ? undefined : trips[t.prev];
    if (!t.cancelled && t.block < 0 && P?.cancelled) cancelTrip(t, P.cancelReason ?? '加开：前序车次取消');
  }
  // Close the stock flow across all retained duties, including returns whose
  // passenger services finished in a different yard. Real transfer workings
  // carry any residual surplus; no published service is retimed or removed.
  restoreCancelledHomes(ctx, plan, live?.now ?? OPENING.dayStart);
  numberPlan(plan, maxSvc + blocks.length + 1);
  plan.fleetPeak = fleetPeak(plan);
  // Retain every infeasible grid request in the preview with its reason.
  // These empty, cancelled duties reserve no car and never enter service.
  for (const request of unfitted) {
    const trip=addTo(trips,request.dir,'extra',request.from,request.to,
      buildStops(ctx,request.dir,request.from,request.to,request.at,true,factorAt),true,tag);
    trip.block=plan.blocks.length;
    cancelTrip(trip,'加开能力不足：整条路径的追踪间隔、折返占用或存车预留时段内无可用时隙');
    plan.blocks.push({id:trip.block,svc:'',start:{kind:'depot',depot:0,time:request.at},end:{kind:'none'},trips:[trip.id]});
  }
  numberPlan(plan,maxSvc+blocks.length+1);
  const kept = trips.slice(n0).filter((t) => !t.cancelled);
  return { trips: kept.length, blocks: blocks.length, extended, skipped: trips.slice(n0).filter((t) => t.cancelled && t.revenue).length };
}

/** Whole-duty cancellations can remove an overnight delivery or a cross-yard
 * return. Restore that physical stock separately from the added passenger
 * grid. Original cancelled trips stay intact; every transfer has a real,
 * headway-checked path and an explicit yard/berth destination. */
function restoreCancelledHomes(ctx: PlanContext, plan: Plan, now: number) {
  const { topo } = ctx;
  const cancelled = (b: Block) => b.trips.every(id => plan.trips[id].cancelled);
  const trips = plan.trips as GenTrip[], index = new DepIndex(trips);
  const retained = plan.blocks.filter(b => cancelled(b) && b.start.kind === 'stable').map(b => b.start);
  const fitMove = (depot: number, station: number, dir: TrackDir, earliest: number, end: Block['end']) => {
    const ex = exitStation(topo, depot, dir);
    if (dir === 'DN' ? ex >= station : ex <= station) return null;
    // (the plan does not change while one move is fitted)
    const ledger = depotLedger(topo,plan);
    for (let offset = 0; earliest + offset < OPENING.dayStart + 86400 - 15*60; offset += 10) {
      const stops = buildStops(ctx, dir, ex, station, earliest + offset, false, t => dwellFactorAt(ctx.dayType, t), () => true);
      if (stops.at(-1)!.arr >= OPENING.dayStart + 86400 - 15*60) break;
      if (depotStartTime(ctx, depot, { dir, stops }) < now + 120 || !index.clear(stops, dir)
        || !storedPlatformsClear(topo,plan,{dir,to:station,stops},end.kind==='stable'?end.berth:undefined)) continue;
      const first = { dir, stops }, [start, clear] = outboundWindow(ctx, depot, first);
      if (sharedLead(topo, depot) && plan.blocks.some(b => b.end.kind === 'depot' && b.end.depot === depot && !cancelled(b)
        && (([a,z]) => start < z && clear > a)(inboundWindow(topo, depot, trips[b.trips.filter(id => !trips[id].cancelled).at(-1)!])))) continue;
      if (end.kind === 'depot') {
        const [a,z] = inboundWindow(topo, end.depot, { to: station, stops });
        if (sharedLead(topo, end.depot) && plan.blocks.some(b => b.start.kind === 'depot' && b.start.depot === end.depot && !cancelled(b)
          && (([x,y]) => x < z && y > a)(outboundWindow(ctx, end.depot, trips[b.trips.find(id => !trips[id].cancelled)!])))) continue;
      }
      const events = sortDepotMoves([...ledger.events.map(e=>({...e})),{time:start,depot,delta:-1,block:-1},
        ...(end.kind==='depot'?[{time:stops.at(-1)!.arr+DEPOT_ENTRY_CLEAR,depot:end.depot,delta:1,block:-1}]:[])]);
      const balance = ledger.initial.slice();
      let fits = true;
      for (const event of events) {
        balance[event.depot]+=event.delta;
        if (balance[event.depot]<0 || event.depot===depot && balance[depot]>Math.max(topo.depots[depot].capacity,ledger.peak[depot]-1)
          || end.kind==='depot' && event.depot===end.depot && balance[event.depot]>topo.depots[event.depot].capacity) {fits=false;break;}
      }
      if (!fits) continue;
      return stops;
    }
    return null;
  };
  const append = (b: Block, depot: number, station: number, dir: TrackDir, stops: PlanStop[]) => {
    const move = addTo(trips, dir, 'empty', stops[0].st, station, stops, false);
    move.block = b.id;
    b.trips.push(move.id);
    b.start = { kind: 'depot', depot, time: depotStartTime(ctx, depot, move) };
    index.add(move);
  };
  // A cancelled morning train still occupies its own berth; no delivery is
  // needed to that slot. Other cancelled night deliveries use the same duty.
  for (const b of plan.blocks.filter(b => cancelled(b) && b.train === undefined && b.start.kind === 'depot' && b.end.kind === 'stable')) {
    if (b.end.kind !== 'stable' || b.end.berth === undefined) continue;
    const berth = topo.berths[b.end.berth];
    const stayed = retained.findIndex(start => start.kind === 'stable' && start.berth !== undefined && topo.berths[start.berth].link === berth.link);
    if (stayed >= 0) { retained.splice(stayed, 1); continue; }
    const ledger = depotLedger(topo, plan);
    // Cancelled morning stabling duties leave their cars on the line, even
    // when their original slot differs from the cancelled night delivery.
    // Only replace the net loss of line stock from the yards.
    if (ledger.final.reduce((sum, n, d) => sum + n - ledger.initial[d], 0) <= 0) break;
    const dir = (topo.links[berth.link].chainB - topo.links[berth.link].chainA) * berth.dir > 0 ? 'DN' : 'UP';
    const station = b.end.station;
    const lastUse = Math.max(OPENING.dayStart, ...trips.filter(t => !t.cancelled && t.dir === dir)
      .flatMap(t => t.stops.filter(s => s.st === station).map(s => s.dep)));
    const desired = Math.max(trips[b.trips.at(-1)!].stops.at(-1)!.arr, lastUse + MIN_HEADWAY);
    // Prefer the surplus yard, but a nearer yard can deliver the slot and
    // receive a real balancing transfer below. Its latest departure need not
    // precede a distant surplus yard's earlier capacity peak.
    const sources = topo.depots.slice().sort((a, b) => Number(ledger.final[b.id] > ledger.initial[b.id])
      - Number(ledger.final[a.id] > ledger.initial[a.id]));
    for (const depot of sources) {
      const run = buildStops(ctx, dir, exitStation(topo, depot.id, dir), b.end.station, desired, false, 1, () => true).at(-1)!.arr - desired;
      const stops = fitMove(depot.id, b.end.station, dir, desired - run, b.end);
      if (!stops) continue;
      append(b, depot.id, b.end.station, dir, stops);
      break;
    }
  }
  for (let guard = 0; guard < LINE_INFO.fleet; guard++) {
    const ledger = depotLedger(topo, plan);
    const surplus = topo.depots.filter(d => ledger.final[d.id] > ledger.initial[d.id]);
    const deficit = topo.depots.filter(d => ledger.final[d.id] < ledger.initial[d.id]);
    if (!surplus.length || !deficit.length) break;
    let placed = false;
    for (const source of surplus) for (const target of deficit) {
      if (placed) continue;
      const dir = source.junctionChain < target.junctionChain ? 'DN' : 'UP';
      const station = entryStation(topo, target.id, dir);
      const end: Block['end'] = { kind: 'depot', depot: target.id };
      const stops = fitMove(source.id, station, dir, now + 900, end);
      if (!stops) continue;
      const b: Block = { id: plan.blocks.length, svc: '', start: { kind: 'depot', depot: source.id, time: 0 }, end, trips: [] };
      append(b, source.id, station, dir, stops); plan.blocks.push(b); placed = true;
    }
    if (!placed) break;
  }
}

/** A standby train (备车) that can take over a duty: see `standbyCandidate`. */
export interface StandbyPlan { depot: number; k: number; start: number; dir: TrackDir; from: number; to: number; stops: PlanStop[] | null; standby?: boolean }

/**
 * Standby takeover (备车顶替, D45): the earliest trip of `tail` (trip ids of
 * one duty, in order, from index `minK`) that a spare vehicle leaving
 * `depot` no earlier than `notBefore` can start on time. The empty move
 * from the yard keeps the minimum headway to every other trip along its
 * whole path and leaves the declared turnback time at the origin.
 * Pure: the plan is not changed.
 */
export function standbyCandidate(ctx: PlanContext, plan: Plan, tail: number[], depot: number, notBefore: number, minK = 0, maxK = tail.length - 1, allowPositioning = false): StandbyPlan | null {
  const { topo } = ctx;
  const own = new Set(tail);
  const index = new DepIndex(plan.trips.filter(t => !own.has(t.id)));
  for (let k = minK; k <= maxK && k < tail.length; k++) {
    const D = plan.trips[tail[k]];
    if ((!D.revenue && !allowPositioning) || D.completed) continue;
    const T = D.from;
    const dep = D.stops[0].dep;
    const dir: TrackDir = topo.stations[T].chain < topo.depots[depot].junctionChain ? 'UP' : 'DN';
    const ex = exitStation(topo, depot, dir);
    if (ex === T) {
      const start = depotStartTime(ctx, depot, D);
      if (start >= notBefore) return { depot, k, start, dir, from: ex, to: T, stops: null };
      continue;
    }
    // An origin passed in the same direction is joined on the move; an
    // opposite one is reached on the arrival platform and turned back.
    const same = dir === D.dir;
    // Replacing a dedicated hot spare's empty return uses that spare's
    // registered storage approach, not an ordinary platform turnback.
    const storage = !same && allowPositioning && !D.revenue && hotStandbyPlaces(topo).find(p => p.depot
      && p.track === 'storage' && p.station === T && p.incoming === dir && storageArrivalBerth(topo,p.berth,dir)!==undefined);
    const mt = same ? 0 : minTurn(T);
    for (const stopping of [false, true]) {
    const factor = (t: number) => dwellFactorAt(ctx.dayType, t);
    const calls = stopping ? () => true : undefined;
    const run = buildStops(ctx, dir, ex, T, dep, false, factor, calls).at(-1)!.arr - dep;
    const latest = dep - mt - (same ? 0 : 60) - run;
    for (let step = 0; step <= 90; step++) {
      const stops = buildStops(ctx, dir, ex, T, latest - step * 10, false, factor, calls);
      stops[0].stop = false;
      if (same) stops[stops.length - 1].stop = false;
      if (storage) stops[stops.length - 1].stop = false;
      const start = depotStartTime(ctx, depot, { stops } as Trip);
      if (start < notBefore) break;
      if (stops.at(-1)!.arr > dep - mt + 1e-6 || !index.clear(stops, dir)) continue;
      const [,clear] = outboundWindow(ctx,depot,{dir,stops});
      const exitPath = topo.depots[depot].portals.exit[dir].path;
      if (plan.blocks.some(b => {
        if (b.withdrawal || b.end.kind !== 'depot' || b.end.depot !== depot) return false;
        const last = b.trips.map(id=>plan.trips[id]).filter(t=>!t.cancelled&&!own.has(t.id)).at(-1);
        if (!last || topo.depots[depot].portals.entry[last.dir].path !== exitPath) return false;
        const [approach,end] = inboundWindow(topo,depot,last);
        return start < end && clear > approach;
      })) continue;
      if (!same && !frontTurnClear(ctx, plan.trips, { dir, to: T, stops }, dep, new Set([D.id]))) continue;
      return { depot, k, start, dir, from: ex, to: T, stops, ...(storage ? { standby: true } : {}) };
    }
    }
  }
  return null;
}

/** Apply a standby takeover: trips `tail[k..]` move from duty `from` to a
 * new duty run by the standby, and are reinstated if their cancellation was
 * caused by losing the original train. Returns the new block. */
export function applyStandby(plan: Plan, from: number, tail: number[], c: StandbyPlan): Block {
  const trips = plan.trips as GenTrip[];
  const taken = tail.slice(c.k);
  const id = plan.blocks.length;
  const ids: number[] = [];
  if (c.stops) {
    const move = addTo(trips, c.dir, 'empty', c.from, c.to, c.stops.map(p => ({ ...p })), false);
    if (c.standby) move.standby = true;
    move.block = id;
    ids.push(move.id);
  }
  for (const t of taken) {
    const trip = trips[t];
    trip.block = id;
    trip.cancelled = false;
    delete trip.cancelReason;
    ids.push(t);
  }
  const old = plan.blocks[from];
  old.trips = old.trips.filter(t => !taken.includes(t));
  old.relieved = true;
  const block: Block = { id, svc: '', start: { kind: 'depot', depot: c.depot, time: c.start }, end: old.end, trips: ids };
  plan.blocks.push(block);
  const maxSvc = Math.max(0, ...plan.blocks.filter((x) => x.svc).map((x) => parseInt(x.svc, 10)));
  numberPlan(plan, maxSvc + 1);
  plan.fleetPeak = fleetPeak(plan);
  return block;
}

/** Single extra train (加开列车) from a depot to a turnback station and back. */
export function addExtraTrain(ctx: PlanContext, plan: Plan, depot: number, dir: TrackDir, to: number, time: number): Block | string {
  const { topo } = ctx;
  const ex = exitStation(topo, depot, dir);
  if ((dir === 'DN' && to <= ex) || (dir === 'UP' && to >= ex)) return '目的站不在出段方向前方';
  const back: TrackDir = dir === 'DN' ? 'UP' : 'DN';
  if (!turnbackAt(topo, to, dir)) return `${STATIONS[to].name} 无该方向折返条件`;
  const en = entryStation(topo, depot, back);
  const trips = plan.trips as GenTrip[];
  const index = new DepIndex(plan.trips);
  let s1: PlanStop[] = [], s2: PlanStop[] = [];
  for (let offset = 0; offset <= 900; offset += 10) {
    const out = buildStops(ctx, dir, ex, to, time + offset, true, 1);
    if (!index.clear(out,dir)) continue;
    // Opposing streams need not have a usable slot exactly 240 seconds after
    // arrival. Search the permitted terminal layover; never hold ordinary stops.
    for(let wait=0;wait<=Math.max(0,(to===0||to===topo.stations.length-1?1500:450)-minTurn(to));wait+=10){
      const into = buildStops(ctx, back, to, en, out[out.length - 1].arr + minTurn(to)+wait, true, 1);
      if(index.clear(into,back)){s1=out;s2=into;break;}
    }
    if(s1.length)break;
  }
  if (!s1.length) return '未来15分钟内无全路径可行的加开及回段时隙';
  const t1 = addTo(trips, dir, 'extra', ex, to, s1, true, 'adhoc');
  const t2 = addTo(trips, back, 'extra', to, en, s2, true, 'adhoc');
  const b: Block = { id: plan.blocks.length, svc: '', start: { kind: 'depot', depot, time: 0 }, end: { kind: 'depot', depot }, trips: [t1.id, t2.id] };
  t1.block = t2.block = b.id;
  b.start = { kind: 'depot', depot, time: depotStartTime(ctx, depot, t1) };
  plan.blocks.push(b);
  const maxSvc = Math.max(0, ...plan.blocks.filter((x) => x.svc).map((x) => parseInt(x.svc, 10)));
  numberPlan(plan, maxSvc + 1);
  plan.fleetPeak = fleetPeak(plan);
  return b;
}

// ---------------------------------------------------------------- turnback & tasks

export type Turnback = { kind: 'rear'; berths: number[] } | { kind: 'front'; arrBerth: number; depBerth: number };

/** how a train arriving at `station` travelling `arrDir` can reverse there */
export function turnbackAt(topo: Topology, station: number, arrDir: TrackDir): Turnback | null {
  const s = topo.stations[station];
  // a berth serves arrivals that keep their heading into it (eastbound berths for DN)
  const rear = s.turnbackBerths.filter((bid) => {
    const b = topo.berths[bid];
    const l = topo.links[b.link];
    const east = (l.chainB - l.chainA) * b.dir > 0;
    return arrDir === 'DN' ? east : !east;
  });
  if (rear.length) return { kind: 'rear', berths: rear };
  if (s.frontTurnback[arrDir]) {
    // arrive on the opposite platform against its normal direction
    const opp = arrDir === 'DN' ? s.platforms.UP : s.platforms.DN;
    const travel = arrDir === 'DN' ? 1 : -1;
    const arrBerth = topo.berths.find((b) => b.platform === opp && b.dir === travel)!.id;
    const depBerth = topo.berths.find((b) => b.platform === opp && b.dir !== travel)!.id;
    return { kind: 'front', arrBerth, depBerth };
  }
  return null;
}

export function platformBerth(topo: Topology, station: number, dir: TrackDir): number {
  const s = topo.stations[station];
  const p = dir === 'DN' ? s.platforms.DN : s.platforms.UP;
  const travel = dir === 'DN' ? 1 : -1;
  return topo.berths.find((b) => b.platform === p && b.dir === travel)!.id;
}

/** Existing depot leads may also serve as turnback tracks. Reserve the
 * other lead while a direct return needs one, in both tasks and validation. */
const DEPOT_TURN_CLEAR = 120;
function dutyTurnBerths(topo: Topology, plan: Plan, block: Block, arrival: Trip, departure: Trip, plannedMoves?: YardMove[]): number[] {
  const turn = turnbackAt(topo, arrival.to, arrival.dir);
  if (turn?.kind !== 'rear') return [];
  let berths = turn.berths;
  const hot = hotStandbyPlaces(topo).find(p => p.station === arrival.to);
  if (hot?.depot && !arrival.standby) {
    const busy = plan.blocks.some(b => b.id !== block.id && b.trips.some((id, i) => {
      const a = plan.trips[id], d = plan.trips[b.trips[i + 1]];
      return !a.cancelled && a.standby && a.to === arrival.to && d && !d.cancelled
        && a.stops.at(-1)!.arr < departure.stops[0].dep && d.stops[0].dep > arrival.stops.at(-1)!.arr;
    }));
    if (busy) berths = berths.filter(b => topo.berths[b].link !== topo.berths[hot.berth].link);
  }
  if (!berths.some(berth => topo.depots.some(yard => yard.transferPaths.some(path => path.flow === 'shared'
    && path.stub === topo.berths[berth].link)))) return berths;
  const moves = plannedMoves ?? depotMoves(plan.blocks, plan.trips, { topo });
  const clear = berths.filter(berth => !moves.some(move => move.block !== block.id
    && turnLeadConflict(topo, move, plan.trips, arrival, departure, berth)));
  // Keep an infeasible choice visible to validation rather than substituting
  // an unmodelled route or silently dropping the duty.
  if (clear.length) berths = clear;
  return berths;
}

/** One resource rule for turnback choice, duty matching and validation. */
function turnLeadConflict(topo: Topology, move: YardMove, trips: readonly Trip[], arrival: Trip, departure: Trip, berth: number): boolean {
  if (move.link === undefined || !move.window || move.trip === undefined) return false;
  const [start, clear] = move.window;
  const from = arrival.stops.at(-1)!.arr, to = departure.stops[0].dep;
  if (topo.berths[berth].link === move.link && from < clear - .001 && start < to - .001) return true;
  const moving = trips[move.trip], yard = topo.depots[move.depot];
  return move.delta > 0 && !yard.portals.entry[moving.dir].reverse
    && moving.to === arrival.to && moving.dir === arrival.dir && from < moving.stops.at(-1)!.arr
    && Math.abs(moving.stops.at(-1)!.arr - to) < DEPOT_TURN_CLEAR
    && returnSharesTurnExit(topo, move.depot, moving, departure, berth);
}

/** Check the actual interlocking sections. SHR2 -> DN and UP -> SHR1 are
 * disjoint straight routes (layout PDF); SHR1 -> DN crosses that return.
 * Keep the existing clearance whenever routes overlap or are unknown. */
function returnSharesTurnExit(topo: Topology, depot: number, incoming: Trip, outgoing: Trip, berth: number): boolean {
  const yard = topo.depots[depot];
  if (!yard) return true;
  const entryStub = yard.transferPaths[yard.portals.entry[incoming.dir].path].stub;
  const tail = topo.links[topo.berths[berth].link];
  const head = topo.berths[berth].dir === 1 ? tail.a : tail.b;
  const platform = topo.platforms[topo.stations[outgoing.from].platforms[outgoing.dir]].link;
  const entries = topo.routes.filter(route => route.steps.at(-1)?.link === entryStub && topo.links[route.steps[0].link].track === incoming.dir);
  const exits = topo.routes.filter(route => topo.signals[route.start].node === head && route.end >= 0 && topo.signals[route.end].link === platform);
  if (!entries.length || !exits.length) return true;
  return entries.some(entry => exits.some(exit => entry.sections.some(section => exit.sections.includes(section))
    || entry.switches.some(point => exit.switches.some(other => other.sw === point.sw))));
}

/** Task list for a block (from its first trip). */
/** Where a passenger on `trip` is carried: a trip that runs through its last
 * station without stopping (an opening feeder, D73) goes on as its block's next
 * trip in the same direction, so destination displays name that trip's end. */
export function serviceEnd(plan: Pick<Plan, 'trips' | 'blocks'>, trip: Trip): number {
  for (let k = 0; k < 8 && trip.stops.at(-1)?.stop === false; k++) {
    const block = plan.blocks[trip.block];
    if (!block) break;
    const next = block.trips.slice(block.trips.indexOf(trip.id) + 1).map(id => plan.trips[id]).find(t => !t.cancelled);
    if (!next || next.dir !== trip.dir || next.from !== trip.to || !next.revenue) break;
    trip = next;
  }
  return trip.to;
}

export function blockTasks(topo: Topology, plan: Plan, block: Block, fromTrip = 0): Task[] {
  const tasks: Task[] = [];
  const ids = block.trips.slice(fromTrip);
  for (let k = 0; k < ids.length; k++) {
    const trip = plan.trips[ids[k]];
    if (trip.cancelled) continue;
    const fromDepot = k === 0 && block.start.kind === 'depot' && fromTrip === 0;
    if (fromDepot && block.start.kind === 'depot') portalExitTasks(topo, block.start.depot, trip, tasks);
    const first = tasks.length;
    tripTasks(topo, trip, tasks, fromDepot);
    // An explicit overnight berth fixes the departure platform as well as
    // the train's initial position (GLL middle track versus DN main).
    if (k === 0 && fromTrip === 0 && block.start.kind === 'stable' && block.start.berth !== undefined) {
      const departure = tasks.slice(first).find((t): t is StopTask => t.k === 'stop');
      if (departure && topo.berths[block.start.berth].kind === 'platform') departure.berth = block.start.berth;
    }
    // an overnight train comes out of its stabling place shortly before its
    // first departure, not as soon as the day starts (D72)
    if (k === 0 && fromTrip === 0 && block.start.kind === 'stable') {
      const departure = tasks.slice(first).find((t): t is StopTask => t.k === 'stop');
      if (departure) departure.stabledOut = true;
    }
    // after a hot standby: its departure stop (D70)
    const before = block.trips.slice(0, fromTrip + k).map((i) => plan.trips[i]).filter((t) => !t.cancelled).at(-1);
    const dep = tasks.slice(first).find((t): t is StopTask => t.k === 'stop');
    if (before?.standby && dep) dep.standby = true;
    const next = ids.slice(k + 1).map((i) => plan.trips[i]).find((t) => !t.cancelled);
    if (next) {
      if (next.dir !== trip.dir) {
        const hot = trip.standby && hotStandbyPlaces(topo).find(p => p.station === trip.to && p.depot);
        const berth = hot && storageArrivalBerth(topo, hot.berth, trip.dir);
        if (berth !== undefined && berth !== false) {
          tasks.push({ k: 'reverse', berths: [berth], chosen: berth, station: trip.to, minTime: 40 });
        } else addTurnback(topo, trip, tasks);
        const reverse = tasks.at(-1);
        if (!hot && reverse?.k === 'reverse') {
          const berths = dutyTurnBerths(topo, plan, block, trip, next);
          if (berths.length) { reverse.berths = berths; reverse.chosen = berths[0]; }
        }
      }
    }
    else if (block.end.kind === 'depot') depotTasks(topo, block.end.depot, trip.dir, tasks);
    else if (block.end.kind === 'stable') {
      if (block.end.berth !== undefined) {
        if (topo.berths[block.end.berth].kind === 'platform') retargetArrival(tasks, trip.to, block.end.berth);
        tasks.push({ k: 'stable', berth: block.end.berth, reason: '存车', station: trip.to });
        continue;
      }
      const tb = turnbackAt(topo, trip.to, trip.dir);
      if (tb && tb.kind === 'rear' && !tailTasks(topo, plan, block, trip, tasks)) tasks.push({ k: 'stable', berth: -1, reason: '存车', station: trip.to });
    }
  }
  return tasks;
}

/**
 * The first trains stabled overnight at a terminal with a storage tail
 * (蟠祥路下行尾轨) go on into it, the first deepest: it is entered only from
 * the departure platform, so the train turns through a turnback track, changes
 * ends again on the departure platform and sets back into the tail. The last
 * ones stay in the turnback tracks, which they would otherwise block.
 * false: this train stays in a turnback track.
 */
function tailTasks(topo: Topology, plan: Plan, block: Block, trip: Trip, tasks: Task[]): boolean {
  const st = topo.stations[trip.to];
  const tb = turnbackAt(topo, trip.to, trip.dir);
  if (!st.storageBerths.length || tb?.kind !== 'rear') return false;
  const lastArr = (b: Block) => plan.trips[b.trips.filter((id) => !plan.trips[id].cancelled).at(-1)!].stops.at(-1)!.arr;
  const ending = plan.blocks.filter((b) => b.end.kind === 'stable' && b.end.station === trip.to && b.trips.some((id) => !plan.trips[id].cancelled))
    .sort((a, b) => lastArr(a) - lastArr(b));
  const rank = ending.indexOf(block);
  if (rank < 0 || rank >= Math.min(st.storageBerths.length, ending.length - st.turnbackBerths.length)) return false;
  const plat = platformBerth(topo, trip.to, trip.dir === 'DN' ? 'UP' : 'DN');
  tasks.push({ k: 'reverse', berths: tb.berths, chosen: tb.berths[0], station: trip.to, minTime: 40 });
  tasks.push({ k: 'stop', berth: plat, station: trip.to, trip: -1, arr: null, dep: null, doors: false, revenue: false, note: '入尾轨换端' });
  tasks.push({ k: 'reverse', berths: [plat], chosen: plat, station: trip.to, minTime: 40 });
  tasks.push({ k: 'stable', berth: st.storageBerths[st.storageBerths.length - 1 - rank], reason: '存车' });
  return true;
}

/** A move out of the depot reaching its first platform against the trip's
 * direction stops there and changes ends before the trip starts. */
function portalExitTasks(topo: Topology, depot: number, trip: Trip, tasks: Task[]) {
  const p = topo.depots[depot].portals.exit[trip.dir];
  if (!p.reverse) return;
  const plat = topo.stations[p.station].platforms[trip.dir];
  const travel = trip.dir === 'DN' ? 1 : -1;
  const berth = topo.berths.find((b) => b.platform === plat && b.dir !== travel)!.id;
  tasks.push({ k: 'stop', berth, station: p.station, trip: trip.id, arr: null, dep: null, doors: false, revenue: false, note: '出段换端' });
  tasks.push({ k: 'reverse', berths: [berth], chosen: berth, station: p.station, minTime: 40 });
  // then stand at the platform in the trip's direction (as after a station-front
  // turnback) unless the trip itself stops there first
  const first = trip.stops[0];
  if (!(first.st === p.station && first.stop)) {
    const dep = trip.stops.find((x) => x.st === p.station)?.dep ?? first.dep;
    tasks.push({ k: 'stop', berth: platformBerth(topo, p.station, trip.dir), station: p.station, trip: trip.id, arr: null, dep, doors: false, revenue: false, note: '出段换端' });
  }
}

/** Into `depot` after running `dir`: where the leads are entered against that
 * direction the train first changes ends on the junction station's platform. */
export function depotTasks(topo: Topology, depot: number, dir: TrackDir, tasks: Task[]) {
  const p = topo.depots[depot].portals.entry[dir];
  if (p.reverse) {
    const berth = platformBerth(topo, p.station, dir);
    const last = tasks[tasks.length - 1];
    if (!(last?.k === 'stop' && last.station === p.station && last.berth === berth)) {
      tasks.push({ k: 'stop', berth, station: p.station, trip: -1, arr: null, dep: null, doors: false, revenue: false, note: '回段换端' });
    }
    tasks.push({ k: 'reverse', berths: [berth], chosen: berth, station: p.station, minTime: 40 });
  }
  tasks.push({ k: 'depot', depot, berth: topo.depots[depot].entryBerths[p.path] });
}

export function tripTasks(topo: Topology, trip: Trip, tasks: Task[], fromDepot: boolean) {
  for (let i = 0; i < trip.stops.length; i++) {
    const s = trip.stops[i];
    if (!s.stop) continue;
    const isFirst = i === 0;
    tasks.push({
      k: 'stop', berth: platformBerth(topo, s.st, trip.dir), station: s.st, trip: trip.id,
      arr: isFirst && !fromDepot ? null : s.arr, dep: i === trip.stops.length - 1 ? null : s.dep,
      doors: trip.revenue, revenue: trip.revenue, ...(s.noBoard ? { noBoard: true } : {}),
    });
  }
}

export function addTurnback(topo: Topology, trip: Trip, tasks: Task[]) {
  const tb = turnbackAt(topo, trip.to, trip.dir);
  if (!tb) return;
  if (tb.kind === 'rear') {
    // a platform turnback track (广兰路 middle track): set down there, not on the main
    if (topo.berths[tb.berths[0]].kind === 'platform') retargetArrival(tasks, trip.to, tb.berths[0]);
    tasks.push({ k: 'reverse', berths: tb.berths, chosen: tb.berths[0], station: trip.to, minTime: 40 });
  } else {
    // station-front: retarget the arrival stop to the opposite platform
    retargetArrival(tasks, trip.to, tb.arrBerth);
    tasks.push({ k: 'reverse', berths: [tb.arrBerth], chosen: tb.arrBerth, station: trip.to, minTime: 40 });
  }
}

function retargetArrival(tasks: Task[], station: number, berth: number) {
  for (let i = tasks.length - 1; i >= 0; i--) {
    const t = tasks[i];
    if (t.k === 'stop' && t.station === station) { t.berth = berth; break; }
  }
}

/** A train that reversed at a platform berth departs from that platform: the
 * berth facing its new direction on the same platform, if it differs from the
 * planned one (广兰路 middle track instead of the UP main). */
export function departureBerthAfterReverse(topo: Topology, reversedAt: number, planned: number): number {
  const b = topo.berths[reversedAt];
  if (b.kind !== 'platform' || topo.berths[planned].platform === b.platform) return planned;
  return topo.berths.find((x) => x.platform === b.platform && x.dir !== b.dir)?.id ?? planned;
}

// ---------------------------------------------------------------- validation

export interface PlanIssue {
  /** Whole-day yard aggregates compare by yard and magnitude, never display text/time. */
  depot?: number;
  delta?: number;
  /** Exact interval for resolving timing conflicts; text is rounded for display. */
  gap?: number;
  /** Circulations contributing to this conflict; used by pure overlay fitting. */
  blocks?: number[];
  severity: 'error' | 'warn';
  code: 'SERVICE_STRUCTURE' | 'TURN_SHORT' | 'TURN_UNAVAILABLE' | 'BLOCK_BREAK' | 'TERMINAL_FULL' | 'TAIL_ORDER' | 'FRONT_CONFLICT' | 'LAYOVER_LONG' | 'DEPOT_CONFLICT' | 'HEADWAY' | 'FLEET' | 'TIME_ORDER' | 'UNASSIGNED' | 'STABLE_CONFLICT' | 'TURN_HEADWAY' | 'YARD_CAPACITY' | 'YARD_BALANCE' | 'POSSESSION';
  t: number;
  text: string;
}

/** shortest turnback the line can do (s): P1 table 1, CBTC 115–120 s */
/** shortest station headway (s), a hard planning limit: P1 table 1, CBTC
 *  design headway ≤ 90 s. The headways the templates aim for (D50) are wider. */
const MIN_HEADWAY = 90;

/** A front turn occupies the opposite platform from arrival to departure.
 * Its timetable slot must protect normal-direction arrivals through that
 * platform as well as the incoming train's own departure stream. */
function frontTurnClear(ctx: PlanContext, trips: readonly Pick<Trip, 'id' | 'dir' | 'stops' | 'cancelled'>[], arrival: Pick<Trip, 'dir' | 'to' | 'stops'>, departure: number, excluded: Set<number>): boolean {
  if (turnbackAt(ctx.topo, arrival.to, arrival.dir)?.kind !== 'front') return true;
  const arr = arrival.stops.at(-1)!.arr;
  return !trips.some(trip => !trip.cancelled && !excluded.has(trip.id) && trip.dir !== arrival.dir
    && trip.stops.some(stop => stop.st === arrival.to && stop.dep > arr - MIN_HEADWAY && stop.arr < departure + MIN_HEADWAY));
}

/** A single rear turnback dispatches its trains in arrival order (TAIL_ORDER):
 * may a train stand in it over [from, to) among the others in `occ`? */
function tailOrderClear(topo: Topology, st: number, occ: { from: number; to: number; block?: number }[], from: number, to: number, own?: number): boolean {
  if (topo.stations[st].turnbackBerths.length !== 1) return true;
  return occ.every(o => o.block === own || !(o.from < from && o.to > to + .01) && !(o.from > from && o.to < to - .01));
}

/** time a train held on a line end's arrival platform needs to move on
 *  into the turnback track once a place there is free */
const HOLD_CLEAR = 120;

/**
 * Moments a terminal holds more trains than it can. TERMINAL_CAP keeps the
 * arrival platform free; at a line end (every train arriving there
 * terminates) one more may stand on it, provided the next arrival comes
 * HOLD_CLEAR after a place has freed up for it.
 */
export function terminalOverflows(topo: Topology, st: number, list: { from: number; to: number }[]): { t: number; cur: number; cap: number }[] {
  const cap = TERMINAL_CAP[st] ?? (topo.stations[st].turnbackBerths.length || 1);
  const lineEnd = st === 0 || st === topo.stations.length - 1;
  const evs = list.flatMap((o) => [[o.from, 1], [o.to, -1]] as [number, number][]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: { t: number; cur: number; cap: number }[] = [];
  let cur = 0;
  let held = -Infinity; // when the train held on the arrival platform can move on
  for (const [t, dlt] of evs) {
    if (dlt > 0 && lineEnd && (cur > cap || (cur === cap && t < held))) out.push({ t, cur: cur + 1, cap });
    cur += dlt;
    if (!lineEnd && cur > cap) out.push({ t, cur, cap });
    if (lineEnd && dlt < 0 && cur === cap) held = t + HOLD_CLEAR;
  }
  return out;
}

/** time intervals trains spend turning back / laying over at each station (between two trips in opposite directions) */
export function terminalOccupancy(plan: Plan, topo?: Topology): Map<number, { from: number; to: number; block: number; arrival?: number; departure?: number; berths?: number[] }[]> {
  const occ = new Map<number, { from: number; to: number; block: number; arrival?: number; departure?: number; berths?: number[] }[]>();
  const moves = topo ? depotMoves(plan.blocks, plan.trips, { topo }) : undefined;
  for (const b of plan.blocks) {
    const ts = b.trips.map((i) => plan.trips[i]).filter((t) => !t.cancelled);
    for (let i = 0; i + 1 < ts.length; i++) {
      const a = ts[i];
      const d = ts[i + 1];
      if (a.to !== d.from || a.dir === d.dir) continue;
      if (!occ.has(a.to)) occ.set(a.to, []);
      occ.get(a.to)!.push({ from: a.stops[a.stops.length - 1].arr, to: d.stops[0].dep, block: b.id,
        arrival: a.id, departure: d.id, ...(topo ? { berths: dutyTurnBerths(topo, plan, b, a, d, moves) } : {}) });
    }
  }
  return occ;
}

/** The overnight berth reservations of one duty: a stabled start holds its
 * berth from the start of the day to its first departure, a stabled end from
 * its last arrival to the next day's start (none after an actual withdrawal).
 * The one definition behind the turnback, storage and platform calendars. */
function overnightHolds(block: Block, live: readonly Trip[]) {
  const out: { station: number; berth: number; from: number; to: number; morning: boolean }[] = [];
  if (!live.length) return out;
  if (block.start.kind === 'stable' && block.start.berth !== undefined)
    out.push({ station: block.start.station, berth: block.start.berth, from: OPENING.dayStart, to: live[0].stops[0].dep, morning: true });
  if (!block.withdrawal && block.end.kind === 'stable' && block.end.berth !== undefined)
    out.push({ station: block.end.station, berth: block.end.berth, from: live.at(-1)!.stops.at(-1)!.arr, to: OPENING.dayStart + 86400, morning: false });
  return out;
}

const liveTrips = (plan: Plan, block: Block) => block.trips.map(id => plan.trips[id]).filter(t => !t.cancelled);

/** Include the morning/evening reservations of fixed rear-track berths in
 * the same capacity calendar used to choose added-service turnbacks. */
function turnbackOccupancy(topo: Topology, plan: Plan) {
  const occ = terminalOccupancy(plan);
  for (const block of plan.blocks) for (const hold of overnightHolds(block, liveTrips(plan, block))) {
    if (!topo.stations[hold.station].turnbackBerths.some(b => topo.berths[b].link === topo.berths[hold.berth].link)) continue;
    if (!occ.has(hold.station)) occ.set(hold.station, []);
    occ.get(hold.station)!.push({ from: hold.from, to: hold.to, block: block.id });
  }
  return occ;
}

/** Main-platform overnight stock also protects through and feeder moves;
 * a rear-platform arrival branches off before the main platform. */
function storedPlatformsClear(topo: Topology, plan: Plan, trip: Pick<Trip,'dir'|'to'|'stops'>, arrivalBerth?: number, only?: Block) {
  for (const block of only ? [only] : plan.blocks) {
    if (block.withdrawal) continue;
    for (const hold of overnightHolds(block, liveTrips(plan, block))) {
      // (a headway's margin after the morning departure / before the evening arrival)
      const from = hold.morning ? hold.from : hold.from - MIN_HEADWAY, to = hold.morning ? hold.to + MIN_HEADWAY : hold.to;
      const berth=topo.berths[hold.berth];
      if (berth.kind!=='platform' || berth.platform!==topo.stations[hold.station].platforms[trip.dir]) continue;
      const stop=trip.stops.find(s=>s.st===hold.station);
      if (!stop) continue;
      if (trip.to===hold.station && arrivalBerth!==undefined && topo.berths[arrivalBerth].platform!==berth.platform) continue;
      if (stop.dep>=from && stop.arr<to) return false;
    }
  }
  return true;
}

/** Physical storage reservations shared by overnight trains and hot spares.
 * Opposite-heading berths on the same link are one slot. */
export function storageOccupancy(topo: Topology, plan: Plan) {
  const out: { link: number; station: number; from: number; to: number; block: number }[] = [];
  const add = (berth: number, from: number, to: number, block: number) => {
    const b = topo.berths[berth];
    out.push({ link: b.link, station: b.station, from, to, block });
  };
  const hotPlaces = hotStandbyPlaces(topo);
  for (const b of plan.blocks) {
    const ts = liveTrips(plan, b);
    for (const hold of overnightHolds(b, ts)) add(hold.berth, hold.from, hold.to, b.id);
    for (let i = 0; i + 1 < ts.length; i++) {
      const a = ts[i], d = ts[i + 1];
      if (a.to !== d.from || a.dir === d.dir) continue;
      const hot = a.standby && hotPlaces.find(p => p.station === a.to);
      // Multiple rear tracks are assigned at runtime. Aggregate capacity is
      // checked by terminalOccupancy; only a fixed/single slot is reserved here.
      const rear = topo.stations[a.to].turnbackBerths;
      const berth = hot && hot.depot ? hot.berth : rear.length === 1 ? rear[0] : undefined;
      if (berth !== undefined) add(berth, a.stops.at(-1)!.arr, d.stops[0].dep, b.id);
    }
  }
  return out;
}

/** departure times per station and direction, for headway checks while trips are added */
export class DepIndex {
  private m = new Map<string, number[]>();
  constructor(trips: Iterable<Pick<Trip, 'dir' | 'stops' | 'cancelled'> & { block?: number }>) { for (const t of trips) this.add(t); }
  add(t: Pick<Trip, 'dir' | 'stops' | 'cancelled'> & { block?: number }) {
    if (t.cancelled || t.block === UNUSED_DEPOT_MOVE) return;
    for (const p of t.stops) {
      const k = `${p.st}${t.dir}`;
      let a = this.m.get(k);
      if (!a) { a = []; this.m.set(k, a); }
      let i = a.length;
      while (i > 0 && a[i - 1] > p.dep) i--;
      a.splice(i, 0, p.dep);
    }
  }
  /** no other train departs / passes within the minimum headway at any stop */
  clear(stops: PlanStop[], dir: TrackDir, h = MIN_HEADWAY, except?: PlanStop[]): boolean {
    for (const p of stops) {
      const a = this.m.get(`${p.st}${dir}`);
      if (!a) continue;
      let lo = 0, hi = a.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] <= p.dep - h) lo = mid + 1; else hi = mid; }
      let ignored = false;
      const own = except?.find(s => s.st === p.st)?.dep;
      while (lo < a.length && a[lo] < p.dep + h) {
        if (!ignored && own !== undefined && a[lo] === own) { ignored = true; lo++; }
        else return false;
      }
    }
    return true;
  }
}

/**
 * Feasibility check of a plan (运行图校验): block continuity and turn times,
 * terminal occupancy, station headways, stop-time order and fleet size.
 * Errors make the plan infeasible for the signalling model; warnings are
 * tight but workable.
 */
export function validatePlan(ctx: PlanContext, plan: Plan, checkDepotStock = true, allHeadways = false): PlanIssue[] {
  const { topo } = ctx;
  const out: PlanIssue[] = [...(generationIssues.get(plan) ?? [])];
  const name = (st: number) => STATIONS[st].name;
  const live = plan.trips.filter((t) => !t.cancelled);
  const storage = storageOccupancy(topo, plan);
  for (let i = 0; i < storage.length; i++) for (let j = i + 1; j < storage.length; j++) {
    const a = storage[i], b = storage[j];
    if (a.link === b.link && a.block !== b.block && a.from < b.to - .001 && b.from < a.to - .001)
      out.push({ severity: 'error', code: 'STABLE_CONFLICT', t: Math.max(a.from, b.from), blocks: [a.block, b.block],
        text: `${name(a.station)} 同一存车泊位的过夜、热备或折返占用重叠` });
  }
  if (checkDepotStock) {
    const ledger = depotLedger(topo, plan);
    for (const [depot, yard] of topo.depots.entries()) {
      if (ledger.peak[depot] > yard.capacity)
        out.push({ severity: 'error', code: 'YARD_CAPACITY', t: ledger.peakAt[depot], depot, delta: ledger.peak[depot] - yard.capacity,
          text: `${yard.name} 库存峰值 ${ledger.peak[depot]} 列，超过库位 ${yard.capacity} 列` });
      if (ledger.final[depot] !== ledger.initial[depot])
        out.push({ severity: 'error', code: 'YARD_BALANCE', t: ledger.events.at(-1)?.time ?? OPENING.dayStart, depot, delta: ledger.final[depot] - ledger.initial[depot],
          text: `${yard.name} 夜间库存 ${ledger.final[depot]} 列，次日早晨需 ${ledger.initial[depot]} 列（含备车）` });
    }
  }
  // Line stabling (正线存车) must hold as many trains at night as leave it in
  // the morning, or the next day starts a train short.
  const overnight = new Map<string, number>();
  for (const place of OPERATIONS.overnightStabling) overnight.set(place.station, (overnight.get(place.station) ?? 0) + place.count);
  for (const [id, n] of overnight) {
    const st = STATIONS.findIndex(x => x.id === id);
    const night = plan.blocks.filter(b => !b.withdrawal && b.end.kind === 'stable' && b.end.station === st).length;
    const morning = plan.blocks.filter(b => b.start.kind === 'stable' && b.start.station === st).length;
    if (night !== n || morning !== n)
      out.push({ severity: 'warn', code: 'FLEET', t: OPENING.dayStart, blocks: [], text: `${name(st)} 正线存车 ${n} 列：夜间入位 ${night} 列，早晨出车 ${morning} 列` });
  }
  // Explicit overnight stabling on a main platform reserves that track from
  // the evening arrival through the following day's departure. Check both
  // today's early movements and tomorrow's via a 24-hour shift, empty or not.
  for (const block of plan.blocks) {
    if (block.withdrawal || block.end.kind !== 'stable' || block.end.berth === undefined) continue;
    const berth = topo.berths[block.end.berth];
    if (berth.platform !== topo.stations[block.end.station].platforms.DN) continue;
    const station = block.end.station;
    const stableBerth = block.end.berth;
    const last = block.trips.map(id => plan.trips[id]).filter(t => !t.cancelled).at(-1)!;
    if (!last) continue;
    const arrived = last.stops.at(-1)!.arr;
    const morning = plan.blocks.find(b => b.start.kind === 'stable' && b.start.station === station && b.start.berth === stableBerth);
    const first = morning?.trips.map(id => plan.trips[id]).find(t => !t.cancelled);
    const departure = first?.stops[0].dep ?? OPENING.guanglanEast;
    for (const trip of live) {
      if (trip.dir !== 'DN' || trip === last || trip === first) continue;
      const stop = trip.stops.find(s => s.st === station);
      // A DN positioning trip ending on the middle track uses the west
      // throat and never passes/occupies the DN main platform.
      const duty = plan.blocks[trip.block];
      const next = duty && plan.trips[duty.trips[duty.trips.indexOf(trip.id) + 1]];
      if (trip.to === station && duty?.end.kind === 'stable' && duty.end.berth !== undefined
        && duty.trips.filter(id=>!plan.trips[id].cancelled).at(-1)===trip.id
        && topo.berths[duty.end.berth].platform!==berth.platform) continue;
      if (trip.to === station && next?.dir === 'UP' && turnbackAt(topo, station, 'DN')?.kind === 'rear') continue;
      if (stop && (stop.dep >= arrived - MIN_HEADWAY || stop.arr < departure + MIN_HEADWAY))
        out.push({ severity: 'error', code: 'STABLE_CONFLICT', t: stop.arr, blocks: [block.id, trip.block], text: `${name(station)} 下行正线存车与 ${trip.no}（${trip.revenue ? '载客' : '空驶'}）冲突` });
    }
  }
  for (const t of live) {
    if (t.block < 0 && t.revenue) out.push({ severity: 'error', code: 'UNASSIGNED', t: t.stops[0].dep, text: `车次 ${t.no} 未分配车底` });
    for (let i = 0; i < t.stops.length; i++) {
      const s = t.stops[i];
      const prev = t.stops[i - 1];
      if (s.dep < s.arr || (prev && s.arr < prev.dep)) { out.push({ severity: 'error', code: 'TIME_ORDER', t: s.arr, text: `车次 ${t.no} 在 ${name(s.st)} 时刻倒序` }); break; }
    }
  }
  // blocks: continuity, turn time, terminal occupancy
  const occ = terminalOccupancy(plan, topo);
  for (const b of plan.blocks) {
    const ts = b.trips.map((i) => plan.trips[i]).filter((t) => !t.cancelled);
    for (let i = 0; i + 1 < ts.length; i++) {
      const a = ts[i];
      const d = ts[i + 1];
      const arr = a.stops[a.stops.length - 1].arr;
      const dep = d.stops[0].dep;
      if (a.to !== d.from) { out.push({ severity: 'error', code: 'BLOCK_BREAK', t: arr, text: `车底 ${b.svc}：${a.no} 终到 ${name(a.to)}，下一车次 ${d.no} 从 ${name(d.from)} 出发` }); continue; }
      const storedTurn = a.standby && hotStandbyPlaces(topo).some(p=>p.station===a.to&&p.depot
        &&storageArrivalBerth(topo,p.berth,a.dir)!==undefined);
      if (a.dir !== d.dir && !turnbackAt(topo,a.to,a.dir) && !storedTurn)
        out.push({severity:'error',code:'TURN_UNAVAILABLE',t:arr,blocks:[b.id],text:`${name(a.to)} 无${a.dir==='DN'?'下行':'上行'}到达换端条件（${a.no}→${d.no}）`});
      if (a.dir !== d.dir && dep - arr < minTurn(a.to) - 1e-6) out.push({ severity: 'error', code: 'TURN_SHORT', t: arr, text: `车底 ${b.svc} 在 ${name(a.to)} 折返仅 ${(dep - arr).toFixed(1)} s（${a.no}→${d.no}，最小 ${minTurn(a.to)} s）` });
      if (a.dir !== d.dir && !frontTurnClear(ctx, live, a, dep, new Set(ts.map(trip => trip.id))))
        out.push({severity:'error',code:'FRONT_CONFLICT',t:arr,blocks:[b.id],text:`${name(a.to)} 站前折返占用时段与正常方向列车冲突`});
      if (a.overlay && a.dir !== d.dir && a.to > 0 && a.to < topo.stations.length - 1 && dep-arr > minTurn(a.to)+450+.01)
        out.push({severity:'error',code:'LAYOVER_LONG',t:arr,blocks:[b.id],text:`${name(a.to)} 加开接续等待超过中间折返站能力`});
    }
  }
  for (const [st, list] of occ) {
    // A single rear turnback cannot dispatch its second arrival before its
    // first: the first would have to hold either the tail or the exit platform.
    if (topo.stations[st].turnbackBerths.length === 1) {
      const ordered = list.slice().sort((a,b) => a.from-b.from);
      for (let i=1;i<ordered.length;i++) if (ordered[i-1].to > ordered[i].to + .01)
        out.push({severity:'error',code:'TAIL_ORDER',t:ordered[i].from,blocks:[ordered[i-1].block,ordered[i].block],text:`${name(st)} 单一折返线到达次序与发车次序相反`});
    }
    // A platform turnback track is entered and left through one throat: the
    // next turning train arrives only after the previous one has left and
    // cleared it (OPERATIONS.platformTurnClear).
    const tb = topo.stations[st].turnbackBerths;
    const clear = OPERATIONS.platformTurnClear[STATIONS[st].id];
    if (clear !== undefined && tb.length === 1 && topo.berths[tb[0]].kind === 'platform') {
      const ordered = list.slice().sort((a,b) => a.from-b.from);
      for (let i=1;i<ordered.length;i++) {
        const gap = ordered[i].from - ordered[i-1].to;
        if (gap < clear - 1e-6) out.push({severity:'error',code:'TURN_HEADWAY',t:ordered[i].from,blocks:[ordered[i-1].block,ordered[i].block],
          text:`${name(st)} 站台折返线前车发车到后车到达仅 ${gap.toFixed(0)} s（最小 ${clear} s）`});
      }
    }
    let reported = -Infinity;
    for (const { t, cur, cap } of terminalOverflows(topo, st, list)) {
      if (t - reported <= 1800) continue;
      reported = t;
      const blocks = plan.blocks.filter(block => {
        const ts = block.trips.map(id => plan.trips[id]).filter(trip => !trip.cancelled);
        return ts.some((a,i) => { const d = ts[i+1]; return d && a.to === st && d.from === st && a.dir !== d.dir
          && a.stops.at(-1)!.arr <= t && d.stops[0].dep > t; });
      }).map(block => block.id);
      out.push({ severity: 'error', code: 'TERMINAL_FULL', t, blocks, text: `${name(st)} 同时折返/待发 ${cur} 列，超过能力 ${cap} 列` });
    }
  }
  const moves = depotMoves(plan.blocks, plan.trips, ctx).filter(move => move.link !== undefined && move.window);
  for (const inbound of moves.filter(move => move.delta > 0)) {
    for (const outbound of moves.filter(move => move.delta < 0)) {
      if (inbound.block === outbound.block || inbound.link !== outbound.link) continue;
      const [approach, clear] = inbound.window!, [start, end] = outbound.window!;
      if (start < clear && end > approach)
        out.push({ severity: 'error', code: 'DEPOT_CONFLICT', t: Math.max(approach, start), blocks: [inbound.block, outbound.block],
          text: `${topo.depots[inbound.depot].name} 回段接近与出段共用转换轨时隙冲突` });
    }
  }
  for (const move of moves) for (const holds of occ.values()) for (const hold of holds) {
    if (hold.block === move.block || hold.arrival === undefined || hold.departure === undefined) continue;
    const arrival = plan.trips[hold.arrival], departure = plan.trips[hold.departure], berth = hold.berths?.[0];
    if (berth === undefined || !turnLeadConflict(topo, move, plan.trips, arrival, departure, berth)) continue;
    const moving = plan.trips[move.trip!];
    out.push({ severity: 'error', code: 'DEPOT_CONFLICT', t: Math.max(move.window![0], hold.from), blocks: [move.block, hold.block],
      text: `${topo.depots[move.depot].name} ${moving.no} ${move.delta > 0 ? '回段' : '出段'}与 ${arrival.no}→${departure.no} 折返待发共用出入段线或咽喉冲突` });
  }
  // station headways per direction (passing / departing)
  for (const dir of ['DN', 'UP'] as TrackDir[]) {
    const byStation = new Map<number, { t: number; no: string; block: number }[]>();
    for (const t of live) {
      if (t.dir !== dir) continue;
      for (const s of t.stops) {
        const block = plan.blocks[t.block];
        const next = block && plan.trips[block.trips[block.trips.indexOf(t.id) + 1]];
        if (s === t.stops.at(-1) && next?.dir === t.dir && next.from === s.st) continue;
        if (!byStation.has(s.st)) byStation.set(s.st, []);
        byStation.get(s.st)!.push({ t: s.dep, no: t.no, block: t.block });
      }
    }
    for (const [st, list] of byStation) {
      list.sort((a, b) => a.t - b.t);
      let reported = -Infinity;
      for (let i = 1; i < list.length; i++) {
        const h = list[i].t - list[i - 1].t;
        if (h < MIN_HEADWAY && (allHeadways || list[i].t - reported > 1800)) {
          reported = list[i].t;
          // the design headway is the hard limit: a plan below it cannot run
          // to time (the operating headways the templates keep are far wider)
          out.push({ severity: 'error', code: 'HEADWAY', gap: h, t: list[i].t, blocks: [list[i-1].block,list[i].block], text: `${name(st)} ${dir === 'DN' ? '下行' : '上行'} ${list[i - 1].no}/${list[i].no} 间隔 ${Math.round(h)} s（最小 ${MIN_HEADWAY} s）` });
        }
      }
    }
  }
  if (plan.fleetPeak > LINE_INFO.fleet) out.push({ severity: 'error', code: 'FLEET', t: 0, text: `用车 ${plan.fleetPeak} 列，超过配属 ${LINE_INFO.fleet} 列` });
  return out.sort((a, b) => a.t - b.t);
}
