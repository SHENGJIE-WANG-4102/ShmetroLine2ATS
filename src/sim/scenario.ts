/**
 * Instructor / scenario mode: preset training scenarios, random fault
 * injection by difficulty, run metrics and the scored end-of-run report.
 */
import type { Sim } from './engine';
import type { DayType, Metrics, ScenarioReport, Train, Plan } from './model';
import { STATIONS, LINE_INFO, OPERATIONS, SIMULATION, type FixedRun } from '../data/current';
import type { InstructorAction } from '../data/simulation';
import { travelDirection } from './topology';
import { closeStation } from './holiday';
import { injectFault } from './faults';
import { setWeather, addPossession } from './env';
import { callPecu, callTrackPerson } from './radio';
import { dayRandom, OPERATING_DAY } from './dayRandom';
import { effectiveStops } from './timetable';

export interface InstructorScheduleEntry { event: string; at: number; step?: number }
export interface InstructorOccurrence extends InstructorScheduleEntry {
  result: string; faults: number[]; calls: number[]; possessions: number[]; weatherUntil: number;
}
/** Migrate the previous checkbox IDs once, including merged sequences. */
const PREVIOUS_EVENT_IDS: Record<string,string> = SIMULATION.instructor.previousIds;
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
    const e = travelDirection(sim.topo, tr) === 'DN';
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

/** Scenario locations and timings are line data; each action is a reusable operation. */
function runInstructorAction(sim: Sim, action: InstructorAction): string | void {
  switch (action.kind) {
    case 'surge':
      injectFault(sim, 'surge', stationIdx(action.station), action.duration, action.multiplier);
      return;
    case 'depotExitSwitch': {
      const dp = sim.topo.depots.find(depot => depot.key === action.depot)!;
      const lead = dp.transferPaths.find(path => path.flow === 'out') ?? dp.transferPaths[0];
      const stub = sim.topo.nodes[lead.throat].links.find(link => sim.topo.links[link].track === 'SID')!;
      const start = sim.topo.links[stub].chainA;
      const sw = findSwitch(sim, dp.station, id => sim.topo.switches[id].kind === 'depot'
        && sim.topo.switches[id].nodes.some(node => Math.abs(sim.topo.nodes[node].chain - start) < 60));
      injectFault(sim, 'switch', sw, action.duration);
      return;
    }
    case 'sidingMergeSwitch': {
      const { topo } = sim;
      const sw = findSwitch(sim, stationIdx(action.station), id => topo.switches[id].kind === 'siding'
        && topo.switches[id].nodes.length === 1 && topo.links[topo.nodes[topo.switches[id].nodes[0]].toe!].track === 'SID');
      injectFault(sim, 'switch', sw, action.duration);
      return;
    }
    case 'namedSwitch':
      injectFault(sim, 'switch', switchNamed(sim, action.name, stationIdx(action.station)), action.duration);
      return;
    case 'zone':
      injectFault(sim, 'zcFail', action.zone, action.duration);
      return;
    case 'train': {
      let train: Train | undefined;
      for (const window of action.windows) {
        train = trainIn(sim, chainOf(sim, window.from) + (window.fromOffset ?? 0),
          chainOf(sim, window.to) + (window.toOffset ?? 0), action.dir === 'DN');
        if (train) break;
      }
      if (!train) return action.noTrainMessage === false ? undefined : '未找到合适列车';
      if (action.fault === 'pecu') callPecu(sim, train);
      else injectFault(sim, 'trainFail', train.id, action.duration ?? 0, undefined, action.recover ?? false);
      return;
    }
    case 'weather':
      setWeather(sim, { wind: action.wind, rain: action.rain, duration: action.duration });
      return;
    case 'possession': {
      const possession = addPossession(sim, stationIdx(action.station), action.until);
      sim.log('B', '施工', `${possession.name} ${action.message}`);
      return;
    }
    case 'psd':
      injectFault(sim, 'psd', sim.topo.stations[stationIdx(action.station)].platforms[action.dir], action.duration ?? 0);
      return;
    case 'trackPerson':
      callTrackPerson(sim, sim.topo.stations[stationIdx(action.station)].platforms[action.dir]);
      return;
    case 'startSignal': {
      const station = stationIdx(action.station);
      const signal = sim.topo.signals.find(signal => signal.role === 'start' && signal.station === station
        && sim.topo.links[signal.link].track === action.dir);
      if (!signal) return '未找到信号机';
      injectFault(sim, 'signal', signal.id, action.duration ?? 0);
      return;
    }
    case 'axle': {
      const from = chainOf(sim, action.from), to = chainOf(sim, action.to);
      const section = sim.topo.sections.find(section => section.track === action.dir && section.kind === 'plain'
        && section.chainFrom > from + action.margin && section.chainTo < to - action.margin);
      if (!section) return '未找到区段';
      injectFault(sim, 'axle', section.id, action.duration);
      return;
    }
    case 'extraPecu': {
      const train = extraTrain(sim);
      if (!train) return '未找到加班车';
      callPecu(sim, train);
      return `${train.tripNo} 车厢内乘客按下紧急报警（错过下车站）`;
    }
    case 'log':
      sim.log('B', action.category, action.text);
      return;
    case 'closeStation':
      if (stationClosed(sim, action.station)) { sim.log('I', '客流', action.alreadyText); return; }
      closeStation(sim, action.station, true);
      sim.log('B', '客流', action.text);
      return;
  }
}

export interface InstructorStep {after:number;name:string;run:(sim:Sim)=>string|void}
export interface InstructorEvent {id:string;name:string;category:string;windows:[number,number][];probability:number;run:(sim:Sim)=>string|void;steps?:InstructorStep[]}
/** 【假设】初始概率统一为 0.5；可发生时段按事件性质给定，可逐项调整。 */
export const INSTRUCTOR_EVENTS: InstructorEvent[] = SIMULATION.instructor.events.map(event => ({
  id: event.id, name: event.name, category: event.category, windows: event.windows, probability: event.probability,
  run: sim => runInstructorAction(sim, event.action),
  steps: event.steps?.map(step => ({ after: step.after, name: step.name, run: sim => runInstructorAction(sim, step.action) })),
}));

export const SCENARIOS: ScenarioDef[] = SIMULATION.instructor.scenarios;

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
  const calls=plan.trips.filter(t=>t.revenue&&!t.cancelled).flatMap(t=>effectiveStops(t));
  if (!calls.length) return [];
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
    const calls=sim.plan.trips.filter(t=>t.revenue&&!t.cancelled).flatMap(t=>effectiveStops(t).filter(stop=>stop.st===s.index&&stop.stop));
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
    case 'trainUto': {
      const tr=pick(sim,running.filter(t=>!t.dtoInhibit));
      return tr?result(injectFault(sim,'trainUto',tr.id,0)):'';
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
