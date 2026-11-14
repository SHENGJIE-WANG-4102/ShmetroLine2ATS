import type { CoreLineData, CrossoverDef, DepotDef, PairDef, SidingDef, StationData, TailDef } from '../../types';
import { LINE14_CORE } from '../line14/line14';

/** 11号线：嘉定北—迪士尼主线，花桥—上海赛车场支线在嘉定新城汇入。
 *
 * 站序、站间距、配线依据：
 * - reference/line11/line11-layout-pdf.md（全网配线 V2025.26.2 逐站读图）
 * - reference/line11/official-timetable.md（官方首末班、分时段间隔）
 * - docs/design-decisions-line11.md（L11-01～10）
 * 支线写在主线前面（L11-06）：花桥→上海赛车场，上海赛车场 joins 嘉定新城；
 * 主线从嘉定北写到迪士尼。整张表从头到尾都是下行方向。
 *
 * dwell 是【假设】：官方首末班只给到分钟、没有逐站实测；普通站 20～30 s，换乘大站
 * 30～35 s，曹杨路按用户口述 50 s（司机换班）。demand 也是【假设】，只用于客流形状。
 */
export const STATIONS: StationData[] = [
  // ---- 花桥支线（0～6），上海赛车场 joins 嘉定新城 ----
  { id: 'HQ', name: '花桥', interM: null, transfers: ['苏州11'], dwell: 30, demand: 0.55 },
  { id: 'GML', name: '光明路', interM: 1267, transfers: [], dwell: 20, demand: 0.45 },
  { id: 'ZFL', name: '兆丰路', interM: 3300, transfers: [], dwell: 20, demand: 0.45 },
  { id: 'AT', name: '安亭', interM: 1128, transfers: [], dwell: 25, demand: 0.6 },
  { id: 'SQC', name: '上海汽车城', interM: 1844, transfers: [], dwell: 20, demand: 0.4 },
  { id: 'CJL', name: '昌吉东路', interM: 2286, transfers: [], dwell: 20, demand: 0.35 },
  { id: 'SSC', name: '上海赛车场', interM: 5382.7, transfers: [], dwell: 25, demand: 0.35,
    // 配线文档第二节：花桥方向下行列车走站台西侧的支线到达线 B，停自己的岛式西面，
    // 过站台后在交叉渡线以南并入中间股道（下行的 at 为正）；上行从东侧上行正线
    // 在站台北端分出 A 线，绕站台北侧去花桥（at 为负）。上行使用共用站台面，
    // 所以 UP 不写 platform。at=±700 m 是按站台半长和渡线位置取的【假设】，
    // PDF 不按比例，不是测距。
    joins: { station: 'JDC', interM: 3118.3, DN: { at: 700, platform: true }, UP: { at: -700 } } },

  // ---- 主线（7～39），嘉定北→迪士尼 ----
  { id: 'JDB', name: '嘉定北', interM: null, transfers: [], dwell: 30, demand: 0.55 },
  { id: 'JDX', name: '嘉定西', interM: 1944, transfers: [], dwell: 20, demand: 0.45 },
  { id: 'BYL', name: '白银路', interM: 3919, transfers: [], dwell: 20, demand: 0.4 },
  { id: 'JDC', name: '嘉定新城', interM: 1887, transfers: [], dwell: 25, demand: 0.55 },
  { id: 'ML', name: '马陆', interM: 2896, transfers: [], dwell: 20, demand: 0.4 },
  { id: 'CXL', name: '陈翔公路', interM: 3891, transfers: [], dwell: 20, demand: 0.35 },
  { id: 'NX', name: '南翔', interM: 1955, transfers: [], dwell: 25, demand: 0.5 },
  { id: 'TPX', name: '桃浦新村', interM: 3237, transfers: [], dwell: 20, demand: 0.45 },
  { id: 'WWL', name: '武威路', interM: 1637.4, transfers: [], dwell: 20, demand: 0.45 },
  { id: 'QLS', name: '祁连山路', interM: 1277.6, transfers: [], dwell: 20, demand: 0.45 },
  { id: 'LZY', name: '李子园', interM: 1380, transfers: [], dwell: 20, demand: 0.45 },
  { id: 'SXZ', name: '上海西站', interM: 1310, transfers: ['15'], dwell: 30, demand: 0.6 },
  { id: 'ZR', name: '真如', interM: 1578.0, transfers: ['14'], dwell: 30, demand: 0.7 },
  { id: 'FQL', name: '枫桥路', interM: 1119.0, transfers: [], dwell: 20, demand: 0.55 },
  { id: 'CYL', name: '曹杨路', interM: 722, transfers: ['3', '4', '14'], dwell: 50, demand: 0.85 },
  { id: 'LDL', name: '隆德路', interM: 1012, transfers: ['13'], dwell: 25, demand: 0.65 },
  { id: 'JSL', name: '江苏路', interM: 1357, transfers: ['2'], dwell: 25, demand: 0.8 },
  { id: 'JTD', name: '交通大学', interM: 2654, transfers: ['10'], dwell: 25, demand: 0.8 },
  { id: 'XJH', name: '徐家汇', interM: 905, transfers: ['1', '9'], dwell: 35, demand: 1.0 },
  { id: 'YYG', name: '上海游泳馆', interM: 1764, transfers: [], dwell: 20, demand: 0.5 },
  { id: 'LH', name: '龙华', interM: 1466, transfers: ['12'], dwell: 25, demand: 0.6 },
  { id: 'YJL', name: '云锦路', interM: 945, transfers: [], dwell: 20, demand: 0.5 },
  { id: 'LYL', name: '龙耀路', interM: 835, transfers: [], dwell: 20, demand: 0.5 },
  { id: 'DFY', name: '东方体育中心', interM: 2263, transfers: ['6', '8'], dwell: 30, demand: 0.7 },
  { id: 'SL', name: '三林', interM: 3516, transfers: [], dwell: 25, demand: 0.55 },
  { id: 'SLD', name: '三林东', interM: 1126, transfers: [], dwell: 20, demand: 0.45 },
  { id: 'PSL', name: '浦三路', interM: 1613, transfers: [], dwell: 20, demand: 0.4 },
  { id: 'KHL', name: '康恒路', interM: 1405, transfers: [], dwell: 20, demand: 0.35 },
  { id: 'YQ', name: '御桥', interM: 1816, transfers: ['18'], dwell: 25, demand: 0.6 },
  { id: 'LSH', name: '罗山路', interM: 2509, transfers: [], dwell: 25, demand: 0.55 },
  { id: 'XYL', name: '秀沿路', interM: 1777, transfers: [], dwell: 20, demand: 0.4 },
  { id: 'KXG', name: '康新公路', interM: 2321.4, transfers: [], dwell: 20, demand: 0.35 },
  { id: 'DSL', name: '迪士尼', interM: 5073.6, transfers: [], dwell: 30, demand: 0.5 },
];
/** 英文名未做逐站实拍核对，留空；PIS 英文按站名缺省处理。 */
export const STATION_EN: Record<string, string> = {};

