/** Recorded platform sound. Scheduling is pure; missing assets remain silent.
 * 【假设】 Jiangsu Road platform assets are reused at every underground station.
 * Anchor uncertainty is a fixed offset, separate from the 3 s drift budget.
 * A kinematic estimate cannot guarantee accuracy under a later signal change:
 * unstable predictions cancel the clip and are never restarted for that visit.
 */
import { SOUND_BANK, SOUNDBANK_DIRECTORY, clipDuration, type SoundClip, type SoundKind } from '../data/audio/soundbank';
import { STATIONS, EXPOSED, stationChainages } from '../data/current';
import { PERF } from '../sim/dynamics';
import type { PisData, Snapshot, TrainSnap } from '../sim/model';
import type { Topology } from '../sim/topology';

export const VVVF_MAX_RATE = 5;
export const STATION_ALIGNMENT_S = 3;
type Direction = 'DN' | 'UP';
export interface StationTrain {
  id: number; trip: string; direction: Direction; mode: TrainSnap['mode'];
  manual: boolean; rm: boolean; failed: boolean; eb: boolean; inService: boolean;
  phase: TrainSnap['phase']; v: number; a: number; distance: number;
  nextStation: number; atStation: boolean; doors: boolean; doorClosing: boolean; dwellLeft: number;
}
export interface StationAudioFrame {
  station: number | null; name: string; t: number; rate: number; paused: boolean;
  muted: boolean; enabled: boolean; trains: readonly StationTrain[]; pis: PisData | null;
}
export type StationSoundCommand =
  | { kind: 'stop'; key: string; fadeS?: number }
  | { kind: 'volume'; key: string; volume: number }
  | { kind: 'play'; key: string; clips: readonly SoundClip[]; offsetS: number; rate: number; loop: boolean; volume: number };

export function isUndergroundStation(station: number): boolean {
  const chain = stationChainages()[station];
  return Number.isFinite(chain) && !EXPOSED.some(e => chain >= e.from && chain <= e.to);
}

export function stationFrame(snap: Snapshot, station: number | null, topo: Topology): Omit<StationAudioFrame, 'muted' | 'enabled'> {
  return { station, name: STATIONS[station ?? -1]?.name ?? '', t: snap.t, rate: snap.speed, paused: snap.paused, pis: snap.pis,
    trains: snap.trains.map(tr => audioTrain(tr, station, topo)) };
}
export function audioTrain(tr: TrainSnap, station: number | null, topo: Topology): StationTrain {
  const link = topo.links[tr.link], platform = topo.platforms[link?.platform ?? -1];
  const direction = platform?.track ?? (link?.track === 'UP' || link?.track === 'DN' ? link.track : tr.dir === 1 ? 'DN' : 'UP');
  return { id: tr.id, trip: tr.trip, direction, mode: tr.mode, manual: tr.manual, rm: tr.rm, failed: tr.failed,
    eb: tr.eb, inService: tr.inService, phase: tr.phase, v: tr.v, a: tr.a, distance: tr.stopDist,
    nextStation: tr.nextStation, atStation: station !== null && platform?.station === station,
    doors: tr.doors, doorClosing: tr.doorClosing, dwellLeft: tr.dwellLeft };
}
export function stationSoundEnabled(frame: StationAudioFrame): boolean {
  return frame.station !== null && isUndergroundStation(frame.station) && frame.enabled && !frame.muted && !frame.paused && frame.rate > 0 && frame.rate <= VVVF_MAX_RATE;
}
export function automatic(tr: StationTrain): boolean {
  return (tr.mode === 'DTO' || tr.mode === 'AM') && !tr.manual && !tr.rm && !tr.failed && !tr.eb && tr.inService;
}
/** Coast to the ATO planning curve, then stop. 【假设】 jerk buildup adds
 * (a+b)^2/(2*b*j) seconds relative to immediately applying the planning brake.
 * The empirical probe decides whether this UI approximation is sufficient.
 */
export function predictStationStop(tr: StationTrain): number | null {
  return automatic(tr) ? stopEstimate(tr) : null;
}
/** The same estimate for any driving mode: under manual driving it places a
 * position-triggered announcement where an ATO train would start it. */
