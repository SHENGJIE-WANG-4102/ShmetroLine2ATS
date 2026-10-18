import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOUND_BANK, clipDuration, ONBOARD_ANNOUNCEMENTS, ONBOARD_NEXT_DELAY_S, ONBOARD_ARRIVAL_ADVANCE_S,
  ONBOARD_HOLD_CLIP, ONBOARD_HOLD_DELAY_S, ONBOARD_HOLD_REPEAT_S } from '../src/data/soundbank';
import { StationAudio, StationSoundPlanner, compatibleBoth, platformAnnouncement, predictStationStop, stationFrame, stationSoundEnabled,
  isUndergroundStation, RecordedSoundPlayer, type StationAudioFrame, type StationTrain, type StationSoundCommand } from '../src/ui/stationaudio';
import { OnboardAudio, OnboardSoundPlanner, cabinVolumes, onboardFrame, type OnboardAudioFrame } from '../src/ui/onboardaudio';
import { VOICE_PARTS, ORIGINAL_ONBOARD, ONBOARD_DESTINATIONS, onboardAnnouncement, onboardDoorSide, VOICE_CROSSFADE_S, RECORDED_VOLUME_GAINS,
  FIELD_1016_VOICE_PARTS, FIELD_1016_TERMINAL_CLIP, compatibleVoiceRecipe, RECORDED_ONBOARD } from '../src/data/onboardbank';
import { Audio } from '../src/ui/audio';
import { DoorAudio, DoorSoundPlanner, doorCycleSplit, type DoorAudioFrame } from '../src/ui/dooraudio';
import { DOOR_TAKES } from '../src/data/doorbank';
import type { OnboardAnnouncement, SoundClip } from '../src/data/soundbank';
import { STATIONS } from '../src/data/line2';
import type { Snapshot, PisData, TrainSnap } from '../src/sim/model';
import type { Topology } from '../src/sim/topology';

const station = STATIONS.findIndex(s => s.name === '江苏路');
const tr = (patch: Partial<StationTrain> = {}): StationTrain => ({ id: 1, trip: '1234', direction: 'DN', mode: 'DTO', manual: false,
  rm: false, failed: false, eb: false, inService: true, phase: 'run', v: 10.5, a: -.75, distance: 73.5,
  nextStation: station, atStation: false, doors: false, dwellLeft: 0, ...patch });
const pis = (trains: readonly StationTrain[]): PisData => ({ station, DN: [], UP: [], notice: '', ...Object.fromEntries(['DN', 'UP'].map(direction =>
  [direction, trains.filter(t => t.direction === direction).map(t => ({ trip: t.trip, dest: '蟠祥路·国家会计学院', destSt: 0, eta: 14, status: t.phase === 'dwell' ? 'at' : 'arriving', load: .2 }))])) });
const frame = (t: number, trains: readonly StationTrain[] = [tr()], patch: Partial<StationAudioFrame> = {}): StationAudioFrame => ({ station, name: '江苏路', t, rate: 1,
  paused: false, muted: false, enabled: true, trains, pis: pis(trains), ...patch });
const plays = (cmds: StationSoundCommand[]) => cmds.filter((c): c is Extract<StationSoundCommand, { kind: 'play' }> => c.kind === 'play');
const motion = (cmds: StationSoundCommand[]) => plays(cmds).filter(c => c.clips[0].kind !== 'ambience');
const countdown = (seconds: number, patch: Partial<StationTrain> = {}) => tr({ v: .75 * seconds, distance: .375 * seconds * seconds, ...patch });

