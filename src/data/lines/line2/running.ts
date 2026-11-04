import type { ClockBand } from '../../simulation';

type SectionRun = readonly [fromId: string, toId: string, level: 1 | 2 | 3 | 4, allowanceS: number];
type SectionRunBand = { from: string; to: string; bands: (ClockBand & { allowanceS: number })[] };

/** D171：11-02录音中正式纳入的23个中/高置信站对（DN19、UP4）。
 * 等级比较现有四档物理时分；余量按0.5s粒度，非负。
 * 旧统一22.5s是无区间实测时的prior，未见明确偏慢的段继续保留。
 * YDD→HTS即使零余量仍有约15.9s残差，保留报告，不改物理下界。
 * D173：软起步/软停车使每段最短走行增加2.6～4.1 s。实测拟合段的余量逐段减去该段增量
 * （最低0），保持与录音的拟合；旧22.5 s prior 改为统一默认18.7 s。
 */
const MEASURED: SectionRun[] = [
  ['PXL', 'GJH', 1, 4.8],
  ['GJH', 'HQZ', 1, 3.3],
  ['HQ2', 'SHR', 3, 18.7],
  ['SHR', 'BXJ', 1, 18.7],
  ['WNL', 'LSG', 1, 18.7],
  ['LSG', 'ZSG', 2, 18.7],
  ['ZSG', 'JSL', 2, 18.7],
  ['JSL', 'JAS', 1, 12.3],
  ['RMG', 'NJD', 1, 18.7],
  ['LJZ', 'PDN', 1, 5.6],
  ['PDN', 'SJD', 1, 11.1],
  ['SJD', 'KJG', 2, 18.7],
  ['ZJG', 'JKL', 1, 10.7],
  ['TZ', 'CXZ', 3, 18.7],
  ['HXD', 'CS', 3, 18.7],
  ['CS', 'LKL', 3, 18.7],
  ['LKL', 'YDD', 1, 15.9],
  ['YDD', 'HTS', 1, 0.0],
  ['HTS', 'PDA', 1, 0.0],
  ['NJD', 'RMG', 1, 18.7],
  ['JAS', 'JSL', 1, 18.7],
  ['HQZ', 'GJH', 3, 18.7],
  ['GJH', 'PXL', 2, 18.7],
];

/** 【假设】其余37段只有弱证据或缺测：在工作日整程约100min约束下
 * 采用现有一级，余量用统一默认（D173起18.7s），不把缺测写成零余量或实测。
 * CXZ→HXD的明确拒绝候选仍属缺测，不重新纳入正式区间指标。
 */
const ASSUMED: SectionRun[] = [
  ['HQZ', 'HQ2', 1, 18.7],
  ['BXJ', 'WNL', 1, 18.7],
  ['JAS', 'NJX', 1, 18.7],
  ['NJX', 'RMG', 1, 18.7],
  ['NJD', 'LJZ', 1, 18.7],
  ['KJG', 'SJG', 1, 18.7],
  ['SJG', 'LYL', 1, 18.7],
  ['LYL', 'ZJG', 1, 18.7],
  ['JKL', 'GLL', 1, 18.7],
  ['GLL', 'TZ', 1, 18.7],
  ['CXZ', 'HXD', 1, 18.7],
  ['PDA', 'HTS', 1, 18.7],
  ['HTS', 'YDD', 1, 18.7],
  ['YDD', 'LKL', 1, 18.7],
  ['LKL', 'CS', 1, 18.7],
  ['CS', 'HXD', 1, 18.7],
  ['HXD', 'CXZ', 1, 18.7],
  ['CXZ', 'TZ', 1, 18.7],
  ['TZ', 'GLL', 1, 18.7],
  ['GLL', 'JKL', 1, 18.7],
  ['JKL', 'ZJG', 1, 18.7],
  ['ZJG', 'LYL', 1, 18.7],
  ['LYL', 'SJG', 1, 18.7],
  ['SJG', 'KJG', 1, 18.7],
  ['KJG', 'SJD', 1, 18.7],
  ['SJD', 'PDN', 1, 18.7],
  ['PDN', 'LJZ', 1, 18.7],
  ['LJZ', 'NJD', 1, 18.7],
  ['RMG', 'NJX', 1, 18.7],
  ['NJX', 'JAS', 1, 18.7],
  ['JSL', 'ZSG', 1, 18.7],
  ['ZSG', 'LSG', 1, 18.7],
  ['LSG', 'WNL', 1, 18.7],
  ['WNL', 'BXJ', 1, 18.7],
  ['BXJ', 'SHR', 1, 18.7],
  ['SHR', 'HQ2', 1, 18.7],
  ['HQ2', 'HQZ', 1, 18.7],
];

/** 两日型引用同一数组；仅平峰11–16覆盖，首末班和高峰沿既有档位/余量。 */
export const OFFPEAK_SECTION_RUN_BANDS: SectionRunBand[] = [...MEASURED, ...ASSUMED]
  .map(([from, to, value, allowanceS]) => ({ from, to,
    bands: [{ from: 11 * 3600, to: 16 * 3600, value, allowanceS }] }));
