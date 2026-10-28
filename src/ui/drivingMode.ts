import { LINE } from '../data/current';
const MODE_LABELS: Record<NonNullable<typeof LINE.ui.dmiStyle>, Record<string, string>> = {
  navyDial: {}, statusGrid: { DTO: 'FAM', AM: 'ATO', CM: 'ATPM', RM: 'RM' },
};
export function formatDrivingMode(mode: string): string {
  return MODE_LABELS[LINE.ui.dmiStyle ?? 'navyDial'][mode] ?? mode;
}
