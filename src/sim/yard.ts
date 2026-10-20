/** Real vehicle stock, workshop occupancy and the shared duty selection rule (D112). */
import type { Sim } from './engine';
import type { Block, SimConfig, VehicleRecord, YardState } from './model';
import type { Topology } from './topology';
import { FLEET, LINE_INFO, OPERATIONS } from '../data/line2';
import { depotMoves, yardNeed } from './timetable';

export type FleetState = Pick<Sim, 'topo' | 'plan' | 'yards' | 'vehicles' | 'depotStock' | 'config' | 't'> & Pick<Sim, 'log'>;
const RULE = OPERATIONS.maintenance;
/** Calendar days, independent of the local timezone and of the per-day simulation clock. */
export function dayNumber(config: Pick<SimConfig, 'date'>): number {
  return Math.floor(Date.parse(`${config.date ?? '2026-01-01'}T00:00:00Z`) / 86400000);
}
export function vehicleName(i: number): string { return FLEET[(i - 1) % FLEET.length].no; }

export function initYards(sim: Pick<Sim, 'topo'>, stock: number[], firstVehicle: number): YardState[] {
  let v = firstVehicle;
  return sim.topo.depots.map((d, i) => {
    const perTrack = Math.max(1, Math.ceil(d.capacity / d.stablingTracks));
    const tracks: string[][] = Array.from({ length: d.stablingTracks }, () => []);
    for (let k = 0; k < stock[i]; k++) {
      const t = tracks.reduce((best, tr, idx) => tr.length < tracks[best].length ? idx : best, 0);
      tracks[t].push(vehicleName(v)); v = (v % LINE_INFO.fleet) + 1;
    }
    return { tracks, perTrack };
  });
}
export function yardCount(y: YardState): number { return y.tracks.reduce((n, t) => n + t.length, 0); }

