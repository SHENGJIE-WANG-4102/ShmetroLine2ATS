/**
 * Colour tokens and sizes shared by the Pixi renderer and the DOM panels.
 *
 * Visual hierarchy: normal states are muted greys / desaturated tones;
 * abnormal states (delay, TSR, hold, degraded trains) use amber, orange,
 * yellow and violet; red is reserved for faults and alarms.
 */
import { LINE } from '../data/current';

export const C = {
  bg: 0x05080c,
  panel: 0x0a1018,
  grid: 0x111a24,
  gridStrong: 0x1a2735,
  frame: 0x16212d,
  text: 0xc6d2de,
  textDim: 0x7d8fa1,
  textMuted: 0x5d6e80,
  textBright: 0xffffff,
  line: Number.parseInt(LINE.branding.color.replace('#', ''), 16),

  // track states
  trackFree: 0x3a4c60,
  trackFreeSide: 0x2f3e4f,
  routeAuto: 0x3b5a4d,
  routeSet: 0x46d47c,
  routeGuide: 0xe8eef5,
  occComm: 0x60758c,
  occAxle: 0xff9a3c,
  disturbed: 0xff4040,
  preset: 0xffd400,
  blocked: 0xb07cff,
  tsr: 0xffd400,
  env: 0x5cc8ff,

  // signals
  sigStopDim: 0x55626f,
  sigStop: 0x9a3a3a,
  sigGreen: 0x3fd47a,
  sigYellow: 0xffd400,
  sigWhite: 0xf2f2f2,
  sigFault: 0xff4040,
  sigMast: 0x6f8193,

  // platforms
  platform: 0x1d2c3b,
  platformHold: 0xffc400,
  platformSkip: 0x5cc8ff,
  crowdLow: 0x3e6b8a,
  crowdMid: 0xffc400,
  crowdHigh: 0xff8a2a,

  // trains
  trainCbtc: 0xa8dcff,
  trainNonComm: 0xff9a3c,
  trainRm: 0xffd400,
  trainManual: 0xe08cff,
  trainFail: 0xff4040,
  trainBoxFill: 0x0b131c,
  trainBoxBorder: 0x3a4b5c,
  onTime: 0x9fb4c8,
  early: 0x5cc8ff,
  slightLate: 0xffc400,
  late: 0xff8a2a,
  nonService: 0x6f8193,
  selection: 0x00e5ff,
  fault: 0xff4040,

  // train graph
  planBig: 0x4f6f96,
  planSmall: 0x4c7f68,
  planLate: 0x6a6496,
  planExtra: 0x9a7a4a,
  planIns: 0x5d6e80,
  planEmpty: 0x3d4855,
  planAdj: 0x8a5a7a,
  actOnTime: 0x46d47c,
  actSlight: 0xffd400,
  actLate: 0xff8a2a,
  actVeryLate: 0xff5a5a,
  nowLine: 0xffd400,
};

export const FONT_CN = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", "Hiragino Sans GB", "WenQuanYi Micro Hei", sans-serif';
export const FONT_MONO = '"JetBrains Mono", "Consolas", "Menlo", monospace';

export const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

export const DESIGN_W = 3840;
export const DESIGN_H = 2160;

export function fmtTime(t: number, sec = true): string {
  const s = Math.floor(((t % 86400) + 86400) % 86400);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return sec ? `${pad(h)}:${pad(m)}:${pad(ss)}` : `${pad(h)}:${pad(m)}`;
}
export const pad = (n: number) => String(n).padStart(2, '0');

export function fmtDelay(d: number): string {
  const a = Math.abs(Math.round(d));
  const m = Math.floor(a / 60);
  const s = a % 60;
  return `${d < 0 ? '早' : '晚'}${m}'${pad(s)}"`;
}

/** delay → status colour (normal muted, abnormal salient, never red) */
export function delayColor(delay: number, inService = true): number {
  if (!inService) return C.nonService;
  if (delay > 300) return C.late;
  if (delay > 120) return C.slightLate;
  if (delay < -60) return C.early;
  return C.onTime;
}

/** load factor (0..1.3) → colour */
export function loadColor(f: number): number {
  if (f > 1.0) return C.crowdHigh;
  if (f > 0.8) return C.crowdMid;
  return C.crowdLow;
}
