/**
 * Details & commands for the selected object (select → command → confirm).
 * Trains get the driver display (DMI), following and manual driving;
 * stations get the PIS preview and the station (interlocking) view; depots
 * the yard summary.
 */
import { timePick } from './timepick';
import { h, clear } from './dom';
import type { Store } from './store';
import { confirmAndSend, type CmdSpec } from './confirm';
import { STATIONS, LINE_INFO } from '../data/line2';
import { SEC, SW, SIGF, PLT, SIG_ASPECT, type TrackDir, type TrainSnap } from '../sim/model';
import { turnbackAt, exitStation, OVERLAY_PRESETS } from '../sim/timetable';
import { fmtTime, fmtDelay } from './theme';
import { StopView } from './stopview';
import { Dmi } from './dmi';
import { renderPis } from './pisview';

const ROLE: Record<string, string> = { start: '出站信号机', home: '进站/防护信号机', rev: '反向信号机', exit: '折返/存车线出口信号机', depot: '出段信号机' };
const ASPECT: Record<string, string> = { R: '红灯（禁止）', G: '绿灯（正线通过）', Y: '黄灯（侧向）', GUIDE: '红+白（引导）', DARK: '灭灯（CBTC 列车接近）', FAIL: '故障' };

export interface PanelHooks {
  openStation(st: number): void;
  openYard(d: number): void;
  follow(train: number | null): void;
  following(): number;
  previewRoute(rid: number | null): void;
  resolution(): number;
  locate(): void;
}

export class CommandPanel {
  el = h('div', { class: 'cmd' });
  private store: Store;
  private hooks: PanelHooks;
  private key = '';
  private live: (() => void) | null = null;
  dmi: Dmi;
  stopView: StopView;
  /** train whose DMI data the worker is sending, -1 none */
  private dmiTrain = -1;

  constructor(store: Store, hooks: PanelHooks) {
    this.store = store;
    this.hooks = hooks;
    this.dmi = new Dmi(() => hooks.resolution());
    this.stopView = new StopView(() => hooks.resolution());
    this.dmi.onNotch = (n) => {
      const sel = this.store.selection;
      if (sel?.kind === 'train') this.store.send({ type: 'drive', train: sel.id, notch: n });
    };
    store.on('selection', () => this.render(true));
    store.on('snap', () => this.render(false));
  }

  refreshResolution() {
    this.dmi.setResolution(this.hooks.resolution());
    this.stopView.setResolution(this.hooks.resolution());
  }

  private render(force: boolean) {
    const sel = this.store.selection;
    const snap = this.store.snap;
    const sys = !sel || sel.kind === 'zone';
    let key = sel ? `${sel.kind}:${sel.id}` : 'none';
    if (sys && snap) key += `|${snap.zones.join(',')}`;
    if (sel?.kind === 'train' && snap) {
      const t = snap.trains.find((x) => x.id === sel.id);
      key += `|${t ? `${t.manual}${t.atoDriver}${t.mode}${t.failed}${t.hold}${t.halt?.code === 'INTERVAL_LIMIT'}${this.hooks.following() === t.id}` : 'gone'}`;
    }
    if (sel && (sel.kind === 'switch' || sel.kind === 'section' || sel.kind === 'platform' || sel.kind === 'signal') && snap) {
      const arr = sel.kind === 'switch' ? snap.switches : sel.kind === 'section' ? snap.sections : sel.kind === 'platform' ? snap.platforms : snap.signals;
      key += `|${arr[sel.id]}`;
    }
    if (!force && key === this.key) { this.live?.(); return; }
    this.key = key;
    this.live = null;
    this.hooks.previewRoute(null);
    clear(this.el);
    if (sel?.kind !== 'train' && this.dmiTrain >= 0) { this.dmiTrain = -1; this.store.send({ type: 'dmi', train: -1 }); }
    if (!snap) return;
    if (!sel) return this.renderSystem();
    switch (sel.kind) {
      case 'signal': return this.renderSignal(sel.id);
      case 'switch': return this.renderSwitch(sel.id);
      case 'section': return this.renderSection(sel.id);
      case 'platform': return this.renderPlatform(sel.id);
      case 'train': return this.renderTrain(sel.id);
      case 'zone': return this.renderSystem(sel.id);
      case 'depot': return this.renderDepot(sel.id);
      case 'station': return this.renderStation(sel.id);
    }
  }

  private head(kind: string, name: string, cn = false, extra?: Node) {
    return h('div', { class: 'objhead' }, h('span', { class: 'kind' }, kind), h('span', { class: `name ${cn ? 'cn' : ''}` }, name), extra ?? '',
      h('span', { style: 'flex:1' }), h('button', { class: 'btn icon', title: '在图上定位', onclick: () => this.hooks.locate() }, '⌖'));
  }
  private kv(pairs: [string, string, string?][]) {
    const g = h('div', { class: 'kv' });
    for (const [k, v, cls] of pairs) g.append(h('div', { class: 'k' }, k), h('div', { class: `v ${cls ?? ''}` }, v));
    return g;
  }
  private liveKv(fn: () => [string, string, string?][], extra?: () => void) {
    const box = h('div');
    const draw = () => { clear(box); box.append(this.kv(fn())); extra?.(); };
    draw();
    this.live = draw;
    return box;
  }
  private btn(label: string, spec: CmdSpec | (() => void), cls = '') {
    return h('button', {
      class: `btn ${cls || (typeof spec !== 'function' && spec.critical ? 'danger' : '')}`,
      onclick: () => { if (typeof spec === 'function') spec(); else void confirmAndSend(this.store, spec); },
    }, label);
  }

