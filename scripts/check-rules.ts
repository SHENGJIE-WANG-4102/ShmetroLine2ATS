/**
 * Run before handing work in: `npm run check:rules`. Prints every rule hit not on the allow-list
 * (rules in scripts/rules.ts) and exits 1 when there is one.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { RULES, applies, checkText } from './rules';

/** the checker and its test spell out the patterns they look for */
const SELF = new Set(['scripts/rules.ts', 'tests/check-rules.test.ts']);

function main(): void {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' }).split('\n')
    .filter(file => file && !SELF.has(file) && RULES.some(rule => applies(rule, file)));
  const hits = files.flatMap(file => checkText(file, readFileSync(file, { encoding: 'utf8' })));
  for (const hit of hits) console.log(`${hit.file}:${hit.line} [${hit.rule.id}] ${hit.rule.rule}\n    ${hit.text.slice(0, 160)}`);
  console.log(hits.length ? `${hits.length} hit(s)` : 'check-rules: clean');
  process.exitCode = hits.length ? 1 : 0;
}

if (process.argv[1]?.endsWith('check-rules.ts')) main();