export function stopEstimate(tr: StationTrain): number | null {
  if (tr.phase !== 'run' || !Number.isFinite(tr.v) || !Number.isFinite(tr.a) || tr.v <= .2 || !Number.isFinite(tr.distance) || tr.distance <= 0) return null;
  const b = PERF.bPlan;
  const brakeDistance = tr.v * tr.v / (2 * b);
  if (brakeDistance > tr.distance + tr.v * STATION_ALIGNMENT_S) return null;
  const jerkCorrection = Math.pow(Math.max(0, tr.a + b), 2) / (2 * b * PERF.jerk);
  return Math.max(0, tr.distance - brakeDistance) / tr.v + tr.v / b + jerkCorrection;
}
function usable(clip: SoundClip, kind: SoundKind, direction: Direction): boolean {
  return clip.kind === kind && clip.confidence !== 'low' && !clip.both &&
    (clip.direction === direction || clip.direction === 'shared');
}
/** Never substitute another destination, or an onboard voice, for a platform name. */
export function platformAnnouncement(bank: readonly SoundClip[], station: string, _direction: Direction, destination: string): SoundClip[] {
  if (!isUndergroundStation(STATIONS.findIndex(s => s.name === station))) return [];
  const prefix = bank.find(c => c.kind === 'prefix' && c.confidence !== 'low' && !c.both);
  const name = bank.find(c => c.kind === 'station-name' && c.confidence !== 'low' && !c.both && c.name === destination);
  const suffix = bank.find(c => c.kind === 'suffix' && c.confidence !== 'low' && !c.both);
  return prefix && name && suffix && prefix.advanceS !== undefined ? [prefix, name, suffix] : [];
}
/** A mixed recording is usable only when both sides' anchors fit the prediction. */
export function compatibleBoth(clip: SoundClip, times: Partial<Record<Direction, number>>): boolean {
  const anchor = clip.kind === 'arrive' ? clip.stopAt : clip.startAt;
  if (!clip.both || anchor === undefined || clip.otherAt === undefined || (clip.direction !== 'DN' && clip.direction !== 'UP')) return false;
  const other = clip.direction === 'DN' ? 'UP' : 'DN';
  const a = times[clip.direction], b = times[other];
  return a !== undefined && b !== undefined && Math.abs((b - a) - (clip.otherAt - anchor)) <= STATION_ALIGNMENT_S;
}

interface Forecast { tr: StationTrain; at: number; stable: number; drift: number }
interface ActiveSound { until: number; tolerance: number; arrivals?: Map<number, number>; departures?: Map<number, number>; embeddedDestination?: string }
const visit = (tr: StationTrain) => `${tr.direction}|${tr.id}|${tr.trip}`;
const elapsedSince = (now: number, at: number) => Math.abs(now - at) < 1e-6 ? 0 : now - at;

/** Pure event/state machine: only frame values and metadata determine commands. */
export class StationSoundPlanner {
  private station: number | null = null;
  private time = NaN;
  private rate = 0;
  private previous = new Map<number, StationTrain>();
  private forecasts = new Map<number, Forecast>();
  private done = new Set<string>();
  private waitingDepartures = new Set<string>();
  private active = new Map<string, ActiveSound>();
  constructor(private bank: readonly SoundClip[] = SOUND_BANK) {}

  reset(): StationSoundCommand[] {
    const commands: StationSoundCommand[] = [...this.active.keys()].map(key => ({ kind: 'stop', key }));
    this.active.clear(); this.previous.clear(); this.forecasts.clear(); this.done.clear(); this.waitingDepartures.clear();
    this.station = null; this.time = NaN; this.rate = 0;
    return commands;
  }

