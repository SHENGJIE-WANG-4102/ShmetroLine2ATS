/**
 * Game-controller input: pure mapping from a pad sample to driver actions,
 * plus the binding table the user can rebind by pressing the control
 * (see gamepadPanel.ts). No DOM, no storage here, so it can be tested with
 * fake samples.
 *
 * A binding is a chord of inputs (all held = active); an action has a list of
 * alternative bindings (any one active = active). An input is a button index,
 * or an axis index with a direction (stick pushed / trigger pulled past the
 * threshold). Bindings are kept per pad id: the same hardware reports different
 * indices in different modes (XInput / DInput / Switch).
 */

export type PadAction =
  | 'notchUp' | 'notchDown' | 'neutral' | 'emergency'
  | 'doorL' | 'doorR'
  | 'reverseBack' | 'reverseNeutral' | 'reverseFwd'
  | 'atoF' | 'atoG'
  | 'pause' | 'cancel';

export type PadInput = { kind: 'button'; index: number } | { kind: 'axis'; index: number; dir: 1 | -1 };
export type PadBinding = PadInput[];
export type PadBindings = Record<PadAction, PadBinding[]>;

/** what the settings page lists, in order */
export const PAD_ACTIONS: { id: PadAction; label: string }[] = [
  { id: 'notchUp', label: '手柄推向牵引（加一级）' },
  { id: 'notchDown', label: '手柄拉向制动（减一级）' },
  { id: 'neutral', label: '手柄回零位' },
  { id: 'emergency', label: '紧急制动' },
  { id: 'doorL', label: '左侧车门开/关' },
  { id: 'doorR', label: '右侧车门开/关' },
  { id: 'reverseBack', label: '方向手柄 向后' },
  { id: 'reverseNeutral', label: '方向手柄 中立' },
  { id: 'reverseFwd', label: '方向手柄 向前' },
  { id: 'atoF', label: 'ATO 按钮 F（按住）' },
  { id: 'atoG', label: 'ATO 按钮 G（按住）' },
  { id: 'pause', label: '暂停 / 继续' },
  { id: 'cancel', label: '取消 / 返回（Esc）' },
];

const btn = (index: number): PadInput => ({ kind: 'button', index });
const axis = (index: number, dir: 1 | -1): PadInput => ({ kind: 'axis', index, dir });

/** the W3C "standard" layout (Xbox pads in XInput mode): A0 B1 X2 Y3 LB4 RB5 LT6 RT7 Back8 Start9 L3 10 R3 11 dpad 12-15 */
export const STANDARD_DEFAULTS: PadBindings = {
  notchUp: [[axis(1, -1)], [btn(12)]],
  notchDown: [[axis(1, 1)], [btn(13)]],
  neutral: [[btn(1)]],
  emergency: [[btn(6), btn(7)]],
  doorL: [[btn(4)]],
  doorR: [[btn(5)]],
  reverseBack: [[btn(14)]],
  reverseNeutral: [[btn(10)]],
  reverseFwd: [[btn(15)]],
  atoF: [[btn(2)]],
  atoG: [[btn(3)]],
  pause: [[btn(9)]],
  cancel: [[btn(8)]],
};

export function emptyBindings(): PadBindings {
  return Object.fromEntries(PAD_ACTIONS.map(a => [a.id, []])) as unknown as PadBindings;
}

/** one frame of a pad, already copied out of the browser object */
export interface PadSample {
  id: string;
  /** browser reports the W3C standard layout */
  standard: boolean;
  buttons: number[];
  axes: number[];
}

export const AXIS_ON = 0.5;
const BUTTON_ON = 0.5;

export function sampleOf(pad: { id: string; mapping: string; buttons: readonly { pressed: boolean; value: number }[]; axes: readonly number[] }): PadSample {
  return {
    id: pad.id,
    standard: pad.mapping === 'standard',
    buttons: pad.buttons.map(b => (b.pressed ? Math.max(1, b.value) : b.value)),
    axes: [...pad.axes],
  };
}

export function inputActive(input: PadInput, s: PadSample): boolean {
  if (input.kind === 'button') return (s.buttons[input.index] ?? 0) > BUTTON_ON;
  const v = s.axes[input.index] ?? 0;
  return input.dir > 0 ? v > AXIS_ON : v < -AXIS_ON;
}

export function bindingActive(binding: PadBinding, s: PadSample): boolean {
  return binding.length > 0 && binding.every(i => inputActive(i, s));
}

/** bindings in force for this pad: the user's, else the standard layout (only for pads that report it), else none */
export function bindingsFor(saved: PadBindings | undefined, s: PadSample): PadBindings {
  if (saved) return { ...emptyBindings(), ...saved };
  return s.standard ? STANDARD_DEFAULTS : emptyBindings();
}

export interface PadEvent { action: PadAction; phase: 'down' | 'up'; repeat: boolean }

/** actions that keep stepping while held (the master controller moves one notch per step) */
const REPEATING: ReadonlySet<PadAction> = new Set<PadAction>(['notchUp', 'notchDown']);
export const REPEAT_FIRST_MS = 400;
export const REPEAT_EVERY_MS = 160;

export function sameInput(a: PadInput, b: PadInput): boolean {
  return a.kind === b.kind && a.index === b.index && (a.kind === 'button' || (b.kind === 'axis' && a.dir === b.dir));
}

/** same set of inputs, any order */
export function sameBinding(a: PadBinding, b: PadBinding): boolean {
  return a.length === b.length && a.every(i => b.some(j => sameInput(i, j)));
}

