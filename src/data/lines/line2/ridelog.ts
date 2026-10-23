import type { RecordingId, RecordingSource, AcousticCandidate, RideConfidence, RideEventEvidence, RideStop, RecordingDoorReview } from '../../types';
export type { RideDirection, RecordingId, RecordingSource, AcousticCandidate, RideConfidence, RideEventEvidence, RideStop, RecordingDoorReview, RideMeasuredEvent } from '../../types';
/**
 * User's local Line 2 recordings, supplied on 2026-10-14 and 2026-10-16.
 * Source files live in ignored work/recordings/; no audio or passenger
 * transcript is distributed. Filename door references are car-door numbers:
 * westbound 4-1, eastbound 5-5. Exact 10-14 clock starts are unknown;
 * the user places ride-east after 19:50. 10-16
 * filenames provide approximate minutes only. Copy times are not clocks.
 *
 * Method: local speech recognition locates station announcements; 8 kHz
 * spectrograms (256 ms windows / 64 ms hops) locate recurring ~2750 / 2843 Hz
 * closing-tone pulses and rising traction bands. Stops are estimated by
 * measure-stops.py (512 ms windows / 64 ms hops): descending brake ridges,
 * followed by a 20-400 Hz energy
 * knee near the local noise floor. Tools cannot accept audio input; automatic
 * estimates therefore carry evidence-based high/medium/low confidence.
 * Speech timestamps are not door times;
 * "门灯闪烁时，请勿上下车" is also part of arrival announcements.
 *
 * Keep the legacy 10-14 motor/closing-warning rows as independent evidence.
 * Later clip reviews live in USER_DOOR_REVIEWS and feed the door-derived
 * analysis without rewriting those motor measurements. 10-16 includes opening and a
 * separate mechanical closingMotion estimate (D85 and the task A notes).
 * Low-confidence events never enter means. Windows are analysis bounds.
 * Confidence thresholds and frequency templates are assumptions 【假设】;
 * they are not statistical error bars. User-supplied markers retain decimals.
 * Station order/names: line2.ts; official comparison: firstlast.ts.
 */

export const LEGACY_RECORDING_IDS = ['ride-east', 'ride-west', 'platform-01', 'platform-03'] as const;
export const FIELD_1016_RECORDING_IDS = ['ride-1016-west-core', 'ride-1016-west-end', 'ride-1016-east-end', 'ride-1016-east-night'] as const;




export const RECORDING_SOURCES: RecordingSource[] = [
  { id: 'ride-east', filename: '2号线江苏路~广兰路 终点站广兰路小交路02A05 020897.wav',
    kind: 'ride', durationS: 2311.66, clockStart: null, clockStartNotBefore: '19:50', recordedDate: '2026-10-14',
    from: '江苏路', to: '广兰路', directions: ['DN'],
    note: '用户2026-10-23更正：19:50以后开始录制，确切起录钟点未知；此前18:00比较假设作废。' },
  { id: 'ride-west', filename: '广兰路~金科路小交路.wav',
    kind: 'ride', durationS: 148.2, clockStart: null, from: '广兰路', to: '金科路', directions: ['UP'] },
  { id: 'platform-01', filename: '江苏路2号线SNAI 02A01 4-1 PVG 02A05 5-5.wav',
    kind: 'platform', durationS: 133.32, clockStart: null, from: '江苏路', to: '江苏路', directions: ['UP', 'DN'],
    doorReferences: [{ direction: 'UP', car: 4, door: 1, trainType: '02A01' },
      { direction: 'DN', car: 5, door: 5, trainType: '02A05' }] },
  { id: 'platform-03', filename: '江苏路2号线SNAI 02A03 4-1 PVG 02A05 5-5.wav',
    kind: 'platform', durationS: 109.96, clockStart: null, from: '江苏路', to: '江苏路', directions: ['UP', 'DN'],
    doorReferences: [{ direction: 'UP', car: 4, door: 1, trainType: '02A03' },
      { direction: 'DN', car: 5, door: 5, trainType: '02A05' }] },
  { id: 'ride-1016-west-core', filename: 'Fri_19.51_中山公园~威宁路_021008车内录音.wav',
    kind: 'ride', durationS: 297.12, clockStart: '19:51', clockStartPrecision: 'minute', recordedDate: '2026-10-16',
    vehicleLabel: '021008', from: '中山公园', to: '威宁路', directions: ['UP'],
    note: 'Filename clock is approximate to the minute. Starts with traction already present; overlaps the other 19:51 source on the nominal clock.' },
  { id: 'ride-1016-west-end', filename: 'Fri_19.51_淞虹路~蟠祥路_021008车内录音.wav',
    kind: 'ride', durationS: 951, clockStart: '19:51', clockStartPrecision: 'minute', recordedDate: '2026-10-16',
    vehicleLabel: '021008', from: '淞虹路', to: '蟠祥路·国家会计学院', directions: ['UP'],
    note: 'Filename clock preserved despite overlapping the western-core recording. Same physical train and turnback timing are not established.' },
  { id: 'ride-1016-east-end', filename: 'Fri_20.25_国际会展中心~淞虹路_021008车内录音.wav',
    kind: 'ride', durationS: 487.54, clockStart: '20:25', clockStartPrecision: 'minute', recordedDate: '2026-10-16',
    vehicleLabel: '021008', from: '国家会展中心', observedFrom: '虹桥火车站', to: '淞虹路', directions: ['DN'],
    note: '国际会展中心 normalized to 国家会展中心. 【假设】Captured portion starts at 虹桥火车站, based on the next/arrival announcements and two observed intervals; filename route retained.' },
  { id: 'ride-1016-east-night', filename: 'Fri_21.05_北新泾~浦东南路_02A05车内录音.wav',
    kind: 'ride', durationS: 1854.86, clockStart: '21:05', clockStartPrecision: 'minute', recordedDate: '2026-10-16',
    vehicleLabel: '02A05', from: '北新泾', to: '浦东南路', directions: ['DN'],
    note: 'Filename clock is approximate to the minute; entry into 北新泾 is captured before its first recorded departure.' },
];








const tone = (at: number): AcousticCandidate => ({ at, searchRadiusS: 1, evidence: 'closing-tone-pulses' });
const traction = (at: number): AcousticCandidate => ({ at, searchRadiusS: 3, evidence: 'rising-traction-band' });
const east = (station: string, analysisWindowS: [number, number] | null,
  close: number | null, start: number | null, note?: string): RideStop => ({
  recording: 'ride-east', station, direction: 'DN', stop: null, open: null, close, start,
  evidence: { ...(close === null ? {} : { close: { confidence: 'high' as const, method: 'closing-tone-pulses' as const } }),
    ...(start === null ? {} : { start: { confidence: 'medium' as const, method: 'rising-traction-band' as const } }) },
  candidates: { ...(close === null ? {} : { close: tone(close) }), ...(start === null ? {} : { start: traction(start) }) },
  analysisWindowS, ...(note ? { note } : {}),
});

