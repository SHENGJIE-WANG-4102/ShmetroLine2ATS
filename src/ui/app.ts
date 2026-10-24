/**
 * Application shell: screen layout on the logical canvas (UI scale),
 * overview schematic / station view switching, the train graph strip,
 * DOM panels, pointer & keyboard input, banners and modal dialogs.
 */
import { installSelectLists } from './popup';
import { datePick } from './timepick';
import { Container, type Application, type Text } from 'pixi.js';
import type { Topology } from '../sim/topology';
import type { SimConfig } from '../sim/model';
import type { Store, Selection } from './store';
import { computeRegions, loadPref, savePref, UI_SCALES, type GraphMode, type Regions, type Rect } from './layout';
import { Geometry, lineWindow, type GeomParams } from './geometry';
import { TrackView, type ViewHandlers, type Layers } from './trackview';
import { StationView } from './stationview';
import { TrainGraph } from './graph';
import { Header, SPEEDS, dayTypeOf, dateLabel } from './header';
import { SidePanel } from './side';
import { Tooltip } from './tooltip';
import { Audio } from './audio';
import { initConfirm, toast } from './confirm';
import { openYard } from './yardview';
import { openHelp, helpSeen } from './help';
import { openReport } from './report';
import { h, clear } from './dom';
import { fmtTime, hex, C } from './theme';
import { holidayOf, isoDate, parseTime } from '../sim/calendar';
export { parseTime };
export const newOperatingSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
import { INSTRUCTOR_EVENTS, SCENARIOS, instructorEventIds } from '../sim/scenario';
import { LINE, WEATHER_RULES, unattended } from '../data/current';
import { formatDrivingMode } from './drivingMode';
import { isPlayerDriving } from './utoControls';

/** default UI scale: 100 % on a 4K canvas, larger on smaller windows so text stays readable (A+/A− go up to 200 %) */
function defaultScale(): number {
  const fit = Math.min(window.innerWidth / 3840, window.innerHeight / 2160);
  // text at least ~15 CSS px, but keep the logical canvas ≥ 2560 px wide (1.5×) so the layout still fits
  const want = Math.min(1.5, Math.max(1, 0.75 / fit));
  let best = 1;
  for (const s of UI_SCALES) if (Math.abs(s - want) < Math.abs(best - want)) best = s;
  return best;
}

/**
 * Overview geometry for a viewport: wrap the line over the number of rows
 * that lets the whole line be seen at the largest zoom (1 = full size).
 */
function overviewParams(topo: Topology, vw: number, vh: number): GeomParams {
  const [a, b] = lineWindow(topo);
  const NEED = LINE.ui.overviewWidth; // world width the whole line needs for readable station names
  const BASE = 500; // minimum row height
  const PAD = 80; // room for the first row's windows / last row's names when zoomed out
  let rows = 1;
  let best = 0;
  for (let n = 1; n <= 6; n++) {
    const z = Math.min(1, vw / Math.max(vw, NEED / n), n * BASE <= vh ? 1 : (vh - 2 * PAD) / (n * BASE));
    if (z > best + 1e-3) { best = z; rows = n; }
  }
  const width = Math.max(Math.round(vw), Math.ceil(NEED / rows));
  // spare height goes into the rows (more room for the label bands around the tracks)
  const fits = rows * BASE <= vh;
  const rowH = Math.min(BASE + 160, Math.floor(fits ? vh / rows : (vh - 2 * PAD) / (rows * best)));
  const off = Math.round((rowH - BASE) / 2);
  return {
    chainFrom: a, chainTo: b, rows, width, marginL: 150, marginR: 150, rowH, top: 0,
    upY: 200 + off, midY: 240 + off, dnY: 280 + off,
    depotDy: { q: 50, z: 66, j1: 80, j2: 94, gate: 108 + off }, detail: false, padBottom: fits ? 0 : PAD, padTop: fits ? 0 : PAD,
  };
}

export class App {
  private topo: Topology;
  private store: Store;
  private pixi: Application;
  private overlay: HTMLElement;
  uiScale: number;
  graphMode: GraphMode;
  R!: Regions;
  private viewLayer = new Container();
  overview: TrackView | null = null;
  private overviewKey = '';
  station: StationView;
  mode: 'overview' | 'station' = 'overview';
  graph: TrainGraph;
  header: Header;
  side: SidePanel;
  tooltip: Tooltip;
  audio = new Audio();
  private vtool = h('div', { class: 'vtool' });
  private ovTool: HTMLElement;
  private status = h('div', { class: 'vstatus' });
  private perfEl = h('span', { class: 'perf' });
  private graphCtl = h('div', { class: 'graph-ctl' });
  private graphModeBtns = new Map<GraphMode, HTMLButtonElement>();
  private layerBtns = new Map<keyof Layers, HTMLButtonElement>();
  private legend: HTMLElement | null = null;
  private veil = h('div', { class: 'progress-veil', style: 'display:none' });
  private layers: Layers = loadPref('layers', { sig: false, sec: false, km: false, pax: true });
  private drag: { x: number; y: number; sx: number; sy: number } | null = null;
  private statusKey = '';
  private lastScenario = '';

