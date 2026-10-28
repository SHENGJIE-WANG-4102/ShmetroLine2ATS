/// <reference lib="webworker" />
/**
 * Simulation worker: owns the Sim, advances it with a fixed time step
 * decoupled from rendering, supports time acceleration, and streams
 * snapshots / events to the UI thread. It also keeps rolling checkpoints
 * and a command log for rewind and replay (回放).
 */
import { Sim, FIXED_DT } from './engine';
import type { FromWorker, ToWorker, SimConfig } from './model';
import { nextOperatingConfig, unfinishedAtRollover } from './operatingDay';
import { OPERATING_DAY } from './dayRandom';
import { capture, restore, type Checkpoint } from './state';
import { applyInput, compactCheckpoints, exportDiagnostics, stringifyDiagnostics, type RecordedInput } from './diagnostics';
import { preparePlan } from './planning';
import { captureWarmup, readWarmup, restoreWarmup, warmupKey, writeWarmup } from './warmupCache';

// Vite includes source text as build inputs. Any simulation/data change
// changes the key automatically, including development worker reloads.
const warmupSources = import.meta.glob(['./*.ts', '../data/**/*.ts'], { eager: true, query: '?raw', import: 'default' });

declare const self: DedicatedWorkerGlobalScope;

let sim: Sim | null = null;
let speed = 1;
let paused = false;
let acc = 0;
let lastWall = performance.now();
let lastSnap = 0;
let stepsWindow = 0;
/** simulated seconds asked for / dropped (CPU could not keep up) in the window */
let wantWindow = 0;
let droppedWindow = 0;
let windowStart = performance.now();
let jumping = false;
let starting = 0;
let initializing = false;

const SNAP_INTERVAL = 50; // ms (20 Hz)
/** an operating day runs from 04:00 to the 03:45 rollover: every run-up stays inside it */
const DAY_FIRST = OPERATING_DAY.from;
const DAY_LAST = OPERATING_DAY.to;
const MAX_SPEED = 1000;
/** a time from a message, or null: never trust it to end a synchronous run-up */
const dayTime = (t: unknown): number | null => (typeof t === 'number' && Number.isFinite(t) ? Math.min(DAY_LAST, Math.max(DAY_FIRST, t)) : null);
const STEP_BUDGET = 9; // ms of simulation work per tick
const CP_INTERVAL = 60; // s of sim time between checkpoints

type LogEntry = RecordedInput;
let checkpoints: Checkpoint[] = [];
let cmdLog: LogEntry[] = [];
let pending: LogEntry[] = [];
let replayUntil = 0;

