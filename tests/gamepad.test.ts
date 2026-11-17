import { describe, expect, it } from 'vitest';
import {
  PadMapper, STANDARD_DEFAULTS, bindingsFor, conflictOf, emptyBindings, scanInputs, ChordScanner, REPEAT_FIRST_MS, REPEAT_EVERY_MS,
  type PadSample,
} from '../src/ui/gamepad';

const pad = (over: Partial<PadSample> = {}): PadSample => ({ id: 'x', standard: true, buttons: Array(17).fill(0), axes: [0, 0, 0, 0], ...over });
const withButtons = (...idx: number[]) => pad({ buttons: Array.from({ length: 17 }, (_, i) => (idx.includes(i) ? 1 : 0)) });

describe('gamepad mapping', () => {
  it('turns a press into one down and a release into one up', () => {
    const m = new PadMapper();
    expect(m.step(withButtons(), STANDARD_DEFAULTS, 0)).toEqual([]);
    expect(m.step(withButtons(4), STANDARD_DEFAULTS, 10)).toEqual([{ action: 'doorL', phase: 'down', repeat: false }]);
    expect(m.step(withButtons(4), STANDARD_DEFAULTS, 20)).toEqual([]);
    expect(m.step(withButtons(), STANDARD_DEFAULTS, 30)).toEqual([{ action: 'doorL', phase: 'up', repeat: false }]);
  });

  it('repeats only the notch steps while held, at a fixed rate', () => {
    const m = new PadMapper();
    const up = pad({ axes: [0, -1, 0, 0] });
    expect(m.step(up, STANDARD_DEFAULTS, 0)).toHaveLength(1);
    expect(m.step(up, STANDARD_DEFAULTS, REPEAT_FIRST_MS - 1)).toEqual([]);
    expect(m.step(up, STANDARD_DEFAULTS, REPEAT_FIRST_MS)).toEqual([{ action: 'notchUp', phase: 'down', repeat: true }]);
    expect(m.step(up, STANDARD_DEFAULTS, REPEAT_FIRST_MS + REPEAT_EVERY_MS - 1)).toEqual([]);
    expect(m.step(up, STANDARD_DEFAULTS, REPEAT_FIRST_MS + REPEAT_EVERY_MS)).toHaveLength(1);
    // a held door button never repeats
    const m2 = new PadMapper();
    m2.step(withButtons(4), STANDARD_DEFAULTS, 0);
    expect(m2.step(withButtons(4), STANDARD_DEFAULTS, 5000)).toEqual([]);
  });

  it('emergency brake needs the chord, not one trigger', () => {
    const m = new PadMapper();
    expect(m.step(withButtons(6), STANDARD_DEFAULTS, 0)).toEqual([]);
    expect(m.step(withButtons(6, 7), STANDARD_DEFAULTS, 10)).toEqual([{ action: 'emergency', phase: 'down', repeat: false }]);
  });

  it('release() lets go of everything held (pad unplugged, window blurred)', () => {
    const m = new PadMapper();
    m.step(withButtons(2), STANDARD_DEFAULTS, 0);
    expect(m.release()).toEqual([{ action: 'atoF', phase: 'up', repeat: false }]);
    expect(m.release()).toEqual([]);
  });

  it('only a pad that reports the standard layout gets default bindings', () => {
    expect(bindingsFor(undefined, pad())).toBe(STANDARD_DEFAULTS);
    expect(bindingsFor(undefined, pad({ standard: false }))).toEqual(emptyBindings());
    const mine = { ...emptyBindings(), doorL: [[{ kind: 'button' as const, index: 20 }]] };
    expect(bindingsFor(mine, pad({ standard: false })).doorL).toEqual(mine.doorL);
  });
});

