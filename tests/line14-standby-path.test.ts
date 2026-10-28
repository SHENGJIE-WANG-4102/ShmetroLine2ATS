import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sim as Simulator } from '../src/sim/engine';

describe('14号线热备真实泊位双程有向路径', () => {
  let Sim: typeof Simulator;
  let tt: typeof import('../src/sim/timetable');
  let route: typeof import('../src/sim/routeTable');
  let topology: typeof import('../src/sim/topology');
  beforeAll(async () => {
    vi.stubEnv('ATS_LINE', '14'); vi.resetModules();
    Sim = (await import('../src/sim/engine')).Sim;
    tt = await import('../src/sim/timetable'); route = await import('../src/sim/routeTable'); topology = await import('../src/sim/topology');
  });
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  for (const dayType of ['weekday', 'weekend'] as const) it(`${dayType}实际选源进位及反向回段均从正常正线可达`, () => {
    const sim = new Sim({ dayType, dateLabel: '热备路径', startTime: 14400, seed: 3 });
    const places = tt.hotStandbyPlaces(sim.topo);
    const arrivals = sim.plan.trips.filter(trip => trip.standby);
    expect(arrivals.map(trip=>sim.topo.stations[trip.to].id).sort()).toEqual(
      (dayType==='weekday'?['CYL','HPN','YSL','ZXX']:['CYL','HPN','YSL','ZXX','LTN']).sort());
    for (const trip of arrivals) {
      const block = sim.plan.blocks[trip.block], next = sim.plan.trips[block.trips[block.trips.indexOf(trip.id)+1]];
      const place = places.find(place => place.station === trip.to)!;
      const arrival = tt.storageArrivalBerth(sim.topo,place.berth,trip.dir)!;
      const departure = tt.storageArrivalBerth(sim.topo,place.berth,next.dir)!;
      expect(route.berthRoundTripReachable(sim.topo,sim.routeTable,
        tt.platformBerth(sim.topo,trip.stops.at(-2)!.st,trip.dir),arrival,departure,
        tt.platformBerth(sim.topo,next.stops[1].st,next.dir)),sim.topo.stations[trip.to].id).toBe(true);
    }
    // PDF: LTN's reserved second track joins DN at its far end; a GQD-UP
    // approach cannot enter it, despite its two stopping-head definitions.
    for (const [key,heading,valid] of [['LTN','UP',false],['LTN','DN',true],['ZXX','DN',false],['ZXX','UP',true]] as const) {
      const place = places.find(place => sim.topo.stations[place.station].id === key)!;
      const back = heading==='DN'?'UP':'DN';
      const inbound=topology.orderedStations(heading), outbound=topology.orderedStations(back);
      const prev=inbound[inbound.indexOf(place.station)-1], after=outbound[outbound.indexOf(place.station)+1];
      expect(route.berthRoundTripReachable(sim.topo,sim.routeTable,tt.platformBerth(sim.topo,prev,heading),
        tt.storageArrivalBerth(sim.topo,place.berth,heading)!,tt.storageArrivalBerth(sim.topo,place.berth,back)!,
        tt.platformBerth(sim.topo,after,back))).toBe(valid);
    }
  });
});
