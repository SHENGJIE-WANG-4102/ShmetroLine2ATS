import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Topology } from '../src/sim/topology';
import { fixtureTrain } from './helpers/fixture-train';

describe('ordinary near turnback and deep physical storage roles', () => {
  let data: typeof import('../src/data/current');
  let geometry: typeof import('../src/sim/topology');
  let timetable: typeof import('../src/sim/timetable');
  let topo: Topology;
  let oldPoints: Topology;
  let margin: number;

  beforeAll(async () => {
    vi.stubEnv('ATS_LINE', '2'); vi.resetModules();
    data = await import('../src/data/current');
    geometry = await import('../src/sim/topology');
    timetable = await import('../src/sim/timetable');
    margin = (await import('../src/sim/safetyLimits')).SIGNAL_MARGIN;
    topo = geometry.buildTopology();
    // Rebuild the same physical layout without the optional pair stopping
    // points. Restore shared line data even if topology construction fails.
    const configured = data.LAYOUT.pairs.flatMap(pair => pair.stubs)
      .filter(stub => stub.turnbackDistance !== undefined)
      .map(stub => ({ stub, distance: stub.turnbackDistance! }));
    try {
      for (const { stub } of configured) delete stub.turnbackDistance;
      oldPoints = geometry.buildTopology();
    } finally {
      for (const { stub, distance } of configured) stub.turnbackDistance = distance;
    }
  });
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it.each(['PXL', 'SHR', 'PDA'])('%s clears the throat by one whole train and the common margin', key => {
    const station = topo.stations.find(st => st.id === key)!;
    expect(station.turnbackBerths).toHaveLength(2);
    for (const id of station.turnbackBerths) {
      const berth = topo.berths[id], link = topo.links[berth.link];
      const room = berth.dir === 1 ? berth.offset : link.len - berth.offset;
      expect(room).toBeCloseTo(193, 8);
      expect(room - data.LINE_INFO.trainLength).toBeGreaterThanOrEqual(margin);
      // Geometry and permission are distinct: SHR still occupies a shared
      // depot lead even after its train has cleared the double Y.
      const point = { link: berth.link, off: berth.offset, dir: berth.dir };
      expect(geometry.safeWaitingPoint(topo, point, data.LINE_INFO.trainLength + margin))
        .toBe(!geometry.sharedTransferLink(topo, berth.link));
    }
  });

  it.each(['PXL', 'SHR'])('%s reserves near points for one train and retains the old deep IDs', key => {
    const station = topo.stations.find(st => st.id === key)!;
    const original = oldPoints.stations[station.index];
    expect(station.storageBerths).toEqual(original.storageBerths);
    expect(station.rescueBerths).toEqual(original.turnbackBerths);
    expect(new Set(station.turnbackBerths.map(id => topo.berths[id].link)).size).toBe(2);
    for (let index = 0; index < station.turnbackBerths.length; index++) {
      const id = station.turnbackBerths[index], near = topo.berths[id];
      const deepId = geometry.stablingBerth(topo, id), deep = topo.berths[deepId];
      expect(deepId).toBe(original.turnbackBerths[index]);
      expect(near.stablingBerth).toBe(deepId);
      expect(geometry.stablingBerth(topo, deepId)).toBe(deepId);
      expect(near.id).toBeGreaterThanOrEqual(oldPoints.berths.length);
      expect(near.link).toBe(deep.link);
      expect(near.dir).toBe(deep.dir);
      expect(near.name).toBe(oldPoints.berths[deepId].name); // Preserve the data-selected main track.
      expect(near.maxLength).toBeCloseTo(193 - margin, 8);
      expect(geometry.berthFits(topo, id, data.LINE_INFO.trainLength)).toBe(true);
      expect(geometry.berthFits(topo, id, near.maxLength!)).toBe(true);
      expect(geometry.berthFits(topo, id, near.maxLength! + .01)).toBe(false);
      expect(geometry.berthFits(topo, id, data.LINE_INFO.trainLength * 2 + 1)).toBe(false);
      expect(geometry.safeWaitingPoint(topo, id, data.LINE_INFO.trainLength * 2 + 1)).toBe(false);
      expect(deep).toEqual({ ...oldPoints.berths[deepId], name: `${near.name}(深位)` });
      expect(deep.offset).toBe(topo.links[deep.link].len - 15);
    }
  });

  it('preserves old track geometry, turnout speeds, berth identities and physical slot counts', () => {
    expect(topo.nodes).toEqual(oldPoints.nodes);
    expect(topo.links).toEqual(oldPoints.links);
    expect(topo.sections).toEqual(oldPoints.sections);
    expect(topo.switches).toEqual(oldPoints.switches);
    const physical = (berth: Topology['berths'][number]) => ({ ...berth, name: '' });
    expect(topo.berths.slice(0, oldPoints.berths.length).map(physical)).toEqual(oldPoints.berths.map(physical));
    expect(topo.berths).toHaveLength(oldPoints.berths.length + 4);
    for (const station of topo.stations) {
      const original = oldPoints.stations[station.index];
      expect(station.turnbackBerths.length).toBe(original.turnbackBerths.length);
      expect(station.storageBerths).toEqual(original.storageBerths);
    }
    for (const key of ['PXL', 'SHR']) {
      const station = topo.stations.find(st => st.id === key)!;
      for (const id of station.turnbackBerths) expect(topo.links[topo.berths[id].link].limit).toBe(30);
      const switches = topo.switches.filter(sw => sw.station === station.index);
      expect(switches).toEqual(oldPoints.switches.filter(sw => sw.station === station.index));
    }
  });

  it('keeps PXL deep capacity for a coupled pair and does not create that capacity at SHR', () => {
    const coupledLength = data.LINE_INFO.trainLength * 2 + 1;
    for (const key of ['PXL', 'SHR']) {
      const station = topo.stations.find(st => st.id === key)!;
      for (const id of station.rescueBerths) {
        const deep = topo.berths[id], link = topo.links[deep.link];
        const room = deep.dir === 1 ? deep.offset : link.len - deep.offset;
        expect(room >= coupledLength + margin).toBe(key === 'PXL');
        expect(geometry.safeWaitingPoint(topo, id, coupledLength + margin)).toBe(key === 'PXL');
      }
    }
  });

  it('maps overnight and hot standby to deep points without adding storage allocations', () => {
    const night = timetable.overnightPlaces(topo), hot = timetable.hotStandbyPlaces(topo);
    expect(night).toHaveLength(data.OPERATIONS.overnightStabling.reduce((sum, rule) => sum + rule.count, 0));
    // D178 用户决定: no main-line overnight trains; only the two line-end spares (D148)
    expect(night).toHaveLength(0);
    expect(hot).toHaveLength(data.OPERATIONS.hotStandby.length);
    expect(hot).toHaveLength(2);
    expect(night.map(place => [place.station, place.berth, place.arrivalBerth]))
      .toEqual(timetable.overnightPlaces(oldPoints).map(place => [place.station, place.berth, place.arrivalBerth]));
    expect(hot.map(place => [place.station, place.berth]))
      .toEqual(timetable.hotStandbyPlaces(oldPoints).map(place => [place.station, place.berth]));
    const pxl = topo.stations.find(st => st.id === 'PXL')!;
    for (const place of [...night, ...hot].filter(place => place.station === pxl.index)) {
      expect(pxl.rescueBerths).toContain(place.berth);
      expect(pxl.turnbackBerths).not.toContain(place.berth);
    }
    // This change extends the pair-stub mechanism only. The airport's
    // existing overnight/standby positions must not silently move as well.
    const airport = topo.stations.find(st => st.id === 'PDA')!;
    for (const place of [...night, ...hot].filter(place => place.station === airport.index)) {
      expect(airport.turnbackBerths).toContain(place.berth);
      expect(geometry.stablingBerth(topo, place.berth)).toBe(place.berth);
    }
  });

  it('recognizes registered near and deep rear positions for the existing change-ends timing', async () => {
    const { calibratedRearTurnback } = await import('../src/sim/onboard');
    for (const key of ['PXL', 'SHR']) {
      const station = topo.stations.find(st => st.id === key)!;
      for (const id of [...station.turnbackBerths, ...station.rescueBerths]) {
        expect(calibratedRearTurnback(topo, { station: station.index, chosen: id })).toBe(true);
      }
    }
  });

  it('keeps both SHR stopping roles subject to shared-lead waiting safety', () => {
    const station = topo.stations.find(st => st.id === 'SHR')!;
    const yard = topo.depots.find(depot => depot.key === 'BZL')!;
    expect(yard.transferPaths).toEqual(oldPoints.depots.find(depot => depot.key === 'BZL')!.transferPaths);
    for (const id of [...station.turnbackBerths, ...station.rescueBerths]) {
      const berth = topo.berths[id];
      expect(geometry.sharedTransferLink(topo, berth.link)).toBe(true);
      expect(geometry.safeWaitingPoint(topo, id, data.LINE_INFO.trainLength)).toBe(false);
      expect(geometry.safeWaitingPoint(topo, { link: berth.link, off: berth.offset, dir: berth.dir },
        data.LINE_INFO.trainLength)).toBe(false);
    }
  });

  it.each(['coupled rescue', 'single deep departure'] as const)('arbitrates %s at its deep point instead of the single-train near point', async role => {
    const { Sim } = await import('../src/sim/engine');
    const movement = await import('../src/sim/movement');
    const interlocking = await import('../src/sim/interlocking');
    const arbitration = await import('../src/sim/resourceArbitration');
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'deep berth role', startTime: 14400, seed: 7,
      noPossessions: true, randomFaults: 0, autoDispatch: false, autoRadio: false });
    const train = fixtureTrain(sim);
    for (const other of [...sim.trainList]) if (other !== train) sim.removeTrain(other);
    for (const id of [...sim.routes.keys()]) interlocking.releaseRoute(sim, id);
    // This fixture tests one physical request, with no virtual depot source.
    sim.plan = { ...sim.plan, blocks: [], trips: [] };
    sim.resourceTransit.clear(); sim.berthRes.clear();
    const station = sim.topo.stations.find(st => st.id === 'PXL')!;
    const nearId = station.turnbackBerths[0], deepId = geometry.stablingBerth(sim.topo, nearId);
    const deep = sim.topo.berths[deepId];
    Object.assign(train, { link: deep.link, off: deep.offset - 1, dir: deep.dir,
      hist: [{ link: deep.link, dir: deep.dir }], phase: 'run', v: 0, failed: false,
      block: -1, tripId: -1, rescuing: -1, rescueBy: -1,
      len: role === 'coupled rescue' ? data.LINE_INFO.trainLength * 2 + 1 : data.LINE_INFO.trainLength,
      coupledLen: role === 'coupled rescue' ? data.LINE_INFO.trainLength : 0,
      tasks: [{ k: 'reverse', station: station.index, berths: [deepId], chosen: deepId, minTime: 40 }] });
    movement.computeBody(sim, train); movement.indexBodies(sim); interlocking.computeOccupancy(sim);
    const request = arbitration.collectResourceRequests(sim).find(item => item.id === train.id);
    expect(request).toBeDefined();
    expect(request!.options.length).toBeGreaterThan(0);
    for (const option of request!.options) expect(option.choices).toContainEqual({ index: 0, berth: deepId });
    const allocation = arbitration.arbitrateResources(sim, [request!]);
    expect(arbitration.peekResourceAllocation(sim)).toBe(allocation);
    const decision = allocation.decisions.get(train.id);
    expect(decision).toMatchObject({ admitted: true });
    expect(decision!.option.choices).toContainEqual({ index: 0, berth: deepId });
    expect(decision!.option.choices.some(choice => choice.berth === nearId)).toBe(false);
    expect(train.tasks[0]).toMatchObject({ k: 'reverse', chosen: deepId });
    expect(geometry.berthFits(sim.topo, nearId, data.LINE_INFO.trainLength * 2 + 1)).toBe(false);
  });
});

describe('lines without optional near stopping points', () => {
  beforeAll(() => { vi.stubEnv('ATS_LINE', '14'); vi.resetModules(); });
  afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('leaves Line 14 default paired tracks and all berth roles unchanged', async () => {
    const data = await import('../src/data/current');
    const geometry = await import('../src/sim/topology');
    expect(data.LAYOUT.pairs.flatMap(pair => pair.stubs).every(stub => stub.turnbackDistance === undefined)).toBe(true);
    const topo = geometry.buildTopology();
    expect(topo.berths.every(berth => berth.stablingBerth === undefined)).toBe(true);
    for (const station of topo.stations) {
      expect(station.rescueBerths).toEqual(station.turnbackBerths);
      for (const id of [...station.turnbackBerths, ...station.storageBerths]) {
        expect(geometry.stablingBerth(topo, id)).toBe(id);
        expect(topo.berths[id].maxLength).toBeUndefined();
      }
    }
  });
});
