import { describe, expect, it } from 'vitest';
import { comparisonDay, comparisonTablePath } from '../scripts/gaode/compare-day';

describe('高德对照日型', () => {
  it('默认使用工作日，显式选择双休日时使用双休日文件', () => {
    expect(comparisonDay([])).toBe('weekday');
    const day = comparisonDay(['--day', 'weekend']);
    expect(day).toBe('weekend');
    expect(comparisonTablePath('data', '北新泾', 'UP', day)).toBe('data/北新泾-UP-weekend.txt');
    expect(() => comparisonDay(['--day'])).toThrow();
    expect(() => comparisonDay(['--day', 'holiday'])).toThrow();
  });
});
