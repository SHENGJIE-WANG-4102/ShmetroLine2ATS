import type { SoundClip } from '../../types';

/** 用户 2026-11-15 车内录音（嘉定北→江苏路）剪出的开关门声，按站随机取（确定性）。
 * 关门：门铃（约 2850 Hz、860 Hz 脉冲，约 6 s）到铃后 3.5 s，含门动作和锁闭。
 * 开门：没有铃声，门开到底有一下碰撞声（用户确认）；取碰撞前 2.8 s 到后 1.5 s。
 * 自动找的（门铃按频率、碰撞按关门铃前 8–25 s 最强宽频冲击），没逐条试听；所在站未对齐，不填。
 * 录音和成片都不入库（public/sounds/line11/）。实录时长不改变门动作物理预算。 */
export const DOOR_SELECTION = 'random' as const;
export const DOOR_TAKES = [
  { id: 'o1', station: '', primary: false, open: [383.1, 387.4], confidence: 'medium' }, // 碰撞声 385.9 s
  { id: 'o2', station: '', primary: false, open: [553.2, 557.5], confidence: 'medium' }, // 碰撞声 556.0 s
  { id: 'o3', station: '', primary: false, open: [756.6, 760.9], confidence: 'medium' }, // 碰撞声 759.4 s
  { id: 'o4', station: '', primary: false, open: [1174.3, 1178.6], confidence: 'medium' }, // 碰撞声 1177.1 s
  { id: 'o5', station: '', primary: false, open: [1566.6, 1570.9], confidence: 'medium' }, // 碰撞声 1569.4 s
  { id: 'c1', station: '', primary: false, warn: [402.2, 412.25], confidence: 'medium' }, // 门铃 402.5–408.75 s
  { id: 'c2', station: '', primary: false, warn: [569.8, 579.75], confidence: 'medium' }, // 门铃 570.1–576.25 s
  { id: 'c3', station: '', primary: false, warn: [1431.45, 1441.5], confidence: 'medium' }, // 门铃 1431.75–1438.0 s
  { id: 'c4', station: '', primary: false, warn: [1998.35, 2008.4], confidence: 'medium' }, // 门铃 1998.65–2004.9 s
  { id: 'c5', station: '', primary: false, warn: [2274.35, 2284.4], confidence: 'medium' }, // 门铃 2274.65–2280.9 s
] as const;

export const DOOR_BANK: readonly SoundClip[] = DOOR_TAKES.map(take => {
  const kind = 'open' in take ? 'door-motion-open' : 'door-warn-close';
  const id = `${kind}-${take.id}`;
  return {
    id, file: `${id}.mp3`, kind, station: take.station, direction: 'shared', side: 'shared',
    source: 'ride-20261115-jdb-jsl', range: [...('open' in take ? take.open : take.warn)] as [number, number],
    confidence: take.confidence, both: false, fadeInS: .015, fadeOutS: .015,
  };
});