const pair = (id: string, station: number, side: 'west' | 'east', at: number,
  stubs: PairDef['stubs']): PairDef => ({ id, station, side, at, stubs });

/** 配线：reference/line11/line11-layout-pdf.md 逐站读图。道岔偏移和有效长度按
 * 6A 单列位（约 140 m）加咽喉净空取【假设】，PDF 不按比例，不是测距。
 * - tails：花桥西、嘉定北西（地图上的站东，线路表里是上行端）、迪士尼东各两条
 *   尾轨，尾轨之间交叉渡线。迪士尼图上 4 条尾轨（两正线各分出两条），本模型
 *   每条正线只生成一条尾轨，共 2 条；运营能力按 3 列写在 terminals.capacity，
 *   见汇报【待定】。
 * - pairs：罗山路站南两条尾轨（下行到达站后折返）。
 * - sidings：南翔、真如两正线之间的存车线（东南端接正线、西北端车挡）；
 *   东方体育中心短存车线；龙耀路短尽头线；三个车场的出入段线。
 * - loops：安亭站西、浦三路、云锦路两正线之间的中间线；三林站内中间折返线
 *   （带站台面，`platform: true`）。
 * - crossovers：按文档逐站的单渡线/交叉渡线。花桥、嘉定北、迪士尼站端的
 *   交叉渡线由 tails 的 scissors 生成；嘉定北往嘉定西一侧的渡线另列。
 */
