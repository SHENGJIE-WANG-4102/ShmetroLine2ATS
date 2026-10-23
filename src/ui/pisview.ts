/**
 * Platform passenger information display (PIS), laid out like the Line 2
 * platform screens: a media area on the left with the scrolling notice bar
 * beneath it, and three boxes on the right — the first train's countdown
 * (always shown), the second / third trains and first / last pages. The western
 * extension's wide screens keep first / last times in their own column (D86).
 *
 * The board is updated in place: rebuilding it on every snapshot restarted
 * the notice ticker, which then only ever showed its first half glyph. A box
 * whose content turns to another train (the first one left, the 2nd / 3rd
 * rotation) or to the other info page pushes the old content out to the left
 * while the new one comes in from the right. The clock / station box rolls
 * vertically and fades between pages.
 */
import { h, clear } from './dom';
import type { PisData, PisRow, TrackDir } from '../sim/model';
import { LINE, STATIONS, STATION_EN, DIRECTIONS } from '../data/current';
import { advancePisCycle, formatPisCountdown, selectPisFirstLast, PIS_TIMING, type PisCycleState, type PisFirstLast } from '../sim/pis';
import metroLogo from './assets/metro-logo.png';
import { stationRange, downstreamTerminal } from '../sim/topology';
import { lineBadge } from './branding';

const ORD = ['1st', '2nd', '3rd'];
const ORD_CN = ['第一班列车', '第二班列车', '第三班列车'];
const pad = (n: number) => String(n).padStart(2, '0');

function loadText(f: number): string {
  if (f >= .9) return '拥挤';
  if (f > 0.75) return '较拥挤';
  return '舒适';
}

/** calendar date of sim time t (t may run past midnight) from the day label */
function dateOf(label: string, t: number): string {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(label);
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + Math.floor(t / 86400)));
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

interface Box { el: HTMLElement; title: HTMLElement; digits: HTMLElement; dest: HTMLElement; to: HTMLElement; toEn: HTMLElement; key: string }
interface Board {
  station: number; track: TrackDir; root: HTMLElement;
  wide: boolean; cycle: PisCycleState; firstLastCycle: PisCycleState;
  schedule?: Box;
  load: HTMLElement; ticker: HTMLElement; tickerText: string;
  b1: Box; b2: Box; b3: HTMLElement;
  rows: PisRow[]; t: number; dateLabel: string;
  /** passed by every train; next planned departure; a departure already went */
  skip: boolean; next?: number; done: boolean; ahead: number;
}

function mkBox(): Box {
  const title = h('div', { class: 'pb-title' });
  const digits = h('div', { class: 'pb-digits' });
  const to = h('div', { class: 'pb-to' });
  const toEn = h('div', { class: 'pb-to-en' });
  const dest = h('div', { class: 'pb-dest' }, to, toEn);
  return { el: h('div', { class: 'pb' }, title, digits, dest), title, digits, dest, to, toEn, key: '' };
}

const SLIDE: KeyframeAnimationOptions = { duration: PIS_TIMING.slideMs, easing: 'linear' };

/**
 * Change the content of `els` (children of one box) with `fill`: a copy of
 * the old content leaves to the left over the new content entering from the
 * right. `fill` returns the new elements when it replaces `els` instead of
 * updating them in place.
 */
function slide(els: HTMLElement[], fill: () => HTMLElement[] | void, vertical = false) {
  const ghosts = els.filter((e) => typeof e.animate === 'function' && e.offsetWidth > 0).map((e) => {
    const g = e.cloneNode(true) as HTMLElement;
    g.classList.add('pis-ghost');
    Object.assign(g.style, {
      position: 'absolute', left: `${e.offsetLeft}px`, top: `${e.offsetTop}px`, width: `${e.offsetWidth}px`, height: `${e.offsetHeight}px`,
      margin: '0', pointerEvents: 'none',
    });
    e.parentElement!.append(g);
    // measured now: `fill` may take `e` out of the page. Clear of the box: its own right edge past the box's left edge
    return { g, out: vertical ? e.offsetTop + e.offsetHeight + 4 : e.offsetLeft + e.offsetWidth + 4 };
  });
  const fresh = fill() ?? els;
  for (const { g, out } of ghosts) {
    // held off-box at the end and removed then: on the animation's own clock, so it never vanishes mid-slide
    const a = g.animate([
      { transform: 'none', opacity: 1 },
      { transform: `translate${vertical ? 'Y' : 'X'}(${-out}px)`, opacity: vertical ? 0 : 1 },
    ], { ...SLIDE, ...(vertical ? { duration: PIS_TIMING.footerSlideMs } : {}), fill: 'forwards' });
    a.onfinish = a.oncancel = () => g.remove();
  }
  if (!ghosts.length) return;
  for (const e of fresh) {
    if (typeof e.animate !== 'function') continue;
    // in from just past the box's right edge (offsets are within the positioned box)
    const parent = e.offsetParent as HTMLElement | null;
    const from = vertical ? (parent?.clientHeight ?? e.offsetHeight) - e.offsetTop + 4 : (parent?.clientWidth ?? e.offsetWidth) - e.offsetLeft + 4;
    e.animate([
      { transform: `translate${vertical ? 'Y' : 'X'}(${from}px)`, opacity: vertical ? 0 : 1 },
      { transform: 'none', opacity: 1 },
    ], { ...SLIDE, ...(vertical ? { duration: PIS_TIMING.footerSlideMs } : {}) });
  }
}

