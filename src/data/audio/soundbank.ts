/** Current-line facade. Selection is fixed when this module is loaded. */
import { LINE } from '../current';
export type { SoundKind, SoundDirection, AnnouncementDoorSide, SoundClip } from '../types';
export const { SOUNDBANK_DIRECTORY, SOURCE_GAIN_REFERENCES, SOUND_BANK, clipDuration } = LINE.audio.soundbank;
export { ONBOARD_ANNOUNCEMENTS, ONBOARD_NEXT_DELAY_S, ONBOARD_ARRIVAL_ADVANCE_S, ONBOARD_HOLD_CLIP, ONBOARD_HOLD_DELAY_S, ONBOARD_HOLD_REPEAT_S } from './onboardbank';
export type { OnboardAnnouncement } from '../types';
