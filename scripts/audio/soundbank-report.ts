/** Validate local sound provenance and station × direction × terminus coverage.
 * npx --no-install vite-node scripts/audio/soundbank-report.ts
 * Metadata only: no passenger recognition text or audio is emitted.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOUND_BANK, SOUNDBANK_DIRECTORY, clipDuration } from '../../src/data/audio/soundbank';
import { ONBOARD_ANNOUNCEMENTS, ONBOARD_NEXT_DELAY_S, ONBOARD_ARRIVAL_ADVANCE_S,
  ONBOARD_DESTINATIONS, RECORDED_ONBOARD, VOICE_PARTS, VOICE_SOURCES, compatibleVoiceRecipe } from '../../src/data/audio/onboardbank';
import { RECORDING_SOURCES } from '../../src/data/audio/ridelog';
import { STATIONS } from '../../src/data/current';
const ids = new Set<string>(), files = new Set<string>();
for (const clip of SOUND_BANK) {
  if (ids.has(clip.id) || files.has(clip.file)) throw new Error(`Duplicate clip: ${clip.id}`);
  ids.add(clip.id); files.add(clip.file);
  const source = [...RECORDING_SOURCES, ...VOICE_SOURCES].find(s => s.id === clip.source);
  if (!source || clip.range[0] < 0 || clip.range[1] > source.durationS + .01 || clipDuration(clip) <= 0) throw new Error(`Invalid range: ${clip.id}`);
  if (!STATIONS.some(s => s.name === clip.station)) throw new Error(`Unknown station: ${clip.station}`);
  if (!existsSync(join('public', SOUNDBANK_DIRECTORY, clip.file))) throw new Error(`Missing local slice: ${clip.file}`);
  for (const at of [clip.stopAt, clip.startAt, clip.otherAt]) if (at !== undefined && (at < 0 || at >= clipDuration(clip) && !(clip.anchorAfterTail && at === clip.stopAt && clip.range[0] + at < source.durationS))) throw new Error(`Invalid anchor: ${clip.id}`);
  for (const part of clip.composition ?? []) if (!VOICE_PARTS.some(p => p.id === part)) throw new Error(`Missing composition part: ${part}`);
  if (clip.composition && !compatibleVoiceRecipe(clip.composition.map(id => VOICE_PARTS.find(p => p.id === id)!), clip.station)) throw new Error(`Incompatible PA speakers: ${clip.id}`);
}
for (const entry of ONBOARD_ANNOUNCEMENTS) for (const id of [entry.next?.clipId, entry.arrived?.clipId]) {
  if (!id) continue;
  const clip = SOUND_BANK.find(c => c.id === id);
  if (!clip || clip.station !== entry.station || clip.direction !== entry.direction || clip.doorSide !== entry.doorSide) throw new Error(`Wrong PA identity/door: ${id}`);
}
for (const row of RECORDED_ONBOARD) for (const boundary of [row.destinationSentence, row.transferRange])
  if (boundary && (boundary[0] < row.range[0] || boundary[1] > row.range[1])) throw new Error(`Sentence outside original PA: ${row.id}`);
if (!Number.isFinite(ONBOARD_NEXT_DELAY_S) || !Number.isFinite(ONBOARD_ARRIVAL_ADVANCE_S)) throw new Error('Missing measured timing mean');
for (const part of VOICE_PARTS) {
  const source = [...RECORDING_SOURCES, ...VOICE_SOURCES].find(s => s.id === part.source);
  if (!source || part.range[0] < 0 || part.range[1] > source.durationS || part.range[1] <= part.range[0]) throw new Error(`Invalid voice range: ${part.id}`);
  if (part.file && !existsSync(join('public', SOUNDBANK_DIRECTORY, part.file))) throw new Error(`Missing standalone voice: ${part.id}`);
}
console.log(`Verified ${SOUND_BANK.length + VOICE_PARTS.filter(p => p.file).length} local files; ${SOUND_BANK.filter(c => c.provenance === 'original').length} original recordings/slices, ${VOICE_PARTS.length} library parts.`);
console.log(`Complete PA means: departure +${ONBOARD_NEXT_DELAY_S.toFixed(2)} s; arrival -${ONBOARD_ARRIVAL_ADVANCE_S.toFixed(2)} s.`);
console.log('\n| 站 | 方向 | 蟠祥路 | 广兰路 | 机场 |');
console.log('|---|---|---|---|---|');
const first = 0, last = STATIONS.length - 1;
for (let st = first; st <= last; st++) for (const dir of ['DN', 'UP'] as const) {
  const statuses = ONBOARD_DESTINATIONS.map(dest => {
    const row = ONBOARD_ANNOUNCEMENTS.find(a => a.station === STATIONS[st].name && a.direction === dir && a.destination === dest);
    if (!row) return '—';
    const clips = [row.next?.clipId, row.arrived?.clipId].map(id => SOUND_BANK.find(c => c.id === id));
    if (clips.some(c => !c)) return '缺';
    return (clips.every(c => c!.provenance === 'original') ? 'original' : 'composed') + (row.missingSentences.length ? '†' : '');
  });
  console.log(`| ${STATIONS[st].name} | ${dir} | ${statuses.join(' | ')} |`);
}
console.log('\n江苏路借平台中文站名；英文专名江苏 + Road为混合来源composed，不冒称原英文录音。中英文右门句已从补充素材定位并降噪。');
const loudness = 'work/recordings/analysis/render/loudness.json';
if (existsSync(loudness)) {
  const report = JSON.parse(readFileSync(loudness, 'utf8'));
  const classes = [...new Set(report.measurements.map((m: { class: string }) => m.class))] as string[];
  console.log('\n| 类别 | 数量 | 归一化前均值 LUFS | 成片均值 LUFS |');
  console.log('|---|---:|---:|---:|');
  for (const kind of classes) {
    const rows = report.measurements.filter((m: { class: string }) => m.class === kind);
    const mean = (key: string) => (rows.reduce((sum: number, m: Record<string, number>) => sum + m[key], 0) / rows.length).toFixed(2);
    console.log(`| ${kind} | ${rows.length} | ${mean('before')} | ${mean('after')} |`);
  }
}
