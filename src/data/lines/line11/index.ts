import type { LineData } from '../../types';
import { emptyAudio } from '../../emptyAudio';
import { LINE11_CORE } from './line11';
import { LINE11_FIRST_LAST } from './firstlast';
import { LINE11_SIMULATION } from './simulation';
import { LINE11_UI } from './ui';
import * as soundbank from './soundbank';
import * as doorbank from './doorbank';

// 门动作时间：用户核对录音一站（2026-11-15）：开门 3 s 到位；关门提示音 4 s 后门动，2 s 关到位。
const silentAudio = emptyAudio(LINE11_CORE.STATIONS, { openingS: 3, warningToMotionS: 4, motionToLockedS: 2 });

export const LINE_11: LineData = {
  id: '11',
  branding: { title: '上海轨道交通11号线', shortName: '11号线', color: LINE11_CORE.LINE_INFO.colorCss, badgeUrl: '', logoText: '11' },
  unattended: { doorClose: false, turnback: false, wakeSleep: false, depotMoves: false },
  lineAtoFallback: false,
  dto: false, // 用户决定（2026-11-16）：GoA2 司机驾驶 ATO，换端、按 ATO 启动按钮发车（D205）
  signalling: { primary: 'CBTC', fallback: [], onLoss: 'restrictedManual', wayside: 'lit' }, // 【假设】缺11号线信号后备逐项资料
  automation: 'ATO',
  core: LINE11_CORE,
  firstLast: LINE11_FIRST_LAST,
  lastTrains: { OTHER_LAST_TRAINS: [] },
  // 车内走行/停车环境声、开关门声来自用户录音（L11-21，2026-11-15）；其余录音库仍为空
  audio: { ...silentAudio, soundbank, doorbank: { ...silentAudio.doorbank, ...doorbank } },
  simulation: LINE11_SIMULATION,
  ui: LINE11_UI,
};
