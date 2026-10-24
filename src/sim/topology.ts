/**
 * Track topology builder.
 *
 * Turns the line data (src/data/current.ts) into a node/link track graph with
 * switches, axle-counter sections, signals, platforms, berths and the
 * interlocking route table. The result is a pure function of the data, so the
 * worker (simulation) and the main thread (renderer) both build it locally
 * and refer to elements by index.
 *
 * Conventions
 *  - Main-line links always run a = west → b = east (chainage increasing).
 *  - A train position is (link, offset from link.a, dir) where dir = +1 means
 *    moving a → b.
 *  - A signal sits at a node and governs entry into one specific link from
 *    that node ("entry key" = node*65536 + link).
 */
import {
  STATIONS, LAYOUT, SPEED_LIMITS, TURNOUT_SPEEDS, LINE_INFO, SIMULATION, stationChainages,
  type CrossoverKind, type SidingLane, type LeadDef,
} from '../data/current';

import { ahead } from './topologyOrder';
export { ahead } from './topologyOrder';

export type TrackKind = 'DN' | 'UP' | 'X' | 'SID' | 'CON' | 'DEP';
export type Dir = 1 | -1;

export interface NodePos { row: number; x: number; y: number }

export interface TNode {
  id: number;
  kind: 'end' | 'joint' | 'switch';
  links: number[];
  /** for switches */
  sw?: number;
  toe?: number;
  normal?: number;
  reverse?: number;
  /** end nodes */
  endKind?: 'buffer' | 'depot';
  depot?: number;
  chain: number;
  pos: NodePos[];
}

export interface TLink {
  id: number;
  a: number;
  b: number;
  len: number;
  track: TrackKind;
  /** normal running direction (+1/-1), 0 = either */
  normalDir: 0 | Dir;
  section: number;
  chainA: number;
  chainB: number;
  limit: number; // km/h
  zone: number;
  platform: number; // -1 if none
  /** Paper-specific conversion-track direction; other links remain bidirectional. */
  depotFlow?: 'in' | 'out';
}

export interface TSwitch {
  id: number;
  name: string;
  nodes: number[];
  kind: 'crossover' | 'siding' | 'depot' | 'single';
  station: number;
  sections: number[];
}

export interface TSection {
  id: number;
  name: string;
  links: number[];
  len: number;
  zone: number;
  kind: 'plain' | 'platform' | 'switch' | 'siding' | 'tail' | 'depot';
  track: TrackKind;
  station: number;
  chainFrom: number;
  chainTo: number;
}

export type SignalRole = 'start' | 'home' | 'rev' | 'exit' | 'depot';

export interface TSignal {
  id: number;
  name: string;
  node: number;
  link: number;
  /** travel direction along `link` for trains passing this signal */
  dir: Dir;
  role: SignalRole;
  station: number;
  routes: number[];
  chain: number;
}

export interface TPlatform {
  id: number;
  station: number;
  track: 'DN' | 'UP';
  link: number;
  section: number;
  name: string;
  /** platform whose waiting passengers this one shares (广兰路 middle-track face of the UP island) */
  pool?: number;
  /** side of the track the platform edge lies on (north = UP main side) */
  face: 'N' | 'S';
}

export type BerthKind = 'platform' | 'tail' | 'siding' | 'depot';

export interface TBerth {
  id: number;
  kind: BerthKind;
  link: number;
  /** head stopping offset on link */
  offset: number;
  dir: Dir;
  platform: number;
  station: number;
  depot: number;
  /** true when this platform berth is approached against the normal direction */
  reverse: boolean;
  name: string;
}

export interface RouteStep { link: number; dir: Dir }

export interface TRoute {
  id: number;
  name: string;
  start: number; // signal
  end: number; // signal or -1
  endNode: number; // end node when end === -1
  steps: RouteStep[];
  sections: number[];
  switches: { sw: number; pos: 'N' | 'R' }[];
  length: number;
  wrongDir: boolean;
  diverging: boolean;
  /** default automatic (fleeting) route */
  fleeting: boolean;
  /** berths that lie on this route (reached while traversing it) */
  berths: number[];
  limit: number;
}

export interface TDepot {
  id: number;
  key: string;
  name: string;
  short: string;
  station: number;
  gateNode: number;
  gateLink: number;
  /** LYD has independent entry and exit conversion tracks (P5 fig.2). */
  outGateNode: number;
  outGateLink: number;
  /** leads into the yard: transfer track t0, t1, t2 (t2 ends at the gate), the
   *  joint where the lead's stub ends, and the depot exit signal (-1 on an entry-only lead) */
  transferPaths: { gate: number; links: number[]; throat: number; flow: 'in' | 'out' | 'shared'; exitSignal: number; /** the lead's stub link (a turnback berth may lie on it) */ stub: number }[];
  berth: number; // entry berth at gate
  /** 入段 berth per transferPaths entry, -1 on an exit-only lead */
  entryBerths: number[];
  exitSignal: number;
  work: { daily: boolean; monthly: boolean; overhaul: boolean };
  capacity: number;
  stablingTracks: number;
  exitTime: number;
  /** mean chainage of the leads' main-line turnouts */
  junctionChain: number;
  /** first / last platform of a depot move in each direction */
  portals: { exit: Record<'DN' | 'UP', DepotPortal>; entry: Record<'DN' | 'UP', DepotPortal> };
}

/** A depot move joins / leaves service at `station`; with `reverse` it reaches
 *  that platform against its normal direction and changes ends there. */
export interface DepotPortal { station: number; reverse: boolean; /** transferPaths index used */ path: number }

export interface TZone { id: number; key: string; name: string; chainFrom: number; chainTo: number }

export interface TStation {
  index: number;
  id: string;
  name: string;
  chain: number;
  platforms: { DN: number; UP: number };
  /** berths a train can use to reverse here (siding/tail, ordered by preference) */
  turnbackBerths: number[];
  /** station-front turnback possible (crossover adjacent) */
  frontTurnback: { DN: boolean; UP: boolean };
  /** storage-only tail berths a stabled train leaves straight for the
   *  departure platform from, the one nearer the platform first */
  storageBerths: number[];
  equipped: boolean;
  row: number;
  x: number;
}

export interface Topology {
  nodes: TNode[];
  links: TLink[];
  switches: TSwitch[];
  sections: TSection[];
  signals: TSignal[];
  platforms: TPlatform[];
  berths: TBerth[];
  routes: TRoute[];
  depots: TDepot[];
  zones: TZone[];
  stations: TStation[];
  /** signal lookup by entry key node*65536+link */
  signalByEntry: Map<number, number>;
  wrapChain: number;
  rows: { chainFrom: number; chainTo: number; x0: number; x1: number }[];
  layout: LayoutGeom;
  chainToX: (chain: number, row: number) => number;
  chainRow: (chain: number) => number;
}

/** Design-space geometry (3840 × 2160 reference). */
export interface LayoutGeom {
  rowTop: number[];
  upY: number; // relative to row top
  dnY: number;
  midY: number;
  depotQY: number;
  depotGateY: number;
  rowHeight: number;
}

export const GEOM: LayoutGeom = {
  rowTop: [128, 610],
  upY: 205,
  dnY: 293,
  midY: 249,
  depotQY: 150,
  depotGateY: 92,
  rowHeight: 470,
};

const PLAT_HALF = 105; // platform section half-length (m)
const SW_HALF = 15; // switch section half-length around a switch point
const XO_HALF = 25; // half horizontal length of a crossover
const CON_DX = 40; // siding connector horizontal length
/** double Y: main turnout → splitting turnout → merging turnout, each this far apart (m) */
const PAIR_DX = 40;

/** a depot lead built at the end of a stub track */
interface LeadOut {
  depot: number;
  flow: 'in' | 'out' | 'shared';
  /** joint where the stub ends and the transfer track starts */
  throat: number;
  /** joint at the far end of t0 (depot exit signal) */
  j1: number;
  gate: number;
  /** transfer track t0, t1, t2 */
  links: number[];
  stub: number;
  /** chainage of the lead's main-line turnout(s) */
  mainCh: number;
  station: number;
  s: Dir;
}

interface MainPoint {
  ch: number;
  kind: 'joint' | 'switch' | 'end';
  /** for switches: which side the toe faces */
  toeSide?: 'west' | 'east';
  swBuild?: SwBuild;
  endKind?: 'buffer';
  node?: number;
}

interface SwBuild {
  sw: number;
  /** the diverging link id for this node (filled later) */
  divLink?: number;
  node?: number;
}

export function sigEntryKey(node: number, link: number): number {
  return node * 65536 + link;
}