const englishScrolls = new WeakMap<HTMLElement, { width: number; textWidth: number; animation?: Animation }>();

/** Measure after layout: short names stay still; overflow enters from the right. */
function fillEnglish(el: HTMLElement, text: string, prefix = '') {
  if (el.dataset.text !== text || el.dataset.prefix !== prefix || !el.firstElementChild) {
    englishScrolls.get(el)?.animation?.cancel();
    englishScrolls.delete(el);
    el.dataset.text = text; el.dataset.prefix = prefix;
    el.replaceChildren(h('span', { class: 'pb-prefix' }, prefix), h('span', { class: 'pb-en-window' }, h('span', {}, text)));
  }
  const window = el.lastElementChild as HTMLElement;
  const span = window.firstElementChild as HTMLElement;
  const width = window.clientWidth, textWidth = span.offsetWidth;
  const old = englishScrolls.get(el);
  if (old?.width === width && old.textWidth === textWidth) return;
  old?.animation?.cancel();
  const animation = width > 0 && textWidth > width && typeof span.animate === 'function' ? span.animate([
    { transform: `translateX(${width}px)` }, { transform: `translateX(${-textWidth}px)` },
  ], { duration: (width + textWidth) / Math.max(1, width * PIS_TIMING.englishWidthsPerSecond) * 1000, iterations: Infinity, easing: 'linear' }) : undefined;
  englishScrolls.set(el, { width, textWidth, animation });
}

function destinationEnglish(r: PisRow | undefined): string {
  return r && r.destSt >= 0 ? STATION_EN[STATIONS[r.destSt].id] ?? '' : '';
}

/** Measure with the secondary column's actual font and width, including font fallback. */
const overflowCache = new Map<string, boolean>();
function englishOverflows(b: Box, row: PisRow | undefined): boolean {
  if (!row) return false;
  const window = b.toEn.lastElementChild as HTMLElement | null;
  if (!window || window.clientWidth <= 0) return false;
  // measured once per text and column width: the board updates every 50 ms
  const text = destinationEnglish(row), key = `${text}|${window.clientWidth}`;
  const known = overflowCache.get(key);
  if (known !== undefined) return known;
  const measure = h('span', { class: 'pb-measure' }, text);
  window.append(measure);
  const overflow = measure.getBoundingClientRect().width > window.clientWidth;
  measure.remove();
  overflowCache.set(key, overflow);
  return overflow;
}

function fillBox(b: Box, k: number, r: PisRow | undefined) {
  const key = `${k}|${r?.trip ?? ''}|${r?.dest ?? ''}`;
  if (b.key && key !== b.key) {
    const els = [...(b.key.startsWith(`${k}|`) ? [] : [b.title]), b.digits, b.dest];
    b.key = key;
    slide(els, () => fillBox(b, k, r));
    return;
  }
  b.key = key;
  b.el.classList.remove('first-last');
  b.digits.classList.remove('pb-timetable');
  b.dest.hidden = false;
  b.title.textContent = `${ORD_CN[k]}(${ORD[k]})`;
  b.digits.textContent = formatPisCountdown(r);
  b.digits.classList.toggle('long', !!r && r.status === 'eta' && r.eta > 3600);
  b.el.classList.toggle('arr', !!r && r.status !== 'eta');
  if (!r) { b.to.replaceChildren(h('span', {}, '开往'), h('span')); fillEnglish(b.toEn, '', 'To'); return; }
  if (r.noBoard) { b.to.textContent = `本次列车只下不上（往${r.dest}）`; fillEnglish(b.toEn, 'Alighting only, please do not board'); return; }
  b.to.innerHTML = '';
  b.to.append(h('span', {}, '开往'), h('span', {}, r.dest));
  fillEnglish(b.toEn, destinationEnglish(r), 'To');
}

