// Warm-up worker for tests/globalSetup.ts: runs one simulator from the start
// of the day to `until` and writes its checkpoint. Usage: warmup.ts <key> <file>
import { writeFileSync, renameSync } from 'node:fs';
import { serialize } from 'node:v8';
import { Sim } from '../src/sim/engine';
import type { DayType } from '../src/sim/model';
import { capture } from '../src/sim/state';
import { assertIntegrity } from './helpers';

const [key, file] = process.argv.slice(2);
const [dayType, until, seed, ...flags] = key.split('-');
const sim = new Sim({ dayType: dayType as DayType, dateLabel: 'test', startTime: Number(until), seed: Number(seed), noPossessions: flags.includes('noPossessions') });
assertIntegrity(sim);
while (sim.t < Number(until)) { sim.step(); assertIntegrity(sim); }
writeFileSync(`${file}.tmp`, serialize(capture(sim)));
renameSync(`${file}.tmp`, file);
