// Compare the weekday plan with the published first / last trains (src/data/firstlast.ts):
// per station, and section by section along the three last trains (each one train end to end).
//   usage: npx tsx scripts/firstlast.ts
import { Sim } from '../src/sim/engine';
import { FIRST_LAST } from '../src/data/firstlast';
import { readFileSync } from 'node:fs';
import type { Plan } from '../src/sim/model';

const sim = new Sim({ dayType: 'weekday', dateLabel: 'firstlast', startTime: 4 * 3600, seed: 1 });
const baselineAt = process.argv.indexOf('--baseline');
const p: Plan = baselineAt > 0 ? JSON.parse(readFileSync(process.argv[baselineAt + 1], 'utf8')) : sim.plan, topo = sim.topo;
const tm = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 3600 + m * 60; };
const hm = (t: number) => { const minute = Math.floor((t + .001) / 60); return `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`; };
const idx = (n: string) => { const i = topo.stations.findIndex((s) => s.name === n); if (i < 0) throw new Error(n); return i; };
const E = topo.stations.length - 1, GLL = idx('广兰路');
const rev = p.trips.filter((t) => !t.cancelled && t.revenue);
const boardAt = (t: (typeof rev)[number], st: number) => t.stops.find((x) => x.st === st && x.stop && !x.noBoard);

/** first / last boardable departure at `st` in `dir` on a trip satisfying `ok` */
function pick(st: number, dir: 'DN' | 'UP', ok: (t: (typeof rev)[number]) => boolean, last: boolean, arrival = false): number | null {
  let best: number | null = null;
  for (const t of rev) {
    if (t.dir !== dir || !ok(t) || (t.to === st && !arrival)) continue;
    const s = arrival && t.to === st ? t.stops.at(-1) : boardAt(t, st);
    const time = s && (arrival && t.to === st ? s.arr : s.dep);
    if (time !== undefined && (best === null || (last ? time > best : time < best))) best = time;
  }
  return best;
}
const toE = (t: (typeof rev)[number]) => t.to === E, toW = (t: (typeof rev)[number]) => t.to === 0;
const viaG = (t: (typeof rev)[number]) => t.stops.some((x) => x.st === GLL);
const cell = (v: string, ours: number | null) => {
  if (!v) return '--';
  if (ours === null) return `${v}/--`;
  const d = Math.round((ours - tm(v)) / 60);
  return `${v}/${hm(ours)} ${d >= 0 ? '+' : ''}${d}`;
};
console.log('station | first→airport | first→蟠祥路 | last→airport | last→蟠祥路 | last→广兰路   (official/ours Δmin)');
for (const r of FIRST_LAST) {
  const st = idx(r.station);
  console.log([r.station, cell(r.firstE, pick(st, 'DN', toE, false, st === E)), cell(r.firstW, pick(st, 'UP', toW, false, st === 0)),
    cell(r.lastE, pick(st, 'DN', toE, true, st === E)), cell(r.lastW, pick(st, 'UP', toW, true, st === 0)), cell(r.lastG, pick(st, 'DN', viaG, true, st === GLL))].join(' | '));
}

// section times along the last trains: official (minute-truncated, ±1) vs planned
const lastTrip = (dir: 'DN' | 'UP', to: number) => rev.filter((t) => t.dir === dir && t.to === to).sort((a, b) => a.stops[0].dep - b.stops[0].dep).at(-1)!;
const cols = [['last→airport', 'lastE', lastTrip('DN', E)], ['last→蟠祥路', 'lastW', lastTrip('UP', 0)], ['last→广兰路', 'lastG', lastTrip('DN', GLL)]] as const;
for (const [name, key, trip] of cols) {
  const rows = FIRST_LAST.filter((r) => r[key] && trip.stops.some((x) => x.st === idx(r.station)));
  const ord = trip.dir === 'DN' ? rows : [...rows].reverse();
  console.log(`\n=== ${name}: ours ${trip.no} dep ${hm(trip.stops[0].dep)}, official ${ord[0][key]}`);
  let prev: { n: string; real: number; ours: number } | null = null, sr = 0, so = 0;
  for (const r of ord) {
    const s = trip.stops.find((x) => x.st === idx(r.station))!;
    const cur = { n: r.station, real: tm(r[key]), ours: s.dep };
    if (prev) {
      const dr = (cur.real - prev.real) / 60, dO = (cur.ours - prev.ours) / 60;
      sr += dr; so += dO;
      console.log(`${prev.n} → ${cur.n}: official ${dr.toFixed(0)}  ours ${dO.toFixed(1)}  Δ ${(dr - dO).toFixed(1)}`);
    }
    prev = cur;
  }
  console.log(`total official ${sr.toFixed(0)} min, ours ${so.toFixed(1)} min, ×${(sr / so).toFixed(3)}`);
}
