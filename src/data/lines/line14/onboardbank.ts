import { findOnboardAnnouncement } from '../../audioUtils';
import type { AnnouncementDoorSide, OnboardAnnouncement, OriginalAnnouncement, SoundClip, VoiceLanguage } from '../../types';

/** 用户2026-10-25实录。只有DN往桂桥路；缺站、缺语种不补字、不合成。
 * 站名与展望画面交叉核对，本地离线识别仅辅助句窗；逐片标置信度。
 * 下一站只取连续中文前段，未把未核清的英文尾段冒充完整双语。
 * 用户决定2026-10-25：武定路按上下站与X1301画面归站，保留原音，低置信度，不冒称听清。
 * WNG/DSJ到站保留连续中英及安全提示；HPN仅采用明确的英文到站段。
 * 边界在原样本±15ms内吸附安静过零点，独立片按D71归一化。
 */
export const VOICE_SOURCES = [
  { id:'line14-ride-1025',filename:'Sun 19.07 14真如~曹杨路.wav',recordedDate:'2026-10-25',durationS:232.58 },
  { id:'line14-cab-191137',filename:'VID_20261025_191137_DOLBY.mp4',recordedDate:'2026-10-25',durationS:140.202667 },
  { id:'line14-cab-191358',filename:'VID_20261025_191358_DOLBY.mp4',recordedDate:'2026-10-25',durationS:722.048 },
] as const;

interface FieldTake {
  id:string; station:string; type:'next'|'arrived'; side:AnnouncementDoorSide;
  source:string; range:[number,number]; language:VoiceLanguage;
  departureAt?:number; stopAt?:number;
  confidence?:SoundClip['confidence'];
  identification?:{method:string;evidence:readonly string[]};
}
/** departureAt/stopAt均为同源视频运动测量秒数，精度约±1秒。
 * 车厢录音的起动时刻未可靠测出，不捏造已测时序。
 */
export const LINE14_FIELD_TAKES: readonly FieldTake[] = [
  {id:'line14-next-znl',station:'中宁路',type:'next',side:'L',source:'line14-ride-1025',range:[7.74375,15.296667],language:'zh'},
  {id:'line14-next-cyl',station:'曹杨路',type:'next',side:'L',source:'line14-ride-1025',range:[145.749313,153.880792],language:'zh'},
  {id:'line14-next-wng',station:'武宁路',type:'next',side:'L',source:'line14-cab-191137',range:[15.448229,25.641792],language:'zh',departureAt:10},
  {id:'line14-next-wdl',station:'武定路',type:'next',side:'L',source:'line14-cab-191358',range:[12.031313,19.819146],language:'zh',departureAt:4,
    confidence:'low',identification:{method:'上下站/画面推断',evidence:['用户决定2026-10-25允许按上下站判断','已确认武宁路→武定路→静安寺','同源实际停站与X1301画面']}},
  {id:'line14-next-jas',station:'静安寺',type:'next',side:'L',source:'line14-cab-191358',range:[113.795813,124.808208],language:'zh',departureAt:108.2},
  {id:'line14-next-hpn',station:'一大会址·黄陂南路',type:'next',side:'R',source:'line14-cab-191358',range:[261.397625,272.62775],language:'zh',departureAt:255},
  {id:'line14-next-dsj',station:'大世界',type:'next',side:'L',source:'line14-cab-191358',range:[520.270521,530.406354],language:'zh',departureAt:514.2},
  {id:'line14-next-yy',station:'豫园',type:'next',side:'L',source:'line14-cab-191358',range:[638.952063,649.000917],language:'zh',departureAt:633.2},
  {id:'line14-arrived-wng',station:'武宁路',type:'arrived',side:'L',source:'line14-cab-191137',range:[68.180688,88.209938],language:'bilingual',stopAt:113},
  {id:'line14-arrived-hpn',station:'一大会址·黄陂南路',type:'arrived',side:'R',source:'line14-cab-191358',range:[423.349604,432.730792],language:'en',stopAt:461.1},
  {id:'line14-arrived-dsj',station:'大世界',type:'arrived',side:'L',source:'line14-cab-191358',range:[550.819146,570.757208],language:'bilingual',stopAt:597.9},
];
/** 【假设】仅两条车厢录音next缺起动锚点，采用本线6秒提示延迟。
 * 实测视频next通过measuredDelay显式使用其差值，不改变其他线路的均值设计。
 */
