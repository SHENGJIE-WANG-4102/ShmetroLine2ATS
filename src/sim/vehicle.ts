/**
 * Vehicle faults between "recovers by itself" and "needs rescue" (D64):
 *  - 牵引单元故障: inverters cut out (of 6, 6M2T with one per motor car 【假设】),
 *    the train keeps running with less traction (the electric brake is
 *    blended out by the friction brake, so braking is unchanged). A driver's
 *    reset may bring them back; otherwise the dispatcher lets it run to the
 *    terminus and withdraw (终点站下线), clears it at the next station, or
 *    keeps it in service.
 *  - 车门故障: a car door does not close at a stop. The driver isolates it
 *    (切除, 60–90 s); with a door cut out every stop takes a little longer.
 *    Severe: it can neither close nor be isolated — clear the passengers and
 *    lock it for the run to the depot, or wait for the maintainer.
 *  - 制动不缓解: at departure one car's brake does not release. The driver
 *    tries to release it (2 min); if that fails he cuts that car's brake out
 *    and the train runs at ≤ 60 km/h; several cars → it cannot move (rescue).
 * The faults on a train close when it reaches the depot. Times, the speed
 * limit and the door penalty are approximations.
 */
import type { Sim } from './engine';
import type { Train, VehicleFault } from './model';
import { openCall } from './radio';
import { trainLabel, cmdWithdraw } from './ats';
import { injectFault } from './faults';
import { STATIONS } from '../data/current';

/** inverters on an 8-car 6M2T train */
export const TRACTION_UNITS = 6;
/** speed limit with one car's brake cut out (m/s) */
export const BRAKE_CUT_VMAX = 60 / 3.6;
/** extra dwell per isolated door (s) */
export const DOOR_CUT_DWELL = 2;
const DOOR_ISOLATE = 75;
const DOOR_MAINTAINER = 8 * 60;
const DOOR_LOCK = 120;
const BRAKE_RELEASE_TRY = 120;

function driverOf(tr: Train) {
  return `${tr.svc}-${tr.tripNo} 司机`;
}

function stationHere(tr: Train): string {
  const t = tr.tasks[0];
  return t && t.k === 'stop' ? STATIONS[t.station].name : '区间';
}

// ---------------------------------------------------------------- injection (faults.ts)

export function injectTraction(sim: Sim, tr: Train, units: number, recover: boolean, fault: number): string {
  tr.tractionCut = Math.min(TRACTION_UNITS - 1, Math.max(tr.tractionCut, units));
  const left = Math.round((1 - tr.tractionCut / TRACTION_UNITS) * 100);
  const text = `列车 ${trainLabel(tr)}（${tr.vehicle}）牵引系统故障，切除 ${tr.tractionCut} 个牵引单元（剩余牵引力约 ${left}%）`;
  sim.log('B', '列车', text, { key: `vt-${tr.id}`, train: tr.id });
  if (recover) {
    // the driver resets the inverters at the next stop
    sim.vehicleResets.push({ train: tr.id, at: sim.t + 180 + sim.rng() * 120, fault });
  }
  openCall(sim, {
    kind: 'vTraction', from: driverOf(tr), train: tr.id,
    text: `牵引系统故障，已切除 ${tr.tractionCut} 个牵引单元，剩余牵引力约 ${left}%，加速变慢，请求指示`,
    options: [
      { key: 'end', label: '继续运营，终点站下线' },
      { key: 'withdraw', label: '前方站清客回段' },
      { key: 'keep', label: '继续运营（夜间检修）' },
    ],
    auto: tr.tractionCut >= 2 ? 'withdraw' : 'end', timeout: 120,
  });
  return text;
}

export function injectDoor(sim: Sim, tr: Train, sev: 1 | 2, fault: number): string {
  const car = 1 + Math.floor(sim.rng() * 8), door = 1 + Math.floor(sim.rng() * 5);
  tr.vfault = { kind: 'door', sev, stage: 'armed', until: 0, fault, recover: false, car, door };
  const text = `列车 ${trainLabel(tr)}（${tr.vehicle}）第${car}车${door}号门故障${sev === 2 ? '（无法关闭且无法切除）' : ''}`;
  return text;
}

export function injectBrake(sim: Sim, tr: Train, sev: 1 | 2, recover: boolean, fault: number): string {
  const car = 1 + Math.floor(sim.rng() * 8);
  tr.vfault = { kind: 'brake', sev, stage: 'armed', until: 0, fault, recover, car, door: 0 };
  return `列车 ${trainLabel(tr)}（${tr.vehicle}）第${car}车制动不缓解${sev === 2 ? '（多车）' : ''}`;
}

// ---------------------------------------------------------------- hooks (ats.ts dwell)

