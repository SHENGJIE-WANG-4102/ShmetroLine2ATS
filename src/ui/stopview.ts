/**
 * Stopping close-up for a manually driven train (对标近景): the train in plan
 * view with the platform beside it — what the driver judges the stop by out of
 * the side window: the platform screen doors, their door numbers and the last
 * PSD pillar before the end door. Stopped right, the cab window stands at that
 * pillar and every car door faces its PSD door. It replaces the view out of the
 * window, so it shows no distance figures while the train moves; the error
 * appears once it stands. The platform is drawn on the side it lies (top = left
 * looking forward), so in RM — no door enable — this is how the driver knows
 * the side.
 *
 * Far out the scale follows the distance still to go, with the eye at the left
 * and the end door (and a little beyond) at the right edge, so the whole
 * platform and train are in view. Once the cab reaches PSD door 2-5 the zoom
 * stops (用户决定): from there on the scale is fixed and the train runs across
 * the picture towards the last pillar, so its distance and speed read true.
 *
 * Geometry is approximate 【假设】: cars of 23.25 m (8 × = 186 m), five doors
 * per side at 4.6 m pitch from 3 m behind the car front, the driver's eye 1.8 m
 * behind the nose, the end door 2.5 m beyond the last pillar, a 188 m platform.
 * PSD doors are numbered car-door from the stopping end (1-1 opposite the head
 * car's front door) 【假设】.
 */
import { h } from './dom';
import type { TrainSnap, DmiData } from '../sim/model';
import { LINE as CURRENT_LINE, STATIONS } from '../data/current';
import { FONT_CN } from './theme';

const W = 760;
const H = 200;
const FONT = `Arial, "Helvetica Neue", Helvetica, sans-serif, ${FONT_CN}`;
/** screen x of the driver's eye while the view still zooms */
const XE_FAR = 176;
/** PSD door (car-door) the cab passes when the zoom stops */
const FREEZE_AT = { car: 2, door: 5 };
/** screen x kept for the end of the view ahead: the end door and a little beyond */
const X_AHEAD = W - 24;
/** across the track the picture shrinks with the scale (true proportions), down to this */
const K_MIN = 0.3;
/** the line it shrinks towards: the middle of the view */
const Y0 = 95;
/** metres shown beyond the stopping point (pillar): the end door and some wall */
const BEYOND = 3.5;
const EYE = 1.8;
const CARS = 8;
const CAR = 186 / CARS;
const GANGWAY = 0.6;
const DOORS = 5;
const DOOR_PITCH = 4.6;
const FIRST_DOOR = 3.0;
const TRAIN_DOOR_W = 1.6;
const PSD_DOOR_W = DOOR_PITCH / 2.25; // 门:固定玻璃=1:1.25
const END_DOOR = 2.5;
const PLATFORM = 188;
/** cab side door and windscreen, from the nose (m) */
const CAB_DOOR = 1.6;
const CAB_DOOR_W = 0.6;
const NOSE = 0.55;
/** distance before the mark at which the view appears (m) */
export const STOPVIEW_RANGE = 300;
const LINE = CURRENT_LINE.branding.color;

const C = {
  bg: '#0b0f16',
  tunnel: '#1d232b',
  floor: '#8b9198',
  joint: '#7d838b',
  tactile: '#e3bd33',
  psdFrame: '#3b4048',
  glass: '#7fb1cc',
  leaf: '#a9d2e4',
  gap: '#141a22',
  mullion: '#2a2f36',
  number: '#1d2530',
  pillarLast: '#ffffff',
  endDoor: '#a77e4e',
  bed: '#2e3238',
  sleeper: '#454b53',
  rail: '#aab3bc',
  body: '#dde2e7',
  roof: '#c3c9cf',
  ac: '#9aa2ab',
  window: '#2c4352',
  carDoor: '#8b949e',
  closingDoor: '#d6a44a',
  doorLine: '#4a525b',
  gangway: '#3a3f46',
  windscreen: '#1c2a36',
  eye: '#f0e000',
  red: '#e0505a',
  green: '#3ad06a',
  dim: '#8a95a3',
  sign: '#ffffff',
};

