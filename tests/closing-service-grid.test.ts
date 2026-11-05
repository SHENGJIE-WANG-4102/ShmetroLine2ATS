import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/engine';
import { OPERATIONS, SIMULATION, STATIONS } from '../src/data/current';
import {
  anchorClosingServices, buildStops, DepIndex, dwellFactorAt, layoutService, officialTimingPoints, stopsAtReference, TEMPLATES, validatePlan,
  type ServiceRequest,
} from '../src/sim/timetable';
import type { PlanStop } from '../src/sim/model';

const calls = (from: number, to: number, departure: number): PlanStop[] => [
  { st: from, arr: departure, dep: departure, stop: true },
  { st: 1, arr: departure + 100, dep: departure + 120, stop: true },
  { st: to, arr: departure + 200, dep: departure + 200, stop: true },
];

describe('reference inversion follows the actual piecewise running curve', () => {
  it('finds an exact slot when fixed-point iteration does not converge fast enough', () => {
    const build = (origin: number): PlanStop[] => [
      { st: 0, arr: origin, dep: origin, stop: true },
      { st: 1, arr: origin + 40 + origin * .9, dep: origin + 40 + origin * .9, stop: true },
    ];
    const stops = stopsAtReference(build, 1, 230);
    expect(stops[0].dep).toBeCloseTo(100, 3);
    expect(stops[1].dep).toBeCloseTo(230, 3);
    expect(stops).toEqual(build(stops[0].dep));
  });

  it('keeps a physical curve when an upward profile jump makes a slot unreachable', () => {
    const build = (origin: number): PlanStop[] => [
      { st: 0, arr: origin, dep: origin, stop: true },
      { st: 1, arr: origin + (origin < 100 ? 20 : 40), dep: origin + (origin < 100 ? 20 : 40), stop: true },
    ];
    const stops = stopsAtReference(build, 1, 130);
    expect(stops).toEqual(build(stops[0].dep));
    expect(Math.abs(stops[1].dep - 130)).toBeGreaterThanOrEqual(10 - 1e-6);
    expect(Math.abs(stops[1].dep - 130)).toBeLessThanOrEqual(10 + .001);
  });
});

describe('the published opening train starts the reference grid', () => {
  it.each(['weekday', 'weekend'] as const)('%s measures the first interval from the actual published call', dayType => {
    const sim = new Sim({ dayType, dateLabel: 'opening reference grid', startTime: 14400, seed: 7, noPossessions: true });
    const { requests, periods } = layoutService(sim.planCtx);
    const ref = STATIONS.findIndex(station => station.id === (SIMULATION.timetable.reference?.DN
      ?? SIMULATION.timetable.terminals.core[0]));
    const opening = requests.filter(request => request.dir === 'DN' && request.revenue
      && request.stops.some(stop => stop.st === ref)).slice(0, 2);
    expect(opening).toHaveLength(2);
    expect(opening[0].stops[0].dep).toBe(OPERATIONS.firstWestTerminusDep);
    const first = opening[0].stops.find(stop => stop.st === ref)!.dep;
    const second = opening[1].stops.find(stop => stop.st === ref)!.dep;
    const service = SIMULATION.timetable.serviceData[dayType];
    const period = periods.find(period => first >= period.from && first < period.to)!;
    const headway = service.openingDn?.find(band => first < band.to)?.headway
      ?? period.headway ?? TEMPLATES[period.template].directionalHeadway?.DN
      ?? TEMPLATES[period.template].headway;
    expect(second - first).toBeCloseTo(headway, 1);
  });
});

