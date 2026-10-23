/**
 * Station / interlocking view (车站图): one station's track layout at
 * workstation scale with a function-first toolbar, as on a CASCO / Thales
 * ATS local workstation: pick a function button, then click the devices.
 *
 *   排列进路 / 引导进路  始端信号机 → 终端信号机（或终端股道 / 车场）
 *   取消进路            始端信号机
 *   定位 / 反位          道岔（单操）
 *   单锁 / 单解          道岔（按当前状态切换）
 *   封锁 / 解封          道岔或区段（按当前状态切换）
 *   区故解 · 计轴预复位   区段
 *
 * Safety-relevant functions go through the second confirmation; the
 * routine ones (routes, switch throws, single lock) execute immediately
 * and report in a toast, like the real HMI.
 */
import type { Container } from 'pixi.js';
import { h, clear } from './dom';
import type { Store, Selection } from './store';
import type { Topology } from '../sim/topology';
import { Geometry, stationWindow } from './geometry';
import { TrackView } from './trackview';
import { confirmAndSend, toast } from './confirm';
import { SEC, SW, type Snapshot } from '../sim/model';
import { STATIONS } from '../data/current';

export type StationFn = 'select' | 'route' | 'guide' | 'cancel' | 'swN' | 'swR' | 'lock' | 'block' | 'secUnlock' | 'axle';

const FNS: { fn: StationFn; label: string; key: string; hint: string; danger?: boolean }[] = [
  { fn: 'select', label: '选择', key: 'Q', hint: '点击设备查看详情与全部命令（右侧面板）' },
  { fn: 'route', label: '排列进路', key: 'R', hint: '点击<b>始端信号机</b>，再点击<b>终端信号机</b>（或终端股道 / 车场）' },
  { fn: 'guide', label: '引导进路', key: 'G', hint: '点击<b>始端信号机</b>，再点击<b>终端</b>；引导进路需二次确认，列车凭引导信号 RM 通过', danger: true },
  { fn: 'cancel', label: '取消进路', key: 'C', hint: '点击要取消进路的<b>始端信号机</b>（接近锁闭时延时解锁）' },
  { fn: 'swN', label: '定位', key: 'N', hint: '点击<b>道岔</b>单操至定位（进路锁闭/单锁/占用时拒绝）' },
  { fn: 'swR', label: '反位', key: 'V', hint: '点击<b>道岔</b>单操至反位' },
  { fn: 'lock', label: '单锁/单解', key: 'L', hint: '点击<b>道岔</b>：未单锁则单锁，已单锁则单解（白圈 = 单锁）' },
  { fn: 'block', label: '封锁/解封', key: 'B', hint: '点击<b>道岔或区段</b>：封锁后不能排列经过它的进路（紫圈/紫色斜线 = 封锁），需二次确认', danger: true },
  { fn: 'secUnlock', label: '区故解', key: 'U', hint: '点击<b>区段</b>：区段故障解锁（进路锁闭残留时使用），需二次确认', danger: true },
  { fn: 'axle', label: '计轴预复位', key: 'X', hint: '点击<b>故障占用区段</b>：计轴预复位，首列车须以 RM 压道出清，需二次确认', danger: true },
];

export interface StationHooks {
  close(): void;
  hover(sel: Selection): void;
  openYard(d: number): void;
  /** the view was (re)built: new Text objects to set resolution on */
  built(): void;
}

export class StationView {
  view: TrackView | null = null;
  station = -1;
  fn: StationFn = 'select';
  /** toolbar content (placed in the view toolbar by the app) */
  tool: HTMLElement;
  /** operation hint banner over the view */
  hint: HTMLElement;
  private topo: Topology;
  private store: Store;
  private hooks: StationHooks;
  private fnBtns = new Map<StationFn, HTMLButtonElement>();
  private stSel: HTMLSelectElement;
  private vw = 0;
  private vh = 0;

  constructor(topo: Topology, store: Store, hooks: StationHooks) {
    this.topo = topo;
    this.store = store;
    this.hooks = hooks;
    this.stSel = h('select', { style: 'width:300px', title: '切换车站', onchange: () => this.open(Number(this.stSel.value), this.vw, this.vh) },
      ...topo.stations.map((s) => h('option', { value: s.index }, s.name))) as HTMLSelectElement;
    const fnBox = h('div', { style: 'display:flex;gap:8px' });
    for (const f of FNS) {
      const b = h('button', { class: `btn fn ${f.danger ? 'warn' : ''}`, title: `${f.label}（${f.key}）`, onclick: () => this.setFn(f.fn) }, f.label);
      this.fnBtns.set(f.fn, b);
      fnBox.append(b);
    }
    this.tool = h('div', { style: 'display:contents' },
      h('button', { class: 'btn primary', title: '返回线路总览（Esc）', onclick: () => this.hooks.close() }, '◀ 总览'),
      h('span', { class: 'ttl' }, '车站图'),
      h('button', { class: 'btn icon', title: '上一站', onclick: () => this.step(-1) }, '‹'),
      this.stSel,
      h('button', { class: 'btn icon', title: '下一站', onclick: () => this.step(1) }, '›'),
      h('span', { class: 'sep' }),
      fnBox,
      h('span', { class: 'sep' }),
      h('button', { class: 'btn', title: '取消当前选择的始端', onclick: () => this.resetPending() }, '清除'),
    );
    this.hint = h('div', { class: 'banner op' });
    this.setFn('select');
  }