const tails: TailDef[] = [
  // 花桥：站西两条尾轨，尾轨之间有交叉渡线。
  { station: 0, side: 'west', length: 420, scissors: true },
  // 嘉定北：地图上的“站东”尾轨在线路表里是嘉定北的上行端（嘉定北是主线第一站），
  // 用 side 'west' 表示列车到达方向的后方；出入段线在尾轨之前接入。
  { station: 7, side: 'west', length: 420, scissors: true, scissorsApproach: 260 },
  // 迪士尼：站东尾轨（图上 4 条，模型每条正线一条，共 2 条）。
  { station: 39, side: 'east', length: 420, scissors: true },
];
const pairs: PairDef[] = [
  // 罗山路：站南两条尾轨，各接一条正线；下行到达后进尾轨换端，经渡线回上行。
  pair('LSH', 36, 'east', 205, [
    { id: 'LSH1', name: '罗山路1道折返线', length: 420, turnbackDistance: 260 },
    { id: 'LSH2', name: '罗山路2道折返线', length: 420, turnbackDistance: 260 },
  ]),
];
const sidings: SidingDef[] = [
  // 南翔：站西北，两正线之间一条存车线，东南端双Y接两正线，西北端车挡。
  { id: 'NX', name: '南翔存车线', station: 13, side: 'west', at: -240, length: 420, connect: 'both', turnback: true },
  // 真如：站西北，两正线之间一条存车线；东南端接正线（图上接一条还是两条看不清，按双Y【假设】），西北端车挡。
  { id: 'ZR', name: '真如存车线', station: 19, side: 'west', at: -240, length: 420, connect: 'both', turnback: true },
  // 东方体育中心：站西北两正线之间一条短存车线，尾端车挡；不改折返用途。
  { id: 'DFY', name: '东方体育中心短存车线', station: 30, side: 'west', at: -260, length: 240, connect: 'both', turnback: false },
  // 龙耀路：站东一条短尽头线，从北侧上行正线分出，尾端车挡。
  { id: 'LYL', name: '龙耀路短尽头线', station: 29, side: 'east', at: 180, length: 200, connect: 'UP', turnback: false },
  // 城北路停车场：嘉定北站东（线路表里为上行端），两条出入段线都接嘉定北
  // 北侧（下行/发车）正线，在尾轨之前接入。
  // 【待公共代码支持】文档写两条都只接下行正线；排图/车场进路要求出段车也能到
  // 上行站台面、入段车也能从上行进入，故两条都建成同时接两正线的双Y
  // （connect: 'both'）。几何位置仍是嘉定北上行端、尾轨之前。见汇报【待定】。
  { id: 'CBL1', name: '城北路停车场入段线', station: 7, side: 'west', at: -180, length: 180, connect: 'both', lane: 'outDN', turnback: false, lead: { depot: 'CBL', flow: 'in' } },
  { id: 'CBL2', name: '城北路停车场出段线', station: 7, side: 'west', at: -240, length: 180, connect: 'both', lane: 'outDN', turnback: false, lead: { depot: 'CBL', flow: 'out' } },
  // 赛车场车辆段：上海赛车场站西北，两条出入段线都接北侧（上行/往花桥）正线。
  // 【待公共代码支持】同上：要能让出段车直接上/下行正线、入段车从两方向进入，
  // 两条都按双Y接两正线建。
  { id: 'SSC1', name: '赛车场车辆段入段线', station: 6, side: 'west', at: -240, length: 260, connect: 'both', lane: 'outUP', turnback: false, lead: { depot: 'SSC', flow: 'in' } },
  { id: 'SSC2', name: '赛车场车辆段出段线', station: 6, side: 'west', at: -300, length: 260, connect: 'both', lane: 'outUP', turnback: false, lead: { depot: 'SSC', flow: 'out' } },
  // 川杨河定修段：罗山路北咽喉，图上 11 号线/16 号线/出入段线并行，接哪条正线看不清；
  // 按两条出入段线分别接两正线建【假设】，保证出段车两个方向都能上正线。
  { id: 'CYL1', name: '川杨河定修段入段线', station: 36, side: 'west', at: -300, length: 260, connect: 'both', lane: 'outDN', turnback: false, lead: { depot: 'CYL', flow: 'in' } },
  { id: 'CYL2', name: '川杨河定修段出段线', station: 36, side: 'west', at: -360, length: 260, connect: 'both', lane: 'outUP', turnback: false, lead: { depot: 'CYL', flow: 'out' } },
];
const loops: CoreLineData['LAYOUT']['loops'] = [
  // 安亭：站西两正线之间一条中间折返/存车线，两端双Y接两正线、两端车挡。
  // 东端接点放在站台范围以外（不能切进站台区段）。
  { id: 'AT', name: '安亭中间存车线', station: 3, west: -420, east: -160 },
  // 浦三路、云锦路：站内两正线之间中间线，两端双Y接两正线、两端短车挡。
  { id: 'PSL', name: '浦三路中间存车线', station: 33, west: -210, east: 210 },
  { id: 'YJL', name: '云锦路中间存车线', station: 28, west: -210, east: 210 },
  // 三林：站内中间折返线，两座岛式站台夹中间线，两端交叉渡线；小交路折返站。
  { id: 'SL', name: '三林中间折返线', station: 31, west: -210, east: 210, platform: true },
];
const crossovers: CrossoverDef[] = [
  { station: 3, offset: 350, kind: 'X' },   // 安亭站东交叉渡线
  { station: 4, offset: 215, kind: '\\' },  // 上海汽车城站东单渡线
  { station: 6, offset: -420, kind: 'X' },  // 上海赛车场站西交叉渡线（在车辆段道岔外）
  // 站东交叉渡线位于上海赛车场→嘉定新城的汇入咽喉，公共配线生成器只在每段正线
  // 的端部以内画渡线，这一段无法用 LAYOUT.crossovers 表达，见汇报【待定】。
  { station: 7, offset: 350, kind: 'X' },   // 嘉定北站东（往嘉定西一侧）交叉渡线
  { station: 10, offset: 350, kind: 'X' },  // 嘉定新城站南交叉渡线
  { station: 16, offset: -215, kind: '/' }, // 祁连山路站西单渡线
  { station: 19, offset: -350, kind: '/' }, // 真如西北端单渡线
  { station: 19, offset: 350, kind: '\\' }, // 真如东南端单渡线
  { station: 30, offset: -380, kind: '/' }, // 东方体育中心西北端单渡线
  { station: 30, offset: 380, kind: '\\' }, // 东方体育中心东南端单渡线
  { station: 31, offset: -350, kind: 'X' }, // 三林西端交叉渡线
  { station: 31, offset: 350, kind: 'X' },  // 三林东端交叉渡线
  { station: 36, offset: 380, kind: 'X' },  // 罗山路站南交叉渡线（在两条尾轨前）
  { station: 38, offset: -215, kind: '\\' },// 康新公路站西单渡线
];
const depots: DepotDef[] = [
  { id: 'CBL', name: '城北路停车场', short: '城北路', station: 7, stablingTracks: 4, capacity: 24, exitTime: 240,
    work: { daily: true, monthly: true, overhaul: false }, source: 'pdf-peixian：嘉定北站东北 24(6A)，4股道；两条出入段线接北侧正线（L11-09 用户确认即资料里的嘉定停车场）' },
  { id: 'SSC', name: '赛车场车辆段', short: '赛车场', station: 6, stablingTracks: 4, capacity: 24, exitTime: 240,
    work: { daily: true, monthly: true, overhaul: true }, source: 'pdf-peixian：上海赛车场站西北 24(6A)，4股道；两条出入段线接北侧上行正线' },
  { id: 'CYL', name: '川杨河定修段', short: '川杨河', station: 36, stablingTracks: 4, capacity: 52, exitTime: 240,
    work: { daily: true, monthly: true, overhaul: true }, source: 'pdf-peixian：罗山路北咽喉，11号线 52(6A)；出入段线接哪条正线看不清，按两正线建【假设】' },
];

