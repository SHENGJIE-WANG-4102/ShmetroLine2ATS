/** Selected-train announcements and cabin/rolling ambience, separate from VVVF.
 * Original whole PA wins; exact-name, same-speaker compositions are pre-rendered.
 */
import { SOUND_BANK, ONBOARD_ANNOUNCEMENTS, ONBOARD_NEXT_DELAY_S, ONBOARD_ARRIVAL_ADVANCE_S,
  ONBOARD_HOLD_CLIP, ONBOARD_HOLD_DELAY_S, ONBOARD_HOLD_REPEAT_S,
  clipDuration, type SoundClip, type OnboardAnnouncement, type AnnouncementDoorSide } from '../data/soundbank';
import { STATIONS } from '../data/line2';
import { onboardAnnouncement, onboardDoorSide } from '../data/onboardbank';
import { PLT, type Snapshot, type TrainSnap, type Plan } from '../sim/model';
import type { Topology } from '../sim/topology';
import { RecordedSoundPlayer, automatic, audioTrain, stopEstimate, VVVF_MAX_RATE, STATION_ALIGNMENT_S,
  type StationTrain, type StationSoundCommand } from './stationaudio';

export interface OnboardAudioFrame {
  t: number; rate: number; paused: boolean; muted: boolean; enabled: boolean;
  train: StationTrain | null; willStop: boolean; skipConfirmed?:boolean; destination: string; doorSide: AnnouncementDoorSide;
}
export function onboardFrame(snap: Snapshot, heard: TrainSnap | null, topo: Topology, plan: Plan | null): Omit<OnboardAudioFrame, 'muted' | 'enabled'> {
  const intent=heard&&plan?.trips[heard.tripId];
  const train = heard ? audioTrain(heard, heard.nextStation, topo) : null;
  // A crossover's local link orientation does not change the service direction.
  if(train&&intent)train.direction=intent.dir;
  const planned = heard && plan?.trips[heard.tripId]?.stops.find(s => s.st === heard.nextStation);
  const platform = train && topo.stations[train.nextStation]?.platforms[train.direction];
  const skipped = platform !== null && platform !== undefined && !!(snap.platforms[platform] & PLT.SKIP);
  const destination = heard?.dest ?? '';
  const paSide = onboardDoorSide(train?.nextStation ?? -1, train?.direction ?? 'DN', destination);
  return { t: snap.t, rate: snap.speed, paused: snap.paused, train, destination,
    skipConfirmed:planned?.stop===false||skipped||heard?.nextStopSkipped===true,
    doorSide: paSide === 'B' ? 'B' : heard?.platSide || paSide,
    // A distant call can lie beyond the authority scan, with stopDist=-1.
    // The plan/worker intent still identifies it as a call for departure PA.
    willStop: !!train && train.nextStation >= 0 && planned?.stop !== false && !skipped && heard?.nextStopSkipped !== true &&
      (planned?.stop === true || train.distance >= 0 || heard?.task.startsWith('停站 ') === true) };
}
export function onboardSoundEnabled(frame: OnboardAudioFrame): boolean {
  return !!frame.train && frame.enabled && !frame.muted && !frame.paused && frame.rate > 0 && frame.rate <= VVVF_MAX_RATE;
}
/** The car's PA follows position and doors, whoever drives (DTO/AM/CM/RM):
 * only a revenue train in working order announces. An emergency brake starts
 * nothing new but does not cut a phrase already playing. */
const announces = (tr: StationTrain) => tr.inService && !tr.failed;
/** Standing still away from a station stop (signal, EB, failure): D102.
 * A failed revenue train still has its PA, unlike the station calls. */
