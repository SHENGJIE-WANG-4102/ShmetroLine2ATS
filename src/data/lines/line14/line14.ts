import type { CoreLineData, StationData } from '../../types';

/** 里程、配线：全网配线 V2025.26.2，6倍逐站复核见 reference/line14/line14-layout-pdf.md。
 * dwell 是【假设】：官方120个首末班锚点与物理最短走行联合约束，5秒粒度；普通20～35秒、换乘30～60秒。
 * demand 是【假设】：换乘及中心城区权重较高、两端较低，未移用其他线路的客流。 */
export const STATIONS: StationData[] = [
  {"id": "FB", "name": "封浜", "interM": null, "transfers": [], "dwell": 20, "demand": 0.35},
  {"id": "LXL", "name": "乐秀路", "interM": 1721.179, "transfers": [], "dwell": 20, "demand": 0.45},
  {"id": "LTL", "name": "临洮路", "interM": 1626.988, "transfers": [], "dwell": 20, "demand": 0.55},
  {"id": "JYL", "name": "嘉怡路", "interM": 1471.205, "transfers": [], "dwell": 35, "demand": 0.65},
  {"id": "DBL", "name": "定边路", "interM": 1689.828, "transfers": [], "dwell": 20, "demand": 0.7},
  {"id": "ZXX", "name": "真新新村", "interM": 950.436, "transfers": [], "dwell": 35, "demand": 0.85},
  {"id": "ZGL", "name": "真光路", "interM": 1143.646, "transfers": [], "dwell": 25, "demand": 0.8},
  {"id": "TCL", "name": "铜川路", "interM": 1268.413, "transfers": ["15"], "dwell": 35, "demand": 1.2},
  {"id": "ZR", "name": "真如", "interM": 875.84, "transfers": ["11"], "dwell": 40, "demand": 1.3},
  {"id": "ZNL", "name": "中宁路", "interM": 1116.729, "transfers": [], "dwell": 35, "demand": 0.9},
  {"id": "CYL", "name": "曹杨路", "interM": 974.468, "transfers": ["3", "4", "11"], "dwell": 60, "demand": 1.6, "sidePlatform": ["UP"]},
  {"id": "WNG", "name": "武宁路", "interM": 1160.995, "transfers": ["13"], "dwell": 45, "demand": 1.2},
  {"id": "WDL", "name": "武定路", "interM": 761.204, "transfers": [], "dwell": 35, "demand": 1},
  {"id": "JAS", "name": "静安寺", "interM": 1178.697, "transfers": ["2", "7"], "dwell": 35, "demand": 1.8},
  {"id": "HPN", "name": "一大会址·黄陂南路", "interM": 2943.879, "transfers": ["1"], "dwell": 60, "demand": 1.7, "sidePlatform": ["DN", "UP"]},
  {"id": "DSJ", "name": "大世界", "interM": 803.473, "transfers": ["8"], "dwell": 45, "demand": 1.5},
  {"id": "YY", "name": "豫园", "interM": 949.9, "transfers": ["10"], "dwell": 35, "demand": 1.6},
  {"id": "LJZ", "name": "陆家嘴", "interM": 1464.522, "transfers": ["2"], "dwell": 60, "demand": 1.7},
  {"id": "PDN", "name": "浦东南路", "interM": 1070.283, "transfers": ["2"], "dwell": 45, "demand": 1.2},
  {"id": "PDD", "name": "浦东大道", "interM": 655.96, "transfers": ["4"], "dwell": 35, "demand": 1.2},
  {"id": "YSL", "name": "源深路", "interM": 1172.334, "transfers": [], "dwell": 25, "demand": 0.8, "sidePlatform": ["DN", "UP"]},
  {"id": "CYI", "name": "昌邑路", "interM": 884.722, "transfers": ["18"], "dwell": 40, "demand": 1.2},
  {"id": "XPL", "name": "歇浦路", "interM": 1347.29, "transfers": [], "dwell": 20, "demand": 0.7},
  {"id": "LJL", "name": "龙居路", "interM": 938.803, "transfers": [], "dwell": 0, "demand": 0, "opened": false},
  {"id": "YSN", "name": "云山路", "interM": 1882.663, "transfers": ["6"], "dwell": 30, "demand": 1.1},
  {"id": "LTN", "name": "蓝天路", "interM": 1271.387, "transfers": ["9"], "dwell": 30, "demand": 1.1},
  {"id": "HYL", "name": "黄杨路", "interM": 1916.529, "transfers": [], "dwell": 35, "demand": 0.6},
  {"id": "YSH", "name": "云顺路", "interM": 948.59, "transfers": [], "dwell": 35, "demand": 0.5},
  {"id": "PDZ", "name": "浦东足球场", "interM": 1523.883, "transfers": [], "dwell": 20, "demand": 0.65},
  {"id": "JYU", "name": "金粤路", "interM": 1315.132, "transfers": [], "dwell": 20, "demand": 0.4},
  {"id": "GQL", "name": "桂桥路", "interM": 1169.977, "transfers": [], "dwell": 20, "demand": 0.35},
];
export const STATION_EN = {"FB": "Fengbang", "LXL": "Lexiu Road", "LTL": "Lintao Road", "JYL": "Jiayi Road", "DBL": "Dingbian Road", "ZXX": "Zhenxin Xincun", "ZGL": "Zhenguang Road", "TCL": "Tongchuan Road", "ZR": "Zhenru", "ZNL": "Zhongning Road", "CYL": "Caoyang Road", "WNG": "Wuning Road", "WDL": "Wuding Road", "JAS": "Jing'an Temple", "HPN": "Site of the First CPC National Congress · South Huangpi Road", "DSJ": "Dashijie", "YY": "Yuyuan Garden", "LJZ": "Lujiazui", "PDN": "South Pudong Road", "PDD": "Pudong Avenue", "YSL": "Yuanshen Road", "CYI": "Changyi Road", "XPL": "Xiepu Road", "LJL": "Longju Road", "YSN": "Yunshan Road", "LTN": "Lantian Road", "HYL": "Huangyang Road", "YSH": "Yunshun Road", "PDZ": "Pudong Football Stadium", "JYU": "Jinyue Road", "GQL": "Guiqiao Road"};