  constructor(topo: Topology, store: Store, pixi: Application, overlay: HTMLElement) {
    this.topo = topo;
    this.store = store;
    this.pixi = pixi;
    this.overlay = overlay;
    this.uiScale = loadPref('uiScale', 0) || defaultScale();
    this.graphMode = loadPref<GraphMode>('graphMode', 'strip');

    this.graph = new TrainGraph(topo, store);
    pixi.stage.addChild(this.viewLayer, this.graph.root);
    pixi.stage.eventMode = 'static';

    this.station = new StationView(topo, store, {
      close: () => this.closeStation(),
      hover: (sel) => this.hover(sel),
      openYard: (d) => this.openYard(d),
      built: () => { this.applyTextResolution(); this.placeStationView(); },
    });

    const panelHooks = {
      openStation: (st: number) => this.openStation(st),
      openYard: (d: number) => this.openYard(d),
      follow: (id: number | null) => this.follow(id),
      following: () => this.overview?.follow ?? -1,
      previewRoute: (rid: number | null) => this.activeView()?.previewRoute(rid),
      resolution: () => this.resolution(),
      locate: () => this.locateSel(this.store.selection),
      rewind: (t: number, replay: boolean) => this.store.send({ type: 'rewind', to: t, replay }),
      locateSel: (sel: Selection) => this.locateSel(sel),
    };
    this.header = new Header(store, {
      restart: () => this.showDayDialog(),
      scale: () => this.uiScale,
      setScale: (v) => this.setScale(v),
      muted: () => this.audio.muted,
      setMuted: (m) => { this.audio.setMuted(m); this.header.refreshScale(); },
      traction: () => this.audio.traction,
      setTraction: (on) => this.audio.setTractionOn(on),
      stationSound: () => this.audio.stationSound,
      setStationSound: (on) => this.audio.setStationSoundOn(on),
      recordedVolume: () => this.audio.recordedVolume,
      setRecordedVolume: (level) => this.audio.setRecordedVolume(level),
      help: () => openHelp(this.overlay),
    });
    this.side = new SidePanel(store, this.audio, panelHooks);
    this.tooltip = new Tooltip(store);
    this.ovTool = this.buildOverviewTool();
    this.buildGraphCtl();
    overlay.append(this.header.el, this.vtool, this.graphCtl, this.station.hint, this.side.el, this.tooltip.el, this.header.menu, this.veil);
    initConfirm(overlay);
    const modalObserver = new MutationObserver(() => { if (this.modalOpen()) this.hover(null); });
    modalObserver.observe(overlay, { childList: true, subtree: true });
    installSelectLists(overlay);

    this.setMode('overview');
    this.layout();
    this.bindInput();
    this.bindStore();
    window.addEventListener('resize', () => this.layout());
    // the header wraps when its content changes width: re-flow the regions below it
    const ro = new ResizeObserver(() => {
      if (!this.R) return;
      if (Math.abs(this.header.el.offsetHeight - this.R.header.h) > 1 || Math.abs(this.vtool.offsetHeight - this.R.toolbar.h) > 1) this.layout();
    });
    ro.observe(this.header.el);
    ro.observe(this.vtool);
    pixi.ticker.add(() => this.frame());
  }

  // ---------------------------------------------------------------- layout

  resolution(): number {
    return Math.max(1, (this.R?.k ?? 1) * (window.devicePixelRatio || 1));
  }

  private setScale(v: number) {
    this.uiScale = v;
    savePref('uiScale', v);
    this.layout();
    this.header.refreshScale();
  }

  setGraphMode(m: GraphMode) {
    this.graphMode = m;
    savePref('graphMode', m);
    for (const [k, b] of this.graphModeBtns) b.classList.toggle('on', k === m);
    this.layout();
  }

  layout() {
    const R = computeRegions(window.innerWidth, window.innerHeight, this.uiScale, this.graphMode, (W) => {
      this.header.el.style.width = `${W}px`;
      return this.header.el.offsetHeight;
    }, (w) => {
      this.vtool.style.width = `${w}px`;
      return this.vtool.offsetHeight;
    });
    this.R = R;
    const o = this.overlay;
    o.style.width = `${R.W}px`;
    o.style.height = `${R.H}px`;
    o.style.transform = `scale(${R.k})`;
    this.pixi.stage.scale.set(R.k);
    const place = (el: HTMLElement, r: Rect, height = true) => {
      el.style.left = `${r.x}px`;
      el.style.top = `${r.y}px`;
      el.style.width = `${r.w}px`;
      if (height) el.style.height = `${r.h}px`;
    };
    place(this.header.el, R.header, false);
    this.header.menu.style.top = `${R.header.y + R.header.h}px`;
    place(this.side.el, R.side);
    place(this.vtool, R.toolbar, false);
    place(this.graphCtl, { x: R.graph.x, y: R.graph.y + 4, w: R.graph.w, h: 56 });
    this.tooltip.bounds = { w: R.W, h: R.H };
    this.graph.resize(R.graph.x, R.graph.y, R.graph.w, R.graph.h);
    this.viewLayer.position.set(R.view.x, R.view.y);
    this.viewLayer.visible = R.view.h > 40;
    // overview: rebuild when the geometry changes, otherwise just resize the viewport
    if (R.view.h > 40) {
      const p = overviewParams(this.topo, R.view.w, R.view.h);
      const key = `${p.rows}|${p.width}|${p.rowH}`;
      if (!this.overview || key !== this.overviewKey) this.buildOverview(p, key);
      else this.overview.setViewport(R.view.w, R.view.h);
      if (this.mode === 'station') this.station.resize(R.view.w, R.view.h - 64);
    }
    this.placeStationView();
    this.side.cmd.refreshResolution();
    this.applyTextResolution();
    if (this.legend) this.toggleLegend(true);
  }

