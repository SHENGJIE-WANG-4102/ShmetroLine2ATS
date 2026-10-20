/**
 * Instructor / scenario mode: preset training scenarios, random fault
 * injection by difficulty, run metrics and the scored end-of-run report.
 */
import type { Sim } from './engine';
import type { DayType, Metrics, ScenarioReport, Train, Plan } from './model';
import { STATIONS, LINE_INFO, HQ_LATE_RUN, OPERATIONS, type FixedRun } from '../data/line2';
import { closeStation } from './holiday';
import { injectFault } from './faults';
import { setWeather, addPossession } from './env';
import { callPecu, callTrackPerson } from './radio';
import { dayRandom, OPERATING_DAY } from './dayRandom';

export interface InstructorScheduleEntry { event: string; at: number; step?: number }
export interface InstructorOccurrence extends InstructorScheduleEntry {
  result: string; faults: number[]; calls: number[]; possessions: number[]; weatherUntil: number;
}
/** Migrate the previous checkbox IDs once, including merged sequences. */
const PREVIOUS_EVENT_IDS: Record<string,string> = {
  "lyl-insert-1": "longyang-depot-exit-switch-failure",
  "lyl-insert-2": "century-avenue-morning-crowd",
  "lyl-insert-3": "longyang-morning-crowd",
  "shr-switch-1": "songhong-turnback-switch-failure",
  "rmg-surge-1": "peoples-square-evening-crowd",
  "rmg-surge-2": "peoples-square-train-pecu",
  "cbtc-tbtc-1": "zc2-failure",
  "rescue-1": "jingansi-nanjingwest-train-failure",
  "dawn-poss-1": "jingansi-possession-extension",
  "dawn-poss-2": "first-westbound-train-failure",
  "gll-loop-1": "guanglan-middle-switch-failure",
  "hq-night-1": "hongqiao-railway-evening-crowd",
  "hq-night-2": "hongqiao-terminal2-evening-crowd",
  "hq-night-3": "hongqiao-railway-down-psd-failure",
  "ciie-close-1": "exhibition-centre-closing-crowd",
  "ciie-close-2": "exhibition-centre-train-pecu",
  "ciie-close-3": "hongqiao-railway-down-start-signal-failure",
  "ljz-person-1": "lujiazui-down-track-intrusion",
  "ljz-person-2": "lujiazui-pudongsouth-axle-disturbance",
  "river-tunnel-1": "river-tunnel-westbound-train-failure",
  "holiday-return-1": "hongqiao-railway-return-crowd",
  "holiday-return-2": "pudong-airport-return-crowd",
  "holiday-return-3": "hongqiao-terminal2-return-crowd",
  "holiday-return-4": "hongqiao-terminal2-down-psd-failure",
  "holiday-return-5": "extra-train-pecu",
  "njd-closure-3": "peoples-square-diverted-crowd",
  "njd-closure-4": "lujiazui-diverted-crowd",
  "storm-1": "severe-wind-sequence",
  "storm-2": "severe-wind-sequence",
  "storm-3": "severe-wind-sequence",
  "storm-4": "severe-wind-sequence",
  "njd-closure-1": "nanjing-east-closure-sequence",
  "njd-closure-2": "nanjing-east-closure-sequence",
  "njd-closure-5": "nanjing-east-closure-sequence"
};
export function instructorEventIds(ids:readonly string[]):string[] {
  return [...new Set(ids.map(id=>PREVIOUS_EVENT_IDS[id]??id))];
}

/** Separate per-event streams also make checkbox order irrelevant. */
export function scheduleInstructorEvents(seed: number, start: number, selected: readonly string[], library = INSTRUCTOR_EVENTS): InstructorScheduleEntry[] {
  const out: InstructorScheduleEntry[] = [];
  const ids = new Set(instructorEventIds(selected));
  for (const ev of library) {
    if (!ids.has(ev.id)) continue;
    let hash = 2166136261;
    for (const ch of ev.id) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
    const rng = dayRandom(seed, hash ^ 0x1e7e2026);
    if (rng() >= ev.probability) continue;
    const span=Math.max(0,...(ev.steps??[]).map(step=>step.after));
    const windows = ev.windows.map(([a,b]) => [Math.max(a,start,OPERATING_DAY.from),Math.min(b,OPERATING_DAY.to-span)])
      .filter(([a,b]) => b > a);
    const total = windows.reduce((n,[a,b]) => n+b-a,0);
    if (!total) continue;
    let offset = rng()*total;
    for (const [a,b] of windows) {
      if (offset < b-a) {
        const at=a+offset;
        out.push({event:ev.id,at});
        ev.steps?.forEach((step,index)=>out.push({event:ev.id,at:at+step.after,step:index+1}));
        break;
      }
      offset -= b-a;
    }
  }
  return out.sort((a,b) => a.at-b.at || a.event.localeCompare(b.event) || (a.step??0)-(b.step??0));
}

function instructorTick(sim: Sim) {
  while (sim.instructorFired < sim.instructorSchedule.length && sim.t >= sim.instructorSchedule[sim.instructorFired].at) {
    const entry = sim.instructorSchedule[sim.instructorFired++];
    const ev = INSTRUCTOR_EVENTS.find(e=>e.id===entry.event);
    if (!ev) continue;
    const faults = new Set(sim.faults.map(f=>f.id)), calls = new Set(sim.calls.map(c=>c.id)), possessions = new Set(sim.possessions.map(p=>p.id));
    const weather = {...sim.env};
    const action=entry.step?ev.steps?.[entry.step-1]:ev;
    if(!action)continue;
    const result = action.run(sim) ?? '';
    sim.instructorOccurred.push({...entry,result,faults:sim.faults.filter(f=>!faults.has(f.id)).map(f=>f.id),
      calls:sim.calls.filter(c=>!calls.has(c.id)).map(c=>c.id),possessions:sim.possessions.filter(p=>!possessions.has(p.id)).map(p=>p.id),
      weatherUntil:Math.max(weather.windUntil!==sim.env.windUntil?sim.env.windUntil:0,weather.rainUntil!==sim.env.rainUntil?sim.env.rainUntil:0)});
    const label=entry.step?`${ev.name}：${action.name}`:ev.name;
    sim.log('B','教员',`教员事件：${label}${result?`（${result}）`:''}`);
    sim.bookmark(label,true);
  }
  if (sim.config.instructorEvents?.length && !sim.dailyEvaluationEnded && sim.t >= OPERATING_DAY.to) endScenario(sim);
}

