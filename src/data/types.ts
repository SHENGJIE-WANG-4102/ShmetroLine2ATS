import type { SimulationData } from './simulation';
import type { LineUiData, PisStyle } from './ui';

/** Shared schemas. Values and per-line evidence live under data/lines/. */
export interface SourceRef {
    id: string;
    title: string;
    url: string;
    used: string;
}
export interface StationData {
    opened?: boolean;
    pisLayout?: 'classic' | 'wide';
    /** this station's PIS hardware when it differs from the line's `ui.pisStyle` */
    pisStyle?: PisStyle;
    id: string;
    name: string;
    dmiName?: string;
    formerName?: string;
    interM: number | null;
    transfers: string[];
    dwell: number;
    demand: number;
    sidePlatform?: ('DN' | 'UP')[];
}
export type CrossoverKind = '/' | '\\';
export interface CrossoverDef {
    station: number;
    offset: number;
    kind: CrossoverKind;
}
export interface LeadDef {
    depot: string;
    flow?: 'in' | 'out';
}
export interface SidingDef {
    purpose?: 'interline';
    id: string;
    name: string;
    station: number;
    side: 'west' | 'east';
    at: number;
    length: number;
    connect?: 'both' | 'UP' | 'DN';
    lane?: SidingLane;
    turnback?: boolean;
    lead?: LeadDef;
    link?: {
        main: 'UP' | 'DN';
        at: number;
    };
}
export type SidingLane = 'mid' | 'midUP' | 'midDN' | 'outUP' | 'outDN';
export interface PairStubDef {
    link?: { main: 'UP' | 'DN'; at: number };
    id: string;
    name: string;
    length: number;
    turnback?: boolean;
    lead?: LeadDef;
}
export interface PairDef {
    id: string;
    station: number;
    side: 'west' | 'east';
    at: number;
    stubs: [
        PairStubDef,
        PairStubDef
    ];
}
export interface LoopDef {
    id: string;
    name: string;
    station: number;
    west: number;
    east: number;
    platform?: boolean;
}
export interface TailDef {
    station: number;
    side: 'west' | 'east';
    length: number;
    scissors?: boolean;
    turnback?: boolean;
}
export interface DepotDef {
    id: string;
    name: string;
    short: string;
    station: number;
    stablingTracks: number;
    work: {
        daily: boolean;
        monthly: boolean;
        overhaul: boolean;
    };
    capacity: number;
    exitTime: number;
    source: string;
}
export interface FixedRun {
    from: string;
    to: string;
    departures: number[];
    board: string[];
    alight: string[];
    depotFrom: string;
    depotTo: string;
}

