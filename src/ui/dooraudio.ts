/** D71: physical door sounds use independent warning / mechanism clocks.
 * The worker publishes the close sequence independently of lock confirmation.
 * Use its onset for the warning and the recorded 2.7 s lead for mechanism
 * audio; do not alter the simulation's door deadlines.
 */
import { SOUND_BANK, clipDuration, type SoundClip, type SoundKind } from '../data/soundbank';
import { DOOR_REFERENCE_TIMING, DOOR_TAKES } from '../data/doorbank';
import { DOOR_CLOSE_S } from '../sim/calibration';
import { RecordedSoundPlayer, VVVF_MAX_RATE, isUndergroundStation, type StationTrain, type StationSoundCommand } from './stationaudio';

export interface DoorAudioFrame {
  t: number; rate: number; paused: boolean; enabled: boolean; muted: boolean;
  selectionKey: string; perspective: 'onboard' | 'platform'; station: number | null;
  trains: readonly StationTrain[];
}
export function doorCycleSplit(cycle = DOOR_REFERENCE_TIMING.openingS + DOOR_CLOSE_S) {
  const opening = Math.min(DOOR_REFERENCE_TIMING.openingS, cycle);
  const closing = Math.max(0, cycle - opening);
  const warning = Math.min(DOOR_REFERENCE_TIMING.warningToMotionS, closing);
  const motion = Math.min(DOOR_REFERENCE_TIMING.motionToLockedS, closing - warning);
  return { opening, warning, motion, confirmation: Math.max(0, closing - warning - motion) };
}
const keyOf = (tr: StationTrain) => `${tr.id}|${tr.trip}`;
export interface DoorEvent { kind: 'open' | 'close'; key: string; at: number }
export class DoorSoundPlanner {
  private context = '';
  private time = NaN;
  private previous = new Map<string, StationTrain>();
  private pending = new Map<string, { at: number; clip: SoundClip; key: string }>();
  private active = new Map<string, { train: string; closing: boolean; until: number }>();
  constructor(private bank: readonly SoundClip[] = SOUND_BANK) {}
  reset(): StationSoundCommand[] {
    const commands: StationSoundCommand[] = [...this.active.keys()].map(key => ({ kind: 'stop', key }));
    this.active.clear(); this.pending.clear(); this.previous.clear(); this.context = ''; this.time = NaN;
    return commands;
  }
  update(f: DoorAudioFrame): { commands: StationSoundCommand[]; events: DoorEvent[] } {
    const events: DoorEvent[] = [];
    if (!f.enabled || f.muted || f.paused || !f.selectionKey || f.rate <= 0 || f.rate > VVVF_MAX_RATE ||
      f.perspective === 'platform' && (f.station === null || !isUndergroundStation(f.station))) return { commands: this.reset(), events };
    const context = `${f.perspective}|${f.selectionKey}|${f.rate}`;
    const commands: StationSoundCommand[] = [];
    if (context !== this.context || f.t < this.time || f.t - this.time > Math.max(3, f.rate)) commands.push(...this.reset());
    if (f.t === this.time) return { commands, events };
    this.context = context; this.time = f.t;
    const current = new Map(f.trains.map(tr => [keyOf(tr), tr]));
    const play = (key: string, clip: SoundClip, offset: number, tr: StationTrain, closing: boolean) => {
      if (offset >= clipDuration(clip)) return;
      commands.push({ kind: 'play', key, clips: [clip], offsetS: offset, rate: f.rate, loop: false, volume: f.perspective === 'onboard' ? 1 : .7 });
      this.active.set(key, { train: keyOf(tr), closing, until: f.t + clipDuration(clip) - offset });
    };
    for (const [key, sound] of this.active) {
      const tr = current.get(sound.train);
      if (!tr || !tr.atStation || tr.v > .05 || (sound.closing ? !tr.doorClosing : tr.doorClosing || !tr.doors) || f.t >= sound.until) {
        commands.push({ kind: 'stop', key }); this.active.delete(key);
      }
    }
    for (const [key, pending] of this.pending) {
      const tr = current.get(key);
      if (!tr || !tr.doorClosing || !tr.atStation || tr.v > .05) this.pending.delete(key);
      else if (f.t >= pending.at) {
        this.pending.delete(key); play(pending.key, pending.clip, f.t - pending.at, tr, true);
      }
    }
    for (const [key, tr] of current) {
      const prev = this.previous.get(key);
      if (!prev || !prev.atStation || !tr.atStation || tr.v > .05) continue;
      const closing = tr.doorClosing && !prev.doorClosing;
      const opening = tr.doors && !tr.doorClosing && (!prev.doors || prev.doorClosing);
      if (!closing && !opening) continue;
      const kind = closing ? 'close' : 'open';
      events.push({ kind, key, at: f.t });
      const primary = DOOR_TAKES.find(t => t.primary)!.id;
      const find = (soundKind: SoundKind) => this.bank.find(c => c.kind === soundKind && c.confidence !== 'low' &&
        (f.perspective === 'platform' ? c.source.startsWith('platform-') : c.id === `${soundKind}-${primary}`));
      const warning = f.perspective === 'onboard' ? find(closing ? 'door-warn-close' : 'door-warn-open') : undefined;
      const mechanism = find(f.perspective === 'onboard' ? closing ? 'door-motion-close' : 'door-motion-open' : closing ? 'close-motion' : 'open');
      if (warning) play(`door|${key}|warn|${f.t}`, warning, 0, tr, closing);
      if (mechanism) {
        if (closing) this.pending.set(key, { at: f.t + doorCycleSplit().warning, clip: mechanism, key: `door|${key}|motion|${f.t}` });
        else play(`door|${key}|motion|${f.t}`, mechanism, 0, tr, false);
      }
    }
    this.previous = current;
    return { commands, events };
  }
}

