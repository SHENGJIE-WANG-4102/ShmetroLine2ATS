import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sim as Simulator } from '../src/sim/engine';
import type { Checkpoint } from '../src/sim/state';

describe('line without a backup signalling system', () => {
  let Sim: typeof Simulator;
  let checkpoint: Checkpoint;
  let restore: typeof import('../src/sim/state').restore;
  let onboard: typeof import('../src/sim/onboard');
  let trainId: number;
  const config = { dayType: 'weekday' as const, dateLabel: 'capabilities', startTime: 14400, seed: 7, noPossessions: true };
  beforeAll(async () => {
    vi.stubEnv('ATS_LINE', 'test'); vi.resetModules();
    Sim = (await import('../src/sim/engine')).Sim;
    const state = await import('../src/sim/state'); restore = state.restore;
    onboard = await import('../src/sim/onboard');
    const sim = new Sim(config);
    const running = () => sim.trainList.find(train => train.inService && train.phase === 'run' && train.v > 5 && train.level === 'CBTC');
    while (!running() && sim.t < 7 * 3600) sim.step();
    expect(running()).toBeDefined();
    trainId = running()!.id; checkpoint = state.capture(sim);
  });
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  const fixture = () => { const sim = new Sim(config); restore(sim, checkpoint); return sim; };

  it('rejects unavailable train and zone levels without changing their state or scheduling a transition', () => {
    const sim = fixture(), train = sim.trains.get(trainId)!;
    const original = { level: train.level, force: train.forceLevel, pending: train.pendingLevel, mode: train.pendingMode, zones: [...sim.zoneState] };
    expect(sim.command({ c: 'trainLevel', train: train.id, level: 'TBTC' }).ok).toBe(false);
    expect(sim.command({ c: 'zoneLevel', zones: [0], level: 'TBTC' }).ok).toBe(false);
    expect(onboard.setMode(sim, train, 'AM', 'TBTC', 'capability check')).toBe(false);
    onboard.requestMode(sim, train, 'AM', 'TBTC');
    expect({ level: train.level, force: train.forceLevel, pending: train.pendingLevel, mode: train.pendingMode, zones: [...sim.zoneState] }).toEqual(original);
    expect(sim.command({ c: 'trainLevel', train: train.id, level: 'AUTO' }).ok).toBe(true);
  });

  for (const kind of ['trainComm', 'zcFail'] as const) it(`${kind}: stops on CBTC, waits for the actual fault, then resumes after repair`, () => {
    const sim = fixture(), train = sim.trains.get(trainId)!;
    expect(sim.command({ c: 'fault', kind, target: kind === 'trainComm' ? train.id : sim.topo.links[train.link].zone, duration: 0 }).ok).toBe(true);
    const fault = sim.faults.at(-1)!;
    const deadline = sim.t + 120;
    while (sim.t < deadline && !sim.calls.some(call => call.train === train.id && call.kind === 'ebRelease' && call.state === 'ringing')) sim.step();
    expect(train.eb).toBe(true);
    expect(train.v).toBeLessThanOrEqual(.01);
    expect(train.level).toBe('CBTC');
    const call = sim.calls.find(call => call.train === train.id && call.kind === 'ebRelease' && call.state === 'ringing');
    expect(call).toBeDefined();
    expect(call!.options.map(option => option.key)).toEqual(['wait']);
    expect(call!.auto).toBe('wait');
    expect(sim.command({ c: 'ebRelease', train: train.id }).ok).toBe(false);
    expect(onboard.answerEbRelease(sim, train, 'degrade').ok).toBe(false);
    expect(train.eb).toBe(true);
    expect(train.pendingLevel).not.toBe('TBTC');
    expect(sim.command({ c: 'radio', call: call!.id, option: 'wait' }).ok).toBe(true);
    const stoppedUntil = sim.t + 30;
    while (sim.t < stoppedUntil) sim.step();
    expect(train.eb).toBe(true);
    expect(train.level).toBe('CBTC');
    expect(sim.command({ c: 'repair', fault: fault.id }).ok).toBe(true);
    expect(sim.command({ c: 'ebRelease', train: train.id }).ok).toBe(true);
    const recovered = sim.t + 180;
    while (sim.t < recovered && train.v <= 1) sim.step();
    expect(train.eb).toBe(false);
    expect(train.level).toBe('CBTC');
    expect(train.v).toBeGreaterThan(1);
    expect(sim.integrity.violations).toEqual([]);
  });
});

describe('existing line backup capability', () => {
  let Sim: typeof Simulator;
  beforeAll(async () => {
    vi.stubEnv('ATS_LINE', '2'); vi.resetModules();
    Sim = (await import('../src/sim/engine')).Sim;
  });
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  it('retains both train and zone TBTC commands', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'backup capability', startTime: 14400, seed: 7, noPossessions: true });
    const train = sim.trainList[0];
    expect(train).toBeDefined();
    expect(sim.command({ c: 'trainLevel', train: train.id, level: 'TBTC' }).ok).toBe(true);
    expect(train.forceLevel).toBe('TBTC');
    expect(sim.command({ c: 'zoneLevel', zones: [0], level: 'TBTC' }).ok).toBe(true);
    expect(sim.zoneState[0]).toBe('TBTC');
  });
});
