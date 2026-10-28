/** Status-grid cab: laid out after the 2025-09-05 cab photograph (reference/line14/line14-field-cab-2025-09-05.md). */
import type { DmiData, DmiMsg, TrainSnap } from '../sim/model';
import { LINE, LINE_INFO, STATIONS } from '../data/current';
import { FONT_CN } from './theme';
import { formatTrainNumber } from './trainNumber';
import { formatDrivingMode } from './drivingMode';

const BG = '#222427', WHITE = '#e9edf0', GREEN = '#66ef54', LIME = '#bce34e', YELLOW = '#efdf20', RED = '#f44338';
const KEY = '#d5d9df', KEY_TEXT = '#2b2e33';
export const DISTANCE_TICKS = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000] as const;

/** Each photographed interval has equal screen length; interpolate within the interval. */
export function distanceBarFraction(distance: number): number {
  if (!Number.isFinite(distance) || distance < 0) return 0;
  for (let i = 1; i < DISTANCE_TICKS.length; i++) {
    if (distance <= DISTANCE_TICKS[i]) return (i - 1 + (distance - DISTANCE_TICKS[i - 1]) / (DISTANCE_TICKS[i] - DISTANCE_TICKS[i - 1])) / (DISTANCE_TICKS.length - 1);
  }
  return 1;
}

export const cabModeName = formatDrivingMode;
const ackKey = (m: DmiMsg) => `${m.t}|${m.m}`;
export function statusGridAlarms(d: DmiData): DmiMsg[] {
  return d.log.filter(m => m.k !== 'info').slice(0, 2);
}
/** The two message rows, each with its 确认 key on the left as photographed. */
const ROW_Y = [508, 550] as const, ROW_H = 35, ACK_X = 18, ACK_W = 85;
export function statusGridAlarmAt(d: DmiData, x: number, y: number): DmiMsg | undefined {
  if (x < ACK_X || x > ACK_X + ACK_W) return;
  const row = ROW_Y.findIndex(top => y >= top && y < top + ROW_H);
  if (row < 0) return;
  const alarm = statusGridAlarms(d)[row];
  return alarm && !d.acknowledged?.includes(ackKey(alarm)) ? alarm : undefined;
}

/** The cab shows station names with 站 (豫园站); other targets (turnback tracks) as they are. */
const stationLabel = (name: string | undefined) => {
  if (!name || name === '—') return '--';
  // a turnback-track target is shown as its station
  const st = STATIONS.filter(s => name.startsWith(s.name)).sort((a, b) => b.name.length - a.name.length)[0];
  return st ? `${st.name}站` : name;
};
const pad = (n: number) => String(n).padStart(2, '0');