export class DoorAudio extends RecordedSoundPlayer {
  private planner: DoorSoundPlanner;
  private bank: readonly SoundClip[];
  private context = '';
  private time = NaN;
  constructor(ctx: AudioContext, dest: AudioNode, private fallback: (closing: boolean, rate: number) => void, bank: readonly SoundClip[] = SOUND_BANK, private cancelFallback: () => void = () => {}) {
    const doors = bank.filter(c => c.kind.startsWith('door-') || c.kind === 'open' || c.kind === 'close-motion');
    super(ctx, dest, doors); this.bank = doors; this.planner = new DoorSoundPlanner(doors);
  }
  override reset() { this.planner.reset(); super.reset(); this.cancelFallback(); this.context = ''; this.time = NaN; }
  update(f: DoorAudioFrame) {
    if (this.ctx.state !== 'running') { this.reset(); return; }
    const context = `${f.perspective}|${f.selectionKey}|${f.rate}`;
    if (f.paused || f.muted || !f.enabled || f.rate <= 0 || f.rate > VVVF_MAX_RATE || context !== this.context || f.t < this.time || f.t - this.time > Math.max(3, f.rate)) this.cancelFallback();
    this.context = context; this.time = f.t;
    const { commands, events } = this.planner.update(f);
    if (events.length) this.cancelFallback();
    this.apply(commands);
    if (f.perspective !== 'onboard') return;
    for (const event of events) {
      const primary = DOOR_TAKES.find(t => t.primary)!.id;
      // An opening lock clunk is motion, not a separate warning. Synthesise
      // once only if the whole opening has no ready recording. For closing,
      // missing warning falls back even when the mechanism file is ready.
      const kinds = event.kind === 'close' ? ['door-warn-close'] : ['door-warn-open', 'door-motion-open'];
      if (!this.bank.some(c => kinds.includes(c.kind) && c.id.endsWith(`-${primary}`) && this.hasClip(c.id))) this.fallback(event.kind === 'close', f.rate);
    }
  }
}
