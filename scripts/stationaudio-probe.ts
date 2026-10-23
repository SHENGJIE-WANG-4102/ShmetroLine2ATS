/** Short headless probe: 30 simulated minutes at rate=1, fixed 0.1 s steps.
 * npx --no-install vite-node scripts/stationaudio-probe.ts --label before
 * --frames work/recordings/analysis/stationaudio-frames.json writes replay frames;
 * --replay PATH compares the same visits without regenerating the simulator.
 * Metadata only, all output restricted to ignored work/. No audio is played.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { deserialize } from 'node:v8';
import { Sim } from '../src/sim/engine';
import { restore, type Checkpoint } from '../src/sim/state';
import { STATIONS } from '../src/data/current';
import { SOUND_BANK } from '../src/data/audio/soundbank';
import { StationSoundPlanner, stationFrame, predictStationStop, type StationAudioFrame, type StationTrain } from '../src/ui/stationaudio';
import { onboardFrame, OnboardSoundPlanner, type OnboardAudioFrame } from '../src/ui/onboardaudio';

const args = process.argv.slice(2), arg = (name: string, def = '') => args.includes(name) ? args[args.indexOf(name) + 1] : def;
const label = arg('--label', 'current'), name = arg('--station', '江苏路');
const station = STATIONS.findIndex(s => s.name === name);
if (station < 0) throw new Error(`Unknown station: ${name}`);
const key = (tr: StationTrain) => `${tr.direction}|${tr.id}|${tr.trip}`;
const eligible = (tr: StationTrain) => (tr.mode === 'DTO' || tr.mode === 'AM') && !tr.manual && !tr.rm && !tr.failed && !tr.eb && tr.inService;
interface Arrival { key: string; t: number; direction: 'DN' | 'UP' }
interface Trace { frames: StationAudioFrame[]; onboardFrames?: OnboardAudioFrame[]; arrivals: Arrival[]; station: string; start: number; end: number; rate: number }
function save(path: string, value: unknown) {
  const inside = relative(resolve('work'), resolve(path));
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Probe output must be under work/');
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function warmupHash() {
  const hash = createHash('sha256');
  const walk = (dir: string) => { for (const name of readdirSync(dir).sort()) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else { hash.update(p); hash.update(readFileSync(p)); } } };
  walk('src/sim'); walk('src/data'); hash.update(readFileSync('tests/warmup.ts'));
  return hash.digest('hex').slice(0, 16);
}
let trace: Trace;
if (arg('--replay')) trace = JSON.parse(readFileSync(arg('--replay'), 'utf8'));
else {
  const start = 8 * 3600, end = start + 1800;
  const sim = new Sim({ dayType: 'weekday', dateLabel: 'audio probe', startTime: start, seed: 7 });
  const checkpoint = join('node_modules/.cache/atssim-warmup', warmupHash(), 'weekday-28800-7.bin');
  if (existsSync(checkpoint)) { restore(sim, deserialize(readFileSync(checkpoint)) as Checkpoint); console.log('Loaded matching warm-up checkpoint.'); }
  else { console.log('Warming up to 08:00 (outside the measured 30-minute window).'); while (sim.t < start - .01) sim.step(); }
  sim.speed = 1; sim.paused = false; sim.pisStation = station;
  trace = { station: name, start, end, rate: 1, frames: [], arrivals: [], ...(args.includes('--onboard') ? { onboardFrames: [] } : {}) };
  let previous = new Map<number, StationTrain>(), steps = 0;
  let followed = -1;
  while (sim.t < end - .01) {
    sim.step();
    if (++steps % 2) continue;
    const snap = sim.snapshot(), raw = stationFrame(snap, station, sim.topo);
    const frame: StationAudioFrame = { ...raw, muted: false, enabled: true, trains: raw.trains.filter(t => t.nextStation === station || t.atStation) };
    for (const tr of frame.trains) {
      const prev = previous.get(tr.id);
      if (eligible(tr) && tr.atStation && tr.phase === 'dwell' && prev?.phase === 'run') trace.arrivals.push({ key: key(tr), t: sim.trains.get(tr.id)!.arrivedAt, direction: tr.direction });
    }
    previous = new Map(frame.trains.map(t => [t.id, t])); trace.frames.push(frame);
    if (trace.onboardFrames) {
      if (followed < 0) followed = frame.trains.find(t => t.direction === 'DN' && t.atStation && t.phase === 'dwell' && eligible(t))?.id ?? -1;
      const onboard = onboardFrame(snap, snap.trains.find(t => t.id === followed) ?? null, sim.topo, sim.plan);
      trace.onboardFrames.push({ ...onboard, muted: false, enabled: true });
    }
  }
  if (arg('--frames')) save(arg('--frames'), trace);
}
const planner = new StationSoundPlanner();
const played = new Map<string, { t: number; predicted: number }>(), cancelled = new Set<string>();
for (const frame of trace.frames) for (const command of planner.update(frame)) {
  const visits = command.key.split('+').filter(k => k.startsWith('arrive|')).map(k => k.slice(7));
  if (command.kind === 'play' && command.clips[0].kind === 'arrive') for (const visit of visits) {
    const tr = frame.trains.find(t => key(t) === visit)!;
    const prediction = predictStationStop(tr);
    if (prediction !== null) played.set(visit, { t: frame.t, predicted: frame.t + prediction });
  }
  if (command.kind === 'stop' && command.fadeS) for (const visit of visits) {
    const arrival = trace.arrivals.find(a => a.key === visit);
    if (arrival && frame.t < arrival.t) cancelled.add(visit);
  }
}
const quantiles = (errors: number[]) => {
  const sorted = errors.map(Math.abs).sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] * 100) / 100 : null;
  return { n: sorted.length, p50: percentile(.5), p90: percentile(.9), max: percentile(1) };
};
const playbackErrors = trace.arrivals.flatMap(a => played.has(a.key) ? [played.get(a.key)!.predicted - a.t] : []);
const onboardPlanner = new OnboardSoundPlanner(), onboardEvents: { at: number; kind: string; station: string; direction: string }[] = [];
for (const frame of trace.onboardFrames ?? []) for (const command of onboardPlanner.update(frame)) {
  if (command.kind === 'play' && !command.loop) {
    const named = command.clips.find(c => c.kind === 'interior-departure' || c.kind === 'interior-arrival');
    if (named) onboardEvents.push({ at: frame.t, kind: named.kind, station: named.station, direction: named.direction });
  }
}
// A common, retrospectively chosen cue avoids comparing only the tiny subset
// the old gate happened to allow. This diagnostic is separate from playback.
const commonCueErrors: number[] = [];
for (const arrival of trace.arrivals) {
  const anchor = SOUND_BANK.find(c => c.kind === 'arrive' && c.direction === arrival.direction && !c.both)?.stopAt;
  if (anchor === undefined) continue;
  const cue = arrival.t - anchor;
  const frame = trace.frames.find(f => f.t >= cue && f.t < cue + .21);
  const tr = frame?.trains.find(t => key(t) === arrival.key);
  const seconds = tr && predictStationStop(tr);
  if (frame && typeof seconds === 'number') commonCueErrors.push(frame.t + seconds - arrival.t);
}
const result = { label, station: trace.station, rate: trace.rate, simulatedMinutes: (trace.end - trace.start) / 60,
  arrivals: trace.arrivals.length, played: trace.arrivals.filter(a => played.has(a.key)).length,
  interruptedBeforeStop: trace.arrivals.filter(a => cancelled.has(a.key)).length,
  atPlayback: quantiles(playbackErrors), atCommonCue: quantiles(commonCueErrors),
  ...(trace.onboardFrames ? { onboardEvents } : {}),
  visits: trace.arrivals.map(a => ({ ...a, playback: played.get(a.key) ?? null, interrupted: cancelled.has(a.key) })) };
save(arg('--out', `work/recordings/analysis/stationaudio-${label}.json`), result);
console.log(JSON.stringify({ ...result, visits: undefined }, null, 2));
