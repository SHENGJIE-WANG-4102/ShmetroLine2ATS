import { afterAll, describe, expect, it, vi } from 'vitest';
import { LINE_INFO } from '../src/data/current';
import { plannedDwell } from '../src/sim/calibration';
import { Sim } from '../src/sim/engine';
import type { Plan, TrackDir, Trip } from '../src/sim/model';
import { plannedWaiting } from '../src/sim/plannedWaiting';
import { dwellFactorAt, minTurn, platformBerth, turnbackAt } from '../src/sim/timetable';
import { ahead, buildTopology, safeWaitingPoint, sharedTransferLink, type Topology } from '../src/sim/topology';

const flip = (dir: TrackDir): TrackDir => dir === 'DN' ? 'UP' : 'DN';
const time = 18 * 3600;

/** Two trips with explicit endpoint clocks; no runtime simulation or warmed
 * plan is needed to test a connection's physical waiting contract. */
function pair(topo: Topology, station: number, incoming: TrackDir, gap: number, sameDirection = false): Plan {
  const source = topo.stations.filter(s => ahead(incoming, s.index, station))
    .sort((a, b) => Math.abs(a.chain - topo.stations[station].chain) - Math.abs(b.chain - topo.stations[station].chain))[0];
  if (!source) throw new Error('fixture needs an incoming adjacent station');
  const outgoing = sameDirection ? incoming : flip(incoming);
  const target = sameDirection ? topo.stations.find(s => ahead(outgoing, station, s.index)) : source;
  if (!target) throw new Error('fixture needs an outgoing station');
  const trip = (id: number, from: number, to: number, dir: TrackDir, dep: number, arr: number): Trip => ({
    id, no: String(id + 1), block: 0, from, to, dir, kind: 'small', revenue: true,
    stops: [{ st: from, arr: dep, dep, stop: true }, { st: to, arr, dep: arr, stop: true }],
  });
  return { dayType: 'weekday', trips: [trip(0, source.index, station, incoming, time - 120, time),
    trip(1, station, target.index, outgoing, time + gap, time + gap + 120)],
  blocks: [{ id: 0, svc: '001', start: { kind: 'stable', station: source.index, berth: platformBerth(topo, source.index, incoming) },
    end: { kind: 'none' }, trips: [0, 1] }], periods: [], overlays: [], fleetPeak: 1 };
}

function findTurn(topo: Topology, accepts: (berths: number[]) => boolean) {
  for (const station of topo.stations) for (const dir of ['DN', 'UP'] as const) {
    const turn = turnbackAt(topo, station.index, dir);
    if (turn?.kind === 'rear' && accepts(turn.berths)
      && topo.stations.some(s => ahead(dir, s.index, station.index))) return { station: station.index, dir, berths: turn.berths };
  }
  throw new Error('fixture needs this topology capability');
}

