/** Line-owned service tables and instructor fixtures; empty optional tables mean no such service. */
import type { DayType, TrackDir } from '../sim/model';
import type { Template, Period, OverlayPreset } from '../sim/timetable';
import type { ScenarioDef } from '../sim/scenario';
import type { SimulationExtras } from './simulationExtras';

export interface ClockBand { from: number; to: number; value: number; valueTo?: number }
export interface ServiceData {
  openingUp?: { at: number; headway: number; template: string; label: string };
  denseUp?: number;
  openingDn?: { to: number; headway: number }[];
  peaks: Record<string, { DN?: number; UP?: number; upEnd?: number }>;
  overrides: (Period & { dir: TrackDir })[];
  openingSupplements: { from: number; to: number; headway: number; terminal: string }[];
  shortClose?: number;
  carryingClose?: { from: number; to: number };
  lateHeadway: number;
  standby: { from: number; need: number; to: number }[];
}
export interface TimetableData {
  diagnostics?: {
    firstLastLabels?: [string, string, string];
    gaode?: { directory: string; checks: [string, TrackDir][]; windows: [number, number][]; reference: { stations: string[]; from: number; to: number } };
  };
  /** Common timing reference inside the core; absence retains terminal references. */
  reference?: Partial<Record<TrackDir, string>>;
  /** Depot positioning follows stopping timings without taking passengers. */
  positioningRevenue?: boolean;
  /** Keep every scheduled passenger origin and destination through circulation. */
  preserveRevenueRoutes?: boolean;
  templates: Record<string, Template>;
  dayPeriods: Record<DayType, Period[]>;
  shownPeriods: Record<DayType, Period[]>;
  dwellBands: Record<DayType, ClockBand[]>;
  runBands: Record<DayType, ClockBand[]>;
  serviceData: Record<DayType, ServiceData>;
  opening: { outerAlternation: number; stockUntil: number; redirectFrom: number; emptyFeedersFrom: number; feederUntil: number; stableUntil: number; dayStart: number; defaultStableDeparture: number };
  outerBandMargin: number;
  overlays: OverlayPreset[];
  terminals: {
    core: [string, string]; insertOrigin?: string; overflowWithdrawal?: string; circulate: string[];
    depot: Record<string, string>; capacity: Record<string, number>; maxPresent: Record<string, number>;
  };
  firstOrigins: { dir: TrackDir; from: string; to: string; dep: number; checkpoint?: { station: string; dep: number }; runAdjustS?: number }[];
  openingGuards: { station: string; dir: TrackDir; until: number }[];
  closingDepotMoves: { station: string; dir: TrackDir; depot: string }[];
  /** Public calibration diagnostic, retained for existing tooling. */
  firstTrainRunAdjust: Record<string, number>;
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
