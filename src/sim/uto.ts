/** Capability-selected unattended procedures. Infrastructure arbitration remains in ATS. */
import type { Sim } from './engine';
import type { Train, StopTask, UtoAction, UtoControlState } from './model';
import { LINE, OPERATIONS, unattended } from '../data/current';
import { cbtcAvailable, setMode, releaseForRestrictedManual } from './onboard';
import { platformSide } from './ats';
import { stopError } from './movement';
import { DOOR_CLOSE_S } from './calibration';
import { depotMoves } from './timetable';
import { sourceDepartureAt } from './resourceArbitration';

export const crewLabel = () => OPERATIONS.uto?.crewLabel ?? '司机';
import {nextUtoAction, utoActions, UTO_ACTION_LABELS as LABELS} from './utoActions';
export {nextUtoAction} from './utoActions';
export function utoBusy(tr: Train): boolean { return !!tr.uto && tr.uto.stage !== 'manual'; }
/** A simulated attendant keeps the same manual cab and dispatch permissions as a player. */
export function computerCrew(tr: Train): boolean { return tr.manual && tr.uto?.computer === true && tr.uto.stage === 'manual'; }
const takeoverDay = (sim: Sim): string => sim.config.date ?? `seed:${sim.config.seed}`;
export function requestUtoControl(sim: Sim, tr: Train, mode: 'CM'|'RM'|'AM'|'AUTO', computer=false) {
  if (!unattended('doorClose') || !OPERATIONS.uto) return {ok:false,msg:'本线路没有无人驾驶接管流程'};
  if (mode === 'AM') return {ok:false,msg:'随车人员请选择 ATPM 或 RM 接管'};
  if (tr.eb || tr.v >= .05 || tr.failed || tr.phase === 'stabled') return {ok:false,msg:'须在列车停稳后办理接管'};
  if (utoBusy(tr)) return {ok:false,msg:`正在${tr.uto!.detail}`};
  if (mode === 'CM' && !cbtcAvailable(sim,tr)) return {ok:false,msg:'CBTC 不可用，不能转 ATPM'};
  if (mode === 'AUTO' && (!cbtcAvailable(sim,tr) || tr.dtoInhibit)) return {ok:false,msg:'CBTC 或全自动功能未恢复，不能恢复 FAM'};
  if (!computer && mode !== 'AUTO' && sim.trainList.some(o=>o!==tr&&!o.uto?.computer&&(o.manual||o.atoDriver||o.uto)))
    return {ok:false,msg:'已有其他列车被接管'};
  tr.uto = {target:mode==='AUTO'?'DTO':mode, computer, stage:'doors', until:sim.t, closeAt:tr.dwellUntil-DOOR_CLOSE_S, detail:'等待车门关闭并锁紧',
    ...(mode==='AUTO'?{}:tr.uto?.retreat?{retreat:true}:{}),
    ...(tr.uto?.resetSuccess===false?{resetSuccess:false}:{})};
  if(tr.phase==='dwell'){const work=utoActions(mode==='AUTO'?'DTO':mode).reduce((sum,_,i)=>sum+(OPERATIONS.uto!.takeoverStepS[i]??1),0);tr.dwellUntil=Math.max(tr.dwellUntil,sim.t)+work;tr.depReadyAt=Math.max(tr.depReadyAt,sim.t)+work;}
  tr.notch=-7;
  return {ok:true,msg:'先关门并锁紧，再按 OCC 报告、钥匙、模式开关、制动手柄、模式确认顺序操作'};
}
export function utoStep(sim:Sim,tr:Train,action:UtoAction) {
  const u=tr.uto,rule=OPERATIONS.uto;
  if (!u||!rule||!unattended('doorClose')) return {ok:false,msg:'没有待办的接管流程'};
  if (tr.v>=.05||tr.doorsOpen||tr.doorsAwait||tr.doorMotion||sim.t<(tr.doorLockedAt??0)) return {ok:false,msg:'须先停稳并完成车门关闭锁紧'};
  if (sim.t<u.until) return {ok:false,msg:`正在${u.detail}`};
  if (nextUtoAction(tr.uto)!==action) return {ok:false,msg:`下一步应为${LABELS[nextUtoAction(tr.uto)!]??'等待'}`};
  if (action==='confirm'&&u.target==='CM'&&!cbtcAvailable(sim,tr)) return {ok:false,msg:'CBTC 不可用，ATPM 模式灯未亮'};
  if (action==='famOn'&&(!cbtcAvailable(sim,tr)||tr.dtoInhibit)) return {ok:false,msg:'CBTC 或全自动功能未恢复'};
  const list=utoActions(u.target),index=list.indexOf(action);
  u.stage=action; u.until=sim.t+(rule.takeoverStepS[index]??rule.takeoverStepS.at(-1)??1);u.detail=LABELS[action];
  tr.dwellUntil=Math.max(tr.dwellUntil,u.until);tr.depReadyAt=Math.max(tr.depReadyAt,u.until);
  sim.log('I','列车',`${tr.vehicle} ${crewLabel()}：${u.detail}`,{train:tr.id});
  return {ok:true,msg:u.detail};
}
function completeControl(sim:Sim,tr:Train,u:UtoControlState):boolean {
  if (u.target==='CM'&&!cbtcAvailable(sim,tr)||u.target==='DTO'&&(!cbtcAvailable(sim,tr)||!!tr.dtoInhibit)) return false;
  if (!setMode(sim,tr,u.target,'CBTC',`${crewLabel()}完成${u.target==='DTO'?'恢复 FAM':'接管'}`)) return false;
  tr.manual=u.target!=='DTO';tr.atoDriver=false;tr.notch=0;tr.reverser=u.retreat?-1:1;
  if (u.target==='DTO') {tr.uto=undefined;return true;}
  u.stage='manual';u.detail=u.target==='CM'?'随车人员 ATPM 驾驶':'随车人员 RM 驾驶';
  u.returnAt=sim.t+(OPERATIONS.uto?.manualDurationS??0);
  return true;
}
/** Same command sequence is used by the player and the simulated attendant. */
export function utoTrainTick(sim:Sim,tr:Train):boolean {
  const rule=OPERATIONS.uto;
  if (!unattended('doorClose')||!rule) return false;
  if(tr.eb&&!['comm','zc'].includes(tr.ebCause))return false;
  let u=tr.uto;
  const available=cbtcAvailable(sim,tr);
  if (!u && tr.v<.05 && !tr.failed && tr.phase!=='stabled') {
    if (LINE.signalling.onLoss==='restrictedManual'&&!available) {
      if(tr.eb&&!releaseForRestrictedManual(sim,tr).ok)return true;
      sim.command({c:'manual',train:tr.id,mode:'RM',computer:true},crewLabel());u=tr.uto;if(u)u.reason='signalLoss';
    } else if(tr.dtoInhibit==='车载全自动功能故障') {sim.command({c:'manual',train:tr.id,mode:'CM',computer:true},crewLabel());u=tr.uto;if(u)u.reason='fault';}
    else if(!tr.manual&&!tr.atoDriver&&tr.phase==='dwell'&&randomTakeoverDue(sim,tr)) {
      if(sim.command({c:'manual',train:tr.id,mode:'CM',computer:true},crewLabel()).ok){
        u=tr.uto;if(u)u.reason='random';
        const vehicle=sim.vehicles.get(tr.vehicle)?.uto;if(vehicle)vehicle.lastTakeoverDay=takeoverDay(sim);
      }
    }
  }
  if (!u) return false;
  if(u.stage!=='manual'&&u.stage!=='reset'&&!available&&u.target!=='RM'&&tr.v<.05) {
    u.target='RM';u.stage='doors';u.until=sim.t;u.reason='signalLoss';u.detail='CBTC 不可用，改办 RM 接管';
  }
  if(u.target==='DTO'&&tr.dtoInhibit){u.target='CM';u.stage='manual';u.detail='全自动功能不可用，继续 ATPM 驾驶';return true;}
  if(u.stage==='reset') {
    if(sim.t<u.until)return true;
    if(u.resetSuccess) {
      tr.dtoInhibit='';sim.clearAlarm(`uto-${tr.id}`);
      sim.log('I','列车',`${tr.vehicle} 全自动功能远程复位成功`,{train:tr.id});
      for(const fault of sim.faults)if(fault.kind==='trainUto'&&fault.target===tr.id&&!fault.repaired){fault.repaired=true;fault.repairAt=sim.t;}
      u.stage='manual';u.detail='远程复位成功，等待停站恢复 FAM';u.returnAt=sim.t;
    } else {sim.log('B','列车',`${tr.vehicle} 全自动功能远程复位失败，终点退出服务`,{train:tr.id});u.stage='manual';u.detail='远程复位失败，终点退出服务';tr.withdrawAtEnd=true;u.returnAt=Infinity;}
    return true;
  }
  if(u.stage==='manual') {
    if(u.target==='CM'&&!available&&tr.v<.05) {
      if(tr.eb&&!releaseForRestrictedManual(sim,tr).ok)return true;
      sim.command({c:'manual',train:tr.id,mode:'RM',computer:u.computer},crewLabel());
      if(tr.uto)tr.uto.reason='signalLoss';
      return true;
    }
    // Dispatch may grant this already staffed cab a bounded RM sweep. Its
    // original protected target stays CM; expiry does not restore faulty FAM.
    if(computerCrew(tr)&&u.target==='CM'&&tr.mode==='RM'&&tr.rmAuth<=0&&!u.retreat&&available) {
      if(setMode(sim,tr,'CM',tr.level,'RM压道结束，恢复 ATPM'))u.detail='随车人员 ATPM 驾驶';
    }
    if(u.reason==='signalLoss'&&available)u.returnAt=sim.t;
    if(u.computer)attendantDoors(sim,tr);
    if(u.retreat) {
      if(tr.phase==='dwell') {u.retreat=false;tr.reverser=1;u.returnAt=sim.t;}
      return true;
    }
    if(u.computer&&tr.v<.05&&available&&!tr.dtoInhibit&&sim.t>=(u.returnAt??Infinity)) sim.command({c:'manual',train:tr.id,mode:'AUTO',computer:true},crewLabel());
    return true;
  }
  if (tr.v>=.05) return true;
  // Simulated attendants operate the existing guarded door mechanism.
  // A manual arrival has no automatic opening timer. Complete its pending
  // passenger door cycle before this same attendant can close and change modes.
  if(u.stage==='doors') {
    u.detail=tr.doorsAwait?'等待开门办理本站客运':'等待车门关闭并锁紧';
    if(u.computer&&tr.manual&&tr.doorsAwait)attendantDoors(sim,tr);
  }
  if(u.computer&&u.stage==='doors'&&tr.doorsOpen&&!tr.doorMotion&&sim.t>=(u.closeAt??0)) {
    const task=tr.tasks[0];if(task?.k==='stop')sim.command({c:'door',train:tr.id,side:platformSide(sim,tr,sim.topo.berths[task.berth].platform)},crewLabel());
  }
  if (tr.doorsOpen||tr.doorsAwait||tr.doorMotion||sim.t<(tr.doorLockedAt??0)||sim.t<u.until)return true;
  const next=nextUtoAction(tr.uto);
  if(!next)completeControl(sim,tr,u);
  else if(u.computer)sim.command({c:'utoStep',train:tr.id,action:next},crewLabel());
  return true;
}
/** Daily sample comes from an isolated seed, so capability=false consumes no RNG. */
function randomTakeoverDue(sim:Sim,tr:Train):boolean {
  const rule=OPERATIONS.uto!;
  const date=Number((sim.config.date??'').replaceAll('-',''));
  let seed=(sim.config.seed^date)>>>0;
  const vehicles=[...sim.vehicles.keys()].sort();
  for(let i=vehicles.length-1;i>0;i--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[vehicles[i],vehicles[j]]=[vehicles[j],vehicles[i]];}
  const index=vehicles.slice(0,rule.randomTakeoversPerDay).indexOf(tr.vehicle);
  const vehicle=sim.vehicles.get(tr.vehicle)?.uto;
  if(index<0||!vehicle||sim.t<rule.randomTakeoverFromS+index*rule.randomTakeoverSpacingS||vehicle.lastTakeoverDay===takeoverDay(sim))return false;
  return true;
}
export function startUtoReset(sim:Sim,tr:Train) {
  const rule=OPERATIONS.uto;
  if(!rule||tr.dtoInhibit!=='车载全自动功能故障'||tr.v>=.05||tr.uto?.stage!=='manual')return {ok:false,msg:'须在全自动故障列车停稳、接管完成后复位'};
  tr.uto={target:'CM',computer:tr.uto?.computer??!tr.manual,stage:'reset',detail:'等待 OCC 远程复位',until:sim.t+rule.resetS,resetSuccess:sim.rng()<rule.resetSuccess};
  return {ok:true,msg:`开始远程复位，预计 ${rule.resetS} 秒`};
}
function attendantDoors(sim:Sim,tr:Train) {
  if(tr.phase!=='dwell'||tr.doorMotion||tr.v>=.05)return;
  const task=tr.tasks[0];if(task?.k!=='stop')return;
  const side=platformSide(sim,tr,sim.topo.berths[task.berth].platform);
  if(tr.doorsAwait||tr.doorsOpen&&sim.t>=tr.dwellUntil-DOOR_CLOSE_S)
    sim.command({c:'door',train:tr.id,side},crewLabel());
}
/** A simulated attendant uses the same master controller and protection as a player.
 * The existing onboard target is advisory; this deterministic driver supplies notches. */
