/**
 * Compare the generated weekday plan with the Gaode station tables
 * (reference/timetable-gaode/), as boarding calls per 15 minutes.
 *
 *   npx tsx scripts/gaode-compare.ts                  # check stations, summary
 *   npx tsx scripts/gaode-compare.ts --table 北新泾,淞虹路   # per-bin table
 *
 * The check set leaves out the Gaode readings known to disagree with their
 * neighbours (虹桥2号航站楼 UP midday, 北新泾 DN 18–21, the inconsistent eastern cells;
 * reference/line2/timetable-gaode.md). A bin fails when |Gaode − plan| ≥ 2.
 */
import { readFileSync } from 'node:fs';
import { Sim } from '../src/sim/engine';

const BIN = 15;
const CHECK: [string, 'UP' | 'DN'][] = [['北新泾', 'UP'], ['世纪公园', 'UP'], ['世纪公园', 'DN'], ['张江高科', 'UP'], ['张江高科', 'DN']];
const WINDOWS: [number, number][] = [[6 * 60, 11 * 60], [16 * 60, 23 * 60 + 30]];

const arg = process.argv.indexOf('--table');
const table = arg > 0 ? process.argv[arg + 1].split(',') : null;
const baselineAt=process.argv.indexOf('--baseline');
const baseline=baselineAt>0?JSON.parse(readFileSync(process.argv[baselineAt+1],'utf8')):null;
const s = new Sim({ dayType: 'weekday', dateLabel: 'gaode-compare', startTime: 4 * 3600, seed: 1 });
const names = s.topo.stations.map((x) => x.name);
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const gaode = (st: string, dir: string) => readFileSync(`reference/timetable-gaode/${st}-${dir}-weekday.txt`, 'utf8')
  .split(/\r?\n/).filter((l) => /^\d\d:\d\d/.test(l)).map((l) => +l.slice(0, 2) * 60 + +l.slice(3, 5));
/** minutes of the revenue calls where passengers can board */
const plan = (st: string, dir: string, arrivals = false) => {
  const i = names.indexOf(st);
  return (baseline??s.plan).trips.filter((t: import('../src/sim/model').Trip) => t.revenue && !t.cancelled && t.dir === dir)
    .flatMap((t) => t.stops.filter((p, k) => p.st === i && p.stop && !p.noBoard && (arrivals || k < t.stops.length - 1)).map((p) => Math.floor(p.arr / 60)));
};
const count = (ts: number[], b: number) => ts.filter((t) => t >= b && t < b + BIN).length;

if (table) {
  for (const dir of ['UP', 'DN']) {
    const cols = table.map((n) => ({ n, g: gaode(n, dir), m: plan(n, dir) }));
    console.log(`\n${dir}    ` + cols.map((c) => `${c.n.slice(0, 4).padStart(5)} G/P`).join('  '));
    for (let b = 5 * 60; b < 24 * 60; b += BIN) console.log(`${hm(b)}  ` + cols.map((c) => `${String(count(c.g, b)).padStart(5)}/${String(count(c.m, b)).padEnd(3)}`).join('  '));
    for (const c of cols) console.log(`${c.n} ${dir} total Gaode ${c.g.length} plan ${c.m.length}`);
  }
} else {
  let fails = 0, abs = 0;
  for (const [st, dir] of CHECK) {
    const g = gaode(st, dir), m = plan(st, dir), bad: string[] = [];
    for (const [a, z] of WINDOWS) for (let b = a; b < z; b += BIN) {
      const d = count(m, b) - count(g, b);
      abs += Math.abs(d);
      if (Math.abs(d) >= 2) bad.push(`${hm(b)} ${d > 0 ? '+' : ''}${d}`);
    }
    fails += bad.length;
    console.log(`${st} ${dir}: Gaode ${g.length} plan ${m.length}; bins off by ≥2: ${bad.length ? bad.join(', ') : 'none'}`);
  }
  console.log(`total |plan − Gaode| over windows ${abs}, failing bins ${fails}`);
}

// Eastern tables are inconsistent with the middle section and are reference
// only. Do not count their differences as failures or acceptance criteria.
const EAST = {
  stations: ['川沙','凌空路','远东大道','海天三路','浦东1号2号航站楼'],
  from: 8, to: 24,
};
if (!table) {
  console.log('东段仅作参考（整体不可信，不计入不合格或验收；小时格为高德/计划到站数）');
  for (const station of EAST.stations) {
    const g = gaode(station,'DN'), m = plan(station,'DN',true);
    const hours = Array.from({length:EAST.to-EAST.from},(_,i)=>EAST.from+i);
    console.log(`参考 ${station} DN: ` + hours.map(hour=>{
      const n = (values:number[]) => values.filter(t=>t>=hour*60&&t<(hour+1)*60).length;
      return `${hour}:00 ${n(g)}/${n(m)}`;
    }).join(', '));
  }
}
