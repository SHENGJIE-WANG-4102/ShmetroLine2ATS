import { afterEach, describe, expect, it, vi } from 'vitest';
import { VVVF_TAKES } from '../src/data/vvvf';
import { chooseVvvfTake, inverterMode, VvvfSound, vvvfTimeAt } from '../src/ui/vvvf';
import type { TrainSnap } from '../src/sim/model';

const identity = { vehicle: '02113', runStartedAt: 43100.1, t: 43118 };
const train = (patch: Partial<TrainSnap> = {}) => ({ vehicle: '02113', phase: 'run', v: 18, a: 0, manual: false,
  atoPhase: 'coast', eb: false, failed: false, ...patch }) as TrainSnap;
afterEach(() => { vi.unstubAllGlobals(); });

describe('local inverter take selection and motor phases', () => {
  it('chooses from all four takes by stock and run start, independent of view time or call history', () => {
    for (const clip of ['power', 'brake'] as const) {
      const expected = chooseVvvfTake(identity, clip);
      expect(expected).toBeDefined();
      expect(chooseVvvfTake({ ...identity, t: 90000 }, clip)).toBe(expected);
      expect(chooseVvvfTake({ ...identity, runStartedAt: identity.runStartedAt - 86400 }, clip)).toBe(expected);
      const ids = new Set(Array.from({ length: 100 }, (_, n) => chooseVvvfTake({ ...identity, runStartedAt: n * 19.1 }, clip)?.id));
      expect(ids.size).toBe(4);
    }
    expect(chooseVvvfTake({ ...identity, vehicle: '0201' }, 'power')).toBeUndefined();
    expect(chooseVvvfTake({ ...identity, vehicle: 'unknown' }, 'power')).toBeUndefined();
    expect(chooseVvvfTake(identity, 'power', [])).toBeUndefined();
    expect(chooseVvvfTake(identity, 'brake', [VVVF_TAKES[1]])).toBe(VVVF_TAKES[1]);
  });
  it('silences stable coast, retains actual residual traction, and gives safety braking priority', () => {
    expect(inverterMode(train())).toBe('off');
    expect(inverterMode(train({ a: .1 }))).toBe('power');
    expect(inverterMode(train({ atoPhase: 'hold', a: .02 }))).toBe('cruise');
    expect(inverterMode(train({ atoPhase: 'traction', a: -.6 }))).toBe('brake');
    expect(inverterMode(train({ atoPhase: 'hold', a: -.6 }))).toBe('brake');
    expect(inverterMode(train({ atoPhase: 'brake', a: -.04 }))).toBe('off');
  });
  it('uses manual effort and excludes unsupported stock, stops and emergency friction braking', () => {
    expect(inverterMode(train({ manual: true, atoPhase: 'hold', a: .1 }))).toBe('power');
    expect(inverterMode(train({ manual: true, atoPhase: 'hold', a: 0 }))).toBe('off');
    expect(inverterMode(train({ manual: true, a: -.6 }))).toBe('brake');
    for (const patch of [{ vehicle: '0201' }, { eb: true }, { failed: true }, { v: 0 }, { phase: 'dwell' as const }]) {
      expect(inverterMode(train({ a: .7, atoPhase: 'traction', ...patch }))).toBe('off');
    }
  });
  it('each take maps both speed directions, with measured steady ends handled by resampling', () => {
    for (const take of VVVF_TAKES) for (const kind of ['power', 'brake'] as const) {
      const { table, plateau } = take[kind];
      expect(table.length).toBeGreaterThan(5);
      expect(vvvfTimeAt(table, 0)).toBe(kind === 'power' ? table[0][0] : table.at(-1)![0]);
      expect(Number.isFinite(vvvfTimeAt(table, 40))).toBe(true);
      expect(vvvfTimeAt(table, 200)).toBeNaN();
      expect(plateau[1]).toBeGreaterThan(plateau[0]);
      expect(table.every(([t, f], i) => t >= 0 && f >= 0 && (!i || t > table[i - 1][0]))).toBe(true);
    }
  });
  it('missing local recordings stay silent without scheduling or an unhandled rejection', async () => {
    const gain = { value: 0, setTargetAtTime: vi.fn() };
    const ctx = { currentTime: 1, createGain: () => ({ gain, connect: vi.fn() }), decodeAudioData: vi.fn(), createBufferSource: vi.fn() };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    const sound = new VvvfSound(ctx as unknown as AudioContext, {} as AudioNode);
    await new Promise(resolve => setTimeout(resolve, 0));
    sound.set('power', 10, 1, identity);
    expect(gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 1, .12);
    expect(ctx.decodeAudioData).not.toHaveBeenCalled();
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
  });
});
