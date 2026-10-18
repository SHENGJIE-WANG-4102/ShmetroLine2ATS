/** D71: local, bilingual carriage PA. All ranges are original-file seconds.
 * Word timing supplies initial boundaries; extraction snaps them within 15 ms
 * to a quiet zero crossing and joins normalised parts with a 30 ms crossfade.
 * 【假设】 stock carriage PA uses the same recorded voice within each language;
 * User decision: JSL alone borrows its proper name from platform PA. Its EN
 * fallback joins that exact proper name to the recorded English word Road.
 * Empty/missing voice parts suppress that sentence; no generated speech.
 */
import { STATIONS } from './line2';
import type { SoundClip, AnnouncementDoorSide } from './soundbank';
export const VOICE_CROSSFADE_S = .03;
export const RECORDED_VOLUME_GAINS = { small: .6, medium: 1, large: 1.45 } as const;
export type RecordedVolume = keyof typeof RECORDED_VOLUME_GAINS;
export type VoiceLanguage = 'zh' | 'en' | 'bilingual';
export interface VoicePart {
  id: string; language: VoiceLanguage; speaker: 'onboard-zh' | 'onboard-en' | 'recorded-pair' | 'platform-zh';
  role: string; name?: string; source: SoundClip['source']; range: [number, number];
  confidence: SoundClip['confidence']; effects?: 'clean-speech-zh' | 'clean-speech-en'; file?: string;
}
export interface OriginalAnnouncement {
  id: string; station: string; direction: 'DN' | 'UP'; type: 'next' | 'arrived';
  source: SoundClip['source']; recordedDestination: string; range: [number, number];
  confidence: SoundClip['confidence']; doorSide: AnnouncementDoorSide;
  destinationSentence?: [number, number]; destinationName?: [number, number];
  transferRange?: [number, number]; terminalOnly?: boolean;
  recordedDirection?: 'DN' | 'UP';
  delayS?: number | null; advanceS?: number; measuredAdvance?: boolean;
}
export const VOICE_SOURCES = [
  // User-supplied door reference: only the two door-direction sentences.
  { id: 'door-reference', filename: '嘉定北~江苏路车内110561录音.wav', durationS: 2684.84 },
  // User decisions (D89/D90): use the cabin video for BXJ and corrected SHR.
  { id: 'cabin-reference', filename: 'VID_20261016_195626_DOLBY.mp4', durationS: 203.244563 },
  // User-supplied 2025-06-13 cabin video: only the unplanned-stop PA (D102).
  { id: 'hold-reference', filename: 'VID_20250613_141329_DOLBY.mp4', durationS: 28.864 },
] as const;
/** D89/D90: missing western names, terminal sentences and corrected SHR cuts.
 * 【假设】 repeated PA phrases match the stock voice separately
 * in each language; this is an acoustic comparison, not speaker authentication.
 * Every new cut has its own local file, independent of the original WAVs.
 * Chinese BXJ comes from the user-designated cabin video. Any suspected
 * passenger overlap is excluded.
 */
