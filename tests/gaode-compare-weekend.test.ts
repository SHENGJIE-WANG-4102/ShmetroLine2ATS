import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ days: [] as string[], reads: [] as string[] }));
vi.mock('node:fs', () => ({
  readFileSync: (path: string) => {
    fixture.reads.push(path);
    if (path === 'fixture/甲-DN-weekend.txt') return '07:00\n';
    throw new Error(`未准备的表：${path}`);
  },
  existsSync: () => false,
}));
vi.mock('../src/data/current', () => ({
  LINE_INFO: { shortName: '测试线' },
  SIMULATION: { timetable: { diagnostics: { gaode: {
    directory: 'fixture', checks: [['甲', 'DN']], windows: [[360, 480]],
    reference: { stations: ['乙'], from: 8, to: 9 },
  } } } },
}));
vi.mock('../src/sim/engine', () => ({
  Sim: class {
    topo = { stations: [{ name: '甲' }] };
    plan: { trips: unknown[] };
    constructor(options: { dayType: string }) {
      fixture.days.push(options.dayType);
      const arr = (options.dayType === 'weekend' ? 420 : 360) * 60;
      this.plan = { trips: [{ revenue: true, dir: 'DN', kind: 'big', stops: [
        { st: 0, arr, stop: true }, { st: 1, arr: arr + 60, stop: true },
      ] }] };
    }
  },
}));

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

describe('双休日高德比较', () => {
  it('读取双休日表并以双休日计划计算', async () => {
    const originalArgv = process.argv;
    fixture.days.length = 0;
    fixture.reads.length = 0;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      process.argv = ['node', 'gaode-compare', '--day', 'weekend'];
      const entry: string = '../scripts/gaode-compare.ts';
      await import(entry);
      expect(fixture.days).toEqual(['weekend']);
      expect(fixture.reads).toEqual(['fixture/甲-DN-weekend.txt']);
      expect(log.mock.calls.flat().join('\n')).toContain('total |plan − Gaode| over windows 0, failing bins 0');
      expect(log.mock.calls.flat().join('\n')).toContain('参考 乙 DN: 无双休日采集表，未比较');
    } finally {
      process.argv = originalArgv;
    }
  });
});
