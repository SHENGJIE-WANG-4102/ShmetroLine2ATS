/**
 * Cab DMI model: per-train message log (driven by state changes, same wording
 * as the Casco DMI message log) and the data block the DMI view needs beyond
 * the regular train snapshot.
 */
import type { Sim } from './engine';
import type { DmiData, DmiMsg, Level, Mode, Train, StopTask } from './model';
import { STATIONS, fleetEntry } from '../data/line2';
import { stopError } from './movement';
import { cbtcAvailable, dtoAllowed } from './onboard';
import { serviceEnd } from './timetable';
import { signalAheadFrom, platformSide } from './ats';

const LOG_MAX = 40;

/** highest mode the on-board equipment could offer right now (the "AM-C" field) */
export function availableMode(sim: Sim, tr: Train): { mode: Mode; level: Level } {
  // CBTC (DTO) needs the radio link and a ZC in control; the TBTC backup
  // (digital track circuits, continuous) runs in parallel and offers ATO (P2 §2.1.1)
  if (cbtcAvailable(sim, tr)) return { mode: dtoAllowed(sim, tr) ? 'DTO' : 'AM', level: 'CBTC' };
  return { mode: 'AM', level: 'TBTC' };
}

/** on-screen wording of the driving mode */
export function modeWord(m: Mode): string {
  return m;
}

export function dmiNote(sim: Sim, tr: Train, m: string, k: DmiMsg['k'] = 'info') {
  tr.dmiLog.push({ t: sim.t, m, k });
  if (tr.dmiLog.length > LOG_MAX) tr.dmiLog.splice(0, tr.dmiLog.length - LOG_MAX);
}

// The photographed ATPM wording describes the existing supervised-mode offer.
const availMsg = (a: { mode: Mode; level: Level }) =>
  a.mode === 'RM' ? '仅RM模式可用' : 'ATPM模式可用';

/** 【假设】空驶/过夜/热备沿用所在客运或出库任务，不另建类别。 */
export function dmiTask(tr: Train): string {
  if (tr.depotStage === 'in' || tr.tasks[0]?.k === 'depot') return 'in';
  if (tr.depotStage === 'out') return 'out';
  if (tr.tbStage !== 'none' || tr.tasks[0]?.k === 'reverse') return 'turn';
  return tr.tasks.some(t => t.k === 'stop' && (t.stabledOut || t.standby)) && !tr.inService ? 'out' : 'service';
}

/** once a second: turn state changes into DMI messages */
export function dmiTick(sim: Sim) {
  for (const tr of sim.trainList) {
    const av = availableMode(sim, tr);
    const context = { task: dmiTask(tr), cab: tr.dmiCab ?? 0 };
    const old = tr.dmiContext;
    if (!old || old.cab !== context.cab || old.task !== context.task) {
      const messages = !old || old.cab !== context.cab
        ? ['active', 'located', 'available'] as const : ['located', 'available'] as const;
      const at = Math.max(sim.t, (tr.dmiQueue?.at(-1)?.at ?? sim.t - 15) + 15);
      tr.dmiQueue ??= [];
      tr.dmiQueue.push(...messages.map((message, i) => ({ at: at + i * 15, message })));
    }
    tr.dmiContext = context;
    while (tr.dmiQueue?.length && tr.dmiQueue[0].at <= sim.t + 1e-6) {
      const next = tr.dmiQueue.shift()!;
      const m = next.message === 'active' ? 'DMI激活' : next.message === 'located' ? '定位已确认' : availMsg(av);
      tr.dmiLog.push({ t: next.at, m, k: next.message === 'available' && av.mode === 'RM' ? 'warn' : 'info' });
      if (tr.dmiLog.length > LOG_MAX) tr.dmiLog.shift();
    }
    const cur = {
      avail: `${av.mode}-${av.level}`, comm: tr.comm, mode: `${tr.mode}-${tr.level}`, eb: tr.eb, hold: tr.hold,
      stop: tr.stopUntil > sim.t, failed: tr.failed, over: tr.v > tr.vPermit + 0.3 && !tr.eb,
    };
    const p = tr.dmiPrev;
    tr.dmiPrev = cur;
    if (!p) continue;
    if (p.comm && !cur.comm) dmiNote(sim, tr, '连接丢失', 'warn');
    if (!p.comm && cur.comm) dmiNote(sim, tr, '连接恢复');
    if (p.avail !== cur.avail) {
      dmiNote(sim, tr, availMsg(av), av.mode === 'RM' ? 'warn' : 'info');
    }
    if (p.mode !== cur.mode) dmiNote(sim, tr, `${modeWord(tr.mode)} ${tr.level}模式`, tr.mode === 'RM' ? 'warn' : 'info');
    if (!p.eb && cur.eb) dmiNote(sim, tr, `紧急制动 ${tr.ebReason}`, 'alarm');
    if (p.eb && !cur.eb) dmiNote(sim, tr, '紧急制动缓解');
    if (!p.over && cur.over) dmiNote(sim, tr, '超速报警', 'warn');
    if (!p.hold && cur.hold) dmiNote(sim, tr, '扣车', 'warn');
    if (p.hold && !cur.hold) dmiNote(sim, tr, '扣车取消');
    if (!p.stop && cur.stop) dmiNote(sim, tr, `区间停车 ${tr.stopReason}`, 'warn');
    if (!p.failed && cur.failed) dmiNote(sim, tr, '列车故障', 'alarm');
  }
}

