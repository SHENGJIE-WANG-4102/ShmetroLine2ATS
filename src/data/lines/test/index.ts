import { emptyAudio } from '../../emptyAudio';
/** Entirely fictional fixture. The six stations, fleet and service are test assumptions. */
import type { CoreLineData, LineData, StationData } from '../../types';
import type { SimulationData } from '../../simulation';
import { LINE_2 } from '../line2';

const stations: StationData[] = ['试验西', '试验一', '试验二', '试验三', '试验四', '试验东'].map((name, i) => ({
  id: `T0${i + 1}`, name, interM: i ? 1200 : null, transfers: [], dwell: 20, demand: .5,
}));
const core: CoreLineData = {
  ...LINE_2.core,
  SOURCES: [], STATIONS: stations, STATION_EN: {},
  LINE_INFO: { ...LINE_2.core.LINE_INFO, name: '测试线', shortName: '测试线', color: 0x9070cc, colorCss: '#9070cc', fleet: 8 },
  FLEET_TYPES: [{ type: 'TEST', from: 1, to: 8, digits: 4, source: '虚构测试数据' }],
  FLEET: Array.from({ length: 8 }, (_, i) => ({ no: `TEST${i + 1}`, type: 'TEST', n: i + 1 })),
  DIRECTIONS: { DN: { label: '下行', towards: '往试验东', prefix: 'X' }, UP: { label: '上行', towards: '往试验西', prefix: 'S' } },
  LAYOUT: {
    tails: [{ station: 5, side: 'east', length: 450 }],
    pairs: [{ id: 'TW', station: 0, side: 'west', at: -205, stubs: [
      { id: 'TW1', name: '测试西折返一', length: 300, lead: { depot: 'TD' } },
      { id: 'TW2', name: '测试西折返二', length: 300, lead: { depot: 'TD' } },
    ] }],
    sidings: [], loops: [], crossovers: [],
    depots: [{ id: 'TD', name: '测试车辆段', short: '测试段', station: 0, stablingTracks: 4, capacity: 8, exitTime: 200,
      work: { daily: true, monthly: true, overhaul: true }, source: '虚构测试数据' }],
    zones: [{ id: 'TZ', name: '测试控制区', fromStation: 0, toStation: 5 }], maxSectionLength: 450,
  },
  SPEED_LIMITS: [], EXPOSED: [{ from: 1200, to: 4800, kind: 'elevated', name: '测试露天段' }], PROFILE_ANCHORS: { elevatedFrom: Infinity, groundFrom: Infinity },
  POSSESSIONS: { candidates: [], morningUntil: 18000, nightFrom: 86400, nightTo: 99000 },
  OPERATIONS: {
    ...LINE_2.core.OPERATIONS,
    maintenance: { dailyLimit: 15, monthlyPeriod: 60, monthlyLimit: 90, monthlyDays: 1, overhaulDays: 30, overhaulCount: 0 },
    intervalTrainLimits: stations.slice(0, -1).map((s, i) => ({ from: s.id, to: stations[i + 1].id, limit: 1 })),
    firstWestTerminusDep: 21600, firstEastTerminusDep: 22200,
    lastBigEastboundDep: 79200, lastLateEastboundDep: 79200, lastBigWestboundDep: 79800, lastBigWestboundArrival: 81000,
    peakCoreHeadway: 1200, minTurnback: { T01: 240, T06: 240 }, platformTurnClear: {},
    depotReturns: [{ depot: 'TD', dir: 'UP', station: 'T01' }],
    overnightStabling: [], hotStandby: [], depotDoorTests: { TD: { beforeSignal: 5 } },
  },
};
const periods = [{ from: 14400, to: 100800, template: 'regular', label: '测试全天', headway: 1200 }];
const service = { peaks: {}, overrides: [], openingSupplements: [], lateHeadway: 1200, standby: [] };
const simulation: SimulationData = {
  ...LINE_2.simulation,
  calibration: {
    ...LINE_2.simulation.calibration, ridershipTarget: { weekday: 3000, weekend: 2000 }, peakSection: null,
    tides: { weekday: { stationWeights: [], amplitude: 0, morning: 8, evening: 18, width: 2 }, weekend: { stationWeights: [], amplitude: 0, morning: 8, evening: 18, width: 2 } },
  },
  gradient: { ...LINE_2.simulation.gradient, depths: {}, river: null },
  holiday: { returnRuns: [], closure: null, surges: [] },
  pis: {
    ...LINE_2.simulation.pis, defaults: { DN: 'T06', UP: 'T01' }, welcome: '欢迎乘坐测试线', weatherNotice: '受天气影响，列车限速运行',
    destinations: [
      { station: 'T06', first: 'firstE', last: 'lastE', alternatives: [] },
      { station: 'T01', first: 'firstW', last: 'lastW', alternatives: [] },
    ],
  },
  topology: { wrapAfter: 'T03' },
  instructor: { previousIds: {}, events: [], scenarios: [] },
  timetable: {
    templates: { regular: { id: 'regular', name: '测试全天', desc: '虚构测试，每20分钟一班', pattern: ['big'], headway: 1200 } },
    dayPeriods: { weekday: periods, weekend: periods }, shownPeriods: { weekday: periods, weekend: periods },
    dwellBands: { weekday: [{ from: 0, to: Infinity, value: 1 }], weekend: [{ from: 0, to: Infinity, value: 1 }] },
    runBands: { weekday: [{ from: 0, to: Infinity, value: 1 }], weekend: [{ from: 0, to: Infinity, value: 1 }] },
    serviceData: { weekday: service, weekend: service },
    opening: { outerAlternation: 0, defaultStableDeparture: 21600, stockUntil: 36000, redirectFrom: 25200, emptyFeedersFrom: 72000, feederUntil: 93600, stableUntil: 36000, dayStart: 14400 },
    outerBandMargin: 1200, overlays: [],
    terminals: { core: ['T01', 'T06'], circulate: [], depot: { T01: 'TD', T06: 'TD' }, capacity: { T01: 3, T06: 3 }, maxPresent: { T01: 3, T06: 3 } },
    firstOrigins: [], openingGuards: [], closingDepotMoves: [], firstTrainRunAdjust: {},
  },
};