export interface CoreLineData {
  SOURCES: SourceRef[];
  STATIONS: StationData[];
  STATION_EN: Record<string, string>;
  LINE_INFO: {
    cars?: number;
    name: string;
    shortName: string;
    color: number;
    colorCss: string;
    trainLength: number;
    platformLength: number;
    maxSpeedKmh: number;
    capacity: number;
    crushCapacity: number;
    fleet: number;
};
  FLEET_TYPES: {
    type: string;
    from: number;
    to: number;
    digits: 4 | 5;
    source: string;
}[];
  FLEET: {
    no: string;
    type: string;
    n: number;
}[];
  DIRECTIONS: {
    readonly DN: {
        readonly label: string;
        readonly towards: string;
        readonly prefix: string;
    };
    readonly UP: {
        readonly label: string;
        readonly towards: string;
        readonly prefix: string;
    };
};
  LAYOUT: {
    tails: TailDef[];
    pairs: PairDef[];
    sidings: SidingDef[];
    loops: LoopDef[];
    crossovers: CrossoverDef[];
    depots: DepotDef[];
    zones: {
        id: string;
        name: string;
        fromStation: number;
        toStation: number;
    }[];
    maxSectionLength: number;
};
  SPEED_LIMITS: {
    from: number;
    to: number;
    kmh: number;
    reason: string;
}[];
  TURNOUT_SPEEDS: {
    crossover: number;
    siding: number;
    depot: number;
    tail: number;
};
  OPERATIONS: {
    /** Per approach, independent of weather; zero preserves the existing adhesion model. */
    atoRandomOverrunProbability: number;
    uto?: {
      crewLabel: string; doorWarningS: number; turnbackS: number;
      wakeLeadS: number; powerS: number; pantographS: number; selfTestS: number;
      clearS: number; washEvery: number; washS: number;
      takeoverStepS: number[]; randomTakeoversPerDay: number; randomTakeoverFromS: number; randomTakeoverSpacingS: number; manualDurationS: number;
      resetS: number; resetSuccess: number;
    };

    maintenance: {
        dailyLimit: number;
        monthlyPeriod: number;
        monthlyLimit: number;
        monthlyDays: number;
        overhaulDays: number;
        overhaulCount: number;
    };
    intervalTrainLimits: {
        from: string;
        to: string;
        limit: number;
    }[];
    randomFaults: {
        levels: {
            count: number;
            majorProbability: number;
        }[];
        crowdWindows: number[][];
        kinds: {
            kind: string;
            weight: number;
            scope: "passenger" | "peak" | "all";
            vehicle?: boolean;
            minLevel: number;
        }[];
        majorKinds: string[];
    };
    firstWestTerminusDep: number;
    firstEastTerminusDep: number;
    lastBigEastboundDep: number;
    lastLateEastboundDep: number;
    lastBigWestboundDep: number;
    lastBigWestboundArrival: number;
    peakCoreHeadway: number;
    minTurnback: Record<string, number>;
    platformTurnClear: Record<string, number>;
    depotReturns: {
        depot: string;
        dir: "UP" | "DN";
        station: string;
        service?: {
            terminal: string;
            intervalMultiplier: number;
        };
    }[];
    overnightStabling: {
        station: string;
        count: number;
        departure: "UP" | "DN";
        kind: "terminal" | "platform" | "origin" | "feeder";
        origin?: string;
        track?: string;
        nightAfter?: number;
        /** Store by a separate empty move after serving the requested terminal. */
        preserveService?: boolean;
    }[];
    hotStandby: {
        station: string;
        track: "turnback" | "storage";
        berth: number;
        depot?: string;
        incoming?: "UP" | "DN";
        /** Other real yard sources, in preference order, when the default source cannot supply this standby. */
        alternatives?: { depot: string; incoming: "UP" | "DN" }[];
          /** May remain unassigned, with a reported reason, when no safe slot/source exists. */
          optional?: boolean;
    }[];
    platformPassKmh: number;
    platformStopKmh: number;
    autoDoorOpenDelay: readonly [number, number];
    reverseKmh: number;
    depotDoorTests: Record<string, {
        beforeSignal: number;
    }>;
    sectionRunAllowanceS: number;
    sectionCruiseMinKmh: number;
    sectionCoastMinKmh: number;
    passRunMargin: number;
    autoStartDelay: readonly [number, number];
    atoDriverWork: {
        postLockExtraS: number;
        turnbackExtraS: {
            rear: number;
            front: number;
        };
        turnbackDoorCycles: {
            rear: number;
            front: number;
        };
        legacyEndChangeS: number;
    };
};
  EXPOSED: {
    from: number;
    to: number;
    kind: 'elevated' | 'ground';
    name: string;
}[];
  PROFILE_ANCHORS: {
    elevatedFrom: number;
    groundFrom: number;
};
  WEATHER_RULES: {
    wind: {
        level: number;
        label: string;
        kmh: number;
        elevatedOnly: boolean;
    }[];
    rain: {
        label: string;
        kmh: number;
        elevatedOnly: boolean;
    };
};
  POSSESSIONS: {
    candidates: number[];
    morningUntil: number;
    nightFrom: number;
    nightTo: number;
};
}
export interface FirstLastRow {
    station: string;
    firstE: string;
    firstW: string;
    lastE: string;
    lastW: string;
    lastG: string;
}
export interface OfficialHeadway {
    name: string;
    from: string | null;
    to: string | null;
    sections: [
        string,
        string,
        number | readonly [number, number]
    ][];
}

export interface FirstLastData {
  FIRST_LAST: FirstLastRow[];
  HQ_LATE_RUN: FixedRun | null;
  FIXED_LATE_TRAINS: FixedRun[];
  OFFICIAL_HEADWAYS: Record<'weekday' | 'weekend', OfficialHeadway[]>;
}
export interface OtherLastTrain {
    station: string;
    line: string;
    toward: string;
    dep: number;
    friSat?: number;
    walk: number;
}

