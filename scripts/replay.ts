import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
const args: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--line') { i++; continue; }
  if (!process.argv[i].startsWith('--line=')) args.push(process.argv[i]);
}
const file = args[0];
if (!file) throw new Error('Usage: npm run replay -- <diagnostics.json> [replayed.json] [--line=<group>]');
const json = readFileSync(file, 'utf8');
// Select the archive's world before importing the simulator's immutable facade.
// An explicit --line/ATS_LINE stays authoritative and mismatch is rejected.
if (!process.env.ATS_LINE && !process.argv.some(arg => arg === '--line' || arg.startsWith('--line='))) {
  const metadata = JSON.parse(json);
  process.env.ATS_LINE = metadata.scope?.groupId ?? metadata.config?.scope?.groupId ?? '2';
}
const { parseDiagnostics, replayDiagnostics, stringifyDiagnostics, exportDiagnostics } = await import('../src/sim/diagnostics');
const { capture } = await import('../src/sim/state');
const bundle = parseDiagnostics(json);
const sim = replayDiagnostics(bundle);
// Compare the serialized state: old JSON omits undefined fields and gains scope
// fields during migration, so object insertion order is not meaningful here.
const matchesSnapshot = isDeepStrictEqual(
  JSON.parse(stringifyDiagnostics({ ...bundle, state: capture(sim) })),
  JSON.parse(stringifyDiagnostics(bundle)),
);
console.log(JSON.stringify({ t: sim.t, matchesSnapshot, integrity: sim.integrity.counts, trips: sim.tripsDone }));
if (args[1]) writeFileSync(args[1], stringifyDiagnostics(exportDiagnostics(sim)));
if (!matchesSnapshot || Object.values(sim.integrity.counts).some(n => n > 0)) process.exitCode = 1;