  // ---------------------------------------------------------------- signal
  private renderSignal(id: number) {
    const { topo } = this.store;
    const s = topo.signals[id];
    this.el.append(this.head(ROLE[s.role] ?? '信号机', s.name));
    this.el.append(this.liveKv(() => {
      const f = this.store.snap!.signals[id];
      const aspect = SIG_ASPECT[f & 7];
      const route = this.store.snap!.activeRoutes.find((r) => topo.routes[r].start === id);
      return [
        ['所属车站', STATIONS[s.station].name], ['显示', ASPECT[aspect], aspect === 'FAIL' ? 'bad' : ''],
        ['当前进路', route !== undefined ? topo.routes[route].name : '无'], ['进路类型', f & SIGF.MANUAL ? '人工' : route !== undefined ? '自动' : '—'],
        ['自动排列', f & SIGF.ARSOFF ? '关（人工）' : '开', f & SIGF.ARSOFF ? 'warn' : ''], ['自动通过', f & SIGF.AUTOPASS ? '开' : '关'],
      ];
    }));
    const f = this.store.snap!.signals[id];
    this.el.append(h('div', { class: 'sect-title' }, '信号机命令'));
    this.el.append(h('div', { class: 'cmdgrid' },
      this.btn('取消进路', { title: `取消进路 ${s.name}`, cmd: { c: 'cancelRoute', signal: id }, detail: '有车接近时进路将延时30秒解锁。' }),
      this.btn(f & SIGF.AUTOPASS ? '关闭自动通过' : '开启自动通过', { title: `${f & SIGF.AUTOPASS ? '关闭' : '开启'}自动通过 ${s.name}`, cmd: { c: 'autoPass', signal: id, on: !(f & SIGF.AUTOPASS) } }),
      this.btn(f & SIGF.ARSOFF ? '恢复自动排列' : '改为人工排列', { title: `${f & SIGF.ARSOFF ? '恢复' : '关闭'}自动排列进路 ${s.name}`, cmd: { c: 'ars', signal: id, on: !!(f & SIGF.ARSOFF) } }),
      this.btn('在车站图中操作', () => this.hooks.openStation(s.station), 'primary'),
    ));
    this.el.append(h('div', { class: 'sect-title' }, '办理进路（悬停预览；引导进路需二次确认）'));
    const list = h('div', { class: 'routes' });
    for (const rid of s.routes) {
      const r = topo.routes[rid];
      list.append(h('div', { class: 'row', onmouseenter: () => this.hooks.previewRoute(rid), onmouseleave: () => this.hooks.previewRoute(null) },
        h('span', { class: 'nm' }, r.name),
        h('span', { class: `chip ${r.wrongDir ? 'warn' : r.diverging ? 'info' : 'ok'}` }, r.wrongDir ? '反向' : r.diverging ? '侧向' : '直向'),
        this.btn('办理', { title: `办理进路 ${r.name}`, cmd: { c: 'setRoute', route: rid } }, 'primary'),
        this.btn('引导', { title: `引导进路 ${r.name}`, cmd: { c: 'guideRoute', route: rid }, critical: true, detail: '引导进路不检查区段空闲，列车以RM模式（≤25km/h）目视通过；道岔失表时须先确认现场钩锁。' }, 'danger'),
      ));
    }
    this.el.append(list);
  }

  // ---------------------------------------------------------------- switch
  private renderSwitch(id: number) {
    const { topo } = this.store;
    const sw = topo.switches[id];
    this.el.append(this.head(sw.nodes.length === 2 ? '双动道岔' : '道岔', sw.name));
    const f0 = this.store.snap!.switches[id];
    this.el.append(this.liveKv(() => {
      const f = this.store.snap!.switches[id];
      const pos = f & SW.FAILED ? (f & SW.FIELD ? `失表（钩锁于${f & SW.R ? '反位' : '定位'}）` : '失表（无表示）') : f & SW.MOVING ? `转换中→${f & SW.TARGET_R ? '反位' : '定位'}` : f & SW.R ? '反位' : '定位';
      return [
        ['所属车站', STATIONS[sw.station].name], ['位置', pos, f & SW.FAILED ? 'bad' : ''],
        ['进路锁闭', f & SW.LOCKED ? '是' : '否'], ['单锁', f & SW.SINGLE ? '是' : '否', f & SW.SINGLE ? 'warn' : ''],
        ['封锁', f & SW.BLOCKED ? '是' : '否', f & SW.BLOCKED ? 'warn' : ''], ['类型', { crossover: '渡线', siding: '折返/存车线', depot: '出入段线', single: '单开' }[sw.kind]],
      ];
    }));
    this.el.append(h('div', { class: 'sect-title' }, '道岔命令'));
    this.el.append(h('div', { class: 'cmdgrid' },
      this.btn('单操定位', { title: `道岔 ${sw.name} 单操至定位`, cmd: { c: 'switchMove', sw: id, pos: 'N' } }),
      this.btn('单操反位', { title: `道岔 ${sw.name} 单操至反位`, cmd: { c: 'switchMove', sw: id, pos: 'R' } }),
      this.btn(f0 & SW.SINGLE ? '单解' : '单锁', { title: `道岔 ${sw.name} ${f0 & SW.SINGLE ? '单解' : '单锁'}`, cmd: { c: 'switchLock', sw: id, on: !(f0 & SW.SINGLE) } }),
      this.btn(f0 & SW.BLOCKED ? '解封' : '封锁', { title: `道岔 ${sw.name} ${f0 & SW.BLOCKED ? '解封' : '封锁'}`, cmd: { c: 'switchBlock', sw: id, on: !(f0 & SW.BLOCKED) }, critical: true, detail: '封锁后不能办理经过该道岔的进路（可单操）。' }),
      this.btn('钩锁确认', { title: `道岔 ${sw.name} 现场钩锁确认`, cmd: { c: 'switchFieldLock', sw: id, on: true }, critical: true, detail: '仅在现场人员确认道岔已密贴并加钩锁器后执行；之后可经引导进路以RM模式通过。' }),
      this.btn('取消钩锁', { title: `道岔 ${sw.name} 取消钩锁`, cmd: { c: 'switchFieldLock', sw: id, on: false } }),
      this.btn('在车站图中操作', () => this.hooks.openStation(sw.station), 'primary'),
    ));
    this.el.append(h('div', { class: 'hint' }, '失表处置：①单操试排（维修完成前无效）②通知维修 ③现场钩锁确认后办理引导进路 ④修复后单操恢复表示、取消钩锁。'));
  }

