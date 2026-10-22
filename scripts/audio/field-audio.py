#!/usr/bin/env python3
"""Local measurement/statistics stage; normally called by field-calibration.ts.

Dependencies: Python 3.10+, numpy, scipy, ffmpeg. All private derivatives stay
under ignored work/. Confidence labels describe acoustic evidence, not CIs.
"""
import argparse
from difflib import SequenceMatcher
from collections import Counter, defaultdict
import hashlib
import importlib.util
import json
import math
import re
from pathlib import Path
import statistics
import subprocess
import sys

import numpy as np
from scipy import ndimage, signal

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/gaode'))
from match_trains import match_trains, official_lag_anchor, estimate_lag
from east_analysis import estimate as exploratory_estimate
import scrape


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


stops, tones, starts = module('measure-stops'), module('measure-door-tones'), module('refine-starts')
motion = module('measure-motion-cues')


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')


def stats(values):
    values = list(values)
    n = len(values)
    sd = statistics.stdev(values) if n > 1 else None
    return dict(n=n, mean=statistics.mean(values) if n else None, sd=sd,
                se=sd / math.sqrt(n) if sd is not None else None,
                minimum=min(values) if n else None, maximum=max(values) if n else None)


def clock_seconds(value):
    bits = list(map(int, value.split(':')))
    if len(bits) not in (2, 3) or not 0 <= bits[0] <= 27 or not 0 <= bits[1] < 60 or (len(bits) == 3 and not 0 <= bits[2] < 60):
        raise ValueError('Clock must be HH:MM[:SS], with operating-day hours 00..27')
    return bits[0] * 3600 + bits[1] * 60 + (bits[2] if len(bits) == 3 else 0)


HEADWAY_BANDS = []  # Filled from OFFICIAL_HEADWAYS by the TypeScript entry.


def period(seconds, bands=None):
    bands = HEADWAY_BANDS if bands is None else bands
    if not bands:
        raise ValueError('Missing officialHeadways; regenerate catalog with the TypeScript entry')
    for band in bands:
        if band['from'] is not None and clock_seconds(band['from']) <= seconds < clock_seconds(band['to']):
            return band['name']
    return next(band['name'] for band in bands if band['from'] is None)


def confidence(*labels):
    if not labels or any(label is None or label == 'low' for label in labels):
        return 'low'
    return 'medium' if 'medium' in labels else 'high'


def stop_in_window(audio, window, source, station):
    # Retain the source STFT grid (4096/3584); avoid changing an event by
    # shifting a small cut's analysis origin. Memory stays bounded per stop.
    origin = max(0, math.floor((window[0] - 12) / .064) * .064)
    end = min(len(audio) / 8000, window[1] + 12)
    a = audio[round(origin * 8000):round(end * 8000)]
    if len(a) < 4096:
        return None
    f, t, p = signal.spectrogram(a, fs=8000, nperseg=4096, noverlap=3584, scaling='spectrum')
    t += origin
    keep = f <= 1200
    f, p = f[keep], p[keep]
    db = 10 * np.log10(np.maximum(p, 1e-12))
    prom = db - ndimage.median_filter(db, size=(21, 1))
    row = dict(station=station, recording=source['id'], direction=source['directions'][0], analysisWindowS=window)
    result = stops.measure(f, t, p, prom, np.zeros(len(t), dtype=bool), row, len(audio) / 8000)
    return None if result is None else dict(result, at=result['stop'])


