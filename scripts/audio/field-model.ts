/** Read-only, isolated section probes using the production doors, ARS and ATO.
 * No controller override: sectionCruise and planned running levels stay active.
 */
import { Sim } from '../../src/sim/engine';
import { newTrain } from '../../src/sim/ats';
import { buildStops, tripTasks, platformBerth, dwellFactorAt } from '../../src/sim/timetable';
import { releaseRoute } from '../../src/sim/interlocking';
import { computeBody, indexBodies, scanAhead, goalBerth, MA_NEAR } from '../../src/sim/movement';
import { sectionCruise, PERF } from '../../src/sim/dynamics';
import { sectionEta } from '../../src/sim/dynamics';
import * as movement from '../../src/sim/movement';
import { ahead } from '../../src/sim/topology';
import { trainLevel } from '../../src/sim/energy';
import type { TrackDir, Train } from '../../src/sim/model';

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : null;
};

export function probeSection(sim: Sim, from: number, to: number, dir: TrackDir, clock: number) {
  if (!ahead(dir, from, to) || Math.abs(to - from) !== 1) throw new Error('Probe requires adjacent stations in travel order');
  for (const tr of [...sim.trainList]) sim.removeTrain(tr);
  for (const id of [...sim.routes.keys()]) releaseRoute(sim, id);
  for (const b of sim.plan.blocks) sim.blockDone.add(b.id);
  sim.t = clock - 60;
  const berth = sim.topo.berths[platformBerth(sim.topo, from, dir)];
  const id = sim.plan.trips.length, blockId = sim.plan.blocks.length;
  // Include one onward stop so the measured destination gets an ordinary dwell.
  const onward = sim.topo.stations.find(st => ahead(dir, to, st.index) && Math.abs(st.index - to) === 1)?.index ?? to;
  const stops = buildStops(sim.planCtx, dir, from, onward, clock, true, t => dwellFactorAt('weekday', t));
  const trip = { ...sim.plan.trips[0], id, no: 'probe', from, to: onward, dir, block: blockId, stops, cancelled: false, completed: false };
  sim.plan.trips.push(trip);
  const block = { ...sim.plan.blocks[0], id: blockId, svc: 'probe', start: { kind: 'stable' as const, station: from, berth: berth.id }, end: { kind: 'none' as const }, trips: [id] };
  sim.plan.blocks.push(block); sim.blockDone.add(blockId); sim.planRev++;
  const tr = newTrain(sim, block, berth.link, berth.offset, berth.dir, [{ link: berth.link, dir: berth.dir }], '0200');
  tr.tripId = id; tr.tripNo = trip.no; tr.inService = true; tr.mode = 'DTO'; tr.level = 'CBTC';
  // 【假设】dry rail, 200 passengers, no leading train; a controlled baseline.
  tr.load = 200;
  tripTasks(sim.topo, trip, tr.tasks, false); computeBody(sim, tr); indexBodies(sim);
  const actual: number[] = [], targets: number[] = [], permits: number[] = [], levels = new Set<number>();
  const cruises: number[] = [], ceilings: number[] = [];
  let missingStopSamples = 0;
  let travelled = 0;
  const trajectory: { metres: number; t: number; v: number; target: number }[] = [];
  const low40: { t: number; cruiseKmh: number; distanceM: number; budgetS: number; spareS: number; level: number }[] = [];
  const budgetDistance = (movement as unknown as { regulationDistance?: (s: Sim, t: Train) => number }).regulationDistance;
  const budgetProfile = (movement as unknown as { regulationProfile?: typeof movement.regulationProfile }).regulationProfile;
  let lastCruiseSample = -Infinity;
  let arrival: number | null = null, opening: number | null = null, locked: number | null = null;
  const initialViolations = sim.integrity.violations.length;
  while (sim.t < clock + 1500) {
    sim.step();
    if (tr.phase === 'run' && tr.tasks[0]?.k === 'stop' && tr.tasks[0].station === to) {
      actual.push(tr.v * 3.6);
      travelled += tr.lastDs;
      trajectory.push({ metres: travelled, t: sim.t, v: tr.v * 3.6, target: tr.vTarget * 3.6 });
      // Report the actual selected target away from the station braking zone.
      if (tr.stopDist > 500 && tr.v > 5) { targets.push(tr.vTarget * 3.6); permits.push(tr.vPermit * 3.6); }
      if (tr.stopDist > 500 && tr.v > 5 && sim.t - lastCruiseSample >= 1) {
        const task = tr.tasks[0], scan = scanAhead(sim, tr, goalBerth(tr), MA_NEAR);
        const margin = tr.delay > 2 ? PERF.atoFastMargin : PERF.atoMargin;
        const profile = budgetProfile?.(sim, tr);
        const ceiling = profile ? PERF.vMax - margin : Math.max(.1, scan.vBody - margin);
        const distance = profile?.distance ?? (budgetDistance ? budgetDistance(sim, tr) : scan.stopDist);
        // Read-only sample of the same public section controller, at most one
        // 0.1s physics step after the stored vTarget above. It sets no state.
        if (task.arr !== null) {
          const cruise = sectionCruise(distance, tr.v, task.arr - sim.t, ceiling, profile?.limits, margin) * 3.6;
          cruises.push(cruise); ceilings.push(ceiling * 3.6);
          if (!Number.isFinite(distance)) missingStopSamples++;
          if (cruise < 40) low40.push({ t: sim.t, cruiseKmh: cruise, distanceM: distance, budgetS: task.arr - sim.t,
            spareS: task.arr - sim.t - sectionEta(distance, tr.v, ceiling, profile?.limits, margin), level: trainLevel(sim, tr) });
        }
        lastCruiseSample = sim.t;
      }
      levels.add(trainLevel(sim, tr));
    }
    if (tr.stopsMade >= 2 && arrival === null) arrival = sim.t;
    if (arrival !== null && tr.doorsOpen && opening === null) opening = sim.t;
    if (arrival !== null && tr.doorLockedAt && tr.doorLockedAt >= arrival) locked = tr.doorLockedAt;
    if (arrival !== null && (sim.depLog.some(d => d.st === to && d.trip === id) || onward === to)) break;
  }
  const departure = sim.depLog.find(d => d.st === from && d.trip === id)?.t ?? null;
  const nextDeparture = sim.depLog.find(d => d.st === to && d.trip === id)?.t ?? null;
  const destination = stops.find(st => st.st === to)!;
  const result = { from, to, dir, clock, regulated: true, seed: 7, passengers: 200,
    plannedRun: destination.arr - stops[0].dep, plannedDwell: destination.dep - destination.arr,
    departure, arrival, opening, locked, nextDeparture,
    run: arrival !== null && departure !== null ? arrival - departure : null,
    dwell: arrival !== null && nextDeparture !== null ? nextDeparture - arrival : null,
    departureToDeparture: departure !== null && nextDeparture !== null ? nextDeparture - departure : null,
    targetMedianKmh: quantile(targets, .5), targetP10Kmh: quantile(targets, .1), targetP90Kmh: quantile(targets, .9),
    permitMedianKmh: quantile(permits, .5), peakKmh: actual.length ? Math.max(...actual) : null,
    cruiseMedianKmh: quantile(cruises, .5), cruiseP10Kmh: quantile(cruises, .1), cruiseP90Kmh: quantile(cruises, .9),
    cruiseReducedFraction: cruises.length ? cruises.filter((v, i) => v < ceilings[i] - 1).length / cruises.length : null,
    cruiseSamples: cruises.length, stopDistanceUnavailableFraction: cruises.length ? missingStopSamples / cruises.length : null,
    cruiseMinimumKmh: cruises.length ? Math.min(...cruises) : null, low40,
    progressThirds: [0, 1, 2].map(third => {
      const points = trajectory.filter(p => p.metres / travelled >= third / 3 && p.metres / travelled < (third + 1) / 3);
      return { third, speedMedianKmh: quantile(points.map(p => p.v), .5), targetMedianKmh: quantile(points.map(p => p.target), .5) };
    }),
    arrivalDeltaS: arrival === null ? null : arrival - destination.arr,
    earlyArrivalS: arrival === null ? null : Math.max(0, destination.arr - arrival),
    dwellAbovePlannedS: arrival === null || nextDeparture === null ? null : nextDeparture - arrival - (destination.dep - destination.arr),
    actualP90Kmh: quantile(actual, .9), levels: [...levels], samples: actual.length, targetSamples: targets.length,
    completed: arrival !== null && departure !== null, halt: tr.halt,
    violations: sim.integrity.violations.slice(initialViolations) };
  trip.completed = true;
  return result;
}

export function createProbeWorld() {
  const sim = new Sim({ dayType: 'weekday', dateLabel: 'field-calibration', startTime: 14400, seed: 7, noPossessions: true, autoRadio: true });
  sim.step();
  for (const trip of sim.plan.trips) trip.completed = true;
  return sim;
}
