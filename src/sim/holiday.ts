/**
 * Holiday operation (节假日运营), D62: a whole operating day run on the
 * holiday timetable with the day's planned measures built in, from the first
 * train on — no scenario jump. The National Day week (10-01…10-07) and its eve:
 *  - 外滩 crowd control: 南京东路 is closed (封站, trains pass both platforms;
 *    ATS sets the skip-stops at the planned time) from 20:00 on 9-30 and from
 *    16:00 every holiday day, to the end of service (the published practice
 *    of 2021, 2024 and 2026); 人民广场 / 陆家嘴 take the diverted crowds;
 *  - every holiday day, more leisure demand at 南京东路 / 陆家嘴 / 上海科技馆;
 *  - the last two days (返程), evening arrivals at the Hongqiao hub and Pudong
 *    airport, and 虹桥火车站 → 龙阳路 fixed-time extra trains up to 00:30
 *    (as published for 10-06 / 10-07 in 2026).
 * Equipment faults are not scripted: the day's random fault level decides.
 * Demand multipliers and the extra trains between the published ones are
 * approximations (D62).
 */
import type { Sim } from './engine';
import { injectFault } from './faults';
import { STATIONS, type FixedRun } from '../data/line2';
import { HQ_LATE_RUN } from '../data/firstlast';
import { holidayOf, type HolidayDay } from './calendar';
export { holidayOf, type HolidayDay };

const H = (h: number, m = 0) => h * 3600 + m * 60;
const stationIdx = (id: string) => STATIONS.findIndex((s) => s.id === id);

/** a holiday day proper (the eve runs the working-day timetable) */
export const isHolidayDay = (h: HolidayDay | null) => !!h && h.day >= 1;
/** the return days: the last two */
const isReturnDay = (h: HolidayDay) => h.day >= h.days - 1;

/** 虹桥火车站 → 龙阳路 fixed-time trains on the return nights, the last at 00:30 */
export const NATIONAL_RETURN_RUNS: FixedRun[] = [
  { ...HQ_LATE_RUN, departures: [H(23, 4), H(23, 30), H(23, 50), H(24, 10), H(24, 30)] },
];

/** fixed-time trains of the day (undefined: the regular ones) */
export function holidayFixedRuns(h: HolidayDay | null): FixedRun[] | undefined {
  return h && h.day >= 1 && isReturnDay(h) ? NATIONAL_RETURN_RUNS : undefined;
}

/** 外滩 crowd control: 南京东路 closed from this time to the end of service */
export const njdClosureFrom = (h: HolidayDay) => (h.day === 0 ? H(20) : H(16));

interface HolidayEvent { at: number; run: (sim: Sim) => void }

/** close or reopen a station: both platforms skip-stopped (封站) */
export function closeStation(sim: Sim, id: string, on: boolean) {
  const st = sim.topo.stations[stationIdx(id)];
  for (const p of [st.platforms.DN, st.platforms.UP]) sim.command({ c: 'platformSkip', platform: p, on });
}

const surge = (id: string, from: number, to: number, m: number): HolidayEvent =>
  ({ at: from, run: (sim) => { injectFault(sim, 'surge', stationIdx(id), to - from, m); } });

/** the planned measures of the day, in time order */
export function holidayEvents(h: HolidayDay): HolidayEvent[] {
  const from = njdClosureFrom(h);
  const ev: HolidayEvent[] = [
    { at: from - 20 * 60, run: (sim) => { sim.log('B', '客流', `外滩地区客流管控：${hm(from)} 起至运营结束南京东路站封站，列车跳站通过，ATS 按计划设置跳停`); } },
    { at: from, run: (sim) => { closeStation(sim, 'NJD', true); sim.log('B', '客流', '南京东路站封站：上、下行站台跳停（计划）'); } },
    // the diverted crowds, heaviest in the evening
    surge('RMG', from, H(22, 30), h.day === 0 ? 1.8 : 2.5),
    surge('LJZ', from, H(22, 30), h.day === 0 ? 1.8 : 2.5),
  ];
  if (isHolidayDay(h)) {
    ev.push(
      surge('NJD', H(12), from, 2),
      surge('KJG', H(10), H(16), 1.6),
    );
    if (isReturnDay(h)) {
      ev.push(
        surge('HQZ', H(19, 30), H(24, 15), 4),
        surge('HQ2', H(20), H(24), 3),
        surge('PDA', H(20, 30), H(23, 20), 3.5),
      );
    }
  }
  return ev.sort((a, b) => a.at - b.at);
}

function hm(t: number): string {
  return `${String(Math.floor(t / 3600) % 24).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`;
}

/** fire the day's measures whose time has come (once each, in order) */
export function holidayTick(sim: Sim) {
  const h = sim.holiday;
  if (!h || sim.scenario) return;
  const ev = holidayEvents(h);
  while (sim.holidayFired < ev.length && sim.t >= ev[sim.holidayFired].at) ev[sim.holidayFired++].run(sim);
}