  private buildOverview(p: GeomParams, key: string) {
    const old = this.overview;
    const follow = old?.follow ?? -1;
    const geom = new Geometry(this.topo, p);
    const handlers: ViewHandlers = {
      device: (sel) => this.store.select(sel),
      station: (st) => this.store.select({ kind: 'station', id: st }),
      depot: (d) => { this.store.select({ kind: 'depot', id: d }); this.openYard(d); },
      background: () => this.store.select(null),
      hover: (sel) => this.hover(sel),
    };
    this.overview = new TrackView(this.topo, this.store, geom, handlers, { mode: 'overview' }, this.R.view.w, this.R.view.h);
    this.overview.setLayers(this.layers);
    this.overview.follow = follow;
    this.overviewKey = key;
    if (old) old.destroy();
    if (this.mode === 'overview') this.attach(this.overview.root);
  }

  private placeStationView() {
    const R = this.R;
    const hint = this.station.hint;
    const on = this.mode === 'station' && R.view.h > 40;
    hint.style.display = on ? 'flex' : 'none';
    if (!on) return;
    hint.style.left = `${R.view.x}px`;
    hint.style.top = `${R.view.y}px`;
    hint.style.width = `${R.view.w}px`;
    if (this.station.view) this.station.view.root.position.set(0, 64);
  }

  private attach(root: Container) {
    this.viewLayer.removeChildren();
    this.viewLayer.addChild(root);
  }

  private applyTextResolution() {
    const res = this.resolution();
    const texts: Text[] = [...this.graph.allTexts()];
    if (this.overview) texts.push(...this.overview.allTexts());
    if (this.station.view) texts.push(...this.station.view.allTexts());
    for (const t of texts) if (t.resolution !== res) t.resolution = res;
  }

  activeView(): TrackView | null {
    return this.mode === 'station' ? this.station.view : this.overview;
  }

  /** viewport rect of the active track view (logical canvas coordinates) */
  private activeRect(): Rect {
    const v = this.R.view;
    return this.mode === 'station' ? { x: v.x, y: v.y + 64, w: v.w, h: v.h - 64 } : v;
  }

  // ---------------------------------------------------------------- modes

  private setMode(m: 'overview' | 'station') {
    this.mode = m;
    clear(this.vtool);
    if (m === 'overview') {
      this.vtool.append(this.ovTool, this.status);
      if (this.overview) this.attach(this.overview.root);
    } else {
      this.vtool.append(this.station.tool, this.status);
      if (this.station.view) this.attach(this.station.view.root);
    }
    this.placeStationView();
    this.statusKey = '';
  }

  openStation(st: number) {
    if (this.R.view.h <= 40) this.setGraphMode('strip');
    if (this.overview) this.overview.follow = -1;
    // swap the toolbar first: its height (it wraps) decides the view size
    this.setMode('station');
    this.layout();
    this.station.open(st, this.R.view.w, this.R.view.h - 64);
    this.attach(this.station.view!.root);
    this.placeStationView();
  }

  closeStation() {
    this.station.close();
    this.setMode('overview');
    this.layout();
  }

  openYard(d: number) {
    openYard(this.store, this.overlay, d, () => this.side.setTab(0));
  }

  follow(id: number | null) {
    if (!this.overview) return;
    if (id !== null && this.mode === 'station') this.closeStation();
    this.overview.follow = id ?? -1;
    if (id !== null) {
      const t = this.store.snap?.trains.find((x) => x.id === id);
      const p = t ? this.overview.trainPoint(t) : null;
      if (p) this.overview.centerOn(p.x, p.y, Math.max(this.overview.z, 1.8));
    }
    this.statusKey = '';
  }

  locateSel(sel: Selection) {
    if (!sel) return;
    if (sel.kind === 'station') { this.store.select(sel); this.openStation(sel.id); return; }
    let v = this.activeView();
    let p = v?.devicePoint(sel) ?? null;
    if (!p && this.mode === 'station') {
      this.closeStation();
      v = this.overview;
      p = v?.devicePoint(sel) ?? null;
    }
    this.store.select(sel);
    if (v && p) v.centerOn(p.x, p.y, this.mode === 'overview' ? Math.max(v.z, 1.8) : v.z);
  }

  private modalOpen() { return !!this.overlay.querySelector('.modal-back'); }

  private hover(sel: Selection) {
    if (this.modalOpen()) sel = null;
    this.store.hover = sel;
    this.store.emit('hover');
  }

  // ---------------------------------------------------------------- toolbars

