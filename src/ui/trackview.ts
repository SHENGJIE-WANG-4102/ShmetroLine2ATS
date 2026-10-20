/**
 * Track schematic renderer (PixiJS) used for both the line overview
 * (总览图) and the station / interlocking view (车站图).
 *
 * Geometry lives in a camera-transformed world container (pan + zoom);
 * labels live in an unscaled layer at constant screen size and are placed
 * through a collision index every update, so they never overlap at any
 * zoom, UI scale or time of day. Level of detail: device IDs, km posts and
 * section IDs only appear when zoomed in, on toggle, or in the station view.
 */
import { Container, Graphics, Text, type FederatedPointerEvent } from 'pixi.js';
import type { Topology } from '../sim/topology';
import type { Snapshot, TrainSnap } from '../sim/model';
import { SEC, SW, PLT, SIG_ASPECT } from '../sim/model';
import { STATIONS, LINE_INFO } from '../data/line2';
import type { Store, Selection } from './store';
import { C, FONT_CN, FONT_MONO, delayColor, loadColor } from './theme';
import { Geometry, type P } from './geometry';
import { placeTrainWindows, trainWindowWidth, LabelIndex, textWidth, lateText, type Rect } from './labels';

const LINE_COLORS: Record<string, number> = {
  '1': 0xe3002b, '2': 0x8cc220, '3': 0xfcd600, '4': 0x461d84, '6': 0xd40068, '7': 0xed6f00, '8': 0x0094d8,
  '9': 0x87caed, '10': 0xc6afd4, '11': 0x871c2b, '12': 0x007a61, '13': 0xe999c0, '14': 0x626020, '15': 0xbca886,
  '16': 0x98d1c0, '17': 0xbc796f, '18': 0xc4984f, '磁浮': 0x009090, '机场联络线': 0x00618b, '国铁': 0x5a6b7a,
};
const LONG_NAMES: Record<string, [string, string]> = {
  '蟠祥路·国家会计学院': ['蟠祥路·', '国家会计学院'],
  '浦东1号2号航站楼': ['浦东1号2号', '航站楼'],
  '虹桥2号航站楼': ['虹桥2号', '航站楼'],
  '国家会展中心': ['国家会展', '中心'],
  '上海科技馆': ['上海', '科技馆'],
};

interface SegHit { x1: number; y1: number; x2: number; y2: number }
class SegmentsHitArea {
  constructor(public segs: SegHit[], public r: number) {}
  contains(x: number, y: number): boolean {
    for (const s of this.segs) {
      const dx = s.x2 - s.x1;
      const dy = s.y2 - s.y1;
      const l2 = dx * dx + dy * dy || 1;
      let t = ((x - s.x1) * dx + (y - s.y1) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      const px = s.x1 + t * dx - x;
      const py = s.y1 + t * dy - y;
      if (px * px + py * py <= this.r * this.r) return true;
    }
    return false;
  }
}

/** width of the direction arrow beside a train window */
const ARROW = 12;

export interface ViewHandlers {
  device(sel: Selection): void;
  station(st: number): void;
  depot(d: number): void;
  background(): void;
  hover(sel: Selection): void;
}

export interface Layers { sig: boolean; sec: boolean; km: boolean; pax: boolean }

/** a label with fixed screen size anchored to a world point */
interface StaticLabel {
  t: Text;
  kind: 'station' | 'chip' | 'km' | 'sig' | 'sec' | 'sw' | 'depot' | 'zone' | 'dir' | 'former' | 'cont';
  prio: number;
  /** world anchor */
  wx: number;
  wy: number;
  /** candidate offsets (screen px) of the label's top-left relative to the anchor */
  cands: { dx: number; dy: number; alt?: string }[];
  w: number;
  h: number;
  minZoom: number;
  layer?: keyof Layers;
  rect?: Rect;
  chip?: Graphics;
}

interface TrainGfx {
  body: Graphics;
  box: Container;
  bg: Graphics;
  label: Text;
  chips: Text;
  bodyKey: string;
  styleKey: string;
  text: string;
  chipText: string;
}

interface SignalGfx { g: Graphics; ring: Graphics; cross: Graphics; lamp: Graphics; lamp2: Graphics; x: number; y: number; dirX: number }

export interface ViewOpts {
  mode: 'overview' | 'detail';
  /** station of a detail view */
  station?: number;
  /** text size factor of the dynamic/static labels (1 = design sizes) */
}

export class TrackView {
  root = new Container();
  readonly mode: 'overview' | 'detail';
  geom: Geometry;
  private topo: Topology;
  private store: Store;
  private h: ViewHandlers;
  private world = new Container();
  private labelLayer = new Container();
  private leaderG = new Graphics();
  private maskG = new Graphics();
  // world layers
  private bgL = new Container();
  private platL = new Container();
  private trackL = new Container();
  private occupiedG = new Graphics();
  private occupiedKey = '';
  private ovL = new Container();
  private swL = new Container();
  private sigL = new Container();
  private yardL = new Container();
  private bodyL = new Container();
  private selL = new Graphics();
  private preview = new Graphics();
  private pending = new Graphics();
  // objects
  private sectionG: Graphics[] = [];
  private sectionMain: boolean[] = [];
  private tsrG: Graphics[] = [];
  private envG: Graphics[] = [];
  private blkG: Graphics[] = [];
  private swGfx: { sw: number; node: number; n: Graphics; r: Graphics; x: Graphics; lk: Graphics; p: P }[] = [];
  private sigGfx: (SignalGfx | null)[] = [];
  private platGfx: ({ rect: Graphics; bar: Graphics; x: number; y: number; w: number; h: number; up: boolean } | null)[] = [];
  private yardGfx: { depot: number; box: Graphics; veh: Graphics; x: number; y: number; w: number; h: number; key: string }[] = [];
  private trains = new Map<number, TrainGfx>();
  private statics: StaticLabel[] = [];
  private dynTexts: Text[] = [];
  private dynUsed = 0;
  private groupBoxes: { box: Container; bg: Graphics; label: Text; ids: number[] }[] = [];
  private index = new LabelIndex(128);
  private staticRects: { r: Rect; tag: string }[] = [];
  private obstacles: Rect[] = [];
  private lastSnap: Snapshot | null = null;
  private lastKey = '';
  private blink = false;
  // camera
  z = 0;
  panX = 0;
  panY = 0;
  vw: number;
  vh: number;
  minZoom = 1;
  maxZoom = 4;
  layers: Layers = { sig: false, sec: false, km: false, pax: true };
  follow = -1;
  private staticZoom = -1;
  private texts: Text[] = [];
  /** route-setting state (detail view): highlighted start signal */
  pendingStart = -1;
  /** rows layout (relative y) */
  readonly L: { upY: number; midY: number; dnY: number; lane: number; laneGap: number; lanes: number; nameY: number; rowH: number };

  constructor(topo: Topology, store: Store, geom: Geometry, h: ViewHandlers, opts: ViewOpts, vw: number, vh: number) {
    this.topo = topo;
    this.store = store;
    this.geom = geom;
    this.h = h;
    this.mode = opts.mode;
    this.vw = vw;
    this.vh = vh;
    const p = geom.p;
    this.L = {
      upY: p.upY, midY: p.midY, dnY: p.dnY, lane: 40, laneGap: 4, lanes: this.mode === 'detail' ? 3 : 3,
      nameY: this.mode === 'detail' ? p.dnY + 230 : p.dnY + 150, rowH: p.rowH,
    };
    this.world.addChild(this.bgL, this.platL, this.trackL, this.occupiedG, this.ovL, this.swL, this.sigL, this.yardL, this.bodyL, this.selL, this.preview, this.pending);
    this.labelLayer.addChild(this.leaderG);
    this.root.addChild(this.world, this.labelLayer, this.maskG);
    this.root.mask = this.maskG;
    this.build();
    this.setViewport(vw, vh);
  }

  destroy() {
    this.root.destroy({ children: true });
  }

  allTexts(): Text[] {
    const out = [...this.texts, ...this.dynTexts];
    for (const tg of this.trains.values()) out.push(tg.label, tg.chips);
    return out;
  }

  private mkText(s: string, size: number, color: number, opts: { mono?: boolean; bold?: boolean } = {}): Text {
    const t = new Text({ text: s, style: { fontFamily: opts.mono ? FONT_MONO : FONT_CN, fontSize: size, fill: color, fontWeight: opts.bold ? '700' : '400' } });
    this.texts.push(t);
    return t;
  }

  // ---------------------------------------------------------------- camera