def pitch_platforms(audio, start, stop):
    """Stable acoustic ridges, deliberately not converted into km/h.

    A switching carrier/harmonic can be stable at many actual speeds. No
    synchronized measured Hz/km/h pair exists in these recordings.
    """
    lo, hi = start + 12, stop - 15
    if hi - lo < 8:
        return dict(speedKmh=None, confidence='low', reason='insufficient cruise context', plateaus=[])
    a = audio[round(lo * 8000):round(hi * 8000)]
    f, t, p = signal.spectrogram(a, fs=8000, nperseg=4096, noverlap=2048, scaling='spectrum')
    db = 10 * np.log10(np.maximum(p, 1e-12))
    prom = db - ndimage.median_filter(db, size=(21, 1))
    band = (f >= 400) & (f <= 1800)
    windows = []
    for offset in np.arange(0, max(0, hi - lo - 7), 8):
        mask = (t >= offset) & (t < offset + 8)
        if mask.sum() < 20:
            continue
        median = np.median(prom[:, mask], axis=1)
        coverage = np.mean(prom[:, mask] >= 6, axis=1)
        level = np.median(db[:, mask], axis=1)
        # Local prominence alone also finds floating-point harmonics in an
        # otherwise pure tone. Require material power within this window.
        floor = float(np.max(level[band])) - 30
        peaks, _ = signal.find_peaks(median, distance=8)
        candidates = [i for i in peaks if band[i] and median[i] >= 8 and coverage[i] >= .7 and level[i] >= floor]
        for pick in sorted(candidates, key=lambda i: median[i], reverse=True)[:3]:
            windows.append(dict(fromS=round(float(lo + offset), 2), toS=round(float(lo + offset + 8), 2), hz=round(float(f[pick]), 1),
                                prominenceDb=round(float(median[pick]), 1), coverage=round(float(coverage[pick]), 2),
                                identity='unclassified narrow-band carrier/harmonic/auxiliary candidate'))
    return dict(speedKmh=None, confidence='low', reason='no synchronized speed/frequency calibration; stable carrier is not necessarily rotor frequency', plateaus=windows)


def announcement_hits(segments, stations):
    """Recognition is a station/window hint, never a stop timestamp."""
    hits = []
    for i, segment in enumerate(segments):
        nearby = []
        for following in segments[i:i + 4]:
            if following['start'] - segment['end'] > 6:
                break
            nearby.append(following)
        text = re.sub(r'[\s，。！？、,.!?·]', '', ''.join(s['text'] for s in nearby))
        kind, tail = None, ''
        if '下一站' in text:
            kind, tail = 'next', text.split('下一站', 1)[1][:18]
        elif '即将到达' in text:
            kind, tail = 'arrived', text.split('即将到达', 1)[1][:18]
        elif '到了' in text:
            kind, tail = 'arrived', text.split('到了', 1)[0][-18:]
        if kind:
            names = [name for name in stations if re.sub(r'[\s·]', '', name) in tail]
            if not names:
                # One-character transcription errors in names of >=4 chars
                # remain low-confidence hints; short names require exact text.
                names = [name for name in stations if len(name) >= 4 and any(SequenceMatcher(None, name, tail[j:j + len(name)]).ratio() >= .75 for j in range(max(0, len(tail) - len(name) + 1))) ]
            if names:
                name = max(names, key=len)
                at = segment['start']
                if not any(h['station'] == name and h['type'] == kind and abs(h['range'][0] - at) < 30 for h in hits):
                    hits.append(dict(station=name, type=kind, range=[at, nearby[-1]['end']], confidence='low', provenance='local speech station hint'))
    return hits


def recognize_announcements(audio, source, folder):
    private = folder / 'speech-private.json'
    paths = [Path(source['recognizer'])] if source.get('recognizer') else [p.parent for p in (ROOT / 'work/recordings/analysis/recognizer').glob('*/snapshots/*/model.bin')]
    paths = [p for p in paths if (p / 'model.bin').is_file()]
    if not paths:
        return [], 'no local recognizer; acoustic station-order candidates only'
    engine_path = min(paths, key=lambda p: (p / 'model.bin').stat().st_size)
    identity = dict(source=json.loads((folder / 'source.json').read_text('utf-8')), engine=str(engine_path),
                    engineBytes=(engine_path / 'model.bin').stat().st_size, order=source['stationOrder'], offset=source.get('offset', 0),
                    beam=3, chunkS=30, stepS=28, language='zh', prompt='下一站，站到了。' + '，'.join(source['stationOrder']))
    meta = folder / 'speech-meta.json'
    if private.exists() and meta.exists() and json.loads(meta.read_text('utf-8')) == identity:
        segments = json.loads(private.read_text('utf-8'))
        hits = announcement_hits(segments, source['stationOrder'])
        save(folder / 'announcement-hints.json', hits)
        return hits, 'cached local speech hints; acoustic evidence remains independent'
    from faster_whisper import WhisperModel
    engine = WhisperModel(str(engine_path), device='cpu', compute_type='int8', cpu_threads=8, local_files_only=True)
    segments = []
    offset = source.get('offset', 0)
    for at in np.arange(offset, len(audio) / 8000, 28):
        chunk = signal.resample_poly(audio[round(at * 8000):round((at + 30) * 8000)], 2, 1).astype('float32')
        result, _ = engine.transcribe(chunk, language='zh', beam_size=3, vad_filter=False, condition_on_previous_text=False,
                                     initial_prompt='下一站，站到了。' + '，'.join(source['stationOrder']))
        for s in result:
            segments.append(dict(start=round(float(at + s.start), 2), end=round(float(at + s.end), 2), text=s.text,
                                 logprob=s.avg_logprob, noSpeech=s.no_speech_prob))
        print(f"recognition {source['id']} {at:.0f}/{len(audio) / 8000:.0f}s", flush=True)
    save(folder / 'speech-private.json', segments)
    save(meta, identity)
    hits = announcement_hits(segments, source['stationOrder'])
    save(folder / 'announcement-hints.json', hits)
    return hits, 'local speech hints; acoustic stop/start confidence remains independent'


