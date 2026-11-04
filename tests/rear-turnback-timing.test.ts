import { describe, expect, it } from 'vitest';
import { OPERATIONS, STATIONS } from '../src/data/current';
import { buildTopology } from '../src/sim/topology';
import { rearTurnbackLeg } from '../src/sim/ats';
import { calibratedRearTurnback, turnbackDwell } from '../src/sim/onboard';
import { platformBerth } from '../src/sim/timetable';
import type { Sim } from '../src/sim/engine';
import type { Train } from '../src/sim/model';

describe('shared physical rear turnback timing', () => {
  it('uses one 56-second rear base while retaining the driver increments and longer work', () => {
    expect(OPERATIONS.rearTurnback).toEqual({ entryRunS: 41, changeEndsS: 56, exitRunS: 38 });
    expect(turnbackDwell('DTO', 40, 'rear', false, true)).toBe(56);
    expect(turnbackDwell('DTO', 40, 'rear')).toBe(40);
    const work = OPERATIONS.atoDriverWork;
    expect(turnbackDwell('AM', 40, 'rear', true, true)).toBe(56 + work.turnbackExtraS.rear
      - work.turnbackDoorCycles.rear * work.postLockExtraS);
    expect(turnbackDwell('AM', 40, 'front', true)).toBe(40 + work.turnbackExtraS.front
      - work.turnbackDoorCycles.front * work.postLockExtraS);
    expect(turnbackDwell('AM', 40, 'rear', false, true)).toBe(56 + work.legacyEndChangeS);
    expect(turnbackDwell('DTO', 100, 'rear', false, true)).toBe(100);
  });

  it.each(['PXL', 'PDA', 'SHR'])('%s offers the same entry and exit budgets only on its real rear movement', id => {
    const topo = buildTopology(), sim = { topo } as Sim;
    const station = STATIONS.findIndex(s => s.id === id);
    const tail = topo.berths[topo.stations[station].turnbackBerths.find(b => topo.berths[b].kind !== 'platform')!];
    const reverse = { k: 'reverse' as const, station, minTime: 40, chosen: tail.id, berths: [tail.id] };
    expect(calibratedRearTurnback(topo, reverse)).toBe(true);
    const leadLinks = new Set(topo.depots.flatMap(d => d.transferPaths.map(p => p.stub)));
    const lead = topo.berths.find(b => b.kind === 'siding' && leadLinks.has(b.link)
      && !topo.stations[b.station].turnbackBerths.some(id => topo.berths[id].link === b.link))!;
    expect(calibratedRearTurnback(topo, { chosen: lead.id, station: lead.station })).toBe(false);
    const train = { phase: 'run', rescuing: -1, rescueBy: -1, coupledLen: 0, tasks: [reverse],
      tbStage: 'arrive', lastStation: station, hist: [{ link: tail.link, dir: tail.dir }] } as Train;
    expect(rearTurnbackLeg(sim, train)).toEqual({ kind: 'entry', seconds: 41, goal: tail.id });
    const platform = platformBerth(topo, station, id === 'PDA' ? 'UP' : 'DN');
    train.tasks = [{ k: 'stop', station, berth: platform, trip: -1, arr: null, dep: null,
      doors: true, revenue: true }];
    train.tbStage = 'depart';
    expect(rearTurnbackLeg(sim, train)).toEqual({ kind: 'exit', seconds: 38, goal: platform });
    train.hist = [{ link: topo.berths[platform].link, dir: topo.berths[platform].dir }];
    expect(rearTurnbackLeg(sim, train)).toBeUndefined();
    // A moving exit outlives the body's tail-link history. Keep only that
    // already-established leg; changing its target cannot inherit the clock.
    train.ato = { turnbackLeg: 'exit', berth: platform } as Train['ato'];
    expect(rearTurnbackLeg(sim, train)).toEqual({ kind: 'exit', seconds: 38, goal: platform });
    train.ato!.berth = -1;
    expect(rearTurnbackLeg(sim, train)).toBeUndefined();
    train.ato = undefined;
    train.tasks = [{ ...reverse, chosen: platform, berths: [platform] }];
    expect(rearTurnbackLeg(sim, train)).toBeUndefined();
    train.tasks = [reverse]; train.rescuing = 1;
    expect(rearTurnbackLeg(sim, train)).toBeUndefined();
    train.rescuing = -1; train.coupledLen = 186;
    expect(rearTurnbackLeg(sim, train)).toBeUndefined();
  });
});
