import {isDesktop} from './ui/platform';
/**
 * Bootstrap: topology, simulation worker, Pixi renderer and the application
 * shell (see ui/app.ts). Starts the default operating day.
 */
import './styles.css';
import { Application } from 'pixi.js';
import { buildTopology } from './sim/topology';
import { Store } from './ui/store';
import { App, parseTime, newOperatingSeed } from './ui/app';
import { dayTypeOf, dateLabel } from './ui/header';
import { isoDate } from './sim/calendar';
import { C, fmtTime } from './ui/theme';
import type { SimConfig } from './sim/model';

const bootMsg = document.getElementById('boot-msg')!;
const bootBar = document.getElementById('boot-progress')!;

async function main() {
  if(isDesktop()) {
    document.documentElement.classList.add('desktop');
    document.querySelector('.boot-title')!.textContent='上海地铁2号线 ATS 模拟器';
    bootMsg.textContent='准备运营日设置…';
    await import('pixi.js/unsafe-eval');
  }
  await document.fonts.load('600 20px "JetBrains Mono"').catch(() => undefined);
  const topo = buildTopology();
  const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
  const store = new Store(topo, worker);

  const pixi = new Application();
  await pixi.init({
    background: C.bg,
    resizeTo: window,
    antialias: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),
    autoDensity: true,
    preference: 'webgl',
  });
  document.getElementById('pixi-host')!.append(pixi.canvas);
  const app = new App(topo, store, pixi, document.getElementById('overlay')!);

  store.on('startup',()=>{
    bootMsg.textContent=store.startupText;
    bootBar.style.width='5%';
  });
  store.on('progress', () => {
    const p = store.progress;
    if (!p) return;
    bootMsg.textContent = `推演中 ${fmtTime(p.t)} → ${fmtTime(p.target)}`;
    bootBar.style.width = `${Math.min(100, Math.max(5, ((p.t - 4 * 3600) / Math.max(1, p.target - 4 * 3600)) * 100))}%`;
  });
  let first = true;
  store.on('ready', () => {
    document.getElementById('boot')!.style.display = 'none';
    if (first) { first = false; app.firstRunHelp(); }
  });

  // default to a weekday so the big/small route peak pattern is visible
  const d = new Date();
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  const params = new URLSearchParams(location.search);
  const startParam = params.get('t');
  const parsed = startParam ? parseTime(startParam) : NaN;
  // an unreadable or out-of-day ?t= falls back to the default start
  const start = Number.isFinite(parsed) && parsed <= 27.7 * 3600 ? parsed : 7 * 3600 + 40 * 60;
  const holiday = params.get('holiday') === '1';
  const cfg: SimConfig = { dayType: dayTypeOf(d, holiday), dateLabel: dateLabel(d, holiday), date: isoDate(d), startTime: start, seed: newOperatingSeed() };
  bootMsg.textContent = `生成 ${cfg.dateLabel} 运行图并推演至 ${fmtTime(start)}…`;
  if(isDesktop()) {
    document.getElementById('boot')!.style.display='none';
    app.showDayDialog(true);
  } else store.start(cfg);

  if (import.meta.env.DEV) (window as unknown as { __ats: unknown }).__ats = { store, app };
}

main().catch((e) => {
  bootMsg.textContent = `启动失败：${e instanceof Error ? e.message : String(e)}`;
  console.error(e);
});
