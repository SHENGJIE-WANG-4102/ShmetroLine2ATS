import { readdirSync, readFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { selectCases, runSoak } from './soak-runner.mjs';
const quick = process.argv.includes('--quick');
const positive = (name, fallback) => {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
};
const seeds = quick ? 2 : positive('SOAK_SEEDS', 10);
const workers = positive('SOAK_WORKERS', Math.min(4, Math.max(2, availableParallelism() - 1)));
const output = process.env.SOAK_OUT ?? (quick ? 'tests/out/soak-quick' : 'tests/out/soak');
const filter = process.argv.find(a => a.startsWith('--filter='))?.slice('--filter='.length) ?? process.env.SOAK_FILTER;
function modelHash() {
  const hash = createHash('sha256');
  for (const dir of ['src/sim', 'src/data']) for (const file of readdirSync(dir).filter(f => f.endsWith('.ts')).sort())
    hash.update(`${dir}/${file}\n`).update(readFileSync(`${dir}/${file}`));
  hash.update(readFileSync('scripts/soak-case.ts'));
  return hash.digest('hex');
}
// Level 3 (a train failure about every 45 min) stays an instructor setting but is
// not a soak gate: no real operating day sees that fault rate (D23).
const cases = selectCases(seeds, quick ? [0, 2] : [0, 1, 2], filter);
// Check the added-service scheduling first, then fault recovery and the base
// plans. Ordering changes no cases, seeds, fault levels or certification rules.
if (quick) {
  const priority = c => c.level === 0 && c.template !== 'base' ? 0 : c.level === 2 ? 1 : 2;
  cases.sort((a,b) => priority(a)-priority(b) || a.seed-b.seed || a.template.localeCompare(b.template) || a.dayType.localeCompare(b.dayType));
}
const summary = await runSoak({ cases,
  output, model: modelHash(), hashCurrent: modelHash, workers,
  log: line => writeSync(1, line + '\n'),
  timeoutMs: positive('SOAK_TIMEOUT_MS', 60 * 60 * 1000), resume: process.env.SOAK_RESUME === '1',
  failFast: process.env.SOAK_FAIL_FAST === '1', progress: process.env.SOAK_PROGRESS !== '0',
  certify: !quick && seeds >= 10 && !filter });
writeSync(1, `Soak${quick ? ' quick' : ''}: ${summary.completed}/${summary.requested} cases; ${summary.certified ? 'full matrix passed' : summary.failed ? 'FAILED' : 'subset passed (not full certification)'}\n`);
if (summary.failed || !summary.complete) process.exitCode = 1;
