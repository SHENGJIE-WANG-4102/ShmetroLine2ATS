import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import type {SoundClip} from '../src/data/types';
import type {OnboardAudioFrame} from '../src/ui/onboardaudio';
import type {DoorAudioFrame} from '../src/ui/dooraudio';
import type {StationSoundCommand} from '../src/ui/stationaudio';

describe('line 14 recorded carriage PA',()=>{
  let data:typeof import('../src/data/current');
  let bank:typeof import('../src/data/lines/line14/onboardbank');
  let facade:typeof import('../src/data/audio/onboardbank');
  let playback:typeof import('../src/ui/onboardaudio');
  let dynamics:typeof import('../src/sim/dynamics');
  let doors:typeof import('../src/ui/dooraudio');
  let doorbank:typeof import('../src/data/lines/line14/doorbank');
  beforeAll(async()=>{
    vi.stubEnv('ATS_LINE','14');vi.resetModules();
    data=await import('../src/data/current');bank=await import('../src/data/lines/line14/onboardbank');
    facade=await import('../src/data/audio/onboardbank');
    playback=await import('../src/ui/onboardaudio');dynamics=await import('../src/sim/dynamics');
    doors=await import('../src/ui/dooraudio');doorbank=await import('../src/data/lines/line14/doorbank');
  });
  afterEach(()=>vi.unstubAllGlobals());
  afterAll(()=>{vi.unstubAllEnvs();vi.resetModules();});

  function doorFrame(t:number,station:number,open:boolean,closing=false):DoorAudioFrame {
    return {t,rate:1,paused:false,muted:false,enabled:true,selectionKey:'train|1',perspective:'onboard',station:null,
      trains:[{id:1,trip:'14001',direction:'DN',mode:'DTO',manual:false,rm:false,failed:false,eb:false,inService:true,
        phase:'dwell',v:0,a:0,distance:0,nextStation:station,atStation:true,doors:open,doorClosing:closing,dwellLeft:30}]};
  }
  function plays(commands:readonly StationSoundCommand[]) {
    return commands.filter((c):c is Extract<StationSoundCommand,{kind:'play'}>=>c.kind==='play');
  }
  function audioContext() {
    const starts:ReturnType<typeof vi.fn>[]=[];
    const ctx={state:'running',currentTime:5,decodeAudioData:vi.fn(async()=>({duration:30})),
      createBufferSource:()=>{
        const start=vi.fn();starts.push(start);
        return {start,stop:vi.fn(),disconnect:vi.fn(),connect:(gain:unknown)=>gain,onended:null,playbackRate:{value:1}};
      },
      createGain:()=>({gain:{value:0,cancelScheduledValues:vi.fn(),setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn(),setTargetAtTime:vi.fn()},connect:vi.fn(),disconnect:vi.fn()})};
    return {ctx:ctx as unknown as AudioContext,starts};
  }

  it('resolves current-line samples without importing any other line recordings',()=>{
    const audio=data.LINE.audio;
    expect(audio.soundbank.SOUNDBANK_DIRECTORY).toBe('sounds/line14');
    expect(audio.soundbank.SOUND_BANK).toHaveLength(27);
    expect(new Set(audio.soundbank.SOUND_BANK.map(c=>c.id)).size).toBe(27);
    for(const clip of audio.soundbank.SOUND_BANK){
      expect(clip.source.startsWith('line14-')).toBe(true);
      expect(clip.file).toBe(`${clip.id}.mp3`);
      expect(clip.provenance).toBe('original');expect(clip.composition).toBeUndefined();
      const lowIds=['line14-next-wdl',...['znl','cyl','wdl','jas','hpn','yy'].map(id=>`line14-arrived-${id}`)];
      expect(clip.confidence).toBe(lowIds.includes(clip.id)?'low':'medium');
      const source=bank.VOICE_SOURCES.find(s=>s.id===clip.source)!;
      expect(source).toBeDefined();expect(clip.range[0]).toBeGreaterThanOrEqual(0);
      expect(clip.range[1]).toBeLessThanOrEqual(source.durationS);
      expect(clip.range[1]-clip.range[0]).toBeGreaterThan(0);
    }
    expect(audio.doorbank.DOOR_BANK).toHaveLength(10);expect(audio.doorbank.DOOR_TAKES).toHaveLength(10);
    expect(audio.soundbank.SOUND_BANK.filter(c=>c.kind==='interior-departure'||c.kind==='interior-arrival')).toHaveLength(16);
    expect(audio.vvvf.VVVF_TAKES).toEqual([]);
    expect(audio.onboardbank.VOICE_PARTS).toEqual([]);
  });

  it('connects the user-confirmed partial door takes for random selection without duplicating closing sound',()=>{
    expect(doorbank.DOOR_TAKES.filter(t=>t.event==='open')).toHaveLength(5);
    expect(doorbank.DOOR_TAKES.filter(t=>t.event==='close')).toHaveLength(5);
    expect(doorbank.DOOR_BANK).toHaveLength(10);
    expect(new Set(doorbank.DOOR_TAKES.map(t=>t.id)).size).toBe(10);
    for(const take of doorbank.DOOR_TAKES){
      expect(take.confidence).toBe('medium');expect(take.mechanicalConfirmed).toBe(false);
      expect(take.method).toContain('用户2026-10-26');
      expect(take.primary).toBe(false);expect('lockedAt' in take).toBe(false);
      const source=bank.VOICE_SOURCES.find(s=>s.id===take.source)!;
      expect(source).toBeDefined();expect(take.preview[0]).toBeGreaterThanOrEqual(0);
      expect(take.preview[1]).toBeLessThanOrEqual(source.durationS);
      expect(take.preview[1]).toBeGreaterThan(take.preview[0]);
      if(take.event==='open')expect('warn' in take).toBe(false);
      else expect('open' in take).toBe(false);
    }
    // Each closing clip already includes its warning and mechanism continuously.
    expect(doorbank.DOOR_BANK.filter(c=>c.kind==='door-warn-close')).toHaveLength(5);
    expect(doorbank.DOOR_BANK.some(c=>c.kind==='door-motion-close')).toBe(false);
    expect(data.LINE.audio.doorbank.DOOR_TAKES).toBe(doorbank.DOOR_TAKES);
    expect(data.LINE.audio.doorbank.DOOR_SELECTION).toBe('random');
    for(const clip of doorbank.DOOR_BANK)expect(data.LINE.audio.soundbank.SOUND_BANK).toContain(clip);
    expect(data.LINE.audio.doorbank.DOOR_REFERENCE_TIMING).toEqual({openingS:2.5,warningToMotionS:2.2,motionToLockedS:4.5});
  });

  it.each(['open','close'] as const)('random %s recordings vary by station and repeat for the same trip and station',event=>{
    const kind=event==='open'?'door-motion-open':'door-warn-close';
    const eligible=new Set<string>(doorbank.DOOR_TAKES.filter(t=>t.event===event).map(t=>t.id));
    const pick=(station:number)=>{
      const planner=new doors.DoorSoundPlanner();
      planner.update(doorFrame(100,station,event==='close'));
      const result=planner.update(doorFrame(100.2,station,true,event==='close'));
      expect(result.events).toHaveLength(1);expect(result.events[0].kind).toBe(event);
      const take=result.events[0].take!;expect(eligible.has(take)).toBe(true);
      expect(plays(result.commands).map(c=>c.clips[0].id)).toEqual([`${kind}-${take}`]);
      // A whole closing recording must not spawn a second mechanical track.
      expect(plays(planner.update(doorFrame(103,station,true,event==='close')).commands)).toEqual([]);
      return take;
    };
    const picks=data.STATIONS.map((_,station)=>pick(station));
    expect(new Set(picks).size).toBeGreaterThanOrEqual(2);
    for(const station of [0,10,14,30])expect(pick(station)).toBe(picks[station]);
  });

  it.each(['open','close'] as const)('real DoorAudio uses a recorded partial %s take without a synthetic fallback',async event=>{
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(1)})));
    const {ctx,starts}=audioContext(),fallback=vi.fn();
    const kind=event==='open'?'door-motion-open':'door-warn-close';
    // An opening has no warning clip; a whole closing has no separate motion clip.
    const partialBank=data.LINE.audio.soundbank.SOUND_BANK.filter(c=>c.kind===kind);
    expect(partialBank).toHaveLength(5);
    const audio=new doors.DoorAudio(ctx,{} as AudioNode,fallback,partialBank);
    await new Promise(resolve=>setTimeout(resolve,0));
    audio.update(doorFrame(100,14,event==='close'));
    audio.update(doorFrame(100.2,14,true,event==='close'));
    expect(starts).toHaveLength(1);expect(starts[0]).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    audio.update(doorFrame(103,14,true,event==='close'));
    expect(starts).toHaveLength(1);expect(fallback).not.toHaveBeenCalled();audio.reset();
    // Keep the genuine missing-recording fallback, rather than muting it globally.
    const missingFallback=vi.fn(),missing=new doors.DoorAudio(audioContext().ctx,{} as AudioNode,missingFallback,[]);
    missing.update(doorFrame(100,14,event==='close'));
    missing.update(doorFrame(100.2,14,true,event==='close'));
    expect(missingFallback).toHaveBeenCalledExactlyOnceWith(event==='close',1);missing.reset();
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
    expect(hpn.missingSentences).not.toContain('中文到站段未采用');
  });

  it('retains all sixteen continuous bilingual calls and the original weak-station confidence',()=>{
    const stations=['中宁路','曹杨路','武宁路','武定路','静安寺','一大会址·黄陂南路','大世界','豫园'];
    for(const type of ['next','arrived'] as const){
      expect(bank.ORIGINAL_ONBOARD.filter(t=>t.type===type).map(t=>t.station).sort()).toEqual([...stations].sort());
    }
    expect(bank.LINE14_FIELD_TAKES.every(t=>t.language==='bilingual')).toBe(true);
    const weakArrival=new Set(['中宁路','曹杨路','武定路','静安寺','一大会址·黄陂南路','豫园']);
    for(const slot of bank.ONBOARD_ANNOUNCEMENTS){
      expect(slot.next).toBeDefined();expect(slot.arrived).toBeDefined();
      expect(slot.next!.confidence).toBe(slot.station==='武定路'?'low':'medium');
      expect(slot.arrived!.confidence).toBe(weakArrival.has(slot.station)?'low':'medium');
      for(const missing of ['到站广播缺段','英文下一站段未采用','下一站长安全提示未采用','中文到站段未采用'])
        expect(slot.missingSentences).not.toContain(missing);
    }
    const wdl=bank.onboardAnnouncement('武定路','DN','桂桥路','L')!;
    expect(bank.LINE14_FIELD_TAKES.find(t=>t.id===wdl.next!.clipId)?.identification).toMatchObject({method:'上下站/画面推断'});
    expect(bank.LINE14_SAFETY_CLIP.kind).toBe('interior-special');
    expect(data.LINE.audio.onboardbank.ONBOARD_HOLD_CLIP.id).toBe('');
  });

  it('uses same-source motion anchors and leaves unmeasured recording delays explicit',()=>{
    const next=(station:string)=>bank.ONBOARD_ANNOUNCEMENTS.find(s=>s.station===station)!.next!;
    for(const take of bank.LINE14_FIELD_TAKES.filter(t=>t.type==='next')){
      const slot=next(take.station);
      if(take.departureAt!==undefined){
        expect(slot.measuredDelay).toBe(true);
        expect(slot.delayS).toBeCloseTo(take.range[0]-take.departureAt,9);
        expect(slot.delayS).toBeGreaterThan(0);expect(slot.delayS).toBeLessThan(9);
      }else{
        expect(slot.delayS).toBe(6);expect(slot.measuredDelay).not.toBe(true);
      }
    }
    expect(bank.LINE14_FIELD_TAKES.filter(t=>t.type==='next'&&t.departureAt!==undefined)).toHaveLength(6);
    const clips=new Map<string,SoundClip>(data.LINE.audio.soundbank.SOUND_BANK.map(c=>[c.id,c]));
    const measured=new Map([['武宁路',113],['武定路',81.8],['静安寺',213.8],['一大会址·黄陂南路',461.1],['大世界',597.9]]);
    expect(data.LINE.audio.onboardbank.ONBOARD_ARRIVAL_ADVANCE_S).toBe(47);
    for(const take of bank.LINE14_FIELD_TAKES.filter(t=>t.type==='arrived')){
      const arrival=bank.ONBOARD_ANNOUNCEMENTS.find(s=>s.station===take.station)!.arrived!;
      if(measured.has(take.station)){
        expect(take.stopAt).toBe(measured.get(take.station));expect(arrival.measuredAdvance).toBe(true);
        expect(arrival.advanceS+clips.get(arrival.clipId)!.range[0]).toBeCloseTo(take.stopAt!,9);
      }else{
        expect(take.stopAt).toBeUndefined();expect(arrival.measuredAdvance).not.toBe(true);
        expect(arrival.advanceS).toBe(47);
      }
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

  it('finishes the actual long Caoyang next message before starting its whole arrival from offset zero',()=>{
    const slot=bank.onboardAnnouncement('曹杨路','DN','桂桥路','L')!;
    const audio=data.LINE.audio.soundbank;
    const nextClip=audio.SOUND_BANK.find(c=>c.id===slot.next!.clipId)!;
    const nextLength=audio.clipDuration(nextClip);
    expect(nextLength).toBeGreaterThan(39);
    const departure=100.2,stop=departure+86.7,speed=12,brake=dynamics.PERF.bPlan;
    const origin=data.STATIONS.findIndex(s=>s.name==='中宁路'),target=data.STATIONS.findIndex(s=>s.name==='曹杨路');
    const frame=(t:number,dwell=false,onset=false):OnboardAudioFrame=>{
      const eta=stop-t;
      return {t,rate:1,paused:false,muted:false,enabled:true,willStop:true,destination:'桂桥路',doorSide:'L',
        train:{id:1,trip:'14001',direction:'DN',mode:'DTO',manual:false,rm:false,failed:false,eb:false,inService:true,
          phase:dwell?'dwell':'run',v:dwell ? 0 : onset ? .005 : speed,a:-brake,
          distance:speed*(eta-speed/brake)+speed*speed/(2*brake),nextStation:dwell?origin:target,
          atStation:dwell,doors:false,doorClosing:false,dwellLeft:0}};
    };
    const planner=new playback.OnboardSoundPlanner();
    planner.update(frame(100,true));planner.update(frame(departure,false,true));
    const speech:{id:string;at:number;offset:number}[]=[];
    for(let i=1;i<=700;i++){
      const t=Number((departure+i*.1).toFixed(3));
      for(const command of plays(planner.update(frame(t))))
        speech.push({id:command.clips[0].id,at:t,offset:command.offsetS});
    }
    expect(speech.map(c=>c.id)).toEqual([slot.next!.clipId,slot.arrived!.clipId]);
    const [next,arrival]=speech;
    expect(next.offset).toBeCloseTo(0,9);
    expect(arrival.at).toBeGreaterThan(stop-47);
    expect(arrival.at).toBeGreaterThanOrEqual(next.at+nextLength-.000001);
    expect(arrival.at).toBeLessThanOrEqual(next.at+nextLength+.101);
    expect(arrival.offset).toBe(0);
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
