/** Versioned, lossless diagnostics and deterministic replay from the service-day start. */
import { Sim, FIXED_DT } from './engine';
import type { Command, SimConfig } from './model';
import { capture, restore, type Checkpoint } from './state';
import type { Topology } from './topology';
import { assertScope, currentScope, type LineScope } from '../data/scope';

export type RecordedInput = { scope?: LineScope } & ({ t: number; cmd: Command; reasonCode?: string } | { t: number; drive: { train: number; notch: number } });
export interface Diagnostics {
  version: 2;
  scope?: LineScope;
  topology: string;
  dt: number;
  config: SimConfig;
  startState: Checkpoint;
  inputs: RecordedInput[];
  until: number;
  state: Checkpoint;
}

export function exportDiagnostics(sim: Sim, inputs: RecordedInput[] = sim.inputLog): Diagnostics {
  assertScope(sim.config.scope);
  for (const input of inputs) assertScope(input.scope);
  return {
    version: 2, scope: currentScope(), topology: topologySignature(sim.topo), dt: FIXED_DT, config: { ...sim.config },
    startState: sim.startState ?? capture(new Sim(sim.config)),
    inputs: structuredClone(inputs.filter(e => e.t <= sim.t + 1e-6).map(input => ({ ...input, scope: currentScope() }))),
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
    || !Array.isArray(bundle.inputs) || !bundle.startState || !bundle.state || !bundle.config
    || bundle.until < bundle.startState.t || bundle.until > 28 * 3600) throw new Error('Unsupported diagnostics bundle');
  let last = bundle.startState.t;
  assertScope(bundle.scope);
  assertScope(bundle.config.scope);
  assertScope(bundle.startState.scope);
  assertScope(bundle.state?.scope);
  for (const input of bundle.inputs) {
    assertScope(input.scope);
    if (!Number.isFinite(input.t) || input.t < last - 1e-6 || input.t > bundle.until + 1e-6) throw new Error('Invalid command timeline');
    last = input.t;
  }
  // Upgrade old single-line archives before comparison or a later export.
  bundle.scope = currentScope();
  bundle.config.scope = currentScope();
  for (const cp of [bundle.startState, bundle.state]) {
    cp.scope = currentScope();
    cp.inputs = cp.inputs?.map(input => {
      assertScope(input.scope);
      return { ...input, scope: currentScope() };
    }) ?? [];
  }
  bundle.inputs = bundle.inputs.map(input => ({ ...input, scope: currentScope() }));
  return bundle;
}

export function replayDiagnostics(bundle: Diagnostics): Sim {
  assertScope(bundle.scope);
  assertScope(bundle.config.scope);
  for (const cp of [bundle.startState, bundle.state]) {
    assertScope(cp.scope);
    for (const input of cp.inputs ?? []) assertScope(input.scope);
  }
  for (const input of bundle.inputs) assertScope(input.scope);
  const sim = new Sim(bundle.config);
  if (bundle.topology !== topologySignature(sim.topo)) throw new Error('Diagnostics infrastructure differs from the current model');
  restore(sim, bundle.startState);
  sim.startState = structuredClone({ ...bundle.startState, scope: currentScope(),
    inputs: bundle.startState.inputs?.map(input => ({ ...input, scope: currentScope() })) ?? [] });
  sim.replaying = true;
  let cursor = 0;
  while (sim.t < bundle.until - 1e-6) {
    while (cursor < bundle.inputs.length && bundle.inputs[cursor].t <= sim.t + 1e-6) applyInput(sim, bundle.inputs[cursor++]);
    sim.step();
  }
  while (cursor < bundle.inputs.length && bundle.inputs[cursor].t <= sim.t + 1e-6) applyInput(sim, bundle.inputs[cursor++]);
  sim.replaying = false;
  sim.inputLog = structuredClone(bundle.inputs.map(input => ({ ...input, scope: currentScope() })));
  return sim;
}

export function applyInput(sim: Sim, input: RecordedInput) {
  assertScope(input.scope);
  if ('cmd' in input) {
    const result = sim.command(input.cmd);
    if (input.reasonCode !== undefined && result.reasonCode !== input.reasonCode) {
      sim.log('C', '回放', `命令原因不一致：记录 ${input.reasonCode}，重放 ${result.reasonCode ?? '无'}`);
    }
  }
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