describe('gamepad scan', () => {
  it('finds a newly pressed button, including indices beyond the standard 17', () => {
    const rest = pad({ buttons: Array(20).fill(0) });
    const now = pad({ buttons: Array.from({ length: 20 }, (_, i) => (i === 18 ? 1 : 0)) });
    expect(scanInputs(rest, now)).toEqual([{ kind: 'button', index: 18 }]);
  });

  it('ignores inputs that were already active, and a trigger axis resting at -1', () => {
    const rest = pad({ buttons: Array.from({ length: 17 }, (_, i) => (i === 3 ? 1 : 0)), axes: [0.2, 0, -1, -1] });
    expect(scanInputs(rest, rest)).toEqual([]);
    expect(scanInputs(rest, { ...rest, axes: [0.2, 0, -1, 1] })).toEqual([{ kind: 'axis', index: 3, dir: 1 }]);
  });

  it('records the pushed direction of a stick', () => {
    expect(scanInputs(pad(), pad({ axes: [0, -0.9, 0, 0] }))).toEqual([{ kind: 'axis', index: 1, dir: -1 }]);
    expect(scanInputs(pad(), pad({ axes: [0, -0.4, 0, 0] }))).toEqual([]);
  });

  it('reports which action already holds an input', () => {
    expect(conflictOf(STANDARD_DEFAULTS, [{ kind: 'button', index: 4 }], 'doorR')).toBe('doorL');
    expect(conflictOf(STANDARD_DEFAULTS, [{ kind: 'button', index: 4 }], 'doorL')).toBeNull();
    // chord members are not single-input conflicts
    expect(conflictOf(STANDARD_DEFAULTS, [{ kind: 'button', index: 6 }], 'doorL')).toBeNull();
  });
});

describe('gamepad combinations', () => {
  const b = (index: number) => ({ kind: 'button' as const, index });
  // LB + D-pad up = emergency; LB alone = left door; D-pad up alone = notch up
  const bindings = { ...STANDARD_DEFAULTS, emergency: [[b(4), b(12)]], notchUp: [[b(12)]], doorL: [[b(4)]] };
  const acts = (e: { action: string; phase: string }[]) => e.map(x => `${x.action}:${x.phase}`);

  it('combo fires on completion and silences the keys it uses alone', () => {
    const m = new PadMapper();
    expect(m.step(withButtons(4), bindings, 0)).toEqual([]);
    expect(acts(m.step(withButtons(4, 12), bindings, 10))).toEqual(['emergency:down']);
    expect(acts(m.step(withButtons(4), bindings, 20))).toEqual(['emergency:up']);
    expect(m.step(withButtons(), bindings, 30)).toEqual([]);
  });

  it('a lone tap of the shared button fires on release', () => {
    const m = new PadMapper();
    expect(m.step(withButtons(4), bindings, 0)).toEqual([]);
    expect(acts(m.step(withButtons(), bindings, 50))).toEqual(['doorL:down', 'doorL:up']);
  });

  it('every member of a combo waits for release when used alone; other buttons are immediate', () => {
    const m = new PadMapper();
    expect(m.step(withButtons(12), bindings, 0)).toEqual([]);
    expect(acts(m.step(withButtons(), bindings, 10))).toEqual(['notchUp:down', 'notchUp:up']);
    expect(acts(m.step(withButtons(2), bindings, 20))).toEqual(['atoF:down']);
  });

  it('a smaller combo inside a bigger one is silenced', () => {
    const big = { ...STANDARD_DEFAULTS, doorL: [[b(4), b(12)]], doorR: [[b(4), b(12), b(13)]] };
    const m = new PadMapper();
    expect(acts(m.step(withButtons(4, 12, 13), big, 0))).toEqual(['doorR:down']);
  });
});

describe('chord scan', () => {
  it('records the held set when everything is released', () => {
    const sc = new ChordScanner(pad());
    expect(sc.feed(withButtons(4))).toBeNull();
    expect(sc.feed(withButtons(4, 12))).toBeNull();
    expect(sc.feed(withButtons(12))).toBeNull();
    expect(sc.feed(withButtons())).toEqual([{ kind: 'button', index: 4 }, { kind: 'button', index: 12 }]);
  });
  it('a single press records a single input', () => {
    const sc = new ChordScanner(pad());
    sc.feed(withButtons(2));
    expect(sc.feed(withButtons())).toEqual([{ kind: 'button', index: 2 }]);
  });
});
