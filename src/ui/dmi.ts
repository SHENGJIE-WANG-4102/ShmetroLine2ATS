/**
 * Cab driver display (DMI) of a followed train, drawn after the Casco DMI
 * fitted to Shanghai Line 2 (02A05) cabs: navy screen, next station / terminus
 * and train number across the top, 0–120 km/h dial with the permitted
 * speed in red on the rim, mode-level and door mode on the right, the
 * available-mode row and stopping-window hexagon under the dial, date / time
 * and the message log at the bottom. Elements that could not be read from the
 * reference photos are listed in the README (DMI section).
 *
 * The master controller (牵引/制动手柄) for manual CM / RM driving sits below it.
 */
import { h } from './dom';
import type { DmiData, TrainSnap } from '../sim/model';
import { PERF } from '../sim/dynamics';
import { FONT_CN, fmtTime } from './theme';
import { LINE } from '../data/current';
import { drawStatusGrid, statusGridAlarmAt } from './dmiStatusGrid';

const STYLES = {
  navyDial: { brand: 'CASCO', draw: null, alarmAt: null },
  statusGrid: { brand: '', draw: drawStatusGrid, alarmAt: statusGridAlarmAt },
} as const;
const STYLE = STYLES[LINE.ui.dmiStyle ?? 'navyDial'];

/** seconds of warning before the permitted speed starts to fall below the present speed */

/** Pure snapshot advisory; hidden outside CM, including old replay snapshots. */
export function recommendedSpeed(t: TrainSnap): number | null {
  return t.manual && t.mode === 'CM' && Number.isFinite(t.vRecommended)
    ? Math.max(0, Math.min(t.vPermit, t.vRecommended!)) * 3.6 : null;
}

const W = 760;
const H = 640;
/** dial range and sweep: 0–120 km/h over 270°, 60 at 12 o'clock (Line 2 photo 2026-10-21, rectified) */
const VMAX = 120;
const SWEEP = (270 * Math.PI) / 180;
const LATIN = 'Arial, "Helvetica Neue", Helvetica, "Liberation Sans", sans-serif';
const FONT = `${LATIN}, ${FONT_CN}`;

/** colours sampled from the clear Casco reference photo */
const C = {
  bg: '#161d49',
  logBg: '#19203d',
  logBorder: '#56618a',
  blue: '#108ce4',
  white: '#ffffff',
  green: '#18e713',
  hexGreen: '#2ccd3b',
  red: '#d93d4c',
  yellow: '#f0e000',
  hl: '#cdf2f1',
  hlText: '#13204a',
  btn: '#e2edf5',
  scroll: '#b7c0c8',
  scrollArrow: '#7a8592',
  dim: '#5d688f',
};

export const NOTCHES: { v: number; label: string; cls: string }[] = [
  { v: 4, label: 'P4', cls: 't' }, { v: 3, label: 'P3', cls: 't' }, { v: 2, label: 'P2', cls: 't' }, { v: 1, label: 'P1', cls: 't' },
  { v: 0, label: 'N', cls: '' },
  { v: -1, label: 'B1', cls: 'b' }, { v: -2, label: 'B2', cls: 'b' }, { v: -3, label: 'B3', cls: 'b' }, { v: -4, label: 'B4', cls: 'b' },
  { v: -5, label: 'B5', cls: 'b' }, { v: -6, label: 'B6', cls: 'b' }, { v: -7, label: 'B7', cls: 'b' }, { v: -8, label: '紧急', cls: 'eb' },
];

/** on-screen wording */
const modeWord = (m: string) => m;

// geometry measured on the rectified Line 2 photo (reference/dmi/IMG_20261021_202807)
const CX = 266;
const CY = 282;
const R = 172;
const LOG = { x: 30, y: 503, w: 424, row: 34, rows: 3 };
const BTN_UP = { x: 461, y: 503, w: 40, h: 40 };
const BTN_DN = { x: 461, y: 553, w: 40, h: 40 };

