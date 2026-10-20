import { describeTask, type Sim } from './engine';
import { overnightPlaces, hotStandbyPlaces } from './timetable';
import { dateLabel, dayTypeOf, isoDate, parseIso } from './calendar';
import type { SimConfig } from './model';

export function unfinishedAtRollover(sim: Sim): string[] {
  const places=[...overnightPlaces(sim.topo).flatMap(p=>[p.berth,p.arrivalBerth]),
    ...hotStandbyPlaces(sim.topo).map(p=>p.berth),...sim.topo.stations.flatMap(s=>s.storageBerths)];
  const legal=[...new Set(places)].map(id=>sim.topo.berths[id]);
  return sim.trainList.filter(t=>{
    const first=t.tasks.find(task=>task.k==='stop');
    const waitingForOpening=first?.stabledOut&&first.dep!==null&&first.dep>sim.t;
    const idle=!t.tasks.length||waitingForOpening;
    // Changing ends changes the head coordinate, not the occupied parking slot.
    return !idle||t.v>=.05||!legal.some(b=>t.link===b.link
      &&Math.abs((t.off-t.dir*t.len/2)-(b.offset-b.dir*t.len/2))<5);
  })
    .map(t=>`${t.vehicle}（${t.svc}-${t.tripNo}，${sim.topo.sections[sim.topo.links[t.link].section].name}，${t.tasks[0]?describeTask(sim,t.tasks[0]):'无后续任务'}）`);
}
/** Carry every session setting through one shared config, then refresh the date. */
export function nextOperatingConfig(sim: Sim): SimConfig {
  const date=parseIso(sim.config.date!); date.setDate(date.getDate()+1);
  const {scenario: _scenario,...config}=sim.config;
  return {...config,date:isoDate(date),dateLabel:dateLabel(date,false),dayType:dayTypeOf(date,false),
    depotStock: sim.depotStock.slice(),
    startTime:4*3600,seed:sim.config.seed+1,autoRadio:sim.autoRadio,randomFaults:sim.randomLevel,driveMode:sim.atoLine?'ATO':'DTO'};
}
