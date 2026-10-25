import type { SoundClip } from '../../types';

/** 用户2026-10-26试听确认10条连续门音，采用确定性随机。
 * 确认可用不等于认证机械起点；保留机械候选/缺锁闭时标的原始不确定性。
 * 关门整段已含提示与机械原音，仅生成一个warn-close，避免同源叠响。
 * 实录时长不改变开门/预警到动作/锁闭物理预算。 */
export const DOOR_SELECTION = 'random' as const;
export const DOOR_TAKES = [
  {"id":"wng-open","station":"武宁路","primary":false,"source":"line14-cab-191137","event":"open","confidence":"medium","previewFile":"open-01-cab191137-114.550-118.300-武宁路.mp3","preview":[114.55077083333333,118.30047916666666],"method":"用户2026-10-26试听确认；机械起点仍为频谱/停站上下文候选","mechanicalConfirmed":false,"open":[114.55077083333333,118.30047916666666],"mechanicalCandidateAt":114.85},
  {"id":"wdl-open","station":"武定路","primary":false,"source":"line14-cab-191358","event":"open","confidence":"medium","previewFile":"open-02-cab191358-83.250-87.900-武定路.mp3","preview":[83.24879166666666,87.90222916666667],"method":"用户2026-10-26试听确认；机械起点仍为频谱/停站上下文候选","mechanicalConfirmed":false,"open":[83.24879166666666,87.90222916666667],"mechanicalCandidateAt":83.45},
  {"id":"jas-open","station":"静安寺","primary":false,"source":"line14-cab-191358","event":"open","confidence":"medium","previewFile":"open-03-cab191358-215.550-220.500-静安寺.mp3","preview":[215.55270833333333,220.49810416666668],"method":"用户2026-10-26试听确认；机械起点仍为频谱/停站上下文候选","mechanicalConfirmed":false,"open":[215.55270833333333,220.49810416666668],"mechanicalCandidateAt":215.7},
  {"id":"hpn-open","station":"黄陂南路","primary":false,"source":"line14-cab-191358","event":"open","confidence":"medium","previewFile":"open-04-cab191358-461.750-468.800-黄陂南路.mp3","preview":[461.74429166666664,468.798375],"method":"用户2026-10-26试听确认；机械起点仍为频谱/停站上下文候选","mechanicalConfirmed":false,"open":[461.74429166666664,468.798375],"mechanicalCandidateAt":462.0},
  {"id":"dsj-open","station":"大世界","primary":false,"source":"line14-cab-191358","event":"open","confidence":"medium","previewFile":"open-05-cab191358-599.300-604.800-大世界.mp3","preview":[599.2948541666667,604.7937916666667],"method":"用户2026-10-26试听确认；机械起点仍为频谱/停站上下文候选","mechanicalConfirmed":false,"open":[599.2948541666667,604.7937916666667],"mechanicalCandidateAt":599.6},
  {"id":"znl-close","station":"中宁路","primary":false,"source":"line14-ride-1025","event":"close","confidence":"medium","previewFile":"close-01-ride1907-130.300-138.100-中宁路.mp3","preview":[130.30627083333334,138.08883333333333],"method":"用户2026-10-26试听确认；机械起点仍为频谱/停站上下文候选","mechanicalConfirmed":false,"warn":[130.30627083333334,138.08883333333333],"warningAt":130.405},
  {"id":"wdl-close","station":"武定路","primary":false,"source":"line14-cab-191358","event":"close","confidence":"medium","previewFile":"close-02-cab191358-97.650-105.000-武定路.mp3","preview":[97.645375,105.00091666666667],"method":"用户2026-10-26试听确认；机械起点仍为频谱/停站上下文候选","mechanicalConfirmed":false,"warn":[97.645375,105.00091666666667],"warningAt":97.85,"mechanicalCandidateAt":100.58,"close":[100.58,105.00091666666667]},
  {"id":"jas-close","station":"静安寺","primary":false,"source":"line14-cab-191358","event":"close","confidence":"medium","previewFile":"close-03-cab191358-244.550-252.000-静安寺.mp3","preview":[244.549375,252.00002083333334],"method":"用户2026-10-26试听确认；机械起点仍为频谱/停站上下文候选","mechanicalConfirmed":false,"warn":[244.549375,252.00002083333334],"warningAt":244.76,"mechanicalCandidateAt":247.58,"close":[247.58,252.00002083333334]},
  {"id":"hpn-close","station":"黄陂南路","primary":false,"source":"line14-cab-191358","event":"close","confidence":"medium","previewFile":"close-04-cab191358-503.950-511.400-黄陂南路.mp3","preview":[503.9409375,511.40316666666666],"method":"用户2026-10-26试听确认；机械起点仍为频谱/停站上下文候选","mechanicalConfirmed":false,"warn":[503.9409375,511.40316666666666],"warningAt":504.13,"mechanicalCandidateAt":506.93,"close":[506.93,511.40316666666666]},
  {"id":"dsj-close","station":"大世界","primary":false,"source":"line14-cab-191358","event":"close","confidence":"medium","previewFile":"close-05-cab191358-622.850-630.100-大世界.mp3","preview":[622.8471041666667,630.0976041666667],"method":"用户2026-10-26试听确认；机械起点仍为频谱/停站上下文候选","mechanicalConfirmed":false,"warn":[622.8471041666667,630.0976041666667],"warningAt":623.035,"mechanicalCandidateAt":626.0,"close":[626.0,630.0976041666667]},
 ] as const;

export const DOOR_BANK: readonly SoundClip[] = DOOR_TAKES.map(take => {
  const kind = take.event === 'open' ? 'door-motion-open' : 'door-warn-close';
  const id = `${kind}-${take.id}`;
  return {
    id, file: `${id}.mp3`, kind, station: take.station,
    direction: 'shared', side: 'shared', source: take.source, range: [...take.preview],
    confidence: take.confidence, provenance: 'original', both: false, fadeInS: .015, fadeOutS: .015,
  };
});
