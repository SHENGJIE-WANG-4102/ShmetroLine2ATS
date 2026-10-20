import type { PlanPreview } from '../sim/planning';
import type { Store } from './store';
import { h } from './dom';
import { fmtTime } from './theme';

export function previewBody(store: Store, preview: PlanPreview): Node[] {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 800 330');
  svg.setAttribute('style', 'width:100%;min-width:560px;background:#121923');
  svg.setAttribute('aria-label', '加开运行图预览：灰色为原计划，青色为新增，红色为冲突');
  const newFrom = store.plan?.trips.length ?? 0;
  const added = preview.plan.trips.filter(t => t.id >= newFrom && !t.cancelled);
  const times = added.flatMap(t => t.stops.map(s => s.dep));
  const from = Math.min(store.snap?.t ?? 14400, ...times);
  const to = Math.max(from + 3600, ...times);
  const x = (t: number) => 60 + 725 * (t - from) / (to - from);
  const y = (station: number) => 28 + 265 * station / (store.topo.stations.length - 1);
  const shape = (name: string, attrs: Record<string, string>, text?: string) => {
    const el = document.createElementNS(svg.namespaceURI, name);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    if (text) el.textContent = text;
    svg.append(el);
  };
  for (const st of store.topo.stations.filter((_, i) => i % 5 === 0 || i === store.topo.stations.length - 1)) {
    shape('line', { x1: '60', x2: '785', y1: String(y(st.index)), y2: String(y(st.index)), stroke: '#293644' });
    shape('text', { x: '2', y: String(y(st.index) - 3), fill: '#aab7c8', 'font-size': '10' }, st.name);
  }
  for (let i = 0; i < 5; i++) {
    const t = from + i * (to - from) / 4;
    shape('text', { x: String(x(t) - 18), y: '318', fill: '#aab7c8', 'font-size': '12' }, fmtTime(t, false));
  }
  for (const trip of preview.plan.trips) {
    if (trip.cancelled || trip.stops[trip.stops.length - 1].arr < from || trip.stops[0].dep > to) continue;
    const points = trip.stops.flatMap(s => [[s.arr, s.st], [s.dep, s.st]]).filter(([t]) => t >= from && t <= to).map(([t, st]) => `${x(t)},${y(st)}`).join(' ');
    shape('polyline', { points, fill: 'none', stroke: trip.id >= newFrom ? '#45d1da' : '#536477', 'stroke-width': trip.id >= newFrom ? '1.5' : '0.5' });
  }
  for (const issue of preview.issues) if (issue.t >= from && issue.t <= to) shape('line', { x1: String(x(issue.t)), x2: String(x(issue.t)), y1: '15', y2: '295', stroke: issue.severity === 'error' ? '#ff5a65' : '#d9b35b', 'stroke-dasharray': '4 4' });
  return [
    h('div', { class: 'cmdline' }, preview.msg),
    h('div', { class: 'hint' }, `灰色：原计划 · 青色：加开 · 红色：冲突 · 峰值用车 ${preview.plan.fleetPeak} 列`),
    ...((preview.warnings??[]).map(text=>h('div',{class:'cmdline'},text))),
    svg,
    h('div', { class: 'hint' }, ...(preview.issues.length ? preview.issues.slice(0, 20).map(issue => h('div', {}, `${fmtTime(issue.t, false)} ${issue.severity === 'error' ? '冲突' : '提示'}：${issue.text}`)) : ['运行图校验通过：追踪间隔、折返能力及车辆库存满足要求。'])),
  ];
}