export const FIELD_1016_VOICE_PARTS: readonly VoicePart[] = ([
  { id: 'zh-name-gjh', language: 'zh', speaker: 'onboard-zh', role: 'name', name: '国家会展中心', source: 'ride-1016-west-end', range: [642.28, 644.00], confidence: 'medium' },
  { id: 'en-name-gjh', language: 'en', speaker: 'onboard-en', role: 'name', name: '国家会展中心', source: 'ride-1016-west-end', range: [661.74, 664.88], confidence: 'medium' },
  { id: 'zh-name-hqz', language: 'zh', speaker: 'onboard-zh', role: 'name', name: '虹桥火车站', source: 'ride-1016-west-end', range: [519.36, 520.60], confidence: 'medium' },
  { id: 'en-name-hqz', language: 'en', speaker: 'onboard-en', role: 'name', name: '虹桥火车站', source: 'ride-1016-west-end', range: [548.44, 550.56], confidence: 'medium' },
  { id: 'zh-name-hq2', language: 'zh', speaker: 'onboard-zh', role: 'name', name: '虹桥2号航站楼', source: 'ride-1016-west-end', range: [146.36, 148.20], confidence: 'medium' },
  { id: 'en-name-hq2', language: 'en', speaker: 'onboard-en', role: 'name', name: '虹桥2号航站楼', source: 'ride-1016-west-end', range: [181.56, 184.12], confidence: 'medium' },
  { id: 'zh-name-shr', language: 'zh', speaker: 'onboard-zh', role: 'name', name: '淞虹路', source: 'cabin-reference', range: [179.08, 179.98], confidence: 'medium' },
  { id: 'en-name-shr', language: 'en', speaker: 'onboard-en', role: 'name', name: '淞虹路', source: 'cabin-reference', range: [197.08, 198.20], confidence: 'medium' },
  { id: 'zh-both', language: 'zh', speaker: 'onboard-zh', role: 'both', source: 'ride-1016-east-end', range: [33.16, 34.24], confidence: 'medium' },
  { id: 'en-both', language: 'en', speaker: 'onboard-en', role: 'both', source: 'ride-1016-east-end', range: [59.52, 61.72], confidence: 'medium' },
  { id: 'zh-name-bxj', language: 'zh', speaker: 'onboard-zh', role: 'name', name: '北新泾', source: 'cabin-reference', range: [25.78, 26.84], confidence: 'medium' },
  { id: 'en-name-bxj', language: 'en', speaker: 'onboard-en', role: 'name', name: '北新泾', source: 'ride-1016-east-night', range: [39.70, 41.12], confidence: 'medium' },
  { id: 'zh-name-wnl', language: 'zh', speaker: 'onboard-zh', role: 'name', name: '威宁路', source: 'ride-1016-west-core', range: [173.88, 174.84], confidence: 'medium' },
  { id: 'en-name-wnl', language: 'en', speaker: 'onboard-en', role: 'name', name: '威宁路', source: 'ride-1016-west-core', range: [192.16, 193.28], confidence: 'medium' },
  { id: 'zh-name-lsg', language: 'zh', speaker: 'onboard-zh', role: 'name', name: '娄山关路', source: 'ride-1016-west-core', range: [13.40, 14.56], confidence: 'medium' },
  { id: 'en-name-lsg', language: 'en', speaker: 'onboard-en', role: 'name', name: '娄山关路', source: 'ride-1016-west-core', range: [34.36, 35.92], confidence: 'medium' },
  { id: 'zh-name-zsg', language: 'zh', speaker: 'onboard-zh', role: 'name', name: '中山公园', source: 'ride-1016-east-night', range: [483.60, 484.82], confidence: 'medium' },
  { id: 'en-name-zsg', language: 'en', speaker: 'onboard-en', role: 'name', name: '中山公园', source: 'ride-1016-east-night', range: [504.50, 505.66], confidence: 'medium' },
  { id: 'en-name-pxl', language: 'en', speaker: 'onboard-en', role: 'name', name: '蟠祥路·国家会计学院', source: 'ride-1016-west-end', range: [917.52, 921.84], confidence: 'medium' },
  { id: 'zh-clearout-pxl', language: 'zh', speaker: 'onboard-zh', role: 'clearout', source: 'ride-1016-west-end', range: [912.74, 914.94], confidence: 'medium' },
  { id: 'en-next-terminal-pxl', language: 'en', speaker: 'onboard-en', role: 'terminal-next', source: 'ride-1016-west-end', range: [853.72, 857.04], confidence: 'medium' },
  { id: 'en-arrived-terminal-pxl', language: 'en', speaker: 'onboard-en', role: 'terminal-arrived', source: 'ride-1016-west-end', range: [915.32, 917.24], confidence: 'medium' },
] satisfies VoicePart[]).map(p => ({ ...p, effects: p.language === 'zh' ? 'clean-speech-zh' : 'clean-speech-en', file: `voice-${p.id}.mp3` }));
export const VOICE_PARTS: readonly VoicePart[] = [
  ...FIELD_1016_VOICE_PARTS,
  // 用户决定：江苏路站名借站台录音。【假设】英文用专名江苏 + Road；
  // this is mixed-source pronunciation, not an original English station name.
  { id: 'zh-name-jsl', language: 'zh', speaker: 'platform-zh', role: 'name', name: '江苏路', source: 'platform-01', range: [55.90, 56.78], confidence: 'medium' },
  { id: 'jsl-proper-name', language: 'zh', speaker: 'platform-zh', role: 'proper-name', name: '江苏', source: 'platform-01', range: [55.90, 56.60], confidence: 'medium' },
  { id: 'en-road', language: 'en', speaker: 'onboard-en', role: 'name-suffix', name: 'Road', source: 'ride-west', range: [35.60, 36.16], confidence: 'medium' },
  { id: 'zh-right', language: 'zh', speaker: 'onboard-zh', role: 'right', source: 'door-reference', range: [357.76, 358.94], effects: 'clean-speech-zh', file: 'voice-zh-right.mp3', confidence: 'high' },
  { id: 'en-right', language: 'en', speaker: 'onboard-en', role: 'right', source: 'door-reference', range: [363.40, 365.10], effects: 'clean-speech-en', file: 'voice-en-right.mp3', confidence: 'high' },
  {"id":"zh-name-jas","language":"zh","speaker":"onboard-zh","role":"name","name":"静安寺","source":"ride-east","range":[20.68,21.75],"confidence":"high"},
  {"id":"zh-name-njx","language":"zh","speaker":"onboard-zh","role":"name","name":"南京西路","source":"ride-east","range":[186.7,188.06],"confidence":"high"},
  {"id":"zh-name-rmg","language":"zh","speaker":"onboard-zh","role":"name","name":"人民广场","source":"ride-east","range":[397.72,398.99],"confidence":"high"},
  {"id":"zh-name-njd","language":"zh","speaker":"onboard-zh","role":"name","name":"南京东路","source":"ride-east","range":[564.72,565.88],"confidence":"medium"},
  {"id":"zh-name-ljz","language":"zh","speaker":"onboard-zh","role":"name","name":"陆家嘴","source":"ride-east","range":[715.75,716.95],"confidence":"medium"},
  {"id":"zh-name-pdn","language":"zh","speaker":"onboard-zh","role":"name","name":"浦东南路","source":"ride-east","range":[906.7,908.22],"confidence":"medium"},
  {"id":"zh-name-sjd","language":"zh","speaker":"onboard-zh","role":"name","name":"世纪大道","source":"ride-east","range":[1094.66,1095.68],"confidence":"medium"},
  {"id":"zh-name-kjg","language":"zh","speaker":"onboard-zh","role":"name","name":"上海科技馆","source":"ride-east","range":[1247.7,1249.38],"confidence":"high"},
  {"id":"zh-name-sjg","language":"zh","speaker":"onboard-zh","role":"name","name":"世纪公园","source":"ride-east","range":[1453.68,1455.06],"confidence":"high"},
  {"id":"zh-name-lyl","language":"zh","speaker":"onboard-zh","role":"name","name":"龙阳路","source":"ride-east","range":[1610.7,1611.78],"confidence":"medium"},
  {"id":"zh-name-zjg","language":"zh","speaker":"onboard-zh","role":"name","name":"张江高科","source":"ride-east","range":[1759.64,1760.91],"confidence":"medium"},
  {"id":"zh-name-jkl","language":"zh","speaker":"onboard-zh","role":"name","name":"金科路","source":"ride-west","range":[16.92,17.74],"confidence":"medium"},
  {"id":"zh-name-gll","language":"zh","speaker":"onboard-zh","role":"name","name":"广兰路","source":"ride-east","range":[2160.52,2161.64],"confidence":"medium"},
  {"id":"en-name-jas","language":"en","speaker":"onboard-en","role":"name","name":"静安寺","source":"ride-east","range":[41.98,43.4],"confidence":"medium"},
  {"id":"en-name-njx","language":"en","speaker":"onboard-en","role":"name","name":"南京西路","source":"ride-east","range":[220.82,222.78],"confidence":"medium"},
  {"id":"en-name-rmg","language":"en","speaker":"onboard-en","role":"name","name":"人民广场","source":"ride-east","range":[418.62,419.72],"confidence":"medium"},
  {"id":"en-name-njd","language":"en","speaker":"onboard-en","role":"name","name":"南京东路","source":"ride-east","range":[625.02,627.1],"confidence":"low"},
  {"id":"en-name-ljz","language":"en","speaker":"onboard-en","role":"name","name":"陆家嘴","source":"ride-east","range":[736.04,737.02],"confidence":"medium"},
  {"id":"en-name-pdn","language":"en","speaker":"onboard-en","role":"name","name":"浦东南路","source":"ride-east","range":[925.26,926.92],"confidence":"medium"},
  {"id":"en-name-sjd","language":"en","speaker":"onboard-en","role":"name","name":"世纪大道","source":"ride-east","range":[1116.44,1117.58],"confidence":"medium"},
  {"id":"en-name-kjg","language":"en","speaker":"onboard-en","role":"name","name":"上海科技馆","source":"ride-east","range":[1266.32,1268.67],"confidence":"medium"},
  {"id":"en-name-sjg","language":"en","speaker":"onboard-en","role":"name","name":"世纪公园","source":"ride-east","range":[1472.2,1473.24],"confidence":"medium"},
  {"id":"en-name-lyl","language":"en","speaker":"onboard-en","role":"name","name":"龙阳路","source":"ride-east","range":[1635.74,1637.16],"confidence":"medium"},
  {"id":"en-name-zjg","language":"en","speaker":"onboard-en","role":"name","name":"张江高科","source":"ride-east","range":[1778.02,1780.3],"confidence":"medium"},
  {"id":"en-name-jkl","language":"en","speaker":"onboard-en","role":"name","name":"金科路","source":"ride-west","range":[34.8,36.16],"confidence":"medium"},
  {"id":"en-name-gll","language":"en","speaker":"onboard-en","role":"name","name":"广兰路","source":"ride-east","range":[2180.3,2181.38],"confidence":"medium"},
  {"id":"zh-terminus","language":"zh","speaker":"onboard-zh","role":"terminus","source":"ride-east","range":[17.1,18.98],"confidence":"medium"},
  {"id":"zh-next","language":"zh","speaker":"onboard-zh","role":"next","source":"ride-east","range":[20.02,20.68],"confidence":"medium"},
  {"id":"zh-arrived","language":"zh","speaker":"onboard-zh","role":"arrived","source":"ride-east","range":[1921.38,1922.14],"confidence":"medium"},
  {"id":"zh-left","language":"zh","speaker":"onboard-zh","role":"left","source":"ride-east","range":[21.8,23.02],"confidence":"medium"},
  {"id":"zh-running-safety","language":"zh","speaker":"onboard-zh","role":"safety","source":"ride-east","range":[26.36,40.54],"confidence":"medium"},
  {"id":"zh-arrival-safety","language":"zh","speaker":"onboard-zh","role":"safety","source":"ride-east","range":[818.68,829.66],"confidence":"medium"},
  {"id":"zh-gap","language":"zh","speaker":"onboard-zh","role":"gap","source":"ride-east","range":[822.3,825.46],"confidence":"medium"},
  {"id":"en-next","language":"en","speaker":"onboard-en","role":"next","source":"ride-east","range":[923.54,924.92],"confidence":"medium"},
  {"id":"en-arrived","language":"en","speaker":"onboard-en","role":"arrived","source":"ride-east","range":[814.22,815.36],"confidence":"medium"},
  {"id":"en-left","language":"en","speaker":"onboard-en","role":"left","source":"ride-east","range":[927.12,928.58],"confidence":"medium"},
  {"id":"en-terminal","language":"en","speaker":"onboard-en","role":"terminus","source":"ride-east","range":[2178.58,2179.96],"confidence":"medium"},
  {"id":"zh-name-pxl","language":"zh","speaker":"onboard-zh","role":"name","name":"蟠祥路·国家会计学院","source":"ride-west","range":[13.5,15.96],"confidence":"medium"},
  {"id":"zh-name-pda","language":"zh","speaker":"onboard-zh","role":"name","name":"浦东1号2号航站楼","source":"ride-east","range":[1560.1,1562.48],"confidence":"medium"},
  {"id":"en-name-pda","language":"en","speaker":"onboard-en","role":"name","name":"浦东1号2号航站楼","source":"ride-east","range":[1993.82,1996.92],"confidence":"high"},
  {"id":"original-next-dn-jas","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[17.16,49.5],"confidence":"high"},
  {"id":"original-next-dn-jas-body","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[20.08,49.5],"confidence":"high"},
  {"id":"original-arrived-dn-jas","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[90.88,110.1],"confidence":"medium"},
  {"id":"original-next-dn-njx","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[183.18,240.7],"confidence":"high"},
  {"id":"original-next-dn-njx-body","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[186.26,240.7],"confidence":"high"},
  {"id":"original-arrived-dn-njx","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[266.14,286],"confidence":"medium"},
  {"id":"original-next-dn-rmg","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[394.16,425.2],"confidence":"high"},
  {"id":"original-next-dn-rmg-body","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[397.16,425.2],"confidence":"high"},
  {"id":"original-arrived-dn-rmg","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[467.9,487],"confidence":"low"},
  {"id":"original-next-dn-njd","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[561.16,594],"confidence":"medium"},
  {"id":"original-next-dn-njd-body","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[564.24,594],"confidence":"medium"},
  {"id":"original-arrived-dn-njd","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[621.24,640.4],"confidence":"medium"},
  {"id":"original-next-dn-ljz","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[712.23,741.8],"confidence":"medium"},
  {"id":"original-next-dn-ljz-body","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[715.17,741.8],"confidence":"medium"},
  {"id":"original-arrived-dn-ljz","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[811.12,830],"confidence":"medium"},
  {"id":"original-next-dn-pdn","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[903.12,928.8],"confidence":"medium"},
  {"id":"original-next-dn-pdn-body","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[906.04,928.8],"confidence":"medium"},
  {"id":"original-arrived-dn-pdn","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[974.06,993.6],"confidence":"low"},
  {"id":"original-next-dn-sjd","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[1091.08,1124.3],"confidence":"medium"},
  {"id":"original-next-dn-sjd-body","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[1094.0,1124.3],"confidence":"medium"},
  {"id":"original-arrived-dn-sjd","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[1153.96,1172.9],"confidence":"low"},
  {"id":"original-next-dn-kjg","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[1243.9,1271.1],"confidence":"high"},
  {"id":"original-next-dn-kjg-body","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[1247.0,1271.1],"confidence":"high"},
  {"id":"original-arrived-dn-kjg","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[1336.14,1357.1],"confidence":"high"},
  {"id":"original-next-dn-sjg","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[1450.12,1475.2],"confidence":"high"},
  {"id":"original-next-dn-sjg-body","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[1453.18,1475.2],"confidence":"high"},
  {"id":"original-arrived-dn-sjg","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[1525.96,1583.7],"confidence":"low"},
  {"id":"original-arrived-dn-sjg-body","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[1525.96,1548.85],"confidence":"low"},
  {"id":"original-next-dn-lyl","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[1607.08,1646.2],"confidence":"medium"},
  {"id":"original-next-dn-lyl-body","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[1610.28,1646.2],"confidence":"medium"},
  {"id":"original-arrived-dn-lyl","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[1659.62,1735],"confidence":"low"},
  {"id":"original-arrived-dn-lyl-body","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[1659.62,1702.8],"confidence":"low"},
  {"id":"original-next-dn-zjg","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[1756.1,1782.6],"confidence":"medium"},
  {"id":"original-next-dn-zjg-body","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[1758.96,1782.6],"confidence":"medium"},
  {"id":"original-arrived-dn-zjg","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[1920.0,1997.2],"confidence":"high"},
  {"id":"original-arrived-dn-zjg-body","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[1920.0,1965.6],"confidence":"high"},
  {"id":"original-arrived-dn-jkl","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[2069.1,2125],"confidence":"medium"},
  {"id":"original-arrived-dn-jkl-body","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[2069.1,2088.6],"confidence":"medium"},
  {"id":"original-next-dn-gll","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[2156.14,2183.2],"confidence":"medium"},
  {"id":"original-arrived-dn-gll","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-east","range":[2267.9,2291.4],"confidence":"medium"},
  {"id":"original-next-up-jkl","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-west","range":[11.6,38.2],"confidence":"medium"},
  {"id":"original-next-up-jkl-body","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-west","range":[15.96,38.2],"confidence":"medium"},
  {"id":"original-arrived-up-jkl","language":"bilingual","speaker":"recorded-pair","role":"body","source":"ride-west","range":[111.48,130.2],"confidence":"medium"},
  {"id":"original-next-dn-jas-body-zh","language":"zh","speaker":"onboard-zh","role":"body","source":"ride-east","range":[20.08,40.4],"confidence":"high"},
  {"id":"original-next-dn-jas-body-en","language":"en","speaker":"onboard-en","role":"body","source":"ride-east","range":[40.4,49.5],"confidence":"high"},
  {"id":"original-next-dn-njx-body-zh","language":"zh","speaker":"onboard-zh","role":"body","source":"ride-east","range":[186.26,219.3],"confidence":"high"},
  {"id":"original-next-dn-njx-body-en","language":"en","speaker":"onboard-en","role":"body","source":"ride-east","range":[219.3,240.7],"confidence":"high"},
  {"id":"original-next-dn-rmg-body-zh","language":"zh","speaker":"onboard-zh","role":"body","source":"ride-east","range":[397.16,417],"confidence":"high"},
  {"id":"original-next-dn-rmg-body-en","language":"en","speaker":"onboard-en","role":"body","source":"ride-east","range":[417,425.2],"confidence":"high"},
  {"id":"original-next-dn-njd-body-zh","language":"zh","speaker":"onboard-zh","role":"body","source":"ride-east","range":[564.24,583.4],"confidence":"medium"},
  {"id":"original-next-dn-njd-body-en","language":"en","speaker":"onboard-en","role":"body","source":"ride-east","range":[583.4,594],"confidence":"medium"},
  {"id":"original-next-dn-ljz-body-zh","language":"zh","speaker":"onboard-zh","role":"body","source":"ride-east","range":[715.17,734.2],"confidence":"medium"},
  {"id":"original-next-dn-ljz-body-en","language":"en","speaker":"onboard-en","role":"body","source":"ride-east","range":[734.2,741.8],"confidence":"medium"},
  {"id":"original-next-dn-pdn-body-zh","language":"zh","speaker":"onboard-zh","role":"body","source":"ride-east","range":[906.04,923.6],"confidence":"medium"},
  {"id":"original-next-dn-pdn-body-en","language":"en","speaker":"onboard-en","role":"body","source":"ride-east","range":[923.6,928.8],"confidence":"medium"},
  {"id":"original-next-dn-sjd-body-zh","language":"zh","speaker":"onboard-zh","role":"body","source":"ride-east","range":[1094.0,1114.8],"confidence":"medium"},
  {"id":"original-next-dn-sjd-body-en","language":"en","speaker":"onboard-en","role":"body","source":"ride-east","range":[1114.8,1124.3],"confidence":"medium"},
  {"id":"original-next-dn-kjg-body-zh","language":"zh","speaker":"onboard-zh","role":"body","source":"ride-east","range":[1247.0,1264.5],"confidence":"high"},
  {"id":"original-next-dn-kjg-body-en","language":"en","speaker":"onboard-en","role":"body","source":"ride-east","range":[1264.5,1271.1],"confidence":"high"},
  {"id":"original-next-dn-sjg-body-zh","language":"zh","speaker":"onboard-zh","role":"body","source":"ride-east","range":[1453.18,1469.9],"confidence":"high"},
  {"id":"original-next-dn-sjg-body-en","language":"en","speaker":"onboard-en","role":"body","source":"ride-east","range":[1469.9,1475.2],"confidence":"high"},
  {"id":"original-next-dn-lyl-body-zh","language":"zh","speaker":"onboard-zh","role":"body","source":"ride-east","range":[1610.28,1633.8],"confidence":"medium"},
  {"id":"original-next-dn-lyl-body-en","language":"en","speaker":"onboard-en","role":"body","source":"ride-east","range":[1633.8,1646.2],"confidence":"medium"},
  {"id":"original-next-dn-zjg-body-zh","language":"zh","speaker":"onboard-zh","role":"body","source":"ride-east","range":[1758.96,1776.2],"confidence":"medium"},
  {"id":"original-next-dn-zjg-body-en","language":"en","speaker":"onboard-en","role":"body","source":"ride-east","range":[1776.2,1782.6],"confidence":"medium"},
  {"id":"original-next-up-jkl-body-zh","language":"zh","speaker":"onboard-zh","role":"body","source":"ride-west","range":[15.96,33.3],"confidence":"medium"},
  {"id":"original-next-up-jkl-body-en","language":"en","speaker":"onboard-en","role":"body","source":"ride-west","range":[33.3,38.2],"confidence":"medium"},
  {"id":"en-terminus","language":"en","speaker":"onboard-en","role":"terminus","source":"ride-east","range":[1992.36,1993.88],"confidence":"high"},
];
export const ORIGINAL_ONBOARD: readonly OriginalAnnouncement[] = [
  {"id":"original-next-dn-jas","station":"静安寺","direction":"DN","type":"next","source":"ride-east","recordedDestination":"广兰路","range":[17.16,49.5],"confidence":"high","doorSide":"L","destinationSentence":[17.16,20.08],"destinationName":[18.98,20.08],"delayS":9.16},
  {"id":"original-arrived-dn-jas","station":"静安寺","direction":"DN","type":"arrived","source":"ride-east","recordedDestination":"广兰路","range":[90.88,110.1],"confidence":"medium","doorSide":"L","advanceS":35.12,"measuredAdvance":true},
  {"id":"original-next-dn-njx","station":"南京西路","direction":"DN","type":"next","source":"ride-east","recordedDestination":"广兰路","range":[183.18,240.7],"confidence":"high","doorSide":"L","destinationSentence":[183.18,186.26],"destinationName":[185.16,186.26],"delayS":9.18},
  {"id":"original-arrived-dn-njx","station":"南京西路","direction":"DN","type":"arrived","source":"ride-east","recordedDestination":"广兰路","range":[266.14,286],"confidence":"medium","doorSide":"L","advanceS":32.86,"measuredAdvance":true},
  {"id":"original-next-dn-rmg","station":"人民广场","direction":"DN","type":"next","source":"ride-east","recordedDestination":"广兰路","range":[394.16,425.2],"confidence":"high","doorSide":"L","destinationSentence":[394.16,397.16],"destinationName":[396.06,397.16],"delayS":8.16},
  {"id":"original-arrived-dn-rmg","station":"人民广场","direction":"DN","type":"arrived","source":"ride-east","recordedDestination":"广兰路","range":[467.9,487],"confidence":"low","doorSide":"L","advanceS":32.1,"measuredAdvance":false},
  {"id":"original-next-dn-njd","station":"南京东路","direction":"DN","type":"next","source":"ride-east","recordedDestination":"广兰路","range":[561.16,594],"confidence":"medium","doorSide":"L","destinationSentence":[561.16,564.24],"destinationName":[563.14,564.24],"delayS":8.16},
  {"id":"original-arrived-dn-njd","station":"南京东路","direction":"DN","type":"arrived","source":"ride-east","recordedDestination":"广兰路","range":[621.24,640.4],"confidence":"medium","doorSide":"L","advanceS":37.76,"measuredAdvance":false},
  {"id":"original-next-dn-ljz","station":"陆家嘴","direction":"DN","type":"next","source":"ride-east","recordedDestination":"广兰路","range":[712.23,741.8],"confidence":"medium","doorSide":"L","destinationSentence":[712.23,715.17],"destinationName":[714.07,715.17],"delayS":6.68},
  {"id":"original-arrived-dn-ljz","station":"陆家嘴","direction":"DN","type":"arrived","source":"ride-east","recordedDestination":"广兰路","range":[811.12,830],"confidence":"medium","doorSide":"L","advanceS":34.43,"measuredAdvance":true},
  {"id":"original-next-dn-pdn","station":"浦东南路","direction":"DN","type":"next","source":"ride-east","recordedDestination":"广兰路","range":[903.12,928.8],"confidence":"medium","doorSide":"L","destinationSentence":[903.12,906.04],"destinationName":[904.94,906.04],"delayS":9.12},
  {"id":"original-arrived-dn-pdn","station":"浦东南路","direction":"DN","type":"arrived","source":"ride-east","recordedDestination":"广兰路","range":[974.06,993.6],"confidence":"low","doorSide":"L","advanceS":33.94,"measuredAdvance":false},
  {"id":"original-next-dn-sjd","station":"世纪大道","direction":"DN","type":"next","source":"ride-east","recordedDestination":"广兰路","range":[1091.08,1124.3],"confidence":"medium","doorSide":"L","destinationSentence":[1091.08,1094.0],"destinationName":[1092.9,1094.0],"delayS":8.08},
  {"id":"original-arrived-dn-sjd","station":"世纪大道","direction":"DN","type":"arrived","source":"ride-east","recordedDestination":"广兰路","range":[1153.96,1172.9],"confidence":"low","doorSide":"L","advanceS":14.04,"measuredAdvance":false},
  {"id":"original-next-dn-kjg","station":"上海科技馆","direction":"DN","type":"next","source":"ride-east","recordedDestination":"广兰路","range":[1243.9,1271.1],"confidence":"high","doorSide":"L","destinationSentence":[1243.9,1247.0],"destinationName":[1245.9,1247.0],"delayS":3.9},
  {"id":"original-arrived-dn-kjg","station":"上海科技馆","direction":"DN","type":"arrived","source":"ride-east","recordedDestination":"广兰路","range":[1336.14,1357.1],"confidence":"high","doorSide":"L","advanceS":32.86,"measuredAdvance":true},
  {"id":"original-next-dn-sjg","station":"世纪公园","direction":"DN","type":"next","source":"ride-east","recordedDestination":"广兰路","range":[1450.12,1475.2],"confidence":"high","doorSide":"L","destinationSentence":[1450.12,1453.18],"destinationName":[1452.08,1453.18],"delayS":8.12},
  {"id":"original-arrived-dn-sjg","station":"世纪公园","direction":"DN","type":"arrived","source":"ride-east","recordedDestination":"广兰路","range":[1525.96,1583.7],"confidence":"low","doorSide":"L","advanceS":59.04,"measuredAdvance":false,"transferRange":[1548.85,1583.7]},
  {"id":"original-next-dn-lyl","station":"龙阳路","direction":"DN","type":"next","source":"ride-east","recordedDestination":"广兰路","range":[1607.08,1646.2],"confidence":"medium","doorSide":"L","destinationSentence":[1607.08,1610.28],"destinationName":[1609.18,1610.28],"delayS":7.08},
  {"id":"original-arrived-dn-lyl","station":"龙阳路","direction":"DN","type":"arrived","source":"ride-east","recordedDestination":"广兰路","range":[1659.62,1735],"confidence":"low","doorSide":"L","advanceS":32.38,"measuredAdvance":false,"transferRange":[1702.8,1735]},
  {"id":"original-next-dn-zjg","station":"张江高科","direction":"DN","type":"next","source":"ride-east","recordedDestination":"广兰路","range":[1756.1,1782.6],"confidence":"medium","doorSide":"L","destinationSentence":[1756.1,1758.96],"destinationName":[1757.86,1758.96],"delayS":6.1},
  {"id":"original-arrived-dn-zjg","station":"张江高科","direction":"DN","type":"arrived","source":"ride-east","recordedDestination":"广兰路","range":[1920.0,1997.2],"confidence":"high","doorSide":"L","advanceS":31.0,"measuredAdvance":true,"transferRange":[1965.6,1997.2]},
  {"id":"original-arrived-dn-jkl","station":"金科路","direction":"DN","type":"arrived","source":"ride-east","recordedDestination":"广兰路","range":[2069.1,2125],"confidence":"medium","doorSide":"L","advanceS":64.9,"measuredAdvance":false,"transferRange":[2088.6,2125]},
  {"id":"original-next-dn-gll","station":"广兰路","direction":"DN","type":"next","source":"ride-east","recordedDestination":"广兰路","range":[2156.14,2183.2],"confidence":"medium","doorSide":"L","destinationSentence":[2156.14,2159.2],"destinationName":[2158.1,2159.2],"delayS":8.14,"terminalOnly":true},
  {"id":"original-arrived-dn-gll","station":"广兰路","direction":"DN","type":"arrived","source":"ride-east","recordedDestination":"广兰路","range":[2267.9,2291.4],"confidence":"medium","doorSide":"L","advanceS":35.1,"measuredAdvance":true,"terminalOnly":true},
  {"id":"original-next-up-jkl","station":"金科路","direction":"UP","type":"next","source":"ride-west","recordedDestination":"蟠祥路·国家会计学院","range":[11.6,38.2],"confidence":"medium","doorSide":"L","destinationSentence":[11.6,15.96],"destinationName":[13.5,15.96],"delayS":null},
  {"id":"original-arrived-up-jkl","station":"金科路","direction":"UP","type":"arrived","source":"ride-west","recordedDestination":"蟠祥路·国家会计学院","range":[111.48,130.2],"confidence":"medium","doorSide":"L","advanceS":37.6,"measuredAdvance":false},
];
export interface OnboardAnnouncement {
  station: string; direction: 'DN' | 'UP'; source: SoundClip['source'];
  destination: string; doorSide: AnnouncementDoorSide; missingSentences: readonly string[];
  next?: { clipId: string; phraseAt: number; delayS: number | null; confidence: SoundClip['confidence'] };
  arrived?: { clipId: string; phraseAt: number; advanceS: number; measuredAdvance: boolean; confidence: SoundClip['confidence'] };
}
export const ONBOARD_DESTINATIONS = ['蟠祥路·国家会计学院', '广兰路', '浦东1号2号航站楼'] as const;
/** User decision: use complete compatible recordings before compositions.
 * New sources stay outside ORIGINAL_ONBOARD to preserve the old timing means.
 * Ranges include recorded transfer/safety sentences; no word substitution.
 * Unknown termini and suspected passenger-overlap candidates are not admitted.
 */
export const FIELD_ORIGINAL_ONBOARD: readonly OriginalAnnouncement[] = [
  { id: 'field-original-next-up-lsg', station: '娄山关路', direction: 'UP', type: 'next', source: 'ride-1016-west-core', recordedDestination: '蟠祥路·国家会计学院', range: [8.20, 40.05], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-arrived-up-lsg', station: '娄山关路', direction: 'UP', type: 'arrived', source: 'ride-1016-west-core', recordedDestination: '蟠祥路·国家会计学院', range: [97.40, 114.30], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-next-up-wnl', station: '威宁路', direction: 'UP', type: 'next', source: 'ride-1016-west-core', recordedDestination: '蟠祥路·国家会计学院', range: [168.94, 195.00], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-arrived-up-wnl', station: '威宁路', direction: 'UP', type: 'arrived', source: 'ride-1016-west-core', recordedDestination: '蟠祥路·国家会计学院', range: [258.40, 275.20], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-next-up-shr', station: '淞虹路', direction: 'UP', type: 'next', source: 'cabin-reference', recordedDestination: '蟠祥路·国家会计学院', range: [173.70, 199.98], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-arrived-up-shr', station: '淞虹路', direction: 'UP', type: 'arrived', source: 'ride-1016-west-end', recordedDestination: '蟠祥路·国家会计学院', range: [49.96, 66.30], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-next-up-bxj', station: '北新泾', direction: 'UP', type: 'next', source: 'cabin-reference', recordedDestination: '蟠祥路·国家会计学院', range: [20.60, 46.80], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-arrived-up-bxj', station: '北新泾', direction: 'UP', type: 'arrived', source: 'cabin-reference', recordedDestination: '蟠祥路·国家会计学院', range: [91.00, 109.20], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-next-up-hq2', station: '虹桥2号航站楼', direction: 'UP', type: 'next', source: 'ride-1016-west-end', recordedDestination: '蟠祥路·国家会计学院', range: [140.88, 206.90], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-arrived-up-hq2', station: '虹桥2号航站楼', direction: 'UP', type: 'arrived', source: 'ride-1016-west-end', recordedDestination: '蟠祥路·国家会计学院', range: [421.90, 439.80], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-arrived-dn-hq2', station: '虹桥2号航站楼', direction: 'DN', type: 'arrived', source: 'ride-1016-east-end', recordedDestination: '未确认', range: [53.30, 73.40], doorSide: 'B', confidence: 'medium' },
  { id: 'field-original-next-up-hqz', station: '虹桥火车站', direction: 'UP', type: 'next', source: 'ride-1016-west-end', recordedDestination: '蟠祥路·国家会计学院', range: [513.88, 534.20], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-arrived-up-hqz', station: '虹桥火车站', direction: 'UP', type: 'arrived', source: 'ride-1016-west-end', recordedDestination: '蟠祥路·国家会计学院', range: [546.40, 563.60], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-next-up-gjh', station: '国家会展中心', direction: 'UP', type: 'next', source: 'ride-1016-west-end', recordedDestination: '蟠祥路·国家会计学院', range: [636.90, 666.80], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-arrived-up-gjh', station: '国家会展中心', direction: 'UP', type: 'arrived', source: 'ride-1016-west-end', recordedDestination: '蟠祥路·国家会计学院', range: [734.40, 752.90], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-next-up-pxl', station: '蟠祥路·国家会计学院', direction: 'UP', type: 'next', source: 'ride-1016-west-end', recordedDestination: '蟠祥路·国家会计学院', range: [829.80, 863.40], doorSide: 'L', confidence: 'medium', terminalOnly: true },
  { id: 'field-original-arrived-dn-bxj', station: '北新泾', direction: 'DN', type: 'arrived', source: 'ride-1016-east-night', recordedDestination: '浦东1号2号航站楼', range: [37.60, 54.00], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-next-dn-wnl', station: '威宁路', direction: 'DN', type: 'next', source: 'ride-1016-east-night', recordedDestination: '浦东1号2号航站楼', range: [125.48, 152.80], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-arrived-dn-wnl', station: '威宁路', direction: 'DN', type: 'arrived', source: 'ride-1016-east-night', recordedDestination: '浦东1号2号航站楼', range: [198.40, 216.00], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-next-dn-lsg', station: '娄山关路', direction: 'DN', type: 'next', source: 'ride-1016-east-night', recordedDestination: '浦东1号2号航站楼', range: [290.80, 323.40], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-arrived-dn-lsg', station: '娄山关路', direction: 'DN', type: 'arrived', source: 'ride-1016-east-night', recordedDestination: '浦东1号2号航站楼', range: [380.40, 397.65], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-next-dn-zsg', station: '中山公园', direction: 'DN', type: 'next', source: 'ride-1016-east-night', recordedDestination: '浦东1号2号航站楼', range: [477.40, 511.25], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-arrived-dn-zsg', station: '中山公园', direction: 'DN', type: 'arrived', source: 'ride-1016-east-night', recordedDestination: '浦东1号2号航站楼', range: [577.20, 592.10], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-next-dn-jsl', station: '江苏路', direction: 'DN', type: 'next', source: 'ride-1016-east-night', recordedDestination: '浦东1号2号航站楼', range: [672.48, 704.40], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-arrived-dn-jsl', station: '江苏路', direction: 'DN', type: 'arrived', source: 'ride-1016-east-night', recordedDestination: '浦东1号2号航站楼', range: [753.60, 772.10], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-next-dn-jas', station: '静安寺', direction: 'DN', type: 'next', source: 'ride-1016-east-night', recordedDestination: '浦东1号2号航站楼', range: [869.48, 904.05], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-next-dn-njx', station: '南京西路', direction: 'DN', type: 'next', source: 'ride-1016-east-night', recordedDestination: '浦东1号2号航站楼', range: [1051.40, 1113.00], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-next-dn-rmg', station: '人民广场', direction: 'DN', type: 'next', source: 'ride-1016-east-night', recordedDestination: '浦东1号2号航站楼', range: [1219.40, 1253.10], doorSide: 'L', confidence: 'medium' },
  // The passenger call begins at 1431.86; the complete PA ends before it.
  { id: 'field-original-next-dn-njd', station: '南京东路', direction: 'DN', type: 'next', source: 'ride-1016-east-night', recordedDestination: '浦东1号2号航站楼', range: [1391.40, 1423.50], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-next-dn-ljz', station: '陆家嘴', direction: 'DN', type: 'next', source: 'ride-1016-east-night', recordedDestination: '浦东1号2号航站楼', range: [1545.40, 1577.60], doorSide: 'L', confidence: 'medium' },
  { id: 'field-original-next-dn-pdn', station: '浦东南路', direction: 'DN', type: 'next', source: 'ride-1016-east-night', recordedDestination: '浦东1号2号航站楼', range: [1727.48, 1755.80], doorSide: 'L', confidence: 'medium' },
];
export const RECORDED_ONBOARD = [...ORIGINAL_ONBOARD, ...FIELD_ORIGINAL_ONBOARD];
const parts = new Map(VOICE_PARTS.map(p => [p.id, p]));
const length = (id: string) => { const p = parts.get(id)!; return p.range[1] - p.range[0]; };
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
export const ONBOARD_NEXT_DELAY_S = mean(ORIGINAL_ONBOARD.flatMap(a => a.type === 'next' && a.delayS != null && a.confidence !== 'low' ? [a.delayS] : []));
export const ONBOARD_ARRIVAL_ADVANCE_S = mean(ORIGINAL_ONBOARD.flatMap(a => a.type === 'arrived' && a.measuredAdvance && a.advanceS !== undefined && a.confidence !== 'low' ? [a.advanceS] : []));
/** Layout is read only. The short-turn middle platform at GLL serves the UP
 * island; through DN service uses the DN side platform (line2.ts/D72).
 * The snapshot supplies L/R for single-side variants. HQ2 eastbound B follows
 * the user-confirmed platforms and recorded PA, independently of that flag.
 */
export function onboardDoorSide(station: number, direction: 'DN' | 'UP', destination: string): AnnouncementDoorSide {
  // User decision + recorded PA: HQ2 eastbound serves platforms on both sides.
  if (STATIONS[station]?.id === 'HQ2' && direction === 'DN') return 'B';
  if (STATIONS[station]?.id === 'GLL' && destination === '广兰路') return 'L';
  return STATIONS[station]?.sidePlatform?.includes(direction) ? 'R' : 'L';
}
const rendered: SoundClip[] = [];
const announcements: OnboardAnnouncement[] = [];
/** Explicitly authorised JSL proper-name borrowing is the sole mixed-voice
 * exception. A future extra speaker must not silently enter a recipe. */
export function compatibleVoiceRecipe(recipe: readonly VoicePart[], station: string): boolean {
  return (['zh', 'en'] as const).every(language => {
    const group = recipe.filter(p => p.language === language);
    const speakers = new Set(group.map(p => p.speaker));
    if (speakers.size <= 1) return true;
    return station === '江苏路' && language === 'zh' && group.every(p => p.speaker === 'onboard-zh' ||
      p.speaker === 'platform-zh' && (p.id === 'zh-name-jsl' || p.id === 'jsl-proper-name'));
  });
}
const destinationId = (name: string) => STATIONS.find(s => s.name === name)?.id.toLowerCase();
const originalClip = (a: OriginalAnnouncement): SoundClip => ({ id: a.id, file: `${a.id}.mp3`,
  kind: a.type === 'next' ? 'interior-departure' : 'interior-arrival', station: a.station,
  direction: a.direction, side: 'shared', source: a.source, range: a.range, both: false,
  confidence: a.confidence, provenance: 'original', recordedDestination: a.recordedDestination,
  doorSide: a.doorSide, ...(a.recordedDirection ? { recordedDirection: a.recordedDirection } : {}) });
rendered.push(...RECORDED_ONBOARD.map(originalClip));
function recordedClip(a: OriginalAnnouncement): SoundClip {
  const existing = rendered.find(c => c.id === a.id);
  if (existing) return existing;
  const clip = originalClip(a); rendered.push(clip); return clip;
}
function matchingOriginal(station: string, direction: 'DN' | 'UP', destination: string, side: AnnouncementDoorSide, type: 'next' | 'arrived') {
  const exact = RECORDED_ONBOARD.find(a => a.station === station && a.type === type && a.direction === direction && a.doorSide === side &&
    (type === 'next' || a.transferRange || a.terminalOnly ? a.recordedDestination === destination : true));
  if (exact) return exact;
  // Ordinary arrivals say the station, door side and safety notices, without
  // a direction/terminus. Reuse their complete waveform, recording its actual
  // source direction; terminal/transfer/destination messages never qualify.
  const neutral = type === 'arrived' ? RECORDED_ONBOARD.find(a => a.station === station && a.type === 'arrived' && a.doorSide === side &&
    !a.transferRange && !a.destinationSentence && !a.terminalOnly) : undefined;
  return neutral ? { ...neutral, id: `reused-${neutral.id}-${direction.toLowerCase()}`, direction, recordedDirection: neutral.direction } : undefined;
}
function composed(station: string, direction: 'DN' | 'UP', destination: string, side: AnnouncementDoorSide, type: 'next' | 'arrived', recipe: string[]): SoundClip | undefined {
  if (!recipe.length || recipe.some(id => !parts.has(id))) return undefined;
  if (!compatibleVoiceRecipe(recipe.map(id => parts.get(id)!), station)) throw new Error(`Incompatible PA speakers: ${station}`);
  const st = STATIONS.find(s => s.name === station)!;
  // Removing a trailing short-turn notice leaves one contiguous recording;
  // it does not require fragment assembly or a second library normalisation.
  const parent = type === 'arrived' && recipe.length === 1 ? ORIGINAL_ONBOARD.find(a => a.id === recipe[0] || `${a.id}-body` === recipe[0]) : undefined;
  if (parent) {
    const part = parts.get(recipe[0])!;
    const clip: SoundClip = { ...originalClip(parent), id: `original-slice-${type}-${direction.toLowerCase()}-${st.id.toLowerCase()}-${destinationId(destination)}-${side.toLowerCase()}`,
      file: '', station, direction, doorSide: side, source: part.source, range: part.range, destination,
      ...(parent.direction !== direction ? { recordedDirection: parent.direction } : {}) };
    clip.file = `${clip.id}.mp3`;
    rendered.push(clip); return clip;
  }
  const id = `composed-${type}-${direction.toLowerCase()}-${st.id.toLowerCase()}-${destinationId(destination)}-${side.toLowerCase()}`;
  const first = parts.get(recipe[0])!;
  const confidence = recipe.some(id => parts.get(id)!.confidence === 'low') ? 'low' : 'medium';
  const clip: SoundClip = { id, file: `${id}.mp3`, kind: type === 'next' ? 'interior-departure' : 'interior-arrival',
    station, direction, side: 'shared', source: first.source, range: first.range, both: false,
    confidence, provenance: 'composed', destination, doorSide: side, composition: recipe,
    durationS: recipe.reduce((sum, id) => sum + length(id), 0) - VOICE_CROSSFADE_S * (recipe.length - 1) };
  rendered.push(clip); return clip;
}
// Each station's existing body retains its transfer lines, safety notices and
// bilingual order. Generic fallback has the same CN -> EN sentence sequence.
const first = STATIONS.findIndex(s => s.id === 'JSL'), last = STATIONS.findIndex(s => s.id === 'GLL');
for (let st = first; st <= last; st++) for (const direction of ['DN', 'UP'] as const) for (const destination of ONBOARD_DESTINATIONS) {
  const station = STATIONS[st], nameId = station.id.toLowerCase(), destId = destinationId(destination)!;
  const side = onboardDoorSide(st, direction, destination), missing: string[] = [];
  const originals = ORIGINAL_ONBOARD.filter(a => a.station === station.name);
  const slot: OnboardAnnouncement = { station: station.name, direction, source: 'ride-east', destination, doorSide: side, missingSentences: missing };
  for (const type of ['next', 'arrived'] as const) {
    const matching = matchingOriginal(station.name, direction, destination, side, type);
    // Do not use terminal-only GLL notices on a through service, or tell an
    // airport-bound passenger to get off and transfer to another airport train.
    let clip = matching ? recordedClip(matching) : undefined;
    const base = originals.find(a => a.type === type);
    if (!clip && base && !base.terminalOnly && side === base.doorSide) {
      const recipe = type === 'next'
        ? destination === '浦东1号2号航站楼'
          ? ['zh-terminus', `zh-name-${destId}`, `${base.id}-body-zh`, 'en-terminus', 'en-name-pda', `${base.id}-body-en`]
          : ['zh-terminus', `zh-name-${destId}`, `${base.id}-body`]
        : [base.transferRange && destination !== '广兰路' ? `${base.id}-body` : base.id];
      clip = composed(station.name, direction, destination, side, type, recipe);
    }
    const enName = nameId === 'jsl' ? ['jsl-proper-name', 'en-road'] : [`en-name-${nameId}`];
    if (!clip && parts.has(`zh-name-${nameId}`) && enName.every(id => parts.has(id))) {
      const door = side === 'L' ? 'left' : 'right';
      const cnDoor = `zh-${door}`, enDoor = `en-${door}`;
      const cnName = `zh-name-${nameId}`;
      const recipe: string[] = [];
      if (type === 'next') {
        if (parts.has('zh-terminus') && parts.has(`zh-name-${destId}`)) recipe.push('zh-terminus', `zh-name-${destId}`);
        else missing.push('中文终点句');
        recipe.push('zh-next', cnName);
      } else recipe.push(cnName, 'zh-arrived');
      if (parts.has(cnDoor)) recipe.push(cnDoor); else missing.push(`中文${door === 'right' ? '右' : '左'}门句`);
      if (type === 'next') {
        recipe.push('zh-running-safety');
        if (destination === '浦东1号2号航站楼' && parts.has('en-terminus') && parts.has('en-name-pda')) recipe.push('en-terminus', 'en-name-pda');
        recipe.push('en-next', ...enName);
      }
      else recipe.push('en-arrived', ...enName);
      if (parts.has(enDoor)) recipe.push(enDoor); else missing.push(`英文${door === 'right' ? '右' : '左'}门句`);
      if (type === 'arrived') recipe.push('zh-arrival-safety');
      clip = composed(station.name, direction, destination, side, type, recipe);
    }
    if (!clip) { missing.push(type === 'next' ? '出站报站（站名素材缺）' : '到站报站（站名素材缺）'); continue; }
    slot.source = clip.source;
    if (type === 'next') slot.next = { clipId: clip.id, phraseAt: base?.range[0] ?? 0, delayS: base?.delayS ?? null, confidence: clip.confidence };
    else slot.arrived = { clipId: clip.id, phraseAt: base?.range[0] ?? 0,
      advanceS: base?.advanceS ?? ONBOARD_ARRIVAL_ADVANCE_S, measuredAdvance: base?.measuredAdvance ?? false, confidence: clip.confidence };
  }
  announcements.push(slot);
}
/** Original terminal PA is catalogued separately so the 10-14 timing means
 * above remain unchanged. CN clear-out belongs inside this arrival message. */
export const FIELD_1016_TERMINAL_CLIP: SoundClip = {
  id: 'original-arrived-up-pxl', file: 'original-arrived-up-pxl.mp3', kind: 'interior-arrival',
  station: '蟠祥路·国家会计学院', direction: 'UP', side: 'shared', source: 'ride-1016-west-end',
  range: [907.20, 934.80], both: false, confidence: 'medium', provenance: 'original',
  recordedDestination: '蟠祥路·国家会计学院', doorSide: 'L',
};
/** D102: "本次列车因故将稍作停留" with its English, one whole original PA
 * (CN 4.8-10.6 s, EN 10.8-18.7 s by local word timing; the cut opens 0.2 s
 * before the first voiced energy). Recording station unknown: station is catalogue metadata only.
 * User decision: the PA starts after 5 s standing and repeats every 45 s. */
export const ONBOARD_HOLD_CLIP: SoundClip = {
  id: 'original-hold', file: 'original-hold.mp3', kind: 'interior-special',
  station: '江苏路', direction: 'shared', side: 'shared', source: 'hold-reference',
  range: [3.80, 19.20], both: false, confidence: 'high', provenance: 'original',
};
export const ONBOARD_HOLD_DELAY_S = 5;
export const ONBOARD_HOLD_REPEAT_S = 45;
// Western slots use the same original-first policy as the central stations.
// Missing names suppress the affected language, allowing an independently
// available English sentence when no usable complete recording exists.
for (let st = 0; st < first; st++) for (const direction of ['DN', 'UP'] as const) for (const destination of ONBOARD_DESTINATIONS) {
  if (st === 0 && (direction !== 'UP' || destination !== STATIONS[0].name)) continue;
  const station = STATIONS[st], nameId = station.id.toLowerCase(), destId = destinationId(destination)!;
  const side = onboardDoorSide(st, direction, destination), door = side === 'B' ? 'both' : side === 'L' ? 'left' : 'right';
  const terminal = st === 0;
  const missing: string[] = [];
  if (!parts.has(`zh-name-${nameId}`)) missing.push('中文站名／报站句');
  if (!parts.has(`en-name-${nameId}`)) missing.push('英文站名／报站句');
  const slot: OnboardAnnouncement = { station: station.name, direction, destination, doorSide: side,
    source: 'ride-1016-west-end', missingSentences: missing };
  for (const type of ['next', 'arrived'] as const) {
    if (terminal && type === 'arrived') {
      slot.arrived = { clipId: FIELD_1016_TERMINAL_CLIP.id, phraseAt: 907.20, advanceS: 38.80,
        measuredAdvance: false, confidence: FIELD_1016_TERMINAL_CLIP.confidence };
      continue;
    }
    const original = matchingOriginal(station.name, direction, destination, side, type);
    if (original) {
      recordedClip(original);
      slot.source = original.source;
      if (type === 'next') slot.next = { clipId: original.id, phraseAt: original.range[0], delayS: original.delayS ?? null, confidence: original.confidence };
      else slot.arrived = { clipId: original.id, phraseAt: original.range[0], advanceS: ONBOARD_ARRIVAL_ADVANCE_S, measuredAdvance: false, confidence: original.confidence };
      continue;
    }
    const recipe: string[] = [];
    if (parts.has(`zh-name-${nameId}`)) {
      if (type === 'next') recipe.push('zh-terminus', `zh-name-${destId}`, 'zh-next', `zh-name-${nameId}`);
      else recipe.push(`zh-name-${nameId}`, 'zh-arrived');
      recipe.push(`zh-${door}`);
      if (type === 'next') recipe.push('zh-running-safety');
    }
    if (parts.has(`en-name-${nameId}`)) {
      if (type === 'next' && destination === '浦东1号2号航站楼') recipe.push('en-terminus', 'en-name-pda');
      recipe.push(terminal ? 'en-next-terminal-pxl' : type === 'next' ? 'en-next' : 'en-arrived', `en-name-${nameId}`, `en-${door}`);
    }
    if (type === 'arrived' && parts.has(`zh-name-${nameId}`)) recipe.push('zh-arrival-safety');
    const clip = composed(station.name, direction, destination, side, type, recipe);
    if (!clip) continue;
    slot.source = clip.source;
    if (type === 'next') slot.next = { clipId: clip.id, phraseAt: 0, delayS: null, confidence: clip.confidence };
    else slot.arrived = { clipId: clip.id, phraseAt: 0, advanceS: ONBOARD_ARRIVAL_ADVANCE_S,
      measuredAdvance: false, confidence: clip.confidence };
  }
  announcements.push(slot);
}
export const ONBOARD_RENDER_BANK: readonly SoundClip[] = rendered;
export const ONBOARD_ANNOUNCEMENTS: readonly OnboardAnnouncement[] = announcements;
/** Strict station + direction + terminus + actual door side lookup. */
export function onboardAnnouncement(station: string, direction: 'DN' | 'UP', destination: string, side: AnnouncementDoorSide, catalog = ONBOARD_ANNOUNCEMENTS) {
  return catalog.find(a => a.station === station && a.direction === direction && a.destination === destination && a.doorSide === side);
}