  // ---------------------------------------------------------------- section
  private intervalSections(id: number): number[] {
    const { topo } = this.store;
    const s = topo.sections[id];
    if (s.track !== 'DN' && s.track !== 'UP') return [id];
    const mid = (s.chainFrom + s.chainTo) / 2;
    const st = topo.stations;
    let a = st[0].chain;
    let b = st[st.length - 1].chain;
    for (let i = 0; i + 1 < st.length; i++) if (mid >= st[i].chain && mid < st[i + 1].chain) { a = st[i].chain; b = st[i + 1].chain; }
    return topo.sections.filter((x) => x.track === s.track && x.chainFrom >= a - 1 && x.chainTo <= b + 1).map((x) => x.id);
  }

  private renderSection(id: number) {
    const { topo } = this.store;
    const s = topo.sections[id];
    this.el.append(this.head('计轴区段', s.name));
    const f0 = this.store.snap!.sections[id];
    this.el.append(this.liveKv(() => {
      const f = this.store.snap!.sections[id];
      const state = f & SEC.DIST ? '故障占用' : f & SEC.PRESET ? '预复位（待压道）' : f & SEC.OCC ? (f & SEC.COMM ? '通信列车占用' : '计轴占用') : '空闲';
      return [
        ['车站/区间', STATIONS[s.station].name], ['股道', { DN: '下行正线', UP: '上行正线', X: '渡线', SID: '折返/存车线', CON: '折返线连接', DEP: '出入段线' }[s.track]],
        ['长度', `${Math.round(s.len)} m`], ['状态', state, f & SEC.DIST ? 'bad' : f & SEC.PRESET ? 'warn' : ''],
        ['进路锁闭', f & SEC.LOCK ? (f & SEC.ROUTEFLEET ? '自动通过进路' : '进路锁闭') : '无'], ['限速', f & SEC.TSR ? `临时 ${this.store.snap!.sectionTsr[id]} km/h` : f & SEC.ENV ? `天气 ${this.store.snap!.sectionTsr[id] || '停运'}` : '无', f & (SEC.TSR | SEC.ENV) ? 'warn' : ''],
        ['封锁', f & SEC.POSS ? '施工封锁' : f & SEC.BLOCK ? '调度封锁' : '无', f & SEC.BLOCK ? 'warn' : ''], ['里程', `K${(s.chainFrom / 1000).toFixed(3)}–K${(s.chainTo / 1000).toFixed(3)}`],
      ];
    }));
    const ivs = this.intervalSections(id);
    const extent = h('select', {}, h('option', { value: 'one' }, '本区段'), h('option', { value: 'iv' }, `整个站间区间（${ivs.length} 个区段）`)) as HTMLSelectElement;
    const pick = () => (extent.value === 'iv' ? ivs : [id]);
    const names = () => pick().map((x) => topo.sections[x].name).join('、');
    this.el.append(h('div', { class: 'sect-title' }, '区段命令'));
    this.el.append(h('div', { class: 'form' }, h('label', {}, '作用范围'), extent));
    this.el.append(h('div', { class: 'cmdgrid' },
      this.btn('计轴预复位', { title: `计轴预复位 ${s.name}`, cmd: { c: 'axleReset', section: id }, critical: true, detail: '预复位后区段显示黄色，首列车以RM模式压道出清后恢复空闲。设备故障未修复时复位将失败。' }),
      this.btn('区段故障解锁', { title: `区段故障解锁 ${s.name}`, cmd: { c: 'sectionUnlock', section: id }, critical: true, detail: '解除故障后残留的进路锁闭。联锁拒绝：区段占用（含计轴故障占用，须先预复位）、进路接近锁闭或已发出移动授权、进路上有列车驶向该区段。办理记入事件日志。' }),
      this.btn(f0 & SEC.BLOCK && !(f0 & SEC.POSS) ? '区段解封' : '区段封锁', () => {
        const on = !(f0 & SEC.BLOCK);
        void confirmAndSend(this.store, { title: `区段${on ? '封锁' : '解封'}：${names()}`, cmd: { c: 'sectionBlock', sections: pick(), on }, critical: true, detail: on ? '封锁后不能办理经过该区段的进路，列车不能进入。' : undefined });
      }, f0 & SEC.BLOCK ? '' : 'danger'),
    ));
    const speed = h('select', {}, ...[15, 25, 35, 45, 60].map((v) => h('option', { value: v }, `${v} km/h`))) as HTMLSelectElement;
    speed.value = '25';
    this.el.append(h('div', { class: 'sect-title' }, '临时限速 TSR'));
    this.el.append(h('div', { class: 'form' },
      h('label', {}, '限速值'), speed,
      this.btn('设置限速', () => void confirmAndSend(this.store, { title: `设置临时限速 ${speed.value}km/h：${names()}`, cmd: { c: 'setTsr', sections: pick(), kmh: Number(speed.value) }, critical: true }), 'danger'),
      this.btn('取消限速', () => void confirmAndSend(this.store, { title: `取消临时限速：${names()}`, cmd: { c: 'cancelTsr', sections: pick() }, critical: true }), 'danger'),
    ));
  }

