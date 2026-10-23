/**
 * 02A05 traction sound (TKQ506B-2000 IGBT-VVVF, 纵横机电): where in two
 * recordings the inverter runs at a given stator frequency.
 *
 * The recordings are electromagnetic pick-ups of a Line 2 train (Bilibili
 * BV1VGZiBPEjt, p02), supplied by the user: one complete start under power
 * (p02 6.2–39.6 s → traction.mp3) and one complete electric-brake stop
 * (p02 66.0–96.8 s → brake.mp3). They are third-party material and are not in
 * the repository (public/sounds/vvvf/ is git-ignored); without them the sound
 * stays silent. The tables below are measurements of those files.
 *
 * Stator fundamental f₁ (the low line in the spectrogram) tracked with a 0.8 s
 * window, avoiding the 50 / 100 Hz mains lines; monotonic-smoothed. Below
 * ~25 Hz the fundamental is too weak to track: the start is taken from the
 * spacing of the asynchronous-PWM sidebands (fc ± f₁: 40 Hz apart at 12 s,
 * 85 Hz at 17.5 s → ~4 Hz/s) back to zero at 6.6 s, the tail of the brake
 * from its constant slope (3.9 Hz/s) to a stand.
 *
 * Speed ↔ f₁ 【假设】: 4-pole motors, gear ratio ≈6.3, 840 mm wheels →
 * f₁ ≈ 4.77 Hz per m/s (106 Hz at 80 km/h), slip ignored. Consistent with the
 * recordings: their slopes are 0.84 m/s² under power and 0.78 m/s² braking,
 * an ATO start and a service brake. The recordings reach ~94 Hz (≈70 km/h);
 * above that the steady end of the run is resampled (src/ui/vvvf.ts).
 */
export const VVVF_HZ_PER_MS = 4.77;

/** [seconds into traction.mp3, f₁ Hz], f₁ rising */
export const VVVF_TRACTION: [number, number][] = [
  [0.2, 0], [1.2, 2], [5.8, 20], [8.8, 30.8], [9.8, 35.3], [10.8, 39.7], [11.8, 44.1], [12.8, 47.5],
  [13.8, 52.8], [14.8, 57.3], [15.8, 61.6], [16.8, 65.5], [17.8, 69.2], [18.8, 72.7], [19.8, 75.3],
  [20.8, 77], [21.8, 78.3], [22.8, 79.1], [23.8, 80.6], [24.8, 83.3], [25.8, 85.8], [26.8, 88.1],
  [27.8, 90.3], [28.8, 92], [29.8, 93], [33.2, 93.8],
];

/** [seconds into brake.mp3, f₁ Hz], f₁ falling; 0–8 s is a steady stretch before the brake */
export const VVVF_BRAKE: [number, number][] = [
  [0, 81.6], [1, 80.9], [4, 80.8], [8, 80.5], [9, 78.9], [10, 76.7], [11, 73.4], [12, 70], [13, 66.4],
  [14, 62.7], [15, 58.9], [16, 55.2], [17, 51.6], [18, 47.7], [19, 43.4], [20, 39.7], [21, 35.6],
  [22, 31.9], [23, 27.7], [30.1, 0],
];

export interface VvvfClip {
  file: string;
  table: [number, number][];
  /** [begin seconds, end seconds, f1 Hz] for synchronous steady resampling. */
  plateau: [number, number, number];
}
export interface VvvfTake { id: string; vehicleType: string; power: VvvfClip; brake: VvvfClip }

/**
 * Measured local-only takes. Post p1/p2: 2025-08-04, 02113; pre 1:
 * 2023-09-30, 02091; pre 2: 2023-04-16, 02090. All title cards identify
 * 02A05 / 纵横IGBT; three also name TKQ506B-2000. The same 950 Hz asynchronous carrier and synchronous
 * harmonic families remain audible before/after CBTC, so these takes may mix
 * for this stock only; they say nothing about other types. Low f1 tails are
 * extrapolated (weak below 25 Hz), with the same 4.77 Hz/(m/s) assumption.
 * Third-party media stays git-ignored; scripts/vvvf-clips.sh cuts the files.
 */
export const VVVF_TAKES: readonly VvvfTake[] = [
  { id: 'post-p1', vehicleType: '02A05', power: { file: 'post-p1-traction', table: [[0, 0], [6.8, 26.2], [7.8, 30], [8.8, 35.7], [9.8, 41.1], [10.8, 45.7], [11.8, 50.8], [12.8, 55.4], [13.8, 60.5], [14.8, 65], [15.8, 69.4], [17.8, 75.3], [19.8, 77.5], [21.8, 78.8], [24.3, 80.7]], plateau: [21.8, 24.3, 79.8] },
    brake: { file: 'post-p1-brake', table: [[0, 80.7], [7.1, 80.5], [8.6, 78.5], [11.6, 70], [13.6, 62.7], [16.6, 51.5], [18.6, 43.5], [21.6, 32.8], [23.6, 25], [30, 0]], plateau: [0.2, 7, 80.7] } },
  { id: 'post-p2', vehicleType: '02A05', power: { file: 'traction', table: VVVF_TRACTION, plateau: [28.8, 33.1, 93.4] },
    brake: { file: 'brake', table: VVVF_BRAKE, plateau: [0.6, 7.9, 80.7] } },
  { id: 'pre-1', vehicleType: '02A05', power: { file: 'pre-1-traction', table: [[0, 0], [8.4, 31], [10.4, 42], [12.4, 52], [14.4, 62], [16.4, 71], [18.4, 78], [20.4, 84], [22.4, 87], [25.1, 88]], plateau: [22.4, 25.1, 87.5] },
    brake: { file: 'pre-1-brake', table: [[0, 88], [4, 87], [7, 81], [11, 73], [16, 62], [21, 53], [24.2, 49], [36, 49], [45, 47], [48, 38], [51, 28], [57.8, 0]], plateau: [0, 3, 88] } },
  { id: 'pre-2', vehicleType: '02A05', power: { file: 'pre-2-traction', table: [[0, 0], [9, 35], [11, 44], [13, 54], [15, 64], [17, 72], [19, 77], [20, 78]], plateau: [18, 19.8, 77] },
    brake: { file: 'pre-2-brake', table: [[0, 105], [2, 99], [4, 93], [8, 78], [12, 66], [16, 58], [24, 58], [27.2, 56], [29, 50], [32, 41], [40, 0]], plateau: [15.8, 24, 58] } },
];
