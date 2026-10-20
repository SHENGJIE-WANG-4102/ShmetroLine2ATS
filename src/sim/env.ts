/**
 * Environment: weather speed restrictions on the exposed (elevated / at
 * grade) east section, and night engineering possessions (施工封锁).
 */
import type { Sim } from './engine';
import type { Possession } from './model';
import { EXPOSED, WEATHER_RULES, POSSESSIONS, STATIONS } from '../data/line2';
import { openCall, possReqSpec, possRelSpec } from './radio';
import { DRY_AFTER, railWet, scatterSlick } from './adhesion';

/** per section: 0 = tunnel, 1 = elevated, 2 = at grade */
export function exposureOf(sim: Pick<Sim,'topo'>): Uint8Array {
  const out = new Uint8Array(sim.topo.sections.length);
  sim.topo.sections.forEach((s, i) => {
    const mid = (s.chainFrom + s.chainTo) / 2;
    for (const e of EXPOSED) if (mid >= e.from && mid < e.to) out[i] = e.kind === 'elevated' ? 1 : 2;
  });
  return out;
}

export function setWeather(sim: Sim, opts: { wind?: number; rain?: boolean; duration: number }): { ok: boolean; msg: string } {
  const until = opts.duration > 0 ? sim.t + opts.duration : Infinity;
  const parts: string[] = [];
  if (opts.wind !== undefined) {
    sim.env.wind = Math.max(0, Math.min(4, Math.round(opts.wind)));
    sim.env.windUntil = sim.env.wind > 0 ? until : 0;
    parts.push(sim.env.wind > 0 ? WEATHER_RULES.wind[sim.env.wind - 1].label : '大风解除');
  }
  if (opts.rain !== undefined) {
    if (opts.rain && !railWet(sim)) scatterSlick(sim);
    if (!opts.rain && sim.env.rain) sim.env.dryAt = sim.t + DRY_AFTER;
    sim.env.rain = opts.rain;
    sim.env.rainUntil = opts.rain ? until : 0;
    parts.push(opts.rain ? WEATHER_RULES.rain.label : '暴雨解除');
  }
  applyWeather(sim);
  return { ok: true, msg: parts.join('，') };
}

export function weatherLimit(sim: Sim): { elevated: number; ground: number } {
  let elevated = 0;
  let ground = 0;
  if (sim.env.wind > 0) {
    const r = WEATHER_RULES.wind[sim.env.wind - 1];
    elevated = r.kmh === 0 ? -1 : r.kmh;
  }
  if (sim.env.rain) {
    const v = WEATHER_RULES.rain.kmh;
    elevated = elevated < 0 ? -1 : elevated > 0 ? Math.min(elevated, v) : v;
    ground = v;
  }
  return { elevated, ground };
}

function applyWeather(sim: Sim) {
  const lim = weatherLimit(sim);
  for (let i = 0; i < sim.sec.length; i++) {
    const e = sim.exposure[i];
    sim.sec[i].envTsr = e === 1 ? lim.elevated : e === 2 ? lim.ground : 0;
  }
  const key = 'weather';
  if (lim.elevated !== 0 || lim.ground !== 0) {
    const txt = [
      sim.env.wind > 0 ? WEATHER_RULES.wind[sim.env.wind - 1].label : '',
      sim.env.rain ? WEATHER_RULES.rain.label : '',
    ].filter(Boolean).join('、');
    const what = lim.elevated < 0 ? '高架段停运' : `高架段限速 ${lim.elevated} km/h${lim.ground > 0 ? `、地面段限速 ${lim.ground} km/h` : ''}`;
    sim.clearAlarm(key);
    sim.log(lim.elevated < 0 ? 'A' : 'B', '环境', `${txt}：${what}`, { key });
  } else {
    sim.clearAlarm(key);
  }
}

export function envTick(sim: Sim) {
  let changed = false;
  if (sim.env.wind > 0 && sim.t >= sim.env.windUntil) { sim.env.wind = 0; changed = true; }
  if (sim.env.rain && sim.t >= sim.env.rainUntil) { sim.env.rain = false; sim.env.dryAt = sim.t + DRY_AFTER; changed = true; }
  if (changed) applyWeather(sim);
  adhesionAlarm(sim);
  possessionTick(sim);
}

/** wet rail on the exposed section: an alarm while it lasts (adhesion.ts) */
function adhesionAlarm(sim: Sim) {
  const wet = railWet(sim);
  if (wet && !sim.alarms.has('adhesion')) {
    sim.log('B', '环境', `高架/地面段轨面湿滑，粘着降低：列车牵引、制动可能空转/滑行，进站可能过标${sim.env.lowAdh ? '' : '（可设置低粘着模式）'}`, { key: 'adhesion' });
  } else if (!wet && sim.alarms.has('adhesion')) {
    sim.clearAlarm('adhesion');
    sim.env.slick = [];
    sim.log('I', '环境', '高架/地面段轨面已干燥，粘着恢复');
  }
}

export function setLowAdhesion(sim: Sim, on: boolean): { ok: boolean; msg: string } {
  if (sim.env.lowAdh === on) return { ok: false, msg: on ? '已处于低粘着模式' : '未设置低粘着模式' };
  sim.env.lowAdh = on;
  const msg = on
    ? '低粘着模式：露天段列车降低牵引、提前以较小减速度制动（运行时分增加）'
    : '取消低粘着模式，恢复正常牵引制动';
  sim.log('C', '调度', msg);
  return { ok: true, msg };
}