describe('pure planned waiting evidence', () => {
  it.each(['weekday', 'weekend'] as const)('%s allocation only connects duties at safe waiting points', dayType => {
    const sim = new Sim({ dayType, dateLabel: 'planned waiting allocation', startTime: 14400, seed: 1 });
    expect(plannedWaiting(sim.planCtx, sim.plan).issues).toEqual([]);
  });

  it('rejects a long connection on actual shared transfer choices', () => {
    const topo = buildTopology(), turn = findTurn(topo, berths => berths.every(b => sharedTransferLink(topo, topo.berths[b].link)));
    const plan = pair(topo, turn.station, turn.dir, minTurn(turn.station) + 600), before = JSON.stringify(plan);
    const result = plannedWaiting({ topo }, plan);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ code: 'UNSAFE_WAIT', blocks: [0], arrival: 0, departure: 1 });
    expect(result.waits[0].berths).toEqual(turn.berths);
    expect(result.waits[0].safeBerths).toEqual([]);
    expect(JSON.stringify(plan)).toBe(before);
    expect(plannedWaiting({topo},plan,{connection:{block:0,arrival:0,departure:1}})).toEqual(result);
    expect(plannedWaiting({topo},plan,{connection:{block:1,arrival:0,departure:1}}).waits).toEqual([]);
  });

  it('allows a full-length wait on an independent rear track', () => {
    const topo = buildTopology(), turn = findTurn(topo, berths => berths.every(b => !sharedTransferLink(topo, topo.berths[b].link)
      && ['tail', 'siding'].includes(topo.berths[b].kind)));
    const result = plannedWaiting({ topo }, pair(topo, turn.station, turn.dir, minTurn(turn.station) + 3600));
    expect(result.issues).toEqual([]);
    expect(result.waits[0]).toMatchObject({ safe: true, reason: 'SAFE_WAITING_POINT' });
    expect(result.waits[0].safeBerths.length).toBeGreaterThan(0);
  });

  it('allows the approved whole-platform cab change followed by ordinary main line', () => {
    const topo = buildTopology(), turn = findTurn(topo, berths => berths.some(b => topo.berths[b].kind === 'platform'));
    const result = plannedWaiting({ topo }, pair(topo, turn.station, turn.dir, minTurn(turn.station) + 600));
    expect(result.issues).toEqual([]);
    expect(result.waits[0]).toMatchObject({ safe: true, reason: 'SAFE_WAITING_POINT' });
    expect(result.waits[0].safeBerths.some(b => topo.berths[b].kind === 'platform')).toBe(true);
  });

  it('does not use the safe arrival platform to approve a turn whose next stage is shared', () => {
    const topo = buildTopology(), turn = findTurn(topo, berths => berths.every(b => sharedTransferLink(topo, topo.berths[b].link)));
    const plan = pair(topo, turn.station, turn.dir, minTurn(turn.station) + 600);
    expect(safeWaitingPoint(topo, platformBerth(topo, turn.station, turn.dir), LINE_INFO.trainLength)).toBe(true);
    expect(plannedWaiting({ topo }, plan).issues).toHaveLength(1);
  });

  it('reports long station-front platform waits without a configured platform exception', () => {
    const topo = buildTopology();
    const fronts = topo.stations.flatMap(station => (['DN', 'UP'] as const).flatMap(dir =>
      turnbackAt(topo, station.index, dir)?.kind === 'front' && topo.stations.some(s => ahead(dir, s.index, station.index))
        ? [{ station: station.index, dir }] : []));
    expect(fronts.length).toBeGreaterThan(0);
    for (const front of fronts) {
      const result = plannedWaiting({ topo }, pair(topo, front.station, front.dir, minTurn(front.station) + 600));
      expect(result.issues, `${front.station}/${front.dir}`).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'UNSAFE_WAIT' })]));
      expect(result.waits[0].reason).toBe('NO_SAFE_WAITING_POINT');
    }
  });

  it('uses the existing turn-work budget without granting extra waiting time', () => {
    const topo = buildTopology(), turn = findTurn(topo, berths => berths.every(b => sharedTransferLink(topo, topo.berths[b].link)));
    const normal = plannedWaiting({ topo }, pair(topo, turn.station, turn.dir, minTurn(turn.station)));
    expect(normal.issues).toEqual([]);
    expect(normal.waits[0].reason).toBe('NORMAL_WORK');
    expect(plannedWaiting({ topo }, pair(topo, turn.station, turn.dir, minTurn(turn.station) + .01)).issues).toHaveLength(1);
  });

  it('keeps ordinary same-direction station work within the existing dwell budget', () => {
    const topo = buildTopology(), station = topo.stations.find(s => topo.stations.some(a => ahead('DN', a.index, s.index))
      && topo.stations.some(b => ahead('DN', s.index, b.index)))!.index;
    const budget = plannedDwell('weekday', station, 'DN', time, dwellFactorAt('weekday', time));
    const result = plannedWaiting({ topo }, pair(topo, station, 'DN', budget, true));
    expect(result.issues).toEqual([]);
    expect(result.waits[0]).toMatchObject({ normalWork: budget, reason: 'NORMAL_WORK' });
  });

  it('includes a connection crossing the scope boundary and states uncovered work', () => {
    const topo = buildTopology(), turn = findTurn(topo, berths => berths.every(b => sharedTransferLink(topo, topo.berths[b].link)));
    const plan = pair(topo, turn.station, turn.dir, 900);
    expect(plannedWaiting({ topo }, plan, { from: time + 600 }).issues).toHaveLength(1);
    expect(plannedWaiting({ topo }, plan, { from: time + 901 }).issues).toEqual([]);
    expect(plannedWaiting({ topo }, plan).uncovered).toEqual(['depot-start-approach', 'final-stabling']);
  });
});

describe('planned waiting on the selected test line', () => {
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  it('uses the selected line topology, work budget and train length', async () => {
    vi.stubEnv('ATS_LINE', 'test'); vi.resetModules();
    const topology = await import('../src/sim/topology');
    const timetable = await import('../src/sim/timetable');
    const checker = await import('../src/sim/plannedWaiting');
    const current = await import('../src/data/current');
    const topo = topology.buildTopology();
    const turn = topo.stations.flatMap(station => (['DN', 'UP'] as const).flatMap(dir => {
      const t = timetable.turnbackAt(topo, station.index, dir);
      return t?.kind === 'rear' && t.berths.some(b => topology.safeWaitingPoint(topo, b, current.LINE_INFO.trainLength))
        && topo.stations.some(s => topology.ahead(dir, s.index, station.index))
        ? [{ station: station.index, dir }] : [];
    }))[0];
    const plan = pair(topo, turn.station, turn.dir, timetable.minTurn(turn.station) + 600);
    expect(topo.stations).toHaveLength(6);
    expect(checker.plannedWaiting({ topo }, plan).issues).toEqual([]);
  });
});