def events_from_announcements(audio, source, pa, duration):
    order = source['stationOrder']
    positions = {name: i for i, name in enumerate(order)}
    arrivals = sorted([p for p in pa if p['type'] == 'arrived' and p['station'] in positions], key=lambda p: p['range'][0])
    events = [dict(station=source['from'], stop=None, start=None, close=None, provenance='start of captured route; first arrival not captured')]
    last_position = 0
    for arrival in arrivals:
        position = positions[arrival['station']]
        if position <= last_position:
            continue
        # Preserve missed stations explicitly, never turn a two-station run
        # into an adjacent-station measurement after a missed announcement.
        for name in order[last_position + 1:position]:
            events.append(dict(station=name, stop=None, start=None, close=None, provenance='missing arrival identity/cue'))
        lo = arrival['range'][0] - 5
        stop = stop_in_window(audio, [lo, min(duration - 3, arrival['range'][0] + 60)], source, arrival['station'])
        if stop and source['mode'] == 'automatic':
            stop['identityConfidence'] = 'low'
            stop['confidence'] = 'low'
        events.append(dict(station=arrival['station'], stop=stop, start=None, close=None, provenance='PA locates search window; descending ridge locates stop'))
        last_position = position
    for i, event in enumerate(events[:-1]):
        choices = [p for p in pa if p['type'] == 'next' and p['station'] == events[i + 1]['station'] and (not event['stop'] or p['range'][0] > event['stop']['at'])]
        if not choices:
            continue
        next_pa = min(choices, key=lambda p: p['range'][0])
        lo, hi = max(source.get('offset', 0) + 2, next_pa['range'][0] - 14), next_pa['range'][0] - 3
        if event['stop'] is not None:
            lo = max(lo, event['stop']['at'] + 12)
        event['start'] = starts.refine_start(audio, [lo, hi])
        if event['start'] and source['mode'] == 'automatic':
            event['start']['confidence'] = 'low'
    return events


def automatic_events(audio, source, folder, duration):
    pa, recognition_status = recognize_announcements(audio, source, folder)
    order = source['stationOrder']
    positions = {name: i for i, name in enumerate(order)}
    offset = source.get('offset', 0)
    candidates = [tone for tone in tones.detect_tones(audio) if tone['start'] >= offset]
    events = [dict(station=order[0], stop=None, start=None, close=None, provenance='recording origin; a start is not inferred from a later next-station announcement')]
    last_position, previous_warning_end = 0, offset
    for tone in candidates:
        next_hints = [p for p in pa if p['type'] == 'next' and previous_warning_end <= p['range'][0] < tone['start'] and p['station'] in positions and positions[p['station']] >= last_position]
        if next_hints:
            position = positions[max(next_hints, key=lambda p: p['range'][0])['station']]
        elif len(events) == 1 and tone['start'] - offset < 45:
            position = 0
        else:
            position = min(len(order) - 1, last_position + 1)
        while len(events) <= position:
            events.append(dict(station=order[len(events)], stop=None, start=None, close=None, provenance='unverified station-order candidate'))
        event = events[position]
        lower = max(offset, previous_warning_end + (25 if previous_warning_end > offset else 0), tone['start'] - 110)
        stop = stop_in_window(audio, [lower, tone['start'] - 2], source, event['station']) if tone['start'] - lower > 12 else None
        start = starts.refine_start(audio, [tone['end'] + 1, min(duration - 4, tone['end'] + 14)])
        if stop:
            stop['confidence'] = 'low'
        if start:
            start['confidence'] = 'low'
        event.update(stop=stop, start=start, close=dict(at=tone['start'], confidence='low', method='closing-warning-candidate'),
                     provenance='next-station speech hint plus closing warning; identity and timing unverified')
        last_position, previous_warning_end = position, tone['end']
    # A tail arrival may have no following closing tone. Require an observed
    # next/arrival identity beyond the last warning before assigning its stop.
    tail = [p for p in pa if p['range'][0] > previous_warning_end and p['station'] in positions and positions[p['station']] > last_position]
    if tail:
        position = positions[max(tail, key=lambda p: p['range'][0])['station']]
        while len(events) <= position:
            events.append(dict(station=order[len(events)], stop=None, start=None, close=None, provenance='missing event; retained in station sequence'))
        last_start = events[last_position]['start']
        lower = max(offset, (last_start['at'] + 35) if last_start else previous_warning_end + 25, duration - 100)
        stop = stop_in_window(audio, [lower, duration - 2], source, events[position]['station'])
        if stop:
            stop['confidence'] = 'low'
        events[position].update(stop=stop, provenance='file-tail spectral arrival with speech station hint; unverified')
    source['automaticWarnings'] = dict(status='review-required', reason=recognition_status, toneCandidates=len(candidates),
                                       assignedStations=len(events), originStartCaptured=events[0]['start'] is not None,
                                       caution='warning groups may be missing or duplicated; all automatic measurements remain low confidence')
    return events