/** 区间限流表：支线末站→嘉定新城用 joins.interM，不能按相邻数组项取（会误成上海赛车场→嘉定北）。 */
const RUN_PAIRS: [string, string][] = [
  ['HQ', 'GML'], ['GML', 'ZFL'], ['ZFL', 'AT'], ['AT', 'SQC'], ['SQC', 'CJL'], ['CJL', 'SSC'], ['SSC', 'JDC'],
  ['JDB', 'JDX'], ['JDX', 'BYL'], ['BYL', 'JDC'], ['JDC', 'ML'], ['ML', 'CXL'], ['CXL', 'NX'], ['NX', 'TPX'],
  ['TPX', 'WWL'], ['WWL', 'QLS'], ['QLS', 'LZY'], ['LZY', 'SXZ'], ['SXZ', 'ZR'], ['ZR', 'FQL'], ['FQL', 'CYL'],
  ['CYL', 'LDL'], ['LDL', 'JSL'], ['JSL', 'JTD'], ['JTD', 'XJH'], ['XJH', 'YYG'], ['YYG', 'LH'], ['LH', 'YJL'],
  ['YJL', 'LYL'], ['LYL', 'DFY'], ['DFY', 'SL'], ['SL', 'SLD'], ['SLD', 'PSL'], ['PSL', 'KHL'], ['KHL', 'YQ'],
  ['YQ', 'LSH'], ['LSH', 'XYL'], ['XYL', 'KXG'], ['KXG', 'DSL'],
];