export class Dmi {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private res = 1;
  lever: HTMLElement;
  private notchEls: HTMLElement[] = [];
  onNotch: (n: number) => void = () => undefined;
  onAck: (message: string, at: number) => void = () => undefined;
  /** selected log row (index into the newest-first log) and first visible row */
  private sel = 0;
  private top = 0;
  private newestKey = '';
  private last: { t: TrainSnap; d: DmiData | null; now: number } | null = null;

  constructor(resolution: () => number) {
    this.canvas = h('canvas', { class: 'dmi' }) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.addEventListener('click', (e) => this.click(e));
    this.lever = h('div', { class: 'lever', title: '牵引/制动手柄：Z/↑ 加牵引 · Q/↓ 加制动 · S 中立位 · E 紧急制动' });
    for (const n of NOTCHES) {
      const e = h('div', { class: `notch ${n.cls}`, onclick: () => this.onNotch(n.v) }, n.label);
      this.notchEls.push(e);
      this.lever.append(e);
    }
    this.lever.addEventListener('wheel', (e) => {
      e.preventDefault();
      const cur = NOTCHES.findIndex((n) => n.v === this.curNotch);
      const next = Math.max(0, Math.min(NOTCHES.length - 1, cur + (e.deltaY > 0 ? 1 : -1)));
      this.onNotch(NOTCHES[next].v);
    }, { passive: false });
    // bezel with the maker's name above the screen, as on the cab photo
    const bezel = h('div', { class: 'dmi-bezel' }, h('div', { class: 'dmi-brand' }, STYLE.brand), this.canvas);
    this.el = h('div', { class: 'dmi-wrap' }, bezel, this.lever);
    this.setResolution(resolution());
  }

  private curNotch = 0;

  setResolution(r: number) {
    this.res = Math.max(1, r);
    this.canvas.width = Math.round(W * this.res);
    this.canvas.height = Math.round(H * this.res);
    if (this.last) this.draw(this.last.t, this.last.d, this.last.now);
  }

  showLever(on: boolean) {
    this.lever.style.display = on ? 'flex' : 'none';
  }

  /** a different train: start the log at its newest entry */
  reset() {
    this.sel = 0;
    this.top = 0;
    this.newestKey = '';
    this.last = null;
  }