describe('recorded platform scheduling', () => {
  it('starts a stable arrival at its stop anchor and does not repeat it', () => {
    const p = new StationSoundPlanner();
    expect(motion(p.update(frame(100, [countdown(14.2)])))).toEqual([]);
    const commands = motion(p.update(frame(100.2, [countdown(14)])));
    expect(commands).toHaveLength(1); expect(commands[0].clips[0].id).toBe('arrive-dn'); expect(commands[0].offsetS).toBeCloseTo(0);
    expect(motion(p.update(frame(100.4, [countdown(13.8)])))).toEqual([]);
  });
  it.each([{ manual: true }, { mode: 'CM' as const }, { mode: 'RM' as const }, { rm: true }, { failed: true }, { eb: true }, { inService: false }])('excludes nonautomatic movements %j', patch => {
    const p = new StationSoundPlanner(); p.update(frame(100, [countdown(14.2, patch)]));
    expect(motion(p.update(frame(100.2, [countdown(14, patch)])))).toEqual([]);
  });
  it('excludes passing trains and a second train behind the PIS first train', () => {
    const p = new StationSoundPlanner(), second = countdown(14, { id: 2, trip: 'second' });
    const first = tr({ trip: 'first', nextStation: station + 1 });
    p.update(frame(100, [first, second]));
    expect(motion(p.update(frame(100.2, [first, second])))).toEqual([]);
  });
  it('requires PIS for this station and respects skip flags', () => {
    for (const board of [null, { ...pis([tr()]), station: station + 1 }, { ...pis([tr()]), skip: { DN: true } }]) {
      const p = new StationSoundPlanner(); p.update(frame(100, [countdown(14.2)], { pis: board }));
      expect(motion(p.update(frame(100.2, [countdown(14)], { pis: board })))).toEqual([]);
    }
  });
  it('skips clips when observation starts too late', () => {
    const p = new StationSoundPlanner(); p.update(frame(100, [countdown(10.2)]));
    expect(motion(p.update(frame(100.2, [countdown(10)])))).toEqual([]);
  });
  it('fades an arrival when drift exceeds 3 s, without subtracting anchor error', () => {
    const p = new StationSoundPlanner(); p.update(frame(100, [countdown(14.2)]));
    p.update(frame(100.2, [countdown(14)]));
    const commands = p.update(frame(100.4, [countdown(17.6)]));
    expect(commands).toContainEqual({ kind: 'stop', key: 'arrive|DN|1|1234', fadeS: .5 });
    p.update(frame(101.2, [countdown(13.8)]));
    expect(motion(p.update(frame(101.4, [countdown(13.6)])))).toEqual([]);
  });
  it('allows 2.9 s late starts from the middle of the recording', () => {
    const p = new StationSoundPlanner(); p.update(frame(100, [countdown(11.3)]));
    const commands = motion(p.update(frame(100.2, [countdown(11.1)])));
    expect(commands).toHaveLength(1); expect(commands[0].offsetS).toBeCloseTo(2.9);
  });
  it('allows a 2 s drift even with 1 s of fixed anchor uncertainty', () => {
    const p = new StationSoundPlanner(); p.update(frame(100, [countdown(14.2)])); p.update(frame(100.2, [countdown(14)]));
    expect(p.update(frame(100.4, [countdown(15.8)])).some(c => c.kind === 'stop')).toBe(false);
  });
  it.each([{ paused: true }, { muted: true }, { enabled: false }, { rate: 10 }, { rate: 0 }, { station: null }])('stops every voice and clears history when gated %j', patch => {
    const p = new StationSoundPlanner(); p.update(frame(100));
    const commands = p.update(frame(100.1, [tr()], patch));
    expect(commands).toContainEqual({ kind: 'stop', key: 'ambience' });
    expect(plays(commands)).toHaveLength(0);
    expect(p.update(frame(100.2, [tr({ phase: 'run', v: 1, atStation: true })])).filter(c => c.kind === 'play' && c.clips[0].kind === 'depart')).toEqual([]);
  });
  it('cancels on station switch, rewind, forward jumps and rate changes', () => {
    for (const patch of [{ station: station + 1, name: '静安寺' }, { t: 50 }, { t: 200 }, { rate: 2 }]) {
      const p = new StationSoundPlanner(); p.update(frame(100));
      expect(p.update(frame(100.2, [tr()], patch))).toContainEqual({ kind: 'stop', key: 'ambience' });
    }
  });
  it('aligns departures to startAt by skipping the pre-start second', () => {
    const p = new StationSoundPlanner(); p.update(frame(100, [tr({ phase: 'dwell', v: 0, atStation: true })]));
    const commands = motion(p.update(frame(100.2, [tr({ v: .1, atStation: true })])));
    expect(commands).toHaveLength(1); expect(commands[0].clips[0].kind).toBe('depart'); expect(commands[0].offsetS).toBe(1);
    expect(motion(p.update(frame(100.4, [tr({ v: .3, atStation: true })])))).toEqual([]);
  });
  it('plays a close warning per actual door transition, including a reopened door', () => {
    const p = new StationSoundPlanner();
    const standing = tr({ phase: 'dwell', v: 0, atStation: true, doors: true });
    p.update(frame(100, [standing]));
    expect(motion(p.update(frame(100.2, [{ ...standing, doors: false }])))[0].clips[0].kind).toBe('close');
    expect(motion(p.update(frame(100.4, [{ ...standing, doors: false }])))).toEqual([]);
    p.update(frame(100.6, [standing]));
    expect(motion(p.update(frame(100.8, [{ ...standing, doors: false }])))[0].clips[0].kind).toBe('close');
  });
  it('retains departure arming when run phase precedes positive speed', () => {
    const p = new StationSoundPlanner();
    p.update(frame(100, [tr({ phase: 'dwell', v: 0, atStation: true })]));
    expect(motion(p.update(frame(100.2, [tr({ phase: 'run', v: 0, atStation: true })])))).toEqual([]);
    const commands = motion(p.update(frame(100.4, [tr({ phase: 'run', v: .005, atStation: true })])));
    expect(commands).toHaveLength(1); expect(commands[0].clips[0].kind).toBe('depart'); expect(commands[0].offsetS).toBe(1);
  });
  it('cancels a departure if the train fails after starting', () => {
    const p = new StationSoundPlanner(); p.update(frame(100, [tr({ phase: 'dwell', v: 0, atStation: true })]));
    p.update(frame(100.2, [tr({ v: .005, atStation: true })]));
    expect(p.update(frame(100.4, [tr({ failed: true, v: 0, atStation: true })]))).toContainEqual({ kind: 'stop', key: 'depart|DN|1|1234', fadeS: .5 });
  });
  it('skips a departure transition observed beyond the alignment budget', () => {
    const p = new StationSoundPlanner(); p.update(frame(100, [tr({ phase: 'dwell', v: 0, atStation: true })]));
    expect(motion(p.update(frame(103.1, [tr({ v: 1, atStation: true })])))).toEqual([]);
  });
  it('does not invent a departure on first selection or a changed trip', () => {
    const p = new StationSoundPlanner(); expect(motion(p.update(frame(100, [tr({ atStation: true, v: .1 })])))).toEqual([]);
    p.update(frame(100.2, [tr({ phase: 'dwell', v: 0, atStation: true })]));
    expect(motion(p.update(frame(100.4, [tr({ trip: 'new', atStation: true, v: .1 })])))).toEqual([]);
  });
  it('allows both sides independently without conflating train identities', () => {
    const p = new StationSoundPlanner();
    const trains = [tr({ phase: 'dwell', v: 0, atStation: true, doors: true }), tr({ id: 2, trip: 'up', direction: 'UP', phase: 'dwell', v: 0, atStation: true, doors: true })];
    p.update(frame(100, trains));
    expect(motion(p.update(frame(100.2, trains.map(t => ({ ...t, doors: false })))))).toHaveLength(2);
  });
  it('uses a mixed arrival only when both recorded stop anchors fit', () => {
    const p = new StationSoundPlanner();
    const trains = (s: number) => [countdown(54 - s), countdown(24 - s, { id: 2, trip: 'up', direction: 'UP' })];
    p.update(frame(100, trains(-.2)));
    const commands = motion(p.update(frame(100.2, trains(0))));
    expect(commands).toHaveLength(1); expect(commands[0].clips[0].id).toBe('arrive-both');
    expect(compatibleBoth(SOUND_BANK.find(c => c.id === 'arrive-both')!, { DN: 120, UP: 120 })).toBe(false);
    expect(compatibleBoth(SOUND_BANK.find(c => c.id === 'arrive-both')!, { DN: 154, UP: 124 })).toBe(true);
  });
  it('guards a mixed departure with the other side countdown and cancels if it fails', () => {
    const p = new StationSoundPlanner();
    const up = tr({ id: 2, trip: 'up', direction: 'UP', phase: 'dwell', v: 0, atStation: true });
    const dn = tr({ phase: 'dwell', v: 0, atStation: true, dwellLeft: 12 });
    p.update(frame(100, [up, dn]));
    const commands = motion(p.update(frame(100.2, [{ ...up, phase: 'run', v: .1 }, dn])));
    expect(commands[0].clips[0].id).toBe('depart-both');
    // Regular intermediate frames avoid interpreting this as a time jump.
    for (let t = 101; t < 116; t++) p.update(frame(t, [{ ...up, phase: 'run', v: 3 }, dn]));
    expect(p.update(frame(116, [{ ...up, phase: 'run', v: 3 }, dn])).some(c => c.kind === 'stop' && c.fadeS === .5)).toBe(true);
  });
  it('never substitutes an unrecorded platform destination or an interior name', () => {
    expect(platformAnnouncement(SOUND_BANK, '江苏路', 'UP', '蟠祥路·国家会计学院').map(c => c.kind)).toEqual(['prefix', 'station-name', 'suffix']);
    expect(platformAnnouncement(SOUND_BANK, '江苏路', 'UP', '广兰路')).toEqual([]);
    expect(platformAnnouncement(SOUND_BANK, '江苏路', 'UP', '人民广场')).toEqual([]);
    expect(platformAnnouncement(SOUND_BANK, '江苏路', 'DN', '浦东1号2号航站楼')).toEqual([]);
  });
  it('does not double the PA already embedded in an arrival', () => {
    const p = new StationSoundPlanner(), up = (s: number) => countdown(s, { direction: 'UP' });
    p.update(frame(100, [up(24.2)])); p.update(frame(100.2, [up(24)]));
    for (let t = 100.4; t < 102.8; t += .2) p.update(frame(t, [up(124.2 - t)]));
    expect(motion(p.update(frame(103, [up(21.2)])))).toEqual([]);
  });
  it('plays the template at its measured lead when the movement has no embedded PA', () => {
    const bank = SOUND_BANK.filter(c => c.kind !== 'arrive');
    const p = new StationSoundPlanner(bank);
    p.update(frame(100, [countdown(21.55, { direction: 'UP' })]));
    const commands = motion(p.update(frame(100.2, [countdown(21.35, { direction: 'UP' })])));
    expect(commands).toHaveLength(1); expect(commands[0].clips.map(c => c.kind)).toEqual(['prefix', 'station-name', 'suffix']);
  });
  it('reuses platform ambience at underground stations and excludes exposed stations', () => {
    const p = new StationSoundPlanner();
    expect(plays(p.update(frame(100, [tr()], { station: station + 1, name: '静安寺' })))[0].clips[0].kind).toBe('ambience');
    const surface = STATIONS.findIndex(s => s.name === '川沙');
    expect(isUndergroundStation(surface)).toBe(false);
    expect(p.update(frame(100.2, [], { station: surface, name: '川沙' })).filter(c => c.kind === 'play')).toEqual([]);
    expect(platformAnnouncement(SOUND_BANK, '人民广场', 'UP', '蟠祥路·国家会计学院')).toHaveLength(3);
    expect(platformAnnouncement(SOUND_BANK, '川沙', 'UP', '蟠祥路·国家会计学院')).toEqual([]);
  });
  it('uses braking distance and speed, rejects nonexistent or infeasible stops', () => {
    expect(predictStationStop(tr())).toBe(14);
    expect(predictStationStop(tr({ a: -.75, v: 15, distance: 150 }))).toBe(20);
    expect(predictStationStop(tr({ distance: 140, a: 0, v: 10 }))).toBeCloseTo(21.1666667);
    for (const distance of [-1, NaN, Infinity, 1]) expect(predictStationStop(tr({ distance }))).toBeNull();
    expect(stationSoundEnabled(frame(100, [], { rate: 5 }))).toBe(true);
  });
  it('projects platform side from topology, without using the manual door side', () => {
    const snap = { t: 100, speed: 1, paused: false, pis: null, trains: [{ ...tr(), dir: 1, link: 0, stopDist: 10 }] } as unknown as Snapshot;
    const topo = { links: [{ platform: 0, track: 'DN' }], platforms: [{ station, track: 'UP' }] } as unknown as Topology;
    const projected = stationFrame(snap, station, topo);
    expect(projected.trains[0].direction).toBe('UP'); expect(projected.trains[0].atStation).toBe(true);
  });
  it('metadata anchors retain valid clocks after foreign-PA trimming, ambience stays at least ten seconds', () => {
    for (const clip of SOUND_BANK) {
      expect(clipDuration(clip)).toBeGreaterThan(0);
      for (const at of [clip.startAt, clip.stopAt, clip.otherAt]) if (at !== undefined) {
        expect(at).toBeGreaterThanOrEqual(0);
        if (clip.anchorAfterTail && at === clip.stopAt) expect(clip.range[0] + at).toBe(32);
        else expect(at).toBeLessThan(clipDuration(clip));
      }
      if (clip.kind === 'ambience') expect(clipDuration(clip)).toBeGreaterThanOrEqual(10);
    }
  });
});

