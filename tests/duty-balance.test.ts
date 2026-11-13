/**
 * Rules behind the duty balance: depot moves change ends beyond the junction station instead of on its
 * platform (OPERATIONS.portalReversal), the morning's idle cars go home to the nearest yard
 * (noDepotReturnBefore), the 远东大道—广兰路 positioning legs carry nobody (emptyLegs), the 广兰路
 * middle track turns both ways, and the balance routes (截短/延伸) join up. Rule-level assertions that
 * hold for every day type; no train numbers or counts.
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import type { DayType, Trip } from '../src/sim/model';
import { entryStation, exitStation, portalReversal, turnbackAt, noDepotReturnBefore, validatePlan, depotLedger, periodAt, TEMPLATES, CORE_W, CORE_E, type Period } from '../src/sim/timetable';
import { between } from '../src/sim/topologyOrder';
import { parseTime } from '../src/sim/calendar';
import { OPERATIONS, STATIONS } from '../src/data/current';

const stationOf = (id: string) => STATIONS.findIndex(s => s.id === id);
const clock = (t: number) => `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}`;
const other = (dir: 'DN' | 'UP') => dir === 'DN' ? 'UP' : 'DN';
const sims = new Map<DayType, Sim>();
const simOf = (dayType: DayType) => {
  if (!sims.has(dayType)) sims.set(dayType, new Sim({ dayType, dateLabel: 'test', startTime: 4 * 3600, seed: 1 }));
  return sims.get(dayType)!;
};
const live = (sim: Sim, ids: number[]) => ids.map(id => sim.plan.trips[id]).filter(t => !t.cancelled);

describe('portalReversal', () => {
  const sim = simOf('weekday'), topo = sim.topo, rule = OPERATIONS.portalReversal!;
  const out = parseTime(rule.pullOutBefore), inn = parseTime(rule.pullInFrom);
  const listed = (st: number) => rule.stations.includes(STATIONS[st].id);
  const cases = topo.depots.flatMap((d, depot) => (['exit', 'entry'] as const).flatMap(kind => (['DN', 'UP'] as const).map(dir =>
    ({ depot, kind, dir, portal: d.portals[kind][dir] }))));

  it('a listed reversing exit is allowed only in an early pull-out, an entry only in a night pull-in', () => {
    const hit = cases.filter(c => c.portal.reverse && listed(c.portal.station));
    expect(hit.length).toBeGreaterThan(0);
    for (const c of hit) {
      const [before, after] = c.kind === 'exit' ? [out - 1, out] : [inn - 1, inn];
      const [early, late] = c.kind === 'exit' ? ['fallback', 'no'] : ['no', 'fallback'];
      expect(portalReversal(topo, c.depot, c.kind, c.dir, before), `${c.kind} ${c.depot} ${c.dir} before`).toBe(early);
      expect(portalReversal(topo, c.depot, c.kind, c.dir, after), `${c.kind} ${c.depot} ${c.dir} after`).toBe(late);
      expect(portalReversal(topo, c.depot, c.kind, c.dir, 12 * 3600)).toBe('no');
    }
  });
  it('everything else is always allowed', () => {
    const rest = cases.filter(c => !(c.portal.reverse && listed(c.portal.station)));
    expect(rest.length).toBeGreaterThan(0);
    for (const c of rest) for (const t of [0, out - 1, 12 * 3600, inn, 26 * 3600])
      expect(portalReversal(topo, c.depot, c.kind, c.dir, t)).toBe('yes');
  });
});

describe('between', () => {
  it('holds for the ends and everything in between, in either order', () => {
    for (const [a, b] of [[3, 9], [9, 3]]) {
      expect(between(a, a, b)).toBe(true);
      expect(between(b, a, b)).toBe(true);
      for (const s of [4, 6, 8]) expect(between(s, a, b), `${s} in ${a},${b}`).toBe(true);
      for (const s of [0, 2, 10, 20]) expect(between(s, a, b), `${s} outside ${a},${b}`).toBe(false);
    }
    expect(between(5, 5, 5)).toBe(true);
    expect(between(4, 5, 5)).toBe(false);
  });
});

describe('turnbackAt', () => {
  const topo = simOf('weekday').topo;
  it('广兰路 turns an upbound arrival too, on the middle-track platforms', () => {
    const gll = stationOf('GLL'), up = turnbackAt(topo, gll, 'UP'), dn = turnbackAt(topo, gll, 'DN');
    expect(up?.kind).toBe('rear');
    if (up?.kind === 'rear') expect(up.berths.some(b => topo.berths[b].kind === 'platform')).toBe(true);
    expect(dn?.kind).toBe('rear');
  });
  it('is null exactly where nothing can reverse, and rear berths all belong to the station', () => {
    for (const s of topo.stations) for (const dir of ['DN', 'UP'] as const) {
      const turn = turnbackAt(topo, s.index, dir);
      if (!s.turnbackBerths.length && !s.frontTurnback[dir]) expect(turn, `${s.id} ${dir}`).toBeNull();
      if (turn?.kind === 'rear') {
        expect(turn.berths.length).toBeGreaterThan(0);
        // a twin is on the same link as one of the station's own turnback berths
        const links = new Set(s.turnbackBerths.map(b => topo.berths[b].link));
        for (const b of turn.berths) expect(links.has(topo.berths[b].link), `${s.id} ${dir} berth ${b}`).toBe(true);
      }
    }
  });
  it('the line ends keep a turnback for the arrival that reaches them', () => {
    expect(turnbackAt(topo, stationOf('PDA'), 'DN')).not.toBeNull();
    expect(turnbackAt(topo, stationOf('SHR'), 'UP')).not.toBeNull();
  });
});

describe.each(['weekday', 'weekend'] as DayType[])('duty balance in the %s plan', dayType => {
  const sim = simOf(dayType), topo = sim.topo, plan = sim.plan;
  const blocks = plan.blocks.map(b => ({ b, trips: live(sim, b.trips) })).filter(x => x.trips.length);

  it('no depot move changes ends on a listed junction platform outside the fallback hours', () => {
    const bad: string[] = [];
    for (const { b, trips } of blocks) {
      const first = trips[0], last = trips.at(-1)!;
      if (b.start.kind === 'depot' && first.from === exitStation(topo, b.start.depot, first.dir)
        && portalReversal(topo, b.start.depot, 'exit', first.dir, b.start.time) === 'no')
        bad.push(`block ${b.id} out ${topo.depots[b.start.depot].key} ${STATIONS[first.from].id} ${clock(b.start.time)}`);
      if (b.end.kind === 'depot' && last.to === entryStation(topo, b.end.depot, last.dir)
        && portalReversal(topo, b.end.depot, 'entry', last.dir, last.stops.at(-1)!.arr) === 'no')
        bad.push(`block ${b.id} in ${topo.depots[b.end.depot].key} ${STATIONS[last.to].id} ${clock(last.stops.at(-1)!.arr)}`);
    }
    expect(bad).toEqual([]);
  });

  it('a car going home before the morning rush is over goes to the yard nearest its last carrying stop', () => {
    const limit = noDepotReturnBefore(), bad: string[] = [];
    for (const { b, trips } of blocks) {
      const last = trips.at(-1)!;
      if (b.end.kind !== 'depot' || last.stops.at(-1)!.arr >= limit || b.withdrawal) continue;
      const carrying = trips.filter(t => t.revenue).at(-1) ?? last;
      const chain = topo.stations[carrying.to].chain;
      const dist = (d: number) => Math.abs(topo.depots[d].junctionChain - chain);
      const nearest = Math.min(...topo.depots.map((_, d) => dist(d)));
      if (dist(b.end.depot) > nearest + 1e-6)
        bad.push(`block ${b.id} ${STATIONS[carrying.to].id} ${clock(last.stops.at(-1)!.arr)} → ${topo.depots[b.end.depot].key}`
          + (b.start.kind === 'depot' ? ` (out of ${topo.depots[b.start.depot].key})` : ''));
    }
    expect(bad).toEqual([]);
  });

  it('a block never has work after the trip that takes it home', () => {
    for (const { b, trips } of blocks) if (b.end.kind === 'depot')
      for (let i = 1; i < trips.length; i++) expect(trips[i].stops[0].dep).toBeGreaterThanOrEqual(trips[i - 1].stops.at(-1)!.arr - 1e-6);
  });

  it('legs wholly inside an emptyLegs band carry nobody and call nowhere in between', () => {
    const bands = (OPERATIONS.emptyLegs ?? []).map(([a, b]) => [stationOf(a), stationOf(b)]);
    const bad: string[] = [];
    let inBand = 0;
    for (const t of plan.trips) {
      if (t.cancelled || !bands.some(([a, b]) => between(t.from, a, b) && between(t.to, a, b))) continue;
      if (t.kind !== 'empty' && t.revenue) continue; // a scheduled service trip is not a positioning leg
      inBand++;
      if (t.revenue) bad.push(`trip ${t.id} revenue ${STATIONS[t.from].id}-${STATIONS[t.to].id} ${clock(t.stops[0].dep)}`);
      const mid = t.stops.slice(1, -1).filter(p => p.stop);
      if (mid.length) bad.push(`trip ${t.id} stops at ${mid.map(p => STATIONS[p.st].id)} ${clock(t.stops[0].dep)}`);
    }
    expect(inBand).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it('every revenue route starts and ends where a train can change ends or use a yard portal', () => {
    const bad: string[] = [];
    const route = new Set<string>();
    for (const t of plan.trips) {
      // the official fixed late runs (末班后定点班车) are data, not balancing routes
      if (t.cancelled || !t.revenue || t.kind === 'extra') continue;
      route.add(`${STATIONS[t.from].id}-${STATIONS[t.to].id}`);
      const exits = topo.depots.some((_, d) => exitStation(topo, d, t.dir) === t.from);
      const entries = topo.depots.some((_, d) => entryStation(topo, d, t.dir) === t.to);
      const turnsFrom = !!turnbackAt(topo, t.from, other(t.dir)) || t.from === 0 || t.from === topo.stations.length - 1;
      const turnsTo = !!turnbackAt(topo, t.to, t.dir) || t.to === 0 || t.to === topo.stations.length - 1;
      if (!(turnsFrom || exits)) bad.push(`trip ${t.id} starts ${STATIONS[t.from].id} ${t.dir} ${clock(t.stops[0].dep)}`);
      if (!(turnsTo || entries)) bad.push(`trip ${t.id} ends ${STATIONS[t.to].id} ${t.dir} ${clock(t.stops.at(-1)!.arr)}`);
    }
    expect(route.size).toBeGreaterThan(1);
    expect(bad).toEqual([]);
  });

  it('consecutive trips of a block join end to start', () => {
    const bad: string[] = [];
    for (const { b, trips } of blocks) for (let i = 1; i < trips.length; i++) {
      const a: Trip = trips[i - 1], d = trips[i];
      if (a.to !== d.from) bad.push(`block ${b.id}: ${a.no} ends ${STATIONS[a.to].id} ${clock(a.stops.at(-1)!.arr)}, ${d.no} starts ${STATIONS[d.from].id}`);
    }
    expect(bad).toEqual([]);
  });
});

/**
 * Yard rebalancing (用户决定 2026-11-13): a morning stock moved between yards
 * (a car short at one, spare at another, as the rollover's actual yard counts
 * can leave them) still gives a valid day: the short yard receives a spare
 * car off-peak, after noDepotReturnBefore, carried in service; every yard ends
 * at its own count; no service trip is added or dropped.
 */
