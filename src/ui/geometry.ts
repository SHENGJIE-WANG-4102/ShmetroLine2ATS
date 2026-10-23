/**
 * Schematic geometry: maps the track graph (chainage based) onto a drawing
 * of one or more rows. Used for the line overview (whole line, wrapped over
 * N rows) and the station / interlocking view (a window around one
 * station, one row, more space for trackwork).
 *
 * x positions use a two-level mapping: every station interval gets a share
 * of the row width from its length and the amount of trackwork in it, and
 * inside an interval the node breakpoints are spread with a per-span pad so
 * switches and signals stay readable.
 */
import type { Topology, TLink } from '../sim/topology';
import type { TrainSnap } from '../sim/model';
import { LINE_INFO } from '../data/current';

/** Schematic units before camera zoom; shared by platforms and train symbols. */
export const PLATFORM_WIDTH = 72;

export interface P { row: number; x: number; y: number }

export interface GeomParams {
  chainFrom: number;
  chainTo: number;
  rows: number;
  width: number;
  marginL: number;
  marginR: number;
  rowH: number;
  top: number;
  /** y of the up / middle / down track relative to the row top */
  upY: number;
  midY: number;
  dnY: number;
  /** depot structure offsets above the up track: switches, junction, transfer, gate */
  depotDy: { q: number; z: number; j1: number; j2: number; gate: number };
  detail: boolean;
  /** main-line nodes this far outside the window are still placed (continuous track at the view edges) */
  nodeMargin?: number;
  /** screen px kept free below the last row when zoomed out (labels are not scaled with the geometry) */
  padBottom?: number;
  /** same above the first row (train windows stacked above the up track) */
  padTop?: number;
}

export interface RowDef { from: number; to: number; x0: number; x1: number; top: number }

const isMain = (l: TLink) => l.track === 'DN' || l.track === 'UP';

export class Geometry {
  readonly p: GeomParams;
  readonly topo: Topology;
  rows: RowDef[] = [];
  private maps: { pts: number[]; xs: number[] }[] = [];
  /** node position (first row the node appears in) or null when outside the window */
  pos: (P | null)[] = [];
  linkVisible: boolean[] = [];
  /** world size */
  width: number;
  height: number;

  constructor(topo: Topology, p: GeomParams) {
    this.topo = topo;
    this.p = p;
    this.width = p.width;
    this.height = p.top + p.rows * p.rowH;
    this.buildX();
    this.reserveTrainSpace();
    this.placeNodes();
  }

  // ---------------------------------------------------------------- x mapping