def infer_door_events(events, timing):
    """Door-derived proxies. Motor timestamps remain independent cross-checks."""
    opening_delay = statistics.mean(timing['openDelay'])
    starting_delay = statistics.mean(timing['startDelay'])
    open_half = (max(timing['openDelay']) - min(timing['openDelay'])) / 2
    start_half = (max(timing['startDelay']) - min(timing['startDelay'])) / 2
    for event in events:
        event['motor'] = {key: event.get(key) for key in ['stop', 'start']}
        opened, warning, locked = event.get('open'), event.get('close'), event.get('locked')
        event['stop'] = None if not opened else dict(at=round(opened['at'] - opening_delay, 3), confidence=opened['confidence'],
                                                     method='door-opening-minus-delay', uncertaintyS=open_half, acoustic=opened)
        departure = None
        if locked:
            departure = dict(at=round(locked['at'] + starting_delay, 3), confidence=locked['confidence'], method='door-lock-plus-start-delay', uncertaintyS=start_half, acoustic=locked)
        elif warning:
            departure = dict(at=round(warning['at'] + timing['closeS'] + starting_delay, 3), confidence=warning['confidence'], method='door-warning-plus-close-and-start-delay', uncertaintyS=start_half, acoustic=warning)
        event['doorStart'] = departure
        event['start'] = departure
        event['discrepancies'] = []
        for key in ['stop', 'start']:
            motor = event['motor'][key]
            derived = event[key]
            if motor and derived and abs(motor['at'] - derived['at']) > 10:
                event['discrepancies'].append(dict(event=key, motorS=motor['at'], doorS=derived['at'], motorMinusDoorS=round(motor['at'] - derived['at'], 3), reason='possible held departure or acoustic interference; not averaged'))
                if key == 'start':
                    event['start'] = {**motor, 'method': 'motor-start-retained-after-door-disagreement', 'uncertaintyS': None,
                                      'doorProxyS': derived['at'], 'possibleHold': motor['at'] > derived['at']}
        if event['stop'] and event['start'] and event['stop']['at'] >= event['start']['at']:
            event['stop'] = {**event['stop'], 'confidence': 'low', 'invalidOrder': True}
    return events


def measure_doors(audio, source, events, timing):
    candidates = tones.detect_tones(audio)
    duration = len(audio) / 8000
    for event in events:
        old_stop, old_start = event.get('stop'), event.get('start')
        reference = next((take for take in timing['referenceTakes'] if source['id'] == 'ride-east' and take['station'] == event['station']), None)
        if reference:
            event['open'] = dict(at=reference['open'][0], confidence=reference['confidence'], method='reviewed-door-motion')
            event['locked'] = dict(at=reference['lockedAt'], confidence=reference['confidence'], method='reviewed-door-lock-impact')
        if not event.get('close') and old_start:
            lower = old_stop['at'] + 5 if old_stop else source.get('offset', 0)
            possible = [tone for tone in candidates if lower <= tone['start'] <= old_start['at'] + 5]
            if possible:
                chosen = min(possible, key=lambda tone: abs(tone['start'] + timing['closeS'] + statistics.mean(timing['startDelay']) - old_start['at']))
                event['close'] = dict(at=chosen['start'], confidence='medium' if len(possible) == 1 and not chosen['leftCensored'] else 'low', method='closing-warning-candidate', alternatives=possible)
        if not event.get('open') and old_stop:
            low = max(source.get('offset', 0), old_stop['at'] - 10)
            high = min(duration - .8, old_stop['at'] + 35, event['close']['at'] - 4 if event.get('close') else duration)
            if high > low + 2:
                left = max(0, low - 2)
                clip = audio[round(left * 8000):round(min(duration, high + 2) * 8000)]
                data = motion.features(clip)
                opened = motion.opening_cue(data, [low - left, high - left])
                if opened:
                    event['open'] = {**opened, 'at': round(opened['at'] + left, 3), 'searchWindowS': [low, high]}
    return infer_door_events(events, timing)


