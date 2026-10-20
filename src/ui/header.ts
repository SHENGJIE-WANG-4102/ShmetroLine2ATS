/**
 * Top status bar: clock, simulation speed, the system title with the
 * Shanghai Metro and Line 2 logos, system level per ZC zone, KPIs (incl.
 * the day's ridership), alarm counters, and a 设置 menu with second-level
 * entries (UI scale, sound, the selected train's traction sound) plus 运营日 / 诊断导出 / 帮助.
 */
import { h, clear } from './dom';
import type { RecordedVolume } from '../data/onboardbank';
import type { Store } from './store';
import { fmtTime } from './theme';
import { UI_SCALES, loadPref, savePref } from './layout';
import { toast } from './confirm';
import { timePick } from './timepick';
import metroLogo from './assets/metro-logo.png';
import lineBadge from './assets/line2-badge.png';

export const SPEEDS = [1, 2, 5, 10, 30, 60, 120];
export { dayTypeOf, dateLabel } from '../sim/calendar';

export interface HeaderHooks {
  restart(): void;
  scale(): number;
  setScale(v: number): void;
  muted(): boolean;
  setMuted(m: boolean): void;
  traction(): boolean;
  setTraction(on: boolean): void;
  stationSound(): boolean;
  setStationSound(on: boolean): void;
  recordedVolume(): RecordedVolume;
  setRecordedVolume(level: RecordedVolume): void;
  help(): void;
}

export class Header {
  el: HTMLElement;
  private clock = h('div', { class: 'clock' }, '--:--:--');
  private date = h('div', {});
  private period = h('div', { class: 'period' });
  private speedSel: HTMLSelectElement;
  private pauseBtn: HTMLButtonElement;
  private zones = h('div', { style: 'display:flex;gap:8px' });
  private kpis = h('div', { style: 'display:flex;gap:22px;align-items:center' });
  private alarmCnt = h('div', { class: 'alarm-counter' });
  private settingsBtn: HTMLButtonElement;
  /** the 设置 drop-down; placed by the app in the overlay (the header clips its overflow) */
  menu: HTMLElement;
  private store: Store;
  private hooks: HeaderHooks;
  speed = 1;
  paused = false;
  /** achieved acceleration, shown when it falls short of the selected one */
  private actual = h('span', { class: 'lbl', style: 'color:var(--warn);min-width:0' });

  constructor(store: Store, hooks: HeaderHooks) {
    this.store = store;
    this.hooks = hooks;
    this.pauseBtn = h('button', { class: 'btn icon', title: '暂停/继续（空格）', onclick: () => this.setPaused(!this.paused) }, '❚❚');
    this.speedSel = h('select', { class: 'speed-sel', title: '模拟速率（数字键切换）' }, ...SPEEDS.map((s) => h('option', { value: s }, `${s}×`))) as HTMLSelectElement;
    this.speedSel.onchange = () => this.setSpeed(Number(this.speedSel.value));
    const jumpAt = timePick(17.5 * 3600);
    jumpAt.el.title = '快进目标时刻';
    const jumpBtn = h('button', {
      class: 'btn', title: '以最高速度推演到指定时刻',
      onclick: () => {
        let target = jumpAt.sec();
        const now = this.store.snap?.t ?? 0;
        while (target < now) target += 86400;
        if (target > 27.7 * 3600) return;
        this.store.send({ type: 'jump', to: target });
      },
    }, '快进至');
    this.settingsBtn = h('button', { class: 'btn settings-btn', title: '设置', onclick: (e: Event) => { e.stopPropagation(); this.toggleMenu(); } }, '设置 ▾');
    this.menu = h('div', { class: 'hdr-menu', hidden: true });
    this.el = h('div', { class: 'hdr' },
      h('div', { class: 'hdr-clock' }, this.clock, h('div', { class: 'clock-meta' }, this.date, this.period)),
      h('div', { class: 'hdr-speed' }, h('span', { class: 'lbl' }, '模拟速率'), this.pauseBtn, this.speedSel, this.actual, jumpAt.el, jumpBtn),
      h('div', { class: 'hdr-brand' },
        h('img', { class: 'metro-logo', src: metroLogo, alt: '上海地铁' }),
        h('img', { class: 'line-badge', src: lineBadge, alt: '2号线 Line 2' }),
        h('div', {}, h('div', { class: 'hdr-title' }, '上海地铁2号线列车自动监控系统'), h('div', { class: 'hdr-sub' }, 'ATS · OCC 行车调度 · CBTC 主用 / TBTC 后备')),
      ),
      h('div', { class: 'hdr-status' }, this.zones, this.kpis, this.alarmCnt, this.settingsBtn),
    );
    this.menu.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.addEventListener('pointerdown', () => this.toggleMenu(false));
    store.on('snap', () => this.update());
    store.on('alarms', () => this.updateAlarms());
    this.refreshScale();
  }

