import { describe, expect, it } from 'vitest';
import { currentScope, LEGACY_SCOPE, sameScope, type LineScope } from '../src/data/scope';
import { Sim } from '../src/sim/engine';
import { capture, fingerprint, restore } from '../src/sim/state';
import { applyInput, exportDiagnostics, parseDiagnostics, replayDiagnostics, stringifyDiagnostics } from '../src/sim/diagnostics';
import { warmupKey } from '../src/sim/warmupCache';

const foreign: LineScope = { groupId: 'foreign', lineIds: ['foreign'] };
const make = () => new Sim({ dayType: 'weekday', dateLabel: 'scope test', startTime: 14400, seed: 19 });

describe('line group state boundaries', () => {
  it('records the startup scope on configs, checkpoints, diagnostics and commands', () => {
    const sim = make();
    sim.command({ c: 'bookmark', label: 'scope' });
    const bundle = exportDiagnostics(sim);
    expect(sim.config.scope).toEqual(currentScope());
    expect(capture(sim).scope).toEqual(currentScope());
    expect(bundle.scope).toEqual(currentScope());
    expect(bundle.inputs).toHaveLength(1);
    expect(bundle.inputs[0].scope).toEqual(currentScope());
    expect(replayDiagnostics(parseDiagnostics(stringifyDiagnostics(bundle))).inputLog).toEqual(sim.inputLog);
  });

  it('refuses restoring an otherwise identical foreign checkpoint before mutating the world', () => {
    const sim = make(), cp = capture(sim), before = fingerprint(sim);
    cp.scope = foreign;
    expect(() => restore(sim, cp)).toThrow('线路组不匹配');
    expect(fingerprint(sim)).toBe(before);
    expect(() => new Sim({ ...sim.config, scope: foreign })).toThrow('线路组不匹配');
  });

  it('checks archived commands even when the bundle and topology match', () => {
    const sim = make();
    sim.command({ c: 'bookmark', label: 'scope' });
    const bundle = exportDiagnostics(sim);
    bundle.inputs[0].scope = foreign;
    expect(() => parseDiagnostics(stringifyDiagnostics(bundle))).toThrow('线路组不匹配');
    expect(() => replayDiagnostics(bundle)).toThrow('线路组不匹配');
    expect(() => applyInput(sim, bundle.inputs[0])).toThrow('线路组不匹配');
    expect(() => exportDiagnostics(sim, bundle.inputs)).toThrow('线路组不匹配');
    const cp = capture(sim);
    cp.inputs = bundle.inputs;
    expect(() => restore(sim, cp)).toThrow('线路组不匹配');
  });

  it('keeps pre-selection single-line archives readable and adds their scope on export', () => {
    expect(sameScope(currentScope(), LEGACY_SCOPE)).toBe(true);
    const sim = make();
    sim.command({ c: 'bookmark', label: 'legacy' });
    const bundle = exportDiagnostics(sim);
    delete bundle.scope;
    delete bundle.config.scope;
    for (const cp of [bundle.startState, bundle.state]) {
      delete cp.scope;
      cp.inputs.forEach(input => delete input.scope);
    }
    bundle.inputs.forEach(input => delete input.scope);
    const replayed = replayDiagnostics(parseDiagnostics(stringifyDiagnostics(bundle)));
    expect(fingerprint(replayed)).toBe(fingerprint(sim));
    expect(exportDiagnostics(replayed).inputs.every(input => sameScope(input.scope!, currentScope()))).toBe(true);
  });

  it('uses all line IDs in the group and rejects a foreign cache configuration', async () => {
    expect(sameScope({ groupId: 'shared', lineIds: ['3', '4'] }, { groupId: 'shared', lineIds: ['3'] })).toBe(false);
    const sim = make();
    const key = await warmupKey(sim.config, sim.plan, { 'data/lines/example.ts': 'v1' });
    expect(await warmupKey(sim.config, sim.plan, { 'data/lines/example.ts': 'v2' })).not.toBe(key);
    await expect(warmupKey({ ...sim.config, scope: foreign }, sim.plan, {})).rejects.toThrow('线路组不匹配');
  });
});
