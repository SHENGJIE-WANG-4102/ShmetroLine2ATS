/**
 * Right-hand column: alarm list (collapsed when empty, flashing on a new
 * alarm), incoming radio / phone calls, and the tabbed area:
 * 详情 (selection details & commands) · 列车 · 事件 · 教员 · 回放.
 */
import { h, clear } from './dom';
import type { Store, Selection } from './store';
import { fmtTime, fmtDelay } from './theme';
import { CommandPanel, type PanelHooks } from './cmdpanel';
import { confirmAndSend, toast, showIntegritySnapshot } from './confirm';
import { FAULT_LABELS } from '../sim/faults';
import { SCENARIOS, RANDOM_LEVELS } from '../sim/scenario';
import { STATIONS, LINE_INFO, WEATHER_RULES } from '../data/line2';
import type { FaultKind, RadioCall, SimEvent } from '../sim/model';
import type { Audio } from './audio';
import type { VvvfMode } from './vvvf';
import { PERF, tractionAccel } from '../sim/dynamics';
import { stationFrame, audioTrain, VVVF_MAX_RATE } from './stationaudio';
import { onboardFrame } from './onboardaudio';

const CAT_FILTERS = ['全部', '报警', '调度', '通话', '信号', '列车', '车站', '客流', '施工', '教员'];

const PROCEDURES: Record<FaultKind, string> = {
  trainComm: '后果：ZC 失去列车位置，该车按计轴区段占用防护；列车紧急制动。处置：司机停稳后报告 → 授权缓解并降级TBTC后备（AM）运行；通信恢复后在下一区段边界不停车升级CBTC（DTO）。',
  trainDto: '后果：该车DTO功能不可用（如障碍物检测、车载DTO设备故障），仍在CBTC下运行，但须司机在驾驶室值守：下一站停站时转ATO（AM），折返时司机换端（多约45秒），发车需司机按ATO启动按钮。处置：调度确认司机已上岗；故障修复后停站时恢复DTO，或安排回段检修。',
  zcFail: '后果：区域内CBTC列车失去移动授权，原地转TBTC后备（AM）按固定闭塞运行。处置：“切换TBTC”（二次确认）使后续列车停站降级；ZC修复后“恢复CBTC”，列车不停车升级。',
  axle: '后果：区段故障占用，列车在区段前停车。处置：设备修复后“计轴预复位”（二次确认）→ 首列车来电申请RM压道 → 同意。',
  switch: '后果：道岔失表，经过该道岔的进路无法办理。处置：单操试排 → 通知维修 → 钩锁确认（二次确认）→ 引导进路 → 修复后单操恢复表示、取消钩锁。',
  signal: '后果：信号机无法开放。处置：办理引导进路（二次确认），列车凭引导信号RM通过；修复后恢复。',
  psd: '后果：站台门无法关闭锁紧，列车不能发车。处置：车站来电申请互锁解除 → 同意（二次确认）；修复后取消互锁解除。',
  psdLink: '后果：车门与站台门不能联动，由车站人员在PSL开关站台门，每次开/关约多耗时15秒；列车仍按DTO运行。处置：通知车站PSL操作；修复后自动恢复联动。',
  trainFail: '后果：列车故障停车。处置：可恢复时司机约4分钟内恢复；不能恢复时司机来电请求救援 → 组织后车救援。',
  traction: '后果：切除1–2个牵引单元（共6个），加速变慢，晚点并拖累后车；“可自行恢复”时司机约3–5分钟复位成功。处置：司机来电 → 继续运营终点站下线 / 前方站清客回段 / 继续运营夜间检修。',
  door: '后果：下次关门时一扇车门关不上，司机约75秒切除后发车，此后每站停站略长。严重（无法切除）：列车不能动车 → 本站清客锁闭车门回段，或等候检修人员（约8分钟）。',
  brake: '后果：下次发车时一辆车制动不缓解，司机约2分钟处置；“可自行恢复”时缓解成功，否则切除该车制动、限速60 km/h → 终点站下线或前方站清客回段。严重（多车）：无法动车，组织救援。',
  surge: '后果：进站客流成倍增加，停站时间延长。处置：限流、扣车均衡间隔、加开列车。',
  pecu: '后果：司机来电请求处置方式。未应答时司机自行区间停车。',
  trackPerson: '后果：车站来电请求紧急关闭站台。必须立即同意；未应答时车站自行按下紧急停车按钮（安全违章）。',
};

export class SidePanel {
  el: HTMLElement;
  private store: Store;
  private audio: Audio;
  private alarmPanel: HTMLElement;
  private alarmBody = h('tbody');
  private alarmMeta = h('span', { class: 'meta' });
  private callsPanel: HTMLElement;
  private callsBody = h('div', { class: 'panel-b' });
  private callsMeta = h('span', { class: 'meta' });
  private tabBody = h('div', { class: 'panel-b' });
  private tabs: HTMLElement[] = [];
  private tab = 0;
  cmd: CommandPanel;
  private evFilter = '全部';
  private evBody = h('tbody');
  private evCount = 0;
  private trainBody = h('tbody');
  private lastDraw = 0;
  private faultList = h('div', { style: 'display:flex;flex-direction:column;gap:8px' });
  private scenarioBox = h('div', { style: 'display:flex;flex-direction:column;gap:10px' });
  private replayBox = h('div', { style: 'display:flex;flex-direction:column;gap:10px' });
  private seenAlarms = new Set<number>();
  private seenCalls = new Set<number>();
  /** the restriction last announced in the manual cab (chime once per restriction) */
  private hooks: PanelHooks & { rewind(t: number, replay: boolean): void; locateSel(sel: Selection): void };

