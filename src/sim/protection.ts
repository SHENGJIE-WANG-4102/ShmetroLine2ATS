/** Shared boundary for accepting a more restrictive movement authority. */
import { PERF } from './dynamics';
import type { Sim } from './engine';
import type { Train } from './model';
import { nextLink, linkChain } from './topology';
import { swPos } from './interlocking';
import { brakingSpeedH, chainSense, G, heightAt, profileOf } from './gradient';

export type RestrictionBrake = 'supervision' | 'emergency';

/** Signal stopping target, measured from the signal towards the approaching train. */
export const SIGNAL_MARGIN = 6;

/** Both brake classes use the same target and zero additional distance margin. */
export const restrictionDistance = (speed: number, brake: RestrictionBrake = 'emergency') =>
  speed * speed / (2 * (brake === 'supervision' ? PERF.bPermit : PERF.bEbGuaranteed));

export function canAcceptRestriction(speed: number, targetDistance: number, brake: RestrictionBrake = 'emergency', rise = 0): boolean {
  return speed <= brakingSpeedH(Math.max(0, targetDistance), 0,
    brake === 'supervision' ? PERF.bPermit : PERF.bEbGuaranteed, rise);
}

export const signalStopDistance = (distance: number) => Math.max(0, distance - SIGNAL_MARGIN);

/** Restricting a signal beyond the braking horizon is safe. Walk the real
 * lined path only as far as that horizon, including closely spaced signals. */
export function canStopBeforeSignal(sim: Sim, tr: Train, signal: number, brake: RestrictionBrake): boolean {
  const profile = profileOf(sim.topo), head = linkChain(sim.topo, tr.link, tr.off);
  const sense = chainSense(sim.topo, tr.link, tr.dir), h0 = heightAt(profile, head);
  // A downhill target can bind beyond the flat-track stopping distance. The
  // lowest profile height gives a conservative search bound, not a new MA cap.
  const drop = brake === 'supervision' && sense ? Math.max(0, h0 - Math.min(...profile.h)) : 0;
  const horizon = restrictionDistance(tr.v, brake) + SIGNAL_MARGIN + G * drop / PERF.bPermit;
  let link = tr.link, dir = tr.dir;
  let distance = dir === 1 ? sim.topo.links[link].len - tr.off : tr.off;
  for (let i = 0; i < 120 && distance <= horizon; i++) {
    const nx = nextLink(sim.topo, link, dir, sw => swPos(sim, sw));
    if (!nx) break;
    const at = sim.topo.signalByEntry.get(nx.node * 65536 + nx.link);
    if (at === signal) {
      const target = signalStopDistance(distance);
      const rise = brake === 'supervision' && sense ? heightAt(profile, head + sense * target) - h0 : 0;
      return canAcceptRestriction(tr.v, target, brake, rise);
    }
    link = nx.link; dir = nx.dir; distance += sim.topo.links[link].len;
  }
  return true;
}
