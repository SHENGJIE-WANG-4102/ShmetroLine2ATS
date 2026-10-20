import {describe,it,expect} from 'vitest';import {Sim} from '../src/sim/engine';import {buildTopology} from '../src/sim/topology';import {exposureOf,setWeather} from '../src/sim/env';import {EXPOSED} from '../src/data/line2';
describe('surface boundaries from the track diagram',()=>{
 it('keeps Jinke Road through Lingkong Road underground and both portals between stations',()=>{
  const topo=buildTopology(),exposure=exposureOf({topo});const st=(id:string)=>topo.stations.find(s=>s.id===id)!;
  for(const s of topo.sections.filter(s=>s.chainFrom>=st('JKL').chain&&s.chainTo<=st('LKL').chain))expect(exposure[s.id]).toBe(0);
  for(const id of ['LYL','ZJG','JKL','GLL','TZ','CXZ','HXD','CS','LKL'])for(const p of topo.platforms.filter(p=>p.station===st(id).index))expect(exposure[p.section],id).toBe(0);
  for(const p of topo.platforms.filter(p=>p.station===st('YDD').index))expect(exposure[p.section]).toBe(1);
  const short=EXPOSED[0];expect(short.from).toBeGreaterThan(st('LYL').chain);expect(short.to).toBeLessThan(st('ZJG').chain);expect(short.to-short.from).toBeLessThan(600);
  expect(EXPOSED[1].from).toBeGreaterThan(st('LKL').chain);expect(EXPOSED[1].from).toBeLessThan(st('YDD').chain);
 });
 it('applies wind and rain only to the corrected exposed sections',()=>{
  const sim=new Sim({dayType:'weekday',dateLabel:'test',startTime:14400,seed:3});setWeather(sim,{wind:2,rain:true,duration:300});
  sim.sec.forEach((s,i)=>expect(s.envTsr).toBe(sim.exposure[i]===1?45:sim.exposure[i]===2?60:0));
 });
});
