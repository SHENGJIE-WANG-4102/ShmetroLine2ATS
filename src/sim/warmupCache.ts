import type { SimConfig, Plan } from './model';
import { capture, restore, type Checkpoint } from './state';
import type { Sim } from './engine';
import { assertScope, currentScope } from '../data/scope';
import { digestJson, readKeyed, writeKeyed } from './idbStore';

const DB = 'atssim-warmup';
const STORE = 'checkpoints';

export interface WarmupCheckpoint extends Checkpoint {
  /** Graph history pending delivery with the first UI snapshot. Ordinary
   * rewind checkpoints intentionally omit these transient trace buffers. */
  warmupTraces?: { train: number; pts: number[] }[];
}

export function captureWarmup(sim: Sim): WarmupCheckpoint {
  return { ...capture(sim), warmupTraces: [
    ...sim.removedTraces.map(t=>({train:t.train,pts:t.pts.slice()})),
    ...sim.trainList.filter(t=>t.trace.length).map(t=>({train:t.id,pts:t.trace.slice()})),
  ] };
}

export function restoreWarmup(sim: Sim, saved: WarmupCheckpoint) {
  const traces = saved.warmupTraces;
  if (!Array.isArray(traces) || traces.some(t=>!Number.isInteger(t.train) || t.train<0
    || !Array.isArray(t.pts) || t.pts.length%4!==0 || !t.pts.every(Number.isFinite)))
    throw new Error('Invalid warm-up graph history');
  restore(sim,saved);
  sim.newEvents = sim.events.slice();
  sim.removedTraces = traces;
}

export async function warmupKey(config: SimConfig, plan: Plan, sources: Record<string, unknown>): Promise<string> {
  if (config.scope) assertScope(config.scope);
  return digestJson([currentScope(), sources, plan, config]);
}

/** Keep at most two configurations (idbStore.ts). */
export const readWarmup = (key: string) => readKeyed<WarmupCheckpoint>(DB, STORE, key);
export const writeWarmup = (key: string, checkpoint: WarmupCheckpoint) => writeKeyed(DB, STORE, key, checkpoint);
