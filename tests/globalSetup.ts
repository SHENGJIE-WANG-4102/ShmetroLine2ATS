import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { startupGroupId } from '../src/data/startup';

/** Warm-ups the test files share (dayType-startTime-seed): each takes tens of
 * seconds of simulation, so they run once, in parallel, before the tests, and
 * are reused until the simulator source changes. */
export const WARMUPS = ['weekday-28800-7', 'weekday-32400-7', 'weekday-35700-5', 'weekday-27600-13'];

function sourceHash(): string {
  const hash = createHash('sha256');
  hash.update(startupGroupId());
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else { hash.update(path); hash.update(readFileSync(path)); }
    }
  };
  walk('src/sim'); walk('src/data'); hash.update(readFileSync('tests/warmup.ts'));
  return hash.digest('hex').slice(0, 16);
}

export default async function setup() {
  const root = 'node_modules/.cache/atssim-warmup';
  const dir = join(root, sourceHash());
  if (existsSync(root)) for (const old of readdirSync(root)) if (join(root, old) !== dir) rmSync(join(root, old), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await Promise.all(WARMUPS.filter(key => !existsSync(join(dir, `${key}.bin`))).map(key => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/vite-node/vite-node.mjs', 'tests/warmup.ts', key, join(dir, `${key}.bin`)], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', code => code ? reject(new Error(`warm-up ${key} exited ${code}`)) : resolve());
  })));
  process.env.ATSSIM_WARMUPS = dir;
}