export interface ScenarioDef {
  id: string;
  name: string;
  desc: string;
  objectives: string[];
  dayType: DayType;
  /** start time (s since midnight) */
  start: number;
  duration: number;
  events: { at: number; event: string; step?: number }[];
  /** the day's fixed-time special trains, in place of the regular ones */
  fixedRuns?: FixedRun[];
}

const H = (h: number, m = 0) => h * 3600 + m * 60;

function stationIdx(id: string) {
  return STATIONS.findIndex((s) => s.id === id);
}

/** a switch at a station by kind/position predicate */
function findSwitch(sim: Sim, station: number, pred: (sw: number) => boolean): number {
  const list = sim.topo.switches.filter((s) => s.station === station).map((s) => s.id);
  return list.find(pred) ?? list[0];
}

/** in-service train running in a chainage window in a direction */
function trainIn(sim: Sim, from: number, to: number, east: boolean): Train | undefined {
  const cand = sim.trainList.filter((tr) => {
    if (!tr.inService || tr.failed || tr.phase === 'stabled') return false;
    const l = sim.topo.links[tr.link];
    const e = tr.dir === 1 ? l.chainB >= l.chainA : l.chainA > l.chainB;
    const ch = sim.trainChain(tr);
    return e === east && ch >= from && ch <= to;
  });
  return cand.sort((a, b) => (east ? sim.trainChain(b) - sim.trainChain(a) : sim.trainChain(a) - sim.trainChain(b)))[0];
}

/** a switch by its name (e.g. P2305), else the first switch at the station */
function switchNamed(sim: Sim, name: string, station: number): number {
  return sim.topo.switches.find((s) => s.name === name)?.id ?? findSwitch(sim, station, () => true);
}

const chainOf = (sim: Sim, id: string) => sim.topo.stations[stationIdx(id)].chain;

/** a fixed-time special train (加班车) running between stations */
function extraTrain(sim: Sim, pred: (tr: Train) => boolean = () => true): Train | undefined {
  return sim.trainList.find((tr) => tr.inService && !tr.failed && tr.phase !== 'dwell' && tr.tripId >= 0
    && sim.plan.trips[tr.tripId]?.kind === 'extra' && pred(tr));
}

const stationClosed = (sim: Sim, id: string) => {
  const st = sim.topo.stations[stationIdx(id)];
  return sim.plat[st.platforms.DN].skip && sim.plat[st.platforms.UP].skip;
};