export function drawStatusGrid(c: CanvasRenderingContext2D, t: TrainSnap, d: DmiData | null, now: number) {
  c.fillStyle = BG; c.fillRect(0, 0, 760, 640);
  c.textBaseline = 'middle'; c.textAlign = 'left';
  const text = (value: string, x: number, y: number, size = 19, color = WHITE, width?: number) => {
    c.fillStyle = color; c.font = `${size}px Arial, ${FONT_CN}`;
    if (width) c.fillText(value, x, y, width); else c.fillText(value, x, y);
  };
  /** label above value, centred on x (the photographed right-hand fields) */
  const stacked = (label: string, value: string, x: number, y: number, color = WHITE, width?: number) => {
    c.textAlign = 'center'; text(label, x, y, 18); text(value, x, y + 26, 18, color, width); c.textAlign = 'left';
  };
  const key = (x: number, y: number, w: number, hgt: number, label: string | string[], color = KEY_TEXT, size = 18) => {
    c.fillStyle = KEY; c.fillRect(x, y, w, hgt);
    c.strokeStyle = '#8d939a'; c.lineWidth = 1; c.strokeRect(x + .5, y + .5, w - 1, hgt - 1);
    const lines = Array.isArray(label) ? label : [label];
    c.textAlign = 'center';
    lines.forEach((line, i) => text(line, x + w / 2, y + hgt / 2 + (i - (lines.length - 1) / 2) * (size + 1), size, color, w - 8));
    c.textAlign = 'left';
  };
  const mode = cabModeName(t.mode), actual = Math.max(0, t.v * 3.6), target = Math.max(0, (d?.targetSpeed ?? t.vTarget) * 3.6), max = Math.max(0, t.vPermit * 3.6);
  const ebi = d && d.vEbi > 0 ? d.vEbi * 3.6 : 0;

  // ---- top line: 系统模式 / 驾驶模式 / -- / phase / 发车授权
  text('系统模式', 14, 30, 20); text(t.level, 104, 30, 20, GREEN);
  text('驾驶模式', 186, 30, 20); text(mode, 276, 30, 20, GREEN);
  text('--', 372, 30, 20);
  const phaseText: Record<TrainSnap['phase'], string> = { run: t.v > .05 ? '运行' : '停车', dwell: '停站', reversing: '折返', stabled: '停放', coupling: '连挂', failed: '故障', depotExit: '出段' };
  text(phaseText[t.phase], 440, 30, 20);
  const departure = d?.departureBoard;
  const granted = departure && !departure.held && !t.eb && (['G', 'Y', 'GUIDE'].includes(departure.aspect) || departure.aspect === 'DARK' && t.maDist > 0);
  text('发车授权', 560, 30, 20); text(departure ? granted ? '允许' : '等待' : '--', 652, 30, 20);

  // ---- speed dial, 0–90 km/h, 0 at lower left
  const cx = 212, cy = 262, radius = 152;
  const angle = (speed: number) => (-225 + Math.min(90, Math.max(0, speed)) / 90 * 270) * Math.PI / 180;
  const point = (speed: number, r: number) => [cx + Math.cos(angle(speed)) * r, cy + Math.sin(angle(speed)) * r];
  c.strokeStyle = WHITE; c.lineWidth = 3; c.beginPath(); c.arc(cx, cy, radius, angle(0), angle(90)); c.stroke();
  c.lineWidth = 2;
  for (let v = 0; v <= 90; v += 5) {
    const [x, y] = point(v, radius), [u, w] = point(v, radius - (v % 10 === 0 ? 16 : 9));
    c.beginPath(); c.moveTo(x, y); c.lineTo(u, w); c.stroke();
    if (v % 10 === 0) { const [lx, ly] = point(v, radius - 36); c.textAlign = 'center'; text(String(v), lx, ly, 22); }
  }
  const redFrom = ebi > 0 ? ebi : max;
  if (redFrom < 90) { c.strokeStyle = RED; c.lineWidth = 5; c.beginPath(); c.arc(cx, cy, radius, angle(redFrom), angle(90)); c.stroke(); }
  // outside markers pointing at the scale: target (yellow), maximum (green), EB intervention (red)
  for (const [speed, color] of [[target, YELLOW], [max, GREEN], ...(ebi > 0 ? [[ebi, RED]] as const : [])] as const) {
    const a = angle(speed), [x, y] = point(speed, radius + 4);
    c.fillStyle = color; c.beginPath(); c.moveTo(x, y);
    c.lineTo(cx + Math.cos(a - .06) * (radius + 22), cy + Math.sin(a - .06) * (radius + 22));
    c.lineTo(cx + Math.cos(a + .06) * (radius + 22), cy + Math.sin(a + .06) * (radius + 22)); c.closePath(); c.fill();
  }
  const [nx, ny] = point(actual, radius - 22);
  c.strokeStyle = t.eb ? RED : WHITE; c.lineWidth = 5; c.lineCap = 'round'; c.beginPath(); c.moveTo(cx, cy); c.lineTo(nx, ny); c.stroke(); c.lineCap = 'butt';
  c.fillStyle = WHITE; c.beginPath(); c.arc(cx, cy, 7, 0, 2 * Math.PI); c.fill();
  c.textAlign = 'center'; text('Km/h', cx, cy + 46, 22);
  c.textAlign = 'left';
  text('实际 :', 66, 446, 20); text(String(Math.round(actual)), 128, 446, 20, d?.speedWarning ? YELLOW : WHITE);
  text('目标 :', 176, 446, 20); text(String(Math.round(target)), 238, 446, 20, YELLOW);
  text('最大 :', 286, 446, 20); text(String(Math.round(max)), 348, 446, 20, GREEN);

  // ---- target distance ladder (nonlinear, equal spacing per photographed interval)
  c.textAlign = 'center'; text('目标距离', 432, 70, 18); c.textAlign = 'right';
  const ladderTop = 104, ladderBottom = 386, step = (ladderBottom - ladderTop) / (DISTANCE_TICKS.length - 1);
  DISTANCE_TICKS.forEach((v, i) => {
    const y = ladderBottom - i * step; text(String(v), 440, y, 16);
    c.strokeStyle = WHITE; c.lineWidth = 2; c.beginPath(); c.moveTo(445, y); c.lineTo(456, y); c.stroke();
  });
  text('m', 414, ladderBottom + 4, 16);
  c.fillStyle = GREEN; const bar = (ladderBottom - ladderTop) * distanceBarFraction(d?.targetDistance ?? -1); c.fillRect(462, ladderBottom - bar, 14, bar);
  c.textAlign = 'center'; text(d && d.targetDistance >= 0 ? String(Math.round(d.targetDistance)) : '--', 470, 416, 20, YELLOW);

  // ---- doors: 列车门 / 站台门 / 门控模式 side by side
  c.textAlign = 'left';
  text('列车门', 494, 70, 18); text('站台门', 580, 70, 18);
  const door = (x: number, state: string) => {
    const open = state === 'open' || state === 'closing';
    const col = state === 'fault' ? RED : state === 'none' ? '#555a60' : '#b9c3d6';
    c.fillStyle = col; c.fillRect(x, 92, 12, 42); c.fillRect(x + (open ? 26 : 15), 92, 12, 42);
  };
  door(509, d?.trainDoor ?? 'closed'); door(595, d?.psd ?? 'none');
  c.textAlign = 'center'; text('门控', 712, 60, 18); text('模式', 712, 84, 18); text(t.manual ? '手动' : '自动', 712, 108, 18); c.textAlign = 'left';

  // ---- next station / destination, hold / skip
  stacked('下一站', stationLabel(d?.next), 552, 160, WHITE, 120);
  stacked('目的地', stationLabel(d?.dest ?? t.dest), 680, 160, WHITE, 120);
  text('扣车', 512, 238, 18); text(t.hold || d?.departureBoard?.held ? '是' : '否', 560, 238, 18);
  text('跳停', 640, 238, 18); text(t.nextStopSkipped ? '是' : '否', 688, 238, 18);

  // ---- level and mode column: CBTC beside ATO; ATP / ATO / FAM stacked, current one boxed
  const selectedMode = mode === 'ATPM' || mode === 'RM' ? 'ATP' : mode;
  c.textAlign = 'center';
  for (const [i, label] of ['ATP', 'ATO', 'FAM'].entries()) {
    const y = 300 + i * 34, selected = label === selectedMode;
    if (selected) { c.strokeStyle = GREEN; c.lineWidth = 2; c.strokeRect(565, y - 15, 64, 30); }
    text(label, 597, y, 22, selected ? GREEN : label === 'FAM' ? YELLOW : LIME);
  }
  text(t.level, 520, 334, 22, LIME);
  // Loss of the radio does not by itself prove the onboard location was lost.
  stacked('定位', t.comm ? '有' : '--', 668, 300);
  stacked('通信', t.comm ? '正常' : '中断', 724, 300, t.comm ? WHITE : RED);

  // ---- running level and wheel calibration, right of the message keys
  stacked('运行等级', d?.runningLevel === undefined || d.runningLevel === 1 ? '正常' : String(d.runningLevel), 600, 440);
  c.textAlign = 'center'; text('--', 668, 453, 18);
  stacked('轮径', '校准', 724, 440);

  // ---- message rows: 确认 | message | 列表 | 司机操作维护 / VCUs
  const alarms = d ? statusGridAlarms(d) : [];
  for (let i = 0; i < 2; i++) {
    const alarm = alarms[i], y = ROW_Y[i], acked = !!alarm && !!d?.acknowledged?.includes(ackKey(alarm));
    key(ACK_X, y, ACK_W, ROW_H, acked ? '已确认' : '确认');
    key(108, y, 284, ROW_H, alarm ? alarm.m : '', alarm?.k === 'alarm' ? '#d8262c' : '#8b9097', 20);
    key(397, y, 88, ROW_H, '列表');
  }
  key(490, ROW_Y[0], 90, ROW_H, ['司机操作', '维护'], KEY_TEXT, 15);
  key(490, ROW_Y[1], 90, ROW_H, 'VCUs  A/2', KEY_TEXT, 15);
  key(600, ROW_Y[1] + 2, 66, 31, '音量', KEY_TEXT, 17); key(676, ROW_Y[1] + 2, 66, 31, '亮度', KEY_TEXT, 17);
  c.textAlign = 'left';

  // ---- footer as photographed
  const tod = ((now % 86400) + 86400) % 86400;
  let x = 18;
  const seg = (value: string, color = WHITE, gap = 10) => { text(value, x, 616, 17, color); x += c.measureText(value).width + gap; };
  seg(LINE.branding.shortName, WHITE, 14); seg('车号'); seg(String(t.vehicle), LIME, 16);
  seg('车次号', YELLOW); seg(formatTrainNumber(t.svc, t.trip), YELLOW, 16); seg(`${LINE_INFO.cars ?? 8}编`, WHITE, 14);
  seg('司机号'); seg('0', LIME, 16);
  seg('日期'); seg((d?.date ?? '').replaceAll('/', '.') || '--', LIME, 16);
  seg('时间'); seg(`${pad(Math.floor(tod / 3600))}:${pad(Math.floor(tod % 3600 / 60))}`, LIME);
}
