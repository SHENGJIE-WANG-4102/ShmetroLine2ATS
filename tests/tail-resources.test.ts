import { describe, expect, it } from 'vitest';
import { LINE_INFO } from '../src/data/current';
import { buildTopology, safeWaitingPoint, sharedTransferLink, topologyResourceLinks } from '../src/sim/topology';
import { SIGNAL_MARGIN } from '../src/sim/protection';
import { Sim } from '../src/sim/engine';
import { computeBody, indexBodies } from '../src/sim/movement';
import { computeOccupancy, releaseRoute, updateInterlocking } from '../src/sim/interlocking';
import { berthHolder, updateTrainTasks } from '../src/sim/ats';

describe('continuous independent tail tracks', () => {
  it('recognises a whole consist across connected tail links without admitting hazards', () => {
    const topo = buildTopology();
    // Split a real independent tail at a joint, including on lines whose
    // original topology happens to model this physical track as one link.
    const berth = topo.berths.find(b => b.kind === 'tail' && topo.sections[topo.links[b.link].section].kind === 'tail'
      && topo.links[b.link].len > LINE_INFO.trainLength + 20)!;
    expect(berth).toBeDefined();
    const previous = topo.links[berth.link], oldB = previous.b, oldLen = previous.len;
    const mid = (previous.chainA + previous.chainB) / 2, node = topo.nodes.length, nextId = topo.links.length;
    topo.nodes.push({ id: node, kind: 'joint', chain: mid, pos: [], links: [previous.id, nextId] });
    const next = { ...previous, id: nextId, a: node, len: oldLen / 2, chainA: mid };
    topo.links.push(next);
    topo.nodes[oldB].links = topo.nodes[oldB].links.map(id => id === previous.id ? nextId : id);
    previous.b = node; previous.len = oldLen / 2; previous.chainB = mid;
    topo.sections[previous.section].links.push(nextId);
    for (const b of topo.berths) if (b.link === previous.id && b.offset > previous.len) {
      b.link = nextId; b.offset -= previous.len;
    }
    const resources = topologyResourceLinks(topo);
    expect(resources.has(previous.id)).toBe(true);
    expect(resources.has(next.id)).toBe(true);
    expect(sharedTransferLink(topo, previous.id)).toBe(false);
    const off = Math.min(next.len, LINE_INFO.trainLength / 2);
    const point = { link: next.id, off, dir: 1 as const,
      incoming: [{ link: previous.id, dir: 1 as const }, { link: next.id, dir: 1 as const }] };
    expect(safeWaitingPoint(topo, point, LINE_INFO.trainLength)).toBe(true);
    expect(safeWaitingPoint(topo, { ...point, incoming: [] }, LINE_INFO.trainLength)).toBe(false);
    expect(safeWaitingPoint(topo, point, LINE_INFO.trainLength, { protectedLinks: new Set([previous.id]) })).toBe(false);
    expect(safeWaitingPoint(topo, point, previous.len + off + 1)).toBe(false);
    const wrong = topo.links.find(link => link.track !== previous.track && link.id !== next.id)!;
    expect(safeWaitingPoint(topo, { ...point, incoming: [{ link: wrong.id, dir: 1 }, { link: next.id, dir: 1 }] }, LINE_INFO.trainLength)).toBe(false);
  });

  it('keeps separate normal and coupled-rescue stopping points where configured', () => {
    const topo = buildTopology();
    const station = topo.stations.find(s => s.rescueBerths.some(id => !s.turnbackBerths.includes(id)));
    if (!station) return; // Lines without a separate rescue berth retain their original layout.
    for (const normalId of station.turnbackBerths) {
      const normal = topo.berths[normalId], link = topo.links[normal.link];
      const deep = station.rescueBerths.map(id => topo.berths[id]).find(berth =>
        berth.dir === normal.dir && topo.links[berth.link].track === link.track)!;
      expect(deep).toBeDefined();
      const last = topo.links[deep.link], before = topo.nodes[last.a].links.map(id => topo.links[id]).find(candidate =>
        candidate.id !== last.id && candidate.b === last.a && candidate.track === last.track)!;
      const normalChain = link.chainA + normal.offset, deepChain = last.chainA + deep.offset;
      expect(Math.abs(deepChain - normalChain)).toBeGreaterThanOrEqual(LINE_INFO.trainLength + SIGNAL_MARGIN);
      const incoming = [{ link: before.id, dir: deep.dir }, { link: last.id, dir: deep.dir }];
      expect(safeWaitingPoint(topo, normalId, LINE_INFO.trainLength + SIGNAL_MARGIN)).toBe(true);
      expect(safeWaitingPoint(topo, normalId, LINE_INFO.trainLength * 2 + 1)).toBe(false);
      expect(safeWaitingPoint(topo, { link: deep.link, off: deep.offset, dir: deep.dir, incoming },
        LINE_INFO.trainLength * 2 + 1 + SIGNAL_MARGIN)).toBe(true);
    }
  });

  it('keeps the original Pudong Airport buffer positions', () => {
    const topo = buildTopology();
    const station = topo.stations.find(s => s.id === 'PDA');
    if (!station) return;
    for (const id of station.rescueBerths) {
      const berth = topo.berths[id], link = topo.links[berth.link];
      expect(link.chainB).toBe(62725);
      expect(link.chainA + berth.offset).toBe(62710);
    }
  });

  it('allows a full rescue consist on a split independent storage tail while retaining occupancy checks', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'split storage tail', startTime: 14400, seed: 7, noPossessions: true });
    const station = sim.topo.stations.find(s => s.id === 'PXL');
    if (!station) return;
    const berth = sim.topo.berths.find(b => b.station === station.index && b.kind === 'tail'
      && sim.topo.links[b.link].track === 'UP')!;
    const outer = sim.topo.links[berth.link];
    const inner = sim.topo.nodes[outer.b].links.map(id => sim.topo.links[id]).find(l =>
      l.id !== outer.id && l.track === outer.track && sim.topo.sections[l.section].kind === 'tail')!;
    expect(inner).toBeDefined();
    const point = { link: outer.id, off: berth.offset, dir: -1 as const,
      incoming: [{ link: inner.id, dir: -1 as const }, { link: outer.id, dir: -1 as const }] };
    expect(safeWaitingPoint(sim.topo, point, LINE_INFO.trainLength * 2 + 1)).toBe(true);
    expect(safeWaitingPoint(sim.topo, point, LINE_INFO.trainLength * 2 + 1,
      { protectedLinks: new Set([inner.id]) })).toBe(false);
    const other = sim.trainList[0];
    sim.linkBodies.clear(); sim.linkBodies.set(inner.id, [{ train: other.id, from: 10, to: 20 }]);
    expect(berthHolder(sim, berth.id, -1, true)).toBe(other.id);
  });

  it('releases an entered route at its actual turnback, but not at an intermediate stop', () => {
    const sim = new Sim({ dayType: 'weekday', dateLabel: 'tail route completion', startTime: 14400, seed: 7, noPossessions: true });
    const station = sim.topo.stations.find(s => s.rescueBerths.some(id => !s.turnbackBerths.includes(id)));
    if (!station) return;
    const tr = sim.trainList[0];
    for (const other of [...sim.trainList]) if (other !== tr) sim.removeTrain(other);
    for (const id of [...sim.routes.keys()]) releaseRoute(sim, id);
    const berth = station.turnbackBerths.map(id => sim.topo.berths[id]).find(b =>
      sim.topo.routes.some(r => r.berths.includes(b.id) && r.sections.at(-1) !== sim.topo.links[b.link].section))!;
    expect(berth).toBeDefined();
    const route = sim.topo.routes.find(r => r.berths.includes(berth.id)
      && r.sections.at(-1) !== sim.topo.links[berth.link].section)!;
    Object.assign(tr, { link: berth.link, off: berth.offset - 10, dir: berth.dir, hist: [{ link: berth.link, dir: berth.dir }],
      phase: 'run', v: 0, tasks: [{ k: 'reverse', station: station.index, berths: [berth.id], chosen: berth.id, minTime: 40 }] });
    computeBody(sim, tr); indexBodies(sim); computeOccupancy(sim);
    sim.routes.set(route.id, { route: route.id, state: 'locked', fleeting: false, manual: false, guide: false, guideUntil: 0,
      occSeen: route.sections.map(() => false), released: route.sections.map(() => false), entered: true,
      owner: tr.id, arsTrain: tr.id, cancelAt: 0, committed: -1, setAt: sim.t });
    sim.sig[route.start].route = route.id;
    sim.routeUnlockedSw.set(route.id, new Set());
    updateInterlocking(sim);
    expect(sim.routes.has(route.id)).toBe(true);
    tr.phase = 'reversing'; updateInterlocking(sim);
    expect(sim.routes.has(route.id)).toBe(true);
    tr.off = berth.offset; tr.phase = 'run';
    computeBody(sim, tr); indexBodies(sim); computeOccupancy(sim); updateInterlocking(sim);
    expect(sim.routes.has(route.id)).toBe(true);
    tr.phase = 'reversing';
    tr.len = berth.offset + 1;
    computeBody(sim, tr); indexBodies(sim); computeOccupancy(sim); updateInterlocking(sim);
    expect(sim.routes.has(route.id)).toBe(true);
    tr.len = LINE_INFO.trainLength;
    computeBody(sim, tr); indexBodies(sim); computeOccupancy(sim); updateInterlocking(sim);
    expect(sim.routes.has(route.id)).toBe(false);

    // A final service may stable at the same tail without a reverse task.
    // Its occupied berth completes the route; an intermediate stop does not.
    sim.routes.set(route.id, { route: route.id, state: 'locked', fleeting: false, manual: false, guide: false, guideUntil: 0,
      occSeen: route.sections.map(() => false), released: route.sections.map(() => false), entered: true,
      owner: tr.id, arsTrain: tr.id, cancelAt: 0, committed: -1, setAt: sim.t });
    sim.sig[route.start].route = route.id;
    sim.routeUnlockedSw.set(route.id, new Set());
    tr.phase = 'stabled'; tr.tasks = []; tr.off = berth.offset - 10;
    computeBody(sim, tr); indexBodies(sim); computeOccupancy(sim); updateInterlocking(sim);
    expect(sim.routes.has(route.id)).toBe(true);
    tr.off = berth.offset; tr.phase = 'run'; tr.stopDist = 0;
    tr.tasks = [{ k: 'stable', berth: berth.id, reason: '存车', station: station.index }];
    computeBody(sim, tr); indexBodies(sim); computeOccupancy(sim);
    updateTrainTasks(sim, tr);
    expect(tr.phase).toBe('stabled');
    expect(tr.tasks).toEqual([]);
    updateInterlocking(sim);
    expect(sim.routes.has(route.id)).toBe(false);
  });
});
