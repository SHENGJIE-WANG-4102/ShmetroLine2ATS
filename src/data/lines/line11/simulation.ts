import { EVENING_SECTION_RUN_BANDS } from './running';
import type { SimulationData, ServiceData } from '../../simulation';
import type { Period, Template } from '../../../sim/timetable';
import { LINE11_PHYSICS, LINE11_ENERGY } from './physics';
import { LINE14_SIMULATION } from '../line14/simulation';

const H = (h: number, m = 0) => h * 3600 + m * 60;

/** 分时段开行花样。交路见 docs/design-decisions.md D213（用户 2026-11-18）、D234（官方分段间隔）：
 * - 平峰/双休日：嘉定北、花桥两条支线全程车，主干每 6/5 分钟一班，两条支线各 12/10 分钟；
 * - 工作日早高峰：官方往迪士尼 南翔—三林 2 分、三林—罗山路 3 分、罗山路—迪士尼 6 分，往郊区 2 分 30 秒、3 分 45 秒、7 分 30 秒，
 *   所以下行三分之一在三林、三分之一在罗山路折返，上行比下行稀（早高峰车往东积、晚高峰往西回）；
 * - 工作日晚高峰：官方往迪士尼 3 分 30 秒（一半到罗山路），往郊区 2 分 30 秒；
 * - 夜间（21:30 起）：只有一班嘉定北车只到三林东，进浦三路中间线过夜（用户 2026-11-24：三林东只有一班）。
 * 小交路写进 pattern，按 terminals.routes 的名字生成；排图主体的 core 取南翔—罗山路。 */
/** 早高峰三十二槽（D234，两半各十六槽）：下行嘉定北、花桥各 6 槽，南翔—三林 4 槽（每 4 槽一趟，三林折返的车和回来的车同一节拍）；
 * 往迪士尼 6、到罗山路 6、到三林 4。每半有 2 槽回库（只开下行）：嘉定北—迪士尼到后空车回川杨河，
 * 再加一趟到罗山路进川杨河，前一半花桥、后一半嘉定北（D213 用户列的两种回库）。
 * 所以上行每十六槽开 14 槽，约为下行的 0.9：官方往郊区 2 分 30 秒、往迪士尼 2 分。 */
const MORNING_HALF = ['big', 'shortHQ', 'shortSL', 'branch', 'shortJDB', 'big', 'shortSL', 'inHQ', 'branch', 'shortJDB', 'shortSL', 'inDSL', 'shortHQ', 'branch', 'shortSL', 'inJDB'];
const MORNING = [...MORNING_HALF.map(k => k === 'inJDB' ? 'shortJDB' : k), ...MORNING_HALF.map(k => k === 'inHQ' ? 'shortHQ' : k)];
/** 晚高峰二十四槽（两个半小时一样的十二槽，后一半嘉定北、花桥对调）：每十二槽往迪士尼 5、到罗山路 4、罗山路出库 3（只开上行）。
 * 上行 24 班/时，嘉定北、花桥各 12；下行 18 班/时，两条支线各 9；迪士尼往返各 10。 */