/** PDF 示意不按比例。所有道岔偏移、存车线有效长度均为【假设】，按 185.6m 单列位与咽喉净空建模；不是 PDF 测距。 */
export const LAYOUT: CoreLineData['LAYOUT'] = {
  tails: [{ station: 0, side: 'west', length: 260, scissors: true }],
  pairs: [
    { id: 'ZXX', station: 5, side: 'west', at: -240, stubs: [
      { id: 'ZXX1', name: '真新新村1道折返线', length: 420, link: { main: 'UP', at: 375 } },
      { id: 'ZXX2', name: '真新新村2道折返线', length: 420, link: { main: 'DN', at: 375 } },
    ] },
    { id: 'LTN', station: 25, side: 'east', at: 240, stubs: [
      { id: 'LTN1', name: '蓝天路1道折返线', length: 420, link: { main: 'UP', at: 375 } },
      { id: 'LTN2', name: '蓝天路2道折返线', length: 420, link: { main: 'DN', at: 375 } },
    ] },
  ],
  // 【假设】双出入段线按正线正常方向分工：西端上行入/下行出，东端下行入/上行出；PDF仅证明双线连接，未标作业方向。
  sidings: [
    { id: 'FBD1', name: '封浜车辆段上行出入段线', station: 0, side: 'west', at: -490, length: 330, connect: 'UP', lane: 'outUP', turnback: false, lead: { depot: 'FBD', flow: 'in' } },
    { id: 'FBD2', name: '封浜车辆段下行出入段线', station: 0, side: 'west', at: -540, length: 330, connect: 'DN', lane: 'outDN', turnback: false, lead: { depot: 'FBD', flow: 'out' } },
    { id: 'GQD1', name: '桂桥路上行出入段线', station: 30, side: 'east', at: 500, length: 310, connect: 'UP', lane: 'outUP', lead: { depot: 'GQD', flow: 'out' } },
    { id: 'GQD2', name: '桂桥路下行出入段线', station: 30, side: 'east', at: 550, length: 310, connect: 'DN', lane: 'outDN', lead: { depot: 'GQD', flow: 'in' } },
    // 用户决定：跨线线段只画到PDF所示范围，正常运营不排车走；purpose 排除其存车/折返用途。
    { id: 'FB13', name: '往13号线西延联络线', station: 0, side: 'east', at: 300, length: 360, connect: 'DN', lane: 'outDN', turnback: false, purpose: 'interline' },
    { id: 'ZR11', name: '往11号线联络线', station: 8, side: 'east', at: -250, length: 500, connect: 'DN', lane: 'outDN', turnback: false, purpose: 'interline' },
  ],
  loops: [
    { id: 'CYL', name: '曹杨路中间存车线', station: 10, west: -260, east: 260 },
    { id: 'HPN', name: '黄陂南路中间存车线', station: 14, west: -260, east: 260 },
    { id: 'YSL', name: '源深路中间存车线', station: 20, west: -260, east: 260 },
  ],
  crossovers: [
    { station: 2, offset: 230, kind: '\\' },
    { station: 8, offset: -300, kind: '/' },
    { station: 22, offset: 230, kind: '\\' },
    { station: 28, offset: -230, kind: '\\' },
    { station: 30, offset: -240, kind: '/' },
    { station: 30, offset: 180, kind: '/' },
    { station: 30, offset: 300, kind: '\\' },
  ],
  depots: [
    { id: 'FBD', name: '封浜车辆段', short: '封浜', station: 0, stablingTracks: 16, capacity: 16, exitTime: 210,
      work: { daily: true, monthly: true, overhaul: false }, source: 'pdf-peixian；16+16后16灰字按远期【假设】；列检/月检作业能力及210秒出段【假设】' },
    { id: 'GQD', name: '金桥定修段', short: '金桥', station: 30, stablingTracks: 36, capacity: 36, exitTime: 210,
      work: { daily: true, monthly: true, overhaul: true }, source: 'pdf-peixian：14号线36(8A)；作业能力及210秒出段【假设】' },
  ],
  // 【假设】按道岔站把线路分成三个近似均衡的控制区；不是实线ZC边界。
  zones: [
    { id: 'ZC1', name: 'ZC1 封浜—真如', fromStation: 0, toStation: 8 },
    { id: 'ZC2', name: 'ZC2 中宁路—浦东大道', fromStation: 9, toStation: 19 },
    { id: 'ZC3', name: 'ZC3 源深路—桂桥路', fromStation: 20, toStation: 30 },
  ],
  maxSectionLength: 420, // 【假设】计轴区段离散化尺度，非实线闭塞分区长度。
};

