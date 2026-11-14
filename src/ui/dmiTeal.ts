/** Teal-panel cab (Line 11, 11A02 unit 1168): laid out after the user's two photos of 2026-10-14
 * (mode / docked / dwell / depart across the top, dial, next-limit and next-signal distance
 * columns, door and station panels, WSP / ATP / ATO / position / EB, two message rows each with
 * its 确认 key, date / time / driver / unit / formation along the bottom). Drawn on an 800 × 600
 * screen scaled into the DMI canvas. The 列表 / English / 司机车 keys are drawn but not worked:
 * what they open on the real screen has not been seen. */
import type { DmiData, DmiMsg, TrainSnap } from '../sim/model';
import { FONT_CN, fmtTime } from './theme';
import { formatDrivingMode } from './drivingMode';

const W = 800, H = 600;
/** the DMI canvas (dmi.ts) */
const CW = 760, CH = 640;
const K = Math.min(CW / W, CH / H), OY = (CH - H * K) / 2;
const FONT = `Arial, ${FONT_CN}`;
const C = { bg: '#111619', cyan: '#54cec9', white: '#f5f7f6', blue: '#36baf4', green: '#39ef08', red: '#ff664f', yellow: '#eeef00', magenta: '#ef72e3', key: '#dce4e3', keyText: '#182326' };
const TICKS = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0];

const ackKey = (m: DmiMsg) => `${m.t}|${m.m}`;
const unacked = (d: DmiData, alarm: boolean) => d.log.find(m => (m.k === 'alarm') === alarm && !d.acknowledged?.includes(ackKey(m)));
/** the two 确认 keys, left of the message rows: train information, then fault messages */
const ACK = [{ x: 14, y: 474, w: 92, h: 36 }, { x: 14, y: 513, w: 92, h: 36 }];

export function tealAlarmAt(d: DmiData, x: number, y: number): DmiMsg | undefined {
  const tx = x / K, ty = (y - OY) / K;
  const row = ACK.findIndex(b => tx >= b.x && tx <= b.x + b.w && ty >= b.y && ty <= b.y + b.h);
  return row < 0 ? undefined : unacked(d, row === 1);
}

