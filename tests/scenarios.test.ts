/**
 * Fault injection scenarios: each checks the consequence and the recovery
 * procedure end to end in the simulation (dispatcher commands: dispatcher.test.ts).
 */
import { describe, expect, it } from 'vitest';
import type { Sim } from '../src/sim/engine';
import { makeSim, runFor, runUntil, assertNoCollision, assertIntegrity, pickTrain, dirOf } from './helpers';
import { SCENARIOS } from '../src/sim/scenario';
import { trainAheadOf } from '../src/sim/ats';

const st = (sim: Sim, name: string) => sim.topo.stations.find((s) => s.name === name)!;
const H = 8 * 3600;

function stepCheck(sim: Sim) { assertNoCollision(sim); assertIntegrity(sim); }

describe('faults', () => {
  it('train communication loss → EB → TBTC ATO (AM) with occupancy protection → re-upgrade to DTO after recovery', () => {
    const sim = makeSim('weekday', H);
    const tr = pickTrain(sim, (t, ch) => dirOf(sim, t) === 'DN' && ch > 15000 && ch < 22000 && t.v > 5);
    const r = sim.command({ c: 'fault', kind: 'trainComm', target: tr.id, duration: 900 });
    expect(r.ok).toBe(true);
    runFor(sim, 5, stepCheck);
    // its occupancy is no longer explained by a communicating train
    expect(sim.sec[sim.topo.links[tr.link].section].commOnly).toBe(false);
    expect(tr.eb || tr.v < 5).toBe(true);
    runFor(sim, 90, stepCheck);
    expect(tr.level).toBe('TBTC');
    expect(tr.mode).toBe('AM');
    expect(tr.eb).toBe(false);
    const ch0 = sim.trainChain(tr);
    runFor(sim, 300, stepCheck);
    expect(sim.trainChain(tr)).toBeGreaterThan(ch0 + 500);
    runFor(sim, 700, stepCheck);
    expect(tr.comm).toBe(true);
    expect(tr.level).toBe('CBTC');
    expect(tr.mode).toBe('DTO');
  });

  it('ZC failure → trains stop → switchover to TBTC → restore CBTC', () => {
    const sim = makeSim('weekday', H);
    const zone = 1;
    expect(sim.command({ c: 'fault', kind: 'zcFail', target: zone, duration: 600 }).ok).toBe(true);
    runFor(sim, 40, stepCheck);
    const inZone = sim.trainList.filter((t) => sim.topo.links[t.link].zone === zone && t.phase === 'run');
    expect(inZone.length).toBeGreaterThan(3);
    // no CBTC authority in the failed zone: every train there has stopped or runs on the TBTC backup
    expect(inZone.every((t) => t.v < 0.5 || t.level === 'TBTC')).toBe(true);
    expect(sim.command({ c: 'zoneLevel', zones: [zone], level: 'CBTC' }).ok).toBe(false);
    expect(sim.command({ c: 'zoneLevel', zones: [zone], level: 'TBTC' }).ok).toBe(true);
    const pos = new Map(inZone.map((t) => [t.id, sim.trainChain(t)]));
    runFor(sim, 240, stepCheck);
    const moved = inZone.filter((t) => sim.trains.has(t.id) && Math.abs(sim.trainChain(t) - pos.get(t.id)!) > 200);
    expect(moved.length).toBeGreaterThan(inZone.length / 2);
    expect(sim.trainList.filter((t) => sim.topo.links[t.link].zone === zone).every((t) => t.level === 'TBTC')).toBe(true);
    runFor(sim, 400, stepCheck);
    expect(sim.command({ c: 'zoneLevel', zones: [zone], level: 'CBTC' }).ok).toBe(true);
    // Re-localisation needs another section, a stop or a beacon (onboard.ts).
    // The retimed stream can still be between beacons at a fixed 30 s sample.
    const restored=()=>sim.trainList.filter(t=>sim.topo.links[t.link].zone===zone&&t.comm).every(t=>t.level==='CBTC');
    const recoveryDeadline=sim.t+120;
    while(!restored()&&sim.t<recoveryDeadline)runFor(sim,5,stepCheck);
    expect(restored()).toBe(true);
  });

  it('axle counter failure → trains stop → reset fails before repair → preset + RM sweep clears', () => {
    const sim = makeSim('weekday', H);
    const a = st(sim, '北新泾').chain;
    const b = st(sim, '威宁路').chain;
    const sec = sim.topo.sections.find((s) => s.track === 'DN' && s.kind === 'plain' && s.chainFrom > a + 300 && s.chainTo < b - 300)!;
    expect(sim.command({ c: 'fault', kind: 'axle', target: sec.id, duration: 300 }).ok).toBe(true);
    runFor(sim, 240, stepCheck);
    expect(sim.trainList.some((t) => t.maReason === '计轴故障占用' && t.v < 0.1)).toBe(true);
    expect(sim.command({ c: 'axleReset', section: sec.id }).ok).toBe(false);
    runFor(sim, 70, stepCheck);
    expect(sim.command({ c: 'axleReset', section: sec.id }).ok).toBe(true);
    expect(sim.sec[sec.id].preset).toBe(true);
    // the first train asks to sweep the preset section in RM; auto-answer never grants RM, the dispatcher does
    let answered = false;
    runFor(sim, 360, (s) => {
      stepCheck(s);
      const c = s.calls.find((x) => x.kind === 'rmPreset' && x.state === 'ringing');
      if (c && !answered) { answered = s.command({ c: 'radio', call: c.id, option: 'approve' }).ok; }
    });
    expect(answered).toBe(true);
    expect(sim.sec[sec.id].preset).toBe(false);
    expect(sim.sec[sec.id].disturbed).toBe(false);
    expect(sim.events.some((e) => e.text.includes('预复位区段压道'))).toBe(true);
    expect(sim.alarms.has(`axle-${sec.id}`)).toBe(false);
  });

  it('switch loss of detection → field lock + guide route → RM passage → restore', () => {
    const sim = makeSim('weekday', H);
    const c = st(sim, '人民广场').chain;
    // DN turnout of the crossover west of 人民广场 (passed by every DN train)
    const sw = sim.topo.switches.find((s) => s.kind === 'crossover' && s.nodes.some((n) => sim.topo.nodes[n].chain < c && sim.topo.nodes[n].chain > c - 400))!;
    expect(sim.command({ c: 'fault', kind: 'switch', target: sw.id, duration: 900 }).ok).toBe(true);
    runFor(sim, 240, stepCheck);
    // the first DN train held in front of the failed switch
    const waiting = sim.trainList
      .filter((t) => dirOf(sim, t) === 'DN' && t.v < 0.1 && t.phase === 'run' && sim.trainChain(t) < c - 240 && sim.trainChain(t) > c - 1500)
      .sort((p, q) => sim.trainChain(q) - sim.trainChain(p))[0];
    expect(waiting).toBeTruthy();
    expect(sim.command({ c: 'switchMove', sw: sw.id, pos: 'N' }).ok).toBe(false);
    expect(sim.command({ c: 'switchFieldLock', sw: sw.id, on: true }).ok).toBe(true);
    const sig = waiting!.nextSignal;
    expect(sig).toBeGreaterThanOrEqual(0);
    const route = sim.topo.signals[sig].routes.find((r) => sim.topo.routes[r].switches.some((x) => x.sw === sw.id && x.pos === 'N') && !sim.topo.routes[r].wrongDir && !sim.topo.routes[r].diverging)!;
    expect(route).toBeDefined();
    if (sim.sig[sig].route >= 0) sim.command({ c: 'cancelRoute', signal: sig });
    runFor(sim, 31);
    expect(sim.command({ c: 'guideRoute', route }).ok).toBe(true);
    const ch0 = sim.trainChain(waiting!);
    runFor(sim, 150, stepCheck);
    expect(sim.trainChain(waiting!)).toBeGreaterThan(ch0 + 200);
    expect(sim.events.some((e) => e.text.includes('引导信号') && e.text.includes('RM'))).toBe(true);
    runFor(sim, 600, stepCheck);
    expect(sim.command({ c: 'switchFieldLock', sw: sw.id, on: false }).ok).toBe(true);
    expect(sim.command({ c: 'switchMove', sw: sw.id, pos: 'N' }).ok).toBe(true);
    expect(sim.sw[sw.id].failed).toBe(false);
  });

  it('signal failure → train held → guide route → passes in RM → repair', () => {
    const sim = makeSim('weekday', H);
    const s5 = st(sim, '北新泾');
    const sig = sim.topo.signals.find((s) => s.role === 'start' && s.station === s5.index && s.dir === 1 && sim.topo.links[s.link].track === 'DN')!;
    expect(sim.command({ c: 'fault', kind: 'signal', target: sig.id, duration: 900 }).ok).toBe(true);
    runFor(sim, 300, stepCheck);
    const held = sim.trainList.find((t) => t.nextSignal === sig.id && t.nextSignalDist < 30);
    expect(held).toBeTruthy();
    expect(held!.maReason).toBe('信号机故障');
    const route = sig.routes.find((r) => sim.topo.routes[r].fleeting)!;
    expect(sim.command({ c: 'setRoute', route }).ok).toBe(false);
    expect(sim.command({ c: 'guideRoute', route }).ok).toBe(true);
    runFor(sim, 120, stepCheck);
    expect(sim.trainChain(held!)).toBeGreaterThan(sig.chain + 50);
    runFor(sim, 600, stepCheck);
    expect(sim.sig[sig.id].failed).toBe(false);
    runFor(sim, 30);
    expect(sim.sig[sig.id].route).toBeGreaterThanOrEqual(0);
  });

  it('platform screen door failure → departure blocked → interlock bypass → departs', () => {
    const sim = makeSim('weekday', H);
    const p = st(sim, '威宁路').platforms.DN;
    expect(sim.command({ c: 'fault', kind: 'psd', target: p, duration: 1200 }).ok).toBe(true);
    let stuck = false;
    runFor(sim, 400, (s) => { stepCheck(s); if (s.alarms.has(`psd-${p}`)) stuck = true; });
    expect(stuck).toBe(true);
    const tr = sim.trainList.find((t) => t.phase === 'dwell' && sim.topo.links[t.link].platform === p)!;
    expect(tr).toBeTruthy();
    runFor(sim, 60);
    expect(tr.phase).toBe('dwell');
    expect(sim.command({ c: 'psdBypass', platform: p, on: true }).ok).toBe(true);
    runFor(sim, 60, stepCheck);
    expect(tr.phase).toBe('run');
    expect(sim.trainChain(tr)).toBeGreaterThan(sim.topo.stations[6].chain + 50);
  });

  it('failed train → rescue by the following train → coupled → withdrawn; service continues', () => {
    const sim = makeSim('weekday', H);
    const failed = pickTrain(sim, (t, ch) => dirOf(sim, t) === 'DN' && ch > 16500 && ch < 21000 && t.v > 8);
    expect(sim.command({ c: 'fault', kind: 'trainFail', target: failed.id, duration: 0, recoverable: false }).ok).toBe(true);
    runFor(sim, 260, stepCheck);
    expect(failed.failed).toBe(true);
    expect(sim.alarms.has(`tfr-${failed.id}`)).toBe(true);
    const rescuer = sim.trainList.find((t) => t.id !== failed.id && trainAheadOf(sim, t, 8000) === failed.id)!;
    expect(rescuer).toBeTruthy();
    expect(sim.command({ c: 'rescue', failed: failed.id, rescuer: rescuer.id }).ok).toBe(true);
    let coupled = false;
    runFor(sim, 1500, (s) => { stepCheck(s); if (!s.trains.has(failed.id)) coupled = true; });
    expect(coupled).toBe(true);
    runFor(sim, 2400, stepCheck);
    expect(sim.trains.has(rescuer.id) && sim.trains.get(rescuer.id)!.phase !== 'stabled').toBe(false);
    // the rest of the line keeps running
    expect(sim.trainList.filter((t) => t.inService && t.v > 1).length).toBeGreaterThan(10);
  }, 300_000); // about 70 min of full-line simulation

  it('passenger surge → crowding alarm and longer dwell', () => {
    const sim = makeSim('weekday', H);
    const s = st(sim, '人民广场');
    expect(sim.command({ c: 'fault', kind: 'surge', target: s.index, duration: 1200, param: 6 }).ok).toBe(true);
    let maxWait = 0;
    runFor(sim, 900, (x) => { maxWait = Math.max(maxWait, x.plat[s.platforms.DN].waiting, x.plat[s.platforms.UP].waiting); });
    expect(maxWait).toBeGreaterThan(800);
    expect(sim.events.some((e) => e.text.includes('人民广场 大客流'))).toBe(true);
  });
});

describe('scenario catalogue', () => {
  // each training scenario finds the trains and equipment its events act on,
  // and runs on past its last event with auto-answered calls without a
  // safety violation
  for (const id of ['dawn-poss', 'gll-loop', 'hq-night', 'ciie-close', 'ljz-person', 'river-tunnel', 'holiday-return', 'njd-closure']) {
    it(`${id} fires all its events and runs on safely`, () => {
      const def = SCENARIOS.find((s) => s.id === id)!;
      const sim = makeSim(def.dayType, def.start, { seed: 3, scenario: id });
      runUntil(sim, def.start + Math.min(def.duration, def.events.at(-1)!.at + 5 * 60), stepCheck);
      expect(sim.scenario?.id).toBe(id);
      expect(sim.scenarioFired).toBe(def.events.length);
      const fired = sim.events.filter((e) => e.text.startsWith('场景事件：'));
      expect(fired.length).toBe(def.events.length);
      expect(fired.filter((e) => e.text.includes('未找到')).map((e) => e.text)).toEqual([]);
    }, 1_200_000); // evening scenarios warm up a whole operating day first (~13 h of full-line simulation from 04:00)
  }
});