/** 高峰间隔仅此一处。往封浜早高峰400秒为官方平均默认值【待实测】。 */
export const HEADWAYS = { morning: { DN: 360, UP: 400 }, evening: 480, offPeak: 510, weekend: 420 } as const;
export const OPERATIONS: CoreLineData['OPERATIONS'] = {
  // 【假设】14A01缺公开检修周期；仅仿真调度预算，与2号线不同的保守占位。
  maintenance: { dailyLimit: 14, monthlyPeriod: 55, monthlyLimit: 85, monthlyDays: 1, overhaulDays: 28, overhaulCount: 1 },
  intervalTrainLimits: STATIONS.slice(0, -1).map((s, i) => ({ from: s.id, to: STATIONS[i + 1].id, limit: 1 })), // 【假设】每方向每区间1列
  randomFaults: {
    // 【假设】全地下UTO训练故障预算，不是故障率统计；没有露天风雨设备故障。
    levels: [{ count: 3, majorProbability: .08 }, { count: 7, majorProbability: .2 }, { count: 12, majorProbability: .4 }],
    crowdWindows: [[7 * 3600, 9.5 * 3600], [(16 * 60 + 40) * 60, 20 * 3600]],
    kinds: [
      { kind: 'door', weight: 4, scope: 'passenger', vehicle: true, minLevel: 1 },
      { kind: 'psd', weight: 4, scope: 'passenger', minLevel: 1 },
      { kind: 'pecu', weight: 3, scope: 'passenger', vehicle: true, minLevel: 1 },
      { kind: 'surge', weight: 3, scope: 'peak', minLevel: 1 },
      { kind: 'trainComm', weight: 2, scope: 'passenger', vehicle: true, minLevel: 1 },
      { kind: 'trainUto', weight: 3, scope: 'passenger', vehicle: true, minLevel: 1 },
      { kind: 'switch', weight: 1, scope: 'all', minLevel: 2 },
      { kind: 'axle', weight: 1, scope: 'all', minLevel: 2 },
      { kind: 'signal', weight: 1, scope: 'all', minLevel: 2 },
      { kind: 'zcFail', weight: .5, scope: 'all', minLevel: 3 },
    ],
    majorKinds: ['traction', 'brake'],
  },
  // 官方：West=封浜，East=桂桥路；big/late都指全程末班，不另造夜间短交路。
  firstWestTerminusDep: 5.5 * 3600, firstEastTerminusDep: 5.5 * 3600,
  lastBigEastboundDep: 22.5 * 3600, lastLateEastboundDep: 22.5 * 3600,
  lastBigWestboundDep: 22.5 * 3600, lastBigWestboundArrival: (23 * 60 + 37) * 60,
  peakCoreHeadway: HEADWAYS.morning.DN / 2,
  minTurnback: { FB: 150, GQL: 150, ZXX: 150, LTN: 150 }, // 【假设】含驶入折返线、换端、驶出
  platformTurnClear: {},
  depotReturns: [{ depot: 'FBD', dir: 'UP', station: 'FB' }, { depot: 'GQD', dir: 'DN', station: 'GQL' }],
  // 用户决定：三列正线过夜；feeder使用已有存车线泊位规则。
  overnightStabling: [
    { station: 'CYL', count: 1, departure: 'UP', kind: 'feeder', preserveService: true, nightAfter: 22.5 * 3600 },
    { station: 'HPN', count: 1, departure: 'UP', kind: 'feeder', preserveService: true, nightAfter: 22.5 * 3600 },
    { station: 'YSL', count: 1, departure: 'DN', kind: 'feeder', preserveService: true, nightAfter: 22.5 * 3600 },
  ],
  hotStandby: [
    { station: 'CYL', track: 'storage', berth: 0, depot: 'FBD', incoming: 'DN', alternatives: [{ depot: 'GQD', incoming: 'UP' }] },
    { station: 'HPN', track: 'storage', berth: 0, depot: 'FBD', incoming: 'DN', alternatives: [{ depot: 'GQD', incoming: 'UP' }] },
    { station: 'YSL', track: 'storage', berth: 0, depot: 'GQD', incoming: 'UP', alternatives: [{ depot: 'FBD', incoming: 'DN' }] },
    { station: 'ZXX', track: 'turnback', berth: 1, optional: true, depot: 'FBD', incoming: 'DN', alternatives: [{ depot: 'GQD', incoming: 'UP' }] },
    { station: 'LTN', track: 'turnback', berth: 1, optional: true, depot: 'GQD', incoming: 'UP', alternatives: [{ depot: 'FBD', incoming: 'DN' }] },
  ],
  platformPassKmh: 45, platformStopKmh: Infinity,
  autoDoorOpenDelay: [0.5, 1.5], // 同2号线，同为8A自动门动作预算【假设】，无14A01实测
  reverseKmh: 5, // 用户决定：沿用人工退行限速
  depotDoorTests: { FBD: { beforeSignal: 5 }, GQD: { beforeSignal: 5 } }, // 【假设】未建库内试验线，以出段信号前5米代替
  sectionRunAllowanceS: 16, // 【假设】物理最短走行之上统一16秒，联合停站拟合官方120锚点；不是逐段补时刻
  sectionCruiseMinKmh: 12, sectionCoastMinKmh: 60, passRunMargin: .16, // 同2号线：通用ATO数值积分预算【假设】
  autoStartDelay: [1, 2], // 【假设】FAM自动发车确认延时
  atoDriverWork: { postLockExtraS: 0, turnbackExtraS: { rear: 0, front: 0 }, turnbackDoorCycles: { rear: 1, front: 1 }, legacyEndChangeS: 45 }, // 【假设】FAM不叠加司机作业；人工换端45秒
  atoRandomOverrunProbability: .0002, // 【假设】每次进站万分之二，全年独立触发
  // 所有秒数/概率均【假设】，流程依据用户提供的FAM接管口径，不是实线SOP。
  uto: { crewLabel: '随车人员', doorWarningS: 3, turnbackS: 15, wakeLeadS: 900,
    powerS: 20, pantographS: 15, selfTestS: 45, clearS: 30, washEvery: 4, washS: 180,
    // 【假设】随机接管自07:00起，所抽车辆最早触发窗口相隔1800秒。
    takeoverStepS: [5, 3, 2, 3, 5], randomTakeoversPerDay: 3, randomTakeoverFromS: 7 * 3600, randomTakeoverSpacingS: 1800, manualDurationS: 1200, resetS: 30, resetSuccess: .7 },
};

