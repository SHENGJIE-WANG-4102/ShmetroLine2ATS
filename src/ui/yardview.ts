import { formatTrainNumber } from './trainNumber';
/**
 * Depot yard view (车场图): every stabling track with the vehicles on it
 * (front of the track = towards the exit), the vehicle that leaves next,
 * the planned exits and the trains on their way in. Live while open.
 */
import { h, clear } from './dom';
import type { Store } from './store';
import { STATIONS } from '../data/current';
import { fmtTime } from './theme';
import { chooseVehicle, dayNumber } from '../sim/yard';
import { vehicleOperationLabel } from './utoControls';
import type { VehicleRecord } from '../sim/model';

export function openYard(store: Store, root: HTMLElement, depot: number, onAddTrain: () => void) {
  const { topo } = store;
  const d = topo.depots[depot];
  const body = h('div', { class: 'modal-b' });
  const back = h('div', { class: 'modal-back' });
  const close = () => { off(); back.remove(); };
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  back.append(h('div', { class: 'modal wide' },
    h('div', { class: 'modal-h' }, h('span', {}, `车场图 · ${d.name}`), h('span', { class: 'stepchip' }, `接轨 ${STATIONS[d.station].name}`)),
    body,
    h('div', { class: 'modal-f' },
      h('button', { class: 'btn primary', onclick: () => { close(); store.select({ kind: 'depot', id: depot }); onAddTrain(); } }, '加开列车…'),
      h('button', { class: 'btn', onclick: close }, '关闭')),
  ));
  let key = '';
  const render = () => {
    const snap = store.snap;
    const plan = store.plan;
    if (!snap || !plan) return;
    const y = snap.yards[depot];
    const now = snap.t;
    const inbound = snap.trains.filter((t) => t.dest === d.short && !t.inService);
    const next = plan.blocks.filter((b) => b.start.kind === 'depot' && b.start.depot === depot && b.start.time > now - 60 && b.train === undefined)
      .sort((a, b) => (a.start as { time: number }).time - (b.start as { time: number }).time).slice(0, 8);
    const workshop = [...snap.vehicles.entries()].filter(([,r]) => r.work && r.depot === depot);
    const date = (day: number) => new Date(day * 86400000).toISOString().slice(0,10);
    const info = (r: VehicleRecord | undefined) => r ? `上次列检 ${date(r.daily)}\n上次月检 ${date(r.monthly)}\n累计里程 ${r.km.toFixed(1)} km` : '';
    const k = `${workshop.map(([no,r])=>`${no}:${r.work}:${r.until}`).join(',')}#${y.tracks.map((t) => t.map(v=>`${v}:${snap.vehicles.get(v)?.uto?.stage ?? ''}`).join(',')).join('|')}#${inbound.map((t) => t.id).join(',')}#${next.map((b) => b.svc).join(',')}#${Math.floor(now / 30)}`;
    if (k === key) return;
    key = k;
    clear(body);
    const total = y.tracks.reduce((a, t) => a + t.length, 0);
    const nextVehicle = chooseVehicle(snap.vehicles, y.tracks.flatMap(t=>t.length ? [t[0]] : []), topo, next[0], dayNumber(store.config ?? {}));
    body.append(h('div', { class: 'kv', style: 'margin-bottom:18px' },
      h('span', { class: 'k' }, '在段车辆'), h('span', { class: 'v' }, `${total} 列`),
      h('span', { class: 'k' }, '停车线'), h('span', { class: 'v' }, `${d.stablingTracks} 股 × ${y.perTrack} 列位`),
      h('span', { class: 'k' }, '容量'), h('span', { class: 'v' }, `${d.capacity} 列`),
      h('span', { class: 'k' }, '出段走行'), h('span', { class: 'v' }, `${Math.round(d.exitTime / 60)} 分钟`)));
    const yard = h('div', { class: 'yard' });
    y.tracks.forEach((t, i) => {
      const rail = h('div', { class: 'rail' }, h('span', { style: 'color:var(--text-muted);font-size:20px;margin-right:6px' }, '出口 ◀'));
      t.forEach((v, j) => {
        const state = vehicleOperationLabel(snap.vehicles.get(v));
        rail.append(h('div', { class: `veh ${v === nextVehicle && j === 0 ? 'next' : ''}`, style: state ? 'flex-direction:column;gap:3px' : '', title: `${v === nextVehicle && j === 0 ? '下一列出段车辆\n' : ''}${info(snap.vehicles.get(v))}` }, v, ...(state ? [h('small', { style: 'font-size:14px;color:var(--text-dim)' }, state)] : [])));
      });
      for (let j = t.length; j < y.perTrack; j++) rail.append(h('div', { class: 'veh', style: 'opacity:.18;border-style:dashed' }, '空'));
      yard.append(h('div', { class: 'trk' }, h('span', { class: 'no' }, `${i + 1}道`), rail));
    });
    body.append(yard);
    const workshopView = h('div', { class: 'sect-title', style: 'margin-top:18px' }, '检修库（不占停车列位）');
    body.append(workshopView);
    if (!workshop.length) body.append(h('div', { class: 'hint' }, '无检修车辆'));
    for (const [no,r] of workshop) body.append(h('div', { class:'mono', title:info(r) }, `${r.work === 'monthly' ? '月检' : '架修'}：${no}，预计 ${date(r.until).slice(5)} 完成`));
    const cols = h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:22px' });
    const tb = h('tbody');
    if (!next.length) tb.append(h('tr', {}, h('td', { class: 'hint' }, '近期无出段计划')));
    for (const b of next) {
      const tr0 = plan.trips[b.trips[0]];
      tb.append(h('tr', {}, h('td', { class: 'mono' }, fmtTime((b.start as { time: number }).time, false)), h('td', { class: 'mono' }, `表号 ${b.svc}`), h('td', {}, tr0 ? `→ ${STATIONS[tr0.to].name}` : '')));
    }
    const tb2 = h('tbody');
    if (!inbound.length) tb2.append(h('tr', {}, h('td', { class: 'hint' }, '无')));
    for (const t of inbound) tb2.append(h('tr', { style: 'cursor:pointer', onclick: () => { close(); store.select({ kind: 'train', id: t.id }); } },
      h('td', { class: 'mono' }, `${formatTrainNumber(t.svc, t.trip, true)}`), h('td', { class: 'mono' }, t.vehicle), h('td', {}, t.nextStation >= 0 ? `经 ${STATIONS[t.nextStation].name}` : '')));
    cols.append(
      h('div', {}, h('div', { class: 'sect-title' }, '计划出段'), h('table', { class: 'grid' }, tb)),
      h('div', {}, h('div', { class: 'sect-title' }, '回段途中'), h('table', { class: 'grid' }, tb2)));
    body.append(cols);
  };
  const off = store.on('snap', render);
  render();
  root.append(back);
  return close;
}