function fillFirstLast(b: Box, row: PisFirstLast | undefined, wide = false) {
  const key = `first-last|${JSON.stringify(row)}`;
  if (b.key === key) return;
  if (b.key) {
    b.key = '';
    slide([b.title, b.digits, b.dest], () => fillFirstLast(b, row, wide));
    return;
  }
  b.key = key;
  b.el.classList.add('first-last');
  b.el.classList.remove('arr');
  b.digits.classList.remove('long');
  b.digits.classList.add('pb-timetable');
  b.dest.hidden = false;
  b.title.replaceChildren(
    h('span', {}, '首班车', h('small', {}, 'The First Train')),
    h('span', {}, '末班车', h('small', {}, 'The Last Train')),
  );
  clear(b.digits);
  clear(b.to);
  fillEnglish(b.toEn, '');
  if (!row) { b.digits.append(h('div', { class: 'pb-times-empty' }, '暂无首末班信息')); return; }
  b.digits.append(h('div', { class: 'pb-times-values' }, h('span', {}, row.first), h('span', {}, row.last)));
  b.to.append(h('span', {}, '开往'), h('span', {}, row.destination));
  const dest = STATIONS.find((s) => s.name === row.destination);
  fillEnglish(b.toEn, dest ? STATION_EN[dest.id] ?? '' : '', 'To');
  if (wide) b.el.classList.add('pb-schedule');
}

function update(bd: Board) {
  const now = performance.now();
  const { rows } = bd;
  fillBox(bd.b1, 0, rows[0]);
  const times = selectPisFirstLast(STATIONS[bd.station].name, bd.track, rows[0]);
  // Prime the English window before measuring its secondary-column width.
  if (!bd.b2.toEn.firstElementChild) fillEnglish(bd.b2.toEn, destinationEnglish(rows[1]), 'To');
  const pages = rows[2] ? [1, 2] : [1];
  const durations = pages.map((k) => englishOverflows(bd.b2, rows[k]) ? PIS_TIMING.scrollingPageMs : PIS_TIMING.pageMs);
  if (!bd.wide) durations.push(...Array(Math.max(1, times.length)).fill(PIS_TIMING.pageMs));
  bd.cycle = advancePisCycle(bd.cycle, now, durations);
  const page = bd.cycle.page;
  if (page >= pages.length) fillFirstLast(bd.b2, times[page - pages.length]);
  else { const k = pages[page]; fillBox(bd.b2, k, rows[k]); }
  if (bd.schedule) {
    bd.firstLastCycle = advancePisCycle(bd.firstLastCycle, now, Array(Math.max(1, times.length)).fill(PIS_TIMING.pageMs));
    fillFirstLast(bd.schedule, times[bd.firstLastCycle.page], true);
  }
  // Wide hardware always keeps the clock and station header visible.
  const showClock = bd.wide || Math.floor(now / PIS_TIMING.footerMs) % 2 === 0;
  const want = showClock ? `clock` : `name`;
  if (bd.b3.dataset.mode !== want) {
    const old = infoContent(bd);
    bd.b3.dataset.mode = want;
    if (old.length) { slide(old, () => { for (const e of old) e.remove(); fillInfo(bd, showClock); return infoContent(bd); }, true); return void fillLoad(bd); }
  }
  fillInfo(bd, showClock);
  fillLoad(bd);
}

/** what the info box shows, without the copies still sliding out */
function infoContent(bd: Board): HTMLElement[] {
  return (Array.from(bd.b3.children) as HTMLElement[]).filter((e) => !e.classList.contains('pis-ghost'));
}

/** the clock / station-name box */
function fillInfo(bd: Board, showClock: boolean) {
  const { t } = bd;
  const st = STATIONS[bd.station];
  if (showClock) {
    const tod = t % 86400;
    const txt = `${pad(Math.floor(tod / 3600))}:${pad(Math.floor(tod % 3600 / 60))}`;
    // clock and date share a baseline; the row itself is centred in the box
    if (!infoContent(bd).length) bd.b3.append(h('div', { class: 'pb-clockrow' }, h('span', { class: 'pb-clock' }), h('span', { class: 'pb-date' })));
    const row = infoContent(bd)[0];
    (row.children[0] as HTMLElement).textContent = txt;
    (row.children[1] as HTMLElement).textContent = dateOf(bd.dateLabel, t);
  } else if (!infoContent(bd).length) {
    bd.b3.append(h('div', { class: 'pb-st' }, st.name), h('div', { class: 'pb-st-en' }, STATION_EN[st.id] ?? ''));
  }
}

