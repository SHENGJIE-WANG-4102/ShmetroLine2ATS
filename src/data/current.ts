/** Stable import surface for the startup-selected line group. No runtime mutation. */
import { getGroup } from './registry';
import { startupGroupId } from './startup';
import { setStationOrder } from '../sim/topologyOrder';
import type { StationData } from './types';
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

/** Service availability is derived once from the infrastructure data. */
export const SERVICE_STATION_IDS = new Set(STATIONS.filter(st => st.opened !== false).map(st => st.id));
export function stationOpened(st: number): boolean { return SERVICE_STATION_IDS.has(STATIONS[st]?.id); }

/** The next station DN-ward of each station (-1 at the DN terminus): the following list entry,
 * or the station a branch's last station joins. */
export function stationOrder(stations: readonly { id: string; interM: number | null; joins?: { station: string } }[]): number[] {
  return stations.map((station, index) => {
    if (station.joins) {
      const to = stations.findIndex(other => other.id === station.joins!.station);
      if (to < 0) throw new Error(`${station.id} joins unknown station ${station.joins.station}`);
      return to;
    }
    return index + 1 < stations.length && stations[index + 1].interM !== null ? index + 1 : -1;
  });
}
/** A line with a branch registers its running order; a single run keeps array order. */
setStationOrder(STATIONS.some(station => station.joins) ? stationOrder(STATIONS) : null);

/** Chainage of each station (m, rising DN-ward). The main run starts at 0; a branch is measured
 * back from the station it joins, so its chainages overlap the main run's on its own tracks. */
export function stationChainages(stations: readonly Pick<StationData, 'id' | 'interM' | 'joins'>[] = STATIONS): number[] {
  let chain = 0;
  const chains = stations.map(station => {
    if (station.interM !== null) chain += station.interM;
    return chain;
  });
  for (let last = stations.length - 1; last >= 0; last--) {
    const joins = stations[last].joins;
    if (!joins) continue;
    chains[last] = chains[stations.findIndex(station => station.id === joins.station)] - joins.interM;
    for (let i = last; i > 0 && stations[i].interM !== null; i--) chains[i - 1] = chains[i] - stations[i].interM!;
  }
  return chains;
}
export function fleetEntry(no: string) {
  return FLEET.find(entry => entry.no === no);
}

export const { FIRST_LAST, HQ_LATE_RUN, FIXED_LATE_TRAINS, OFFICIAL_HEADWAYS } = LINE.firstLast;
export const { OTHER_LAST_TRAINS } = LINE.lastTrains;

/** Behaviour is selected by explicit capability, never by automation display labels. */
export function unattended(task: keyof typeof LINE.unattended): boolean { return LINE.unattended[task]; }