/** "T" + four digits as shown on the DMI: 0213 → T2013, 02086 → T2086 */
export function dmiTrainNo(vehicle: string): string {
  const five = vehicle.length === 4 ? `${vehicle.slice(0, 2)}0${vehicle.slice(2)}` : vehicle;
  return `T${five.slice(-4)}`;
}

export function computeDmi(sim: Sim, id: number): DmiData | null {
  const tr = sim.trains.get(id);
  if (!tr) return null;
  const { topo } = sim;
  let dep = -1;
  for (const t of tr.tasks) {
    if (t.k !== 'stop' || !t.doors) continue;
    dep = t.dep ?? -1;
    break;
  }
  const dwelling = tr.phase === 'dwell' || tr.phase === 'reversing';
  if (dwelling) dep = tr.dwellUntil;
  else if (tr.departureDisplay) dep = tr.departureDisplay.at ?? tr.departureDisplay.stop.dep ?? -1;
  // platform screen doors where the head stands
  let psd: DmiData['psd'] = 'none';
  const pi = topo.links[tr.link].platform;
  if (pi >= 0) {
    const ps = sim.plat[pi];
    psd = ps.psd === 'bypass' ? 'bypass' : ps.psd === 'closeFail' || ps.psdFault ? 'fault' : ps.psd === 'closed' ? 'closed' : 'open';
  }
  // stopping window indicator
  const err = stopError(sim, tr);
  let win: DmiData['stopWin'] = 'none';
  if (dwelling) win = 'aligned';
  else if (Number.isFinite(err) && tr.v < 0.05 && Math.abs(err) < 5) win = Math.abs(err) <= 0.5 ? 'aligned' : err > 0 ? 'short' : 'over';
  else if (Number.isFinite(tr.stopDist) && tr.stopDist < 600) win = 'ahead';
  const names = workingNames(sim, tr);
  const current = tr.departureDisplay?.stop ?? tr.tasks[0];
  let departureBoard: DmiData['departureBoard'];
  if (current?.k === 'stop') {
    const b = topo.berths[current.berth];
    const found = b.platform < 0 ? null : signalAheadFrom(sim, b.link, b.offset, b.dir);
    if (found) departureBoard = { at: dep, signalName: topo.signals[found.sig].name,
      signalOffset: found.dist, aspect: sim.sig[found.sig].aspect,
      held: tr.hold || sim.plat[b.platform].hold, headLeftAt: tr.departureDisplay?.headLeftAt,
      remaining: tr.departureDisplay?.remaining ?? err, side: tr.departureDisplay?.side ?? platformSide(sim, tr, b.platform), station: current.station };
  }
  const doorFault = tr.vfault?.kind === 'door' && tr.vfault.stage !== 'armed';
  return {
    train: id,
    trainNo: dmiTrainNo(tr.vehicle),
    vehicleType: fleetEntry(tr.vehicle)?.type ?? '',
    dest: names.dest,
    next: names.next,
    log: tr.dmiLog.slice().reverse(),
    dep,
    dwellTotal: dwelling ? Math.max(1, tr.dwellUntil - tr.phaseSince) : 0,
    avail: availableMode(sim, tr),
    psd,
    trainDoor: doorFault ? 'fault' : tr.doorMotion?.kind === 'closing' ? 'closing' : tr.doorsOpen || tr.doorSide ? 'open' : sim.t < (tr.doorLockedAt ?? 0) ? 'closing' : tr.doorsCut > 0 ? 'isolated' : 'closed',
    departureBoard,
    stopWin: win,
    vEbi: tr.vEbi,
    maDist: Number.isFinite(tr.maDist) ? tr.maDist : -1,
    date: calendarDate(sim.config.date, sim.t),
  };
}

