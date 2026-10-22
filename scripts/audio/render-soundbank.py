#!/usr/bin/env python3
"""Render the numeric soundbank manifest: numpy, ffmpeg and ffprobe required.

All analysis/cache remains under ignored work/. Carriage PA is two-pass
loudnorm at -16 LUFS. Platform slices and new door sounds share source gains;
noise in existing carriage loops preserves its measured difference from PA.
Library cuts snap to a zero crossing within 15 ms, then receive the same
loudness target BEFORE a 30 ms crossfade. No transcript or audio is uploaded.
"""
import argparse
import json
import pathlib
import re
import subprocess

import numpy as np

RATE = 48000


def run(args, data=None):
    return subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)


def measure(a, target=-16, repeat_short=True):
    # Short words need several complete 400 ms measurement blocks. Repetition
    # affects only the analyser input, never the rendered word duration.
    samples = np.tile(a, max(1, int(np.ceil(3.2 * RATE / len(a))))) if repeat_short else a
    result = run(['ffmpeg', '-hide_banner', '-f', 'f32le', '-ar', str(RATE), '-ac', '1', '-i', 'pipe:0',
                  '-af', f'loudnorm=I={target}:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], samples.astype('<f4').tobytes())
    log = result.stderr.decode(errors='replace')
    return json.JSONDecoder().raw_decode(log[log.rfind('{'):])[0]


def short_loudness(a):
    """Peak 3 s short-term loudness; shorter name clips are zero-padded only
    for this measurement, never repeated or padded in the rendered asset."""
    a = np.pad(a, (0, max(0, 3 * RATE - len(a))))
    result = run(['ffmpeg', '-hide_banner', '-nostats', '-f', 'f32le', '-ar', str(RATE), '-ac', '1', '-i', 'pipe:0',
                  '-af', 'ebur128', '-f', 'null', '-'], a.astype('<f4').tobytes())
    values = [float(v) for v in re.findall(r'\bS:\s*(-?[\d.]+)', result.stderr.decode(errors='replace'))]
    values = [v for v in values if v > -100]
    return max(values) if values else None


def normalise(a, target):
    measured = measure(a, target)
    params = ':'.join(f'{key}={measured[value]}' for key, value in [
        ('measured_I', 'input_i'), ('measured_TP', 'input_tp'),
        ('measured_LRA', 'input_lra'), ('measured_thresh', 'input_thresh'), ('offset', 'target_offset')])
    result = run(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', str(RATE), '-ac', '1', '-i', 'pipe:0',
                  '-af', f'loudnorm=I={target}:TP=-1.5:LRA=11:{params}:linear=true',
                  '-ar', str(RATE), '-f', 'f32le', '-'], a.astype('<f4').tobytes())
    normal = np.frombuffer(result.stdout, dtype='<f4').copy()
    # loudnorm's short-clip startup/gating can leave individual words below
    # target even with repeated first-pass measurements. Correct constant gain
    # using the same repeat analyser; preserve duration and avoid hard clipping.
    for _ in range(3):
        current = float(measure(normal, target)['input_i'])
        if abs(current - target) <= .15:
            break
        normal *= 10 ** ((target - current) / 20)
        if np.max(np.abs(normal)) > .84:
            limited = run(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', str(RATE), '-ac', '1', '-i', 'pipe:0',
                           '-af', 'alimiter=limit=0.84:level=false:latency=true', '-f', 'f32le', '-'], normal.astype('<f4').tobytes())
            normal = np.frombuffer(limited.stdout, dtype='<f4').copy()
    return normal, float(measured['input_i'])


