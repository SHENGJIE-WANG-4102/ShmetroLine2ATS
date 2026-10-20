import type { Sim } from './engine';
import { type Command, type Plan } from './model';
import { addExtraTrain, applyOverlay, OVERLAY_PRESETS, validatePlan, fleetPeak, depotMoves, sortDepotMoves, type PlanIssue } from './timetable';
import { validateCommand } from './commands';

export type PlanCommand = Extract<Command, { c: 'overlay' | 'addTrain' }>;
export interface PlanPreview {
  ok: boolean;
  msg: string;
  plan: Plan;
  issues: PlanIssue[];
  added: number;
  skipped: number;
  /** running circulations that continue into added trips (延长运用, D47):
   * their trains get the new trips after `last` when the plan is committed */
  extended?: { block: number; last: number }[];
  warnings?: string[];
}

/** Summary errors describe the whole operating day, regardless of the clock
 * assigned to the last depot movement. Shared by extras and standby relief. */
export function liveIssues(sim: Sim, plan: Plan): PlanIssue[] {
  const issues = validatePlan(sim.planCtx, plan).filter(i => i.code === 'YARD_BALANCE' || i.code === 'YARD_CAPACITY' || i.t >= sim.t - 1e-6);
  const shortfall = yardShortfall(sim, plan);
  if (shortfall) issues.push(shortfall);
  return [...issues, ...possessionIssues(sim, plan)];
}

export function addedPlanErrors(sim: Sim, plan: Plan, after = liveIssues(sim, plan)): PlanIssue[] {
  const before = liveIssues(sim, sim.plan).filter(i => i.severity === 'error');
  return after.filter(i => i.severity === 'error' && !before.some(old => {
    if (i.code === 'YARD_BALANCE' || i.code === 'YARD_CAPACITY')
      return old.code === i.code && old.depot === i.depot && Math.abs(i.delta!) <= Math.abs(old.delta!);
    return old.code === i.code && old.text === i.text;
  }));
}

export function noWorse(sim: Sim, plan: Plan): boolean { return addedPlanErrors(sim, plan).length === 0; }

/** Existing possession table is the sole source. Check the actual planned
 * run windows, including empty moves between a yard and its portal station. */
export function possessionIssues(sim: Sim, plan: Plan): PlanIssue[] {
  const works = sim.possessions.filter(p => p.state !== 'done' && p.state !== 'cancelled');
  if (!works.length) return [];
  const issues: PlanIssue[] = [];
  const check = (from: number, to: number, at: number, until: number, name: string, dir: string) => {
    if (until < sim.t) return;
    for (const p of works) {
      const end = p.to <= sim.t && p.state !== 'planned' ? Infinity : p.to;
      if (at >= end || until <= Math.max(sim.t, p.from)) continue;
      if (p.sections.some(id => {
        const section = sim.topo.sections[id];
        return section.track === dir && section.chainFrom < Math.max(from,to) && section.chainTo > Math.min(from,to);
      })) issues.push({ severity:'error', code:'POSSESSION', t:Math.max(at,sim.t,p.from), text:`${name} 经过施工封锁：${p.name}` });
    }
  };
  for (const trip of plan.trips) if (!trip.cancelled && !trip.completed) {
    for (let i = 1; i < trip.stops.length; i++) {
      const a = trip.stops[i-1], b = trip.stops[i];
      check(sim.topo.stations[a.st].chain,sim.topo.stations[b.st].chain,a.dep,b.arr,`车次 ${trip.no}`,trip.dir);
    }
  }
  for (const move of depotMoves(plan.blocks,plan.trips,sim.planCtx)) {
    if (sim.blockDone.has(move.block) || move.delta < 0 && plan.blocks[move.block].train !== undefined) continue;
    const block = plan.blocks[move.block], trips = block.trips.map(id=>plan.trips[id]).filter(t=>!t.cancelled);
    const trip = move.delta < 0 ? trips[0] : trips.at(-1);
    if (!trip) continue;
    const station = sim.topo.stations[move.delta < 0 ? trip.from : trip.to].chain;
    const yard = sim.topo.depots[move.depot].junctionChain;
    const from = move.delta < 0 ? yard : station, to = move.delta < 0 ? station : yard;
    check(from,to,move.window?.[0]??move.time,move.window?.[1]??move.time,`表号 ${block.svc} 出入段`,to>from?'DN':'UP');
  }
  return issues;
}