  constructor(store: Store, audio: Audio, hooks: PanelHooks & { rewind(t: number, replay: boolean): void; locateSel(sel: Selection): void }) {
    this.store = store;
    this.audio = audio;
    this.hooks = hooks;
    this.cmd = new CommandPanel(store, hooks);
    const ackAll = h('button', { class: 'btn', onclick: () => {
      const ids = this.store.alarms.filter((a) => !a.ack).map((a) => a.id);
      if (ids.length) void this.store.command({ c: 'ack', ids });
    } }, '全部确认');
    this.alarmPanel = h('div', { class: 'panel alarms empty' },
      h('div', { class: 'panel-h' }, h('span', { class: 't' }, '实时报警'), this.alarmMeta, h('span', { class: 'sp' }), ackAll),
      h('div', { class: 'panel-b' }, h('table', { class: 'grid' }, this.alarmBody)),
    );
    this.callsPanel = h('div', { class: 'panel calls hidden' },
      h('div', { class: 'panel-h' }, h('span', { class: 't' }, '调度电话 · 无线'), this.callsMeta),
      this.callsBody,
    );
    const names = ['详情', '列车', '事件', '教员', '回放', '客流'];
    const tabBar = h('div', { class: 'tabs' });
    names.forEach((n, i) => {
      const t = h('div', { class: `tab ${i === 0 ? 'on' : ''}`, onclick: () => this.setTab(i) }, n);
      this.tabs.push(t);
      tabBar.append(t);
    });
    const tabPanel = h('div', { class: 'panel', style: 'flex:1' }, tabBar, this.tabBody);
    this.el = h('div', { class: 'side' }, this.alarmPanel, this.callsPanel, tabPanel);
    this.setTab(0);
    store.on('alarms', () => this.renderAlarms());
    store.on('events', () => { if (this.tab === 2) this.appendEvents(); });
    store.on('rewound', () => { if (this.tab === 2) this.setTab(2); });
    store.on('selection', () => { if (this.store.selection && this.tab !== 0) this.setTab(0); });
    store.on('selection', () => this.audio.stopStationAudio());
    store.on('rewound', () => this.audio.stopStationAudio());
    store.on('ready', () => this.audio.stopStationAudio());
    store.on('ready', () => { this.seenAlarms.clear(); this.seenCalls.clear(); });
    store.on('snap', () => {
      this.renderCalls();
      const now = performance.now();
      if (now - this.lastDraw > 1000) {
        this.lastDraw = now;
        if (this.tab === 1) this.renderTrains();
        if (this.tab === 3) { this.renderFaultList(); this.renderScenarioState(); }
        if (this.tab === 4) this.renderReplay();
        if (this.tab === 5) this.renderRidership();
      }
    });
  }

  setTab(i: number) {
    this.tab = i;
    this.tabs.forEach((t, k) => t.classList.toggle('on', k === i));
    clear(this.tabBody);
    if (i === 0) this.tabBody.append(this.cmd.el);
    if (i === 1) this.renderTrainsTab();
    if (i === 2) this.renderEventsTab();
    if (i === 3) this.renderInstructorTab();
    if (i === 4) this.renderReplayTab();
    if (i === 5) this.renderRidership();
  }

  // ---------------------------------------------------------------- alarms
  private renderAlarms() {
    clear(this.alarmBody);
    const order = { A: 0, B: 1, C: 2, I: 3 };
    const list = [...this.store.alarms].sort((a, b) => Number(!!a.ack) - Number(!!b.ack) || order[a.level] - order[b.level] || b.t - a.t);
    let fresh: 'A' | 'B' | 'C' | null = null;
    for (const a of list) {
      if (!this.seenAlarms.has(a.id)) {
        this.seenAlarms.add(a.id);
        if (a.level !== 'I' && (!fresh || order[a.level] < order[fresh])) fresh = a.level;
      }
      const sel = alarmTarget(a);
      const tr = h('tr', { class: `${a.ack ? '' : 'unack'} ${a.level}`, style: 'cursor:pointer', onclick: () => {
        if (!a.ack) void this.store.command({ c: 'ack', ids: [a.id] });
        if (sel) this.hooks.locateSel(sel);
      } },
        h('td', { class: 'mono', style: 'width:120px' }, fmtTime(a.t)),
        h('td', { style: 'width:56px' }, h('span', { class: `lvl ${a.level}` }, a.level)),
        h('td', { class: 'txt wrap' }, a.text, ...(a.snapshot ? [h('button', {
          class: 'btn', onclick: (e: Event) => { e.stopPropagation(); showIntegritySnapshot(a.snapshot!); },
        }, '快照')] : [])),
      );
      this.alarmBody.append(tr);
    }
    const unack = list.filter((a) => !a.ack).length;
    this.alarmPanel.classList.toggle('empty', list.length === 0);
    this.alarmMeta.textContent = list.length ? `${list.length} 条 · 未确认 ${unack} · 点击行确认并定位` : '无活动报警';
    if (fresh) {
      this.alarmPanel.classList.remove('flash');
      void this.alarmPanel.offsetWidth;
      this.alarmPanel.classList.add('flash');
      this.audio.alarm(fresh);
    }
    this.audio.setAlarmLoop(list.some((a) => a.level === 'A' && !a.ack));
  }