/** 运行图依据：官方首末班与分时段间隔，见 reference/line11/official-timetable.md。 */
const H = (h: number, m = 0) => h * 3600 + m * 60;

export const OPERATIONS: CoreLineData['OPERATIONS'] = {
  ...LINE14_CORE.OPERATIONS,
  // 11号线是 6A、司机驾驶（ATO），不继承14号线的 UTO 作业表。
  uto: undefined,
  maintenance: { dailyLimit: 14, monthlyPeriod: 55, monthlyLimit: 85, monthlyDays: 1, overhaulDays: 28, overhaulCount: 1 }, // 【假设】缺11号线检修周期公开资料
  intervalTrainLimits: RUN_PAIRS.map(([from, to]) => ({ from, to, limit: 1 })), // 【假设】每方向每区间1列
  // 官方首末班：嘉定北 05:36 往迪士尼、迪士尼 05:58 往嘉定北；末班嘉定北 22:10、迪士尼 22:30。
  firstWestTerminusDep: H(5, 36),
  firstEastTerminusDep: H(5, 58),
  lastBigEastboundDep: H(22, 10),
  lastLateEastboundDep: H(22, 10),
  lastBigWestboundDep: H(22, 30),
  lastBigWestboundArrival: H(24, 0),
  peakCoreHeadway: 120, // 官方 南翔—三林 早高峰往三林 平均2分
  minTurnback: { HQ: 240, JDB: 240, DSL: 300, NX: 240, SL: 300, LSH: 240, AT: 240 }, // 【假设】按尾轨/中间线作业加余量
  longWaitPlatformStations: [],
  platformTurnClear: {},
  // 回段：城北路在嘉定北上/下行端接入，赛车场接上行正线，川杨河按两正线建。
  depotReturns: [
    { depot: 'CBL', dir: 'UP', station: 'JDB' },
    { depot: 'CBL', dir: 'DN', station: 'JDB' },
    // 【假设】声明中途回段站，并用 service 规则保住外层末班：否则排图主体会把这些
    // 车在罗山路/上海赛车场提前截短回段（只保护 core 两端，不保护 三林—迪士尼）。
    { depot: 'SSC', dir: 'UP', station: 'SSC', service: { terminal: 'HQ', intervalMultiplier: 1 } },
    { depot: 'SSC', dir: 'DN', station: 'SSC', service: { terminal: 'HQ', intervalMultiplier: 1 } },
    { depot: 'CYL', dir: 'DN', station: 'LSH', service: { terminal: 'DSL', intervalMultiplier: 1 } },
    { depot: 'CYL', dir: 'UP', station: 'LSH', service: { terminal: 'DSL', intervalMultiplier: 1 } },
  ],
  // 用户口述：南翔、真如都有存车/备车。过夜/热备先不写死列数，避免凭空造车；
  // 见汇报【待定】。
  overnightStabling: [],
  hotStandby: [],
  platformPassKmh: 45,
  platformStopKmh: Infinity,
  depotDoorTests: { CBL: { beforeSignal: 5 }, SSC: { beforeSignal: 5 }, CYL: { beforeSignal: 5 } }, // 【假设】未建库内试验线
  sectionRunAllowanceS: 16,
  sectionCruiseMinKmh: 12,
  sectionCoastMinKmh: 60,
  passRunMargin: .16,
  autoStartDelay: [1, 2], // 【假设】人工驾驶 ATO 发车确认延时
  atoDriverWork: { postLockExtraS: 0, turnbackExtraS: { rear: 0, front: 0 }, turnbackDoorCycles: { rear: 1, front: 1 }, legacyEndChangeS: 45 },
};

