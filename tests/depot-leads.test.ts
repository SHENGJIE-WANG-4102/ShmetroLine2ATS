import { describe, expect, it } from 'vitest';
import { buildTopology } from '../src/sim/topology';
import { depotLeadsConflict } from '../src/sim/timetable';
import { depotTasks } from '../src/sim/timetable';
import type { Task } from '../src/sim/model';

describe('depot movement paths', () => {
  it('keeps independent normal movements separate and protects a reverse exit on the entry lead', () => {
    const topo = buildTopology();
    const depot = topo.depots.findIndex(d => d.key === 'CSD');
    const yard = topo.depots[depot];
    expect(depot).toBeGreaterThanOrEqual(0);
    const entry = yard.portals.entry.DN.path;
    expect(yard.transferPaths[entry].flow).toBe('shared');
    expect(yard.portals.exit.UP.path).not.toBe(entry);
    expect(yard.portals.exit.DN.path).toBe(entry);
    expect(depotLeadsConflict(topo, depot, 'DN', 'UP')).toBe(false);
    expect(depotLeadsConflict(topo, depot, 'DN', 'DN')).toBe(true);
  });
  it('retains the existing yard-wide shared-lead slot model where no path scope is specified', () => {
    const topo=buildTopology(),depot=topo.depots.findIndex(d=>d.key==='BZL'),p=topo.depots[depot].portals;
    expect([p.entry.DN.path,p.entry.UP.path].some(entry=>entry!==p.exit.DN.path)).toBe(true);
    expect(depotLeadsConflict(topo,depot,'DN','DN')).toBe(true);
    expect(depotLeadsConflict(topo,depot,'UP','DN')).toBe(true);
  });
  it.each(['BZL', 'LYD', 'CSD'])('%s carries one fixed work stop on each physical movement', key => {
    const topo = buildTopology();
    const depot = topo.depots.findIndex(d => d.key === key), yard = topo.depots[depot];
    for (const path of yard.transferPaths.filter(p => p.exitSignal >= 0)) {
      const stop = topo.berths[path.exitWorkBerth!];
      expect(stop).toMatchObject({ link: path.links[1], offset: 5, dir: -1, depot });
    }
    const tasks: Task[] = [];
    depotTasks(topo, depot, 'DN', tasks);
    const work = tasks.filter(t => t.k === 'stop' && t.depotWork?.kind === 'in');
    expect(work).toHaveLength(1);
    if (work[0].k !== 'stop') throw Error('work stop missing');
    expect(work[0].minDwell).toBe(30);
    expect(work[0].depotWork?.berths.length).toBeGreaterThan(0);
    expect(topo.berths[work[0].berth].platform >= 0).toBe(key === 'LYD');
    if (key === 'BZL') expect(work[0].depotWork?.berths).toHaveLength(2);
    expect(tasks.at(-1)).toMatchObject({ k:'depot', depot });
  });
});
