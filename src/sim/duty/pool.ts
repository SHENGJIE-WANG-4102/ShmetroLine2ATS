/**
 * 终点车底池（D178）: the one allocation rule of the rolling-stock duty, shared
 * by the day plan (planner.ts) and the live dispatcher (live.ts).
 *
 * A car is in a station's pool from the moment it can take a departure there
 * (`ready`). A departure takes a car from the pool of its origin. The plan
 * takes the most recently ready car, which keeps layovers and occupied tracks
 * short; the live dispatcher keeps the planned car while it is in time and
 * otherwise takes the first ready car (先到先发). Physical admission (turnback
 * tracks, terminal capacity, safe waiting) is the caller's: `admit` may
 * reserve the place it checked, and is called only for the car finally taken.
 */
export interface PoolCar { id: number; ready: number }
export interface PoolDemand { id: number; at: number }

export interface PoolRule<C extends PoolCar, D extends PoolDemand> {
  /** longest a car may stand for this departure (s) */
  maxWait(car: C, demand: D): number;
  /** physical feasibility of `car` taking `demand`; may reserve on success */
  admit(car: C, demand: D): boolean;
  /** 'latest': plan (shortest stand); 'earliest': live first come, first served */
  order: 'latest' | 'earliest';
  /** a car already bound to this departure, kept when admissible (live: planned car) */
  bound?(demand: D): C | undefined;
  /** lateness a car may still have for the departure (s, live only) */
  late?: number;
}

/** The car `demand` takes from `cars`, or undefined. The car is removed. */
export function takeCar<C extends PoolCar, D extends PoolDemand>(cars: C[], demand: D, rule: PoolRule<C, D>): C | undefined {
  const late = rule.late ?? 0;
  const usable = (car: C) => car.ready <= demand.at + late && demand.at - car.ready <= rule.maxWait(car, demand);
  const bound = rule.bound?.(demand);
  if (bound && cars.includes(bound) && usable(bound) && rule.admit(bound, demand)) {
    cars.splice(cars.indexOf(bound), 1);
    return bound;
  }
  const ordered = cars.filter(usable).sort((a, b) => rule.order === 'latest' ? b.ready - a.ready : a.ready - b.ready);
  for (const car of ordered) {
    if (car === bound || !rule.admit(car, demand)) continue;
    cars.splice(cars.indexOf(car), 1);
    return car;
  }
  return undefined;
}

/** Match a whole timeline: cars arrive (enter at `ready`), demands draw in
 * time order. Cars past every remaining wait limit leave as spare. */
export function matchPool<C extends PoolCar, D extends PoolDemand>(cars: readonly C[], demands: readonly D[], rule: PoolRule<C, D>) {
  const pairs = new Map<number, C>();
  const unmet: D[] = [];
  const present: C[] = [];
  const incoming = cars.slice().sort((a, b) => a.ready - b.ready);
  let next = 0;
  for (const demand of demands.slice().sort((a, b) => a.at - b.at)) {
    while (next < incoming.length && incoming[next].ready <= demand.at + (rule.late ?? 0)) present.push(incoming[next++]);
    const car = takeCar(present, demand, rule);
    if (car) pairs.set(demand.id, car); else unmet.push(demand);
  }
  const spare = [...present, ...incoming.slice(next)];
  return { pairs, unmet, spare };
}
