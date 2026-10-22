import { describe, it, expect } from 'vitest';
import { stopViewScale, FREEZE_REM, departureSeconds, departureText, stopViewDoorState } from '../src/ui/stopview';

describe('stopping close-up scale', () => {
  it('distinguishes closing from open and locked, including a manually opened far-side door', () => {
    expect(stopViewDoorState({doors:true,doorSide:'',doorClosing:true},true)).toBe('closing');
    expect(stopViewDoorState({doors:true,doorSide:'',doorClosing:true},false)).toBe('closed');
    expect(stopViewDoorState({doors:false,doorSide:'R',doorClosing:true},false)).toBe('closing');
    expect(stopViewDoorState({doors:false,doorSide:'',doorClosing:false},true)).toBe('closed');
  });
  it('counts down through zero, then counts overtime; hold is H, off five seconds after head exit', () => {
    expect(departureSeconds(100, 72)).toBe(28);
    expect(departureSeconds(100, 79)).toBe(21);
    expect(departureSeconds(100, 100)).toBe(0);
    expect(departureSeconds(100, 101)).toBe(1);
    expect(departureSeconds(-1, 72)).toBeNull();
    const board={at:100,signalName:'test',signalOffset:6,aspect:'R' as const,held:false,remaining:0,side:'L' as const,station:12};
    expect(departureText({...board,held:true},79)).toBe('H');
    expect(departureText({...board,held:true},105)).toBe('H');
    expect(departureText({...board,headLeftAt:102},106.9)).toBe('6');
    expect(departureText({...board,headLeftAt:102},107)).toBeNull();
    expect(departureText({...board,headLeftAt:102,held:true},107)).toBeNull();
  });
  it('fits the departure signal beyond the stop without a zoom discontinuity', () => {
    for (const rem of [300, FREEZE_REM, 10, 0, -1]) {
      const {px, xe} = stopViewScale(rem, 20);
      expect(xe + (rem + 15) * px).toBeLessThan(760);
    }
    expect(stopViewScale(FREEZE_REM + 1e-6, 20).px).toBeCloseTo(stopViewScale(FREEZE_REM, 20).px, 5);
  });
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