  get root(): Container | null {
    return this.view?.root ?? null;
  }

  private step(d: number) {
    const n = this.topo.stations.length;
    this.open((this.station + d + n) % n, this.vw, this.vh);
  }

  open(st: number, vw: number, vh: number) {
    const keep = this.view && this.station === st ? { z: this.view.z, x: this.view.panX, y: this.view.panY } : null;
    this.station = st;
    this.vw = vw;
    this.vh = vh;
    this.stSel.value = String(st);
    const [a, b] = stationWindow(this.topo, st);
    const geom = new Geometry(this.topo, {
      chainFrom: a, chainTo: b, rows: 1, width: Math.max(1600, vw), marginL: 170, marginR: 170, rowH: 760, top: 0,
      upY: 360, midY: 440, dnY: 520, depotDy: { q: 60, z: 95, j1: 125, j2: 150, gate: 200 }, detail: true, nodeMargin: 300,
    });
    const old = this.view;
    this.view = new TrackView(this.topo, this.store, geom, {
      device: (sel) => this.onDevice(sel),
      station: () => this.store.select({ kind: 'station', id: st }),
      depot: (d) => (this.fn === 'route' || this.fn === 'guide') && this.view!.pendingStart >= 0 ? this.onDevice({ kind: 'depot', id: d }) : this.hooks.openYard(d),
      background: () => { if (this.fn === 'select') this.store.select(null); },
      hover: (sel) => this.hooks.hover(sel),
    }, { mode: 'detail', station: st }, vw, vh);
    this.view.maxZoom = 3;
    if (keep) { this.view.z = keep.z; this.view.panX = keep.x; this.view.panY = keep.y; this.view.setViewport(vw, vh); }
    if (old) old.destroy();
    this.resetPending();
    this.hooks.built();
  }

  resize(vw: number, vh: number) {
    if (this.station < 0) return;
    if (this.view && Math.abs(vw - this.vw) < 1 && Math.abs(vh - this.vh) < 1) return;
    this.open(this.station, vw, vh);
  }

  close() {
    this.view?.destroy();
    this.view = null;
    this.station = -1;
  }

  update(snap: Snapshot, now: number) {
    this.view?.update(snap, now);
  }

  setFn(fn: StationFn) {
    this.fn = fn;
    for (const [k, b] of this.fnBtns) b.classList.toggle('on', k === fn);
    this.resetPending();
  }

  /** keyboard shortcut for a function button */
  fnForKey(key: string): StationFn | null {
    const f = FNS.find((x) => x.key === key.toUpperCase());
    return f ? f.fn : null;
  }

  resetPending() {
    if (this.view) {
      this.view.pendingStart = -1;
      this.view.previewRoute(null);
    }
    this.renderHint();
  }

  private renderHint(extra?: string) {
    const f = FNS.find((x) => x.fn === this.fn)!;
    clear(this.hint);
    this.hint.classList.toggle('danger', !!f.danger);
    const st = this.station >= 0 ? STATIONS[this.station].name : '';
    this.hint.append(h('span', { class: 'fnname' }, `${st} · ${f.label}`));
    const span = h('span', {});
    span.innerHTML = extra ?? f.hint;
    this.hint.append(span);
  }

