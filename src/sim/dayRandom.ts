/** Independent streams: drawing a daily setting never consumes Sim.rng(). */
export function dayRandom(seed: number, stream: number) {
  let state = (seed ^ stream) >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
export const OPERATING_DAY = { from: 4 * 3600, to: 27.75 * 3600 };