const within = (small: PadBinding, big: PadBinding) => small.every(i => big.some(j => sameInput(i, j)));

/**
 * Edge detector: feed a sample every frame, get the events since the last one.
 * Time is passed in so the repeat rate is testable.
 *
 * Combinations work like a shift key. A combo fires when it completes and
 * silences the actions bound to the same inputs alone (and a smaller combo
 * inside a bigger one). A lone button that is also a member of some combo
 * cannot fire when pressed, because the combo may follow: it fires on release,
 * and only if no combo used it while it was held.
 */
export class PadMapper {
  private held = new Map<PadAction, { next: number }>();
  /** lone presses waiting for release: cancelled once a combo took the button */
  private pending = new Map<PadAction, { cancelled: boolean }>();

  step(s: PadSample, bindings: PadBindings, now: number): PadEvent[] {
    const out: PadEvent[] = [];
    const combos: PadBinding[] = [];
    const shift: PadInput[] = [];
    for (const { id } of PAD_ACTIONS) for (const b of bindings[id]) if (b.length > 1) {
      shift.push(...b);
      if (bindingActive(b, s)) combos.push(b);
    }
    const silenced = (b: PadBinding) => b.length === 1
      ? combos.some(c => c.some(i => sameInput(i, b[0])))
      : combos.some(c => c.length > b.length && within(b, c));
    const deferred = (b: PadBinding) => b.length === 1 && shift.some(i => sameInput(i, b[0]));

    for (const { id } of PAD_ACTIONS) {
      const live = bindings[id].filter(b => bindingActive(b, s));
      const active = live.some(b => !deferred(b) && !silenced(b));
      const h = this.held.get(id);
      if (active && !h) {
        this.held.set(id, { next: now + REPEAT_FIRST_MS });
        out.push({ action: id, phase: 'down', repeat: false });
      } else if (active && h && REPEATING.has(id) && now >= h.next) {
        h.next = now + REPEAT_EVERY_MS;
        out.push({ action: id, phase: 'down', repeat: true });
      } else if (!active && h) {
        this.held.delete(id);
        out.push({ action: id, phase: 'up', repeat: false });
      }
      const lone = live.filter(deferred);
      const p = this.pending.get(id);
      if (lone.length) {
        const cancelled = lone.some(silenced);
        if (p) p.cancelled ||= cancelled; else this.pending.set(id, { cancelled });
      } else if (p) {
        this.pending.delete(id);
        if (!p.cancelled) out.push({ action: id, phase: 'down', repeat: false }, { action: id, phase: 'up', repeat: false });
      }
    }
    return out;
  }

  /** pad gone or window blurred: release everything that is held, drop waiting presses */
  release(): PadEvent[] {
    const out = [...this.held.keys()].map(action => ({ action, phase: 'up' as const, repeat: false }));
    this.held.clear();
    this.pending.clear();
    return out;
  }
}

/** inputs that are active now but were not at rest: a button newly pressed, an axis pushed far enough */
export function scanInputs(rest: PadSample, now: PadSample): PadInput[] {
  const found: PadInput[] = [];
  for (let i = 0; i < now.buttons.length; i++) {
    if (now.buttons[i] > BUTTON_ON && !((rest.buttons[i] ?? 0) > BUTTON_ON)) found.push(btn(i));
  }
  for (let i = 0; i < now.axes.length; i++) {
    const d = now.axes[i] - (rest.axes[i] ?? 0);
    if (Math.abs(d) >= 0.7 && Math.abs(now.axes[i]) > AXIS_ON) found.push(axis(i, d > 0 ? 1 : -1));
  }
  return found;
}

export const MAX_CHORD = 3;

/**
 * Records a binding: hold the first input, add the others, release. Done when
 * everything that was pressed has been let go again; the binding is the set of
 * inputs seen. Compares against the resting sample so a drifting stick or a
 * trigger resting at -1 is not taken as pressed.
 */
export class ChordScanner {
  private seen: PadInput[] = [];
  constructor(private rest: PadSample) {}

  feed(now: PadSample): PadBinding | null {
    const cur = scanInputs(this.rest, now);
    for (const i of cur) if (this.seen.length < MAX_CHORD && !this.seen.some(j => sameInput(i, j))) this.seen.push(i);
    return this.seen.length && !cur.length ? this.seen : null;
  }
}

/** the action (other than `except`) that already uses exactly this binding */
export function conflictOf(bindings: PadBindings, binding: PadBinding, except: PadAction): PadAction | null {
  for (const { id } of PAD_ACTIONS) {
    if (id !== except && bindings[id].some(b => sameBinding(b, binding))) return id;
  }
  return null;
}

export function describeInput(i: PadInput, standard: boolean): string {
  if (i.kind === 'button') {
    const names = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L3', 'R3', '十字键↑', '十字键↓', '十字键←', '十字键→', 'Xbox'];
    return standard && names[i.index] ? names[i.index] : `按键 ${i.index}`;
  }
  const arrow = i.index % 2 === 0 ? (i.dir > 0 ? '右' : '左') : (i.dir > 0 ? '下' : '上');
  const stick = standard && i.index < 4 ? (i.index < 2 ? '左摇杆' : '右摇杆') : `轴 ${i.index}`;
  return `${stick}${standard && i.index < 4 ? arrow : i.dir > 0 ? '+' : '−'}`;
}

export function describeBinding(b: PadBinding, standard: boolean): string {
  return b.map(i => describeInput(i, standard)).join(' + ');
}