function fillLoad(bd: Board) {
  const r = bd.rows[0];
  bd.load.textContent = r?.destSt === bd.station ? '本站终到，请勿上车' : r ? `下一班列车 车厢${loadText(r.load)}` : '';
}

function build(station: number, track: TrackDir): Board {
  const s = STATIONS[station];
  const towards = DIRECTIONS[track].towards;
  // the stations still ahead in this direction
  const ahead = stationRange(track, station, downstreamTerminal(track)).slice(0, 7);
  const strip = h('div', { class: 'pm-strip' }, ...ahead.map((i, n) => h('div', { class: `pm-stop${n === 0 ? ' here' : ''}` },
    h('i'), h('span', {}, STATIONS[i].name))));
  const load = h('div', { class: 'pm-load' });
  const media = h('div', { class: 'pis-media' },
    h('div', { class: 'pm-head' }, h('img', { src: metroLogo, alt: '' }), lineBadge(), h('span', {}, `${track === 'DN' ? '下行' : '上行'}站台`)),
    h('div', { class: 'pm-name' }, s.name), h('div', { class: 'pm-towards' }, towards), strip, load);
  const ticker = h('div', { class: 'pis-ticker' });
  const bar = h('div', { class: 'pis-bar' }, lineBadge(), ticker);
  const b1 = mkBox(), b2 = mkBox();
  const b3 = h('div', { class: 'pb pb-info' });
  const wide = s.pisLayout === 'wide';
  const schedule = wide ? mkBox() : undefined;
  if (schedule) schedule.el.classList.add('pb-schedule');
  const root = wide ? h('div', { class: 'pis2 pis-wide' }, media, bar, b3,
    h('div', { class: 'pw-line' }, LINE.branding.shortName, h('small', {}, LINE.ui.lineNameEn)),
    h('div', { class: 'pw-station' }, s.name, h('small', {}, STATION_EN[s.id] ?? '')),
    schedule!.el, b2.el, b1.el) : h('div', { class: 'pis2' }, media, bar, h('div', { class: 'pis-side' }, b1.el, b2.el, b3));
  b1.el.classList.add('pb-first'); b2.el.classList.add('pb-next');
  const since = performance.now();
  return { station, track, root, wide, schedule, cycle: { page: 0, since }, firstLastCycle: { page: 0, since }, load, ticker, tickerText: '', b1, b2, b3, rows: [], t: 0, dateLabel: '', skip: false, done: false, ahead: 0 };
}

const boards = new WeakMap<HTMLElement, { key: string; list: Board[]; timer: number }>();

/**
 * Render (or update) the PIS boards for a station — both platforms, or only
 * `track` — into `el`.
 */
export function renderPis(el: HTMLElement, pis: PisData | null, t: number, dateLabel = '', track?: TrackDir) {
  if (!pis) { const cur = boards.get(el); if (cur) clearInterval(cur.timer); boards.delete(el); clear(el); el.append(h('div', { class: 'hint' }, '等待数据…')); return; }
  const key = `${pis.station}:${track ?? '*'}`;
  let cur = boards.get(el);
  if (!cur || cur.key !== key) {
    if (cur) clearInterval(cur.timer);
    clear(el);
    const list = (track ? [track] : ['DN', 'UP'] as TrackDir[]).map((k) => build(pis.station, k));
    for (const b of list) el.append(b.root);
    const timer = window.setInterval(() => {
      if (!el.isConnected) { clearInterval(timer); boards.delete(el); return; }
      for (const b of list) update(b);
    }, 50);
    cur = { key, list, timer };
    boards.set(el, cur);
  }
  for (const b of cur.list) {
    b.rows = pis[b.track]; b.t = t; b.dateLabel = dateLabel;
    b.skip = !!pis.skip?.[b.track]; b.next = pis.next?.[b.track]; b.done = !!pis.done?.[b.track]; b.ahead = pis.ahead?.[b.track] ?? 0;
    const notice = [pis.notice, ...(b.skip && !pis.notice.includes('本站列车通过不停车') ? ['本站列车通过不停车 Trains will not stop at this station'] : [])].filter(Boolean).join('　');
    if (b.tickerText !== notice) {
      b.tickerText = notice;
      clear(b.ticker);
      b.ticker.append(h('span', {}, notice));
    }
    update(b);
  }
}
