/** Shared boundary for accepting a more restrictive movement authority. */
import { PERF } from './dynamics';
import type { Sim } from './engine';
import type { Train } from './model';
import { nextLink, linkChain, type Topology, type TrackPoint } from './topology';
import { swPos } from './interlocking';
import { brakingSpeedH, chainSense, G, heightAt, profileOf, type Profile } from './gradient';

export type RestrictionBrake = 'supervision' | 'emergency';

/** Signal stopping target, measured from the signal towards the approaching train. */
export const SIGNAL_MARGIN = 6;

/** Both brake classes use the same target and zero additional distance margin. */
export const restrictionDistance = (speed: number, brake: RestrictionBrake = 'emergency') =>
  speed * speed / (2 * (brake === 'supervision' ? PERF.bPermit : PERF.bEbGuaranteed));

export interface RestrictionPosition extends TrackPoint { len: number }

interface RestrictionGeometry {
  profile: Profile;
  integral: number[];
  minimum: number;
  distances: Map<string, number>;
}
const restrictionGeometry = new WeakMap<Topology, RestrictionGeometry>();

function geometry(topo: Topology): RestrictionGeometry {
  let value = restrictionGeometry.get(topo);
  if (!value) {
    const profile = profileOf(topo), integral = [0];
    let minimum = Infinity;
    for (let i = 0; i < profile.ch.length; i++) {
      minimum = Math.min(minimum, profile.h[i]);
      if (i) integral.push(integral[i - 1]
        + (profile.h[i - 1] + profile.h[i]) * (profile.ch[i] - profile.ch[i - 1]) / 2);
    }
    value = { profile, integral, minimum, distances: new Map() };
    restrictionGeometry.set(topo, value);
  }
  return value;
}

/** Exact primitive of the piecewise-linear rail height, including its level ends. */
function heightIntegral(g: RestrictionGeometry, x: number): number {
  const { ch, h } = g.profile, last = ch.length - 1;
  if (x <= ch[0]) return (x - ch[0]) * h[0];
  if (x >= ch[last]) return g.integral[last] + (x - ch[last]) * h[last];
  let lo = 0, hi = last;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ch[mid] <= x) lo = mid; else hi = mid; }
  const dx = x - ch[lo], slope = (h[hi] - h[lo]) / (ch[hi] - ch[lo]);
  return g.integral[lo] + h[lo] * dx + slope * dx * dx / 2;
}

/** First stopping point under the same whole-consist gravity as gradeAccelAt.
 * Work is b*d + g*(meanHeight(d)-meanHeight(0)); a head-only rise can miss
 * the downhill tail. Only immutable profile data and exact geometry/speed
 * queries are cached, never a route, clock, driving mode or admission result. */
export function restrictionDistanceAt(topo: Topology, position: RestrictionPosition, speed: number,
  brake: RestrictionBrake = 'emergency'): number {
  if (speed <= 0) return 0;
  if (!Number.isFinite(speed) || !topo.links[position.link]) return Infinity;
  const sense = chainSense(topo, position.link, position.dir);
  if (!sense) return restrictionDistance(speed, brake);
  const g = geometry(topo), len = Number.isFinite(position.len) ? Math.max(0, position.len) : 0;
  const key = `${position.link}/${position.off}/${position.dir}/${len}/${speed}/${brake}`;
  const cached = g.distances.get(key);
  if (cached !== undefined) return cached;
  const head = linkChain(topo, position.link, position.off), rear = head - sense * len;
  const meanHeight = (x: number) => len > 0
    ? (heightIntegral(g, Math.max(x, x - sense * len)) - heightIntegral(g, Math.min(x, x - sense * len))) / len
    : heightAt(g.profile, x);
  const initialHeight = meanHeight(head), kinetic = speed * speed / 2;
  const b = brake === 'supervision' ? PERF.bPermit : PERF.bEbGuaranteed;
  const work = (d: number) => b * d + G * (meanHeight(head + sense * d) - initialHeight);
  // The whole train's mean can never be below the profile minimum. This is
  // a root-search bound, not an extra stopping margin or an MA extension.
  let upper = (kinetic + G * Math.max(0, initialHeight - g.minimum)) / b;
  for (let i = 0; i < 8 && work(upper) < kinetic; i++) upper = upper * 2 + 1;
  if (!Number.isFinite(upper) || work(upper) < kinetic) return Infinity;
  const cuts = [0, upper];
  for (const x of g.profile.ch) {
    const h = (x - head) / sense, r = (x - rear) / sense;
    if (h > 0 && h < upper) cuts.push(h);
    if (len > 0 && r > 0 && r < upper) cuts.push(r);
  }
  cuts.sort((a, b) => a - b);
  const derivative = (d: number) => len > 0
    ? b + G * (heightAt(g.profile, head + sense * d) - heightAt(g.profile, rear + sense * d)) / len
    : b;
  const root = (lo: number, hi: number) => {
    // Return the safe side of a bracket; sub-micrometre resolution is solely
    // numerical, with no new operating distance or integrity tolerance.
    for (let i = 0; i < 48 && hi - lo > 1e-7; i++) {
      const mid = (lo + hi) / 2;
      if (work(mid) >= kinetic) hi = mid; else lo = mid;
    }
    return hi;
  };
  let distance = upper;
  for (let i = 1; i < cuts.length; i++) {
    const lo = cuts[i - 1], hi = cuts[i];
    if (hi <= lo) continue;
    if (work(hi) >= kinetic) { distance = root(lo, hi); break; }
    // Mean height is quadratic between head/tail profile crossings. Check
    // an interior maximum too, so even a non-monotone energy curve uses its
    // first stop rather than an assumed globally monotone binary search.
    const a = derivative(lo), z = derivative(hi);
    if (a > 0 && z < 0) {
      const peak = lo + (hi - lo) * a / (a - z);
      if (work(peak) >= kinetic) { distance = root(lo, peak); break; }
    }
  }
  if (g.distances.size >= 1024) {
    const oldest = g.distances.keys().next().value;
    if (oldest !== undefined) g.distances.delete(oldest);
  }
  g.distances.set(key, distance);
  return distance;
}

export function canAcceptRestriction(speed: number, targetDistance: number, brake: RestrictionBrake = 'emergency', rise = 0): boolean {
  return speed <= brakingSpeedH(Math.max(0, targetDistance), 0,
    brake === 'supervision' ? PERF.bPermit : PERF.bEbGuaranteed, rise);
}

export const signalStopDistance = (distance: number) => Math.max(0, distance - SIGNAL_MARGIN);

/** Restricting a signal beyond the braking horizon is safe. Walk the real
 * lined path only as far as that horizon, including closely spaced signals. */
export function canStopBeforeSignal(sim: Sim, tr: Train, signal: number, brake: RestrictionBrake): boolean {
  const required = restrictionDistanceAt(sim.topo, tr, tr.v, brake);
  const horizon = required + SIGNAL_MARGIN;
  let link = tr.link, dir = tr.dir;
  let distance = dir === 1 ? sim.topo.links[link].len - tr.off : tr.off;
  for (let i = 0; i < 120 && distance <= horizon; i++) {
    const nx = nextLink(sim.topo, link, dir, sw => swPos(sim, sw));
    if (!nx) break;
    const at = sim.topo.signalByEntry.get(nx.node * 65536 + nx.link);
    if (at === signal) {
      const target = signalStopDistance(distance);
      return target >= required;
    }
    link = nx.link; dir = nx.dir; distance += sim.topo.links[link].len;
  }
  return true;
}