  setViewport(w: number, h: number) {
    this.vw = w;
    this.vh = h;
    this.maskG.clear().rect(0, 0, w, h).fill({ color: 0xffffff });
    // zoom out at most to "whole layout visible" (never below 25 %); labels stay full size
    const atMin = this.z <= this.minZoom + 1e-6;
    const pad = (this.geom.p.padBottom ?? 0) + (this.geom.p.padTop ?? 0);
    this.minZoom = Math.max(0.25, Math.min(1, w / this.geom.width, (h - pad) / this.geom.height));
    if (atMin || this.z < this.minZoom) this.z = this.minZoom;
    this.clampPan();
    this.applyCamera();
  }

  private clampPan() {
    // zoomed out, labels keep their size and need screen room around the drawing
    const pt = this.z < 1 ? this.geom.p.padTop ?? 0 : 0;
    const pb = this.z < 1 ? this.geom.p.padBottom ?? 0 : 0;
    const cw = this.geom.width * this.z;
    const ch = this.geom.height * this.z + pt + pb;
    this.panX = cw < this.vw ? -(this.vw - cw) / 2 : Math.max(0, Math.min(cw - this.vw, this.panX));
    this.panY = ch < this.vh ? -(this.vh - ch) / 2 - pt : Math.max(-pt, Math.min(ch - pt - this.vh, this.panY));
  }

  private applyCamera() {
    this.world.scale.set(this.z);
    this.world.position.set(-this.panX, -this.panY);
    this.labelLayer.position.set(-this.panX, -this.panY);
    if (Math.abs(this.staticZoom - this.z) > 1e-6) this.placeStatics();
    this.lastKey = '';
  }

  zoomAt(factor: number, sx: number, sy: number) {
    const nz = Math.max(this.minZoom, Math.min(this.maxZoom, this.z * factor));
    if (nz === this.z) return;
    const wx = (sx + this.panX) / this.z;
    const wy = (sy + this.panY) / this.z;
    this.z = nz;
    this.panX = wx * nz - sx;
    this.panY = wy * nz - sy;
    this.clampPan();
    this.applyCamera();
  }

  panBy(dx: number, dy: number) {
    this.panX -= dx;
    this.panY -= dy;
    this.clampPan();
    this.applyCamera();
  }

  resetView() {
    this.z = this.minZoom;
    this.panX = 0;
    this.panY = 0;
    this.follow = -1;
    this.clampPan();
    this.applyCamera();
  }

  /** centre the camera on a world point (optionally at a zoom) */
  centerOn(wx: number, wy: number, z?: number, smooth = 0) {
    if (z !== undefined) this.z = Math.max(this.minZoom, Math.min(this.maxZoom, z));
    const tx = wx * this.z - this.vw / 2;
    const ty = wy * this.z - this.vh / 2;
    this.panX = smooth > 0 ? this.panX + (tx - this.panX) * smooth : tx;
    this.panY = smooth > 0 ? this.panY + (ty - this.panY) * smooth : ty;
    this.clampPan();
    this.applyCamera();
  }

  /** world point of a train head (for following / locating) */
  trainPoint(tr: TrainSnap): P | null {
    return this.geom.trainHeadPoint(tr);
  }

  // ---------------------------------------------------------------- build

  private sel(sel: Selection) {
    return (e: FederatedPointerEvent) => {
      e.stopPropagation();
      if (this.dragMoved) return;
      this.h.device(sel);
    };
  }
  private hov(sel: Selection) {
    return () => this.h.hover(sel);
  }
  dragMoved = false;

