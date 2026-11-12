/**
 * Dispatcher command scenarios, end to end in the simulation.
 */
import { describe, expect, it } from 'vitest';
import type { Sim } from '../src/sim/engine';
import { exchangePartner } from '../src/sim/ats';
import { hotStandby, predictedLateness } from '../src/sim/duty/live';
import type { StopTask, Train } from '../src/sim/model';
import { makeSim, runFor, assertNoCollision, assertIntegrity, pickTrain, dirOf } from './helpers';

const st = (sim: Sim, name: string) => sim.topo.stations.find((s) => s.name === name)!;
const H = 8 * 3600;

function stepCheck(sim: Sim) { assertNoCollision(sim); assertIntegrity(sim); }

describe('dispatcher commands', () => {
  it('hold / release, skip-stop, emergency close', () => {
    const sim = makeSim('weekday', H);
    runFor(sim, 30);
    const tr = sim.trainList.find((t) => t.phase === 'dwell' && t.inService)!;
    expect(sim.command({ c: 'trainHold', train: tr.id, on: true }).ok).toBe(true);
    runFor(sim, 150);
    expect(tr.phase).toBe('dwell');
    sim.command({ c: 'trainHold', train: tr.id, on: false });
    runFor(sim, 80);
    expect(tr.phase).not.toBe('dwell');

    const js = st(sim, '江苏路');
    sim.command({ c: 'platformSkip', platform: js.platforms.DN, on: true });
    let skipped = false;
    runFor(sim, 600, (x) => { if (x.events.some((e) => e.text.includes('跳停 江苏路'))) skipped = true; });
    expect(skipped).toBe(true);
    sim.command({ c: 'platformSkip', platform: js.platforms.DN, on: false });

    const p = js.platforms.UP;
    sim.command({ c: 'platformEsp', platform: p, on: true });
    let blocked = false;
    runFor(sim, 400, (x) => { stepCheck(x); if (x.trainList.some((t) => t.maReason === '站台紧急关闭' && t.v < 0.1)) blocked = true; });
    expect(blocked).toBe(true);
    sim.command({ c: 'platformEsp', platform: p, on: false });
    runFor(sim, 120, stepCheck);
    expect(sim.trainList.some((t) => t.maReason === '站台紧急关闭')).toBe(false);
  });

  it('temporary speed restriction is respected', () => {
    const sim = makeSim('weekday', H);
    const a = st(sim, '中山公园').chain;
    const b = st(sim, '江苏路').chain;
    const secs = sim.topo.sections.filter((s) => s.track === 'DN' && s.chainFrom >= a + 105 && s.chainTo <= b - 105).map((s) => s.id);
    expect(sim.command({ c: 'setTsr', sections: secs, kmh: 25 }).ok).toBe(true);
    runFor(sim, 60);
    let maxV = 0;
    runFor(sim, 500, (x) => {
      for (const t of x.trainList) if (t.body.every((bb) => secs.includes(x.topo.links[bb.link].section))) maxV = Math.max(maxV, t.v);
    });
    expect(maxV).toBeGreaterThan(3);
    expect(maxV).toBeLessThanOrEqual(25 / 3.6 + 1.0);
    expect(sim.command({ c: 'cancelTsr', sections: secs }).ok).toBe(true);
  });

  it('manual turnback and withdraw', () => {
    // D79 extends the AM wave; exercise the command after it clears the core.
    const sim = makeSim('weekday', 9 * 3600 + 55 * 60, { seed: 5 });
    runFor(sim, 13*3600-sim.t, stepCheck);
    const rm = st(sim, '人民广场');
    // Wait for a real approaching train rather than requiring this
    // incidental snapshot to contain one.
    const suitable = () => sim.trainList.some(t => t.inService && t.phase==='run' && dirOf(sim,t)==='DN'
      && sim.trainChain(t)<rm.chain-1500 && sim.trainChain(t)>rm.chain-5000);
    const until=sim.t+900;while(!suitable()&&sim.t<until)runFor(sim,10,stepCheck);
    const tr = pickTrain(sim, (t, ch) => dirOf(sim, t) === 'DN' && ch < rm.chain - 1500 && ch > rm.chain - 5000);
    const r1 = sim.command({ c: 'turnback', train: tr.id, station: rm.index });
    expect(r1.ok).toBe(true);
    let turned = false;
    runFor(sim, 1200, (x) => { stepCheck(x); if (x.trains.has(tr.id) && dirOf(x, tr) === 'UP' && x.trainChain(tr) < rm.chain - 300) turned = true; });
    expect(turned).toBe(true);

    // (not one entering a turnback track: withdrawal waits for its reversal there)
    const w = pickTrain(sim, (t) => dirOf(sim, t) === 'UP' && t.id !== tr.id && t.tasks[0]?.k !== 'reverse');
    expect(sim.command({ c: 'withdraw', train: w.id }).ok).toBe(true);
    const end = sim.t + 3600;
    while (sim.trains.has(w.id) && sim.t < end) runFor(sim, 10, stepCheck);
    expect(sim.trains.has(w.id)).toBe(false);
  },240_000);

  it('add train', () => {
    // the shared 09:55 checkpoint: the peak bands are at capacity (no slot
    // keeps the minimum headway), so the extra train runs in the first
    // off-peak hour, on an undisturbed line and to time
    const sim = makeSim('weekday', 9 * 3600 + 55 * 60, { seed: 5 });
    runFor(sim,13*3600-sim.t,stepCheck);
    const lyd = sim.topo.depots.findIndex((d) => d.key === 'LYD');
    const add = sim.command({c:'addTrain',depot:lyd,dir:'DN',to:st(sim,'广兰路').index,time:Math.max(sim.t+600,10*3600)});
    expect(add.ok,add.msg).toBe(true);
    const blk = sim.plan.blocks[sim.plan.blocks.length - 1];
    const trips = blk.trips.map(id => sim.plan.trips[id]).filter(t => t.revenue);
    expect(trips.length).toBe(2);
    const end = trips.at(-1)!.stops.at(-1)!.arr;
    const done = () => trips.every(t => t.completed);
    let worst = 0;
    const track = (x: Sim) => { stepCheck(x); const t = blk.train === undefined ? undefined : x.trains.get(blk.train); if (t?.inService) worst = Math.max(worst, t.delay); };
    while (!done() && sim.t < end + 3600) runFor(sim, 30, track);
    expect(done()).toBe(true);
    expect(worst).toBeLessThanOrEqual(120);
  },240_000);

  it('runs the CIIE opening-window services', () => {
    const sim = makeSim('weekday', 9 * 3600);
    // D178: on the pool-planned base the 9:30 slots keep no headway room;
    // the window starts a quarter later. 用户决定 2026-11-08 (no return
    // before 10:00): the morning's surplus cars return from 10:00 on, the
    // 北翟路 lead is busy until about 10:30 and 国家会展中心 has no car for
    // an added departure then; the window starts after that wave.
    const preset = { from: 10.5 * 3600, to: 11 * 3600, headway: 900 };
    const before = sim.plan.trips.length;
    const ov = sim.command({ c: 'overlay', id: 'ciie', ...preset });
    expect(ov.ok, ov.msg).toBe(true);
    const added = sim.plan.trips.slice(before).filter(t => t.revenue && t.overlay?.startsWith('ciie'));
    // D79 keeps the base peak until 10:00. Off the peak each of the three
    // slots yields an eastbound section and a westbound return. D184: the
    // eastbound sections no longer need a 北翟路 exit between the small-route
    // returns; base cars running home take them (pool overlay), so all run.
    // An unavailable origin tail may move out to the next rear turnback;
    // compare the requested section, which keeps its published calls.
    const service = added.filter(t => t.dir==='DN'
      ? t.stops.some(s=>s.st===1)&&t.to===22
      : t.from>=22&&t.stops.some(s=>s.st===22)&&t.to===1);
    expect(service.length).toBe(6);
    expect(service.filter(t => t.cancelled)).toHaveLength(0);
    const running = added.filter(t => !t.cancelled);
    expect(running.length).toBeGreaterThan(0);
    const last = Math.max(...running.map(t => t.stops.at(-1)!.arr));
    runFor(sim, last + 600 - sim.t, stepCheck);
    expect(running.filter(t => t.completed).length).toBeGreaterThanOrEqual(Math.ceil(.9 * running.length));
  }, 300_000); // the added services run until about 12:30: some 13000 simulated seconds

  it('R4 exchanges the duty of a late train with the on-time same-route trip behind it', () => {
    const sim = makeSim('weekday', H);
    const at = (t: Sim['trainList'][number]) => t.tasks[0];
    const tr = sim.trainList.find(t => t.phase === 'dwell' && t.inService && at(t)?.k === 'stop'
      && (at(t) as { station: number }).station >= 8 && (at(t) as { station: number }).station <= 16)!;
    expect(tr).toBeDefined();
    expect(sim.command({ c: 'trainHold', train: tr.id, on: true }).ok).toBe(true);
    let partner: ReturnType<typeof exchangePartner> = null;
    for (let i = 0; i < 1500 && !partner; i++) { runFor(sim, 1, stepCheck); partner = exchangePartner(sim, tr); }
    expect(partner).not.toBeNull();
    const w = partner!;
    const before = { tr: tr.tripId, w: w.tripId, trSvc: tr.svc, wSvc: w.svc, trBlock: tr.block, wBlock: w.block };
    expect(sim.command({ c: 'exchangeDuty', train: tr.id, with: w.id }).ok).toBe(true);
    expect([tr.tripId, w.tripId]).toEqual([before.w, before.tr]);
    expect([tr.block, w.block]).toEqual([before.wBlock, before.trBlock]);
    expect([tr.svc, w.svc]).toEqual([before.wSvc, before.trSvc]);
    expect(sim.plan.blocks[tr.block].train).toBe(tr.id);
    expect(sim.plan.blocks[w.block].train).toBe(w.id);
    expect(sim.events.some(e => e.text.includes('车次调整'))).toBe(true);
    // the late trip is not lost: the train behind runs it, after the train in front runs the on-time one
    sim.command({ c: 'trainHold', train: tr.id, on: false });
    const station = (at(tr) as { station: number }).station;
    // each train left the exchange station still running the trip it took over
    const left = (t: typeof tr, trip: number) => t.tripId === trip && !t.tasks.some(x => x.k === 'stop' && x.trip === trip && x.station === station);
    runFor(sim, 900, stepCheck);
    expect(left(tr, before.w)).toBe(true);
    expect(left(w, before.tr)).toBe(true);
    expect(sim.plan.trips[before.tr].cancelled).toBeFalsy();
    expect(sim.plan.trips[before.w].cancelled).toBeFalsy();
  });

  it('hot standby (D70): stands in a turnback track, takes a lost train\'s departure, relieves a late one', () => {
    const sim = makeSim('weekday', 9 * 3600 + 55 * 60, { seed: 5 });
    const E = sim.topo.stations.length - 1;
    const hots = () => sim.trainList.filter(t => [0, E].includes(hotStandby(sim, t)?.station ?? -1));
    const until = 13*3600;
    while (hots().length < 2 && sim.t < until) runFor(sim, 30, stepCheck);
    expect(hots().map(t => hotStandby(sim, t)!.station).sort((a, b) => a - b)).toEqual([0, E]);
    expect(sim.snapshot().trains.filter(t => t.hot).length).toBe(sim.trainList.filter(t => hotStandby(sim, t)).length);
    // it keeps to its track: the departure platform stays free for the turning trains
    for (const h of hots()) expect(sim.topo.stations[hotStandby(sim, h)!.station].turnbackBerths.map(b => sim.topo.berths[b].link)).toContain(h.link);
    const depFrom = (t: Train, st: number) => t.tasks.find((x): x is StopTask => x.k === 'stop' && x.station === st && x.arr === null && x.dep !== null);

    // R3: a train due out of the airport soon is withdrawn; the hot standby there takes its departure
    sim.autoDispatch = true;
    const lost = sim.trainList.filter(t => t.inService && !hotStandby(sim, t) && (d => !!d && d.dep! - sim.t > 600 && d.dep! - sim.t < 1500)(depFrom(t, E)))[0];
    expect(lost).toBeDefined();
    const D = depFrom(lost, E)!;
    const hotE = hots().find(t => hotStandby(sim, t)!.station === E)!;
    expect(sim.command({ c: 'withdraw', train: lost.id }).ok).toBe(true);
    expect(sim.events.some(e => e.text.includes('热备车顶替'))).toBe(true);
    let left = -1;
    runFor(sim, D.dep! - sim.t + 120, (x) => { stepCheck(x); if (left < 0 && hotE.tripId === D.trip && hotE.phase === 'run' && hotE.v > 1) left = x.t; });
    expect(left).toBeGreaterThan(0);
    expect(left - D.dep!).toBeLessThan(60);
    sim.autoDispatch = false;

    // R1 at 蟠祥路: a late westbound train swaps with the standby there and becomes the standby
    const hotW = hots().find(t => hotStandby(sim, t)!.station === 0)!;
    const pick = () => sim.trainList.filter(t => t.inService && t !== hotW && t.phase === 'dwell' && (d => !!d && d.dep! - sim.t > 900 && d.dep! - sim.t < 1500)(depFrom(t, 0)))[0];
    for (let i = 0; i < 120 && !pick(); i++) runFor(sim, 5, stepCheck);
    const late = pick();
    expect(late).toBeDefined();
    const Dw = depFrom(late, 0)!;
    sim.command({ c: 'trainHold', train: late.id, on: true });
    while (predictedLateness(sim, late) < 330 && sim.t < Dw.dep! - 300) runFor(sim, 5, stepCheck);
    sim.command({ c: 'trainHold', train: late.id, on: false });
    const r = sim.command({ c: 'standby', train: late.id });
    expect(r.ok, r.msg).toBe(true);
    expect(r.msg).toContain('转为热备');
    left = -1;
    runFor(sim, Dw.dep! - sim.t + 120, (x) => { stepCheck(x); if (left < 0 && hotW.tripId === Dw.trip && hotW.v > 1 && x.trainChain(hotW) > x.topo.stations[0].chain + 300) left = x.t; });
    expect(left).toBeGreaterThan(0);
    expect(left - Dw.dep!).toBeLessThan(90);
    runFor(sim, 900, stepCheck);
    expect(hotStandby(sim, late)?.station).toBe(0);
  },240_000);

  it('manual route cancel / set at a signal', () => {
    const sim = makeSim('weekday', H);
    const s = sim.topo.signals.find((x) => x.role === 'start' && x.station === 10 && sim.topo.links[x.link].track === 'DN')!;
    expect(sim.sig[s.id].route).toBeGreaterThanOrEqual(0);
    sim.command({ c: 'ars', signal: s.id, on: false });
    // a route with a train in it cannot be cancelled; retry until it is clear
    let c = sim.command({ c: 'cancelRoute', signal: s.id });
    for (let i = 0; i < 300 && !c.ok; i++) { runFor(sim, 1); c = sim.command({ c: 'cancelRoute', signal: s.id }); }
    expect(c.ok).toBe(true);
    runFor(sim, 40);
    expect(sim.sig[s.id].route).toBe(-1);
    const r = s.routes.find((x) => sim.topo.routes[x].fleeting)!;
    expect(sim.command({ c: 'setRoute', route: r }).ok).toBe(true);
    runFor(sim, 10);
    expect(sim.sig[s.id].route).toBe(r);
    sim.command({ c: 'ars', signal: s.id, on: true });
  });
});