const EVENING_HALF = ['big', 'shortHQ', 'big', 'outHQ', 'shortJDB', 'branch', 'outJDB', 'branch', 'shortJDB', 'outHQ', 'big', 'shortHQ'];
const SWAP_BRANCH: Record<string, string> = { big: 'branch', branch: 'big', shortHQ: 'shortJDB', shortJDB: 'shortHQ', outHQ: 'outJDB', outJDB: 'outHQ' };
const EVENING = [...EVENING_HALF, ...EVENING_HALF.map(k => SWAP_BRANCH[k])];
const templates: Record<string, Template> = {
  opening: { id: 'opening', name: '早间过渡', desc: '嘉定北/花桥两条支线往迪士尼，逐渐接近高峰【假设】', pattern: ['big', 'branch'], headway: 600 },
  morning: { id: 'morning', name: '工作日早高峰', desc: '三十二槽：每十六槽嘉定北、花桥各 6 槽（各约 5 分 50 秒一班），南翔—三林 4 槽；往迪士尼 6、到罗山路 6；2 槽回库只开下行。参考站 2 分 10 秒', pattern: MORNING, headway: 130, phase: { UP: 30 }, peak: true },
  // 早高峰上行先开（罗山路 06:20 起），这时还没有到三林折返的车：三林那几槽改成罗山路—南翔，正好给南翔的下行小交路送车
  morningUpEarly: { id: 'morningUpEarly', name: '工作日早高峰', desc: '早高峰上行先开的一段：三林槽改罗山路—南翔', pattern: MORNING.map(k => k === 'shortSL' ? 'shortNX' : k), headway: 130, phase: { UP: 30 }, peak: true },
  morningTail: { id: 'morningTail', name: '工作日早高峰', desc: '同早高峰三十二槽，放到 2 分 30 秒；回库槽照旧只开下行（退峰时车陆续回库）', pattern: MORNING, headway: 150, peak: true, continuePattern: true },
  offpeak: { id: 'offpeak', name: '工作日平峰', desc: '嘉定北/花桥全程，主干约6分钟、支线约12分钟', pattern: ['big', 'branch'], headway: 360 },
  eveningBuild: { id: 'eveningBuild', name: '工作日晚高峰', desc: '四槽：嘉定北、花桥各一半，往迪士尼、到罗山路各一半。参考站上下行都是 3 分 20 秒', pattern: ['big','shortHQ','shortJDB','branch'], headway: 200, peak: true },
  evening: { id: 'evening', name: '工作日晚高峰', desc: '二十四槽：往迪士尼 10、到罗山路 8、罗山路出库 6（只开上行）；上行 2 分 30 秒，下行平均 3 分 20 秒', pattern: EVENING, headway: 150, peak: true, continuePattern: true },
  weekend: { id: 'weekend', name: '双休日日间', desc: '嘉定北/花桥全程，主干约5分钟、支线约10分钟', pattern: ['big', 'branch'], headway: 300, peak: true },
  closing: { id: 'closing', name: '夜间过渡', desc: '全程车，至末班逐渐放疏【假设】', pattern: ['big', 'branch'], headway: 600 },
  lateNight: { id: 'lateNight', name: '夜间特殊交路', desc: '一班嘉定北车只到三林东，进浦三路中间线过夜（夜间特殊交路，全天只有这一班，用户 2026-11-24）', pattern: ['big', 'branch', 'night'], headway: 600 },
  late: { id: 'late', name: '末班前', desc: '全程车至末班逐渐放疏', pattern: ['big', 'branch'], headway: 600 },
};
const dayPeriods: Record<'weekday' | 'weekend', Period[]> = {
  weekday: [
    // 早间过渡保持 10 分钟一班，让花桥第二班正好落在官方首班 05:37（不是 05:33）。
    { from: H(4), to: H(7), template: 'opening', label: '早间过渡', headway: 600 },
    // 早高峰到南翔 09:15：高德 11-27 南翔下行 09 点 15 班、10 点 10 班，真如 09 点 21 班、10 点 11 班（逐分自洽的表）。
    // 官方是区段平均值，故退峰、升峰用渐变，不用一档。
    { from: H(7), to: H(8, 40), template: 'morning', label: '早高峰' },
    { from: H(8, 40), to: H(9, 5), template: 'morningTail', label: '早高峰' },
    { from: H(9, 5), to: H(9, 15), template: 'offpeak', label: '早高峰退峰', headway: 200, headwayTo: 360 },
    { from: H(9, 15), to: H(14, 20), template: 'offpeak', label: '平峰' },
    { from: H(14, 20), to: H(15, 30), template: 'offpeak', label: '晚高峰前升峰', headway: 360, headwayTo: 200 },
    // 15:30 起加密（高德 15 点起）：下行直接开晚高峰十二槽（平均 3 分 20 秒），上行 16:45 前先 3 分 20 秒四槽（serviceData.overrides），
    // 再加密到 2 分 30 秒：早高峰往东积的车这时回西边。下行早开是为了它到迪士尼、罗山路时正好接上上行的十二槽。
    { from: H(15, 30), to: H(19, 15), template: 'evening', label: '晚高峰' },
    // 晚间 21:33 起东方体育中心约 3 分、22:00 后约 4～5 分一班（折算到南翔提前 43 分）。
    { from: H(19, 15), to: H(20, 45), template: 'closing', label: '夜间过渡', headway: 190, headwayTo: 230 },
    { from: H(20, 45), to: H(21, 46) + 26, template: 'closing', label: '夜间过渡', headway: 230, headwayTo: 244 },
    // 夜间特殊交路只有一班（嘉定北—三林东）：窗口只放下一个 big、branch、night 的循环，之后接普通末班前。
    // 用户给的实际：这班 21:32 到嘉定北站台停稳，21:38 关门起步。窗口起点（参考站时刻）按排图的偏移推到让嘉定北 21:38 发；
    // 到三林东在浦三路中间线 22:30 的入位时刻（nightAfter）之后。
    { from: H(21, 46) + 26, to: H(22, 3) + 26, template: 'lateNight', label: '夜间特殊交路', headway: 255 },
    { from: H(22, 3) + 26, to: H(24), template: 'late', label: '末班前', headway: 265, headwayTo: 300 },
  ],
  weekend: [
    { from: H(4), to: H(7), template: 'opening', label: '早间过渡', headway: 650 },
    { from: H(7), to: H(21), template: 'weekend', label: '日间' },
    { from: H(20, 45), to: H(24), template: 'closing', label: '夜间过渡', headway: 330, headwayTo: 360 },
  ],
};
/** 高峰波的起点按参考站（南翔下行、罗山路上行）起算【假设】。小交路到罗山路，单程约 1 小时，
 * 默认的“核心区提前一整程”会把波排到首班车上（05:47 嘉定新城两车只隔 10 s），所以直接给起点：
 * 早高峰 06:45/07:00，晚高峰 15:30；小交路的车头一进核心区就有车接，排图 0 问题、班数贴近高德。 */