def crossfade(parts, seconds):
    result = parts[0].copy()
    for following in parts[1:]:
        count = min(round(seconds * RATE), len(result), len(following))
        ramp = np.linspace(0, 1, count, dtype=np.float32)
        result = np.concatenate((result[:-count], result[-count:] * (1 - ramp) + following[:count] * ramp, following[count:]))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=pathlib.Path)
    args = parser.parse_args()
    workspace = pathlib.Path(__file__).resolve().parents[2]
    work = workspace / 'work' / 'recordings' / 'analysis' / 'render'
    work.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(args.manifest.read_text(encoding='utf-8'))
    out = pathlib.Path(manifest['out']).resolve()
    if out != workspace / 'public' / 'sounds' / 'field-20261014':
        raise ValueError('Unexpected audio output directory')
    out.mkdir(parents=True, exist_ok=True)
    source_root = pathlib.Path(manifest['sourceRoot'])
    sources = {s['id']: pathlib.Path(s['path']) if s.get('path') else source_root / s['filename'] for s in manifest['sources']}
    if any(not p.is_file() for p in sources.values()):
        raise ValueError('A source file is missing')
    cache = {}
    boundaries = []

    def decode(source, bounds, snap=False, effects=None):
        key = (source, tuple(bounds), snap, effects)
        if key in cache:
            return cache[key].copy()
        begin, end = bounds
        margin = 1.5 if effects and effects.startswith('clean-speech') else .015 if snap else 0
        actual_begin = max(0, begin - margin)
        filters = {'cabin-floor': 'highpass=f=25,lowpass=f=180', 'rolling-noise': 'highpass=f=30,lowpass=f=800',
                   'door-warning': 'highpass=f=2600,lowpass=f=3000',
                   'door-mechanism': 'bandreject=f=2750:t=h:w=130,bandreject=f=2843:t=h:w=130',
                   'clean-speech-zh': 'highpass=f=350,lowpass=f=5500,anlmdn=s=0.001:p=0.002:r=0.006',
                   'clean-speech-en': 'highpass=f=180,lowpass=f=5500,afftdn=nr=18:nf=-25:tn=1:gs=10'}
        command = ['ffmpeg', '-v', 'error', '-ss', str(actual_begin), '-t', str(end + margin - actual_begin), '-i', str(sources[source])]
        if effects:
            command += ['-af', filters[effects]]
        command += ['-ac', '1', '-ar', str(RATE), '-f', 'f32le', '-']
        a = np.frombuffer(run(command).stdout, dtype='<f4').copy()
        indices = [round((begin - actual_begin) * RATE), round((end - actual_begin) * RATE)]
        if snap:
            for i, index in enumerate(indices):
                lo, hi = max(0, index - round(.015 * RATE)), min(len(a) - 1, index + round(.015 * RATE))
                crossings = np.flatnonzero(np.signbit(a[lo:hi]) != np.signbit(a[lo + 1:hi + 1])) + lo
                if len(crossings):
                    indices[i] = int(crossings[np.argmin(np.abs(crossings - index))])
            boundaries.append({'source': source, 'requested': bounds, 'actual': [actual_begin + i / RATE for i in indices]})
        a = a[indices[0]:indices[1]]
        if not len(a):
            raise ValueError(f'Empty sound: {source} {bounds}')
        cache[key] = a
        return a.copy()

    all_clips = manifest['clips']
    selected = set(manifest.get('only') or [])
    clips = [c for c in all_clips if not selected or c['id'] in selected]
    if selected and len(clips) != len(selected):
        raise ValueError('Unknown --only clip id')
    previous_path = work / 'loudness.json'
    previous = json.loads(previous_path.read_text(encoding='utf-8')) if selected and previous_path.exists() else None
    # Compare cabin noise against actual original complete PA, not its target.
    # Keep the old PA reference population: direction aliases and contiguous
    # trims must not change cabin/rolling loudness on a clean full render.
    speech = [c for c in all_clips if c.get('provenance') == 'original' and c['source'] == 'ride-east'
              and c['id'].startswith('original-') and not c['id'].startswith('original-slice-')]
    raw_voice = [] if previous else [float(measure(decode(c['source'], c['range']))['input_i']) for c in speech]
    voice_reference = previous['voiceReferenceLUFS'] if previous else float(np.mean(raw_voice))
    print(f'Original carriage PA reference: {voice_reference:.2f} LUFS', flush=True)
    library = {}
    needed = {id for c in clips for id in c.get('composition', [])}
    selected_parts = set(manifest.get('onlyParts') or [])
    if selected_parts - {p['id'] for p in manifest['parts']}:
        raise ValueError('Unknown --parts library id')
    active_parts = [p for p in manifest['parts'] if not selected or p['id'] in needed or p['id'] in selected_parts]
    replacing = {c['id'] for c in clips} | {p['id'] for p in active_parts}
    measurements = [m for m in previous['measurements'] if m['id'] not in replacing] if previous else []
    # Constant source gains are deliberately independent of clip selection.
    # Platform references use the whole source for headroom, with no limiter,
    # compressor or individual loudnorm on any of its slices (including loops).
    source_gains = {}
    def gain_source(c):
        return c.get('sourceGain') or (c['source'] if c['source'].startswith('platform-') and not c.get('provenance') else None)
    for ref in manifest.get('gainReferences', []):
        source = ref['source']
        if not any(gain_source(c) == source for c in clips):
            continue
        reference = measure(decode(source, ref['range']), repeat_short=False)
        duration = next(s['durationS'] for s in manifest['sources'] if s['id'] == source)
        peak = float(measure(decode(source, [0, duration]), repeat_short=False)['input_tp']) if source.startswith('platform-') else float(reference['input_tp'])
        gain = min(ref['targetLUFS'] - float(reference['input_i']), -.1 - peak)
        source_gains[source] = {'gainDB': gain, 'referenceLUFS': float(reference['input_i']),
                                'referenceRange': ref['range'], 'referenceAfterLUFS': float(reference['input_i']) + gain,
                                'sourcePeakDBTP': peak, 'nominalTargetLUFS': ref['targetLUFS']}
        print(f'{source}: common gain {gain:+.2f} dB; reference {float(reference["input_i"]):.2f} -> {float(reference["input_i"])+gain:.2f} LUFS', flush=True)
    for p in active_parts:
        a = decode(p['source'], p['range'], snap=True, effects=p.get('effects'))
        a, before = normalise(a, -16)
        library[p['id']] = a
        # Decoding a needed part for a changed composition must not rewrite
        # its independently delivered file unless that part was selected.
        if p.get('file') and (not selected or p['id'] in selected_parts or not (out / p['file']).exists()):
            # Fade first, then meter the standalone word. Fading a very short
            # normalised name afterwards can otherwise lower it by >1 LU.
            standalone = a.copy()
            head, tail = min(round(.015 * RATE), len(a)), min(round(.025 * RATE), len(a))
            standalone[:head] *= np.linspace(0, 1, head)
            standalone[-tail:] *= np.linspace(1, 0, tail)
            standalone, _ = normalise(standalone, -16)
            run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(RATE), '-ac', '1', '-i', 'pipe:0',
                 '-c:a', 'libmp3lame', '-b:a', '112k', str(out / p['file'])], standalone.astype('<f4').tobytes())
        measurements.append({'id': p['id'], 'class': 'library-' + p['language'], 'before': before,
                             'after': float(measure(a)['input_i']), 'target': -16})
    for clip in clips:
        fixed_source = gain_source(clip)
        path = out / clip['file']
        old = None
        if fixed_source and path.exists():
            old = np.frombuffer(run(['ffmpeg', '-v', 'error', '-i', str(path), '-ar', str(RATE), '-ac', '1', '-f', 'f32le', '-']).stdout, dtype='<f4')
        composed = bool(clip.get('composition'))
        a = crossfade([library[id] for id in clip['composition']], manifest['crossfadeS']) if composed else decode(clip['source'], clip['range'], effects=clip.get('effects'))
        before = float(measure(a)['input_i'])
        noise = clip['kind'] in ['interior-rolling', 'interior-idle', 'ambience']
        target = round(-16 + before - voice_reference, 2) if noise else -16
        # Bounds of the audio processor; do not make a very quiet floor loud.
        target = max(-60, min(-5, target))
        if clip.get('loopCrossfadeS'):
            count = round(clip['loopCrossfadeS'] * RATE)
            a = crossfade([a[-count:], a[:count]], clip['loopCrossfadeS'])
            original = decode(clip['source'], clip['range'], effects=clip.get('effects'))
            a = np.concatenate((a, original[count:-count]))
        if fixed_source:
            a *= 10 ** (source_gains[fixed_source]['gainDB'] / 20)
            fade_in = min(round(clip.get('fadeInS', .04) * RATE), len(a) // 4)
            fade_out = min(round(clip.get('fadeOutS', .04) * RATE), len(a) // 4)
            a[:fade_in] *= np.linspace(0, 1, fade_in)
            a[-fade_out:] *= np.linspace(1, 0, fade_out)
        else:
            a, _ = normalise(a, target)
            fade = min(round((1.5 if clip.get('truncatedTail') else .015) * RATE), len(a) // 4)
            if not clip.get('loopCrossfadeS'):
                a[:min(720, fade)] *= np.linspace(0, 1, min(720, fade))
                a[-fade:] *= np.linspace(1, 0, fade)
        if pathlib.Path(clip['file']).name != clip['file'] or not clip['file'].endswith('.mp3'):
            raise ValueError('Unsafe clip filename')
        run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(RATE), '-ac', '1', '-i', 'pipe:0',
             '-c:a', 'libmp3lame', '-b:a', '112k', str(path)], a.astype('<f4').tobytes())
        decoded = np.frombuffer(run(['ffmpeg', '-v', 'error', '-i', str(path), '-ar', str(RATE), '-ac', '1', '-f', 'f32le', '-']).stdout, dtype='<f4')
        after = float(measure(decoded, repeat_short=not fixed_source)['input_i'])
        meta = json.loads(run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=channels', '-of', 'json', str(path)]).stdout)
        expected = clip.get('durationS', clip['range'][1] - clip['range'][0] - clip.get('loopCrossfadeS', 0))
        if meta['streams'][0]['channels'] != 1 or abs(float(meta['format']['duration']) - expected) > .14:
            raise ValueError(f'Unexpected channels/duration: {clip["id"]}')
        if not fixed_source and abs(after - target) > .8:
            raise ValueError(f'Loudness mismatch: {clip["id"]} {after} target {target}')
        row = {'id': clip['id'], 'class': clip['kind'], 'provenance': clip.get('provenance'),
               'before': before, 'after': after, 'target': None if fixed_source else target, 'durationS': len(decoded) / RATE}
        if fixed_source:
            row['sourceGainDB'] = source_gains[fixed_source]['gainDB']
            row['previousIntegratedLUFS'] = float(measure(old, repeat_short=False)['input_i']) if old is not None else None
            if clip.get('voiceRange'):
                lo, hi = [round((t - clip['range'][0]) * RATE) for t in clip['voiceRange']]
                row['voiceShortBeforeLUFS'] = short_loudness(old[max(0,lo):hi]) if old is not None else None
                row['voiceShortAfterLUFS'] = short_loudness(decoded[max(0,lo):hi])
        measurements.append(row)
        print(f'{clip["id"]}: {before:.2f} -> {after:.2f} LUFS', flush=True)
    report = {'voiceReferenceLUFS': voice_reference, 'crossfadeS': manifest['crossfadeS'],
              'measurements': measurements, 'boundaries': boundaries,
              'sourceGains': {**(previous.get('sourceGains', {}) if previous else {}), **source_gains}}
    (work / 'loudness.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'Rendered {len(clips)} mono clips; metadata in {work / "loudness.json"}', flush=True)


if __name__ == '__main__':
    main()