export interface InstructorStep {after:number;name:string;run:(sim:Sim)=>string|void}
export interface InstructorEvent {id:string;name:string;category:string;windows:[number,number][];probability:number;run:(sim:Sim)=>string|void;steps?:InstructorStep[]}
/** 【假设】初始概率统一为 0.5；可发生时段按事件性质给定，可逐项调整。 */
export const INSTRUCTOR_EVENTS: InstructorEvent[] = [
  {id:"longyang-depot-exit-switch-failure",name:"龙阳路车辆段出段道岔失表",category:"设备故障",windows:[[25200,79200]],probability:.5,run:(sim) => {
          const dp = sim.topo.depots.find((d) => d.key === 'LYD')!;
          // the exit lead's main-line turnout
          const lead = dp.transferPaths.find((p) => p.flow === 'out') ?? dp.transferPaths[0];
          const stub = sim.topo.nodes[lead.throat].links.find((l) => sim.topo.links[l].track === 'SID')!;
          const start = sim.topo.links[stub].chainA;
          const sw = findSwitch(sim, dp.station, (id) => sim.topo.switches[id].kind === 'depot'
            && sim.topo.switches[id].nodes.some((n) => Math.abs(sim.topo.nodes[n].chain - start) < 60));
          injectFault(sim, 'switch', sw, 18 * 60);
        }},
  {id:"century-avenue-morning-crowd",name:"世纪大道大客流",category:"客流",windows:[[23400,34200]],probability:.5,run:(sim) => { injectFault(sim, 'surge', stationIdx('SJD'), 30 * 60, 3); }},
  {id:"longyang-morning-crowd",name:"龙阳路大客流",category:"客流",windows:[[23400,34200]],probability:.5,run:(sim) => { injectFault(sim, 'surge', stationIdx('LYL'), 25 * 60, 2.5); }},
  {id:"songhong-turnback-switch-failure",name:"淞虹路折返线道岔失表",category:"设备故障",windows:[[25200,79200]],probability:.5,run:(sim) => {
          const st = stationIdx('SHR');
          // the merging turnout in front of 1道 (its toe is the start of the track)
          const { topo } = sim;
          const sw = findSwitch(sim, st, (id) => topo.switches[id].kind === 'siding' && topo.switches[id].nodes.length === 1
            && topo.links[topo.nodes[topo.switches[id].nodes[0]].toe!].track === 'SID');
          injectFault(sim, 'switch', sw, 25 * 60);
        }},
  {id:"peoples-square-evening-crowd",name:"人民广场大客流（×5）",category:"客流",windows:[[57600,70200]],probability:.5,run:(sim) => { injectFault(sim, 'surge', stationIdx('RMG'), 35 * 60, 5); }},
  {id:"peoples-square-train-pecu",name:"列车乘客紧急报警",category:"列车故障",windows:[[25200,79200]],probability:.5,run:(sim) => {
          const c = sim.topo.stations[stationIdx('RMG')].chain;
          const tr = trainIn(sim, c - 3000, c - 300, true) ?? trainIn(sim, c - 6000, c, true);
          if (tr) callPecu(sim, tr);
        }},
  {id:"zc2-failure",name:"ZC2 故障",category:"设备故障",windows:[[25200,79200]],probability:.5,run:(sim) => { injectFault(sim, 'zcFail', 1, 25 * 60); }},
  {id:"jingansi-nanjingwest-train-failure",name:"静安寺—南京西路列车故障",category:"列车故障",windows:[[25200,79200]],probability:.5,run:(sim) => {
          const a = sim.topo.stations[stationIdx('JAS')].chain;
          const b = sim.topo.stations[stationIdx('NJX')].chain;
          const tr = trainIn(sim, a + 150, b - 150, true) ?? trainIn(sim, a - 2500, b - 150, true);
          if (!tr) return '未找到合适列车';
          injectFault(sim, 'trainFail', tr.id, 0, undefined, false);
        }},
  {id:"severe-wind-sequence",name:"雷暴大风过程",category:"天气",windows:[[14400,99900]],probability:.5,
    run:sim=>{setWeather(sim,{wind:2,duration:40*60});},steps:[
      {after:6*60,name:'暴雨',run:sim=>{setWeather(sim,{rain:true,duration:30*60});}},
      {after:13*60,name:'阵风≥10级，高架段停运',run:sim=>{setWeather(sim,{wind:4,duration:12*60});}},
      {after:25*60,name:'风力减弱（黄色）',run:sim=>{setWeather(sim,{wind:2,duration:15*60});}},
    ]},
  {id:"jingansi-possession-extension",name:"静安寺—南京西路施工延时销点",category:"施工",windows:[[16200,18360]],probability:.5,run:(sim) => {
          const p = addPossession(sim, stationIdx('JAS'), H(5, 50));
          sim.log('B', '施工', `${p.name} 施工负责人报告：作业未完，申请延时至 05:50 销点`);
        }},
  {id:"first-westbound-train-failure",name:"上行首班车故障",category:"列车故障",windows:[[20520,22500]],probability:.5,run:(sim) => {
          const tr = trainIn(sim, chainOf(sim, 'KJG') - 600, chainOf(sim, 'LYL') + 300, false) ?? trainIn(sim, chainOf(sim, 'RMG'), chainOf(sim, 'GLL'), false);
          if (!tr) return '未找到合适列车';
          injectFault(sim, 'trainFail', tr.id, 300, undefined, true);
        }},
  {id:"guanglan-middle-switch-failure",name:"广兰路中间线道岔P2305失表",category:"设备故障",windows:[[25200,79200]],probability:.5,run:(sim) => { injectFault(sim, 'switch', switchNamed(sim, 'P2305', stationIdx('GLL')), 25 * 60); }},
  {id:"hongqiao-railway-evening-crowd",name:"虹桥火车站大客流（×4）",category:"客流",windows:[[57600,70200]],probability:.5,run:(sim) => { injectFault(sim, 'surge', stationIdx('HQZ'), 40 * 60, 4); }},
  {id:"hongqiao-terminal2-evening-crowd",name:"虹桥2号航站楼大客流（×3）",category:"客流",windows:[[57600,70200]],probability:.5,run:(sim) => { injectFault(sim, 'surge', stationIdx('HQ2'), 35 * 60, 3); }},
  {id:"hongqiao-railway-down-psd-failure",name:"虹桥火车站下行站台门故障",category:"设备故障",windows:[[25200,79200]],probability:.5,run:(sim) => { injectFault(sim, 'psd', sim.topo.stations[stationIdx('HQZ')].platforms.DN, 15 * 60); }},
  {id:"exhibition-centre-closing-crowd",name:"国家会展中心散场客流（×6）",category:"客流",windows:[[57600,70200]],probability:.5,run:(sim) => { injectFault(sim, 'surge', stationIdx('GJH'), 40 * 60, 6); }},
  {id:"exhibition-centre-train-pecu",name:"下行列车乘客紧急报警",category:"列车故障",windows:[[25200,79200]],probability:.5,run:(sim) => {
          const tr = trainIn(sim, chainOf(sim, 'GJH') + 200, chainOf(sim, 'SHR'), true);
          if (!tr) return '未找到合适列车';
          callPecu(sim, tr);
        }},
  {id:"hongqiao-railway-down-start-signal-failure",name:"虹桥火车站下行出站信号机故障",category:"设备故障",windows:[[25200,79200]],probability:.5,run:(sim) => {
          const st = stationIdx('HQZ');
          const sig = sim.topo.signals.find((x) => x.role === 'start' && x.station === st && sim.topo.links[x.link].track === 'DN');
          if (!sig) return '未找到信号机';
          injectFault(sim, 'signal', sig.id, 15 * 60);
        }},
  {id:"lujiazui-down-track-intrusion",name:"陆家嘴下行站台人员侵入",category:"设备故障",windows:[[25200,79200]],probability:.5,run:(sim) => { callTrackPerson(sim, sim.topo.stations[stationIdx('LJZ')].platforms.DN); }},
  {id:"lujiazui-pudongsouth-axle-disturbance",name:"陆家嘴—浦东南路计轴受扰",category:"设备故障",windows:[[25200,79200]],probability:.5,run:(sim) => {
          const a = chainOf(sim, 'LJZ'), b = chainOf(sim, 'PDN');
          const sec = sim.topo.sections.find((x) => x.track === 'DN' && x.kind === 'plain' && x.chainFrom > a + 200 && x.chainTo < b - 200);
          if (!sec) return '未找到区段';
          injectFault(sim, 'axle', sec.id, 6 * 60);
        }},
  {id:"river-tunnel-westbound-train-failure",name:"越江隧道上行列车故障",category:"列车故障",windows:[[25200,79200]],probability:.5,run:(sim) => {
          const tr = trainIn(sim, chainOf(sim, 'NJD') + 150, chainOf(sim, 'LJZ') - 150, false) ?? trainIn(sim, chainOf(sim, 'NJD') + 150, chainOf(sim, 'SJD'), false);
          if (!tr) return '未找到合适列车';
          injectFault(sim, 'trainFail', tr.id, 0, undefined, false);
        }},
  {id:"hongqiao-railway-return-crowd",name:"虹桥火车站返程大客流（×5）",category:"客流",windows:[[75600,86400]],probability:.5,run:(sim) => { injectFault(sim, 'surge', stationIdx('HQZ'), 70 * 60, 5); }},
  {id:"pudong-airport-return-crowd",name:"浦东机场到达大客流（×4）",category:"客流",windows:[[75600,86400]],probability:.5,run:(sim) => { injectFault(sim, 'surge', stationIdx('PDA'), 60 * 60, 4); }},
  {id:"hongqiao-terminal2-return-crowd",name:"虹桥2号航站楼大客流（×3）",category:"客流",windows:[[75600,86400]],probability:.5,run:(sim) => { injectFault(sim, 'surge', stationIdx('HQ2'), 60 * 60, 3); }},
  {id:"hongqiao-terminal2-down-psd-failure",name:"虹桥2号航站楼下行站台门故障",category:"设备故障",windows:[[25200,79200]],probability:.5,run:(sim) => { injectFault(sim, 'psd', sim.topo.stations[stationIdx('HQ2')].platforms.DN, 12 * 60); }},
  {id:"extra-train-pecu",name:"加班车乘客紧急报警",category:"列车故障",windows:[[25200,79200]],probability:.5,run:(sim) => {
          const tr = extraTrain(sim);
          if (!tr) return '未找到加班车';
          callPecu(sim, tr);
          return `${tr.tripNo} 车厢内乘客按下紧急报警（错过下车站）`;
        }},
  {id:"nanjing-east-closure-sequence",name:"南京东路封站过程",category:"运营调整",windows:[[55800,57600]],probability:.5,
    run:sim=>{sim.log('B','客流','公安通告：20分钟后南京东路站临时封站，列车跳站通过，出入口关闭；随后处置通过列车的乘客报警。');},steps:[
      {after:20*60,name:'封站',run:(sim) => {
          if (stationClosed(sim, 'NJD')) { sim.log('I', '客流', '南京东路站已封站，出入口关闭'); return; }
          closeStation(sim, 'NJD', true);
          sim.log('B', '客流', '南京东路站封站：上、下行站台跳停（计划），出入口关闭');
         }},
      {after:32*60,name:'通过列车乘客要求下车',run:(sim)=>{
        const tr=trainIn(sim,chainOf(sim,'RMG')+200,chainOf(sim,'LJZ')-200,true)??trainIn(sim,chainOf(sim,'JAS'),chainOf(sim,'PDN'),true);
        if(!tr)return '未找到合适列车';
        callPecu(sim,tr);
      }},
    ]},
  {id:"peoples-square-diverted-crowd",name:"人民广场客流激增（×3）",category:"客流",windows:[[57600,61200]],probability:.5,run:(sim) => { injectFault(sim, 'surge', stationIdx('RMG'), 38 * 60, 3); }},
  {id:"lujiazui-diverted-crowd",name:"陆家嘴客流激增（×3.5）",category:"客流",windows:[[57600,61200]],probability:.5,run:(sim) => { injectFault(sim, 'surge', stationIdx('LJZ'), 35 * 60, 3.5); }},

];

