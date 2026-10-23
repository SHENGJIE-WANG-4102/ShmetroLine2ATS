import type { SoundClip } from '../../types';
export type { SoundKind, SoundDirection, AnnouncementDoorSide, SoundClip } from '../../types';
import { ONBOARD_RENDER_BANK, FIELD_1016_TERMINAL_CLIP, ONBOARD_HOLD_CLIP } from './onboardbank';
import { DOOR_BANK } from './doorbank';
export { ONBOARD_ANNOUNCEMENTS, ONBOARD_NEXT_DELAY_S, ONBOARD_ARRIVAL_ADVANCE_S, ONBOARD_HOLD_CLIP, ONBOARD_HOLD_DELAY_S, ONBOARD_HOLD_REPEAT_S } from './onboardbank';
export type { OnboardAnnouncement } from './onboardbank';
/** Local recordings only; files are not distributed with the repository (D71).
 * Cut ranges are seconds in the original WAV; anchors are seconds in the clip.
 * Speech boundaries come from local word timing + spectral pauses; no passenger
 * transcript is stored here. 【假设】 platform anchors use spectral endpoints,
 * with about 1 s uncertainty; overlapping sides are retained explicitly.
 * 【假设】 platform motion/ambience/templates are reused at underground stations.
 * Interior names remain specific to the recorded station and direction.
 */


/** Audio door wording; B is both sides, independent of the physical snapshot. */


export const SOUNDBANK_DIRECTORY = 'sounds/field-20261014';
/** D71: source PA references. One constant gain preserves on-site balance.
 * 【假设】 -16 LUFS nominal, with common source headroom if needed. */
export const SOURCE_GAIN_REFERENCES = [
  { source: 'platform-01', range: [10.78, 25.04], targetLUFS: -16 },
  { source: 'platform-03', range: [15.40, 18.62], targetLUFS: -16 },
  { source: 'ride-east', range: [17.16, 49.50], targetLUFS: -16 },
  { source: 'ride-west', range: [11.60, 38.20], targetLUFS: -16 },
] as const;
export const SOUND_BANK: readonly SoundClip[] = [
  { id: 'arrive-dn', file: 'arrive-dn.mp3', kind: 'arrive', station: '江苏路', direction: 'DN', side: 'east', source: 'platform-03', range: [26, 42], stopAt: 14, anchorErrorS: 1, both: false, confidence: 'medium' },
  { id: 'arrive-up', file: 'arrive-up.mp3', kind: 'arrive', station: '江苏路', direction: 'UP', side: 'west', source: 'platform-01', range: [8, 25.10], stopAt: 24, anchorAfterTail: true, fadeOutS: .4, voiceRange: [10.78, 24.65], anchorErrorS: 1, embeddedDestination: '蟠祥路·国家会计学院', both: false, confidence: 'medium' },
  { id: 'arrive-both', file: 'arrive-both.mp3', kind: 'arrive', station: '江苏路', direction: 'UP', side: 'both', source: 'platform-01', range: [8, 68], stopAt: 24, otherAt: 54, voiceRange: [10.78, 25.04], anchorErrorS: 1, embeddedDestination: '蟠祥路·国家会计学院', both: true, confidence: 'medium' },
  { id: 'depart-dn', file: 'depart-dn.mp3', kind: 'depart', station: '江苏路', direction: 'DN', side: 'east', source: 'platform-01', range: [109, 133.32], startAt: 1, anchorErrorS: 1, both: false, confidence: 'medium', truncatedTail: true },
  { id: 'depart-both', file: 'depart-both.mp3', kind: 'depart', station: '江苏路', direction: 'UP', side: 'both', source: 'platform-03', range: [72.5, 109.96], startAt: 1, otherAt: 13, anchorErrorS: 1, both: true, confidence: 'medium', truncatedTail: true },
  { id: 'ambience', file: 'ambience.mp3', kind: 'ambience', station: '江苏路', direction: 'shared', side: 'shared', source: 'platform-03', range: [58.5, 70.5], loopCrossfadeS: 1, both: false, confidence: 'medium' },
  { id: 'platform-prefix', file: 'platform-prefix.mp3', kind: 'prefix', station: '江苏路', direction: 'UP', side: 'west', source: 'platform-01', range: [10.65, 16.05], voiceRange: [10.78, 16.05], advanceS: 21.35, anchorErrorS: 1, both: false, confidence: 'medium' },
  { id: 'platform-name-pxl', file: 'platform-name-pxl.mp3', kind: 'station-name', station: '江苏路', direction: 'UP', side: 'west', source: 'platform-01', range: [16.05, 18.53], voiceRange: [16.05, 18.53], name: '蟠祥路·国家会计学院', both: false, confidence: 'high' },
  { id: 'platform-suffix', file: 'platform-suffix.mp3', kind: 'suffix', station: '江苏路', direction: 'UP', side: 'west', source: 'platform-01', range: [18.53, 25.10], voiceRange: [18.88, 25.04], both: false, confidence: 'medium' },
  { id: 'platform-close', file: 'platform-close.mp3', kind: 'close', station: '江苏路', direction: 'shared', side: 'shared', source: 'platform-03', range: [15.35, 18.80], voiceRange: [15.54, 18.62], both: false, confidence: 'high' },
  ...ONBOARD_RENDER_BANK,
  FIELD_1016_TERMINAL_CLIP,
  ONBOARD_HOLD_CLIP,
  ...DOOR_BANK,
  {"id":"onboard-rolling","file":"onboard-rolling.mp3","kind":"interior-rolling","station":"浦东南路","direction":"shared","side":"shared","source":"ride-east","range":[947,963],"loopCrossfadeS":1,"effects":"rolling-noise","both":false,"confidence":"medium"},
  {"id":"onboard-idle","file":"onboard-idle.mp3","kind":"interior-idle","station":"静安寺","direction":"shared","side":"shared","source":"ride-east","range":[134,146],"loopCrossfadeS":1,"effects":"cabin-floor","both":false,"confidence":"medium"},
];

export { clipDuration } from '../../audioUtils';

