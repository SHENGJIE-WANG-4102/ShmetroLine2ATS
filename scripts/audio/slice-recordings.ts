/** Reproducible mono MP3 slices; ffmpeg/ffprobe on PATH, no runtime dependency.
 * npx --no-install vite-node scripts/audio/slice-recordings.ts work/recordings
 * The source directory can change; edit SOUND_BANK to change cut boundaries.
 * --source-map work/.../sources.json accepts source-id -> raw-file-path overrides.
 */
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SOUND_BANK, SOUNDBANK_DIRECTORY, SOURCE_GAIN_REFERENCES } from '../../src/data/audio/soundbank';
import { VOICE_PARTS, VOICE_CROSSFADE_S, VOICE_SOURCES } from '../../src/data/audio/onboardbank';
import { RECORDING_SOURCES } from '../../src/data/audio/ridelog';

const sourceRoot = resolve(process.argv[2] ?? 'work/recordings');
const out = resolve('public', SOUNDBANK_DIRECTORY);
// An ignored JSON id -> path map allows raw files to stay in another folder.
const mapAt = process.argv.indexOf('--source-map');
const sourcePaths: Record<string, string> = mapAt < 0 ? {} : JSON.parse(readFileSync(resolve(process.argv[mapAt + 1]), 'utf8'));
mkdirSync(out, { recursive: true });
execFileSync('git', ['check-ignore', out], { stdio: 'pipe' });
// Validate all sources before writing any clips.
const sources = [...RECORDING_SOURCES, ...VOICE_SOURCES].map(source => {
  const dated = 'recordedDate' in source && source.recordedDate
    ? join(sourceRoot, source.recordedDate.slice(5), source.filename) : undefined;
  const path = [sourcePaths[source.id] && resolve(sourcePaths[source.id]), join(sourceRoot, source.filename), dated].find(p => p && existsSync(p));
  if (!path) throw new Error(`Missing source: ${source.filename}`);
  return { ...source, path };
});
const analysis = resolve('work/recordings/analysis');
mkdirSync(analysis, { recursive: true });
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt < 0 ? undefined : process.argv[onlyAt + 1].split(',');
const partsAt = process.argv.indexOf('--parts');
const onlyParts = partsAt < 0 ? undefined : process.argv[partsAt + 1].split(',');
const manifest = join(analysis, 'render-manifest.json');
writeFileSync(manifest, JSON.stringify({ sourceRoot, out, only, onlyParts, clips: SOUND_BANK, parts: VOICE_PARTS, gainReferences: SOURCE_GAIN_REFERENCES, sources, crossfadeS: VOICE_CROSSFADE_S }));
execFileSync(process.env.AUDIO_PYTHON ?? 'python', ['scripts/audio/render-soundbank.py', manifest], { stdio: 'inherit' });
console.log(`Rendered and verified ${only?.length ?? SOUND_BANK.length} local mono MP3 clips in ${out}`);
