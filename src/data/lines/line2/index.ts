import * as core from './line2';
import * as firstLast from './firstlast';
import * as lastTrains from './lasttrains';
import * as soundbank from './soundbank';
import * as onboardbank from './onboardbank';
import * as doorbank from './doorbank';
import * as vvvf from './vvvf';
import * as ridelog from './ridelog';
import * as onboardfield1021 from './onboardfield1021';
import { SIMULATION } from './simulation';
import { UI } from './ui';
import type { LineData } from '../../types';

export const LINE_2: LineData = {
  id: '2',
  branding: {
    title: core.LINE_INFO.name,
    shortName: core.LINE_INFO.shortName,
    color: core.LINE_INFO.colorCss,
    badgeUrl: new URL('./line2-badge.png', import.meta.url).href,
    logoText: '2',
  },
  unattended: { doorClose: false, turnback: false, wakeSleep: false, depotMoves: false },
  signalling: { primary: 'CBTC', fallback: ['TBTC'], onLoss: 'fallback' },
  automation: 'DTO',
  core, firstLast, lastTrains,
  audio: { soundbank, onboardbank, doorbank, vvvf, ridelog, onboardfield1021 },
  simulation: SIMULATION,
  ui: UI,
};
