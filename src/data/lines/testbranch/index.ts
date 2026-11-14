/** Entirely fictional fixture: the test line with a two-station branch that joins it at 试验二.
 * The branch's DN main has a platform face of its own there and meets the DN main beyond the
 * platform; its UP main leaves the UP main before the platform. The branch has its own depot and
 * its trains run through to 试验东, alternating with the main run's. */
import type { LineData, StationData } from '../../types';
import { TEST_LINE } from '../test';

const branch: StationData[] = [
  { id: 'B01', name: '支线西', interM: null, transfers: [], dwell: 20, demand: .5 },
  { id: 'B02', name: '支线一', interM: 1100, transfers: [], dwell: 20, demand: .5,
    joins: { station: 'T03', interM: 1500, DN: { at: 220, platform: true }, UP: { at: -220 } } },
];
const stations = [...branch, ...TEST_LINE.core.STATIONS];
const shift = branch.length;
const layout = TEST_LINE.core.LAYOUT, operations = TEST_LINE.core.OPERATIONS, timetable = TEST_LINE.simulation.timetable;
const periods = [{ from: 14400, to: 100800, template: 'regular', label: '测试全天', headway: 600 }];

export const TEST_BRANCH_LINE: LineData = {
  ...TEST_LINE, id: 'testbranch',
  core: {
    ...TEST_LINE.core, STATIONS: stations,
    LINE_INFO: { ...TEST_LINE.core.LINE_INFO, fleet: 16 },
    FLEET_TYPES: [{ type: 'TEST', from: 1, to: 16, digits: 4, source: '虚构测试数据' }],
    FLEET: Array.from({ length: 16 }, (_, i) => ({ no: `TEST${i + 1}`, type: 'TEST', n: i + 1 })),
    LAYOUT: {
      ...layout,
      tails: layout.tails.map(tail => ({ ...tail, station: tail.station + shift })),
      pairs: [...layout.pairs.map(pair => ({ ...pair, station: pair.station + shift })), { id: 'BW', station: 0, side: 'west' as const, at: -205, stubs: [
        { id: 'BW1', name: '支线西折返一', length: 300, lead: { depot: 'BD' } },
        { id: 'BW2', name: '支线西折返二', length: 300, lead: { depot: 'BD' } },
      ] }],
      depots: [...layout.depots.map(depot => ({ ...depot, station: depot.station + shift })),
        { ...layout.depots[0], id: 'BD', name: '支线车辆段', short: '支线段', station: 0 }],
      zones: [{ ...layout.zones[0], fromStation: 0, toStation: stations.length - 1 }],
    },
    OPERATIONS: {
      ...operations,
      intervalTrainLimits: stations.slice(0, -1).flatMap((s, i) => stations[i + 1].interM === null ? [] : [{ from: s.id, to: stations[i + 1].id, limit: 1 }]),
      minTurnback: { ...operations.minTurnback, B01: 240 },
      depotReturns: [...operations.depotReturns, { depot: 'BD', dir: 'UP' as const, station: 'B01' }],
      depotDoorTests: { ...operations.depotDoorTests, BD: { beforeSignal: 5 } },
    },
  },
  simulation: {
    ...TEST_LINE.simulation,
    timetable: {
      ...timetable,
      templates: { regular: { id: 'regular', name: '测试全天', desc: '虚构测试，每10分钟一班，干线和支线交替', pattern: ['big', 'branch'], headway: 600 } },
      dayPeriods: { weekday: periods, weekend: periods }, shownPeriods: { weekday: periods, weekend: periods },
      reference: { DN: 'T03', UP: 'T06' },
      terminals: { ...timetable.terminals, trunk: ['T01', 'T06'], routes: { branch: ['B01', 'T06'] },
        depot: { ...timetable.terminals.depot, B01: 'BD' }, capacity: { ...timetable.terminals.capacity, B01: 3 }, maxPresent: { ...timetable.terminals.maxPresent, B01: 3 } },
    },
  },
};