export const LINE11_CORE: CoreLineData = {
  SOURCES: [
    { id: 'pdf-peixian', title: '上海轨道交通全网配线V2025.26.2', url: 'reference/上海轨道交通全网配线V2025.26.2.pdf', used: '40站站序、里程、站台型式、道岔/存车线/折返线拓扑、三个车场容量与接轨' },
    { id: 'official-timetable', title: '11号线官方首末班/运行间隔（用户截图）', url: 'reference/line11/official-timetable.md', used: '首末班、分时段运行间隔' },
    { id: 'user-facts', title: '11号线现实情况（用户，2026-11-14）', url: 'reference/line11/user-facts.md', used: '交路、停站、曹杨路50秒、车场口径、花桥停车场不启用' },
    { id: 'design-line11', title: '11号线设计决定 L11-01～10', url: 'docs/design-decisions-line11.md', used: '时刻精度、交路、车站表/joins/terminals 写法' },
  ],
  STATIONS, STATION_EN,
  LINE_INFO: { name: '上海轨道交通11号线', shortName: '11号线', color: 0x871c2b, colorCss: '#871c2b',
    trainLength: 140, platformLength: 145, maxSpeedKmh: 100, capacity: 1460, crushCapacity: 1950, fleet: 82, cars: 6 },
  FLEET_TYPES: [{ type: '11A01', from: 11001, to: 11082, digits: 5, source: 'L11-01：6A，82列，一个车辆模型；车长/载客【假设】' }],
  FLEET: Array.from({ length: 82 }, (_, i) => ({ no: String(11001 + i), type: '11A01', n: 11001 + i })),
  DIRECTIONS: { DN: { label: '下行', towards: '迪士尼', prefix: '11' }, UP: { label: '上行', towards: '花桥/嘉定北', prefix: '11' } },
  LAYOUT: {
    tails, pairs, sidings, loops, crossovers, depots,
    zones: [
      { id: 'ZC1', name: 'ZC1 花桥—上海赛车场', fromStation: 0, toStation: 6 },
      { id: 'ZC2', name: 'ZC2 嘉定北—南翔', fromStation: 7, toStation: 13 },
      { id: 'ZC3', name: 'ZC3 桃浦新村—龙华', fromStation: 14, toStation: 27 },
      { id: 'ZC4', name: 'ZC4 云锦路—迪士尼', fromStation: 28, toStation: 39 },
    ],
    maxSectionLength: 450, // 【假设】计轴区段离散化尺度，非实线闭塞分区长度
  },
  SPEED_LIMITS: [],
  // 同2号线、14号线的通用道岔限速【假设】，无11号线道岔限速表。
  TURNOUT_SPEEDS: { crossover: 35, siding: 30, depot: 25, tail: 40 },
  OPERATIONS,
  // 11号线嘉定段、迪士尼段有高架/地面，但缺逐段实拍资料；先按全地下处理【假设】。
  EXPOSED: [],
  PROFILE_ANCHORS: { elevatedFrom: Infinity, groundFrom: Infinity },
  WEATHER_RULES: { wind: [], rain: { label: '暴雨', kmh: 80, elevatedOnly: true } },
  POSSESSIONS: { candidates: [2, 5, 13, 19, 25, 31, 36], morningUntil: H(4, 30), nightFrom: H(24), nightTo: H(27) }, // 【假设】夜间施工窗与候选区段
};