/** Display the working actually being performed, without changing train tasks/MA. */
function workingNames(sim: Sim, tr: Train): { next: string; dest: string } {
  const name = (st: number) => STATIONS[st]?.dmiName ?? STATIONS[st]?.name ?? '—';
  const first = tr.tasks[0];
  const reverse = first?.k === 'reverse' ? first : tr.phase === 'dwell' && first?.k === 'stop' && tr.tasks[1]?.k === 'reverse' ? tr.tasks[1] : undefined;
  const after = reverse ? tr.tasks.slice(tr.tasks.indexOf(reverse) + 1).filter((t): t is StopTask => t.k === 'stop' && t.doors) : [];
  const offPlatform = reverse?.berths.some(b => sim.topo.berths[b].platform < 0);
  // Turning back in a tail or siding (用户确认): "X折" until the train stands
  // in the tail; from then until it stands at the departure platform, both
  // fields show that platform's station; only there the real terminus.
  if (reverse && offPlatform) {
    const shown = tr.phase === 'reversing' ? name(after[0]?.station ?? reverse.station) : name(reverse.station) + '折';
    return { next: shown, dest: shown };
  }
  // On the way to the departure platform of a working - out of the depot,
  // from an overnight or hot-standby place, or back from a tail turnback -
  // the train is not yet in passenger service (用户确认): both fields show
  // that platform's station until it stands there.
  const firstStop = tr.tasks.find((t): t is StopTask => t.k === 'stop' && t.doors);
  const origin = firstStop && sim.plan.trips[firstStop.trip]?.stops.find(x => x.stop)?.st;
  const pi = sim.topo.links[tr.link].platform;
  const atOrigin = firstStop !== undefined && pi >= 0 && sim.topo.platforms[pi].station === firstStop.station && tr.v < 0.05;
  if (firstStop && !atOrigin && (origin === firstStop.station
    || ((tr.tbStage === 'depart' || tr.tbStage === 'manual') && first === firstStop && firstStop.station === tr.lastStation))) {
    const shown = name(firstStop.station);
    return { next: shown, dest: shown };
  }
  const stops = tr.tasks.filter((t): t is StopTask => t.k === 'stop' && t.doors);
  const nextWorking = reverse && tr.phase === 'reversing' ? after[0] : undefined;
  const trip = nextWorking ? sim.plan.trips[nextWorking.trip] : undefined;
  let dest = trip ? name(serviceEnd(sim.plan, trip)) : tr.destStation >= 0 ? name(tr.destStation) : tr.destText || '—';
  if (nextWorking && !trip) dest = name(after.at(-1)?.station ?? tr.destStation);
  // A platform-only reversal changes at once to the next working: its next
  // call and real terminus (用户确认).
  const next = nextWorking ? after[1]
    : (tr.phase === 'dwell' || atOrigin) && first?.k === 'stop' && first.dep !== null ? stops[1] : stops[0];
  return { next: next ? name(next.station) : '—', dest };
}

function calendarDate(iso: string | undefined, t: number): string {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + Math.floor(t / 86400));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
}
