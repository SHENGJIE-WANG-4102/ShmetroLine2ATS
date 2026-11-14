import { LINE } from '../data/current';
const MODE_LABELS: Record<NonNullable<typeof LINE.ui.dmiStyle>, Record<string, string>> = {
  navyDial: {}, statusGrid: { DTO: 'FAM', AM: 'ATO', CM: 'ATPM', RM: 'RM' },
  // 11 号线实拍（2026-10-14）正常运营显示「模式 ATO」；手动模式字样未见【假设】
  tealPanel: { DTO: 'ATO', AM: 'ATO' },
};
export function formatDrivingMode(mode: string): string {
  return MODE_LABELS[LINE.ui.dmiStyle ?? 'navyDial'][mode] ?? mode;
}