export const SCENARIOS: ScenarioDef[] = [
  {
    id: 'lyl-insert',
    name: '龙阳路早高峰加车',
    desc: '07:00 早高峰上线阶段，龙阳路车辆段出段咽喉道岔失去表示，同时世纪大道、龙阳路进站客流激增。需保证高峰加车按时上线、控制站台滞留。',
    objectives: [
      '处置龙阳路车辆段出段道岔失表（单操试排→钩锁确认→引导进路；修复后单操恢复表示）',
      '必要时从北翟路车辆段加开列车补位（命令页 → 加开列车）',
      '世纪大道、龙阳路站台滞留尽快消除（扣车均衡 / 限流）',
    ],
    dayType: 'weekday', start: H(6, 52), duration: 45 * 60,
    events: [
      {at:60,event:"longyang-depot-exit-switch-failure"},
      {at:8 * 60,event:"century-avenue-morning-crowd"},
      {at:10 * 60,event:"longyang-morning-crowd"},
    ],
  },
  {
    id: 'shr-switch',
    name: '淞虹路道岔故障',
    desc: '早高峰大小交路运营中，淞虹路一条折返线的道岔失去表示，小交路只剩另一条折返线可用，站后折返能力减半。需调整交路（提前/延后折返）或组织钩锁+引导进路恢复双线折返。',
    objectives: [
      '确认故障道岔并通知维修；必要时现场钩锁后办理引导进路折返',
      '小交路列车改在其他折返站人工折返（如中山公园站东剪刀渡线站前折返），或延伸为大交路',
      '控制西段间隔，修复后恢复正常折返',
    ],
    dayType: 'weekday', start: H(7, 40), duration: 40 * 60,
    events: [
      {at:90,event:"songhong-turnback-switch-failure"},
    ],
  },
  {
    id: 'rmg-surge',
    name: '人民广场大客流',
    desc: '晚高峰人民广场站进站客流达平时5倍，站台严重拥挤，停站时间延长并波及全线。需综合运用扣车均衡间隔、限流、加开等手段。',
    objectives: [
      '应答车站客流电话，视情实施限流',
      '在人民广场前后站扣车均衡间隔，避免列车串挤',
      '考虑加开运行图（命令页 → 加开运行图模板）',
    ],
    dayType: 'weekday', start: H(17, 25), duration: 40 * 60,
    events: [
      {at:120,event:"peoples-square-evening-crowd"},
      {at:12 * 60,event:"peoples-square-train-pecu"},
    ],
  },
  {
    id: 'cbtc-tbtc',
    name: 'CBTC→TBTC 降级切换',
    desc: 'ZC2（中山公园—浦东南路）区域控制器故障，区域内CBTC列车失去移动授权紧急制动。需按程序切换至TBTC后备系统，固定闭塞下维持运营，修复后恢复CBTC。',
    objectives: [
      '确认区域内列车停稳 → 切换ZC2至TBTC（二次确认）',
      'TBTC运营期间注意追踪间隔，必要时扣车调整',
      'ZC修复后恢复CBTC',
    ],
    dayType: 'weekday', start: H(9, 55), duration: 45 * 60,
    events: [{at:120,event:"zc2-failure"}],
  },
  {
    id: 'rescue',
    name: '故障列车救援',
    desc: '一列下行载客列车在静安寺—南京西路区间发生牵引故障，司机处置无效。需组织后车清客救援、调整后续列车运行，并尽快恢复线路。',
    objectives: [
      '应答司机电话，确认无法恢复后组织救援（选中故障列车 → 组织救援，或电话中“组织后车救援”）',
      '救援期间对后续列车扣车/折返，避免区间积压',
      '救援完成后恢复正常间隔',
    ],
    dayType: 'weekday', start: H(9, 5), duration: 45 * 60,
    events: [
      {at:90,event:"jingansi-nanjingwest-train-failure"},
    ],
  },
  {
    id: 'storm',
    name: '东段雷暴大风',
    desc: '强对流天气影响东延伸高架段：大风黄色预警限速45km/h，随后暴雨，阵风一度达10级需高架段停运。需在广兰路组织折返（唐镇无配线），天气好转后恢复。',
    objectives: [
      '关注环境限速对运行的影响，调整间隔',
      '高架段停运期间，在广兰路中间线站台对东行列车人工折返（选中列车 → 人工折返）',
      '恢复后组织列车重新进入东段，回归运行图',
    ],
    dayType: 'weekday', start: H(16, 30), duration: 50 * 60,
    events: [
      {at:120,event:"severe-wind-sequence"},
      {at:8 * 60,event:"severe-wind-sequence",step:1},
      {at:15 * 60,event:"severe-wind-sequence",step:2},
      {at:27 * 60,event:"severe-wind-sequence",step:3},
    ],
  },
  {
    id: 'dawn-poss',
    name: '首班车：施工延时销点',
    desc: '凌晨静安寺—南京西路区间施工未能按时销点，施工负责人报告预计延时至05:50。首班车即将上线，广兰路始发的上行首班车途中又发生故障。需在封锁区间两侧组织首班车折返或等待，销点后尽快恢复全线运营。',
    objectives: [
      '掌握施工延时情况，封锁区间两侧首班车提前折返（人民广场站西渡线 / 中山公园站东剪刀渡线），或在站等待',
      '应答首班车司机故障电话，按程序处置（复位/救援）',
      '应答销点请求后解封区间，组织列车回归运行图',
    ],
    dayType: 'weekday', start: H(4, 50), duration: 90 * 60,
    events: [
      {at:60,event:"jingansi-possession-extension"},
      {at:66 * 60,event:"first-westbound-train-failure"},
    ],
  },
  {
    id: 'gll-loop',
    name: '广兰路中间线道岔故障',
    desc: '晚高峰广兰路中间线西端道岔P2305失去表示，小交路列车无法进入中间线站台折返。需调整小交路折返站（上海科技馆尽头线），或延伸为大交路，并组织现场钩锁、引导进路恢复中间线折返。',
    objectives: [
      '确认P2305失表，通知维修；避免小交路列车在广兰路下行站台积压',
      '后续小交路列车改在上海科技馆折返（选中列车 → 人工折返），或延伸至浦东1号2号航站楼',
      '钩锁后办理引导进路恢复中间线折返；修复后单操恢复表示',
    ],
    dayType: 'weekday', start: H(17, 20), duration: 45 * 60,
    events: [
      {at:90,event:"guanglan-middle-switch-failure"},
    ],
  },
  {
    id: 'hq-night',
    name: '虹桥枢纽夜间大客流',
    desc: '晚间航班、高铁集中到达，虹桥火车站、虹桥2号航站楼进站客流激增，往市区方向站台严重拥挤；随后虹桥火车站下行站台门故障。需及时加开、限流并处置站台门故障。',
    objectives: [
      '套用“虹桥枢纽大客流加开”运行图模板（命令页 → 加开运行图模板）',
      '应答车站客流电话，视情限流；扣车均衡后续间隔',
      '虹桥火车站下行站台门故障：确认人工关闭后办理互锁解除发车，修复后恢复',
    ],
    dayType: 'weekday', start: H(19, 40), duration: 50 * 60,
    events: [
      {at:60,event:"hongqiao-railway-evening-crowd"},
      {at:5 * 60,event:"hongqiao-terminal2-evening-crowd"},
      {at:18 * 60,event:"hongqiao-railway-down-psd-failure"},
    ],
  },
  {
    id: 'ciie-close',
    name: '进博会散场',
    desc: '进博会闭馆散场，国家会展中心进站客流达平时6倍；一列满载下行列车上乘客按下紧急报警，随后虹桥火车站下行出站信号机故障。需加开、均衡间隔并处置报警和信号故障。',
    objectives: [
      '套用“进博会保障加开”或人工加开列车，提升西段运力',
      '处置列车乘客紧急报警（应答司机电话，就近站台处置）',
      '虹桥火车站信号机故障：办理引导进路，列车RM越过，修复后恢复',
    ],
    dayType: 'weekday', start: H(16, 40), duration: 50 * 60,
    events: [
      {at:60,event:"exhibition-centre-closing-crowd"},
      {at:10 * 60,event:"exhibition-centre-train-pecu"},
      {at:22 * 60,event:"hongqiao-railway-down-start-signal-failure"},
    ],
  },
  {
    id: 'ljz-person',
    name: '陆家嘴人员侵入轨行区',
    desc: '早高峰陆家嘴站下行站台有乘客跳下轨行区。需立即紧急关闭站台、扣停接近列车；人员出清后恢复运营，随后一段计轴受扰需预复位并组织列车压道。',
    objectives: [
      '应答车站电话，立即紧急关闭陆家嘴下行站台，扣停接近列车',
      '确认人员出清后取消紧急关闭，恢复运营并均衡间隔',
      '计轴受扰：故障修复后计轴预复位，首列车RM压道出清',
    ],
    dayType: 'weekday', start: H(8, 15), duration: 40 * 60,
    events: [
      {at:90,event:"lujiazui-down-track-intrusion"},
      {at:12 * 60,event:"lujiazui-pudongsouth-axle-disturbance"},
    ],
  },
  {
    id: 'river-tunnel',
    name: '越江隧道列车故障',
    desc: '晚高峰一列上行载客列车在陆家嘴—南京东路越江隧道内牵引故障，无法自行恢复。需组织后车救援；救援期间东侧后续列车在上海科技馆折返，西侧在人民广场组织折返，维持两端运营。',
    objectives: [
      '应答司机电话，确认无法恢复后组织后车救援',
      '东侧后续上行列车在上海科技馆折返，西侧列车在人民广场站后折返，避免隧道区间积压',
      '救援完成后恢复全线运营，回归运行图',
    ],
    dayType: 'weekday', start: H(18, 0), duration: 50 * 60,
    events: [
      {at:90,event:"river-tunnel-westbound-train-failure"},
    ],
  },
  {
    id: 'holiday-return',
    name: '国庆返程高峰：定点加班车',
    desc: '国庆最后返程日（节假日运行图），虹桥枢纽与浦东机场晚间到达客流集中。虹桥火车站往龙阳路定点加班车延长至次日00:05，浦东1号2号航站楼往中山公园临时加班至23:30。加班车只在指定车站停车（虹桥两站上下客，其余停靠站只下不上），其余车站以不超过45 km/h通过。期间虹桥2号航站楼下行站台门故障，加班车上又有乘客按下紧急报警。',
    objectives: [
      '保障加班车准点始发：虹桥火车站 23:04 / 23:30 / 23:45 / 00:05 往龙阳路；浦东1号2号航站楼 22:50 / 23:10 / 23:30 往中山公园',
      '加班车停站与通过按计划执行（只下不上站不上客，通过站限速45 km/h）',
      '虹桥2号航站楼下行站台门故障：确认人工关闭后办理互锁解除发车，修复后恢复',
      '应答加班车乘客紧急报警；视情对虹桥火车站限流',
    ],
    dayType: 'weekend', start: H(22, 30), duration: 100 * 60,
    fixedRuns: [
      { ...HQ_LATE_RUN, departures: [H(23, 4), H(23, 30), H(23, 45), H(24, 5)] },
      { from: 'PDA', to: 'ZSG', departures: [H(22, 50), H(23, 10), H(23, 30)], board: ['PDA'], alight: ['LYL', 'SJD', 'RMG'], depotFrom: 'CSD', depotTo: 'BZL' },
    ],
    events: [
      {at:60,event:"hongqiao-railway-return-crowd"},
      {at:2 * 60,event:"pudong-airport-return-crowd"},
      {at:4 * 60,event:"hongqiao-terminal2-return-crowd"},
      {at:50 * 60,event:"hongqiao-terminal2-down-psd-failure"},
      {at:70 * 60,event:"extra-train-pecu"},
    ],
  },
  {
    id: 'njd-closure',
    name: '国庆南京东路封站跳停',
    desc: '国庆假期，外滩客流管控，公安部门通告16:00起南京东路站临时封站：列车跳站通过、出入口关闭、不办理换乘。客流转向人民广场、陆家嘴，两站站台迅速拥挤；一列下行列车通过南京东路时有乘客要求下车，按下紧急报警。',
    objectives: [
      '确认16:00 ATS按计划设置南京东路上下行跳停（封站），封站期间不得取消',
      '列车以不超过45 km/h通过南京东路站台',
      '人民广场、陆家嘴大客流：视情限流，扣车均衡间隔',
      '应答列车乘客紧急报警，在前方站处置',
    ],
    dayType: 'weekend', start: H(15, 40), duration: 60 * 60,
    events: [
      {at:60,event:"nanjing-east-closure-sequence"},
      {at:21 * 60,event:"nanjing-east-closure-sequence",step:1},
      {at:21 * 60,event:"peoples-square-diverted-crowd"},
      {at:24 * 60,event:"lujiazui-diverted-crowd"},
      {at:33 * 60,event:"nanjing-east-closure-sequence",step:2},
    ],
  },
];

