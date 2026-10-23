/**
 * SHA-256 of the generated plan (trips and blocks) for both day types of the
 * selected line group. Structure-only changes must leave every hash unchanged.
 *   npx tsx scripts/plan-hash.ts              (Line 2)
 *   ATS_LINE=test npx tsx scripts/plan-hash.ts
 */
import { createHash } from 'node:crypto';
import { Sim } from '../src/sim/engine';
import { GROUP_ID } from '../src/data/current';

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
for (const dayType of ['weekday', 'weekend'] as const) {
  const sim = new Sim({ dayType, dateLabel: 'hash', startTime: 14400, seed: 3 });
  const { trips, blocks } = sim.plan;
  console.log(`line ${GROUP_ID} ${dayType} trips ${trips.length} ${sha(trips)} blocks ${blocks.length} ${sha(blocks)}`);
}
