/**
 * Banner hardware above the platform doors: media and notice strip on the left,
 * three departures with the car loads in the middle, and a vertically scrolling
 * route map over the first/last box on the right. Layout follows the Pudong
 * Avenue photograph and the Zhenru clip (reference/line14/field, 2026-10-25).
 */
import { h, clear } from './dom';
import './pisBanner.css';
import { LINE, STATIONS, STATION_EN, stationOpened } from '../data/current';
import type { PisData, TrackDir } from '../sim/model';
import { formatPisCountdown, selectPisFirstLast } from '../sim/pis';
import { stationRange, downstreamTerminal } from '../sim/topology';

/** stops shown at once in the route window, as photographed */
const ROUTE_SLOTS = 5;
/** Measured from the Zhenru clip: the map moves about one stop every 4 s, continuously. */
const ROUTE_STOP_MS = 4000;

const pad = (n: number) => String(n).padStart(2, '0');
const en = (station: number | undefined) => station === undefined ? '' : STATION_EN[STATIONS[station]?.id] ?? '';

/** Stops still ahead, nearest first. 【假设】循环从下一站起、到终点站进入窗口顶部后从头再滚，实拍未录到循环点。 */
export function bannerRouteStops(station: number, track: TrackDir): number[] {
  return stationRange(track, station, downstreamTerminal(track)).filter(i => i !== station && stationOpened(i));
}

/** which side of the pill each transfer circle sits on (photographed per station; otherwise alternating) */
function badgeSides(st: number, k: number): { left: string[]; right: string[] } {
  const known = LINE.ui.pisRouteBadges?.[STATIONS[st].name];
  if (known) return { left: known[0], right: known[1] };
  const lines = STATIONS[st].transfers;
  // 【假设】未实拍的车站：单条换乘线左右交替，多条时末一条放右侧
  if (lines.length > 1) return { left: lines.slice(0, -1), right: lines.slice(-1) };
  return k % 2 ? { left: [], right: lines } : { left: lines, right: [] };
}

interface BannerBoard { root: HTMLElement; track: TrackDir; station: number; clock: HTMLElement; date: HTMLElement; arrivals: HTMLElement[]; schedule: HTMLElement; loadHead: HTMLElement; cars: HTMLElement; ticker: HTMLElement }
interface BannerState { key: string; boards: BannerBoard[]; pis: PisData; t: number; date: string; timer: number }
const states = new WeakMap<HTMLElement, BannerState>();

function routeMap(station: number, track: TrackDir): HTMLElement {
  const stops = bannerRouteStops(station, track);
  const strip = h('div', { class: 'ph-strip', style: `--stops:${stops.length}` }, ...stops.map((st, k) => {
    const { left, right } = badgeSides(st, k);
    const badges = (lines: string[]) => lines.map(l => h('b', {}, l));
    return h('div', { class: `ph-stop${left.length ? ' ph-l' : ''}${right.length ? ' ph-r' : ''}` },
      h('div', { class: 'ph-badges' }, ...badges(left)),
      h('span', {}, STATIONS[st].name),
      h('div', { class: 'ph-badges' }, ...badges(right)));
  }));
  const shift = stops.length - ROUTE_SLOTS;
  if (shift > 0 && typeof strip.animate === 'function') {
    // on the wall clock, so every board shows the same position whatever the sim speed
    const a = strip.animate([{ transform: 'none' }, { transform: `translateY(${shift / stops.length * 100}%)` }],
      { duration: shift * ROUTE_STOP_MS, iterations: Infinity, easing: 'linear' });
    a.currentTime = performance.now() % (shift * ROUTE_STOP_MS);
  }
  return h('div', { class: 'ph-route' }, strip);
}

function build(station: number, track: TrackDir): BannerBoard {
  const st = STATIONS[station], clock = h('b', { class: 'ph-seg' }), date = h('small');
  const arrivals = Array.from({ length: 3 }, (_, i) => h('div', { class: `ph-box ph-arrival ph-arrival-${i}` }));
  const schedule = h('div', { class: 'ph-box ph-schedule' }), cars = h('div', { class: 'ph-cars' }), loadHead = h('div', { class: 'ph-load-head' });
  const ticker = h('div', { class: 'ph-ticker' });
  const lineNo = /\d+/.exec(LINE.branding.shortName)?.[0] ?? LINE.branding.shortName;
  const root = h('div', { class: 'pis-banner', style: `--banner-line:${LINE.ui.pisColorCss}` },
    h('div', { class: 'ph-media' }, h('div', { class: 'ph-ad' }, h('div', {}, '文明乘车　安全出行'), h('small', {}, '请先下后上，照顾身边有需要的乘客')), ticker),
    h('div', { class: 'ph-center' },
      h('div', { class: 'ph-head' },
        h('div', { class: 'ph-box ph-line' }, h('b', {}, lineNo), h('span', {}, '号线', h('small', {}, LINE.ui.lineNameEn))),
        h('div', { class: 'ph-box ph-station' }, st.name, h('small', {}, STATION_EN[st.id] ?? '')),
        h('div', { class: 'ph-box ph-clock' }, clock, date)),
      h('div', { class: 'ph-arrivals' }, ...arrivals),
      h('div', { class: 'ph-load' }, loadHead, cars)),
    h('div', { class: 'ph-right' }, routeMap(station, track), schedule));
  return { root, track, station, clock, date, arrivals, schedule, loadHead, cars, ticker };
}

