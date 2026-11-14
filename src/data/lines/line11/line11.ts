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
  { id: 'HQ', name: '花桥', interM: null, transfers: ['苏州11'], dwell: 30, demand: 0.55, sidePlatform: ['DN', 'UP'] },
  { id: 'GML', name: '光明路', interM: 1267, transfers: [], dwell: 20, demand: 0.45, sidePlatform: ['DN', 'UP'] },
  { id: 'ZFL', name: '兆丰路', interM: 3300, transfers: [], dwell: 20, demand: 0.45 },
  { id: 'AT', name: '安亭', interM: 1128, transfers: [], dwell: 25, demand: 0.6 },
  { id: 'SQC', name: '上海汽车城', interM: 1844, transfers: [], dwell: 20, demand: 0.4, sidePlatform: ['DN', 'UP'] },
  { id: 'CJL', name: '昌吉东路', interM: 2286, transfers: [], dwell: 20, demand: 0.35, sidePlatform: ['DN', 'UP'] },
  { id: 'SSC', name: '上海赛车场', interM: 5382.7, transfers: [], dwell: 25, demand: 0.35, sidePlatform: ['DN', 'UP'],
    // 图上：花桥方向到达线 B 沿岛式西面到站南，在站南 X 以南并入中间（下行）
    // 正线（JDC 中心以南约 60 图面点）；去花桥的出发线 A 在站台北端从东侧
    // 上行正线分出、跨过下行正线向西。按站台半长 105 m 折算，DN 并线点取
    // +300 m（X 在 +150 m 以南），UP 分岔点取 -160 m（站台北端外）。
    joins: { station: 'JDC', interM: 3118.3, DN: { at: 300, platform: true }, UP: { at: -160 } } },

  // ---- 主线（7～39），嘉定北→迪士尼 ----
  { id: 'JDB', name: '嘉定北', interM: null, transfers: [], dwell: 30, demand: 0.55, sidePlatform: ['DN', 'UP'] },
  { id: 'JDX', name: '嘉定西', interM: 1944, transfers: [], dwell: 20, demand: 0.45 },
  { id: 'BYL', name: '白银路', interM: 3919, transfers: [], dwell: 20, demand: 0.4, sidePlatform: ['DN', 'UP'] },
  { id: 'JDC', name: '嘉定新城', interM: 1887, transfers: [], dwell: 25, demand: 0.55, sidePlatform: ['DN', 'UP'] },
  { id: 'ML', name: '马陆', interM: 2896, transfers: [], dwell: 20, demand: 0.4, sidePlatform: ['DN', 'UP'] },
  { id: 'CXL', name: '陈翔公路', interM: 3891, transfers: [], dwell: 20, demand: 0.35, sidePlatform: ['DN', 'UP'] },
  { id: 'NX', name: '南翔', interM: 1955, transfers: [], dwell: 25, demand: 0.5, sidePlatform: ['UP'] },
  { id: 'TPX', name: '桃浦新村', interM: 3237, transfers: [], dwell: 20, demand: 0.45 },
  { id: 'WWL', name: '武威路', interM: 1637.4, transfers: [], dwell: 20, demand: 0.45 },
  { id: 'QLS', name: '祁连山路', interM: 1277.6, transfers: [], dwell: 20, demand: 0.45 },
  { id: 'LZY', name: '李子园', interM: 1380, transfers: [], dwell: 20, demand: 0.45 },
  { id: 'SXZ', name: '上海西站', interM: 1310, transfers: ['15'], dwell: 30, demand: 0.6 },
  { id: 'ZR', name: '真如', interM: 1578.0, transfers: ['14'], dwell: 30, demand: 0.7, sidePlatform: ['DN'] },
  { id: 'FQL', name: '枫桥路', interM: 1119.0, transfers: [], dwell: 20, demand: 0.55 },
  { id: 'CYL', name: '曹杨路', interM: 722, transfers: ['3', '4', '14'], dwell: 50, demand: 0.85, sidePlatform: ['DN', 'UP'] },
  { id: 'LDL', name: '隆德路', interM: 1012, transfers: ['13'], dwell: 25, demand: 0.65 },
  { id: 'JSL', name: '江苏路', interM: 1357, transfers: ['2'], dwell: 25, demand: 0.8 },
  { id: 'JTD', name: '交通大学', interM: 2654, transfers: ['10'], dwell: 25, demand: 0.8 },
  { id: 'XJH', name: '徐家汇', interM: 905, transfers: ['1', '9'], dwell: 35, demand: 1.0 },
  { id: 'YYG', name: '上海游泳馆', interM: 1764, transfers: [], dwell: 20, demand: 0.5 },
  { id: 'LH', name: '龙华', interM: 1466, transfers: ['12'], dwell: 25, demand: 0.6 },
  { id: 'YJL', name: '云锦路', interM: 945, transfers: [], dwell: 20, demand: 0.5, sidePlatform: ['DN', 'UP'] },
  { id: 'LYL', name: '龙耀路', interM: 835, transfers: [], dwell: 20, demand: 0.5 },
  { id: 'DFY', name: '东方体育中心', interM: 2263, transfers: ['6', '8'], dwell: 30, demand: 0.7 },
  { id: 'SL', name: '三林', interM: 3516, transfers: [], dwell: 25, demand: 0.55 },
  { id: 'SLD', name: '三林东', interM: 1126, transfers: [], dwell: 20, demand: 0.45 },
  { id: 'PSL', name: '浦三路', interM: 1613, transfers: [], dwell: 20, demand: 0.4, sidePlatform: ['DN', 'UP'] },
  { id: 'KHL', name: '康恒路', interM: 1405, transfers: [], dwell: 20, demand: 0.35 },
  { id: 'YQ', name: '御桥', interM: 1816, transfers: ['18'], dwell: 25, demand: 0.6 },
  { id: 'LSH', name: '罗山路', interM: 2509, transfers: [], dwell: 25, demand: 0.55 },
  { id: 'XYL', name: '秀沿路', interM: 1777, transfers: [], dwell: 20, demand: 0.4, sidePlatform: ['DN', 'UP'] },
  { id: 'KXG', name: '康新公路', interM: 2321.4, transfers: [], dwell: 20, demand: 0.35, sidePlatform: ['DN', 'UP'] },
  { id: 'DSL', name: '迪士尼', interM: 5073.6, transfers: [], dwell: 30, demand: 0.5 },
];
/** 英文名未做逐站实拍核对，留空；PIS 英文按站名缺省处理。 */
export const STATION_EN: Record<string, string> = {};

