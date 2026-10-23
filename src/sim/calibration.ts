/** Calibrated service assumptions; factual sources are recorded in D29–D31. */
import type { DayType, TrackDir } from './model';
import { dayRandom } from './dayRandom';
import { DOOR_REFERENCE_TIMING } from '../data/doorbank';
import { OPERATIONS, STATIONS } from '../data/line2';
export const RIDERSHIP_TARGET = { weekday: 1_090_000, weekend: 1_090_000 * 0.7 };
/** 【假设】每日目标在中心值的 ±5% 内均匀抽取，两种日型共用规则。 */
export const RIDERSHIP_RANGE = Object.fromEntries(Object.entries(RIDERSHIP_TARGET).map(([day,center])=>[day,{min:Math.round(center*.95),max:Math.round(center*1.05)}])) as Record<DayType,{min:number;max:number}>;
export function drawDailyRidership(day: DayType, seed: number): number {
 const range=RIDERSHIP_RANGE[day];
 return Math.round(range.min+dayRandom(seed,0x71de2026)()*(range.max-range.min));
}
/** Where and when the reported peak section load (高峰最大断面) is taken: weekdays,
 * 淞虹路–广兰路, the morning and evening peak hours (h). */
export const PEAK_SECTION = { day: 'weekday' as DayType, from: 'SHR', to: 'GLL', hours: [[6.8333, 9.5], [16.8333, 19.5]] };
export function inPeakSection(day: DayType, station: number, t: number): boolean {
 const id=(x: string)=>STATIONS.findIndex(st=>st.id===x), h=t/3600;
 return day===PEAK_SECTION.day && station>=id(PEAK_SECTION.from) && station<=id(PEAK_SECTION.to)
  && PEAK_SECTION.hours.some(([a,b])=>h>=a && h<b);
}
/** One physical clock shared by simulation, PSD, DMI and audio. */
export const DOOR_CLOSE_S = DOOR_REFERENCE_TIMING.warningToMotionS + DOOR_REFERENCE_TIMING.motionToLockedS;
export const meanRange = (r: readonly [number, number]) => (r[0] + r[1]) / 2;
export const DOOR_CYCLE = meanRange(OPERATIONS.autoDoorOpenDelay) + DOOR_REFERENCE_TIMING.openingS
  + DOOR_CLOSE_S + meanRange(OPERATIONS.autoStartDelay);
/** D73图定停站原值保留：旧门序列预算15秒，关门至起车预算12秒。
 * 物理门序列用区间期望12.2秒；差额2.8秒留作原图定客流作业余量。 */
export const PLANNED_DOOR_BUDGET = 15; // D73图定门作业预算，D119保持
export const PLANNED_CLOSE_BUDGET = 12;
export const MIN_DWELL = 22; // D73保留的停站下限；物理门序列改用DOOR_CYCLE期望值
export const MAX_EARLY_HOLD = 10;
export const MAX_DWELL_BUSY = 85; // 【假设】 peak ceiling, calibrated against fleet counts (D73)
export const MAX_DWELL = 70;
export const DOORS_PER_SIDE = 40; // eight cars, five doors per car
export const EXCHANGE_PER_DOOR = 2.2; // persons/s, calibrated aggregate exchange (assumption)
const WEEKDAY: [number, number][] = [[4.5,0],[5.4,.08],[6.2,.4],[6.8,1.2],[7.5,3.4],[8.1,4],[8.8,2.7],[9.6,.8],[11,.65],[13,.7],[16,.8],[17.2,2.6],[18,3.7],[18.8,2.8],[19.8,.85],[21,.5],[22.5,.25],[23.5,.1],[24.5,0]];
const WEEKEND: [number, number][] = [[4.5,0],[5.4,.1],[7,.4],[9,.9],[10.5,1.15],[14,1.2],[17,1.25],[19,1.1],[21,.7],[22.5,.4],[23.5,.15],[24.5,0]];
export function profile(day: DayType, t: number): number {
 const h=t/3600, p=day==='weekday'?WEEKDAY:WEEKEND;
 for(let i=0;i+1<p.length;i++)if(h>=p[i][0]&&h<p[i+1][0])return p[i][1]+(p[i+1][1]-p[i][1])*(h-p[i][0])/(p[i+1][0]-p[i][0]);
 return 0;
}
/** Both directions sum to two: tides redistribute station demand, not its daily total. */
export function directionShare(day: DayType, station: number, dir: TrackDir, t: number): number {
 if(day!=='weekday')return 1;
 const h=t/3600;
 const am=Math.max(0,1-Math.abs(h-8)/2),pm=Math.max(0,1-Math.abs(h-18)/2);
 const west=station<=12?1:station>=17?-1:0;
 const dn=1+.72*west*(am-pm);
 return dir==='DN'?dn:2-dn;
}
export function rawDemand(day: DayType, station: number, dir: TrackDir, t: number): number {
 return STATIONS[station].demand*profile(day,t)*directionShare(day,station,dir,t);
}
/** Boarding demand of a platform. At a line end everyone boards towards the
 * line, so the one departing direction carries the station's whole weight. */
export function boardingDemand(day: DayType, station: number, dir: TrackDir, t: number): number {
 const end=station===0?'DN':station===STATIONS.length-1?'UP':undefined;
 if(end)return dir===end?STATIONS[station].demand*profile(day,t)*2:0;
 return rawDemand(day,station,dir,t);
}
/** Interchanges include transfer boardings in the demand weight. Smooth time variation
 * avoids artificial time jumps when a train straddles a template boundary. */
export function plannedDwell(day: DayType, station: number, dir: TrackDir, t: number, factor = 1): number {
 const busy=STATIONS[station].demand>=1.4;
 const exchange=(rawDemand(day,station,dir,t)+rawDemand(day,station,dir==='DN'?'UP':'DN',t))/2;
 // D138【假设】: shared platform exchange window, calibrated to paper AM trips.
 // The fixed door budget stays separate; directional demand still drives passengers.
 return Math.max(MIN_DWELL, Math.min(busy ? MAX_DWELL_BUSY : MAX_DWELL,
  PLANNED_DOOR_BUDGET + (32 + exchange * 2) * factor));
}
export function passengerMinimum(board: number, alight: number, crowded: boolean, surge=1): number {
 const rate=DOORS_PER_SIDE*EXCHANGE_PER_DOOR*(crowded?.75:1);
 const exchange=Math.max(7,(board+alight)/rate);
 return Math.max(MIN_DWELL,DOOR_CYCLE+exchange)+Math.min(30,Math.max(0,surge-1)*6);
}
/** Origins keep their published departure slots; the 10-second cap applies to
 * intermediate stops, never to turnback/depot positioning or dispatcher holds. */
export function regulatedDwell(planned: number, minimum: number, arrivalDelay: number): number {
 return Math.max(minimum,planned-(arrivalDelay>0?arrivalDelay:Math.max(-MAX_EARLY_HOLD,arrivalDelay)));
}