export function buildTopology(): Topology {
  const chains = stationChainages();
  const nStations = STATIONS.length;
  const lastCh = chains[nStations - 1];
  const wrapAfter = STATIONS.findIndex(station => station.id === SIMULATION.topology.wrapAfter);
  const wrapChain = (chains[wrapAfter] + chains[wrapAfter + 1]) / 2;

  const nodes: TNode[] = [];
  const links: TLink[] = [];
  const switches: TSwitch[] = [];

  const nearestStation = (ch: number): number => {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < nStations; i++) {
      const d = Math.abs(chains[i] - ch);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };

  const newNode = (kind: TNode['kind'], chain: number): TNode => {
    const n: TNode = { id: nodes.length, kind, links: [], chain, pos: [] };
    nodes.push(n);
    return n;
  };
  const newLink = (a: number, b: number, len: number, track: TrackKind, normalDir: 0 | Dir, chainA: number, chainB: number): TLink => {
    const l: TLink = {
      id: links.length, a, b, len: Math.max(1, len), track, normalDir, section: -1,
      chainA, chainB, limit: LINE_INFO.maxSpeedKmh, zone: 0, platform: -1,
    };
    links.push(l);
    nodes[a].links.push(l.id);
    nodes[b].links.push(l.id);
    return l;
  };
  const newSwitch = (kind: TSwitch['kind'], station: number): TSwitch => {
    const s: TSwitch = { id: switches.length, name: '', nodes: [], kind, station, sections: [] };
    switches.push(s);
    return s;
  };

  // ------------------------------------------------------------------ main points
  const mainPts: Record<'DN' | 'UP', MainPoint[]> = { DN: [], UP: [] };
  const hardBounds: Record<'DN' | 'UP', number[]> = { DN: [], UP: [] };
  /** feature switch points on the mains → used to place protecting signals */
  const features: { station: number; pts: { track: 'DN' | 'UP'; ch: number }[] }[] = [];
  let curFeature: { station: number; pts: { track: 'DN' | 'UP'; ch: number }[] } | null = null;
  const beginFeature = (station: number) => { curFeature = { station, pts: [] }; features.push(curFeature); };
  /** join the feature of the same station with a switch point within 150 m (scissors + stubs), else begin one */
  const joinFeature = (station: number, ch: number) => {
    const f = features.find((x) => x.station === station && x.pts.some((p) => Math.abs(p.ch - ch) < 150));
    if (f) curFeature = f; else beginFeature(station);
  };
  const addSwitchPt = (track: 'DN' | 'UP', ch: number, toeSide: 'west' | 'east', sb: SwBuild) => {
    mainPts[track].push({ ch, kind: 'switch', toeSide, swBuild: sb });
    hardBounds[track].push(ch - SW_HALF, ch + SW_HALF);
    curFeature!.pts.push({ track, ch });
  };
  const featureExtent = (f: (typeof features)[number], t: 'DN' | 'UP') => {
    const p = f.pts.filter((x) => x.track === t).map((x) => x.ch);
    if (!p.length) return null;
    return { from: Math.min(...p) - SW_HALF, to: Math.max(...p) + SW_HALF };
  };

  // terminal extents
  const westBuffer = chains[0] - PLAT_HALF - 500;
  const eastBuffer = lastCh + PLAT_HALF + 500;
  for (const t of ['DN', 'UP'] as const) {
    mainPts[t].push({ ch: westBuffer, kind: 'end', endKind: 'buffer' });
    mainPts[t].push({ ch: eastBuffer, kind: 'end', endKind: 'buffer' });
    hardBounds[t].push(wrapChain);
    for (let i = 0; i < nStations; i++) hardBounds[t].push(chains[i] - PLAT_HALF, chains[i] + PLAT_HALF);
  }

  // crossovers (incl. scissors at terminals and junctions)
  interface XoBuild { kind: CrossoverKind; center: number; station: number; sw: TSwitch; dn: SwBuild; up: SwBuild }
  const xos: XoBuild[] = [];
  const addCrossover = (center: number, kind: CrossoverKind, station: number, swKind: TSwitch['kind'] = 'crossover'): XoBuild => {
    const sw = newSwitch(swKind, station);
    const dn: SwBuild = { sw: sw.id };
    const up: SwBuild = { sw: sw.id };
    if (kind === '/') {
      // DN at west end (toe faces west), UP at east end (toe faces east)
      addSwitchPt('DN', center - XO_HALF, 'west', dn);
      addSwitchPt('UP', center + XO_HALF, 'east', up);
    } else {
      addSwitchPt('UP', center - XO_HALF, 'west', up);
      addSwitchPt('DN', center + XO_HALF, 'east', dn);
    }
    const xo = { kind, center, station, sw, dn, up };
    xos.push(xo);
    return xo;
  };

  for (const x of LAYOUT.crossovers) {
    joinFeature(x.station, chains[x.station] + x.offset);
    addCrossover(chains[x.station] + x.offset, x.kind, x.station);
  }

  /** A second turnout connects a siding or paired middle track back to a main. */
  const farConnector = (station: number, end: number, s: Dir, link: NonNullable<(typeof LAYOUT.sidings)[number]['link']>): NonNullable<SidingBuild['k']> => {
    const ch = end + s * link.at;
    const sw = newSwitch('siding', station);
    const main: SwBuild = { sw: sw.id };
    joinFeature(station, ch + s * CON_DX);
    addSwitchPt(link.main, ch + s * CON_DX, s > 0 ? 'east' : 'west', main);
    return { sw, main, ch };
  };

  // double Y + diamond into two middle tracks (蟠祥路, 国家会展中心, 淞虹路, 上海科技馆)
  interface PairBuild {
    def: (typeof LAYOUT.pairs)[number]; s: Dir; e: number; mT: number;
    u: SwBuild; d: SwBuild; sw: Record<'SU' | 'SD' | 'MU' | 'MD', TSwitch>;
    /** splitting (SU, SD) and merging (MU, MD) nodes */
    nodes?: { SU: number; SD: number; MU: number; MD: number };
    stubs: { link: number; exitNode: number; exitLink: number; bnd: number; lead?: LeadOut }[];
    cons: number[]; inner: { U: number[]; D: number[]; X: number[] };
    farLinks: (SidingBuild['k'])[];
  }
  const pairs: PairBuild[] = [];
  for (const pd of LAYOUT.pairs) {
    const c = chains[pd.station];
    const s: Dir = pd.side === 'west' ? -1 : 1;
    const e = c + pd.at;
    const mT = e - s * 2 * PAIR_DX;
    const toeSide: 'west' | 'east' = s < 0 ? 'east' : 'west';
    joinFeature(pd.station, mT);
    const u: SwBuild = { sw: newSwitch('siding', pd.station).id };
    const d: SwBuild = { sw: newSwitch('siding', pd.station).id };
    addSwitchPt('UP', mT, toeSide, u);
    addSwitchPt('DN', mT, toeSide, d);
    // single-action turnouts: one failed turnout leaves the other middle track usable
    const sw = { SU: newSwitch('siding', pd.station), SD: newSwitch('siding', pd.station), MU: newSwitch('siding', pd.station), MD: newSwitch('siding', pd.station) };
    const farLinks = pd.stubs.map(st => st.link ? farConnector(pd.station, e, s, st.link) : undefined);
    pairs.push({ def: pd, s, e, mT, u, d, sw, stubs: [], cons: [], inner: { U: [], D: [], X: [] }, farLinks });
  }

  // terminal tails: scissors (or just the mains) beyond the platform to buffers
  const tailInfo: { station: number; side: 'west' | 'east'; signalCh: Record<'DN' | 'UP', number>; turnback: boolean }[] = [];
  for (const t of LAYOUT.tails) {
    const c = chains[t.station];
    const s = t.side === 'west' ? -1 : 1;
    let f: (typeof features)[number] | undefined;
    if (t.scissors ?? true) {
      const c1 = c + s * (PLAT_HALF + SW_HALF + XO_HALF + 30); // centre of first crossover
      const c2 = c1 + s * (2 * XO_HALF + 2 * SW_HALF + 10 + 30);
      beginFeature(t.station);
      addCrossover(c1, '/', t.station);
      addCrossover(c2, '\\', t.station);
      f = features[features.length - 1];
    } else {
      // the mains run on past the station's own switches (a double Y)
      f = features.find((x) => x.station === t.station && x.pts.some((p) => (p.ch - c) * s > 0));
    }
    const ext = f ? { DN: featureExtent(f, 'DN')!, UP: featureExtent(f, 'UP')! } : null;
    const plat = { from: c - PLAT_HALF, to: c + PLAT_HALF };
    const signalCh = s < 0 ? { DN: (ext?.DN ?? plat).from, UP: (ext?.UP ?? plat).from } : { DN: (ext?.DN ?? plat).to, UP: (ext?.UP ?? plat).to };
    tailInfo.push({ station: t.station, side: t.side, signalCh, turnback: t.turnback ?? true });
    const outer = s < 0 ? Math.min(signalCh.DN, signalCh.UP) : Math.max(signalCh.DN, signalCh.UP);
    // move buffer to the requested tail length
    const buf = outer + s * t.length;
    for (const tr of ['DN', 'UP'] as const) {
      const e = mainPts[tr].find((p) => p.kind === 'end' && (s < 0 ? p.ch < c : p.ch > c))!;
      e.ch = buf;
    }
  }

  // stub sidings: through a Y to both mains, or a single turnout on one main
  interface SidingBuild {
    def: (typeof LAYOUT.sidings)[number]; s: Dir; e: number; dead: number; mainCh: number;
    y?: SwBuild; ysw?: TSwitch; u?: SwBuild; d?: SwBuild;
    /** stub link holding the berth, and the joint/link of its exit signal */
    stub?: number; exitNode?: number; exitLink?: number; cons: number[];
    /** second turnout on the stub with a connector to a main (龙阳路) */
    k?: { sw: TSwitch; main: SwBuild; ch: number; node?: number; links?: number[]; con?: number[] };
    lead?: LeadOut;
  }
  const sidings: SidingBuild[] = [];
  for (const sd of LAYOUT.sidings) {
    const c = chains[sd.station];
    const s: Dir = sd.side === 'west' ? -1 : 1;
    const e = c + sd.at;
    const dead = e + s * sd.length;
    const mainCh = e - s * CON_DX; // turnout point(s), behind the attached end
    const connect = sd.connect ?? 'both';
    // a stub running west has its turnouts' toes facing east (legs to the west), and vice versa
    const toeSide: 'west' | 'east' = s < 0 ? 'east' : 'west';
    joinFeature(sd.station, mainCh);
    const sb: SidingBuild = { def: sd, s, e, dead, mainCh, cons: [] };
    const kind: TSwitch['kind'] = sd.lead ? 'depot' : 'siding';
    if (connect !== 'DN') { sb.u = { sw: newSwitch(kind, sd.station).id }; addSwitchPt('UP', mainCh, toeSide, sb.u); }
    if (connect !== 'UP') { sb.d = { sw: newSwitch(kind, sd.station).id }; addSwitchPt('DN', mainCh, toeSide, sb.d); }
    if (connect === 'both') { sb.ysw = newSwitch(kind, sd.station); sb.y = { sw: sb.ysw.id }; }
    if (sd.link) sb.k = farConnector(sd.station, e, s, sd.link);
    sidings.push(sb);
  }

  // middle tracks joined at both ends to both mains (待避线 / 广兰路 platform track)
  interface LoopBuild {
    def: (typeof LAYOUT.loops)[number]; w: number; e: number;
    uw: SwBuild; dw: SwBuild; ue: SwBuild; de: SwBuild; ywSw: TSwitch; yeSw: TSwitch;
    yw?: number; ye?: number; ends: number[]; middle: number[]; platLink?: number;
    exits: { node: number; link: number }[];
  }
  const loops: LoopBuild[] = [];
  for (const lp of LAYOUT.loops) {
    const c = chains[lp.station];
    const w = c + lp.west;
    const e = c + lp.east;
    const mk = () => ({ sw: newSwitch('siding', lp.station).id }) as SwBuild;
    const uw = mk(); const dw = mk(); const ue = mk(); const de = mk();
    beginFeature(lp.station);
    addSwitchPt('UP', w - CON_DX, 'west', uw);
    addSwitchPt('DN', w - CON_DX, 'west', dw);
    beginFeature(lp.station);
    addSwitchPt('UP', e + CON_DX, 'east', ue);
    addSwitchPt('DN', e + CON_DX, 'east', de);
    loops.push({ def: lp, w, e, uw, dw, ue, de, ywSw: newSwitch('siding', lp.station), yeSw: newSwitch('siding', lp.station), ends: [], middle: [], exits: [] });
  }

  // feature-side signal positions become hard boundaries (they already are switch bounds)
  // equipped stations: any feature within 1.2 km of the station centre
  const equipped = chains.map((c, i) => features.some((f) => f.station === i || f.pts.some((p) => Math.abs(p.ch - c) < 1200)));

  // plain-line subdivision and joints
  const sectionBounds: Record<'DN' | 'UP', number[]> = { DN: [], UP: [] };
  for (const t of ['DN', 'UP'] as const) {
    const pts = mainPts[t];
    const lo = Math.min(...pts.filter((p) => p.kind === 'end').map((p) => p.ch));
    const hi = Math.max(...pts.filter((p) => p.kind === 'end').map((p) => p.ch));
    let b = Array.from(new Set(hardBounds[t].map((v) => Math.round(v * 10) / 10))).filter((v) => v > lo + 1 && v < hi - 1).sort((x, y) => x - y);
    // subdivide long gaps
    const full = [lo, ...b, hi];
    const extra: number[] = [];
    for (let i = 0; i + 1 < full.length; i++) {
      const gap = full[i + 1] - full[i];
      if (gap > LAYOUT.maxSectionLength) {
        const n = Math.ceil(gap / LAYOUT.maxSectionLength);
        for (let k = 1; k < n; k++) extra.push(full[i] + (gap * k) / n);
      }
    }
    b = [...b, ...extra].sort((x, y) => x - y);
    sectionBounds[t] = b;
    for (const ch of b) pts.push({ ch, kind: 'joint' });
    pts.sort((p, q) => p.ch - q.ch);
  }

  // ------------------------------------------------------------------ main nodes/links
  const mainLinks: Record<'DN' | 'UP', number[]> = { DN: [], UP: [] };
  for (const t of ['DN', 'UP'] as const) {
    const pts = mainPts[t];
    for (const p of pts) {
      const n = newNode(p.kind, p.ch);
      if (p.kind === 'end') n.endKind = 'buffer';
      if (p.kind === 'switch') {
        n.sw = p.swBuild!.sw;
        p.swBuild!.node = n.id;
        switches[n.sw].nodes.push(n.id);
      }
      p.node = n.id;
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const l = newLink(pts[i].node!, pts[i + 1].node!, pts[i + 1].ch - pts[i].ch, t, t === 'DN' ? 1 : -1, pts[i].ch, pts[i + 1].ch);
      mainLinks[t].push(l.id);
    }
    // assign toe / normal for switch nodes on mains
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.kind !== 'switch') continue;
      const n = nodes[p.node!];
      const westLink = mainLinks[t][i - 1];
      const eastLink = mainLinks[t][i];
      if (p.toeSide === 'west') { n.toe = westLink; n.normal = eastLink; } else { n.toe = eastLink; n.normal = westLink; }
    }
  }

  const findMainNode = (sb: SwBuild) => nodes[sb.node!];

  // ------------------------------------------------------------------ diverging links
  // crossovers: diagonal split into two halves
  for (const xo of xos) {
    const dn = findMainNode(xo.dn);
    const up = findMainNode(xo.up);
    const mid = newNode('joint', (dn.chain + up.chain) / 2);
    const half = Math.hypot(Math.abs(up.chain - dn.chain), 4) / 2 + 1;
    const l1 = newLink(dn.id, mid.id, half, 'X', 0, dn.chain, mid.chain);
    const l2 = newLink(mid.id, up.id, half, 'X', 0, mid.chain, up.chain);
    dn.reverse = l1.id;
    up.reverse = l2.id;
    l1.limit = l2.limit = TURNOUT_SPEEDS.crossover;
  }

  // sidings
  const conHalf = Math.hypot(CON_DX, 2) / 2 + 1;
  /** connector from a stub/loop end node to a main-line turnout: end → mid → main */
  const mkCon = (from: TNode, main: TNode): [number, number] => {
    const mid = newNode('joint', (from.chain + main.chain) / 2);
    const c1 = newLink(from.id, mid.id, conHalf, 'CON', 0, from.chain, mid.chain);
    const c2 = newLink(mid.id, main.id, conHalf, 'CON', 0, mid.chain, main.chain);
    c1.limit = c2.limit = TURNOUT_SPEEDS.siding;
    main.reverse = c2.id;
    return [c1.id, c2.id];
  };
  const sidingBerthInfo: { name: string; station: number; turnback: boolean; link: number; offset: number; dir: Dir; exitNode: number; exitLink: number; bidirectional?: boolean }[] = [];
  /**
   * A stub from `bnd` running `s`-wards: either to a buffer, or (a depot lead)
   * on through a transfer track to the yard gate. Returns the stub link that
   * holds the berth; with a `link` turnout the stub is split around it.
   */
  const leads: LeadOut[] = [];
  const buildStub = (bnd: TNode, s: Dir, length: number, station: number, lead: LeadDef | undefined, mainCh: number,
    k?: SidingBuild['k']): number => {
    const endCh = bnd.chain + s * length;
    let from = bnd;
    if (k) {
      // bnd → kw → K → ke → … (K: toe towards bnd, normal on along the stub, reverse to the connector)
      const kw = newNode('joint', k.ch - s * SW_HALF);
      const kn = newNode('switch', k.ch);
      kn.sw = k.sw.id; k.sw.nodes.push(kn.id); k.node = kn.id;
      const ke = newNode('joint', k.ch + s * SW_HALF);
      const l0 = newLink(bnd.id, kw.id, Math.abs(kw.chain - bnd.chain), 'SID', 0, bnd.chain, kw.chain);
      const l1 = newLink(kw.id, kn.id, SW_HALF, 'SID', 0, kw.chain, kn.chain);
      const l2 = newLink(kn.id, ke.id, SW_HALF, 'SID', 0, kn.chain, ke.chain);
      kn.toe = l1.id; kn.normal = l2.id;
      k.con = mkCon(kn, findMainNode(k.main));
      kn.reverse = k.con[0];
      k.links = [l0.id, l1.id, l2.id];
      for (const l of [l0, l1, l2]) l.limit = TURNOUT_SPEEDS.siding;
      from = ke;
    }
    if (!lead) {
      const dead = newNode('end', endCh);
      dead.endKind = 'buffer';
      const ls = newLink(from.id, dead.id, Math.abs(endCh - from.chain), 'SID', 0, from.chain, endCh);
      ls.limit = TURNOUT_SPEEDS.siding;
      return ls.id;
    }
    // depot lead: stub → throat T → t0 → j1 → t1 → j2 → t2 → gate
    const di = LAYOUT.depots.findIndex((x) => x.id === lead.depot);
    if (di < 0) throw new Error(`unknown depot ${lead.depot}`);
    const T = newNode('joint', endCh);
    const ls = newLink(from.id, T.id, Math.abs(endCh - from.chain), 'SID', 0, from.chain, endCh);
    ls.limit = TURNOUT_SPEEDS.siding;
    const j1 = newNode('joint', endCh + s * 20);
    const j2 = newNode('joint', endCh + s * 35);
    const gate = newNode('end', endCh + s * 45);
    gate.endKind = 'depot'; gate.depot = di;
    const t0 = newLink(T.id, j1.id, SW_HALF + 10, 'DEP', 0, T.chain, j1.chain);
    const t1 = newLink(j1.id, j2.id, 220, 'DEP', 0, j1.chain, j2.chain);
    const t2 = newLink(j2.id, gate.id, 220, 'DEP', 0, j2.chain, gate.chain);
    for (const l of [t0, t1, t2]) {
      l.limit = TURNOUT_SPEEDS.depot;
      if (lead.flow) l.depotFlow = lead.flow;
    }
    leads.push({ depot: di, flow: lead.flow ?? 'shared', throat: T.id, j1: j1.id, gate: gate.id, links: [t0.id, t1.id, t2.id], stub: ls.id, mainCh, station, s });
    return ls.id;
  };
  for (const sb of sidings) {
    const s = sb.s;
    let bnd: TNode;
    if (sb.y) {
      const y = newNode('switch', sb.e);
      y.sw = sb.ysw!.id;
      sb.ysw!.nodes.push(y.id);
      sb.y.node = y.id;
      bnd = newNode('joint', sb.e + s * SW_HALF);
      // siding links run from station side outward: y → bnd → dead
      const ly = newLink(y.id, bnd.id, SW_HALF, 'SID', 0, sb.e, sb.e + s * SW_HALF);
      ly.limit = TURNOUT_SPEEDS.siding;
      y.toe = ly.id;
      const cu = mkCon(y, findMainNode(sb.u!));
      const cd = mkCon(y, findMainNode(sb.d!));
      y.normal = cu[0];
      y.reverse = cd[0];
      sb.exitNode = bnd.id;
      sb.exitLink = ly.id;
    } else {
      // single turnout: main → connector → stub, the stub starting at the attached end
      bnd = newNode('joint', sb.e);
      sb.cons = mkCon(bnd, findMainNode(sb.u ?? sb.d!));
      sb.exitNode = bnd.id;
      sb.exitLink = sb.cons[0];
    }
    const length = sb.y ? sb.def.length - SW_HALF : sb.def.length;
    const ls = links[buildStub(bnd, s, length, sb.def.station, sb.def.lead, sb.mainCh, sb.k)];
    if (sb.def.lead) sb.lead = leads[leads.length - 1];
    sb.stub = ls.id;
    // berth: head stops 15 m short of the dead end / lead throat, travelling outward (+1 on ls)
    if (sb.def.purpose !== 'interline') sidingBerthInfo.push({ name: sb.def.name, station: sb.def.station, turnback: sb.def.turnback ?? true, link: ls.id, offset: ls.len - 15, dir: 1, exitNode: sb.exitNode, exitLink: sb.exitLink });
  }
  // double Y: main turnout → splitter (SU/SD) → own-lane merger (normal) or
  // the diamond leg to the other lane's merger (reverse); merger → middle track
  for (const pb of pairs) {
    const s = pb.s;
    const mkSw = (sw: TSwitch, ch: number) => { const n = newNode('switch', ch); n.sw = sw.id; sw.nodes.push(n.id); return n; };
    const chS = pb.mT + s * PAIR_DX;
    const SU = mkSw(pb.sw.SU, chS); const SD = mkSw(pb.sw.SD, chS);
    const MU = mkSw(pb.sw.MU, pb.e); const MD = mkSw(pb.sw.MD, pb.e);
    pb.nodes = { SU: SU.id, SD: SD.id, MU: MU.id, MD: MD.id };
    const cu = mkCon(SU, findMainNode(pb.u));
    const cd = mkCon(SD, findMainNode(pb.d));
    pb.cons = [...cu, ...cd];
    SU.toe = cu[0]; SD.toe = cd[0];
    const mk = (a: TNode, b: TNode, cross: boolean) => {
      const l = newLink(a.id, b.id, (cross ? Math.hypot(PAIR_DX, 5) : PAIR_DX) + 1, 'SID', 0, a.chain, b.chain);
      l.limit = TURNOUT_SPEEDS.siding;
      return l.id;
    };
    const uu = mk(SU, MU, false); const dd = mk(SD, MD, false);
    const ud = mk(SU, MD, true); const du = mk(SD, MU, true);
    SU.normal = uu; SU.reverse = ud;
    SD.normal = dd; SD.reverse = du;
    MU.normal = uu; MU.reverse = du;
    MD.normal = dd; MD.reverse = ud;
    pb.inner = { U: [cu[0], uu], D: [cd[0], dd], X: [ud, du] };
    pb.def.stubs.forEach((st, i) => {
      const M = i === 0 ? MU : MD;
      const bnd = newNode('joint', pb.e + s * SW_HALF);
      const lt = newLink(M.id, bnd.id, SW_HALF, 'SID', 0, M.chain, bnd.chain);
      lt.limit = TURNOUT_SPEEDS.siding;
      M.toe = lt.id;
      (i === 0 ? pb.inner.U : pb.inner.D).push(lt.id);
      const far = pb.farLinks[i];
      const end = buildStub(bnd, s, st.length - SW_HALF, pb.def.station, st.lead, pb.mT, far);
      // With a far-end connector, stable before its turnout, clear of both
      // throats; the short continuation is a buffer overrun, not a train berth.
      const ls = links[far ? far.links![0] : end];
      if (far) (i === 0 ? pb.inner.U : pb.inner.D).push(end);
      pb.stubs.push({ link: ls.id, exitNode: bnd.id, exitLink: lt.id, bnd: bnd.id, lead: st.lead ? leads[leads.length - 1] : undefined });
      sidingBerthInfo.push({ name: st.name, station: pb.def.station, turnback: st.turnback ?? true, link: ls.id, offset: ls.len - 15, dir: 1, exitNode: bnd.id, exitLink: lt.id, bidirectional: !!far });
    });
  }

  // loops: yw → bw → [platform] → be → ye, each Y joined to both mains
  for (const lb of loops) {
    const c = chains[lb.def.station];
    const mkY = (sw: TSwitch, ch: number) => { const n = newNode('switch', ch); n.sw = sw.id; sw.nodes.push(n.id); return n; };
    const yw = mkY(lb.ywSw, lb.w);
    const ye = mkY(lb.yeSw, lb.e);
    lb.yw = yw.id; lb.ye = ye.id;
    const bw = newNode('joint', lb.w + SW_HALF);
    const be = newNode('joint', lb.e - SW_HALF);
    const lw = newLink(yw.id, bw.id, SW_HALF, 'SID', 0, lb.w, lb.w + SW_HALF);
    const le = newLink(be.id, ye.id, SW_HALF, 'SID', 0, lb.e - SW_HALF, lb.e);
    yw.toe = lw.id;
    ye.toe = le.id;
    lb.ends = [lw.id, le.id];
    const pts = lb.def.platform ? [bw, newNode('joint', c - PLAT_HALF), newNode('joint', c + PLAT_HALF), be] : [bw, be];
    for (let i = 0; i + 1 < pts.length; i++) {
      const l = newLink(pts[i].id, pts[i + 1].id, pts[i + 1].chain - pts[i].chain, 'SID', 0, pts[i].chain, pts[i + 1].chain);
      lb.middle.push(l.id);
    }
    if (lb.def.platform) lb.platLink = lb.middle[1];
    for (const lid of [lw.id, le.id, ...lb.middle]) links[lid].limit = TURNOUT_SPEEDS.siding;
    yw.normal = mkCon(yw, findMainNode(lb.uw))[0];
    yw.reverse = mkCon(yw, findMainNode(lb.dw))[0];
    ye.normal = mkCon(ye, findMainNode(lb.ue))[0];
    ye.reverse = mkCon(ye, findMainNode(lb.de))[0];
    // exit signals facing out at both ends of the middle track; with a platform
    // at the platform ends, so a train reversing there has used its whole route
    lb.exits = lb.def.platform
      ? [{ node: pts[1].id, link: lb.middle[0] }, { node: pts[2].id, link: lb.middle[2] }]
      : [{ node: bw.id, link: lw.id }, { node: be.id, link: le.id }];
  }

  // tail limits: main links beyond the outer scissors
  for (const ti of tailInfo) {
    for (const t of ['DN', 'UP'] as const) {
      for (const lid of mainLinks[t]) {
        const l = links[lid];
        const m = (l.chainA + l.chainB) / 2;
        if ((ti.side === 'west' && m < ti.signalCh[t]) || (ti.side === 'east' && m > ti.signalCh[t])) l.limit = TURNOUT_SPEEDS.tail;
      }
    }
  }
  // permanent speed limits on mains
  for (const t of ['DN', 'UP'] as const) {
    for (const lid of mainLinks[t]) {
      const l = links[lid];
      const m = (l.chainA + l.chainB) / 2;
      for (const sl of SPEED_LIMITS) if (m >= sl.from && m < sl.to) l.limit = Math.min(l.limit, sl.kmh);
    }
  }

  // ------------------------------------------------------------------ zones
  const zones: TZone[] = LAYOUT.zones.map((z, i) => {
    const from = i === 0 ? -1e9 : (chains[z.fromStation - 1] + chains[z.fromStation]) / 2;
    const to = i === LAYOUT.zones.length - 1 ? 1e9 : (chains[z.toStation] + chains[z.toStation + 1]) / 2;
    return { id: i, key: z.id, name: z.name, chainFrom: from, chainTo: to };
  });
  const zoneOf = (ch: number) => {
    for (const z of zones) if (ch >= z.chainFrom && ch < z.chainTo) return z.id;
    return zones.length - 1;
  };
  for (const l of links) l.zone = zoneOf((l.chainA + l.chainB) / 2);

  // ------------------------------------------------------------------ sections
  const sections: TSection[] = [];
  const newSection = (kind: TSection['kind'], track: TrackKind, ch: number): TSection => {
    const s: TSection = { id: sections.length, name: '', links: [], len: 0, zone: zoneOf(ch), kind, track, station: nearestStation(ch), chainFrom: Infinity, chainTo: -Infinity };
    sections.push(s);
    return s;
  };
  const assign = (lid: number, sec: TSection) => {
    const l = links[lid];
    l.section = sec.id;
    sec.links.push(lid);
    sec.len += l.len;
    sec.chainFrom = Math.min(sec.chainFrom, l.chainA, l.chainB);
    sec.chainTo = Math.max(sec.chainTo, l.chainA, l.chainB);
  };
  // mains: group consecutive links between section bounds
  for (const t of ['DN', 'UP'] as const) {
    const bounds = new Set(sectionBounds[t].map((v) => Math.round(v * 10) / 10));
    let cur: TSection | null = null;
    for (const lid of mainLinks[t]) {
      const l = links[lid];
      if (!cur) cur = newSection('plain', t, l.chainA);
      assign(lid, cur);
      const endCh = Math.round(l.chainB * 10) / 10;
      if (bounds.has(endCh)) cur = null;
    }
  }
  // classify main sections
  for (const s of sections) {
    const mid = (s.chainFrom + s.chainTo) / 2;
    const st = nearestStation(mid);
    if (Math.abs(mid - chains[st]) < 1 && Math.abs(s.len - 2 * PLAT_HALF) < 1) s.kind = 'platform';
    if (s.links.some((lid) => nodes[links[lid].a].kind === 'switch' || nodes[links[lid].b].kind === 'switch')) s.kind = 'switch';
  }
  // tails: plain sections beyond the outer scissors
  for (const s of sections) {
    for (const ti of tailInfo) {
      const mid = (s.chainFrom + s.chainTo) / 2;
      const tr = s.track as 'DN' | 'UP';
      if (s.kind === 'plain' && (tr === 'DN' || tr === 'UP') && ((ti.side === 'west' && mid < ti.signalCh[tr]) || (ti.side === 'east' && mid > ti.signalCh[tr]))) s.kind = 'tail';
    }
  }
  // diverging links: attach to the section of the main/branch node they touch
  const nodeSection = (nid: number): number => {
    const n = nodes[nid];
    for (const lid of n.links) if (links[lid].section >= 0) return links[lid].section;
    return -1;
  };
  for (const l of links) {
    if (l.section >= 0) continue;
    if (l.track === 'X' || l.track === 'CON' || (l.track === 'DEP' && (nodes[l.a].kind === 'switch' && nodes[l.a].chain !== nodes[l.b].chain))) {
      // first half (touching a switch at a) – take that switch's section
      const sw = nodes[l.a].kind === 'switch' ? l.a : l.b;
      const sec = nodeSection(sw);
      if (sec >= 0) { assign(l.id, sections[sec]); continue; }
    }
  }
  // second halves and remaining siding/depot links
  for (const l of links) {
    if (l.section >= 0) continue;
    if (l.track === 'X' || l.track === 'CON' || l.track === 'DEP') {
      const swEnd = nodes[l.b].kind === 'switch' ? l.b : nodes[l.a].kind === 'switch' ? l.a : -1;
      if (swEnd >= 0) {
        const sec = nodeSection(swEnd);
        if (sec >= 0) { assign(l.id, sections[sec]); continue; }
        // switch node not yet in a section (siding Y / depot Q): create switch section
        const ns = newSection('switch', l.track === 'DEP' ? 'DEP' : 'SID', l.chainA);
        assign(l.id, ns);
        continue;
      }
    }
  }
  const moveTo = (lid: number, secId: number) => {
    const l = links[lid];
    if (l.section === secId) return;
    if (l.section >= 0) {
      const old = sections[l.section];
      old.links = old.links.filter((x) => x !== lid);
      old.len -= l.len;
    }
    l.section = -1;
    assign(lid, sections[secId]);
  };
  // siding Y sections: y-node links (toe ly + connector halves) share one section;
  // a single-turnout stub's connector joins its turnout's section
  for (const sb of sidings) {
    if (sb.y) {
      const y = nodes[sb.y.node!];
      const secId = links[y.normal!].section >= 0 ? links[y.normal!].section : newSection('switch', 'SID', sb.e).id;
      for (const lid of [y.toe!, y.normal!, y.reverse!]) moveTo(lid, secId);
    } else moveTo(sb.cons[0], links[sb.cons[1]].section);
    if (sb.k) {
      // the connector turnout on the stub: its own switch section; the piece before it a short siding section
      const ks = newSection('switch', 'SID', sb.k.ch).id;
      for (const lid of [sb.k.links![1], sb.k.links![2], sb.k.con![0]]) moveTo(lid, ks);
      moveTo(sb.k.links![0], newSection('siding', 'SID', links[sb.k.links![0]].chainA).id);
    }
    moveTo(sb.stub!, newSection('siding', 'SID', sb.dead).id);
  }
  // double Y: each splitter with its own-lane merger, and the diamond, are sections
  for (const pb of pairs) {
    for (const k of ['U', 'D', 'X'] as const) {
      const sid = newSection('switch', 'SID', pb.mT + pb.s * PAIR_DX).id;
      for (const lid of pb.inner[k]) moveTo(lid, sid);
    }
    for (const st of pb.stubs) moveTo(st.link, newSection('siding', 'SID', links[st.link].chainB).id);
    for (const far of pb.farLinks) if (far) {
      const secId = newSection('switch', 'SID', far.ch).id;
      for (const lid of [far.links![1], far.links![2], far.con![0]]) moveTo(lid, secId);
    }
  }
  for (const lb of loops) {
    for (const yid of [lb.yw!, lb.ye!]) {
      const y = nodes[yid];
      const secId = newSection('switch', 'SID', y.chain).id;
      for (const lid of [y.toe!, y.normal!, y.reverse!]) moveTo(lid, secId);
    }
    for (const lid of lb.middle) {
      const l = links[lid];
      assign(lid, newSection(lid === lb.platLink ? 'platform' : 'siding', 'SID', (l.chainA + l.chainB) / 2));
    }
  }
  // depot transfer tracks: one section per link
  for (const ld of leads) for (const lid of ld.links) moveTo(lid, newSection('depot', 'DEP', links[lid].chainA).id);
  // remove empty sections (from re-assignment) by compaction
  {
    const keep = sections.filter((s) => s.links.length > 0);
    const remap = new Map<number, number>();
    keep.forEach((s, i) => { remap.set(s.id, i); s.id = i; });
    for (const l of links) l.section = remap.get(l.section)!;
    sections.length = 0;
    sections.push(...keep);
  }
  for (const s of sections) {
    // recompute extents/len
    s.len = s.links.reduce((a, lid) => a + links[lid].len, 0);
    s.zone = links[s.links[0]].zone;
  }

  // switch sections
  for (const sw of switches) {
    const own = sw.nodes.map((n) => links[nodes[n].toe!].section);
    const adj = sw.nodes.flatMap((n) => [nodes[n].normal!, nodes[n].reverse!].map((l) => links[l].section));
    sw.sections = Array.from(new Set([...own, ...adj]));
  }

  // ------------------------------------------------------------------ platforms
  const platforms: TPlatform[] = [];
  const stationPlat: { DN: number; UP: number }[] = [];
  for (let i = 0; i < nStations; i++) {
    const rec = { DN: -1, UP: -1 };
    for (const t of ['DN', 'UP'] as const) {
      const lid = mainLinks[t].find((id) => Math.abs(links[id].chainA - (chains[i] - PLAT_HALF)) < 0.2 && Math.abs(links[id].chainB - (chains[i] + PLAT_HALF)) < 0.2);
      if (lid === undefined) throw new Error(`platform link not found for ${STATIONS[i].name} ${t}`);
      const p: TPlatform = {
        id: platforms.length, station: i, track: t, link: lid, section: links[lid].section,
        name: `${STATIONS[i].name} ${t === 'DN' ? '下行' : '上行'}站台`,
        // UP runs north of DN: an island lies between them, a side platform outside
        face: (STATIONS[i].sidePlatform?.includes(t) ?? false) === (t === 'UP') ? 'N' : 'S',
      };
      links[lid].platform = p.id;
      platforms.push(p);
      rec[t] = p.id;
    }
    stationPlat.push(rec);
  }
  // middle-track face of an island platform (shares the UP face's waiting passengers)
  for (const lb of loops) {
    if (lb.platLink === undefined) continue;
    const i = lb.def.station;
    const p: TPlatform = {
      id: platforms.length, station: i, track: 'UP', link: lb.platLink, section: links[lb.platLink].section,
      name: `${STATIONS[i].name} 中间线站台`, pool: stationPlat[i].UP, face: 'N',
    };
    links[lb.platLink].platform = p.id;
    platforms.push(p);
  }

  // ------------------------------------------------------------------ signals
  const signals: TSignal[] = [];
  const signalByEntry = new Map<number, number>();
  const addSignal = (node: number, link: number, role: SignalRole): number => {
    const key = sigEntryKey(node, link);
    const ex = signalByEntry.get(key);
    if (ex !== undefined) return ex;
    const l = links[link];
    const dir: Dir = l.a === node ? 1 : -1;
    const s: TSignal = { id: signals.length, name: '', node, link, dir, role, station: nearestStation(nodes[node].chain), routes: [], chain: nodes[node].chain };
    signals.push(s);
    signalByEntry.set(key, s.id);
    return s.id;
  };
  /** main joint node at chainage on track */
  const mainNodeAt = (t: 'DN' | 'UP', ch: number): number => {
    let best = -1;
    let bd = Infinity;
    for (const lid of mainLinks[t]) {
      for (const nid of [links[lid].a, links[lid].b]) {
        const d = Math.abs(nodes[nid].chain - ch);
        if (d < bd && nodes[nid].kind === 'joint') { bd = d; best = nid; }
      }
    }
    if (bd > 0.6) throw new Error(`no joint at ${t} ${ch} (closest ${bd})`);
    return best;
  };
  const mainLinkFrom = (t: 'DN' | 'UP', node: number, dir: Dir): number => {
    for (const lid of nodes[node].links) {
      const l = links[lid];
      if (l.track !== t) continue;
      if (dir === 1 && l.a === node) return lid;
      if (dir === -1 && l.b === node) return lid;
    }
    throw new Error('main link not found');
  };
  const sigAt = (t: 'DN' | 'UP', ch: number, dir: Dir, role: SignalRole) => {
    const n = mainNodeAt(t, ch);
    return addSignal(n, mainLinkFrom(t, n, dir), role);
  };
  // platform signals
  for (let i = 0; i < nStations; i++) {
    const c = chains[i];
    const westEnd = i === 0;
    const eastEnd = i === nStations - 1;
    // starting signals (normal direction, exit end)
    if (!eastEnd || equipped[i]) sigAt('DN', c + PLAT_HALF, 1, 'start');
    if (!westEnd || equipped[i]) sigAt('UP', c - PLAT_HALF, -1, 'start');
    if (equipped[i]) {
      sigAt('DN', c - PLAT_HALF, 1, 'home');
      sigAt('UP', c + PLAT_HALF, -1, 'home');
      // reverse-direction signals
      sigAt('DN', c - PLAT_HALF, -1, 'rev');
      sigAt('DN', c + PLAT_HALF, -1, 'rev');
      sigAt('UP', c + PLAT_HALF, 1, 'rev');
      sigAt('UP', c - PLAT_HALF, 1, 'rev');
    }
  }
  // feature signals: protect both ends of each feature, both directions
  const westLimit = (t: 'DN' | 'UP') => tailInfo.find((x) => x.side === 'west')?.signalCh[t] ?? -Infinity;
  const eastLimit = (t: 'DN' | 'UP') => tailInfo.find((x) => x.side === 'east')?.signalCh[t] ?? Infinity;
  const hasSignalNear = (t: 'DN' | 'UP', ch: number, dir: Dir, within: number) =>
    signals.some((s) => links[s.link].track === t && s.dir === dir && Math.abs(s.chain - ch) <= within);
  const signalInFront = (t: 'DN' | 'UP', ch: number, dir: Dir, within: number) =>
    signals.some((s) => links[s.link].track === t && s.dir === dir && (dir === 1 ? s.chain <= ch + 1 && s.chain >= ch - within : s.chain >= ch - 1 && s.chain <= ch + within));
  for (const f of features) {
    for (const t of ['DN', 'UP'] as const) {
      const ext = featureExtent(f, t);
      if (!ext) continue;
      const normal: Dir = t === 'DN' ? 1 : -1;
      // west edge facing east, east edge facing west
      const westRole: SignalRole = normal === 1 ? 'home' : 'rev';
      const eastRole: SignalRole = normal === -1 ? 'home' : 'rev';
      // only a signal in front of the switches protects them: one just past a
      // facing switch leaves the diverging leg unprotected, and routes into it
      // then start at the previous station (广兰路 west end)
      if (!signalInFront(t, ext.from, 1, 130)) sigAt(t, ext.from, 1, westRole);
      if (!signalInFront(t, ext.to, -1, 130)) sigAt(t, ext.to, -1, eastRole);
    }
  }
  // exit / protection signals on the far side of each feature (routes end
  // just past the switches; plain line beyond is covered by automatic routes)
  for (const f of features) {
    for (const t of ['DN', 'UP'] as const) {
      const ext = featureExtent(f, t);
      if (!ext) continue;
      const normal: Dir = t === 'DN' ? 1 : -1;
      if (!hasSignalNear(t, ext.to, 1, 25) && ext.to < eastLimit(t)) sigAt(t, ext.to, 1, normal === 1 ? 'home' : 'rev');
      if (!hasSignalNear(t, ext.from, -1, 25) && ext.from > westLimit(t)) sigAt(t, ext.from, -1, normal === -1 ? 'home' : 'rev');
    }
  }
  // tail exit signals (both tracks, facing the platform)
  for (const ti of tailInfo) {
    const dir: Dir = ti.side === 'west' ? 1 : -1;
    for (const t of ['DN', 'UP'] as const) {
      const n = mainNodeAt(t, ti.signalCh[t]);
      const sid = addSignal(n, mainLinkFrom(t, n, dir), 'exit');
      signals[sid].role = 'exit';
    }
  }
  // siding and middle-track exit signals
  for (const b of sidingBerthInfo) addSignal(b.exitNode, b.exitLink, 'exit');
  for (const lb of loops) for (const x of lb.exits) addSignal(x.node, x.link, 'exit');
  for (const pb of pairs) for (const far of pb.farLinks) if (far) {
    // Protect the far-end turnout when departing a middle track without
    // reversing through the station-side double Y.
    addSignal(links[far.links![0]].b, far.links![1], 'exit');
  }
  // depot exit signals
  for (const ld of leads) {
    // depot exit signal at the yard end of the transfer track, and the depot
    // entry signal where the stub track ends (a turnback berth lies short of it)
    if (ld.flow !== 'in') addSignal(ld.j1, ld.links[0], 'depot');
    if (ld.flow !== 'out') addSignal(ld.throat, ld.links[0], 'home');
  }

  // ------------------------------------------------------------------ berths
  const berths: TBerth[] = [];
  const addBerth = (b: Omit<TBerth, 'id'>) => { const id = berths.length; berths.push({ ...b, id }); return id; };
  const stationTurnback: number[][] = chains.map(() => []);
  const stationStorage: number[][] = chains.map(() => []);
  for (const p of platforms) {
    const l = links[p.link];
    const stopOff = (LINE_INFO.platformLength / 2) + (PLAT_HALF - LINE_INFO.platformLength / 2); // head at platform end
    const normalDir: Dir = p.track === 'DN' ? 1 : -1;
    for (const dir of [1, -1] as Dir[]) {
      // stopping points symmetric about the platform centre: after changing
      // ends the head is exactly at the opposite-direction stopping point
      const offset = dir === 1 ? l.len / 2 + LINE_INFO.trainLength / 2 : l.len / 2 - LINE_INFO.trainLength / 2;
      void stopOff;
      // the middle-track face serves both directions (arrival east, departure west)
      const reverse = p.pool === undefined && dir !== normalDir;
      addBerth({
        kind: 'platform', link: p.link, offset, dir, platform: p.id, station: p.station, depot: -1,
        reverse, name: `${p.name}${reverse ? '(反向)' : ''}`,
      });
    }
  }
  for (const ti of tailInfo) {
    const dir: Dir = ti.side === 'west' ? -1 : 1;
    for (const t of ['DN', 'UP'] as const) {
      // the buffer-end link
      const lid = dir === -1 ? mainLinks[t][0] : mainLinks[t][mainLinks[t].length - 1];
      const l = links[lid];
      const offset = dir === -1 ? 15 : l.len - 15;
      const id = addBerth({ kind: 'tail', link: lid, offset, dir, platform: -1, station: ti.station, depot: -1, reverse: false, name: `${STATIONS[ti.station].name}${t === 'DN' ? '下行' : '上行'}尾轨` });
      if (ti.turnback) stationTurnback[ti.station].push(id);
      // A storage-only tail on the track that leaves away from the buffer
      // (蟠祥路 下行) holds two trains, one on each of its links: they go out
      // straight to the departure platform, the inner one first.
      const away = (t === 'DN') === (dir === -1);
      const innerId = dir === -1 ? mainLinks[t][1] : mainLinks[t][mainLinks[t].length - 2];
      if (!ti.turnback && away && links[innerId].len >= LINE_INFO.trainLength + 30) {
        const il = links[innerId];
        const inner = addBerth({ kind: 'tail', link: innerId, offset: dir === -1 ? 15 : il.len - 15, dir, platform: -1, station: ti.station, depot: -1, reverse: false, name: `${STATIONS[ti.station].name}${t === 'DN' ? '下行' : '上行'}尾轨(内)` });
        stationStorage[ti.station].push(inner, id);
      }
    }
  }
  for (const b of sidingBerthInfo) {
    const id = addBerth({ kind: 'siding', link: b.link, offset: b.offset, dir: b.dir, platform: -1, station: b.station, depot: -1, reverse: false, name: b.name });
    if (b.turnback) stationTurnback[b.station].push(id);
    if (b.bidirectional) addBerth({ kind: 'siding', link: b.link, offset: b.offset - LINE_INFO.trainLength, dir: -1,
      platform: -1, station: b.station, depot: -1, reverse: false, name: b.name });
  }
  // 广兰路: small-loop trains reverse at the middle-track platform (arriving eastbound)
  for (const lb of loops) {
    if (lb.platLink === undefined) {
      // Both throats and their exit signals already exist. Register the
      // usable stopping point; no interlocking rule changes.
      const link = links[lb.middle[0]];
      const id = addBerth({ kind: 'siding', link: link.id, offset: link.len / 2 + LINE_INFO.trainLength / 2,
        dir: 1, platform: -1, station: lb.def.station, depot: -1, reverse: false, name: lb.def.name });
      addBerth({ kind: 'siding', link: link.id, offset: link.len / 2 - LINE_INFO.trainLength / 2,
        dir: -1, platform: -1, station: lb.def.station, depot: -1, reverse: false, name: lb.def.name });
      stationStorage[lb.def.station].push(id);
      continue;
    }
    const id = berths.find((b) => b.link === lb.platLink && b.dir === 1)!.id;
    stationTurnback[lb.def.station].push(id);
  }
  /**
   * Is (link, dir) → accept reachable without reversing, over any switch
   * position `swOk` allows, within `maxLen` metres? Shortest paths first.
   */
  const reach = (from: number, dir: Dir, maxLen: number, accept: (lid: number, d: Dir) => boolean,
    swOk: (sw: number, pos: 'N' | 'R') => boolean = () => true): boolean => reachLen(from, dir, maxLen, accept, swOk) < Infinity;
  /** length of the shortest such path, Infinity if none */
  const reachLen = (from: number, dir: Dir, maxLen: number, accept: (lid: number, d: Dir) => boolean,
    swOk: (sw: number, pos: 'N' | 'R') => boolean = () => true): number => {
    const seen = new Set<number>();
    const open: { l: number; d: Dir; len: number }[] = [{ l: from, d: dir, len: 0 }];
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].len < open[bi].len) bi = i;
      const { l, d, len } = open.splice(bi, 1)[0];
      const key = l * 2 + (d > 0 ? 1 : 0);
      if (seen.has(key)) continue;
      seen.add(key);
      if (accept(l, d)) return len;
      if (len > maxLen) continue;
      const nid = d === 1 ? links[l].b : links[l].a;
      const n = nodes[nid];
      const nexts: { l: number; sw?: [number, 'N' | 'R'] }[] = [];
      if (n.kind === 'joint') {
        const o = n.links.find((x) => x !== l);
        if (o !== undefined) nexts.push({ l: o });
      } else if (n.kind === 'switch') {
        if (l === n.toe) nexts.push({ l: n.normal!, sw: [n.sw!, 'N'] }, { l: n.reverse!, sw: [n.sw!, 'R'] });
        else if (l === n.normal) nexts.push({ l: n.toe!, sw: [n.sw!, 'N'] });
        else if (l === n.reverse) nexts.push({ l: n.toe!, sw: [n.sw!, 'R'] });
      }
      for (const nx of nexts) {
        if (nx.sw && !swOk(nx.sw[0], nx.sw[1])) continue;
        const nl = links[nx.l];
        const nd: Dir = nl.a === nid ? 1 : -1;
        if (nl.depotFlow && (nl.depotFlow === 'in' ? nd !== 1 : nd !== -1)) continue;
        open.push({ l: nx.l, d: nd, len: len + nl.len });
      }
    }
    return Infinity;
  };
  const normalDirOf = (t: 'DN' | 'UP'): Dir => (t === 'DN' ? 1 : -1);
  const platLinkOf = (st: number, t: 'DN' | 'UP') => platforms[stationPlat[st][t]].link;

  const depots: TDepot[] = [];
  LAYOUT.depots.forEach((dp, di) => {
    const own = leads.filter((ld) => ld.depot === di);
    // dedicated leads first, two-way leads after them
    const exits = own.filter((ld) => ld.flow !== 'in').sort((a, b) => +(a.flow !== 'out') - +(b.flow !== 'out'));
    const entries = own.filter((ld) => ld.flow !== 'out').sort((a, b) => +(a.flow !== 'in') - +(b.flow !== 'in'));
    const inL = entries[0];
    const outL = exits.find((ld) => ld !== inL) ?? exits[0];
    if (!inL || !outL) throw new Error(`depot ${dp.id} needs an entry and an exit lead`);
    const id = depots.length;
    // one 入段 berth at the gate of every lead a train can go in by
    const entryBerths = own.map((ld) => ld.flow === 'out' ? -1
      : addBerth({ kind: 'depot', link: ld.links[2], offset: links[ld.links[2]].len - 5, dir: 1, platform: -1, station: dp.station, depot: id, reverse: false, name: `${dp.name}入段` }));
    const berth = entryBerths[own.indexOf(inL)];
    // where trains leaving in each direction first reach a platform, and where
    // trains coming in last leave one: at the junction station, directly or
    // against the platform's normal direction (then they change ends there)
    const S = dp.station;
    const portal = (t: 'DN' | 'UP', exit: boolean): DepotPortal => {
      const n = normalDirOf(t);
      const plat = platLinkOf(S, t);
      // the shortest way wins: with two leads behind a double Y that is the
      // one running straight onto the main, not across the diamond
      for (const reverse of [false, true]) {
        const want: Dir = (reverse ? -n : n) as Dir;
        const len = (ld: LeadOut) => exit ? reachLen(ld.links[1], -1, 4000, (l, d) => l === plat && d === want)
          : reachLen(plat, want, 4000, (l, d) => l === ld.links[2] && d === 1);
        const best = (exit ? exits : entries).map((ld) => ({ ld, len: len(ld) })).filter((x) => x.len < Infinity)
          .sort((a, b) => a.len - b.len)[0];
        if (best) return { station: S, reverse, path: own.indexOf(best.ld) };
      }
      throw new Error(`${dp.name}: no ${exit ? 'exit' : 'entry'} path for ${t} at ${STATIONS[S].name}`);
    };
    depots.push({
      id, key: dp.id, name: dp.name, short: dp.short, station: dp.station, gateNode: inL.gate,
      gateLink: inL.links[2], outGateNode: outL.gate, outGateLink: outL.links[2],
      transferPaths: own.map((ld) => ({ gate: ld.gate, links: ld.links, throat: ld.throat, flow: ld.flow, stub: ld.stub,
        exitSignal: ld.flow === 'in' ? -1 : signalByEntry.get(sigEntryKey(ld.j1, ld.links[0]))! })),
      berth, entryBerths, exitSignal: signalByEntry.get(sigEntryKey(outL.j1, outL.links[0]))!,
      work: dp.work, capacity: dp.capacity, stablingTracks: dp.stablingTracks, exitTime: dp.exitTime,
      junctionChain: own.reduce((a, ld) => a + ld.mainCh, 0) / own.length,
      portals: {
        exit: { DN: portal('DN', true), UP: portal('UP', true) },
        entry: { DN: portal('DN', false), UP: portal('UP', false) },
      },
    });
  });

  // ------------------------------------------------------------------ routes
  const routes: TRoute[] = [];
  const berthsByLink = new Map<number, number[]>();
  for (const b of berths) {
    const arr = berthsByLink.get(b.link) ?? [];
    arr.push(b.id);
    berthsByLink.set(b.link, arr);
  }
  for (const sig of signals) {
    const startLink = sig.link;
    type Frame = { steps: RouteStep[]; sws: { sw: number; pos: 'N' | 'R' }[]; len: number };
    const stack: Frame[] = [{ steps: [{ link: startLink, dir: sig.dir }], sws: [], len: links[startLink].len }];
    while (stack.length) {
      const fr = stack.pop()!;
      const last = fr.steps[fr.steps.length - 1];
      const l = links[last.link];
      const exitNode = last.dir === 1 ? l.b : l.a;
      const n = nodes[exitNode];
      const finish = (end: number, endNode: number) => {
        routes.push({
          id: routes.length, name: '', start: sig.id, end, endNode, steps: fr.steps,
          sections: dedupe(fr.steps.map((s) => links[s.link].section)), switches: fr.sws, length: fr.len,
          wrongDir: false, diverging: fr.sws.some((s) => s.pos === 'R'), fleeting: false, berths: [], limit: 0,
        });
      };
      if (n.kind === 'end') { finish(-1, exitNode); continue; }
      const nexts: { link: number; sw?: { sw: number; pos: 'N' | 'R' } }[] = [];
      if (n.kind === 'joint') {
        const other = n.links.find((x) => x !== last.link);
        if (other !== undefined) nexts.push({ link: other });
      } else {
        const sw = n.sw!;
        if (last.link === n.toe) {
          nexts.push({ link: n.normal!, sw: { sw, pos: 'N' } });
          nexts.push({ link: n.reverse!, sw: { sw, pos: 'R' } });
        } else if (last.link === n.normal) nexts.push({ link: n.toe!, sw: { sw, pos: 'N' } });
        else if (last.link === n.reverse) nexts.push({ link: n.toe!, sw: { sw, pos: 'R' } });
      }
      for (const nx of nexts) {
        const nl = links[nx.link];
        const ndir: Dir = nl.a === exitNode ? 1 : -1;
        if (nl.depotFlow && (nl.depotFlow === 'in' ? ndir !== 1 : ndir !== -1)) {
          // an exit-only lead can still be entered from the main as far as its throat (折返/停车 on 出段线)
          if (nl.depotFlow === 'out' && fr.steps.length > 1) {
            finish(-1, exitNode);
            routes[routes.length - 1].switches = fr.sws;
            routes[routes.length - 1].diverging = fr.sws.some((s) => s.pos === 'R');
          }
          continue;
        }
        const sigId = signalByEntry.get(sigEntryKey(exitNode, nx.link));
        // consistent position for paired switches
        if (nx.sw) {
          const prev = fr.sws.find((s) => s.sw === nx.sw!.sw);
          if (prev && prev.pos !== nx.sw.pos) continue;
        }
        const sws = nx.sw && !fr.sws.some((s) => s.sw === nx.sw!.sw) ? [...fr.sws, nx.sw] : fr.sws;
        if (sigId !== undefined) {
          // a signal facing our travel direction ends the route
          finish(sigId, exitNode);
          routes[routes.length - 1].switches = sws;
          routes[routes.length - 1].diverging = sws.some((s) => s.pos === 'R');
          continue;
        }
        if (fr.steps.some((s) => s.link === nx.link)) continue;
        if (fr.len > 9000) continue; // no end signal within reach (远东大道—航站楼 is ~8 km)
        stack.push({ steps: [...fr.steps, { link: nx.link, dir: ndir }], sws, len: fr.len + nl.len });
      }
    }
  }
  // route attributes
  for (const r of routes) {
    let wrong = 0;
    let limit = 999;
    for (const s of r.steps) {
      const l = links[s.link];
      if (l.normalDir !== 0 && l.normalDir !== s.dir) wrong += l.len;
      limit = Math.min(limit, l.limit);
      for (const bid of berthsByLink.get(s.link) ?? []) if (berths[bid].dir === s.dir) r.berths.push(bid);
    }
    r.limit = limit;
    r.wrongDir = wrong > 80;
    const sig = signals[r.start];
    r.fleeting = !r.diverging && !r.wrongDir && (sig.role === 'start' || sig.role === 'home') && r.end >= 0 && r.steps.every((s) => {
      const l = links[s.link];
      return l.track === 'DN' || l.track === 'UP';
    });
    sig.routes.push(r.id);
  }

  // ------------------------------------------------------------------ names
  const zz = (n: number) => String(n).padStart(2, '0');
  {
    const cnt = new Map<string, number>();
    const next = (k: string, start: number) => { const v = cnt.get(k) ?? start; cnt.set(k, v + 2); return v; };
    const ordered = [...signals].sort((a, b) => a.chain - b.chain);
    for (const s of ordered) {
      const st = zz(s.station + 1);
      if (s.role === 'depot') {
        const d = depots.find((x) => x.transferPaths.some((p) => p.exitSignal === s.id));
        const outs = d ? d.transferPaths.filter((p) => p.exitSignal >= 0) : [];
        s.name = `D${d?.key ?? ''}${outs.length > 1 ? outs.findIndex((p) => p.exitSignal === s.id) + 1 : ''}`;
        continue;
      }
      const l = links[s.link];
      const facingEast = (s.dir === 1 ? l.chainB - l.chainA : l.chainA - l.chainB) > 0;
      const prefix = facingEast ? 'X' : 'S';
      s.name = `${prefix}${st}${zz(next(prefix + st, prefix === 'X' ? 1 : 2))}`;
    }
  }
  {
    const ordered = [...switches].sort((a, b) => nodes[a.nodes[0]].chain - nodes[b.nodes[0]].chain);
    const cnt = new Map<number, number>();
    for (const sw of ordered) {
      const k = sw.station;
      const v = cnt.get(k) ?? 1;
      if (sw.nodes.length === 2) {
        sw.name = `P${zz(k + 1)}${zz(v)}/${zz(v + 2)}`;
        cnt.set(k, v + 4);
      } else {
        sw.name = `P${zz(k + 1)}${zz(v)}`;
        cnt.set(k, v + 2);
      }
    }
  }
  {
    const ordered = [...sections].sort((a, b) => a.chainFrom - b.chainFrom);
    const cnt = new Map<string, number>();
    for (const s of ordered) {
      const st = zz(s.station + 1);
      const isUp = s.track === 'UP';
      const key = st + (isUp ? 'U' : 'D');
      const v = cnt.get(key) ?? (isUp ? 2 : 1);
      cnt.set(key, v + 2);
      const p = platforms.find((pp) => pp.section === s.id);
      s.name = p ? `G${st}${zz(v)}·${p.track === 'DN' ? '下' : '上'}站台` : `G${st}${zz(v)}`;
    }
  }
  for (const r of routes) {
    r.name = `${signals[r.start].name}→${r.end >= 0 ? signals[r.end].name : nodes[r.endNode].endKind === 'depot' ? '入段' : '尽头'}${r.diverging ? '(侧向)' : ''}`;
  }

  // ------------------------------------------------------------------ geometry (schematic)
  const rowsDef = [
    { chainFrom: -Infinity, chainTo: wrapChain, x0: 150, x1: 3690 },
    { chainFrom: wrapChain, chainTo: Infinity, x0: 150, x1: 3690 },
  ];
  // breakpoints along chainage from main nodes
  const bps = Array.from(new Set(nodes.filter((n) => links[n.links[0]] && (links[n.links[0]].track === 'DN' || links[n.links[0]].track === 'UP')).map((n) => Math.round(n.chain)))).sort((a, b) => a - b);
  const rowMap = rowsDef.map((rd) => {
    const pts = bps.filter((c) => c >= rd.chainFrom - 0.5 && c <= rd.chainTo + 0.5);
    if (rd.chainFrom !== -Infinity && pts[0] !== Math.round(rd.chainFrom)) pts.unshift(Math.round(rd.chainFrom));
    if (rd.chainTo !== Infinity && pts[pts.length - 1] !== Math.round(rd.chainTo)) pts.push(Math.round(rd.chainTo));
    // two-level mapping: each station interval gets a width from its length
    // and the amount of trackwork in it; inside the interval breakpoints are
    // spread with a per-span pad so switches and signals stay readable.
    const stCh = chains.filter((c) => c > pts[0] && c < pts[pts.length - 1]);
    const bounds = [pts[0], ...stCh, pts[pts.length - 1]];
    const all = Array.from(new Set([...pts, ...stCh])).sort((a, b) => a - b);
    const swPts = nodes.filter((n) => n.kind === 'switch' && n.links.some((l) => links[l].track === 'DN' || links[l].track === 'UP')).map((n) => n.chain);
    const iw: number[] = [];
    for (let k = 0; k + 1 < bounds.length; k++) {
      const d = bounds[k + 1] - bounds[k];
      const nsw = swPts.filter((c) => c > bounds[k] && c < bounds[k + 1]).length;
      const end = k === 0 || k === bounds.length - 2;
      const atTerminal = end && (Math.abs(bounds[k] - westBuffer) < 2000 || Math.abs(bounds[k + 1] - lastCh) < 2000) && (k === 0 ? bounds[1] === chains[0] : bounds[k] === lastCh);
      iw.push((end && !atTerminal ? 0.5 : end ? 0.55 : 1) + 0.13 * Math.min(4, d / 1000) + 0.075 * nsw);
    }
    const tot = iw.reduce((a, b) => a + b, 0);
    const xs: number[] = [];
    let xAcc = rd.x0;
    for (let k = 0; k + 1 < bounds.length; k++) {
      const W = (iw[k] / tot) * (rd.x1 - rd.x0);
      const inside = all.filter((c) => c >= bounds[k] && c <= bounds[k + 1]);
      const sw = [0];
      for (let i = 1; i < inside.length; i++) {
        const len = inside[i] - inside[i - 1];
        sw.push(sw[i - 1] + 4 + Math.pow(len, 0.6));
      }
      const total = sw[sw.length - 1] || 1;
      for (let i = k === 0 ? 0 : 1; i < inside.length; i++) xs.push(xAcc + (sw[i] / total) * W);
      xAcc += W;
    }
    const pts2 = all;
    if (pts2.length !== xs.length) throw new Error(`x-map mismatch ${pts2.length} ${xs.length}`);
    return { pts: pts2, xs };
  });
  const chainRow = (ch: number) => (ch < wrapChain ? 0 : 1);
  const chainToX = (ch: number, row: number) => {
    const { pts, xs } = rowMap[row];
    if (ch <= pts[0]) return xs[0] - (pts[0] - ch) * 0.05;
    if (ch >= pts[pts.length - 1]) return xs[xs.length - 1] + (ch - pts[pts.length - 1]) * 0.05;
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (pts[m] <= ch) lo = m; else hi = m;
    }
    const t = (ch - pts[lo]) / (pts[hi] - pts[lo] || 1);
    return xs[lo] + t * (xs[hi] - xs[lo]);
  };

  const g = GEOM;
  const posFor = (ch: number, yRel: number): NodePos[] => {
    if (Math.abs(ch - wrapChain) < 0.6) {
      return [0, 1].map((r) => ({ row: r, x: chainToX(ch, r), y: g.rowTop[r] + yRel }));
    }
    const r = chainRow(ch);
    return [{ row: r, x: chainToX(ch, r), y: g.rowTop[r] + yRel }];
  };
  for (const t of ['DN', 'UP'] as const) {
    const y = t === 'UP' ? g.upY : g.dnY;
    for (const lid of mainLinks[t]) {
      for (const nid of [links[lid].a, links[lid].b]) if (nodes[nid].pos.length === 0) nodes[nid].pos = posFor(nodes[nid].chain, y);
    }
  }
  // crossover mids
  for (const l of links) {
    if (l.track !== 'X') continue;
    for (const nid of [l.a, l.b]) if (nodes[nid].pos.length === 0) nodes[nid].pos = posFor(nodes[nid].chain, g.midY);
  }
  // sidings and middle tracks on their lanes; connector midpoints halfway to the main
  const laneY = (lane: SidingLane | undefined): number => {
    const gap = g.dnY - g.upY;
    switch (lane) {
      case 'midUP': return g.upY + gap * 0.3;
      case 'midDN': return g.upY + gap * 0.7;
      case 'outUP': return g.upY - gap * 0.3;
      case 'outDN': return g.dnY + gap * 0.3;
      default: return g.midY;
    }
  };
  const placeLane = (lids: number[], y: number) => {
    for (const lid of lids) for (const nid of [links[lid].a, links[lid].b]) if (nodes[nid].pos.length === 0) nodes[nid].pos = posFor(nodes[nid].chain, y);
  };
  for (const sb of sidings) {
    const y = laneY(sb.def.lane);
    if (sb.k) placeLane(sb.k.links!, y);
    placeLane([sb.stub!], y);
    if (sb.y) placeLane([nodes[sb.y.node!].toe!], y);
  }
  for (const pb of pairs) {
    const yu = laneY('midUP');
    const yd = laneY('midDN');
    placeLane([pb.inner.U[1], pb.inner.U[2], pb.stubs[0].link], yu);
    placeLane([pb.inner.D[1], pb.inner.D[2], pb.stubs[1].link], yd);
    pb.farLinks.forEach((far, i) => {
      if (far) placeLane([...far.links!, ...pb.inner[i === 0 ? 'U' : 'D'].slice(3)], i === 0 ? yu : yd);
    });
  }
  for (const lb of loops) placeLane([...lb.ends, ...lb.middle], laneY(lb.def.platform ? 'midDN' : 'mid'));
  for (const n of nodes) {
    if (n.pos.length || n.links.length !== 2 || !n.links.every((lid) => links[lid].track === 'CON')) continue;
    const ends = n.links.map((lid) => nodes[links[lid].a === n.id ? links[lid].b : links[lid].a]);
    if (ends.some((m) => !m.pos.length)) continue;
    n.pos = posFor(n.chain, (ends[0].pos[0].y + ends[1].pos[0].y) / 2 - g.rowTop[ends[0].pos[0].row]);
  }
  // depot transfer tracks climb from the end of their lead over the UP main to the yard
  for (const ld of leads) {
    const k = leads.filter((x) => x.depot === ld.depot).indexOf(ld);
    const T = nodes[ld.throat].chain;
    const at = (d: number) => T + ld.s * (25 + 50 * k + d);
    nodes[links[ld.links[0]].b].pos = posFor(at(0), g.upY - 34);
    nodes[links[ld.links[1]].b].pos = posFor(at(12), g.depotQY - 30);
    nodes[ld.gate].pos = posFor(at(20), g.depotGateY);
  }
  for (const n of nodes) if (n.pos.length === 0) n.pos = posFor(n.chain, g.midY);

  // ------------------------------------------------------------------ stations
  const stations: TStation[] = STATIONS.map((s, i) => {
    const r = chainRow(chains[i]);
    // station-front turnback: an arriving train can cross, over this station's
    // own switches, onto the opposite platform (against its normal direction)
    const front = (t: 'DN' | 'UP'): boolean => {
      const n = normalDirOf(t);
      const from = chains[i] - n * 700;
      const start = mainLinks[t].find((lid) => Math.min(links[lid].chainA, links[lid].chainB) <= from && Math.max(links[lid].chainA, links[lid].chainB) > from);
      if (start === undefined) return false;
      const opp = platLinkOf(i, t === 'DN' ? 'UP' : 'DN');
      return reach(start, n, 1400, (l, d) => l === opp && d === n, (sw, pos) => pos === 'N' || switches[sw].station === i);
    };
    const frontDN = front('DN');
    const frontUP = front('UP');
    return {
      index: i, id: s.id, name: s.name, chain: chains[i], platforms: stationPlat[i],
      turnbackBerths: stationTurnback[i], storageBerths: stationStorage[i], frontTurnback: { DN: frontDN, UP: frontUP }, equipped: equipped[i],
      row: r, x: chainToX(chains[i], r),
    };
  });

  return {
    nodes, links, switches, sections, signals, platforms, berths, routes, depots, zones, stations,
    signalByEntry, wrapChain, rows: rowsDef, layout: GEOM, chainToX, chainRow,
  };
}

