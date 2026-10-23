/** Local-only 02A05 inverter takes, read by measured stator frequency. */
import { VVVF_HZ_PER_MS, VVVF_TAKES, type VvvfClip, type VvvfTake } from '../data/audio/vvvf';
import { fleetEntry } from '../data/current';
import type { TrainSnap } from '../sim/model';

export type VvvfMode = 'power' | 'brake' | 'cruise' | 'off';
type Clip = 'power' | 'brake';
export interface VvvfIdentity { vehicle: string; runStartedAt: number; t: number }
const GRAIN = .12, HOP = GRAIN / 2, LOOKAHEAD = .12, JITTER = .025, IDLE = .8;
// D71: full-power grains retain about 9 dB below the cabin PA.
const VOLUME = .45, CRUISE_HIGH = 64, CRUISE_LOW = 54, BRAKE_TAIL = 8;

function hash(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h >>> 0;
}

function identityKey(identity: VvvfIdentity): string {
  // carryWorld subtracts a day from both run start and sim time; keep the same take.
  const dayMs = 86400000, start = ((Math.round(identity.runStartedAt * 1000) % dayMs) + dayMs) % dayMs;
  return `${identity.vehicle}|${start}`;
}

/** Same train/start and available files always choose the same take, including after a seek. */
export function chooseVvvfTake(identity: VvvfIdentity, clip: Clip, takes: readonly VvvfTake[] = VVVF_TAKES): VvvfTake | undefined {
  const available = takes.filter(t => t.vehicleType === fleetEntry(identity.vehicle)?.type);
  return available[hash(`${identityKey(identity)}|${clip}`) % available.length];
}

/** Snapshot acceleration is motor effort: safety braking wins over planned phase. */
export function inverterMode(train: Pick<TrainSnap, 'vehicle' | 'v' | 'a' | 'manual' | 'atoPhase' | 'eb' | 'failed' | 'phase'>): VvvfMode {
  if (!VVVF_TAKES.some(take => take.vehicleType === fleetEntry(train.vehicle)?.type)
    || train.eb || train.failed || train.phase !== 'run' || train.v <= 0) return 'off';
  if (train.a < -.05) return 'brake';
  if (train.manual) return train.a > .03 ? 'power' : 'off';
  if (train.atoPhase === 'hold') return 'cruise';
  if (train.a > .03 || train.atoPhase === 'traction') return 'power';
  return 'off';
}

/** Time at f1; a steady endpoint instead uses synchronous resampling. */
export function vvvfTimeAt(table: [number, number][], f: number): number {
  const rising = table[table.length - 1][1] > table[0][1];
  if (f >= (rising ? table[table.length - 1][1] : table[0][1])) return NaN;
  if (f <= 0) return rising ? table[0][0] : table[table.length - 1][0];
  for (let i = 1; i < table.length; i++) {
    const [t0, f0] = table[i - 1], [t1, f1] = table[i];
    if ((f - f0) * (f - f1) <= 0 && f0 !== f1) return t0 + (t1 - t0) * (f - f0) / (f1 - f0);
  }
  return NaN;
}

interface Grain { clip: VvvfClip; pos: number; rate: number }

export class VvvfSound {
  private buf = new Map<string, AudioBuffer>();
  private ready = false;
  private out: GainNode;
  private timer = 0;
  private next = 0;
  private lastOn = 0;
  private voice: Exclude<VvvfMode, 'off'> = 'power';
  private f = 0;
  private volumeScale = 1;
  private identity: VvvfIdentity = { vehicle: '', runStartedAt: 0, t: 0 };
  private power?: VvvfTake;
  private brake?: VvvfTake;
  private grainNo = 0;
  private seed = '';