// ---------------------------------------------------------------- metrics

export function newMetrics(t: number): Metrics {
  return {
    since: t, tripDelays: [], tripsCompleted: 0, boarded: 0, departures: 0, departuresLate: 0, boardedDelayed: 0, stranded: 0, cleared: 0, limited: 0,
    safety: { spad: 0, overspeed: 0, rmNearMiss: 0, unsafeAuth: 0, espIgnored: 0, overrun: 0, wrongDoor: 0 },
    callsAnswered: 0, callsExpired: 0, faults: 0,
  };
}

export function startScenario(sim: Sim, id: string) {
  const def = SCENARIOS.find((s) => s.id === id);
  if (!def) return;
  sim.scenario = { id, name: def.name, start: sim.t, end: sim.t + def.duration, objectives: def.objectives, ended: false };
  sim.metrics = newMetrics(sim.t);
  sim.scenarioFired = 0;
  sim.log('B', '教员', `场景开始：${def.name}（时长 ${Math.round(def.duration / 60)} 分钟）`);
  sim.bookmark(`场景开始：${def.name}`, true);
}

export function scenarioTick(sim: Sim) {
  instructorTick(sim);
  const sc = sim.scenario;
  if (!sc || sc.ended) return;
  const def = SCENARIOS.find((s) => s.id === sc.id);
  if (def) {
    while (sim.scenarioFired < def.events.length && sim.t - sc.start >= def.events[sim.scenarioFired].at) {
      const scheduled = def.events[sim.scenarioFired++];
      const ev = INSTRUCTOR_EVENTS.find(e=>e.id===scheduled.event)!;
      const action=scheduled.step?ev.steps?.[scheduled.step-1]:ev;
      if(!action)continue;
      const r = action.run(sim);
      const label=scheduled.step?`${ev.name}：${action.name}`:ev.name;
      sim.log('B', '教员', `场景事件：${label}${r ? `（${r}）` : ''}`);
      sim.bookmark(label, true);
    }
  }
  if (sim.t >= sc.end) endScenario(sim);
}

