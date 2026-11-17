/**
 * The sim worker threw: the world is frozen, so say so instead of leaving a
 * stuck screen. The dialog has no close button (Esc is ignored while a modal
 * is open); the way out is exporting the diagnostics or reloading.
 */
import { h } from './dom';
import { downloadDiagnostics } from './diagnosticFiles';
import { toast } from './confirm';

export interface CrashInfo { where: string; message: string; json: string }

export function showCrash(root: HTMLElement, c: CrashInfo, filename: string) {
  if (root.querySelector('.crash-back')) return;
  const exportBtn = h('button', {
    class: 'btn primary',
    onclick: () => { void downloadDiagnostics(c.json, filename).catch(e => toast(`诊断导出失败：${String(e)}`, false)); },
  }, '导出诊断');
  exportBtn.disabled = !c.json;
  root.append(h('div', { class: 'modal-back crash-back' }, h('div', { class: 'modal critical' },
    h('div', { class: 'modal-h' }, h('span', { class: 'stepchip' }, '仿真已停止'), '仿真线程出错'),
    h('div', { class: 'modal-b' },
      h('p', {}, `出错位置：${c.where}。画面上的列车已停止更新，不要再继续操作。`),
      h('p', { class: 'hint' }, c.json ? '先导出诊断（含到出错前的全部操作，可回放），再重新载入。' : '诊断包没能生成，请把下面的错误文字一并反馈。'),
      h('pre', { style: 'max-height:360px;overflow:auto;font-size:16px;white-space:pre-wrap' }, c.message)),
    h('div', { class: 'modal-f' }, exportBtn, h('button', { class: 'btn danger', onclick: () => location.reload() }, '重新载入')))));
}
