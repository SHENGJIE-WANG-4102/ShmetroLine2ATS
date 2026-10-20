/**
 * Timetable validator (§7): the generated plans of every template, and the plans with
 * each added-service overlay applied, are feasible — turnbacks, terminal capacity,
 * headways (P1), block continuity and fleet size.
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { validatePlan, applyOverlay, OVERLAY_PRESETS, terminalOccupancy, storageOccupancy, hotStandbyPlaces, overnightPlaces, TEMPLATES, dayPeriods, yardNeed, depotLedger, serviceStructureIssues, platformBerth, blockTasks, allocateTerminalServices, buildStops, dwellFactorAt, inboundWindow, outboundWindow, MAX_DIAGRAM_SHIFT_S, depotMoves, terminalReuseRejections, type ServiceRequest } from '../src/sim/timetable';
import { buildTopology } from '../src/sim/topology';
import { computeRunTimes } from '../src/sim/dynamics';
import { plannedDwell } from '../src/sim/calibration';
import type { DayType } from '../src/sim/model';
import { SCENARIOS } from '../src/sim/scenario';
import { STATIONS, OPERATIONS, LINE_INFO } from '../src/data/line2';
import { FIRST_LAST } from '../src/data/firstlast';
import { readFileSync } from 'node:fs';
import { preparePlan, addedPlanErrors, noWorse } from '../src/sim/planning';
import { takeVehicle, putVehicle } from '../src/sim/yard';
import { addPossession } from '../src/sim/env';

describe('live extras with existing yard imbalance and engineering work', () => {
  const fixture = () => {
    const sim = new Sim({ dayType:'weekday',dateLabel:'inventory',startTime:14400,seed:3,noPossessions:true });
    for (const tr of [...sim.trainList]) sim.removeTrain(tr);
    for (const b of sim.plan.blocks) sim.blockDone.add(b.id);
    for (const t of sim.plan.trips) t.completed = true;
    sim.plan.blocks.find(b=>b.end.kind==='depot'&&b.end.depot===2)!.withdrawal={depot:0,at:24*3600+20*60};
    putVehicle(sim,0,takeVehicle(sim,2)!);
    sim.t=24*3600+38*60;
    return sim;
  };
  const command={c:'addTrain' as const,depot:2,dir:'DN' as const,to:30,time:24*3600+54*60};
  it('allows a same-yard airport round trip and reports the unchanged historical imbalance as a warning',()=>{
    const sim=fixture(),before=depotLedger(sim.topo,sim.plan);
    const preview=preparePlan(sim,command);
    expect(preview.ok,preview.msg).toBe(true);
    expect(depotLedger(sim.topo,preview.plan).final).toEqual(before.final);
    const issues=preview.issues.filter(i=>i.code==='YARD_BALANCE');
    expect(issues.map(i=>[i.depot,i.delta,i.severity])).toEqual([[0,1,'warn'],[2,-1,'warn']]);
    expect(issues.every(i=>i.t>sim.t)).toBe(true); // old error clock was 00:20, the candidate clock is later
    expect(preview.warnings?.join('')).toContain('已有问题');
  });
  it('rejects an increased per-yard deficit but permits an improvement regardless of summary timestamps',()=>{
    const sim=fixture(),preview=preparePlan(sim,command),bad=structuredClone(preview.plan);
    bad.blocks.at(-1)!.end={kind:'depot',depot:0};
    expect(noWorse(sim,bad)).toBe(false);
    expect(addedPlanErrors(sim,bad).filter(i=>i.code==='YARD_BALANCE').map(i=>[i.depot,i.delta])).toEqual([[0,2],[2,-2]]);
    const better=structuredClone(preview.plan),block=better.blocks.at(-1)!;
    if(block.start.kind!=='depot')throw new Error('expected yard origin');
    block.start.depot=0;
    expect(addedPlanErrors(sim,better).filter(i=>i.code==='YARD_BALANCE')).toEqual([]);
  });
  it('rejects a path crossing current construction and allows an unrelated possession',()=>{
    const sim=fixture();
    const unrelated=addPossession(sim,5,26*3600);
    expect(preparePlan(sim,command).ok).toBe(true);
    unrelated.state='done';
    addPossession(sim,28,26*3600);
    const preview=preparePlan(sim,command);
    expect(preview.ok).toBe(false);
    expect(preview.issues.some(i=>i.code==='POSSESSION'&&i.text.includes('远东大道—海天三路'))).toBe(true);
  });
  it('checks planned work by its run window and keeps an overdue unsurrendered block in force',()=>{
    const sim=fixture(),p=addPossession(sim,28,26*3600);
    p.state='planned';p.from=25*3600;
    expect(preparePlan(sim,command).ok).toBe(false);
    p.from=26.5*3600;p.to=27.5*3600;
    expect(preparePlan(sim,command).ok).toBe(true);
    p.from=24*3600;p.to=25*3600;p.state='active';sim.t=26*3600;
    const preview=preparePlan(sim,{...command,time:sim.t+15*60});
    expect(preview.ok).toBe(false);expect(preview.issues.some(i=>i.code==='POSSESSION')).toBe(true);
  });
});

const fmtIssues = (xs: { code: string; text: string }[]) => xs.map((i) => `${i.code} ${i.text}`).join('\n');

describe('daily depot homes', () => {
  for (const dayType of ['weekday', 'weekend'] as const) {
    const sim = new Sim({ dayType, dateLabel: 'daily depot ledger', startTime: 14400, seed: 1 });
    it(`${dayType}: credits a physical withdrawal instead of its former overnight berth`, () => {
      const plan = structuredClone(sim.plan);
      const b = plan.blocks.find(b=>b.start.kind==='depot'&&b.end.kind==='stable')!;
      for (const id of b.trips) plan.trips[id].cancelled = true;
      b.withdrawal = {depot:1,at:12*3600};
      const events = depotLedger(sim.topo,plan).events.filter(e=>e.block===b.id);
      expect(events.map(e=>[e.depot,e.delta])).toEqual([[b.start.kind==='depot'?b.start.depot:-1,-1],[1,1]]);
      expect(storageOccupancy(sim.topo,plan).some(o=>o.block===b.id)).toBe(false);
    });
    it(`${dayType}: closes every yard with direct returns or a required through working`, () => {
      const ledger = depotLedger(sim.topo, sim.plan);
      expect(ledger.initial).toEqual(sim.depotStock);
      expect(ledger.final).toEqual(ledger.initial);
      ledger.peak.forEach((n, depot) => expect(n).toBeLessThanOrEqual(sim.topo.depots[depot].capacity));
      for (const block of sim.plan.blocks) {
        if (block.end.kind !== 'depot') continue;
        const last = block.trips.map(id => sim.plan.trips[id]).filter(t => !t.cancelled && t.revenue).at(-1)!;
        if (!last) continue; // dedicated hot spares only position and return
        const depot = sim.topo.depots[block.end.depot];
        const home = OPERATIONS.depotReturns.find(rule => rule.depot === depot.key)!;
        if (STATIONS[last.to].id === home.service?.terminal) {
          expect(last.dir).toBe(home.dir);
          const tail = block.trips.slice(block.trips.indexOf(last.id) + 1).map(id => sim.plan.trips[id]);
          expect(tail.length, `block ${block.svc} must physically return from the terminal`).toBeGreaterThan(0);
          expect(tail.every(t => !t.revenue && t.from === last.to && STATIONS[t.to].id === home.station && t.dir !== last.dir)).toBe(true);
          expect(blockTasks(sim.topo, sim.plan, block).some(task => task.k === 'depot' && task.depot === depot.id)).toBe(true);
        } else expect([last.dir, STATIONS[last.to].id], `block ${block.svc}`).toEqual([home.dir, home.station]);
      }
      const home = OPERATIONS.depotReturns.find(rule => rule.service)!;
      const yard = sim.topo.depots.find(d => d.key === home.depot)!;
      const retired = sim.plan.blocks.filter(block => block.end.kind === 'depot' && block.end.depot === yard.id);
      const via = retired.filter(block => {
        const last = block.trips.map(id => sim.plan.trips[id]).filter(t => t.revenue && !t.cancelled).at(-1);
        return last && STATIONS[last.to].id === home.service!.terminal;
      });
      expect(via.length).toBeGreaterThan(0);
      expect(via.length).toBeLessThan(retired.length / 2);
      expect(validatePlan(sim.planCtx, sim.plan).filter(issue => issue.severity === 'error')).toEqual([]);
      expect(sim.plan.fleetPeak).toBeLessThanOrEqual(86);
    });
    it(`${dayType}: rejects one train returning to the wrong yard`, () => {
      const plan = structuredClone(sim.plan);
      const from = sim.topo.depots.findIndex(yard => yard.key === 'LYD');
      const to = sim.topo.depots.findIndex(yard => yard.key === 'CSD');
      const block = plan.blocks.find(block => block.end.kind === 'depot' && block.end.depot === from)!;
      block.end = { kind: 'depot', depot: to };
      const errors = validatePlan(sim.planCtx, plan).filter(issue => issue.severity === 'error');
      expect(errors.filter(issue => issue.code === 'YARD_BALANCE')).toHaveLength(2);
      expect(errors.some(issue => issue.code === 'YARD_CAPACITY')).toBe(true);
    });
    it(`${dayType}: detects intraday overflow even when the final balance closes`, () => {
      const plan = structuredClone(sim.plan);
      const block = plan.blocks.find(block => block.end.kind === 'depot')!;
      plan.trips[block.trips.at(-1)!].stops.at(-1)!.arr = 14400 - 301;
      const issues = validatePlan(sim.planCtx, plan);
      expect(issues.some(issue => issue.code === 'YARD_CAPACITY')).toBe(true);
      expect(issues.some(issue => issue.code === 'YARD_BALANCE')).toBe(false);
    });
  }
  it('keeps the airport service running through withdrawal without adding passenger departures', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'withdrawal coverage', startTime: 14400, seed: 1 });
    const airport = sim.topo.stations.find(st => st.id === 'PDA')!.index;
    const calls = sim.plan.trips.filter(t => t.revenue && !t.cancelled && t.dir === 'DN' && t.to === airport)
      .map(t => t.stops.at(-1)!.arr).filter(at => at >= 22 * 3600).sort((a,b) => a-b);
    expect(calls.length).toBeGreaterThan(8);
    expect(Math.max(...calls.slice(1).map((at,i) => at-calls[i]))).toBeLessThan(16 * 60);
    // The data rule adds no passenger departures. Core calls retain their
    // clocks; east-only depot feeders can refit to the shared-lead windows.
    const rule = OPERATIONS.depotReturns.find(rule => rule.service)!;
    const saved = rule.service;
    try {
      delete rule.service;
      const direct = new Sim({ dayType: 'weekday', dateLabel: 'direct withdrawal', startTime: 14400, seed: 1 });
      const signature = (sim: Sim) => sim.plan.trips.filter(t => t.revenue && !t.cancelled).map(t => [t.dir,t.from,
        t.stops.filter(stop => stop.st <= sim.topo.stations.find(st => st.id === 'GLL')!.index)
          .map(stop => [stop.st,stop.arr,stop.dep])]);
      expect(signature(sim)).toEqual(signature(direct));
      expect(direct.plan.trips.filter(t => !t.revenue && t.from === airport && t.to === sim.topo.depots.find(d => d.key === rule.depot)!.station)).toHaveLength(0);
    } finally { rule.service = saved; }
  });
});

describe('shared depot lead turnbacks', () => {
  for (const dayType of ['weekday', 'weekend'] as const) {
    const sim = new Sim({ dayType, dateLabel: 'shared lead', startTime: 14400, seed: 1 });
    for (const delta of [1, -1]) it(`${dayType}: rejects a turn waiting across a shared-lead ${delta > 0 ? 'entry' : 'exit'}`, () => {
      const plan = structuredClone(sim.plan);
      const yard = sim.topo.depots.find(yard => yard.key === 'CSD')!;
      const move = depotMoves(plan.blocks, plan.trips, sim.planCtx).find(move => move.depot === yard.id
        && move.delta === delta && move.window && move.link !== undefined)!;
      expect(move).toBeDefined();
      const [start, end] = move.window!;
      const id = plan.trips.length, block = plan.blocks.length, station = yard.station;
      const a = { ...structuredClone(plan.trips[0]), id, no: 'test-arrival', block, dir: 'DN' as const,
        from: station - 1, to: station, stops: [{ st: station, arr: start - 60, dep: start - 60, stop: true }] };
      const d = { ...a, id: id + 1, no: 'test-departure', dir: 'UP' as const, from: station, to: station - 1,
        stops: [{ st: station, arr: end + 60, dep: end + 60, stop: true }] };
      plan.trips.push(a, d);
      plan.blocks.push({ id: block, svc: 'test', start: { kind: 'stable', station: a.from }, end: { kind: 'none' }, trips: [id, id + 1] });
      const turn = terminalOccupancy(plan, sim.topo).get(station)!.find(hold => hold.block === block)!;
      expect(sim.topo.berths[turn.berths![0]].link).toBe(move.link);
      const conflict = () => validatePlan(sim.planCtx, plan).filter(issue => issue.code === 'DEPOT_CONFLICT'
        && issue.blocks?.[0] === move.block && issue.blocks[1] === block);
      expect(conflict()).toHaveLength(1);
      expect(conflict()[0].text).toContain('test-arrival→test-departure');
      // A hold starting at the resource's clearing boundary no longer overlaps.
      a.stops[0].arr = a.stops[0].dep = end;
      expect(conflict()).toEqual([]);
      plan.trips[a.id].cancelled = true;
      expect(terminalOccupancy(plan, sim.topo).get(station)?.some(hold => hold.block === block) ?? false).toBe(false);
    });
    it(`${dayType}: keeps depot return windows and the published fleet feasible`, () => {
      const moves = depotMoves(sim.plan.blocks, sim.plan.trips, sim.planCtx).filter(move => move.delta > 0 && move.window
        && ['4091', '4089'].includes(sim.plan.trips[move.trip!].no));
      if (dayType === 'weekday') expect(moves).toHaveLength(2);
      for (let i = 0; i < moves.length; i++) for (let j = i + 1; j < moves.length; j++) {
        const a = moves[i], b = moves[j];
        if (a.link !== b.link) continue;
        expect(a.window![0] >= b.window![1] || b.window![0] >= a.window![1],
          `${sim.plan.trips[a.trip!].no}/${sim.plan.trips[b.trip!].no}`).toBe(true);
      }
      expect(validatePlan(sim.planCtx, sim.plan).filter(issue => issue.severity === 'error')).toEqual([]);
      expect(sim.plan.fleetPeak).toBeLessThanOrEqual(LINE_INFO.fleet);
      if (dayType === 'weekday') expect(terminalReuseRejections(sim.plan).some(text => text.startsWith('4091→4148：') && text.includes('4089'))).toBe(true);
    });
  }
});

describe('D73 calibrated service anchors', () => {
  const H = (h: number, m = 0) => h * 3600 + m * 60;
  const clock = (s: string) => { const [h, m] = s.split(':').map(Number); return H(h, m); };
  const sim = new Sim({ dayType: 'weekday', dateLabel: 'calibration anchors', startTime: H(4), seed: 1 });
  const live = sim.plan.trips.filter(t => t.revenue && !t.cancelled);
  it('fixes all three last origins and matches official end-to-end arrivals within a minute', () => {
    for (const [dir, from, to, departure, arrival] of [
      ['DN', 0, 30, H(21, 57), H(23, 31)],
      ['UP', 30, 0, H(22, 30), H(24, 5)],
      ['DN', 0, 22, H(22, 42), H(23, 44)],
    ] as const) {
      const trip = live.filter(t => t.dir === dir && t.from === from && t.to === to)
        .sort((a, b) => a.stops[0].dep - b.stops[0].dep).at(-1)!;
      expect(trip.stops[0].dep).toBe(departure);
      expect(Math.abs(trip.stops.at(-1)!.arr - arrival)).toBeLessThanOrEqual(60);
    }
    expect(OPERATIONS.lastBigWestboundDep).toBe(H(22, 30));
  });
  it('has no westbound GLL passenger origins after the published last train', () => {
    expect(live.filter(t => t.dir === 'UP' && t.from === 22 && t.stops[0].dep > H(23, 2))).toHaveLength(0);
  });
  it('stables the last revenue arrivals at the terminal overnight stations', () => {
    for (const [st, count] of [[0, 2], [30, 1], [22, 2]]) {
      const expected = live.filter(t => t.to === st).sort((a, b) => b.stops.at(-1)!.arr - a.stops.at(-1)!.arr)
        .slice(0, count).map(t => t.id).sort((a, b) => a - b);
      const actual = sim.plan.blocks.filter(b => b.end.kind === 'stable' && b.end.station === st)
        .map(b => b.trips.at(-1)!).sort((a, b) => a - b);
      expect(actual, STATIONS[st].name).toEqual(expected);
    }
    const gll = sim.plan.blocks.filter(b => b.end.kind === 'stable' && b.end.station === 22)
      .sort((a, b) => sim.plan.trips[a.trips.at(-1)!].stops.at(-1)!.arr - sim.plan.trips[b.trips.at(-1)!].stops.at(-1)!.arr);
    expect(gll[0].end).toMatchObject({ berth: sim.topo.stations[22].turnbackBerths[0] });
    expect(gll[1].end).toMatchObject({ berth: platformBerth(sim.topo, 22, 'DN') });
  });
  it('matches every published first/last minute within two minutes, including terminal arrivals', () => {
    for (const [st, row] of FIRST_LAST.entries()) {
      for (const [key, dir, terminal, last] of [
        ['firstE', 'DN', 30, false], ['firstW', 'UP', 0, false],
        ['lastE', 'DN', 30, true], ['lastW', 'UP', 0, true], ['lastG', 'DN', 22, true],
      ] as const) {
        if (!row[key] || (row.station === '唐镇' && key === 'firstW')) continue;
        const times = live.filter(t => t.dir === dir && (key === 'lastG' ? t.stops.some(s => s.st === 22) : t.to === terminal))
          .flatMap(t => t.stops.filter(s => s.st === st && s.stop && (t.to === st ? st === terminal : !s.noBoard))
            .map(s => t.to === st ? s.arr : s.dep));
        expect(times.length, `${row.station} ${key}`).toBeGreaterThan(0);
        const ours = last ? Math.max(...times) : Math.min(...times);
        expect(Math.abs(ours - clock(row[key])), `${row.station} ${key}`).toBeLessThanOrEqual(120);
      }
    }
  });
  it('keeps the retimed peak fleet within the available trainsets and yard stock', () => {
    const count = (time: number) => new Set(live.filter(t => t.stops[0].dep <= time && t.stops.at(-1)!.arr > time).map(t => t.block)).size;
    expect(sim.plan.fleetPeak).toBeLessThanOrEqual(86);
    for(const [i,need]of yardNeed(sim.topo,sim.plan).entries())expect(need).toBeLessThanOrEqual(sim.topo.depots[i].capacity);
    expect(count(H(8))).toBeGreaterThan(count(H(12)));
    expect(count(H(18,30))).toBeGreaterThan(count(H(16)));
    for (let at = H(6, 50); at < H(10); at += 60) expect(count(at)).toBeLessThanOrEqual(80);
  });
  it('keeps ZJG opening sparse before the 07:03 peak wave rather than filling it from 06:00', () => {
    const calls=live.filter(t=>t.dir==='UP').flatMap(t=>t.stops.filter((p,k)=>p.st===20&&p.stop&&!p.noBoard&&k<t.stops.length-1).map(p=>p.arr));
    const count=(a:number,b:number)=>calls.filter(t=>t>=a&&t<b).length;
    expect(count(H(6,15),H(6,30))).toBeLessThanOrEqual(3);
    expect(count(H(6,45),H(7))).toBeLessThanOrEqual(3);
    expect(count(H(7,15),H(7,30))).toBe(6);
  });
});

describe('D79–D81 Gaode service distribution', () => {
  const sim = new Sim({ dayType: 'weekday', dateLabel: 'Gaode bins', startTime: 14400, seed: 1 });
  const s = sim;
  const checks = [['北新泾', 'UP'], ['世纪公园', 'UP'], ['世纪公园', 'DN'], ['张江高科', 'UP'], ['张江高科', 'DN']] as const;
  it('leaves at most eleven two-train misses across all checked windows and no three-train misses', () => {
    let bad = 0;
    for (const [name, dir] of checks) {
      const gaode = new TextDecoder().decode(readFileSync(`reference/timetable-gaode/${name}-${dir}-weekday.txt`))
        .split(/\r?\n/).filter(line => /^\d\d:\d\d/.test(line))
        .map(line => +line.slice(0, 2) * 60 + +line.slice(3, 5));
      const station = sim.topo.stations.findIndex(st => st.name === name);
      const plan = sim.plan.trips.filter(t => t.revenue && !t.cancelled && t.dir === dir)
        .flatMap(t => t.stops.filter((stop, index) => stop.st === station && stop.stop && !stop.noBoard && index < t.stops.length - 1)
          .map(stop => Math.floor(stop.arr / 60)));
      for (const [from, to] of [[360, 660], [960, 1290], [1290, 1410]]) {
        for (let at = from; at < to; at += 15) {
          const difference = plan.filter(t => t >= at && t < at + 15).length - gaode.filter(t => t >= at && t < at + 15).length;
          expect(Math.abs(difference), `${name} ${dir} ${at}`).toBeLessThan(3);
          if (Math.abs(difference) >= 2) bad++;
        }
      }
    }
    expect(bad).toBeLessThanOrEqual(11);
  });
  it('keeps the last GLL westbound short service at 20:55 and uses LYL for late carrying returns',()=>{
    expect(s.plan.trips.some(t=>!t.cancelled&&t.revenue&&t.dir==='UP'&&t.from===22&&t.to===0&&t.stops[0].dep===20*3600+55*60)).toBe(true);
    expect(s.plan.trips.filter(t=>!t.cancelled&&t.revenue&&t.dir==='DN'&&t.to===19&&t.stops.at(-1)!.arr>=22.5*3600&&t.stops.at(-1)!.arr<23.5*3600).length).toBeGreaterThanOrEqual(3);
    const returns=s.plan.trips.filter(t=>!t.cancelled&&t.revenue&&t.dir==='DN'&&t.to===19&&t.stops.at(-1)!.arr>=22.5*3600);
    for(const trip of returns) expect(s.plan.blocks[trip.block].end).toEqual({kind:'depot',depot:s.topo.depots.findIndex(yard=>yard.key==='LYD')});
  });
});

describe('terminal service allocation before trip creation', () => {
  const topo = buildTopology();
  const ctx = { topo, rt: computeRunTimes(topo, LINE_INFO.trainLength), dayType: 'weekend' as const };
  const factor = (time: number) => dwellFactorAt(ctx.dayType, time);
  const request = (id: number, dir: 'UP' | 'DN', departure: number): ServiceRequest => {
    const from = dir === 'DN' ? 0 : 30, to = dir === 'DN' ? 30 : 0;
    return { id, dir, kind: 'big', from, to, revenue: true, stops: buildStops(ctx, dir, from, to, departure, true, factor) };
  };
  const incoming = (id: number, at: number) => {
    let start = at - buildStops(ctx, 'UP', 30, 0, 0, true, factor).at(-1)!.arr;
    for (let k = 0; k < 8; k++) start -= buildStops(ctx, 'UP', 30, 0, start, true, factor).at(-1)!.arr - at;
    return request(id, 'UP', start);
  };
  for (const hour of [12, 13]) {
    it(`${hour}: uses an available arrival instead of scheduling another depot car, without editing requests`, () => {
      const at = hour * 3600;
      const requests = Array.from({ length: 4 }, (_, id) => request(id, 'DN', at + id * 300));
      requests.push(incoming(4, at + 2400), request(5, 'DN', at + 2760));
      const before = structuredClone(requests);
      for (const service of requests) {
        for (const stop of service.stops) Object.freeze(stop);
        Object.freeze(service.stops);
        Object.freeze(service);
      }
      const result = allocateTerminalServices(ctx, Object.freeze(requests));
      expect(requests).toEqual(before);
      expect(result.supply.pairs.get(4)).toBe(5);
      expect(result.supply.feeders.has(5)).toBe(false);
      const later = [...before.slice(0, 4), incoming(4, at + 2580), before[5]];
      const changed = allocateTerminalServices(ctx, later);
      expect(changed.supply.pairs.has(4)).toBe(false);
      expect(changed.supply.feeders.has(5) || changed.services[5].from !== 0).toBe(true);
    });
    it(`${hour}: allocates a burst against real places while preserving every core slot`, () => {
      const at = hour * 3600;
      const requests = Array.from({ length: 4 }, (_, id) => request(id, 'DN', at + id * 300));
      for (let i = 0; i < 10; i++) requests.push(incoming(requests.length, at + 2400 + i * 90));
      for (let i = 0; i < 10; i++) requests.push(request(requests.length, 'DN', at + 3300 + i * 180));
      const before = structuredClone(requests);
      const { services, supply } = allocateTerminalServices(ctx, requests);
      expect(requests).toEqual(before);
      expect(services).toHaveLength(requests.length);
      const intervals: { station: number; from: number; to: number }[] = [];
      for (const [arrival, departure] of supply.pairs) intervals.push({ station: services[arrival].to,
        from: services[arrival].stops.at(-1)!.arr, to: services[departure].stops[0].dep });
      for (const [arrival, move] of supply.withdrawals) intervals.push({ station: services[arrival].to,
        from: services[arrival].stops.at(-1)!.arr, to: move.stops[0].dep });
      for (const [departure, move] of supply.feeders) intervals.push({ station: services[departure].from,
        from: move.stops.at(-1)!.arr, to: services[departure].stops[0].dep });
      for (const place of intervals) {
        expect(intervals.filter(other => other.station === place.station && other.from <= place.from && other.to > place.from).length)
          .toBeLessThanOrEqual(3);
      }
      for (const [id, selected] of services.entries()) {
        for (const call of requests[id].stops.filter(stop => stop.st >= 4 && stop.st <= 22)) {
          const actual = selected.stops.find(stop => stop.st === call.st)!;
          expect(actual).toBeDefined();
          expect(call.st === (selected.dir === 'DN' ? 22 : 4) ? actual.arr : actual.dep)
            .toBe(call.st === (selected.dir === 'DN' ? 22 : 4) ? call.arr : call.dep);
        }
      }
    });
  }
});

describe('laid-out service protection', () => {
  for (const dayType of ['weekday', 'weekend'] as const) {
    it(`${dayType}: preserves every laid-out route and publishes no cancelled depot candidates`, () => {
      const sim = new Sim({ dayType, dateLabel: 'layout guard', startTime: 14400, seed: 1 });
      expect(serviceStructureIssues(sim.plan)).toEqual([]);
      expect(sim.plan.trips.filter(t => t.cancelled)).toHaveLength(0);
      for (const block of sim.plan.blocks) for (let i = 1; i < block.trips.length; i++) {
        const before = sim.plan.trips[block.trips[i - 1]], after = sim.plan.trips[block.trips[i]];
        if (after.kind !== 'ins' || !after.revenue || before.to !== after.from || before.dir !== after.dir || !before.stops.at(-1)!.stop) continue;
        const arrival = before.stops.at(-1)!.arr;
        const boarding = plannedDwell(dayType, after.from, after.dir, arrival, dwellFactorAt(dayType, arrival));
        expect(after.stops[0].dep - arrival, `boarding before continuation ${after.no}`).toBeGreaterThanOrEqual(boarding);
      }
      const trip = sim.plan.trips.find(t => t.revenue && t.from === 30 && t.to === 0)!;
      const from = trip.from;
      trip.from = 19;
      expect(serviceStructureIssues(sim.plan).some(i => i.code === 'SERVICE_STRUCTURE')).toBe(true);
      trip.from = from;
      trip.cancelled = true;
      expect(serviceStructureIssues(sim.plan).some(i => i.code === 'SERVICE_STRUCTURE')).toBe(true);
      trip.cancelled = false;
      expect(serviceStructureIssues(sim.plan)).toEqual([]);
    });
  }
});

describe('D72 timetable structure', () => {
  const H = (h: number, m = 0) => h * 3600 + m * 60;
  const make = (dayType: DayType) => new Sim({ dayType, dateLabel: 'structure', startTime: H(4), seed: 1 });
  it('uses a 150-second weekday AM core headway within the bounded diagram shift', () => {
    expect(TEMPLATES.weekdayAM.headway).toBe(150);
    const sim = make('weekday');
    for (const dir of ['DN', 'UP'] as const) {
      const times = sim.plan.trips.filter(t => !t.cancelled && t.dir === dir && t.revenue && t.to !== (dir === 'DN' ? 4 : 22))
        .flatMap(t => t.stops.filter(s => s.st === (dir === 'DN' ? 4 : 22) && s.dep >= H(7, 30) && s.dep < H(8, 30)).map(s => s.dep)).sort((a, b) => a - b);
      expect(times.length).toBeGreaterThan(20);
      for (let i = 1; i < times.length; i++) expect(Math.abs(times[i] - times[i - 1] - 150)).toBeLessThanOrEqual(2 * MAX_DIAGRAM_SHIFT_S + .001);
      expect(Math.abs((times.at(-1)! - times[0]) / (times.length - 1) - 150)).toBeLessThan(1);
    }
  });
  it('keeps short routes at 20:30, then closes them with passenger-carrying withdrawals', () => {
    const sim = make('weekday');
    const live = sim.plan.trips.filter(t => t.revenue && !t.cancelled);
    expect(live.some(t => t.from === 22 && t.to === 4 && t.stops[0].dep <= H(20, 30) && t.stops.at(-1)!.arr > H(20, 30))).toBe(true);
    expect(live.filter(t => t.kind === 'small' && t.stops.at(-1)!.arr > H(21, 10))).toHaveLength(0);
    // Retirement is distributed by daily homes rather than the old single
    // 20:55 portal-arrival anchor; the extended western stream is mixed.
    for (const to of [19,28,30]) expect(live.some(t => t.dir === 'DN' && t.to === to
      && t.stops.some(s => s.st === 4 && s.dep >= H(20,15) && s.dep <= H(21,15)))).toBe(true);
    expect(live.some(t => t.kind === 'wd' && t.dir === 'UP' && t.from === 22 && t.to === 0 && Math.abs(t.stops[0].dep - H(20, 55)) <= 180)).toBe(true);
    expect(dayPeriods('weekday').some(p => p.template === 'weekdayEvening')).toBe(false);
    expect(dayPeriods('weekend').find(p => p.from === H(21))?.template).toBe('weekdayEvening');
  });
  for (const dayType of ['weekday', 'weekend'] as const) {
    it(`${dayType}: official first trains and eight overnight trains fit the yards`, () => {
      const sim = make(dayType), { plan, topo } = sim;
      for (const [id, dir] of [['LYL', 'UP'], ['KJG', 'UP'], ['GLL', 'UP'], ['PXL', 'DN'], ['GLL', 'DN'], ['PDA', 'UP']] as const) {
        const st = STATIONS.findIndex(s => s.id === id);
        const row = FIRST_LAST.find(r => r.station === STATIONS[st].name)!;
        const [h, m] = (dir === 'DN' ? row.firstE : row.firstW).split(':').map(Number);
        const departures = plan.trips.filter(t => !t.cancelled && t.revenue && t.dir === dir && t.to !== st)
          .flatMap(t => t.stops.filter(s => s.st === st && s.stop && !s.noBoard).map(s => s.dep));
        const first = Math.min(...departures);
        expect(first, `${id} ${dir}`).toBeGreaterThanOrEqual(H(h, m) - .001);
        expect(first, `${id} ${dir}`).toBeLessThanOrEqual(H(h, m) + 60);
      }
      // the first trains open the line: they board all the way, wherever run
      // times put them against the published minutes
      const opener = (dir: 'UP' | 'DN', from: string, dep: number) => plan.trips.find(t => !t.cancelled && t.dir === dir
        && STATIONS[t.stops[0].st].id === from && Math.abs(t.stops[0].dep - dep) < 60);
      for (const [dir, from, dep] of [['DN', 'PXL', H(5, 25)], ['UP', 'LYL', H(5, 20)], ['UP', 'GLL', H(5, 28)], ['DN', 'GLL', H(6)], ['UP', 'PDA', H(6)]] as const) {
        const t = opener(dir, from, dep);
        expect(t, `${from} ${dir}`).toBeDefined();
        expect(t!.revenue).toBe(true);
        expect(t!.stops.filter(s => s.stop && s.noBoard && s.st !== t!.to).map(s => STATIONS[s.st].id), `${from} ${dir}`).toEqual([]);
      }
      expect(plan.blocks.filter(b => b.start.kind === 'stable')).toHaveLength(8);
      expect(plan.blocks.filter(b => b.start.kind === 'stable' && b.start.station === 17)).toHaveLength(2);
      expect(plan.blocks.filter(b => b.start.kind === 'stable' && b.start.station === 24)).toHaveLength(1);
      const gll = plan.blocks.filter(b => b.start.kind === 'stable' && b.start.station === 22);
      expect(gll).toHaveLength(2);
      for (const b of gll) {
        const first = plan.trips[b.trips[0]];
        expect(first.stops[0].dep).toBe(first.dir === 'UP' ? H(5, 28) : H(6));
        if (b.start.kind !== 'stable') throw new Error('stable');
        const berth = topo.berths[b.start.berth!];
        expect(berth.platform === topo.stations[22].platforms.DN).toBe(first.dir === 'DN');
        expect(blockTasks(topo, plan, b).find(t => t.k === 'stop')).toMatchObject({ berth: b.start.berth });
        expect(sim.trainList.find(t => t.block === b.id)?.dir).toBe(first.dir === 'DN' ? 1 : -1);
      }
      sim.step(); sim.step();
      for (const b of gll) expect(sim.trainList.find(t => t.block === b.id)?.doorsOpen).toBe(false);
      expect(sim.integrity.violations).toHaveLength(0);
      expect(plan.blocks.filter(b => b.end.kind === 'stable' && b.end.station === 22)).toHaveLength(2);
      expect(yardNeed(topo, plan).every((n, d) => n <= topo.depots[d].capacity)).toBe(true);
      expect(sim.depotStock.every((n, d) => n <= topo.depots[d].capacity)).toBe(true);
      expect(fmtIssues(validatePlan(sim.planCtx, plan))).toBe('');
    });
    it(`${dayType}: protects GLL's DN overnight platform through midnight and the next opening`, () => {
      const sim = make(dayType), { plan, topo } = sim;
      const berth = platformBerth(topo, 22, 'DN');
      const night = plan.blocks.find(b => b.end.kind === 'stable' && b.end.berth === berth)!;
      const last = plan.trips[night.trips.at(-1)!];
      const morning = plan.blocks.find(b => b.start.kind === 'stable' && b.start.berth === berth)!;
      const first = plan.trips[morning.trips[0]];
      for (const t of plan.trips) {
        if (t.cancelled || t.dir !== 'DN' || t.id === last.id || t.id === first.id) continue;
        const tasks = blockTasks(topo, plan, plan.blocks[t.block]);
        const at = t.stops.find(s => s.st === 22);
        if (!at || !tasks.some(task => task.k === 'stop' && task.trip === t.id && task.berth === berth) && t.to === 22) continue;
        expect(at.dep).toBeLessThan(last.stops.at(-1)!.arr);
        expect(at.arr).toBeGreaterThanOrEqual(first.stops[0].dep);
      }
      // A returning empty train must be rejected too, even if it is a fixed
      // special or a next-day depot positioning trip rather than revenue.
      const conflicting = plan.trips.find(t => t.dir === 'DN' && t.to > 22 && !t.cancelled)!;
      conflicting.revenue = false;
      conflicting.stops.find(s => s.st === 22)!.arr = H(5, 50);
      conflicting.stops.find(s => s.st === 22)!.dep = H(5, 50);
      expect(validatePlan(sim.planCtx, plan).some(i => i.code === 'STABLE_CONFLICT' && i.blocks?.includes(conflicting.block))).toBe(true);
    });
  }
});

describe('timetable validator', () => {
  for (const dayType of ['weekday', 'weekend'] as DayType[]) {
    it(`${dayType} plan has no issues`, () => {
      const sim = new Sim({ dayType, dateLabel: 'test', startTime: 4 * 3600, seed: 1 });
      const issues = validatePlan(sim.planCtx, sim.plan);
      expect(fmtIssues(issues)).toBe('');
      expect(sim.plan.trips.some((t) => t.revenue)).toBe(true);
    });
    for (const p of OVERLAY_PRESETS) {
      it(`${dayType} + overlay ${p.id} has no errors`, () => {
        const sim = new Sim({ dayType, dateLabel: 'test', startTime: 4 * 3600, seed: 1 });
        // as ordered from the dispatcher before service: base blocks may be extended (D47)
        applyOverlay(sim.planCtx, sim.plan, p, { now: sim.t, canExtend: () => true });
        const issues = validatePlan(sim.planCtx, sim.plan).filter((i) => i.severity === 'error');
        expect(fmtIssues(issues)).toBe('');
        // a front-turn end may be served by turning at the next rear turnback beyond it (D47)
        const serves = (t: typeof sim.plan.trips[number], x: number, y: number) => {
          const i = t.stops.findIndex(s => s.st === x), j = t.stops.findIndex(s => s.st === y);
          return i >= 0 && j > i;
        };
        expect(sim.plan.trips.some(t => !t.cancelled && t.overlay && t.revenue && serves(t, p.a, p.b))).toBe(true);
        expect(sim.plan.trips.some(t => !t.cancelled && t.overlay && t.revenue && serves(t, p.b, p.a))).toBe(true);
      });
    }
  }
  it('keeps one hot standby at each table location and shares storage only at different times', () => {
    for (const dayType of ['weekday', 'weekend'] as DayType[]) {
      const sim = new Sim({ dayType, dateLabel: 'test', startTime: 4 * 3600, seed: 1 });
      const { plan, topo } = sim;
      const E = topo.stations.length - 1;
      const at = (st: number, t: number) => plan.blocks.filter(b => {
        const ts = b.trips.map(id => plan.trips[id]).filter(x => !x.cancelled);
        return ts.some((x, i) => x.standby && x.to === st && ts[i + 1] && x.stops.at(-1)!.arr <= t && ts[i + 1].stops[0].dep > t);
      });
      for (const st of hotStandbyPlaces(topo).map(p => p.station)) {
        // midday: exactly one, and the other trains turn within the remaining places
        expect(at(st, 13 * 3600).length, `${dayType} ${STATIONS[st].name}`).toBe(1);
        const occ = terminalOccupancy(plan).get(st)!;
        const busy = (t: number) => occ.filter(o => o.from <= t && o.to > t).length;
        for (let t = 11 * 3600; t < 14 * 3600; t += 60) expect(busy(t)).toBeLessThanOrEqual(3);
      }
      const places = storageOccupancy(topo, plan);
      for (const p of overnightPlaces(topo)) {
        expect(plan.blocks.filter(b => b.start.kind === 'stable' && b.start.berth === p.berth)).toHaveLength(1);
        expect(plan.blocks.filter(b => b.end.kind === 'stable' && b.end.berth === p.arrivalBerth)).toHaveLength(1);
      }
      for (const [i, a] of places.entries()) for (const b of places.slice(i + 1)) {
        if (a.link === b.link && a.block !== b.block) expect(a.from < b.to && b.from < a.to).toBe(false);
      }
      // Deliberately keep a middle spare over the overnight arrival: the
      // opposite-direction berth is still the same physical storage slot.
      const hot = plan.blocks.find(b => b.trips.some(id => plan.trips[id].standby && plan.trips[id].to === 24))!;
      const leave = plan.trips[hot.trips[1]];
      const saved = leave.stops[0].dep;
      leave.stops[0].dep = 28 * 3600;
      expect(validatePlan(sim.planCtx, plan).some(i => i.code === 'STABLE_CONFLICT' && i.blocks?.includes(hot.id))).toBe(true);
      leave.stops[0].dep = saved;
      // not in the peaks: both tracks turn trains then
      if (dayType === 'weekday') for (const st of [0, E]) {
        expect(at(st, 8 * 3600).length + at(st, 17.5 * 3600).length).toBe(0);
        expect(at(st, 20.5 * 3600)).toHaveLength(0);
        expect(at(st, 21.5 * 3600)).toHaveLength(0);
      }
      expect(fmtIssues(validatePlan(sim.planCtx, plan))).toBe('');
    }
  });

  it('fits complete overlay circulations after fault cancellations open larger gaps', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'recovery', startTime: 14400, seed: 1 });
    for (const block of sim.plan.blocks) if (block.id % 3 === 0)
      for (const id of block.trips) sim.plan.trips[id].cancelled = true;
    const original = sim.plan.trips.map(trip => ({ cancelled: trip.cancelled, stops: structuredClone(trip.stops) }));
    const firstAdded = sim.plan.trips.length;
    const result = applyOverlay(sim.planCtx, sim.plan, OVERLAY_PRESETS[0]);
    expect(result.trips).toBeGreaterThan(0);
    expect(fmtIssues(validatePlan(sim.planCtx, sim.plan))).toBe('');
    expect(sim.plan.trips.slice(0, firstAdded).map(trip => ({ cancelled: trip.cancelled, stops: trip.stops }))).toEqual(original);
    const omitted = sim.plan.trips.slice(firstAdded).filter(trip => trip.cancelReason?.startsWith('加开能力不足'));
    expect(omitted.length).toBeGreaterThan(0);
    for (const trip of omitted) expect(sim.plan.blocks[trip.block].trips.every(id => sim.plan.trips[id].cancelled)).toBe(true);
  });
  it('flags a turnback shorter than the minimum', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'test', startTime: 4 * 3600, seed: 1 });
    const plan = sim.plan;
    const b = plan.blocks.find((x) => x.trips.length >= 2 && plan.trips[x.trips[0]].revenue && plan.trips[x.trips[1]].revenue)!;
    const a = plan.trips[b.trips[0]], d = plan.trips[b.trips[1]];
    const shift = d.stops[0].dep - a.stops[a.stops.length - 1].arr - 30;
    for (const s of d.stops) { s.arr -= shift; s.dep -= shift; }
    expect(validatePlan(sim.planCtx, plan).some((i) => i.code === 'TURN_SHORT')).toBe(true);
  });
  it('rejects a front turn that occupies the normal departure platform during a through train', () => {
    const sim = new Sim({dayType:'weekday',dateLabel:'front slot',startTime:14400,seed:1});
    const plan = sim.plan;
    // shorten one 蟠祥路 turn of a base block to a front turn at 威宁路
    const block = plan.blocks.find(b => b.trips.some((id,i) => {
      const a = plan.trips[id], d = plan.trips[b.trips[i+1]];
      return d && a.revenue && d.revenue && a.dir==='UP' && a.to===0 && d.from===0 && a.stops[0].arr > 10*3600;
    }))!;
    const index = block.trips.findIndex((id,i) => plan.trips[id].to===0 && plan.trips[block.trips[i+1]]?.from===0 && plan.trips[id].stops[0].arr > 10*3600);
    const arrival = plan.trips[block.trips[index]], departure = plan.trips[block.trips[index+1]];
    arrival.stops = arrival.stops.filter(s => s.st >= 6); arrival.to = 6;
    departure.stops = departure.stops.filter(s => s.st >= 6); departure.from = 6;
    const occupied = terminalOccupancy(plan).get(6)!.find(o => o.block===block.id)!;
    expect(occupied).toBeDefined();
    const trip = plan.trips.find(t => !t.cancelled && t.block!==block.id && t.dir==='DN' && t.stops.some(s => s.st===6))!;
    const stop = trip.stops.find(s => s.st===6)!;
    const shift = occupied.from+30-stop.dep;
    for (const s of trip.stops) {s.arr+=shift;s.dep+=shift;}
    expect(validatePlan(sim.planCtx,plan).some(issue => issue.code==='FRONT_CONFLICT' && issue.blocks?.includes(block.id))).toBe(true);
  });
  it('rejects an added circulation that uses an intermediate terminal as long-term storage', () => {
    const sim = new Sim({dayType:'weekday',dateLabel:'layover',startTime:14400,seed:1});
    applyOverlay(sim.planCtx,sim.plan,OVERLAY_PRESETS[0]);
    const occupied = terminalOccupancy(sim.plan).get(1)!.find(o => sim.plan.trips[sim.plan.blocks[o.block].trips[0]].overlay)!;
    const block = sim.plan.blocks[occupied.block];
    const index = block.trips.findIndex((id,i) => sim.plan.trips[id].to===1 && sim.plan.trips[block.trips[i+1]]?.from===1);
    const arrival = sim.plan.trips[block.trips[index]], departure = sim.plan.trips[block.trips[index+1]];
    const shift = arrival.stops.at(-1)!.arr+1200-departure.stops[0].dep;
    for (const stop of departure.stops) {stop.arr+=shift;stop.dep+=shift;}
    expect(validatePlan(sim.planCtx,sim.plan).some(issue => issue.code==='LAYOVER_LONG' && issue.blocks?.includes(block.id))).toBe(true);
  });
  it('protects planned depot exits from an added return on the shared conversion track', () => {
    const sim = new Sim({dayType:'weekday',dateLabel:'depot slot',startTime:14400,seed:1});
    const original = structuredClone(sim.plan.trips);
    applyOverlay(sim.planCtx,sim.plan,OVERLAY_PRESETS[0]);
    expect(sim.plan.trips.slice(0,original.length)).toEqual(original);
    expect(validatePlan(sim.planCtx,sim.plan).filter(i=>i.severity==='error')).toEqual([]);
    // Inventory-aware homes may fit every conversion-track return. Force a
    // real shared-lead overlap rather than relying on a particular rejected
    // circulation and its former cancellation wording.
    const inbound = sim.plan.blocks.find(b => b.end.kind === 'depot' && b.trips.some(id => sim.plan.trips[id].overlay && !sim.plan.trips[id].cancelled)
      && sim.plan.blocks.some(o => o.start.kind === 'depot' && b.end.kind === 'depot' && o.start.depot === b.end.depot
        && !sim.plan.trips[o.trips[0]].overlay && sim.topo.depots[b.end.depot].portals.entry[sim.plan.trips[b.trips.at(-1)!].dir].path
          === sim.topo.depots[b.end.depot].portals.exit[sim.plan.trips[o.trips[0]].dir].path))!;
    expect(inbound).toBeDefined();
    if (inbound.end.kind !== 'depot') throw Error('depot');
    const depot = inbound.end.depot, last = sim.plan.trips[inbound.trips.at(-1)!];
    const outgoing = sim.plan.blocks.find(o => o.start.kind === 'depot' && o.start.depot === depot && !sim.plan.trips[o.trips[0]].overlay
      && sim.topo.depots[depot].portals.entry[last.dir].path === sim.topo.depots[depot].portals.exit[sim.plan.trips[o.trips[0]].dir].path)!;
    const delta = outboundWindow(sim.planCtx,depot,sim.plan.trips[outgoing.trips[0]])[0] + 10 - inboundWindow(sim.topo,depot,last)[0];
    for (const stop of last.stops) { stop.arr += delta; stop.dep += delta; }
    expect(validatePlan(sim.planCtx,sim.plan).some(issue => issue.code==='DEPOT_CONFLICT' && issue.blocks?.includes(inbound.id))).toBe(true);
  });
  it('uses the independent SHR lead, and still rejects a turn forced across the return route',()=>{
    const sim=new Sim({dayType:'weekday',dateLabel:'SHR return',startTime:14400,seed:1}),p=sim.plan;
    const inbound=p.blocks.find(b=>b.end.kind==='depot'&&sim.topo.depots[b.end.depot].key==='BZL'
      &&p.trips[b.trips.at(-1)!].dir==='UP'&&p.trips[b.trips.at(-1)!].to===4)!;
    expect(inbound).toBeDefined();
    const other=p.blocks.find(b=>b!==inbound&&b.trips.some((id,k)=>{
      const a=p.trips[id],d=p.trips[b.trips[k+1]];return d&&!a.cancelled&&!d.cancelled&&a.dir==='UP'&&a.to===4&&d.dir==='DN'&&d.from===4;
    }))!;
    const k=other.trips.findIndex((id,k)=>p.trips[id].dir==='UP'&&p.trips[id].to===4&&p.trips[other.trips[k+1]]?.dir==='DN');
    const departure=p.trips[other.trips[k+1]],last=p.trips[inbound.trips.at(-1)!],delta=departure.stops[0].dep-10-last.stops.at(-1)!.arr;
    last.stops=last.stops.map(s=>({...s,arr:s.arr+delta,dep:s.dep+delta}));
    const conflicts = () => validatePlan(sim.planCtx, p).some(issue => issue.code === 'DEPOT_CONFLICT'
      && issue.blocks?.[0] === inbound.id && issue.blocks?.[1] === other.id);
    expect(conflicts()).toBe(false);
    const depot = sim.topo.depots.find(depot => depot.key === 'BZL')!;
    const stub = depot.transferPaths[depot.portals.entry.UP.path].stub;
    const reverse = blockTasks(sim.topo, p, other).find(task => task.k === 'reverse' && task.station === 4);
    expect(reverse?.k).toBe('reverse');
    if (reverse?.k === 'reverse') expect(reverse.berths.every(berth => sim.topo.berths[berth].link !== stub)).toBe(true);
    const berths = sim.topo.stations[4].turnbackBerths;
    sim.topo.stations[4].turnbackBerths = berths.filter(berth => sim.topo.berths[berth].link === stub);
    try { expect(conflicts()).toBe(true); }
    finally { sim.topo.stations[4].turnbackBerths = berths; }
  });
  it('protects a basic-plan return through the reversing exit platform after the nominal yard exit time', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'conversion reservation', startTime: 14400, seed: 1 });
    const yard = sim.topo.depots.find(depot => depot.key === 'CSD')!;
    const outgoing = sim.plan.blocks.find(block => block.start.kind === 'depot' && block.start.depot === yard.id
      && sim.plan.trips[block.trips[0]].dir === 'DN')!;
    const incoming = sim.plan.blocks.find(block => block !== outgoing && block.end.kind === 'depot' && block.end.depot === yard.id
      && sim.plan.trips[block.trips.at(-1)!].dir === 'DN')!;
    const first = sim.plan.trips[outgoing.trips[0]], last = sim.plan.trips[incoming.trips.at(-1)!];
    expect(first.overlay).toBeUndefined();
    expect(last.overlay).toBeUndefined();
    const [start, clear] = outboundWindow(sim.planCtx, yard.id, first);
    expect(clear).toBeGreaterThan(start + yard.exitTime + 5);
    const shift = start + yard.exitTime + 5 - 15 - last.stops.at(-1)!.arr;
    last.stops = last.stops.map(stop => ({ ...stop, arr: stop.arr + shift, dep: stop.dep + shift }));
    expect(validatePlan(sim.planCtx, sim.plan).some(issue => issue.code === 'DEPOT_CONFLICT'
      && issue.blocks?.[0] === incoming.id && issue.blocks?.[1] === outgoing.id)).toBe(true);
  });
  it('keeps a throat clearance between turns on the GLL middle-track platform', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'throat', startTime: 14400, seed: 1 });
    const plan = sim.plan;
    const turns = terminalOccupancy(plan).get(22)!.sort((a,b) => a.from-b.from);
    const clear = OPERATIONS.platformTurnClear.GLL;
    for (let i = 1; i < turns.length; i++) expect(turns[i].from - turns[i-1].to).toBeGreaterThanOrEqual(clear);
    // the D72 opening built up 40 s gaps here: arrive 20 s after the previous turn leaves
    const i = turns.findIndex((x, k) => k > 0 && x.from > 6 * 3600 && x.from - turns[k-1].to > 40);
    const first = turns[i-1], second = turns[i];
    const arriving = plan.blocks[second.block].trips.map(id => plan.trips[id]).find(t => !t.cancelled && t.to === 22 && t.stops.at(-1)!.arr === second.from)!;
    const shift = second.from - (first.to + 20);
    for (const stop of arriving.stops) { stop.arr -= shift; stop.dep -= shift; }
    expect(validatePlan(sim.planCtx, plan).some(issue => issue.code === 'TURN_HEADWAY'
      && issue.blocks?.includes(second.block) && issue.blocks.includes(first.block))).toBe(true);
  });
  it('rejects an early feeder that traps an earlier departure on the single GLL turnback platform', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'order', startTime: 14400, seed: 1 });
    const occupancy = terminalOccupancy(sim.plan).get(22)!.sort((a,b) => a.from-b.from);
    // (one train turns there at a time: move a feeder ahead of the train before it)
    const index = occupancy.findIndex((item,i) => i > 0
      && !sim.plan.trips[sim.plan.blocks[item.block].trips[0]].revenue
      && sim.plan.trips[sim.plan.blocks[item.block].trips[0]].to === 22);
    expect(index).toBeGreaterThan(0);
    const first = occupancy[index-1], second = occupancy[index];
    const feeder = sim.plan.trips[sim.plan.blocks[second.block].trips[0]];
    const shift = second.from-first.from+10;
    for (const stop of feeder.stops) { stop.arr -= shift; stop.dep -= shift; }
    expect(validatePlan(sim.planCtx, sim.plan).some(issue => issue.code === 'TAIL_ORDER'
      && issue.blocks?.includes(second.block) && issue.blocks.includes(first.block))).toBe(true);
  });
});

describe('fixed-time special trains (定点班车)', () => {
  const idx = (id: string) => STATIONS.findIndex((s) => s.id === id);
  for (const dayType of ['weekday', 'weekend'] as DayType[]) {
    it(`${dayType}: 虹桥火车站 23:04 / 23:30 to 龙阳路, set-down only, passing the rest`, () => {
      const sim = new Sim({ dayType, dateLabel: 'test', startTime: 4 * 3600, seed: 1 });
      const runs = sim.plan.trips.filter((t) => t.kind === 'extra' && !t.cancelled);
      expect(runs.map((t) => t.stops[0].dep).sort((a, b) => a - b)).toEqual([23 * 3600 + 4 * 60, 23 * 3600 + 30 * 60]);
      for (const t of runs) {
        expect([t.from, t.to]).toEqual([idx('HQZ'), idx('LYL')]);
        const stopping = t.stops.filter((s) => s.stop).map((s) => STATIONS[s.st].id);
        expect(stopping).toEqual(['HQZ', 'HQ2', 'SHR', 'WNL', 'ZSG', 'JAS', 'RMG', 'SJD', 'LYL']);
        expect(t.stops.filter((s) => s.noBoard).map((s) => STATIONS[s.st].id)).toEqual(['SHR', 'WNL', 'ZSG', 'JAS', 'RMG', 'SJD']);
        // a train already on the line carries it, into 龙阳路 depot
        const b = sim.plan.blocks[t.block];
        expect(b.end).toMatchObject({ kind: 'depot', depot: sim.topo.depots.findIndex((d) => d.key === 'LYD') });
      }
    });
  }
  it('holiday-return scenario: its own runs both ways, plan feasible', () => {
    const def = SCENARIOS.find((s) => s.id === 'holiday-return')!;
    const sim = new Sim({ dayType: def.dayType, dateLabel: 'test', startTime: 4 * 3600, seed: 1, scenario: def.id });
    expect(fmtIssues(validatePlan(sim.planCtx, sim.plan))).toBe('');
    const runs = sim.plan.trips.filter((t) => t.kind === 'extra' && !t.cancelled);
    expect(runs.filter((t) => t.dir === 'DN').length).toBe(4);
    const air = runs.filter((t) => t.dir === 'UP');
    expect(air.map((t) => t.stops[0].dep).sort((a, b) => a - b)).toEqual([22 * 3600 + 50 * 60, 23 * 3600 + 10 * 60, 23 * 3600 + 30 * 60]);
    for (const t of air) {
      expect([t.from, t.to]).toEqual([idx('PDA'), idx('ZSG')]);
      // terminating at 中山公园, the train goes on empty into 北翟路
      const b = sim.plan.blocks[t.block];
      const next = sim.plan.trips[b.trips[b.trips.indexOf(t.id) + 1]];
      expect(next.revenue).toBe(false);
      expect(next.from).toBe(idx('ZSG'));
    }
  });
});
