/** Pure operation order shared by simulator and control panels. */
import type {UtoAction,UtoControlState} from './model';
const ACTIONS: UtoAction[] = ['report','key','famOff','brake','confirm'];
const RESTORE: UtoAction[] = ['restoreReport','neutral','famOn'];
export const UTO_ACTION_LABELS: Record<UtoAction,string> = {
  report:'向 OCC 报告接管', key:'插入主控钥匙', famOff:'FAM 开关拨到 0 位',
  brake:'手柄拉到制动位', confirm:'等待模式灯亮并确认',
  restoreReport:'向 OCC 申请恢复 FAM', neutral:'双手柄归 0', famOn:'FAM 开关拨回全自动位',
};
export const utoActions=(target:UtoControlState['target']):readonly UtoAction[]=>target==='DTO'?RESTORE:ACTIONS;
export function nextUtoAction(control:UtoControlState|undefined):UtoAction|undefined {
  if(!control||control.stage==='manual'||control.stage==='reset')return;
  const actions=utoActions(control.target);
  return control.stage==='doors'?actions[0]:actions[actions.indexOf(control.stage)+1];
}
