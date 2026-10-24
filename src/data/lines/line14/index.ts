import type { LineData } from '../../types';
import { emptyAudio } from '../../emptyAudio';
import { LINE14_CORE } from './line14';
import { LINE14_FIRST_LAST } from './firstlast';
import { LINE14_SIMULATION } from './simulation';
import { LINE14_UI } from './ui';

export const LINE_14: LineData = {
  id: '14', branding: { title: '上海轨道交通14号线', shortName: '14号线', color: LINE14_CORE.LINE_INFO.colorCss, badgeUrl: '', logoText: '14' },
  unattended: { doorClose: true, turnback: true, wakeSleep: true, depotMoves: true },
  signalling: { primary: 'CBTC', fallback: [], onLoss: 'restrictedManual' }, automation: 'UTO',
  core: LINE14_CORE, firstLast: LINE14_FIRST_LAST, lastTrains: { OTHER_LAST_TRAINS: [] },
  // 同2号线，同为8A自动门的物理时间预算【假设】；没有音频素材，不继承任何声音。
  audio: emptyAudio(LINE14_CORE.STATIONS, { openingS: 2.5, warningToMotionS: 2.2, motionToLockedS: 4.5 }),
  simulation: LINE14_SIMULATION, ui: LINE14_UI,
};