  // ---------------------------------------------------------------- calls
  private callsKey = '';
  private renderCalls() {
    const snap = this.store.snap;
    if (!snap) return;
    const calls = snap.calls;
    const ringing = calls.filter((c) => c.state === 'ringing');
    for (const c of ringing) {
      if (!this.seenCalls.has(c.id)) {
        this.seenCalls.add(c.id);
        if (!snap.autoRadio && !snap.paused && snap.speed > 5) {
          // bring time back to real time so the dispatcher can answer
          this.store.emit('slowForCall');
        }
      }
    }
    this.audio.setRinging(ringing.length > 0 && !snap.autoRadio);
    // the manual cab: warning above the permitted speed (RM 25 km/h), before the EB
    const cab = snap.trains.find((t) => t.manual);
    this.audio.setOverspeed(!!cab && cab.phase === 'run' && !cab.eb && cab.v > cab.vPermit + 0.05);
    // the inverter of the selected train (02A05 recordings for every train until other stock is recorded)
    const sel = this.store.selection;
    const heard = sel?.kind === 'train' ? snap.trains.find((t) => t.id === sel.id) : undefined;
    let mode: VvvfMode = 'off', level = 0;
    if (heard && !snap.paused && snap.speed <= VVVF_MAX_RATE && heard.phase === 'run' && !heard.eb && !heard.failed) {
      // ATO holding its target speed keeps the inverter on at low torque, through its small pulses of power
      if (!heard.manual && heard.v > 1 && heard.v >= heard.vTarget - 0.4 && heard.a > -0.05) {
        mode = 'cruise'; level = 0.45 + 0.55 * Math.max(0, heard.a) / tractionAccel(heard.v);
      } else if (heard.a > 0.03) { mode = 'power'; level = heard.a / tractionAccel(heard.v); }
      // the electric brake holds down to a stand (the stop recording runs to 0 Hz)
      else if (heard.a < -0.05 && heard.v > 0) { mode = 'brake'; level = -heard.a / PERF.bService; }
    }
    // the inverter follows the wheels: spinning they run ahead of the train, sliding they fall behind,
    // and the anti-slip / WSP control makes the pitch hunt as it cycles
    const hunt = Math.sin(performance.now() / 120);
    const wheel = heard?.slip === 'slip' ? 1.12 + 0.06 * hunt : heard?.slip === 'slide' ? 0.85 + 0.05 * hunt : 1;
    this.audio.setTraction(mode, (heard?.v ?? 0) * wheel, level);
    // a selected platform hears its own station
    const heardStation = sel?.kind === 'station' ? sel.id : sel?.kind === 'platform' ? this.store.topo.platforms[sel.id]?.station ?? null : null;
    const platformFrame = stationFrame(snap, heardStation, this.store.topo);
    this.audio.setStationAudio(platformFrame);
    this.audio.setOnboardAudio(onboardFrame(snap, heard ?? null, this.store.topo, this.store.plan));
    this.audio.setDoorAudio({ t: snap.t, rate: snap.speed, paused: snap.paused,
      perspective: heard ? 'onboard' : 'platform', station: heardStation,
      selectionKey: heard ? `train|${heard.id}` : heardStation === null ? '' : `station|${heardStation}`,
      trains: heard ? [audioTrain(heard, heard.nextStation, this.store.topo)] : platformFrame.trains.filter(tr => tr.atStation) });
    const key = calls.map((c) => `${c.id}:${c.state}:${Math.ceil((c.deadline - snap.t) / 5)}`).join(',') + snap.autoRadio;
    if (key === this.callsKey) return;
    this.callsKey = key;
    this.callsPanel.classList.toggle('hidden', calls.length === 0);
    this.callsMeta.textContent = ringing.length ? `${ringing.length} 个来电待应答${snap.autoRadio ? '（自动应答中）' : ''}` : '';
    clear(this.callsBody);
    for (const c of calls.slice().sort((a, b) => Number(b.state === 'ringing') - Number(a.state === 'ringing') || a.deadline - b.deadline)) {
      this.callsBody.append(this.callCard(c, snap.t));
    }
  }

