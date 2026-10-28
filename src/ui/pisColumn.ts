/** Column hardware: simultaneous three departures above first/last, eight cars and paged route. */
import { h, clear } from './dom';
import './pisColumn.css';
import { LINE, STATIONS, STATION_EN, SIMULATION, stationOpened } from '../data/current';
import type { PisData, TrackDir } from '../sim/model';
import { formatPisCountdown, selectPisFirstLast } from '../sim/pis';
import { stationRange, downstreamTerminal } from '../sim/topology';

/** Only passenger stations, in travel order. The last page is allowed fewer than five. */
export function columnRoutePages(station: number, track: TrackDir): number[][] {
  const route = stationRange(track, station, downstreamTerminal(track)).filter(stationOpened);
  return Array.from({ length: Math.ceil(route.length / 5) }, (_, i) => route.slice(i * 5, i * 5 + 5));
}

const pad = (n: number) => String(n).padStart(2, '0');
const en = (station: number | undefined) => station === undefined ? '' : STATION_EN[STATIONS[station]?.id] ?? '';
interface ColumnBoard { root: HTMLElement; track: TrackDir; station: number; clock: HTMLElement; date: HTMLElement; arrivals: HTMLElement[]; schedule: HTMLElement; loadHead: HTMLElement; cars: HTMLElement; route: HTMLElement; notice: HTMLElement; routePage: number }
interface ColumnState { key: string; boards: ColumnBoard[]; pis: PisData; t: number; date: string; timer: number }
const states = new WeakMap<HTMLElement, ColumnState>();

/** Layout follows the Xiepu Road column (reference/line14/line14-field-pis-2026-10-22.md). */
function build(station: number, track: TrackDir): ColumnBoard {
  const st = STATIONS[station], clock = h('b', { class: 'pc-seg' }), date = h('small');
  const arrivals = Array.from({ length: 3 }, (_, i) => h('div', { class: `pc-arrival pc-arrival-${i}`, 'data-rank': String(i + 1) }));
  const schedule = h('div', { class: 'pc-schedule' }), cars = h('div', { class: 'pc-cars' }), route = h('div', { class: 'pc-route' }), notice = h('div', { class: 'pc-notice' });
  const loadHead = h('div', { class: 'pc-load-head' });
  const lineNo = /\d+/.exec(LINE.branding.shortName)?.[0] ?? LINE.branding.shortName;
  const root = h('div', { class: 'pis-column', style: `--column-line:${LINE.ui.pisColorCss}` },
    h('div', { class: 'pc-head' },
      h('div', { class: 'pc-box pc-line' }, h('b', {}, lineNo), h('span', {}, '号线', h('small', {}, LINE.ui.lineNameEn))),
      h('div', { class: 'pc-box pc-station' }, st.name, h('small', {}, STATION_EN[st.id] ?? '')),
      h('div', { class: 'pc-box pc-clock' }, clock, date)),
    h('div', { class: 'pc-arrivals' }, ...arrivals), schedule,
    loadHead, cars, route,
    h('div', { class: 'pc-media' }, h('div', {}, '文明乘车　安全出行'), h('small', {}, '请先下后上，照顾身边有需要的乘客'), notice));
  return { root, track, station, clock, date, arrivals, schedule, loadHead, cars, route, notice, routePage: -1 };
}

/** 「开往 X 方向」with the English line beneath 开往 and the name, as photographed. */
function towards(dest: string, destSt: number | undefined) {
  return h('div', { class: 'pc-destination' },
    h('span', {}, '开往', h('small', {}, 'To')), h('span', {}, dest, h('small', {}, en(destSt))), h('span', {}, '方向', h('small', {}, ' ')));
}

