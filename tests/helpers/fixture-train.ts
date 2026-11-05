import type { Sim } from '../../src/sim/engine';
import type { Train } from '../../src/sim/model';

/** `n` planned trains for a hand-built fixture. No train stands on the main
 * line overnight (D178), so early in the day the simulation first runs on
 * until the yards have sent out `n` (the fixture then places them). */
export function fixtureTrains(sim: Sim, n: number): Train[] {
  const until = sim.t + 3 * 3600;
  while (sim.trainList.length < n && sim.t < until) sim.step();
  if (sim.trainList.length < n) throw new Error(`fixture: fewer than ${n} trains on the line by ${Math.round(sim.t)} s`);
  wholeSecond(sim);
  return sim.trainList.slice(0, n);
}

export function fixtureTrain(sim: Sim): Train { return fixtureTrains(sim, 1)[0]; }

/** The first train satisfying `pred`, running the simulation on (up to 3 h) until one does. */
export function fixtureTrainWhere(sim: Sim, pred: (tr: Train) => boolean): Train {
  const until = sim.t + 3 * 3600;
  let tr: Train | undefined;
  while (!(tr = sim.trainList.find(pred)) && sim.t < until) sim.step();
  if (!tr) throw new Error(`fixture: no matching train by ${Math.round(sim.t)} s`);
  wholeSecond(sim);
  return sim.trainList.includes(tr) && pred(tr) ? tr : fixtureTrainWhere(sim, pred);
}

/** Finish on a whole-second tick, as a fixture built straight after a plain advance would. */
function wholeSecond(sim: Sim) {
  while (sim.secAcc > 1e-9) sim.step();
}
