/**
 * Label collision index: a uniform grid of placed rectangles. Every label
 * on the schematic (station names, train windows, device IDs, km posts,
 * badges) is placed through it, so no two labels ever overlap; labels that
 * cannot be placed are hidden (level of detail) or moved (stacking with a
 * leader line).
 */
export interface Rect { x: number; y: number; w: number; h: number }

export interface Leader { x1: number; y1: number; x2: number; y2: number }
export function leaderCrosses(a: Leader, b: Leader): boolean {
  const cross = (x: number, y: number, u: number, v: number) => x * v - y * u;
  const dx = a.x2-a.x1, dy = a.y2-a.y1, ex = b.x2-b.x1, ey = b.y2-b.y1;
  const d = cross(dx,dy,ex,ey);
  if (Math.abs(d) < 1e-6) return false;
  const t = cross(b.x1-a.x1,b.y1-a.y1,ex,ey)/d;
  const u = cross(b.x1-a.x1,b.y1-a.y1,dx,dy)/d;
  return t > 1e-6 && t < 1-1e-6 && u > 1e-6 && u < 1-1e-6;
}
export function leaderHits(l: Leader, r: Rect): boolean {
  let lo = 0, hi = 1;
  for (const [v, d, min, max] of [[l.x1,l.x2-l.x1,r.x-2,r.x+r.w+2],[l.y1,l.y2-l.y1,r.y-2,r.y+r.h+2]]) {
    if (Math.abs(d) < 1e-6) { if (v <= min || v >= max) return false; }
    else { const a=(min-v)/d,b=(max-v)/d; lo=Math.max(lo,Math.min(a,b)); hi=Math.min(hi,Math.max(a,b)); }
  }
  return lo < hi && hi > 0 && lo < 1;
}
/** Widths come from the renderer, including its CJK fallback font. */
export function trainWindowWidth(text: number, chips: number, arrow = 12): number {
  return Math.ceil(text + (chips ? chips + 10 : 0) + 16 + arrow);
}
/** Pure placement: nearest layers first, always within one width of the head.
 * Static text may yield to a train window; windows and leaders never do. */
export function placeTrainLabel(head: {x:number;y:number}, side: 1|-1, width: number,
  placed: {r:Rect;leader:Leader}[], obstacles: Rect[], layers = 8, futureHeads: {x:number;y:number}[] = [], band?: Rect,
  shifts = [0,-.25,.25,-.5,.5,-.75,.75,-1,1]): {r:Rect;leader:Leader}|null {
  const h=40;
  for (let k=0;k<layers;k++) for (const avoidStatic of [true,false]) {
    for (const shift of shifts) {
      const r={x:head.x-width/2+shift*width,y:head.y+side*(14+k*(h+4))-(side<0?h:0),w:width,h};
      if (band) {
        if (width > band.w || h > band.h) continue;
        r.x = Math.max(band.x, Math.min(band.x + band.w - width, r.x));
        r.y = Math.max(band.y, Math.min(band.y + band.h - h, r.y));
      }
      const leader={x1:head.x,y1:head.y,x2:Math.max(r.x+4,Math.min(r.x+r.w-4,head.x)),y2:side>0?r.y:r.y+h};
      const overlap=(o:Rect)=>r.x<o.x+o.w+3&&r.x+r.w+3>o.x&&r.y<o.y+o.h+3&&r.y+r.h+3>o.y;
      if (futureHeads.some(p=>Math.abs(p.y-head.y)<50 && (p.x>r.x-2 && p.x<r.x+r.w+2 || leaderCrosses(leader,{x1:p.x,y1:p.y,x2:p.x,y2:p.y+side*100000})))) continue;
      if (avoidStatic && obstacles.some(overlap)) continue;
      if (placed.some(o=>overlap(o.r)||leaderHits(leader,o.r)||leaderHits(o.leader,r)||leaderCrosses(leader,o.leader))) continue;
      return {r,leader};
    }
  }
  return null;
}

export interface TrainWindowInput { id: number; head: {x:number;y:number}; side: 1|-1; width: number; delay: number }
export interface TrainWindowPlacement { ids: number[]; r: Rect; leader: Leader; text?: string }
export const trainGroupText = (count: number, delay: number) => `+${count} 列 · 最晚 ${Math.ceil(Math.max(0, delay) / 60)}分`;

/** One bounded band, with capacity reserved for the overflow group. Never
 * add more vertical layers to make a queue fit into the next station row. */
