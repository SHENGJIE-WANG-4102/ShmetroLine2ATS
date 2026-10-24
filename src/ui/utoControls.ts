import { h } from './dom';
import { OPERATIONS, unattended } from '../data/current';
import type { Store } from './store';
import type { TrainSnap, UtoAction, VehicleRecord } from '../sim/model';
import { nextUtoAction } from '../sim/utoActions';

const LABELS: Record<UtoAction, string> = {
  report: '报 OCC', key: '插入主控钥匙', famOff: 'FAM 开关拨到 0', brake: '手柄拉到制动', confirm: '确认驾驶模式',
  restoreReport: '报 OCC 申请恢复 FAM', neutral: '双手柄归 0', famOn: 'FAM 开关拨回全自动位',
};
const VEHICLE_LABELS = { sleep: '休眠', power: '唤醒上电', pantograph: '升弓', selfTest: '自检', ready: '可用', clear: '清客确认', wash: '自动洗车' };
export function vehicleOperationLabel(vehicle: VehicleRecord | undefined): string {
  return vehicle?.uto ? VEHICLE_LABELS[vehicle.uto.stage] : '';
}

export function isPlayerDriving(train: Pick<TrainSnap, 'manual' | 'uto'>): boolean {
  return train.manual && !train.uto?.computer;
}

export function utoDrivingChoices(store: Store, train: TrainSnap): HTMLElement[] {
  const choices: ['AUTO' | 'CM' | 'RM', string][] = train.uto?.computer || train.mode === 'DTO' && !train.uto
    ? [['CM', `${OPERATIONS.uto?.crewLabel ?? '司机'}接管 ATPM`], ['RM', `${OPERATIONS.uto?.crewLabel ?? '司机'}接管 RM`]]
    : [['AUTO', '申请恢复 FAM']];
  return choices.map(([mode, label]) => h('button', { class: 'btn warn', disabled: !!train.uto && train.uto.stage !== 'manual', onclick: () => void store.command({ c: 'manual', train: train.id, mode }) }, label));
}

/** The buttons issue the same logged commands as the computer-controlled sequence. */
export function utoControls(store: Store, train: TrainSnap): HTMLElement[] {
  if (!unattended('doorClose')) return [];
  const controls: HTMLElement[] = [];
  const control = train.uto;
  if (control && control.stage !== 'manual' && control.stage !== 'reset') {
    const next = nextUtoAction(control);
    controls.push(h('div', { class: 'hint', 'data-uto-status': '' }, control.detail));
    const side = train.doorSide || train.platSide;
    if (control.stage === 'doors' && !control.computer && train.doors && side) controls.push(h('button', {
      class: 'btn primary', disabled: train.doorClosing,
      onclick: () => void store.command({ c: 'door', train: train.id, side }),
    }, train.doorClosing ? '等待车门关闭锁紧' : '关闭站台侧车门'));
    if (next && !control.computer) controls.push(h('button', {
      class: 'btn primary', disabled: train.doors || train.doorsAwait || train.doorClosing || !!(store.snap && store.snap.t < control.until),
      onclick: () => void store.command({ c: 'utoStep', train: train.id, action: next }),
    }, LABELS[next]));
  }
  if (train.dto === '车载全自动功能故障') controls.push(h('button', {
    class: 'btn warn', disabled: train.v >= .05 || !!control && control.stage !== 'manual',
    onclick: () => void store.command({ c: 'utoReset', train: train.id }),
  }, control?.stage === 'reset' ? '等待 OCC 远程复位' : 'OCC 远程复位全自动功能'));
  return controls;
}
