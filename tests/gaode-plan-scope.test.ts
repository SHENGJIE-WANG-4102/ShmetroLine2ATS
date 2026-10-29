import { describe, expect, it } from 'vitest';
import { includedInComparison } from '../scripts/gaode/plan-scope';

describe('高德比较范围', () => {
  it('only excludes the specified trip kind at the specified station, direction and time', () => {
    const rules = [{ station: '甲', dir: 'UP' as const, from: 100, to: 200, kinds: ['small' as const] }];
    expect(includedInComparison(rules, '甲', 'UP', 'small', 100)).toBe(false);
    expect(includedInComparison(rules, '甲', 'UP', 'small', 199)).toBe(false);
    expect(includedInComparison(rules, '甲', 'UP', 'small', 200)).toBe(true);
    expect(includedInComparison(rules, '甲', 'UP', 'big', 150)).toBe(true);
    expect(includedInComparison(rules, '甲', 'DN', 'small', 150)).toBe(true);
    expect(includedInComparison(rules, '乙', 'UP', 'small', 150)).toBe(true);
  });
});