export const TEST_LINE: LineData = {
  id: 'test', branding: { title: '测试线', shortName: '测试线', color: '#9070cc', badgeUrl: '', logoText: 'T' },
  signalling: { primary: 'CBTC', fallback: [] }, automation: 'DTO',
  core, simulation,
  firstLast: { FIRST_LAST: [
    { station: stations[0].name, firstE: '06:00', firstW: '', lastE: '22:00', lastW: '', lastG: '' },
    { station: stations[5].name, firstE: '', firstW: '06:10', lastE: '', lastW: '22:10', lastG: '' },
  ], HQ_LATE_RUN: null, FIXED_LATE_TRAINS: [], OFFICIAL_HEADWAYS: { weekday: [], weekend: [] } },
  lastTrains: { OTHER_LAST_TRAINS: [] }, audio: emptyAudio(stations, LINE_2.audio.doorbank.DOOR_REFERENCE_TIMING),
  ui: {
    documentTitle: '测试线 ATS', bootTitle: '测试线 · ATS', desktopTitle: '测试线 ATS', headerTitle: '测试线列车自动监控系统',
    headerSubtitle: '虚构测试数据 · CBTC', lineNameEn: 'Test Line', pisColorCss: '#9070cc', preferencePrefix: 'ats-test',
    helpIntro: '六站虚构测试线，用于验证线路隔离和通用运营规则。', helpDmi: '测试车辆司机室显示。', helpScenarios: '无预设教员场景。', helpEnvironment: '测试中间区段用于验证天气限速。',
    holidayNotice: { eve: '', day: '', returning: '', suffix: '' }, stationNameLines: {}, transferColors: {}, overviewWidth: 3000,
  },
};