  // ---------------------------------------------------------------- platform
  private renderPlatform(id: number) {
    const { topo } = this.store;
    const p = topo.platforms[id];
    this.el.append(this.head('站台', p.name, true));
    const f = this.store.snap!.platforms[id];
    this.el.append(this.liveKv(() => {
      const fl = this.store.snap!.platforms[id];
      const w = this.store.snap!.platformWaiting[id];
      return [
        ['候车人数', String(w), w > 1200 ? 'bad' : w > 700 ? 'warn' : ''], ['站台门', fl & PLT.PSDFAULT ? (fl & PLT.BYPASS ? '故障（互锁解除）' : '故障') : fl & PLT.PSDOPEN ? '打开' : '关闭锁紧', fl & PLT.PSDFAULT ? 'bad' : ''],
        ['扣车', fl & PLT.HOLD ? '是' : '否', fl & PLT.HOLD ? 'warn' : ''], ['跳停', fl & PLT.SKIP ? '是' : '否'],
        ['紧急关闭', fl & PLT.ESP ? '是' : '否', fl & PLT.ESP ? 'bad' : ''], ['大客流', fl & PLT.SURGE ? '是' : '否', fl & PLT.SURGE ? 'warn' : ''],
      ];
    }));
    this.el.append(h('div', { class: 'sect-title' }, '站台命令'));
    this.el.append(h('div', { class: 'cmdgrid' },
      this.btn(f & PLT.HOLD ? '取消扣车' : '站台扣车', { title: `${f & PLT.HOLD ? '取消扣车' : '扣车'} ${p.name}`, cmd: { c: 'platformHold', platform: id, on: !(f & PLT.HOLD) } }),
      this.btn(f & PLT.SKIP ? '取消跳停' : '站台跳停', { title: `${f & PLT.SKIP ? '取消跳停' : '跳停'} ${p.name}`, cmd: { c: 'platformSkip', platform: id, on: !(f & PLT.SKIP) } }),
      this.btn(f & PLT.ESP ? '取消紧急关闭' : '紧急关闭', { title: `${f & PLT.ESP ? '取消紧急关闭' : '紧急关闭'} ${p.name}`, cmd: { c: 'platformEsp', platform: id, on: !(f & PLT.ESP) }, critical: true, detail: '紧急关闭后列车不得进出该站台，接近列车将紧急制动。' }),
      this.btn(f & PLT.BYPASS ? '取消互锁解除' : '站台门互锁解除', { title: `站台门互锁${f & PLT.BYPASS ? '恢复' : '解除'} ${p.name}`, cmd: { c: 'psdBypass', platform: id, on: !(f & PLT.BYPASS) }, critical: !(f & PLT.BYPASS), detail: '确认站台门已人工关闭或已派人看守后执行，列车可凭人工确认发车。' }),
      this.btn('车站图', () => this.hooks.openStation(p.station), 'primary'),
    ));
    this.pisSection(p.station, p.track);
  }

  private pisSection(station: number, track?: TrackDir) {
    this.store.send({ type: 'pis', station });
    const box = h('div', { class: 'pis-boards' });
    this.el.append(h('div', { class: 'sect-title' }, '站台乘客信息（PIS）预览'), box);
    const prev = this.live;
    const draw = () => {
      prev?.();
      const s = this.store.snap;
      renderPis(box, s?.pis?.station === station ? s.pis : null, s?.t ?? 0, s?.dateLabel ?? '', track);
    };
    this.live = draw;
    renderPis(box, null, 0);
  }