export function stopViewDoorState(t: Pick<TrainSnap, 'doors' | 'doorSide' | 'doorClosing'>, near: boolean) {
  const open = near ? t.doors : !!t.doorSide && !t.doors;
  return open ? t.doorClosing ? 'closing' : 'open' : 'closed';
}

/** door centres of a car, measured from its front end (m, negative = back) */
const doorsOf = (front: number) => Array.from({ length: DOORS }, (_, k) => front - FIRST_DOOR - k * DOOR_PITCH);

/** metres still to go when the eye stands at the FREEZE_AT door */
export const FREEZE_REM = (FREEZE_AT.car - 1) * CAR + FIRST_DOOR + (FREEZE_AT.door - 1) * DOOR_PITCH - EYE;
/** the fixed scale from there on: that door to BEYOND past the mark fills the view */
const PX_NEAR = (X_AHEAD - XE_FAR) / (FREEZE_REM + BEYOND);

/**
 * Scale and the eye's screen position for `rem` metres still to go. Beyond
 * FREEZE_REM the eye stays at XE_FAR and the scale fits everything up to
 * BEYOND past the mark into the view; within it the scale is fixed and the
 * eye moves right, reaching the mark's fixed screen position at the stop.
 */
export function stopViewScale(rem: number, beyond = BEYOND): { px: number; xe: number } {
  const near = (X_AHEAD - XE_FAR) / (FREEZE_REM + beyond);
  if (rem >= FREEZE_REM) return { px: (X_AHEAD - XE_FAR) / (rem + beyond), xe: XE_FAR };
  return { px: near, xe: XE_FAR + (FREEZE_REM - rem) * near };
}

/** 用户确认：count down through zero, then count positive overtime seconds. */
export function departureSeconds(at: number, now: number): number | null {
  return Number.isFinite(at) && at >= 0 ? at >= now ? Math.ceil(at - now) : Math.floor(now - at) : null;
}

export function departureText(board: DmiData['departureBoard'], now: number): string | null {
  if (!board || board.headLeftAt !== undefined && now - board.headLeftAt >= 5) return null;
  if (board.held) return 'H';
  const seconds = departureSeconds(board.at, now);
  return seconds === null ? null : String(seconds);
}

const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001',
  '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];

function dotNumber(c: CanvasRenderingContext2D, text: string, right: number, y: number, color = '#31ef59') {
  const pitch = 3, w = text.length * 12 + 6, x = right - w;
  c.fillStyle = '#07110b'; c.fillRect(x, y - 11, w, 23);
  c.fillStyle = color;
    [...text].forEach((n, i) => [...(n === 'H' ? '101101111101101' : DIGITS[Number(n)])].forEach((bit, p) => {
    if (bit === '1') { c.beginPath(); c.arc(x + 5 + i * 12 + p % 3 * pitch, y - 6 + Math.floor(p / 3) * pitch, 1.1, 0, Math.PI * 2); c.fill(); }
  }));
}

/** a step of `base` metres, coarsened so that marks stay at least `minPx` apart */
const stepFor = (base: number, px: number, minPx: number) => base * Math.max(1, Math.ceil(minPx / (base * px)));

export class StopView {
  el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private res = 1;

  constructor(resolution: () => number) {
    this.el = h('canvas', { class: 'stopview' }) as HTMLCanvasElement;
    this.ctx = this.el.getContext('2d')!;
    this.setResolution(resolution());
  }

  setResolution(r: number) {
    this.res = Math.max(1, r);
    this.el.width = Math.round(W * this.res);
    this.el.height = Math.round(H * this.res);
  }

