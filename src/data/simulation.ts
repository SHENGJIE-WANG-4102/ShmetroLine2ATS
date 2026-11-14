/** Line-owned service tables and instructor fixtures; empty optional tables mean no such service. */
import type { DayType, TrackDir, TripKind } from '../sim/model';
import type { Template, Period, OverlayPreset } from '../sim/timetable';
import type { ScenarioDef } from '../sim/scenario';
import type { SimulationExtras } from './simulationExtras';

export interface ClockBand { from: number; to: number; value: number; valueTo?: number }
export interface ServiceData {
  openingUp?: { at: number; headway: number; template: string; label: string };
  denseUp?: number;
  openingDn?: { to: number; headway: number }[];
  /** Reference departure wave starts, keyed by template; also supports nonpeak grids. */
  peaks: Record<string, { DN?: number; UP?: number; upEnd?: number }>;
  overrides: (Period & { dir: TrackDir })[];
  openingSupplements: { from: number; to: number; headway: number; terminal: string }[];
  shortClose?: number;
  carryingClose?: { from: number; to: number };
  lateHeadway: number;
  standby: { from: number; need: number; to: number }[];
}
export interface TimetableData {
  /** Soft costs for a future duty allocation; these do not forbid a movement. */
  duty?: { yardPreferences?: {
    exitDirections: { depot: string; direction: TrackDir; penalty: number }[];
    movements: { depot: string; kind: 'in' | 'out'; from: number; to: number; penalty: number }[];
  } };
  diagnostics?: {
    firstLastLabels?: [string, string, string];
    gaode?: { directory: string; checks: [string, TrackDir][]; windows: [number, number][];
      /** Where the evidence covers only part of the plan, report the excluded kinds explicitly. */
      excludeKinds?: { station: string; dir: TrackDir; from: number; to: number; kinds: TripKind[]; days?: DayType[] }[];
      reference?: { stations: string[]; from: number; to: number } };
  };
  /** Common timing reference inside the core; absence retains terminal references. */
  reference?: Partial<Record<TrackDir, string>>;
  /** Depot positioning follows stopping timings without taking passengers. */
  positioningRevenue?: boolean;
  /** Whether scheduled mainline stock moves must carry after opening. */
  carryMainlineMoves?: boolean;
  /** Keep every scheduled passenger origin and destination through circulation. */
  preserveRevenueRoutes?: boolean;
  templates: Record<string, Template>;
  dayPeriods: Record<DayType, Period[]>;
  shownPeriods: Record<DayType, Period[]>;
  dwellBands: Record<DayType, ClockBand[]>;
  runBands: Record<DayType, ClockBand[]>;
  /** Directed physical sections may use a different level within clock bands.
   * Missing sections and uncovered clocks retain runBands. Station IDs are data. */
  /** seconds a published last train runs faster than the planned physical run
   * between two adjacent stations (station ids), where the field runs were faster */
  lastTrainRunGain?: { from: string; to: string; s: number }[];
  sectionRunBands?: Partial<Record<DayType, { from: string; to: string;
    bands: (ClockBand & { allowanceS?: number })[] }[]>>;
  serviceData: Record<DayType, ServiceData>;
  opening: { outerAlternation: number; stockUntil: number; redirectFrom: number; emptyFeedersFrom: number; feederUntil: number; stableUntil: number; dayStart: number; defaultStableDeparture: number };
  outerBandMargin: number;
  overlays: OverlayPreset[];
  terminals: {
    /** the whole route (大交路), DN-ward; unset: the first and last station of the list */
    trunk?: [string, string];
    /** further through routes a template's pattern may name, DN-ward (a branch's whole route,
     * a second short route); each must pass the reference stations */
    routes?: Record<string, [string, string]>;
    core: [string, string]; insertOrigin?: string; overflowWithdrawal?: string; circulate: string[];
    /** the eastern line end balances its cars with the core by short and extended
     * service routes (截短/延伸交路, timetable.ts layoutService); unset: off */
    balanceRoutes?: boolean;
    depot: Record<string, string>; capacity: Record<string, number>; maxPresent: Record<string, number>;
  };
  firstOrigins: { dir: TrackDir; from: string; to: string; dep: number }[];
  openingGuards: { station: string; dir: TrackDir; until: number }[];
  closingDepotMoves: { station: string; dir: TrackDir; depot: string }[];
  /** Pre-service track patrols (巡道车): out of `depot` before the first trains, empty and
   * passing every station along `via` (changing ends at each inner station), then waiting at
   * the last one for the first departure there, which the car then works. */
  patrols?: { depot: string; via: string[] }[];
}

export type TrainWindow = { from: string; to: string; fromOffset?: number; toOffset?: number };
export type InstructorAction =
  | { kind: 'surge'; station: string; duration: number; multiplier: number }
  | { kind: 'depotExitSwitch'; depot: string; duration: number }
  | { kind: 'sidingMergeSwitch'; station: string; duration: number }
  | { kind: 'namedSwitch'; station: string; name: string; duration: number }
  | { kind: 'zone'; zone: number; duration: number }
  | { kind: 'train'; windows: TrainWindow[]; dir: TrackDir; fault: 'pecu' | 'trainFail'; duration?: number; recover?: boolean; noTrainMessage?: boolean }
  | { kind: 'weather'; wind?: number; rain?: boolean; duration: number }
  | { kind: 'possession'; station: string; until: number; message: string }
  | { kind: 'psd' | 'trackPerson' | 'startSignal'; station: string; dir: TrackDir; duration?: number }
  | { kind: 'axle'; from: string; to: string; dir: TrackDir; margin: number; duration: number }
  | { kind: 'extraPecu' }
  | { kind: 'log'; category: string; text: string }
  | { kind: 'closeStation'; station: string; alreadyText: string; text: string };
export interface InstructorEventData {
  id: string; name: string; category: string; windows: [number, number][]; probability: number;
  action: InstructorAction;
  steps?: { after: number; name: string; action: InstructorAction }[];
}
export interface SimulationData extends SimulationExtras {
  timetable: TimetableData;
  topology: { wrapAfter: string };
  instructor: { previousIds: Record<string, string>; events: InstructorEventData[]; scenarios: ScenarioDef[] };
}
