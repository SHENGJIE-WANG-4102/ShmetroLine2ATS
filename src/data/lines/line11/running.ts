import type { ClockBand } from '../../simulation';

type SectionRunBand = { from: string; to: string; bands: (ClockBand & { allowanceS: number })[] };

/** 2026-11-19、11-20 两趟实测（嘉定北→曹杨路下行，18:06–20:15，`reference/line11/实测/`）逐段换算的补时：
 * 两次实测运行时分的平均减去当前物理最短走行，按 0.5 s 取整、不小于 0。
 * 只放在实测的钟点（工作日 18:00–20:30），首末班和别的时段、上行、周末沿用统一补时。
 * 马陆→陈翔公路第 2 次比第 1 次慢 9.5 s，南翔→桃浦新村两次都比物理最短多 37 s，都按平均写入。 */
const MEASURED: readonly (readonly [from: string, to: string, allowanceS: number])[] = [
  ['JDB', 'JDX', 13],
  ['JDX', 'BYL', 19.5],
  ['BYL', 'JDC', 16.5],
  ['JDC', 'ML', 15],
  ['ML', 'CXL', 26],
  ['CXL', 'NX', 12],
  ['NX', 'TPX', 37],
  ['TPX', 'WWL', 6.5],
  ['WWL', 'QLS', 8],
  ['QLS', 'LZY', 3],
  ['LZY', 'SXZ', 13.5],
  ['SXZ', 'ZR', 13],
  ['ZR', 'FQL', 5.5],
  ['FQL', 'CYL', 0],
];

export const EVENING_SECTION_RUN_BANDS: SectionRunBand[] = MEASURED.map(([from, to, allowanceS]) => ({
  from, to, bands: [{ from: 18 * 3600, to: 20.5 * 3600, value: 1, allowanceS }],
}));
