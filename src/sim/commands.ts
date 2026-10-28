/** Validate the whole dispatcher command before any state is changed. */
import type { Sim } from './engine';
import type { Command } from './model';
import { FAULT_LABELS, SURGE_MAX } from './faults';
import { WEATHER_RULES } from '../data/current';

// Exhaustive against Command: missing a discriminator is a compile error.
const COMMANDS: Record<Command['c'], true> = {
  setRoute: true, cancelRoute: true, guideRoute: true, autoPass: true, ars: true, switchMove: true,
  switchLock: true, switchFieldLock: true, axleReset: true, sectionUnlock: true, setTsr: true, cancelTsr: true,
  platformHold: true, platformSkip: true, platformEsp: true, psdBypass: true, trainHold: true, trainSkip: true,
  turnback: true, withdraw: true, recoverService: true, exchangeDuty: true, standby: true, authRM: true,
  utoStep:true, utoReset:true, dmiAck:true,
  ebRelease: true, trainLevel: true, trainDto: true, lineAto: true, door: true, reverser: true, atoButton: true, rescue: true,
  addTrain: true, overlay: true, zoneLevel: true, ack: true, fault: true, repair: true,
  trainMaintenance: true, sectionBlock: true, switchBlock: true, manual: true, radio: true, radioAuto: true,
  env: true, runLevel: true, randomFaults: true, scenarioEnd: true, bookmark: true, lowAdhesion: true,
};

