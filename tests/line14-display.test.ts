import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sim as Simulator } from '../src/sim/engine';

describe('column platform and status-grid cab presentation', () => {
  let Sim: typeof Simulator;
  let data: typeof import('../src/data/current');
  let cab: typeof import('../src/sim/dmi');
  let pis: typeof import('../src/sim/pis');
  let screen: typeof import('../src/ui/dmiStatusGrid');
  let route: typeof import('../src/ui/pisColumn');
  let formatTrainNumber: typeof import('../src/ui/trainNumber').formatTrainNumber;
  let newTrain: typeof import('../src/sim/ats').newTrain;
  let controls: typeof import('../src/ui/utoControls');
  beforeAll(async () => {
    vi.stubEnv('ATS_LINE', '14'); vi.resetModules();
    data = await import('../src/data/current');
    Sim = (await import('../src/sim/engine')).Sim;
    newTrain = (await import('../src/sim/ats')).newTrain;
    controls = await import('../src/ui/utoControls');
    cab = await import('../src/sim/dmi'); pis = await import('../src/sim/pis');
    screen = await import('../src/ui/dmiStatusGrid'); route = await import('../src/ui/pisColumn');
    formatTrainNumber = (await import('../src/ui/trainNumber')).formatTrainNumber;
  });
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('uses explicit screen styles and duty-based train numbers without changing trip identity', () => {
    // banner screens above the doors; Xiepu Road was photographed with a column
    expect(data.LINE.ui).toMatchObject({ dmiStyle: 'statusGrid', pisStyle: 'banner', dmiSpeedWarning: 'target' });
    expect(data.STATIONS.filter((s: { pisStyle?: string }) => s.pisStyle).map((s: { name: string; pisStyle?: string }) => `${s.name}:${s.pisStyle}`)).toEqual(['歇浦路:column']);
    expect(formatTrainNumber('034', '8765')).toBe('14034');
    expect(formatTrainNumber(7, '8765', true)).toBe('14007');
    expect(screen.cabModeName('CM')).toBe('ATPM');
    expect(screen.cabModeName('DTO')).toBe('FAM');
  });

  it('shows the photographed nonlinear distance scale, including unknown distances', () => {
    expect(screen.DISTANCE_TICKS).toEqual([0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]);
    expect(screen.distanceBarFraction(1)).toBeCloseTo(.1);
    expect(screen.distanceBarFraction(100)).toBeCloseTo(.7);
    expect(screen.distanceBarFraction(151)).toBeCloseTo(.751);
    expect(screen.distanceBarFraction(2000)).toBe(1);
    expect(screen.distanceBarFraction(Infinity)).toBe(0);
    expect(screen.distanceBarFraction(-1)).toBe(0);
  });

  it('keeps a simulated attendant separate from the player master controller', () => {
    const uto = { computer: true, stage: 'manual' as const, target: 'CM' as const, until: 0, detail: '随车人员 ATPM 驾驶' };
    expect(controls.isPlayerDriving({ manual: true, uto })).toBe(false);
    expect(controls.isPlayerDriving({ manual: true, uto: { ...uto, computer: false } })).toBe(true);
    expect(controls.isPlayerDriving({ manual: true })).toBe(true);
    expect(controls.isPlayerDriving({ manual: false })).toBe(false);
  });

  it('paginates every passenger station in travel order, five per page, excluding the unopened station', () => {
    const start = data.STATIONS.findIndex(s => s.id === 'XPL');
    const closed = data.STATIONS.findIndex(s => s.id === 'LJL');
    const east = route.columnRoutePages(start, 'DN'), west = route.columnRoutePages(start, 'UP');
    expect(east.flat()).not.toContain(closed);
    expect(west.flat()).not.toContain(closed);
    expect(east.flat().at(-1)).toBe(data.STATIONS.findIndex(s => s.id === 'GQL'));
    expect(west.flat().at(-1)).toBe(data.STATIONS.findIndex(s => s.id === 'FB'));
    expect(west.every(page => page.length <= 5)).toBe(true);
    expect(new Set(west.flat()).size).toBe(west.flat().length);
  });

  it('preserves the three simultaneous field countdowns and station-direction first/last times', () => {
    const rows = [400, 910, 1420].map(eta => ({ eta, status: 'eta' as const, dest: '封浜', destSt: 0, trip: '1', load: 0 }));
    expect(rows.map(pis.formatPisCountdown)).toEqual(['06:40', '15:10', '23:40']);
    expect(pis.selectPisFirstLast('歇浦路', 'UP', rows[0])[0]).toEqual({ destination: '封浜', first: '05:47', last: '22:47' });
  });

  it('warns above target while below maximum, and acknowledgement uses a replayable command', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'display', startTime: 14400, seed: 7, noPossessions: true });
    const link = sim.topo.platforms[0].link;
    const train = newTrain(sim, null, link, 100, 1, [{ link, dir: 1 }], '14049');
    train.manual = true; train.mode = 'CM'; train.v = 74 / 3.6; train.vRecommended = 72 / 3.6; train.vPermit = 79 / 3.6; train.eb = false; train.tgtD = 151;
    expect(cab.computeDmi(sim, train.id)).toMatchObject({ speedWarning: true, targetSpeed: 72 / 3.6, targetDistance: 151 });
    train.v = 71 / 3.6;
    expect(cab.computeDmi(sim, train.id)?.speedWarning).toBe(false);
    train.dmiLog.push({ t: sim.t, m: '速度警告', k: 'warn' });
    expect(sim.command({ c: 'dmiAck', train: train.id, message: '速度警告', at: sim.t }).ok).toBe(true);
    const dmi = cab.computeDmi(sim, train.id)!;
    expect(dmi.acknowledged).toContain(`${sim.t}|速度警告`);
    expect(screen.statusGridAlarmAt(dmi, 60, 520)).toBeUndefined();
    expect(sim.inputLog.at(-1)).toMatchObject({ cmd: { c: 'dmiAck' } });
    expect(sim.command({ c: 'dmiAck', train: train.id, message: '速度警告', at: sim.t }).ok).toBe(true);
    expect(train.dmiAcknowledged).toHaveLength(1);
    cab.dmiTick(sim);
    sim.t += 1; train.v = 74 / 3.6; cab.dmiTick(sim);
    const repeated = cab.computeDmi(sim, train.id)!;
    expect(screen.statusGridAlarmAt(repeated, 60, 520)).toMatchObject({ t: sim.t, m: '速度警告' });
    expect(repeated.acknowledged).not.toContain(`${sim.t}|速度警告`);
  });

  it('returns an empty board for the unopened station even before train tasks are inspected', () => {
    const closed = data.STATIONS.findIndex(s => s.id === 'LJL');
    const board = pis.computePis({ topo: {} } as Simulator, closed);
    expect(board).toMatchObject({ DN: [], UP: [], skip: { DN: true, UP: true }, notice: '本站未开通，列车通过不停车' });
  });
});
