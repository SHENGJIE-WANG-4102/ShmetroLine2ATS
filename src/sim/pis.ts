/**
 * Passenger information (PIS) for one station: next trains per platform
 * with destination and estimated arrival, derived from the trains' task
 * lists, their current delay and position.
 */
import type { Sim } from './engine';
import type { PisData, PisRow, TrackDir } from './model';
import { STATIONS, LINE_INFO, SIMULATION, stationOpened } from '../data/current';
const RULES = SIMULATION.pis;
import { FIRST_LAST } from '../data/current';
import { PERF } from './dynamics';
import { effectiveStops, serviceEnd } from './timetable';

/** Platform countdown: it counts down to the train standing in the platform
 *  (an arriving train still counts), then reads 00:00 while it stands. */
export function formatPisCountdown(row: PisRow | undefined): string {
  if (!row) return '00:00';
  if (row.status === 'at' || row.status === 'departing') return '00:00';
  if (row.eta > 3600) return '预计大于1小时';
  const seconds = Math.max(0, Math.round(row.eta));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

export interface PisFirstLast { destination: string; first: string; last: string }

/** Screen time is wall-clock time, independent of simulation speed. 10-16 video measurements, D86. */
export const PIS_TIMING = RULES.timing;

export interface PisCycleState { page: number; since: number }

/** Advance an existing page without restarting it when a countdown or train list changes. */
export function advancePisCycle(state: PisCycleState, now: number, durations: readonly number[]): PisCycleState {
  if (!durations.length) return { page: 0, since: now };
  let page = state.page % durations.length, since = state.since;
  const cycle = durations.reduce((a, b) => a + b, 0);
  if (now - since >= cycle) since += Math.floor((now - since) / cycle) * cycle;
  while (now - since >= durations[page]) {
    since += durations[page]; page = (page + 1) % durations.length;
  }
  return { page, since };
}

/** Published times at this station, with the first train's destination first. */
export function selectPisFirstLast(station: string, track: TrackDir, first?: PisRow): PisFirstLast[] {
  const row = FIRST_LAST.find((r) => r.station === station);
  if (!row) return [];
  const to = STATIONS[first?.destSt ?? -1];
  const dest = to && to.name !== station ? to.id : undefined;
  // 【假设】龙阳路、淞虹路等其他终点没有单独的官方列，沿用该方向大交路。
  // 无车或本站终到时也按站台方向显示，避免把到达本站的车当成发车方向。
  const rules = RULES.destinations;
  const service = rules.find(r => r.station === dest) ?? rules.find(r => r.station === RULES.defaults[track]);
  if (!service) return [];
  const time = (s: string) => s ? `${String(Number(s.slice(0, 2)) % 24).padStart(2, '0')}${s.slice(2)}` : '--:--';
  const item = (rule: typeof service): PisFirstLast => ({
    destination: STATIONS.find(s => s.id === rule.station)!.name,
    first: time(row[rule.first]), last: time(row[rule.last]),
  });
  const services = [service];
  for (const alt of service.alternatives) {
    const target = rules.find(r => r.station === alt.station);
    if (target && (!alt.when || row[alt.when])) services.push(target);
  }
  return services.map(item);
}

/** time for a train at `v` to stand at its stopping point `d` ahead: on at
 *  its speed, then braking as ATO plans it; a train standing or crawling
 *  (held at a signal) is given the old rough allowance */
export function timeToStop(v: number, d: number): number {
  if (v < 1) return d / 8 + 8;
  const brake = v * v / (2 * PERF.bPlan);
  return d > brake ? (d - brake) / v + v / PERF.bPlan : 2 * d / v;
}

export function computePis(sim: Sim, station: number): PisData {
  const { topo } = sim;
  const out: PisData = { station, DN: [], UP: [], notice: '' };
  if (!stationOpened(station)) return { ...out, notice: '本站未开通，列车通过不停车', skip: { DN: true, UP: true } };
  const listed = new Set<number>();
  for (const tr of sim.trainList) {
    if (tr.failed && tr.phase !== 'dwell') continue;
    let prevEta = sim.t;
    const late = Math.max(0, tr.delay);
    for (let i = 0; i < Math.min(tr.tasks.length, 16); i++) {
      const t = tr.tasks[i];
      if (t.k !== 'stop') continue;
      let eta: number;
      if (i === 0 && tr.phase === 'dwell') eta = sim.t;
      else if (i === 0 && Number.isFinite(tr.stopDist)) eta = sim.t + timeToStop(tr.v, tr.stopDist);
      else eta = Math.max(prevEta + 45, (t.arr ?? t.dep ?? sim.t) + late);
      prevEta = eta;
      if (t.station !== station) continue;
      const p = topo.berths[t.berth].platform;
      // an empty move ending here (it may start in service from here next), or a
      // call the train will pass (skip-stop, 跳停 / 封站): no train for this board yet
      if (!t.revenue || !t.doors || sim.plat[p].skip || tr.skipStations.has(station)) continue;
      const track = topo.platforms[p].track;
      let status: PisRow['status'] = 'eta';
      if (i === 0 && tr.phase === 'dwell') status = tr.doorsOpen ? 'at' : 'departing';
      else if (i === 0 && tr.stopDist < 350) status = 'arriving';
      const trip = t.trip >= 0 ? sim.plan.trips[t.trip] : null;
      const tripEnd = trip ? serviceEnd(sim.plan, trip) : undefined;
      if (trip && tripEnd === undefined) continue;
      // a train terminating here is still listed by its destination name, as photographed (D86)
      const end = t.dep === null ? station : tripEnd ?? -1;
      const dest = end >= 0 ? STATIONS[end].name : tr.destText;
      // a train starting here waits for its planned departure
      if (status === 'eta' && t.dep !== null && t.arr === null) eta = Math.max(eta, t.dep - 60);
      listed.add(t.trip);
      // 【假设】客流模型只有全列总量；逐节按等容量、均匀分布展示，不伪造节间差异。
      const load = Math.min(1.3, tr.load / LINE_INFO.capacity);
      out[track].push({ dest, ...(t.noBoard ? { noBoard: true } : {}), destSt: end, dwellRemaining: i === 0 && tr.phase === 'dwell' && t.dep !== null ? Math.max(0, tr.dwellUntil - sim.t) : undefined, eta: Math.max(0, eta - sim.t), status, trip: trip?.no ?? tr.tripNo, load,
        ...(LINE_INFO.cars ? { carLoads: Array(LINE_INFO.cars).fill(load) } : {}) });
      break;
    }
  }
  // Origin boards also count down an assigned departure while its car is
  // still in a tail track, an earlier trip, or waiting for its yard exit.
  // Never invent a vehicle for an unassigned/cancelled/withdrawn duty.
  for (const trip of sim.plan.trips) {
    if (trip.from !== station || !trip.revenue || trip.cancelled || trip.completed || listed.has(trip.id)) continue;
    const first = effectiveStops(trip)[0], block = sim.plan.blocks[trip.block];
    if (!first?.stop || first.noBoard || !block?.trips.includes(trip.id)) continue;
    const platform = topo.stations[station].platforms[trip.dir];
    if (sim.plat[platform].skip) continue;
    const vehicle = sim.trainList.find(t => t.block === block.id);
    const assigned = vehicle ? !vehicle.failed && !vehicle.withdrawn && !vehicle.skipStations.has(station)
      // A trip remains active after leaving its origin. Only its unconsumed
      // origin call can put it back on this board, not a later stop of that trip.
      && vehicle.tasks.some(t => t.k === 'stop' && t.trip === trip.id && t.station === station)
      : block.train === undefined && block.start.kind === 'depot' && block.start.time >= sim.t && first.dep >= sim.t;
    if (!assigned) continue;
    // a late car still to come keeps its place on the board, delayed by its
    // present lateness, rather than counting to zero and vanishing
    const expected = first.dep + (vehicle ? Math.max(0, vehicle.delay) : 0);
    const end = serviceEnd(sim.plan, trip);
    if (end === undefined) continue;
    out[trip.dir].push({ dest: STATIONS[end].name, destSt: end, eta: Math.max(0, expected - sim.t),
      status: 'eta', trip: trip.no, load: vehicle ? Math.min(1.3, vehicle.load/LINE_INFO.capacity) : 0,
      ...(LINE_INFO.cars ? { carLoads: Array(LINE_INFO.cars).fill(vehicle ? Math.min(1.3, vehicle.load / LINE_INFO.capacity) : 0) } : {}) });
  }
  for (const k of ['DN', 'UP'] as const) out[k] = out[k].sort((a, b) => a.eta - b.eta).slice(0, 3);
  // per platform: passed by every train (跳停 / 封站), and the next and the last
  // planned departure with boarding — what an empty board says
  const sp = topo.stations[station].platforms;
  out.skip = { DN: sim.plat[sp.DN].skip, UP: sim.plat[sp.UP].skip };
  const next: PisData['next'] = {}, done: PisData['done'] = {}, ahead: PisData['ahead'] = {};
  for (const trip of sim.plan.trips) {
    if (!trip.revenue || trip.cancelled) continue;
    const stops = effectiveStops(trip);
    for (let i = 0; i < stops.length - 1; i++) {
      const x = stops[i];
      if (x.st !== station || !x.stop || x.noBoard) continue;
      const k = trip.dir as 'DN' | 'UP';
      if (x.dep >= sim.t) { next[k] = Math.min(next[k] ?? Infinity, x.dep); ahead[k] = (ahead[k] ?? 0) + 1; }
      else done[k] = true;
    }
  }
  out.next = next; out.done = done; out.ahead = ahead;
  // notices
  const notes: string[] = [];
  const s = topo.stations[station];
  if (sim.plat[s.platforms.DN].skip && sim.plat[s.platforms.UP].skip) notes.push('本站临时封站，列车通过不停车，请乘客至邻近车站乘车');
  else if (sim.plat[s.platforms.DN].skip || sim.plat[s.platforms.UP].skip) notes.push('本站部分方向列车跳站通过，请留意列车信息');
  if (sim.plat[s.platforms.DN].esp || sim.plat[s.platforms.UP].esp) notes.push('站台临时停止服务，请听从工作人员指挥');
  if (sim.plat[s.platforms.DN].surge > 1 || sim.plat[s.platforms.UP].surge > 1) notes.push('本站客流较大，请有序候车，注意安全');
  if (sim.plat[s.platforms.DN].limitUntil > sim.t) notes.push('本站实施客流控制，请耐心等候');
  if (sim.env.wind > 0 || sim.env.rain) notes.push(RULES.weatherNotice);
  for (const a of sim.alarms.values()) {
    if ((a.level === 'A' || a.level === 'B') && (a.cat === '信号' || a.cat === '列车')) { notes.push('因设备故障，列车运行间隔有所延长，请耐心候车'); break; }
  }
  out.notice = notes[0] ?? `${RULES.welcome} · ${STATIONS[station].name}站`;
  return out;
}