  private buildOverviewTool(): HTMLElement {
    const lay = (k: keyof Layers, label: string, title: string) => {
      const b = h('button', { class: `btn ${this.layers[k] ? 'on' : ''}`, title, onclick: () => {
        this.layers[k] = !this.layers[k];
        savePref('layers', this.layers);
        b.classList.toggle('on', this.layers[k]);
        this.overview?.setLayers({ [k]: this.layers[k] });
      } }, label);
      this.layerBtns.set(k, b);
      return b;
    };
    const zoom = (f: number) => {
      const v = this.activeView();
      if (v) v.zoomAt(f, v.vw / 2, v.vh / 2);
    };
    const stSel = h('select', { style: 'width:280px', title: '打开车站图（联锁操作）', onchange: () => {
      if (stSel.value !== '') this.openStation(Number(stSel.value));
      stSel.value = '';
    } }, h('option', { value: '' }, '车站图…'), ...this.topo.stations.map((s) => h('option', { value: s.index }, s.name))) as HTMLSelectElement;
    return h('div', { style: 'display:contents' },
      h('span', { class: 'ttl' }, '线路总览'),
      h('span', { class: 'lbl' }, '图层'),
      lay('sig', '信号机', '显示全部信号机编号（放大后自动显示）'),
      lay('sec', '区段', '显示区段编号（放大后自动显示）'),
      lay('km', '公里标', '显示车站公里标（放大后自动显示）'),
      lay('pax', '客流', '站台候车人数与列车满载率'),
      h('span', { class: 'sep' }),
      h('button', { class: 'btn icon', title: '缩小（-）', onclick: () => zoom(1 / 1.3) }, '−'),
      h('button', { class: 'btn icon', title: '放大（+）', onclick: () => zoom(1.3) }, '+'),
      h('button', { class: 'btn', title: '全览（0）', onclick: () => this.activeView()?.resetView() }, '全览'),
      h('span', { class: 'sep' }),
      stSel,
      h('button', { class: 'btn', title: '图例', onclick: () => this.toggleLegend() }, '图例'),
    );
  }

  private buildGraphCtl() {
    const spans: [number, string][] = [[3600, '1小时'], [3 * 3600, '3小时'], [6 * 3600, '6小时'], [22 * 3600, '全天']];
    const btns: HTMLButtonElement[] = [];
    const box = this.graphCtl;
    box.append(h('span', { class: 'ttl' }, '运行图'));
    const modes: [GraphMode, string, string][] = [['strip', '条带', '运行图显示为下方条带'], ['hidden', '收起', '收起运行图，示意图占满'], ['max', '最大', '运行图全屏（隐藏示意图）']];
    for (const [m, label, title] of modes) {
      const b = h('button', { class: `btn ${m === this.graphMode ? 'on' : ''}`, title, onclick: () => this.setGraphMode(m) }, label);
      this.graphModeBtns.set(m, b);
      box.append(b);
    }
    const winBox = h('span', { class: 'gwin' });
    for (const [s, t] of spans) {
      const b = h('button', { class: `btn ${s === 3 * 3600 ? 'on' : ''}`, onclick: () => { this.graph.setWindow(s); btns.forEach((x) => x.classList.toggle('on', x === b)); } }, t);
      btns.push(b);
      winBox.append(b);
    }
    const li = (color: string, text: string, w = 4) => h('span', {}, h('i', { style: `background:${color};height:${w}px` }), text);
    box.append(winBox, h('span', { class: 'lg' },
      h('span', { class: 'lgh' }, '计划'), li(hex(C.planBig), '大交路', 2), li(hex(C.planSmall), '小交路', 2), li(hex(C.planIns), '出入段', 2), li(hex(C.planExtra), '加开', 2), li(hex(C.planAdj), '调整', 2),
      h('span', { class: 'lgh' }, '实迹'), li(hex(C.actOnTime), '正点≤2分'), li(hex(C.actSlight), '晚点2–5分'), li(hex(C.actLate), '晚点>5分'), li('#6a7684', '非载客', 2)), this.perfEl);
  }

