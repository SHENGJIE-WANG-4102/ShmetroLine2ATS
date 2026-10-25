import { findOnboardAnnouncement } from '../../audioUtils';
import type { AnnouncementDoorSide, OnboardAnnouncement, OriginalAnnouncement, SoundClip, VoiceLanguage } from '../../types';

/** 用户2026-10-25实录。只有DN往桂桥路；缺站、缺语种不补字、不合成。
 * 站名与展望画面交叉核对，本地离线识别仅辅助句窗；逐片标置信度。
 * 用户2026-10-26试听确认：16条整段中英连续原音，含原换乘/安全正文。
 * 用户决定2026-10-25：武定路按上下站与X1301画面归站，保留原音，低置信度，不冒称听清。
 * 弱站名均按上下站/画面归属并保留low；不补字、不合成或中间拼接。
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
  timingBasis?:string;
  identification?:{method:string;evidence:readonly string[]};
}
/** departureAt/stopAt均为同源视频运动测量秒数，精度约±1秒。
 * 车厢录音的起动时刻未可靠测出，不捏造已测时序。
 */
export const LINE14_FIELD_TAKES: readonly FieldTake[] = [
  {"id":"line14-next-znl","station":"中宁路","type":"next","side":"L","source":"line14-ride-1025","range":[7.74375,36.19510416666667],"language":"bilingual","confidence":"medium"},
  {"id":"line14-arrived-znl","station":"中宁路","type":"arrived","side":"L","source":"line14-ride-1025","range":[60.490604166666664,86.494875],"language":"bilingual","confidence":"low","timingBasis":"【假设】无可靠停稳锚点，采用本线47秒默认提前量；不标实测","identification":{"method":"上下站/画面推断","evidence":["用户2026-10-26试听确认整条原音可用","沿线已确认的上下站顺序与实际画面/门侧归属"]}},
  {"id":"line14-next-cyl","station":"曹杨路","type":"next","side":"L","source":"line14-ride-1025","range":[145.7493125,184.95566666666667],"language":"bilingual","confidence":"medium"},
  {"id":"line14-arrived-cyl","station":"曹杨路","type":"arrived","side":"L","source":"line14-ride-1025","range":[184.95566666666667,205.99202083333333],"language":"bilingual","confidence":"low","timingBasis":"【假设】无可靠停稳锚点，采用本线47秒默认提前量；不标实测","identification":{"method":"上下站/画面推断","evidence":["用户2026-10-26试听确认整条原音可用","沿线已确认的上下站顺序与实际画面/门侧归属"]}},
  {"id":"line14-next-wng","station":"武宁路","type":"next","side":"L","source":"line14-cab-191137","range":[15.448229166666666,50.4894375],"language":"bilingual","confidence":"medium","departureAt":10},
  {"id":"line14-arrived-wng","station":"武宁路","type":"arrived","side":"L","source":"line14-cab-191137","range":[68.1806875,88.2151875],"language":"bilingual","confidence":"medium","stopAt":113},
  {"id":"line14-next-wdl","station":"武定路","type":"next","side":"L","source":"line14-cab-191358","range":[12.0313125,24.601854166666666],"language":"bilingual","confidence":"low","departureAt":4,"identification":{"method":"上下站/画面推断","evidence":["用户2026-10-26试听确认整条原音可用","沿线已确认的上下站顺序与实际画面/门侧归属"]}},
  {"id":"line14-arrived-wdl","station":"武定路","type":"arrived","side":"L","source":"line14-cab-191358","range":[37.49822916666667,60.002125],"language":"bilingual","confidence":"low","stopAt":81.8,"identification":{"method":"上下站/画面推断","evidence":["用户2026-10-26试听确认整条原音可用","沿线已确认的上下站顺序与实际画面/门侧归属"]}},
  {"id":"line14-next-jas","station":"静安寺","type":"next","side":"L","source":"line14-cab-191358","range":[113.7958125,150.09427083333333],"language":"bilingual","confidence":"medium","departureAt":108.2},
  {"id":"line14-arrived-jas","station":"静安寺","type":"arrived","side":"L","source":"line14-cab-191358","range":[167.00895833333334,201.99122916666667],"language":"bilingual","confidence":"low","stopAt":213.8,"identification":{"method":"上下站/画面推断","evidence":["用户2026-10-26试听确认整条原音可用","沿线已确认的上下站顺序与实际画面/门侧归属"]}},
  {"id":"line14-next-hpn","station":"一大会址·黄陂南路","type":"next","side":"R","source":"line14-cab-191358","range":[261.397625,300.400875],"language":"bilingual","confidence":"medium","departureAt":255},
  {"id":"line14-arrived-hpn","station":"一大会址·黄陂南路","type":"arrived","side":"R","source":"line14-cab-191358","range":[409.9908125,444.4036458333333],"language":"bilingual","confidence":"low","stopAt":461.1,"identification":{"method":"上下站/画面推断","evidence":["用户2026-10-26试听确认整条原音可用","沿线已确认的上下站顺序与实际画面/门侧归属"]}},
  {"id":"line14-next-dsj","station":"大世界","type":"next","side":"L","source":"line14-cab-191358","range":[520.2738958333333,539.1001041666667],"language":"bilingual","confidence":"medium","departureAt":514.2},
  {"id":"line14-arrived-dsj","station":"大世界","type":"arrived","side":"L","source":"line14-cab-191358","range":[550.8191458333333,570.7572083333333],"language":"bilingual","confidence":"medium","stopAt":597.9},
  {"id":"line14-next-yy","station":"豫园","type":"next","side":"L","source":"line14-cab-191358","range":[638.9580416666666,657.5983958333334],"language":"bilingual","confidence":"medium","departureAt":633.2},
  {"id":"line14-arrived-yy","station":"豫园","type":"arrived","side":"L","source":"line14-cab-191358","range":[675.0007708333334,699.9972083333333],"language":"bilingual","confidence":"low","timingBasis":"【假设】无可靠停稳锚点，采用本线47秒默认提前量；不标实测","identification":{"method":"上下站/画面推断","evidence":["用户2026-10-26试听确认整条原音可用","沿线已确认的上下站顺序与实际画面/门侧归属"]}},
];
/** 【假设】仅两条车厢录音next缺起动锚点，采用本线6秒提示延迟。
 * 实测视频next通过measuredDelay显式使用其差值，不改变其他线路的均值设计。
 */