/** at the door close of an automatic stop: a door that does not close keeps the train (true = hold) */
export function doorCloseHold(sim: Sim, tr: Train): boolean {
  const f = tr.vfault;
  if (!f || f.kind !== 'door') return false;
  if (f.stage === 'armed') {
    f.stage = 'stuck';
    f.until = sim.t + DOOR_ISOLATE;
    sim.log('B', '列车', `列车 ${trainLabel(tr)} 在${stationHere(tr)}第${f.car}车${f.door}号门无法关闭，司机处置中`, { key: `vd-${tr.id}`, train: tr.id });
  }
  tr.dwellUntil = Math.max(tr.dwellUntil, sim.t + 1);
  return true;
}

/** when the train is ready to leave: a brake that does not release keeps it (true = hold) */
export function departureHold(sim: Sim, tr: Train, activate = true): boolean {
  const f = tr.vfault;
  if (f?.kind === 'door' && f.stage !== 'armed') return true;
  if (!f || f.kind !== 'brake') return false;
  if (activate && f.stage === 'armed') {
    f.stage = 'stuck';
    f.until = sim.t + BRAKE_RELEASE_TRY;
    sim.log('B', '列车', `列车 ${trainLabel(tr)} 在${stationHere(tr)}发车时第${f.car}车制动不缓解，司机处置中`, { key: `vb-${tr.id}`, train: tr.id });
  }
  return true;
}

// ---------------------------------------------------------------- once a second

export function vehicleTick(sim: Sim) {
  for (let i = sim.vehicleResets.length - 1; i >= 0; i--) {
    const r = sim.vehicleResets[i];
    if (sim.t < r.at) continue;
    sim.vehicleResets.splice(i, 1);
    const tr = sim.trains.get(r.train);
    const f = sim.faults.find((x) => x.id === r.fault);
    if (!tr || !f || f.repaired) continue;
    // healthy again: no reason left to come off at the terminus
    const keep = tr.withdrawAtEnd && (tr.vfault || tr.vCap < Infinity || tr.doorsCut > 0);
    sim.log('C', '列车', `列车 ${trainLabel(tr)} 牵引系统复位成功，牵引单元恢复${tr.withdrawAtEnd && !keep ? '，取消终点站下线' : ''}`, { train: tr.id });
    if (!keep) tr.withdrawAtEnd = false;
    f.repairAt = sim.t;
  }
  for (const tr of sim.trainList) {
    // a train told to withdraw at the end of its trip does so at the terminus
    if (tr.withdrawAtEnd && tr.phase === 'dwell') {
      const t = tr.tasks[0];
      if (t?.k === 'stop' && t.trip >= 0 && t.dep === null) {
        tr.withdrawAtEnd = false;
        cmdWithdraw(sim, tr, '车辆故障：终点站下线');
        sim.log('I', '调度', `列车 ${trainLabel(tr)} 车辆故障，终点站下线回段`, { train: tr.id });
      }
    }
    const f = tr.vfault;
    if (!f || f.stage === 'armed' || sim.t < f.until) continue;
    if (f.kind === 'door') doorStep(sim, tr, f);
    else brakeStep(sim, tr, f);
  }
  // faults on a train that has left the line are closed in the depot
  for (const f of sim.faults) {
    if (f.repaired || (f.kind !== 'traction' && f.kind !== 'door' && f.kind !== 'brake')) continue;
    const tr = sim.trains.get(f.target);
    if (!tr || tr.phase === 'stabled') f.repairAt = Math.min(f.repairAt, sim.t);
  }
}

function doorStep(sim: Sim, tr: Train, f: VehicleFault) {
  const where = `${stationHere(tr)}`;
  if (f.stage === 'stuck' && f.sev === 1 || f.stage === 'maintainer') {
    tr.doorsCut++;
    tr.vfault = null;
    sim.clearAlarm(`vd-${tr.id}`);
    sim.log('C', '列车', `列车 ${trainLabel(tr)} 第${f.car}车${f.door}号门已切除（${f.stage === 'maintainer' ? '检修人员处理' : '司机处置'}），关门发车`, { train: tr.id });
    if (f.stage === 'stuck') {
      openCall(sim, {
        kind: 'vDoorCut', from: driverOf(tr), train: tr.id,
        text: `${where}第${f.car}车${f.door}号门无法关闭，已切除（对应站台门由车站张贴告示），请求指示`,
        options: [{ key: 'keep', label: '继续运营（夜间检修）' }, { key: 'end', label: '继续运营，终点站下线' }],
        auto: 'keep', timeout: 120,
      });
    }
    return;
  }
  if (f.stage === 'stuck') {
    f.stage = 'decide';
    f.until = Infinity;
    openCall(sim, {
      kind: 'vDoorStuck', from: driverOf(tr), train: tr.id,
      text: `${where}第${f.car}车${f.door}号门无法关闭也无法切除，列车不能动车，请求指示`,
      options: [{ key: 'withdraw', label: '本站清客，锁闭车门后回段' }, { key: 'wait', label: '等候检修人员到场处理（约8分钟）' }],
      auto: 'withdraw', timeout: 90,
    });
    return;
  }
  if (f.stage === 'lock') {
    tr.doorsCut++;
    tr.vfault = null;
    sim.clearAlarm(`vd-${tr.id}`);
    sim.log('C', '列车', `列车 ${trainLabel(tr)} 第${f.car}车${f.door}号门已锁闭，空车回段`, { train: tr.id });
  }
}

