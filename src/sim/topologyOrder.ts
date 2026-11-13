/** Data-independent topology primitive, also exported by topology.ts.
 * Line catalogue construction must not import the selected-world facade. */

/** Station running order. Without a registered order the line is one run of stations in array
 * order (DN = rising index). A line with a branch registers, per station, the next station in
 * the DN direction (-1 at the DN terminus): every station then has one way DN and the branches
 * fan out UP, so "ahead" is a question about that tree, never about station indices. */
let dnNext: readonly number[] | null = null;
/** reach[from * n + to] = 1 when `to` lies DN of `from` */
let reach: Uint8Array | null = null;

export function setStationOrder(next: readonly number[] | null): void {
  dnNext = next; reach = null;
  if (!next) return;
  const n = next.length;
  reach = new Uint8Array(n * n);
  for (let from = 0; from < n; from++) {
    let steps = 0;
    for (let station = next[from]; station >= 0; station = next[station]) {
      if (++steps > n) throw new Error('station order has a loop');
      reach[from * n + station] = 1;
    }
  }
}

/** Is `to` ahead of `from` when running `direction`? Callers do not compare station indices. */
export function ahead(direction: 'DN' | 'UP', from: number, to: number): boolean {
  if (!dnNext) return direction === 'DN' ? to > from : to < from;
  const n = dnNext.length;
  return (direction === 'DN' ? reach![from * n + to] : reach![to * n + from]) === 1;
}

/** The stations from `from` to `to` inclusive along the line, whichever way that runs
 * (DN to where the two meet, then UP); a single station when they are the same. */
export function stationPath(from: number, to: number): number[] {
  if (!dnNext) {
    const path: number[] = [];
    for (let station = from; station !== to; station += to > from ? 1 : -1) path.push(station);
    return [...path, to];
  }
  const down = (station: number) => { const path = [station]; while (dnNext![path.at(-1)!] >= 0) path.push(dnNext![path.at(-1)!]); return path; };
  const a = down(from), b = down(to);
  const meet = a.findIndex(station => b.includes(station));
  if (meet < 0) return [];
  return [...a.slice(0, meet + 1), ...b.slice(0, b.indexOf(a[meet])).reverse()];
}

/** Is `station` one of `a`, `b` or between them (either order) along the line? */
export function between(station: number, a: number, b: number): boolean {
  if (dnNext) return stationPath(a, b).includes(station);
  return station === a || station === b
    || ahead('DN', a, station) && ahead('DN', station, b) || ahead('UP', a, station) && ahead('UP', station, b);
}

/** Direction from a station chainage to a target; preserve the caller's
 * direction when both lie at the same point. */
export function directionToward(fromChain: number, targetChain: number, same: 'DN' | 'UP'): 'DN' | 'UP' {
  return targetChain > fromChain ? 'DN' : targetChain < fromChain ? 'UP' : same;
}
