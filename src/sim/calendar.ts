/** Operating-day calendar helpers shared by the UI and the worker. */
import type { DayType } from './model';
import { SIMULATION } from '../data/current';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/** the National Day week (10-01…10-07) runs the holiday timetable whatever the weekday */
export const nationalDay = (d: Date) => d.getMonth() === 9 && d.getDate() <= 7;

export function dayTypeOf(d: Date, holiday: boolean): DayType {
  const wd = d.getDay();
  return holiday || (holidayOf(isoDate(d))?.day ?? 0) >= 1 || wd === 0 || wd === 6 ? 'weekend' : 'weekday';
}

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dateLabel(d: Date, holiday: boolean): string {
  const s = `${isoDate(d)} 星期${WEEK[d.getDay()]}`;
  if (nationalDay(d)) return `${s}（国庆第${d.getDate()}天）`;
  return holiday ? `${s}（节假日）` : s;
}

export function parseIso(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** "HH:MM" (00–27 h) in seconds of the operating day, NaN if it is not a time */
export function parseTime(v: string): number {
  const m = /^\s*(\d{1,2})(?::(\d{1,2}))?\s*$/.exec(v);
  if (!m) return NaN;
  const hh = Number(m[1]), mm = Number(m[2] ?? 0);
  if (hh > 27 || mm > 59) return NaN;
  // before 04:00 belongs to the night after the operating day
  const t = hh * 3600 + mm * 60;
  return t < 4 * 3600 ? t + 86400 : t;
}

export interface HolidayDay {
  /** e.g. 国庆 */
  name: string;
  /** day of the holiday (1-based; 0 = the eve, an ordinary working day) and its length */
  day: number;
  days: number;
}

/** the holiday programme of an ISO date, null on an ordinary day */
export function holidayOf(date: string | undefined): HolidayDay | null {
  if (!date) return null;
  const calendar = SIMULATION.holiday.calendar;
  if (calendar) {
    const period = calendar.find(p => date >= p.from && date <= p.to);
    if (!period) return null;
    const elapsed = Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(period.from + 'T00:00:00Z')) / 86400000);
    return { name: period.name, day: period.dayOffset + elapsed, days: period.days };
  }
  const d = parseIso(date);
  if (d.getMonth() === 9 && d.getDate() <= 7) return { name: '国庆', day: d.getDate(), days: 7 };
  if (d.getMonth() === 8 && d.getDate() === 30) return { name: '国庆', day: 0, days: 7 };
  return null;
}