  private toggleLegend(refresh = false) {
    if (this.legend && !refresh) { this.legend.remove(); this.legend = null; return; }
    this.legend?.remove();
    const i = (c: number | string, t: string) => [h('i', { style: `background:${typeof c === 'number' ? hex(c) : c}` }), h('span', {}, t)];
    const b = (c: number, t: string) => [h('b', { style: `background:${hex(c)}` }), h('span', {}, t)];
    const head = (t: string) => h('div', { class: 'h' }, t);
    const el = h('div', { class: 'legend-pop', onclick: () => this.toggleLegend() },
      head('轨道区段'),
      ...i(C.trackFree, '空闲'), ...i(C.routeAuto, '自动通过进路'), ...i(C.routeSet, '进路锁闭'), ...i(C.occComm, 'CBTC 列车占用'),
      ...i(C.occAxle, '计轴占用（非通信车）'), ...i(C.disturbed, '故障占用'), ...i(C.preset, '预复位 / 临时限速'), ...i(C.blocked, '封锁 / 施工'),
      ...i(C.env, '大风/暴雨限速'), ...i(C.routeGuide, '引导进路'),
      head('信号机'),
      ...b(C.sigStopDim, 'CBTC区 禁止（暗）'), ...b(C.sigStop, '禁止（后备区）'), ...b(C.sigGreen, '直向开放'), ...b(C.sigYellow, '侧向开放'),
      ...b(C.fault, '故障（闪）'), ...b(C.selection, '已选始端（闪）'),
      head('列车车次窗（表号-车次）'),
      ...i(C.onTime, '正点'), ...i(C.slightLate, '晚点 2–5 分'), ...i(C.late, '晚点 > 5 分'), ...i(C.early, '早点 > 1 分'),
      ...i(C.fault, '故障 / 紧急制动'), ...i(C.nonService, '非载客'), ...i(C.trainManual, '人工驾驶'), ...i(C.platformHold, '扣车'),
      head('站台 / 道岔'),
      ...i(C.crowdLow, '候车人数（条长）'), ...i(C.crowdHigh, '站台拥挤'), ...[h('b', { style: 'background:transparent;border:3px solid #e8eef5' }), h('span', {}, '道岔单锁')], ...[h('b', { style: 'background:transparent;border:3px solid #b07cff' }), h('span', {}, '道岔封锁')],
      h('div', { class: 'h', style: 'font-size:20px;color:var(--text-dim)' }, '点击关闭'),
    );
    const R = this.R;
    el.style.left = `${R.view.x + 16}px`;
    el.style.top = `${R.view.y + 8}px`;
    el.style.maxWidth = `${R.view.w - 32}px`;
    this.legend = el;
    this.overlay.append(el);
  }

  /** right part of the view toolbar: follow / replay / weather / scenario state */
  private renderStatus() {
    const s = this.store.snap;
    if (!s) return;
    const fol = this.overview?.follow ?? -1;
    const ft = fol >= 0 ? s.trains.find((t) => t.id === fol) : undefined;
    if (fol >= 0 && !ft && this.overview) this.overview.follow = -1;
    const sc = s.scenario && !s.scenario.ended ? s.scenario : null;
    const key = `${ft ? `${ft.svc}-${ft.trip}` : ''}|${s.replay.replaying}|${Math.floor(s.replay.to / 60)}|${s.env.wind}|${s.env.rain}|${s.env.rain || s.t < s.env.dryAt}|${s.env.lowAdh}|${sc ? Math.floor((sc.end - s.t) / 30) : ''}|${s.paused}|${this.mode}`;
    if (key === this.statusKey) return;
    this.statusKey = key;
    clear(this.status);
    if (s.paused) this.status.append(h('span', { class: 'chip warn big' }, '已暂停'));
    if (s.replay.replaying) {
      this.status.append(h('span', { class: 'banner replay' }, h('b', {}, '回放中'), `${fmtTime(s.t, false)} → ${fmtTime(s.replay.to, false)}`,
        h('button', { class: 'btn warn', onclick: () => this.store.send({ type: 'takeover' }) }, '接管')));
    }
    if (ft) {
      this.status.append(h('span', { class: 'banner' }, `跟踪 ${ft.svc}-${ft.trip}`,
        h('button', { class: 'btn', onclick: () => this.follow(null) }, '取消')));
    }
    if (s.env.wind > 0 || s.env.rain) {
      const parts: string[] = [];
      const w = s.env.wind > 0 ? WEATHER_RULES.wind[s.env.wind - 1] : undefined;
      if (w) parts.push(`${w.label} 高架 ${w.kmh ? `≤${w.kmh}` : '停运'}`);
      if (s.env.rain) parts.push(`暴雨 露天段 ≤${WEATHER_RULES.rain.kmh}`);
      this.status.append(h('span', { class: 'banner weather' }, h('b', {}, '气象限速'), parts.join(' · ')));
    }
    // wet rail on the exposed section (adhesion.ts): the dispatcher's low-adhesion mode
    if (s.env.rain || s.t < s.env.dryAt || s.env.lowAdh) {
      const on = s.env.lowAdh;
      this.status.append(h('span', { class: 'banner weather' }, h('b', {}, s.env.rain || s.t < s.env.dryAt ? '轨面湿滑' : '轨面已干'),
        h('button', { class: on ? 'btn warn' : 'btn', title: '露天段列车降低牵引、提前以较小减速度制动，减少空转滑行和过标，运行时分增加',
          onclick: async () => { const r = await this.store.command({ c: 'lowAdhesion', on: !on }); toast(r.msg, r.ok); } }, on ? '取消低粘着模式' : '低粘着模式')));
    }
    if (sc) {
      const left = Math.max(0, sc.end - s.t);
      this.status.append(h('span', { class: 'banner scen' }, h('b', {}, sc.name), `剩余 ${Math.floor(left / 60)} 分`));
    }
    this.status.style.display = this.status.childElementCount ? '' : 'none';
  }

  // ---------------------------------------------------------------- input

  private toLogical(e: { clientX: number; clientY: number }) {
    return { x: e.clientX / this.R.k, y: e.clientY / this.R.k };
  }

