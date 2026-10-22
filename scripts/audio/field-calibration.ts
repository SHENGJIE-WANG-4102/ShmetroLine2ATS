/** One entry for a new ride or the existing local recordings. See README-field.md. */
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { STATIONS } from '../../src/data/line2';
import { FIRST_LAST } from '../../src/data/firstlast';
import { RIDE_LOG, RECORDING_SOURCES } from '../../src/data/ridelog';
import { FIELD_1021_ORIGINALS } from '../../src/data/onboardfield1021';
import { ahead } from '../../src/sim/topology';
import { capture, restore } from '../../src/sim/state';
import { createProbeWorld, probeSection } from './field-model';

const args = process.argv.slice(2);
const option = (key: string) => { const at = args.indexOf(key); return at < 0 ? undefined : args[at + 1]; };
if (args.includes('--help')) {
  console.log('npx tsx scripts/audio/field-calibration.ts --input FILE --from STATION --direction DN|UP --clock HH:MM --out work/field-calibration/new\n  --existing: run all existing rides; --refresh-model: discard model cache; --no-model: audio/statistics only');
  process.exit(0);
}
const out = resolve(option('--out') ?? 'work/field-calibration');
const inside = relative(resolve('work'), out);
if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Output must be a child of ignored work/');
mkdirSync(out, { recursive: true });
const save = (name: string, data: unknown) => writeFileSync(join(out, name), JSON.stringify(data, null, 2), 'utf8');
const existing = args.includes('--existing');
const sources = RECORDING_SOURCES.filter(s => s.kind === 'ride').map(s => ({ ...s,
  path: resolve(s.id.startsWith('ride-1016') ? 'work/recordings/10-16' : 'work/recordings', s.filename),
  events: RIDE_LOG.filter(r => r.recording === s.id), mode: 'adopted-events',
}));
for (const [id, clock, name, from] of [
  ['ride-1021-east', '19:56', '10-21-2026 19.56.wav', '广兰路'],
  ['ride-1021-west', '20:33', '10-21-2026 20.33.wav', '浦东1号2号航站楼'],
]) {
  const pa = FIELD_1021_ORIGINALS.filter(p => p.source === id);
  (sources as unknown[]).push({ id, path: resolve('D:/Windows_Users/Downloads', name), filename: name,
    clockStart: clock, clockStartPrecision: 'minute', from, directions: [pa[0].direction],
    durationS: id.endsWith('west') ? 3667.54 : 1859.30,
    offset: id.endsWith('west') ? 152 : 0, mode: 'pa-windows', announcements: pa });
}
if (!existing) {
  const path = option('--input'), from = option('--from'), direction = option('--direction'), clock = option('--clock');
  if (!path || !from || !STATIONS.some(s => s.name === from) || !['DN', 'UP'].includes(direction ?? '') || !/^\d{2}:\d{2}(:\d{2})?$/.test(clock ?? '')) throw new Error('Supply --input, known --from, --direction DN|UP and --clock HH:MM[:SS]');
  const known = (sources as unknown as { path: string; from: string; observedFrom?: string; directions: string[] }[]).find(s => resolve(s.path).toLowerCase() === resolve(path).toLowerCase());
  if (known && ((known.observedFrom ?? known.from) !== from || known.directions[0] !== direction)) throw new Error('Known recording conflicts with --from or --direction; see source metadata');
  sources.length = 0;
  (sources as unknown[]).push(known && !args.includes('--automatic') ? { ...known, clockStart: clock } : { id: 'new-ride', path: resolve(path), from, directions: [direction], clockStart: clock, clockStartPrecision: 'approximate', mode: 'automatic', offset: Number(option('--offset') ?? 0), recognizer: option('--recognizer') });
}
save('catalog.json', { sources, stations: STATIONS.map((s, index) => ({ index, id: s.id, name: s.name })), official: FIRST_LAST,
  travelOrder: Object.fromEntries(['DN', 'UP'].map(dir => [dir, STATIONS.map((s, index) => ({ name: s.name, index })).sort((a, b) => ahead(dir as 'DN' | 'UP', a.index, b.index) ? -1 : a.index === b.index ? 0 : 1).map(s => s.name)])) });
function python(...parameters: string[]) {
  const run = spawnSync(option('--python') ?? 'python', [resolve('scripts/audio/field-audio.py'), '--out', out, ...parameters], { stdio: 'inherit' });
  if (run.status !== 0) throw new Error(`Audio/statistics failed (${run.status})`);
}
const preparedOnly = args.includes('--prepare-only');
if (preparedOnly) process.exit(0);
python('--measure');
if (!args.includes('--no-model')) {
  const measurements = JSON.parse(readFileSync(join(out, 'measurements.json'), 'utf8')) as { intervals: { from: string; to: string; direction: 'DN' | 'UP'; modelClock: number }[] };
  const jobs = measurements.intervals.map(row => ({ from: STATIONS.findIndex(s => s.name === row.from), to: STATIONS.findIndex(s => s.name === row.to), dir: row.direction, clock: row.modelClock }));
  if (existing) for (const dir of ['DN', 'UP'] as const) for (const clock of [8 * 3600, 12 * 3600, 18 * 3600, 20 * 3600 + 30 * 60, 22 * 3600 + 15 * 60]) {
    const order = STATIONS.map((_, i) => i).sort((a, b) => ahead(dir, a, b) ? -1 : a === b ? 0 : 1);
    for (let i = 1; i < order.length; i++) jobs.push({ from: order[i - 1], to: order[i], dir, clock });
  }
  // Cache identity covers all production TS inputs and parameters, never filenames alone.
  const hash = createHash('sha256');
  for (const folder of ['src/data', 'src/sim']) for (const file of readdirSync(folder).filter(f => f.endsWith('.ts')).sort()) { hash.update(`${folder}/${file}`); hash.update(readFileSync(join(folder, file))); }
  hash.update(readFileSync('scripts/audio/field-model.ts')); hash.update(JSON.stringify(jobs));
  const signature = hash.digest('hex');
  let cache: { signature?: string; rows: ReturnType<typeof probeSection>[] } = { rows: [] };
  try { cache = JSON.parse(readFileSync(join(out, 'model.json'), 'utf8')); } catch { /* fresh output */ }
  if (cache.signature !== signature || args.includes('--refresh-model')) {
    const sim = createProbeWorld(), baseline = capture(sim), rows: ReturnType<typeof probeSection>[] = [];
    const unique = new Map(jobs.map(job => [JSON.stringify(job), job]));
    for (const job of unique.values()) {
      restore(sim, baseline);
      const row = probeSection(sim, job.from, job.to, job.dir, job.clock); rows.push(row);
      console.log(`model ${rows.length}/${unique.size}: ${STATIONS[job.from].name}→${STATIONS[job.to].name} ${job.dir} ${job.clock} run=${row.run?.toFixed(1)} peak=${row.peakKmh?.toFixed(1)} violations=${row.violations.length}`);
      if (!row.completed || row.violations.length) { save('model-failure.json', row); throw new Error('Incomplete or unsafe probe; see model-failure.json'); }
    }
    save('model.json', { signature, rows });
  } else console.log(`model cache: ${cache.rows.length} probes, verified source signature`);
}
python('--summarize', ...(args.includes('--no-model') ? ['--no-model'] : []));