  private build() {
    const { topo, geom } = this;
    const detail = this.mode === 'detail';
    const L = this.L;

    // background (click clears selection)
    const bg = new Graphics().rect(0, 0, geom.width, geom.height).fill({ color: C.bg, alpha: 0.001 });
    bg.eventMode = 'static';
    bg.on('pointertap', () => { if (!this.dragMoved) this.h.background(); });
    this.bgL.addChild(bg);

    // rows: frames, zone boundaries, direction & continuation labels
    geom.rows.forEach((rd, r) => {
      const frame = new Graphics().roundRect(8, rd.top + 2, geom.width - 16, L.rowH - 8, 6).stroke({ width: 1, color: C.frame });
      this.bgL.addChild(frame);
      const lab = (s: string, x: number, y: number, kind: StaticLabel['kind'], color = C.textMuted) => {
        const t = this.mkText(s, 20, color);
        this.addStatic({ t, kind, prio: 50, wx: x, wy: y, cands: [{ dx: 0, dy: -12 }], w: textWidth(s, 20), h: 24, minZoom: 0 });
      };
      if (!detail) {
        lab('◀ 上行', 14, rd.top + L.upY, 'dir');
        lab('下行 ▶', 14, rd.top + L.dnY, 'dir');
        if (r < geom.rows.length - 1) lab(`接第${r + 2}行`, rd.x1 + 12, rd.top + L.midY, 'cont', C.line);
        if (r > 0) lab(`接第${r}行`, 14, rd.top + L.midY, 'cont', C.line);
      } else {
        lab('◀ 上行', 14, rd.top + L.upY, 'dir');
        lab('下行 ▶', 14, rd.top + L.dnY, 'dir');
      }
    });
    for (const z of topo.zones) {
      for (let r = 0; r < geom.rows.length; r++) {
        const rd = geom.rows[r];
        const from = Math.max(z.chainFrom, rd.from);
        const to = Math.min(z.chainTo, rd.to);
        if (from >= to) continue;
        const x0 = geom.chainX(from, r);
        if (from > rd.from + 1) {
          const d = new Graphics();
          for (let y = rd.top + 8; y < rd.top + L.rowH - 12; y += 16) d.moveTo(x0, y).lineTo(x0, y + 8);
          d.stroke({ width: 1.5, color: 0x2a3b4d });
          this.bgL.addChild(d);
        }
        const t = this.mkText(z.key, 20, C.textMuted, { mono: true });
        this.addStatic({ t, kind: 'zone', prio: 40, wx: Math.max(rd.x0, x0) + 8, wy: rd.top + L.dnY + 70, cands: [{ dx: 0, dy: 0 }], w: textWidth(z.key, 20, true), h: 24, minZoom: 0 });
      }
    }

    // platforms
    for (const p of topo.platforms) {
      const st = topo.stations[p.station];
      const a = geom.pos[topo.links[p.link].a];
      if (!a) { this.platGfx.push(null); continue; }
      const row = geom.chainRow(st.chain);
      const top = geom.rows[row].top;
      const x0 = geom.chainX(st.chain, row) - geom.platformWidth() / 2;
      const x1 = x0 + geom.platformWidth();
      const up = p.track === 'UP';
      let y0 = up ? top + L.upY + 9 : top + L.midY + 5;
      let y1 = up ? top + L.midY - 5 : top + L.dnY - 9;
      if (topo.platforms.some((q) => q.station === p.station && q.pool !== undefined)) {
        // 广兰路: island between the UP main and the middle track (upper face UP,
        // lower face middle track), side platform outside the DN main
        const lane = top + L.upY + 0.7 * (L.dnY - L.upY);
        const half = (top + L.upY + 9 + lane - 5) / 2;
        if (p.pool !== undefined) { y0 = half; y1 = lane - 5; }
        else if (up) { y0 = top + L.upY + 9; y1 = half; }
        else { y0 = top + L.dnY + 9; y1 = top + L.dnY + 30; }
      }
      const rect = new Graphics().rect(x0, y0, x1 - x0, y1 - y0).fill({ color: 0xffffff });
      rect.tint = C.platform;
      rect.eventMode = 'static';
      rect.cursor = 'pointer';
      rect.on('pointertap', this.sel({ kind: 'platform', id: p.id }));
      rect.on('pointerover', this.hov({ kind: 'platform', id: p.id }));
      rect.on('pointerout', this.hov(null));
      const bar = new Graphics();
      this.platL.addChild(rect, bar);
      this.platGfx.push({ rect, bar, x: x0, y: y0, w: x1 - x0, h: y1 - y0, up });
    }

    // station names, transfer chips, km posts
    for (const st of topo.stations) {
      const row = geom.chainRow(st.chain);
      if (!geom.pos[topo.links[topo.platforms[st.platforms.DN].link].a]) continue;
      const x = geom.chainX(st.chain, row);
      const top = geom.rows[row].top;
      const size = detail ? 48 : 40;
      const name = st.name;
      const t = this.mkText(name, size, 0xe6edf4, { bold: true });
      t.eventMode = 'static';
      t.cursor = 'pointer';
      t.on('pointertap', (e: FederatedPointerEvent) => { e.stopPropagation(); if (!this.dragMoved) this.h.station(st.index); });
      const w1 = textWidth(name, size);
      const two = LONG_NAMES[name];
      const cands: StaticLabel['cands'] = [{ dx: -w1 / 2, dy: 0 }];
      if (two) {
        const w2 = Math.max(textWidth(two[0], size), textWidth(two[1], size));
        cands.push({ dx: -w2 / 2, dy: 0, alt: `${two[0]}\n${two[1]}` });
      }
      for (const s of [1, -1]) for (const k of [0.25, 0.5, 0.75]) cands.push({ dx: -w1 / 2 + s * k * w1, dy: 0 });
      if (two) for (const s of [1, -1]) for (const k of [0.25, 0.5]) cands.push({ dx: -textWidth(two[1], size) / 2 + s * k * textWidth(two[1], size), dy: 0, alt: `${two[0]}\n${two[1]}` });
      const nameY = detail ? top + 40 : top + L.nameY;
      this.addStatic({ t, kind: 'station', prio: 100, wx: x, wy: nameY, cands, w: w1, h: size + 6, minZoom: 0 });
      // interchange chips
      const tr = STATIONS[st.index].transfers;
      if (tr.length) {
        const parts = tr.map((l) => (l === '机场联络线' ? '机场线' : l));
        const txt = parts.join(' ');
        const cw = parts.reduce((a, s2) => a + textWidth(s2, 20) + 12, 0) + (parts.length - 1) * 4;
        const t2 = this.mkText('', 20, 0xffffff, { bold: true });
        t2.visible = false;
        const chip = new Graphics();
        let cx = 0;
        for (const l of tr) {
          const s2 = l === '机场联络线' ? '机场线' : l;
          const w = textWidth(s2, 20) + 12;
          chip.roundRect(cx, 0, w, 26, 4).fill({ color: LINE_COLORS[l] ?? 0x666666 });
          const tt = new Text({ text: s2, style: { fontFamily: FONT_CN, fontSize: 20, fill: 0xffffff, fontWeight: '700' } });
          tt.anchor.set(0.5, 0.5);
          tt.position.set(cx + w / 2, 13);
          this.texts.push(tt);
          chip.addChild(tt);
          cx += w + 4;
        }
        void txt;
        this.labelLayer.addChild(chip);
        const yy = detail ? top + 40 : top + L.nameY;
        this.addStatic({ t: t2, kind: 'chip', prio: 30, wx: x, wy: yy, chip, w: cw, h: 26, minZoom: 0,
          cands: [{ dx: -cw / 2, dy: size + 10 }, { dx: w1 / 2 + 10, dy: (size - 26) / 2 + 4 }, { dx: -w1 / 2 - cw - 10, dy: (size - 26) / 2 + 4 }] });
      }
      const former = STATIONS[st.index].formerName;
      if (former) {
        const s3 = `原${former}`;
        const t3 = this.mkText(s3, 20, C.textMuted);
        const w3 = textWidth(s3, 20);
        this.addStatic({ t: t3, kind: 'former', prio: 20, wx: x, wy: detail ? top + 40 : top + L.nameY, w: w3, h: 24, minZoom: detail ? 0 : 1.4,
          cands: [{ dx: w1 / 2 + 10, dy: 12 }, { dx: -w1 / 2 - w3 - 10, dy: 12 }, { dx: -w3 / 2, dy: size + 40 }] });
      }
      const kmS = `K${Math.floor(st.chain / 1000)}+${String(Math.round(st.chain % 1000)).padStart(3, '0')}`;
      const tk = this.mkText(kmS, 20, C.textDim, { mono: true });
      const wk = textWidth(kmS, 20, true);
      this.addStatic({ t: tk, kind: 'km', prio: 25, wx: x, wy: detail ? top + L.dnY + 150 : top + L.nameY, w: wk, h: 24, minZoom: detail ? 0 : 1.7, layer: 'km',
        cands: detail ? [{ dx: -wk / 2, dy: 0 }] : [{ dx: -wk / 2, dy: size + 44 }, { dx: -wk / 2, dy: size + 10 }, { dx: w1 / 2 + 12, dy: 12 }, { dx: -w1 / 2 - wk - 12, dy: 12 }] });
    }

    // tracks by section
    const boundaryNode = (nid: number) => {
      const n = topo.nodes[nid];
      const secs = new Set(n.links.map((l) => topo.links[l].section));
      return secs.size > 1 || n.kind === 'end';
    };
    for (const s of topo.sections) {
      const g = new Graphics();
      const segs: SegHit[] = [];
      const main = s.track === 'DN' || s.track === 'UP';
      const width = detail ? (main ? 9 : 7) : main ? 7 : 5;
      for (const lid of s.links) {
        const l = topo.links[lid];
        for (const sg of geom.linkSegs(lid)) {
          const dx = sg.x2 - sg.x1;
          const dy = sg.y2 - sg.y1;
          const len = Math.hypot(dx, dy) || 1;
          const gap = detail ? 3 : 1.6;
          const ga = boundaryNode(l.a) && len > 6 ? gap : 0;
          const gb = boundaryNode(l.b) && len > 6 ? gap : 0;
          g.moveTo(sg.x1 + (dx / len) * ga, sg.y1 + (dy / len) * ga).lineTo(sg.x2 - (dx / len) * gb, sg.y2 - (dy / len) * gb);
          segs.push(sg);
        }
      }
      g.stroke({ width, color: 0xffffff, cap: 'butt', join: 'round' });
      g.tint = main ? C.trackFree : C.trackFreeSide;
      g.eventMode = 'static';
      g.cursor = 'pointer';
      g.hitArea = new SegmentsHitArea(segs, detail ? 14 : 10);
      g.on('pointertap', this.sel({ kind: 'section', id: s.id }));
      g.on('pointerover', this.hov({ kind: 'section', id: s.id }));
      g.on('pointerout', this.hov(null));
      this.trackL.addChild(g);
      this.sectionG.push(g);
      this.sectionMain.push(main);
      // overlays: TSR (yellow dashes outside the track), weather (blue dashes), blocked (violet ticks)
      const off = s.track === 'DN' ? 11 : s.track === 'UP' ? -11 : -10;
      const mkOv = (color: number, dash: number, offY: number, width2: number) => {
        const o = new Graphics();
        for (const sg of segs) {
          const len = Math.hypot(sg.x2 - sg.x1, sg.y2 - sg.y1);
          const n = Math.max(1, Math.floor(len / (dash * 2)));
          for (let k = 0; k < n; k++) {
            const t0 = (k * 2 * dash) / len;
            const t1 = Math.min(1, ((k * 2 + 1) * dash) / len);
            o.moveTo(sg.x1 + (sg.x2 - sg.x1) * t0, sg.y1 + (sg.y2 - sg.y1) * t0 + offY).lineTo(sg.x1 + (sg.x2 - sg.x1) * t1, sg.y1 + (sg.y2 - sg.y1) * t1 + offY);
          }
        }
        o.stroke({ width: width2, color });
        o.visible = false;
        this.ovL.addChild(o);
        return o;
      };
      this.tsrG.push(mkOv(C.tsr, 8, off, 4));
      this.envG.push(mkOv(C.env, 6, -off, 3));
      const b = new Graphics();
      for (const sg of segs) {
        const len = Math.hypot(sg.x2 - sg.x1, sg.y2 - sg.y1);
        const n = Math.max(1, Math.floor(len / 14));
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          const x = sg.x1 + (sg.x2 - sg.x1) * t;
          const y = sg.y1 + (sg.y2 - sg.y1) * t;
          b.moveTo(x - 5, y + 8).lineTo(x + 5, y - 8);
        }
      }
      b.stroke({ width: 2.5, color: C.blocked });
      b.visible = false;
      this.ovL.addChild(b);
      this.blkG.push(b);
      // section ID label (zoom / toggle / detail)
      if (segs.length && (main || detail)) {
        const mid = segs[Math.floor(segs.length / 2)];
        const name = s.name.replace(/·.*/, '');
        const ts = this.mkText(name, 20, C.textMuted, { mono: true });
        const w = textWidth(name, 20, true);
        const below = s.track !== 'UP';
        const mx = (mid.x1 + mid.x2) / 2;
        const my = (mid.y1 + mid.y2) / 2;
        this.addStatic({ t: ts, kind: 'sec', prio: 10, wx: mx, wy: my, w, h: 24, minZoom: detail ? 0 : 2.4, layer: 'sec',
          cands: below ? [{ dx: -w / 2, dy: 16 }, { dx: -w / 2, dy: 40 }] : [{ dx: -w / 2, dy: -40 }, { dx: -w / 2, dy: -64 }] });
      }
    }