  /** distance the head still has to go to its stopping point, NaN when no stop is near */
  static remaining(t: TrainSnap): number {
    if (!t.platSide || Number.isNaN(t.stopErr)) return NaN;
    return t.stopErr;
  }

  draw(t: TrainSnap, d: DmiData | null = null, now = 0) {
    const board = d?.departureBoard;
    const platformDoorsOpen = d?.psd === 'open' || d?.psd === 'fault' ? true : d?.psd === 'closed' ? false : t.doors;
    const side = board?.side || t.platSide;
    const rem = board?.side && Number.isFinite(board.remaining) ? board.remaining : StopView.remaining(t);
    const show = !!side && Number.isFinite(rem) && rem < STOPVIEW_RANGE;
    this.el.style.display = show ? 'block' : 'none';
    if (!show) return;
    const c = this.ctx;
    c.setTransform(this.res, 0, 0, this.res, 0, 0);
    c.fillStyle = C.bg;
    c.fillRect(0, 0, W, H);
    const { px: PX, xe: XE } = stopViewScale(rem, Math.max(BEYOND, (board?.signalOffset ?? 0) + 5));
    // drawn for a platform on top (driver's left); mirrored otherwise
    const top = side === 'L';
    // across the track: as drawn at the fixed near scale, thinner further out, not below K_MIN
    const k = Math.max(K_MIN, Math.min(1, PX / PX_NEAR));
    const Y = (y: number) => Y0 + (y - Y0) * k;
    /** screen y of a point drawn at y (design units) */
    const P = (y: number) => (top ? Y(y) : H - Y(y));
    /** screen top of a band drawn from y, hh high */
    const yOf = (y: number, hh = 0) => (top ? Y(y) : H - Y(y) - hh * k);
    const rect = (x: number, y: number, w: number, hh: number, col: string) => {
      const a = Math.max(-2, x), b = Math.min(W + 2, x + w);
      if (b <= a) return;
      c.fillStyle = col;
      c.fillRect(a, yOf(y, hh), b - a, hh * k);
    };
    /** screen x of a lineside position p (m from the stop mark, + = beyond) */
    const sx = (p: number) => XE + (p + rem) * PX;
    /** the lineside positions on screen */
    const pLeft = -rem - XE / PX, pRight = -rem + (W - XE) / PX;

    // ---- tunnel, platform floor (tile joints, tactile strip), end wall
    rect(0, 0, W, 80, C.tunnel);
    const pa = Math.max(pLeft, -PLATFORM), pb = Math.min(pRight, END_DOOR + 0.8);
    if (pb > pa) {
      rect(sx(pa), 10, (pb - pa) * PX, 62, C.floor);
      const joint = stepFor(1.2, PX, 8);
      for (let p = Math.ceil(pa / joint) * joint; p < pb; p += joint) rect(sx(p), 10, 1, 62, C.joint);
      rect(sx(pa), 54, (pb - pa) * PX, 6, C.tactile);
    }
    // ---- track bed, sleepers (they stream past), rails
    rect(0, 82, W, 96, C.bed);
    const sleeper = stepFor(0.6, PX, 7);
    const sw = Math.min(6, Math.max(1.5, 0.24 * PX));
    for (let p = Math.floor(pLeft / sleeper) * sleeper; p < pRight; p += sleeper) rect(sx(p) - sw / 2, 98, sw, 62, C.sleeper);
    rect(0, 104, W, 4, C.rail);
    rect(0, 150, W, 4, C.rail);

    // ---- platform screen doors: frame, glass, a numbered sliding door (two leaves) opposite every car door
    if (pb > pa) {
      const fa = Math.max(pLeft, -PLATFORM), fb = Math.min(pRight, 0);
      if (fb > fa) {
        rect(sx(fa), 70, (fb - fa) * PX, 10, C.psdFrame);
        rect(sx(fa), 73, (fb - fa) * PX, 4, C.glass);
      }
      const mw = Math.min(4, Math.max(1, 0.15 * PX));
      // door numbers: every door while there is plenty of room, then doors 1/3/5, then the first door of each car
      const everyDoor = DOOR_PITCH * PX >= 60;
      // in between: doors 1, 3 and 5 of each car
      const oddDoors = !everyDoor && DOOR_PITCH * PX >= 30;
      const small = k < 0.55;
      c.font = `bold ${small ? 10 : everyDoor ? 13 : 12}px ${FONT}`;
      const ph = small ? 12 : 15;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      for (let car = 0; car < CARS; car++) {
        doorsOf(EYE - car * CAR).forEach((dc, k) => {
          if (dc < pLeft - 2 || dc > pRight + 2) return;
          const x = sx(dc - PSD_DOOR_W / 2), w = PSD_DOOR_W * PX;
          // leaves slide apart behind the fixed panels when open
          const shift = platformDoorsOpen ? w / 2 : 0;
          rect(x, 71, w, 8, platformDoorsOpen ? C.gap : C.leaf);
          rect(x - shift, 72, w / 2 - 1, 6, C.leaf);
          rect(x + w / 2 + 1 + shift, 72, w / 2 - 1, 6, C.leaf);
          rect(x - mw, 66, mw, 18, C.mullion);
          rect(x + w, 66, mw, 18, C.mullion);
          if (!everyDoor && (oddDoors ? k % 2 === 1 : k > 0)) return;
          // number plate on the door header, read from the platform
          const label = `${car + 1}-${k + 1}`;
          const lw = c.measureText(label).width + (small ? 4 : 6);
          const cx = sx(dc);
          // (plates and the stop board keep their size at every scale)
          c.fillStyle = C.sign;
          c.fillRect(cx - lw / 2, P(45) - ph / 2, lw, ph);
          c.fillStyle = C.number;
          c.fillText(label, cx, P(45) + 0.5);
        });
      }
      // the last pillar, the end door (端门, swinging) and the stop board 8
      rect(sx(0) - 3, 62, 7, 26, C.pillarLast);
      rect(sx(0) + 4, 72, Math.max(2, END_DOOR * PX - 6), 6, C.endDoor);
      if (sx(0) > -30 && sx(0) < W + 30) {
        c.fillStyle = C.sign;
        // just clear of the door plates, on the wall side
        const bx = sx(0) - 13, by = (top ? Y(45) - 22.5 : H - Y(45) + 22.5) - 13;
        c.fillRect(bx, by, 26, 26);
        c.strokeStyle = '#000';
        c.lineWidth = 2;
        c.strokeRect(bx + 2, by + 2, 22, 22);
        c.fillStyle = '#000';
        c.font = `bold 19px ${FONT}`;
        c.textAlign = 'center';
        c.textBaseline = 'alphabetic';
        c.fillText('8', sx(0), by + 20);
      }
    }

    // Platform-end sign beside the actual departure signal, on either side.
    if (board) {
      const x = sx(board.signalOffset), y = P(30);
      c.strokeStyle = '#89949f'; c.lineWidth = 3;
      c.beginPath(); c.moveTo(x, P(67)); c.lineTo(x, y); c.stroke();
      c.fillStyle = '#10151c'; c.fillRect(x - 7, y - 11, 14, 22);
      c.fillStyle = board.aspect === 'G' ? C.green : board.aspect === 'Y' || board.aspect === 'GUIDE' ? '#ffe153' : C.red;
      c.beginPath(); c.arc(x, y, 4, 0, Math.PI * 2); c.fill();
      const text = departureText(board, now);
      if (text !== null) dotNumber(c, text, x - 13, y, text !== 'H' && now > board.at ? '#ff4545' : '#31ef59');
      c.fillStyle = '#ffffff'; c.font = `10px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(board.signalName, x, P(55));
    }

    // ---- the train: the nose EYE ahead of the eye, cars behind it
    const xNose = XE + EYE * PX;
    const xOf = (m: number) => xNose + m * PX; // m from the nose, negative = back
    for (let car = 0; car < CARS; car++) {
      const front = -car * CAR, back = front - CAR;
      if (xOf(front) < -4 || xOf(back) > W + 4) continue;
      const head = car === 0;
      const a = xOf(back + GANGWAY / 2), b = xOf(head ? -NOSE : front - GANGWAY / 2);
      rect(a, 90, b - a, 78, C.body);
      rect(a, 106, b - a, 46, C.roof);
      // roof air-conditioning units
      for (const f of [0.3, 0.72]) rect(xOf(front - CAR * f - 1.75), 112, 3.5 * PX, 34, C.ac);
      if (!head) rect(xOf(front - GANGWAY / 2), 98, GANGWAY * PX, 62, C.gangway);
      // windows between the doors (and up to the cab), doors, the Line 2 band, on both sides
      const doorX = doorsOf(front);
      const winFront = head ? front - CAB_DOOR - CAB_DOOR_W / 2 : front - 0.8;
      for (const side of [0, 1]) {
        const yWin = side ? 159 : 94, yDoor = side ? 159 : 90;
        for (let k = 0; k <= DOORS; k++) {
          const wa = k < DOORS ? doorX[k] + TRAIN_DOOR_W / 2 + 0.25 : back + 0.8;
          const wb = k === 0 ? winFront - 0.25 : doorX[k - 1] - TRAIN_DOOR_W / 2 - 0.25;
          if (wb > wa) rect(xOf(wa), yWin, (wb - wa) * PX, 5, C.window);
        }
        rect(a, side ? 166 : 90, b - a, 2, LINE);
        for (const d of doorX) {
          const state = stopViewDoorState(t, side === 0);
          rect(xOf(d - TRAIN_DOOR_W / 2), yDoor, TRAIN_DOOR_W * PX, 9, state === 'closing' ? C.closingDoor : state === 'open' ? (side === 0 ? C.gap : C.red) : C.carDoor);
          if (state !== 'open' && PX >= 6) rect(xOf(d) - 0.5, yDoor, 1, 9, C.doorLine);
        }
        if (head) rect(xOf(-CAB_DOOR - CAB_DOOR_W / 2), yDoor, CAB_DOOR_W * PX, 9, C.carDoor);
      }
    }
    // nose and windscreen
    c.fillStyle = C.body;
    const yT = P(90), yB = P(168), xn = xOf(-NOSE);
    c.beginPath();
    c.moveTo(xn, yT); c.quadraticCurveTo(xNose + Math.max(1, 0.15 * PX), (yT + yB) / 2, xn, yB); c.closePath();
    c.fill();
    rect(xOf(-0.75), 104, Math.max(2, 0.3 * PX), 50, C.windscreen);
    // driver's seat and the eye mark pointing at the platform side
    rect(XE - Math.min(7, 0.27 * PX), 98, Math.min(14, 0.54 * PX), 16, C.windscreen);
    c.fillStyle = C.eye;
    c.beginPath();
    const ey = P(88), tip = ey + (top ? -8 : 8);
    c.moveTo(XE - 7, ey); c.lineTo(XE + 7, ey); c.lineTo(XE, tip);
    c.closePath();
    c.fill();

    // ---- caption: station and side; the error once standing
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.font = `15px ${FONT}`;
    c.fillStyle = C.dim;
    const capY = top ? H - 6 : 16;
    const st = STATIONS[board?.station ?? t.nextStation]?.name ?? '';
    c.fillText(`${st}  站台在${top ? '左' : '右'}侧`, 10, capY);
    if (t.v < 0.05) {
      const e = Math.abs(rem);
      c.textAlign = 'right';
      c.font = `bold 17px ${FONT}`;
      c.fillStyle = e <= 0.3 ? C.green : e <= 1 ? C.eye : C.red;
      c.fillText(`${rem >= 0 ? '欠标' : '过标'} ${e.toFixed(2)} m`, W - 10, capY);
    }
  }
}
