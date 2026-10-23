import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deserialize } from 'node:v8';
import { Sim } from '../src/sim/engine';
import type { DayType, SimConfig, Train } from '../src/sim/model';
import { capture, restore, type Checkpoint } from '../src/sim/state';
import { SCENARIOS } from '../src/sim/scenario';

// Scenarios share a seed and initial time. Reuse a verified warm-up snapshot
// (made once per run by tests/globalSetup.ts, or here on first use); each test
// still gets its own simulator and mutable state. The configuration only
// takes effect from `until` (autoRadio, scenario), so it does not change the
// warm-up — except a scenario's own fixed-time trains and noPossessions,
// which must have separate checkpoints.
const warmups = new Map<string, Checkpoint>();

export function makeSim(dayType: DayType = 'weekday', until = 8 * 3600, config: Partial<SimConfig> = {}): Sim {
  const seed = config.seed ?? 7;
  const sim = new Sim({ dayType, dateLabel: 'test', startTime: until, seed, ...config });
  const own = config.scenario && SCENARIOS.find((x) => x.id === config.scenario)?.fixedRuns;
  const key = `${dayType}-${until}-${seed}${config.noPossessions ? '-noPossessions' : ''}${own ? `-${config.scenario}` : ''}`;
  let cp = warmups.get(key);
  const file = process.env.ATSSIM_WARMUPS && join(process.env.ATSSIM_WARMUPS, `${key}.bin`);
  if (!cp && file && existsSync(file)) warmups.set(key, cp = deserialize(readFileSync(file)) as Checkpoint);
  if (cp) {
    restore(sim, cp);
    sim.autoRadio = config.autoRadio ?? true;
    sim.autoDispatch = config.autoDispatch ?? false;
  } else { runUntil(sim, until); warmups.set(key, capture(sim)); }
  return sim;
}

export function runUntil(sim: Sim, t: number, each?: (sim: Sim) => void) {
  let k = 0;
  while (sim.t < t) {
    sim.step();
    if (each && ++k % 10 === 0) each(sim);
  }
}

export function runFor(sim: Sim, seconds: number, each?: (sim: Sim) => void) {
  runUntil(sim, sim.t + seconds, each);
}

/** throws if any two trains share track space (a rescue pair may only touch while coupling) */
export function assertNoCollision(sim: Sim) {
  for (const [link, segs] of sim.linkBodies) {
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const a = segs[i];
        const b = segs[j];
        if (a.train === b.train) continue;
        const ta = sim.trains.get(a.train)!;
        const tb = sim.trains.get(b.train)!;
        const overlap = Math.min(a.to, b.to) - Math.max(a.from, b.from);
        const coupling = (ta.rescuing === tb.id && ta.phase === 'coupling') || (tb.rescuing === ta.id && tb.phase === 'coupling');
        if (coupling && overlap <= 1) continue;
        if (overlap > 0.5) throw new Error(`collision on link ${link}: ${ta.vehicle} / ${tb.vehicle} at t=${sim.t.toFixed(0)}`);
      }
    }
  }
}

/**
 * throws on the first invariant violation found by the simulator's own
 * per-tick checker (src/sim/invariants.ts); the violation with its state
 * snapshot is saved to tests/out/ for diagnosis
 */
export function assertIntegrity(sim: Sim) {
  const v = sim.integrity.violations[0];
  if (!v) return;
  const file = `tests/out/violation-${v.kind}-${Math.round(v.t)}.json`;
  try {
    mkdirSync('tests/out', { recursive: true });
    writeFileSync(file, JSON.stringify(v, null, 1));
  } catch { /* the assertion below is what matters */ }
  throw new Error(`integrity violation ${v.kind} at t=${v.t.toFixed(1)}: ${v.detail} (snapshot ${file})`);
}

/** an in-service train running on the main line near a chainage window, in a given direction */
export function pickTrain(sim: Sim, pred: (tr: Train, ch: number) => boolean): Train {
  const tr = sim.trainList.find((t) => t.inService && t.phase === 'run' && pred(t, sim.trainChain(t)));
  if (!tr) throw new Error('no suitable train');
  return tr;
}

export function dirOf(sim: Sim, tr: Train): 'DN' | 'UP' {
  const l = sim.topo.links[tr.link];
  const east = tr.dir === 1 ? l.chainB >= l.chainA : l.chainA > l.chainB;
  return east ? 'DN' : 'UP';
}