export function endScenario(sim: Sim): ScenarioReport {
  const sc = sim.scenario;
  const report = buildReport(sim, sc ? sc.name : '自由运营评估', sc ? sc.start : sim.metrics.since);
  if (sc) { sc.ended = true; sc.report = report; }
  sim.dailyEvaluationEnded = true;
  sim.reportReady = report;
  sim.log('B', '教员', `${report.title}结束：得分 ${report.score}（${report.grade}）`);
  return report;
}

export function buildReport(sim: Sim, title: string, from: number): ScenarioReport {
  const m = sim.metrics;
  const now = sim.t;
  // train delay minutes: completed trips + trains still running late
  let delaySec = m.tripDelays.reduce((a, d) => a + Math.max(0, d), 0);
  for (const tr of sim.trainList) if (tr.inService && tr.delay > 60) delaySec += tr.delay;
  // planned trips that should have started in the window
  const planned = sim.plan.trips.filter((t) => t.revenue && t.stops[0].dep >= from && t.stops[0].dep <= now - 60);
  const plannedIds = new Set(planned.map((t) => t.id));
  const departed = new Set(sim.depLog.filter((d) => plannedIds.has(d.trip)).map((d) => d.trip));
  const delivered = planned.filter((t) => departed.has(t.id) && !t.cancelled).length;
  const delivery = planned.length ? delivered / planned.length : 1;
  const punctuality = m.departures ? 1 - m.departuresLate / m.departures : 1;
  const affected = Math.round(m.stranded + m.boardedDelayed + m.cleared + m.limited);
  const s = m.safety;
  const safetyTotal = s.spad + s.overspeed + s.rmNearMiss + s.unsafeAuth + s.espIgnored + s.overrun + s.wrongDoor;
  const stops = sim.drivingStops.filter((x) => x.t >= from);
  const driving = stops.length ? {
    stops: stops.length,
    avgErr: stops.reduce((a, x) => a + Math.abs(x.err), 0) / stops.length,
    avgScore: stops.reduce((a, x) => a + x.score, 0) / stops.length,
  } : null;
  const delayMinutes = delaySec / 60;
  // normalised, so a longer session is not marked down for its length:
  // average delay per planned trip (s), affected passengers as a share of those carried
  const avgDelay = delaySec / Math.max(1, planned.length);
  const affectedShare = affected / Math.max(1000, m.boarded ?? 0);
  const pen = {
    delay: Math.min(30, avgDelay / 4),
    affected: Math.min(20, affectedShare * 400),
    delivery: Math.min(25, (1 - delivery) * 150),
    safety: Math.min(45, safetyTotal * 12),
    calls: Math.min(10, m.callsExpired * 2),
  };
  let score = 100 - pen.delay - pen.affected - pen.delivery - pen.safety - pen.calls;
  if (driving) score = score * 0.85 + driving.avgScore * 0.15;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = safetyTotal > 0 && score >= 70 ? 'C（存在安全违章）' : score >= 90 ? 'A 优秀' : score >= 80 ? 'B 良好' : score >= 65 ? 'C 合格' : 'D 不合格';
  const notes: string[] = [];
  if (safetyTotal) notes.push(`安全违章 ${safetyTotal} 起：${[s.spad && `冒进信号 ${s.spad}`, s.overspeed && `超速触发紧急制动 ${s.overspeed}`, s.rmNearMiss && `目视行车未能停车 ${s.rmNearMiss}`, s.unsafeAuth && `不安全授权 ${s.unsafeAuth}`, s.espIgnored && `未及时紧急关闭站台 ${s.espIgnored}`, s.overrun && `对标越站 ${s.overrun}`, s.wrongDoor && `开错侧车门 ${s.wrongDoor}`].filter(Boolean).join('、')}`);
  if (m.callsExpired) notes.push(`有 ${m.callsExpired} 次呼叫未在时限内应答`);
  if (delivery < 0.98) notes.push(`运行图兑现率 ${(delivery * 100).toFixed(1)}%，有车次未开行或被取消`);
  if (m.stranded > 500) notes.push(`站台滞留乘客较多（约 ${Math.round(m.stranded)} 人次），可考虑限流、加开或均衡间隔`);
  if (!notes.length) notes.push('处置得当，运营秩序良好');
  for (const event of sim.instructorOccurred.filter(e=>e.at>=from)) {
    const name=INSTRUCTOR_EVENTS.find(e=>e.id===event.event)?.name??event.event;
    const faults=sim.faults.filter(f=>event.faults.includes(f.id));
    const calls=sim.calls.filter(c=>event.calls.includes(c.id));
    const possessions=sim.possessions.filter(p=>event.possessions.includes(p.id));
    const details=[event.result,...(faults.length?[`故障修复 ${faults.filter(f=>f.repaired).length}/${faults.length}`]:[]),
      ...(calls.length?[`呼叫应答 ${calls.filter(c=>c.state==='answered').length}/${calls.length}`]:[]),
      ...(possessions.length?[`施工完成 ${possessions.filter(p=>['done','cancelled'].includes(p.state)).length}/${possessions.length}`]:[]),
      ...(event.weatherUntil?[sim.t>=event.weatherUntil?'天气时段已结束':'天气影响中']:[])].filter(Boolean);
    notes.push(`${name}：${details.join('；')||'已执行，见事件日志'}`);
  }
  return {
    title, from, to: now, delayMinutes, affected, delivery, plannedTrips: planned.length, deliveredTrips: delivered, punctuality,
    safety: { ...s }, safetyTotal, callsAnswered: m.callsAnswered, callsExpired: m.callsExpired, driving, score, grade, notes,
  };
}