function update(state: ColumnState) {
  for (const board of state.boards) {
    const rows = state.pis[board.track];
    const loadKey0 = rows[0]?.dest ?? '';
    if (board.loadHead.dataset.content !== loadKey0) {
      board.loadHead.dataset.content = loadKey0;
      board.loadHead.replaceChildren(h('span', {}, h('i'), '即将到达'), h('span', {}, '拥挤度'), h('span', {}, rows[0] ? `终点站： ${rows[0].dest}` : ''));
    }
    const tod = state.t % 86400;
    board.clock.textContent = `${pad(Math.floor(tod / 3600))}:${pad(Math.floor(tod % 3600 / 60))}`;
    const iso = /\d{4}-\d{2}-\d{2}/.exec(state.date)?.[0];
    const date = iso ? new Date(`${iso}T00:00:00Z`) : null;
    if (date) { date.setUTCDate(date.getUTCDate() + Math.floor(state.t / 86400)); board.date.textContent = `${date.getUTCMonth() + 1}月${date.getUTCDate()}日 周${'日一二三四五六'[date.getUTCDay()]}`; }
    for (const [i, el] of board.arrivals.entries()) {
      const row = rows[i], key = `${row?.dest}|${row?.status}|${row?.noBoard}|${formatPisCountdown(row)}`;
      if (el.dataset.content === key) continue;
      el.dataset.content = key;
      el.classList.toggle('pc-countdown-long', !!row && row.eta > 3600 && row.status === 'eta');
      el.replaceChildren(h('div', { class: 'pc-rank' }, `${['第一', '第二', '第三'][i]}班列车（${['1st', '2nd', '3rd'][i]}）`),
        h('strong', { class: 'pc-countdown' }, row ? formatPisCountdown(row) : '--:--'),
        row ? row.noBoard ? h('div', { class: 'pc-destination' }, `本站只下不上 · ${row.dest}`) : towards(row.dest, row.destSt)
          : h('div', { class: 'pc-destination' }, '等待列车信息'));
    }
    const timetable = selectPisFirstLast(STATIONS[board.station].name, board.track, rows[0])[0];
    const scheduleKey = JSON.stringify(timetable);
    if (board.schedule.dataset.content !== scheduleKey) {
      board.schedule.dataset.content = scheduleKey;
      // the photographed row names the line terminal of this platform (开往 封浜 方向), not the next train's
      const terminal = downstreamTerminal(board.track);
      board.schedule.replaceChildren(towards(STATIONS[terminal].name, terminal),
        h('div', {}, h('span', {}, '首班车', h('small', {}, 'The First Train')), h('b', { class: 'pc-seg' }, timetable?.first ?? '--:--')),
        h('div', {}, h('span', {}, '末班车', h('small', {}, 'The Last Train')), h('b', { class: 'pc-seg' }, timetable?.last ?? '--:--')));
    }
    const loads = rows[0]?.carLoads ?? [];
    const loadKey = JSON.stringify(loads);
    if (board.cars.dataset.content !== loadKey) {
      board.cars.dataset.content = loadKey;
      board.cars.replaceChildren(h('div', { class: 'pc-cab' }, h('i')), ...Array.from({ length: LINE.core.LINE_INFO.cars ?? 8 }, (_, i) => {
        const load = loads[i];
        return h('div', { class: 'pc-car', style: `--car-load:${load === undefined ? '#7d8d96' : load >= .9 ? '#e0453f' : load > .75 ? '#f0c23a' : '#62d548'}` },
          load === undefined ? '--' : load < .05 ? '<5%' : `${Math.round(load * 100)}%`);
      }), h('div', { class: 'pc-cab' }, h('i')));
    }
    const pages = columnRoutePages(board.station, board.track);
    // 【假设】实拍未测分页周期，每 8 秒切换；使用墙钟，不随仿真倍速加快。
    const page = Math.floor(performance.now() / SIMULATION.pis.timing.pageMs) % Math.max(1, pages.length);
    if (page !== board.routePage) {
      board.routePage = page;
      const badge = (line: string) => h('b', {}, line);
      board.route.replaceChildren(...(pages[page] ?? []).flatMap((st, i) => {
        // transfer circles alternate below/above the pills; a second line goes to the other side
        const lines = STATIONS[st].transfers, above = i % 2 === 1 || lines.length > 1;
        const stop = h('div', { class: `pc-stop${st === board.station ? ' pc-here' : ''}` },
          h('div', { class: 'pc-transfers pc-above' }, ...(above ? lines.slice(0, 1) : []).map(badge)),
          h('span', {}, STATIONS[st].name.replace('·', '')),
          h('div', { class: 'pc-transfers pc-below' }, ...(above ? lines.slice(1) : lines).map(badge)));
        // chevrons on the line point the way the train runs
        return [h('i', { class: 'pc-chev' }, '>>>'), stop];
      }), h('i', { class: 'pc-chev' }, '>>>'));
    }
    board.notice.textContent = state.pis.notice;
  }
}

export function renderColumnPis(el: HTMLElement, pis: PisData | null, t: number, date = '', track?: TrackDir) {
  let state = states.get(el);
  if (!pis) { if (state) clearInterval(state.timer); states.delete(el); clear(el); el.append(h('div', { class: 'hint' }, '等待数据…')); return; }
  const key = `${pis.station}:${track ?? '*'}`;
  if (!state || state.key !== key) {
    if (state) clearInterval(state.timer);
    clear(el);
    const boards = (track ? [track] : ['DN', 'UP'] as TrackDir[]).map(dir => build(pis.station, dir));
    el.append(...boards.map(b => b.root));
    state = { key, boards, pis, t, date, timer: 0 };
    const owned = state;
    owned.timer = window.setInterval(() => { if (!el.isConnected) { clearInterval(owned.timer); states.delete(el); return; } update(owned); }, 250);
    states.set(el, state);
  }
  state.pis = pis; state.t = t; state.date = date; update(state);
}