/** 配线：以 reference/上海轨道交通全网配线V2025.26.2.pdf 原图逐站核对（2026-11-14 第二次读图）。
 * 图上不按比例，米数仍是【假设】；对的是哪一端、哪条正线、道岔朝向和先后次序。
 * 方向口径：数据里 side 'west' 是下行后方（里程小的一端），'east' 是下行前方。
 * - tails：花桥（站西）、嘉定北（站东=数据 west）两正线延长到车挡，站台外一组 X；
 *   迪士尼（站东）两正线延长到车挡，不设渡线。
 * - pairs：迪士尼站东、罗山路站南两组双Y中间折返线；罗山路站北一组双Y中间线就是
 *   川杨河定修段的出入段线。
 * - sidings：马陆站西北上行外侧存车线（两端接上行）；南翔（暂代中间线，见注释）；
 *   城北路（只接下行）、赛车场（只接上行）两个车场的出入段线。东方体育中心只有一座
 *   岛式站台、龙耀路没有配线（用户 2026-11-14）。
 * - loops：安亭、浦三路、云锦路两端双Y的中间线；三林、真如带站台面的中间线。
 * - crossovers：安亭站东、上海赛车场站西和站东（站东那组在往嘉定新城的汇入咽喉里）、
 *   嘉定新城站南的 X；花桥站东、兆丰路两端、上海汽车城、马陆、祁连山路、康新公路的
 *   单渡线。
 */