  private bindInput() {
    const canvas = this.pixi.canvas;
    const inRect = (p: { x: number; y: number }, r: Rect) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
    canvas.addEventListener('pointerdown', (e) => {
      const p = this.toLogical(e);
      const v = this.activeView();
      if (!v || !inRect(p, this.activeRect())) return;
      this.drag = { x: p.x, y: p.y, sx: p.x, sy: p.y };
      v.dragMoved = false;
      if (this.legend) this.toggleLegend();
    });
    window.addEventListener('pointermove', (e) => {
      if (this.modalOpen()) { this.drag = null; this.hover(null); return; }
      const p = this.toLogical(e);
      this.tooltip.move(p.x, p.y);
      const d = this.drag;
      const v = this.activeView();
      if (!d || !v) return;
      if (!v.dragMoved && Math.hypot(p.x - d.sx, p.y - d.sy) > 6) {
        v.dragMoved = true;
        canvas.style.cursor = 'grabbing';
        if (v === this.overview && v.follow >= 0) this.follow(null);
      }
      if (v.dragMoved) v.panBy(p.x - d.x, p.y - d.y);
      d.x = p.x;
      d.y = p.y;
    });
    window.addEventListener('pointerup', () => {
      this.drag = null;
      canvas.style.cursor = '';
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = this.toLogical(e);
      const r = this.activeRect();
      const v = this.activeView();
      if (!v || !inRect(p, r)) return;
      v.zoomAt(Math.exp(-e.deltaY * 0.0015), p.x - r.x, p.y - r.y);
    }, { passive: false });
    canvas.addEventListener('pointerleave', () => this.hover(null));
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', e => { const key = e.key.toLowerCase(); if (key === 'f' || key === 'g') this.releaseAto(key); });
    window.addEventListener('blur', () => this.releaseAto());
  }

  private atoKeys = new Map<'f' | 'g', number>();
  private releaseAto(key?: 'f' | 'g') {
    for (const [button, train] of this.atoKeys) if (!key || key === button) {
      this.store.command({ c: 'atoButton', train, button, down: false });
      this.atoKeys.delete(button);
    }
  }

  private onKey(e: KeyboardEvent) {
    const tgt = e.target as HTMLElement | null;
    const typing = !!tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA');
    if (this.modalOpen()) return; // dialogs handle their own keys
    if (e.key === 'F1') { e.preventDefault(); openHelp(this.overlay); return; }
    if (e.ctrlKey || e.metaKey) {
      if (e.key === '+' || e.key === '=') { e.preventDefault(); this.header.stepScale(1); }
      else if (e.key === '-') { e.preventDefault(); this.header.stepScale(-1); }
      return;
    }
    if (typing && e.key !== 'Escape') return;
    // manual driving of the selected train
    const sel = this.store.selection;
    const tr = sel?.kind === 'train' ? this.store.snap?.trains.find((t) => t.id === sel.id) : undefined;
    const key = e.key.toLowerCase();
    if (tr?.atoDriver && (key === 'f' || key === 'g')) {
      e.preventDefault();
      if (!e.repeat) {
        this.atoKeys.set(key, tr.id);
        this.store.command({ c: 'atoButton', train: tr.id, button: key, down: true });
      }
      return;
    }
    if (tr && isPlayerDriving(tr)) {
      let n: number | null = null;
      const k = e.key.toLowerCase();
      if (['j', 'k', 'l'].includes(k) && !e.repeat) {
        e.preventDefault();
        this.store.command({ c: 'reverser', train: tr.id, position: k === 'j' ? -1 : k === 'k' ? 0 : 1 }).then(r => toast(r.msg, r.ok));
        return;
      }
      // single master controller, JRETS layout: Z power / release, Q brake, S neutral, E emergency
      const up = e.key === 'ArrowUp' || k === 'z';
      if (up) n = Math.min(4, tr.notch + 1);
      else if (e.key === 'ArrowDown' || k === 'q') n = Math.max(-7, tr.notch - 1);
      else if (k === 's') n = 0;
      else if (k === 'e') n = -8;
      // door buttons, TSW layout: Y right, U left; the same side again closes
      if ((k === 'y' || k === 'u') && !e.repeat) {
        e.preventDefault();
        this.store.command({ c: 'door', train: tr.id, side: k === 'y' ? 'R' : 'L' }).then((r) => toast(r.msg, r.ok));
        return;
      }
      if (n !== null) {
        e.preventDefault();
        if (e.repeat && k !== 'z' && k !== 'q' && !e.key.startsWith('Arrow')) return;
        // out of EB only by moving the handle towards release or straight to N
        if (tr.notch === -8 && n > -8 && k !== 's' && !up) return;
        this.store.send({ type: 'drive', train: tr.id, notch: n });
        return;
      }
    }
    if (e.key === 'Escape') {
      if (typing) { tgt!.blur(); return; }
      if (this.legend) { this.toggleLegend(); return; }
      if (this.mode === 'station') {
        if (this.station.view && this.station.view.pendingStart >= 0) this.station.resetPending();
        else if (this.station.fn !== 'select') this.station.setFn('select');
        else this.closeStation();
        return;
      }
      if (this.overview && this.overview.follow >= 0) { this.follow(null); return; }
      this.store.select(null);
      return;
    }
    if (e.key === ' ') { e.preventDefault(); this.header.setPaused(!this.header.paused); return; }
    if (/^[1-7]$/.test(e.key)) { this.header.setSpeed(SPEEDS[Number(e.key) - 1]); return; }
    const v = this.activeView();
    if (e.key === '+' || e.key === '=') { v?.zoomAt(1.3, v.vw / 2, v.vh / 2); return; }
    if (e.key === '-') { v?.zoomAt(1 / 1.3, v.vw / 2, v.vh / 2); return; }
    if (e.key === '0') { v?.resetView(); return; }
    if (e.key.toLowerCase() === 'm') { this.audio.setMuted(!this.audio.muted); this.header.refreshScale(); return; }
    if (this.mode === 'station') {
      const fn = this.station.fnForKey(e.key);
      if (fn) { this.station.setFn(fn); return; }
    }
  }