  update(frame: StationAudioFrame): StationSoundCommand[] {
    if (!stationSoundEnabled(frame)) return this.reset();
    const commands: StationSoundCommand[] = [];
    if (this.station !== frame.station || this.rate !== frame.rate || frame.t < this.time || frame.t - this.time > Math.max(STATION_ALIGNMENT_S, frame.rate)) commands.push(...this.reset());
    if (frame.t === this.time) return commands;
    const frameGap = frame.t - this.time;
    this.station = frame.station; this.rate = frame.rate; this.time = frame.t;
    const first = frame.pis?.station === frame.station ? frame.pis : null;
    const upcoming: Partial<Record<Direction, Forecast>> = {};
    const forecasts = new Map<number, Forecast>();
    for (const direction of ['DN', 'UP'] as const) {
      const row = first?.[direction][0];
      if (!row || first?.skip?.[direction] || row.status === 'at' || row.status === 'departing') continue;
      const tr = frame.trains.find(t => t.direction === direction && t.trip === row.trip && t.nextStation === frame.station && automatic(t));
      if (!tr) continue;
      const seconds = predictStationStop(tr);
      if (seconds === null) continue;
      const at = frame.t + seconds, prev = this.forecasts.get(tr.id);
      const drift = prev?.tr.trip === tr.trip ? Math.abs(at - prev.at) : Infinity;
      const forecast = { tr, at, drift, stable: drift <= STATION_ALIGNMENT_S ? (prev?.stable ?? 0) + 1 : 1 };
      upcoming[direction] = forecast; forecasts.set(tr.id, forecast);
    }
    this.forecasts = forecasts;
    // Expire finished voices, or cancel a movement whose predicted alignment changed.
    for (const [key, sound] of this.active) {
      let bad = false;
      for (const [id, expected] of sound.arrivals ?? []) {
        const tr = frame.trains.find(t => t.id === id);
        const prediction = forecasts.get(id);
        if (!tr || !automatic(tr) || (tr.phase === 'run' && (!prediction || Math.abs(prediction.at - expected) > sound.tolerance)) ||
          (tr.phase === 'dwell' && Math.abs(frame.t - expected) > STATION_ALIGNMENT_S && this.previous.get(id)?.phase !== 'dwell')) bad = true;
      }
      for (const [id, expected] of sound.departures ?? []) {
        const tr = frame.trains.find(t => t.id === id);
        if (!tr || !automatic(tr) || (frame.t > expected + STATION_ALIGNMENT_S && tr.v <= .05)) bad = true;
      }
      if (bad || frame.t >= sound.until) { commands.push(bad ? { kind: 'stop', key, fadeS: .5 } : { kind: 'stop', key }); this.active.delete(key); }
    }
    const emit = (key: string, clips: readonly SoundClip[], offsetS: number, arrivals?: Map<number, number>, departures?: Map<number, number>) => {
      const loop = clips[0].kind === 'ambience';
      if (offsetS < 0 || offsetS >= clips.reduce((sum, c) => sum + clipDuration(c), 0)) return;
      commands.push({ kind: 'play', key, clips, offsetS, rate: frame.rate, loop, volume: loop ? .12 : .7 });
      this.active.set(key, { until: loop ? Infinity : frame.t + clips.reduce((sum, c) => sum + clipDuration(c), 0) - offsetS,
        tolerance: STATION_ALIGNMENT_S, arrivals, departures, embeddedDestination: clips[0].embeddedDestination });
    };
    const ambience = this.bank.find(c => c.kind === 'ambience' && c.confidence !== 'low');
    if (ambience && !this.active.has('ambience')) emit('ambience', [ambience], 0);

    const both = this.bank.find(c => c.kind === 'arrive' && c.confidence !== 'low' &&
      compatibleBoth(c, { DN: upcoming.DN?.at, UP: upcoming.UP?.at }));
    if (both && upcoming.DN && upcoming.UP && upcoming.DN.stable >= 2 && upcoming.UP.stable >= 2 &&
      (!both.embeddedDestination || both.embeddedDestination === (STATIONS[first![both.direction as Direction][0].destSt]?.name ?? first![both.direction as Direction][0].dest))) {
      const primary = upcoming[both.direction as Direction]!;
      const secondary = upcoming[both.direction === 'DN' ? 'UP' : 'DN']!;
      const offset = elapsedSince(frame.t, primary.at - both.stopAt!);
      const pairError = Math.abs((secondary.at - primary.at) - (both.otherAt! - both.stopAt!));
      const keys = [upcoming.DN, upcoming.UP].map(f => `arrive|${visit(f.tr)}`);
      if (offset >= 0 && offset <= STATION_ALIGNMENT_S && pairError <= STATION_ALIGNMENT_S && keys.every(k => !this.done.has(k))) {
        keys.forEach(k => this.done.add(k));
        emit(keys.join('+'), [both], offset, new Map([[upcoming.DN.tr.id, upcoming.DN.at], [upcoming.UP.tr.id, upcoming.UP.at]]));
      }
    }
    for (const direction of ['DN', 'UP'] as const) {
      const f = upcoming[direction];
      if (!f || f.stable < 2) continue;
      const row = first![direction][0];
      const destination = STATIONS[row.destSt]?.name ?? row.dest;
      const arrival = this.bank.find(c => usable(c, 'arrive', direction) && c.stopAt !== undefined && (!c.embeddedDestination || c.embeddedDestination === destination));
      const arrivalKey = `arrive|${visit(f.tr)}`;
      if (arrival && !this.done.has(arrivalKey)) {
        const offset = elapsedSince(frame.t, f.at - arrival.stopAt!);
        if (offset >= 0) {
          this.done.add(arrivalKey);
          if (offset <= STATION_ALIGNMENT_S) emit(arrivalKey, [arrival], offset, new Map([[f.tr.id, f.at]]));
        }
      }
      const announcement = platformAnnouncement(this.bank, frame.name, direction, destination);
      const announceKey = `announce|${visit(f.tr)}`;
      if (announcement.length && !this.done.has(announceKey)) {
        const offset = elapsedSince(frame.t, f.at - announcement[0].advanceS!);
        if (offset >= 0) {
          this.done.add(announceKey);
          const embedded = [...this.active.values()].some(sound => sound.embeddedDestination === destination && sound.arrivals?.has(f.tr.id));
          if (!embedded && offset <= STATION_ALIGNMENT_S) emit(announceKey, announcement, offset, new Map([[f.tr.id, f.at]]));
        }
      }
    }
    for (const tr of frame.trains) {
      if (automatic(tr) && tr.atStation && tr.phase === 'dwell' && tr.v <= .05) this.waitingDepartures.add(visit(tr));
      if (!automatic(tr) || (tr.phase !== 'run' && tr.phase !== 'dwell')) this.waitingDepartures.delete(visit(tr));
      const prev = this.previous.get(tr.id);
      if (!prev || prev.trip !== tr.trip || prev.direction !== tr.direction || !automatic(tr) || !automatic(prev) || !prev.atStation) continue;
      if (!prev.doorClosing && tr.doorClosing && tr.atStation) {
        const key = `close|${visit(tr)}|${frame.t}`, clip = this.bank.find(c => usable(c, 'close', tr.direction));
        if (clip) emit(key, [clip], 0);
      }
      // The phase may change to run several frames before the first positive
      // speed under jerk limiting. Keep the observed dwell armed until then.
      if (this.waitingDepartures.has(visit(tr)) && tr.v > .001 && !tr.doors && !tr.doorClosing && tr.phase === 'run') {
        this.waitingDepartures.delete(visit(tr));
        const key = `depart|${visit(tr)}`;
        if (this.done.has(key)) continue;
        this.done.add(key);
        const mixed = this.bank.find(c => c.kind === 'depart' && c.direction === tr.direction && c.both && c.confidence !== 'low' && c.otherAt !== undefined);
        const other = frame.trains.find(t => t.direction !== tr.direction && t.atStation && !t.doors && t.phase === 'dwell' && automatic(t));
        const times = { [tr.direction]: frame.t, ...(other ? { [other.direction]: frame.t + other.dwellLeft } : {}) };
        const otherKey = other ? `depart|${visit(other)}` : '';
        if (mixed && other && !this.done.has(otherKey) && compatibleBoth(mixed, times) && frameGap <= STATION_ALIGNMENT_S) {
          this.done.add(otherKey);
          emit(`${key}+${otherKey}`, [mixed], mixed.startAt!, undefined, new Map([[tr.id, frame.t], [other.id, frame.t + other.dwellLeft]]));
        } else {
          const clip = this.bank.find(c => usable(c, 'depart', tr.direction) && c.startAt !== undefined);
          // The observed transition is the start anchor: skip the pre-start lead-in.
          if (clip && frameGap <= STATION_ALIGNMENT_S) emit(key, [clip], clip.startAt!, undefined, new Map([[tr.id, frame.t]]));
        }
      }
    }
    this.previous = new Map(frame.trains.map(tr => [tr.id, tr]));
    return commands;
  }
}