function dedupe(a: number[]): number[] {
  const out: number[] = [];
  for (const v of a) if (out[out.length - 1] !== v) out.push(v);
  return out;
}

// ---------------------------------------------------------------------------
// graph walking helpers
// ---------------------------------------------------------------------------

/**
 * Next link when leaving `link` in direction `dir`, following the current
 * switch positions. Returns null at a buffer / depot gate or when a trailing
 * switch is set against the movement or not detected.
 */
export function nextLink(
  topo: Topology, link: number, dir: Dir, swPos: (sw: number) => 'N' | 'R' | null,
): { link: number; dir: Dir; node: number } | null {
  const l = topo.links[link];
  const nid = dir === 1 ? l.b : l.a;
  const n = topo.nodes[nid];
  let nl: number | undefined;
  if (n.kind === 'end') return null;
  if (n.kind === 'joint') nl = n.links[0] === link ? n.links[1] : n.links[0];
  else {
    const p = swPos(n.sw!);
    if (p === null) return null;
    if (link === n.toe) nl = p === 'N' ? n.normal : n.reverse;
    else if (link === n.normal) nl = p === 'N' ? n.toe : undefined;
    else if (link === n.reverse) nl = p === 'R' ? n.toe : undefined;
  }
  if (nl === undefined) return null;
  const nlk = topo.links[nl];
  return { link: nl, dir: nlk.a === nid ? 1 : -1, node: nid };
}