export const LINE14_CORE: CoreLineData = {
  SOURCES: [
    { id: 'pdf-peixian', title: '上海轨道交通全网配线V2025.26.2', url: 'reference/上海轨道交通全网配线V2025.26.2.pdf', used: '31站里程、站台、道岔/存车线拓扑、两基地容量；6倍逐站复核' },
    { id: 'official-timetable', title: '14号线官方首末班/运行间隔（用户截图）', url: 'reference/line14/line14-official-timetable.md', used: '首末班、分时段间隔，优先于历史公告' },
    { id: 'vehicle-supplier', title: '14号线首列列车下线，供应商供稿', url: 'http://umt1998.tongji.edu.cn/cn/article/pdf/preview/10.16037/j.1007-869x.2019.10.023.pdf', used: '185.6米、8节A型、49列；2019(10)p94' },
    { id: 'field-cab', title: '14号线司机室实拍', url: 'reference/line14/line14-field-cab-2025-09-05.md', used: '最高运行速度80km/h、ATPM/FAM' },
    { id: 'field-pis', title: '歇浦路PIS实拍', url: 'reference/line14/line14-field-pis-2026-10-22.md', used: '英文Road写全、8车厢' },
    { id: 'wiki-14a01', title: '上海地铁14A01型电动列车（C级）', url: 'https://zh.wikipedia.org/wiki/上海地铁14A01型电动列车', used: '14001—14049、6M2T编组；容量1860/2460为C级候选【假设】' },
  ],
  STATIONS, STATION_EN,
  LINE_INFO: { name: '上海轨道交通14号线', shortName: '14号线', color: 0x626020, colorCss: '#626020',
    trainLength: 185.6, platformLength: 190, maxSpeedKmh: 80, capacity: 1860, crushCapacity: 2460, fleet: 49, cars: 8 }, // 【假设】站台190米；载客容量C级候选，未称为AW2/AW3
  FLEET_TYPES: [{ type: '14A01', from: 14001, to: 14049, digits: 5, source: 'wiki-14a01（C级）：Tc+Mp+M+Mp+M+M+Mp+Tc；供应商49列8节' }],
  FLEET: Array.from({ length: 49 }, (_, i) => ({ no: String(14001 + i), type: '14A01', n: 14001 + i })),
  DIRECTIONS: { DN: { label: '下行', towards: '桂桥路', prefix: '14' }, UP: { label: '上行', towards: '封浜', prefix: '14' } },
  LAYOUT, SPEED_LIMITS: [],
  TURNOUT_SPEEDS: { crossover: 35, siding: 30, depot: 25, tail: 40 }, // 同2号线，9/12号道岔通用仿真限速【假设】，无14号线道岔限速表
  OPERATIONS,
  EXPOSED: [], // 官方工程资料：正线全地下；不对基地内部推断露天范围
  PROFILE_ANCHORS: { elevatedFrom: Infinity, groundFrom: Infinity },
  WEATHER_RULES: { wind: [], rain: { label: '暴雨', kmh: 80, elevatedOnly: true } }, // 【假设】正线无露天段，不从外界天气推断隧道限速
  POSSESSIONS: { candidates: [2, 6, 9, 12, 19, 21, 25, 28], morningUntil: 4.5 * 3600, nightFrom: 24 * 3600, nightTo: 27 * 3600 }, // 【假设】夜间训练施工窗与候选区段
};