    // buffer stops
    const bufG = new Graphics();
    for (const n of topo.nodes) {
      if (n.kind !== 'end' || n.endKind === 'depot') continue;
      const l = topo.links[n.links[0]];
      const p = geom.pos[n.id];
      const q = geom.pos[l.a === n.id ? l.b : l.a];
      if (!p || !q) continue;
      const dx = p.x - q.x;
      const dy = p.y - q.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      bufG.moveTo(p.x + nx * 10, p.y + ny * 10).lineTo(p.x - nx * 10, p.y - ny * 10);
    }
    bufG.stroke({ width: 4, color: 0x9fb0c0 });
    this.trackL.addChild(bufG);

    // switches
    topo.switches.forEach((sw, si) => {
      for (const nid of sw.nodes) {
        const n = topo.nodes[nid];
        const p = geom.pos[nid];
        if (!p) continue;
        const mk = (lid: number) => {
          const l = topo.links[lid];
          const o = geom.pos[l.a === nid ? l.b : l.a];
          const g = new Graphics();
          if (o) {
            const dx = o.x - p.x;
            const dy = o.y - p.y;
            const len = Math.hypot(dx, dy) || 1;
            const a = detail ? 5 : 4;
            const b = detail ? 22 : 14;
            g.moveTo(p.x + (dx / len) * a, p.y + (dy / len) * a).lineTo(p.x + (dx / len) * Math.min(b, len * 0.6), p.y + (dy / len) * Math.min(b, len * 0.6)).stroke({ width: detail ? 14 : 10, color: C.bg });
          }
          g.visible = false;
          return g;
        };
        const gn = mk(n.normal!);
        const gr = mk(n.reverse!);
        const s = detail ? 10 : 7;
        const x = new Graphics().moveTo(p.x - s, p.y - s).lineTo(p.x + s, p.y + s).moveTo(p.x + s, p.y - s).lineTo(p.x - s, p.y + s).stroke({ width: 3, color: C.fault });
        x.visible = false;
        const hit = new Graphics().circle(p.x, p.y, detail ? 20 : 13).fill({ color: 0xffffff, alpha: 0.001 });
        hit.eventMode = 'static';
        hit.cursor = 'pointer';
        hit.on('pointertap', this.sel({ kind: 'switch', id: si }));
        hit.on('pointerover', this.hov({ kind: 'switch', id: si }));
        hit.on('pointerout', this.hov(null));
        // single lock (white ring) / block (violet ring) indicator
        const lk = new Graphics().circle(p.x, p.y, detail ? 17 : 11).stroke({ width: detail ? 3 : 2.5, color: 0xffffff });
        lk.visible = false;
        this.swL.addChild(gn, gr, x, lk, hit);
        this.swGfx.push({ sw: si, node: nid, n: gn, r: gr, x, lk, p });
        // ID label
        const name = sw.name.replace(/^P/, '');
        const tl = this.mkText(name, 20, C.textDim, { mono: true });
        const w = textWidth(name, 20, true);
        const isUp = topo.links[n.toe!].track === 'UP';
        const isDn = topo.links[n.toe!].track === 'DN';
        const cands = isUp ? [{ dx: -w / 2, dy: -44 }, { dx: -w / 2, dy: -68 }] : isDn ? [{ dx: -w / 2, dy: 18 }, { dx: -w / 2, dy: 42 }] : [{ dx: 14, dy: -28 }, { dx: -w - 14, dy: -28 }, { dx: 14, dy: 6 }];
        this.addStatic({ t: tl, kind: 'sw', prio: 15, wx: p.x, wy: p.y, w, h: 24, minZoom: detail ? 0 : 2.0, layer: 'sig', cands });
      }
    });

    // signals
    for (const s of topo.signals) {
      const l = topo.links[s.link];
      const p = geom.pos[s.node];
      const o = geom.pos[l.a === s.node ? l.b : l.a];
      if (!p || !o) { this.sigGfx.push(null); continue; }
      let dx = o.x - p.x;
      let dy = o.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      // right-hand side of travel (screen y down)
      let nx = -dy;
      let ny = dx;
      if (Math.abs(dy) > 0.8) { nx = 1; ny = 0; }
      const c = new Graphics();
      const lamp = new Graphics();
      const lamp2 = new Graphics();
      const ring = new Graphics();
      const cross = new Graphics();
      const r = detail ? 9 : 4.5;
      const off = detail ? 22 : 11;
      const lx = p.x + nx * off;
      const ly = p.y + ny * off;
      if (detail) {
        // mast + base on the track side, lamp facing the approaching train
        const bx = p.x + nx * 8;
        const by = p.y + ny * 8;
        c.moveTo(bx, by).lineTo(lx, ly).moveTo(lx - dx * 4, ly - dy * 4).lineTo(lx + dx * 4, ly + dy * 4).stroke({ width: 2.5, color: C.sigMast });
        const cx = lx - dx * (r + 4);
        const cy = ly - dy * (r + 4);
        lamp.circle(cx, cy, r).fill({ color: 0xffffff });
        lamp2.circle(cx - dx * (2 * r + 3), cy - dy * (2 * r + 3), r).fill({ color: 0xffffff });
        ring.circle(cx, cy, r).stroke({ width: 2, color: 0xffffff });
        cross.moveTo(cx - r, cy - r).lineTo(cx + r, cy + r).moveTo(cx + r, cy - r).lineTo(cx - r, cy + r).stroke({ width: 3, color: C.fault });
        this.sigGfx.push({ g: c, ring, cross, lamp, lamp2, x: cx, y: cy, dirX: dx });
      } else {
        lamp.circle(lx, ly, r).fill({ color: 0xffffff });
        ring.circle(lx, ly, r).stroke({ width: 1.5, color: 0xffffff });
        lamp2.circle(lx, ly, r + 2).stroke({ width: 2, color: 0xffffff });
        cross.moveTo(lx - 6, ly - 6).lineTo(lx + 6, ly + 6).moveTo(lx + 6, ly - 6).lineTo(lx - 6, ly + 6).stroke({ width: 3, color: C.fault });
        this.sigGfx.push({ g: c, ring, cross, lamp, lamp2, x: lx, y: ly, dirX: dx });
      }
      lamp2.visible = false;
      cross.visible = false;
      ring.visible = false;
      const hit = new Graphics().circle(lx, ly, detail ? 22 : 12).fill({ color: 0xffffff, alpha: 0.001 });
      hit.eventMode = 'static';
      hit.cursor = 'pointer';
      hit.on('pointertap', this.sel({ kind: 'signal', id: s.id }));
      hit.on('pointerover', this.hov({ kind: 'signal', id: s.id }));
      hit.on('pointerout', this.hov(null));
      this.sigL.addChild(c, lamp, lamp2, ring, cross, hit);
      // ID label beside the signal, on its side of the track
      const tn = this.mkText(s.name, 20, C.textDim, { mono: true });
      const w = textWidth(s.name, 20, true);
      const above = ny < 0;
      const cands = above
        ? [{ dx: -w / 2, dy: -off - 30 }, { dx: dx > 0 ? -w - 12 : 12, dy: -off - 14 }, { dx: -w / 2, dy: -off - 56 }]
        : [{ dx: -w / 2, dy: off + 6 }, { dx: dx > 0 ? -w - 12 : 12, dy: off - 10 }, { dx: -w / 2, dy: off + 32 }];
      this.addStatic({ t: tn, kind: 'sig', prio: 14, wx: p.x, wy: p.y, w, h: 24, minZoom: detail ? 0 : 2.0, layer: 'sig', cands });
    }

