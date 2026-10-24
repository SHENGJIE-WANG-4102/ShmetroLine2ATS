/** Status-grid cab: the photographed 0–90 dial, distance ladder and ATP/ATO/FAM column. */
import type { DmiData, DmiMsg, TrainSnap } from '../sim/model';
import { LINE, LINE_INFO } from '../data/current';
import { fmtTime, FONT_CN } from './theme';
import { formatTrainNumber } from './trainNumber';
import { formatDrivingMode } from './drivingMode';

const BG = '#131519', WHITE = '#e9edf0', GREEN = '#66ef54', YELLOW = '#efdf20', RED = '#f44338';
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
export function statusGridAlarmAt(d: DmiData, x: number, y: number): DmiMsg | undefined {
  if (x < 655 || x > 739 || y < 476 || y >= 548) return;
  const alarm = statusGridAlarms(d)[Math.floor((y - 476) / 36)];
  return alarm && !d.acknowledged?.includes(ackKey(alarm)) ? alarm : undefined;
}

export function drawStatusGrid(c: CanvasRenderingContext2D, t: TrainSnap, d: DmiData | null, now: number) {
  c.fillStyle = BG; c.fillRect(0, 0, 760, 640);
  c.textBaseline = 'middle'; c.textAlign = 'left';
  const text = (value: string, x: number, y: number, size = 19, color = WHITE, width?: number) => {
    c.fillStyle = color; c.font = `${size}px Arial, ${FONT_CN}`;
    if (width) c.fillText(value, x, y, width); else c.fillText(value, x, y);
  };
  const box = (x: number, y: number, w: number, h: number, color = '#737a80') => {
    c.strokeStyle = color; c.lineWidth = 1; c.strokeRect(x, y, w, h);
  };
  const mode = cabModeName(t.mode), actual = Math.max(0, t.v * 3.6), target = Math.max(0, (d?.targetSpeed ?? t.vTarget) * 3.6), max = Math.max(0, t.vPermit * 3.6);
  box(12, 12, 736, 47);
  text(`系统模式  ${t.level}`, 25, 35);
  text(`驾驶模式  ${mode}`, 233, 35);
  const phaseText: Record<TrainSnap['phase'], string> = { run: t.v > .05 ? '运行' : '停车', dwell: '停站', reversing: '折返', stabled: '停放', coupling: '连挂', failed: '故障', depotExit: '出段' };
  text(phaseText[t.phase], 464, 35);
  const departure = d?.departureBoard;
  const granted = departure && !departure.held && !t.eb && (['G', 'Y', 'GUIDE'].includes(departure.aspect) || departure.aspect === 'DARK' && t.maDist > 0);
  text('发车授权  ' + (departure ? granted ? '允许' : '等待' : '--'), 558, 35, 17);

  const cx = 211, cy = 232, radius = 139;
  const angle = (speed: number) => (-225 + Math.min(90, Math.max(0, speed)) / 90 * 270) * Math.PI / 180;
  const point = (speed: number, r: number) => [cx + Math.cos(angle(speed)) * r, cy + Math.sin(angle(speed)) * r];
  c.strokeStyle = WHITE; c.lineWidth = 2; c.beginPath(); c.arc(cx, cy, radius, angle(0), angle(90)); c.stroke();
  for (let v = 0; v <= 90; v += 2) {
    const [x, y] = point(v, radius), [u, w] = point(v, radius - (v % 10 === 0 ? 15 : 7));
    c.beginPath(); c.moveTo(x, y); c.lineTo(u, w); c.stroke();
    if (v % 10 === 0) { const [lx, ly] = point(v, radius - 31); c.textAlign = 'center'; text(String(v), lx, ly, 18); }
  }
  c.strokeStyle = RED; c.lineWidth = 7; c.beginPath(); c.arc(cx, cy, radius + 5, angle(max), angle(90)); c.stroke();
  for (const [speed, color] of [[target, YELLOW], [max, GREEN]] as const) {
    const a = angle(speed), [x, y] = point(speed, radius + 3);
    c.fillStyle = color; c.beginPath(); c.moveTo(x, y);
    c.lineTo(cx + Math.cos(a - .055) * (radius + 20), cy + Math.sin(a - .055) * (radius + 20));
    c.lineTo(cx + Math.cos(a + .055) * (radius + 20), cy + Math.sin(a + .055) * (radius + 20)); c.closePath(); c.fill();
  }
  const [nx, ny] = point(actual, radius - 22);
  c.strokeStyle = WHITE; c.lineWidth = 4; c.beginPath(); c.moveTo(cx, cy); c.lineTo(nx, ny); c.stroke();
  c.fillStyle = BG; c.beginPath(); c.arc(cx, cy, 27, 0, 2 * Math.PI); c.fill();
  c.textAlign = 'center'; text(String(Math.round(actual)), cx, cy, 32, t.eb ? RED : d?.speedWarning ? YELLOW : WHITE);
  text('km/h', cx, cy + 62, 17);
  text(`实际 ${Math.round(actual)}`, 104, 383, 20); text(`目标 ${Math.round(target)}`, 220, 383, 20, YELLOW); text(`最大 ${Math.round(max)}`, 335, 383, 20, GREEN);

  // Vertical nonlinear distance ladder; values and spacing follow the cab photograph.
  c.textAlign = 'right';
  DISTANCE_TICKS.forEach((v, i) => { const y = 357 - i * 25; text(String(v), 449, y, 14); box(456, y, 8, .5); });
  c.fillStyle = '#252a2e'; c.fillRect(468, 107, 25, 250);
  c.fillStyle = GREEN; const bar = 250 * distanceBarFraction(d?.targetDistance ?? -1); c.fillRect(468, 357 - bar, 25, bar);
  c.textAlign = 'center'; text(d && d.targetDistance >= 0 ? `${Math.round(d.targetDistance)} m` : '-- m', 468, 388, 18);

  c.textAlign = 'left';
  text('列车门', 521, 94, 17); text('站台门', 628, 94, 17);
  const door = (x: number, state: string) => { const open = state === 'open' || state === 'closing'; const col = state === 'fault' ? RED : state === 'none' ? '#444' : GREEN; box(x, 118, 17, 46, col); box(x + (open ? 32 : 19), 118, 17, 46, col); };
  door(531, d?.trainDoor ?? 'closed'); door(638, d?.psd ?? 'none');
  text(`门控模式  ${t.manual ? '手动' : '自动'}`, 521, 187, 18);
  text(`下一站  ${d?.next ?? '—'}`, 521, 225, 18, WHITE, 215);
  text(`目的地  ${d?.dest ?? t.dest}`, 521, 257, 18, WHITE, 215);
  text(`扣车 ${t.hold || d?.departureBoard?.held ? '是' : '否'}     跳停 ${t.nextStopSkipped ? '是' : '否'}`, 521, 292, 17);
  text(t.level, 521, 334, 19);
  for (const [i, label] of ['ATP', 'ATO', 'FAM'].entries()) {
    const selected = label === (mode === 'ATPM' || mode === 'RM' ? 'ATP' : mode);
    if (selected) box(654, 316 + i * 31, 71, 28, GREEN);
    text(label, 667, 331 + i * 31, 20, label === 'FAM' ? YELLOW : WHITE);
  }
  // Loss of the radio does not by itself prove the onboard location was lost.
  text(`定位 ${t.comm ? '有' : '--'}    通信 ${t.comm ? '正常' : '中断'}`, 27, 427, 18);
  text(`运行等级 ${d?.runningLevel ?? 1}`, 27, 455, 17);
  text(t.halt?.detail || t.unattendedStatus || '', 232, 455, 16, WHITE, 490);
  text('轮径校准 --', 581, 432, 17);

  const alarms = d ? statusGridAlarms(d) : [];
  for (let i = 0; i < 2; i++) {
    const alarm = alarms[i], y = 476 + i * 36;
    c.fillStyle = alarm?.k === 'alarm' ? '#7c171c' : '#373b40'; c.fillRect(20, y, 719, 32);
    text(alarm ? `${fmtTime(alarm.t)}  ${alarm.m}` : i === 0 ? '无告警' : '', 29, y + 16, 17, WHITE, 610);
    box(655, y, 84, 32); text(alarm && d?.acknowledged?.includes(ackKey(alarm)) ? '已确认' : '确认', 668, y + 16, 17);
  }
  box(20, 560, 719, 31); text('列表     操作维护     VCUs     音量     亮度', 33, 576, 17, '#a9adb0');
  text(`${LINE.branding.shortName}  车号 ${t.vehicle}  车次 ${formatTrainNumber(t.svc, t.trip)}  ${LINE_INFO.cars ?? 8}编`, 23, 615, 17, WHITE, 460);
  text(`${d?.date ?? ''}  ${fmtTime(now)}`, 487, 615, 17);
}