  private click(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) * W) / r.width;
    const y = ((e.clientY - r.top) * H) / r.height;
    if (STYLE.alarmAt) {
      const alarm = this.last?.d && STYLE.alarmAt(this.last.d, x, y);
      if (alarm) this.onAck(alarm.m, alarm.t);
      return;
    }
    const inside = (b: { x: number; y: number; w: number; h: number }) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
    const n = this.last?.d?.log.length ?? 0;
    if (inside(BTN_UP)) this.select(this.sel - 1, n);
    else if (inside(BTN_DN)) this.select(this.sel + 1, n);
    else if (x >= LOG.x && x <= LOG.x + LOG.w && y >= LOG.y && y <= LOG.y + LOG.row * LOG.rows) this.select(this.top + Math.floor((y - LOG.y) / LOG.row), n);
    else return;
    if (this.last) this.draw(this.last.t, this.last.d, this.last.now);
  }

  private select(i: number, n: number) {
    this.sel = Math.max(0, Math.min(Math.max(0, n - 1), i));
    if (this.sel < this.top) this.top = this.sel;
    if (this.sel >= this.top + LOG.rows) this.top = this.sel - LOG.rows + 1;
  }

  draw(t: TrainSnap, d: DmiData | null, now: number) {
    this.last = { t, d, now };
    const c = this.ctx;
    c.setTransform(this.res, 0, 0, this.res, 0, 0);
    if (STYLE.draw) {
      STYLE.draw(c, t, d, now);
      this.curNotch = t.notch;
      this.notchEls.forEach((e, i) => e.classList.toggle('on', t.manual && NOTCHES[i].v === t.notch));
      return;
    }
    c.fillStyle = C.bg;
    c.fillRect(0, 0, W, H);
    c.textBaseline = 'alphabetic';
    const v = t.v * 3.6;
    const vp = Math.max(0, Math.min(VMAX, t.vPermit * 3.6));
    const eb = t.eb;
    const over = !eb && v > vp + 0.5;

    this.topBar(c, t, d, now);
    this.dial(c, v, vp, eb, over, t);
    this.rightColumn(c, t, d, eb);
    this.statusRow(c, t, d);
    this.bottom(c, d, now);

    this.curNotch = t.notch;
    this.notchEls.forEach((e, i) => e.classList.toggle('on', t.manual && NOTCHES[i].v === t.notch));
  }

  // ------------------------------------------------------------ top bar

  private topBar(c: CanvasRenderingContext2D, t: TrainSnap, d: DmiData | null, now: number) {
    const field = (x: number, label: string, value: string, maxW: number) => {
      c.textAlign = 'center';
      c.fillStyle = C.white;
      c.font = `17px ${FONT}`;
      c.fillText(label, x, 30);
      c.font = `19px ${FONT}`;
      c.fillText(value, x, 60, maxW);
    };
    field(164, '下一站', d?.next ?? '—', 156);
    field(318, '终点站', d?.dest ?? t.dest ?? '—', 148);
    c.textAlign = 'center';
    c.fillStyle = C.white;
    // HOLD: 用户确认 shown while an ATO/DTO train stands still; also while the train
    // or its platform is held (扣车) in any mode
    const hold = (t.mode === 'DTO' || t.mode === 'AM') && t.v < 0.05 || t.hold || !!d?.departureBoard?.held;
    c.font = `bold 20px ${FONT}`;
    c.fillText(hold ? 'HOLD' : '', 456, 50);
    c.font = `bold 23px ${FONT}`;
    c.fillText(d?.trainNo ?? '', 556, 40);
    c.font = `22px ${FONT}`;
    c.fillText(t.svc.replace(/^0+(?=\d)/, ''), 644, 40);
    c.fillStyle = '#b7bdc7';
    c.fillRect(686, 8, 64, 47);
    c.fillStyle = C.hlText;
    c.fillText('C000', 718, 40);
    button(c, 636, 68, 114, 54);
    c.fillStyle = C.hlText;
    c.fillText('菜单', 693, 103);
    c.fillStyle = C.white;
    c.font = `20px ${FONT}`;
    c.fillText('DEP', 563, 86);
    c.font = `bold 22px ${FONT}`;
    c.fillText(d && d.dep >= 0 ? fmtTime(d.dep) : '--:--:--', 563, 113);
    void now;
  }

  // ------------------------------------------------------------ speedometer

  private dial(c: CanvasRenderingContext2D, v: number, vp: number, eb: boolean, over: boolean, t: TrainSnap) {
    const ang = (s: number) => -Math.PI / 2 - SWEEP / 2 + (Math.max(0, Math.min(VMAX, s)) / VMAX) * SWEEP;
    const pt = (a: number, r: number): [number, number] => [CX + Math.cos(a) * r, CY + Math.sin(a) * r];
    // rim ring
    c.strokeStyle = C.white;
    c.lineWidth = 2;
    c.beginPath(); c.arc(CX, CY, R, ang(0), ang(VMAX)); c.stroke();
    // ticks: every 2 km/h, longer every 10, labelled every 20
    for (let s = 0; s <= VMAX; s += 2) {
      const a = ang(s);
      const long = s % 10 === 0;
      const [x1, y1] = pt(a, R);
      const [x2, y2] = pt(a, R - (s % 20 === 0 ? 20 : long ? 16 : 9));
      c.lineWidth = long ? 4 : 2;
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    }
    c.fillStyle = C.white;
    c.font = `bold 24px ${FONT}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let s = 0; s <= VMAX; s += 20) {
      const [x, y] = pt(ang(s), R - 42);
      c.fillText(String(s), x, y + 1);
    }
    const marker = (speed: number, colour: string) => {
      const a = ang(speed);
      const [tx, ty] = pt(a, R + 4);
      const [b1x, b1y] = pt(a - 0.07, R + 24);
      const [b2x, b2y] = pt(a + 0.07, R + 24);
      c.fillStyle = colour;
      c.beginPath(); c.moveTo(tx, ty); c.lineTo(b1x, b1y); c.lineTo(b2x, b2y); c.closePath(); c.fill();
    };
    // CM advisory follows the Line 14 cab (user photo 2025-09-05): yellow = recommended,
    // green = maximum (permitted), red = EB intervention with the red arc beyond it.
    const recommendation = recommendedSpeed(t);
    // permitted speed: red arc on the outer rim from the permitted speed to the end of the scale + red marker
    // 【假设】no arc while standing without authority: the standing DTO photo (HOLD) shows none
    if (t.phase !== 'failed' && !(v < 0.5 && vp < 1)) {
      const red = recommendation !== null ? Math.min(VMAX, vp + PERF.atpTolerance * 3.6) : vp;
      c.strokeStyle = C.red;
      c.lineWidth = 6;
      c.lineCap = 'butt';
      c.beginPath(); c.arc(CX, CY, R + 5, ang(red), ang(VMAX)); c.stroke();
      marker(red, C.red);
      if (recommendation !== null) marker(vp, C.green);
    }
    // the recommended speed (CM)
    if (recommendation !== null) marker(recommendation, C.yellow);
    // needle: tapered white pointer from the hub
    const na = ang(v);
    const [nx, ny] = pt(na, R - 24);
    const [l1x, l1y] = pt(na - Math.PI / 2, 6);
    const [l2x, l2y] = pt(na + Math.PI / 2, 6);
    c.fillStyle = C.white;
    c.beginPath(); c.moveTo(l1x, l1y); c.lineTo(nx, ny); c.lineTo(l2x, l2y); c.closePath(); c.fill();
    // hub with the digital speed
    c.fillStyle = C.bg;
    c.beginPath(); c.arc(CX, CY, 32, 0, Math.PI * 2); c.fill();
    c.strokeStyle = C.white;
    c.lineWidth = 3;
    c.beginPath(); c.arc(CX, CY, 32, 0, Math.PI * 2); c.stroke();
    c.fillStyle = eb ? C.red : over ? C.yellow : C.white;
    c.font = `bold 28px ${FONT}`;
    c.fillText(String(Math.round(v)), CX, CY + 1);
    c.fillStyle = C.white;
    c.font = `bold 20px ${FONT}`;
    c.fillText('km/h', CX, CY + 118);
    if (recommendation !== null) {
      // one row inside the dial under the hub: white labels, values in the marker colours
      c.font = `18px ${FONT}`;
      c.textAlign = 'left';
      const parts = [['推荐 ', C.white], [String(Math.round(recommendation)), C.yellow], ['　最大 ', C.white], [String(Math.round(vp)), C.green]] as const;
      let x = CX - parts.reduce((w, [text]) => w + c.measureText(text).width, 0) / 2;
      for (const [text, colour] of parts) { c.fillStyle = colour; c.fillText(text, x, CY + 72); x += c.measureText(text).width; }
      c.textAlign = 'center';
    }
    c.textBaseline = 'alphabetic';
  }

  // ------------------------------------------------------------ right column

  private rightColumn(c: CanvasRenderingContext2D, t: TrainSnap, d: DmiData | null, eb: boolean) {
    // mode and level
    c.fillStyle = C.white;
    c.font = `bold 44px ${FONT}`;
    c.textAlign = 'left';
    c.textAlign = 'center';
    c.fillText(modeWord(t.mode), 560, 182);
    c.fillText(t.level, 690, 182);
    c.textAlign = 'left';
    // 用户决定（2026-10-22）：显示距模型停车点的距离；非实机含义断言。
    c.strokeStyle = C.white;
    c.lineWidth = 2;
    c.strokeRect(513, 238, 95, 12);
    c.font = `17px ${FONT}`;
    c.textAlign = 'center';
    c.fillText(Number.isFinite(t.stopDist) && t.stopDist >= 0 ? `${Math.round(t.stopDist)}m` : '--m', 560, 270, 95);
    c.textAlign = 'left';
    const state = eb ? 'eb' : t.a > 0.05 ? 'traction' : t.a < -0.12 && t.v > 0.05 ? 'brake' : 'coast';
    trainFront(c, 656, 214, state);
    // Two distinct symbols: train doors always above AA; PSD only on a platform.
    // 用户确认：photograph shows OPEN leaves; closed leaves meet.
    // Train doors are white, PSD yellow in the reference.
    // Fault, isolation and lock-confirmation colours remain【假设】.
    const td = d?.trainDoor ?? (t.doors || t.doorSide ? 'open' : 'closed');
    const tc = td === 'fault' ? C.red : td === 'closing' ? C.dim : td === 'isolated' ? '#ff9a2a' : C.white;
    // closeDoors clears the open bit when closing STARTS. The symbol must
    // remain separated until the physical close/lock confirmation completes.
    const doorOpen = td === 'open' || td === 'closing' || t.doors || !!t.doorSide;
    for (const x of doorOpen ? [518, 567] : [523, 555]) doorLeaf(c, x, 285, 34, 52, tc, false);
    if (td === 'fault' || td === 'isolated') {
      c.strokeStyle = tc; c.lineWidth = 3;
      c.beginPath(); c.moveTo(516, 339); c.lineTo(603, 283);
      if (td === 'fault') { c.moveTo(516, 283); c.lineTo(603, 339); }
      c.stroke();
    }
    const psd = d?.psd ?? 'none';
    // door mode AA / MM (no bar on the photo)
    c.fillStyle = C.white;
    c.font = `bold 42px ${FONT}`;
    c.fillText(t.mode === 'DTO' || t.mode === 'AM' ? 'AA' : 'MM', 527, 400);
    const pc = psd === 'fault' ? C.red : psd === 'bypass' ? '#ff9a2a' : C.yellow;
    for (const x of psd === 'none' ? [] : psd === 'open' ? [663, 697] : [669, 691]) {
      c.strokeStyle = pc;
      c.lineWidth = 3;
      c.strokeRect(x, 358, 22, 52);
      c.fillStyle = pc;
      c.fillRect(x + 6, 364, 10, 40);
    }
    if (psd === 'fault' || psd === 'bypass') {
      c.strokeStyle = pc; c.lineWidth = 3; c.beginPath();
      c.moveTo(659, 412); c.lineTo(723, 356);
      if (psd === 'fault') { c.moveTo(659, 356); c.lineTo(723, 412); }
      c.stroke();
    }
    // door enable (CM: the ATP enables the platform side of a train stopped at
    // its mark; RM has none) — a green arrow on that side of the door icon
    if (t.manual && t.mode === 'CM') for (const side of ['L', 'R'] as const) {
      if (!t.doorEnable?.[side]) continue;
      const left = side === 'L';
      const ax = left ? 504 : 615;
      c.fillStyle = C.green;
      c.beginPath();
      c.moveTo(ax + (left ? -12 : 12), 311); c.lineTo(ax, 297); c.lineTo(ax, 325); c.closePath(); c.fill();
    }
    // supervision status line (extrapolated: the photos show no such state)
    let msg = '';
    let col = C.white;
    if (eb) { msg = '紧急制动'; col = C.red; }
    else if (t.v * 3.6 > t.vPermit * 3.6 + 0.5) { msg = '超速'; col = C.yellow; }
    else if (t.slip) { msg = t.slip === 'slip' ? '空转' : '滑行'; col = C.yellow; }
    else if (t.manual && t.doorSide && !t.doors) { msg = '非站台侧车门开启'; col = C.red; }
    else if (t.manual && t.doorsAwait) { msg = '停稳，待开门'; col = C.white; }
    // 用户决定：no plain「人工驾驶」(the mode field says CM); only a real reason the train stands
    else if (t.manual && t.halt?.detail && !['人工驾驶', '等待司机加牵引', '司机牵引起步'].includes(t.halt.detail)) { msg = t.halt.detail; col = C.white; }
    if (msg) {
      c.font = `bold ${msg.length > 12 ? 19 : 26}px ${FONT}`;
      c.fillStyle = col;
      c.fillText(msg, 520, 446, 230);
    }
  }

  // ------------------------------------------------------------ row under the dial

  private statusRow(c: CanvasRenderingContext2D, t: TrainSnap, d: DmiData | null) {
    const y = 460;
    wheel(c, 62, y);
    c.fillStyle = C.white;
    c.font = `bold 26px ${FONT}`;
    c.textAlign = 'left';
    c.fillText(`${modeWord(t.mode)}-${t.level}`, 125, y + 10);
    // train / door status: green = doors closed and locked, yellow = open, red = train fault
    hexagon(c, 478, y, d?.stopWin ?? 'none');
  }

  // ------------------------------------------------------------ bottom: date / time, message log, target

  private bottom(c: CanvasRenderingContext2D, d: DmiData | null, now: number) {
    c.fillStyle = C.white;
    c.textAlign = 'left';
    c.font = `bold 22px ${FONT}`;
    c.textAlign = 'center';
    c.fillText(d?.date ?? '', 180, 630);
    c.fillText(fmtTime(now), 418, 630);
    c.textAlign = 'right';
    c.font = `20px ${FONT}`;
    c.fillText('版本：1.0.0', 736, 628);
    c.textAlign = 'left';
    // log
    const log = d?.log ?? [];
    const key = log.length ? `${log[0].t}|${log[0].m}` : '';
    if (key !== this.newestKey) {
      if (this.newestKey && this.sel > 0) this.select(this.sel + 1, log.length);
      this.newestKey = key;
    }
    this.select(this.sel, log.length);
    c.fillStyle = C.logBg;
    c.fillRect(LOG.x, LOG.y, LOG.w, LOG.row * LOG.rows);
    c.strokeStyle = C.logBorder;
    c.lineWidth = 1;
    c.strokeRect(LOG.x + 0.5, LOG.y + 0.5, LOG.w - 1, LOG.row * LOG.rows - 1);
    c.font = `20px ${FONT}`;
    for (let i = 0; i < LOG.rows; i++) {
      const e = log[this.top + i];
      if (!e) break;
      const ry = LOG.y + i * LOG.row;
      const selected = this.top + i === this.sel;
      if (selected) { c.fillStyle = C.hl; c.fillRect(LOG.x + 2, ry + 2, LOG.w - 4, LOG.row - 2); }
      c.fillStyle = selected ? C.hlText : e.k === 'alarm' ? '#ff8a8a' : e.k === 'warn' ? '#ffe36a' : C.white;
      c.fillText(`${fmtTime(e.t, false)} ${e.m}`, LOG.x + 6, ry + 21, LOG.w - 12);
    }
    scrollButton(c, BTN_UP, true, this.sel > 0);
    scrollButton(c, BTN_DN, false, this.sel < log.length - 1);

  }
}

// ---------------------------------------------------------------- icons

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + hh, r);
  c.arcTo(x + w, y + hh, x, y + hh, r);
  c.arcTo(x, y + hh, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function button(c: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number) {
  c.fillStyle = C.btn;
  roundRect(c, x, y, w, hh, 3);
  c.fill();
}

function scrollButton(c: CanvasRenderingContext2D, b: { x: number; y: number; w: number; h: number }, up: boolean, active: boolean) {
  c.fillStyle = C.scroll;
  roundRect(c, b.x, b.y, b.w, b.h, 3);
  c.fill();
  c.fillStyle = active ? C.scrollArrow : '#a2abb4';
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const s = up ? -1 : 1;
  c.beginPath();
  c.moveTo(cx, cy + s * 12);
  c.lineTo(cx - 13, cy - s * 2);
  c.lineTo(cx - 5, cy - s * 2);
  c.lineTo(cx - 5, cy - s * 13);
  c.lineTo(cx + 5, cy - s * 13);
  c.lineTo(cx + 5, cy - s * 2);
  c.lineTo(cx + 13, cy - s * 2);
  c.closePath();
  c.fill();
}

/** wheel / axle status: scalloped ring with a letter (Line 2 photos) on an axle line (Casco) */
function wheel(c: CanvasRenderingContext2D, x: number, y: number) {
  c.strokeStyle = C.white;
  c.fillStyle = C.white;
  c.lineWidth = 3;
  // brake-disc symbol: B in a ring between two brackets with stubs (photo 2026-10-21)
  c.beginPath(); c.moveTo(x - 34, y); c.lineTo(x - 26, y); c.moveTo(x + 26, y); c.lineTo(x + 34, y);
  c.moveTo(x - 26, y - 13); c.lineTo(x - 26, y + 13); c.moveTo(x + 26, y - 13); c.lineTo(x + 26, y + 13); c.stroke();
  c.beginPath(); c.arc(x, y, 20, 0, Math.PI * 2); c.stroke();
  c.beginPath(); c.arc(x, y, 15, 0, Math.PI * 2); c.lineWidth = 2; c.stroke();
  // the glyph inside reads as "B" on both Line 2 photos (blurry: see README)
  c.font = `bold 24px ${LATIN}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('B', x, y + 1);
  c.textAlign = 'left';
  c.textBaseline = 'alphabetic';
}