export function placeTrainWindows(inputs: TrainWindowInput[], band: Rect, obstacles: Rect[]): TrainWindowPlacement[] {
  const out: TrainWindowPlacement[] = [], hidden: TrainWindowInput[] = [];
  const layers = Math.max(1, Math.ceil(band.h / 44));
  for (const input of inputs) {
    const p = placeTrainLabel(input.head, input.side, input.width, out, obstacles, layers, [], band);
    if (p) out.push({ ...p, ids: [input.id] }); else hidden.push(input);
  }
  while (hidden.length) {
    hidden.sort((a,b)=>inputs.indexOf(a)-inputs.indexOf(b));
    const head = { x: hidden.reduce((n, t) => n + t.head.x, 0) / hidden.length, y: hidden[0].head.y };
    const text = trainGroupText(hidden.length, Math.max(...hidden.map(t => t.delay)));
    const width = textWidth(text, 24) + 24;
    const p = placeTrainLabel(head, hidden[0].side, width, out, obstacles, layers, [], band);
    if (p) { out.push({ ...p, ids: hidden.map(t => t.id), text }); break; }
    // A dense queue can fan out to both sides of one head. Reposition the
    // first individual window before falling back to a group for everyone.
    if (out.length === 1) {
      const first = inputs.find(t => t.id === out[0].ids[0])!;
      for (const shift of [-1,1,-.75,.75,-.5,.5]) {
        const solo = placeTrainLabel(first.head,first.side,first.width,[],obstacles,layers,[],band,[shift]);
        if (!solo) continue;
        const rest = placeTrainLabel(head,hidden[0].side,width,[solo],obstacles,layers,[],band);
        if (rest) return [{...solo,ids:[first.id]},{...rest,ids:hidden.map(t=>t.id),text}];
      }
    }
    const last = out.pop();
    if (!last) break; // a clipped/off-screen band has no room for even one window
    hidden.unshift(inputs.find(t => t.id === last.ids[0])!);
  }
  return out;
}

export class LabelIndex {
  private cell: number;
  private grid = new Map<number, Rect[]>();
  /** every placed rectangle (debug / overlap checks) */
  placed: { r: Rect; tag: string }[] = [];

  constructor(cell = 128) {
    this.cell = cell;
  }

  clear() {
    this.grid.clear();
    this.placed = [];
  }

  private keys(r: Rect): number[] {
    const c = this.cell;
    const out: number[] = [];
    const x0 = Math.floor(r.x / c);
    const x1 = Math.floor((r.x + r.w) / c);
    const y0 = Math.floor(r.y / c);
    const y1 = Math.floor((r.y + r.h) / c);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push((x + 4096) * 8192 + (y + 4096));
    return out;
  }

  /** true if r intersects any placed rectangle (with a gap) */
  hits(r: Rect, gap = 2): boolean {
    for (const k of this.keys(r)) {
      const arr = this.grid.get(k);
      if (!arr) continue;
      for (const o of arr) {
        if (r.x < o.x + o.w + gap && r.x + r.w + gap > o.x && r.y < o.y + o.h + gap && r.y + r.h + gap > o.y) return true;
      }
    }
    return false;
  }

  add(r: Rect, tag = '') {
    for (const k of this.keys(r)) {
      let arr = this.grid.get(k);
      if (!arr) { arr = []; this.grid.set(k, arr); }
      arr.push(r);
    }
    this.placed.push({ r, tag });
  }

  /** place at the first free candidate; returns the chosen rectangle or null */
  tryPlace(cands: Rect[], tag = '', gap = 2): Rect | null {
    for (const c of cands) {
      if (!this.hits(c, gap)) {
        this.add(c, tag);
        return c;
      }
    }
    return null;
  }
}

/** text width estimate for layout (CJK full-width, Latin/digits ~0.6 em in mono, 0.55 em proportional) */
export function textWidth(s: string, size: number, mono = false): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x2e80) w += size;
    else if (ch === '·') w += size * 0.5;
    else w += size * (mono ? 0.6 : 0.56);
  }
  return Math.ceil(w);
}

/** list of overlapping pairs among placed rectangles (used by the automated overlap check) */
export function overlaps(rects: { r: Rect; tag: string }[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i].r;
      const b = rects[j].r;
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) out.push([rects[i].tag, rects[j].tag]);
    }
  }
  return out;
}
