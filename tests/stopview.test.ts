import { describe, it, expect } from 'vitest';
import { stopViewScale, FREEZE_REM } from '../src/ui/stopview';

describe('stopping close-up scale', () => {
  it('zooms in with the distance, then stops zooming once the cab reaches PSD door 2-5', () => {
    expect(FREEZE_REM).toBeCloseTo(23.25 + 3 + 4 * 4.6 - 1.8);
    const far = stopViewScale(300), at = stopViewScale(FREEZE_REM), near = stopViewScale(10), stop = stopViewScale(0);
    expect(far.px).toBeLessThan(at.px);
    expect(near.px).toBe(at.px);
    expect(stop.px).toBe(at.px);
    // just outside the freeze the picture does not jump
    const before = stopViewScale(FREEZE_REM + 1e-6);
    expect(before.px).toBeCloseTo(at.px, 5); expect(before.xe).toBeCloseTo(at.xe, 3);
  });
  it('keeps the stopping mark still on screen and moves the train at the fixed scale', () => {
    const mark = (rem: number) => { const s = stopViewScale(rem); return s.xe + rem * s.px; };
    expect(mark(30)).toBeCloseTo(mark(0));
    const a = stopViewScale(20), b = stopViewScale(10);
    expect(b.xe - a.xe).toBeCloseTo(10 * a.px);
  });
});