function brakeStep(sim: Sim, tr: Train, f: VehicleFault) {
  if (f.stage !== 'stuck') return;
  tr.vfault = null;
  sim.clearAlarm(`vb-${tr.id}`);
  const fault = sim.faults.find((x) => x.id === f.fault);
  if (f.recover) {
    sim.log('C', '列车', `列车 ${trainLabel(tr)} 制动缓解成功，恢复运行`, { train: tr.id });
    if (fault) fault.repairAt = sim.t;
    return;
  }
  if (f.sev === 2) {
    // a train that cannot move: the train failure procedure (rescue) takes over
    sim.log('A', '列车', `列车 ${trainLabel(tr)} 多车制动不缓解，无法动车`, { train: tr.id });
    if (fault) fault.repairAt = sim.t;
    injectFault(sim, 'trainFail', tr.id, 0, undefined, false);
    return;
  }
  tr.vCap = BRAKE_CUT_VMAX;
  sim.log('B', '列车', `列车 ${trainLabel(tr)} 切除第${f.car}车制动，限速 ${Math.round(BRAKE_CUT_VMAX * 3.6)} km/h 运行`, { key: `vbc-${tr.id}`, train: tr.id });
  openCall(sim, {
    kind: 'vBrake', from: driverOf(tr), train: tr.id,
    text: `第${f.car}车制动不缓解，已切除该车制动，限速 ${Math.round(BRAKE_CUT_VMAX * 3.6)} km/h，请求指示`,
    options: [{ key: 'end', label: '限速运行至终点站下线' }, { key: 'withdraw', label: '前方站清客回段' }],
    auto: 'end', timeout: 120,
  });
}

// ---------------------------------------------------------------- answers (radio.ts)

export function answerVehicle(sim: Sim, kind: string, tr: Train | undefined, option: string): { ok: boolean; msg: string } {
  if (!tr) return { ok: false, msg: '列车已不在线' };
  if (kind === 'vDoorStuck') {
    const f = tr.vfault;
    if (!f || f.kind !== 'door' || f.stage !== 'decide') return { ok: false, msg: '车门情况已变化' };
    if (option === 'wait') {
      f.stage = 'maintainer';
      f.until = sim.t + DOOR_MAINTAINER;
      return { ok: true, msg: '检修人员赶赴现场处理' };
    }
    f.stage = 'lock';
    f.until = sim.t + DOOR_LOCK;
    const r = cmdWithdraw(sim, tr, '车门故障：清客回段');
    return r.ok ? { ok: true, msg: '本站清客，车门锁闭后回段' } : r;
  }
  if (option === 'withdraw') return cmdWithdraw(sim, tr, '车辆故障：清客回段');
  if (option === 'end') {
    tr.withdrawAtEnd = true;
    return { ok: true, msg: '继续运营，终点站下线' };
  }
  return { ok: true, msg: '继续运营，夜间检修' };
}

/** clear a train's vehicle fault effects (faults.ts repair) */
export function clearVehicleFault(sim: Sim, kind: 'traction' | 'door' | 'brake', tr: Train | undefined) {
  if (!tr) return;
  if (kind === 'traction') { tr.tractionCut = 0; sim.clearAlarm(`vt-${tr.id}`); }
  if (kind === 'door') { tr.doorsCut = 0; if (tr.vfault?.kind === 'door') tr.vfault = null; sim.clearAlarm(`vd-${tr.id}`); }
  if (kind === 'brake') { tr.vCap = Infinity; if (tr.vfault?.kind === 'brake') tr.vfault = null; sim.clearAlarm(`vb-${tr.id}`); sim.clearAlarm(`vbc-${tr.id}`); }
}

/** short vehicle fault state for the train list */
export function vehicleNote(tr: Train): string {
  const n: string[] = [];
  if (tr.tractionCut) n.push(`牵引切除${tr.tractionCut}`);
  if (tr.doorsCut) n.push(`门切除${tr.doorsCut}`);
  if (tr.vfault && tr.vfault.stage !== 'armed') n.push(tr.vfault.kind === 'door' ? '车门故障' : '制动不缓解');
  if (tr.vCap < Infinity) n.push(`限速${Math.round(tr.vCap * 3.6)}`);
  if (tr.withdrawAtEnd) n.push('终点下线');
  return n.join(' ');
}