  private callCard(c: RadioCall, t: number) {
    const ringing = c.state === 'ringing';
    const left = Math.max(0, c.deadline - t);
    const total = Math.max(1, c.deadline - c.t);
    const card = h('div', { class: `call ${ringing ? '' : 'done'}` },
      h('div', { class: 'who' }, h('span', { class: 'ico' }, ringing ? '☎' : '✓'), h('span', {}, c.from), h('span', { style: 'flex:1' }),
        h('span', { class: 'mono', style: 'color:var(--text-dim);font-size:20px' }, ringing ? `剩 ${Math.ceil(left)} s` : c.state === 'expired' ? '未应答' : `已应答：${c.options.find((o) => o.key === c.answer)?.label ?? ''}`)),
      h('div', { class: 'msg' }, c.text, c.repeats ? h('span', { class: 'chip late', style: 'margin-left:10px' }, `第${c.repeats + 1}次呼叫`) : ''),
    );
    if (ringing) {
      card.append(h('div', { class: `bar ${left / total < 0.3 ? 'low' : ''}` }, h('i', { style: `width:${(left / total) * 100}%` })));
      const opts = h('div', { class: 'opts' });
      for (const o of c.options) {
        opts.append(h('button', { class: `btn ${o.critical ? 'danger' : o.key === c.auto ? 'primary' : ''}`, onclick: async () => {
          this.audio.squelch();
          if (o.critical) await confirmAndSend(this.store, { title: `应答 ${c.from}：${o.label}`, cmd: { c: 'radio', call: c.id, option: o.key }, critical: true, detail: c.text });
          else {
            const r = await this.store.command({ c: 'radio', call: c.id, option: o.key });
            toast(r.msg, r.ok);
          }
        } }, o.label));
      }
      if (c.train !== undefined) opts.append(h('button', { class: 'btn icon', title: '定位列车', onclick: () => this.hooks.locateSel({ kind: 'train', id: c.train! }) }, '⌖'));
      else if (c.target !== undefined && (c.kind === 'psd' || c.kind === 'trackPerson' || c.kind === 'espClear')) opts.append(h('button', { class: 'btn icon', title: '定位站台', onclick: () => this.hooks.locateSel({ kind: 'platform', id: c.target! }) }, '⌖'));
      card.append(opts);
    }
    return card;
  }

  // ---------------------------------------------------------------- events
  private renderEventsTab() {
    const bar = h('div', { style: 'display:flex;gap:8px;padding:10px;border-bottom:1px solid var(--border);flex-wrap:wrap' });
    for (const f of CAT_FILTERS) bar.append(h('button', { class: `btn ${f === this.evFilter ? 'on' : ''}`, style: 'min-width:0', onclick: () => { this.evFilter = f; this.setTab(2); } }, f));
    this.evBody = h('tbody');
    this.evCount = 0;
    const table = h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', { style: 'width:120px' }, '时间'), h('th', { style: 'width:56px' }, '级'), h('th', { style: 'width:80px' }, '类别'), h('th', {}, '事件'))), this.evBody);
    this.tabBody.append(bar, table);
    this.appendEvents();
  }

  private match(e: SimEvent) {
    switch (this.evFilter) {
      case '全部': return true;
      case '报警': return e.level !== 'I';
      case '调度': return !!e.manual;
      default: return e.cat === this.evFilter;
    }
  }

  private appendEvents() {
    const ev = this.store.events;
    if (this.evCount > ev.length) this.evCount = 0;
    const rows: HTMLElement[] = [];
    for (let i = this.evCount; i < ev.length; i++) {
      const e = ev[i];
      if (!this.match(e)) continue;
      const recovered = e.text.startsWith('【恢复】');
      rows.push(h('tr', { class: `${e.manual ? 'manual' : ''} ${recovered ? 'recovered' : ''}` },
        h('td', { class: 'mono' }, fmtTime(e.t)), h('td', {}, h('span', { class: `lvl ${e.level}` }, e.level)), h('td', {}, e.cat), h('td', { class: 'txt wrap' }, e.text)));
    }
    this.evCount = ev.length;
    for (const r of rows.reverse()) this.evBody.prepend(r);
    while (this.evBody.children.length > 1200) this.evBody.lastElementChild?.remove();
  }

  // ---------------------------------------------------------------- trains
  private renderTrainsTab() {
    this.trainBody = h('tbody');
    this.tabBody.append(h('table', { class: 'grid' }, h('thead', {}, h('tr', {},
      ...['表号-车次', '目的地', '位置', '速度', '模式', '晚点', '满载', '状态'].map((t) => h('th', {}, t)))), this.trainBody));
    this.renderTrains();
  }