const held = (tr: StationTrain) => tr.inService && tr.v <= .05 && (tr.phase === 'run' || tr.phase === 'failed');
const visit = (tr: StationTrain) => `${tr.id}|${tr.trip}|${tr.direction}|${tr.nextStation}`;
export function cabinVolumes(v: number): { rolling: number; idle: number } {
  const fraction = Math.min(1, Math.max(0, v) / (80 / 3.6));
  // Loudness differences are baked into assets, not erased by equal gains.
  return { rolling: Math.sqrt(fraction), idle: 1 - .8 * fraction };
}
/** Pure timetable/physics-driven state machine; no PIS mutation or audio IO. */
export class OnboardSoundPlanner {
  private selected = -1;
  private time = NaN;
  private rate = 0;
  private armed = false;
  private origin = -1;
  private nextHold = NaN;
  private departing: { at: number; from: number; trip: string; direction: 'DN' | 'UP' } | null = null;
  private pending: { key: string; at: number; next: OnboardAnnouncement['next']; direction: 'DN' | 'UP' } | null = null;
  private done = new Set<string>();
  private active = new Map<string, { until: number; predicted?: number; target?: string; speech: boolean; hold?: boolean }>();
  constructor(private bank: readonly SoundClip[] = SOUND_BANK,
    private announcements: readonly OnboardAnnouncement[] = ONBOARD_ANNOUNCEMENTS,
    private nextDelayS = ONBOARD_NEXT_DELAY_S, private arrivalAdvanceS = ONBOARD_ARRIVAL_ADVANCE_S) {}
  reset(): StationSoundCommand[] {
    const commands: StationSoundCommand[] = [...this.active.keys()].map(key => ({ kind: 'stop', key }));
    this.active.clear(); this.done.clear(); this.pending = null; this.departing = null;
    this.selected = -1; this.time = NaN; this.rate = 0; this.armed = false; this.origin = -1; this.nextHold = NaN;
    return commands;
  }
  update(frame: OnboardAudioFrame): StationSoundCommand[] {
    if (!onboardSoundEnabled(frame)) return this.reset();
    const tr = frame.train!, commands: StationSoundCommand[] = [];
    if (this.selected !== tr.id || this.rate !== frame.rate || frame.t < this.time || frame.t - this.time > Math.max(STATION_ALIGNMENT_S, frame.rate)) commands.push(...this.reset());
    if (frame.t === this.time) return commands;
    this.selected = tr.id; this.time = frame.t; this.rate = frame.rate;
    // Freeze the chosen recording once it starts. Door-side/terminus metadata
    // can change at a crossover without changing this station call.
    const call = visit(tr);
    const slot = onboardAnnouncement(STATIONS[tr.nextStation]?.name, tr.direction, frame.destination, frame.doorSide, this.announcements);
    const seconds = frame.willStop && announces(tr) ? stopEstimate(tr) : null;
    const predicted = seconds === null ? null : frame.t + seconds;
    for (const [key, sound] of this.active) {
      // (only an ATO approach is predictable enough to fade a drifting phrase)
      const invalid = sound.speech && !sound.hold && (!announces(tr) || frame.skipConfirmed===true || sound.target !== call ||
        (automatic(tr) && sound.predicted !== undefined && tr.phase === 'run' && predicted!==null && Math.abs(predicted - sound.predicted) > STATION_ALIGNMENT_S));
      if (invalid || frame.t >= sound.until) { commands.push(invalid ? { kind: 'stop', key, fadeS: .5 } : { kind: 'stop', key }); this.active.delete(key); }
    }
    const play = (key: string, clips: SoundClip[], offsetS: number, volume: number, loop = false, expected?: number, hold = false) => {
      const length = clips.reduce((sum, c) => sum + clipDuration(c), 0);
      if (offsetS < 0 || offsetS >= length) return;
      commands.push({ kind: 'play', key, clips, offsetS, rate: frame.rate, volume, loop });
      this.active.set(key, { until: loop ? Infinity : frame.t + length - offsetS, predicted: expected, target: call, speech: !loop, hold });
    };
    const levels = cabinVolumes(tr.v);
    for (const kind of ['interior-rolling', 'interior-idle'] as const) {
      const clip = this.bank.find(c => c.kind === kind), key = `cabin|${kind}`;
      if (!clip) continue;
      const volume = kind === 'interior-rolling' ? levels.rolling : levels.idle;
      if (!this.active.has(key)) play(key, [clip], 0, volume, true);
      else commands.push({ kind: 'volume', key, volume });
    }
    // The stop PA is not tied to a call: moving on does not cut it, and it
    // waits for any phrase already playing rather than talking over it.
    if (!held(tr)) this.nextHold = NaN;
    else if (Number.isNaN(this.nextHold)) this.nextHold = frame.t + ONBOARD_HOLD_DELAY_S;
    const hold = this.bank.find(c => c.id === ONBOARD_HOLD_CLIP.id);
    if (hold && frame.t >= this.nextHold && ![...this.active.values()].some(s => s.speech)) {
      play('hold', [hold], 0, 1, false, undefined, true);
      this.nextHold = frame.t + ONBOARD_HOLD_REPEAT_S;
    }
    if (!announces(tr)) { this.pending = null; this.departing = null; this.armed = false; }
    if (announces(tr) && tr.phase === 'dwell' && tr.v <= .05) { this.armed = true; this.origin = tr.nextStation; }
    if (this.armed && announces(tr) && tr.phase === 'run' && tr.v > .001 && !tr.doors) {
      this.armed = false;
      // The worker retains the departing stop until its first movement has
      // cleared it. Capture the real onset, then wait for the new nextStation.
      this.departing = { at: frame.t, from: this.origin, trip: tr.trip, direction: tr.direction };
    }
    if (this.departing) {
      const departure = this.departing;
      if (departure.trip !== tr.trip || departure.direction !== tr.direction || frame.t - departure.at > this.nextDelayS + STATION_ALIGNMENT_S) this.departing = null;
      else if (tr.nextStation !== departure.from && frame.willStop) {
        this.departing = null;
        if (slot?.next && Number.isFinite(this.nextDelayS)) this.pending = { key: `next|${call}`, at: departure.at + this.nextDelayS, next: slot.next, direction: tr.direction };
      }
    }
    if (this.pending && (!frame.willStop || this.pending.direction !== tr.direction || this.pending.key !== `next|${call}`)) this.pending = null;
    if (this.pending && frame.t >= this.pending.at && announces(tr) && !tr.eb) {
      const pending = this.pending; this.pending = null;
      const offset = Math.max(0, frame.t - pending.at);
      const clip = this.bank.find(c => c.id === pending.next?.clipId && c.station === STATIONS[tr.nextStation]?.name && c.direction === tr.direction);
      if (offset <= STATION_ALIGNMENT_S && clip && !this.done.has(pending.key)) {
        this.done.add(pending.key); play(pending.key, [clip], offset, 1);
      }
    }
    if (slot?.arrived && predicted !== null && announces(tr) && !tr.eb && frame.willStop && tr.phase === 'run') {
      const arrival = slot.arrived;
      const advance = arrival.measuredAdvance ? arrival.advanceS : this.arrivalAdvanceS;
      const offset = Math.abs(frame.t - (predicted - advance)) < 1e-6 ? 0 : frame.t - (predicted - advance);
      const key = `arrived|${call}`;
      if (Number.isFinite(advance) && offset >= 0 && offset <= STATION_ALIGNMENT_S && !this.done.has(key)) {
        const clip = this.bank.find(c => c.id === arrival.clipId && c.station === STATIONS[tr.nextStation]?.name && c.direction === tr.direction && c.kind === 'interior-arrival');
        if (clip) { this.done.add(key); play(key, [clip], offset, 1, false, predicted); }
      } else if (offset > STATION_ALIGNMENT_S) this.done.add(key);
    }
    return commands;
  }
}