export const RIDE_LOG: RideStop[] = [
  east('江苏路', null, null, 8, 'Recording starts during the closing tones; their onset is not captured.'),
  east('静安寺', [88, 132], 164, 174),
  east('南京西路', [261, 305], 375, 386),
  east('人民广场', [466, 510], 540, 553),
  east('南京东路', [617, 663], 693, 706),
  east('陆家嘴', [807, 852], 884, 894),
  east('浦东南路', [973, 1017], 1072, 1083),
  east('世纪大道', [1149, 1224], 1225, 1240, 'Multiple tonal/broadband changes; motion and door sounds need separation.'),
  east('上海科技馆', [1330, 1381], 1429, 1442),
  east('世纪公园', [1525, 1570], 1588, 1600),
  east('龙阳路', [1658, 1705], 1735, 1750),
  east('张江高科', [1915, 1965], 1980, 1993),
  east('金科路', [2064, 2124], 2141, 2148),
  east('广兰路', [2265, 2311.66], null, null, 'Terminating service; no onward departure is established.'),
  { recording: 'ride-west', station: '广兰路', direction: 'UP', stop: null, open: null, close: null, start: null,
    candidates: {}, evidence: {}, analysisWindowS: null, note: 'Traction is present at the file boundary; the start onset is not fully captured.' },
  { recording: 'ride-west', station: '金科路', direction: 'UP', stop: null, open: null, close: null, start: null,
    candidates: {}, evidence: {}, analysisWindowS: [115, 148.2], note: 'Recording ends near a falling traction band; post-stop context is limited.' },
];

// Only 3.2 s of post-stop context in this short file; excluded from averages.
const shortArrival = RIDE_LOG.find(row => row.recording === 'ride-west' && row.station === '金科路')!;
shortArrival.stop = 145;
shortArrival.evidence.stop = { confidence: 'low', method: 'spectral-knee', bandHz: [650, 900],
  ridgeFallDb: 13.04, lowBeforeDb: -25.76, lowAfterDb: -26, lowFallDb: .24, floorDb: -26.05,
  ambiguous: false, note: 'File ends at 148.20 s; stop context is edge-limited and start is not captured.' };

/** Output of measure-stops.py; the frequency/energy numbers explain each decision. */
export const BRAKE_STOP_MEASUREMENTS: (RideEventEvidence & { station: string; at: number })[] = [
  { station: '静安寺', at: 125, confidence: 'high', bandHz: [600, 900], ridgeFallDb: 7.17, lowBeforeDb: -21.81, lowAfterDb: -23.16, lowFallDb: 1.34, floorDb: -22.86, ambiguous: false },
  { station: '南京西路', at: 299, confidence: 'medium', bandHz: [600, 900], ridgeFallDb: 5.77, lowBeforeDb: -21.75, lowAfterDb: -23.12, lowFallDb: 1.37, floorDb: -23.05, ambiguous: false },
  { station: '人民广场', at: 500, confidence: 'medium', bandHz: [600, 900], ridgeFallDb: 7.71, lowBeforeDb: -21.83, lowAfterDb: -23.14, lowFallDb: 1.31, floorDb: -22.8, ambiguous: false },
  { station: '南京东路', at: 659, confidence: 'low', bandHz: [600, 900], ridgeFallDb: 3.38, lowBeforeDb: -19.22, lowAfterDb: -22.92, lowFallDb: 3.7, floorDb: -26.3, ambiguous: true },
  { station: '陆家嘴', at: 843, confidence: 'medium', bandHz: [550, 900], ridgeFallDb: 3, lowBeforeDb: -25.72, lowAfterDb: -26.31, lowFallDb: 0.58, floorDb: -26.43, ambiguous: false },
  { station: '浦东南路', at: 1008, confidence: 'low', bandHz: [550, 900], ridgeFallDb: 2.71, lowBeforeDb: -21.97, lowAfterDb: -24.04, lowFallDb: 2.08, floorDb: -24.79, ambiguous: true },
  { station: '世纪大道', at: 1168, confidence: 'low', bandHz: [650, 900], ridgeFallDb: 4.43, lowBeforeDb: -14.82, lowAfterDb: -20.1, lowFallDb: 5.28, floorDb: -20.44, ambiguous: true },
  { station: '上海科技馆', at: 1369, confidence: 'medium', bandHz: [650, 900], ridgeFallDb: 6.93, lowBeforeDb: -26.03, lowAfterDb: -25.63, lowFallDb: -0.4, floorDb: -25.95, ambiguous: false },
  { station: '世纪公园', at: 1585, confidence: 'low', bandHz: [550, 960], ridgeFallDb: 3.97, lowBeforeDb: -21.99, lowAfterDb: -23.06, lowFallDb: 1.07, floorDb: -22.99, ambiguous: true },
  { station: '龙阳路', at: 1692, confidence: 'high', bandHz: [600, 900], ridgeFallDb: 10.66, lowBeforeDb: -26.8, lowAfterDb: -27.46, lowFallDb: 0.65, floorDb: -27.27, ambiguous: false },
  { station: '张江高科', at: 1951, confidence: 'medium', bandHz: [650, 900], ridgeFallDb: 3.47, lowBeforeDb: -21.81, lowAfterDb: -25.45, lowFallDb: 3.65, floorDb: -25.09, ambiguous: false },
  { station: '金科路', at: 2134, confidence: 'low', bandHz: [600, 900], ridgeFallDb: 4.87, lowBeforeDb: -23.88, lowAfterDb: -25.56, lowFallDb: 1.68, floorDb: -25.58, ambiguous: true },
  { station: '广兰路', at: 2303, confidence: 'high', bandHz: [650, 900], ridgeFallDb: 8.15, lowBeforeDb: -18.77, lowAfterDb: -28.17, lowFallDb: 9.4, floorDb: -28.43, ambiguous: false },
].map(row => ({ ...row, method: 'spectral-knee' as const, confidence: row.confidence as RideConfidence,
  bandHz: row.bandHz as [number, number] }));

for (const measured of BRAKE_STOP_MEASUREMENTS) {
  const row = RIDE_LOG.find(entry => entry.recording === 'ride-east' && entry.station === measured.station)!;
  row.stop = measured.at;
  row.evidence.stop = { ...measured };
}

/** Direct user decisions override automatic estimates; retain the estimate for comparison. */
export const USER_RIDE_MARKERS: { station: string; event: 'stop' | 'close' | 'start'; at: number }[] = [
  { station: '静安寺', event: 'stop', at: 126 },
  { station: '静安寺', event: 'close', at: 164.5 },
  { station: '南京东路', event: 'close', at: 693.28 },
  { station: '南京东路', event: 'start', at: 705.55 },
  { station: '陆家嘴', event: 'stop', at: 845.55 },
  { station: '龙阳路', event: 'close', at: 1735.16 },
];
for (const marker of USER_RIDE_MARKERS) {
  const row = RIDE_LOG.find(entry => entry.recording === 'ride-east' && entry.station === marker.station)!;
  const automatic = row[marker.event];
  row[marker.event] = marker.at;
  row.evidence[marker.event] = { ...row.evidence[marker.event], confidence: 'high', method: 'user-marker',
    ...(automatic === null ? {} : { autoAt: automatic }), note: 'User-provided recording timestamp.' };
}