// ---------------------------------------------------------------- random faults

export const RANDOM_LEVELS = ['关闭', '初级', '中级', '高级'];

export interface RandomFaultEntry extends InstructorScheduleEntry {
  kind: string; major: boolean; vehicle: boolean; windows: number[][];
  retryAt?: number; status: 'pending'|'fired'|'unavailable'; vehicleId?: string;
}

/** Draw kinds once, then reuse the instructor time-window lottery. */
export function scheduleRandomFaults(seed:number,start:number,level:number,plan:Plan,count=OPERATIONS.randomFaults.levels[level-1]?.count??0,allowMajor=true):RandomFaultEntry[] {
  if(!count)return [];
  const rules=OPERATIONS.randomFaults,rng=dayRandom(seed,0x72616e64^level);
  const calls=plan.trips.filter(t=>t.revenue&&!t.cancelled).flatMap(t=>t.stops);
  const passenger:[[number,number]]=[[Math.max(start,Math.min(...calls.map(s=>s.dep))),Math.max(...calls.map(s=>s.arr))]];
  const peak=rules.crowdWindows.map(([a,b])=>[Math.max(a,passenger[0][0]),Math.min(b,passenger[0][1])]).filter(([a,b])=>b>a);
  const major=allowMajor&&rng()<rules.levels[level-1].majorProbability?Math.floor(rng()*count):-1;
  const entries:RandomFaultEntry[]=[];
  for(let slot=0;slot<count;slot++) {
    const choices=rules.kinds.filter(k=>k.minLevel<=level&&(k.scope!=='peak'||peak.length)&&(k.scope==='all'||passenger[0][1]>passenger[0][0]));
    const total=choices.reduce((n,k)=>n+k.weight,0);let weight=rng()*total;
    const selected=choices.find(k=>(weight-=k.weight)<0)??choices.at(-1);
    if(!selected)continue;
    const isMajor=slot===major&&passenger[0][1]>passenger[0][0];
    const kind=isMajor?rules.majorKinds[Math.floor(rng()*rules.majorKinds.length)]:selected.kind;
    const windows=isMajor||selected.scope==='passenger'?passenger:selected.scope==='peak'?peak:[[start,OPERATING_DAY.to]];
    const id=`random-${level}-${slot}-${kind}`;
    const event:InstructorEvent={id,name:kind,category:'随机故障',probability:1,windows:windows.map(([a,b])=>[a,b]),run:()=>{}};
    const [draw]=scheduleInstructorEvents(seed,start,[id],[event]);
    if(draw)entries.push({...draw,kind,major:isMajor,vehicle:isMajor||!!selected.vehicle,windows,status:'pending'});
  }
  return entries.sort((a,b)=>a.at-b.at||a.event.localeCompare(b.event));
}

export function setRandomFaults(sim: Sim, level: number) {
  sim.randomLevel = Math.max(0, Math.min(3, level));
  if(sim.randomLevel) {
    const done=sim.randomSchedule.filter(e=>e.status!=='pending');
    const count=Math.max(0,OPERATIONS.randomFaults.levels[sim.randomLevel-1].count-done.filter(e=>e.status==='fired').length);
    sim.randomSchedule=[...done,...scheduleRandomFaults(sim.config.seed,Math.max(sim.t,sim.config.startTime),sim.randomLevel,sim.plan,count,!done.some(e=>e.major&&e.status==='fired'))];
  }
  sim.nextRandomAt=sim.randomLevel?Math.min(...sim.randomSchedule.filter(e=>e.status==='pending').map(e=>e.at)):Infinity;
  return { ok: true, msg: `随机故障：${RANDOM_LEVELS[sim.randomLevel]}` };
}

