import { GROUP } from './current';

/** Numeric station, train and depot IDs belong to one selected line group. */
export interface LineScope { groupId: string; lineIds: string[] }

export function currentScope(): LineScope {
  return { groupId: GROUP.id, lineIds: [...GROUP.lineIds] };
}

/** Archives before line selection were always the original single-line world. */
export const LEGACY_SCOPE: LineScope = { groupId: '2', lineIds: ['2'] };

export function sameScope(a: LineScope, b: LineScope): boolean {
  return a.groupId === b.groupId && Array.isArray(a.lineIds) && Array.isArray(b.lineIds)
    && a.lineIds.length === b.lineIds.length && a.lineIds.every((id, i) => id === b.lineIds[i]);
}

export function assertScope(scope: LineScope | undefined, expected = currentScope()): void {
  if (!sameScope(scope ?? LEGACY_SCOPE, expected)) throw new Error('线路组不匹配，不能恢复或回放其他线路的状态');
}
