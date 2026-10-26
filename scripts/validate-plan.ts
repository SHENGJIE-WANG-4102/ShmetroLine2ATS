/** print plan validation issues: npx vite-node scripts/validate-plan.ts [dayType] */
import { Sim } from '../src/sim/engine';
import { validatePlan, terminalReuseRejections } from '../src/sim/timetable';
const sim = new Sim({ dayType: (process.argv[2] ?? 'weekday') as 'weekday', dateLabel: 'probe', startTime: 4 * 3600, seed: 3 });
const fmt = (s: number) => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`;
const issues = validatePlan(sim.planCtx, sim.plan, true, false, { checkWaiting: true });
for (const i of issues) console.log(i.severity, i.code, fmt(i.t), i.text);
for (const text of terminalReuseRejections(sim.plan)) console.log('info', 'TURN_REJECTED', text);
console.log('trips', sim.plan.trips.length, 'fleet', sim.plan.fleetPeak, 'issues', issues.length);
