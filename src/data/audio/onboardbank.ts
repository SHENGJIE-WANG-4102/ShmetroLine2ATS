/** Current-line facade. Selection is fixed when this module is loaded. */
import { LINE } from '../current';
export type { RecordedVolume, VoiceLanguage, VoicePart, OriginalAnnouncement, OnboardAnnouncement } from '../types';
export const { VOICE_CROSSFADE_S, RECORDED_VOLUME_GAINS, VOICE_SOURCES, FIELD_1016_VOICE_PARTS, ORIGINAL_ONBOARD, ONBOARD_DESTINATIONS, ADDITIONAL_ONBOARD_ROUTES, FIELD_ORIGINAL_ONBOARD, RECORDED_ONBOARD, VOICE_PARTS, ONBOARD_NEXT_DELAY_S, ONBOARD_ARRIVAL_ADVANCE_S, onboardDoorSide, compatibleVoiceRecipe, FIELD_1016_TERMINAL_CLIP, ONBOARD_HOLD_CLIP, ONBOARD_HOLD_DELAY_S, ONBOARD_HOLD_REPEAT_S, ONBOARD_RENDER_BANK, ONBOARD_ANNOUNCEMENTS, onboardAnnouncement } = LINE.audio.onboardbank;