interface RecordedVoice { source: AudioBufferSourceNode; gain: GainNode; volume: number }
/** Shared Web Audio adapter: no timers, no late playback after asset loading. */
export class RecordedSoundPlayer {
  private volumeScale = 1;
  private buffers = new Map<string, AudioBuffer>();
  private voices = new Map<string, RecordedVoice[]>();
  private fading = new Set<RecordedVoice>();
  private waitingLoops = new Map<string, Extract<StationSoundCommand, { kind: 'play' }>>();
  private requested = new Set<string>();
  constructor(protected ctx: AudioContext, private dest: AudioNode, bank: readonly SoundClip[], eager = true) {
    if (eager) this.preload(bank);
  }
  protected preload(bank: readonly SoundClip[]) {
    for (const clip of bank) {
      if (this.requested.has(clip.id)) continue;
      this.requested.add(clip.id);
      fetch(`${import.meta.env.BASE_URL}${SOUNDBANK_DIRECTORY}/${clip.file}`)
        .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))
        .then(b => this.ctx.decodeAudioData(b)).then(b => this.buffers.set(clip.id, b)).catch(() => { /* no local recording: silent */ });
    }
  }
  /** Asset readiness only; door warnings can fall back without replaying late. */
  protected hasClip(id: string): boolean { return this.buffers.has(id); }
  reset() {
    this.waitingLoops.clear();
    for (const key of [...this.voices.keys()]) this.stop(key);
    // Pause/mute/selection also cancel voices already fading out.
    for (const voice of [...this.fading]) this.release(voice, true);
  }
  setVolume(scale: number) {
    this.volumeScale = Math.max(0, scale);
    for (const voices of this.voices.values()) for (const voice of voices)
      voice.gain.gain.setTargetAtTime(voice.volume * this.volumeScale, this.ctx.currentTime, .12);
  }
  private release(voice: RecordedVoice, stop = false) {
    if (stop) { voice.source.onended = null; try { voice.source.stop(); } catch { /* ended */ } }
    voice.source.disconnect(); voice.gain.disconnect(); this.fading.delete(voice);
  }
  private stop(key: string, fadeS = 0) {
    this.waitingLoops.delete(key);
    const sources = this.voices.get(key);
    this.voices.delete(key);
    for (const voice of sources ?? []) {
      if (fadeS > 0) {
        const now = this.ctx.currentTime;
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
        voice.gain.gain.linearRampToValueAtTime(0, now + fadeS);
        this.fading.add(voice);
        try { voice.source.stop(now + fadeS); } catch { this.release(voice); }
      } else this.release(voice, true);
    }
  }
  apply(commands: readonly StationSoundCommand[]) {
    for (const command of commands) {
      if (command.kind === 'stop') { this.stop(command.key, command.fadeS); continue; }
      if (command.kind === 'volume') {
        const pending = this.waitingLoops.get(command.key);
        if (pending) pending.volume = command.volume;
        for (const voice of this.voices.get(command.key) ?? []) {
          voice.volume = command.volume;
          voice.gain.gain.setTargetAtTime(command.volume * this.volumeScale, this.ctx.currentTime, .12);
        }
        continue;
      }
      if (command.clips.some(c => !this.buffers.has(c.id))) {
        this.preload(command.clips);
        // A continuing ambience may start once loaded; never catch up an old
        // movement or sentence asynchronously. The current frame flushes loops.
        if (command.loop) this.waitingLoops.set(command.key, { ...command });
        continue;
      }
      this.stop(command.key);
      const sources: RecordedVoice[] = [];
      this.voices.set(command.key, sources);
      let offset = command.offsetS, when = this.ctx.currentTime;
      for (const clip of command.clips) {
        const buffer = this.buffers.get(clip.id)!;
        if (offset >= buffer.duration) { offset -= buffer.duration; continue; }
        const source = this.ctx.createBufferSource(), gain = this.ctx.createGain();
        source.buffer = buffer; source.loop = command.loop;
        if (command.loop) { source.loopStart = 0; source.loopEnd = Math.min(buffer.duration, clipDuration(clip)); }
        source.playbackRate.value = command.rate; gain.gain.value = command.volume * this.volumeScale;
        source.connect(gain).connect(this.dest);
        const voice = { source, gain, volume: command.volume }; sources.push(voice);
        source.onended = () => { this.release(voice); const at = sources.indexOf(voice); if (at >= 0) sources.splice(at, 1); if (!sources.length && this.voices.get(command.key) === sources) this.voices.delete(command.key); };
        source.start(when, offset);
        when += (buffer.duration - offset) / command.rate; offset = 0;
      }
    }
    const ready = [...this.waitingLoops.values()].filter(command => command.clips.every(c => this.buffers.has(c.id)));
    if (ready.length) {
      ready.forEach(command => this.waitingLoops.delete(command.key));
      this.apply(ready);
    }
  }
}

export class StationAudio extends RecordedSoundPlayer {
  private planner: StationSoundPlanner;
  private context = '';
  private time = NaN;
  constructor(ctx: AudioContext, dest: AudioNode, bank: readonly SoundClip[] = SOUND_BANK) {
    const platform = bank.filter(c => !c.kind.startsWith('interior-') && !c.kind.startsWith('door-'));
    super(ctx, dest, platform); this.planner = new StationSoundPlanner(platform);
  }
  override reset() { this.planner.reset(); super.reset(); this.context = ''; this.time = NaN; }
  update(frame: StationAudioFrame) {
    if (this.ctx.state !== 'running' || !stationSoundEnabled(frame)) { this.reset(); return; }
    const context = `${frame.station}|${frame.rate}`;
    if (this.context !== context || frame.t < this.time) this.reset();
    this.context = context; this.time = frame.t;
    this.apply(this.planner.update(frame));
  }
}
