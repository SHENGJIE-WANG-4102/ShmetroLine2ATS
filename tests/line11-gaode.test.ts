import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';

/** 11号线工作日高峰以高德为主（用户 2026-11-18）：高德到站表（reference/line11/gaode-20261118-weekday-am.md，
 * 往迪士尼方向，秀沿路、东方体育中心、三林东）每一段连续时刻里的班数，排图在同一站同一时段到站的班数
 * 差不超过 max(3 班, 10%)。东方体育中心、三林东的早高峰第一段不比：截图是 03:34 的滚动窗口，
 * 07:32–08:30 只有 13 班，与官方 2 分钟间隔、与秀沿路同时段 20 班都对不上，数据本身不可信。 */
const FILE = 'reference/line11/gaode-20261118-weekday-am.md';
const STATIONS = ['秀沿路', '东方体育中心', '三林东'];
const UNRELIABLE = new Set(['东方体育中心 0', '三林东 0']);

function parse() {
  const found: Record<string, number[][]> = {};
  let station = '', morning = true;
  for (const line of readFileSync(FILE, 'utf8').split('\n')) {
    if (line.startsWith('## 补充')) morning = false;
    const head = line.match(/^#{2,3} (秀沿路|东方体育中心|三林东)/);
    if (head) { station = head[1]; continue; }
    if (!station) continue;
    const body = morning && /^\d\d:\d\d /.test(line) ? line : !morning && /^- \d\d:\d\d–/.test(line) ? line.split('：')[1] ?? '' : '';
    const times = (body.match(/\d\d:\d\d/g) ?? []).map(x => { const [h, m] = x.split(':').map(Number); return h * 60 + m; });
    if (!times.length) continue;
    const list = found[station] ??= [];
    if (morning) { if (!list.length) list.push([]); list[0].push(...times); } else list.push(times);
  }
  return found;
}

describe('11号线工作日 高德到站班数', () => {
  const gaode = parse();
  const sim = new Sim({ dayType: 'weekday', dateLabel: 'gaode', startTime: 4 * 3600, seed: 1 });

  it.each(STATIONS)('%s 各段班数贴近高德', name => {
    const st = sim.topo.stations.findIndex(s => s.name === name);
    const ours = sim.plan.trips.filter(t => !t.cancelled && t.revenue && t.dir === 'DN')
      .map(t => t.stops.find(p => p.st === st && p.stop)?.arr).filter((x): x is number => x !== undefined).map(x => x / 60);
    const bad: string[] = [];
    gaode[name].forEach((segment, index) => {
      if (UNRELIABLE.has(`${name} ${index}`)) return;
      const from = segment[0], to = segment.at(-1)!;
      const plan = ours.filter(x => x >= from - .5 && x <= to + .5).length;
      if (Math.abs(plan - segment.length) > Math.max(3, segment.length * .1)) bad.push(`${name} ${from}–${to} 分: 高德 ${segment.length} 班 排图 ${plan} 班`);
    });
    expect(bad).toEqual([]);
  });
});