/** User review on 2026-10-23. All adopted event timestamps use original-file seconds. */
export const USER_DOOR_REVIEWS: RecordingDoorReview[] = [
  { recording: 'ride-east', station: '南京东路', reviewedOn: '2026-10-23', clipWindowS: [649, 696],
    reply: '开门8.7~9，关门45',
    note: '片内45秒对应原件694秒；关门未区分提示音/机械动作，保留原文，不覆盖已确认提示音693.28秒。',
    events: { open: { at: 657.85, rangeS: [657.7, 658], confidence: 'high', method: 'user-marker',
      presenceConfirmed: true, timingConfirmed: true, note: '采用用户范围中点；小数位不表示百分之一秒精度。' } } },
  { recording: 'ride-east', station: '浦东南路', reviewedOn: '2026-10-23', clipWindowS: [1002, 1031],
    reply: '开门6~7.2',
    events: { open: { at: 1008.6, rangeS: [1008, 1009.2], confidence: 'high', method: 'user-marker',
      presenceConfirmed: true, timingConfirmed: true, note: '采用用户范围中点，保留1.2秒范围。' } } },
  { recording: 'ride-east', station: '张江高科', reviewedOn: '2026-10-23', clipWindowS: [1946, 1975],
    reply: '开门7.9',
    events: { open: { at: 1953.9, confidence: 'high', method: 'user-marker',
      presenceConfirmed: true, timingConfirmed: true, note: '用户片内近似秒数；未提供误差范围。' } } },
  { recording: 'ride-east', station: '金科路', reviewedOn: '2026-10-23', clipWindowS: [2124, 2147],
    reply: '没听到开门声，我确定；14s关门提示音,17s关门,20s关门完成', openingNotHeard: true,
    events: {
      close: { at: 2138, confidence: 'high', method: 'user-marker', note: '片内14秒，关门提示开始，近似秒数。' },
      closingMotion: { at: 2141, confidence: 'high', method: 'user-marker', note: '片内17秒，机械关门开始，近似秒数。' },
      locked: { at: 2144, confidence: 'high', method: 'user-marker', note: '片内20秒，用户确认关门完成，作为声学完成节点；不是电气锁闭反馈。' },
    } },
  { recording: 'ride-east', station: '广兰路', reviewedOn: '2026-10-23', clipWindowS: [2295, 2311.66],
    reply: '听到了确定',
    events: { open: { at: 2310.82, confidence: 'low', method: 'opening-band-step',
      presenceConfirmed: true, timingConfirmed: false, edgeLimited: true,
      note: '用户只确认开门声已录到；2310.82秒沿用先前声学候选，距文件尾0.84秒，定时保持低置信，不入主均值。' } } },
];

/** Additional user door observations, including the corrected lock timestamp. */
export const USER_DOOR_REFERENCES = {
  recording: 'ride-east' as RecordingId, station: '静安寺',
  open: 127.5, closingMotion: 167.2,
  locked: { raw: '2.50.20', parsedSeconds: 170.2, usable: true },
};

/** Immutable pre-calibration plan snapshot, generated before concurrent model edits.
 * Source: weekday generatePlan/computeRunTimes at the revision below; seconds.
 * Keep the original comparison stable as calibration changes the current model.
 */
export const RIDE_MODEL_BASELINE = {
  revision: '7eead9e', tripG: '3009', tripW: '3002',
  tripAirport: '1433', airportFullSeconds: 4591.03,
  wholeRecordedModelSeconds: 1702.25,
  terminalDN: '广兰路', terminalUP: '蟠祥路·国家会计学院',
  intervals: [
    { direction: 'DN', from: '江苏路', to: '静安寺', runS: 103.5, dwellS: 25.53 },
    { direction: 'DN', from: '静安寺', to: '南京西路', runS: 102.6, dwellS: 25.51 },
    { direction: 'DN', from: '南京西路', to: '人民广场', runS: 94.9, dwellS: 25.66 },
    { direction: 'DN', from: '人民广场', to: '南京东路', runS: 86.4, dwellS: 25.51 },
    { direction: 'DN', from: '南京东路', to: '陆家嘴', runS: 131.9, dwellS: 25.49 },
    { direction: 'DN', from: '陆家嘴', to: '浦东南路', runS: 104.9, dwellS: 20.3 },
    { direction: 'DN', from: '浦东南路', to: '世纪大道', runS: 90.8, dwellS: 25.57 },
    { direction: 'DN', from: '世纪大道', to: '上海科技馆', runS: 117.9, dwellS: 20.22 },
    { direction: 'DN', from: '上海科技馆', to: '世纪公园', runS: 100.9, dwellS: 20.21 },
    { direction: 'DN', from: '世纪公园', to: '龙阳路', runS: 87.9, dwellS: 25.36 },
    { direction: 'DN', from: '龙阳路', to: '张江高科', runS: 172.1, dwellS: 20.29 },
    { direction: 'DN', from: '张江高科', to: '金科路', runS: 98, dwellS: 20.21 },
    { direction: 'DN', from: '金科路', to: '广兰路', runS: 130.6, dwellS: 0 },
    { direction: 'UP', from: '广兰路', to: '金科路', runS: 130.5, dwellS: 20.22 },
  ],
};