    // depots / yards
    topo.depots.forEach((d, i) => {
      const gp = geom.pos[d.gateNode];
      if (!gp) return;
      const top = geom.rows[gp.row].top;
      const w = detail ? 520 : 420;
      const hgt = detail ? 150 : 86;
      const x0 = gp.x - w / 2;
      const y0 = detail ? gp.y - hgt - 6 : top + 6;
      const box = new Graphics().roundRect(x0, y0, w, hgt, 4).fill({ color: 0x0a1520 }).stroke({ width: 1.5, color: 0x34506b });
      box.moveTo(gp.x, gp.y).lineTo(gp.x, y0 + hgt).stroke({ width: 4, color: C.trackFreeSide });
      box.eventMode = 'static';
      box.cursor = 'pointer';
      box.on('pointertap', (e: FederatedPointerEvent) => { e.stopPropagation(); if (!this.dragMoved) this.h.depot(i); });
      const veh = new Graphics();
      this.yardL.addChild(box, veh);
      this.yardGfx.push({ depot: i, box, veh, x: x0, y: y0, w, h: hgt, key: '' });
      const t = this.mkText(d.name, 24, 0xd6e0ea);
      t.eventMode = 'static';
      t.cursor = 'pointer';
      t.on('pointertap', (e: FederatedPointerEvent) => { e.stopPropagation(); if (!this.dragMoved) this.h.depot(i); });
      this.addStatic({ t, kind: 'depot', prio: 90, wx: x0, wy: y0, w: textWidth(d.name, 24), h: 28, minZoom: 0, cands: [{ dx: 10, dy: 3 }] });
      // the yard box and the junction throat are obstacles for train windows
      this.obstacles.push({ x: x0, y: y0, w, h: hgt });
      const legs = d.transferPaths.flatMap((path) => path.links.flatMap((l) => [topo.links[l].a, topo.links[l].b])).map((n) => geom.pos[n]).filter((q): q is P => !!q);
      if (legs.length) {
        const xs = legs.map((q) => q.x);
        const ys = legs.map((q) => q.y);
        this.obstacles.push({ x: Math.min(...xs) - 6, y: Math.min(...ys) - 4, w: Math.max(...xs) - Math.min(...xs) + 12, h: Math.max(...ys) - Math.min(...ys) + 4 });
      }
    });

    this.placeStatics();
  }

  private addStatic(l: StaticLabel) {
    l.t.visible = false;
    if (!l.chip) this.labelLayer.addChild(l.t);
    this.statics.push(l);
  }

  /** place the static labels for the current zoom (greedy by priority) */
  private placeStatics() {
    this.staticZoom = this.z;
    const idx = new LabelIndex(128);
    const z = this.z;
    for (const o of this.obstacles) idx.add({ x: o.x * z, y: o.y * z, w: o.w * z, h: o.h * z }, 'obstacle');
    const order = [...this.statics].sort((a, b) => b.prio - a.prio);
    const placed: { r: Rect; tag: string }[] = [];
    for (const l of order) {
      const enabled = z >= l.minZoom || (l.layer ? this.layers[l.layer] : false);
      if (!enabled) { this.hideStatic(l); continue; }
      let ok = false;
      for (const c of l.cands) {
        let w = l.w;
        let h = l.h;
        if (c.alt) {
          const lines = c.alt.split('\n');
          const size = (l.t.style.fontSize as number) ?? 40;
          w = Math.max(...lines.map((s) => textWidth(s, size)));
          h = lines.length * (size + 4) + 2;
        }
        // keep labels inside the drawing (names of the terminal stations near the edges)
        const r = { x: Math.max(4, Math.min(this.geom.width * z - w - 4, l.wx * z + c.dx)), y: l.wy * z + c.dy, w, h };
        if (idx.hits(r, 4)) continue;
        idx.add(r, `${l.kind}:${l.t.text || 'chip'}`);
        placed.push({ r, tag: `${l.kind}:${l.t.text || 'chip'}` });
        if (c.alt) l.t.text = c.alt;
        else if (l.kind === 'station') l.t.text = l.t.text.replace('\n', '');
        l.rect = r;
        if (l.chip) { l.chip.position.set(r.x, r.y); l.chip.visible = true; }
        else { l.t.position.set(r.x, r.y); l.t.visible = true; }
        ok = true;
        break;
      }
      if (!ok) this.hideStatic(l);
    }
    // obstacles (yards, junctions) also block train windows
    for (const o of this.obstacles) placed.push({ r: { x: o.x * z, y: o.y * z, w: o.w * z, h: o.h * z }, tag: 'obstacle' });
    this.staticRects = placed;
    this.lastKey = '';
  }

  private hideStatic(l: StaticLabel) {
    l.rect = undefined;
    if (l.chip) l.chip.visible = false;
    else l.t.visible = false;
  }

  setLayers(layers: Partial<Layers>) {
    Object.assign(this.layers, layers);
    this.placeStatics();
  }

  // ---------------------------------------------------------------- update

  update(snap: Snapshot, nowMs: number) {
    const phase = Math.floor(nowMs / 250);
    const sel = this.store.selection;
    const key = `${phase}|${sel ? `${sel.kind}:${sel.id}` : ''}|${this.pendingStart}|${this.follow}`;
    if (snap === this.lastSnap && key === this.lastKey) return;
    this.lastKey = key;
    this.lastSnap = snap;
    this.blink = Math.floor(nowMs / 500) % 2 === 0;
    const blinkSlow = Math.floor(nowMs / 800) % 2 === 0;
    const detail = this.mode === 'detail';
    const { topo } = this;

    // Symbols stay the same length; the grey occupied sections use real detection.
    this.updateTrainBodies(snap);
    const occupied=this.updateTrainOccupation(snap);

    // sections
    for (let i = 0; i < this.sectionG.length; i++) {
      const f = snap.sections[i];
      let c: number;
      if (f & SEC.DIST) c = this.blink ? C.disturbed : 0x6a1a1a;
      else if (f & SEC.PRESET) c = blinkSlow ? C.preset : 0x6a5a00;
      else if (f & SEC.OCC && !(f & SEC.COMM)) c = C.occAxle;
      else if (f & SEC.OCC && !occupied.has(i)) c = C.occComm;
      else if (f & SEC.GUIDE) c = C.routeGuide;
      else if (f & SEC.LOCK) c = f & SEC.ROUTEFLEET ? C.routeAuto : C.routeSet;
      else c = this.sectionMain[i] ? C.trackFree : C.trackFreeSide;
      if (this.sectionG[i].tint !== c) this.sectionG[i].tint = c;
      this.tsrG[i].visible = (f & SEC.TSR) !== 0;
      this.envG[i].visible = (f & SEC.ENV) !== 0;
      const blk = (f & SEC.BLOCK) !== 0;
      this.blkG[i].visible = blk;
    }

    // switches
    for (const g of this.swGfx) {
      const f = snap.switches[g.sw];
      const moving = (f & SW.MOVING) !== 0;
      const failed = (f & SW.FAILED) !== 0;
      const rev = (f & SW.R) !== 0;
      if (failed && !(f & SW.FIELD)) {
        g.n.visible = true;
        g.r.visible = true;
        g.x.visible = this.blink;
      } else if (moving) {
        g.n.visible = this.blink;
        g.r.visible = this.blink;
        g.x.visible = false;
      } else {
        g.n.visible = rev;
        g.r.visible = !rev;
        g.x.visible = false;
      }
      const blocked = (f & SW.BLOCKED) !== 0;
      const single = (f & SW.SINGLE) !== 0;
      g.lk.visible = blocked || single;
      if (g.lk.visible) g.lk.tint = blocked ? C.blocked : 0xe8eef5;
    }

    // signals
    for (let i = 0; i < this.sigGfx.length; i++) {
      const g = this.sigGfx[i];
      if (!g) continue;
      const f = snap.signals[i];
      const aspect = SIG_ASPECT[f & 7];
      const zone = snap.zones[topo.links[topo.signals[i].link].zone];
      const cbtc = zone === 'CBTC';
      g.lamp2.visible = false;
      g.cross.visible = false;
      g.ring.visible = false;
      g.lamp.visible = true;
      g.lamp.alpha = 1;
      const pend = this.pendingStart === i;
      switch (aspect) {
        case 'R':
          // CBTC: trains run on movement authority, the wayside stop aspect is shown hollow / dim
          if (detail && cbtc) { g.lamp.visible = false; g.ring.visible = true; g.ring.tint = C.sigStop; }
          else if (detail) g.lamp.tint = C.sigStop;
          else if (cbtc) { g.lamp.visible = false; g.ring.visible = true; g.ring.tint = C.sigStopDim; }
          else g.lamp.tint = C.sigStop;
          break;
        case 'G': g.lamp.tint = detail || !cbtc ? C.sigGreen : 0x2f6b48; break;
        case 'Y': g.lamp.tint = detail || !cbtc ? C.sigYellow : 0x7a6a20; break;
        case 'GUIDE':
          g.lamp.tint = C.sigStop;
          g.lamp2.visible = this.blink;
          g.lamp2.tint = C.sigWhite;
          break;
        case 'DARK':
          g.lamp.visible = false;
          g.ring.visible = true;
          g.ring.tint = 0x3a4a5a;
          break;
        case 'FAIL':
          g.lamp.visible = false;
          g.ring.visible = true;
          g.ring.tint = this.blink ? C.fault : 0x5a1010;
          g.cross.visible = true;
          break;
      }
      if (pend) { g.lamp2.visible = this.blink; g.lamp2.tint = C.selection; }
    }

    // platforms: crowding bars
    for (let i = 0; i < this.platGfx.length; i++) {
      const g = this.platGfx[i];
      if (!g) continue;
      const f = snap.platforms[i];
      const esp = (f & PLT.ESP) !== 0;
      g.rect.tint = esp ? (this.blink ? 0x7a1010 : 0x3a0a0a) : f & PLT.HOLD ? 0x3a3010 : C.platform;
      g.bar.clear();
      if (this.layers.pax) {
        const w = snap.platformWaiting[i];
        const frac = Math.min(1, w / 1500);
        if (frac > 0.02) {
          const col = w > 1200 ? C.crowdHigh : w > 700 ? C.crowdMid : C.crowdLow;
          const bh = Math.max(4, Math.min(8, g.h * 0.28));
          const by = g.up ? g.y + 2 : g.y + g.h - bh - 2;
          g.bar.rect(g.x + 3, by, (g.w - 6) * frac, bh).fill({ color: col });
        }
      }
      const fault = (f & PLT.PSDFAULT) !== 0;
      if (fault) g.bar.rect(g.x, g.up ? g.y - 3 : g.y + g.h, g.w, 3).fill({ color: f & PLT.BYPASS ? C.occAxle : this.blink ? C.fault : 0x5a1010 });
    }

    // yards
    this.updateYards(snap);
    this.placeDynamic(snap);
    this.drawSelection();
    // follow camera
    if (this.follow >= 0) {
      const tr = snap.trains.find((t) => t.id === this.follow);
      if (tr) {
        const p = this.trainPoint(tr);
        if (p) this.centerOn(p.x, p.y, undefined, 0.25);
      }
    }
  }

