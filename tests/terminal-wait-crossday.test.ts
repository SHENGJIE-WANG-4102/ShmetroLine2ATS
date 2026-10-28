import { afterAll, expect, it, vi } from 'vitest';
import type { ReverseTask, StopTask } from '../src/sim/model';

afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it('keeps a future tail call-out after a real operating-day carry', async () => {
  vi.stubEnv('ATS_LINE', '14'); vi.resetModules();
  const { Sim } = await import('../src/sim/engine');
  const ats = await import('../src/sim/ats');
  const movement = await import('../src/sim/movement');
  const arbitration = await import('../src/sim/resourceArbitration');
  const timetable = await import('../src/sim/timetable');
  const day = await import('../src/sim/operatingDay');
  const model = await import('../src/sim/model');
  const old = new Sim({ dayType: 'weekend', date: '2026-10-24', dateLabel: 'crossday-wait',
    startTime: 14400, seed: 14201, noPossessions: true, randomFaults: 0, autoDispatch: false });
  const arrival = old.plan.trips.find(t => t.no === '0001')!;
  const departure = old.plan.trips.find(t => t.no === '1004')!;
  const block = old.plan.blocks[departure.block];
  expect(block.trips.indexOf(departure.id)).toBe(block.trips.indexOf(arrival.id) + 1);

  // This real endpoint connection is retimed as a whole to just after the
  // rollover, preserving every interval and making the carried call future.
  const origin = 100500;
  const delta = origin - departure.stops[0].dep;
  departure.stops = departure.stops.map(s => ({ ...s, arr: s.arr + delta, dep: s.dep + delta }));
  const tasks = timetable.blockTasks(old.topo, old.plan, block);
  const end = tasks.findIndex(t => t.k === 'stop' && t.trip === arrival.id && t.station === arrival.to);
  const reverseIndex = tasks.findIndex((t, i) => i > end && t.k === 'reverse');
  const reverse = tasks[reverseIndex] as ReverseTask;
  const berth = old.topo.berths[reverse.chosen];
  expect(['tail', 'siding']).toContain(berth.kind);
  expect((tasks[reverseIndex + 1] as StopTask).trip).toBe(departure.id);
  for (const prior of [...old.trainList]) old.removeTrain(prior);
  const vehicle = [...old.vehicles.keys()][0];
  old.vehicles.get(vehicle)!.uto = { stage: 'ready', until: 0, cycles: 0 };
  const tr = ats.newTrain(old, block, berth.link, berth.offset, berth.dir, [{ link: berth.link, dir: berth.dir }], vehicle);
  tr.tasks = structuredClone(tasks.slice(reverseIndex));
  tr.tripId = arrival.id; tr.stopDist = 0; tr.v = 0; tr.manual = false; tr.mode = 'DTO';
  old.t = 99900;
  movement.computeBody(old, tr);
  ats.updateTrainTasks(old, tr);
  expect(tr.phase).toBe('reversing');
  expect((tr.tasks[1] as StopTask).turnbackWaitBerth).toBe(berth.id);

  const next = new Sim(day.nextOperatingConfig(old));
  day.carryWorld(next, old);
  const carried = next.trains.get(tr.id)!;
  const stop = carried.tasks[1] as StopTask;
  const call = origin - day.DAY_S - model.STANDBY_CALL;
  expect(next.t).toBe(old.t - day.DAY_S);
  expect(next.t).toBeLessThan(call);
  expect(stop.trip).not.toBe(departure.id);
  expect(stop.turnbackWaitBerth).toBe(berth.id);
  expect(arbitration.sourceDepartureAt(next, stop, carried)).toBe(origin - day.DAY_S);
  expect(arbitration.sourceReadyAt(next, stop, carried)).toBe(call);

  // Finish the physically carried cab change, then verify both sides of the
  // call-out boundary while the train remains at its actual tail berth.
  next.t = carried.dwellUntil;
  ats.updateTrainTasks(next, carried);
  expect(carried.phase).toBe('run');
  const first = carried.tasks[0] as StopTask;
  next.t = call - .1;
  expect(arbitration.sourceReadyAt(next, first, carried)).toBe(call);
  expect(movement.scanAhead(next, carried, first.berth)).toMatchObject({ maDist: 0, maCode: 'REGULATION' });
  next.t = call;
  expect(arbitration.sourceReadyAt(next, first, carried)).toBe(call);
  expect(movement.scanAhead(next, carried, first.berth).maCode).not.toBe('REGULATION');
});
