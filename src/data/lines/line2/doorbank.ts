export type {  } from '../../types';
/** D71: recorded warning and mechanism are separate assets. No passenger text.
 * 【假设】 narrow warning bands are isolated; the same bands are rejected from
 * mechanism tracks so concurrent playback does not double the warning.
 * Opening has no reliably independent warning in these recordings: the lock
 * release/clunk belongs to motion, not an invented opening tone.
 */
import type { SoundClip } from './soundbank';
export const DOOR_REFERENCE_TIMING = { openingS: 3, warningToMotionS: 2.7, motionToLockedS: 3 } as const;
export const DOOR_TAKES = [
  { id: 'kjg', station: '上海科技馆', primary: true, open: [1372.16, 1374.90], warn: [1429.10, 1435.35], close: [1431.80, 1435.35], lockedAt: 1434.80, confidence: 'medium' },
  { id: 'jas', station: '静安寺', primary: false, open: [127.46, 130.05], warn: [164.50, 170.70], close: [167.20, 170.70], lockedAt: 170.20, confidence: 'high' },
  { id: 'ljz', station: '陆家嘴', primary: false, open: [846.78, 849.48], warn: [884.12, 890.65], close: [886.82, 890.65], lockedAt: 890.15, confidence: 'medium' },
] as const;
export const DOOR_BANK: readonly SoundClip[] = DOOR_TAKES.flatMap(take => ([
  { kind: 'door-motion-open', range: take.open, effects: undefined },
  { kind: 'door-warn-close', range: take.warn, effects: 'door-warning' },
  { kind: 'door-motion-close', range: take.close, effects: 'door-mechanism' },
] as const).map(part => ({
  id: `${part.kind}-${take.id}`, file: `${part.kind}-${take.id}.mp3`, kind: part.kind,
  station: take.station, direction: 'shared', side: 'shared', source: 'ride-east',
  sourceGain: 'ride-east', range: [...part.range], confidence: take.confidence,
  effects: part.effects, both: false, fadeInS: .04, fadeOutS: .04,
})));
