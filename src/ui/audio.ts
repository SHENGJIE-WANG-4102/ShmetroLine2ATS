/**
 * Synthesised sounds (Web Audio, no assets): alarm tones by level, the
 * radio / phone ring while a call waits, a squelch burst when a call is
 * answered, and a short click for commands. Mute is persisted. The one
 * recorded sounds are handled by vvvf.ts and stationaudio.ts.
 */
import { loadPref, savePref } from './layout';
import { RECORDED_VOLUME_GAINS, type RecordedVolume } from '../data/onboardbank';
import { VvvfSound, type VvvfMode } from './vvvf';
import { StationAudio, type StationAudioFrame } from './stationaudio';
import { OnboardAudio, type OnboardAudioFrame } from './onboardaudio';
import { DoorAudio, type DoorAudioFrame } from './dooraudio';

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = loadPref('muted', false);
  /** the inverter sound of the selected train, switched on and off in 设置 › 走行音 */
  traction = loadPref('traction', true);
  stationSound = loadPref('stationSound', true);
  recordedVolume: RecordedVolume = (() => { const v = loadPref<string>('recordedVolume', 'medium'); return v in RECORDED_VOLUME_GAINS ? v as RecordedVolume : 'medium'; })();
  private ringTimer = 0;
  private alarmTimer = 0;
  private overTimer = 0;
  private vvvf: VvvfSound | null = null;
  private station: StationAudio | null = null;
  private onboard: OnboardAudio | null = null;
  private doors: DoorAudio | null = null;
  private doorFallbackNodes = new Set<OscillatorNode>();

  constructor() {
    const unlock = () => {
      this.ensure();
      void this.ctx?.resume();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  private ensure() {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.35;
      this.master.connect(this.ctx.destination);
      this.vvvf = new VvvfSound(this.ctx, this.master);
      this.station = new StationAudio(this.ctx, this.master);
      this.onboard = new OnboardAudio(this.ctx, this.master);
      this.doors = new DoorAudio(this.ctx, this.master, (closing, rate) => this.doorChime(closing, rate), undefined, () => this.stopDoorFallback());
      this.applyRecordedVolume();
    } catch {
      this.ctx = null;
    }
  }

  setMuted(m: boolean) {
    this.muted = m;
    savePref('muted', m);
    if (this.master) this.master.gain.value = m ? 0 : 0.35;
    if (m) { this.stopRing(); this.stopAlarm(); this.setOverspeed(false); this.stopStationAudio(); }
  }

  private tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', vol = 0.6) {
    if (!this.ctx || !this.master || this.muted) return;
    const t0 = this.ctx.currentTime + start;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + Math.min(.012, dur / 4));
    g.gain.setValueAtTime(vol, t0 + dur - Math.min(.03, dur / 3));
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
    return o;
  }

  /** one alarm sound by level */
  alarm(level: 'A' | 'B' | 'C') {
    this.ensure();
    if (level === 'A') { this.tone(988, 0, 0.18, 'square', 0.35); this.tone(740, 0.22, 0.18, 'square', 0.35); this.tone(988, 0.44, 0.18, 'square', 0.35); }
    else if (level === 'B') { this.tone(880, 0, 0.16, 'triangle', 0.5); this.tone(660, 0.2, 0.22, 'triangle', 0.5); }
    else this.tone(660, 0, 0.18, 'sine', 0.5);
  }

  /** repeat the A tone while there are unacknowledged A alarms */
  setAlarmLoop(on: boolean) {
    if (on && !this.alarmTimer) {
      this.alarm('A');
      this.alarmTimer = window.setInterval(() => this.alarm('A'), 4000);
    } else if (!on) this.stopAlarm();
  }

  private stopAlarm() {
    if (this.alarmTimer) { clearInterval(this.alarmTimer); this.alarmTimer = 0; }
  }

  /** telephone-style double ring, repeated while a call is waiting */
  setRinging(on: boolean) {
    if (on && !this.ringTimer) {
      const ring = () => {
        for (let i = 0; i < 2; i++) {
          for (let k = 0; k < 8; k++) {
            this.tone(k % 2 ? 480 : 440, i * 0.45 + k * 0.05, 0.05, 'sine', 0.35);
          }
        }
      };
      this.ensure();
      ring();
      this.ringTimer = window.setInterval(ring, 2600);
    } else if (!on) this.stopRing();
  }

  private stopRing() {
    if (this.ringTimer) { clearInterval(this.ringTimer); this.ringTimer = 0; }
  }

  /** radio squelch: band-passed noise burst */
  squelch() {
    this.ensure();
    if (!this.ctx || !this.master || this.muted) return;
    const len = Math.floor(this.ctx.sampleRate * 0.22);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.8;
    const g = this.ctx.createGain();
    g.gain.value = 0.5;
    src.connect(bp).connect(g).connect(this.master);
    src.start();
    this.tone(1200, 0.2, 0.06, 'sine', 0.25);
  }

  /** overspeed warning in the cab of a manually driven train (above the permitted speed, before the EB) */
  setOverspeed(on: boolean) {
    if (on && !this.overTimer) {
      const beep = () => this.tone(1250, 0, 0.12, 'square', 0.25);
      this.ensure();
      beep();
      this.overTimer = window.setInterval(beep, 450);
    } else if (!on && this.overTimer) { clearInterval(this.overTimer); this.overTimer = 0; }
  }

  /**
   * Missing-file fallback only. Recorded warning / motion use separate clocks.
   * 【假设】 retain the former beeps if the relevant recording is unavailable.
   */
  doorChime(closing: boolean, rate = 1) {
    if (!this.stationSound || this.muted) return;
    this.ensure();
    this.stopDoorFallback();
    const n = closing ? 12 : 3;
    for (let i = 0; i < n; i++) {
      for (const [freq, type, gain] of [[2300, 'triangle', .22], [4600, 'sine', .05]] as const) {
        const node = this.tone(freq, i * .25 / rate, .13 / rate, type, gain * RECORDED_VOLUME_GAINS[this.recordedVolume]);
        if (node) { this.doorFallbackNodes.add(node); node.onended = () => this.doorFallbackNodes.delete(node); }
      }
    }
  }
  private stopDoorFallback() {
    for (const node of this.doorFallbackNodes) { try { node.stop(); } catch { /* already ended */ } node.disconnect(); }
    this.doorFallbackNodes.clear();
  }

  setTractionOn(on: boolean) {
    this.traction = on;
    savePref('traction', on);
  }

  setStationSoundOn(on: boolean) {
    this.stationSound = on;
    savePref('stationSound', on);
    if (!on) this.stopStationAudio();
  }
  setRecordedVolume(level: RecordedVolume) {
    this.recordedVolume = level; savePref('recordedVolume', level); this.applyRecordedVolume();
  }
  private applyRecordedVolume() {
    const gain = RECORDED_VOLUME_GAINS[this.recordedVolume];
    this.station?.setVolume(gain); this.onboard?.setVolume(gain); this.doors?.setVolume(gain); this.vvvf?.setVolume(gain);
  }
  stopStationAudio() { this.station?.reset(); this.onboard?.reset(); this.doors?.reset(); this.stopDoorFallback(); }
  setStationAudio(frame: Omit<StationAudioFrame, 'muted' | 'enabled'>) {
    this.station?.update({ ...frame, muted: this.muted, enabled: this.stationSound });
  }
  setOnboardAudio(frame: Omit<OnboardAudioFrame, 'muted' | 'enabled'>) {
    this.onboard?.update({ ...frame, muted: this.muted, enabled: this.stationSound });
  }
  setDoorAudio(frame: Omit<DoorAudioFrame, 'muted' | 'enabled'>) {
    this.doors?.update({ ...frame, muted: this.muted, enabled: this.stationSound });
  }

  /** the inverter sound of the train listened to (see vvvf.ts) */
  setTraction(mode: VvvfMode, v: number, level: number) {
    this.vvvf?.set(this.muted || !this.traction ? 'off' : mode, v, level);
  }

  click() {
    this.ensure();
    this.tone(1400, 0, 0.03, 'square', 0.12);
  }
}