/** cab front in profile with the traction / brake arrow (right column) */
function trainFront(c: CanvasRenderingContext2D, x: number, y: number, state: 'traction' | 'brake' | 'coast' | 'eb') {
  // outline cab in side view (photo 2026-10-21): flat roof, rounded nose to the right,
  // a split window and a door window, standing on a floor line
  const col = state === 'eb' ? C.red : C.white;
  c.strokeStyle = col;
  c.fillStyle = col;
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(x + 4, y + 40);
  c.lineTo(x + 4, y + 2);
  c.lineTo(x + 40, y + 2);
  c.quadraticCurveTo(x + 66, y + 4, x + 70, y + 40);
  c.stroke();
  c.beginPath(); c.moveTo(x - 4, y + 42); c.lineTo(x + 74, y + 42); c.stroke();
  c.lineWidth = 2;
  c.strokeRect(x + 10, y + 10, 16, 26);
  c.fillRect(x + 12, y + 12, 12, 10);
  c.beginPath();
  c.moveTo(x + 30, y + 36); c.lineTo(x + 30, y + 10); c.lineTo(x + 44, y + 10);
  c.quadraticCurveTo(x + 58, y + 12, x + 60, y + 24); c.lineTo(x + 30, y + 24);
  c.stroke();
  // 【假设】the triangle under the nose (white upward on the standing photo) shows
  // traction green, braking yellow, EB red, otherwise white
  c.fillStyle = state === 'traction' ? C.green : state === 'brake' ? C.yellow : state === 'eb' ? C.red : C.white;
  const ax = x + 62;
  const ay = y + 46;
  c.beginPath();
  if (state === 'brake' || state === 'eb') { c.moveTo(ax, ay + 12); c.lineTo(ax - 13, ay); c.lineTo(ax + 13, ay); }
  else { c.moveTo(ax, ay); c.lineTo(ax - 13, ay + 12); c.lineTo(ax + 13, ay + 12); }
  c.closePath();
  c.fill();
}