  private updateYards(snap: Snapshot) {
    for (const yg of this.yardGfx) {
      const y = snap.yards[yg.depot];
      if (!y) continue;
      const key = y.tracks.map((t) => t.length).join(',');
      if (key === yg.key) continue;
      yg.key = key;
      const g = yg.veh;
      g.clear();
      const n = y.tracks.length;
      const cols = this.mode === 'detail' ? 1 : 2;
      const perCol = Math.ceil(n / cols);
      const padTop = 34;
      const pitch = (yg.h - padTop - 6) / perCol;
      const colW = (yg.w - 20) / cols;
      for (let k = 0; k < n; k++) {
        const col = Math.floor(k / perCol);
        const rowI = k % perCol;
        const x = yg.x + 10 + col * colW;
        const yy = yg.y + padTop + rowI * pitch + pitch / 2;
        const railEnd = x + colW - 12;
        g.moveTo(x, yy).lineTo(railEnd, yy).stroke({ width: 2, color: 0x688096 });
        g.moveTo(x, yy-3).lineTo(x, yy+3).moveTo(railEnd, yy-3).lineTo(railEnd, yy+3).stroke({ width: 1.5, color: 0x688096 });
        const vw = (colW - 18) / Math.max(1, y.perTrack) - 4;
        y.tracks[k].forEach((_, j) => {
          g.roundRect(x + 3 + j * (vw + 4), yy - Math.min(4, pitch / 2 - 1), vw, Math.min(8, pitch - 2), 2).fill({ color: 0x6f8ba6 });
        });
      }
    }
  }

  private bodyColor(tr: TrainSnap): number {
    if (tr.failed) return this.blink ? C.trainFail : 0x6a1010;
    if (tr.eb) return C.trainFail;
    if (tr.manual) return C.trainManual;
    if (tr.mode === 'RM') return C.trainRm;
    if (tr.level !== 'CBTC' || !tr.comm) return C.trainNonComm;
    return C.trainCbtc;
  }

  /** Draw fixed-length symbols independently of the grey occupied sections. */
  private updateTrainOccupation(snap:Snapshot):Set<number> {
    const paths=snap.trains.filter(t=>t.comm&&t.level==='CBTC').flatMap(t=>this.geom.trainOccupiedPath(t));
    const occupied=new Set(paths.map(s=>s.section));
    const key=`${this.z}|${paths.map(s=>`${s.x1.toFixed(2)},${s.y1.toFixed(2)},${s.x2.toFixed(2)},${s.y2.toFixed(2)},${snap.sections[s.section]}`).join(';')}`;
    if(key!==this.occupiedKey) {
      this.occupiedKey=key;this.occupiedG.clear();
      for(const s of paths) {
        const f=snap.sections[s.section];
        if(!(f&SEC.OCC)||!(f&SEC.COMM)||(f&(SEC.DIST|SEC.PRESET)))continue;
        this.occupiedG.moveTo(s.x1,s.y1).lineTo(s.x2,s.y2);
      }
      // Keep the grey occupation visible around the constant-size symbol.
      const width=Math.max(this.mode==='detail'?9:7,((this.mode==='detail'?13:10)+8)/this.z);
      this.occupiedG.stroke({width,color:C.occComm,cap:'butt',join:'round'});
    }
    return occupied;
  }

  /** Draw the train symbol without using it as an occupation measurement. */
  private updateTrainBodies(snap: Snapshot) {
    const swPos = (sw: number) => (snap.switches[sw] & SW.R ? 'R' : 'N') as 'N' | 'R';
    const seen = new Set<number>();
    const w = this.mode === 'detail' ? 13 : 10;
    for (const tr of snap.trains) {
      seen.add(tr.id);
      let tg = this.trains.get(tr.id);
      if (!tg) tg = this.createTrain(tr);
      const color = this.bodyColor(tr);
      const sel = this.store.selection?.kind === 'train' && this.store.selection.id === tr.id;
      const segs = this.geom.trainBody(tr, swPos);
      const bodyKey = `${segs.map(s => `${s.x1.toFixed(1)},${s.y1.toFixed(1)},${s.x2.toFixed(1)},${s.y2.toFixed(1)}`).join(';')}|${this.z}|${color}|${sel}`;
      if (bodyKey !== tg.bodyKey) {
        tg.bodyKey = bodyKey;
        tg.body.clear();
        let drawn = false;
        let tail: {x:number;y:number} | undefined;
        for (const s of segs) {
            if (!tail || Math.hypot(tail.x-s.x1,tail.y-s.y1)>.01) tg.body.moveTo(s.x1, s.y1);
            tg.body.lineTo(s.x2, s.y2);
            tail={x:s.x2,y:s.y2};
            drawn = true;
        }
        if (drawn) {
          if (sel) tg.body.stroke({ width: (w + 8)/this.z, color: C.selection, alpha: 0.5, cap: 'butt', join: 'round' });
          tg.body.stroke({ width: w/this.z, color, cap: 'butt', join: 'round' });
        }
      }
    }
    for (const [id, tg] of this.trains) {
      if (!seen.has(id)) {
        tg.body.destroy();
        tg.box.destroy({ children: true });
        this.trains.delete(id);
      }
    }
  }

  private createTrain(tr: TrainSnap): TrainGfx {
    const body = new Graphics();
    const box = new Container();
    const bg = new Graphics();
    const label = new Text({ text: '', style: { fontFamily: FONT_MONO, fontSize: 30, fill: 0xffffff, fontWeight: '600' } });
    label.anchor.set(0, 0.5);
    const chips = new Text({ text: '', style: { fontFamily: FONT_CN, fontSize: 24, fill: C.slightLate, fontWeight: '700' } });
    chips.anchor.set(0, 0.5);
    box.addChild(bg, label, chips);
    box.eventMode = 'static';
    box.cursor = 'pointer';
    const sel = { kind: 'train', id: tr.id } as const;
    box.on('pointertap', this.sel(sel));
    box.on('pointerover', this.hov(sel));
    box.on('pointerout', this.hov(null));
    body.eventMode = 'static';
    body.cursor = 'pointer';
    body.on('pointertap', this.sel(sel));
    body.on('pointerover', this.hov(sel));
    body.on('pointerout', this.hov(null));
    this.bodyL.addChild(body);
    this.labelLayer.addChild(box);
    const tg: TrainGfx = { body, box, bg, label, chips, bodyKey: '', styleKey: '', text: '', chipText: '' };
    this.trains.set(tr.id, tg);
    this.store.emit('textsChanged');
    return tg;
  }