export const ONBOARD_NEXT_DELAY_S = 6;
export const ONBOARD_ARRIVAL_ADVANCE_S = 0;
export const ONBOARD_DESTINATIONS = ['桂桥路'] as const;
export const VOICE_CROSSFADE_S = .03;
// 复用D71的播放器音量档位；不是本线实车声压测量。当前无拼接，交叉淡化值不参与成片。
export const RECORDED_VOLUME_GAINS = {small:.6,medium:1,large:1.45} as const;
export const ORIGINAL_ONBOARD: readonly OriginalAnnouncement[] = LINE14_FIELD_TAKES.map(t=>({
  id:t.id,station:t.station,direction:'DN',type:t.type,source:t.source,recordedDestination:'桂桥路',
  range:t.range,confidence:t.confidence??'medium',doorSide:t.side,
  ...(t.type==='next'?{delayS:t.departureAt===undefined?ONBOARD_NEXT_DELAY_S:t.range[0]-t.departureAt}
    :{advanceS:t.stopAt!-t.range[0],measuredAdvance:true}),
}));
export const FIELD_ORIGINAL_ONBOARD = ORIGINAL_ONBOARD;
export const RECORDED_ONBOARD: OriginalAnnouncement[] = [...ORIGINAL_ONBOARD];

export const LINE14_SAFETY_CLIP: SoundClip = {
  id:'line14-safety-door-lights',file:'line14-safety-door-lights.mp3',kind:'interior-special',
  station:'中宁路',direction:'DN',side:'shared',source:'line14-ride-1025',range:[79.018583,82.860021],
  both:false,confidence:'medium',provenance:'original',recordedDirection:'DN',recordedDestination:'桂桥路',
};
/** 独立安全片供本地抽听；播放时安全句随原到站广播正文，不另造触发事件。 */
export const ONBOARD_RENDER_BANK: readonly SoundClip[] = [
  ...ORIGINAL_ONBOARD.map((a):SoundClip=>({id:a.id,file:`${a.id}.mp3`,
    kind:a.type==='next'?'interior-departure':'interior-arrival',station:a.station,direction:'DN',side:'shared',
    source:a.source,range:a.range,both:false,confidence:a.confidence,provenance:'original',
    recordedDirection:'DN',recordedDestination:'桂桥路',destination:'桂桥路',doorSide:a.doorSide})),
  LINE14_SAFETY_CLIP,
];
export const ONBOARD_ANNOUNCEMENTS: readonly OnboardAnnouncement[] = [...new Set(ORIGINAL_ONBOARD.map(a=>a.station))].map(station=>{
  const takes=ORIGINAL_ONBOARD.filter(a=>a.station===station),next=takes.find(a=>a.type==='next'),arrived=takes.find(a=>a.type==='arrived');
  const first=takes[0],missing=['英文下一站段未采用','下一站长安全提示未采用'];
  if(!arrived)missing.push('到站广播缺段');
  else if(LINE14_FIELD_TAKES.find(t=>t.id===arrived.id)?.language==='en')missing.push('中文到站段未采用');
  return {station,direction:'DN',destination:'桂桥路',doorSide:first.doorSide,source:first.source,missingSentences:missing,
    ...(next?{next:{clipId:next.id,phraseAt:next.range[0],delayS:next.delayS??ONBOARD_NEXT_DELAY_S,confidence:next.confidence,
      ...(LINE14_FIELD_TAKES.find(t=>t.id===next.id)?.departureAt!==undefined?{measuredDelay:true}:{})}}:{}),
    ...(arrived?{arrived:{clipId:arrived.id,phraseAt:arrived.range[0],advanceS:arrived.advanceS!,measuredAdvance:true,confidence:arrived.confidence}}:{})};
});
export function onboardAnnouncement(station:string,direction:'DN'|'UP',destination:string,side:AnnouncementDoorSide,catalog=ONBOARD_ANNOUNCEMENTS) {
  return findOnboardAnnouncement(station,direction,destination,side,catalog);
}
