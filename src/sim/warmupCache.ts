import type { SimConfig, Plan } from './model';
import { capture, restore, type Checkpoint } from './state';
import type { Sim } from './engine';
import { assertScope, currentScope } from '../data/scope';

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
  const bytes = new TextEncoder().encode(JSON.stringify([currentScope(), sources, plan, config], (_key,value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))) : value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('');
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Warm-up cache blocked'));
  });
}

/** Storage is optional: privacy settings, quotas and damaged entries must
 * never prevent a normal start. Keep at most two configurations. */
export async function readWarmup(key: string): Promise<WarmupCheckpoint | null> {
  let db: IDBDatabase | undefined;
  try {
    db = await open();
    return await new Promise((resolve, reject) => {
      const tx = db!.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(key);
      tx.oncomplete = () => resolve(request.result ?? null);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } catch { return null; }
  finally { db?.close(); }
}

export async function writeWarmup(key: string, checkpoint: WarmupCheckpoint): Promise<void> {
  let db: IDBDatabase | undefined;
  try {
    db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const keys = store.getAllKeys();
      keys.onsuccess = () => {
        const old = keys.result.filter(k => k !== key);
        for (const k of old.slice(0, Math.max(0, old.length - 1))) store.delete(k);
        store.put(checkpoint, key);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } catch { /* Continue without persistent storage. */ }
  finally { db?.close(); }
}
