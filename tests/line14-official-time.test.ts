import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Topology } from '../src/sim/topology';
import type { RunTimes } from '../src/sim/dynamics';

describe('14号线官方首末班独立锚点', () => {
  let topo: Topology, rt: RunTimes;
  let current: typeof import('../src/data/current');
  let buildStops: typeof import('../src/sim/timetable').buildStops;
  beforeAll(async () => {
    vi.stubEnv('ATS_LINE', '14'); vi.resetModules();
    current = await import('../src/data/current');
    topo = (await import('../src/sim/topology')).buildTopology();
    rt = (await import('../src/sim/dynamics')).computeRunTimes(topo, current.LINE_INFO.trainLength);
    buildStops = (await import('../src/sim/timetable')).buildStops;
  });
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('法定节日使用双休日图，豫园封站按公告日历和时刻办理', async () => {
    const {holidayOf, dayTypeOf, parseIso} = await import('../src/sim/calendar');
    const {holidayEvents} = await import('../src/sim/holiday');
    const yy = topo.stations.find(st => st.id === 'YY')!;
    for (const [date, clock, dayType] of [
      ['2026-05-01', 16, 'weekend'], ['2026-05-05', 16, 'weekend'],
      ['2026-09-30', 20, 'weekday'], ['2026-10-01', 16, 'weekend'], ['2026-10-07', 16, 'weekend'],
    ] as const) {
      expect(dayTypeOf(parseIso(date), false), date).toBe(dayType);
      const holiday = holidayOf(date)!;
      const commands: import('../src/sim/model').Command[] = [];
      const world = {topo, command: (c: import('../src/sim/model').Command) => commands.push(c), log: () => {}};
      const closure = holidayEvents(holiday).find(event => event.at === clock * 3600)!;
      expect(closure, date).toBeDefined();
      closure.run(world as unknown as import('../src/sim/engine').Sim);
      expect(commands).toEqual([
        {c:'platformSkip', platform:yy.platforms.DN, on:true},
        {c:'platformSkip', platform:yy.platforms.UP, on:true},
      ]);
    }
    for (const date of ['2026-05-06', '2026-09-29', '2026-10-08']) {
      expect(holidayOf(date)).toBeNull();
      expect(dayTypeOf(parseIso(date), false)).toBe('weekday');
    }
  });

  it('两种日型、两个方向、首末班逐一保持官方60秒误差界限，并报告分钟差', () => {
    const clock = (value: string) => { const [h, m] = value.split(':').map(Number); return h * 3600 + m * 60; };
    const differences: string[] = [];
    let checked = 0;
    for (const dayType of ['weekday', 'weekend'] as const) for (const dir of ['DN', 'UP'] as const) for (const service of ['first', 'last'] as const) {
      const start = dir === 'DN' ? 0 : 30, end = dir === 'DN' ? 30 : 0;
      const stops = buildStops({ topo, rt, dayType }, dir, start, end, service === 'first' ? 19800 : 81000, true, 1);
      for (const row of current.FIRST_LAST) {
        const station = current.STATIONS.findIndex(st => st.name === row.station);
        const stop = stops.find(s => s.st === station)!;
        const key = `${service}${dir === 'DN' ? 'E' : 'W'}` as 'firstE' | 'lastE' | 'firstW' | 'lastW';
        const target = clock(row[key]), actual = station === end ? stop.arr : stop.dep, error = actual - target;
        expect(Math.abs(error), `${dayType}/${dir}/${service}/${row.station} ${error.toFixed(1)}秒`).toBeLessThanOrEqual(60);
        if (Math.floor(actual / 60) !== target / 60) differences.push(`${dayType}/${dir}/${service}/${row.station}: ${error.toFixed(1)}秒`);
        checked++;
      }
      const unopened = stops.find(s => s.st === current.STATIONS.findIndex(st => st.id === 'LJL'))!;
      expect(unopened.stop).toBe(false);
      expect(unopened.dep).toBe(unopened.arr);
    }
    expect(checked).toBe(240);
    // The official source has minute-level discrepancies; print every mismatch,
    // without changing the source or treating different minutes as exact matches.
    if (differences.length) console.info('官方分钟不同（逐格误差已逐项断言≤60秒）\n' + differences.join('\n'));
  });
});