describe('separate recorded door clocks', () => {
  const df = (t: number, doors: boolean, patch: Partial<DoorAudioFrame> = {}): DoorAudioFrame => ({
    t, rate: 1, paused: false, muted: false, enabled: true, selectionKey: 'train|1', perspective: 'onboard', station: null,
    trains: [tr({ v: 0, atStation: true, phase: 'dwell', doors })], ...patch });
  it('retains the pre-trim arrival start clock even when sound ends before the stop', () => {
    const p = new StationSoundPlanner(), up = (s: number) => countdown(s, { direction: 'UP' });
    p.update(frame(100, [up(24.2)]));
    const command = motion(p.update(frame(100.2, [up(24)])))[0];
    expect(command.clips[0].id).toBe('arrive-up'); expect(command.offsetS).toBe(0);
    const c = command.clips[0]; expect(c.range[1]).toBeLessThan(25.2);
    expect(c.range[0] + c.stopAt!).toBe(32); expect(clipDuration(c)).toBeLessThan(c.stopAt!);
    expect(c.fadeOutS).toBe(.4); expect(c.anchorAfterTail).toBe(true);
    expect(SOUND_BANK.find(c => c.id === 'arrive-both')!.range[1]).toBeGreaterThan(67.31);
  });
  it('splits the existing 15 s door budget without changing train operation', () => {
    const split = doorCycleSplit();
    expect(split.opening).toBe(3); expect(split.warning).toBe(2.7); expect(split.motion).toBe(3);
    expect(split.confirmation).toBeCloseTo(6.3);
    for (const take of DOOR_TAKES) expect(take.close[0] - take.warn[0]).toBeCloseTo(2.7, 2);
  });
  it('opens with one mechanical recording and no fabricated warning', () => {
    const p = new DoorSoundPlanner(); p.update(df(100, false));
    const commands = plays(p.update(df(100.2, true)).commands);
    expect(commands.map(c => c.clips[0].kind)).toEqual(['door-motion-open']);
    expect(commands[0].offsetS).toBe(0);
  });
  it.each([1, 5])('aligns warning now and motion 2.7 simulation seconds later at rate %s', rate => {
    const p = new DoorSoundPlanner(); p.update(df(100, true, { rate }));
    const warning = plays(p.update(df(100.2, false, { rate })).commands);
    expect(warning.map(c => c.clips[0].kind)).toEqual(['door-warn-close']);
    expect(plays(p.update(df(102.8, false, { rate })).commands)).toEqual([]);
    const movement = plays(p.update(df(102.9, false, { rate })).commands);
    expect(movement.map(c => c.clips[0].kind)).toEqual(['door-motion-close']);
    expect(movement[0].offsetS).toBeCloseTo(0); expect(movement[0].rate).toBe(rate);
  });
  it('cancels the pending close mechanism if the door reopens', () => {
    const p = new DoorSoundPlanner(); p.update(df(100, true)); p.update(df(100.2, false));
    const reopening = p.update(df(101, true));
    expect(reopening.commands.some(c => c.kind === 'stop')).toBe(true);
    expect(plays(reopening.commands)[0].clips[0].kind).toBe('door-motion-open');
    expect(plays(p.update(df(103, true)).commands)).toEqual([]);
  });
  it.each([{ paused: true }, { muted: true }, { enabled: false }, { rate: 0 }, { rate: 10 }, { selectionKey: 'train|2' }])('cancels pending door clocks on %j', patch => {
    const p = new DoorSoundPlanner(); p.update(df(100, true)); p.update(df(100.2, false));
    expect(p.update(df(100.4, false, patch)).commands.some(c => c.kind === 'stop')).toBe(true);
    expect(plays(p.update(df(103, false)).commands)).toEqual([]);
  });
  it('does not invent an initial transition or substitute cabin motion for missing platform motion', () => {
    const p = new DoorSoundPlanner();
    expect(plays(p.update(df(100, true)).commands)).toEqual([]);
    const q = new DoorSoundPlanner();
    const patch = { perspective: 'platform' as const, selectionKey: 'station|jsl', station };
    q.update(df(100, false, patch)); expect(plays(q.update(df(100.2, true, patch)).commands)).toEqual([]);
  });
});

