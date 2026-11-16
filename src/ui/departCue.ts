import type { DmiData, TrainSnap } from '../sim/model';

/** 实拍视频（2026-11-02 机场 V1414）：门锁闭后等到 DEP 前约 2 s，黄色起步箭头出现，
 * 同时门关好绿灯熄灭；B 变 M 再晚 0.5～1 s（用户）；TDT 过零车动、箭头消失。 */
export function startCue(d: DmiData | null, now: number, lead = 2): boolean {
  return !!d?.startReady && d.dep >= 0 && d.dep - now <= lead;
}

/** 用户（2026-11-07，D188）：人工驾驶没有自动起步时刻，以门关好锁闭、有移动授权、未扣车、
 * 到发车时刻前 2 s 为准 */
export function manualStartCue(t: TrainSnap, d: DmiData | null, now: number): boolean {
  return t.manual && !t.hold && !t.eb && t.maDist > 1 && !t.doors && !t.doorClosing && !t.doorsAwait && !t.doorSide
    && (!d || d.dep < 0 || d.dep - now <= 2);
}

/** a standing train has its departure authority: the start arrow (Line 2), 出发 YES (Line 11) */
export function departureCue(t: TrainSnap, d: DmiData | null, now: number): boolean {
  return !!d?.atoStart || startCue(d, now) || manualStartCue(t, d, now);
}

/** the cab's ATO start lamp: blinking green once a driver-ATO (AM) train standing at a stop has its
 * departure authority, steady after F+G and while ATO drives (用户 2026-11-16) */
export function atoLampState(t: TrainSnap, d: DmiData | null, now: number): 'off' | 'blink' | 'on' {
  const ato = !t.manual && (t.mode === 'AM' || t.mode === 'DTO') && t.comm && t.level === 'CBTC';
  const stopped = t.v < 0.05;
  if (d?.atoPressed || ato && !stopped && t.phase === 'run') return 'on';
  return ato && t.mode === 'AM' && stopped && departureCue(t, d, now) ? 'blink' : 'off';
}