// ---------------------------------------------------------------- possessions

function intervalSections(sim: Sim, west: number): number[] {
  const { topo } = sim;
  const a = topo.stations[west].chain + 120;
  const b = topo.stations[west + 1].chain - 120;
  return topo.sections.filter((s) => (s.track === 'DN' || s.track === 'UP') && s.chainFrom >= a - 1 && s.chainTo <= b + 1 && s.kind === 'plain').map((s) => s.id);
}

export function initPossessions(sim: Sim) {
  if (sim.config.noPossessions) return;
  const cands = [...POSSESSIONS.candidates];
  // seeded shuffle
  for (let i = cands.length - 1; i > 0; i--) {
    const j = Math.floor(sim.rng() * (i + 1));
    [cands[i], cands[j]] = [cands[j], cands[i]];
  }
  const mk = (west: number, from: number, to: number, state: Possession['state']): Possession => ({
    id: sim.possessions.length, name: `${STATIONS[west].name}—${STATIONS[west + 1].name} 区间`, sections: intervalSections(sim, west), from, to, state,
  });
  // morning: active from the start of the day, released before the first trains
  for (const w of cands.slice(0, 2)) {
    const p = mk(w, sim.dayStart - 3 * 3600, POSSESSIONS.morningUntil, 'active');
    sim.possessions.push(p);
    for (const s of p.sections) { sim.sec[s].blocked = true; sim.sec[s].poss = p.id; }
  }
  // tonight
  cands.slice(2, 5).forEach((w, k) => {
    sim.possessions.push(mk(w, POSSESSIONS.nightFrom + k * 300, POSSESSIONS.nightTo - k * 300, 'planned'));
  });
}

/**
 * A possession of the interval east of station `west` that is (still) in
 * force until `to` — used by scenarios for a possession that overruns.
 */
export function addPossession(sim: Sim, west: number, to: number): Possession {
  const p: Possession = { id: sim.possessions.length, name: `${STATIONS[west].name}—${STATIONS[west + 1].name} 区间`, sections: intervalSections(sim, west), from: sim.t, to, state: 'active' };
  sim.possessions.push(p);
  for (const s of p.sections) { sim.sec[s].blocked = true; sim.sec[s].poss = p.id; }
  return p;
}

function possessionClear(sim: Sim, p: Possession): boolean {
  const secs = new Set(p.sections);
  const { topo } = sim;
  // (a quick bound first: most remaining paths lie wholly outside the work)
  let lo = Infinity, hi = -Infinity;
  for (const id of p.sections) { lo = Math.min(lo, topo.sections[id].chainFrom); hi = Math.max(hi, topo.sections[id].chainTo); }
  const crosses = (a:number,b:number) => lo < Math.max(a,b) && hi > Math.min(a,b) && p.sections.some(id => {
    const section=topo.sections[id];
    return section.chainFrom < Math.max(a,b) && section.chainTo > Math.min(a,b);
  });
  const west = topo.sections[p.sections[0]]?.station ?? 0;
  for (const tr of sim.trainList) {
    if (tr.phase === 'stabled') continue;
    for (const b of tr.body) if (secs.has(topo.links[b.link].section)) return false;
    // trains still due to run through the interval
    let from=sim.trainChain(tr);
    for (const t of tr.tasks) {
      const to=t.k==='stop'||t.k==='reverse'?topo.stations[t.station].chain
        :t.k==='stable'&&t.berth>=0?topo.stations[topo.berths[t.berth].station]?.chain
          :t.k==='depot'?topo.depots[t.depot].junctionChain:undefined;
      // Non-stopping empty moves can have no intermediate stop tasks. Their
      // whole remaining path still has to clear before the work can start.
      if(to!==undefined) {if(crosses(from,to)) return false;from=to;}
      if (t.k === 'stop' && Math.abs(t.station - west) <= 2) return false;
      if (t.k === 'depot') {
        const j = topo.depots[t.depot].junctionChain;
        const ch = sim.trainChain(tr);
        const lo = Math.min(j, ch);
        const hi = Math.max(j, ch);
        if (p.sections.some((s) => topo.sections[s].chainFrom < hi && topo.sections[s].chainTo > lo)) return false;
      }
    }
  }
  for(const block of sim.plan.blocks) {
    if(block.train!==undefined||sim.blockDone.has(block.id)||block.start.kind!=='depot'||block.start.time>=p.to) continue;
    let from=topo.depots[block.start.depot].junctionChain;
    for(const trip of block.trips.map(id=>sim.plan.trips[id]).filter(t=>!t.cancelled&&!t.completed)) {
      if(trip.stops[0].dep>=p.to) break;
      for(const stop of trip.stops) {
        const to=topo.stations[stop.st].chain;
        if(crosses(from,to)) return false;
        from=to;
      }
    }
  }
  return true;
}

function possessionTick(sim: Sim) {
  for (const p of sim.possessions) {
    if (p.state === 'planned' && sim.t >= p.from) {
      if (!possessionClear(sim, p)) continue;
      p.state = 'requested';
      openCall(sim, possReqSpec(sim, p.id));
    } else if (p.state === 'active' && sim.t >= p.to) {
      p.state = 'releasing';
      openCall(sim, possRelSpec(sim, p.id));
    }
  }
}
