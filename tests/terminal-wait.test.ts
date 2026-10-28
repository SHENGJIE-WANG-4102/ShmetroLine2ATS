import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sim as Simulator } from '../src/sim/engine';
import type { StopTask, ReverseTask } from '../src/sim/model';

describe('planned terminal waiting', () => {
  let Sim: typeof Simulator;
  let ats: typeof import('../src/sim/ats');
  let timetable: typeof import('../src/sim/timetable');
  let movement: typeof import('../src/sim/movement');
  let arbitration: typeof import('../src/sim/resourceArbitration');
  let checker: typeof import('../src/sim/plannedWaiting');
  let STANDBY_CALL: number;
  beforeAll(async () => {
    vi.stubEnv('ATS_LINE', '14'); vi.resetModules();
    Sim = (await import('../src/sim/engine')).Sim;
    ats = await import('../src/sim/ats');
    timetable = await import('../src/sim/timetable');
    movement = await import('../src/sim/movement');
    arbitration = await import('../src/sim/resourceArbitration');
    checker = await import('../src/sim/plannedWaiting');
    STANDBY_CALL = (await import('../src/sim/model')).STANDBY_CALL;
  });
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  function fixture(alternative = false) {
    const sim = new Sim({ dayType: 'weekend', date: '2026-10-24', dateLabel: 'terminal-wait',
      startTime: 14400, seed: 14201, noPossessions: true, autoDispatch: false });
    const a = sim.plan.trips.find(t => t.no === '0001')!;
    const d = sim.plan.trips.find(t => t.no === '1004')!;
    const block = sim.plan.blocks[d.block];
    expect(block.trips.indexOf(d.id)).toBe(block.trips.indexOf(a.id) + 1);
    const tasks = timetable.blockTasks(sim.topo, sim.plan, block);
    const first = tasks.findIndex(t => t.k === 'stop' && t.trip === a.id);
    const reverseIndex = tasks.findIndex((t, i) => i > first && t.k === 'reverse');
    const reverse = tasks[reverseIndex] as ReverseTask;
    const next = tasks[reverseIndex + 1] as StopTask;
    expect(next.trip).toBe(d.id);
    const selected = alternative ? reverse.berths.at(-1)! : reverse.chosen;
    const berth = sim.topo.berths[selected];
    expect(['tail', 'siding']).toContain(berth.kind);
    for (const old of [...sim.trainList]) sim.removeTrain(old);
    const vehicle = [...sim.vehicles.keys()][0], record = sim.vehicles.get(vehicle)!;
    record.uto = { stage: 'ready', until: 0, cycles: 0 };
    const tr = ats.newTrain(sim, block, berth.link, berth.offset, berth.dir, [{ link: berth.link, dir: berth.dir }], vehicle);
    tr.tasks = structuredClone(tasks.slice(reverseIndex));
    (tr.tasks[0] as ReverseTask).chosen = selected;
    tr.stopDist = 0; tr.v = 0; tr.manual = false; tr.mode = 'DTO'; tr.tripId = a.id;
    movement.computeBody(sim, tr);
    return { sim, tr, a, d, block, tasks, reverseIndex, berth };
  }

  it('uses the selected safe tail in the checker and the actual reverse task', () => {
    const { sim, a, d, block, tasks, reverseIndex } = fixture();
    const result = checker.plannedWaiting(sim.planCtx, sim.plan, { connection: { block: block.id, arrival: a.id, departure: d.id } });
    const reverse = tasks[reverseIndex] as ReverseTask;
    expect(result.waits).toHaveLength(1);
    expect(result.waits[0].selectedBerth).toBe(reverse.chosen);
    expect(result.waits[0].safeBerths).toContain(reverse.chosen);
    // Merely building or extending a duty must not immobilise an online train.
    expect((tasks[reverseIndex + 1] as StopTask).turnbackWaitBerth).toBeUndefined();
  });

  it('waits in the physically reached tail until the existing call-out window', () => {
    const { sim, tr, d, berth } = fixture();
    ats.updateTrainTasks(sim, tr);
    expect(tr.phase).toBe('reversing');
    const next = tr.tasks[1] as StopTask;
    expect(next.turnbackWaitBerth).toBe(berth.id);
    expect(arbitration.sourceDepartureAt(sim, next)).toBe(d.stops[0].dep);
    const call = d.stops[0].dep - STANDBY_CALL;
    expect(arbitration.sourceReadyAt(sim, next, tr)).toBe(call);
    const request = arbitration.collectResourceRequests(sim).find(r => r.id === tr.id);
    expect(request).toBeDefined();
    expect(request!.safeHere).toBe(true);
    expect(request!.readyAt).toBeGreaterThanOrEqual(call);
    sim.t = tr.dwellUntil; ats.updateTrainTasks(sim, tr);
    expect(tr.phase).toBe('run');
    const first = tr.tasks[0] as StopTask;
    sim.t = call - .1;
    expect(movement.scanAhead(sim, tr, first.berth)).toMatchObject({ maDist: 0, maCode: 'REGULATION', maReason: '折返线图定候班' });
    sim.t = call;
    expect(arbitration.sourceReadyAt(sim, first, tr)).toBe(sim.t);
    expect(movement.scanAhead(sim, tr, first.berth).maCode).not.toBe('REGULATION');
  });

  it('uses the actual trip origin for a positioning trip whose first task has no departure', () => {
    const { sim, tr, d } = fixture();
    ats.updateTrainTasks(sim, tr);
    const marked = tr.tasks[1] as StopTask;
    expect(arbitration.sourceDepartureAt(sim, { ...marked, arr: null, dep: null })).toBe(d.stops[0].dep);
    expect(arbitration.sourceDepartureAt(sim, { ...marked, dep: d.stops[0].dep + 900 })).toBe(d.stops[0].dep);
    expect(arbitration.sourceReadyAt(sim, { ...marked, turnbackWaitBerth: undefined })).toBe(-Infinity);
  });

  it('clears an unknown departure alarm when the same trip becomes valid again', () => {
    const { sim, tr, d } = fixture();
    ats.updateTrainTasks(sim, tr);
    const marked = tr.tasks[1] as StopTask;
    const original = d.stops[0].dep;
    d.stops[0].dep = NaN;
    expect(arbitration.sourceDepartureAt(sim, marked, tr)).toBeNull();
    expect(sim.alarms.has(`turnback-departure-train-${tr.id}`)).toBe(true);
    d.stops[0].dep = original;
    expect(arbitration.sourceDepartureAt(sim, marked, tr)).toBe(original);
    expect(sim.alarms.has(`turnback-departure-train-${tr.id}`)).toBe(false);
  });

  it('retains the original standby and overnight readiness when both markers are present', () => {
    const { sim, tr, d } = fixture();
    ats.updateTrainTasks(sim, tr);
    const marked = tr.tasks[1] as StopTask;
    const dep = d.stops[0].dep + 900;
    for (const flag of ['standby', 'stabledOut'] as const) {
      const existing = { ...marked, [flag]: true, dep };
      expect(arbitration.sourceDepartureAt(sim, existing)).toBe(dep);
      expect(arbitration.sourceReadyAt(sim, existing)).toBe(dep - STANDBY_CALL);
      expect(arbitration.sourceWaitReason(existing)).toBe(flag === 'standby' ? '热备待命' : '存车待发');
    }
  });

  it('does not mark a reverse that has not physically reached its selected berth', () => {
    const { sim, tr } = fixture();
    tr.off -= 3;
    tr.stopDist = 3;
    ats.updateTrainTasks(sim, tr);
    expect((tr.tasks[1] as StopTask).turnbackWaitBerth).toBeUndefined();
  });

  it.each([3, 5, -3])('keeps the call-out for an accepted manual stop %s m from the tail mark', error => {
    const { sim, tr, d, berth } = fixture();
    tr.manual = true; tr.mode = 'CM';
    tr.off = berth.offset - berth.dir * error;
    movement.computeBody(sim, tr);
    ats.updateTrainTasks(sim, tr);
    expect(tr.phase).toBe('reversing');
    expect((tr.tasks[1] as StopTask).turnbackWaitBerth).toBe(berth.id);
    const request = arbitration.collectResourceRequests(sim).find(r => r.id === tr.id);
    expect(request).toBeDefined();
    expect(request!.safeHere).toBe(true);
    expect(request!.readyAt).toBeGreaterThanOrEqual(d.stops[0].dep - STANDBY_CALL);
  });

  it('does not certify a physically overlong consist as fully clear at a tail mark', () => {
    const { sim, tr } = fixture();
    tr.len = sim.topo.links[tr.link].len + 500;
    movement.computeBody(sim, tr);
    ats.updateTrainTasks(sim, tr);
    expect(tr.phase).toBe('reversing');
    expect((tr.tasks[1] as StopTask).turnbackWaitBerth).toBeUndefined();
    expect(sim.events).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TURNBACK_WAIT_UNSAFE', train: tr.id })]));
    const key = `turnback-wait-unsafe-${tr.id}`;
    expect(sim.alarms.has(key)).toBe(true);
    tr.phase = 'run'; tr.v = .1; tr.lastDs = .01;
    ats.updateTrainTasks(sim, tr);
    expect(sim.alarms.has(key)).toBe(false);
  });

  it('uses the chosen berth identity even when the section belongs to an adjacent station', () => {
    const { sim, tr, d, berth } = fixture();
    ats.updateTrainTasks(sim, tr);
    const next = tr.tasks[1] as StopTask;
    const section = sim.topo.sections[sim.topo.links[berth.link].section], previous = section.station;
    try {
      section.station = previous + 1;
      expect(arbitration.sourceReadyAt(sim, next, tr)).toBe(d.stops[0].dep - STANDBY_CALL);
    } finally { section.station = previous; }
  });

  it('consumes the marker once physical departure begins', () => {
    const { sim, tr } = fixture();
    ats.updateTrainTasks(sim, tr);
    sim.t = tr.dwellUntil; ats.updateTrainTasks(sim, tr);
    expect((tr.tasks[0] as StopTask).turnbackWaitBerth).toBeDefined();
    tr.v = .1; tr.lastDs = .01;
    ats.updateTrainTasks(sim, tr);
    expect((tr.tasks[0] as StopTask).turnbackWaitBerth).toBeUndefined();
  });

  it('applies the same physical test if the arbiter chooses the other safe tail', async () => {
    const { sim, tr, a, d, tasks, reverseIndex, berth } = fixture(true);
    const reverse = tasks[reverseIndex] as ReverseTask;
    expect(reverse.berths.length).toBeGreaterThan(1);
    expect(berth.id).not.toBe(reverse.chosen);
    const { plannedWaitBerth } = await import('../src/sim/plannedWaitBerth');
    expect(plannedWaitBerth(sim.topo, a, d, tr.tasks, 0, [berth.id], berth.id)).toMatchObject({ selectedBerth: berth.id, safe: true });
    ats.updateTrainTasks(sim, tr);
    expect((tr.tasks[1] as StopTask).turnbackWaitBerth).toBe(berth.id);
  });

  it('selects and offers only a safe tail when the preferred candidate cannot contain the train', async () => {
    const { sim, a, d, block, tasks, reverseIndex } = fixture();
    const reverse = tasks[reverseIndex] as ReverseTask;
    expect(reverse.berths.length).toBeGreaterThan(1);
    const [unsafe, safe] = reverse.berths;
    const { buildTopology } = await import('../src/sim/topology');
    const topo = buildTopology(), target = topo.berths[unsafe];
    target.offset = target.dir === 1 ? 0 : topo.links[target.link].len;
    const { plannedWaitBerth } = await import('../src/sim/plannedWaitBerth');
    expect(plannedWaitBerth(topo, a, d, tasks, reverseIndex, [unsafe, safe], unsafe))
      .toMatchObject({ selectedBerth: safe, safeBerths: [safe], safe: true });
    const actual = timetable.blockTasks(topo, sim.plan, block);
    const arrival = actual.map(t => t.k === 'stop' && t.trip === a.id).lastIndexOf(true);
    const selected = actual.find((t, i) => i > arrival && t.k === 'reverse') as ReverseTask;
    expect(selected).toMatchObject({ chosen: safe, berths: [safe] });
    expect(checker.plannedWaiting({ topo }, sim.plan, { connection: { block: block.id, arrival: a.id, departure: d.id } }).waits[0])
      .toMatchObject({ selectedBerth: safe, safe: true });
  });

  it('stays at the arrival platform and names the actual holder when every safe tail is occupied', () => {
    const { sim, tr, a, tasks, reverseIndex } = fixture();
    const arrivalIndex = tasks.findIndex(t => t.k === 'stop' && t.trip === a.id && t.station === a.to);
    const stop = tasks[arrivalIndex] as StopTask;
    const platform = sim.topo.berths[stop.berth];
    Object.assign(tr, { link: platform.link, off: platform.offset, dir: platform.dir,
      hist: [{ link: platform.link, dir: platform.dir }], phase: 'dwell', doorsOpen: false,
      doorsAwait: false, doorSide: '', doorMotion: undefined, doorLockedAt: 0,
      dwellUntil: sim.t - 1, depReadyAt: sim.t - 1, maDist: 1000, lastStation: a.to });
    tr.tasks = structuredClone(tasks.slice(arrivalIndex));
    movement.computeBody(sim, tr);
    const holders: number[] = [];
    const reverse = tasks[reverseIndex] as ReverseTask;
    for (const id of reverse.berths) {
      const b = sim.topo.berths[id];
      const holder = ats.newTrain(sim, null, b.link, b.offset, b.dir, [{ link: b.link, dir: b.dir }], tr.vehicle);
      holders.push(holder.id); sim.berthRes.set(id, holder.id);
    }
    expect(holders.length).toBeGreaterThan(0);
    ats.updateTrainTasks(sim, tr);
    expect(tr.phase).toBe('dwell');
    expect(tr.tasks[0]).toMatchObject({ k: 'stop', berth: stop.berth });
    expect(tr.arsWait).toMatchObject({ code: 'BERTH_WAIT', train: holders[0] });
    expect(tr.arsWait!.detail).toContain(sim.topo.berths[reverse.berths[0]].name);
  });

  it('keeps the origin identity and shifts its planned clock during an actual day carry', async () => {
    const { sim, tr, d, berth } = fixture();
    ats.updateTrainTasks(sim, tr);
    const origin = d.stops[0].dep;
    const { carryWorld, nextOperatingConfig, DAY_S } = await import('../src/sim/operatingDay');
    sim.t = 99900;
    const next = new Sim(nextOperatingConfig(sim));
    carryWorld(next, sim);
    const carried = next.trains.get(tr.id)!;
    const stop = carried.tasks[1] as StopTask;
    expect(stop.trip).not.toBe(d.id);
    expect(stop.turnbackWaitBerth).toBe(berth.id);
    expect(arbitration.sourceDepartureAt(next, stop)).toBeCloseTo(origin - DAY_S, 8);
    expect(arbitration.sourceReadyAt(next, stop, carried)).toBeCloseTo(origin - DAY_S - STANDBY_CALL, 8);
  });
});
