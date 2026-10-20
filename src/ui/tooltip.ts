/** Hover tooltip for schematic objects. */
import { h, clear } from './dom';
import type { Store } from './store';
import { STATIONS, LINE_INFO } from '../data/line2';
import { SEC, SW, SIG_ASPECT } from '../sim/model';
import { fmtDelay } from './theme';

const ASPECT_CN: Record<string, string> = { R: '禁止（红）', G: '绿灯', Y: '黄灯', GUIDE: '引导（红+白）', DARK: '灭灯（CBTC）', FAIL: '故障' };

export class Tooltip {
  el = h('div', { class: 'tooltip', style: 'display:none' });
  private store: Store;
  private mx = 0;
  private my = 0;
  private groupKey = '';
  /** logical canvas size (for keeping the tooltip on screen) */
  bounds = { w: 3840, h: 2160 };

  constructor(store: Store) {
    this.store = store;
    store.on('hover', () => this.render());
    store.on('trainGroup', () => this.render());
    store.on('snap', () => { if (this.store.hover || this.store.trainGroup) this.render(); });
  }

  /** mouse position in design coordinates */
  move(x: number, y: number) {
    if (this.store.trainGroup?.pinned) return;
    this.mx = x;
    this.my = y;
    if (this.el.style.display !== 'none') this.place();
  }

  private place() {
    const w = this.el.offsetWidth || 360;
    const hgt = this.el.offsetHeight || 200;
    let x = this.mx + 22;
    let y = this.my + 22;
    if (x + w > this.bounds.w - 10) x = this.mx - w - 22;
    if (y + hgt > this.bounds.h - 10) y = this.my - hgt - 22;
    x = Math.max(4, x);
    y = Math.max(4, y);
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
  }

  private row(k: string, v: string) {
    return h('div', { class: 'row' }, h('span', {}, k), h('span', {}, v));
  }

  private render() {
    const hov = this.store.hover;
    const snap = this.store.snap;
    const group = this.store.trainGroup;
    this.el.classList.toggle('train-group', !!group?.pinned);
    if ((!hov && !group) || !snap) { this.groupKey=''; this.el.style.display = 'none'; return; }
    const liveIds=group?.ids.filter(id=>snap.trains.some(t=>t.id===id))??[];
    const key = group ? `${group.pinned}:${liveIds.join(',')}` : '';
    if (group && key === this.groupKey) {
      for (const button of this.el.querySelectorAll<HTMLButtonElement>('button[data-train]')) {
        const t = snap.trains.find(t=>t.id===Number(button.dataset.train));
        if (t) button.textContent = `${t.svc}-${t.trip}　${fmtDelay(t.delay)}`;
      }
      return;
    }
    this.groupKey = key;
    const { topo } = this.store;
    clear(this.el);
    if (group) {
      const trains = group.ids.flatMap(id => snap.trains.find(t => t.id === id) ?? []);
      this.el.append(h('div', { class: 'tt' }, `${trains.length} 列排队列车`));
      if (group.pinned) this.el.append(h('button', { class: 'btn', onclick: () => this.store.showTrainGroup(null, true) }, '关闭'));
      else this.el.append(this.row('提示', '点击汇总窗口后可选择列车'));
      for (const t of trains) this.el.append(h('button', { class: 'btn group-train', 'data-train':String(t.id),
        onclick: () => this.store.select({ kind: 'train', id: t.id }) }, `${t.svc}-${t.trip}　${fmtDelay(t.delay)}`));
      this.el.style.maxHeight = `${Math.max(100, this.bounds.h - 80)}px`;
      this.el.style.overflowY = 'auto';
    } else if (hov?.kind === 'train') {
      const t = snap.trains.find((x) => x.id === hov.id);
      if (!t) { this.el.style.display = 'none'; return; }
      this.el.append(h('div', { class: 'tt' }, `${t.svc}-${t.trip}  ${t.vehicle}`),
        this.row('目的地', t.dest || '—'), this.row('速度', `${(t.v * 3.6).toFixed(0)} km/h`), this.row('模式/级别', `${t.mode} / ${t.level}${t.comm ? '' : ' 通信中断'}`),
        this.row('晚点', t.inService ? fmtDelay(t.delay) : '非载客'), this.row('满载率', `${Math.round((t.load / LINE_INFO.capacity) * 100)}%`), this.row('任务', t.task),
        ...(t.maReason ? [this.row('移动授权', `${t.maReason} ${Math.round(t.maDist)}m`)] : []),
        ...(t.halt ? [this.row('停车原因', `${t.halt.label}${t.halt.blocker ? `（${t.halt.blocker}）` : ''} [${t.halt.code}] ${Math.round((snap.t - t.halt.since) / 60)}分`)] : []));
    } else if (hov?.kind === 'signal') {
      const s = topo.signals[hov.id];
      const r = snap.activeRoutes.find((x) => topo.routes[x].start === hov.id);
      this.el.append(h('div', { class: 'tt' }, s.name), this.row('车站', STATIONS[s.station].name), this.row('显示', ASPECT_CN[SIG_ASPECT[snap.signals[hov.id] & 7]]), this.row('进路', r !== undefined ? topo.routes[r].name : '无'));
    } else if (hov?.kind === 'section') {
      const s = topo.sections[hov.id];
      const f = snap.sections[hov.id];
      this.el.append(h('div', { class: 'tt' }, s.name), this.row('位置', STATIONS[s.station].name), this.row('长度', `${Math.round(s.len)} m`),
        this.row('状态', f & SEC.DIST ? '故障占用' : f & SEC.PRESET ? '预复位' : f & SEC.OCC ? (f & SEC.COMM ? 'CBTC列车占用' : '计轴占用') : '空闲'),
        this.row('锁闭', f & SEC.LOCK ? (f & SEC.ROUTEFLEET ? '自动通过' : '进路锁闭') : '—'), ...(f & SEC.TSR ? [this.row('临时限速', `${snap.sectionTsr[hov.id]} km/h`)] : []),
        ...(f & SEC.ENV ? [this.row('天气限速', snap.sectionTsr[hov.id] > 0 ? `${snap.sectionTsr[hov.id]} km/h` : '停运')] : []),
        ...(f & SEC.BLOCK ? [this.row('封锁', f & SEC.POSS ? '施工封锁' : '调度封锁')] : []));
    } else if (hov?.kind === 'switch') {
      const s = topo.switches[hov.id];
      const f = snap.switches[hov.id];
      this.el.append(h('div', { class: 'tt' }, s.name), this.row('位置', f & SW.FAILED ? '失表' : f & SW.MOVING ? '转换中' : f & SW.R ? '反位' : '定位'), this.row('锁闭', f & SW.LOCKED ? '进路锁闭' : f & SW.SINGLE ? '单锁' : '—'),
        ...(f & SW.BLOCKED ? [this.row('封锁', '已封锁')] : []), ...(f & SW.FIELD ? [this.row('钩锁', '现场钩锁')] : []));
    } else if (hov?.kind === 'platform') {
      const p = topo.platforms[hov.id];
      this.el.append(h('div', { class: 'tt' }, p.name), this.row('候车', `${snap.platformWaiting[hov.id]} 人`), this.row('提示', '点击查看详情与 PIS'));
    } else { this.el.style.display = 'none'; return; }
    this.el.style.display = 'block';
    this.place();
  }
}
