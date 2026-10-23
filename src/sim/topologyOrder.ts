/** Data-independent topology primitive, also exported by topology.ts.
 * Line catalogue construction must not import the selected-world facade. */
/** Forward order on the current linear topology; callers do not compare station indices. */
export function ahead(direction: 'DN' | 'UP', from: number, to: number): boolean {
  return direction === 'DN' ? to > from : to < from;
}
