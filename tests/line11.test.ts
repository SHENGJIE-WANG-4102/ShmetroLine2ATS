import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Topology, TRoute } from '../src/sim/topology';

/** Line 11: 花桥—上海赛车场 branch joins 嘉定北—迪士尼 trunk at 嘉定新城.
 * Station table: branch (0–6) then trunk (7–39), 40 stations in all. */
describe('line 11 branch, layout and plan', () => {
  let topo: Topology;
  let order: typeof import('../src/sim/topologyOrder');
  let STATIONS: typeof import('../src/data/current').STATIONS;
  let LAYOUT: typeof import('../src/data/current').LAYOUT;
  let Sim: typeof import('../src/sim/engine').Sim;
  let validatePlan: typeof import('../src/sim/timetable').validatePlan;
  beforeAll(async () => {
    vi.stubEnv('ATS_LINE', '11'); vi.resetModules();
    order = await import('../src/sim/topologyOrder');
    topo = (await import('../src/sim/topology')).buildTopology();
    ({ STATIONS, LAYOUT } = await import('../src/data/current'));
    Sim = (await import('../src/sim/engine')).Sim;
    validatePlan = (await import('../src/sim/timetable')).validatePlan;
  });
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  const station = (id: string) => STATIONS.findIndex(s => s.id === id);
  /** can a train get from one link to another by routes, running forward */
  const reaches = (from: number, to: number, wrongWay = false): boolean => {
    const seen = new Set<number>(), queue: TRoute[] = topo.routes.filter(route => route.steps.some(step => step.link === from));
    while (queue.length) {
      const route = queue.pop()!;
      if (seen.has(route.id)) continue;
      seen.add(route.id);
      if (route.wrongDir && !wrongWay) continue;
      if (route.steps.some(step => step.link === to)) return true;
      if (route.end >= 0) queue.push(...topo.signals[route.end].routes.map(id => topo.routes[id]));
    }
    return false;
  };
  const platform = (st: number, track: 'DN' | 'UP') => topo.platforms[topo.stations[st].platforms[track]].link;

  it('has 40 stations and the three depots from the layout document', () => {
    expect(STATIONS).toHaveLength(40);
    expect(topo.depots.map(depot => [depot.name, depot.capacity])).toEqual([
      ['城北路停车场', 24], ['赛车场车辆段', 24], ['川杨河定修段', 52],
    ]);
    expect(LAYOUT.depots.map(depot => depot.station)).toEqual([station('JDB'), station('SSC'), station('LSH')]);
  });

  it('registers the Y-shaped running order', () => {
    expect(order.stationPath(station('HQ'), station('DSL')).map(i => STATIONS[i].name))
      .toEqual(['花桥', '光明路', '兆丰路', '安亭', '上海汽车城', '昌吉东路', '上海赛车场', '嘉定新城',
        '马陆', '陈翔公路', '南翔', '桃浦新村', '武威路', '祁连山路', '李子园', '上海西站', '真如',
        '枫桥路', '曹杨路', '隆德路', '江苏路', '交通大学', '徐家汇', '上海游泳馆', '龙华', '云锦路',
        '龙耀路', '东方体育中心', '三林', '三林东', '浦三路', '康恒路', '御桥', '罗山路', '秀沿路',
        '康新公路', '迪士尼']);
    expect(order.stationPath(station('HQ'), station('DSL'))).not.toContain(station('JDB'));
    expect(order.ahead('DN', station('HQ'), station('JDC'))).toBe(true);
    expect(order.ahead('DN', station('JDB'), station('JDC'))).toBe(true);
    expect(order.ahead('UP', station('JDC'), station('HQ'))).toBe(true);
  });

  it('gives 花桥, 嘉定北 and 迪士尼 turnback berths', () => {
    for (const id of ['HQ', 'JDB', 'DSL']) {
      expect(topo.stations[station(id)].turnbackBerths.length).toBeGreaterThan(0);
      expect(topo.stations[station(id)].turnbackBerths
        .every(berth => topo.berths[berth].kind === 'tail' || topo.berths[berth].kind === 'siding')).toBe(true);
    }
    // 罗山路的两条尾轨是小交路折返线；三林中间线是带站台面的折返线。
    expect(topo.stations[station('LSH')].turnbackBerths).toHaveLength(2);
    expect(topo.stations[station('SL')].turnbackBerths).toHaveLength(1);
    expect(topo.berths[topo.stations[station('SL')].turnbackBerths[0]].kind).toBe('platform');
  });

  it('runs the branch through its own DN face at 嘉定新城 and on to 迪士尼', () => {
    const JDC = station('JDC'), HQ = station('HQ'), SSC = station('SSC'), DSL = station('DSL');
    // the table carries the branch's station index, not its station id, on the own face
    const own = topo.platforms.filter(p => p.station === JDC && p.from !== undefined);
    expect(own.map(p => [p.track, p.from])).toEqual([['DN', SSC]]);
    expect(reaches(platform(HQ, 'DN'), own[0].link)).toBe(true);
    expect(reaches(own[0].link, platform(DSL, 'DN'))).toBe(true);
    expect(reaches(platform(HQ, 'DN'), platform(JDC, 'DN'))).toBe(false);
    // the trunk still runs through on the main DN face
    expect(reaches(platform(station('JDB'), 'DN'), platform(DSL, 'DN'))).toBe(true);
  });

  it('joins the 嘉定北 yard to the DN main only, one lead on each side of the crossover', () => {
    const JDB = station('JDB'), at = topo.stations[JDB].chain;
    const yard = topo.depots.find(depot => depot.station === JDB)!;
    // walk the lead's connector from its stub to the switch on the main
    const leads = yard.transferPaths.map(path => {
      const stub = topo.links[path.stub];
      let node = topo.nodes[stub.a === path.throat ? stub.b : stub.a], link = path.stub;
      while (node.kind !== 'switch') {
        link = node.links.find(l => l !== link)!;
        node = topo.nodes[topo.links[link].a === node.id ? topo.links[link].b : topo.links[link].a];
      }
      return { flow: path.flow, track: node.links.map(l => topo.links[l].track), chain: node.chain - at };
    });
    expect(leads.every(lead => lead.track.includes('DN') && !lead.track.includes('UP'))).toBe(true);
    const cross = topo.nodes.filter(node => node.kind === 'switch' && Math.abs(node.chain - at) < 800 && node.links.some(l => topo.links[l].track === 'X')).map(node => node.chain - at);
    const out = leads.find(lead => lead.flow === 'out')!, into = leads.find(lead => lead.flow === 'in')!;
    // beyond the platform end, tail-ward: platform, exit lead, crossover, entry lead
    expect(out.chain).toBeLessThan(-105);
    expect(out.chain).toBeGreaterThan(Math.max(...cross));
    expect(into.chain).toBeLessThan(Math.min(...cross));
    // trains leave straight onto the DN platform; arrivals on the UP main go in without changing ends
    expect(yard.portals.exit.DN).toMatchObject({ reverse: false });
    expect(yard.portals.entry.UP).toMatchObject({ reverse: false });
  });

  it('turns 嘉定北 yard moves at the end of either 牵出线, out and in', async () => {
    const { depotTasks } = await import('../src/sim/timetable');
    const yard = topo.depots.findIndex(depot => depot.station === station('JDB'));
    const { transferPaths, portals } = topo.depots[yard];
    const ends = (berths: number[]) => berths.map(b => topo.berths[b]);
    for (const path of transferPaths) {
      // both 牵出线 serve every lead, its own yard track's first; each ends at a buffer
      expect(path.shuntBerths).toHaveLength(2);
      for (const berth of ends(path.shuntBerths!)) expect(topo.nodes[topo.links[berth.link].b].kind).toBe('end');
      // the lead ends at a turnout on line 0, the nearer 牵出线
      expect(topo.nodes[path.throat].kind).toBe('switch');
      expect(path.shuntBerths!.some(b => topo.links[topo.nodes[path.throat].toe!].id !== topo.berths[b].link)).toBe(true);
    }
    // both lines run out further than the mains' tails, to the same buffer chainage
    const [a, b] = ends(transferPaths[0].shuntBerths!).map(berth => topo.nodes[topo.links[berth.link].b].chain);
    expect(a).toBe(b);
    // a move can reach either 牵出线 from either lead, and the yard's way in from either 牵出线
    for (const path of transferPaths) for (const berth of ends(path.shuntBerths!)) {
      // (the entry lead is entered running against the DN main's direction, off the crossover)
      expect(reaches(path.stub, berth.link, true)).toBe(true);
      const back = topo.nodes[topo.links[berth.link].a].links.find(l => l !== berth.link)!;
      for (const other of transferPaths.filter(p => p.flow !== 'out')) expect(reaches(back, other.links[2])).toBe(true);
    }
    // in: the train changes ends on a 牵出线, then backs into the yard
    const tasks: import('../src/sim/model').Task[] = [];
    depotTasks(topo, yard, 'UP', tasks);
    expect(tasks.slice(-2).map(task => task.k)).toEqual(['reverse', 'depot']);
    expect(tasks.at(-2)).toMatchObject({ berths: transferPaths[portals.entry.UP!.path].shuntBerths });
  });

  it('keeps 上海赛车场 crossovers on both sides of the platform, the east one before the join', () => {
    const SSC = station('SSC'), at = topo.stations[SSC].chain;
    const cross = (t: string) => topo.nodes.filter(node => node.kind === 'switch' && Math.abs(node.chain - at) < 600
      && node.links.some(l => topo.links[l].track === t) && node.links.some(l => topo.links[l].track === 'X')).map(node => node.chain - at);
    for (const t of ['DN', 'UP']) {
      expect(cross(t).some(ch => ch < 0)).toBe(true);
      expect(cross(t).some(ch => ch > 0)).toBe(true);
    }
    // the depot leads leave the UP main only
    const yard = topo.depots.find(depot => depot.station === SSC)!;
    for (const path of yard.transferPaths) {
      const stub = topo.links[path.stub];
      let node = topo.nodes[stub.a === path.throat ? stub.b : stub.a], link = path.stub;
      while (node.kind !== 'switch') {
        link = node.links.find(l => l !== link)!;
        node = topo.nodes[topo.links[link].a === node.id ? topo.links[link].b : topo.links[link].a];
      }
      expect(node.links.map(l => topo.links[l].track)).toContain('UP');
    }
  });

  it('turns 南翔 short routes on its middle track, platform on the DN side only', () => {
    const NX = station('NX'), turns = topo.stations[NX].turnbackBerths;
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.every(berth => topo.berths[berth].kind === 'platform' && topo.links[topo.berths[berth].link].platform >= 0)).toBe(true);
    // the middle track shares the DN main's island: its face looks the other way
    const loop = topo.platforms.filter(p => p.station === NX && turns.some(berth => topo.berths[berth].link === p.link));
    const main = topo.platforms[topo.stations[NX].platforms.DN];
    expect(loop.map(p => p.track)).toEqual(['DN']);
    expect(loop[0].face).not.toBe(main.face);
  });

  it('runs UP from 嘉定新城 to either branch', () => {
    const JDC = station('JDC');
    expect(reaches(platform(JDC, 'UP'), platform(station('JDB'), 'UP'))).toBe(true);
    expect(reaches(platform(JDC, 'UP'), platform(station('HQ'), 'UP'))).toBe(true);
    // and the branch only leads to its own two stations, not to 嘉定北
    expect(reaches(platform(station('HQ'), 'UP'), platform(station('JDB'), 'UP'))).toBe(false);
  });

  for (const dayType of ['weekday', 'weekend'] as const) it(`${dayType}: lays out both branches and the short routes without plan issues`, async () => {
    const sim = new Sim({ dayType, dateLabel: '11号线', startTime: 14400, seed: 7 });
    const paths = (dir: 'DN' | 'UP') => {
      const count = new Map<string, number>();
      for (const trip of sim.plan.trips) if (trip.revenue && trip.dir === dir) {
        const key = trip.stops.map(stop => STATIONS[stop.st].id).join(' ');
        count.set(key, (count.get(key) ?? 0) + 1);
      }
      return count;
    };
    const dn = [...paths('DN').keys()], up = [...paths('UP').keys()];
    expect(dn.some(path => path.startsWith('JDB ') && path.endsWith(' DSL'))).toBe(true);
    expect(dn.some(path => path.startsWith('HQ ') && path.endsWith(' DSL'))).toBe(true);
    expect(up.some(path => path.startsWith('DSL ') && path.endsWith(' JDB'))).toBe(true);
    expect(up.some(path => path.startsWith('DSL ') && path.endsWith(' HQ'))).toBe(true);
    // the short routes run in the weekday peaks only (official weekend table has no small route)
    if (dayType === 'weekday') {
      // 用户决定（2026-11-18）：高峰小交路是南翔—罗山路、花桥—罗山路；不再有南翔—三林小交路；夜间有嘉定北—三林东
      expect(dn.some(path => path.startsWith('NX ') && path.endsWith(' LSH'))).toBe(true);
      expect(dn.some(path => path.startsWith('HQ ') && path.endsWith(' LSH'))).toBe(true);
      expect(up.some(path => path.startsWith('LSH ') && path.endsWith(' NX'))).toBe(true);
      expect(up.some(path => path.startsWith('LSH ') && path.endsWith(' HQ'))).toBe(true);
      expect(dn.some(path => path.startsWith('NX ') && path.endsWith(' SL'))).toBe(false);
      expect(dn.some(path => path.startsWith('JDB ') && path.endsWith(' SLD'))).toBe(true);
    }
    // every trip calls only at stations on its own way, and never repeats one
    for (const trip of sim.plan.trips.filter(trip => trip.revenue)) {
      expect(new Set(trip.stops.map(stop => stop.st)).size).toBe(trip.stops.length);
      expect(order.stationPath(trip.from, trip.to)).toEqual(trip.stops.map(stop => stop.st));
    }
    expect(sim.plan.fleetPeak).toBeLessThanOrEqual(82);
    expect(validatePlan(sim.planCtx, sim.plan, true, false, { checkWaiting: true })).toEqual([]);

    // L11-04 / L11-18: four patrols, after the night's possessions, each the first train over its
    // tracks, then working the first departure where it waits
    const { POSSESSIONS } = await import('../src/data/current');
    const patrols = sim.plan.blocks.filter(block => sim.plan.trips[block.trips[0]].patrol);
    expect(patrols.map(block => block.trips.filter(id => sim.plan.trips[id].patrol)
      .map(id => STATIONS[sim.plan.trips[id].from].id).concat(STATIONS[sim.plan.trips[block.trips.find(id => !sim.plan.trips[id].patrol)!].from].id)).sort())
      .toEqual([['JDB', 'DSL'], ['LSH', 'DSL', 'JDB'], ['SSC', 'HQ'], ['SSC', 'NX']].sort());
    for (const block of patrols) {
      expect(block.start.kind).toBe('depot');
      const legs = block.trips.map(id => sim.plan.trips[id]).filter(trip => trip.patrol);
      expect(legs[0].stops[0].dep).toBeGreaterThanOrEqual(POSSESSIONS.morningUntil);
      for (const leg of legs) for (const stop of leg.stops) for (const other of sim.plan.trips)
        if (other.revenue && !other.cancelled && other.dir === leg.dir) for (const call of other.stops)
          if (call.st === stop.st) expect(call.dep).toBeGreaterThan(stop.dep);
      const served = sim.plan.trips[block.trips.find(id => !sim.plan.trips[id].patrol)!];
      expect(served.revenue).toBe(true);
      expect(sim.plan.trips.filter(trip => trip.revenue && !trip.cancelled && trip.from === served.from && trip.dir === served.dir)
        .every(trip => trip.stops[0].dep >= served.stops[0].dep)).toBe(true);
    }
    // 官方首末班（D214）：往安亭末班迪士尼 22:25 发、00:01 到安亭；安亭 05:35 往迪士尼；往花桥首班罗山路 05:25；
    // 往花桥末班 23:45 到花桥，之后不再有开往花桥的车
    const revenue = sim.plan.trips.filter(trip => trip.revenue && !trip.cancelled);
    const clock = (h: number, m: number) => h * 3600 + m * 60;
    const toAT = revenue.filter(trip => trip.dir === 'UP' && STATIONS[trip.to].id === 'AT');
    expect(toAT.map(trip => [STATIONS[trip.from].id, trip.stops[0].dep, trip.stops.at(-1)!.arr])).toEqual([['DSL', clock(22, 25), clock(24, 1)]]);
    expect(revenue.some(trip => trip.dir === 'DN' && STATIONS[trip.from].id === 'AT' && STATIONS[trip.to].id === 'DSL' && trip.stops[0].dep === clock(5, 35))).toBe(true);
    const toHQ = revenue.filter(trip => trip.dir === 'UP' && STATIONS[trip.to].id === 'HQ');
    expect(Math.max(...toHQ.map(trip => trip.stops.at(-1)!.arr))).toBeLessThanOrEqual(clock(23, 45) + 60);
    expect(Math.min(...toHQ.map(trip => trip.stops[0].dep))).toBe(clock(5, 25));
    // 嘉定新城 22:23 那一列是花桥 22:00 那趟的：它 23:44 到迪士尼，嘉定北 22:10 那趟在它前面 4 分钟（23:39 到）
    const lastDN = (id: string) => revenue.filter(trip => trip.dir === 'DN' && STATIONS[trip.from].id === id && STATIONS[trip.to].id === 'DSL').sort((x, y) => x.stops[0].dep - y.stops[0].dep).at(-1)!;
    expect([lastDN('HQ').stops[0].dep, Math.floor(lastDN('HQ').stops.at(-1)!.arr / 60) * 60]).toEqual([clock(22, 0), clock(23, 44)]);
    expect([lastDN('JDB').stops[0].dep, Math.floor(lastDN('JDB').stops.at(-1)!.arr / 60) * 60]).toEqual([clock(22, 10), clock(23, 39)]);
    // 罗山路出库往迪士尼（D215）：工作日有，周末没有
    const outOfLSH = revenue.filter(trip => trip.dir === 'DN' && STATIONS[trip.from].id === 'LSH' && STATIONS[trip.to].id === 'DSL');
    expect(outOfLSH.length > 0).toBe(dayType === 'weekday');
    // 浦三路中间线过夜一列：夜里最后一批到站的车空车进去，次日清晨空车出来（工作日是嘉定北—三林东夜间交路的车）
    const PSR = station('PSR');
    const into = sim.plan.trips.filter(trip => !trip.revenue && !trip.cancelled && trip.to === PSR && trip.stops[0].dep >= 22.5 * 3600);
    const out = sim.plan.trips.filter(trip => !trip.revenue && !trip.cancelled && trip.from === PSR && trip.stops[0].dep < 6 * 3600);
    expect(into).toHaveLength(1);
    expect(out).toHaveLength(1);
    if (dayType === 'weekday') expect(STATIONS[into[0].from].id).toBe('SLD');
  });
});
