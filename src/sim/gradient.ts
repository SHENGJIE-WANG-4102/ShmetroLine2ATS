/**
 * Vertical profile (纵断面) of the line, D65. No profile of Line 2 is public,
 * so it is generated from the design code (GB 50157《地铁设计规范》) and a
 * few anchor assumptions 【假设】:
 *  - underground stations sit on a level stretch (the code allows ≤ 2‰) at
 *    about 14 m rail depth, deeper at the big interchanges and by the river;
 *  - between them the energy-saving profile (节能坡): leaving a station the
 *    line falls at 24‰ (code maximum 30‰), runs a shallow 3‰ V (drainage) and
 *    climbs at 24‰ into the next station; the dip grows with the distance;
 *  - the 黄浦江 crossing (南京东路—陆家嘴) dives to about 34 m at the
 *    river's middle on ≈27‰ grades;
 *  - the historical D65 calibration uses a K37.4 elevation anchor and a
 *    K60.9 ground anchor, with 12 m high points and gentle 10‰ dips. These
 *    synthetic anchors are retained independently of the corrected tunnel
 *    portals; they are not evidence of the real surface/underground boundary.
 * Heights are rail level relative to the ground (m). Gravity acts on the
 * whole train: the mean grade under its length.
 */
import type { Topology, Dir } from './topology';
import { linkChain } from './topology';
import { PROFILE_ANCHORS, LINE_INFO } from '../data/line2';

export const G = 9.81;

/** rail depth of the underground stations by name (m below ground), others STATION_DEPTH */
const DEPTH: Record<string, number> = {
  虹桥火车站: 18, 人民广场: 16, 南京东路: 18, 陆家嘴: 19, 世纪大道: 17, 龙阳路: 15,
};
const STATION_DEPTH = 14;
const ELEVATED = 12;
const GROUND = 1;
/** level stretch either side of a station centre (half platform plus run-off, m) */
const FLAT = 115;
const RAMP = 0.024;
const VALLEY = 0.003;
const MAX_DIP = 9;
/** the river crossing: lowest rail level and where it is */
const RIVER = { from: '南京东路', to: '陆家嘴', depth: 34, grade: 0.027 };

export interface Profile { ch: number[]; h: number[] }

const cache = new WeakMap<Topology, Profile>();

export function profileOf(topo: Topology): Profile {
  let p = cache.get(topo);
  if (!p) { p = buildProfile(topo); cache.set(topo, p); }
  return p;
}

function buildProfile(topo: Topology): Profile {
  const {elevatedFrom:elevFrom,groundFrom}=PROFILE_ANCHORS;
  const sts = topo.stations.map((s) => ({ name: s.name, chain: s.chain }));
  const levelOf = (s: { name: string; chain: number }) =>
    s.chain >= groundFrom ? GROUND : s.chain >= elevFrom - FLAT ? ELEVATED : -(DEPTH[s.name] ?? STATION_DEPTH);
  const pts: [number, number][] = [];
  const add = (c: number, h: number) => { if (!pts.length || c > pts[pts.length - 1][0] + 0.5) pts.push([c, h]); };
  add(sts[0].chain - 2000, levelOf(sts[0]));
  for (let i = 0; i < sts.length; i++) {
    const s = sts[i];
    const h0 = levelOf(s);
    add(s.chain - FLAT, h0);
    add(s.chain + FLAT, h0);
    const n = sts[i + 1];
    if (!n) break;
    const h1 = levelOf(n);
    const a = s.chain + FLAT, b = n.chain - FLAT;
    const L = b - a;
    if (s.name === RIVER.from && n.name === RIVER.to) {
      const low = -RIVER.depth;
      const da = (h0 - low) / RIVER.grade, db = (h1 - low) / RIVER.grade;
      add(a + da, low);
      add(b - db, low);
      continue;
    }
    if (h0 < 0 && h1 > 0) {
      // out of the tunnel onto the viaduct: one climb ending before the exposed section
      const top = Math.min(b, elevFrom - 50);
      const climb = (h1 - h0) / 0.03;
      add(Math.max(a, top - climb), h0);
      add(top, h1);
      continue;
    }
    if (h0 > 0 && h1 > 0 && h1 < h0) {
      // down from the viaduct to the ground at the airport
      const down = Math.min(L, (h0 - h1) / 0.012);
      add(Math.max(a, groundFrom - down), h0);
      add(Math.min(b, groundFrom), h1);
      continue;
    }
    // energy-saving dip: down at RAMP, a shallow V, up at RAMP
    const elevated = h0 > 0;
    const grade = elevated ? 0.01 : RAMP;
    const dip = elevated ? Math.min(3, L * 0.002) : Math.min(MAX_DIP, L * 0.006);
    const lowA = Math.min(h0, h1) - dip;
    const da = (h0 - lowA) / grade, db = (h1 - lowA) / grade;
    if (da + db >= L) { add((a + b) / 2, (h0 + h1) / 2); continue; }
    const mid = (a + da + b - db) / 2;
    // (the viaduct drains on its own: no valley)
    const vDepth = elevated ? 0 : VALLEY * (b - db - (a + da)) / 2;
    add(a + da, lowA);
    add(mid, lowA - vDepth);
    add(b - db, lowA);
  }
  const last = sts[sts.length - 1];
  add(last.chain + 2000, levelOf(last));
  return { ch: pts.map((p) => p[0]), h: pts.map((p) => p[1]) };
}

/** rail level at a chainage (m) */
export function heightAt(p: Profile, c: number): number {
  const { ch, h } = p;
  if (c <= ch[0]) return h[0];
  if (c >= ch[ch.length - 1]) return h[h.length - 1];
  let lo = 0, hi = ch.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ch[m] <= c) lo = m; else hi = m; }
  return h[lo] + (h[hi] - h[lo]) * (c - ch[lo]) / (ch[hi] - ch[lo]);
}

/** +1 when travel on the link at `dir` increases the chainage, -1 when it decreases, 0 off the chainage axis */
export function chainSense(topo: Topology, link: number, dir: Dir): number {
  const l = topo.links[link];
  return Math.sign(l.chainB - l.chainA) * dir;
}

/** gravity along the travel of a train whose head is at `head` (chainage), moving with chainage sense `s` */
export function gradeAccelAt(p: Profile, head: number, s: number, len = LINE_INFO.trainLength): number {
  if (!s) return 0;
  return -G * (heightAt(p, head) - heightAt(p, head - s * len)) / len;
}

/** grade under the head in the direction of travel (‰, + = climbing) */
export function gradePermille(topo: Topology, link: number, off: number, dir: Dir): number {
  const s = chainSense(topo, link, dir);
  if (!s) return 0;
  const p = profileOf(topo), c = linkChain(topo, link, off);
  return Math.round((heightAt(p, c + s * 10) - heightAt(p, c - s * 10)) / 20 * 1000);
}

/**
 * Speed allowed now to come down to `vEnd` at a point `d` ahead that lies
 * `dh` metres higher (negative: lower), braking at `b` plus gravity: the
 * energy balance ½v² = ½vEnd² + b·d + g·dh.
 */
export function brakingSpeedH(d: number, vEnd: number, b: number, dh: number): number {
  if (d <= 0) return vEnd;
  return Math.sqrt(Math.max(vEnd * vEnd, vEnd * vEnd + 2 * b * d + 2 * G * dh));
}
