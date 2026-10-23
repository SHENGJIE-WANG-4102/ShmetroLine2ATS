import {describe,expect,it} from 'vitest';
import {RIDE_LOG,RECORDING_SOURCES,LEGACY_RECORDING_IDS,FIELD_1016_RECORDING_IDS,
  summarizeRideLog,type RideStop,type RecordingId} from '../src/data/audio/ridelog';

const row=(station:string,stop:number|null,start:number|null,recording:RecordingId='ride-1016-east-night'):RideStop=>({
  recording,station,direction:'DN',stop,open:null,close:null,start,analysisWindowS:null,candidates:{},
  evidence:{...(stop===null?{}:{stop:{method:'spectral-knee',confidence:'high'}}),
    ...(start===null?{}:{start:{method:'rising-traction-band',confidence:'medium'}})},
});

describe('recorded ride cohorts',()=>{
  it('keeps the original observed means and pair denominator unchanged',()=>{
    const legacy:readonly RecordingId[]=LEGACY_RECORDING_IDS;
    const summary=summarizeRideLog(RIDE_LOG.filter(r=>legacy.includes(r.recording)));
    expect(summary.run).toEqual({count:8,meanS:134.25});
    expect(summary.dwell).toEqual({count:7,meanS:58.49});
    expect(summary.paired).toEqual({count:7,runMeanS:131.29,dwellMeanS:58.49});
    expect(summary.events.stop.low).toBe(6);
  });
  it('records filename clocks as minutes and keeps a clipped route explicit',()=>{
    const field:readonly RecordingId[]=FIELD_1016_RECORDING_IDS;
    const sources=RECORDING_SOURCES.filter(s=>field.includes(s.id));
    expect(sources).toHaveLength(4);
    expect(sources.every(s=>s.clockStartPrecision==='minute'&&s.recordedDate==='2026-10-16')).toBe(true);
    const clipped=sources.find(s=>s.id==='ride-1016-east-end')!;
    expect(clipped.from).toBe('国家会展中心');expect(clipped.observedFrom).toBe('虹桥火车站');
    expect(RIDE_LOG.find(r=>r.recording===clipped.id)!.station).toBe(clipped.observedFrom);
  });
  it('does not join recordings or jump over an unmeasured departure',()=>{
    const a=row('a',0,10),b=row('b',30,null),c=row('c',60,70);
    const other=row('x',1000,1010,'ride-1016-west-core');
    expect(summarizeRideLog([a,other,b,c]).run).toEqual({count:1,meanS:20});
  });
  it('excludes a low stop from both run and dwell while retaining the observation',()=>{
    const a=row('a',0,10),b=row('b',30,50);b.evidence.stop!.confidence='low';
    const result=summarizeRideLog([a,b]);
    expect(result.run.count).toBe(0);expect(result.dwell).toEqual({count:1,meanS:10});
    expect(result.events.stop.low).toBe(1);expect(b.stop).toBe(30);
  });
  it('keeps weak opening and mechanical-close estimates out of their own means only',()=>{
    const a=row('a',0,20);a.open=2;a.closingMotion=16;a.close=13;
    a.evidence.open={method:'opening-band-step',confidence:'low'};
    a.evidence.closingMotion={method:'door-impact-duration',confidence:'low'};
    a.evidence.close={method:'closing-tone-pulses',confidence:'high'};
    const result=summarizeRideLog([a]);
    expect(result.dwell).toEqual({count:1,meanS:20});
    expect(result.openingLag).toEqual({count:0,meanS:null});
    expect(result.closingToStart).toEqual({count:0,meanS:null});
    expect(result.warningToStart).toEqual({count:1,meanS:7});
  });
  it('combines underlying observations rather than averaging cohort means',()=>{
    const a=[row('a',0,10)],b=[row('b',100,130),row('c',150,200)];
    expect(summarizeRideLog([...a,...b]).dwell).toEqual({count:3,meanS:30});
    expect(summarizeRideLog([]).run.meanS).toBeNull();
  });
});