def measure_source(source, out, timing):
    folder = out / source['id']
    folder.mkdir(exist_ok=True)
    path = Path(source['path'])
    info = dict(path=str(path), bytes=path.stat().st_size, mtimeNs=path.stat().st_mtime_ns)
    fingerprint = hashlib.sha256(json.dumps(source, sort_keys=True, ensure_ascii=False).encode())
    fingerprint.update(json.dumps(timing, sort_keys=True, ensure_ascii=False).encode())
    for file in [Path(__file__), *[Path(__file__).with_name(name + '.py') for name in
                                 ['refine-starts', 'measure-stops', 'measure-door-tones', 'measure-motion-cues']]]:
        fingerprint.update(file.read_bytes())
    fingerprint.update(json.dumps(info, sort_keys=True).encode())
    cache_path = folder / 'measurement-cache.json'
    if cache_path.exists():
        cached = json.loads(cache_path.read_text('utf-8'))
        if cached['fingerprint'] == fingerprint.hexdigest():
            return cached['result']
    pcm = folder / 'mono.f32'
    identity = folder / 'source.json'
    if not pcm.exists() or not identity.exists() or json.loads(identity.read_text('utf-8')) != info:
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(path), '-ac', '1', '-ar', '8000', '-f', 'f32le', str(pcm)], check=True)
        save(identity, info)
    audio = np.memmap(pcm, dtype='<f4', mode='r')
    duration = len(audio) / 8000
    if source.get('durationS') and abs(duration - source['durationS']) > .2:
        raise ValueError(f"{source['id']}: duration changed; reviewed events cannot be transferred to this file")
    if source['mode'] == 'adopted-events':
        events = []
        for row in source['events']:
            events.append(dict(station=row['station'], **{key: None if row[key] is None else {**row['evidence'].get(key, dict(confidence='low')), 'at': row[key]} for key in ['stop', 'start', 'close', 'open']}, provenance='reviewed src/data/ridelog.ts'))
    elif source['mode'] == 'pa-windows':
        events = events_from_announcements(audio, source, source['announcements'], duration)
    else:
        events = automatic_events(audio, source, folder, duration)
    # D122 independently reviewed narrow start windows are retained as input
    # evidence, not recreated from a desired run-time residual.
    if source['id'].startswith('ride-1021'):
        windows = {'ride-1021-west': {'浦东1号2号航站楼': [164, 174], '海天三路': [410, 420], '远东大道': [871, 881]},
                   'ride-1021-east': {'凌空路': [1078, 1088], '远东大道': [1328, 1339], '海天三路': [1689, 1697]}}
        for event in events:
            if event['station'] in windows[source['id']]:
                event['start'] = starts.refine_start(audio, windows[source['id']][event['station']])
    events = measure_doors(audio, source, events, timing)
    save(folder / 'events.json', events)
    intervals = []
    for a, b in zip(events, events[1:]):
        start = a['start']['at'] if a['start'] else None
        stop = b['stop']['at'] if b['stop'] else None
        run = stop - start if start is not None and stop is not None and stop >= start else None
        dwell = b['start']['at'] - stop if b['start'] and stop is not None and b['start']['at'] >= stop else None
        clock = clock_seconds(source['clockStart']) + (start or 0) if source.get('clockStart') else 22 * 3600 + (start or 0)
        acoustic = pitch_platforms(audio, start, stop) if run is not None else dict(speedKmh=None, confidence='low', reason='run boundaries incomplete', plateaus=[])
        intervals.append(dict(recording=source['id'], fromStation=a['station'], toStation=b['station'], direction=source['directions'][0],
                              **{'from': a['station'], 'to': b['station']}, start=start, stop=stop, dwell=dwell, run=run,
                              confidence=confidence(a['start'].get('confidence') if a['start'] else None, b['stop'].get('confidence') if b['stop'] else None),
                              runUncertaintyS=(a['start'].get('uncertaintyS', 0) or 0) + (b['stop'].get('uncertaintyS', 0) or 0) if a['start'] and b['stop'] and a['start'].get('uncertaintyS') is not None else None,
                              dwellUncertaintyS=(b['start'].get('uncertaintyS', 0) or 0) + (b['stop'].get('uncertaintyS', 0) or 0) if b['start'] and b['stop'] and b['start'].get('uncertaintyS') is not None else None,
                              dwellConfidence=confidence(b['start'].get('confidence') if b['start'] else None, b['stop'].get('confidence') if b['stop'] else None),
                              period=period(clock) if source.get('clockStart') else '钟点未知；22:00情景', modelClock=round(clock),
                              clockReliable=False, clockBasis='filename minute only' if source.get('clockStart') else '【假设】22:00 model scenario; original wall clock unknown', acoustic=acoustic))
    result = dict(source=source, duration=duration, events=events, intervals=intervals)
    save(cache_path, dict(fingerprint=fingerprint.hexdigest(), result=result))
    return result


