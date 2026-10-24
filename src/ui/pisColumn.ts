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
interface ColumnBoard { root: HTMLElement; track: TrackDir; station: number; clock: HTMLElement; date: HTMLElement; arrivals: HTMLElement[]; schedule: HTMLElement; loadHead: HTMLElement; cars: HTMLElement; route: HTMLElement; notice: HTMLElement; routePage: number }
interface ColumnState { key: string; boards: ColumnBoard[]; pis: PisData; t: number; date: string; timer: number }
const states = new WeakMap<HTMLElement, ColumnState>();

function build(station: number, track: TrackDir): ColumnBoard {
  const st = STATIONS[station], clock = h('b'), date = h('small');
  const arrivals = Array.from({ length: 3 }, (_, i) => h('div', { class: `pc-arrival pc-arrival-${i}`, 'data-rank': String(i + 1) }));
  const schedule = h('div', { class: 'pc-schedule' }), cars = h('div', { class: 'pc-cars' }), route = h('div', { class: 'pc-route' }), notice = h('div', { class: 'pc-notice' });
  const loadHead = h('div', { class: 'pc-load-head' });
  const root = h('div', { class: 'pis-column', style: `--column-line:${LINE.ui.pisColorCss}` },
    h('div', { class: 'pc-head' }, h('div', { class: 'pc-line' }, LINE.branding.shortName, h('small', {}, LINE.ui.lineNameEn)),
      h('div', { class: 'pc-station' }, st.name, h('small', {}, STATION_EN[st.id] ?? '')), h('div', { class: 'pc-clock' }, clock, date)),
    h('div', { class: 'pc-arrivals' }, ...arrivals), schedule,
    loadHead, cars, route,
    h('div', { class: 'pc-media' }, h('div', {}, '文明乘车　安全出行'), h('small', {}, '请先下后上，照顾身边有需要的乘客')), notice);
  return { root, track, station, clock, date, arrivals, schedule, loadHead, cars, route, notice, routePage: -1 };
}

function update(state: ColumnState) {
  for (const board of state.boards) {
    const rows = state.pis[board.track];
    board.loadHead.textContent = `即将到达 · 拥挤度${rows[0] ? `　终点站：${rows[0].dest}` : ''}`;
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
      el.replaceChildren(h('div', { class: 'pc-rank' }, `${['第一', '第二', '第三'][i]}班列车`, h('small', {}, ['1st', '2nd', '3rd'][i])),
        h('strong', { class: 'pc-countdown' }, row ? formatPisCountdown(row) : '--:--'),
        h('div', { class: 'pc-destination' }, row ? row.noBoard ? `本站只下不上 · ${row.dest}` : `开往 ${row.dest} 方向` : '等待列车信息',
          h('small', {}, row ? `To ${STATION_EN[STATIONS[row.destSt]?.id] ?? row.dest}` : 'Waiting for train information')));
    }
    const timetable = selectPisFirstLast(STATIONS[board.station].name, board.track, rows[0])[0];
    const scheduleKey = JSON.stringify(timetable);
    if (board.schedule.dataset.content !== scheduleKey) {
      board.schedule.dataset.content = scheduleKey;
      board.schedule.replaceChildren(h('div', { class: 'pc-direction' }, `开往 ${timetable?.destination ?? '—'} 方向`),
        h('div', {}, h('span', {}, '首班车', h('small', {}, 'The First Train')), h('b', {}, timetable?.first ?? '--:--')),
        h('div', {}, h('span', {}, '末班车', h('small', {}, 'The Last Train')), h('b', {}, timetable?.last ?? '--:--')));
    }
    const loads = rows[0]?.carLoads ?? [];
    const loadKey = JSON.stringify(loads);
    if (board.cars.dataset.content !== loadKey) {
      board.cars.dataset.content = loadKey;
      board.cars.replaceChildren(...Array.from({ length: LINE.core.LINE_INFO.cars ?? 8 }, (_, i) => {
        const load = loads[i];
        return h('div', { class: `pc-car${i === 0 || i === (LINE.core.LINE_INFO.cars ?? 8) - 1 ? ' pc-cab' : ''}`, style: `--car-load:${load === undefined ? '#526773' : load >= .9 ? '#cb3f3d' : load > .75 ? '#e8b930' : '#70be4d'}` },
          h('small', {}, `${i + 1}`), h('b', {}, load === undefined ? '--' : load < .05 ? '<5%' : `${Math.round(load * 100)}%`));
      }));
    }
    const pages = columnRoutePages(board.station, board.track);
    // 【假设】实拍未测分页周期，每 8 秒切换；使用墙钟，不随仿真倍速加快。
    const page = Math.floor(performance.now() / SIMULATION.pis.timing.pageMs) % Math.max(1, pages.length);
    if (page !== board.routePage) {
      board.routePage = page;
      board.route.replaceChildren(...(pages[page] ?? []).map(st => h('div', { class: `pc-stop${st === board.station ? ' pc-here' : ''}` },
        h('i'), h('span', {}, STATIONS[st].name), h('div', { class: 'pc-transfers' }, ...STATIONS[st].transfers.map(line => h('b', { style: `background:#${(LINE.ui.transferColors[line] ?? 0x666666).toString(16).padStart(6, '0')}` }, line))))), h('b', { class: 'pc-forward', title: '前方' }, '→'));
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