/** 「开往 X 方向」; the first box and the first/last box carry the English line beneath. */
function towards(dest: string, destSt: number | undefined) {
  return h('div', { class: 'ph-destination' },
    h('span', {}, '开往', h('small', {}, 'To')), h('span', { class: 'ph-dest' }, dest, h('small', {}, en(destSt))), h('span', {}, '方向'));
}

function update(state: BannerState) {
  const tod = state.t % 86400;
  const iso = /\d{4}-\d{2}-\d{2}/.exec(state.date)?.[0];
  const day = iso ? new Date(`${iso}T00:00:00Z`) : null;
  if (day) day.setUTCDate(day.getUTCDate() + Math.floor(state.t / 86400));
  for (const board of state.boards) {
    const rows = state.pis[board.track];
    board.clock.textContent = `${pad(Math.floor(tod / 3600))}:${pad(Math.floor(tod % 3600 / 60))}`;
    board.date.textContent = day ? `${day.getUTCMonth() + 1}月${day.getUTCDate()}日 周${'日一二三四五六'[day.getUTCDay()]}` : '';
    for (const [i, el] of board.arrivals.entries()) {
      const row = rows[i], key = `${row?.dest}|${row?.status}|${row?.noBoard}|${formatPisCountdown(row)}`;
      if (el.dataset.content === key) continue;
      el.dataset.content = key;
      el.classList.toggle('ph-countdown-long', !!row && row.eta > 3600 && row.status === 'eta');
      el.replaceChildren(h('div', { class: 'ph-rank' }, `${['第一', '第二', '第三'][i]}班列车（${['1st', '2nd', '3rd'][i]}）`),
        h('strong', { class: 'ph-countdown' }, row ? formatPisCountdown(row) : '--:--'),
        row ? row.noBoard ? h('div', { class: 'ph-destination' }, `本站只下不上 · ${row.dest}`) : towards(row.dest, row.destSt)
          : h('div', { class: 'ph-destination' }, '等待列车信息'));
    }
    const headKey = rows[0]?.dest ?? '';
    if (board.loadHead.dataset.content !== headKey) {
      board.loadHead.dataset.content = headKey;
      board.loadHead.replaceChildren(h('span', {}, h('i'), '即将到达'), h('span', {}, '拥挤度'), h('span', {}, rows[0] ? `终点站：${rows[0].dest}` : ''));
    }
    const loads = rows[0]?.carLoads ?? [];
    const loadKey = JSON.stringify(loads);
    if (board.cars.dataset.content !== loadKey) {
      board.cars.dataset.content = loadKey;
      board.cars.replaceChildren(h('div', { class: 'ph-cab' }, h('i')), ...Array.from({ length: LINE.core.LINE_INFO.cars ?? 8 }, (_, i) => {
        const load = loads[i];
        return h('div', { class: 'ph-car', style: `--car-load:${load === undefined ? '#7d8d96' : load >= .9 ? '#e0453f' : load > .75 ? '#f0c23a' : '#b9ec3c'}` },
          load === undefined ? '--' : load < .05 ? '<5%' : `${Math.round(load * 100)}%`);
      }), h('div', { class: 'ph-cab' }, h('i')));
    }
    const timetable = selectPisFirstLast(STATIONS[board.station].name, board.track, rows[0])[0];
    const scheduleKey = JSON.stringify(timetable);
    if (board.schedule.dataset.content !== scheduleKey) {
      board.schedule.dataset.content = scheduleKey;
      // like the column: the platform's line terminal, not the next train's destination
      const terminal = downstreamTerminal(board.track);
      board.schedule.replaceChildren(towards(STATIONS[terminal].name, terminal),
        h('div', { class: 'ph-times' },
          h('div', {}, h('span', {}, '首班车', h('small', {}, 'The First Train')), h('b', { class: 'ph-seg' }, timetable?.first ?? '--:--')),
          h('div', {}, h('span', {}, '末班车', h('small', {}, 'The Last Train')), h('b', { class: 'ph-seg' }, timetable?.last ?? '--:--'))));
    }
    if (board.ticker.textContent !== state.pis.notice) board.ticker.replaceChildren(...(state.pis.notice ? [h('span', {}, state.pis.notice)] : []));
  }
}

export function renderBannerPis(el: HTMLElement, pis: PisData | null, t: number, date = '', track?: TrackDir) {
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
