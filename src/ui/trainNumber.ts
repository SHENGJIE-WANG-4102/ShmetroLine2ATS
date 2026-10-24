import { LINE } from '../data/current';

/** A duty-based display never changes the trip identity used by the timetable. */
export function formatTrainNumber(duty: string | number, trip: string, withDuty = false): string {
  const rule = LINE.ui.tripNumber;
  return rule ? rule.prefix + String(duty).padStart(rule.digits, '0') : withDuty ? `${duty}-${trip}` : trip;
}