const weekdayPeaks: ServiceData['peaks'] = {
  morning: { DN: H(6, 45), UP: H(6, 20) },
  evening: { DN: H(15, 30), UP: H(16, 45) },
};
const service = (): ServiceData => ({
  peaks: {}, overrides: [], openingSupplements: [], lateHeadway: 600, standby: [],
});

/** 首班车起点。官方表里能读出“从这里另起一趟”的车站（同一方向首班比上一站早，
 * 说明不是同一列车）：花桥 05:37、安亭 05:35、南翔 05:45 往迪士尼（嘉定新城 05:45 是嘉定北 05:36 那趟路过的，
 * 不是始发，2026-11-18 用户决定），罗山路 05:20/05:25 往花桥/嘉定北。花桥 05:37 由早间过渡的
 * 第二班产生（不是另加一趟）；这里只补罗山路 05:20 往嘉定北这一趟。
 * 其余起点在车场出车/中途折返上没有来源，或两趟只差 5 分钟会追尾，逐条写在
 * 汇报【待定】。官方表里还有“往安亭”末班，现字段表达不了；4 趟巡道车见下面 patrols。 */
const firstOrigins: SimulationData['timetable']['firstOrigins'] = [
  { dir: 'UP', from: 'LSH', to: 'JDB', dep: H(5, 20) },  // 罗山路首班往嘉定北
  // 【假设】官方表南翔 05:45 往迪士尼早于上一站陈翔公路 05:53，是另起的始发；来源按车场出车排
  { dir: 'DN', from: 'NX', to: 'DSL', dep: H(5, 45) },
  // 官方：往花桥首班也从罗山路起，05:25（往嘉定北 05:20 之后）
  { dir: 'UP', from: 'LSH', to: 'HQ', dep: H(5, 25) },
  // 官方：安亭 05:35 往迪士尼是始发，车是前一晚往安亭末班（迪士尼 22:25 发、00:01 到）停在安亭中间存车线的那列
  { dir: 'DN', from: 'AT', to: 'DSL', dep: H(5, 35) },
  // 高德桃浦新村/嘉定北上行 06:17 起约 8 分一班（只取班数）：罗山路 05:30–05:55 往两条支线各补三趟，约 10 分一班【假设】
  { dir: 'UP', from: 'LSH', to: 'JDB', dep: H(5, 30) },
  { dir: 'UP', from: 'LSH', to: 'HQ', dep: H(5, 35) },
  { dir: 'UP', from: 'LSH', to: 'JDB', dep: H(5, 40) },
  { dir: 'UP', from: 'LSH', to: 'HQ', dep: H(5, 45) },
  { dir: 'UP', from: 'LSH', to: 'JDB', dep: H(5, 50) },
  { dir: 'UP', from: 'LSH', to: 'HQ', dep: H(5, 55) },
];

/** 用户决定（2026-11-14，L11-04）：首班前 4 趟巡道车，跑完在终点等，接那里的第一趟发车。
 * 花桥支线两趟从赛车场车辆段出：一趟到花桥折返线等，一趟到嘉定新城站台等（出车车场
 * 【假设】）；主线：嘉定北→迪士尼到折返线等，罗山路→迪士尼→嘉定北到折返线等。 */
const patrols: SimulationData['timetable']['patrols'] = [
  { depot: 'SSC', via: ['SSC', 'HQ'] },
  { depot: 'SSC', via: ['SSC', 'NX'] }, // 用户决定（2026-11-18）：原到嘉定新城等车的巡道车改到南翔，接南翔 05:45
  { depot: 'CBL', via: ['JDB', 'DSL'] },
  { depot: 'CYL', via: ['LSH', 'DSL', 'JDB'] },
];