  stepScale(d: number) {
    const cur = this.hooks.scale();
    let i = UI_SCALES.findIndex((s) => Math.abs(s - cur) < 1e-3);
    if (i < 0) i = UI_SCALES.indexOf(1);
    i = Math.max(0, Math.min(UI_SCALES.length - 1, i + d));
    this.hooks.setScale(UI_SCALES[i]);
    this.refreshScale();
  }

  /** rebuild the menu so its checked entries follow the current settings */
  refreshScale() {
    if (!this.menu.hidden) this.buildMenu();
  }

  toggleMenu(open = this.menu.hidden) {
    this.menu.hidden = !open;
    this.settingsBtn.classList.toggle('on', open);
    if (open) this.buildMenu();
  }

  private buildMenu() {
    const close = (f: () => void) => () => { this.toggleMenu(false); f(); };
    const item = (label: string, act: () => void, opts: { on?: boolean; key?: string } = {}) =>
      h('div', { class: `mi ${opts.on ? 'on' : ''}`, onclick: act }, h('span', { class: 'ck' }, opts.on ? '✓' : ''), h('span', {}, label), h('span', { class: 'key' }, opts.key ?? ''));
    const sub = (label: string, value: string, ...items: HTMLElement[]) => {
      const el = h('div', { class: 'mi has-sub' }, h('span', { class: 'ck' }), h('span', {}, label), h('span', { class: 'key' }, `${value} ▸`), h('div', { class: 'submenu' }, ...items));
      el.addEventListener('click', (e) => { if (e.target === el || (e.target as HTMLElement).parentElement === el) el.classList.toggle('open'); });
      return el;
    };
    const scale = this.hooks.scale(), muted = this.hooks.muted(), traction = this.hooks.traction(), stationSound = this.hooks.stationSound();
    clear(this.menu);
    this.menu.append(
      sub('界面缩放', `${Math.round(scale * 100)}%`,
        ...UI_SCALES.map((v) => item(`${Math.round(v * 100)}%`, () => { this.hooks.setScale(v); this.refreshScale(); }, { on: Math.abs(v - scale) < 1e-3 })),
        h('div', { class: 'msep' }),
        item('放大', () => this.stepScale(1), { key: 'Ctrl +' }), item('缩小', () => this.stepScale(-1), { key: 'Ctrl −' })),
      sub('声音', muted ? '静音' : '开启',
        item('开启', () => this.hooks.setMuted(false), { on: !muted, key: 'M' }), item('静音', () => this.hooks.setMuted(true), { on: muted, key: 'M' })),
      sub('走行音', traction ? '开启' : '关闭',
        item('开启', () => { this.hooks.setTraction(true); this.refreshScale(); }, { on: traction }),
        item('关闭', () => { this.hooks.setTraction(false); this.refreshScale(); }, { on: !traction })),
      sub('车站音效', stationSound ? '开启' : '关闭',
        item('开启', () => { this.hooks.setStationSound(true); this.refreshScale(); }, { on: stationSound }),
        item('关闭', () => { this.hooks.setStationSound(false); this.refreshScale(); }, { on: !stationSound })),
      sub('车内/车站音量', ({ large: '大', medium: '中', small: '小' })[this.hooks.recordedVolume()],
        ...(['large', 'medium', 'small'] as const).map(v => item(({ large: '大', medium: '中', small: '小' })[v], () => { this.hooks.setRecordedVolume(v); this.refreshScale(); }, { on: v === this.hooks.recordedVolume() }))),
      sub('能耗与运行等级', this.energy ? '显示' : '隐藏',
        item('显示', () => this.setEnergy(true), { on: this.energy }),
        item('隐藏', () => this.setEnergy(false), { on: !this.energy })),
      h('div', { class: 'msep' }),
      item('运营日 / 重新开始…', close(() => this.hooks.restart())),
      item('诊断导出', close(() => this.store.send({ type: 'diagnostics' })), {}),
      item('上一运营日诊断导出', close(() => {void this.store.exportPreviousDiagnostics();})),
      item('帮助', close(() => this.hooks.help()), { key: 'F1' }),
    );
  }

