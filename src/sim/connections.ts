/**
 * Last-train connections at the interchanges (末班车换乘衔接), D63/D133.
 *
 * Two kinds, both from the other lines' published last trains
 * (src/data/current.ts), counted only where the timetables connect:
 *  - feed (他线 → 2号线): the last Line 2 train a transferring passenger from
 *    another line's last train can still take;
 *  - onward (2号线 → 他线): the last Line 2 arrival from which the other
 *    line's last train can be caught.
 * User decision: no line waits for another — stations announce the other
 * lines' first/last times and transfers are the passengers' own. A Line 2
 * train running late therefore just strands its transfer (an event, not a
 * dispatcher call). Passenger numbers are approximations.
 */
import type { Sim } from './engine';
import type { Connection, StopTask, TrackDir, Train } from './model';
export type { Connection };
import { STATIONS, LINE_INFO } from '../data/current';
import { OTHER_LAST_TRAINS } from '../data/current';
import { parseIso } from './calendar';
import { trainLabel } from './ats';

const DIR_NAME: Record<TrackDir, string> = { DN: '下行', UP: '上行' };

export function hhmm(t: number): string {
  return `${String(Math.floor(t / 3600) % 24).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`;
}

/** the day's connections, from the plan; passenger numbers on their own random stream */
export function initConnections(sim: Sim) {
  sim.connections = [];
  const date = sim.config.date ? parseIso(sim.config.date) : null;
  const friSat = !!date && (date.getDay() === 5 || date.getDay() === 6);
  let seed = (sim.config.seed ^ 0x1a57c0de) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const trips = sim.plan.trips.filter((t) => t.revenue);
  for (const e of OTHER_LAST_TRAINS) {
    const st = STATIONS.findIndex((s) => s.id === e.station);
    if (st < 0) continue;
    const time = friSat && e.friSat ? e.friSat : e.dep;
    const busy = STATIONS[st].demand ?? 1;
    for (const dir of ['DN', 'UP'] as TrackDir[]) {
      const calls = trips.filter((t) => t.dir === dir).map((t) => {
        const i = t.stops.findIndex((x) => x.st === st && x.stop);
        return { t, s: t.stops[i], first: i === 0, final: i === t.stops.length - 1 };
      }).filter((x) => !!x.s);
      // feed: the last Line 2 departure here, if the transfer reaches it by the timetables
      const boarding = calls.filter((x) => !x.s.noBoard && !x.final).sort((a, b) => a.s.dep - b.s.dep);
      const last = boarding[boarding.length - 1];
      if (last && time - 30 + e.walk <= last.s.dep) {
        sim.connections.push({ id: sim.connections.length, kind: 'feed', st, line: e.line, toward: e.toward, planned: time - 30,
          walk: e.walk, dir, trip: last.t.id, l2: last.s.dep, pax: Math.round((10 + rnd() * 30) * busy), state: 'pending' });
      }
      // onward: the last Line 2 arrival from which the other line's last train is caught
      const arriving = calls.filter((x) => !x.first && x.s.arr + e.walk <= time).sort((a, b) => a.s.arr - b.s.arr);
      const lastIn = arriving[arriving.length - 1];
      if (lastIn && time - lastIn.s.arr < 3600) {
        sim.connections.push({ id: sim.connections.length, kind: 'onward', st, line: e.line, toward: e.toward, planned: time,
          walk: e.walk, dir, trip: lastIn.t.id, l2: lastIn.s.arr, pax: Math.round((8 + rnd() * 25) * busy), state: 'pending' });
      }
    }
  }
}

const lineName = (c: Connection) => (/^\d+$/.test(c.line) ? `${c.line}号线` : c.line);
const subject = (c: Connection) => `${lineName(c)}往${c.toward}末班`;
const stName = (c: Connection) => STATIONS[c.st].name;

function miss(sim: Sim, c: Connection, why: string) {
  c.state = 'missed';
  sim.metrics.stranded += c.pax;
  sim.passengersStranded += c.pax;
  sim.log('I', '客流', `${stName(c)} 末班换乘未衔接：${why}，约 ${c.pax} 名换乘乘客滞留`, { key: `conn-${c.id}` });
}

/** a Line 2 train left a stop: settle the connections of that trip there */
export function connectionDeparture(sim: Sim, tr: Train, task: StopTask) {
  if (task.trip < 0) return;
  for (const c of sim.connections) {
    if (c.trip !== task.trip || c.st !== task.station || c.state === 'made' || c.state === 'missed' || c.state === 'void') continue;
    if (c.kind === 'feed') {
      // passengers of the other line's last train reach the platform at planned + walk
      if (sim.t + 1 >= c.planned + c.walk) c.state = 'made';
      else miss(sim, c, `${LINE_INFO.shortName}${DIR_NAME[c.dir]}末班 ${trainLabel(tr)} ${hhmm(sim.t)} 发车，${subject(c)}的换乘乘客 ${hhmm(c.planned + c.walk)} 才到站台`);
    } else {
      // the transfer walks from the arrival
      if (tr.arrivedAt + c.walk <= c.planned) c.state = 'made';
      else miss(sim, c, `${trainLabel(tr)} ${hhmm(tr.arrivedAt)} 到站，${subject(c)}已于 ${hhmm(c.planned)} 开出`);
    }
  }
}
