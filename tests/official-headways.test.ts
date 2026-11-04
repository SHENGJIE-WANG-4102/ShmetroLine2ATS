import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { minTurn, terminalOccupancy } from '../src/sim/timetable';
import { OFFICIAL_HEADWAYS, STATIONS } from '../src/data/current';
import type { Plan } from '../src/sim/model';
import type { Topology } from '../src/sim/topology';

// D173 用户决定（2026-11-04）：官方间隔是时段平均值。2号线多车库、多交路，
// 高峰和回库难免多开，所以只看整段平均间隔：偏稀不超过官方110%，偏密不低于80%。
// "其他时段"夹在高峰前铺车和收车回库之间，只卡偏稀。
const SPARSE = 1.1, DENSE = 0.8;
// "其他时段"只在全天运营的钟点里检查，开班和收车另由首末班约束。
const SERVICE = { from: 6 * 3600, to: 22.5 * 3600 };
const OTHER = [300, 600] as const;

const clock = (v: string) => { const [h, m] = v.split(':').map(Number); return h * 3600 + m * 60; };

/** Revenue departures at the boarding stop nearest the middle of a section. */
function middleDepartures(plan: Plan, topo: Topology, a: string, b: string, dir: 'DN' | 'UP', start: number, end: number) {
  const c0 = topo.stations[STATIONS.findIndex(s => s.name === a)].chain;
  const c1 = topo.stations[STATIONS.findIndex(s => s.name === b)].chain;
  const middle = (c0 + c1) / 2;
  const station = topo.stations.filter(s => s.chain > Math.min(c0, c1) && s.chain < Math.max(c0, c1))
    .sort((x, y) => Math.abs(x.chain - middle) - Math.abs(y.chain - middle))[0];
  const count = plan.trips.filter(t => t.revenue && !t.cancelled && t.dir === dir && t.to !== station.index)
    .filter(t => t.stops.some(p => p.st === station.index && p.stop && !p.noBoard && p.dep >= start && p.dep < end)).length;
  return { station: STATIONS[station.index].name, count };
}

/** Named official windows of a day, and the gaps between them inside SERVICE. */
function windows(dayType: 'weekday' | 'weekend') {
  const rows = OFFICIAL_HEADWAYS[dayType];
  const named = rows.filter(r => r.from && r.to).map(r => ({ name: r.name, from: clock(r.from!), to: clock(r.to!), sections: r.sections }))
    .sort((x, y) => x.from - y.from);
  const other = rows.find(r => !r.from)!;
  const gaps: typeof named = [];
  let at = SERVICE.from;
  for (const w of named) { if (w.from > at) gaps.push({ name: other.name, from: at, to: w.from, sections: other.sections }); at = Math.max(at, w.to); }
  if (at < SERVICE.to) gaps.push({ name: other.name, from: at, to: SERVICE.to, sections: other.sections });
  return [...named, ...gaps];
}

/** Official average headway at the outer section of terminal `st` at time `t`. */
function terminalHeadway(dayType: 'weekday' | 'weekend', st: number, t: number) {
  const name = STATIONS[st].name;
  const w = windows(dayType).find(w => t >= w.from && t < w.to);
  const section = w?.sections.find(([a, b]) => a === name || b === name);
  const h = section?.[2];
  return typeof h === 'number' ? h : OTHER[1];
}

describe.each(['weekday', 'weekend'] as const)('D173 official headways (%s)', dayType => {
  const sim = new Sim({ dayType, dateLabel: 'official headways', startTime: 14400, seed: 1 });

  it('keeps every official window, section and direction within the average-interval band', () => {
    const report: string[] = [], bad: string[] = [];
    for (const w of windows(dayType)) for (const [a, b, h] of w.sections) {
      const [low, high] = typeof h === 'number' ? [h, h] : h;
      for (const dir of ['DN', 'UP'] as const) {
        const { station, count } = middleDepartures(sim.plan, sim.topo, a, b, dir, w.from, w.to);
        const average = count ? (w.to - w.from) / count : Infinity;
        const line = `${w.name} ${a}—${b} ${dir} @${station}: ${count}列 平均${Math.round(average)}s 官方${typeof h === 'number' ? h : h.join('–')}s`;
        report.push(line);
        if (average > high * SPARSE || typeof h === 'number' && average < low * DENSE) bad.push(line);
      }
    }
    console.log(report.join('\n'));
    expect(bad).toEqual([]);
  });

  it('turns trains at the line ends without queueing beyond one official interval', () => {
    const bad: string[] = [];
    for (const st of [0, sim.topo.stations.length - 1]) {
      for (const o of terminalOccupancy(sim.plan, sim.topo).get(st) ?? []) {
        const arrival = o.arrival !== undefined ? sim.plan.trips[o.arrival] : undefined;
        // Night stabling and the hot standby stand by design.
        if (arrival?.standby || o.to - o.from > 3 * 3600 || o.from < SERVICE.from || o.from >= SERVICE.to) continue;
        const limit = minTurn(st) + terminalHeadway(dayType, st, o.from);
        if (o.to - o.from > limit) bad.push(`${STATIONS[st].name} ${Math.floor(o.from / 3600)}:${String(Math.floor(o.from % 3600 / 60)).padStart(2, '0')} 停${Math.round(o.to - o.from)}s 限${limit}s`);
      }
    }
    expect(bad).toEqual([]);
  });
});
