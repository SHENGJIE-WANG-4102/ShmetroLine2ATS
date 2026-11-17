/**
 * Controller support: the poller that turns the first connected pad into driver
 * events, and the settings page where each action is bound by pressing the
 * control on the pad. Mapping logic lives in gamepad.ts (pure, tested).
 */
import { h, clear } from './dom';
import { loadPref, savePref } from './layout';
import {
  PAD_ACTIONS, PadMapper, bindingsFor, ChordScanner, conflictOf, describeBinding, sampleOf, sameBinding,
  type PadAction, type PadBindings, type PadEvent, type PadSample,
} from './gamepad';

const PREF = 'gamepadBindings';

function firstPad(): Gamepad | null {
  try {
    for (const p of navigator.getGamepads?.() ?? []) if (p && p.connected) return p;
  } catch { /* gamepad API unavailable */ }
  return null;
}

export class GamepadService {
  private mapper = new PadMapper();
  private saved: Record<string, PadBindings> = loadPref<Record<string, PadBindings>>(PREF, {});

  sample(): PadSample | null {
    const p = firstPad();
    return p ? sampleOf(p) : null;
  }

  bindings(s: PadSample): PadBindings {
    return bindingsFor(this.saved[s.id], s);
  }

  /** replace the pad's bindings (undefined = back to the default layout) */
  setBindings(id: string, b: PadBindings | undefined) {
    if (b) this.saved[id] = b; else delete this.saved[id];
    savePref(PREF, this.saved);
  }

  /** events since the last call; empty with no pad */
  poll(now: number): PadEvent[] {
    const s = this.sample();
    if (!s) return this.mapper.release();
    return this.mapper.step(s, this.bindings(s), now);
  }

  release(): PadEvent[] { return this.mapper.release(); }
}

/** open the settings page; returns its close function */
export function openGamepadSettings(root: HTMLElement, svc: GamepadService) {
  const body = h('div', { class: 'modal-b' });
  const status = h('div', { class: 'hint' });
  const note = h('div', { class: 'hint', style: 'color:var(--warn)' });
  const back = h('div', { class: 'modal-back help-back' });
  let scanning: PadAction | null = null;
  let timer = 0;
  let scanner: ChordScanner | null = null;
  let shownId = '';
  const stopScan = () => { scanning = null; scanner = null; clearInterval(timer); timer = 0; };
  const close = () => {
    stopScan();
    window.removeEventListener('keydown', onKey, true);
    back.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (scanning) { stopScan(); draw(); } else close();
  };

  const draw = () => {
    const s = svc.sample();
    shownId = s?.id ?? '';
    clear(body);
    status.textContent = s ? `已连接：${s.id}${s.standard ? '' : '（非标准布局，没有默认设置，请逐项按键设定）'}` : '未检测到手柄：连接后按一下任意键。';
    if (!s) { body.append(status); return; }
    const cur = svc.bindings(s);
    body.append(status, note);
    for (const a of PAD_ACTIONS) {
      const text = scanning === a.id ? '请按住按键（组合键：依次按住几个键），松开完成… （Esc 取消）'
        : cur[a.id].length ? cur[a.id].map(b => describeBinding(b, s.standard)).join('　或　') : '未设置';
      body.append(h('div', { style: 'display:flex;gap:14px;align-items:center;margin:6px 0' },
        h('span', { style: 'width:420px' }, a.label),
        h('span', { style: `flex:1;color:${scanning === a.id ? 'var(--accent)' : 'inherit'}` }, text),
        h('button', { class: 'btn', onclick: () => startScan(a.id, s) }, scanning === a.id ? '扫描中' : '按键设定'),
        h('button', { class: 'btn', onclick: () => { update(s, a.id, []); } }, '清除')));
    }
    body.append(h('div', { style: 'margin-top:14px' },
      h('button', { class: 'btn', onclick: () => { svc.setBindings(s.id, undefined); note.textContent = ''; draw(); } },
        s.standard ? '恢复默认布局' : '清除全部')));
  };

  const update = (s: PadSample, action: PadAction, list: PadBindings[PadAction]) => {
    const b = { ...svc.bindings(s), [action]: list };
    svc.setBindings(s.id, b);
    note.textContent = '';
    draw();
  };

  const startScan = (action: PadAction, s: PadSample) => {
    stopScan();
    scanning = action;
    scanner = new ChordScanner(s);
    draw();
    timer = window.setInterval(() => {
      const now = svc.sample();
      if (!now || now.id !== s.id || !scanner) return;
      const input = scanner.feed(now);
      if (!input) return;
      const b = { ...svc.bindings(s) };
      const other = conflictOf(b, input, action);
      let msg = '';
      if (other) {
        b[other] = b[other].filter(x => !sameBinding(x, input));
        msg = `该按键原属于「${PAD_ACTIONS.find(x => x.id === other)!.label}」，已移到这里`;
      }
      b[action] = [input];
      svc.setBindings(s.id, b);
      stopScan();
      draw();
      note.textContent = msg;
    }, 40);
  };

  back.append(h('div', { class: 'modal wide help' },
    h('div', { class: 'modal-h' }, '手柄设置'),
    body,
    h('div', { class: 'modal-f' }, h('button', { class: 'btn primary', onclick: close }, '完成'))));
  window.addEventListener('keydown', onKey, true);
  root.append(back);
  draw();
  // a pad is only listed after its first button press: redraw when one appears or goes
  const wait = window.setInterval(() => {
    if (!back.isConnected) { clearInterval(wait); return; }
    if (!scanning && (svc.sample()?.id ?? '') !== shownId) draw();
  }, 500);
  return close;
}
