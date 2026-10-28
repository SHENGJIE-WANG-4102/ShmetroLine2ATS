/** The worker publishes the close sequence independently of lock confirmation.
 * User decision: layer the selected carriage warning and closing mechanism,
 * keeping both recorded tails. Physical deadlines stay independent of the
 * recording's duration.
 */
import { SOUND_BANK, clipDuration, type SoundClip, type SoundKind } from '../data/audio/soundbank';
import { DOOR_REFERENCE_TIMING, DOOR_SELECTION, DOOR_TAKES } from '../data/audio/doorbank';
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
export interface DoorEvent { kind: 'open' | 'close'; key: string; at: number; take?: string }
const takeOf = (c: SoundClip) => c.id.slice(c.kind.length + 1);
// FNV-1a: the same trip at the same station always picks the same take, so a replay sounds alike.
const pick = <T>(items: readonly T[], seed: string) => {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return items[(h >>> 0) % items.length];
};
export class DoorSoundPlanner {
  private context = '';
  private time = NaN;
  private previous = new Map<string, StationTrain>();
  private pending = new Map<string, { at: number; clip: SoundClip; key: string; completeClip: boolean }>();
  private active = new Map<string, { train: string; closing: boolean; completeClip: boolean; until: number }>();
  constructor(private bank: readonly SoundClip[] = SOUND_BANK, private selection: 'primary' | 'random' = DOOR_SELECTION) {}
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
    const play = (key: string, clip: SoundClip, offset: number, tr: StationTrain, closing: boolean, completeClip = false) => {
      if (offset >= clipDuration(clip)) return;
      commands.push({ kind: 'play', key, clips: [clip], offsetS: offset, rate: f.rate, loop: false, volume: f.perspective === 'onboard' ? 1 : .7 });
      this.active.set(key, { train: keyOf(tr), closing, completeClip, until: f.t + clipDuration(clip) - offset });
    };
    for (const [key, sound] of this.active) {
      const tr = current.get(sound.train);
      // Both carriage closing tracks keep their tails through lock and departure.
      // Reopening cancels it; pause/mute/selection changes still reset all voices.
      const interrupted = tr && (sound.completeClip ? tr.doors && !tr.doorClosing
        : !tr.atStation || tr.v > .05 || (sound.closing ? !tr.doorClosing : tr.doorClosing || !tr.doors));
      if (!tr || interrupted || f.t >= sound.until) {
        commands.push({ kind: 'stop', key }); this.active.delete(key);
      }
    }
    for (const [key, pending] of this.pending) {
      const tr = current.get(key);
      if (!tr || (pending.completeClip ? tr.doors && !tr.doorClosing : !tr.doorClosing || !tr.atStation || tr.v > .05)) this.pending.delete(key);
      else if (f.t >= pending.at) {
        this.pending.delete(key); play(pending.key, pending.clip, f.t - pending.at, tr, true, pending.completeClip);
      }
    }
    for (const [key, tr] of current) {
      const prev = this.previous.get(key);
      if (!prev || !prev.atStation || !tr.atStation || tr.v > .05) continue;
      const closing = tr.doorClosing && !prev.doorClosing;
      const opening = tr.doors && !tr.doorClosing && (!prev.doors || prev.doorClosing);
      if (!closing && !opening) continue;
      const kind = closing ? 'close' : 'open';
      // Warning and mechanism of one event come from the same take. A line
      // without door recordings has no takes: nothing matches, the caller falls back.
      const kinds: SoundKind[] = closing ? ['door-warn-close', 'door-motion-close'] : ['door-warn-open', 'door-motion-open'];
      const takes = [...new Set(this.bank.filter(c => kinds.includes(c.kind) && c.confidence !== 'low').map(takeOf))];
      const take = this.selection === 'random' ? takes.length ? pick(takes, `${tr.trip}|${tr.nextStation}|${kind}`) : undefined
        : DOOR_TAKES.find(t => t.primary)?.id;
      events.push({ kind, key, at: f.t, take });
      const find = (soundKind: SoundKind) => this.bank.find(c => c.kind === soundKind && c.confidence !== 'low' &&
        (f.perspective === 'platform' ? c.source.startsWith('platform-') : take !== undefined && c.id === `${soundKind}-${take}`));
      const warning = f.perspective === 'onboard' ? find(closing ? 'door-warn-close' : 'door-warn-open') : undefined;
      const mechanism = find(f.perspective === 'onboard' ? closing ? 'door-motion-close' : 'door-motion-open' : closing ? 'close-motion' : 'open');
      if (warning) play(`door|${key}|warn|${f.t}`, warning, 0, tr, closing, closing);
      if (mechanism) {
        if (closing) this.pending.set(key, { at: f.t + DOOR_REFERENCE_TIMING.warningToMotionS, clip: mechanism, key: `door|${key}|motion|${f.t}`, completeClip: f.perspective === 'onboard' });
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
      // An opening lock clunk is motion, not a separate warning. Synthesise
      // once only if the whole opening has no ready recording. For closing,
      // a missing warning falls back once even if the mechanism is ready.
      const kinds = event.kind === 'close' ? ['door-warn-close'] : ['door-warn-open', 'door-motion-open'];
      if (!this.bank.some(c => event.take !== undefined && kinds.includes(c.kind) && c.id === `${c.kind}-${event.take}` && this.hasClip(c.id))) this.fallback(event.kind === 'close', f.rate);
    }
  }
}
