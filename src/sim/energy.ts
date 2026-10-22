/**
 * Traction energy and ATO run levels (D67). Shown only with 设置 › 能耗与运行等级
 * on; diagram operation is the default, with level 1 during daytime (D74).
 *
 * Energy: the motors' power m·F·v at the wheels, through the drive's
 * efficiency to the pantograph. Electric braking feeds power back into the
 * third rail; it is used only when another train in the same or a
 * neighbouring power section is drawing power at that moment, otherwise it
 * is burned in the braking resistors (no energy-storage or inverting
 * substations assumed). Traction only: auxiliaries (air conditioning,
 * lighting) are not counted. All figures 【假设】.
 *
 * Run levels (运行等级): 1 is full ATO performance; 2/3 cruise by coasting
 * down a speed band, and 3 cruises lower. Diagram-only level 4 is slower at
 * night. A train over 20 s late falls back to level 1 to catch up.
 */
import type { Sim } from './engine';
import type { Train } from './model';
import { PERF } from './dynamics';
export { levelBand, levelAccel } from './dynamics';
import { linkChain } from './topology';

/** empty 8-car A-type train (kg) and a passenger */
const MASS0 = 290e3;
const PAX = 60;
/** pantograph → wheel in traction, wheel → pantograph in electric braking */
const ETA_TRAC = 0.85;
const ETA_REGEN = 0.8;
/** power sections (traction substation spacing, m) */
const SECTION = 2500;
/** a train this late (s) runs level 1 whatever the line's level */
export const LEVEL_LATE = 20;

export interface EnergyState {
  /** drawn from the substations for traction (J) */
  drawn: number;
  /** fed back by electric braking (J) */
  regen: number;
  /** of that, taken up by other trains (J) */
  reused: number;
  /** train-km run */
  km: number;
}

export function newEnergy(): EnergyState {
  return { drawn: 0, regen: 0, reused: 0, km: 0 };
}

/** the run level a train actually runs: late trains run level 1 */
export function trainLevel(sim: Sim, tr: Train, delay = tr.delay): number {
  if (delay > LEVEL_LATE) return 1;
  if (sim.runLevel > 0) return sim.runLevel;
  const trip = sim.plan.trips[tr.tripId];
  const task = tr.tasks[0];
  if (!trip || task?.k !== 'stop' || task.trip !== trip.id) return 1;
  if (!trip.revenue) {
    const chain = linkChain(sim.topo, tr.link, tr.off);
    const half = tr.len / 2;
    const ahead = trip.stops.findIndex(s => trip.dir === 'DN'
      ? sim.topo.stations[s.st].chain + half > chain
      : sim.topo.stations[s.st].chain - half < chain);
    return trip.stops[Math.max(0, (ahead < 0 ? trip.stops.length : ahead) - 1)]?.runLevel ?? 1;
  }
  const index = trip.stops.findIndex(s => s.st === task.station);
  return trip.stops[Math.max(0, index - 1)]?.runLevel ?? 1;
}

const draw = new Map<number, number>();
const feed = new Map<number, number>();

export function energyTick(sim: Sim, dt: number) {
  draw.clear();
  feed.clear();
  const e = sim.energy;
  for (const tr of sim.trainList) {
    if (tr.phase !== 'run' || tr.v <= 0) continue;
    e.km += tr.v * dt / 1000;
    // coasting is the running resistance; the motors give the rest
    const motor = tr.eb ? 0 : tr.a + PERF.resist;
    if (Math.abs(motor) < 0.02) continue;
    const p = (MASS0 + tr.load * PAX) * motor * tr.v;
    const sec = Math.floor(linkChain(sim.topo, tr.link, tr.off) / SECTION);
    if (p > 0) draw.set(sec, (draw.get(sec) ?? 0) + p / ETA_TRAC);
    else feed.set(sec, (feed.get(sec) ?? 0) - p * ETA_REGEN);
  }
  for (const p of draw.values()) e.drawn += p * dt;
  // regenerated power goes to trains drawing in this section first, then the neighbours
  const left = new Map(draw);
  for (const [sec, p] of feed) {
    e.regen += p * dt;
    let rest = p;
    for (const s of [sec, sec - 1, sec + 1]) {
      const d = left.get(s) ?? 0;
      const take = Math.min(d, rest);
      left.set(s, d - take);
      rest -= take;
      if (rest <= 0) break;
    }
    e.reused += (p - rest) * dt;
  }
}

/** kWh from J */
export const kWh = (j: number) => j / 3.6e6;
