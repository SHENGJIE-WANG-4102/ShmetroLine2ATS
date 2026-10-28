import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { newTrain } from '../src/sim/ats';
import { computeBody, indexBodies } from '../src/sim/movement';
import { computeOccupancy } from '../src/sim/interlocking';
import { setMode } from '../src/sim/onboard';

// Train 216 of fuzz 142031: a standby out of CSD, head 6.36 m short of S2908,
// bound for the reverse platform at 远东大道 after ZC4 failed (D146).
function fixture(level: 'CBTC' | 'TBTC') {
  const sim = new Sim({ dayType: 'weekday', dateLabel: 'reverse-hold', startTime: 14400, seed: 7, noPossessions: true, autoRadio: true });
  for (const tr of [...sim.trainList]) sim.removeTrain(tr);
  for (const block of sim.plan.blocks) sim.blockDone.add(block.id);
  const link = sim.topo.links.find(l => sim.topo.sections[l.section].name === 'G2909')!;
  const sig = sim.topo.signals.find(s => s.name === 'S2908')!;
  const berth = sim.topo.berths.find(b => b.station === 28 && b.kind === 'platform' && b.reverse && b.dir === -1)!.id;
  const hist = [{ link: 514, dir: -1 as const }, { link: 509, dir: -1 as const }, { link: 512, dir: 1 as const },
    { link: 513, dir: 1 as const }, { link: 196, dir: -1 as const }, { link: 195, dir: -1 as const }];
  const tr = newTrain(sim, null, link.id, 6.3611073836, -1, hist, 'reverse-hold');
  Object.assign(tr, { level, mode: level === 'CBTC' ? 'DTO' : 'AM', forceLevel: 'AUTO', phase: 'run', manual: false,
    tasks: [{ k: 'stop', berth, station: 28, trip: -1, arr: null, dep: null, doors: false, revenue: false }] });
  computeBody(sim, tr); indexBodies(sim); computeOccupancy(sim);
  return { sim, tr, sig, zone: link.zone };
}

describe('reverse platform movements and TBTC', () => {
  it('holds a CBTC train whose reverse platform lies in a TBTC zone', () => {
    const { sim, tr, zone } = fixture('CBTC');
    sim.zoneState[zone] = 'TBTC';
    for (let i = 0; i < 50; i++) sim.step(0.1);
    expect(tr.arsWait?.code).toBe('DIRECTION_WAIT');
    expect(tr.arsWait?.detail).toContain('区域为TBTC');
  });

  it('re-registers in place after a standing degrade once the zone is CBTC again', () => {
    const { sim, tr } = fixture('CBTC');
    tr.v = 0;
    expect(setMode(sim, tr, 'AM', 'TBTC', '区域转TBTC，原地降级')).toBe(true);
    expect(tr.locKept).toBe(true);
    const off = tr.off;
    for (let i = 0; i < 30 && tr.level !== 'CBTC'; i++) sim.step(0.1);
    expect(tr.level).toBe('CBTC');
    expect(Math.abs(tr.off - off)).toBeLessThan(0.5);
  });

  it('a train that moved under TBTC still waits for a relocalisation point', () => {
    const { sim, tr } = fixture('TBTC');
    tr.locKept = false;
    for (let i = 0; i < 30; i++) sim.step(0.1);
    expect(tr.level).toBe('TBTC');
    expect(tr.mode).not.toBe('RM');
  });
});