export function validateCommand(sim: Sim, cmd: Command): string | null {
  if (!cmd || typeof cmd !== 'object' || !Object.hasOwn(COMMANDS, cmd.c)) return '无效调度命令';
  const c = cmd as unknown as Record<string, unknown>;
  const required: Record<string, string[]> = {
    setRoute: ['route'], cancelRoute: ['signal'], guideRoute: ['route'], autoPass: ['signal', 'on'], ars: ['signal', 'on'],
    switchMove: ['sw', 'pos'], switchLock: ['sw', 'on'], switchFieldLock: ['sw', 'on'], axleReset: ['section'], sectionUnlock: ['section'],
    setTsr: ['sections', 'kmh'], cancelTsr: ['sections'], platformHold: ['platform', 'on'], platformSkip: ['platform', 'on'],
    platformEsp: ['platform', 'on'], psdBypass: ['platform', 'on'], trainHold: ['train', 'on'], trainSkip: ['train', 'station', 'on'],
    turnback: ['train', 'station'], withdraw: ['train'], recoverService: ['train'], exchangeDuty: ['train', 'with'], standby: ['train'], authRM: ['train'], ebRelease: ['train'], trainLevel: ['train', 'level'],
    reverser: ['train', 'position'], atoButton: ['train', 'button', 'down'],
    utoStep:['train','action'], utoReset:['train'], dmiAck:['train','message','at'],
    trainDto: ['train', 'on'], lineAto: ['on'], door: ['train', 'side'],
    rescue: ['failed', 'rescuer'], addTrain: ['depot', 'dir', 'to', 'time'], overlay: ['id', 'from', 'to', 'headway'],
    zoneLevel: ['zones', 'level'], ack: ['ids'], fault: ['kind', 'target', 'duration'], repair: ['fault'], trainMaintenance: ['fault'],
    sectionBlock: ['sections', 'on'], switchBlock: ['sw', 'on'], manual: ['train', 'mode'], radio: ['call', 'option'],
    radioAuto: ['on'], env: ['duration'], lowAdhesion: ['on'], runLevel: ['level'], randomFaults: ['level'], bookmark: ['label'],
  };
  for (const field of required[cmd.c] ?? []) if (!(field in c)) return `命令缺少参数：${field}`;
  for (const field of ['id', 'option', 'label', 'reason']) if (field in c && (typeof c[field] !== 'string' || !(c[field] as string).trim())) return `无效文本：${field}`;
  for (const field of ['rain', 'recoverable','computer']) if (field in c && typeof c[field] !== 'boolean') return `无效布尔值：${field}`;
  if ((cmd.c === 'repair' || cmd.c === 'trainMaintenance') && !sim.faults.some(f => f.id === cmd.fault)) return '故障不存在';
  if (cmd.c === 'radio' && !sim.calls.some(call => call.id === cmd.call)) return '来电不存在';
  if (cmd.c === 'ack' && (!Array.isArray(cmd.ids) || cmd.ids.some(id => !Number.isInteger(id) || id < 0))) return '无效报警列表';
  const validId = (id: unknown, n: number) => Number.isInteger(id) && (id as number) >= 0 && (id as number) < n;
  const limits: Record<string, number> = {
    route: sim.topo.routes.length, signal: sim.sig.length, sw: sim.sw.length,
    section: sim.sec.length, platform: sim.plat.length, station: sim.topo.stations.length,
    depot: sim.topo.depots.length,
  };
  for (const [field, n] of Object.entries(limits)) if (field in c && !validId(c[field], n)) return `无效对象：${field}`;
  if ('train' in c && !sim.trains.has(c.train as number)) return '列车不存在';
  if (cmd.c === 'rescue' && (!sim.trains.has(cmd.failed) || !sim.trains.has(cmd.rescuer) || cmd.failed === cmd.rescuer)) return '无效救援列车';
  for (const [field, n] of [['sections', sim.sec.length], ['zones', sim.zoneState.length]] as const) {
    if (!(field in c)) continue;
    const ids = c[field];
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !validId(id, n))) return `无效对象列表：${field}`;
  }
  if ('on' in c && typeof c.on !== 'boolean') return '开关值须为布尔值';
  for (const key of ['time', 'from', 'to', 'headway', 'duration', 'kmh', 'wind', 'param']) {
    if (key in c && (typeof c[key] !== 'number' || !Number.isFinite(c[key]))) return `无效数值：${key}`;
  }
  if ('duration' in c && (c.duration as number) < 0) return '故障/环境持续时间不得为负';
  if (cmd.c === 'switchMove' && !['N', 'R'].includes(cmd.pos)) return '无效道岔位置';
  if (cmd.c === 'trainLevel' && !['AUTO', 'CBTC', 'TBTC'].includes(cmd.level)) return '无效列车级别';
  if (cmd.c === 'zoneLevel') {
    if (!['CBTC', 'TBTC'].includes(cmd.level)) return '无效区域级别';
    if (cmd.level === 'CBTC' && sim.faults.some(f => f.kind === 'zcFail' && !f.repaired && (f.target < 0 || cmd.zones.includes(f.target)))) return 'ZC 故障未修复，不能恢复CBTC';
  }
  if (cmd.c === 'sectionBlock' && !cmd.on && cmd.sections.some(s => sim.sec[s].poss >= 0)) return '施工封锁须施工销点后解封';
  if (cmd.c === 'manual' && !['CM', 'RM', 'AM', 'AUTO'].includes(cmd.mode)) return '无效驾驶模式';
  if(cmd.c==='utoStep'&&!['report','key','famOff','brake','confirm','restoreReport','neutral','famOn'].includes(cmd.action))return '无效接管步骤';
  if(cmd.c==='dmiAck'&&(typeof cmd.message!=='string'||!Number.isFinite(cmd.at)))return '无效车载告警';
  if (cmd.c === 'reverser' && ![-1, 0, 1].includes(cmd.position)) return '无效换向器位置';
  if (cmd.c === 'atoButton' && (!['f', 'g'].includes(cmd.button) || typeof cmd.down !== 'boolean')) return '无效ATO启动按钮';
  if (cmd.c === 'door' && !['L', 'R'].includes(cmd.side)) return '无效车门侧';
  if (cmd.c === 'randomFaults' && ![0, 1, 2, 3].includes(cmd.level)) return '故障等级须为0–3';
  if (cmd.c === 'runLevel' && ![0, 1, 2, 3].includes(cmd.level)) return '运行等级须为按图(0)或1–3';
  if (cmd.c === 'env' && cmd.wind !== undefined && cmd.wind !== 0 && !WEATHER_RULES.wind.some(rule => rule.level === cmd.wind)) return '无效大风等级';
  if (cmd.c === 'addTrain' && !['DN', 'UP'].includes(cmd.dir)) return '无效行车方向';
  if (cmd.c === 'addTrain' && !validId(cmd.to, sim.topo.stations.length)) return '无效终到站';
  if (cmd.c === 'overlay' && (cmd.to <= cmd.from || cmd.headway < 90 || cmd.to > 27.5 * 3600)) return '无效加开时段或间隔';
  if (cmd.c === 'fault') {
    if (!(cmd.kind in FAULT_LABELS)) return '无效故障类型';
    if (cmd.kind === 'surge' && cmd.param !== undefined && (cmd.param < 1 || cmd.param > SURGE_MAX)) return `客流倍数须在 1–${SURGE_MAX} 之间`;
    if (['trainComm', 'trainUto', 'trainDto', 'trainFail', 'traction', 'door', 'brake', 'pecu'].includes(cmd.kind)) {
      if (!sim.trains.has(cmd.target)) return '列车不存在';
    } else {
      const n = cmd.kind === 'zcFail' ? sim.zoneState.length : cmd.kind === 'switch' ? sim.sw.length
        : cmd.kind === 'signal' ? sim.sig.length : cmd.kind === 'axle' ? sim.sec.length
          : cmd.kind === 'surge' ? sim.topo.stations.length : sim.plat.length;
      if (!(cmd.kind === 'zcFail' && cmd.target === -1) && !validId(cmd.target, n)) return '无效故障对象';
    }
  }
  return null;
}