function post(msg: FromWorker, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

/** UI subscriptions that survive a restart */
let wantPis = -1;
let wantDmi = -1;

async function start(raw: SimConfig) {
  const began=performance.now();
  const phase=(phase:'diagram'|'cache'|'warmup'|'complete')=>post({type:'startup',phase,elapsed:performance.now()-began});
  const generation = ++starting;
  initializing = true;
  const config: SimConfig = { ...raw, startTime: dayTime(raw.startTime) ?? DAY_FIRST, seed: Number.isFinite(raw.seed) ? raw.seed : 1 };
  phase('diagram');
  sim = new Sim(config);
  sim.pisStation = wantPis;
  sim.dmiTrain = wantDmi;
  speed = 1;
  paused = false;
  acc = 0;
  checkpoints = [];
  cmdLog = [];
  pending = [];
  replayUntil = 0;
  checkpoint();
  // warm up from the start of the service day to the requested start time
  if (config.startTime > sim.t) {
    phase('cache');
    let key: string | undefined;
    try { key = await warmupKey(config, sim.plan, warmupSources); } catch { /* Normal warm-up below. */ }
    const cached = key ? await readWarmup(key) : null;
    if (generation !== starting) return;
    if (cached && Math.abs(cached.t - config.startTime) < FIXED_DT + 1e-6) {
      try { restoreWarmup(sim, cached); } catch { sim = new Sim(config); }
    }
    if (sim.t < config.startTime) {
      phase('warmup');
      runUntil(config.startTime, true);
      if (key) void writeWarmup(key, captureWarmup(sim));
    }
  }
  sim.pisStation = wantPis;
  sim.dmiTrain = wantDmi;
  checkpoint();
  initializing = false;
  lastWall = performance.now();
  phase('complete');
  post({ type: 'ready', plan: sim.plan, config:sim.config });
  flushEvents(true);
  sendSnapshot();
}

/** Next operating day: archive the finished day, build the new one on the
 * running world. Rewind cannot reach back across it. */
function rollover() {
  const old = sim!;
  const config = nextOperatingConfig(old);
  const transition = `运营日切换：${old.config.date} → ${config.date}`;
  const running = unfinishedAtRollover(old);
  if (running.length) old.log('I', '运营', `跨运营日继续运行：${running.join('；')}`);
  old.log('I', '运营', transition);
  post({ type: 'dayArchive', date: old.config.date!, json: stringifyDiagnostics(exportDiagnostics(old, cmdLog.slice(0, cmdLog.length - pending.length))) });
  flushEvents(true);
  sim = new Sim(config, old);
  sim.speed = speed;
  sim.paused = paused;
  sim.autoDispatch = old.autoDispatch;
  sim.pisStation = wantPis;
  sim.dmiTrain = wantDmi;
  checkpoints = [];
  cmdLog = [];
  pending = [];
  replayUntil = 0;
  checkpoint();
  sim.log('I', '运营', transition + '；上一运营日诊断已移交归档');
  post({ type: 'ready', plan: sim.plan, config: sim.config });
  post({ type: 'dayChanged', text: transition });
  flushEvents(true);
  sendSnapshot();
}

function checkpoint() {
  if (!sim) return;
  const cp = capture(sim);
  cp.inputCursor = cmdLog.length - pending.length;
  cp.inputs = cmdLog.slice(0, cp.inputCursor);
  checkpoints.push(cp);
  checkpoints = compactCheckpoints(checkpoints, sim.t);
}

/** one fixed step incl. replayed commands and periodic checkpoints */
function stepOnce(keepCheckpoints = true) {
  if (!sim) return;
  while (pending.length && pending[0].t <= sim.t + 1e-6) {
    const e = pending.shift()!;
    sim.replaying = true;
    applyInput(sim, e);
    sim.replaying = false;
    sim.inputLog.push(structuredClone(e));
  }
  sim.step(FIXED_DT);
  const last = checkpoints[checkpoints.length - 1];
  if (keepCheckpoints && (!last || sim.t - last.t >= CP_INTERVAL - 1e-6)) checkpoint();
  if (sim.reportReady) {
    post({ type: 'report', report: sim.reportReady });
    sim.reportReady = null;
  }
}

function runUntil(to: number, initial = false, stopOnCap = false) {
  const target = dayTime(to);
  if (!sim || target === null) return;
  jumping = true;
  let lastProgress = performance.now();
  while (sim.t < target) {
    // a fast-forward stops when a CM / RM train comes onto the line (Sim.speedCap)
    if (stopOnCap && sim.speedCap() < Infinity) {
      sim.log('I', '系统', '线上有人工驾驶（CM/RM）列车，快进停止');
      break;
    }
    stepOnce();
    if (performance.now() - lastProgress > 200) {
      lastProgress = performance.now();
      post({ type: 'progress', t: sim.t, target });
    }
  }
  jumping = false;
  if (!initial) {
    flushEvents(true);
    sendSnapshot();
  }
}

function flushEvents(force = false) {
  if (!sim) return;
  if (sim.newEvents.length) {
    post({ type: 'events', events: sim.newEvents.splice(0) });
  }
  if (sim.alarmsDirty || force) {
    sim.alarmsDirty = false;
    post({ type: 'alarms', alarms: Array.from(sim.alarms.values()) });
  }
  if (sim.planDirty) {
    sim.planDirty = false;
    post({ type: 'plan', plan: sim.plan });
  }
}

function sendSnapshot() {
  if (!sim) return;
  sim.speed = speed;
  sim.paused = paused;
  const snap = sim.snapshot();
  snap.replay = {
    from: checkpoints[0]?.t ?? sim.t, to: Math.max(sim.t, replayUntil), replaying: sim.t < replayUntil, pending: pending.length,
  };
  post({ type: 'snap', snap }, [snap.sections.buffer, snap.sectionTsr.buffer, snap.switches.buffer, snap.signals.buffer, snap.platforms.buffer, snap.platformWaiting.buffer]);
}

function applyDrive(train: number, notch: number) {
  return sim?.drive(train, notch) ?? false;
}

/** the dispatcher acts during a replay: the recorded future is discarded */
function takeOver() {
  if (!sim || !pending.length) return;
  cmdLog = cmdLog.slice(0, cmdLog.length - pending.length);
  pending = [];
  replayUntil = 0;
}

function rewind(to: number, replay: boolean) {
  if (!sim || !checkpoints.length) return;
  let idx = -1;
  for (let i = checkpoints.length - 1; i >= 0; i--) if (checkpoints[i].t <= to + 1e-6) { idx = i; break; }
  if (idx < 0) idx = 0;
  const cp = checkpoints[idx];
  const now = sim.t;
  restore(sim, cp);
  checkpoints = checkpoints.slice(0, idx + 1);
  if (replay) {
    pending = cmdLog.slice(cp.inputCursor);
    replayUntil = now;
  } else {
    pending = [];
    replayUntil = 0;
    cmdLog = cmdLog.slice(0, cp.inputCursor);
  }
  acc = 0;
  if (replay && to > sim.t) runUntil(Math.min(to, now));
  post({ type: 'rewound', t: sim.t, nextEventId: sim.nextEventId });
  flushEvents(true);
  sendSnapshot();
}

function tick() {
  if (!sim || jumping || initializing) return;
  const now = performance.now();
  const dtWall = Math.min(0.25, (now - lastWall) / 1000);
  lastWall = now;
  if (!paused) {
    // CM / RM trains on the line hold the acceleration down (Sim.speedCap)
    const run = Math.min(speed, sim.speedCap());
    acc += dtWall * run;
    wantWindow += dtWall * run;
    const t0 = performance.now();
    let steps = 0;
    while (acc >= FIXED_DT) {
      stepOnce();
      acc -= FIXED_DT;
      steps++;
      if ((steps & 15) === 0 && performance.now() - t0 > STEP_BUDGET) {
        // cannot keep up with the requested acceleration: drop the backlog
        if (acc > 2 * FIXED_DT * 50) { droppedWindow += acc; acc = 0; }
        break;
      }
    }
    stepsWindow += steps;
  }
  if (now - windowStart > 1000) {
    sim.stepsPerSec = Math.round(stepsWindow * 1000 / (now - windowStart));
    sim.speedWanted = paused ? 0 : wantWindow * 1000 / (now - windowStart);
    sim.droppedPerSec = droppedWindow * 1000 / (now - windowStart);
    stepsWindow = 0;
    wantWindow = 0;
    droppedWindow = 0;
    windowStart = now;
  }
  // operating-day rollover after the night shutdown (03:45): the world runs on (D111)
  if (sim.t >= DAY_LAST && sim.config.date) {
    rollover();
    return;
  }

  if (now - lastSnap >= SNAP_INTERVAL) {
    lastSnap = now;
    flushEvents();
    sendSnapshot();
  }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (initializing && !['init', 'restart', 'speed', 'pause', 'pis', 'dmi'].includes(m.type)) return;
  switch (m.type) {
    case 'init':
    case 'restart':
      start(m.config);
      break;
    case 'speed':
      if (Number.isFinite(m.speed) && m.speed >= 0) speed = Math.min(MAX_SPEED, m.speed);
      break;
    case 'pause':
      paused = m.paused;
      break;
    case 'jump':
      if (sim && Number.isFinite(m.to) && m.to > sim.t) runUntil(m.to, false, true);
      break;
    case 'cmd': {
      if (!sim) return;
      takeOver();
      const inputIndex = sim.inputLog.length;
      const r = sim.command(m.cmd);
      cmdLog.push(structuredClone(sim.inputLog[inputIndex]));
      post({ type: 'cmdResult', id: m.id, ok: r.ok, msg: r.msg });
      flushEvents();
      sendSnapshot();
      break;
    }
    case 'drive':
      if (!sim) return;
      if (!sim.trains.get(m.train)?.manual || !Number.isFinite(m.notch)) return;
      takeOver();
      if (applyDrive(m.train, m.notch)) cmdLog.push(structuredClone(sim.inputLog.at(-1)!));
      break;
    case 'pis':
      wantPis = m.station;
      if (sim) sim.pisStation = m.station;
      break;
    case 'dmi':
      wantDmi = m.train;
      if (sim) sim.dmiTrain = m.train;
      sendSnapshot();
      break;
    case 'rewind':
      rewind(m.to, m.replay);
      break;
    case 'takeover':
      takeOver();
      sendSnapshot();
      break;
    case 'diagnostics':
      if (sim) post({ type: 'diagnostics', json: stringifyDiagnostics(exportDiagnostics(sim, cmdLog.slice(0, cmdLog.length - pending.length))) });
      break;
    case 'planPreview':
      if (sim) post({ type: 'planPreview', id: m.id, preview: preparePlan(sim, m.cmd) });
      break;
  }
};

setInterval(tick, 8);