export function randomTick(sim: Sim) {
  // nothing is injected during the warm-up before the session starts
  if (!sim.randomLevel || sim.t < sim.nextRandomAt || sim.t < sim.config.startTime) return;
  for(const entry of sim.randomSchedule.filter(e=>e.status==='pending'&&(e.retryAt??e.at)<=sim.t)) {
    const window=entry.windows.find(([a,b])=>sim.t>=a&&sim.t<b);
    if(!window) {
      const later=entry.windows.find(([a])=>a>sim.t);
      if(later)entry.retryAt=later[0];
      else {entry.status='unavailable';sim.log('I','教员',`随机故障未执行：${entry.kind}，允许时段内没有合适对象`);}
      continue;
    }
    const before=sim.faults.length;
    const msg=injectRandom(sim,entry.kind,entry.vehicle?sim.randomFaultVehicles:undefined);
    if(!msg) {entry.retryAt=Math.min(window[1],sim.t+30);continue;}
    entry.status='fired';
    if(entry.vehicle) {
      const vehicle=sim.trains.get(sim.faults.slice(before).find(f=>sim.trains.has(f.target))?.target??-1)?.vehicle;
      if(vehicle){entry.vehicleId=vehicle;sim.randomFaultVehicles.push(vehicle);}
    }
    sim.log('B','教员',`随机故障（${RANDOM_LEVELS[sim.randomLevel]}）：${msg}`);
    sim.bookmark(`随机故障：${msg}`,true);
  }
  sim.nextRandomAt=Math.min(...sim.randomSchedule.filter(e=>e.status==='pending').map(e=>e.retryAt??e.at));
}

function pick<T>(sim: Sim, arr: T[]): T | undefined {
  return arr.length ? arr[Math.floor(sim.rng() * arr.length)] : undefined;
}

function injectRandom(sim: Sim, kind: string, usedVehicles?: string[]): string {
  const { topo } = sim;
  const level = sim.randomLevel;
  const dur = (base: number) => Math.round(base * (0.7 + sim.rng() * 0.6) * (level === 3 ? 1.4 : 1));
  const passengerTrains=sim.trainList.filter(t=>t.inService&&t.phase!=='stabled');
  const running = sim.trainList.filter((t) => t.inService && t.phase === 'run' && !t.failed && !t.manual && topo.links[t.link].track !== 'DEP'&&!usedVehicles?.includes(t.vehicle));
  const served=topo.stations.filter(s=>{
    const calls=sim.plan.trips.filter(t=>t.revenue&&!t.cancelled).flatMap(t=>t.stops.filter(stop=>stop.st===s.index&&stop.stop));
    return calls.some(c=>c.arr<=sim.t)&&calls.some(c=>c.dep>=sim.t);
  });
  const busy = served.filter((s) => STATIONS[s.index].demand >= 1.2).map((s) => s.index);
  const result = (r: { ok: boolean; msg: string }) => (r.ok ? r.msg.replace('已注入故障：', '') : '');
  switch (kind) {
    case 'trainFailR': {
      const tr = pick(sim, running);
      return tr ? result(injectFault(sim, 'trainFail', tr.id, dur(200), undefined, true)) : '';
    }
    case 'trainFail': {
      const tr = pick(sim, running);
      return tr ? result(injectFault(sim, 'trainFail', tr.id, 0, undefined, false)) : '';
    }
    case 'traction': {
      const tr = pick(sim, running.filter((t) => !t.tractionCut));
      return tr ? result(injectFault(sim, 'traction', tr.id, 0, sim.rng() < 0.7 ? 1 : 2, sim.rng() < 0.4)) : '';
    }
    case 'door': {
      const tr = pick(sim, running.filter((t) => !t.vfault));
      return tr ? result(injectFault(sim, 'door', tr.id, 0, sim.rng() < 0.8 ? 1 : 2)) : '';
    }
    case 'brake': {
      const tr = pick(sim, running.filter((t) => !t.vfault && t.vCap === Infinity));
      const r = sim.rng();
      return tr ? result(injectFault(sim, 'brake', tr.id, 0, r < 0.85 ? 1 : 2, r < 0.5)) : '';
    }
    case 'trainComm': {
      const tr = pick(sim, running.filter((t) => t.level === 'CBTC' && t.comm));
      return tr ? result(injectFault(sim, 'trainComm', tr.id, dur(420))) : '';
    }
    case 'trainDto': {
      const tr = pick(sim, running.filter((t) => ['DTO','AM'].includes(t.mode) && !t.dtoInhibit));
      return tr ? result(injectFault(sim, 'trainDto', tr.id, dur(1800))) : '';
    }
    case 'psd': {
      if(!passengerTrains.length)return '';
      const p = pick(sim, topo.platforms.filter(pp=>served.some(s=>s.index===pp.station)).map(pp=>pp.id));
      return p !== undefined ? result(injectFault(sim, 'psd', p, dur(600))) : '';
    }
    case 'surge': {
      if(!passengerTrains.length)return '';
      const st = pick(sim, busy);
      return st !== undefined ? result(injectFault(sim, 'surge', st, dur(1500), 2 + Math.round(sim.rng() * 3))) : '';
    }
    case 'pecu': {
      const tr = pick(sim, running);
      if (!tr) return '';
      callPecu(sim, tr);
      return `列车 ${tr.svc}-${tr.tripNo} 乘客紧急报警`;
    }
    case 'trackPerson': {
      const p = pick(sim, topo.platforms.filter((pp) => STATIONS[pp.station].demand >= 1).map((pp) => pp.id));
      if (p === undefined) return '';
      callTrackPerson(sim, p);
      return `${topo.platforms[p].name} 人员侵入轨道`;
    }
    case 'switch': {
      const sw = pick(sim, topo.switches.filter((s) => s.kind === 'crossover' || s.kind === 'siding').map((s) => s.id));
      return sw !== undefined ? result(injectFault(sim, 'switch', sw, dur(900))) : '';
    }
    case 'axle': {
      const s = pick(sim, topo.sections.filter((x) => x.kind === 'plain' && (x.track === 'DN' || x.track === 'UP') && !sim.sec[x.id].trainOcc).map((x) => x.id));
      return s !== undefined ? result(injectFault(sim, 'axle', s, dur(480))) : '';
    }
    case 'signal': {
      const s = pick(sim, topo.signals.filter((x) => x.role === 'home' || x.role === 'start').map((x) => x.id));
      return s !== undefined ? result(injectFault(sim, 'signal', s, dur(600))) : '';
    }
    case 'zcFail': {
      const z = Math.floor(sim.rng() * topo.zones.length);
      return result(injectFault(sim, 'zcFail', z, dur(1200)));
    }
    case 'wind':
      return setWeather(sim, { wind: 1 + Math.floor(sim.rng() * 2), duration: dur(1500) }).msg;
    case 'rain':
      return setWeather(sim, { rain: true, duration: dur(1500) }).msg;
  }
  return '';
}

export { LINE_INFO };