const tails: TailDef[] = [
  // 花桥：站西两条尾轨就是两正线延长线，尾轨之间只有一组交叉渡线（图上单个 X）。
  { station: 0, side: 'west', length: 420, scissors: true, scissorsSpacing: 0 },
  // 嘉定北：站东（数据 west）两正线延长到车挡，站台东端外一组 X；城北路停车场
  // 两条出入段线在 X 两侧从下行正线分出，见 sidings。站西往嘉定西方向
  // 没有渡线（图上那条带 X 的横线是嘉闵线城北路，不是 11 号线）。
  { station: 7, side: 'west', length: 700, scissors: true, scissorsSpacing: 0, scissorsApproach: 200 },
  // 迪士尼：站东两正线各自延长到车挡（存车，不折返）；折返走两正线之间的
  // 两条中间折返线，见 pairs。两正线之间没有渡线（站东从 1 道正线往北去的
  // 那根斜线接的是 21 号线，不是 11 号线自己的渡线）。
  { station: 39, side: 'east', length: 420, scissors: false, turnback: false },
];
const pairs: PairDef[] = [
  // 迪士尼：站台东端外两正线各分出一个Y，内侧两腿交叉，进两条中间折返线
  // （和 2 号线蟠祥路同一种双Y）：任一正线都能进任一条折返线。
  { id: 'DSL', station: 39, side: 'east', at: 205, stubs: [
    { id: 'DSL1', name: '迪士尼1道折返线', length: 400 },
    { id: 'DSL2', name: '迪士尼2道折返线', length: 400 },
  ] },
  // 罗山路站北（往御桥一端）：两正线各分出一个Y，内侧两腿交叉进两条中间线，
  // 两条中间线往北再折向东进川杨河定修段，就是出入段线；任一正线都能进出
  // 任一条。哪条出段、哪条回段图上分不出【假设】。
  { id: 'CYL', station: 36, side: 'west', at: -205, stubs: [
    { id: 'CYL1', name: '川杨河定修段1道出入段线', length: 260, turnback: false, lead: { depot: 'CYL', flow: 'in' } },
    { id: 'CYL2', name: '川杨河定修段2道出入段线', length: 260, turnback: false, lead: { depot: 'CYL', flow: 'out' } },
  ] },
  // 罗山路站南（往秀沿路一端）：同样的双Y进两条中间折返线，尽头车挡。
  { id: 'LSH', station: 36, side: 'east', at: 205, stubs: [
    { id: 'LSH1', name: '罗山路1道折返线', length: 420 },
    { id: 'LSH2', name: '罗山路2道折返线', length: 420 },
  ] },
];
const sidings: SidingDef[] = [
  // 马陆：站西北（往嘉定新城一端）上行正线外侧一条存车线，两端都接上行正线，
  // 西北端外有车挡；离站台近的是它东南端的道岔，再往站台是一组单渡线（见
  // crossovers）。长度【假设】。
  { id: 'ML', name: '马陆存车线', station: 11, side: 'west', at: -330, length: 560, connect: 'UP', lane: 'outUP', turnback: false, link: { main: 'UP', at: 420 } },
  // 城北路停车场：嘉定北站东（数据 west），在下行正线外侧。图上两条出入段线都只接下行正线：
  // 近处一条在站台东端和 X 之间分出，远处一条在 X 以东、正线车挡以西分出；两条线之间在段内
  // 还有一组剪刀。出段车走近处那条，直接到下行站台；上行到达的回段车过 X 后走远处那条【假设】
  // （图上分不出哪条出、哪条入，按进路最顺的走法定）。
  { id: 'CBL1', name: '城北路停车场出段线', station: 7, side: 'west', at: -190, length: 450, connect: 'DN', lane: 'farDN', turnback: false, lead: { depot: 'CBL', flow: 'out', shunt: 400 } },
  { id: 'CBL2', name: '城北路停车场入段线', station: 7, side: 'west', at: -540, length: 450, connect: 'DN', lane: 'outDN', turnback: false, lead: { depot: 'CBL', flow: 'in', shunt: 300 } },
  // 赛车场车辆段：图上两条出入段线都只接北侧上行正线，分别在站西 X 的两侧接入；
  // 两条线之间在段内还有一组剪刀。两处道岔都朝东开：远处一条（X 以西）出段车往东
  // 过 X 换到下行，直接进下行站台，下行来的回段车在站台换端后过 X 也只能进这条；
  // 近处一条（X 和站台之间）只有上行到达的车能不换端直接进。所以远处一条双向，
  // 近处一条只入段【假设】（图上分不出哪条出、哪条入）。
  { id: 'SSC1', name: '赛车场车辆段出入段线', station: 6, side: 'west', at: -400, length: 220, connect: 'UP', lane: 'outUP', turnback: false, lead: { depot: 'SSC' } },
  { id: 'SSC2', name: '赛车场车辆段入段线', station: 6, side: 'west', at: -160, length: 220, connect: 'UP', lane: 'outUP', turnback: false, lead: { depot: 'SSC', flow: 'in' } },
];
const loops: CoreLineData['LAYOUT']['loops'] = [
  // 安亭：站西两正线之间一条中间折返/存车线，两端双Y接两正线，
  // 车挡在两端道岔外侧的短尽头。
  { id: 'AT', name: '安亭中间存车线', station: 3, west: -420, east: -160 },
  // 浦三路、云锦路：站内两正线之间中间线，两端双Y接两正线，两端短车挡。
  { id: 'PSL', name: '浦三路中间存车线', station: 33, west: -210, east: 210 },
  { id: 'YJL', name: '云锦路中间存车线', station: 28, west: -210, east: 210 },
  // 三林：站内中间折返线，两座岛式站台夹中间线，两端各一组交叉渡线接两正线；
  // 这两组渡线已由 loop 的双Y生成，不再另列 crossovers。
  { id: 'SL', name: '三林中间折返线', station: 31, west: -210, east: 210, platform: true, island: 'both' },
  // 真如：两正线之间一条中间线，两端各双Y接两正线，车挡在道岔外侧的短尽头；
  // 中间线有站台面（和上行正线共用一座岛式站台）。

  { id: 'ZR', name: '真如中间线', station: 19, west: -210, east: 210, platform: true },
  // 南翔：两正线之间一条带站台面的中间线，和下行正线共用岛式站台（上行是侧式站台），
  // 两端各双Y接两正线，道岔外短车挡；南翔小交路上行到达后在中间线站台换端。
  { id: 'NX', name: '南翔中间折返线', station: 13, west: -210, east: 210, platform: true, island: 'DN' },
];
const crossovers: CrossoverDef[] = [
  { station: 0, offset: 215, kind: '\\' },  // 花桥站东（站前）单渡线
  { station: 2, offset: -215, kind: '/' },  // 兆丰路站西单渡线
  { station: 2, offset: 215, kind: '/' },   // 兆丰路站东单渡线
  { station: 3, offset: 250, kind: 'X' },   // 安亭站东交叉渡线
  { station: 4, offset: 215, kind: '\\' },  // 上海汽车城站东单渡线
  { station: 6, offset: -280, kind: 'X' },  // 上海赛车场站西交叉渡线（夹在车辆段两条道岔之间）
  { station: 6, offset: 230, kind: 'X' },   // 上海赛车场站东交叉渡线
  { station: 11, offset: -200, kind: '\\' }, // 马陆站西北单渡线（上行端在西北、下行端靠站台）
  { station: 10, offset: 150, kind: 'X' },  // 嘉定新城站南交叉渡线（在支线并线点以北）
  { station: 16, offset: -215, kind: '/' }, // 祁连山路站西单渡线
  { station: 38, offset: -215, kind: '\\' },// 康新公路站西单渡线
];
const depots: DepotDef[] = [
  { id: 'CBL', name: '城北路停车场', short: '城北路', station: 7, stablingTracks: 4, capacity: 24, exitTime: 240,
    work: { daily: true, monthly: true, overhaul: false }, source: 'pdf-peixian：嘉定北站东北 24(6A)，4股道；图上两条出入段线都只接北侧下行正线，两处道岔分在站台东端 X 两侧（一处约在站台东缘、一处在 X 以东），两条线之间在段内还有剪刀（L11-09 用户确认即资料里的嘉定停车场）。数据按图只接北侧下行；去花桥方向的进出段由车场门户按反向进路处理' },
  { id: 'SSC', name: '赛车场车辆段', short: '赛车场', station: 6, stablingTracks: 4, capacity: 24, exitTime: 240,
    work: { daily: true, monthly: true, overhaul: true }, source: 'pdf-peixian：上海赛车场站西北 24(6A)，4股道；图上两条出入段线都只接北侧上行正线，分别在站西 X 两侧的两处道岔接入，两条线之间在段内还有剪刀；出段去迪士尼时东侧那条要经站东汇入咽喉的 X 换到下行，西侧那条经站西 X。数据里因站东 X 放不下、车场门户找不到 DN 出段前向进路，暂写双Y，见待定' },
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
  longWaitPlatformStations: ['NX'], // 南翔小交路在中间线站台上候发换端（没有别的折返线）
  platformTurnClear: {},
  // 回段：图上城北路只接嘉定北下行正线，数据照图写；赛车场只接上行正线，但因站东 X 放不下，
  // 数据里的出入段线暂写双Y（见 LAYOUT.sidings 注释和汇报【待定】）。川杨河接哪条正线看不清，按两正线【假设】。
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
      { id: 'ZC1', name: 'ZC1 花桥—嘉定新城', fromStation: 0, toStation: 6 }, // 含支线到嘉定新城的区间（用户 2026-11-14）
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
