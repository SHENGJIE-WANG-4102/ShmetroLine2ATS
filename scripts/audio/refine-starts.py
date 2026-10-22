#!/usr/bin/env python3
"""Rising traction-ridge start proxy; no vehicle-speed calibration.

Extracted from the reviewed D122 experiment. Input is an 8 kHz mono array;
the caller supplies an independently located window. 【假设】500→900 Hz,
75..200 Hz/s and score/coverage thresholds apply only to compatible stock.
"""
import numpy as np
from scipy import signal, ndimage


def refine_start(audio, window, offset=0):
    lo, hi = window
    left, right = max(offset, lo - 4), min(offset + len(audio) / 8000, hi + 5)
    clip = audio[int(round((left - offset) * 8000)):int(round((right - offset) * 8000))]
    if len(clip) < 2048 or hi <= lo:
        return None
    f, t, p = signal.spectrogram(clip, fs=8000, nperseg=2048, noverlap=1920, scaling='spectrum')
    t += left
    db = 10 * np.log10(np.maximum(p, 1e-12))
    prom = db - ndimage.median_filter(db, size=(21, 1))
    dt, df = t[1] - t[0], f[1] - f[0]
    rows = []
    lag = np.arange(.15, 3.01, .05)
    for at in np.arange(max(lo, left + 2), min(hi, right - 3), .05):
        ti = np.clip(np.rint((at + lag - t[0]) / dt).astype(int), 0, len(t) - 1)
        for slope in range(75, 201, 5):
            fi = np.rint(np.minimum(900, 500 + slope * lag) / df).astype(int)
            ridge = np.max(np.array([prom[fi + d, ti] for d in [-1, 0, 1]]), axis=0)
            before = np.max(np.array([prom[fi + d, np.clip(ti - int(2 / dt), 0, len(t) - 1)] for d in [-1, 0, 1]]), axis=0)
            score = float(np.quantile(ridge, .3) + .4 * np.median(ridge) - .25 * np.median(np.maximum(before, 0)))
            rows.append(dict(at=round(float(at), 2), slope=slope, score=round(score, 3), contrast=round(float(np.median(ridge)), 2), coverage=round(float(np.mean(ridge > 5)), 3)))
    if not rows:
        return None
    best = max(rows, key=lambda row: row['score'])
    near = [r['at'] for r in rows if r['score'] >= best['score'] - 1]
    span = [min(near), max(near)]
    return dict(**best, nearBestRange=span, confidence='medium' if best['score'] > 6 and best['coverage'] > .6 and span[1] - span[0] <= 4 else 'low',
                method='ascending-500-to-900Hz-traction-ridge', window=list(window))