  constructor(private ctx: AudioContext, dest: AudioNode) {
    this.out = ctx.createGain(); this.out.gain.value = 0; this.out.connect(dest);
    const base = import.meta.env.BASE_URL;
    const files = [...new Set(VVVF_TAKES.flatMap(t => [t.power.file, t.brake.file]))];
    void Promise.all(files.map(file => fetch(`${base}sounds/vvvf/${file}.mp3`)
      .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))
      .then(b => ctx.decodeAudioData(b)).then(a => { this.buf.set(file, a); })
      .catch(() => { /* missing local-only recording: silent */ })))
      .then(() => { this.ready = true; });
  }

  setVolume(gain: number) { this.volumeScale = Math.max(0, gain); }

  set(mode: VvvfMode, v: number, level: number, identity: VvvfIdentity) {
    const now = this.ctx.currentTime;
    this.identity = identity;
    this.power = chooseVvvfTake(identity, 'power', VVVF_TAKES.filter(t => this.buf.has(t.power.file)));
    this.brake = chooseVvvfTake(identity, 'brake', VVVF_TAKES.filter(t => this.buf.has(t.brake.file)));
    const enabled = this.ready && (mode === 'brake' ? this.brake : this.power);
    let target = mode === 'off' || !enabled ? 0 : VOLUME * this.volumeScale * (.35 + .65 * Math.min(1, Math.max(0, level)));
    const f = v * VVVF_HZ_PER_MS;
    if (mode === 'brake' && f < BRAKE_TAIL) target *= 2 - f / BRAKE_TAIL;
    this.out.gain.setTargetAtTime(target, now, .12);
    if (mode === 'off' || !enabled) return;
    const seed = `${identityKey(identity)}|${mode}`;
    if (seed !== this.seed) { this.seed = seed; this.grainNo = 0; }
    this.voice = mode; this.f = f; this.lastOn = now;
    if (!this.timer) { this.next = now + .02; this.timer = window.setInterval(() => this.pump(), 30); }
  }

  private plateau(clip: VvvfClip, n: number): Grain {
    const [begin, end, frequency] = clip.plateau;
    const span = Math.min(end, this.buf.get(clip.file)!.duration) - begin;
    const u = ((this.identity.t - this.identity.runStartedAt + n * HOP) % (2 * span) + 2 * span) % (2 * span);
    return { clip, pos: begin + (u < span ? u : 2 * span - u), rate: Math.max(.3, this.f / frequency) };
  }

  private grain(n: number): Grain {
    const f = this.f, power = this.power?.power, brake = this.brake?.brake;
    if (this.voice === 'cruise' && brake && hash(`${this.seed}|blend|${n}`) / 4294967296 < (f - CRUISE_LOW) / (CRUISE_HIGH - CRUISE_LOW)) return this.plateau(brake, n);
    const clip = (this.voice === 'brake' ? brake : power)!;
    const t = vvvfTimeAt(clip.table, f);
    return Number.isNaN(t) ? this.plateau(clip, n) : { clip, pos: t, rate: 1 };
  }

  private pump() {
    const ctx = this.ctx;
    if (ctx.currentTime - this.lastOn > IDLE) { clearInterval(this.timer); this.timer = 0; return; }
    if (this.voice === 'brake' ? !this.brake : !this.power) return;
    if (this.next < ctx.currentTime) this.next = ctx.currentTime;
    while (this.next < ctx.currentTime + LOOKAHEAD) {
      const at = this.next, n = this.grainNo++, gr = this.grain(n), buf = this.buf.get(gr.clip.file)!;
      const len = GRAIN * gr.rate, jitter = (hash(`${this.seed}|jitter|${n}`) / 4294967296 * 2 - 1) * JITTER;
      const pos = Math.min(buf.duration - len, Math.max(0, gr.pos - len / 2 + jitter));
      const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = gr.rate;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(1, at + GRAIN / 2); g.gain.linearRampToValueAtTime(0, at + GRAIN);
      src.connect(g).connect(this.out); src.start(at, pos); src.stop(at + GRAIN); this.next += HOP;
    }
  }
}