describe('official last service owns the fixed closing reference phase', () => {
  it('keeps every request and route while moving its reference grid to the official curve', () => {
    const requests: ServiceRequest[] = [0, 1, 2].map((index) => ({
      id: 70 + index, dir: 'UP', kind: index === 1 ? 'wd' : 'big',
      from: 3 + index, to: 0, revenue: true, stops: calls(3 + index, 0, 900 + index * 240),
    }));
    const specifications = requests.map(({ stops: _stops, ...request }) => structuredClone(request));
    const official = calls(requests[2].from, 0, 1500);
    const originalOfficial = structuredClone(official);
    requests[2].stops = official;
    expect(anchorClosingServices(requests, new Set([requests[2].id]), 1, 240,
      (request, at) => calls(request.from, request.to, at - 120))).toEqual([]);
    expect(requests.map(({ stops: _stops, ...request }) => request)).toEqual(specifications);
    expect(requests.map(request => request.stops.find(stop => stop.st === 1)!.dep))
      .toEqual([1140, 1380, 1620]);
    expect(requests.at(-1)!.stops).toEqual(originalOfficial);
    expect(requests.every(request => request.stops[0].st === request.from
      && request.stops.at(-1)!.st === request.to)).toBe(true);
  });

  const mixedFlow = () => {
    const slow = (request: ServiceRequest, at: number): PlanStop[] => [
      { st: request.from, arr: at - 100, dep: at - 100, stop: true },
      { st: 3, arr: at, dep: at, stop: true },
      { st: 2, arr: at + 200, dep: at + 200, stop: true },
      ...(request.to === 0 ? [{ st: 0, arr: at + 500, dep: at + 500, stop: true }] : []),
    ];
    const requests: ServiceRequest[] = [
      { id: 10, dir: 'UP', kind: 'wd', from: 6, to: 2, revenue: true, stops: [] },
      { id: 11, dir: 'UP', kind: 'big', from: 5, to: 0, revenue: true, stops: [] },
      { id: 12, dir: 'UP', kind: 'big', from: 4, to: 0, revenue: true, stops: [] },
    ];
    requests.forEach((request, index) => { request.stops = slow(request, 1140 + index * 240); });
    requests[2].stops = [
      { st: 4, arr: 1520, dep: 1520, stop: true },
      { st: 3, arr: 1620, dep: 1620, stop: true },
      { st: 2, arr: 1720, dep: 1720, stop: true },
      { st: 0, arr: 1820, dep: 1820, stop: true },
    ];
    return { requests, slow };
  };

  it('propagates the full-path boundary through different origins and destinations sharing one reference', () => {
    const { requests, slow } = mixedFlow();
    const specifications = requests.map(({ stops: _stops, ...request }) => structuredClone(request));
    const official = structuredClone(requests[2].stops);
    expect(anchorClosingServices(requests, new Set([12]), 3, 240, slow)).toEqual([]);
    const reference = requests.map(request => request.stops.find(stop => stop.st === 3)!.dep);
    expect(reference[2] - reference[1]).toBeGreaterThan(240);
    expect(reference[1] - reference[0]).toBeCloseTo(240, 6);
    expect(requests.map(({ stops: _stops, ...request }) => request)).toEqual(specifications);
    expect(requests[2].stops).toEqual(official);
    for (let index = 0; index < requests.length; index++) {
      const following = requests.slice(index + 1);
      expect(new DepIndex(following).clear(requests[index].stops, 'UP')).toBe(true);
      for (const earlier of requests[index].stops) for (const later of following) {
        const call = later.stops.find(stop => stop.st === earlier.st);
        if (call) expect(earlier.dep).toBeLessThan(call.dep);
      }
    }
  });

  it('keeps fixed anchors and all original requests when their bracket has no feasible phase', () => {
    const { requests, slow } = mixedFlow();
    requests[0].stops = slow(requests[0], 1200);
    const before = structuredClone(requests);
    const issues = anchorClosingServices(requests, new Set([10, 12]), 3, 240, slow);
    expect(issues).toHaveLength(1); expect(issues[0].code).toBe('HEADWAY');
    expect(requests).toEqual(before);
  });

  it.each(['weekday', 'weekend'] as const)('%s preserves official anchors and full-path headways', dayType => {
    const sim = new Sim({ dayType, date: dayType === 'weekday' ? '2026-10-19' : '2026-10-24',
      dateLabel: 'closing reference grid', startTime: 14400, seed: 7, noPossessions: true });
    const { requests, periods, issues } = layoutService(sim.planCtx);
    expect(issues).toEqual([]);
    const east = STATIONS.length - 1;
    const coreEast = STATIONS.findIndex(station => station.id === SIMULATION.timetable.terminals.core[1]);
    const anchors = [
      ['DN', 0, east, OPERATIONS.firstWestTerminusDep],
      ['UP', east, 0, OPERATIONS.firstEastTerminusDep],
      ['DN', 0, east, OPERATIONS.lastBigEastboundDep],
      ['UP', east, 0, OPERATIONS.lastBigWestboundDep],
      ...(OPERATIONS.lastLateEastboundDep > OPERATIONS.lastBigEastboundDep
        ? [['DN', 0, coreEast, OPERATIONS.lastLateEastboundDep] as const] : []),
    ] as const;
    const physicalResiduals: { dir: string; station: number; departure: number }[] = [];
    for (const [dir, from, to, departure] of anchors) {
      const request = requests.find(trip => trip.dir === dir && trip.from === from && trip.to === to
        && trip.stops[0].dep === departure);
      expect(request, `${dir} origin ${departure}`).toBeDefined();
      const points = officialTimingPoints(dir, from, to, departure);
      expect(points.size).toBeGreaterThan(0);
      expect(request!.stops).toEqual(buildStops(sim.planCtx, dir, from, to, departure,
        true, time => dwellFactorAt(dayType, time)));
      for (const [station, minute] of points) {
        const stop = request!.stops.find(call => call.st === station)!;
        const actual = station === to ? stop.arr : stop.dep;
        if (Math.floor((actual + .001) / 60) === Math.floor(minute / 60)) {
          expect(Math.floor((actual + .001) / 60), `${dir}/${STATIONS[station].id}`).toBe(Math.floor(minute / 60));
          continue;
        }
        // 020724 explicitly retains the airport's terminal residual (1A: ~0.5 s;
        // D173 soft start/stop make the physical minimum slower: ~7.6 s).
        // It is already the level-1 physical run with all allowance returned;
        // an official minute assertion cannot demand another speed increase.
        expect(dir).toBe('DN'); expect(station).toBe(east); expect(to).toBe(east);
        expect(departure).toBe(OPERATIONS.lastBigEastboundDep);
        const index = request!.stops.indexOf(stop), previous = request!.stops[index - 1];
        const physicalRun = sim.planCtx.rt.dn[Math.min(previous.st, station)] - OPERATIONS.sectionRunAllowanceS;
        expect(previous.runLevel).toBe(1);
        expect(actual).toBeCloseTo(previous.dep + physicalRun, 6);
        expect(actual - (minute + 60)).toBeGreaterThan(0); expect(actual - (minute + 60)).toBeLessThan(10);
        physicalResiduals.push({ dir, station, departure });
      }
    }
    // D178 (用户决定 D73 A+B): the last train's shortest dwells and its 2 s gain
    // 远东大道→海天三路 bring the airport arrival onto the official minute
    expect(physicalResiduals).toEqual([]);
    for (const origin of SIMULATION.timetable.firstOrigins) {
      const from = STATIONS.findIndex(station => station.id === origin.from);
      const to = STATIONS.findIndex(station => station.id === origin.to);
      expect(requests.some(request => request.dir === origin.dir && request.from === from && request.to === to
        && request.stops[0].dep === origin.dep)).toBe(true);
    }
    const reference = STATIONS.findIndex(station => station.id === SIMULATION.timetable.reference?.UP);
    const ref = reference >= 0 ? reference : coreEast;
    const last = requests.find(trip => trip.dir === 'UP' && trip.from === east && trip.to === 0
      && trip.stops[0].dep === OPERATIONS.lastBigWestboundDep)!;
    const finalReference = last.stops.find(stop => stop.st === ref)!.dep;
    const period = periods.find(period => period.from <= finalReference && finalReference < period.to)!;
    if (period.headwayTo === undefined) {
      const headway = period.headway ?? TEMPLATES[period.template].directionalHeadway?.UP
        ?? TEMPLATES[period.template].headway;
      const closing = requests.filter(trip => trip.dir === 'UP'
        && (trip.stops.find(stop => stop.st === ref)?.dep ?? -Infinity) >= period.from)
        .sort((a, b) => a.stops.find(stop => stop.st === ref)!.dep - b.stops.find(stop => stop.st === ref)!.dep);
      expect(closing.length).toBeGreaterThan(1);
      for (let index = 1; index < closing.length; index++) {
        const before = closing[index - 1], after = closing[index];
        const a = before.stops.find(stop => stop.st === ref)!.dep;
        const z = after.stops.find(stop => stop.st === ref)!.dep;
        expect(new DepIndex(closing.slice(index)).clear(before.stops, 'UP')).toBe(true);
        if (z - a >= headway - .01) {
          expect(z - a).toBeGreaterThanOrEqual(headway - .01);
          continue;
        }
        // A retained physical profile discontinuity can make the exact
        // nominal slot unreachable. Prove the jump brackets that slot;
        // ordinary intervals keep the nominal headway assertion above.
        const target = z - headway;
        const build = (origin: number) => buildStops(sim.planCtx, 'UP', before.from, before.to,
          origin, true, time => dwellFactorAt(dayType, time), undefined, false);
        const solved = stopsAtReference(build, ref, target);
        expect(before.stops[0].dep).toBeCloseTo(solved[0].dep, 6);
        const lower = build(solved[0].dep - .001).find(stop => stop.st === ref)!.dep;
        const upper = build(solved[0].dep + .001).find(stop => stop.st === ref)!.dep;
        expect(lower).toBeLessThan(target);
        expect(upper).toBeGreaterThan(target);
        expect(Math.abs(a - target)).toBeGreaterThan(.001);
      }
    }
    // Count the DN fixed closing stream from its actual official endpoint.
    // An inverse origin later than the published origin cannot consume the
    // preceding full slot; the endpoint's natural request count owns it.
    const dnRef = STATIONS.findIndex(station => station.id === (SIMULATION.timetable.reference?.DN
      ?? SIMULATION.timetable.terminals.core[0]));
    const dnLast = requests.find(request => request.dir === 'DN' && request.from === 0 && request.to === east
      && request.stops[0].dep === OPERATIONS.lastBigEastboundDep)!;
    const dnEnd = dnLast.stops.find(stop => stop.st === dnRef)!.dep;
    const dnPeriod = periods.find(period => period.from <= dnEnd && dnEnd < period.to)!;
    const dnHeadway = dnPeriod.headway ?? TEMPLATES[dnPeriod.template].directionalHeadway?.DN
      ?? TEMPLATES[dnPeriod.template].headway;
    expect(dnPeriod.headwayTo).toBeUndefined();
    const prefix = requests.filter(request => request.dir === 'DN'
      && request.stops.some(stop => stop.st === dnRef && stop.dep < dnPeriod.from - .001))
      .sort((a, b) => a.stops.find(stop => stop.st === dnRef)!.dep - b.stops.find(stop => stop.st === dnRef)!.dep).at(-1)!;
    const expectedReferences: number[] = [];
    for (let at = dnEnd; at >= dnPeriod.from - .001; at -= dnHeadway) {
      if (at !== dnEnd) {
        const raw = stopsAtReference(origin => buildStops(sim.planCtx, 'DN', 0, east,
          origin, true, time => dwellFactorAt(dayType, time), undefined, false), dnRef, at);
        const curve = buildStops(sim.planCtx, 'DN', 0, east, raw[0].dep,
          true, time => dwellFactorAt(dayType, time));
        if (!new DepIndex([prefix]).clear(curve, 'DN')) break;
      }
      expectedReferences.unshift(at);
    }
    const closingDN = requests.filter(request => request.dir === 'DN' && request.from === 0 && request.to === east
      && request.stops.some(stop => stop.st === dnRef && stop.dep >= dnPeriod.from - .001 && stop.dep <= dnEnd + .001))
      .sort((a, b) => a.stops.find(stop => stop.st === dnRef)!.dep - b.stops.find(stop => stop.st === dnRef)!.dep);
    expect(closingDN).toHaveLength(expectedReferences.length);
    for (let index = 0; index < closingDN.length; index++) {
      // The generator solves clocks to 1 ms; compare at that resolution.
      expect(closingDN[index].stops.find(stop => stop.st === dnRef)!.dep).toBeCloseTo(expectedReferences[index], 2);
      expect(new DepIndex(closingDN.slice(index + 1)).clear(closingDN[index].stops, 'DN')).toBe(true);
    }
    expect(closingDN[0].stops.find(stop => stop.st === dnRef)!.dep).toBeCloseTo(expectedReferences[0], 2);
    expect(new DepIndex(closingDN).clear(prefix.stops, 'DN')).toBe(true);
    // Use the shared validator's minimum and shared-train convention, and ask
    // for every station conflict rather than its default reporting interval.
    expect(validatePlan(sim.planCtx, sim.plan, true, true).filter(issue => issue.code === 'HEADWAY')).toEqual([]);
  });
});
