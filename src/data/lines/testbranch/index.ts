/** Entirely fictional fixture: the test line with a two-station branch that joins it at 试验二.
 * The branch's DN main has a platform face of its own there and meets the DN main beyond the
 * platform; its UP main leaves the UP main before the platform. For topology tests only. */
import type { LineData, StationData } from '../../types';
import { TEST_LINE } from '../test';

const branch: StationData[] = [
  { id: 'B01', name: '支线西', interM: null, transfers: [], dwell: 20, demand: .5 },
  { id: 'B02', name: '支线一', interM: 1100, transfers: [], dwell: 20, demand: .5,
    joins: { station: 'T03', interM: 1500, DN: { at: 220, platform: true }, UP: { at: -220 } } },
];
const stations = [...branch, ...TEST_LINE.core.STATIONS];
const shift = branch.length;
const layout = TEST_LINE.core.LAYOUT;

export const TEST_BRANCH_LINE: LineData = {
  ...TEST_LINE, id: 'testbranch',
  core: {
    ...TEST_LINE.core, STATIONS: stations,
    LAYOUT: {
      ...layout,
      tails: [...layout.tails.map(tail => ({ ...tail, station: tail.station + shift })), { station: 0, side: 'west' as const, length: 450 }],
      pairs: layout.pairs.map(pair => ({ ...pair, station: pair.station + shift })),
      depots: layout.depots.map(depot => ({ ...depot, station: depot.station + shift })),
      zones: [{ ...layout.zones[0], fromStation: 0, toStation: stations.length - 1 }],
    },
    OPERATIONS: { ...TEST_LINE.core.OPERATIONS,
      intervalTrainLimits: stations.slice(0, -1).flatMap((s, i) => stations[i + 1].interM === null ? [] : [{ from: s.id, to: stations[i + 1].id, limit: 1 }]) },
  },
};
