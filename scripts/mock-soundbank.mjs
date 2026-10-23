/** Local placeholders, never overwrite actual recordings without --force.
 * node scripts/mock-soundbank.mjs [--force]
 * Requires ffmpeg and the repository's existing TypeScript dependency.
 * Reads the real bank so filenames, durations and anchors stay identical.
 */
import { mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
// Use the same ESM transform as the app so selected catalogues may import shared helpers.
const loader = await createServer({ configFile: false, root, server: { middlewareMode: true, watch: null }, appType: 'custom' });
let bank;
try {
  const sounds = await loader.ssrLoadModule('/src/data/audio/soundbank.ts');
  const onboard = await loader.ssrLoadModule('/src/data/audio/onboardbank.ts');
  bank = { ...sounds, fixed: onboard.VOICE_PARTS.filter(p => p.file) };
} finally { await loader.close(); }
const { SOUND_BANK, SOUNDBANK_DIRECTORY, clipDuration } = bank;
const out = join(root, 'public', SOUNDBANK_DIRECTORY);
mkdirSync(out, { recursive: true });
execFileSync('git', ['check-ignore', out], { cwd: root, stdio: 'pipe' });
let count = 0;
const clips = [...SOUND_BANK, ...bank.fixed.map(p => ({ ...p, kind: 'interior-suffix' }))];
for (const [index, clip] of clips.entries()) {
  if (!/^[a-z0-9-]+\.mp3$/.test(clip.file)) throw new Error(`Unsafe filename: ${clip.file}`);
  const path = join(out, clip.file);
  if (existsSync(path) && !process.argv.includes('--force')) continue;
  const duration = clipDuration(clip), anchor = clip.stopAt ?? clip.startAt ?? 0;
  const volume = clip.kind === 'ambience' ? '0.01' : `if(between(t,${anchor},${Math.min(duration, anchor + .16)}),0.18,0.01)`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${330 + index * 37}:sample_rate=48000:duration=${duration}`,
    '-af', `volume='${volume}':eval=frame`, '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '112k', path], { stdio: 'pipe' });
  count++;
}
console.log(`Generated ${count} placeholders in ${out}; existing recordings preserved unless --force.`);
