import { LINE_2 } from './lines/line2';
import { TEST_LINE } from './lines/test';
import type { LineData, LineGroup, ScopedId } from './types';

function singleLineGroup(line: LineData, developmentOnly = false): LineGroup {
  return { id: line.id, name: line.core.LINE_INFO.shortName, lines: [line], lineIds: [line.id], developmentOnly };
}
export const LINE_GROUPS: readonly LineGroup[] = [singleLineGroup(LINE_2), singleLineGroup(TEST_LINE, true)];

export function getGroup(id: string): LineGroup {
  const group = LINE_GROUPS.find(candidate => candidate.id === id);
  if (!group) throw new Error(`未知线路组：${id}`);
  return group;
}
export function getLine(id: string, group?: LineGroup): LineData {
  const line = (group ? group.lines : LINE_GROUPS.flatMap(candidate => candidate.lines)).find(candidate => candidate.id === id);
  if (!line) throw new Error(`未知线路：${id}`);
  return line;
}
export function visibleLineGroups(includeDevelopment = false): readonly LineGroup[] {
  return LINE_GROUPS.filter(group => includeDevelopment || !group.developmentOnly);
}
export function scopedId(lineId: string, kind: ScopedId['kind'], localId: string): ScopedId {
  return { lineId, kind, localId };
}