  private buildX() {
    const { topo, p } = this;
    const chains = topo.stations.map((s) => s.chain);
    const mainNodes = topo.nodes.filter((n) => n.links.some((l) => isMain(topo.links[l])));
    const swCh = topo.nodes.filter((n) => n.kind === 'switch' && n.links.some((l) => isMain(topo.links[l]))).map((n) => n.chain);
    const inWin = (c: number) => c >= p.chainFrom - 0.5 && c <= p.chainTo + 0.5;
    const stIn = chains.filter((c) => c > p.chainFrom + 1 && c < p.chainTo - 1);
    const bounds = [p.chainFrom, ...stIn, p.chainTo];
    // interval weights
    const weights: number[] = [];
    for (let k = 0; k + 1 < bounds.length; k++) {
      const a = bounds[k];
      const b = bounds[k + 1];
      const d = b - a;
      const nsw = swCh.filter((c) => c > a && c < b).length;
      const isStationInterval = chains.includes(a) && chains.includes(b);
      if (p.detail) weights.push(0.6 + Math.pow(d / 1000, 0.5) * 0.5 + 0.12 * nsw);
      else weights.push((isStationInterval ? 1 : 0.42) + 0.13 * Math.min(4, d / 1000) + 0.075 * nsw);
    }
    // rows: split the cumulative weight; wraps at the middle of a station interval clear of switches
    const total = weights.reduce((a, b) => a + b, 0);
    const wraps: number[] = [];
    let acc = 0;
    let r = 1;
    for (let k = 0; k < weights.length && r < p.rows; k++) {
      const target = (total * r) / p.rows;
      if (acc + weights[k] >= target) {
        const a = bounds[k];
        const b = bounds[k + 1];
        // largest switch-free gap inside the interval, preferring the middle
        const pts = [a + 150, ...swCh.filter((c) => c > a + 150 && c < b - 150), b - 150].sort((x, y) => x - y);
        let best = (a + b) / 2;
        let bestGap = -1;
        for (let i = 0; i + 1 < pts.length; i++) {
          const gap = pts[i + 1] - pts[i];
          const mid = (pts[i] + pts[i + 1]) / 2;
          const score = gap - Math.abs(mid - (a + b) / 2) * 0.3;
          if (score > bestGap) { bestGap = score; best = mid; }
        }
        wraps.push(Math.round(best));
        r++;
      }
      acc += weights[k];
    }
    const rowBounds = [p.chainFrom, ...wraps, p.chainTo];
    const bps = Array.from(new Set(mainNodes.map((n) => Math.round(n.chain * 10) / 10).filter(inWin))).sort((a, b) => a - b);
    const weightOf = (a: number, b: number) => {
      // weight of a sub-interval [a,b] of the station interval containing it
      let w = 0;
      for (let k = 0; k + 1 < bounds.length; k++) {
        const lo = Math.max(a, bounds[k]);
        const hi = Math.min(b, bounds[k + 1]);
        if (hi > lo) w += weights[k] * ((hi - lo) / (bounds[k + 1] - bounds[k]));
      }
      return w;
    };
    for (let ri = 0; ri < rowBounds.length - 1; ri++) {
      const from = rowBounds[ri];
      const to = rowBounds[ri + 1];
      const x0 = p.marginL;
      const x1 = p.width - p.marginR;
      const top = p.top + ri * p.rowH;
      this.rows.push({ from, to, x0, x1, top });
      // sub-intervals of this row (station bounds inside)
      const sb = [from, ...bounds.filter((c) => c > from + 0.5 && c < to - 0.5), to];
      const rowW = weightOf(from, to);
      const pts: number[] = [];
      const xs: number[] = [];
      let xAcc = x0;
      for (let k = 0; k + 1 < sb.length; k++) {
        const a = sb[k];
        const b = sb[k + 1];
        const W = (weightOf(a, b) / rowW) * (x1 - x0);
        const inside = Array.from(new Set([a, ...bps.filter((c) => c > a + 0.05 && c < b - 0.05), b]));
        const sw = [0];
        for (let i = 1; i < inside.length; i++) {
          const len = inside[i] - inside[i - 1];
          sw.push(sw[i - 1] + (p.detail ? 14 + Math.pow(len, 0.72) : 4 + Math.pow(len, 0.6)));
        }
        const tot = sw[sw.length - 1] || 1;
        for (let i = k === 0 ? 0 : 1; i < inside.length; i++) {
          pts.push(inside[i]);
          xs.push(xAcc + (sw[i] / tot) * W);
        }
        xAcc += W;
      }
      this.maps.push({ pts, xs });
    }
  }

  chainRow(ch: number): number {
    for (let r = 0; r < this.rows.length; r++) if (ch < this.rows[r].to || r === this.rows.length - 1) return r;
    return this.rows.length - 1;
  }