export const LINE11_SIMULATION: SimulationData = {
  physics: LINE11_PHYSICS, energy: LINE11_ENERGY,
  calibration: {
    ...LINE14_SIMULATION.calibration,
    dwellModel: 'station', // 图定停站按本线站表；官方只到分钟，逻辑为主
    ridershipTarget: { weekday: 900000, weekend: 700000 }, // 【假设】无11号线逐日客流实测
    peakSection: { day: 'weekday', from: 'NX', to: 'SL', hours: [[7, 9], [18, 19]] },
    profiles: {
      weekday: [[4, 0], [5.25, .12], [6, .4], [7, 1.8], [8, 3], [9.5, .75], [12, .6], [16, .7], [17.5, 2.2], [19, 1.2], [20, .6], [22, .25], [23.75, 0]],
      weekend: [[4, 0], [5.25, .08], [7, .4], [10, 1.1], [14, 1.3], [18, 1], [21, .5], [23.75, 0]],
    },
    tides: {
      weekday: { stationWeights: [], amplitude: 0, morning: 8, evening: 18, width: 2 },
      weekend: { stationWeights: [], amplitude: 0, morning: 8, evening: 18, width: 2 },
    },
    // 用户决定（2026-11-15，L11-03）：TDT 最短 20 s，开门到位起算。D220：最短图定停站 = 停稳到门开好约 4.4 s
    // + TDT 20 s + 倒计时归零到平均起动（COUNTDOWN_LEAD_S，约 14.7 s）≈ 39 s。
    minDwell: 39,
    // 用户决定（2026-11-21，D220）：TDT 开门到位起算，剩 12 s 起可关门，最晚归零后 10 s（显示 --）；关门约 6 s，
    // 关门完成后 5 s 站台端门内发车指示灯亮绿灯，绿灯后 6–15 s 起步。关门时刻多数在剩 12–5 s，
    // 20% 的概率更晚（密度线性减小到归零后 10 s）【假设：概率】；曹杨路和其他站同一规则。
    driverCloseRule: { closeFromS: 12, typicalToS: 5, lateProbability: .2, overrunMaxS: 10, lampDelayS: 5, startAfterLampS: [6, 15] },
  },
  gradient: { ...LINE14_SIMULATION.gradient, depths: {}, river: null }, // 【假设】缺11号线纵断面，按平坦隧道处理
  holiday: { calendar: [], returnRuns: [], closure: null, surges: [] },
  pis: {
    timing: LINE14_SIMULATION.pis.timing,
    defaults: { DN: 'DSL', UP: 'HQ' },
    destinations: [
      { station: 'DSL', first: 'firstE', last: 'lastE', alternatives: [] },
      { station: 'JDB', first: 'firstW', last: 'lastW', alternatives: [{ station: 'HQ' }] },
      { station: 'HQ', first: 'firstW', last: 'lastW', alternatives: [] },
    ],
    welcome: '欢迎乘坐上海轨道交通11号线',
    weatherNotice: '受设备或线路条件影响，列车限速运行',
  },
  topology: { wrapAfter: 'SL' },
  instructor: { previousIds: {}, events: [], scenarios: [] },
  timetable: {
    carryMainlineMoves: true, positioningRevenue: { from: H(7), to: H(21) }, preserveRevenueRoutes: true, truncateHome: { from: H(7), to: H(19) },
    templates,
    dayPeriods, shownPeriods: dayPeriods,
    dwellBands: { weekday: [{ from: 0, to: Infinity, value: 1 }], weekend: [{ from: 0, to: Infinity, value: 1 }] },
    runBands: { weekday: [{ from: 0, to: Infinity, value: 1 }], weekend: [{ from: 0, to: Infinity, value: 1 }] },
    sectionRunBands: { weekday: EVENING_SECTION_RUN_BANDS },
    serviceData: { weekday: { ...service(), peaks: weekdayPeaks,
      overrides: [
        { from: H(6, 20), to: H(7, 25), template: 'morningUpEarly', dir: 'UP', label: '早高峰' },
        // 上行晚 15 分钟才加密：高德 11-27 御桥上行 15:30–16:00 6 班、16:00 起每半小时 10 班（下行曹杨路 14:30 起就加密）
        { from: H(14, 20), to: H(15, 45), template: 'offpeak', dir: 'UP', label: '平峰' },
        { from: H(15, 45), to: H(16, 45), template: 'eveningBuild', dir: 'UP', label: '晚高峰' },
        // 上行晚高峰到罗山路 18:45 就收：高德御桥上行 18:30 起每半小时 8 班（之前 11 班）；官方晚高峰 18–19 点按区段中间站平均，仍在 2 分 30 秒内
        { from: H(18, 45), to: H(20, 45), template: 'closing', dir: 'UP', label: '夜间过渡', headway: 190, headwayTo: 226 },
      ] }, weekend: service() },
    // 【假设】车库整备/出车窗口，不代表新增营业首班。
    opening: { outerAlternation: 0, stockUntil: H(12), redirectFrom: H(5), emptyFeedersFrom: H(20), feederUntil: H(26), stableUntil: H(10), dayStart: H(4), defaultStableDeparture: H(6) },
    outerBandMargin: 0,
    overlays: [],
    terminals: {
      // L11-10：大交路两端写嘉定北、迪士尼；两条支线和小交路用 routes 命名。
      trunk: ['JDB', 'DSL'],
      routes: {
        branch: ['HQ', 'DSL'],       // 花桥—迪士尼（白天到花桥）
        shortNX: ['NX', 'LSH'],      // 南翔—罗山路小交路（主线短交路）
        shortHQ: ['HQ', 'LSH'],      // 花桥—罗山路小交路（支线短交路）
        shortJDB: ['JDB', 'LSH'],    // 嘉定北—罗山路小交路（用户 2026-11-27 在嘉定北见到下午出库往罗山路的车）
        shortSL: ['NX', 'SL'],       // 南翔—三林小交路，三林中间线折返（早高峰，D234 用户决定 2026-11-27）
        night: ['JDB', 'SLD'],       // 嘉定北—三林东夜间特殊交路，到后进浦三路中间线过夜
        // 早高峰回库（D213 用户列的「嘉定北/花桥—罗山路回库」）：载客到罗山路进川杨河；嘉定北—迪士尼那趟到后空车回川杨河
        inJDB: ['JDB', 'LSH'],
        inHQ: ['HQ', 'LSH'],
        inDSL: ['JDB', 'DSL'],
        // 晚高峰出库（只开上行）：川杨河出车到罗山路，载客往嘉定北/花桥，晚上进城北路、赛车场——早高峰往东积的车这时回西边
        outJDB: ['JDB', 'LSH'],
        outHQ: ['HQ', 'LSH'],
      },
      oneWay: { night: 'DN', inJDB: 'DN', inHQ: 'DN', inDSL: 'DN', outJDB: 'UP', outHQ: 'UP' },
      // 排图主体仍只认一种小交路 core，取南翔—罗山路（与 shortNX 同一条）。
      core: ['NX', 'LSH'],
      circulate: ['JDB', 'HQ', 'NX', 'SL', 'LSH', 'DSL'],
      depot: { JDB: 'CBL', HQ: 'SSC', NX: 'CBL', SL: 'CYL', LSH: 'CYL', DSL: 'CYL' },
      // 花桥/嘉定北/迪士尼各两条尾轨，三林中间折返线，罗山路两条尾轨。
      capacity: { JDB: 3, HQ: 3, NX: 2, SL: 2, LSH: 3, DSL: 3 },
      maxPresent: { JDB: 3, HQ: 3, NX: 2, SL: 2, LSH: 3, DSL: 3 },
    },
    firstOrigins, patrols,
    // 用户 2026-11-27 现场所见：工作日约 14–16 点嘉定北按组出车，每组「出库空放、折返大交路、出库罗山路」，不止三组；
    // 空放是调车（用户判断：南翔、真如平峰已有备车，嘉定新城没有专用折返线）。【假设】去川杨河定修段，全程空车下行；
    // 4 组，各排在高德嘉定北成对载客班（14:03/14:07、14:24/14:28、14:38/14:42、15:10/15:15）之前。推翻：现场看到空放停在别处。
    depotTransfers: [{ from: 'CBL', to: 'CYL', dep: [H(14, 0), H(14, 20), H(14, 34), H(15, 6)], days: ['weekday'] }],
    lastRuns: [{ dir: 'UP', from: 'DSL', to: 'AT', dep: H(22, 25) }, { dir: 'DN', from: 'HQ', to: 'DSL', dep: H(22, 0) }],
    // 官方末班往迪士尼一列，嘉定新城之后的分钟是花桥 22:00 那趟的（赛车场 22:19 → 嘉定新城 22:23，4 分钟）；嘉定北 22:10 那趟比它早一站间隔
    columnOwners: [{ column: 'lastE', station: 'JDC', from: 'HQ' }],
    openingGuards: [], closingDepotMoves: [],
  },
};