  setSpeed(s: number) {
    this.speed = s;
    this.store.send({ type: 'speed', speed: s });
    this.speedSel.value = String(s);
  }
  setPaused(p: boolean) {
    this.paused = p;
    this.store.send({ type: 'pause', paused: p });
    this.pauseBtn.classList.toggle('on', p);
    this.pauseBtn.textContent = p ? '▶' : '❚❚';
  }

  private lastZones = '';
  private lastKpi = '';
  update() {
    const s = this.store.snap;
    if (!s) return;
    this.clock.textContent = fmtTime(s.t);
    // the worker drops the backlog it cannot compute: say how fast it really runs
    const got = s.stats.speedActual;
    const short = s.stats.speedWanted > 1 && got < s.stats.speedWanted * 0.9;
    const capped = s.stats.speedCap < this.speed;
    const txt = capped ? `人工驾驶 限${s.stats.speedCap}×` : short ? `实际 ${Math.round(got)}×` : '';
    if (this.actual.textContent !== txt) {
      this.actual.textContent = txt;
      this.actual.title = capped ? `线上有CM/RM列车（人工驾驶或降级），仿真速率暂限 ${s.stats.speedCap}×；恢复自动驾驶后回到所选 ${this.speed}×`
        : short ? `所选 ${Math.round(s.stats.speedWanted)}×，实际 ${got.toFixed(0)}×（${s.stats.stepsPerSec} 步/秒）；计算跟不上，每秒约 ${s.stats.droppedPerSec.toFixed(0)} 秒仿真时间的积压被舍弃（列车位置不受影响，只是推演变慢）` : '';
    }
    const dt = s.dayType === 'weekday' ? '工作日图' : '双休日/节假日图';
    this.date.textContent = `${s.dateLabel} · ${dt}`;
    const plan = this.store.plan;
    if (plan) {
      const p = plan.periods.find((x) => s.t >= x.from && s.t < x.to);
      const ov = plan.overlays.filter((o) => s.t >= o.from && s.t <= o.to).map((o) => o.label);
      // after the last regular train, the fixed-time late trains (虹桥 → 龙阳路, more on the
      // holiday return nights) still run: not 收车 yet
      let label = p?.label ?? '—';
      if (label === '末班/收车') {
        const end = (x: (typeof plan.trips)[number]) => x.stops[x.stops.length - 1].arr ?? 0;
        const live = plan.trips.filter((x) => x.revenue && !x.cancelled && end(x) > s.t);
        if (live.length && live.every((x) => x.kind === 'extra')) label = `延时运营（${live.length}班）`;
      }
      const txt = `${label}${ov.length ? ' + ' + ov.join('、') : ''}${s.scenario && !s.scenario.ended ? ` · 场景：${s.scenario.name}` : ''}`;
      if (this.period.textContent !== txt) this.period.textContent = txt;
    }
    const zk = s.zones.join(',');
    if (zk !== this.lastZones) {
      this.lastZones = zk;
      clear(this.zones);
      s.zones.forEach((z, i) => {
        const name = this.store.topo.zones[i].key;
        this.zones.append(h('div', { class: `zone-chip ${z}`, title: this.store.topo.zones[i].name, onclick: () => this.store.select({ kind: 'zone', id: i }) },
          h('span', { class: 'z' }, name), h('span', { class: 'lv' }, z === 'ZCFAIL' ? '故障' : z)));
      });
    }
    const st = s.stats;
    let riders = 0;
    for (const row of s.ridership.boardings) for (const v of row) riders += v;
    const wan = (riders / 1e4).toFixed(1);
    // traction energy (energy.ts), only when asked for
    const en = s.energy;
    const perKm = en.km > 1 ? (en.drawn - en.reused) / 3.6e6 / en.km : 0;
    const reuse = en.regen > 0 ? en.reused / en.regen : 0;
    const eKey = this.energy ? `${perKm.toFixed(2)}|${Math.round(reuse * 100)}|${s.runLevel}` : '';
    const key = `${wan}|${st.online}|${st.inService}|${st.late}|${st.punctuality.toFixed(3)}|${st.tripsDone}|${st.tripsPlanned}|${eKey}`;
    if (key === this.lastKpi) return;
    this.lastKpi = key;
    clear(this.kpis);
    const kpi = (v: string, k: string, cls = '') => h('div', { class: `kpi ${cls}` }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));
    this.kpis.append(
      kpi(`${wan}万`, '今日客流'),
      kpi(`${st.inService}/${st.online}`, '载客/在线'),
      kpi(String(st.late), '晚点>2分', st.late > 0 ? 'late' : ''),
      kpi(`${(st.punctuality * 100).toFixed(1)}%`, '正点率', st.punctuality < 0.98 ? 'warn' : ''),
      kpi(`${st.tripsDone}/${st.tripsPlanned}`, '完成车次'),
    );
    if (this.energy) {
      const lvl = h('select', { title: 'ATO 运行等级：按图逐区间选择；1/2/3全线手动覆盖。1全性能、2惰行节能、3低速惰行。晚点超过20秒自动回1级' },
        h('option', { value: 0 }, '按图'),
        ...[1, 2, 3].map((v) => h('option', { value: v }, String(v)))) as HTMLSelectElement;
      lvl.value = String(s.runLevel);
      lvl.onchange = async () => { const r = await this.store.command({ c: 'runLevel', level: Number(lvl.value) }); toast(r.msg, r.ok); };
      this.kpis.append(
        kpi(perKm ? perKm.toFixed(2) : '—', `kWh/车公里·再生${Math.round(reuse * 100)}%`),
        h('div', { class: 'kpi' }, h('div', { class: 'v' }, lvl), h('div', { class: 'k' }, '运行等级')),
      );
    }
  }

  /** 设置 › 能耗与运行等级 (D67): off by default, for when the day is not about energy */
  private energy = loadPref('energy', false);
  private setEnergy(on: boolean) {
    this.energy = on;
    savePref('energy', on);
    this.lastKpi = '';
    this.refreshScale();
  }

  updateAlarms() {
    const cnt = { A: 0, B: 0, C: 0 };
    const unack = { A: false, B: false, C: false };
    for (const a of this.store.alarms) {
      if (a.level === 'I') continue;
      cnt[a.level]++;
      if (!a.ack) unack[a.level] = true;
    }
    clear(this.alarmCnt);
    for (const l of ['A', 'B', 'C'] as const) {
      this.alarmCnt.append(h('span', { class: `${l} ${cnt[l] ? 'has' : ''} ${unack[l] && l === 'A' ? 'active' : ''}`, title: `${l}级报警` }, String(cnt[l])));
    }
  }
}