def pis_comparisons(tables):
    path = ROOT / 'work/PIS_10.16/readings.json'
    predictions = []
    if path.exists():
        for row in json.loads(path.read_text('utf-8'))['rows']:
            file, when, station, direction, position, destination, _, countdown, label = row
            if label == '低' or not re.fullmatch(r'\d{2}:\d{2}', countdown) or '首末' in position or countdown == '00:00':
                continue
            match = re.search(r'20261016_(\d{2})(\d{2})(\d{2})', file)
            if not match:
                continue
            at = int(match[1]) * 3600 + int(match[2]) * 60 + int(match[3])
            sample = re.search(r'样本[≈～~]?\s*(\d+(?:\.\d+)?)\s*s', when)
            at += float(sample[1]) if sample else 0
            seconds = clock_seconds(countdown) / 60  # mm:ss is a duration here
            predictions.append(dict(station=station, direction='UP' if 'UP' in direction else 'DN', destination=destination,
                                    predicted=at + seconds, file=file, confidence=label, kind='arrival prediction'))
    # Airport photos explicitly describe departure predictions, kept separate.
    for seconds, destination in [(20 * 3600 + 33 * 60 + 4, '淞虹路'), (20 * 3600 + 37 * 60 + 25, '蟠祥路·国家会计学院')]:
        predictions.append(dict(station='浦东1号2号航站楼', direction='UP', destination=destination, predicted=seconds,
                                file='docs/field/field-2026-10-21-airport.md', confidence='高', kind='departure prediction'))
    # A screen repeated each second is one forecast train, not 100 samples.
    groups = []
    for row in sorted(predictions, key=lambda p: (p['station'], p['direction'], p['destination'], p['predicted'])):
        group = next((g for g in groups if all(g[0][key] == row[key] for key in ['station', 'direction', 'destination', 'kind']) and abs(statistics.median(r['predicted'] for r in g) - row['predicted']) <= 20), None)
        if group is None:
            groups.append([row])
        else:
            group.append(row)
    rows = []
    for group in groups:
        first = group[0]
        at = statistics.median(r['predicted'] for r in group)
        candidates = [t for t in tables.get((first['station'], first['direction']), []) if abs(t * 60 - at) <= 120]
        nearest = min(candidates, key=lambda t: (abs(t * 60 - at), t)) if candidates else None
        rows.append(dict(station=first['station'], direction=first['direction'], destination=first['destination'], kind=first['kind'],
                         predictionS=at, frames=len(group), files=sorted({r['file'] for r in group}), gaodeMinute=nearest,
                         candidateMinutes=candidates, deltaS=nearest * 60 - at if nearest is not None else None,
                         sameTrainVerified=False, period='晚间', reason='filename clock uncalibrated; PIS forecast is not actual event; nearest train identity unverified'))
    return dict(rawPredictions=len(predictions), deduplicatedPredictions=len(rows), rows=rows,
                rawCandidateStats=stats(r['deltaS'] for r in rows if r['deltaS'] is not None), verifiedStats=stats([]))