/** Own seeded stream: initialization/migration must not consume passenger or fault randomness. */
export function initVehicles(sim: Pick<Sim, 'config' | 'vehicles'>) {
  const today = dayNumber(sim.config);
  let seed = sim.config.seed >>> 0;
  const shuffled = FLEET.map(v => v.no);
  for (let i = shuffled.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  shuffled.forEach((no, i) => {
    if (!sim.vehicles.has(no)) sim.vehicles.set(no, { daily: today, monthly: today - Math.floor(i * RULE.monthlyPeriod / (shuffled.length - 1)), km: 0, work: '', depot: -1, until: 0 });
  });
}

/** One rule for live dispatch, overnight shunting and multi-day projection.
 * A duty returning to a workshop receives the oldest monthly examination;
 * other duties the youngest. Line stabling must leave a full inspection day spare. */
export function chooseVehicle(vehicles: ReadonlyMap<string, VehicleRecord>, candidates: readonly string[], topo: Topology, block: Block | undefined, today: number): string | null {
  const monthly = block?.end.kind === 'depot' && topo.depots[block.end.depot].work.monthly;
  const line = block?.end.kind === 'stable';
  return candidates.filter(no => {
    const r = vehicles.get(no);
    return r && !r.work && (!line || today - r.daily < RULE.dailyLimit - 1);
  }).sort((a, b) => {
    const x = vehicles.get(a)!, y = vehicles.get(b)!;
    return (monthly ? x.monthly - y.monthly : y.monthly - x.monthly)
      || (line ? y.daily - x.daily : x.daily - y.daily) || a.localeCompare(b);
  })[0] ?? null;
}

/** Only track heads can leave; all departures (including relief/extras) come here. */
export function peekVehicle(sim: Pick<FleetState, 'topo' | 'vehicles' | 'yards' | 'config'>, depot: number, block?: Block): string | null {
  return chooseVehicle(sim.vehicles, sim.yards[depot].tracks.flatMap(t => t.length ? [t[0]] : []), sim.topo, block, dayNumber(sim.config));
}
export function takeVehicle(sim: FleetState, depot: number, block?: Block): string | null {
  const no = peekVehicle(sim, depot, block);
  if (!no) {
    sim.log('B', '车辆', `${sim.topo.depots[depot].name} 无符合列检余量的车辆，表号 ${block?.svc ?? '-'} 延迟出段`, { key: `fleet-short-${block?.id ?? depot}` });
    return null;
  }
  const y = sim.yards[depot], track = y.tracks.find(t => t[0] === no)!;
  track.shift(); sim.depotStock[depot] = yardCount(y);
  const r = sim.vehicles.get(no)!;
  r.depot = -1;
  if (dayNumber(sim.config) - r.monthly > RULE.monthlyLimit && !(block?.end.kind === 'depot' && sim.topo.depots[block.end.depot].work.monthly))
    sim.log('B', '车辆', `${no} 月检已超 ${RULE.monthlyLimit} 天；剩余表号 ${block?.svc ?? '-'} 不回具备月检能力的车场，继续运用等待回段检修`);
  return no;
}

function futureDuties(sim: Pick<FleetState, 'plan' | 't'>, depot: number): Block[] {
  return depotMoves(sim.plan.blocks, sim.plan.trips).filter(m => m.delta < 0 && m.time >= sim.t && m.depot === depot && sim.plan.blocks[m.block].train === undefined)
    .map(m => sim.plan.blocks[m.block]);
}
/** Predict departure order using the same selector, without mutating the diagram. */
function departureOrder(sim: FleetState, depot: number, candidates: string[]): string[] {
  const left = new Set(candidates), order: string[] = [], today = dayNumber(sim.config);
  for (const block of futureDuties(sim, depot)) {
    const no = chooseVehicle(sim.vehicles, [...left], sim.topo, block, today);
    if (no) { order.push(no); left.delete(no); }
  }
  return [...order, ...left];
}

/** Arrivals go behind vehicles with earlier predicted exits, respecting the existing track length. */
export function putVehicle(sim: FleetState, depot: number, vehicle: string) {
  const y = sim.yards[depot];
  const order = departureOrder(sim, depot, [...y.tracks.flat(), vehicle]);
  const rank = new Map(order.map((no, i) => [no, i]));
  const room = y.tracks.map((t, i) => ({ t, i })).filter(({ t }) => t.length < y.perTrack);
  if (!room.length || yardCount(y) >= sim.topo.depots[depot].capacity) throw new Error(`${sim.topo.depots[depot].name} 停车列位不足：${vehicle}`);
  const fitting = room.filter(({ t }) => !t.length || rank.get(t.at(-1)!)! <= rank.get(vehicle)!);
  const best = (fitting.length ? fitting : room).sort((a, b) => a.t.length - b.t.length || a.i - b.i)[0];
  best.t.push(vehicle); sim.depotStock[depot] = yardCount(y);
  const record = sim.vehicles.get(vehicle); if (record) record.depot = depot;
}

/** Night shunting puts the successive assignments at accessible track heads. */
export function arrangeYard(sim: FleetState, depot: number) {
  const y = sim.yards[depot], order = departureOrder(sim, depot, y.tracks.flat());
  y.tracks.forEach(t => t.splice(0));
  order.forEach((no, i) => y.tracks[i % y.tracks.length].push(no));
}

export interface FleetDayResult { monthly: number; overhaul: number; deferred: number; need: number[] }
/** Release completed work before reserving today's spare vehicles. No diagram or capacity edits. */
export function maintainFleet(sim: FleetState, overnight: boolean, reorder = overnight): FleetDayResult {
  const today = dayNumber(sim.config), need = yardNeed(sim.topo, { ...sim.plan, blocks: sim.plan.blocks.filter(b=>b.train === undefined) });
  const result: FleetDayResult = { monthly: 0, overhaul: 0, deferred: 0, need };
  if (overnight) for (const [depot, yard] of sim.yards.entries()) for (const no of yard.tracks.flat()) {
    const r = sim.vehicles.get(no)!; if (sim.topo.depots[depot].work.daily) r.daily = today;
    r.depot = depot;
  }
  if (overnight) for (const r of sim.vehicles.values()) if (r.work && sim.topo.depots[r.depot].work.daily) r.daily = today;
  for (const [no, r] of sim.vehicles) if (r.work && r.until <= today) {
    r.work = ''; r.monthly = today; r.daily = today; r.until = 0;
    putVehicle(sim, r.depot, no);
  }
  const reserve = (depot: number, no: string, work: 'monthly' | 'overhaul') => {
    const y = sim.yards[depot], track = y.tracks.find(t => t.includes(no))!;
    track.splice(track.indexOf(no), 1);
    const r = sim.vehicles.get(no)!;r.work = work;r.depot = depot;
    r.until = today + (work === 'monthly' ? RULE.monthlyDays : RULE.overhaulDays);
    sim.depotStock[depot] = yardCount(y);result[work]++;
  };
  let overhaul = [...sim.vehicles.values()].filter(r => r.work === 'overhaul').length;
  for (const d of sim.topo.depots) if (d.work.overhaul) {
    const candidates = sim.yards[d.id].tracks.flat().sort((a,b) => sim.vehicles.get(a)!.monthly - sim.vehicles.get(b)!.monthly || a.localeCompare(b));
    while (overhaul < RULE.overhaulCount && candidates.length && yardCount(sim.yards[d.id]) > need[d.id]) {
      reserve(d.id, candidates.shift()!, 'overhaul');overhaul++;
    }
  }
  if (overhaul < RULE.overhaulCount) { result.deferred++;sim.log('B','车辆','架修推迟：具备架修能力车场的可用车不足当天 yardNeed'); }
  for (const d of sim.topo.depots) if (d.work.monthly) {
    const due = sim.yards[d.id].tracks.flat().filter(no => today - sim.vehicles.get(no)!.monthly >= RULE.monthlyPeriod)
      .sort((a,b) => sim.vehicles.get(a)!.monthly - sim.vehicles.get(b)!.monthly || a.localeCompare(b));
    for (const no of due) {
      if (yardCount(sim.yards[d.id]) <= need[d.id]) {
        result.deferred++;sim.log('B','车辆',`${no} 月检推迟：${d.name} 可用 ${yardCount(sim.yards[d.id])} 列，当天 yardNeed ${need[d.id]} 列`);
      } else reserve(d.id, no, 'monthly');
    }
  }
  // First-day numbering/positions remain the established opening placement.
  if (reorder) for (const d of sim.topo.depots) arrangeYard(sim, d.id);
  sim.log('I','车辆运用',`车辆运用：可用 ${sim.depotStock.reduce((a,b)=>a+b,0)} 列在段，月检 ${[...sim.vehicles.values()].filter(r=>r.work==='monthly').length} 列，架修 ${overhaul} 列，推迟 ${result.deferred} 列；各段最低备车 ${need.join('/')}`);
  return result;
}
