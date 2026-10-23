/**
 * Screen layout on a logical canvas.
 *
 * The UI is designed on a 3840×2160 canvas. At UI scale 100 % the logical
 * canvas equals the design canvas whatever the window size (uniform
 * scaling); a larger UI scale makes everything bigger by shrinking the
 * logical canvas, and the regions re-flow (the schematic then pans).
 */
import { DESIGN_W, DESIGN_H } from './theme';
import { LINE } from '../data/current';

export interface Rect { x: number; y: number; w: number; h: number }

export type GraphMode = 'strip' | 'hidden' | 'max';

export interface Regions {
  W: number;
  H: number;
  /** CSS px per logical px */
  k: number;
  header: Rect;
  side: Rect;
  main: Rect;
  toolbar: Rect;
  view: Rect;
  graph: Rect;
}

export const UI_SCALES = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

const LS = (k: string) => `${LINE.ui.preferencePrefix}.${k}`;

export function loadPref<T>(key: string, def: T): T {
  try {
    const v = localStorage.getItem(LS(key));
    return v === null ? def : (JSON.parse(v) as T);
  } catch {
    return def;
  }
}

export function savePref(key: string, v: unknown) {
  try {
    localStorage.setItem(LS(key), JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

export const HEADER_H = 112;
export const TOOLBAR_H = 76;

/** headerH: header height for a given logical width (the header wraps on narrow canvases) */
export function computeRegions(
  winW: number, winH: number, uiScale: number, graphMode: GraphMode,
  headerH: (W: number) => number = () => HEADER_H, toolbarH: (w: number) => number = () => TOOLBAR_H,
): Regions {
  const fit = Math.min(winW / DESIGN_W, winH / DESIGN_H);
  const k = fit * uiScale;
  const W = winW / k;
  const H = winH / k;
  const hh = Math.max(80, Math.round(headerH(W)));
  const header = { x: 0, y: 0, w: W, h: hh };
  const sideW = Math.round(Math.max(820, Math.min(1040, W * 0.25)));
  const side = { x: W - sideW, y: hh, w: sideW, h: H - hh };
  const main = { x: 0, y: hh, w: W - sideW, h: H - hh };
  const th = Math.max(TOOLBAR_H, Math.round(toolbarH(main.w)));
  const toolbar = { x: 0, y: hh, w: main.w, h: th };
  const below = main.h - th;
  let gh = 0;
  if (graphMode === 'strip') gh = Math.round(Math.min(H * 0.2, 460, below * 0.36));
  else if (graphMode === 'hidden') gh = 64;
  else gh = below;
  const view = { x: 0, y: hh + th, w: main.w, h: graphMode === 'max' ? 0 : below - gh - 8 };
  const graph = { x: 0, y: H - gh, w: main.w, h: gh };
  return { W, H, k, header, side, main, toolbar, view, graph };
}