export interface LastTrainsData {
  OTHER_LAST_TRAINS: OtherLastTrain[];
}
export type SoundKind = 'arrive' | 'depart' | 'ambience' | 'prefix' | 'station-name' | 'suffix' | 'close' | 'open' | 'close-motion' | 'door-warn-open' | 'door-warn-close' | 'door-motion-open' | 'door-motion-close' | 'interior-departure' | 'interior-special' | 'interior-prefix' | 'interior-name' | 'interior-suffix' | 'interior-arrival' | 'interior-rolling' | 'interior-idle';
export type SoundDirection = 'DN' | 'UP' | 'both' | 'shared';
export type AnnouncementDoorSide = 'L' | 'R' | 'B';
export interface SoundClip {
    id: string;
    file: string;
    kind: SoundKind;
    station: string;
    direction: SoundDirection;
    side: 'east' | 'west' | 'both' | 'shared';
    source: string;
    range: [number, number];
    both: boolean;
    confidence: 'high' | 'medium' | 'low';
    stopAt?: number;
    startAt?: number;
    anchorAfterTail?: boolean;
    fadeInS?: number;
    fadeOutS?: number;
    sourceGain?: string;
    voiceRange?: [number, number];
    otherAt?: number;
    anchorErrorS?: number;
    advanceS?: number;
    name?: string;
    loopCrossfadeS?: number;
    truncatedTail?: boolean;
    embeddedDestination?: string;
    effects?: 'cabin-floor' | 'rolling-noise' | 'door-warning' | 'door-mechanism';
    provenance?: 'original' | 'composed';
    recordedDestination?: string;
    recordedDirection?: 'DN' | 'UP';
    destination?: string;
    doorSide?: AnnouncementDoorSide;
    composition?: readonly string[];
    durationS?: number;
}

export interface SoundbankData {
  SOUNDBANK_DIRECTORY: string;
  SOURCE_GAIN_REFERENCES: readonly ({
    readonly source: string;
    readonly range: readonly [number, number];
    readonly targetLUFS: number;
})[];
  SOUND_BANK: readonly SoundClip[];
  clipDuration: (clip: SoundClip) => number;
}
export type RecordedVolume = 'small' | 'medium' | 'large';
export type VoiceLanguage = 'zh' | 'en' | 'bilingual';
export interface VoicePart {
    id: string;
    language: VoiceLanguage;
    speaker: 'onboard-zh' | 'onboard-en' | 'recorded-pair' | 'platform-zh';
    role: string;
    name?: string;
    source: SoundClip['source'];
    range: [number, number];
    confidence: SoundClip['confidence'];
    effects?: 'clean-speech-zh' | 'clean-speech-en';
    file?: string;
}
export interface OriginalAnnouncement {
    id: string;
    station: string;
    direction: 'DN' | 'UP';
    type: 'next' | 'arrived';
    source: SoundClip['source'];
    recordedDestination: string;
    range: [number, number];
    confidence: SoundClip['confidence'];
    doorSide: AnnouncementDoorSide;
    destinationSentence?: [number, number];
    destinationName?: [number, number];
    transferRange?: [number, number];
    terminalOnly?: boolean;
    directionNeutral?: boolean;
    recordedDirection?: 'DN' | 'UP';
    delayS?: number | null;
    advanceS?: number;
    measuredAdvance?: boolean;
    arrivalRecipe?: readonly string[];
}
export interface OnboardAnnouncement {
    station: string;
    direction: 'DN' | 'UP';
    source: SoundClip['source'];
    destination: string;
    doorSide: AnnouncementDoorSide;
    missingSentences: readonly string[];
    next?: {
        clipId: string;
        phraseAt: number;
        delayS: number | null;
        confidence: SoundClip['confidence'];
    };
    arrived?: {
        clipId: string;
        phraseAt: number;
        advanceS: number;
        measuredAdvance: boolean;
        confidence: SoundClip['confidence'];
    };
}