  /** dynamic labels: TSR / block badges, then train windows by priority */
  private placeDynamic(snap: Snapshot) {
    const z = this.z;
    const idx = this.index;
    idx.clear();
    for (const s of this.staticRects) idx.add(s.r, s.tag);
    this.dynUsed = 0;
    const leaders = this.leaderG;
    leaders.clear();
    const { topo, geom } = this;

    // badges for restricted / blocked stretches (one per run of sections)
    const badge = (text: string, color: number, wx: number, wy: number, below: boolean) => {
      const w = textWidth(text, 20) + 12;
      const h = 26;
      const cands: Rect[] = [];
      for (const dy of below ? [18, 46, 74] : [-44, -72, -100]) for (const dx of [0, -w, w, -2 * w, 2 * w]) cands.push({ x: wx * z - w / 2 + dx, y: wy * z + dy, w, h });
      const r = idx.tryPlace(cands, `badge:${text}`);
      if (!r) return;
      const t = this.dynText(text, color);
      t.position.set(r.x + 6, r.y + 1);
      leaders.roundRect(r.x, r.y, r.w, r.h, 4).fill({ color: 0x0b131c, alpha: 0.92 }).stroke({ width: 1.5, color });
    };
    const runs = (flag: number, label: (s: number) => string, color: number) => {
      const seen = new Set<string>();
      for (let i = 0; i < topo.sections.length; i++) {
        if (!(snap.sections[i] & flag)) continue;
        const s = topo.sections[i];
        if (s.track !== 'DN' && s.track !== 'UP') continue;
        const text = label(i);
        if (!text) continue;
        // one badge per station interval and track
        const k = `${text}|${s.track}|${s.station}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const mid = (s.chainFrom + s.chainTo) / 2;
        const row = geom.chainRow(mid);
        if (!geom.pos[topo.links[s.links[0]].a]) continue;
        const x = geom.chainX(mid, row);
        const y = geom.rows[row].top + (s.track === 'UP' ? this.L.upY : this.L.dnY);
        badge(text, color, x, y, s.track !== 'UP');
      }
    };
    runs(SEC.POSS, () => '施工', C.blocked);
    runs(SEC.BLOCK, (i) => (snap.sections[i] & SEC.POSS ? '' : '封锁'), C.blocked);
    runs(SEC.TSR, (i) => `限${snap.sectionTsr[i]}`, C.tsr);
    runs(SEC.ENV, (i) => (snap.sectionTsr[i] > 0 && !(snap.sections[i] & SEC.TSR) ? `风雨${snap.sectionTsr[i]}` : snap.sectionTsr[i] === 0 ? '停运' : ''), C.env);

    // trains: abnormal first
    const prio = (t: TrainSnap) => {
      let p = 0;
      if (this.store.selection?.kind === 'train' && this.store.selection.id === t.id) p += 1000;
      if (t.failed || t.eb) p += 500;
      // (AM under CBTC is the norm while the whole line runs ATO)
      if (!t.comm || t.level !== 'CBTC' || t.manual || t.mode !== 'DTO' && !(t.mode === 'AM' && snap.atoLine)) p += 300;
      if (t.hold) p += 200;
      if (t.inService && t.delay > 120) p += 100 + Math.min(99, t.delay / 60);
      if (!t.inService) p -= 50;
      return p;
    };
    const list = snap.trains.slice().sort((a, b) => (geom.linkPoint(a.link,a.off)?.x??0)-(geom.linkPoint(b.link,b.off)?.x??0)||prio(b)-prio(a));
    for (const tg of this.trains.values()) tg.box.visible = false;
    const prepared = list.flatMap(tr => { const p = this.prepareTrainWindow(tr); return p ? [p] : []; });
    const rows = new Map<number, typeof prepared>();
    for (const input of prepared) rows.set(input.row, [...rows.get(input.row) ?? [], input]);
    const taken = idx.placed.map(o => o.r);
    const placed = [...rows].map(([row, inputs]) => {
      const ps = placeTrainWindows(inputs, { [-1]: this.trainWindowBand(row, -1), [1]: this.trainWindowBand(row, 1) }, taken);
      taken.push(...ps.map(p => p.r));
      return { inputs, ps };
    });
    let groupUsed = 0;
    for (const { inputs, ps } of placed) {
      for (const p of ps) {
        if (p.text) {
          this.drawTrainGroup(groupUsed++, p.ids, p.text, p.r, Math.max(...p.ids.map(id => inputs.find(t => t.id === id)!.delay)));
          idx.add(p.r, `train-group:${p.ids.join(',')}`);
        } else {
          const data = inputs.find(t => t.id === p.ids[0])!, tg = this.trains.get(data.id)!;
          tg.box.visible = true;
          this.drawWindow(tg, data.tr, p.compact ? data.tr.trip : `${data.tr.svc}-${data.tr.trip}`, data.chips, p.r, data.status, data.right);
          idx.add(p.r, `train:${data.tr.svc}-${data.tr.trip}`);
        }
        leaders.moveTo(p.leader.x1,p.leader.y1).lineTo(p.leader.x2,p.leader.y2).stroke({width:1.5,color:0x5d7086,alpha:.9});
      }
    }
    for (let i = groupUsed; i < this.groupBoxes.length; i++) this.groupBoxes[i].box.visible = false;
    for (let i = this.dynUsed; i < this.dynTexts.length; i++) this.dynTexts[i].visible = false;
  }

  private dynText(s: string, color: number): Text {
    let t = this.dynTexts[this.dynUsed];
    if (!t) {
      t = new Text({ text: '', style: { fontFamily: FONT_CN, fontSize: 20, fill: 0xffffff, fontWeight: '700' } });
      this.dynTexts.push(t);
      this.labelLayer.addChild(t);
      this.store.emit('textsChanged');
    }
    this.dynUsed++;
    if (t.text !== s) t.text = s;
    if (t.style.fill !== color) t.style.fill = color;
    t.visible = true;
    return t;
  }

  private trainWindowBand(row: number, side: 1|-1): Rect {
    const rd = this.geom.rows[row], z = this.z;
    const top = rd.top * z, bottom = (rd.top + this.L.rowH) * z;
    let from = side < 0 ? top + 8 : (rd.top + this.L.dnY) * z + 14;
    let to = side < 0 ? (rd.top + this.L.upY) * z - 10 : bottom - 8;
    const names = this.staticRects.filter(o => o.tag.startsWith('station:') && o.r.y >= top && o.r.y < bottom);
    if (side < 0) for (const { r } of names) if (r.y < to) from = Math.max(from, r.y + r.h + 8);
    if (side > 0) for (const { r } of names) if (r.y > (rd.top + this.L.dnY) * z) to = Math.min(to, r.y - 8);
    // Labels are unscaled. Keep a full-height band even at overview zoom.
    from = Math.max(top + 4, Math.min(from, to - 40));
    from = Math.max(from, this.panY + 2); to = Math.min(to, this.panY + this.vh - 2);
    const x = Math.max(2, this.panX + 2);
    return { x, y: from, w: Math.max(0, Math.min(this.geom.width * z - 2, this.panX + this.vw - 2) - x), h: Math.max(0, to - from) };
  }

  private drawTrainGroup(index: number, ids: number[], text: string, r: Rect, delay: number) {
    let group = this.groupBoxes[index];
    if (!group) {
      const box = new Container(), bg = new Graphics();
      const label = this.mkText('', 24, C.slightLate, { bold: true });
      group = { box, bg, label, ids }; this.groupBoxes.push(group);
      box.addChild(bg, label); this.labelLayer.addChild(box);
      box.eventMode = 'static'; box.cursor = 'pointer';
      const target = group;
      // a box naming one train behaves like that train's window
      const one = () => target.ids.length === 1 ? { kind: 'train', id: target.ids[0] } as const : null;
      box.on('pointerover', () => { const t = one(); if (t) this.h.hover(t); else this.store.showTrainGroup(target.ids); });
      box.on('pointerout', () => { if (one()) this.h.hover(null); else this.store.showTrainGroup(null); });
      box.on('pointertap', (e: FederatedPointerEvent) => {
        e.stopPropagation();
        if (this.dragMoved) return;
        const t = one();
        if (t) this.h.device(t); else this.store.showTrainGroup(target.ids, true);
      });
      this.store.emit('textsChanged');
    }
    group.ids = ids; group.box.visible = true; group.box.position.set(r.x, r.y);
    // same lateness colours as a single window: an on-time queue is not flagged
    const status = delayColor(delay);
    group.label.text = text; group.label.position.set(12, 4);
    group.label.style.fill = status === C.onTime ? 0xffffff : status;
    group.bg.clear().roundRect(1, 1, r.w - 2, r.h - 2, 4).fill({color:C.trainBoxFill,alpha:.97}).stroke({width:2,color:status === C.onTime ? C.trainBoxBorder : status});
  }

  private prepareTrainWindow(tr: TrainSnap) {
    const tg = this.trains.get(tr.id)!;
    const { topo, geom } = this;
    const z = this.z;
    const head = geom.trainHeadPoint(tr);
    if (!head || head.x*z < this.panX - 200 || head.x*z > this.panX + this.vw + 200) return;
    const l = topo.links[tr.link];
    const a = geom.pos[l.a]!;
    const b = geom.pos[l.b]!;
    const right = (b.x - a.x) * tr.dir >= 0;
    // Bands: those whose leader crosses the fewest main lines (UP above, DN
    // below, depot leads above; the middle tracks reach both), nearer first.
    const top = geom.rows[head.row].top, lines = [top + this.L.upY, top + this.L.dnY];
    const crossed = (side: 1 | -1) => lines.filter(y => (y - head.y) * side > 1).length;
    const least = Math.min(crossed(-1), crossed(1));
    const sides = ([-1, 1] as const).filter(s => crossed(s) === least)
      .sort((p, q) => Math.abs(lines[p < 0 ? 0 : 1] - head.y) - Math.abs(lines[q < 0 ? 0 : 1] - head.y));
    // texts
    const full = `${tr.svc}-${tr.trip}`;
    let chips = '';
    if (tr.failed) chips += '故障';
    else if (tr.eb) chips += 'EB';
    if (!tr.comm) chips += '×';
    else if (tr.level === 'TBTC') chips += 'T';
    if (tr.manual) chips += tr.mode === 'RM' ? '人RM' : '人CM';
    else if (tr.mode !== 'DTO' && !(tr.mode === 'AM' && tr.level === 'CBTC' && this.store.snap?.atoLine)) chips += tr.mode;
    if (tr.hold) chips += '扣';
    if (tr.hot) chips += '热备';
    if (tr.inService) chips += lateText(tr.delay);
    tg.chips.text = chips;
    // The label may show the compact or the full text (drawWindow sets it);
    // it is monospaced, so one measured advance sizes both.
    const charW = tg.label.text ? tg.label.width / tg.label.text.length : textWidth('0', 30, true);
    const width = trainWindowWidth(charW * full.length, chips ? tg.chips.width : 0);
    const compactWidth = trainWindowWidth(charW * tr.trip.length, chips ? tg.chips.width : 0);
    const status = tr.failed || tr.eb ? C.fault : delayColor(tr.delay, tr.inService);
    const keep = !!chips || (this.store.selection?.kind === 'train' && this.store.selection.id === tr.id);
    return { id: tr.id, tr, head: { x: head.x*z, y: head.y*z }, row: head.row, side: sides[0], sides, width, delay: tr.inService ? tr.delay : 0, keep, compactWidth, trip: tr.trip, chips, status, right };
  }

  private drawWindow(tg: TrainGfx, tr: TrainSnap, text: string, chips: string, r: Rect, status: number, right: boolean) {
    const sel = this.store.selection?.kind === 'train' && this.store.selection.id === tr.id;
    const loadF = Math.min(1.3, tr.load / LINE_INFO.capacity);
    const late5 = tr.inService && tr.delay > 300;
    const styleKey = `${text}|${chips}|${status}|${sel}|${r.w}|${right}|${Math.round(loadF * 20)}|${tr.inService}|${this.layers.pax}`;
    tg.box.position.set(r.x, r.y);
    if (styleKey === tg.styleKey) return;
    tg.styleKey = styleKey;
    if (tg.text !== text) { tg.text = text; tg.label.text = text; }
    if (tg.chipText !== chips) { tg.chipText = chips; tg.chips.text = chips; }
    tg.label.style.fill = tr.inService ? 0xffffff : C.nonService;
    // the reserved rect includes the direction arrow on the leading side
    const bx = right ? 0 : ARROW;
    const bw = r.w - ARROW;
    tg.label.position.set(bx + 8, r.h / 2);
    tg.chips.position.set(bx + 8 + tg.label.width + 6, r.h / 2);
    tg.chips.style.fill = tr.failed || tr.eb || !tr.comm ? C.fault : tr.manual ? C.trainManual : tr.hold ? C.platformHold : status;
    const g = tg.bg;
    g.clear();
    const fill = late5 ? 0x2a1606 : C.trainBoxFill;
    const border = sel ? C.selection : status === C.onTime ? C.trainBoxBorder : status;
    g.roundRect(bx + 1.5, 1.5, bw - 3, r.h - 3, 4).fill({ color: fill, alpha: 0.95 }).stroke({ width: sel ? 3 : 2, color: border });
    // load bar
    if (this.layers.pax && tr.inService) g.rect(bx + 4, r.h - 6, Math.min(1, loadF / 1.3) * (bw - 8), 3).fill({ color: loadColor(loadF) });
    // direction arrow on the leading side
    const ac = status === C.onTime ? 0x6f8193 : status;
    if (right) g.poly([bw + 1, 10, bw + ARROW - 1, r.h / 2, bw + 1, r.h - 10]).fill({ color: ac });
    else g.poly([ARROW - 1, 10, 1, r.h / 2, ARROW - 1, r.h - 10]).fill({ color: ac });
  }

  private drawSelection() {
    const g = this.selL;
    g.clear();
    const sel = this.store.selection;
    if (!sel) return;
    const { topo, geom } = this;
    const c = C.selection;
    if (sel.kind === 'section') {
      for (const lid of topo.sections[sel.id].links) for (const s of geom.linkSegs(lid)) g.moveTo(s.x1, s.y1).lineTo(s.x2, s.y2);
      g.stroke({ width: 16, color: c, alpha: 0.35 });
    } else if (sel.kind === 'signal') {
      const sg = this.sigGfx[sel.id];
      if (sg) g.circle(sg.x, sg.y, this.mode === 'detail' ? 20 : 14).stroke({ width: 3, color: c });
    } else if (sel.kind === 'switch') {
      for (const n of topo.switches[sel.id].nodes) {
        const p = geom.pos[n];
        if (p) g.circle(p.x, p.y, this.mode === 'detail' ? 26 : 18).stroke({ width: 3, color: c });
      }
    } else if (sel.kind === 'platform') {
      const pg = this.platGfx[sel.id];
      if (pg) g.rect(pg.x - 4, pg.y - 4, pg.w + 8, pg.h + 8).stroke({ width: 3, color: c });
    } else if (sel.kind === 'depot') {
      const yg = this.yardGfx.find((y) => y.depot === sel.id);
      if (yg) g.rect(yg.x - 4, yg.y - 4, yg.w + 8, yg.h + 8).stroke({ width: 3, color: c });
    }
  }

  /** route preview (hovering a route in the command panel / route setting) */
  previewRoute(rid: number | number[] | null, alpha = 0.45) {
    this.preview.clear();
    if (rid === null) return;
    const ids = Array.isArray(rid) ? rid : [rid];
    if (!ids.length) return;
    for (const id of ids) {
      for (const st of this.topo.routes[id].steps) for (const s of this.geom.linkSegs(st.link)) this.preview.moveTo(s.x1, s.y1).lineTo(s.x2, s.y2);
    }
    this.preview.stroke({ width: this.mode === 'detail' ? 18 : 14, color: C.selection, alpha });
  }

  /** all currently visible label rectangles (screen space of the view) */
  labelRects(): { r: Rect; tag: string }[] {
    return this.index.placed.filter((p) => p.tag !== 'obstacle');
  }

  /** world position of a station (for centring) */
  stationPoint(st: number): P {
    const s = this.geom.stationX(st);
    return { row: s.row, x: s.x, y: this.geom.rows[s.row].top + this.L.midY };
  }

  /** world position of a device for alarms → locate */
  devicePoint(sel: Selection): P | null {
    if (!sel) return null;
    const { topo, geom } = this;
    switch (sel.kind) {
      case 'train': {
        const t = this.lastSnap?.trains.find((x) => x.id === sel.id);
        return t ? this.trainPoint(t) : null;
      }
      case 'signal': return geom.pos[topo.signals[sel.id].node];
      case 'switch': return geom.pos[topo.switches[sel.id].nodes[0]];
      case 'section': return geom.linkPoint(topo.sections[sel.id].links[0], 0);
      case 'platform': return this.stationPoint(topo.platforms[sel.id].station);
      case 'depot': return geom.pos[topo.depots[sel.id].gateNode];
      default: return null;
    }
  }
}
