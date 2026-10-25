import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import type {SoundClip} from '../src/data/types';
import type {OnboardAudioFrame} from '../src/ui/onboardaudio';

describe('line 14 recorded carriage PA',()=>{
  let data:typeof import('../src/data/current');
  let bank:typeof import('../src/data/lines/line14/onboardbank');
  let facade:typeof import('../src/data/audio/onboardbank');
  let playback:typeof import('../src/ui/onboardaudio');
  let dynamics:typeof import('../src/sim/dynamics');
  beforeAll(async()=>{
    vi.stubEnv('ATS_LINE','14');vi.resetModules();
    data=await import('../src/data/current');bank=await import('../src/data/lines/line14/onboardbank');
    facade=await import('../src/data/audio/onboardbank');
    playback=await import('../src/ui/onboardaudio');dynamics=await import('../src/sim/dynamics');
  });
  afterAll(()=>{vi.unstubAllEnvs();vi.resetModules();});

  it('resolves current-line samples without importing any other line recordings',()=>{
    const audio=data.LINE.audio;
    expect(audio.soundbank.SOUNDBANK_DIRECTORY).toBe('sounds/line14');
    expect(audio.soundbank.SOUND_BANK).toHaveLength(12);
    expect(new Set(audio.soundbank.SOUND_BANK.map(c=>c.id)).size).toBe(12);
    for(const clip of audio.soundbank.SOUND_BANK){
      expect(clip.source.startsWith('line14-')).toBe(true);
      expect(clip.file).toBe(`${clip.id}.mp3`);
      expect(clip.provenance).toBe('original');expect(clip.composition).toBeUndefined();
      expect(clip.confidence).toBe(clip.id==='line14-next-wdl'?'low':'medium');
      const source=bank.VOICE_SOURCES.find(s=>s.id===clip.source)!;
      expect(source).toBeDefined();expect(clip.range[0]).toBeGreaterThanOrEqual(0);
      expect(clip.range[1]).toBeLessThanOrEqual(source.durationS);
      expect(clip.range[1]-clip.range[0]).toBeGreaterThan(0);
    }
    expect(audio.doorbank.DOOR_BANK).toEqual([]);expect(audio.doorbank.DOOR_TAKES).toEqual([]);
    expect(audio.vvvf.VVVF_TAKES).toEqual([]);
    expect(audio.onboardbank.VOICE_PARTS).toEqual([]);
  });

  it('requires the recorded direction, destination and actual door side for every station call',()=>{
    for(const slot of bank.ONBOARD_ANNOUNCEMENTS){
      const station=data.STATIONS.findIndex(s=>s.name===slot.station);
      expect(data.LINE.audio.onboardbank.onboardDoorSide(station,'DN','桂桥路')).toBe(slot.doorSide);
      expect(facade.onboardAnnouncement(slot.station,'DN','桂桥路',slot.doorSide)).toBe(slot);
      expect(facade.onboardAnnouncement(slot.station,'UP','桂桥路',slot.doorSide)).toBeUndefined();
      expect(facade.onboardAnnouncement(slot.station,'DN','封浜',slot.doorSide)).toBeUndefined();
      expect(facade.onboardAnnouncement(slot.station,'DN','蓝天路',slot.doorSide)).toBeUndefined();
      expect(facade.onboardAnnouncement(slot.station,'DN','桂桥路',slot.doorSide==='L'?'R':'L')).toBeUndefined();
    }
    expect(facade.onboardAnnouncement('陆家嘴','DN','桂桥路','L')).toBeUndefined();
    const hpn=facade.onboardAnnouncement('一大会址·黄陂南路','DN','桂桥路','R')!;
    expect(hpn.next).toBeDefined();expect(hpn.arrived).toBeDefined();
    expect(hpn.missingSentences).toContain('中文到站段未采用');
  });

  it('retains the actual partial coverage and does not invent station names or missing sentences',()=>{
    expect(bank.ORIGINAL_ONBOARD.filter(t=>t.type==='next').map(t=>t.station)).toEqual(['中宁路','曹杨路','武宁路','武定路','静安寺','一大会址·黄陂南路','大世界','豫园']);
    expect(bank.ORIGINAL_ONBOARD.filter(t=>t.type==='arrived').map(t=>t.station)).toEqual(['武宁路','一大会址·黄陂南路','大世界']);
    const wdl=bank.onboardAnnouncement('武定路','DN','桂桥路','L')!;
    expect(wdl.next?.confidence).toBe('low');expect(wdl.arrived).toBeUndefined();
    expect(bank.ORIGINAL_ONBOARD.find(t=>t.id===wdl.next!.clipId)?.confidence).toBe('low');
    expect(bank.LINE14_FIELD_TAKES.find(t=>t.id===wdl.next!.clipId)?.identification).toMatchObject({method:'上下站/画面推断'});
    for(const station of ['中宁路','曹杨路','静安寺','豫园']){
      const slot=bank.ONBOARD_ANNOUNCEMENTS.find(s=>s.station===station)!;
      expect(slot.arrived).toBeUndefined();expect(slot.missingSentences).toContain('到站广播缺段');
    }
    expect(bank.ONBOARD_ANNOUNCEMENTS.every(a=>a.missingSentences.includes('英文下一站段未采用'))).toBe(true);
    expect(bank.LINE14_SAFETY_CLIP.kind).toBe('interior-special');
    expect(data.LINE.audio.onboardbank.ONBOARD_HOLD_CLIP.id).toBe('');
  });

  it('uses same-source motion anchors and leaves unmeasured recording delays explicit',()=>{
    const next=(station:string)=>bank.ONBOARD_ANNOUNCEMENTS.find(s=>s.station===station)!.next!;
    expect(next('武宁路').delayS).toBeCloseTo(15.448229-10,6);
    expect(next('武定路').delayS).toBeCloseTo(8.031313,6);
    expect(next('武定路').measuredDelay).toBe(true);
    expect(next('武定路').delayS).toBeLessThan(9);
    expect(next('静安寺').delayS).toBeCloseTo(113.795813-108.2,6);
    expect(next('中宁路').delayS).toBe(6);expect(next('曹杨路').delayS).toBe(6);
    expect(next('中宁路').measuredDelay).toBeUndefined();expect(next('曹杨路').measuredDelay).toBeUndefined();
    expect(next('武宁路').measuredDelay).toBe(true);expect(next('静安寺').measuredDelay).toBe(true);
    const clips=new Map<string,SoundClip>(data.LINE.audio.soundbank.SOUND_BANK.map(c=>[c.id,c]));
    for(const take of bank.LINE14_FIELD_TAKES.filter(t=>t.type==='arrived')){
      const arrival=bank.ONBOARD_ANNOUNCEMENTS.find(s=>s.station===take.station)!.arrived!;
      expect(arrival.measuredAdvance).toBe(true);
      expect(arrival.advanceS+clips.get(arrival.clipId)!.range[0]).toBeCloseTo(take.stopAt!,6);
    }
    const start=(station:string,origin:string,legacy=false)=>{
      const original=bank.ONBOARD_ANNOUNCEMENTS.find(s=>s.station===station)!;
      // A legacy delayS alone must not opt a slot into per-recording timing.
      const slot=legacy?{...original,next:{...original.next!,delayS:99,measuredDelay:undefined}}:original;
      const planner=new playback.OnboardSoundPlanner(data.LINE.audio.soundbank.SOUND_BANK,[slot],6,0);
      const frame=(t:number,v:number,nextStation:string,phase:'dwell'|'run'):OnboardAudioFrame=>({
        t,rate:1,paused:false,muted:false,enabled:true,willStop:true,destination:'桂桥路',doorSide:slot.doorSide,
        train:{id:1,trip:'test',direction:'DN',mode:'DTO',manual:false,rm:false,failed:false,eb:false,inService:true,
          phase,v,a:0,distance:1000,nextStation:data.STATIONS.findIndex(s=>s.name===nextStation),atStation:phase==='dwell',doors:false,doorClosing:false,dwellLeft:0}});
      planner.update(frame(100,0,origin,'dwell'));
      planner.update(frame(100.2,.005,station,'run'));
      const due=100.2+(legacy?6:slot.next!.delayS!);
      for(let t=101;t<due-.01;t++)expect(planner.update(frame(t,4,station,'run')).filter(c=>c.kind==='play')).toEqual([]);
      expect(planner.update(frame(due-.001,4,station,'run')).filter(c=>c.kind==='play')).toEqual([]);
      const commands=planner.update(frame(due,4,station,'run')).filter(c=>c.kind==='play');
      expect(commands.map(c=>c.clips[0].id)).toEqual([slot.next!.clipId]);
      expect(commands[0].offsetS).toBeCloseTo(0,6);
    };
    start('武宁路','曹杨路');start('武定路','武宁路');start('中宁路','真如',true);
  });

  it('schedules the real arrival through the existing player at its measured lead and keeps safety inside that original',()=>{
    const slot=bank.onboardAnnouncement('武宁路','DN','桂桥路','L')!,eta=slot.arrived!.advanceS;
    const speed=12,brake=dynamics.PERF.bPlan;
    const frame:OnboardAudioFrame={t:100,rate:1,paused:false,muted:false,enabled:true,willStop:true,destination:'桂桥路',doorSide:'L',
      train:{id:1,trip:'test',direction:'DN',mode:'DTO',manual:false,rm:false,failed:false,eb:false,inService:true,
        phase:'run',v:speed,a:-brake,distance:speed*(eta-speed/brake)+speed*speed/(2*brake),
        nextStation:data.STATIONS.findIndex(s=>s.name===slot.station),atStation:false,doors:false,doorClosing:false,dwellLeft:0}};
    const planner=new playback.OnboardSoundPlanner();
    const commands=planner.update(frame).filter(c=>c.kind==='play');
    expect(commands).toHaveLength(1);
    expect(commands[0].clips.map(c=>c.id)).toEqual(['line14-arrived-wng']);
    expect(commands[0].offsetS).toBeCloseTo(0,6);
    expect(planner.update({...frame,t:100.1}).filter(c=>c.kind==='play')).toEqual([]);
    expect(new playback.OnboardSoundPlanner().update({...frame,destination:'蓝天路'}).filter(c=>c.kind==='play')).toEqual([]);
    expect(new playback.OnboardSoundPlanner().update({...frame,doorSide:'R'}).filter(c=>c.kind==='play')).toEqual([]);
  });
});