describe('Web Audio lifecycle', () => {
  afterEach(() => vi.unstubAllGlobals());
  function context() {
    const sources: { stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; onended: (() => void) | null; playbackRate: { value: number } }[] = [];
    const gains: { disconnect: ReturnType<typeof vi.fn> }[] = [];
    const ctx = { state: 'running', currentTime: 5,
      decodeAudioData: vi.fn(async () => ({ duration: 26 })),
      createBufferSource: () => { const s = { stop: vi.fn(), disconnect: vi.fn(), start: vi.fn(), connect: (g: unknown) => g, onended: null, playbackRate: { value: 1 } }; sources.push(s); return s; },
      createGain: () => { const g = { gain: { value: 0, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), setTargetAtTime: vi.fn() }, disconnect: vi.fn(), connect: () => null }; gains.push(g); return g; } };
    return { ctx: ctx as unknown as AudioContext, sources, gains };
  }
  async function ready() { await new Promise(resolve => setTimeout(resolve, 0)); }
  const doorFrame = (t: number, doors: boolean, patch: Partial<DoorAudioFrame> = {}): DoorAudioFrame => ({
    t, rate: 1, paused: false, muted: false, enabled: true, selectionKey: 'train|1', perspective: 'onboard', station: null,
    trains: [tr({ v: 0, atStation: true, phase: 'dwell', doors })], ...patch });
  it('plays recorded door motion without inventing an opening warning or synthetic chime', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })));
    const { ctx, sources } = context(), fallback = vi.fn(), audio = new DoorAudio(ctx, {} as AudioNode, fallback);
    await ready(); audio.update(doorFrame(100, false)); audio.update(doorFrame(100.2, true));
    expect(sources).toHaveLength(1); expect(fallback).not.toHaveBeenCalled();
  });
  it('falls back once for a missing door file, cancels on pause, never replays after late loading', async () => {
    let finish!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finish = resolve; })));
    const { ctx, sources } = context(), fallback = vi.fn(), cancel = vi.fn(), audio = new DoorAudio(ctx, {} as AudioNode, fallback, undefined, cancel);
    audio.update(doorFrame(100, true)); audio.update(doorFrame(100.2, false));
    expect(fallback).toHaveBeenCalledExactlyOnceWith(true, 1); expect(sources).toHaveLength(0);
    audio.update(doorFrame(100.4, false, { paused: true })); expect(cancel).toHaveBeenCalled();
    finish({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }); await ready();
    audio.update(doorFrame(101, false)); expect(sources).toHaveLength(0); expect(fallback).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('missing fetch/decode stays silent (HTTP failure=%s)', async httpFailure => {
    vi.stubGlobal('fetch', vi.fn(async () => { if (httpFailure) return { ok: false, status: 404 }; throw new Error('offline'); }));
    const { ctx, sources } = context(), audio = new StationAudio(ctx, {} as AudioNode);
    await ready(); expect(() => audio.update(frame(100))).not.toThrow(); expect(sources).toHaveLength(0);
  });
  it('requires every template buffer; cannot play a wrong partial sentence', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: !url.includes('name-pxl'), arrayBuffer: async () => new ArrayBuffer(1) })));
    const { ctx, sources } = context(), audio = new StationAudio(ctx, {} as AudioNode, SOUND_BANK.filter(c => c.kind !== 'arrive' && c.kind !== 'ambience'));
    await ready(); audio.update(frame(100, [countdown(21.55, { direction: 'UP' })])); audio.update(frame(100.2, [countdown(21.35, { direction: 'UP' })]));
    expect(sources).toHaveLength(0);
  });
  it('decode errors remain silent without asynchronous late playback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })));
    const { ctx, sources } = context(); vi.mocked(ctx.decodeAudioData).mockRejectedValue(new Error('invalid MP3'));
    const audio = new StationAudio(ctx, {} as AudioNode); await ready();
    expect(() => audio.update(frame(100))).not.toThrow(); expect(sources).toHaveLength(0);
  });
  it('stops and disconnects all scheduled nodes on mute, including pending sentence parts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })));
    const { ctx, sources, gains } = context(), bank = SOUND_BANK.filter(c => c.kind !== 'arrive' && c.kind !== 'ambience');
    const audio = new StationAudio(ctx, {} as AudioNode, bank);
    await ready(); audio.update(frame(100, [countdown(21.55, { direction: 'UP' })])); audio.update(frame(100.2, [countdown(21.35, { direction: 'UP' })]));
    expect(sources).toHaveLength(3); expect(sources[1].start.mock.calls[0][0]).toBeGreaterThan(5);
    audio.update(frame(100.4, [], { muted: true }));
    for (const s of sources) { expect(s.stop).toHaveBeenCalledOnce(); expect(s.disconnect).toHaveBeenCalledOnce(); }
    for (const g of gains) expect(g.disconnect).toHaveBeenCalledOnce();
  });
  it('does not schedule while the audio context is suspended', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })));
    const { ctx, sources } = context(); Object.defineProperty(ctx, 'state', { value: 'suspended' });
    const audio = new StationAudio(ctx, {} as AudioNode); await ready(); audio.update(frame(100)); expect(sources).toHaveLength(0);
  });
  it('schedules a 0.5 s fade and lets pause cancel the retiring voice immediately', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })));
    const { ctx, sources, gains } = context(), audio = new RecordedSoundPlayer(ctx, {} as AudioNode, [SOUND_BANK[0]]);
    await ready(); audio.apply([{ kind: 'play', key: 'test', clips: [SOUND_BANK[0]], offsetS: 2.9, rate: 1, loop: false, volume: .7 }]);
    expect(sources[0].start).toHaveBeenCalledWith(5, 2.9);
    audio.apply([{ kind: 'stop', key: 'test', fadeS: .5 }]);
    expect(sources[0].stop).toHaveBeenCalledWith(5.5); expect(gains[0].disconnect).not.toHaveBeenCalled();
    audio.reset(); expect(sources[0].stop).toHaveBeenLastCalledWith(); expect(gains[0].disconnect).toHaveBeenCalledOnce();
  });
  it('preloads only the selected carriage call, the stop PA and its two loops', async () => {
    const request = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }));
    vi.stubGlobal('fetch', request);
    const { ctx, sources } = context(), audio = new OnboardAudio(ctx, {} as AudioNode);
    expect(request).not.toHaveBeenCalled();
    const selected: OnboardAudioFrame = { t: 100, rate: 1, paused: false, muted: false, enabled: true,
      train: tr({ nextStation: STATIONS.findIndex(s => s.id === 'JAS'), v: 4, distance: 1000 }), willStop: true, destination: '广兰路', doorSide: 'L' };
    audio.update(selected); await ready(); audio.update({ ...selected, t: 100.2 });
    expect(request).toHaveBeenCalledTimes(5); expect((sources as unknown as AudioBufferSourceNode[]).filter(s => s.loop)).toHaveLength(2);
    audio.reset();
  });
  it('scales existing voices and future plays by the same volume tier', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })));
    const { ctx, gains } = context(), audio = new RecordedSoundPlayer(ctx, {} as AudioNode, [SOUND_BANK[0]]);
    await ready(); audio.setVolume(1.45);
    audio.apply([{ kind: 'play', key: 'test', clips: [SOUND_BANK[0]], offsetS: 0, rate: 1, loop: false, volume: .7 }]);
    const gain = (gains[0] as unknown as GainNode).gain;
    expect(gain.value).toBeCloseTo(.7 * 1.45);
    audio.setVolume(.6); expect(gain.setTargetAtTime).toHaveBeenLastCalledWith(.7 * .6, 5, .12);
    audio.reset();
  });
  it('starts continuing ambience after loading, but does not replay expired speech', async () => {
    let resolveFetch!: (r: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { resolveFetch = resolve; })));
    const { ctx, sources } = context(), clip = SOUND_BANK.find(c => c.kind === 'ambience')!;
    const audio = new RecordedSoundPlayer(ctx, {} as AudioNode, [clip]);
    audio.apply([{ kind: 'play', key: 'ambience', clips: [clip], offsetS: 0, loop: true, rate: 1, volume: .1 }]);
    expect(sources).toHaveLength(0);
    resolveFetch({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }); await ready();
    audio.apply([]); expect(sources).toHaveLength(1);
    audio.reset();
  });
});

