// Mechanism fixture (D178). Line 2 no longer stores trains on the main line
// overnight and keeps hot spares only at the two ends, but the mid-line
// storage, local-shunt and mid-line hot-standby mechanisms stay for any line
// whose data uses them. Tests of those mechanisms import this module FIRST:
// it restores the pre-D178 Line 2 entries before any simulator module reads
// the data, and keeps those tests off the shared warm-up checkpoints.
import { OPERATIONS } from '../../src/data/current';

type Stabling = (typeof OPERATIONS.overnightStabling)[number];
type Standby = (typeof OPERATIONS.hotStandby)[number];
(OPERATIONS.overnightStabling as Stabling[]).push(
  { station: 'PXL', count: 2, departure: 'DN', kind: 'terminal' },
  { station: 'PDA', count: 1, departure: 'UP', kind: 'terminal' },
  { station: 'KJG', count: 2, departure: 'UP', kind: 'origin', origin: 'LYL', nightAfter: 21 * 3600 + 40 * 60 },
  { station: 'CXZ', count: 1, departure: 'DN', kind: 'feeder', nightAfter: 22 * 3600 + 30 * 60 },
);
(OPERATIONS.hotStandby as Standby[]).push(
  { station: 'KJG', track: 'turnback', berth: 1, depot: 'BZL', incoming: 'DN' },
  { station: 'CXZ', track: 'storage', berth: 0, depot: 'CSD', incoming: 'DN', emptyCalloutToFirstPlatform: true },
);
(globalThis as { __atssimDataFixture?: boolean }).__atssimDataFixture = true;