  // ---------------------------------------------------------------- station
  private renderStation(id: number) {
    const { topo } = this.store;
    const st = topo.stations[id];
    const sd = STATIONS[id];
    this.el.append(this.head('车站', st.name, true));
    this.el.append(this.kv([
      ['里程', `K${(st.chain / 1000).toFixed(3)}`], ['换乘', sd.transfers.length ? sd.transfers.join('、') : '无'],
      ['折返', st.turnbackBerths.some((b) => topo.berths[b].kind === 'platform') ? '中间线站台折返'
        : st.turnbackBerths.length ? '站后折返线' : st.frontTurnback.DN || st.frontTurnback.UP ? '站前渡线' : '无'], ['原名', sd.formerName ?? '—'],
    ]));
    this.el.append(h('div', { class: 'cmdgrid' },
      this.btn('打开车站图（联锁）', () => this.hooks.openStation(id), 'primary'),
      this.btn('下行站台', () => this.store.select({ kind: 'platform', id: st.platforms.DN })),
      this.btn('上行站台', () => this.store.select({ kind: 'platform', id: st.platforms.UP })),
      ...topo.platforms.filter((p) => p.station === id && p.pool !== undefined)
        .map((p) => this.btn('中间线站台', () => this.store.select({ kind: 'platform', id: p.id }))),
    ));
    this.el.append(this.liveKv(() => {
      const s = this.store.snap!;
      return [['下行候车', `${s.platformWaiting[st.platforms.DN]} 人`], ['上行候车', `${s.platformWaiting[st.platforms.UP]} 人`]];
    }));
    this.pisSection(id);
  }

  // ---------------------------------------------------------------- depot
  private renderDepot(id: number) {
    const { topo } = this.store;
    const d = topo.depots[id];
    this.el.append(this.head('车辆基地', d.name, true));
    this.el.append(this.liveKv(() => {
      const y = this.store.snap!.yards[id];
      const n = y.tracks.reduce((a, t) => a + t.length, 0);
      return [['在段车辆', `${n} 列`], ['停车线', `${d.stablingTracks} 股 × ${y.perTrack}`], ['接轨站', STATIONS[d.station].name], ['容量', `${d.capacity} 列`]];
    }));
    const plan = this.store.plan!;
    const now = this.store.snap!.t;
    const next = plan.blocks.filter((b) => b.start.kind === 'depot' && b.start.depot === id && b.start.time > now - 60 && b.train === undefined)
      .sort((a, b) => (a.start as { time: number }).time - (b.start as { time: number }).time).slice(0, 6);
    this.el.append(h('div', { class: 'sect-title' }, '计划出段'));
    if (!next.length) this.el.append(h('div', { class: 'hint' }, '近期无出段计划'));
    else {
      const tb = h('tbody');
      for (const b of next) tb.append(h('tr', {}, h('td', { class: 'mono' }, fmtTime((b.start as { time: number }).time, false)), h('td', { class: 'mono' }, `表号 ${b.svc}`), h('td', {}, plan.trips[b.trips[0]] ? `→ ${STATIONS[plan.trips[b.trips[0]].to].name}` : '')));
      this.el.append(h('table', { class: 'grid' }, tb));
    }
    this.el.append(h('div', { class: 'cmdgrid' }, this.btn('打开车场图', () => this.hooks.openYard(id), 'primary')));
    this.addTrainForm(id);
  }

  // ---------------------------------------------------------------- train
  private trainDir(t: TrainSnap): TrackDir {
    const l = this.store.topo.links[t.link];
    const east = t.dir === 1 ? l.chainB >= l.chainA : l.chainA > l.chainB;
    return east ? 'DN' : 'UP';
  }

