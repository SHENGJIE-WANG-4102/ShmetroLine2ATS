import { describe, expect, it } from 'vitest';
import { advancePisCycle, computePis, formatPisCountdown, PIS_TIMING, selectPisFirstLast, timeToStop } from '../src/sim/pis';
import { PERF } from '../src/sim/dynamics';
import { STATIONS, STATION_EN } from '../src/data/line2';
import type { PisRow, TrackDir } from '../src/sim/model';
import type { Sim } from '../src/sim/engine';

const train = (destination: string, eta = 36, status: PisRow['status'] = 'eta'): PisRow => ({
  destSt: STATIONS.findIndex((s) => s.id === destination),
  dest: STATIONS.find((s) => s.id === destination)?.name ?? '未知终点',
  eta, status, trip: 'test-1', load: .5,
});

describe('PIS countdown', () => {
  it('keeps an absent train distinct from a distant train', () => {
    expect(formatPisCountdown(undefined)).toBe('00:00');
    expect(formatPisCountdown(train('PDA', 4392))).toBe('预计大于1小时');
    expect(formatPisCountdown(train('PDA', 6000))).toBe('预计大于1小时');
  });

  it.each([
    [-10, '00:00'], [0, '00:00'], [36, '00:36'], [59.6, '01:00'],
    [3599, '59:59'], [3600, '60:00'], [3600.1, '预计大于1小时'],
  ])('formats the one-hour boundary and rounding (%s s)', (eta, expected) => {
    expect(formatPisCountdown(train('PDA', eta))).toBe(expected);
  });

  it.each(['at', 'departing'] as const)('shows zero for %s even with a stale ETA', (status) => {
    expect(formatPisCountdown(train('PDA', 7000, status))).toBe('00:00');
  });

  it('times the run in as cruising, then braking as ATO plans it', () => {
    const v = 15, brake = v * v / (2 * PERF.bPlan);
    expect(timeToStop(v, brake)).toBeCloseTo(v / PERF.bPlan);
    expect(timeToStop(v, brake + 150)).toBeCloseTo(10 + v / PERF.bPlan);
    expect(timeToStop(5, 1)).toBeCloseTo(0.4);
  });

  it('keeps counting down while the train runs into the platform', () => {
    expect(formatPisCountdown(train('PDA', 18, 'arriving'))).toBe('00:18');
  });
});

describe('PIS published first / last times', () => {
  it('matches both eastbound rows photographed at Jiangsu Road', () => {
    expect(selectPisFirstLast('江苏路', 'DN', train('PDA'))).toEqual([
      { destination: '浦东1号2号航站楼', first: '05:52', last: '22:24' },
      { destination: '广兰路', first: '05:52', last: '23:09' },
    ]);
  });

  it('puts the first train to Guanglan Road first and uses lastG', () => {
    expect(selectPisFirstLast('江苏路', 'DN', train('GLL'))).toEqual([
      { destination: '广兰路', first: '05:52', last: '23:09' },
      { destination: '浦东1号2号航站楼', first: '05:52', last: '22:24' },
    ]);
  });

  it('uses the westbound column for Panxiang Road', () => {
    expect(selectPisFirstLast('金科路', 'UP', train('PXL'))).toEqual([
      { destination: '蟠祥路·国家会计学院', first: '05:31', last: '23:05' },
    ]);
  });

  it.each([
    ['世纪大道', 'DN', 'LYL', '06:11', '22:43', '浦东1号2号航站楼'],
    ['江苏路', 'UP', 'SHR', '05:44', '23:38', '蟠祥路·国家会计学院'],
  ] as const)('uses the directional full-route column for %s depot-bound service', (station, track, dest, first, last, destination) => {
    expect(selectPisFirstLast(station, track as TrackDir, train(dest))[0]).toEqual({ destination, first, last });
  });

  it('formats times past midnight as clock times', () => {
    expect(selectPisFirstLast('蟠祥路·国家会计学院', 'UP', train('PXL'))[0].last).toBe('00:05');
    expect(selectPisFirstLast('虹桥火车站', 'UP', train('PXL'))[0].last).toBe('00:00');
  });

  it('omits Guanglan Road where the official table has no such service', () => {
    expect(selectPisFirstLast('唐镇', 'DN', train('PDA'))).toEqual([
      { destination: '浦东1号2号航站楼', first: '06:04', last: '23:04' },
    ]);
  });

  it('uses the platform direction with no train, unknown destination or a terminating arrival', () => {
    const expected = selectPisFirstLast('江苏路', 'UP', train('PXL'));
    expect(selectPisFirstLast('江苏路', 'UP')).toEqual(expected);
    expect(selectPisFirstLast('江苏路', 'UP', train('unknown'))).toEqual(expected);
    // a short working terminating at 广兰路 is not a departure towards 广兰路
    expect(selectPisFirstLast('广兰路', 'DN', train('GLL'))).toEqual(selectPisFirstLast('广兰路', 'DN'));
  });

  it('returns no invented schedule for an unknown station', () => {
    expect(selectPisFirstLast('未知车站', 'DN', train('PDA'))).toEqual([]);
  });

  it('uses the platform abbreviation for Panxiang Road English', () => {
    expect(STATION_EN.PXL).toBe('Panxiang Rd. • SNAI');
  });
});