export function drawTeal(c: CanvasRenderingContext2D, t: TrainSnap, d: DmiData | null, now: number) {
  c.fillStyle = C.cyan;
  c.fillRect(0, 0, CW, CH);
  c.save();
  c.translate(0, OY);
  c.scale(K, K);
  c.textBaseline = 'alphabetic';
  const text = (s: string, x: number, y: number, size = 21, color: string = C.white, max = 1000, bold = false, align: CanvasTextAlign = 'left') => {
    c.fillStyle = color; c.font = `${bold ? 'bold ' : ''}${size}px ${FONT}`; c.textAlign = align; c.fillText(s, x, y, max);
  };
  const line = (x1: number, y1: number, x2: number, y2: number, width = 3, color: string = C.cyan) => {
    c.strokeStyle = color; c.lineWidth = width; c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
  };
  const box = (x: number, y: number, w: number, hh: number) => {
    c.fillStyle = C.bg; c.fillRect(x, y, w, hh); c.strokeStyle = C.cyan; c.lineWidth = 3; c.strokeRect(x, y, w, hh);
  };
  const key = (x: number, y: number, w: number, hh: number, label: string, live: boolean) => {
    c.fillStyle = C.key; c.fillRect(x, y, w, hh); c.strokeStyle = C.cyan; c.lineWidth = 1; c.strokeRect(x, y, w, hh);
    text(label, x + w / 2, y + hh / 2 + 7, 18, live ? C.keyText : '#8a9493', w - 4, false, 'center');
  };

  const v = Math.max(0, t.v * 3.6);
  const stopped = t.v < 0.05;
  const protectedMode = t.mode !== 'RM' && t.comm && t.level === 'CBTC' && d?.avail.level === 'CBTC';
  const docked = stopped && d?.stopWin === 'aligned' && !!t.platSide;
  const doorOpen = !!d && ['open', 'opening', 'closing'].includes(d.trainDoor);
  const depart = !t.eb && !t.failed && !t.hold && !d?.stationHold && !t.halt && !doorOpen && !t.doorsAwait
    && t.phase === 'run' && t.maDist > 3 && t.vTarget > 0.1;

  // top fields
  const fields: [string, string, string][] = [
    ['模式', formatDrivingMode(t.mode), C.blue],
    ['停靠', docked ? 'YES' : 'NO', docked ? C.green : C.red],
    ['停站', t.phase === 'dwell' ? String(Math.max(0, Math.ceil(t.dwellLeft))) : '—', C.yellow],
    ['出发', depart ? 'YES' : 'NO', depart ? C.green : C.red],
  ];
  fields.forEach(([label, value, col], i) => {
    box(8 + i * 196, 8, 196, 52);
    text(label, 20 + i * 196, 43, 26, C.white, 110, true);
    text(value, 184 + i * 196, 43, 28, col, 86, true, 'right');
  });
  box(8, 60, 366, 408);
  box(374, 60, 156, 408);

  // dial: 0–120 over 270°, the red arc from 105
  const cx = 190, cy = 242, r = 160;
  const angle = (n: number) => (135 + n / 120 * 270) * Math.PI / 180;
  c.strokeStyle = C.white; c.lineWidth = 5; c.beginPath(); c.arc(cx, cy, r, angle(0), angle(120)); c.stroke();
  c.strokeStyle = C.red; c.lineWidth = 7; c.beginPath(); c.arc(cx, cy, r - 3, angle(105), angle(120)); c.stroke();
  for (let n = 0; n <= 120; n += 5) {
    const a = angle(n), major = n % 10 === 0, inner = r - (major ? 18 : 10);
    line(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner, cx + Math.cos(a) * r, cy + Math.sin(a) * r, major ? 4 : 2, C.white);
    if (major) text(String(n), cx + Math.cos(a) * (r - 37), cy + Math.sin(a) * (r - 37) + 7, 23, n >= 110 ? C.red : C.white, 44, true, 'center');
  }
  const a = angle(Math.min(120, v));
  line(cx, cy, cx + Math.cos(a) * (r - 30), cy + Math.sin(a) * (r - 30), 9, t.eb ? C.red : C.white);
  c.fillStyle = C.white; c.beginPath(); c.arc(cx, cy, 18, 0, Math.PI * 2); c.fill();
  text('公里/时', cx, 308, 23, C.white, 120, true, 'center');
  // 正向: running cab-forwards (not the line's UP / DN)
  text('正向', cx, 340, 25, C.magenta, 120, true, 'center');
  text('校验', cx, 370, 25, C.green, 145, true, 'center');
  const target = Math.max(0, t.vTarget * 3.6);
  const m = angle(Math.min(120, target));
  c.fillStyle = C.yellow; c.beginPath();
  c.moveTo(cx + Math.cos(m) * (r + 4), cy + Math.sin(m) * (r + 4));
  c.lineTo(cx + Math.cos(m + .04) * (r + 17), cy + Math.sin(m + .04) * (r + 17));
  c.lineTo(cx + Math.cos(m - .04) * (r + 17), cy + Math.sin(m - .04) * (r + 17));
  c.closePath(); c.fill();
  for (const [x, label, value, col] of [[28, '实际', v, C.green], [143, '目标', target, C.yellow], [256, '最大', Math.max(0, t.vPermit * 3.6), C.red]] as const) {
    text(label, x, 439, 21, C.white, 85, true);
    text(String(Math.round(value)), x + 47, 439, 24, col, 52, true);
  }

  // next speed limit / next signal: distance columns on the photographed log scale
  for (const [x, label] of [[411, '限速'], [491, '信号机']] as const) {
    text('下一个', x, 84, 17, C.white, 78, true, 'center');
    text(label, x, 110, 18, C.white, 78, true, 'center');
  }
  const limitKmh = d?.nextLimitKmh ?? -1, limitDist = d?.limitDist ?? -1, signalDist = d?.signalDist ?? -1;
  text(limitKmh >= 0 ? String(Math.round(limitKmh)) : '—', 405, 136, 21, C.yellow, 70, true, 'center');
  const y0 = 155, hh = 270;
  line(400, y0, 400, y0 + hh, 4, C.white);
  line(508, y0, 508, y0 + hh, 4, C.white);
  TICKS.forEach((n, i) => {
    const y = y0 + i * hh / (TICKS.length - 1);
    line(400, y, 410, y, 3, C.white); line(498, y, 508, y, 3, C.white);
    text(String(n), 454, y + 6, 17, C.white, 76, true, 'center');
  });
  for (const [x, distance] of [[400, limitDist], [508, signalDist]] as const) {
    if (!(distance >= 0 && Number.isFinite(distance))) continue;
    const value = Math.min(1000, distance);
    let i = 0;
    while (i < TICKS.length - 2 && value < TICKS[i + 1]) i++;
    const f = (TICKS[i] - value) / (TICKS[i] - TICKS[i + 1]);
    const y = y0 + (i + f) * hh / (TICKS.length - 1);
    line(x - 15, y, x + 15, y, 6, C.magenta);
  }
  text(limitDist >= 0 ? String(Math.round(limitDist)) : '—', 401, 450, 18, C.yellow, 52, true, 'center');
  text('米', 454, 453, 20, C.white, 55, true, 'center');

  // doors
  box(552, 64, 232, 155);
  text('门', 668, 90, 25, C.white, 200, true, 'center');
  line(668, 96, 668, 211, 2, C.white);
  const enabled = protectedMode && docked && (t.phase === 'dwell' || t.doorsAwait || t.doors);
  const psdEnabled = docked && protectedMode && !!d && d.psd !== 'none';
  const doorWord = (s: string | undefined) => s === 'opening' ? 'Opening' : s === 'closing' ? 'Closing' : s === 'fault' ? 'Fault'
    : s === 'bypass' ? 'Bypass' : s === 'isolated' ? 'Isolated' : s === 'none' || s === undefined ? '—' : s === 'open' ? 'Open' : 'Closed';
  const doorColour = (s: string | undefined) => s === 'opening' || s === 'closing' || s === 'bypass' || s === 'isolated' ? C.yellow
    : s === 'open' || s === 'fault' ? C.red : s === 'none' || s === undefined ? C.white : C.green;
  for (const [x, label, on, state] of [[612, '列车门', enabled, d?.trainDoor], [726, '站台门', psdEnabled, d?.psd]] as const) {
    text(label, x, 125, 23, C.white, 111, true, 'center');
    text(on ? 'Enabled' : 'Disabled', x, 160, 21, on ? C.red : C.green, 109, false, 'center');
    text(doorWord(state), x, 193, 22, doorColour(state), 109, false, 'center');
  }

  // station
  box(614, 228, 170, 157);
  text('车站', 699, 251, 21, C.white, 165, true, 'center');
  line(699, 260, 699, 381, 2, C.white);
  text('下一站', 656, 277, 19, C.white, 80, true, 'center');
  text('终点站', 742, 277, 19, C.white, 80, true, 'center');
  text(d?.next ?? '—', 656, 302, 21, C.blue, 81, true, 'center');
  text(d?.dest ?? t.dest ?? '—', 742, 302, 21, C.blue, 81, true, 'center');
  line(618, 312, 780, 312, 2, C.white);
  text('扣车', 656, 339, 20, C.white, 80, true, 'center');
  text('跳停', 742, 339, 20, C.white, 80, true, 'center');
  const held = t.hold || !!d?.stationHold;
  text(held ? 'YES' : 'NO', 656, 371, 23, held ? C.yellow : C.red, 80, true, 'center');
  text(d?.skipNext ? 'YES' : 'NO', 742, 371, 23, d?.skipNext ? C.yellow : C.red, 80, true, 'center');

  // WSP / ATP / ATO / 定位 / EB
  const positioned = t.body.length >= 3;
  const ato = (t.mode === 'DTO' || t.mode === 'AM') && protectedMode;
  const statuses: [string, string, string][] = [
    ['WSP', t.slip ? 'YES' : 'NO', t.slip ? C.yellow : C.red],
    ['ATP', protectedMode ? 'OK' : 'NO', protectedMode ? C.blue : C.red],
    ['ATO', ato ? 'OK' : 'NO', ato ? C.blue : C.red],
    ['定位', positioned ? 'YES' : 'NO', positioned ? C.blue : C.red],
    ['EB', t.eb ? 'ON' : 'OK', t.eb ? C.red : C.blue],
  ];
  statuses.forEach(([label, value, col], i) => {
    const x = 530 + i * 52;
    box(x, 395, 52, 73);
    text(label, x + 26, 418, 19, C.white, 49, false, 'center');
    text(value, x + 26, 451, 23, col, 49, true, 'center');
  });

  // message rows: train information, fault messages
  box(107, 474, 471, 37);
  box(107, 513, 471, 37);
  const info = d ? unacked(d, false) : undefined, fault = d ? unacked(d, true) : undefined;
  const terminal = t.phase === 'dwell' && !!d && d.next !== '—' && d.next === d.dest;
  text(terminal ? '列车到达终点' : t.hold ? '扣车' : info?.m ?? '', 343, 500, 22, C.white, 457, true, 'center');
  text(t.eb ? `紧急制动 ${t.ebReason}` : fault?.m ?? 'FAULT MESSAGE', 343, 539, 21, C.red, 450, true, 'center');
  key(ACK[0].x, ACK[0].y, ACK[0].w, ACK[0].h, '确认', !!info);
  key(ACK[1].x, ACK[1].y, ACK[1].w, ACK[1].h, '确认', !!fault);
  key(584, 474, 94, 36, '列表', false);
  key(584, 513, 94, 36, '列表', false);
  key(684, 474, 108, 36, 'English', false);
  key(684, 513, 108, 36, '司机 车', false);

  // bottom row
  box(8, 557, 142, 35); text('日期', 12, 580, 17); text(d?.date.replaceAll('/', '.') || '—', 48, 580, 16, C.blue, 100, true);
  box(150, 557, 109, 35); text('时间', 154, 580, 17); text(fmtTime(now, false), 189, 580, 18, C.blue, 65, true);
  box(343, 557, 95, 35); text('司机', 348, 580, 19, C.white, 53); text('---', 429, 580, 19, C.red, 38, true, 'right');
  box(438, 557, 106, 35); text('车号', 443, 580, 19); text(t.vehicle, 538, 580, 21, C.blue, 63, true, 'right');
  box(544, 557, 93, 35); text('编组', 549, 580, 19); text('-', 629, 580, 19, C.red, 38, true, 'right');
  c.restore();
}