export const ONBOARD_NEXT_DELAY_S = 6;
/** 【假设】五条视频实测advance均值46.8204s取整为47s；用户确认接线后，
 * 仅供两条ride及豫园无停稳锚点的到站片。000333任务回复批准，非实测标志。 */
export const ONBOARD_ARRIVAL_ADVANCE_S = 47;
export const ONBOARD_DESTINATIONS = ['桂桥路'] as const;
export const VOICE_CROSSFADE_S = .03;
// 复用D71的播放器音量档位；不是本线实车声压测量。当前无拼接，交叉淡化值不参与成片。
export const RECORDED_VOLUME_GAINS = {small:.6,medium:1,large:1.45} as const;
export const ORIGINAL_ONBOARD: readonly OriginalAnnouncement[] = LINE14_FIELD_TAKES.map(t=>({
  id:t.id,station:t.station,direction:'DN',type:t.type,source:t.source,recordedDestination:'桂桥路',
  range:t.range,confidence:t.confidence??'medium',doorSide:t.side,
  ...(t.type==='next'?{delayS:t.departureAt===undefined?ONBOARD_NEXT_DELAY_S:t.range[0]-t.departureAt}
    :{advanceS:t.stopAt===undefined?ONBOARD_ARRIVAL_ADVANCE_S:t.stopAt-t.range[0],measuredAdvance:t.stopAt!==undefined}),
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
  const first=takes[0],missing:string[]=[];
  if(!arrived)missing.push('到站广播缺段');
  else if(LINE14_FIELD_TAKES.find(t=>t.id===arrived.id)?.language==='en')missing.push('中文到站段未采用');
  return {station,direction:'DN',destination:'桂桥路',doorSide:first.doorSide,source:first.source,missingSentences:missing,
    ...(next?{next:{clipId:next.id,phraseAt:next.range[0],delayS:next.delayS??ONBOARD_NEXT_DELAY_S,confidence:next.confidence,
      ...(LINE14_FIELD_TAKES.find(t=>t.id===next.id)?.departureAt!==undefined?{measuredDelay:true}:{})}}:{}),
    ...(arrived?{arrived:{clipId:arrived.id,phraseAt:arrived.range[0],advanceS:arrived.advanceS!,measuredAdvance:!!arrived.measuredAdvance,confidence:arrived.confidence}}:{})};
});
export function onboardAnnouncement(station:string,direction:'DN'|'UP',destination:string,side:AnnouncementDoorSide,catalog=ONBOARD_ANNOUNCEMENTS) {
  return findOnboardAnnouncement(station,direction,destination,side,catalog);
}