describe('PIS field cadence', () => {
  it('preserves the page through countdown updates and switches exactly at its boundary', () => {
    const state = { page: 0, since: 100 };
    const durations = [PIS_TIMING.scrollingPageMs, PIS_TIMING.pageMs, PIS_TIMING.pageMs];
    expect(advancePisCycle(state, 13449, durations)).toEqual(state);
    expect(advancePisCycle(state, 13450, durations)).toEqual({ page: 1, since: 13450 });
    expect(advancePisCycle(state, 17900, durations)).toEqual({ page: 2, since: 17900 });
  });

  it('catches up after a background-tab pause and preserves the remainder', () => {
    const durations = [4450, 4450];
    expect(advancePisCycle({ page: 1, since: 0 }, 89000 + 4451, durations)).toEqual({ page: 0, since: 93450 });
  });

  it('keeps separate first/last pages when the direction has two services', () => {
    const durations = [13350, 4450, 4450, 4450];
    expect(advancePisCycle({ page: 0, since: 0 }, 17800, durations).page).toBe(2);
    expect(advancePisCycle({ page: 0, since: 0 }, 22250, durations).page).toBe(3);
    expect(advancePisCycle({ page: 0, since: 0 }, 26700, durations).page).toBe(0);
  });

  it('uses the user-selected hardware only at the two western extension stations', () => {
    expect(STATIONS.filter((s) => s.pisLayout === 'wide').map((s) => s.id)).toEqual(['PXL', 'GJH']);
    expect(STATION_EN.YDD).toBe('Yuandong Ave.');
  });
});

describe('PIS actual task destination', () => {
  it('counts down an assigned origin while its car is still on an earlier trip', () => {
    const station=0, departure=21*3600+57*60;
    const task={k:'stop',station,berth:0,trip:1,arr:null,dep:departure,revenue:true,doors:true};
    const sim={
      t:21*3600+50*60,
      topo:{berths:[{platform:0},{platform:1}],platforms:[{track:'DN'},{track:'UP'}],stations:[{platforms:{DN:0,UP:1}}]},
      trainList:[{block:0,failed:false,withdrawn:false,delay:0,phase:'run',stopDist:Infinity,v:10,load:0,
        skipStations:new Set(),tasks:[{...task,berth:1,trip:0,arr:21*3600+51*60,dep:null},
          ...Array.from({length:17},()=>({...task,station:1,trip:0})),task]}],
      plan:{blocks:[{id:0,train:42,trips:[0,1],start:{kind:'depot',depot:0,time:18000}}],trips:[
        {id:0,from:30,to:0,dir:'UP',stops:[]},
        {id:1,block:0,no:'last-origin',from:station,to:30,dir:'DN',revenue:true,stops:[{st:station,arr:departure,dep:departure,stop:true},{st:30,arr:departure+5600,dep:departure+5600,stop:true}]},
      ]},
      plat:[{skip:false,surge:1,limitUntil:0},{skip:false,surge:1,limitUntil:0}],env:{wind:0,rain:false},alarms:new Map(),
    } as unknown as Sim;
    expect(formatPisCountdown(computePis(sim,station).DN[0])).toBe('07:00');
    expect(computePis(sim,station).UP[0].destSt).toBe(station);
    // The car has already left the origin of this trip: later stops of the
    // same active trip must not resurrect an overdue zero-countdown row.
    sim.t=departure+180;
    sim.trainList[0].tasks=sim.trainList[0].tasks.filter(t=>t.k!=='stop'||t.trip!==1||t.station!==station);
    sim.trainList[0].tasks.push({...task,station:1} as Sim['trainList'][number]['tasks'][number]);
    expect(computePis(sim,station).DN).toEqual([]);
    sim.trainList=[];
    expect(computePis(sim,station).DN).toEqual([]);
  });
  it.each(['LYL', 'YDD', 'SHR'] as const)('preserves %s both upstream and at its terminal arrival', (id) => {
    const dest = STATIONS.findIndex((s) => s.id === id);
    for (const terminal of [false, true]) {
      const station = terminal ? dest : dest - 1;
      const sim = {
        t: 100, topo: { berths: [{ platform: 0 }], platforms: [{ track: 'DN' }],
          stations: STATIONS.map((s) => ({ name: s.name, platforms: { DN: 0, UP: 1 } })) },
        trainList: [{ failed: false, delay: 0, tasks: [{ k: 'stop', station, berth: 0, trip: 0,
          arr: 150, dep: terminal ? null : 180, revenue: true, doors: true }],
          phase: 'run', stopDist: Infinity, v: 0, skipStations: new Set(), tripNo: 'fixture', load: 0 }],
        // A terminating task can supersede the original diagram destination.
        plan: { trips: [{ revenue: true, to: terminal ? STATIONS.length - 1 : dest, dir: 'DN', stops: [] }] },
        plat: [{ skip: false, surge: 1, limitUntil: 0 }, { skip: false, surge: 1, limitUntil: 0 }],
        env: { wind: 0, rain: false }, alarms: new Map(),
      } as unknown as Sim;
      const actual = computePis(sim, station).DN[0];
      expect(actual.dest).toBe(STATIONS[dest].name);
      expect(actual.destSt).toBe(dest);
    }
  });
});
