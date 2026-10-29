/** Export the selected line's existing data to the Python UI collector. */
import { FIRST_LAST, LINE_INFO, SIMULATION } from '../../src/data/current';

console.log(JSON.stringify({ name: LINE_INFO.shortName, firstLast: FIRST_LAST,
  directory: SIMULATION.timetable.diagnostics?.gaode?.directory }));
