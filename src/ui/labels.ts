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
      // (leaders fanning out of one queue start a few pixels apart: their
      // crossing right at the heads is invisible and is not a conflict)
      const fan=(o:Leader)=>Math.hypot(o.x1-leader.x1,o.y1-leader.y1)<6;
      if (placed.some(o=>overlap(o.r)||leaderHits(leader,o.r)||leaderHits(o.leader,r)||!fan(o.leader)&&leaderCrosses(leader,o.leader))) continue;
      return {r,leader};
    }
  }
  return null;
}

/** Lateness shown on a window: beyond this a train is no longer on time (图例「正点≤2分」). */
export const LATE_SHOWN_S = 120;
export const lateText = (delay: number) => delay > LATE_SHOWN_S ? `+${Math.floor(delay / 60)}'` : '';

/** `delay` is service lateness (0 out of service). `keep`: an abnormal or
 * selected train whose number must stay visible, never folded into a group. */
export interface TrainWindowInput { id: number; head: {x:number;y:number}; side: 1|-1; width: number; delay: number; keep?: boolean;
  /** width with the trip number alone (no 表号), used where windows collide */
  compactWidth?: number;
  /** the trip number, written on a group of this train alone */
  trip?: string }
export interface TrainWindowPlacement { ids: number[]; r: Rect; leader: Leader; text?: string; compact?: boolean }
export const trainGroupText = (count: number, delay: number) =>
  `+${count} 列${delay > LATE_SHOWN_S ? ` · 最晚 ${Math.floor(delay / 60)}分` : ''}`;

/** One bounded band, with capacity reserved for the overflow group. Never
 * add more vertical layers to make a queue fit into the next station row.
 * Abnormal trains claim their windows first. Where windows collide, the
 * normal trains of that spot show the trip number alone (no 表号); only what
 * still does not fit is folded into a group next to its trains. The rest of
 * the view keeps full windows, so a passing crowd does not flip the picture. */
export function placeTrainWindows(inputs: TrainWindowInput[], band: Rect, obstacles: Rect[]): TrainWindowPlacement[] {
  const out: TrainWindowPlacement[] = [], hidden: TrainWindowInput[] = [];
  const layers = Math.max(1, Math.ceil(band.h / 44));
  const byId = new Map(inputs.map(t => [t.id, t]));
  const short = new Set<number>();
  const width = (t: TrainWindowInput) => short.has(t.id) ? t.compactWidth! : t.width;
  const place = (t: TrainWindowInput, shifts?: number[]) => {
    const p = placeTrainLabel(t.head, t.side, width(t), out, obstacles, layers, [], band, shifts);
    if (p) out.push({ ...p, ids: [t.id] });
    return !!p;
  };
  for (const t of [...inputs.filter(t => t.keep), ...inputs.filter(t => !t.keep)]) if (!place(t)) hidden.push(t);
  const clusters: TrainWindowInput[][] = [];
  for (const t of hidden.sort((a, b) => a.head.x - b.head.x)) {
    const last = clusters.at(-1)?.at(-1);
    if (last && t.head.x - last.head.x <= Math.max(width(t), width(last))) clusters.at(-1)!.push(t);
    else clusters.push([t]);
  }
  const group = (c: TrainWindowInput[]) => {
    const cx = c.reduce((n, t) => n + t.head.x, 0) / c.length;
    // a "group" of one names its train: no narrower than "+1 列", and says more
    const text = c.length === 1 && c[0].trip ? c[0].trip + lateText(c[0].delay) : trainGroupText(c.length, Math.max(...c.map(t => t.delay)));
    const p = placeTrainLabel({ x: cx, y: c[0].head.y }, c[0].side, textWidth(text, 24) + 24, out, obstacles, layers, [], band);
    return p && { ...p, ids: c.map(t => t.id), text };
  };
  while (clusters.length) {
    const c = clusters.shift()!;
    // Lift the windows around the spot and lay the spot out again.
    const cx = c.reduce((n, t) => n + t.head.x, 0) / c.length;
    const reach = 2 * Math.max(...c.map(t => t.width));
    const dist = (x: number) => Math.abs(x - cx);
    let lifted = out.filter(o => dist(o.r.x + o.r.w / 2) <= reach);
    // nothing close: the nearest window anywhere (a clipped band may hold none)
    if (!lifted.length && out.length) lifted = [out.reduce((a, b) => dist(a.r.x + a.r.w / 2) <= dist(b.r.x + b.r.w / 2) ? a : b)];
    for (const o of lifted) out.splice(out.indexOf(o), 1);
    const members = [...new Map([...c, ...lifted.flatMap(o => o.ids.map(id => byId.get(id)!))].map(t => [t.id, t])).values()]
      // abnormal first, then nearest
      .sort((a, b) => Number(!!b.keep) - Number(!!a.keep) || dist(a.head.x) - dist(b.head.x));
    for (const t of members) if (!t.keep && t.compactWidth) short.add(t.id);
    const base = out.length;
    // first: every train of the spot in its own (compact) window
    if (members.every(t => place(t))) continue;
    out.length = base;
    // then keep as many as still leave room for a group of the rest
    // (a queue on one head: kept windows step aside so the group can sit over it)
    let done = false;
    for (let k = members.length - 1; k >= 0 && !done; k--) for (const shifts of [undefined, [-1, 1, -.75, .75, -.5, .5]]) {
      if (done) break;
      const fold = members.slice(k);
      for (const t of members.slice(0, k)) if (!place(t, shifts)) fold.push(t);
      const g = group(fold);
      if (g) { out.push(g); done = true; } else out.length = base;
    }
    if (!done) { if (!lifted.length) break; clusters.unshift(members); }
  }
  return out.map(o => !o.text && short.has(o.ids[0]) ? { ...o, compact: true } : o);
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