/** 2026-10-16 field measurements; old rows and snapshot remain unchanged. */
const FIELD_1016_RIDE_LOG: RideStop[] = [
  { recording: "ride-1016-west-core", station: "中山公园", direction: "UP",
    stop: null, open: null, close: null, closingMotion: null, start: null,
    evidence: {
    }, candidates: {
    }, analysisWindowS: null,
    note: "Traction and next-station announcement already present near the left boundary; no complete origin door/start cycle captured.",
  },
  { recording: "ride-1016-west-core", station: "娄山关路", direction: "UP",
    stop: 130, open: 131.52, close: 150.336, closingMotion: 153.37, start: 157.74,
    evidence: {
      stop: {"confidence": "medium","method": "spectral-knee","bandHz": [650,900],"ridgeFallDb": 3.41,"lowBeforeDb": -24.36,"lowAfterDb": -27.44,"lowFallDb": 3.08,"floorDb": -25.19,"ambiguous": false,"score": 3.84,"edgeLimited": false,"preContextLimited": false},
      open: {"confidence": "medium","method": "opening-band-step","ambiguous": false,"edgeLimited": false,"gainDb": 12.83,"note": "Local 400–2400 Hz band step after the estimated stop. Not a separate opening warning."},
      closingMotion: {"confidence": "low","method": "door-impact-duration","impactAt": 156.37,"travelS": 3,"note": "【假设】Mechanical impact minus 3 s travel measured in the video. This inferred onset stays low and is excluded from means."},
      start: {"confidence": "medium","method": "traction-switch-and-rolling","floorDb": -30.99,"powerAt": 157.74,"rollingConfirmed": false,"note": "Switching/traction cue without a sustained low-band confirmation; video shows motor sound can precede movement by about 2 s. Medium, not frame-verified."},
      close: {"confidence": "high","method": "closing-tone-pulses","note": "Warning onset, not mechanical closing or a spoken announcement. Source-specific bands reviewed."},
    }, candidates: {
      open: {"at": 131.52,"searchRadiusS": 3,"evidence": "opening-band-step"},
      closingMotion: {"at": 153.37,"searchRadiusS": 3,"evidence": "door-impact-duration"},
      start: {"at": 157.74,"searchRadiusS": 3,"evidence": "traction-switch-and-rolling"},
      close: {"at": 150.336,"searchRadiusS": 1,"evidence": "closing-tone-pulses"},
    }, analysisWindowS: [110,133],
  },
  { recording: "ride-1016-west-core", station: "威宁路", direction: "UP",
    stop: 289, open: 294.25, close: null, closingMotion: null, start: null,
    evidence: {
      stop: {"confidence": "low","method": "spectral-knee","bandHz": [650,920],"ridgeFallDb": 2.23,"lowBeforeDb": -26.38,"lowAfterDb": -26.88,"lowFallDb": 0.5,"floorDb": -26.98,"ambiguous": false,"score": 2.58,"edgeLimited": false,"preContextLimited": false},
      open: {"confidence": "low","method": "opening-band-step","ambiguous": true,"edgeLimited": false,"gainDb": 13.29,"note": "Local 400–2400 Hz band step after the estimated stop. Not a separate opening warning."},
    }, candidates: {
      open: {"at": 294.25,"searchRadiusS": 3,"evidence": "opening-band-step"},
    }, analysisWindowS: [275,296],
  },
  { recording: "ride-1016-west-end", station: "淞虹路", direction: "UP",
    stop: 78, open: 82.29, close: 120.768, closingMotion: 123.7, start: 129.54,
    evidence: {
      stop: {"confidence": "medium","method": "spectral-knee","bandHz": [600,900],"ridgeFallDb": 3.76,"lowBeforeDb": -25.24,"lowAfterDb": -26.0,"lowFallDb": 0.75,"floorDb": -26.45,"ambiguous": false,"score": 3.36,"edgeLimited": false,"preContextLimited": false},
      open: {"confidence": "low","method": "opening-band-step","ambiguous": true,"edgeLimited": false,"gainDb": 7.42,"note": "Local 400–2400 Hz band step after the estimated stop. Not a separate opening warning."},
      closingMotion: {"confidence": "low","method": "door-impact-duration","impactAt": 126.7,"travelS": 3,"note": "【假设】Mechanical impact minus 3 s travel measured in the video. This inferred onset stays low and is excluded from means."},
      start: {"confidence": "medium","method": "traction-switch-and-rolling","floorDb": -31.47,"powerAt": 129.54,"rollingConfirmed": false,"note": "Switching/traction cue without a sustained low-band confirmation; video shows motor sound can precede movement by about 2 s. Medium, not frame-verified."},
      close: {"confidence": "high","method": "closing-tone-pulses","note": "Warning onset, not mechanical closing or a spoken announcement. Source-specific bands reviewed."},
    }, candidates: {
      open: {"at": 82.29,"searchRadiusS": 3,"evidence": "opening-band-step"},
      closingMotion: {"at": 123.7,"searchRadiusS": 3,"evidence": "door-impact-duration"},
      start: {"at": 129.54,"searchRadiusS": 3,"evidence": "traction-switch-and-rolling"},
      close: {"at": 120.768,"searchRadiusS": 1,"evidence": "closing-tone-pulses"},
    }, analysisWindowS: [65,94],
  },
  { recording: "ride-1016-west-end", station: "虹桥2号航站楼", direction: "UP",
    stop: 453, open: 455.82, close: 495.616, closingMotion: 498.62, start: 503.6,
    evidence: {
      stop: {"confidence": "low","method": "spectral-knee","bandHz": [650,940],"ridgeFallDb": 2.29,"lowBeforeDb": -23.16,"lowAfterDb": -26.21,"lowFallDb": 3.06,"floorDb": -27.03,"ambiguous": true,"score": 2.38,"edgeLimited": false,"preContextLimited": false},
      open: {"confidence": "medium","method": "opening-band-step","ambiguous": false,"edgeLimited": false,"gainDb": 12.12,"note": "Local 400–2400 Hz band step after the estimated stop. Not a separate opening warning."},
      closingMotion: {"confidence": "low","method": "door-impact-duration","impactAt": 501.62,"travelS": 3,"note": "【假设】Mechanical impact minus 3 s travel measured in the video. This inferred onset stays low and is excluded from means."},
      start: {"confidence": "medium","method": "traction-switch-and-rolling","floorDb": -32.21,"powerAt": 503.6,"rollingConfirmed": false,"note": "Switching/traction cue without a sustained low-band confirmation; video shows motor sound can precede movement by about 2 s. Medium, not frame-verified."},
      close: {"confidence": "high","method": "closing-tone-pulses","note": "Warning onset, not mechanical closing or a spoken announcement. Source-specific bands reviewed."},
    }, candidates: {
      open: {"at": 455.82,"searchRadiusS": 3,"evidence": "opening-band-step"},
      closingMotion: {"at": 498.62,"searchRadiusS": 3,"evidence": "door-impact-duration"},
      start: {"at": 503.6,"searchRadiusS": 3,"evidence": "traction-switch-and-rolling"},
      close: {"at": 495.616,"searchRadiusS": 1,"evidence": "closing-tone-pulses"},
    }, analysisWindowS: [440,475],
  },
  { recording: "ride-1016-west-end", station: "虹桥火车站", direction: "UP",
    stop: 579, open: 584.66, close: 617.536, closingMotion: 619.13, start: 625.62,
    evidence: {
      stop: {"confidence": "high","method": "spectral-knee","bandHz": [600,900],"ridgeFallDb": 8.52,"lowBeforeDb": -23.64,"lowAfterDb": -25.15,"lowFallDb": 1.5,"floorDb": -26.16,"ambiguous": false,"score": 8.58,"edgeLimited": false,"preContextLimited": false},
      open: {"confidence": "low","method": "opening-band-step","ambiguous": true,"edgeLimited": false,"gainDb": 11.09,"note": "Local 400–2400 Hz band step after the estimated stop. Not a separate opening warning."},
      closingMotion: {"confidence": "low","method": "door-impact-duration","impactAt": 622.13,"travelS": 3,"note": "【假设】Mechanical impact minus 3 s travel measured in the video. This inferred onset stays low and is excluded from means."},
      start: {"confidence": "medium","method": "traction-switch-and-rolling","floorDb": -27.16,"powerAt": 625.62,"rollingConfirmed": false,"note": "Switching/traction cue without a sustained low-band confirmation; video shows motor sound can precede movement by about 2 s. Medium, not frame-verified."},
      close: {"confidence": "high","method": "closing-tone-pulses","note": "Warning onset, not mechanical closing or a spoken announcement. Source-specific bands reviewed."},
    }, candidates: {
      open: {"at": 584.66,"searchRadiusS": 3,"evidence": "opening-band-step"},
      closingMotion: {"at": 619.13,"searchRadiusS": 3,"evidence": "door-impact-duration"},
      start: {"at": 625.62,"searchRadiusS": 3,"evidence": "traction-switch-and-rolling"},
      close: {"at": 617.536,"searchRadiusS": 1,"evidence": "closing-tone-pulses"},
    }, analysisWindowS: [565,598],
  },
  { recording: "ride-1016-west-end", station: "国家会展中心", direction: "UP",
    stop: 765, open: 767.91, close: 809.664, closingMotion: 812.57, start: 818.02,
    evidence: {
      stop: {"confidence": "high","method": "spectral-knee","bandHz": [650,900],"ridgeFallDb": 7.68,"lowBeforeDb": -23.03,"lowAfterDb": -23.81,"lowFallDb": 0.78,"floorDb": -23.84,"ambiguous": false,"score": 7.96,"edgeLimited": false,"preContextLimited": false},
      open: {"confidence": "medium","method": "opening-band-step","ambiguous": false,"edgeLimited": false,"gainDb": 7.09,"note": "Local 400–2400 Hz band step after the estimated stop. Not a separate opening warning."},
      closingMotion: {"confidence": "low","method": "door-impact-duration","impactAt": 815.57,"travelS": 3,"note": "【假设】Mechanical impact minus 3 s travel measured in the video. This inferred onset stays low and is excluded from means."},
      start: {"confidence": "medium","method": "traction-switch-and-rolling","floorDb": -25.49,"powerAt": 818.02,"rollingConfirmed": false,"note": "Switching/traction cue without a sustained low-band confirmation; video shows motor sound can precede movement by about 2 s. Medium, not frame-verified."},
      close: {"confidence": "high","method": "closing-tone-pulses","note": "Warning onset, not mechanical closing or a spoken announcement. Source-specific bands reviewed."},
    }, candidates: {
      open: {"at": 767.91,"searchRadiusS": 3,"evidence": "opening-band-step"},
      closingMotion: {"at": 812.57,"searchRadiusS": 3,"evidence": "door-impact-duration"},
      start: {"at": 818.02,"searchRadiusS": 3,"evidence": "traction-switch-and-rolling"},
      close: {"at": 809.664,"searchRadiusS": 1,"evidence": "closing-tone-pulses"},
    }, analysisWindowS: [755,790],
  },
  { recording: "ride-1016-west-end", station: "蟠祥路·国家会计学院", direction: "UP",
    stop: 946, open: 948.72, close: null, closingMotion: null, start: null,
    evidence: {
      stop: {"confidence": "medium","method": "spectral-knee","bandHz": [650,900],"ridgeFallDb": 5.71,"lowBeforeDb": -21.05,"lowAfterDb": -21.63,"lowFallDb": 0.58,"floorDb": -22.12,"ambiguous": false,"score": 6.6,"edgeLimited": false,"preContextLimited": false},
      open: {"confidence": "low","method": "opening-band-step","ambiguous": true,"edgeLimited": false,"gainDb": 0.88,"note": "Local 400–2400 Hz band step after the estimated stop. Not a separate opening warning."},
    }, candidates: {
      open: {"at": 948.72,"searchRadiusS": 3,"evidence": "opening-band-step"},
    }, analysisWindowS: [935,951],
    note: "Terminating announcement at 907–917 s. File ends at 951 s, shortly after low-confidence opening candidate; no closing, reversal or onward departure captured.",
  },
  { recording: "ride-1016-east-end", station: "虹桥火车站", direction: "DN",
    stop: null, open: null, close: 4.992, closingMotion: 7.94, start: 19.94,
    evidence: {
      closingMotion: {"confidence": "low","method": "door-impact-duration","impactAt": 10.94,"travelS": 3,"note": "【假设】Mechanical impact minus 3 s travel measured in the video. This inferred onset stays low and is excluded from means."},
      start: {"confidence": "medium","method": "traction-switch-and-rolling","floorDb": -27.63,"powerAt": 19.94,"rollingConfirmed": false,"note": "Switching/traction cue without a sustained low-band confirmation; video shows motor sound can precede movement by about 2 s. Medium, not frame-verified."},
      close: {"confidence": "high","method": "closing-tone-pulses","note": "Warning onset, not mechanical closing or a spoken announcement. Source-specific bands reviewed."},
    }, candidates: {
      closingMotion: {"at": 7.94,"searchRadiusS": 3,"evidence": "door-impact-duration"},
      start: {"at": 19.94,"searchRadiusS": 3,"evidence": "traction-switch-and-rolling"},
      close: {"at": 4.992,"searchRadiusS": 1,"evidence": "closing-tone-pulses"},
    }, analysisWindowS: null,
    note: "【假设】Filename route starts at 国家会展中心, but next/arrival PA establishes the captured first interval as 虹桥火车站→虹桥2号航站楼. Initial stop/open not captured.",
  },
  { recording: "ride-1016-east-end", station: "虹桥2号航站楼", direction: "DN",
    stop: 81, open: 86.22, close: 122.048, closingMotion: 124.97, start: 135.52,
    evidence: {
      stop: {"confidence": "medium","method": "spectral-knee","bandHz": [650,900],"ridgeFallDb": 5.0,"lowBeforeDb": -22.54,"lowAfterDb": -22.88,"lowFallDb": 0.35,"floorDb": -22.85,"ambiguous": false,"score": 4.97,"edgeLimited": false,"preContextLimited": false},
      open: {"confidence": "medium","method": "opening-band-step","ambiguous": false,"edgeLimited": false,"gainDb": 10.3,"note": "Local 400–2400 Hz band step after the estimated stop. Not a separate opening warning."},
      closingMotion: {"confidence": "low","method": "door-impact-duration","impactAt": 127.97,"travelS": 3,"note": "【假设】Mechanical impact minus 3 s travel measured in the video. This inferred onset stays low and is excluded from means."},
      start: {"confidence": "medium","method": "traction-switch-and-rolling","floorDb": -28.39,"powerAt": 135.52,"rollingConfirmed": false,"note": "Switching/traction cue without a sustained low-band confirmation; video shows motor sound can precede movement by about 2 s. Medium, not frame-verified."},
      close: {"confidence": "high","method": "closing-tone-pulses","note": "Warning onset, not mechanical closing or a spoken announcement. Source-specific bands reviewed."},
    }, candidates: {
      open: {"at": 86.22,"searchRadiusS": 3,"evidence": "opening-band-step"},
      closingMotion: {"at": 124.97,"searchRadiusS": 3,"evidence": "door-impact-duration"},
      start: {"at": 135.52,"searchRadiusS": 3,"evidence": "traction-switch-and-rolling"},
      close: {"at": 122.048,"searchRadiusS": 1,"evidence": "closing-tone-pulses"},
    }, analysisWindowS: [73,88],
  },
  { recording: "ride-1016-east-end", station: "淞虹路", direction: "DN",
    stop: 454, open: 457.95, close: null, closingMotion: null, start: null,
    evidence: {
      stop: {"confidence": "high","method": "spectral-knee","bandHz": [650,900],"ridgeFallDb": 10.77,"lowBeforeDb": -24.57,"lowAfterDb": -25.67,"lowFallDb": 1.1,"floorDb": -25.97,"ambiguous": false,"score": 7.61,"edgeLimited": false,"preContextLimited": false},
      open: {"confidence": "medium","method": "opening-band-step","ambiguous": false,"edgeLimited": false,"gainDb": 7.51,"note": "Local 400–2400 Hz band step after the estimated stop. Not a separate opening warning."},
    }, candidates: {
      open: {"at": 457.95,"searchRadiusS": 3,"evidence": "opening-band-step"},
    }, analysisWindowS: [440,487.54],
  },
  { recording: "ride-1016-east-night", station: "北新泾", direction: "DN",
    stop: 68, open: 71.63, close: 107.264, closingMotion: 110.2, start: 114.69,
    evidence: {
      stop: {"confidence": "high","method": "spectral-knee","bandHz": [600,900],"ridgeFallDb": 11.75,"lowBeforeDb": -25.23,"lowAfterDb": -26.06,"lowFallDb": 0.83,"floorDb": -26.2,"ambiguous": false,"score": 12.01,"edgeLimited": false,"preContextLimited": false},
      open: {"confidence": "medium","method": "opening-band-step","ambiguous": false,"edgeLimited": false,"gainDb": 12.65,"note": "Local 400–2400 Hz band step after the estimated stop. Not a separate opening warning."},
      closingMotion: {"confidence": "low","method": "door-impact-duration","impactAt": 113.2,"travelS": 3,"note": "【假设】Mechanical impact minus 3 s travel measured in the video. This inferred onset stays low and is excluded from means."},
      start: {"confidence": "medium","method": "traction-switch-and-rolling","floorDb": -29.52,"powerAt": 114.69,"rollingConfirmed": false,"note": "Switching/traction cue without a sustained low-band confirmation; video shows motor sound can precede movement by about 2 s. Medium, not frame-verified."},
      close: {"confidence": "high","method": "closing-tone-pulses","note": "Warning onset, not mechanical closing or a spoken announcement. Source-specific bands reviewed."},
    }, candidates: {
      open: {"at": 71.63,"searchRadiusS": 3,"evidence": "opening-band-step"},
      closingMotion: {"at": 110.2,"searchRadiusS": 3,"evidence": "door-impact-duration"},
      start: {"at": 114.69,"searchRadiusS": 3,"evidence": "traction-switch-and-rolling"},
      close: {"at": 107.264,"searchRadiusS": 1,"evidence": "closing-tone-pulses"},
    }, analysisWindowS: [55,73],
  },
  { recording: "ride-1016-east-night", station: "威宁路", direction: "DN",
    stop: 234, open: 234.75, close: 270.208, closingMotion: 273.18, start: 279.44,
    evidence: {
      stop: {"confidence": "low","method": "spectral-knee","bandHz": [650,920],"ridgeFallDb": 3.16,"lowBeforeDb": -24.09,"lowAfterDb": -23.86,"lowFallDb": -0.23,"floorDb": -24.93,"ambiguous": true,"score": 2.48,"edgeLimited": false,"preContextLimited": false},
      open: {"confidence": "low","method": "opening-band-step","ambiguous": true,"edgeLimited": false,"gainDb": 10.51,"note": "Local 400–2400 Hz band step after the estimated stop. Not a separate opening warning."},
      closingMotion: {"confidence": "low","method": "door-impact-duration","impactAt": 276.18,"travelS": 3,"note": "【假设】Mechanical impact minus 3 s travel measured in the video. This inferred onset stays low and is excluded from means."},
      start: {"confidence": "medium","method": "traction-switch-and-rolling","floorDb": -31.43,"powerAt": 279.44,"rollingConfirmed": false,"note": "Switching/traction cue without a sustained low-band confirmation; video shows motor sound can precede movement by about 2 s. Medium, not frame-verified."},
      close: {"confidence": "high","method": "closing-tone-pulses","note": "Warning onset, not mechanical closing or a spoken announcement. Source-specific bands reviewed."},
    }, candidates: {
      open: {"at": 234.75,"searchRadiusS": 3,"evidence": "opening-band-step"},
      closingMotion: {"at": 273.18,"searchRadiusS": 3,"evidence": "door-impact-duration"},
      start: {"at": 279.44,"searchRadiusS": 3,"evidence": "traction-switch-and-rolling"},
      close: {"at": 270.208,"searchRadiusS": 1,"evidence": "closing-tone-pulses"},
    }, analysisWindowS: [217,234],
  },
  { recording: "ride-1016-east-night", station: "娄山关路", direction: "DN",
    stop: 409, open: 412.74, close: 458.176, closingMotion: 461.16, start: 468.61,
    evidence: {
      stop: {"confidence": "high","method": "spectral-knee","bandHz": [650,900],"ridgeFallDb": 8.63,"lowBeforeDb": -18.62,"lowAfterDb": -21.75,"lowFallDb": 3.13,"floorDb": -21.73,"ambiguous": false,"score": 10.93,"edgeLimited": false,"preContextLimited": false},
      open: {"confidence": "medium","method": "opening-band-step","ambiguous": false,"edgeLimited": false,"gainDb": 10.52,"note": "Local 400–2400 Hz band step after the estimated stop. Not a separate opening warning."},
      closingMotion: {"confidence": "low","method": "door-impact-duration","impactAt": 464.16,"travelS": 3,"note": "【假设】Mechanical impact minus 3 s travel measured in the video. This inferred onset stays low and is excluded from means."},
      start: {"confidence": "medium","method": "traction-switch-and-rolling","floorDb": -31.06,"powerAt": 466.05,"rollingConfirmed": true},
      close: {"confidence": "high","method": "closing-tone-pulses","note": "Warning onset, not mechanical closing or a spoken announcement. Source-specific bands reviewed."},
    }, candidates: {
      open: {"at": 412.74,"searchRadiusS": 3,"evidence": "opening-band-step"},
      closingMotion: {"at": 461.16,"searchRadiusS": 3,"evidence": "door-impact-duration"},
      start: {"at": 468.61,"searchRadiusS": 3,"evidence": "traction-switch-and-rolling"},
      close: {"at": 458.176,"searchRadiusS": 1,"evidence": "closing-tone-pulses"},
    }, analysisWindowS: [397,419],
  },
  { recording: "ride-1016-east-night", station: "中山公园", direction: "DN",
    stop: 606, open: 610.1, close: 651.2, closingMotion: 654.15, start: 660.98,
    evidence: {
      stop: {"confidence": "high","method": "spectral-knee","bandHz": [650,900],"ridgeFallDb": 10.27,"lowBeforeDb": -26.41,"lowAfterDb": -27.17,"lowFallDb": 0.76,"floorDb": -26.39,"ambiguous": false,"score": 9.17,"edgeLimited": false,"preContextLimited": false},
      open: {"confidence": "medium","method": "opening-band-step","ambiguous": false,"edgeLimited": false,"gainDb": 14.03,"note": "Local 400–2400 Hz band step after the estimated stop. Not a separate opening warning."},
      closingMotion: {"confidence": "low","method": "door-impact-duration","impactAt": 657.15,"travelS": 3,"note": "【假设】Mechanical impact minus 3 s travel measured in the video. This inferred onset stays low and is excluded from means."},
      start: {"confidence": "medium","method": "traction-switch-and-rolling","floorDb": -30.08,"powerAt": 660.98,"rollingConfirmed": false,"note": "Switching/traction cue without a sustained low-band confirmation; video shows motor sound can precede movement by about 2 s. Medium, not frame-verified."},
      close: {"confidence": "high","method": "closing-tone-pulses","note": "Warning onset, not mechanical closing or a spoken announcement. Source-specific bands reviewed."},
    }, candidates: {
      open: {"at": 610.1,"searchRadiusS": 3,"evidence": "opening-band-step"},
      closingMotion: {"at": 654.15,"searchRadiusS": 3,"evidence": "door-impact-duration"},
      start: {"at": 660.98,"searchRadiusS": 3,"evidence": "traction-switch-and-rolling"},
      close: {"at": 651.2,"searchRadiusS": 1,"evidence": "closing-tone-pulses"},
    }, analysisWindowS: [592,618],
  },
  { recording: "ride-1016-east-night", station: "江苏路", direction: "DN",
    stop: 789, open: 794.41, close: 850.176, closingMotion: 853.14, start: 857.82,
    evidence: {
      stop: {"confidence": "low","method": "spectral-knee","bandHz": [550,900],"ridgeFallDb": 4.82,"lowBeforeDb": -19.22,"lowAfterDb": -24.94,"lowFallDb": 5.72,"floorDb": -27.3,"ambiguous": false,"score": 5.3,"edgeLimited": false,"preContextLimited": false},
      open: {"confidence": "medium","method": "opening-band-step","ambiguous": false,"edgeLimited": false,"gainDb": 14.35,"note": "Local 400–2400 Hz band step after the estimated stop. Not a separate opening warning."},
      closingMotion: {"confidence": "low","method": "door-impact-duration","impactAt": 856.14,"travelS": 3,"note": "【假设】Mechanical impact minus 3 s travel measured in the video. This inferred onset stays low and is excluded from means."},
      start: {"confidence": "medium","method": "traction-switch-and-rolling","floorDb": -30.96,"powerAt": 857.82,"rollingConfirmed": false,"note": "Switching/traction cue without a sustained low-band confirmation; video shows motor sound can precede movement by about 2 s. Medium, not frame-verified."},
      close: {"confidence": "high","method": "closing-tone-pulses","note": "Warning onset, not mechanical closing or a spoken announcement. Source-specific bands reviewed."},
    }, candidates: {
      open: {"at": 794.41,"searchRadiusS": 3,"evidence": "opening-band-step"},
      closingMotion: {"at": 853.14,"searchRadiusS": 3,"evidence": "door-impact-duration"},
      start: {"at": 857.82,"searchRadiusS": 3,"evidence": "traction-switch-and-rolling"},
      close: {"at": 850.176,"searchRadiusS": 1,"evidence": "closing-tone-pulses"},
    }, analysisWindowS: [772,800],
  },
  { recording: "ride-1016-east-night", station: "静安寺", direction: "DN",
    stop: 1012, open: 1014.78, close: 1032.192, closingMotion: 1035.14, start: 1040.54,
    evidence: {
      stop: {"confidence": "high","method": "spectral-knee","bandHz": [650,900],"ridgeFallDb": 12.44,"lowBeforeDb": -24.52,"lowAfterDb": -26.83,"lowFallDb": 2.31,"floorDb": -26.92,"ambiguous": false,"score": 13.66,"edgeLimited": false,"preContextLimited": false},
      open: {"confidence": "medium","method": "opening-band-step","ambiguous": false,"edgeLimited": false,"gainDb": 12.79,"note": "Local 400–2400 Hz band step after the estimated stop. Not a separate opening warning."},
      closingMotion: {"confidence": "low","method": "door-impact-duration","impactAt": 1038.14,"travelS": 3,"note": "【假设】Mechanical impact minus 3 s travel measured in the video. This inferred onset stays low and is excluded from means."},
      start: {"confidence": "medium","method": "traction-switch-and-rolling","floorDb": -29.18,"powerAt": 1040.54,"rollingConfirmed": false,"note": "Switching/traction cue without a sustained low-band confirmation; video shows motor sound can precede movement by about 2 s. Medium, not frame-verified."},
      close: {"confidence": "high","method": "closing-tone-pulses","note": "Warning onset, not mechanical closing or a spoken announcement. Source-specific bands reviewed."},
    }, candidates: {
      open: {"at": 1014.78,"searchRadiusS": 3,"evidence": "opening-band-step"},
      closingMotion: {"at": 1035.14,"searchRadiusS": 3,"evidence": "door-impact-duration"},
      start: {"at": 1040.54,"searchRadiusS": 3,"evidence": "traction-switch-and-rolling"},
      close: {"at": 1032.192,"searchRadiusS": 1,"evidence": "closing-tone-pulses"},
    }, analysisWindowS: [996,1016],
  },
  { recording: "ride-1016-east-night", station: "南京西路", direction: "DN",
    stop: 1167, open: 1168.47, close: 1200.192, closingMotion: 1203.13, start: 1210,
    evidence: {
      stop: {"confidence": "medium","method": "spectral-knee","bandHz": [600,900],"ridgeFallDb": 5.7,"lowBeforeDb": -24.48,"lowAfterDb": -24.8,"lowFallDb": 0.32,"floorDb": -24.77,"ambiguous": false,"score": 3.54,"edgeLimited": false,"preContextLimited": false},
      open: {"confidence": "medium","method": "opening-band-step","ambiguous": false,"edgeLimited": false,"gainDb": 13.68,"note": "Local 400–2400 Hz band step after the estimated stop. Not a separate opening warning."},
      closingMotion: {"confidence": "low","method": "door-impact-duration","impactAt": 1206.13,"travelS": 3,"note": "【假设】Mechanical impact minus 3 s travel measured in the video. This inferred onset stays low and is excluded from means."},
      close: {"confidence": "high","method": "closing-tone-pulses","note": "Warning onset, not mechanical closing or a spoken announcement. Source-specific bands reviewed."},
      start: {"confidence": "low","method": "rising-traction-band","note": "Switching-tone rule did not return a stable cue; spectral review of the rising 0.5–0.95 kHz band. Estimate retained, excluded from means."},
    }, candidates: {
      open: {"at": 1168.47,"searchRadiusS": 3,"evidence": "opening-band-step"},
      closingMotion: {"at": 1203.13,"searchRadiusS": 3,"evidence": "door-impact-duration"},
      close: {"at": 1200.192,"searchRadiusS": 1,"evidence": "closing-tone-pulses"},
      start: {"at": 1210,"searchRadiusS": 3,"evidence": "rising-traction-band"},
    }, analysisWindowS: [1154,1182],
  },
  { recording: "ride-1016-east-night", station: "人民广场", direction: "DN",
    stop: 1326, open: 1329.17, close: 1370.112, closingMotion: 1373.08, start: 1380.48,
    evidence: {
      stop: {"confidence": "high","method": "spectral-knee","bandHz": [650,900],"ridgeFallDb": 7.83,"lowBeforeDb": -25.89,"lowAfterDb": -26.8,"lowFallDb": 0.91,"floorDb": -26.58,"ambiguous": false,"score": 8.03,"edgeLimited": false,"preContextLimited": false},
      open: {"confidence": "medium","method": "opening-band-step","ambiguous": false,"edgeLimited": false,"gainDb": 8.5,"note": "Local 400–2400 Hz band step after the estimated stop. Not a separate opening warning."},
      closingMotion: {"confidence": "low","method": "door-impact-duration","impactAt": 1376.08,"travelS": 3,"note": "【假设】Mechanical impact minus 3 s travel measured in the video. This inferred onset stays low and is excluded from means."},
      start: {"confidence": "medium","method": "traction-switch-and-rolling","floorDb": -30.86,"powerAt": 1380.48,"rollingConfirmed": false,"note": "Switching/traction cue without a sustained low-band confirmation; video shows motor sound can precede movement by about 2 s. Medium, not frame-verified."},
      close: {"confidence": "high","method": "closing-tone-pulses","note": "Warning onset, not mechanical closing or a spoken announcement. Source-specific bands reviewed."},
    }, candidates: {
      open: {"at": 1329.17,"searchRadiusS": 3,"evidence": "opening-band-step"},
      closingMotion: {"at": 1373.08,"searchRadiusS": 3,"evidence": "door-impact-duration"},
      start: {"at": 1380.48,"searchRadiusS": 3,"evidence": "traction-switch-and-rolling"},
      close: {"at": 1370.112,"searchRadiusS": 1,"evidence": "closing-tone-pulses"},
    }, analysisWindowS: [1313,1341],
  },
  { recording: "ride-1016-east-night", station: "南京东路", direction: "DN",
    stop: 1483, open: 1487.86, close: 1526.208, closingMotion: 1529.18, start: 1536,
    evidence: {
      stop: {"confidence": "medium","method": "spectral-knee","bandHz": [600,900],"ridgeFallDb": 5.67,"lowBeforeDb": -25.28,"lowAfterDb": -26.47,"lowFallDb": 1.19,"floorDb": -26.47,"ambiguous": false,"score": 6.63,"edgeLimited": false,"preContextLimited": false},
      open: {"confidence": "medium","method": "opening-band-step","ambiguous": false,"edgeLimited": false,"gainDb": 11.15,"note": "Local 400–2400 Hz band step after the estimated stop. Not a separate opening warning."},
      closingMotion: {"confidence": "low","method": "door-impact-duration","impactAt": 1532.18,"travelS": 3,"note": "【假设】Mechanical impact minus 3 s travel measured in the video. This inferred onset stays low and is excluded from means."},
      close: {"confidence": "high","method": "closing-tone-pulses","note": "Warning onset, not mechanical closing or a spoken announcement. Source-specific bands reviewed."},
      start: {"confidence": "low","method": "rising-traction-band","note": "Switching-tone rule did not return a stable cue; spectral review of the rising 0.5–0.95 kHz band. Estimate retained, excluded from means."},
    }, candidates: {
      open: {"at": 1487.86,"searchRadiusS": 3,"evidence": "opening-band-step"},
      closingMotion: {"at": 1529.18,"searchRadiusS": 3,"evidence": "door-impact-duration"},
      close: {"at": 1526.208,"searchRadiusS": 1,"evidence": "closing-tone-pulses"},
      start: {"at": 1536,"searchRadiusS": 3,"evidence": "rising-traction-band"},
    }, analysisWindowS: [1470,1499],
  },
  { recording: "ride-1016-east-night", station: "陆家嘴", direction: "DN",
    stop: 1672, open: 1678.54, close: 1709.184, closingMotion: 1712.17, start: 1716.72,
    evidence: {
      stop: {"confidence": "low","method": "spectral-knee","bandHz": [650,900],"ridgeFallDb": 6.91,"lowBeforeDb": -25.72,"lowAfterDb": -26.32,"lowFallDb": 0.6,"floorDb": -26.38,"ambiguous": true,"score": 4.65,"edgeLimited": false,"preContextLimited": false},
      open: {"confidence": "medium","method": "opening-band-step","ambiguous": false,"edgeLimited": false,"gainDb": 10.67,"note": "Local 400–2400 Hz band step after the estimated stop. Not a separate opening warning."},
      closingMotion: {"confidence": "low","method": "door-impact-duration","impactAt": 1715.17,"travelS": 3,"note": "【假设】Mechanical impact minus 3 s travel measured in the video. This inferred onset stays low and is excluded from means."},
      start: {"confidence": "medium","method": "traction-switch-and-rolling","floorDb": -29.09,"powerAt": 1716.72,"rollingConfirmed": false,"note": "Switching/traction cue without a sustained low-band confirmation; video shows motor sound can precede movement by about 2 s. Medium, not frame-verified."},
      close: {"confidence": "high","method": "closing-tone-pulses","note": "Warning onset, not mechanical closing or a spoken announcement. Source-specific bands reviewed."},
    }, candidates: {
      open: {"at": 1678.54,"searchRadiusS": 3,"evidence": "opening-band-step"},
      closingMotion: {"at": 1712.17,"searchRadiusS": 3,"evidence": "door-impact-duration"},
      start: {"at": 1716.72,"searchRadiusS": 3,"evidence": "traction-switch-and-rolling"},
      close: {"at": 1709.184,"searchRadiusS": 1,"evidence": "closing-tone-pulses"},
    }, analysisWindowS: [1662,1685],
  },
  { recording: "ride-1016-east-night", station: "浦东南路", direction: "DN",
    stop: 1829, open: 1833.72, close: null, closingMotion: null, start: null,
    evidence: {
      stop: {"confidence": "medium","method": "spectral-knee","bandHz": [650,900],"ridgeFallDb": 4.63,"lowBeforeDb": -26.07,"lowAfterDb": -26.53,"lowFallDb": 0.47,"floorDb": -26.5,"ambiguous": false,"score": 3.64,"edgeLimited": false,"preContextLimited": false},
      open: {"confidence": "medium","method": "opening-band-step","ambiguous": false,"edgeLimited": false,"gainDb": 11.59,"note": "Local 400–2400 Hz band step after the estimated stop. Not a separate opening warning."},
    }, candidates: {
      open: {"at": 1833.72,"searchRadiusS": 3,"evidence": "opening-band-step"},
    }, analysisWindowS: [1819,1845],
  },
];
RIDE_LOG.push(...FIELD_1016_RIDE_LOG);


export { RIDE_MEASURED_EVENTS, usableRideEvent, summarizeRideLog } from '../../rideEvidence';
