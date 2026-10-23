/** Current-line facade. Selection is fixed when this module is loaded. */
import { LINE } from '../current';
export type { RideDirection, RecordingId, RecordingSource, AcousticCandidate, RideConfidence, RideEventEvidence, RideStop, RecordingDoorReview, RideMeasuredEvent } from '../types';
export const { LEGACY_RECORDING_IDS, FIELD_1016_RECORDING_IDS, RECORDING_SOURCES, RIDE_LOG, BRAKE_STOP_MEASUREMENTS, USER_RIDE_MARKERS, USER_DOOR_REVIEWS, USER_DOOR_REFERENCES, RIDE_MODEL_BASELINE, RIDE_MEASURED_EVENTS, usableRideEvent, summarizeRideLog } = LINE.audio.ridelog;
