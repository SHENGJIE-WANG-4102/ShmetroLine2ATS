import { clipDuration } from '../../audioUtils';
import type { SoundbankData, SoundClip } from '../../types';
import { DOOR_BANK } from './doorbank';

/** 用户 2026-11-15 提供的车内录音（嘉定北→江苏路，车号 11056）剪出的车内走行/停车环境声。
 * 原件和成片都不随仓库分发（public/sounds/line11/ 已忽略）；缺文件时播放器静默。
 * 片段按噪声电平最稳、无报站无门铃挑出，range 为原件秒数；录音没有逐站对齐，所在站不填。 */
export const SOUNDBANK_DIRECTORY = 'sounds/line11';
export const SOURCE_GAIN_REFERENCES: SoundbankData['SOURCE_GAIN_REFERENCES'] = [];
const RIDE = 'ride-20261115-jdb-jsl';
export const SOUND_BANK: SoundClip[] = [
  { id: 'onboard-rolling', file: 'onboard-rolling.mp3', kind: 'interior-rolling', station: '', direction: 'shared', side: 'shared',
    source: RIDE, range: [1900, 1914], loopCrossfadeS: 1, both: false, confidence: 'medium' },
  { id: 'onboard-idle', file: 'onboard-idle.mp3', kind: 'interior-idle', station: '', direction: 'shared', side: 'shared',
    source: RIDE, range: [1012, 1024], loopCrossfadeS: 1, both: false, confidence: 'medium' },
  ...DOOR_BANK,
];
export { clipDuration };