  private ridershipHour = -1;
  private renderRidership() {
    const snap = this.store.snap;
    if (!snap) return;
    clear(this.tabBody);
    const r = snap.ridership;
    const hour = h('select', { class: 'btn', onchange: (e: Event) => { this.ridershipHour = Number((e.target as HTMLSelectElement).value); this.renderRidership(); } },
      h('option', { value: '-1' }, '全运营日'),
      ...Array.from({length: 24}, (_,i) => { const h0=i+4; return h('option', { value: String(h0) }, `${h0 >= 24 ? '次日 ' : ''}${String(h0 % 24).padStart(2,'0')}:00–${String((h0+1)%24).padStart(2,'0')}:00`); }));
    hour.value = String(this.ridershipHour);
    const sum = (a: number[]) => this.ridershipHour < 0 ? a.reduce((x,y)=>x+y,0) : a[this.ridershipHour];
    this.tabBody.append(h('div', { class: 'sect-title' }, '线路客流'),
      h('div', { class: 'hint' }, `今日上车 ${Math.round(snap.stats.passengers).toLocaleString()} 人次 · 高峰最大断面 ${Math.round(r.peakSectionLoad / LINE_INFO.capacity * 100)}% · 全日最大载客 ${Math.round(r.maxLoad).toLocaleString()} 人`),
      h('div', { class: 'hint' }, `校准目标：${snap.dayType === 'weekday' ? '工作日 109万' : '休息日 76.3万'} 人次 · 包含换乘上车`),
      h('div', { class: 'form' }, h('label', {}, '统计时段'), hour),
      h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', {}, '车站'), h('th', {}, '上车'), h('th', {}, '下车'))),
        h('tbody', {}, ...STATIONS.map((st,i)=>h('tr', {}, h('td', {}, st.name), h('td', { class:'mono' }, Math.round(sum(r.boardings[i])).toLocaleString()), h('td', { class:'mono' }, Math.round(sum(r.alightings[i])).toLocaleString()))))));
    this.renderConnections(snap);
  }

  /** tonight's last-train connections near now (D63) */
  private renderConnections(snap: NonNullable<Store['snap']>) {
    const now = snap.t;
    const list = snap.connections.filter((c) => c.state === 'missed'
      || (c.kind === 'feed' ? c.l2 : c.planned) >= now - 15 * 60 && (c.kind === 'feed' ? c.l2 : c.planned) <= now + 60 * 60)
      .sort((a, b) => (a.kind === 'feed' ? a.l2 : a.planned) - (b.kind === 'feed' ? b.l2 : b.planned));
    if (!list.length) return;
    const STATE: Record<string, [string, string]> = {
      pending: ['—', ''],
      made: ['已衔接', 'color:var(--ok, inherit)'], missed: ['未衔接', 'color:var(--bad)'], void: ['车次取消', ''],
    };
    const hm = (t: number) => fmtTime(t).slice(0, 5);
    const line = (c: (typeof list)[number]) => `${/^\d+$/.test(c.line) ? `${c.line}号线` : c.line}往${c.toward}`;
    const trip = (id: number) => snap.trains.find((t) => t.tripId === id);
    this.tabBody.append(h('div', { class: 'sect-title' }, '末班接续（他线末班 ↔ 2号线）'),
      h('div', { class: 'hint' }, '按各线公布的末班时刻能衔接的换乘。各线不互相等候（车站广播提醒乘客注意换乘线路首末班时间），2号线晚点赶不上的换乘乘客记为滞留。'),
      h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', {}, '车站'), h('th', {}, '接续'), h('th', {}, '他线'), h('th', {}, '2号线'), h('th', {}, '状态'))),
        h('tbody', {}, ...list.map((c) => {
          const tr = trip(c.trip);
          const [label, style] = STATE[c.state];
          return h('tr', { style: tr ? 'cursor:pointer' : '', onclick: () => { if (tr) { this.store.select({ kind: 'train', id: tr.id }); this.hooks.locate(); } } },
            h('td', {}, STATIONS[c.st].name),
            h('td', {}, c.kind === 'feed' ? `${line(c)} → 2号线${c.dir === 'DN' ? '下行' : '上行'}` : `2号线${c.dir === 'DN' ? '下行' : '上行'} → ${line(c)}`),
            h('td', { class: 'mono' }, hm(c.kind === 'feed' ? c.planned + 30 : c.planned)),
            h('td', { class: 'mono' }, `${hm(c.l2)}${tr && tr.delay > 60 ? `（晚${Math.round(tr.delay / 60)}′）` : ''}`),
            h('td', { style }, label));
        }))));
  }

  private renderTrains() {
    const snap = this.store.snap;
    if (!snap) return;
    clear(this.trainBody);
    const { topo } = this.store;
    const trains = [...snap.trains].sort((a, b) => (b.inService && b.delay > 120 ? b.delay : 0) - (a.inService && a.delay > 120 ? a.delay : 0) || a.svc.localeCompare(b.svc));
    for (const t of trains) {
      const near = topo.stations.reduce((best, s) => (Math.abs(s.chain - t.chain) < Math.abs(best.chain - t.chain) ? s : best), topo.stations[0]);
      const sel = this.store.selection?.kind === 'train' && this.store.selection.id === t.id;
      const late = t.inService && t.delay > 120;
      this.trainBody.append(h('tr', { class: sel ? 'sel' : '', style: 'cursor:pointer', onclick: () => { this.store.select({ kind: 'train', id: t.id }); this.hooks.locate(); } },
        h('td', { class: 'mono' }, `${t.svc}-${t.trip}`), h('td', {}, t.dest),
        h('td', {}, `${near.name}${Math.abs(near.chain - t.chain) > 150 ? '附近' : ''}`), h('td', { class: 'mono' }, `${Math.round(t.v * 3.6)}`),
        h('td', { class: 'mono', style: (t.mode !== 'DTO' && t.mode !== 'AM') || t.manual ? 'color:var(--warn)' : '' }, `${t.manual ? '人' : ''}${t.mode}${t.comm ? '' : '×'}`),
        h('td', { class: 'mono', style: late ? 'color:var(--late)' : '' }, t.inService ? fmtDelay(t.delay) : '—'), h('td', { class: 'mono' }, `${Math.round((t.load / LINE_INFO.capacity) * 100)}%`),
        h('td', { style: t.failed || t.eb ? 'color:var(--bad)' : '', title: t.halt ? `${t.halt.code} ${t.halt.detail}` : '' },
          t.failed ? '故障' : t.eb ? '紧急制动' : t.hold ? '扣车' : t.hot ? '热备待命' : t.phase === 'dwell' ? '停站' : t.phase === 'reversing' ? '折返' : t.v > 0.1 ? '运行'
            : t.halt ? `${t.halt.label}${t.halt.blocker ? `（${t.halt.blocker}）` : ''}` : '停车',
          t.vehicleNote ? h('span', { style: 'color:var(--warn);margin-left:6px' }, t.vehicleNote) : ''),
      ));
    }
  }

  // ---------------------------------------------------------------- instructor / scenarios
  private renderInstructorTab() {
    const { topo } = this.store;
    const snap = this.store.snap!;
    const box = h('div', { class: 'cmd' });
    // scenarios
    box.append(h('div', { class: 'sect-title' }, '训练场景（开始后将重新载入该时刻的运营状态，结束时给出评分报告）'));
    for (const s of SCENARIOS) {
      box.append(h('div', { style: 'display:flex;gap:12px;align-items:flex-start;border:1px solid var(--border);padding:12px' },
        h('div', { style: 'flex:1' }, h('div', { style: 'font-size:26px;color:#fff' }, `${s.name}  `, h('span', { class: 'chip info' }, `${fmtTime(s.start, false)} · ${Math.round(s.duration / 60)} 分钟`)),
          h('div', { class: 'hint' }, s.desc)),
        h('button', { class: 'btn primary', onclick: () => void this.startScenario(s.id) }, '开始'),
      ));
    }
    box.append(this.scenarioBox);
    this.renderScenarioState();
    // random faults & radio
    const lvl = h('select', {}, ...RANDOM_LEVELS.map((l, i) => h('option', { value: i }, l))) as HTMLSelectElement;
    lvl.value = String(snap.randomLevel);
    const auto = h('input', { type: 'checkbox' }) as HTMLInputElement;
    auto.checked = snap.autoRadio;
    auto.onchange = () => void this.store.command({ c: 'radioAuto', on: auto.checked });
    box.append(h('div', { class: 'sect-title' }, '随机故障与通话'));
    box.append(h('div', { class: 'form' }, h('label', {}, '随机故障难度'), lvl,
      h('button', { class: 'btn primary', onclick: async () => { const r = await this.store.command({ c: 'randomFaults', level: Number(lvl.value) }); toast(r.msg, r.ok); } }, '应用'),
      h('label', { style: 'margin-left:16px' }, '通话自动应答（演示）'), auto));
    box.append(h('div', { class: 'cmdgrid' },
      h('button', { class: 'btn', onclick: async () => { const r = await this.store.command({ c: 'scenarioEnd' }); toast(r.msg, r.ok); } }, '结束并评分'),
    ));
    // weather
    const wind = h('select', {}, h('option', { value: 0 }, '无大风'), ...WEATHER_RULES.wind.map((w) => h('option', { value: w.level }, `${w.label} → ${w.kmh ? `${w.kmh}km/h` : '停运'}`))) as HTMLSelectElement;
    wind.value = String(snap.env.wind);
    const rain = h('input', { type: 'checkbox' }) as HTMLInputElement;
    rain.checked = snap.env.rain;
    const wdur = h('select', {}, ...[[900, '15分钟'], [1800, '30分钟'], [3600, '60分钟'], [0, '持续']].map(([v, t]) => h('option', { value: v }, String(t)))) as HTMLSelectElement;
    wdur.value = '1800';
    box.append(h('div', { class: 'sect-title' }, '环境（东段高架/地面段）'));
    box.append(h('div', { class: 'form' }, wind, h('label', {}, '暴雨'), rain, wdur,
      h('button', { class: 'btn primary', onclick: async () => { const r = await this.store.command({ c: 'env', wind: Number(wind.value), rain: rain.checked, duration: Number(wdur.value) }); toast(r.msg, r.ok); } }, '设置')));
    // manual fault injection
    const kind = h('select', {}, ...(Object.keys(FAULT_LABELS) as FaultKind[]).map((k) => h('option', { value: k }, FAULT_LABELS[k]))) as HTMLSelectElement;
    const target = h('select', { style: 'min-width:420px;max-width:100%' }) as HTMLSelectElement;
    const dur = h('select', {}, ...[[0, '需人工修复'], [120, '2分钟'], [300, '5分钟'], [600, '10分钟'], [1200, '20分钟'], [1800, '30分钟']].map(([v, t]) => h('option', { value: v }, String(t)))) as HTMLSelectElement;
    dur.value = '600';
    const rec = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const mult = h('select', {}, ...[2, 3, 4, 6, 8].map((v) => h('option', { value: v }, `×${v}`))) as HTMLSelectElement;
    mult.value = '4';
    const sev = h('select', {}, h('option', { value: 1 }, '一般'), h('option', { value: 2 }, '严重')) as HTMLSelectElement;
    const proc = h('div', { class: 'hint' });
    const extra = h('span', { style: 'display:flex;gap:10px;align-items:center' });
    const fillTargets = () => {
      clear(target);
      clear(extra);
      const k = kind.value as FaultKind;
      const sel = this.store.selection;
      const opt = (v: number, t: string, chosen = false) => { const o = h('option', { value: v }, t); if (chosen) (o as HTMLOptionElement).selected = true; return o; };
      const s = this.store.snap!;
      if (k === 'trainComm' || k === 'trainDto' || k === 'trainFail' || k === 'traction' || k === 'door' || k === 'brake' || k === 'pecu') {
        for (const t of [...s.trains].sort((a, b) => a.svc.localeCompare(b.svc))) if (t.inService || t.phase === 'run') target.append(opt(t.id, `${t.svc}-${t.trip}（${t.vehicle}）`, sel?.kind === 'train' && sel.id === t.id));
        if (k === 'traction' || k === 'door' || k === 'brake') {
          (sev.options[0] as HTMLOptionElement).text = k === 'traction' ? '切除1个单元' : '一般';
          (sev.options[1] as HTMLOptionElement).text = k === 'traction' ? '切除2个单元' : k === 'door' ? '严重（无法切除）' : '严重（多车）';
          extra.append(h('label', {}, '程度'), sev);
        }
        if (k === 'trainFail' || k === 'traction' || k === 'brake') extra.append(h('label', {}, '可自行恢复'), rec);
      } else if (k === 'zcFail') {
        target.append(opt(-1, 'DCS/全部ZC（全线）'));
        topo.zones.forEach((z) => target.append(opt(z.id, z.name, sel?.kind === 'zone' && sel.id === z.id)));
      } else if (k === 'axle') {
        for (const x of topo.sections) target.append(opt(x.id, `${x.name}（${STATIONS[x.station].name}）`, sel?.kind === 'section' && sel.id === x.id));
      } else if (k === 'switch') {
        topo.switches.forEach((x) => target.append(opt(x.id, `${x.name}（${STATIONS[x.station].name}）`, sel?.kind === 'switch' && sel.id === x.id)));
      } else if (k === 'signal') {
        topo.signals.forEach((x) => target.append(opt(x.id, `${x.name}（${STATIONS[x.station].name}）`, sel?.kind === 'signal' && sel.id === x.id)));
      } else if (k === 'psd' || k === 'trackPerson') {
        topo.platforms.forEach((p) => target.append(opt(p.id, p.name, sel?.kind === 'platform' && sel.id === p.id)));
      } else if (k === 'surge') {
        topo.stations.forEach((x) => target.append(opt(x.index, x.name, (sel?.kind === 'platform' && topo.platforms[sel.id].station === x.index) || (sel?.kind === 'station' && sel.id === x.index))));
        extra.append(h('label', {}, '客流倍数'), mult);
      }
      proc.textContent = PROCEDURES[k];
    };
    kind.onchange = fillTargets;
    fillTargets();
    const inject = h('button', { class: 'btn danger', onclick: async () => {
      if (!target.value) return;
      const r = await this.store.command({ c: 'fault', kind: kind.value as FaultKind, target: Number(target.value), duration: Number(dur.value), param: ['traction', 'door', 'brake'].includes(kind.value) ? Number(sev.value) : Number(mult.value), recoverable: rec.checked });
      toast(r.msg, r.ok);
      this.renderFaultList();
    } }, '注入故障');
    box.append(h('div', { class: 'sect-title' }, '手动注入故障（先在图上选中对象可自动带入）'),
      h('div', { class: 'form' }, h('label', {}, '类型'), kind),
      h('div', { class: 'form' }, h('label', {}, '对象'), target, extra),
      h('div', { class: 'form' }, h('label', {}, '维修时长'), dur, inject),
      proc,
      h('div', { class: 'sect-title' }, '当前故障'),
      this.faultList);
    this.tabBody.append(box);
    this.renderFaultList();
  }

  private async startScenario(id: string) {
    const s = SCENARIOS.find((x) => x.id === id)!;
    const ok = window.confirm(`开始训练场景“${s.name}”？\n将重新载入 ${fmtTime(s.start, false)} 的运营状态，通话需人工应答，结束时自动评分。`);
    if (!ok) return;
    this.store.emit('startScenario:' + id);
  }

  private renderScenarioState() {
    const snap = this.store.snap;
    if (!snap) return;
    clear(this.scenarioBox);
    const sc = snap.scenario;
    if (!sc) return;
    const m = snap.metrics;
    const left = Math.max(0, sc.end - snap.t);
    this.scenarioBox.append(
      h('div', { style: 'border:1px solid var(--line);padding:12px;display:flex;flex-direction:column;gap:8px' },
        h('div', { style: 'font-size:26px;color:#fff' }, `进行中：${sc.name}`, h('span', { class: 'chip ok', style: 'margin-left:12px' }, sc.ended ? '已结束' : `剩余 ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`)),
        h('ul', { style: 'margin:0;padding-left:28px;font-size:22px;color:var(--text)' }, ...sc.objectives.map((o) => h('li', {}, o))),
        h('div', { class: 'hint' }, `实时：完成车次 ${m.tripsCompleted} · 晚点发车 ${m.departuresLate}/${m.departures} · 滞留 ${Math.round(m.stranded)} 人次 · 安全违章 ${Object.values(m.safety).reduce((a, b) => a + b, 0)} · 未应答 ${m.callsExpired}`),
      ));
  }

  private renderFaultList() {
    const snap = this.store.snap;
    if (!snap) return;
    clear(this.faultList);
    const list = snap.faults;
    if (!list.length) { this.faultList.append(h('div', { class: 'hint' }, '无')); return; }
    for (const f of list) {
      this.faultList.append(h('div', { style: 'display:flex;gap:12px;align-items:center;font-size:22px' },
        h('span', { class: `chip ${f.repaired ? 'ok' : 'bad'}` }, f.repaired ? '已修复' : '故障中'),
        h('span', { class: 'mono', style: 'color:var(--text-dim)' }, fmtTime(f.since)),
        h('span', { style: 'flex:1;color:#fff' }, f.text),
        h('span', { class: 'mono', style: 'color:var(--text-dim)' }, f.repaired ? '' : !Number.isFinite(f.repairAt) ? '待人工' : `至 ${fmtTime(f.repairAt, false)}`),
        f.repaired ? '' : h('button', { class: 'btn', onclick: async () => { const r = await this.store.command({ c: 'repair', fault: f.id }); toast(r.msg, r.ok); } }, '现场修复'),
      ));
    }
  }

  // ---------------------------------------------------------------- replay
  private renderReplayTab() {
    const box = h('div', { class: 'cmd' });
    box.append(h('div', { class: 'hint' }, '检查点覆盖整个运营日：最近2小时每分钟保存，更早每10分钟保存。“回退”重新处置；“回放”按原有命令重演，下达命令即接管。事件时间线记录各类报警首次发生时刻。'));
    const label = h('input', { type: 'text', placeholder: '书签名称', style: 'flex:1' }) as HTMLInputElement;
    box.append(h('div', { class: 'form' }, label, h('button', { class: 'btn primary', onclick: async () => { const r = await this.store.command({ c: 'bookmark', label: label.value || '手动书签' }); toast(r.msg, r.ok); label.value = ''; this.renderReplay(); } }, '添加书签')));
    box.append(h('div', { class: 'cmdgrid' },
      ...[1, 5, 15, 30].map((m) => h('button', { class: 'btn', onclick: () => this.hooks.rewind((this.store.snap?.t ?? 0) - m * 60, false) }, `回退 ${m} 分钟`)),
    ));
    box.append(this.replayBox);
    this.tabBody.append(box);
    this.renderReplay();
  }

  private renderReplay() {
    const snap = this.store.snap;
    if (!snap) return;
    clear(this.replayBox);
    const r = snap.replay;
    this.replayBox.append(h('div', { class: 'sect-title' }, `可回退范围 ${fmtTime(r.from, false)} — ${fmtTime(r.to, false)}${r.replaying ? ` · 回放中（待重演命令 ${r.pending}）` : ''}`));
    this.replayBox.append(h('div', { class: 'sect-title' }, '事件时间线（首次发生）'));
    for (const incident of snap.incidents) this.replayBox.append(h('div', { class: 'form' },
      h('span', { class: 'mono' }, fmtTime(incident.t)),
      h('span', { class: 'hint', style: 'flex:1' }, incident.text),
      h('button', { class: 'btn', onclick: () => this.hooks.rewind(Math.max(r.from, incident.t), true) }, '定位'),
    ));
    const tb = h('tbody');
    for (const b of snap.bookmarks.slice().reverse()) {
      const can = b.t - 60 >= r.from - 1;
      tb.append(h('tr', {},
        h('td', { class: 'mono' }, fmtTime(b.t)),
        h('td', { class: 'wrap' }, h('span', { class: `chip ${b.auto ? 'info' : 'ok'}`, style: 'margin-right:8px' }, b.auto ? '自动' : '手动'), b.label),
        h('td', {}, can ? h('button', { class: 'btn', onclick: () => this.hooks.rewind(b.t - 60, true) }, '回放') : h('span', { class: 'hint' }, '超出范围')),
        h('td', {}, can ? h('button', { class: 'btn', onclick: () => this.hooks.rewind(b.t - 60, false) }, '回退处置') : ''),
      ));
    }
    if (!snap.bookmarks.length) tb.append(h('tr', {}, h('td', { class: 'hint' }, '暂无书签')));
    this.replayBox.append(h('table', { class: 'grid' }, tb));
  }
}

/** map an alarm key to the object it is about (for click → locate) */
export function alarmTarget(a: SimEvent): Selection {
  const k = a.key ?? '';
  const m = /^([a-z]+)-(-?\d+)$/.exec(k);
  if (!m) return null;
  const id = Number(m[2]);
  switch (m[1]) {
    case 'eb': case 'comm': case 'tf': case 'tfr': case 'spad': case 'late': return { kind: 'train', id };
    case 'sw': return { kind: 'switch', id };
    case 'axle': case 'blk': case 'tsr': return { kind: 'section', id };
    case 'sig': return { kind: 'signal', id };
    case 'psd': case 'esp': return { kind: 'platform', id };
    case 'crowd': case 'surge': return { kind: 'station', id };
    case 'zc': return id >= 0 ? { kind: 'zone', id } : null;
    default: return null;
  }
}