  chainX(ch: number, row: number): number {
    const { pts, xs } = this.maps[row];
    const n = pts.length - 1;
    if (ch <= pts[0]) return xs[0] - (pts[0] - ch) * (n > 0 ? Math.min(0.6, (xs[1] - xs[0]) / (pts[1] - pts[0] || 1)) : 0.05);
    if (ch >= pts[n]) return xs[n] + (ch - pts[n]) * (n > 0 ? Math.min(0.6, (xs[n] - xs[n - 1]) / (pts[n] - pts[n - 1] || 1)) : 0.05);
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (pts[m] <= ch) lo = m; else hi = m;
    }
    const t = (ch - pts[lo]) / (pts[hi] - pts[lo] || 1);
    return xs[lo] + t * (xs[hi] - xs[lo]);
  }

  // ---------------------------------------------------------------- nodes

  private placeNodes() {
    const { topo, p } = this;
    const pos: (P | null)[] = topo.nodes.map(() => null);
    const m = p.nodeMargin ?? 1;
    const inWin = (c: number) => c >= p.chainFrom - m && c <= p.chainTo + m;
    const at = (ch: number, dy: number): P => {
      const row = this.chainRow(ch);
      return { row, x: this.chainX(ch, row), y: this.rows[row].top + dy };
    };
    // main tracks
    for (const n of topo.nodes) {
      if (!inWin(n.chain)) continue;
      const main = n.links.map((l) => topo.links[l]).find(isMain);
      if (main) pos[n.id] = at(n.chain, main.track === 'UP' ? p.upY : p.dnY);
    }
    // sidings, on the lane the topology gave them (fraction of the UP→DN gap)
    for (const n of topo.nodes) {
      if (pos[n.id] || !inWin(n.chain)) continue;
      if (!n.links.some((l) => topo.links[l].track === 'SID')) continue;
      const d = n.pos[0];
      const f = d ? (d.y - topo.layout.rowTop[d.row] - topo.layout.upY) / (topo.layout.dnY - topo.layout.upY) : 0.5;
      pos[n.id] = at(n.chain, p.upY + f * (p.dnY - p.upY));
    }
    // depot transfer tracks: from the end of each lead (on its lane) up over
    // the UP main to the yard gate, leads of one depot side by side
    for (const d of topo.depots) {
      d.transferPaths.forEach((path, k) => {
        const T = topo.nodes[path.throat];
        if (!inWin(T.chain)) return;
        const row = this.chainRow(T.chain);
        const top = this.rows[row].top;
        const s = Math.sign(topo.nodes[path.gate].chain - T.chain) || 1;
        const x = this.chainX(T.chain, row) + s * (10 + 18 * k);
        pos[path.gate] = { row, x, y: top + p.upY - p.depotDy.gate };
        pos[topo.links[path.links[2]].a] = { row, x, y: top + p.upY - p.depotDy.j2 };
        pos[topo.links[path.links[1]].a] = { row, x, y: top + p.upY - p.depotDy.j1 };
      });
    }
    // the rest (diagonal halves: crossovers, connectors, depot legs) sit between their neighbours
    for (let pass = 0; pass < 4; pass++) {
      for (const n of topo.nodes) {
        if (pos[n.id] || !inWin(n.chain)) continue;
        const nb = n.links.map((l) => { const lk = topo.links[l]; return pos[lk.a === n.id ? lk.b : lk.a]; }).filter((x): x is P => !!x);
        if (nb.length >= 2) pos[n.id] = { row: nb[0].row, x: (nb[0].x + nb[1].x) / 2, y: (nb[0].y + nb[1].y) / 2 };
      }
    }
    this.pos = pos;
    this.linkVisible = topo.links.map((l) => !!pos[l.a] && !!pos[l.b]);
  }

  // ---------------------------------------------------------------- links

  /** drawing segments of a link (main links may wrap across rows) */
  linkSegs(lid: number): { row: number; x1: number; y1: number; x2: number; y2: number }[] {
    const { topo } = this;
    const l = topo.links[lid];
    const a = this.pos[l.a];
    const b = this.pos[l.b];
    if (!a || !b) return [];
    if (a.row === b.row) return [{ row: a.row, x1: a.x, y1: a.y, x2: b.x, y2: b.y }];
    // wraps (main links only): split at each row boundary
    const out: { row: number; x1: number; y1: number; x2: number; y2: number }[] = [];
    const y = a.y - this.rows[a.row].top;
    let c0 = Math.min(l.chainA, l.chainB);
    const c1 = Math.max(l.chainA, l.chainB);
    for (let r = this.chainRow(c0); r <= this.chainRow(c1); r++) {
      const rd = this.rows[r];
      const s = Math.max(c0, rd.from);
      const e = Math.min(c1, rd.to);
      out.push({ row: r, x1: this.chainX(s, r), y1: rd.top + y, x2: this.chainX(e, r), y2: rd.top + y });
      c0 = e;
    }
    return out;
  }

  /** point at an offset along a link */
  linkPoint(lid: number, off: number): P | null {
    const { topo } = this;
    const l = topo.links[lid];
    const a = this.pos[l.a];
    const b = this.pos[l.b];
    if (!a || !b) return null;
    const t = Math.min(1, Math.max(0, off / l.len));
    if (a.row === b.row) {
      let x = a.x + (b.x - a.x) * t;
      const platform = topo.platforms[l.platform];
      if (platform) {
        // Both train ends and track objects share the platform's fixed-width map.
        const centre = this.chainX(topo.stations[platform.station].chain, a.row);
        const sign = Math.sign(b.x - a.x);
        const from = (l.len - LINE_INFO.platformLength) / 2;
        const to = (l.len + LINE_INFO.platformLength) / 2;
        const left = centre - sign * this.platformWidth() / 2;
        const right = centre + sign * this.platformWidth() / 2;
        const offset = t * l.len;
        if (offset < from) x = a.x + (left - a.x) * offset / from;
        else if (offset <= to) x = left + (right - left) * (offset - from) / LINE_INFO.platformLength;
        else x = right + (b.x - right) * (offset - to) / (l.len - to);
      }
      return { row: a.row, x, y: a.y + (b.y - a.y) * t };
    }
    const ch = l.chainA + (l.chainB - l.chainA) * t;
    const row = this.chainRow(ch);
    return { row, x: this.chainX(ch, row), y: this.rows[row].top + (a.y - this.rows[a.row].top) };
  }

  /** link drawing segments covering [from,to] offsets (train bodies) */
  linkSpan(lid: number, from: number, to: number): { x1: number; y1: number; x2: number; y2: number }[] {
    const { topo } = this;
    const l = topo.links[lid];
    const a = this.pos[l.a];
    const b = this.pos[l.b];
    if (!a || !b) return [];
    if (a.row === b.row) {
      const p1 = this.linkPoint(lid, from)!;
      const p2 = this.linkPoint(lid, to)!;
      return [{ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }];
    }
    const out: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const chAt = (o: number) => l.chainA + (l.chainB - l.chainA) * Math.min(1, Math.max(0, o / l.len));
    const ca = Math.min(chAt(from), chAt(to));
    const cb = Math.max(chAt(from), chAt(to));
    const yRel = a.y - this.rows[a.row].top;
    let c0 = ca;
    for (let r = this.chainRow(ca); r <= this.chainRow(cb); r++) {
      const rd = this.rows[r];
      const e = Math.min(cb, rd.to);
      out.push({ x1: this.chainX(c0, r), y1: rd.top + yRel, x2: this.chainX(e, r), y2: rd.top + yRel });
      c0 = e;
    }
    return out;
  }

  platformWidth(): number { return PLATFORM_WIDTH; }
  /** One symbol length throughout this drawing, including intervals and depot leads. */
  platformTrainLength(): number { return this.platformWidth() * LINE_INFO.trainLength / LINE_INFO.platformLength; }

  trainHeadPoint(tr:Pick<TrainSnap,'link'|'off'|'dir'>):P|null {
    return this.linkPoint(tr.link, tr.off);
  }

  /** Stretch the schematic mapping, never the physical topology. Every span
   * containing a full train gets enough drawing room, including depot leads. */
  private reserveTrainSpace() {
    const spans = this.topo.stations.flatMap(s=>[
      {a:s.chain-LINE_INFO.platformLength/2,b:s.chain,w:this.platformWidth()/2+4},
      {a:s.chain,b:s.chain+LINE_INFO.platformLength/2,w:this.platformWidth()/2+4},
    ]);
    for (const berth of this.topo.berths) {
      if (berth.kind === 'depot') continue;
      const l=this.topo.links[berth.link];
      spans.push({a:Math.min(l.chainA,l.chainB),b:Math.max(l.chainA,l.chainB),w:this.platformTrainLength()*l.len/LINE_INFO.trainLength+8});
    }
    for (let row=0;row<this.maps.length;row++) {
      const map=this.maps[row], rd=this.rows[row];
      const relevant=spans.filter(s=>s.b>s.a && s.a>=rd.from && s.b<=rd.to);
      const points=[...new Set([...map.pts,...relevant.flatMap(s=>[s.a,s.b])])].sort((a,b)=>a-b);
      const xs=points.map(c=>this.chainX(c,row));
      map.pts=points;map.xs=xs;
      for (const span of relevant.sort((a,b)=>(a.b-a.a)-(b.b-b.a))) {
        const a=points.indexOf(span.a),b=points.indexOf(span.b),extra=span.w-(xs[b]-xs[a]);
        if(extra<=0)continue;
        for(let i=a+1;i<xs.length;i++) xs[i]+=extra*Math.min(1,(points[i]-span.a)/(span.b-span.a));
      }
      rd.x1=xs.at(-1)!;
      this.width=Math.max(this.width,rd.x1+this.p.marginR);
    }
  }

  /** Fixed-length train symbol. Track occupation comes from the simulation,
   * never from the links this enlarged or shortened symbol happens to cover. */
  trainBody(tr: Pick<TrainSnap, 'link' | 'off' | 'dir' | 'body'>, swPos: (sw: number) => 'N' | 'R' = () => 'N') {
    const out: { x1: number; y1: number; x2: number; y2: number; section: number }[] = [];
    let link = tr.link, off = tr.off, dir = tr.dir, remaining = this.platformTrainLength();
    const visited = new Set<number>();
    for (let i = 0; i < 100 && remaining > .001; i++) {
      if (visited.has(link)) break;
      visited.add(link);
      const l = this.topo.links[link], end = dir === 1 ? 0 : l.len;
      const segments = this.directedLinkSpan(link, Math.min(off, end), Math.max(off, end), dir);
      for (const s of segments) {
        const distance = Math.hypot(s.x2-s.x1,s.y2-s.y1);
        if (distance < .001) continue;
        const f = Math.min(1, remaining / distance);
        out.push({x1:s.x1,y1:s.y1,x2:s.x1+(s.x2-s.x1)*f,y2:s.y1+(s.y2-s.y1)*f,section:l.section});
        remaining -= distance * f;
        if (remaining < .001) break;
      }
      const node = dir === 1 ? l.a : l.b;
      const bodyNext = tr.body[(i+1)*3];
      const n = this.topo.nodes[node];
      const next = bodyNext !== undefined && n.links.includes(bodyNext) ? bodyNext
        : n.kind === 'end' ? undefined
          : n.kind === 'joint' ? n.links.find(id => id !== link)
            : link !== n.toe ? n.toe : swPos(n.sw!) === 'R' ? n.reverse : n.normal;
      if (next === undefined) break;
      link = next;
      dir = this.topo.links[link].b === node ? 1 : -1;
      off = dir === 1 ? this.topo.links[link].len : 0;
    }
    // A diagram/window boundary must not shorten the symbol either. Continue
    // its tail in the last drawing direction; this never adds track occupation.
    if (remaining > .001 && out.length) {
      const tail = out[out.length - 1];
      const distance = Math.hypot(tail.x2 - tail.x1, tail.y2 - tail.y1);
      tail.x2 += (tail.x2 - tail.x1) / distance * remaining;
      tail.y2 += (tail.y2 - tail.y1) / distance * remaining;
    }
    return out;
  }

  private directedLinkSpan(link:number,from:number,to:number,dir:1|-1) {
    const segments=this.linkSpan(link,from,to);
    return dir===1?segments.reverse().map(s=>({x1:s.x2,y1:s.y2,x2:s.x1,y2:s.y1})):segments;
  }

  /** Actual occupied track, independent of the fixed-length train symbol. */
  trainOccupiedPath(tr:Pick<TrainSnap,'dir'|'body'>) {
    const out:{x1:number;y1:number;x2:number;y2:number;section:number;link:number}[]=[];
    let dir=tr.dir,tailNode=-1;
    for(let i=0;i+2<tr.body.length;i+=3) {
      const link=tr.body[i],from=tr.body[i+1],to=tr.body[i+2],l=this.topo.links[link];
      if(i)dir=l.b===tailNode?1:-1;
      if(to>from)for(const segment of this.directedLinkSpan(link,from,to,dir))out.push({...segment,link,section:l.section});
      tailNode=dir===1?l.a:l.b;
    }
    return out;
  }

  /** world x/y of a station centre on the down track */
  stationX(st: number): { row: number; x: number } {
    const ch = this.topo.stations[st].chain;
    const row = this.chainRow(ch);
    return { row, x: this.chainX(ch, row) };
  }
}

/** chain window (with margin) covering a station and all its trackwork */
export function stationWindow(topo: Topology, st: number): [number, number] {
  const s = topo.stations[st];
  let lo = s.chain - 420;
  let hi = s.chain + 420;
  for (const sw of topo.switches) {
    if (sw.station !== st) continue;
    for (const n of sw.nodes) {
      lo = Math.min(lo, topo.nodes[n].chain - 160);
      hi = Math.max(hi, topo.nodes[n].chain + 160);
    }
  }
  for (const n of topo.nodes) {
    if (n.kind !== 'end') continue;
    if (Math.abs(n.chain - s.chain) < 1500) { lo = Math.min(lo, n.chain - 60); hi = Math.max(hi, n.chain + 60); }
  }
  for (const d of topo.depots) if (d.station === st) for (const path of d.transferPaths) {
    const c = topo.nodes[path.throat].chain;
    lo = Math.min(lo, c - 120); hi = Math.max(hi, c + 120);
  }
  return [lo, hi];
}

/** whole-line chain window */
export function lineWindow(topo: Topology): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of topo.nodes) { lo = Math.min(lo, n.chain); hi = Math.max(hi, n.chain); }
  return [lo - 20, hi + 20];
}
