import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { newTrain, cmdWithdraw } from '../src/sim/ats';
import { computeBody, indexBodies } from '../src/sim/movement';
import { depotLeadTasks, platformBerth } from '../src/sim/timetable';
import { reversedBerthPoint } from '../src/sim/topology';
import type { StopTask, Task } from '../src/sim/model';
import { LINE_INFO } from '../src/data/current';

/** 用户决定（2026-11-11）：停在与车场直接相连的折返/出入段线上的空车退出服务，
 * 就地换端（或车头已朝车场时直接）从这条线回段，不出站台清客、不绕另一条线。 */
describe('withdrawing an empty train standing on a depot lead', () => {
  const setup = () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'lead-withdraw', startTime: 14400, seed: 7, noPossessions: true });
    for (const tr of [...sim.trainList]) sim.removeTrain(tr);
    // (any yard whose lead track is entered directly: found by capability, not by name)
    const lead = sim.topo.depots.flatMap((d, depot) => d.transferPaths.flatMap(path =>
      depotLeadTasks(sim.topo, depot, path.stub) ? [{ depot, stub: path.stub, station: d.station }] : []))[0];
    if (!lead) throw new Error('fixture needs a directly entered depot lead');
    const berth = sim.topo.berths.find(b => b.link === lead.stub && b.kind !== 'platform' && b.offset >= 200)!;
    return { sim, lead, berth };
  };
  const place = (sim: Sim, link: number, off: number, dir: 1 | -1, load = 0) => {
    const tr = newTrain(sim, null, link, off, dir, [{ link, dir }], 'lead-case');
    const platform: StopTask = { k: 'stop', berth: platformBerth(sim.topo, sim.topo.depots[0].station, 'DN'), station: sim.topo.depots[0].station,
      trip: -1, arr: null, dep: sim.t + 600, doors: true, revenue: true };
    Object.assign(tr, { tasks: [platform], phase: 'run', v: 0, a: 0, load, inService: true });
    computeBody(sim, tr); indexBodies(sim);
    return tr;
  };
  const viaPlatform = (tasks: Task[], sim: Sim) => tasks.some(t => t.k === 'stop' && sim.topo.berths[t.berth].kind === 'platform');

  it('changes ends where it stands when its cab faces the platform', () => {
    const { sim, lead, berth } = setup();
    // standing as after a change of ends into the lead: facing out of it
    const at = reversedBerthPoint(sim.topo, berth.id, LINE_INFO.trainLength, [{ link: berth.link, dir: berth.dir }])!;
    const tr = place(sim, at.link, at.off, at.dir);
    expect(cmdWithdraw(sim, tr, 'test').ok).toBe(true);
    expect(tr.tasks[0].k).toBe('reverse');
    expect(tr.phase).toBe('reversing');
    expect(viaPlatform(tr.tasks, sim)).toBe(false);
    expect(tr.tasks.at(-1)).toMatchObject({ k: 'depot', depot: lead.depot });
    expect(tr.withdrawn).toBe(true);
  });

  it('runs straight in when its cab already faces the yard', () => {
    const { sim, lead, berth } = setup();
    const tr = place(sim, berth.link, berth.offset - 20 * berth.dir, berth.dir);
    expect(cmdWithdraw(sim, tr, 'test').ok).toBe(true);
    expect(tr.tasks.some(t => t.k === 'reverse')).toBe(false);
    expect(viaPlatform(tr.tasks, sim)).toBe(false);
    expect(tr.tasks.at(-1)).toMatchObject({ k: 'depot', depot: lead.depot });
  });

  it('keeps the ordinary clear-out path for a train with passengers aboard', () => {
    const { sim, berth } = setup();
    const at = reversedBerthPoint(sim.topo, berth.id, LINE_INFO.trainLength, [{ link: berth.link, dir: berth.dir }])!;
    const tr = place(sim, at.link, at.off, at.dir, 50);
    cmdWithdraw(sim, tr, 'test');
    expect(tr.phase).not.toBe('reversing');
    expect(tr.tasks[0].k).not.toBe('reverse');
  });
});