  // ---------------------------------------------------------------- store events

  private bindStore() {
    const s = this.store;
    s.on('textsChanged', () => this.applyTextResolution());
    s.on('selection', () => {
      const sel = s.selection;
      // PIS feed only while a station / platform is selected
      const st = sel?.kind === 'station' ? sel.id : sel?.kind === 'platform' ? this.topo.platforms[sel.id].station : -1;
      s.send({ type: 'pis', station: st });
      if (this.mode === 'station' && sel?.kind === 'station' && sel.id !== this.station.station) this.openStation(sel.id);
    });
    s.on('slowForCall', () => { if (this.header.speed > 5) { this.header.setSpeed(1); toast('来电：仿真速率已降至 1×', true); } });
    s.on('report', () => {
      const r = s.report;
      if (!r) return;
      const again = this.lastScenario ? () => this.startScenario(this.lastScenario) : undefined;
      openReport(this.overlay, r, again);
    });
    for (const sc of SCENARIOS) s.on('startScenario:' + sc.id, () => this.startScenario(sc.id));
    s.on('startup',()=>{
      this.veil.textContent=s.startupText;
      this.veil.style.display='flex';
    });
    s.on('progress', () => {
      const p = s.progress;
      if (!p) return;
      this.veil.textContent = `预热推演 ${fmtTime(p.t)} → ${fmtTime(p.target)}（${Math.min(100,Math.round((p.t-14400)/Math.max(1,p.target-14400)*100))}%）`;
      this.veil.style.display = 'flex';
    });
    s.on('snap', () => { if (this.veil.style.display !== 'none') this.veil.style.display = 'none'; });
    s.on('ready', () => {
      if (this.mode === 'station') this.closeStation();
      if (this.overview) this.overview.follow = -1;
    });
    s.on('rewound', () => toast(`已回到 ${fmtTime(s.snap?.t ?? 0)}`, true));
  }

  startScenario(id: string) {
    const def = SCENARIOS.find((x) => x.id === id);
    if (!def) return;
    this.lastScenario = id;
    const d = new Date();
    const wantWeekend = def.dayType !== 'weekday';
    for (let i = 0; i < 7; i++) {
      const we = d.getDay() === 0 || d.getDay() === 6;
      if (we === wantWeekend) break;
      d.setDate(d.getDate() + 1);
    }
    const cfg: SimConfig = {
      dayType: dayTypeOf(d, false), dateLabel: dateLabel(d, false), date: isoDate(d), startTime: def.start,
      seed: 20251101 + d.getDate(), scenario: id, autoRadio: false,
    };
    this.veil.textContent = `载入场景：${def.name}…`;
    this.veil.style.display = 'flex';
    this.store.start(cfg);
    this.header.setSpeed(1);
  }

  // ---------------------------------------------------------------- frame loop

  private fpsAcc = 0;
  private fpsN = 0;
  private updMs = 0;

  private frame() {
    const now = performance.now();
    this.store.flushSnap();
    const snap = this.store.snap;
    if (snap) {
      if (this.mode === 'overview') this.overview?.update(snap, now);
      else this.station.update(snap, now);
      this.graph.update(now);
      this.renderStatus();
    }
    this.updMs += performance.now() - now;
    this.fpsAcc += this.pixi.ticker.deltaMS;
    this.fpsN++;
    if (this.fpsAcc > 1000) {
      const perf = { fps: (this.fpsN * 1000) / this.fpsAcc, updateMs: this.updMs / this.fpsN };
      (window as unknown as { __perf: unknown }).__perf = perf;
      this.perfEl.textContent = `${Math.round(perf.fps)} fps · ${perf.updateMs.toFixed(1)} ms · 仿真 ${snap ? snap.stats.speedActual.toFixed(0) : 0}×`;
      this.fpsAcc = 0;
      this.fpsN = 0;
      this.updMs = 0;
    }
  }

  // ---------------------------------------------------------------- operating day dialog

