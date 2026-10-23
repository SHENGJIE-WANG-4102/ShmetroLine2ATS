/** Stable import surface for the startup-selected line group. No runtime mutation. */
import { getGroup } from './registry';
import { startupGroupId } from './startup';
export * from './types';
export { getLine, getGroup, visibleLineGroups, scopedId } from './registry';

export const GROUP = getGroup(startupGroupId());
if (typeof location !== 'undefined' && import.meta.env?.PROD && GROUP.developmentOnly)
  throw new Error('测试线路仅在开发模式或自动测试中提供');
/** The current engine runs one member. The selection contract already preserves every member. */
export const LINE = GROUP.lines[0];
export const LINE_ID = LINE.id;
export const GROUP_ID = GROUP.id;
export const SIMULATION = LINE.simulation;
export function supportsSignalSystem(level: typeof LINE.signalling.primary): boolean {
  return LINE.signalling.primary === level || LINE.signalling.fallback.includes(level);
}
export const {
  SOURCES, STATIONS, STATION_EN, LINE_INFO, FLEET_TYPES, FLEET, DIRECTIONS, LAYOUT,
  SPEED_LIMITS, TURNOUT_SPEEDS, OPERATIONS, EXPOSED, PROFILE_ANCHORS, WEATHER_RULES, POSSESSIONS,
} = LINE.core;

export function stationChainages(): number[] {
  let chain = 0;
  return STATIONS.map(station => {
    if (station.interM !== null) chain += station.interM;
    return chain;
  });
}
export function fleetEntry(no: string) {
  return FLEET.find(entry => entry.no === no);
}

export const { FIRST_LAST, HQ_LATE_RUN, FIXED_LATE_TRAINS, OFFICIAL_HEADWAYS } = LINE.firstLast;
export const { OTHER_LAST_TRAINS } = LINE.lastTrains;
