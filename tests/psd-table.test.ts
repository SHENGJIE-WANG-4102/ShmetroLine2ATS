import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { closeDoors, doorMotionTick, openDoors } from '../src/sim/psd';
import { platformBerth } from '../src/sim/timetable';
import { fixtureTrain } from './helpers/fixture-train';

/** Platform doors left open behind a train (PSD 'open') meet an opening worked
 * from the PSL: open→pslOpen is not in the PSD table. The worker must not
 * stop on it; the integrity checker reports it and the doors keep their state. */
describe('a PSD transition outside its table', () => {
  it('is an integrity violation, not an exception, and the doors still close afterwards', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'psd-table', startTime: 14400, seed: 7,
      noPossessions: true, autoRadio: false, autoDispatch: false });
    const tr = fixtureTrain(sim);
    const p = sim.topo.berths[platformBerth(sim.topo, 8, 'DN')].platform;
    const ps = sim.plat[p];
    ps.psd = 'open';
    Object.assign(tr, { vfault: null, manual: false, atoDriver: false, doorMotion: undefined });
    openDoors(sim, tr, p, true);
    sim.t += .3;
    expect(() => doorMotionTick(sim)).not.toThrow();
    expect(ps.psd).toBe('open');
    const v = sim.integrity.violations.filter(x => x.kind === 'FSM' && x.detail.includes('open→pslOpen'));
    expect(v).toHaveLength(1);
    expect(v[0].trains).toEqual([tr.id]);
    expect([...sim.alarms.values()].some(a => a.code === 'INTEGRITY_FSM')).toBe(true);
    // the degraded state stays in the table: the next close locks the doors
    expect(closeDoors(sim, tr, p)).toBeGreaterThanOrEqual(0);
    sim.t = tr.doorLockedAt! + .01;
    doorMotionTick(sim);
    expect(ps.psd).toBe('closed');
    expect(tr.doorsOpen).toBe(false);
    expect(ps.psdTrain).toBe(-1);
    expect(sim.integrity.violations.filter(x => x.kind === 'FSM')).toHaveLength(1);
  }, 120000);
});
