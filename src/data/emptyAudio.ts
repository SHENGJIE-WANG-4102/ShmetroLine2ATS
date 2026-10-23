import { clipDuration, findOnboardAnnouncement } from './audioUtils';
import type { LineAudioData, SoundClip, StationData } from './types';
import { RIDE_MEASURED_EVENTS, usableRideEvent, summarizeRideLog } from './rideEvidence';

/** A line without recordings carries empty catalogues; no sample can be scheduled. */
export function emptyAudio(stations: readonly StationData[], doorTiming: LineAudioData['doorbank']['DOOR_REFERENCE_TIMING']): LineAudioData {
  // Legacy audio consumers compare this id against the actual bank. An empty id is never a sample.
  const noClip: SoundClip = { id: '', file: '', kind: 'interior-special', station: '', direction: 'shared',
    side: 'shared', source: '', range: [0, 0], both: false, confidence: 'low' };
  return {
    soundbank: {
      SOUNDBANK_DIRECTORY: '', SOURCE_GAIN_REFERENCES: [], SOUND_BANK: [],
      clipDuration,
    },
    onboardbank: {
      VOICE_CROSSFADE_S: 0, RECORDED_VOLUME_GAINS: { small: 1, medium: 1, large: 1 },
      VOICE_SOURCES: [], FIELD_1016_VOICE_PARTS: [], ORIGINAL_ONBOARD: [], ONBOARD_DESTINATIONS: [],
      ADDITIONAL_ONBOARD_ROUTES: [], FIELD_ORIGINAL_ONBOARD: [], RECORDED_ONBOARD: [], VOICE_PARTS: [],
      ONBOARD_NEXT_DELAY_S: 0, ONBOARD_ARRIVAL_ADVANCE_S: 0,
      onboardDoorSide: (station, direction) => stations[station]?.sidePlatform?.includes(direction) ? 'R' : 'L',
      compatibleVoiceRecipe: recipe => (['zh', 'en'] as const).every(language =>
        new Set(recipe.filter(part => part.language === language).map(part => part.speaker)).size <= 1),
      FIELD_1016_TERMINAL_CLIP: noClip, ONBOARD_HOLD_CLIP: noClip, ONBOARD_HOLD_DELAY_S: 0, ONBOARD_HOLD_REPEAT_S: 0,
      ONBOARD_RENDER_BANK: [], ONBOARD_ANNOUNCEMENTS: [],
      onboardAnnouncement: findOnboardAnnouncement,
    },
    doorbank: { DOOR_REFERENCE_TIMING: doorTiming, DOOR_TAKES: [], DOOR_BANK: [] },
    vvvf: { VVVF_HZ_PER_MS: 0, VVVF_TRACTION: [], VVVF_BRAKE: [], VVVF_TAKES: [] },
    ridelog: {
      LEGACY_RECORDING_IDS: [], FIELD_1016_RECORDING_IDS: [], RECORDING_SOURCES: [], RIDE_LOG: [],
      BRAKE_STOP_MEASUREMENTS: [], USER_RIDE_MARKERS: [], USER_DOOR_REVIEWS: [],
      USER_DOOR_REFERENCES: { recording: '', station: '', open: 0, closingMotion: 0,
        locked: { raw: '', parsedSeconds: 0, usable: false } },
      RIDE_MODEL_BASELINE: { revision: '', tripG: '', tripW: '', tripAirport: '', airportFullSeconds: 0,
        wholeRecordedModelSeconds: 0, terminalDN: '', terminalUP: '', intervals: [] },
      RIDE_MEASURED_EVENTS, usableRideEvent, summarizeRideLog,
    },
    onboardfield1021: { FIELD_1021_ORIGINALS: [], FIELD_1021_PARTS: [] },
  };
}