def gaode_analysis(catalog, out):
    tables, provenance = {}, []
    for path in sorted((ROOT / 'reference/timetable-gaode').glob('*-weekday.txt')):
        name, direction, _, values = scrape.read_table(path)
        numbers = list(map(scrape.minutes, values))
        if any(b <= a for a, b in zip(numbers, numbers[1:])):
            raise ValueError(f'{path.name}: duplicate/unordered times')
        tables[name, direction] = numbers
        errors, warnings = scrape.validate(name, direction, values)
        provenance.append(dict(file=path.name, sha256=hashlib.sha256(path.read_bytes()).hexdigest(), count=len(numbers), errors=errors, warnings=warnings))
        inputs = out / 'inputs'
        inputs.mkdir(exist_ok=True)
        (inputs / path.name).write_bytes(path.read_bytes())
    boundaries = []
    for official in catalog['official']:
        for key, direction in [('firstE', 'DN'), ('firstW', 'UP'), ('lastE', 'DN'), ('lastW', 'UP'), ('lastG', 'DN')]:
            value = official[key]
            if not value or (official['station'], direction) not in tables:
                continue
            target = clock_seconds(value) / 60
            times = tables[official['station'], direction]
            # First service and the last service in each table are boundary
            # candidates. The airport-bound last train can precede lastG.
            if key.startswith('first'):
                candidate = times[0]
                alternatives = [candidate]
                matching = 'first table record'
            elif key == 'lastW' or key == 'lastG' or not official['lastG']:
                candidate = times[-1]
                alternatives = [candidate]
                matching = 'last table record; terminal arrival/boarding scope may differ'
            else:
                alternatives = [t for t in times if abs(t - target) <= 2]
                candidate = min(alternatives, key=lambda t: (abs(t - target), t)) if alternatives else None
                matching = 'nearest within ±2 min; identity unproved and selection-biased'
            boundaries.append(dict(station=official['station'], direction=direction, kind=key, period='首班' if key.startswith('first') else '末班', official=value,
                                   gaode=candidate, deltaS=(candidate - target) * 60 if candidate is not None else None,
                                   alternatives=alternatives, matching=matching, sameTrainVerified=False))
    groups = {}
    usable = [b for b in boundaries if b['deltaS'] is not None]
    for dimension in ['direction', 'period', 'station', 'kind']:
        groups[dimension] = {v: stats(b['deltaS'] for b in usable if b[dimension] == v) for v in sorted({b[dimension] for b in usable})}
    edges = []
    for direction, order in catalog['travelOrder'].items():
        sampled = [s for s in order if (s, direction) in tables]
        for upstream, downstream in zip(sampled, sampled[1:]):
            a, b = tables[upstream, direction], tables[downstream, direction]
            anchor = official_lag_anchor(upstream, downstream, direction)
            try:
                estimate = estimate_lag(a, b, anchor)
                basis = 'clean five-minute phase candidate'
            except ValueError as error:
                estimate = exploratory_estimate(a, b, upstream, downstream, direction)
                estimate['cleanFailure'] = str(error)
                basis = 'exploratory phase candidate; no unique clean anchor'
            lag = estimate['minutes']
            matched = match_trains(a, b, lag)
            rows = [dict(up=t, down=u, seconds=(u - t) * 60, period=period(t * 60), ambiguous=len(matched.alternatives[u]) != 1) for t, u in sorted(matched.upstream_to_downstream.items())]
            windows = {}
            for label in ['早高峰', '白天平峰', '晚高峰', '晚间20:00–21:40', '夜间21:40后']:
                selected = [r for r in rows if r['period'] == label and not r['ambiguous']]
                windows[label] = dict(**stats(r['seconds'] for r in selected), ambiguous=sum(r['ambiguous'] for r in rows if r['period'] == label),
                                      phaseSensitivity={str(d): len(match_trains([t for t in a if period(t * 60) == label], b, d).upstream_to_downstream) for d in [max(1, lag - 1), lag, lag + 1]})
            edges.append(dict(upstream=upstream, downstream=downstream, direction=direction, estimate=estimate, basis=basis,
                              metric='arrival-to-arrival candidate, NOT departure-to-departure', correctionS=None,
                              sameTrainVerified=False, trustedAcceptancePair=(upstream, direction) in [('世纪公园', 'UP'), ('世纪公园', 'DN'), ('张江高科', 'UP'), ('张江高科', 'DN'), ('北新泾', 'UP')] and (downstream, direction) in [('世纪公园', 'UP'), ('世纪公园', 'DN'), ('张江高科', 'UP'), ('张江高科', 'DN'), ('北新泾', 'UP')],
                              pairs=rows, windows=windows, onlyUpstream=matched.only_upstream, onlyDownstream=matched.only_downstream))
    result = dict(sources=provenance, boundaries=boundaries, rawBoundaryStats=stats(b['deltaS'] for b in usable), groups=groups, edges=edges,
                  pis=pis_comparisons(tables),
                  correctionS=None, verifiedClockSamples=0, diagnosis='cannot identify truncation vs rounding: official minute values and filename/PIS clock scope do not provide synchronized second-level same-train ground truth')
    save(out / 'gaode.json', result)
    return result