  private onDevice(sel: Selection) {
    if (!sel || !this.view) return;
    const { topo, store } = this;
    const snap = store.snap;
    if (!snap) return;
    switch (this.fn) {
      case 'select':
        store.select(sel);
        return;
      case 'route':
      case 'guide': {
        const v = this.view;
        if (v.pendingStart < 0) {
          if (sel.kind !== 'signal') { toast('请先点击始端信号机', false); return; }
          const s = topo.signals[sel.id];
          if (!s.routes.length) { toast(`信号机 ${s.name} 不能作为进路始端`, false); return; }
          v.pendingStart = sel.id;
          v.previewRoute(s.routes, 0.22);
          const ends = Array.from(new Set(s.routes.map((r) => this.endName(r))));
          this.renderHint(`始端 <b>${s.name}</b> · 请点击终端：${ends.join('、')}（再次点击始端取消）`);
          return;
        }
        if (sel.kind === 'signal' && sel.id === v.pendingStart) { this.resetPending(); return; }
        const start = topo.signals[v.pendingStart];
        const cands = start.routes.filter((rid) => this.routeEndsAt(rid, sel));
        if (!cands.length) { toast(`${start.name} 至所选终端无进路`, false); return; }
        cands.sort((x, y) => Number(topo.routes[x].diverging) - Number(topo.routes[y].diverging) || topo.routes[x].length - topo.routes[y].length);
        const rid = cands[0];
        const r = topo.routes[rid];
        this.resetPending();
        if (this.fn === 'route') {
          void store.command({ c: 'setRoute', route: rid }).then((res) => toast(`排列进路 ${r.name}：${res.msg}`, res.ok));
        } else {
          void confirmAndSend(store, { title: `办理引导进路 ${r.name}`, cmd: { c: 'guideRoute', route: rid }, critical: true,
            detail: '引导进路不检查区段空闲（检查道岔位置/钩锁），开放引导信号，列车以RM模式≤25km/h目视行车通过。' });
        }
        return;
      }
      case 'cancel': {
        if (sel.kind !== 'signal') { toast('请点击进路始端信号机', false); return; }
        const s = topo.signals[sel.id];
        void store.command({ c: 'cancelRoute', signal: sel.id }).then((res) => toast(`取消进路（${s.name}）：${res.msg}`, res.ok));
        return;
      }
      case 'swN':
      case 'swR': {
        if (sel.kind !== 'switch') { toast('请点击道岔', false); return; }
        const pos = this.fn === 'swN' ? 'N' : 'R';
        const sw = topo.switches[sel.id];
        void store.command({ c: 'switchMove', sw: sel.id, pos }).then((res) => toast(`道岔 ${sw.name} 单操至${pos === 'N' ? '定位' : '反位'}：${res.msg}`, res.ok));
        return;
      }
      case 'lock': {
        if (sel.kind !== 'switch') { toast('请点击道岔', false); return; }
        const on = !(snap.switches[sel.id] & SW.SINGLE);
        const sw = topo.switches[sel.id];
        void store.command({ c: 'switchLock', sw: sel.id, on }).then((res) => toast(`道岔 ${sw.name} ${on ? '单锁' : '单解'}：${res.msg}`, res.ok));
        return;
      }
      case 'block': {
        if (sel.kind === 'switch') {
          const on = !(snap.switches[sel.id] & SW.BLOCKED);
          const sw = topo.switches[sel.id];
          void confirmAndSend(store, { title: `道岔 ${sw.name} ${on ? '封锁' : '解封'}`, cmd: { c: 'switchBlock', sw: sel.id, on }, critical: true,
            detail: on ? '封锁后不能办理经过该道岔的进路（仍可单操）。' : undefined });
        } else if (sel.kind === 'section') {
          const on = !(snap.sections[sel.id] & SEC.BLOCK);
          const s = topo.sections[sel.id];
          void confirmAndSend(store, { title: `区段 ${s.name} ${on ? '封锁' : '解封'}`, cmd: { c: 'sectionBlock', sections: [sel.id], on }, critical: true,
            detail: on ? '封锁后不能办理经过该区段的进路，列车不能进入。' : undefined });
        } else toast('请点击道岔或区段', false);
        return;
      }
      case 'secUnlock': {
        if (sel.kind !== 'section') { toast('请点击区段', false); return; }
        const s = topo.sections[sel.id];
        void confirmAndSend(store, { title: `区段故障解锁 ${s.name}`, cmd: { c: 'sectionUnlock', section: sel.id }, critical: true,
          detail: '确认区段内无车、无进路使用后执行，解除残留的进路锁闭。' });
        return;
      }
      case 'axle': {
        if (sel.kind !== 'section') { toast('请点击区段', false); return; }
        const s = topo.sections[sel.id];
        void confirmAndSend(store, { title: `计轴预复位 ${s.name}`, cmd: { c: 'axleReset', section: sel.id }, critical: true,
          detail: '确认区段内确无列车/车辆后执行。预复位后首列车须以 RM 模式压道出清，区段才恢复空闲。' });
        return;
      }
    }
  }

  private endName(rid: number): string {
    const r = this.topo.routes[rid];
    if (r.end >= 0) return this.topo.signals[r.end].name;
    const dep = this.topo.depots.find((d) => d.transferPaths.some((p) => p.gate === r.endNode));
    if (dep) return dep.short;
    const sec = this.topo.sections[r.sections[r.sections.length - 1]];
    return sec ? sec.name : '终端';
  }

  private routeEndsAt(rid: number, sel: Selection): boolean {
    const r = this.topo.routes[rid];
    if (!sel) return false;
    if (sel.kind === 'signal') return r.end === sel.id;
    if (sel.kind === 'depot') return r.end < 0 && this.topo.depots[sel.id].transferPaths.some((p) => p.gate === r.endNode);
    if (sel.kind === 'section') {
      const last = r.sections[r.sections.length - 1];
      if (r.end < 0) return last === sel.id || this.topo.sections[sel.id].links.some((l) => this.topo.links[l].a === r.endNode || this.topo.links[l].b === r.endNode);
      // a section just beyond the end signal also names that end (e.g. the receiving platform track)
      const endSig = this.topo.signals[r.end];
      return this.topo.sections[sel.id].links.includes(endSig.link);
    }
    if (sel.kind === 'platform') {
      const p = this.topo.platforms[sel.id];
      return r.sections[r.sections.length - 1] === p.section || (r.end >= 0 && this.topo.signals[r.end].link === p.link);
    }
    return false;
  }
}