describe('selected train interior audio', () => {
  const target = STATIONS.findIndex(s => s.name === '静安寺');
  const slot: OnboardAnnouncement = { station: '静安寺', direction: 'DN', source: 'ride-east', destination: '广兰路', doorSide: 'L', missingSentences: [],
    next: { clipId: 'test-departure', phraseAt: 19.79, delayS: 11.79, confidence: 'medium' },
    arrived: { clipId: 'test-arrival', phraseAt: 91, advanceS: 35, measuredAdvance: true, confidence: 'medium' } };
  const bank: SoundClip[] = [...SOUND_BANK,
    { id: 'test-departure', file: 'test-departure.mp3', kind: 'interior-departure', station: '静安寺', direction: 'DN', side: 'shared', source: 'ride-east', range: [17, 49], confidence: 'medium', both: false },
    { id: 'test-arrival', file: 'test-arrival.mp3', kind: 'interior-arrival', station: '静安寺', direction: 'DN', side: 'shared', source: 'ride-east', range: [91, 93], confidence: 'medium', both: false },
    { id: 'rolling', file: 'rolling.mp3', kind: 'interior-rolling', station: '江苏路', direction: 'shared', side: 'shared', source: 'ride-east', range: [947, 963], confidence: 'medium', both: false },
    { id: 'idle', file: 'idle.mp3', kind: 'interior-idle', station: '江苏路', direction: 'shared', side: 'shared', source: 'ride-east', range: [134, 146], confidence: 'medium', both: false }];
  const onboard = (t: number, patch: Partial<StationTrain> = {}, globals: Partial<OnboardAudioFrame> = {}): OnboardAudioFrame => ({
    t, rate: 1, paused: false, muted: false, enabled: true, willStop: true, destination: '广兰路', doorSide: 'L', train: tr({ nextStation: target, ...patch }), ...globals });
  const speech = (c: StationSoundCommand[]) => plays(c).filter(c => !c.loop);
  const planner = () => new OnboardSoundPlanner(bank, [slot], 10, 35);
  it('announces the exact next station once after the measured mean departure delay', () => {
    const p = planner(); p.update(onboard(100, { phase: 'dwell', v: 0, nextStation: station }));
    p.update(onboard(100.2, { phase: 'run', v: 0 })); p.update(onboard(100.4, { v: .005 }));
    for (let t = 101; t < 110; t++) p.update(onboard(t, { v: 4, distance: 1000 }));
    const commands = speech(p.update(onboard(110.4, { v: 4, distance: 1000 })));
    expect(commands).toHaveLength(1); expect(commands[0].clips.map(c => c.id)).toEqual(['test-departure']);
    expect(speech(p.update(onboard(110.6, { v: 4, distance: 1000 })))).toEqual([]);
  });
  it('waits for the worker to shift the departure stop without losing its onset time', () => {
    const p = planner(); p.update(onboard(100, { phase: 'dwell', v: 0, nextStation: station }));
    p.update(onboard(100.2, { v: .005, nextStation: station }, { willStop: false }));
    p.update(onboard(100.4, { v: .05, nextStation: target }));
    for (let t = 101; t < 110; t++) p.update(onboard(t, { v: 4, distance: 1000 }));
    expect(speech(p.update(onboard(110.2, { v: 4, distance: 1000 }))).map(c => c.clips[0]?.id)).toEqual(['test-departure']);
  });
  it('aligns X arrived to its recorded advance and accepts a partial late phrase', () => {
    const p = planner();
    const commands = speech(p.update(onboard(100, countdown(34.5, { nextStation: target }))));
    expect(commands[0].clips[0].id).toBe('test-arrival'); expect(commands[0].offsetS).toBeCloseTo(.5);
  });
  it.each([{ manual: true }, { mode: 'RM' as const }, { rm: true }, { mode: 'CM' as const }])('announces at the same position under manual/restricted driving %j', patch => {
    const commands = speech(planner().update(onboard(100, countdown(34.5, { nextStation: target, ...patch }))));
    expect(commands[0].clips[0].id).toBe('test-arrival'); expect(commands[0].offsetS).toBeCloseTo(.5);
  });
  it.each([{ failed: true }, { inService: false }, { eb: true }])('starts no announcement for a failed, empty or emergency-braked train %j', patch => {
    expect(speech(planner().update(onboard(100, countdown(35, { nextStation: target, ...patch }))))).toEqual([]);
  });
  it('lets a manual driver brake differently without cutting the phrase', () => {
    const p = planner();
    expect(speech(p.update(onboard(100, countdown(35, { nextStation: target, mode: 'CM', manual: true }))))).toHaveLength(1);
    const late = countdown(20, { nextStation: target, mode: 'CM', manual: true });
    expect(p.update(onboard(100.2, late)).filter(c => c.kind === 'stop' && c.fadeS)).toEqual([]);
  });
  const holds = (c: StationSoundCommand[]) => speech(c).filter(c => c.clips[0]?.id === ONBOARD_HOLD_CLIP.id);
  const standing = { phase: 'run' as const, v: 0, a: 0, distance: 500 };
  it('asks passengers to wait after standing between stations, then repeats', () => {
    const p = planner(), at = 100 + ONBOARD_HOLD_DELAY_S;
    for (let t = 100; t < at; t += .5) expect(holds(p.update(onboard(t, standing)))).toEqual([]);
    expect(holds(p.update(onboard(at, standing)))).toHaveLength(1);
    for (let t = at + .5; t < at + ONBOARD_HOLD_REPEAT_S; t += .5) expect(holds(p.update(onboard(t, standing)))).toEqual([]);
    expect(holds(p.update(onboard(at + ONBOARD_HOLD_REPEAT_S, standing)))).toHaveLength(1);
  });
  // (the planner resets across a gap in frames, so standing is fed in steps)
  const stand = (p: OnboardSoundPlanner, from: number, to: number, patch: Partial<StationTrain> = {}) => {
    let n = 0;
    for (let t = from; t <= to + 1e-9; t += .5) n += holds(p.update(onboard(t, { ...standing, ...patch }))).length;
    return n;
  };
  it.each([{ failed: true, phase: 'failed' as const }, { eb: true }, { mode: 'RM' as const, manual: true }])('also announces a stop by failure, emergency brake or manual driving %j', patch => {
    expect(stand(planner(), 100, 100 + ONBOARD_HOLD_DELAY_S, patch)).toBe(1);
  });
  it('keeps quiet at a station stop, for an empty train, and restarts the wait after moving', () => {
    expect(stand(planner(), 100, 200, { phase: 'dwell' })).toBe(0);
    expect(stand(planner(), 100, 200, { inService: false })).toBe(0);
    const p = planner();
    const moved = 100 + ONBOARD_HOLD_DELAY_S / 2;
    expect(stand(p, 100, moved - .5)).toBe(0);
    p.update(onboard(moved, { ...standing, v: 2 }));
    expect(stand(p, moved + .5, moved + ONBOARD_HOLD_DELAY_S)).toBe(0);
    expect(stand(p, moved + .5 + ONBOARD_HOLD_DELAY_S, moved + .5 + ONBOARD_HOLD_DELAY_S)).toBe(1);
  });
  it('is not cut when the train moves off, and waits for a phrase already playing', () => {
    const p = planner();
    expect(stand(p, 100, 100 + ONBOARD_HOLD_DELAY_S)).toBe(1);
    const moving = p.update(onboard(100.5 + ONBOARD_HOLD_DELAY_S, { v: 4, distance: 1000 }, { willStop: false }));
    expect(moving.filter(c => c.kind === 'stop' && c.key === 'hold')).toEqual([]);
    // a manual driver stops short while a long arrival phrase is still playing
    const long = bank.map(c => c.id === 'test-arrival' ? { ...c, range: [91, 131] as [number, number] } : c);
    const q = new OnboardSoundPlanner(long, [slot], 10, 35), manual = { mode: 'CM' as const, manual: true };
    expect(speech(q.update(onboard(100, countdown(35, { nextStation: target, ...manual }))))).toHaveLength(1);
    expect(stand(q, 100.5, 139.5, manual)).toBe(0);
    expect(stand(q, 140, 140, manual)).toBe(1);
  });
  it('does not announce passing calls, unavailable stations, or the unrecorded direction', () => {
    expect(speech(planner().update(onboard(100, countdown(35, { nextStation: target }), { willStop: false })))).toEqual([]);
    expect(speech(planner().update(onboard(100, countdown(35, { nextStation: target + 1 }))))).toEqual([]);
    expect(speech(planner().update(onboard(100, countdown(35, { nextStation: target, direction: 'UP' }))))).toEqual([]);
  });
  it.each([{ paused: true }, { muted: true }, { enabled: false }, { rate: 10 }, { train: null }])('stops cabin audio under the common gate %j', globals => {
    const p = planner(); p.update(onboard(100));
    expect(p.update(onboard(100.2, {}, globals)).filter(c => c.kind === 'stop')).toHaveLength(2);
  });
  it('adds speed-dependent rolling and very quiet standing ambience', () => {
    const still = cabinVolumes(0), moving = cabinVolumes(15);
    expect(still.rolling).toBe(0); expect(still.idle).toBeGreaterThan(0); expect(still.idle).toBe(1); // floor is normalised to its measured quiet level, not PA level
    expect(moving.rolling).toBeGreaterThan(still.rolling);
    const p = planner(); expect(plays(p.update(onboard(100, { v: 0, phase: 'dwell' }))).filter(c => c.loop)).toHaveLength(2);
    expect(p.update(onboard(100.2, { v: 10 })).filter(c => c.kind === 'volume')).toHaveLength(2);
  });
  it('does not invent a departure announcement when joining a moving train', () => {
    const p = planner(); expect(speech(p.update(onboard(100, { v: 4, distance: 1000 })))).toEqual([]);
    expect(speech(p.update(onboard(100.2, { v: 4, distance: 1000 })))).toEqual([]);
  });
  it('uses the valid-stop mean advance for a low-confidence stop anchor', () => {
    const p = new OnboardSoundPlanner(bank, [{ ...slot, arrived: { ...slot.arrived!, advanceS: 65, measuredAdvance: false } }], 10, 35);
    expect(speech(p.update(onboard(100, countdown(35, { nextStation: target })))).map(c => c.clips[0].id)).toEqual(['test-arrival']);
  });
  it('keeps all recorded whole bilingual messages and measured complete-message onsets', () => {
    expect(ORIGINAL_ONBOARD.filter(a => a.direction === 'DN' && a.type === 'next')).toHaveLength(12);
    expect(ORIGINAL_ONBOARD.filter(a => a.direction === 'DN' && a.type === 'arrived')).toHaveLength(13);
    expect(ORIGINAL_ONBOARD.filter(a => a.direction === 'UP')).toHaveLength(2);
    expect(ONBOARD_ANNOUNCEMENTS.find(a => a.station === '金科路' && a.direction === 'DN' && a.destination === '广兰路')!.next).toBeDefined();
    expect(ONBOARD_NEXT_DELAY_S).toBeGreaterThan(6); expect(ONBOARD_NEXT_DELAY_S).toBeLessThan(9);
    expect(ONBOARD_ARRIVAL_ADVANCE_S).toBeGreaterThan(30); expect(ONBOARD_ARRIVAL_ADVANCE_S).toBeLessThan(36);
  });
  it('fades a previously correct announcement when the selected train terminus changes', () => {
    const p = planner(); p.update(onboard(100, countdown(35, { nextStation: target })));
    expect(p.update(onboard(100.2, countdown(34.8, { nextStation: target }), { destination: '浦东1号2号航站楼' })).filter(c => c.kind === 'stop' && c.fadeS === .5)).toHaveLength(1);
  });
  it('projects the worker single-train skip flag and global platform skip into willStop', () => {
    const heard = { ...tr({ nextStation: target }), stopDist: 1000, link: 0, dir: 1, tripId: -1, nextStopSkipped: true } as unknown as Snapshot['trains'][number];
    const topo = { links: [{ platform: -1, track: 'DN' }], platforms: [], stations: Array.from({ length: target + 1 }, () => ({ platforms: { DN: 0, UP: 1 } })) } as unknown as Topology;
    const snap = { t: 100, speed: 1, paused: false, platforms: new Uint8Array(2) } as unknown as Snapshot;
    expect(onboardFrame(snap, heard, topo, null).willStop).toBe(false);
    heard.nextStopSkipped = false; expect(onboardFrame(snap, heard, topo, null).willStop).toBe(true);
    snap.platforms[0] = 2; expect(onboardFrame(snap, heard, topo, null).willStop).toBe(false);
  });
});

