/** Versioned, lossless diagnostics and deterministic replay from the service-day start. */
import { Sim, FIXED_DT } from './engine';
import type { Command, SimConfig } from './model';
import { capture, restore, type Checkpoint } from './state';
import type { Topology } from './topology';

export type RecordedInput = { t: number; cmd: Command } | { t: number; drive: { train: number; notch: number } };
export interface Diagnostics {
  version: 2;
  topology: string;
  dt: number;
  config: SimConfig;
  startState: Checkpoint;
  inputs: RecordedInput[];
  until: number;
  state: Checkpoint;
}

export function exportDiagnostics(sim: Sim, inputs: RecordedInput[] = sim.inputLog): Diagnostics {
  return {
    version: 2, topology: topologySignature(sim.topo), dt: FIXED_DT, config: { ...sim.config },
    startState: sim.startState ?? capture(new Sim(sim.config)),
    inputs: structuredClone(inputs.filter(e => e.t <= sim.t + 1e-6)),
    until: sim.t, state: capture(sim),
  };
}

/** Prevent restoring numeric object IDs into a different infrastructure model. */
export function topologySignature(topo: Topology): string {
  const data = JSON.stringify([topo.links, topo.signals, topo.berths, topo.switches]);
  let hash = 2166136261;
  for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

export function stringifyDiagnostics(bundle: Diagnostics): string {
  return JSON.stringify(bundle, (_key, value: unknown) => {
    if (value instanceof Map) return { $sim: 'Map', value: [...value] };
    if (value instanceof Set) return { $sim: 'Set', value: [...value] };
    if (typeof value === 'number' && !Number.isFinite(value)) return { $sim: 'Number', value: String(value) };
    return value;
  });
}

export function parseDiagnostics(json: string): Diagnostics {
  const bundle = JSON.parse(json, (_key, value) => {
    if (value?.$sim === 'Map') return new Map(value.value);
    if (value?.$sim === 'Set') return new Set(value.value);
    if (value?.$sim === 'Number') return Number(value.value);
    return value;
  }) as Diagnostics;
  if (bundle.version !== 2 || typeof bundle.topology !== 'string' || bundle.dt !== FIXED_DT || !Number.isFinite(bundle.until)
    || !Array.isArray(bundle.inputs) || !bundle.startState || !bundle.config
    || bundle.until < bundle.startState.t || bundle.until > 28 * 3600) throw new Error('Unsupported diagnostics bundle');
  let last = bundle.startState.t;
  for (const input of bundle.inputs) {
    if (!Number.isFinite(input.t) || input.t < last - 1e-6 || input.t > bundle.until + 1e-6) throw new Error('Invalid command timeline');
    last = input.t;
  }
  return bundle;
}

export function replayDiagnostics(bundle: Diagnostics): Sim {
  const sim = new Sim(bundle.config);
  if (bundle.topology !== topologySignature(sim.topo)) throw new Error('Diagnostics infrastructure differs from the current model');
  restore(sim, bundle.startState);
  sim.startState = structuredClone(bundle.startState);
  sim.replaying = true;
  let cursor = 0;
  while (sim.t < bundle.until - 1e-6) {
    while (cursor < bundle.inputs.length && bundle.inputs[cursor].t <= sim.t + 1e-6) applyInput(sim, bundle.inputs[cursor++]);
    sim.step();
  }
  while (cursor < bundle.inputs.length && bundle.inputs[cursor].t <= sim.t + 1e-6) applyInput(sim, bundle.inputs[cursor++]);
  sim.replaying = false;
  sim.inputLog = structuredClone(bundle.inputs);
  return sim;
}

export function applyInput(sim: Sim, input: RecordedInput) {
  if ('cmd' in input) sim.command(input.cmd);
  else sim.drive(input.drive.train, input.drive.notch);
}

/** Keep one checkpoint every 10 min beyond the last two hours, including day start. */
export function compactCheckpoints(checkpoints: Checkpoint[], now: number): Checkpoint[] {
  let bucket = -1;
  return checkpoints.filter((cp, i) => {
    const next = Math.floor(cp.t / 600);
    if (i === 0 || now - cp.t <= 7200 || next !== bucket) { bucket = next; return true; }
    return false;
  });
}
