import { GROUP } from '../data/current';
import { assertScope, currentScope } from '../data/scope';
import {archiveDiagnostics,previousDiagnostics,downloadDiagnostics} from './diagnosticFiles';
import {toast} from './confirm';
/**
 * UI-side state: latest snapshot from the worker, plan, events, alarms and
 * the dispatcher's current selection. Also wraps the worker protocol.
 */
import type { Topology } from '../sim/topology';
import type { Command, FromWorker, Plan, ScenarioReport, SimConfig, SimEvent, Snapshot, ToWorker } from '../sim/model';

export type Selection =
  | { kind: 'signal'; id: number }
  | { kind: 'switch'; id: number }
  | { kind: 'section'; id: number }
  | { kind: 'platform'; id: number }
  | { kind: 'train'; id: number }
  | { kind: 'zone'; id: number }
  | { kind: 'depot'; id: number }
  | { kind: 'station'; id: number }
  | null;

type Listener = () => void;

/** stride of the actual-line trace points: [t, chainage, inService, delay] */
export const TRACE_STRIDE = 4;

export class Store {
  private previews = new Map<number, (p: import('../sim/planning').PlanPreview) => void>();
  topo: Topology;
  worker: Worker;
  plan: Plan | null = null;
  snap: Snapshot | null = null;
  events: SimEvent[] = [];
  alarms: SimEvent[] = [];
  selection: Selection = null;
  hover: Selection = null;
  trainGroup: { ids: number[]; pinned: boolean } | null = null;
  config: SimConfig | null = null;
  planVersion = 0;
  traces = new Map<number, number[]>();
  traceVersion = 0;
  /** bumped when traces were truncated (rewind) and the graph must redraw */
  traceReset = 0;
  report: ScenarioReport | null = null;
  progress: { t: number; target: number } | null = null;
  startupText='生成运行图…';
  private listeners = new Map<string, Set<Listener>>();
  private nextCmd = 1;
  private snapDirty = false;
  private pending = new Map<number, (r: { ok: boolean; msg: string }) => void>();

  constructor(topo: Topology, worker: Worker) {
    this.topo = topo;
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data);
  }

  on(ev: string, fn: Listener) {
    let s = this.listeners.get(ev);
    if (!s) { s = new Set(); this.listeners.set(ev, s); }
    s.add(fn);
    return () => s!.delete(fn);
  }
  emit(ev: string) {
    this.listeners.get(ev)?.forEach((f) => f());
  }

  send(msg: ToWorker) {
    this.worker.postMessage(msg);
  }

  start(config: SimConfig) {
    if (config.scope) assertScope(config.scope);
    config = { ...config, scope: currentScope() };
    this.showTrainGroup(null, true);
    this.progress=null;
    this.config = config;
    this.events = [];
    this.alarms = [];
    this.traces.clear();
    this.traceVersion++;
    this.traceReset++;
    this.selection = null;
    this.report = null;
    this.send({ type: 'init', config });
  }

  async exportPreviousDiagnostics() {
    const previous=await previousDiagnostics();
    if(!previous){toast('还没有归档的运营日诊断',false);return;}
    try {await downloadDiagnostics(previous.json,`line${GROUP.id}-diagnostics-${previous.date}.json`);}catch(e){toast(`诊断导出失败：${String(e)}`,false);}
  }

  command(cmd: Command): Promise<{ ok: boolean; msg: string }> {
    const id = this.nextCmd++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ type: 'cmd', id, cmd });
    });
  }

  preview(cmd: Extract<Command, { c: 'overlay' | 'addTrain' }>): Promise<import('../sim/planning').PlanPreview> {
    const id = this.nextCmd++;
    return new Promise(resolve => { this.previews.set(id, resolve); this.send({ type: 'planPreview', id, cmd }); });
  }

  /** emit a pending 'snap' (called once per render frame) */
  flushSnap() {
    if (!this.snapDirty) return;
    this.snapDirty = false;
    this.emit('snap');
  }

  select(sel: Selection) {
    this.showTrainGroup(null, true);
    this.selection = sel;
    this.emit('selection');
  }

  showTrainGroup(ids: number[] | null, pinned = false) {
    if (this.trainGroup?.pinned && !pinned) return;
    this.trainGroup = ids ? { ids, pinned } : null;
    this.emit('trainGroup');
  }

  private onMessage(m: FromWorker) {
    switch (m.type) {
      case 'ready':
        if(m.config)this.config=m.config;
        // a new operating day (first start or rollover)
        this.events = [];
        this.alarms = [];
        this.traces.clear();
        this.traceVersion++;
        this.traceReset++;
        this.plan = m.plan;
        this.planVersion++;
        this.emit('ready');
        this.emit('plan');
        break;
      case 'plan':
        this.plan = m.plan;
        this.planVersion++;
        this.emit('plan');
        break;
      case 'snap': {
        this.snap = m.snap;
        for (const tr of m.snap.traces) {
          let arr = this.traces.get(tr.train);
          if (!arr) { arr = []; this.traces.set(tr.train, arr); }
          for (const v of tr.pts) arr.push(v);
        }
        if (m.snap.traces.length) this.traceVersion++;
        // listeners run from the render frame (flushSnap): at most once per
        // painted frame, so DOM/canvas work can never queue up behind slow frames
        this.snapDirty = true;
        break;
      }
      case 'events':
        for (const e of m.events) this.events.push(e);
        if (this.events.length > 6000) this.events.splice(0, this.events.length - 5000);
        this.emit('events');
        break;
      case 'alarms':
        this.alarms = m.alarms;
        this.emit('alarms');
        break;
      case 'cmdResult': {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); p({ ok: m.ok, msg: m.msg }); }
        break;
      }
      case 'diagnostics':
        void downloadDiagnostics(m.json,`line${GROUP.id}-diagnostics-${Math.round(this.snap?.t??0)}.json`).catch(e=>toast(`诊断导出失败：${String(e)}`,false));
        break;
      case 'dayArchive':
        void archiveDiagnostics(m).then(saved=>{if(!saved)toast('上一运营日诊断已暂存；持久保存失败，请在关闭前导出。',false);});
        break;
      case 'dayChanged': toast(m.text,true);break;
      case 'planPreview': {
        this.previews.get(m.id)?.(m.preview);
        this.previews.delete(m.id);
        break;
      }
      case 'progress':
        this.progress = m;
        this.emit('progress');
        break;
      case 'startup':
        if(m.phase==='complete')break;
        this.startupText={diagram:'生成运行图…',cache:'读取开局缓存…',warmup:'预热推演…'}[m.phase];
        this.emit('startup');
        break;
      case 'rewound': {
        // drop everything recorded after the restored time
        for (const [id, pts] of this.traces) {
          let n = pts.length;
          while (n >= TRACE_STRIDE && pts[n - TRACE_STRIDE] > m.t + 1e-6) n -= TRACE_STRIDE;
          if (n === 0) this.traces.delete(id); else pts.length = n;
        }
        this.traceVersion++;
        this.traceReset++;
        this.events = this.events.filter((e) => e.id < m.nextEventId);
        this.emit('events');
        this.emit('rewound');
        break;
      }
      case 'report':
        this.report = m.report;
        this.emit('report');
        break;
      case 'call':
        break;
    }
  }
}
