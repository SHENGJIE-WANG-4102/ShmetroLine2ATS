import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Sim as Simulator } from '../src/sim/engine';
import type { Train } from '../src/sim/model';
import type { TRoute } from '../src/sim/topology';

/** One planned train on an otherwise empty line, with every route released. */
async function fixture(line?: string) {
  vi.resetModules();
  if (line) vi.stubEnv('ATS_LINE', line);
  const { Sim } = await import('../src/sim/engine');
  const ci = await import('../src/sim/interlocking');
  const { fixtureTrain } = await import('./helpers/fixture-train');
  const { LINE } = await import('../src/data/current');
  const sim: Simulator = new Sim({ dayType: 'weekday', dateLabel: 'signal-aspect', startTime: 14400, seed: 3, noPossessions: true });
  const tr = fixtureTrain(sim);
  for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
  for (const rid of [...sim.routes.keys()]) ci.releaseRoute(sim, rid);
  ci.computeOccupancy(sim);
  const { topo } = sim;
  const free = (r: TRoute) => r.sections.every(s => !sim.sec[s].occ) && sim.zoneState[topo.links[topo.signals[r.start].link].zone] === 'CBTC';
  const pick = (shunt: boolean) => topo.routes.find(r => free(r) && !r.diverging && topo.signals[r.start].routes.every(x => !!topo.routes[x].shunt === shunt))!;
  const set = (r: TRoute) => {
    expect(ci.trySetRoute(sim, r.id).ok).toBe(true);
    for (let i = 0; i < 20 && sim.routes.get(r.id)!.state !== 'locked'; i++) { sim.t += 1; ci.updateInterlocking(sim); }
    expect(sim.routes.get(r.id)!.state).toBe('locked');
  };
  /** `tr` faces the signal in the given driving state; null: no train faces it */
  const face = (sig: number, state: Partial<Train> | null) => {
    Object.assign(tr, { nextSignal: state ? sig : -1, nextSignalDist: 120, comm: true, level: 'CBTC', mode: 'AM' }, state ?? {});
    ci.updateAspects(sim);
    return { shown: sim.sig[sig].aspect, lit: sim.sig[sig].lit };
  };
  /** a communicating train ahead inside the route */
  const occupyAhead = (r: TRoute, commOnly: boolean) => Object.assign(sim.sec[r.sections.at(-1)!], { occ: true, trainOcc: true, commOnly });
  return { sim, tr, LINE, pick, set, face, occupyAhead };
}

describe('wayside signal aspects', () => {
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('line 2: running signals stay dark for a train on CBTC authority, lit for everyone else', async () => {
    const { LINE, pick, set, face, occupyAhead, sim } = await fixture();
    expect(LINE.signalling.wayside).toBe('darkForCbtc');
    const main = pick(false), sig = main.start;
    expect(face(sig, {})).toEqual({ shown: 'DARK', lit: 'R' });
    expect(face(sig, null)).toEqual({ shown: 'DARK', lit: 'R' });
    expect(face(sig, { mode: 'RM' })).toEqual({ shown: 'R', lit: 'R' });
    expect(face(sig, { comm: false })).toEqual({ shown: 'R', lit: 'R' });
    set(main);
    expect(face(sig, {})).toEqual({ shown: 'DARK', lit: 'G' });
    expect(face(sig, { level: 'TBTC' })).toEqual({ shown: 'G', lit: 'G' });
    occupyAhead(main, true);
    expect(face(sig, {})).toEqual({ shown: 'DARK', lit: 'G' });
    expect(face(sig, { mode: 'RM' })).toEqual({ shown: 'R', lit: 'R' });
    occupyAhead(main, false);
    expect(face(sig, {})).toEqual({ shown: 'DARK', lit: 'R' });
    sim.zoneState[sim.topo.links[sim.topo.signals[sig].link].zone] = 'ZCFAIL';
    expect(face(sig, {})).toEqual({ shown: 'R', lit: 'R' });
  });

  it('line 2: shunt signals stay lit, red, white, red once the head has passed', async () => {
    const { pick, set, face, sim, tr } = await fixture();
    const shunt = pick(true), sig = shunt.start;
    expect(face(sig, {})).toEqual({ shown: 'R', lit: 'R' });
    set(shunt);
    expect(face(sig, {})).toEqual({ shown: 'W', lit: 'W' });
    const { signalPassed } = await import('../src/sim/interlocking');
    signalPassed(sim, tr.id, sig);
    expect(face(sig, {})).toEqual({ shown: 'R', lit: 'R' });
  });

  it('lit line: never dark; a communicating train ahead in the route does not turn it red for a follower on authority', async () => {
    const { LINE, pick, set, face, occupyAhead } = await fixture('test');
    expect(LINE.signalling.wayside).toBe('lit');
    const main = pick(false), sig = main.start;
    expect(face(sig, {})).toEqual({ shown: 'R', lit: 'R' });
    set(main);
    expect(face(sig, {})).toEqual({ shown: 'G', lit: 'G' });
    occupyAhead(main, true);
    expect(face(sig, {})).toEqual({ shown: 'G', lit: 'G' });
    expect(face(sig, { mode: 'RM' })).toEqual({ shown: 'R', lit: 'R' });
    expect(face(sig, { comm: false })).toEqual({ shown: 'R', lit: 'R' });
    occupyAhead(main, false);
    expect(face(sig, {})).toEqual({ shown: 'R', lit: 'R' });
  });
});
