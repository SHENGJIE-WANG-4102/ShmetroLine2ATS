import type { LineData } from '../../types';
import { emptyAudio } from '../../emptyAudio';
import { LINE11_CORE } from './line11';
import { LINE11_FIRST_LAST } from './firstlast';
import { LINE11_SIMULATION } from './simulation';
import { LINE11_UI } from './ui';

// 11号线没有本地录音库；门动作物理预算沿用 6A 通用值【假设】。
const silentAudio = emptyAudio(LINE11_CORE.STATIONS, { openingS: 2.5, warningToMotionS: 2.2, motionToLockedS: 4.5 });

export const LINE_11: LineData = {
  id: '11',
  branding: { title: '上海轨道交通11号线', shortName: '11号线', color: LINE11_CORE.LINE_INFO.colorCss, badgeUrl: '', logoText: '11' },
  unattended: { doorClose: false, turnback: false, wakeSleep: false, depotMoves: false },
  signalling: { primary: 'CBTC', fallback: [], onLoss: 'restrictedManual' }, // 【假设】缺11号线信号后备逐项资料
  automation: 'ATO',
  core: LINE11_CORE,
  firstLast: LINE11_FIRST_LAST,
  lastTrains: { OTHER_LAST_TRAINS: [] },
  audio: silentAudio,
  simulation: LINE11_SIMULATION,
  ui: LINE11_UI,
};
