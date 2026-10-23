/**
 * Wheel-rail adhesion in the rain (D66). Underground the rail stays dry; on
 * the exposed east section (EXPOSED) rain wets it, and it stays wet for a
 * while after the rain stops. Wet adhesion falls with speed; a few slippery
 * spots (leaves, oil, rust film) halve it again. The train cannot put more
 * effort through the wheels than the adhesion allows: in traction the
 * anti-slip control and in braking the wheel slide protection (WSP) hold it
 * just under the limit, so the train accelerates and brakes less than asked
 * and can slide past its stopping point. The emergency brake sands the rail
 * and is not limited. All figures are 【假设】 (typical wet-rail values).
 *
 * The dispatcher can put the line in low-adhesion mode (低粘着模式): ATO
 * then plans its braking at LOW_ADH_BPLAN instead of PERF.bPlan and keeps the
 * traction down, which costs running time but rarely reaches the limit.
 */
import type { Sim } from './engine';
import type { Train } from './model';
import { G } from './gradient';
import { linkChain } from './topology';
import { EXPOSED, LINE_INFO } from '../data/current';

/** wet-rail adhesion at standstill, and its fall with speed: μ(v) = MU0 / (1 + MU_FALL·km/h) */
const MU0 = 0.15;
const MU_FALL = 0.012;
/** adhesion on a slippery spot, as a share of the wet value */
const SLICK = 0.45;
/** share of the train weight on motored axles (6M2T): the traction limit */
const MOTORED = 0.75;
/** WSP / anti-slip keep the effort a little under the limit while they cycle */
const CONTROL = 0.9;
/** the rail stays wet this long after the rain (s) */
export const DRY_AFTER = 20 * 60;
/** ATO braking plan in low-adhesion mode (m/s²) */
export const LOW_ADH_BPLAN = 0.55;
/** traction share used in low-adhesion mode */
export const LOW_ADH_TRACTION = 0.7;

export function railWet(sim: Sim): boolean {
  return sim.env.rain || sim.t < (sim.env.dryAt ?? 0);
}

/**
 * Slippery spots for a new spell of rain: a few patches anywhere on each
 * exposed main track, and as many on station approaches, where trains brake
 * and stand and the rail is dirtiest (oil, brake dust).
 */
export function scatterSlick(sim: Sim) {
  const out: { track: string; from: number; to: number }[] = [];
  const half = LINE_INFO.trainLength / 2;
  const exposed = (c: number) => EXPOSED.some((e) => c >= e.from && c < e.to);
  const stops = sim.topo.stations.map((s) => s.chain).filter(exposed);
  for (const track of ['DN', 'UP']) {
    // DN runs with the chainage, UP against it
    const sgn = track === 'DN' ? 1 : -1;
    for (const e of EXPOSED) {
      const n = Math.round((e.to - e.from) / 7000);
      for (let i = 0; i < n; i++) {
        const from = e.from + sim.rng() * (e.to - e.from - 100);
        out.push({ track, from, to: from + 40 + sim.rng() * 60 });
      }
    }
    for (const c of stops) {
      if (sim.rng() > 0.35) continue;
      // the braking stretch 50–170 m before the stopping point
      const stop = c + sgn * half;
      const near = 50 + sim.rng() * 40, far = near + 50 + sim.rng() * 30;
      const a = stop - sgn * far, b = stop - sgn * near;
      out.push({ track, from: Math.min(a, b), to: Math.max(a, b) });
    }
  }
  sim.env.slick = out;
}

/**
 * The most acceleration (traction) and deceleration (braking) the wheels can
 * transmit at the train's position (m/s², Infinity on dry rail), and whether
 * the head is on the exposed section (where low-adhesion mode applies).
 */
export function adhesionLimit(sim: Sim, tr: Train): { trac: number; brake: number; slick: boolean; exposed: boolean } {
  const l = sim.topo.links[tr.link];
  if (l.track !== 'DN' && l.track !== 'UP') return NONE;
  const c = linkChain(sim.topo, tr.link, tr.off);
  if (!EXPOSED.some((e) => c >= e.from && c < e.to)) return NONE;
  if (!railWet(sim)) return DRY;
  let mu = MU0 / (1 + MU_FALL * tr.v * 3.6);
  const slick = (sim.env.slick ?? []).some((s) => s.track === l.track && c >= s.from && c < s.to);
  if (slick) mu *= SLICK;
  return { trac: G * mu * MOTORED * CONTROL, brake: G * mu * CONTROL, slick, exposed: true };
}
const NONE = { trac: Infinity, brake: Infinity, slick: false, exposed: false };
const DRY = { trac: Infinity, brake: Infinity, slick: false, exposed: true };