/** The same pure preparation and validation is used by preview and commit. */
export function preparePlan(sim: Sim, cmd: PlanCommand): PlanPreview {
  const plan = structuredClone(sim.plan);
  const reject = (msg: string, issues: PlanIssue[] = []): PlanPreview => ({ ok: false, msg, plan, issues, added: 0, skipped: 0 });
  const invalid = validateCommand(sim, cmd);
  if (invalid) return reject(invalid);
  const firstBlock = plan.blocks.length;
  const firstTrip = plan.trips.length;
  let skipped = 0;
  let label: string;
  let extended: PlanPreview['extended'];
  if (cmd.c === 'addTrain') {
    if (cmd.time < sim.t + 120) return reject('加开时刻须晚于当前时刻2分钟以上');
    const b = addExtraTrain(sim.planCtx, plan, cmd.depot, cmd.dir, cmd.to, cmd.time);
    if (typeof b === 'string') return reject(b);
    if (b.start.kind === 'depot' && b.start.time < sim.t) return reject('当前时刻已来不及出段，请选择更晚的加开时刻');
    label = `加开列车 表号${b.svc}`;
  } else {
    const preset = OVERLAY_PRESETS.find(p => p.id === cmd.id);
    if (!preset) return reject('无此加开模板');
    if (cmd.from < sim.t - 1e-6) return reject('加开开始时刻不能早于当前时刻');
    const result = applyOverlay(sim.planCtx, plan, { ...preset, from: cmd.from, to: cmd.to, headway: cmd.headway },
      { now: sim.t, canExtend: (block, last) => canExtend(sim, block, last),
        stock: { at: sim.t, levels: sim.depotStock.slice(), departed: sim.plan.blocks.filter(block => block.train !== undefined).map(block => block.id), done: [...sim.blockDone] } });
    skipped = result.skipped;
    extended = result.extended.map(x => ({ block: x.block, last: x.last }));
    label = preset.label;
    // (trips of a dropped duty belong to no duty, not to whichever takes its number)
    for (const b of plan.blocks) if (b.id >= firstBlock && b.trips.every(id => plan.trips[id].cancelled)) for (const id of b.trips) plan.trips[id].block = -1;
    plan.blocks = plan.blocks.filter(b => b.id < firstBlock || b.trips.some(id => !plan.trips[id].cancelled));
    plan.blocks.forEach((b, id) => { b.id = id; for (const trip of b.trips) plan.trips[trip].block = id; });
  }
  plan.fleetPeak = fleetPeak(plan);
  const rawIssues = liveIssues(sim, plan);
  const errors = addedPlanErrors(sim, plan, rawIssues);
  const issues = rawIssues.map(issue => issue.severity === 'error' && !errors.includes(issue)
    ? { ...issue, severity: 'warn' as const, text: `已有问题（未加重）：${issue.text}` } : issue);
  if (errors.length) return reject(`运行图不可行：${errors[0].text}`, issues);
  const warnings=issues.filter(i=>i.text.startsWith('已有问题')).map(i=>i.text);
  const added = plan.trips.slice(firstTrip).filter(trip => !trip.cancelled && trip.revenue).length;
  return { ok: true, msg: `${label}：新增 ${added} 个车次${skipped ? `；${skipped} 个车次因能力或库存不足未安排` : ''}`, plan, issues, added, skipped, extended, warnings };
}

/** The train of a circulation can still be kept in service after trip `last`:
 * either it has not left the depot yet, or it runs normally and has not yet
 * finished `last`. */
function canExtend(sim: Sim, block: number, last: number): boolean {
  if (sim.blockDone.has(block)) return false;
  const id = sim.plan.blocks[block]?.train;
  if (id === undefined) return true;
  const tr = sim.trains.get(id);
  return !!tr && !tr.failed && !tr.manual && !tr.relievedBy && !tr.withdrawn && tr.coupledLen === 0 && tr.rescuing < 0 && tr.rescueBy < 0
    && tr.tbStage !== 'manual' && tr.tasks.some(t => t.k === 'stop' && t.trip === last && t.dep === null);
}

/** Current yard stock must cover every planned departure from the yard.
 * Existing stock is reserved first, with planned returns credited only
 * after their entry movement. */
export function yardShortfall(sim: Sim, plan: Plan): PlanIssue | undefined {
  return yardCheck(sim, plan)?.issue;
}

/** The shortfall and the circulation whose departure from the yard first overdraws it. */
function yardCheck(sim: Sim, plan: Plan): { issue: PlanIssue; block: number } | undefined {
  const balance = sim.depotStock.slice();
  // (a duty already out has drawn its car; a finished one has returned it;
  // a pending exit cannot happen before now)
  const moves = sortDepotMoves(depotMoves(plan.blocks, plan.trips)
    .filter(m => !sim.blockDone.has(m.block) && !(m.delta < 0 && plan.blocks[m.block].train !== undefined))
    .map(m => m.delta < 0 ? { ...m, time: Math.max(sim.t, m.time) } : m));
  for (const move of moves) {
    balance[move.depot] += move.delta;
    if (balance[move.depot] < 0) return { issue: { severity: 'error', code: 'FLEET', t: move.time, text: `${sim.topo.depots[move.depot].name} 预计库存不足` }, block: move.block };
  }
  return undefined;
}