  showDayDialog(required = false) {
    const d = new Date();
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    const dateIn = datePick(d, () => showHol());
    const hol = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const st = h('select', {}, ...[['04:30', '首班车前 04:30'], ['06:30', '早高峰前 06:30'], ['07:40', '早高峰 07:40'], ['12:00', '平峰 12:00'], ['17:40', '晚高峰 17:40'], ['21:30', '末班前 21:30'], ['23:50', '收车 23:50']].map(([v, t]) => h('option', { value: v }, t))) as HTMLSelectElement;
    st.value = '07:40';
    const auto = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const drive = h('select', {}, h('option', { value: 'DTO' }, `${formatDrivingMode('DTO')}（正常）`),
      ...(!unattended('doorClose') ? [h('option', { value: 'ATO' }, 'ATO（DTO兼容模式，司机驾驶）')] : [])) as HTMLSelectElement;
    const random=h('select',{},...['关','轻','中','重'].map((label,level)=>h('option',{value:level},label)));
    const savedLevel=Number(loadPref('randomFaults',0));
    random.value=String([0,1,2,3].includes(savedLevel)?savedLevel:0);
    const savedEvents=loadPref<unknown>('instructorEvents',[]);
    const selected=new Set(instructorEventIds(Array.isArray(savedEvents)?savedEvents.filter((id):id is string=>typeof id==='string'):[]));
    const checks=new Map(INSTRUCTOR_EVENTS.map(event=>[event.id,h('input',{type:'checkbox',checked:selected.has(event.id)})]));
    const eventPicker=h('div',{class:'instructor-picker'},h('div',{class:'event-actions'},
      h('button',{class:'btn',onclick:()=>checks.forEach(c=>c.checked=true)},'全选'),
      h('button',{class:'btn',onclick:()=>checks.forEach(c=>c.checked=false)},'全不选')));
    for(const category of [...new Set(INSTRUCTOR_EVENTS.map(e=>e.category))]) eventPicker.append(h('fieldset',{},h('legend',{},category),
      ...INSTRUCTOR_EVENTS.filter(e=>e.category===category).map(e=>h('label',{},checks.get(e.id)!,e.name))));
    // the holiday programme of the date (holiday.ts) is shown as soon as the date is typed
    const holHint = h('div', { class: 'hint', style: 'margin-top:10px;color:var(--warn, #d9a400)' });
    const showHol = () => {
      const hd = holidayOf(dateIn.iso());
      const note = LINE.ui.holidayNotice;
      holHint.textContent = !hd || !note.day ? ''
        : hd.day === 0 ? note.eve
        : `国庆第${hd.day}${note.day}${hd.day >= hd.days - 1 ? note.returning : ''}${note.suffix}`;
    };
    showHol();
    const back = h('div', { class: 'modal-back' });
    const close = () => back.remove();
    const go = () => {
      const [y, m, dd] = dateIn.iso().split('-').map(Number);
      const nd = new Date(y, (m || 1) - 1, dd || 1);
      if (Number.isNaN(nd.getTime())) { toast('日期格式应为 YYYY-MM-DD', false); return; }
      const c: SimConfig = { dayType: dayTypeOf(nd, hol.checked), dateLabel: dateLabel(nd, hol.checked), date: isoDate(nd), startTime: parseTime(st.value), seed: newOperatingSeed(), autoRadio: auto.checked,
        randomFaults:Number(random.value),instructorEvents:[...checks].filter(([,c])=>c.checked).map(([id])=>id),
        ...(drive.value === 'ATO' ? { driveMode: 'ATO' as const } : {}) };
      savePref('randomFaults',c.randomFaults);
      savePref('instructorEvents',c.instructorEvents);
      close();
      this.lastScenario = '';
      this.veil.textContent = '生成运行图…';
      this.veil.style.display = 'flex';
      this.store.start(c);
    };
    back.append(h('div', { class: 'modal day-setup' },
      h('div', { class: 'modal-h' }, '运营日设置'),
      h('div', { class: 'modal-b' },
        h('div', { class: 'form' }, h('label', {}, '运营日期'), dateIn.el, h('label', {}, '节假日'), hol),
        holHint,
        h('div', { class: 'form', style: 'margin-top:14px' }, h('label', {}, '开始时刻'), st),
        h('div', { class: 'form', style: 'margin-top:14px' }, h('label', {}, '来电自动应答（观摩模式）'), auto),
        h('div', { class: 'form', style: 'margin-top:14px' }, h('label', {}, '运营驾驶模式'), drive),
        h('div',{class:'form',style:'margin-top:14px'},h('label',{},'随机故障'),random),
        h('div',{class:'sect-title'},'教员事件'),eventPicker,
        h('div',{class:'hint'},'勾选的事件可能在当天随机发生，也可能不发生。事件时刻不预告。'),
        h('div', { class: 'hint', style: 'margin-top:14px' }, '工作日采用早晚高峰大小交路运行图，双休日/节假日采用对应运行图，均含出入段与过夜安排。开始时刻之前的运营以最高速度推演。',
          unattended('doorClose') ? '常态FAM全自动，随车人员接管需先关门并完成操作序列。' : 'ATO运营（DTO兼容模式）沿用同一运行图，终点站折返时司机换端、发车需司机按钮。', '训练场景请在右侧“教员”页选择。'),
      ),
      h('div', { class: 'modal-f' }, required ? null : h('button', { class: 'btn', onclick: close }, '取消'), h('button', { class: 'btn primary', onclick: go }, '开始')),
    ));
    this.overlay.append(back);
  }

  firstRunHelp() {
    if (!helpSeen()) openHelp(this.overlay);
  }
}