export function utoAttendantEffort(tr:Train) {
  if(!tr.uto?.computer||tr.uto.stage!=='manual'||!tr.manual||tr.uto.retreat)return;
  if(tr.phase!=='run'||tr.eb||tr.doorsOpen||tr.doorMotion){tr.notch=-7;return;}
  const remaining=Math.max(0,Math.min(tr.stopDist,tr.maDist)-.5);
  const ceiling=Math.max(0,tr.vPermit-.4);
  const target=remaining<.8?0:Math.min(tr.vRecommended??tr.vTarget,ceiling,Math.sqrt(.6*remaining));
  const error=target-tr.v;
  tr.notch=target<.04?-7:error<-.12?Math.max(-7,Math.floor(error*3)):error>.15?Math.min(4,Math.ceil(error*2)):0;
}
/** Uses the existing retreat path and permission check, never changes a route. */
export function utoRetreatEffort(sim:Sim,tr:Train) {
  if(!tr.uto?.retreat||!tr.uto.computer||tr.uto.stage!=='manual'||tr.mode!=='RM')return;
  const remaining=Math.max(0,-stopError(sim,tr)), atTarget=remaining<.2;
  // Once stopped at the controller's existing target, let manualArrival
  // accept the mark. Requesting another reverse step would recheck a return
  // footprint after the car is already back and can create a false overrun.
  if(atTarget&&tr.v<.05){tr.reverser=1;tr.notch=-7;return;}
  tr.reverser=-1;
  tr.notch=atTarget?-7:tr.v>Math.min(OPERATIONS.reverseKmh/3.6-.2,Math.sqrt(remaining*.7))?-4:2;
}
export function utoDoorWarningReady(sim:Sim,tr:Train):boolean {
  if(!unattended('doorClose')||!OPERATIONS.uto||tr.mode!=='DTO')return true;
  if(tr.utoDoorWarningAt===undefined) {
    tr.utoDoorWarningAt=sim.t;sim.log('I','列车',`${tr.vehicle} 自动关门预告`,{train:tr.id});
  }
  return sim.t>=tr.utoDoorWarningAt+OPERATIONS.uto.doorWarningS;
}
export function beginUtoReturn(sim:Sim,vehicle:string) {
  const r=sim.vehicles.get(vehicle);if(!r||!unattended('wakeSleep')||!OPERATIONS.uto)return;
  const cycles=(r.uto?.cycles??0)+1;
  r.uto={...r.uto,stage:'clear',until:sim.t+OPERATIONS.uto.clearS,cycles};
}
export function utoFleetTick(sim:Sim) {
  const rule=OPERATIONS.uto;if(!unattended('wakeSleep')||!rule)return;
  // One timetable query per 1 Hz fleet tick; each vehicle then checks only its depot.
  const nextExit=sim.topo.depots.map(()=>Infinity);
  for(const move of depotMoves(sim.plan.blocks.filter(b=>b.train===undefined&&!sim.blockDone.has(b.id)),sim.plan.trips))
    // An overdue unexecuted departure still needs a ready vehicle; only the
    // completed/assigned block filter above may remove its wake-up demand.
    if(move.delta<0)nextExit[move.depot]=Math.min(nextExit[move.depot],move.time);
  for(const [vehicle,r]of sim.vehicles) {
    if(!r.uto){if(!r.work)r.depot=sim.yards.findIndex(y=>y.tracks.some(t=>t.includes(vehicle)));r.uto={stage:'sleep',until:0,cycles:0};}
    const u=r.uto;
    if(r.work)continue;
    if(u.stage==='clear'&&sim.t>=u.until) {u.stage=r.depot>=0&&rule.washEvery>0&&u.cycles%rule.washEvery===0?'wash':'sleep';u.until=sim.t+(u.stage==='wash'?rule.washS:0);}
    if(u.stage==='wash'&&sim.t>=u.until){u.stage='sleep';u.until=0;}
    if(r.depot<0)continue;
    const due=nextExit[r.depot]-sim.t<=rule.wakeLeadS;
    if(u.stage==='sleep'&&due){u.stage='power';u.until=sim.t+rule.powerS;}
    else if(u.stage==='power'&&sim.t>=u.until){u.stage='pantograph';u.until=sim.t+rule.pantographS;}
    else if(u.stage==='pantograph'&&sim.t>=u.until){u.stage='selfTest';u.until=sim.t+rule.selfTestS;}
    else if(u.stage==='selfTest'&&sim.t>=u.until){u.stage='ready';u.until=0;}
  }
  for(const tr of sim.trainList) {
    const r=sim.vehicles.get(tr.vehicle);if(!r||!r.uto||r.uto.stage==='ready')continue;
    if(r.depot>=0)continue;
    const u=r.uto;
    if(u.stage==='sleep'){
      const trips=sim.plan.blocks[tr.block]?.trips.map(id=>sim.plan.trips[id])
        .filter(trip=>trip&&!trip.cancelled&&!trip.completed)??[];
      const active=new Set(trips.map(trip=>trip.id));
      const stops=tr.tasks.filter((t):t is StopTask=>t.k==='stop'&&(t.trip<0||active.has(t.trip)));
      // Wake and release share the same clock, including a dep=null feeder.
      // The lookup also keeps a live intermediate hold's own departure.
      const departure=stops.map(task=>sourceDepartureAt(sim,task,tr)).find(at=>at!==null&&Number.isFinite(at));
      if(departure==null||!Number.isFinite(departure)||departure-sim.t>rule.wakeLeadS)continue;
      u.stage='power';u.until=sim.t+rule.powerS;
    }
    else if(u.stage==='power'&&sim.t>=u.until){u.stage='pantograph';u.until=sim.t+rule.pantographS;}
    else if(u.stage==='pantograph'&&sim.t>=u.until){u.stage='selfTest';u.until=sim.t+rule.selfTestS;}
    else if(u.stage==='selfTest'&&sim.t>=u.until){u.stage='ready';u.until=0;}
  }
}
export function utoVehicleWait(sim:Sim,tr:Train):string {
  if(!unattended('wakeSleep'))return '';
  const stage=sim.vehicles.get(tr.vehicle)?.uto?.stage;
  return stage&&stage!=='ready'?({sleep:'休眠',power:'唤醒上电',pantograph:'升弓',selfTest:'自检',clear:'清客确认',wash:'自动洗车'})[stage]:'';
}

/** ATS displays actual capability-selected vehicle work, including automatic depot moves. */
export function utoStatus(sim:Sim,tr:Train):string {
  const waiting=utoVehicleWait(sim,tr);if(waiting)return waiting;
  if(tr.uto)return tr.uto.detail;
  if(unattended('depotMoves')&&tr.mode==='DTO') {
    if(tr.depotStage==='out')return 'FAM 自动出段';
    if(tr.depotStage==='in')return 'FAM 自动入段';
  }
  return '';
}
