import type { SoundClip } from '../../types';

/** 用户 2026-11-15 车内录音（嘉定北→江苏路）剪出的开关门声，按站随机取（确定性）。
 * 关门：门铃（约 2850 Hz、860 Hz 脉冲，约 6 s）到铃后 3.5 s，含门动作和锁闭。
 * 开门：没有铃声，有开门动作声和开到位的碰撞声（用户确认）；取关门铃前 6–25 s 最强宽频冲击的前 1 s 到后 4 s，开门和到位都在里面。
 * 用户核对一站：2:21 开门、2:24 开门到位、2:37 关门提示音、2:41 关门、2:43 关门到位（o1、c1，高置信）；
 * 其余为自动找的，没逐条试听；所在站未对齐，不填。
 * 录音和成片都不入库（public/sounds/line11/）。实录时长不改变门动作物理预算。 */
export const DOOR_SELECTION = 'random' as const;
export const DOOR_TAKES = [
  { id: 'o1', station: '', primary: false, open: [141.0, 146.0], confidence: 'high' }, // 用户核对：2:21 开门、2:24 到位
  { id: 'o2', station: '', primary: false, open: [384.9, 389.9], confidence: 'medium' },
  { id: 'o3', station: '', primary: false, open: [555.0, 560.0], confidence: 'medium' },
  { id: 'o4', station: '', primary: false, open: [758.4, 763.4], confidence: 'medium' },
  { id: 'o5', station: '', primary: false, open: [1568.4, 1573.4], confidence: 'medium' },
  { id: 'c1', station: '', primary: false, warn: [156.6, 166.65], confidence: 'high' }, // 用户核对：2:37 提示音、2:41 关门、2:43 到位
  { id: 'c2', station: '', primary: false, warn: [402.2, 412.25], confidence: 'medium' },
  { id: 'c3', station: '', primary: false, warn: [569.8, 579.75], confidence: 'medium' },
  { id: 'c4', station: '', primary: false, warn: [1431.45, 1441.5], confidence: 'medium' },
  { id: 'c5', station: '', primary: false, warn: [1998.35, 2008.4], confidence: 'medium' },
  { id: 'c6', station: '', primary: false, warn: [2274.35, 2284.4], confidence: 'medium' },
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