  private renderTrain(id: number) {
    const { topo } = this.store;
    const t0 = this.store.snap!.trains.find((x) => x.id === id);
    if (!t0) { this.el.append(h('div', { class: 'empty' }, '列车已不在线')); return; }
    const following = this.hooks.following() === id;
    this.el.append(this.head('列车', `${t0.svc}-${t0.trip}`, false, h('span', { class: 'chip info' }, `车组 ${t0.vehicle}`)));
    // follow + driving
    const drive = h('div', { class: 'cmdgrid' },
      this.btn(following ? '取消跟踪' : '跟踪列车', () => this.hooks.follow(following ? null : id), following ? 'on' : 'primary'),
      ...(t0.manual || t0.atoDriver
        ? [this.btn('恢复自动驾驶', { title: `列车 ${t0.svc}-${t0.trip} 恢复自动驾驶（CBTC级 DTO 或降级ATO时 AM，TBTC级 AM）`, cmd: { c: 'manual', train: id, mode: 'AUTO' } }, 'primary')]
        : [
          this.btn('ATO 驾驶', { title: `接管列车 ${t0.svc}-${t0.trip}：ATO驾驶`, cmd: { c: 'manual', train: id, mode: 'AM' }, detail: '自动驾驶，到站后关门锁闭、发车条件满足时，同时按住F和G启动。' }, 'warn'),
          this.btn('人工驾驶 CM', { title: `接管列车 ${t0.svc}-${t0.trip}：人工驾驶 CM（ATP 防护）`, cmd: { c: 'manual', train: id, mode: 'CM' }, detail: '由你操纵牵引/制动手柄驾驶列车（Z 牵引、Q 制动、S 中立位、E 紧急制动；Y/U 右/左侧车门）。到站停准后由你开关门，车门关好才能牵引。ATP 监督速度与移动授权，超速将触发紧急制动并计入安全违章。停站对标将评分。人工驾驶期间仿真速率最高 5×。' }, 'warn'),
          this.btn('人工驾驶 RM', { title: `接管列车 ${t0.svc}-${t0.trip}：限制人工驾驶 RM（≤25km/h）`, cmd: { c: 'manual', train: id, mode: 'RM' }, critical: true, detail: 'RM 模式无移动授权防护，司机目视行车，限速25km/h。越过红灯将记为冒进信号。须先停车。' }, 'danger'),
        ]),
    );
    this.el.append(drive);
    if (this.dmiTrain !== id) { this.dmi.reset(); this.dmiTrain = id; }
    this.store.send({ type: 'dmi', train: id });
    this.dmi.showLever(t0.manual);
    this.el.append(this.dmi.el);
    this.el.append(this.stopView.el);
    if (t0.atoDriver) this.el.append(h('div', { class: 'keys' }, 'ATO启动：发车条件满足后同时按住 F + G'));
    if (t0.manual) this.el.append(h('div', { class: 'keys' }, '手柄：', h('b', {}, 'Z ↑'), ' 加牵引 · ', h('b', {}, 'Q ↓'), ' 加制动 · ', h('b', {}, 'S'), ' 中立位 · ', h('b', {}, 'E'), ' 紧急制动 · ', h('b', {}, 'Y'), ' 右门 · ', h('b', {}, 'U'), ' 左门 · 鼠标滚轮/点击手柄档位'));
    if (t0.manual) this.el.append(h('div', { class: 'cmdgrid' }, ...([[-1, '后 J'], [0, '零 K'], [1, '前 L']] as const).map(([position, label]) => this.btn(`换向器 ${label}`, { title: `换向器 ${label}`, cmd: { c: 'reverser', train: id, position } }))));
    const scores = h('div', { class: 'scores' });
    if (t0.drv || t0.manual) this.el.append(h('div', { class: 'sect-title' }, '人工驾驶记录（对标误差 / 得分）'), scores);
    this.el.append(this.liveKv(() => {
      const t = this.store.snap!.trains.find((x) => x.id === id);
      if (!t) return [['状态', '已下线']];
      const dir = this.trainDir(t);
      return [
        ...(t.manual ? [['换向器', t.reverser === -1 ? '后' : t.reverser === 0 ? '零' : '前'] as [string, string]] : []),
        ['目的地', t.dest || '—'], ['方向', dir === 'DN' ? '下行' : '上行'],
        ['当前任务', t.task], ['晚点', t.inService ? fmtDelay(t.delay) : '非载客', t.delay > 300 ? 'bad' : t.delay > 120 ? 'warn' : ''],
        ['停车原因', t.halt ? `${t.halt.label}${t.halt.blocker ? `（${t.halt.blocker}）` : ''} [${t.halt.code}] ${t.halt.detail}` : '—'],
        ['折返阶段', ({ none: '—', arrive: '牵入', reverse: '换端', manual: '待司机牵出', depart: '牵出' })[t.tbStage]],
        ['出入段阶段', ({ none: '—', out: '出段', in: '入段' })[t.depotStage]],
        ['满载率', `${Math.round((t.load / LINE_INFO.capacity) * 100)}%`, t.load > LINE_INFO.capacity ? 'warn' : ''], ['里程', `K${(t.chain / 1000).toFixed(3)}`],
      ];
    }, () => {
      const t = this.store.snap!.trains.find((x) => x.id === id);
      if (!t) return;
      const snap = this.store.snap!;
      this.dmi.draw(t, snap.dmi?.train === id ? snap.dmi : null, snap.t);
      this.stopView.draw(t, snap.dmi?.train === id ? snap.dmi : null, snap.t);
      if (t.drv) {
        clear(scores);
        const st = t.drv.stops.slice(-8);
        if (!st.length) scores.append(h('span', { class: 'hint' }, '尚无停站记录'));
        for (const s of st) scores.append(h('span', { class: `chip ${s.score >= 90 ? 'ok' : s.score >= 60 ? 'warn' : 'late'}` }, `${STATIONS[s.station].name} ${s.err >= 0 ? '欠' : '过'}${Math.abs(s.err).toFixed(2)}m ${s.score}${s.note ? ` ${s.note}` : ''}`));
        if (t.drv.overspeed || t.drv.spad) scores.append(h('span', { class: 'chip bad' }, `超速EB ${t.drv.overspeed} · 冒进 ${t.drv.spad}`));
      }
    }));
    const dir = this.trainDir(t0);
    const ahead = topo.stations.filter((s) => (dir === 'DN' ? s.chain > t0.chain + 20 : s.chain < t0.chain - 20)).sort((a, b) => (dir === 'DN' ? a.chain - b.chain : b.chain - a.chain));
    const tbOpts = ahead.filter((s) => turnbackAt(topo, s.index, dir));
    const intervalHeld = t0.halt?.code === 'INTERVAL_LIMIT';
    const release = t0.hold || intervalHeld;
    this.el.append(h('div', { class: 'sect-title' }, '调度命令'));
    this.el.append(h('div', { class: 'cmdgrid' },
      this.btn(release ? '放行' : '扣车', { title: `${release ? '放行' : '扣车'} 列车 ${t0.svc}-${t0.trip}`, cmd: { c: 'trainHold', train: id, on: !release },
        detail: intervalHeld ? '仅放行本站这一次区间限车，仍须信号开放并满足ATP防护。' : undefined }),
      this.btn('恢复接续', { title: `列车 ${t0.svc}-${t0.trip} 故障恢复接续`, cmd: { c: 'recoverService', train: id }, detail: '仅在已完成车次的终点停站办理。取消已错过的完整往返车次，按原图接续同一终点的近期始发；无近期接续则保留计划，须另行人工调整。已完成车次和历史晚点保留。' }),
      this.btn('退出服务', { title: `列车 ${t0.svc}-${t0.trip} 退出服务，清客回段`, cmd: { c: 'withdraw', train: id }, detail: '列车在前方站清客后回最近车辆段/停车场，剩余计划车次取消。' }),
      this.btn('备车接替', { title: `为列车 ${t0.svc}-${t0.trip} 投入热备/备车`, cmd: { c: 'standby', train: id }, detail: '列车晚点、后续车次将晚发时：优先由终点站热备车接替其在该站的始发车次（提前2–3分钟通知），本车到达后转为热备；无热备可用时由车辆段备车出段接替，本车跑完保留车次后回段。' }),
      t0.dto
        ? this.btn('恢复DTO', { title: `列车 ${t0.svc}-${t0.trip} 恢复DTO`, cmd: { c: 'trainDto', train: id, on: true }, detail: `当前不能DTO：${t0.dto}。调度命令降级的可恢复；车载故障须先修复。列车在下一站停站时由AM转DTO。` })
        : this.btn('降级ATO', { title: `列车 ${t0.svc}-${t0.trip} 降级为ATO（司机驾驶室值守）`, cmd: { c: 'trainDto', train: id, on: false }, detail: '仍为CBTC级移动闭塞，司机在下一站停站时转AM：发车需司机按ATO启动按钮，折返时司机换端（多约45秒）。用于DTO相关设备故障、车内异常需司机值守等。' }, 'warn'),
      this.btn('授权RM运行', { title: `授权列车 ${t0.svc}-${t0.trip} 以RM模式运行`, cmd: { c: 'authRM', train: id }, critical: true, detail: '司机以≤25km/h目视行车600m，可越过故障占用区段或关闭的信号（须确认进路正确、道岔位置正确）。' }),
    ));
    const skipSel = h('select', {}, ...ahead.slice(0, 8).map((s) => h('option', { value: s.index }, s.name))) as HTMLSelectElement;
    const tbSel = h('select', {}, ...tbOpts.map((s) => {
      const tb = turnbackAt(topo, s.index, dir)!;
      return h('option', { value: s.index }, `${s.name}（${tb.kind === 'rear' ? '站后' : '站前'}）`);
    })) as HTMLSelectElement;
    this.el.append(h('div', { class: 'form' }, h('label', {}, '跳停'), skipSel,
      this.btn('设置跳停', () => void confirmAndSend(this.store, { title: `列车 ${t0.svc}-${t0.trip} 跳停 ${STATIONS[Number(skipSel.value)].name}`, cmd: { c: 'trainSkip', train: id, station: Number(skipSel.value), on: true } }))));
    this.el.append(h('div', { class: 'form' }, h('label', {}, '人工折返'), tbSel,
      this.btn('折返', () => tbSel.value && void confirmAndSend(this.store, { title: `列车 ${t0.svc}-${t0.trip} 人工折返于 ${STATIONS[Number(tbSel.value)].name}`, cmd: { c: 'turnback', train: id, station: Number(tbSel.value) }, detail: '列车在折返站清客折返，按调整车次接续反方向运营。' }), 'primary')));
    if (t0.failed) {
      const behind = this.store.snap!.trains.filter((x) => x.id !== id && this.trainDir(x) === dir && (dir === 'DN' ? x.chain < t0.chain : x.chain > t0.chain))
        .sort((a, b) => Math.abs(a.chain - t0.chain) - Math.abs(b.chain - t0.chain)).slice(0, 4);
      const rs = h('select', {}, ...behind.map((x) => h('option', { value: x.id }, `${x.svc}-${x.trip}（后方 ${Math.round(Math.abs(x.chain - t0.chain))}m）`))) as HTMLSelectElement;
      this.el.append(h('div', { class: 'sect-title' }, '故障救援'));
      this.el.append(h('div', { class: 'form' }, h('label', {}, '救援列车'), rs,
        this.btn('组织救援', () => rs.value && void confirmAndSend(this.store, { title: `组织列车 ${rs.selectedOptions[0]?.textContent} 救援故障列车 ${t0.svc}-${t0.trip}`, cmd: { c: 'rescue', failed: id, rescuer: Number(rs.value) }, critical: true, detail: '救援列车清客后以RM模式接近连挂（≤3km/h），推送故障车至前方站清客后回段。' }), 'danger')));
    }
    this.live?.();
  }

