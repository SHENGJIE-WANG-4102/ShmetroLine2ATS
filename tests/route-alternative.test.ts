import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ResourceRequest } from '../src/sim/resourceArbitration';

// Two single crossovers in series give one signal two routes to the same
// berth. Line 2's throats are true scissors (D181), so the fictional test
// line's tail is where this layout still exists.
describe('whole-movement resource admission over alternate routes', () => {
  let m: typeof import('../src/sim/engine') & typeof import('../src/sim/ats') & typeof import('../src/sim/movement')
    & typeof import('../src/sim/interlocking') & typeof import('../src/sim/resourceArbitration');
  beforeAll(async () => {
    vi.stubEnv('ATS_LINE', 'test');
    vi.resetModules();
    m = { ...await import('../src/sim/engine'), ...await import('../src/sim/ats'), ...await import('../src/sim/movement'),
      ...await import('../src/sim/interlocking'), ...await import('../src/sim/resourceArbitration') };
  });
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('does not invent a physical predecessor when an alternate route to the same berth is free', () => {
    const sim = new m.Sim({ dayType: 'weekday', dateLabel: 'physical-route-or', startTime: 14400, seed: 7, noPossessions: true });
    for (const tr of [...sim.trainList]) sim.removeTrain(tr);
    const signal = sim.topo.signals.find(s => s.name === 'S0616')!;
    const goal = sim.topo.berths.find(b => b.name === '试验东 下行站台(反向)')!;
    const preferred = sim.topo.routes.find(r => r.name === 'S0616→S0610(侧向)')!;
    const alternate = sim.topo.routes.find(r => r.name === 'S0616→S0610')!;
    expect(sim.routeTable.next.get(goal.id)![signal.id]).toBe(preferred.id);
    // A section only the preferred route uses, and one only the alternate uses.
    const only = (a: typeof preferred, b: typeof preferred) => a.steps.find(st => !b.sections.includes(sim.topo.links[st.link].section))!;
    const firstStep = only(preferred, alternate), secondStep = only(alternate, preferred);
    const first = sim.topo.links[firstStep.link], second = sim.topo.links[secondStep.link];
    expect(alternate.sections).not.toContain(first.section); expect(preferred.sections).not.toContain(second.section);
    const applicant = m.newTrain(sim, null, signal.link, 0, signal.dir, [{ link: signal.link, dir: signal.dir }], 'applicant');
    applicant.nextSignal = signal.id; applicant.len = 10;
    expect(m.routePhysicalPredecessors(sim, applicant, sim.topo.berths.length)).toEqual([]);
    const blocker = m.newTrain(sim, null, first.id, first.len / 2, firstStep.dir, [{ link: first.id, dir: firstStep.dir }], 'first-blocker'); blocker.len = 10;
    const origin = (dep: number) => ({ k: 'stop' as const, berth: goal.id, station: goal.station, trip: -1, arr: null, dep, doors: false, revenue: false });
    applicant.tasks = [origin(sim.t + 10)]; blocker.tasks = [origin(sim.t + 20)];
    const goalLink = sim.topo.links[goal.link];
    const request: ResourceRequest = { id: blocker.id, train: blocker, tasks: blocker.tasks, inside: true, safeHere: true, committed: false,
      time: sim.t, readyAt: sim.t, options: [{ phases: [{ goal: goal.id, start: { link: first.id, off: first.len / 2, dir: firstStep.dir }, routes: [],
        path: [{ link: goal.link, from: goalLink.len, to: goal.offset }], distance: 100 }], sections: new Set([first.section]),
        choices: [{ index: 0, berth: goal.id }], resourceLinks: new Set() }] };
    m.computeBody(sim, applicant); m.computeBody(sim, blocker); m.indexBodies(sim); m.computeOccupancy(sim);
    expect(m.routePhysicalPredecessors(sim, applicant, goal.id)).toEqual([]);
    expect(m.arbitrateResources(sim, [request]).decisions.get(blocker.id)).toMatchObject({ admitted: false, code: 'REGULATION', blocker: applicant.id });
    const other = m.newTrain(sim, null, second.id, second.len / 2, secondStep.dir, [{ link: second.id, dir: secondStep.dir }], 'second-blocker'); other.len = 10;
    m.computeBody(sim, other); m.indexBodies(sim); m.computeOccupancy(sim);
    expect(new Set(m.routePhysicalPredecessors(sim, applicant, goal.id))).toEqual(new Set([blocker.id, other.id]));
    expect(m.arbitrateResources(sim, [request]).decisions.get(blocker.id)).toMatchObject({ admitted: true });
  });
});