describe.each(['weekday', 'weekend'] as DayType[])('yard rebalancing in the %s plan', dayType => {
  const base = new Sim({ dayType, dateLabel: 'test', startTime: 4 * 3600, seed: 3, noPossessions: true });
  // service trips per direction (outer legs may join or leave elsewhere with other stock; none is added or dropped)
  const service = (sim: Sim) => (['DN', 'UP'] as const).map(dir => sim.plan.trips.filter(t => !t.cancelled && t.revenue && t.dir === dir
    && !['ins', 'wd', 'empty', 'adj'].includes(t.kind)).length);
  const moveKey = (t: Trip) => `${t.dir} ${t.from}-${t.to} ${Math.round(t.stops[0].dep)}`;
  const baseMoves = new Set(base.plan.trips.filter(t => ['ins', 'wd'].includes(t.kind)).map(moveKey));
  const short = base.topo.depots.length - 1;
  it.each([1, 2])('%s car(s) short at the last yard, spare at the first', shift => {
    const stock = base.depotStock.slice(); stock[0] += shift; stock[short] -= shift;
    const sim = new Sim({ ...base.config, depotStock: stock });
    const errors = validatePlan(sim.planCtx, sim.plan, true, false, { checkWaiting: true }).filter(i => i.severity === 'error');
    expect(errors.map(i => `${i.code} ${i.text}`)).toEqual([]);
    expect(depotLedger(sim.topo, sim.plan).final).toEqual(sim.depotStock);
    expect(service(sim)).toEqual(service(base));
    // every move the shifted stock adds through the core runs after the morning peak, off-peak, carrying
    const added = sim.plan.trips.filter(t => !t.cancelled && ['ins', 'wd'].includes(t.kind) && !baseMoves.has(moveKey(t))
      && t.stops.some(p => p.st === CORE_W) && t.stops.some(p => p.st === CORE_E));
    for (const t of added) {
      const at = t.stops[0].dep;
      expect(at, `${t.no} ${clock(at)}`).toBeGreaterThanOrEqual(noDepotReturnBefore());
      expect(TEMPLATES[periodAt(sim.plan.periods as Period[], at).template].peak, `${t.no} ${clock(at)} peak`).toBeFalsy();
      expect(t.revenue, `${t.no} carries`).toBe(true);
    }
  }, 300000);
});
