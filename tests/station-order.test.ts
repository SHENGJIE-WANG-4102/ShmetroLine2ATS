import { afterEach, describe, expect, it } from 'vitest';
import { ahead, between, setStationOrder, stationPath } from '../src/sim/topologyOrder';

// 0-1-2-3-4 is the main run (DN = rising index); 5-6 is a branch that joins at 2:
//   0 - 1 \
//          2 - 3 - 4
//   5 - 6 /
const BRANCHED = [1, 2, 3, 4, -1, 6, 2];

describe('station order', () => {
  afterEach(() => setStationOrder(null));

  it('a line without a registered order runs in array order', () => {
    expect(ahead('DN', 1, 3)).toBe(true); expect(ahead('DN', 3, 1)).toBe(false);
    expect(ahead('UP', 3, 1)).toBe(true); expect(ahead('DN', 2, 2)).toBe(false);
    expect(stationPath(1, 4)).toEqual([1, 2, 3, 4]); expect(stationPath(3, 1)).toEqual([3, 2, 1]);
    expect(stationPath(2, 2)).toEqual([2]);
    expect(between(2, 3, 1)).toBe(true); expect(between(4, 1, 3)).toBe(false);
  });

  it('a registered single run answers exactly like array order', () => {
    const linear = [1, 2, 3, 4, -1];
    const expected: unknown[] = [], got: unknown[] = [];
    const probe = (out: unknown[]) => { for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) {
      out.push(ahead('DN', a, b), ahead('UP', a, b), stationPath(a, b));
      for (let s = 0; s < 5; s++) out.push(between(s, a, b));
    } };
    probe(expected); setStationOrder(linear); probe(got);
    expect(got).toEqual(expected);
  });

  it('on a branched line, ahead follows the line and not the station numbers', () => {
    setStationOrder(BRANCHED);
    // both branches run DN into the shared section
    expect(ahead('DN', 0, 4)).toBe(true); expect(ahead('DN', 6, 3)).toBe(true); expect(ahead('DN', 5, 2)).toBe(true);
    // the two branches are not ahead of one another either way
    for (const direction of ['DN', 'UP'] as const) for (const [a, b] of [[1, 5], [5, 1], [0, 6], [6, 0]])
      expect(ahead(direction, a, b), `${direction} ${a}→${b}`).toBe(false);
    // UP from the shared section, both branches lie ahead
    expect(ahead('UP', 3, 1)).toBe(true); expect(ahead('UP', 3, 5)).toBe(true); expect(ahead('UP', 4, 6)).toBe(true);
    expect(ahead('UP', 1, 3)).toBe(false); expect(ahead('DN', 4, 2)).toBe(false);
  });

  it('paths and between go through the junction', () => {
    setStationOrder(BRANCHED);
    expect(stationPath(5, 4)).toEqual([5, 6, 2, 3, 4]);
    expect(stationPath(4, 5)).toEqual([4, 3, 2, 6, 5]);
    expect(stationPath(0, 5)).toEqual([0, 1, 2, 6, 5]);
    expect(stationPath(6, 6)).toEqual([6]);
    expect(between(2, 0, 5)).toBe(true); expect(between(3, 0, 5)).toBe(false);
    expect(between(6, 5, 4)).toBe(true); expect(between(1, 5, 4)).toBe(false);
  });

  it('rejects an order that loops', () => {
    expect(() => setStationOrder([1, 0])).toThrow();
  });
});