/** a platform screen door leaf: outline with a glazed upper half */
function doorLeaf(c: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, col: string, open: boolean) {
  c.strokeStyle = col;
  c.lineWidth = 3;
  roundRect(c, x, y, w, hh, 3);
  c.stroke();
  c.fillStyle = col;
  if (open) c.fillRect(x + 5, y + 5, w - 10, hh - 10);
  else c.fillRect(x + 6, y + 6, w - 12, hh / 2 - 8);
}

/** stopping-window hexagon (vertical): green bands show where the train is relative to the stopping point */
function hexagon(c: CanvasRenderingContext2D, x: number, y: number, win: DmiData['stopWin']) {
  const w = 17;
  const hh = 30;
  const path = () => {
    c.beginPath();
    c.moveTo(x, y - hh);
    c.lineTo(x + w, y - hh / 2);
    c.lineTo(x + w, y + hh / 2);
    c.lineTo(x, y + hh);
    c.lineTo(x - w, y + hh / 2);
    c.lineTo(x - w, y - hh / 2);
    c.closePath();
  };
  path();
  c.fillStyle = C.white;
  c.fill();
  c.save();
  path();
  c.clip();
  const band = (y0: number, y1: number, col: string) => { c.fillStyle = col; c.fillRect(x - w, y0, w * 2, y1 - y0); };
  if (win === 'ahead') { band(y - hh, y - hh / 2, C.hexGreen); band(y + hh / 2, y + hh, C.hexGreen); }
  else if (win === 'aligned') band(y - hh / 2 - 4, y + hh / 2 + 4, C.hexGreen);
  else if (win === 'short') band(y - hh, y - hh / 2, C.yellow);
  else if (win === 'over') band(y + hh / 2, y + hh, C.yellow);
  c.restore();
}
