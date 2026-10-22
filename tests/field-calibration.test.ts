import { describe, expect, it } from 'vitest';
import { createProbeWorld, probeSection } from '../scripts/audio/field-model';
import { capture, restore } from '../src/sim/state';
import { STATIONS } from '../src/data/line2';

describe('field section measurement harness', () => {
  it('uses real departure, arrival and door clocks with ATO regulation enabled', () => {
    const sim = createProbeWorld();
    const from = STATIONS.findIndex(s => s.id === 'YDD'), to = STATIONS.findIndex(s => s.id === 'HTS');
    const row = probeSection(sim, from, to, 'DN', 20 * 3600 + 30 * 60);
    expect(row.completed).toBe(true);
    expect(row.violations).toEqual([]);
    expect(row.regulated).toBe(true);
    expect(row.samples).toBeGreaterThan(100);
    expect(row.departure!).toBeLessThan(row.arrival!);
    expect(row.opening!).toBeGreaterThan(row.arrival!);
    expect(row.locked!).toBeGreaterThan(row.opening!);
    expect(row.nextDeparture!).toBeGreaterThanOrEqual(row.locked!);
    expect(row.run).toBeCloseTo(row.arrival! - row.departure!, 6);
    expect(row.departureToDeparture).toBeCloseTo(row.run! + row.dwell!, 6);
    expect(row.peakKmh!).toBeGreaterThan(row.targetMedianKmh! - 5);
    // The probe must use the same 1400m scan as production. A full-distance
    // scan would invent an ATS cruise target the train never actually used.
    expect(row.stopDistanceUnavailableFraction!).toBeGreaterThan(.5);
    expect(row.cruiseMedianKmh!).toBeCloseTo(row.targetMedianKmh!, 0);
    expect(row.levels).toEqual([1]);
  });

  it('restoring the baseline prevents earlier probes from changing a measurement', () => {
    const sim = createProbeWorld(), baseline = capture(sim);
    // Name lookup keeps this regression independent of station numbering.
    const a = STATIONS.findIndex(s => s.name === '江苏路');
    const b = STATIONS.findIndex(s => s.name === '静安寺');
    const first = probeSection(sim, a, b, 'DN', 22 * 3600);
    restore(sim, baseline);
    probeSection(sim, b, a, 'UP', 12 * 3600);
    restore(sim, baseline);
    expect(probeSection(sim, a, b, 'DN', 22 * 3600)).toEqual(first);
  });
});