def summarize(catalog, out, include_model=True):
    measurements = json.loads((out / 'measurements.json').read_text('utf-8'))
    gaode = gaode_analysis(catalog, out)
    model_path = out / 'model.json'
    models = json.loads(model_path.read_text('utf-8'))['rows'] if include_model and model_path.exists() else []
    stations = {s['name']: s['index'] for s in catalog['stations']}
    for interval in measurements['intervals']:
        interval['model'] = next((m for m in models if m['from'] == stations[interval['from']] and m['to'] == stations[interval['to']] and m['dir'] == interval['direction'] and m['clock'] == interval['modelClock']), None)
        edge = next((e for e in gaode['edges'] if e['upstream'] == interval['from'] and e['downstream'] == interval['to'] and e['direction'] == interval['direction']), None)
        interval['gaode'] = edge['windows'].get(interval['period']) if edge else None
        m = interval['model']
        interval['modelMinusField'] = m['run'] - interval['run'] if m and m['run'] is not None and interval['run'] is not None else None
    measurements['gaode'] = gaode
    measurements['modelProbes'] = models
    save(out / 'comparison.json', measurements)
    def fmt(v):
        return '—' if v is None else f'{v:.1f}'
    lines = ['# 录音逐区间对照（门声推算）', '', '停稳=开门开始−自动开门延迟均值；起动=锁闭/关门警示＋模型门序列及起步延迟均值。电机起动相差>10s时保留电机值并逐条标记。±值只含延迟区间半宽，不含声学检测误差；null表示不能给这个误差界。高德仅参考车数，不作时分验收。', '',
             '|录音|区间/方向|时段|起动/停稳 s|现场运行 s/置信度|下一站停站 s/置信度|高德到→到 s/n/SE|图定运行 s|实跑 s|巡航/峰值 km/h|实跑−现场 s|',
             '|---|---|---|---|---|---|---|---|---|---|---|']
    for r in measurements['intervals']:
        m, g = r['model'], r['gaode']
        lines.append(f"|{r['recording']}|{r['from']}→{r['to']} {r['direction']}|{r['period']}|{fmt(r['start'])}/{fmt(r['stop'])}|{fmt(r['run'])}/{r['confidence']}|{fmt(r['dwell'])}/{r['dwellConfidence']}|{fmt(g['mean'])+'/'+str(g['n'])+'/'+fmt(g['se']) if g else '—'}|{fmt(m['plannedRun']) if m else '—'}|{fmt(m['run']) if m else '—'}|{fmt(m.get('cruiseMedianKmh'))+'/'+fmt(m['peakKmh']) if m else '—'}|{fmt(r['modelMinusField'])}|")
    (out / 'comparison.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f"comparison: {len(measurements['intervals'])} intervals, {len(models)} probes; {out / 'comparison.md'}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--measure', action='store_true')
    parser.add_argument('--summarize', action='store_true')
    parser.add_argument('--no-model', action='store_true')
    args = parser.parse_args()
    out = args.out.resolve()
    if out == ROOT / 'work' or not out.is_relative_to(ROOT / 'work'):
        parser.error('All derivatives must stay under ignored work/')
    catalog = json.loads((out / 'catalog.json').read_text('utf-8'))
    global HEADWAY_BANDS
    HEADWAY_BANDS = catalog['officialHeadways']['weekday']
    if args.measure:
        measured = []
        for source in catalog['sources']:
            order = catalog['travelOrder'][source['directions'][0]]
            source['stationOrder'] = order[order.index(source['from']):]
            result = measure_source(source, out, catalog['doorTiming'])
            measured.append(result)
            print(f"audio {source['id']}: {len(result['events'])} events, {len(result['intervals'])} intervals", flush=True)
        save(out / 'measurements.json', dict(sources=measured, intervals=[r for s in measured for r in s['intervals']]))
    if args.summarize:
        summarize(catalog, out, include_model=not args.no_model)


if __name__ == '__main__':
    main()
