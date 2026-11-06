import type { RunTimes } from './dynamics';
import { primeRunTimes, sharedRunTimes } from './engine';
import { restorePlans, storedPlans, type StoredPlan } from './timetable';
import { currentScope } from '../data/scope';
import { digestJson, readKeyed, writeKeyed } from './idbStore';

/** D186: the run times and the generated diagrams take most of a fresh
 * worker's start (about 4 s) and use no random draw, so the worker keeps them
 * between launches. The key is the line and the source text of the simulation
 * and line data: any code or data change starts over. Within a version the
 * diagram cache's own key (timetable.ts) still tells configurations apart. */

const DB = 'atssim-build';
const STORE = 'builds';
/** most recent diagrams kept (each ~1.2 MB) */
const KEEP_PLANS = 4;

interface BuildSnapshot { rt: RunTimes; plans: StoredPlan[] }

export const buildKey = (sources: Record<string, unknown>) => digestJson([currentScope(), sources]);

/** keys already in storage for this version */
const saved = new Set<string>();

let loaded: string | undefined;

/** Once per worker: later starts find everything in memory. */
export async function loadBuild(key: string): Promise<void> {
  if (loaded === key) return;
  loaded = key;
  const snapshot = await readKeyed<BuildSnapshot>(DB, STORE, key);
  if (!snapshot) return;
  try {
    primeRunTimes(snapshot.rt);
    restorePlans(snapshot.plans);
    for (const p of snapshot.plans) saved.add(p.key);
  } catch { /* A damaged entry: build normally. */ }
}

/** Store what this worker has built, if anything is new. */
export function saveBuild(key: string): void {
  const rt = sharedRunTimes();
  const plans = storedPlans().slice(-KEEP_PLANS);
  if (!rt || plans.every(p => saved.has(p.key))) return;
  for (const p of plans) saved.add(p.key);
  void writeKeyed(DB, STORE, key, { rt, plans } satisfies BuildSnapshot);
}
