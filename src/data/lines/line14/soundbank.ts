import { clipDuration } from '../../audioUtils';
import { ONBOARD_RENDER_BANK } from './onboardbank';
import { DOOR_BANK } from './doorbank';
import type { SoundbankData } from '../../types';

/** 本地实录及成片均不随仓库分发；缺文件由现有播放器静默处理。 */
export const SOUNDBANK_DIRECTORY = 'sounds/line14';
export const SOURCE_GAIN_REFERENCES: SoundbankData['SOURCE_GAIN_REFERENCES'] = [];
export const SOUND_BANK = [...ONBOARD_RENDER_BANK, ...DOOR_BANK];
export {clipDuration};