export class OnboardAudio extends RecordedSoundPlayer {
  private planner: OnboardSoundPlanner;
  private bank: readonly SoundClip[];
  private context = '';
  private time = NaN;
  constructor(ctx: AudioContext, dest: AudioNode, bank: readonly SoundClip[] = SOUND_BANK) {
    const interior = bank.filter(c => c.kind.startsWith('interior-'));
    // Whole PA variants are large: only decode this call and the two loops,
    // rather than hundreds of unused journey/terminus combinations on unlock.
    super(ctx, dest, interior, false); this.bank = interior; this.planner = new OnboardSoundPlanner(interior);
  }
  override reset() { this.planner.reset(); super.reset(); this.context = ''; this.time = NaN; }
  update(frame: OnboardAudioFrame) {
    if (this.ctx.state !== 'running' || !onboardSoundEnabled(frame)) { this.reset(); return; }
    const context = `${frame.train!.id}|${frame.rate}`;
    if (this.context !== context || frame.t < this.time) this.reset();
    const slot = onboardAnnouncement(STATIONS[frame.train!.nextStation]?.name, frame.train!.direction, frame.destination, frame.doorSide);
    this.preload(this.bank.filter(c => c.id === slot?.next?.clipId || c.id === slot?.arrived?.clipId || c.id === ONBOARD_HOLD_CLIP.id || c.kind === 'interior-rolling' || c.kind === 'interior-idle'));
    this.context = context; this.time = frame.t; this.apply(this.planner.update(frame));
  }
}
