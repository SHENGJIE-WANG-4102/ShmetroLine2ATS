/** Data-independent topology primitive, also exported by topology.ts.
 * Line catalogue construction must not import the selected-world facade. */
/** Forward order on the current linear topology; callers do not compare station indices. */
export function ahead(direction: 'DN' | 'UP', from: number, to: number): boolean {
  return direction === 'DN' ? to > from : to < from;
}

/** Is `station` one of `a`, `b` or between them (either order) on the current linear topology? */
export function between(station: number, a: number, b: number): boolean {
  return station === a || station === b
    || ahead('DN', a, station) && ahead('DN', station, b) || ahead('UP', a, station) && ahead('UP', station, b);
}

/** Direction from a station chainage to a target; preserve the caller's
 * direction when both lie at the same point. */
export function directionToward(fromChain: number, targetChain: number, same: 'DN' | 'UP'): 'DN' | 'UP' {
  return targetChain > fromChain ? 'DN' : targetChain < fromChain ? 'UP' : same;
}