  // ---------------------------------------------------------------- system / zones / add trains
  private renderSystem(zone?: number) {
    const { topo } = this.store;
    const snap = this.store.snap!;
    this.el.append(this.head('系统', '信号系统 / 运营调整', true));
    const zbox = h('div', { style: 'display:flex;flex-direction:column;gap:8px' });
    topo.zones.forEach((z, i) => {
      const st = snap.zones[i];
      zbox.append(h('div', { style: `display:flex;align-items:center;gap:12px;font-size:24px;${zone === i ? 'outline:2px solid var(--accent);' : ''}padding:4px` },
        h('span', { style: 'flex:1' }, z.name),
        h('span', { class: `chip ${st === 'CBTC' ? 'ok' : st === 'TBTC' ? 'warn' : 'bad'}` }, st === 'ZCFAIL' ? 'ZC故障' : st),
        this.btn('切TBTC', { title: `${z.name} 切换至 TBTC 后备系统`, cmd: { c: 'zoneLevel', zones: [i], level: 'TBTC' }, critical: true, detail: '区域内列车停稳后经司机确认转为TBTC级别运行（固定闭塞，区段占用防护）。' }, 'danger'),
        this.btn('恢复CBTC', { title: `${z.name} 恢复 CBTC`, cmd: { c: 'zoneLevel', zones: [i], level: 'CBTC' }, critical: true }, 'danger'),
      ));
    });
    this.el.append(h('div', { class: 'sect-title' }, 'CBTC / TBTC 系统切换'), zbox);
    this.el.append(h('div', { class: 'sect-title' }, `运营驾驶模式：${snap.atoLine ? 'ATO（DTO兼容模式，司机驾驶）' : 'DTO'}`));
    this.el.append(h('div', { class: 'cmdgrid' },
      snap.atoLine
        ? this.btn('全线恢复DTO', { title: '全线恢复 DTO 运营', cmd: { c: 'lineAto', on: false }, critical: true, detail: '各列车在下一站停站时由AM恢复DTO（车载DTO故障或单独降级的列车除外）。' })
        : this.btn('全线转ATO运营', { title: '全线转 ATO 运营（DTO兼容模式）', cmd: { c: 'lineAto', on: true }, critical: true, detail: '仍为CBTC移动闭塞，各列车在下一站停站时由司机转AM驾驶；终点站折返司机换端约多45秒、发车需司机按钮。运行图不变，终点站折返余量吸收换端时间；高峰折返紧张时可能晚点。新运营日也可在“运营日设置”中直接选择ATO运营。' }, 'warn'),
    ));
    this.el.append(h('div', { class: 'cmdgrid' },
      this.btn('全线切换TBTC', { title: '全线切换至 TBTC 后备系统', cmd: { c: 'zoneLevel', zones: topo.zones.map((z) => z.id), level: 'TBTC' }, critical: true }),
      this.btn('全线恢复CBTC', { title: '全线恢复 CBTC', cmd: { c: 'zoneLevel', zones: topo.zones.map((z) => z.id), level: 'CBTC' }, critical: true }),
    ));
    this.addTrainForm();
    // overlays
    this.el.append(h('div', { class: 'sect-title' }, '加开运行图模板'));
    for (const p of OVERLAY_PRESETS) {
      const a = timePick(Math.max(p.from, snap.t + 1200));
      const b = timePick(Math.max(p.to, snap.t + 3600 * 2));
      const hw = h('select', {}, ...[600, 720, 900, 1200].map((v) => h('option', { value: v }, `${v / 60}分`))) as HTMLSelectElement;
      hw.value = String(p.headway);
      this.el.append(h('div', { class: 'form' }, h('span', { style: 'color:#fff;min-width:240px' }, p.label), a.el, h('span', {}, '至'), b.el, hw,
        this.btn('套用', () => void confirmAndSend(this.store, {
          title: `${p.label} ${a.text()}—${b.text()}，间隔 ${Number(hw.value) / 60} 分钟`,
          cmd: { c: 'overlay', id: p.id, from: a.sec(), to: b.sec(), headway: Number(hw.value) },
          detail: p.desc,
        }), 'primary')));
    }
  }