export interface OnboardbankData {
  VOICE_CROSSFADE_S: number;
  RECORDED_VOLUME_GAINS: {
    readonly small: number;
    readonly medium: number;
    readonly large: number;
};
  VOICE_SOURCES: readonly ({
    readonly id: string;
    readonly filename: string;
    readonly recordedDate: string;
    readonly durationS: number;
} | {
    readonly id: string;
    readonly filename: string;
    readonly durationS: number;
})[];
  FIELD_1016_VOICE_PARTS: readonly VoicePart[];
  ORIGINAL_ONBOARD: readonly OriginalAnnouncement[];
  ONBOARD_DESTINATIONS: readonly (string)[];
  ADDITIONAL_ONBOARD_ROUTES: readonly {
    from: string;
    to: string;
    direction: 'DN' | 'UP';
}[];
  FIELD_ORIGINAL_ONBOARD: readonly OriginalAnnouncement[];
  RECORDED_ONBOARD: OriginalAnnouncement[];
  VOICE_PARTS: readonly VoicePart[];
  ONBOARD_NEXT_DELAY_S: number;
  ONBOARD_ARRIVAL_ADVANCE_S: number;
  onboardDoorSide: (station: number, direction: 'DN' | 'UP', destination: string) => AnnouncementDoorSide;
  compatibleVoiceRecipe: (recipe: readonly VoicePart[], station: string) => boolean;
  FIELD_1016_TERMINAL_CLIP: SoundClip;
  ONBOARD_HOLD_CLIP: SoundClip;
  ONBOARD_HOLD_DELAY_S: number;
  ONBOARD_HOLD_REPEAT_S: number;
  ONBOARD_RENDER_BANK: readonly SoundClip[];
  ONBOARD_ANNOUNCEMENTS: readonly OnboardAnnouncement[];
  onboardAnnouncement: (station: string, direction: 'DN' | 'UP', destination: string, side: AnnouncementDoorSide, catalog?: readonly OnboardAnnouncement[]) => OnboardAnnouncement | undefined;
}

export interface DoorbankData {
  DOOR_REFERENCE_TIMING: {
    readonly openingS: number;
    readonly warningToMotionS: number;
    readonly motionToLockedS: number;
};
  DOOR_TAKES: readonly ({
    readonly id: string;
    readonly station: string;
    readonly primary: true;
    readonly open: readonly [number, number];
    readonly warn: readonly [number, number];
    readonly close: readonly [number, number];
    readonly lockedAt: number;
    readonly confidence: string;
} | {
    readonly id: string;
    readonly station: string;
    readonly primary: false;
    readonly open: readonly [number, number];
    readonly warn: readonly [number, number];
    readonly close: readonly [number, number];
    readonly lockedAt: number;
    readonly confidence: string;
})[];
  DOOR_BANK: readonly SoundClip[];
}
export interface VvvfClip {
    file: string;
    table: [number, number][];
    plateau: [number, number, number];
}
export interface VvvfTake {
    id: string;
    vehicleType: string;
    power: VvvfClip;
    brake: VvvfClip;
}

export interface VvvfData {
  VVVF_HZ_PER_MS: number;
  VVVF_TRACTION: [number, number][];
  VVVF_BRAKE: [number, number][];
  VVVF_TAKES: readonly VvvfTake[];
}
export type RideDirection = 'DN' | 'UP';
export type RecordingId = string;
export interface RecordingSource {
    id: RecordingId;
    filename: string;
    kind: 'ride' | 'platform';
    durationS: number;
    clockStart: string | null;
    clockStartNotBefore?: string;
    clockStartPrecision?: 'minute';
    recordedDate?: string;
    vehicleLabel?: string;
    observedFrom?: string;
    note?: string;
    from: string;
    to: string;
    directions: RideDirection[];
    doorReferences?: {
        direction: RideDirection;
        car: number;
        door: number;
        trainType: string;
    }[];
}
export interface AcousticCandidate {
    at: number;
    searchRadiusS: number;
    evidence: 'closing-tone-pulses' | 'rising-traction-band' | 'opening-band-step' | 'door-impact-duration' | 'traction-switch-and-rolling';
}
export type RideConfidence = 'high' | 'medium' | 'low';
export interface RideEventEvidence {
    confidence: RideConfidence;
    method: AcousticCandidate['evidence'] | 'spectral-knee' | 'user-marker' | 'file-boundary';
    gainDb?: number;
    impactAt?: number;
    travelS?: number;
    powerAt?: number;
    rollingConfirmed?: boolean;
    score?: number;
    edgeLimited?: boolean;
    preContextLimited?: boolean;
    bandHz?: [number, number];
    ridgeFallDb?: number;
    lowBeforeDb?: number;
    lowAfterDb?: number;
    lowFallDb?: number;
    floorDb?: number;
    ambiguous?: boolean;
    autoAt?: number;
    note?: string;
}
export interface RideStop {
    recording: RecordingId;
    station: string;
    direction: RideDirection;
    stop: number | null;
    open: number | null;
    close: number | null;
    closingMotion?: number | null;
    start: number | null;
    evidence: Partial<Record<'stop' | 'open' | 'close' | 'closingMotion' | 'start', RideEventEvidence>>;
    candidates: Partial<Record<'open' | 'close' | 'closingMotion' | 'start', AcousticCandidate>>;
    analysisWindowS: [number, number] | null;
    note?: string;
}
export interface RecordingDoorReview {
    recording: RecordingId;
    station: string;
    reviewedOn: string;
    clipWindowS: [number, number];
    reply: string;
    note?: string;
    openingNotHeard?: boolean;
    events?: Partial<Record<'open' | 'close' | 'closingMotion' | 'locked', {
        at: number;
        confidence: RideConfidence;
        method: 'user-marker' | 'opening-band-step';
        rangeS?: [number, number];
        presenceConfirmed?: boolean;
        timingConfirmed?: boolean;
        edgeLimited?: boolean;
        note?: string;
    }>>;
}
export type RideMeasuredEvent = 'stop' | 'open' | 'closingMotion' | 'start' | 'close';

