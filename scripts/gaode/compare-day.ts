import type { DayType } from '../../src/sim/model';

export function comparisonDay(args: readonly string[]): DayType {
  const i = args.indexOf('--day');
  const value = i < 0 ? 'weekday' : args[i + 1];
  if (value !== 'weekday' && value !== 'weekend') throw new Error('--day 须为 weekday 或 weekend');
  return value;
}

export function comparisonTablePath(directory: string, station: string, dir: string, day: DayType): string {
  return `${directory}/${station}-${dir}-${day}.txt`;
}
