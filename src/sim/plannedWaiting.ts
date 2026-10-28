/** Offline evidence for waits between adjacent live trips. No reservations or
 * runtime decisions are read or written. Depot-source approach times are not
 * inferred: a depot gate time alone is not a platform arrival time. */
import type { Plan } from './model';
import { plannedWaitBerth, plannedNormalWork, plannedWaitLong } from './plannedWaitBerth';
import { blockTasks, effectiveTrip, platformBerth, terminalOccupancy } from './timetable';
import type { Topology } from './topology';
export { plannedNormalWork } from './plannedWaitBerth';

export interface PlannedWait {
  block: number; arrival: number; departure: number; station: number;
  from: number; to: number; gap: number; normalWork: number;
  long: boolean;
  berths: number[]; safeBerths: number[]; selectedBerth?: number; safe: boolean;
  reason: 'NORMAL_WORK' | 'SAFE_WAITING_POINT' | 'NO_SAFE_WAITING_POINT' | 'BLOCK_BREAK';
}
export interface PlannedWaitingIssue {
  severity: 'error'; code: 'UNSAFE_WAIT'; t: number; blocks: number[];
  arrival: number; departure: number; text: string;
}
export interface PlannedWaitingResult {
  waits: PlannedWait[]; issues: PlannedWaitingIssue[];
  /** Explicit gaps in this check, not exceptions to a discovered violation. */
  uncovered: readonly ['depot-start-approach', 'final-stabling'];
}

/** Only adjacent-trip waits are covered. `from` includes waits crossing the
 * boundary; it never edits or exempts earlier issues in a full-plan call.
 * Normal work uses the existing diagram dwell/turn budget, with no extra
 * layover allowance. One physically safe actual berth is sufficient. */
export function plannedWaiting(ctx: { topo: Topology }, plan: Plan, options: { from?: number; connection?: { block:number; arrival:number; departure:number } } = {}): PlannedWaitingResult {
  const { topo } = ctx;
  const waits: PlannedWait[] = [], issues: PlannedWaitingIssue[] = [];
  const occupancy = terminalOccupancy(plan, topo);
  for (const block of plan.blocks) {
    if(options.connection&&options.connection.block!==block.id)continue;
    const trips = block.trips.map(id => plan.trips[id]).filter(t => !t.cancelled).map(effectiveTrip);
    const tasks = blockTasks(topo, plan, block);
    for (let i = 1; i < trips.length; i++) {
      const a = trips[i - 1], d = trips[i];
      if (!a || !d) continue;
      const last = a.stops.at(-1), first = d.stops[0];
      if (!last || !first) continue;
      const from = last.arr, to = first.dep;
      if(options.connection&&(options.connection.arrival!==a.id||options.connection.departure!==d.id))continue;
      if (to < (options.from ?? -Infinity)) continue;
      const turning = a.dir !== d.dir;
      const normalWork = plannedNormalWork(plan.dayType, a, d);
      const long = plannedWaitLong(plan.dayType, a, d);
      const wait: PlannedWait = { block: block.id, arrival: a.id, departure: d.id, station: a.to,
        from, to, gap: to - from, normalWork, long, berths: [], safeBerths: [], safe: false, reason: 'NO_SAFE_WAITING_POINT' };
      waits.push(wait);
      if (a.to !== d.from) { wait.reason = 'BLOCK_BREAK'; continue; }
      const hold = occupancy.get(a.to)?.find(h => h.block === block.id && h.arrival === a.id && h.departure === d.id);
      const lastArrival = tasks.map(t => t.k === 'stop' && t.trip === a.id).lastIndexOf(true);
      const firstDeparture = tasks.findIndex((t, index) => index > lastArrival && t.k === 'stop' && t.trip === d.id);
      const reverse = lastArrival >= 0 && firstDeparture > lastArrival
        ? tasks.findIndex((t, index) => index > lastArrival && index < firstDeparture && t.k === 'reverse') : -1;
      const reverseTask = tasks[reverse];
      // Use both the actual task and the same duty/occupancy candidates; a
      // fixed hot-spare task is its own physical source of truth.
      wait.berths = turning ? reverseTask?.k === 'reverse' ? reverseTask.berths.slice() : []
        : [platformBerth(topo, a.to, a.dir)];
      if (turning && !a.standby && hold?.berths?.length)
        wait.berths = wait.berths.filter(berth => hold.berths!.includes(berth));
      const choice = plannedWaitBerth(topo, a, d, tasks, reverse, wait.berths,
        reverseTask?.k === 'reverse' ? reverseTask.chosen : hold?.berths?.[0]);
      wait.selectedBerth = choice.selectedBerth;
      wait.safeBerths = choice.safeBerths;
      wait.safe = !long || choice.safe;
      wait.reason = !long ? 'NORMAL_WORK' : wait.safe ? 'SAFE_WAITING_POINT' : 'NO_SAFE_WAITING_POINT';
      if (!wait.safe) {
        const reason = choice.selectedBerth === undefined ? '没有可执行的折返候班泊位'
          : choice.policyRejected ? '该站未配置站台长候班，且无可选安全尾轨或折返线'
            : `选定泊位 ${topo.berths[choice.selectedBerth]?.name ?? choice.selectedBerth} 无法全列安全等待`;
        issues.push({ severity: 'error', code: 'UNSAFE_WAIT', t: from, blocks: [block.id], arrival: a.id, departure: d.id,
          text: `${topo.stations[a.to].name} ${a.no}→${d.no} 候班 ${wait.gap.toFixed(1)} s，正常作业 ${normalWork.toFixed(1)} s，${reason}` });
      }
    }
  }
  return { waits, issues, uncovered: ['depot-start-approach', 'final-stabling'] };
}