/** Interpolated schematic position of an offset along a link. */
export function linkPoint(topo: Topology, link: number, offset: number): { row: number; x: number; y: number } {
  const l = topo.links[link];
  const [pa, pb] = linkEnds(topo, l);
  const t = Math.min(1, Math.max(0, offset / l.len));
  return { row: pa.row, x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t };
}

export function linkEnds(topo: Topology, l: TLink): [NodePos, NodePos] {
  const A = topo.nodes[l.a].pos;
  const B = topo.nodes[l.b].pos;
  for (const a of A) for (const b of B) if (a.row === b.row) return [a, b];
  return [A[0], B[0]];
}

/** chainage of a point on a link */
export function linkChain(topo: Topology, link: number, offset: number): number {
  const l = topo.links[link];
  return l.chainA + (l.chainB - l.chainA) * Math.min(1, Math.max(0, offset / l.len));
}



/** Stations in running order, optionally starting at an included station. */
export function orderedStations(direction: 'DN' | 'UP', from?: number): number[] {
  return STATIONS.map((_, station) => station)
    .filter(station => from === undefined || station === from || ahead(direction, from, station))
    .sort((a, b) => ahead(direction, a, b) ? -1 : ahead(direction, b, a) ? 1 : 0);
}

/** Last station reached in a direction on the current linear topology. */
export function downstreamTerminal(direction: 'DN' | 'UP'): number {
  return orderedStations(direction).at(-1)!;
}

/** Inclusive forward station range; a reversed range contains no stations. */
export function stationRange(direction: 'DN' | 'UP', from: number, to: number): number[] {
  if (from !== to && !ahead(direction, from, to)) return [];
  return orderedStations(direction, from).filter(station => station === to || ahead(direction, station, to));
}

/** Geographic running direction of a physical train, including depot/siding links. */
export function travelDirection(topo: Topology, train: { link: number; dir: Dir }): 'DN' | 'UP' {
  const link = topo.links[train.link];
  return (train.dir === 1 ? link.chainB >= link.chainA : link.chainA > link.chainB) ? 'DN' : 'UP';
}