export interface RidelogData {
  LEGACY_RECORDING_IDS: readonly (string)[];
  FIELD_1016_RECORDING_IDS: readonly (string)[];
  RECORDING_SOURCES: RecordingSource[];
  RIDE_LOG: RideStop[];
  BRAKE_STOP_MEASUREMENTS: (RideEventEvidence & {
    station: string;
    at: number;
})[];
  USER_RIDE_MARKERS: {
    station: string;
    event: 'stop' | 'close' | 'start';
    at: number;
}[];
  USER_DOOR_REVIEWS: RecordingDoorReview[];
  USER_DOOR_REFERENCES: {
    recording: RecordingId;
    station: string;
    open: number;
    closingMotion: number;
    locked: {
        raw: string;
        parsedSeconds: number;
        usable: boolean;
    };
};
  RIDE_MODEL_BASELINE: {
    revision: string;
    tripG: string;
    tripW: string;
    tripAirport: string;
    airportFullSeconds: number;
    wholeRecordedModelSeconds: number;
    terminalDN: string;
    terminalUP: string;
    intervals: {
        direction: string;
        from: string;
        to: string;
        runS: number;
        dwellS: number;
    }[];
};
  RIDE_MEASURED_EVENTS: readonly RideMeasuredEvent[];
  usableRideEvent: (row: RideStop, event: RideMeasuredEvent) => boolean;
  summarizeRideLog: (rows: readonly RideStop[]) => {
    rows: number;
    events: Record<RideMeasuredEvent, {
        high: number;
        medium: number;
        low: number;
        missing: number;
    }>;
    run: {
        count: number;
        meanS: number | null;
    };
    dwell: {
        count: number;
        meanS: number | null;
    };
    openingLag: {
        count: number;
        meanS: number | null;
    };
    warningToStart: {
        count: number;
        meanS: number | null;
    };
    closingToStart: {
        count: number;
        meanS: number | null;
    };
    paired: {
        count: number;
        runMeanS: number | null;
        dwellMeanS: number | null;
    };
};
}

export interface OnboardfieldData {
  FIELD_1021_ORIGINALS: readonly OriginalAnnouncement[];
  FIELD_1021_PARTS: readonly VoicePart[];
}

/** A catalogue without local recordings has empty banks and evidence arrays. */
export interface LineAudioData {
  soundbank: SoundbankData;
  onboardbank: OnboardbankData;
  doorbank: DoorbankData;
  vvvf: VvvfData;
  ridelog: RidelogData;
  onboardfield1021: OnboardfieldData;
}
export interface LineData {
  /** Stable public selector; local station/depot/trip ids are scoped by it. */
  id: string;
  branding: { title: string; shortName: string; color: string; badgeUrl: string; logoText: string };
  unattended: { doorClose: boolean; turnback: boolean; wakeSleep: boolean; depotMoves: boolean };
  signalling: { primary: 'CBTC' | 'TBTC' | 'TACS' | 'fixed'; fallback: ('CBTC' | 'TBTC' | 'TACS' | 'fixed')[]; onLoss: 'fallback' | 'restrictedManual' | 'wait' };
  automation: 'DTO' | 'UTO' | 'ATO';
  core: CoreLineData;
  firstLast: FirstLastData;
  lastTrains: LastTrainsData;
  audio: LineAudioData;
  simulation: SimulationData;
  ui: LineUiData;
}
/** Selection is a group so shared-line worlds can be added without a new entry contract. */
export interface LineGroup {
  id: string;
  name: string;
  lines: readonly LineData[];
  lineIds: readonly string[];
  developmentOnly?: boolean;
}
export interface ScopedId {
  lineId: string;
  kind: 'station' | 'depot' | 'trip' | 'train';
  localId: string;
}