describe('whole carriage PA, exact terminus and pre-rendered compositions', () => {
  const clip = (id: string) => SOUND_BANK.find(c => c.id === id)!;
  const pa = (station: string, direction: 'DN' | 'UP', destination: string) => onboardAnnouncement(station, direction, destination,
    onboardDoorSide(STATIONS.findIndex(s => s.name === station), direction, destination))!;
  it('prefers original complete audio for a matching journey, without fragment concatenation', () => {
    const a = pa('静安寺', 'DN', '广兰路');
    expect(clip(a.next!.clipId).provenance).toBe('original');
    expect(clip(a.next!.clipId).range).toEqual([17.16, 49.5]);
    expect(clip(a.next!.clipId).composition).toBeUndefined();
    expect(clip(pa('金科路', 'UP', '蟠祥路·国家会计学院').next!.clipId).provenance).toBe('original');
  });
  it('replaces the western terminus using the carriage voice and retains this station body', () => {
    const c = clip(pa('静安寺', 'UP', '蟠祥路·国家会计学院').next!.clipId);
    expect(c.provenance).toBe('composed');
    expect(c.composition).toEqual(['zh-terminus', 'zh-name-pxl', 'original-next-dn-jas-body']);
    expect(VOICE_PARTS.find(p => p.id === 'zh-name-pxl')!.source).toBe('ride-west');
  });
  it('uses airport terminal name in both languages, never the old Guanglan terminus', () => {
    const c = clip(pa('世纪大道', 'DN', '浦东1号2号航站楼').next!.clipId);
    expect(c.composition).toEqual(['zh-terminus', 'zh-name-pda', 'original-next-dn-sjd-body-zh', 'en-terminus', 'en-name-pda', 'original-next-dn-sjd-body-en']);
    const original = ORIGINAL_ONBOARD.find(a => a.id === 'original-next-dn-sjd')!;
    expect(VOICE_PARTS.find(p => p.id === 'original-next-dn-sjd-body-zh')!.range[0]).toBe(original.destinationSentence![1]);
  });
  it.each(['世纪公园', '龙阳路', '张江高科', '金科路'])('keeps the recorded transfer on short route, removes it for airport at %s', station => {
    const short = clip(pa(station, 'DN', '广兰路').arrived!.clipId);
    const airport = clip(pa(station, 'DN', '浦东1号2号航站楼').arrived!.clipId);
    expect(short.provenance).toBe('original');
    const original = ORIGINAL_ONBOARD.find(a => a.id === short.id)!;
    expect(original.transferRange).toBeDefined();
    if (station === '金科路') {
      // The opposite-direction whole recording has no short-turn transfer.
      expect(airport.provenance).toBe('original');
      expect(airport.recordedDirection).toBe('UP');
      expect(airport.range).toEqual([111.48, 130.2]);
      return;
    }
    expect(airport.provenance).toBe('original'); expect(airport.composition).toBeUndefined();
    expect(airport.range[0]).toBe(original.range[0]);
    expect(airport.range[1]).toBe(original.transferRange![0]);
  });
  it('plain arrivals remain original across termini in the same direction', () => {
    expect(pa('陆家嘴', 'DN', '广兰路').arrived!.clipId).toBe(pa('陆家嘴', 'DN', '浦东1号2号航站楼').arrived!.clipId);
  });
  it('never plays Guanglan terminal/clear-out or left-door notices on the through side platform', () => {
    const gll = STATIONS.findIndex(s => s.id === 'GLL');
    expect(onboardDoorSide(gll, 'DN', '广兰路')).toBe('L'); expect(onboardDoorSide(gll, 'DN', '浦东1号2号航站楼')).toBe('R');
    const a = pa('广兰路', 'DN', '浦东1号2号航站楼');
    expect(a.missingSentences).toEqual([]);
    expect(clip(a.next!.clipId).composition).toContain('zh-right');
    expect(clip(a.next!.clipId).composition).toContain('en-right');
    expect(clip(a.next!.clipId).composition).not.toContain('zh-left');
    expect(clip(a.arrived!.clipId).composition).not.toContain('original-arrived-dn-gll');
  });
  it('uses recorded JSL announcements first and the permitted platform name only for remaining gaps', () => {
    for (const dest of ONBOARD_DESTINATIONS) for (const dir of ['DN', 'UP'] as const) {
      const a = pa('江苏路', dir, dest);
      expect(a.missingSentences).toEqual([]);
      for (const id of [a.next!.clipId, a.arrived!.clipId]) {
        const c = clip(id);
        if (id === a.arrived!.clipId || dir === 'DN' && dest === '浦东1号2号航站楼') {
          expect(c.provenance).toBe('original'); expect(c.composition).toBeUndefined(); continue;
        }
        expect(c.provenance).toBe('composed');
        expect(c.composition).toContain('zh-name-jsl');
        expect(c.composition).toContain('jsl-proper-name');
        expect(c.composition).toContain('en-road');
        const name = VOICE_PARTS.find(p => p.id === 'zh-name-jsl')!;
        expect(name.source).toBe('platform-01'); expect(name.name).toBe('江苏路');
        expect(name.speaker).toBe('platform-zh');
      }
    }
  });
  it('cannot replace an absent station or terminus name with another station', () => {
    expect(onboardAnnouncement('唐镇', 'DN', '广兰路', 'L')).toBeUndefined();
    expect(onboardAnnouncement('静安寺', 'DN', '淞虹路', 'L')).toBeUndefined();
  });
  it('adds western PA from the available names, with independent local files for every new cut', () => {
    for (const station of ['国家会展中心', '虹桥火车站', '虹桥2号航站楼', '淞虹路', '威宁路', '娄山关路', '中山公园']) {
      for (const dir of ['DN', 'UP'] as const) for (const dest of ONBOARD_DESTINATIONS) {
        const a = pa(station, dir, dest);
        expect(a.missingSentences).toEqual([]);
        for (const id of [a.next!.clipId, a.arrived!.clipId]) {
          const c = clip(id);
          if (c.provenance === 'original') { expect(c.composition).toBeUndefined(); continue; }
          expect(c.composition).toContain(`zh-name-${STATIONS.find(s => s.name === station)!.id.toLowerCase()}`);
          expect(c.composition).toContain(`en-name-${STATIONS.find(s => s.name === station)!.id.toLowerCase()}`);
        }
      }
    }
    expect(FIELD_1016_VOICE_PARTS.every(p => p.file?.endsWith('.mp3'))).toBe(true);
    expect(new Set(FIELD_1016_VOICE_PARTS.map(p => p.file)).size).toBe(FIELD_1016_VOICE_PARTS.length);
  });
  it('fills Chinese BXJ from the cabin video while retaining its recorded English name', () => {
    const name = VOICE_PARTS.find(p => p.id === 'zh-name-bxj')!;
    expect(name.source).toBe('cabin-reference');
    expect(name.range).toEqual([25.78, 26.84]);
    expect(VOICE_PARTS.find(p => p.id === 'en-name-bxj')!.source).toBe('ride-1016-east-night');
    for (const dir of ['DN', 'UP'] as const) for (const dest of ONBOARD_DESTINATIONS) {
      const a = pa('北新泾', dir, dest);
      expect(a.missingSentences).toEqual([]);
      for (const id of [a.next!.clipId, a.arrived!.clipId]) {
        const c = clip(id);
        if (c.provenance === 'original') { expect(c.composition).toBeUndefined(); continue; }
        const recipe = c.composition!;
        expect(recipe).toContain('en-name-bxj');
        expect(recipe).toContain('zh-name-bxj');
        expect(recipe.indexOf('zh-name-bxj')).toBeLessThan(recipe.indexOf('en-name-bxj'));
      }
    }
  });
  it('restricts terminal clear-out to the westbound PXL terminal arrival and keeps its full source range', () => {
    const a = pa('蟠祥路·国家会计学院', 'UP', '蟠祥路·国家会计学院');
    expect(clip(a.arrived!.clipId)).toEqual(FIELD_1016_TERMINAL_CLIP);
    expect(clip(a.arrived!.clipId).range).toEqual([907.20, 934.80]);
    expect(clip(a.next!.clipId).id).toBe('field-original-next-up-pxl');
    expect(clip(a.next!.clipId).provenance).toBe('original');
    expect(clip(a.next!.clipId).composition).toBeUndefined();
    expect(onboardAnnouncement('蟠祥路·国家会计学院', 'DN', '广兰路', 'L')).toBeUndefined();
    expect(onboardAnnouncement('蟠祥路·国家会计学院', 'UP', '浦东1号2号航站楼', 'L')).toBeUndefined();
    expect(ORIGINAL_ONBOARD.some(row => row.id === FIELD_1016_TERMINAL_CLIP.id)).toBe(false);
  });
  it('uses the video next-station phrase for SHR instead of an uncertain terminus word', () => {
    const name = VOICE_PARTS.find(p => p.id === 'zh-name-shr')!;
    expect(name.source).toBe('cabin-reference'); expect(name.range).toEqual([179.08, 179.98]);
    expect(clip(pa('淞虹路', 'UP', '蟠祥路·国家会计学院').next!.clipId).id).toBe('field-original-next-up-shr');
  });
  it('prefers every exact compatible whole recording and leaves incompatible termini composed', () => {
    for (const row of RECORDED_ONBOARD) {
      const destination = row.type === 'next' || row.transferRange || row.terminalOnly ? row.recordedDestination : ONBOARD_DESTINATIONS[0];
      if (!ONBOARD_DESTINATIONS.some(d => d === destination)) continue;
      const a = onboardAnnouncement(row.station, row.direction, destination, row.doorSide);
      if (!a) continue;
      const id = row.type === 'next' ? a.next?.clipId : a.arrived?.clipId;
      expect(clip(id!).provenance).toBe('original');
      expect(clip(id!).composition).toBeUndefined();
    }
    expect(clip(pa('国家会展中心', 'UP', '浦东1号2号航站楼').next!.clipId).provenance).toBe('composed');
    expect(clip(pa('国家会展中心', 'UP', '蟠祥路·国家会计学院').next!.clipId).id).toBe('field-original-next-up-gjh');
  });
  it('uses both-side wording at eastbound HQ2 even when the physical snapshot supplies L', () => {
    const st = STATIONS.findIndex(s => s.id === 'HQ2');
    expect(onboardDoorSide(st, 'DN', '浦东1号2号航站楼')).toBe('B');
    expect(onboardDoorSide(st, 'UP', '蟠祥路·国家会计学院')).toBe('L');
    const a = pa('虹桥2号航站楼', 'DN', '浦东1号2号航站楼');
    expect(clip(a.next!.clipId).composition).toContain('zh-both');
    expect(clip(a.next!.clipId).composition).toContain('en-both');
    expect(clip(a.next!.clipId).composition).not.toContain('zh-left');
    expect(clip(a.arrived!.clipId).provenance).toBe('original');
    expect(clip(a.arrived!.clipId).doorSide).toBe('B');
    const topo = { links: [{ platform: -1, track: 'DN' }], platforms: [], stations: STATIONS.map(() => ({ platforms: { DN: 0, UP: 1 } })) } as unknown as Topology;
    const train = { ...tr({ nextStation: st, direction: 'DN' }), link: 0, dir: 1, stopDist: 1000, task: '停站 虹桥2号航站楼', dest: '浦东1号2号航站楼', platSide: 'L' } as unknown as TrainSnap;
    const snap = { t: 100, speed: 1, paused: false, platforms: new Uint16Array(2) } as unknown as Snapshot;
    expect(onboardFrame(snap, train, topo, null).doorSide).toBe('B');
  });
  it('rejects different speakers within a language except the explicit JSL proper-name exception', () => {
    const zh = VOICE_PARTS.find(p => p.id === 'zh-next')!;
    const platform = VOICE_PARTS.find(p => p.id === 'zh-name-jsl')!;
    expect(compatibleVoiceRecipe([zh, platform], '虹桥火车站')).toBe(false);
    expect(compatibleVoiceRecipe([zh, platform], '江苏路')).toBe(true);
    expect(compatibleVoiceRecipe([zh, { ...platform, id: 'another-platform-name' }], '江苏路')).toBe(false);
    for (const c of SOUND_BANK.filter(c => c.composition)) {
      expect(compatibleVoiceRecipe(c.composition!.map(id => VOICE_PARTS.find(p => p.id === id)!), c.station)).toBe(true);
    }
  });
  it('records every composed source part and a 30 ms join budget', () => {
    expect(VOICE_CROSSFADE_S).toBe(.03);
    const ids = new Set(VOICE_PARTS.map(p => p.id));
    for (const c of SOUND_BANK.filter(c => c.provenance === 'composed')) {
      expect(c.composition!.every(p => ids.has(p))).toBe(true);
      expect(clipDuration(c)).toBeGreaterThan(0);
    }
    expect(RECORDED_VOLUME_GAINS.small).toBeLessThan(RECORDED_VOLUME_GAINS.medium);
    expect(RECORDED_VOLUME_GAINS.large).toBeGreaterThan(RECORDED_VOLUME_GAINS.medium);
  });
  it('persists the three volume choices and rejects stale preference values', () => {
    const prefs = new Map<string, string>();
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    vi.stubGlobal('localStorage', { getItem: (k: string) => prefs.get(k) ?? null, setItem: (k: string, v: string) => prefs.set(k, v) });
    const audio = new Audio(); audio.setRecordedVolume('large'); expect(new Audio().recordedVolume).toBe('large');
    audio.setRecordedVolume('small'); expect(new Audio().recordedVolume).toBe('small');
    prefs.set('ats2.recordedVolume', JSON.stringify('stale')); expect(new Audio().recordedVolume).toBe('medium');
  });
});