  private addTrainForm(depot?: number) {
    const { topo } = this.store;
    const snap = this.store.snap!;
    const depSel = h('select', {}, ...topo.depots.map((d) => h('option', { value: d.id }, d.name))) as HTMLSelectElement;
    if (depot !== undefined) depSel.value = String(depot);
    const dirSel = h('select', {}, h('option', { value: 'DN' }, '下行'), h('option', { value: 'UP' }, '上行')) as HTMLSelectElement;
    const toSel = h('select', {}) as HTMLSelectElement;
    const fill = () => {
      clear(toSel);
      const d = Number(depSel.value);
      const dir = dirSel.value as TrackDir;
      const ex = exitStation(topo, d, dir);
      for (const s of topo.stations) {
        if ((dir === 'DN' && s.index <= ex) || (dir === 'UP' && s.index >= ex)) continue;
        if (!turnbackAt(topo, s.index, dir)) continue;
        toSel.append(h('option', { value: s.index }, s.name));
      }
    };
    depSel.onchange = fill;
    dirSel.onchange = fill;
    fill();
    // departures on the minute (the planned times are whole minutes)
    const tIn = timePick(snap.t + 900, 1);
    this.el.append(h('div', { class: 'sect-title' }, '加开列车（出段 → 折返站 → 回段）'));
    this.el.append(h('div', { class: 'form' }, depSel, dirSel, h('label', {}, '折返'), toSel, h('label', {}, '发车'), tIn.el,
      this.btn('加开', () => void confirmAndSend(this.store, {
        title: `加开列车：${topo.depots[Number(depSel.value)].name} 出段 → ${STATIONS[Number(toSel.value)]?.name ?? '?'} 折返 → 回段，${tIn.text()} 发车`,
        cmd: { c: 'addTrain', depot: Number(depSel.value), dir: dirSel.value as TrackDir, to: Number(toSel.value), time: tIn.sec() },
      }), 'primary')));
  }
}
