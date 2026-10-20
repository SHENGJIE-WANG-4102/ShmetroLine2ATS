/**
 * 上海轨道交通2号线 线路基础数据
 *
 * All real-world facts (station order, names, inter-station distances, depot
 * junction stations, terminus first/last trains) are taken from the public
 * sources listed in SOURCES. Everything flagged `approx: true` (or living in
 * the LAYOUT / OPERATIONS blocks) is a plausible approximation because the
 * real values are not public — see README "近似处理" for the full list.
 *
 * Nothing in this file is used directly for drawing; the topology builder
 * (src/sim/topology.ts) turns it into a track graph that both the simulation
 * worker and the renderer consume.
 */

export interface SourceRef {
  id: string;
  title: string;
  url: string;
  used: string;
}

export const SOURCES: SourceRef[] = [
  {
    id: 'pdf-peixian',
    title: '上海轨道交通全网配线 V2025.26.2（reference/上海轨道交通全网配线V2025.26.2.pdf）',
    url: 'reference/上海轨道交通全网配线V2025.26.2.pdf',
    used: '各站配线型式（渡线、尽头线、中间线、存车线）、广兰路中间线站台折返、车辆段/停车场8A列位（北翟路36、龙阳路24、川沙32）；示意图不按比例，见 docs/layout-pdf.md',
  },
  {
    id: 'wiki-zh',
    title: '上海轨道交通2号线 — 维基百科（车站列表：站间距、里程）',
    url: 'https://zh.wikipedia.org/zh-hans/%E4%B8%8A%E6%B5%B7%E8%BD%A8%E9%81%93%E4%BA%A4%E9%80%9A2%E5%8F%B7%E7%BA%BF',
    used: '31座车站顺序、各站站间距（米）、以蟠祥路·国家会计学院为0点的里程、全长62.2 km',
  },
  {
    id: 'jtw-20251027',
    title: '上海市交通委：定了！2号线蟠祥路·国家会计学院站11月1日首班车起开通初期运营',
    url: 'https://jtw.sh.gov.cn/xwfb2/20251027/14557ac7aeaa4e95a61cce023ce01a55.html',
    used: '西端新终点站开通日期；首班05:25、往浦东1号2号航站楼末班21:57、往广兰路末班22:42；浦东1号2号航站楼始发末班到达蟠祥路00:05；大小交路方式',
  },
  {
    id: 'thepaper-20251101',
    title: '澎湃新闻：上海地铁2号线“上新”，蟠祥路·国家会计学院站正式开通',
    url: 'https://www.thepaper.cn/newsDetail_forward_31871679',
    used: '西延伸长约1.67 km、地下二层岛式站台；工作日高峰大小交路（小交路淞虹路—广兰路），平峰及双休日大交路',
  },
  {
    id: 'thepaper-20240921',
    title: '澎湃新闻：上海9座地铁站改名（2024-09-21）',
    url: 'https://www.thepaper.cn/newsDetail_forward_28825374',
    used: '徐泾东→国家会展中心、东昌路→浦东南路、浦东国际机场→浦东1号2号航站楼',
  },
  {
    id: 'shgov-20240227',
    title: '上海市政府：2号线“双套信号系统”就像手机的“双卡双待”',
    url: 'https://www.shanghai.gov.cn/nw4411/20240227/180dcb4ed7aa4c48b38cf0761062580c.html',
    used: 'CBTC 主用 + TBTC 备用的双系统、可一键切换',
  },
  {
    id: 'jtw-20240129',
    title: '上海市交通委：轨道交通2号线信号系统完成阶段性改造平稳投运',
    url: 'https://jtw.sh.gov.cn/xydt/20240129/723ad1281785433db88e237f2c0748a0.html',
    used: 'CBTC 于2024-01-27投入运行；TBTC 作为降级/备用系统',
  },
  {
    id: 'wiki-depots',
    title: '上海轨道交通车辆基地 — 维基百科',
    url: 'https://zh.wikipedia.org/zh-hans/%E4%B8%8A%E6%B5%B7%E8%BD%A8%E9%81%93%E4%BA%A4%E9%80%9A%E8%BD%A6%E8%BE%86%E5%9F%BA%E5%9C%B0',
    used: '北翟路基地接轨淞虹路（淞虹路西北）、龙阳路车辆段接轨龙阳路（龙阳路东北）、川沙停车场接轨远东大道（远东大道东）',
  },
  {
    id: 'china-emu-02a05',
    title: '02A05 型列车资料（6M2T，8辆编组，最高运营速度80 km/h）',
    url: 'https://www.china-emu.cn/Trains/Cityrails/Model/M-203-T.html',
    used: '8辆A型车编组、最高运营速度 80 km/h；02A05 编号 02086—02116（31列）',
  },
  {
    id: 'wiki-02a01',
    title: '上海地铁02A01型电动列车 — 维基百科',
    url: 'https://zh.wikipedia.org/zh-hans/%E4%B8%8A%E6%B5%B7%E5%9C%B0%E9%93%8102A01%E5%9E%8B%E7%94%B5%E5%8A%A8%E5%88%97%E8%BD%A6',
    used: '02A01（原AC02）16列，编号 0201—0216',
  },
  {
    id: 'wiki-02a02',
    title: '上海地铁02A02型电动列车 — 维基百科',
    url: 'https://zh.wikipedia.org/zh-hans/%E4%B8%8A%E6%B5%B7%E5%9C%B0%E9%93%8102A02%E5%9E%8B%E7%94%B5%E5%8A%A8%E5%88%97%E8%BD%A6',
    used: '02A02（原AC08）21列，编号 0233—0253',
  },
  {
    id: 'wiki-02a03-04',
    title: '上海地铁02A03型、02A04型电动列车 — 维基百科',
    url: 'https://zh.wikipedia.org/wiki/%E4%B8%8A%E6%B5%B7%E5%9C%B0%E9%93%8102A03%E5%9E%8B%E3%80%8102A04%E5%9E%8B%E7%94%B5%E5%8A%A8%E5%88%97%E8%BD%A6',
    used: '02A03（原AC17a）16列，编号 0254—0269；02A04（原AC17b，已扩编为8辆）16列，编号 0270—0285',
  },
  {
    id: 'whb-100th',
    title: '文汇报：地铁2号线喜提第100列列车（2020-06-02）',
    url: 'https://wenhui.whb.cn/third/zaker/202006/02/352215.html',
    used: '2号线配属列车总数 100 列（末列增购车 02116）',
  },
];

export interface StationData {
  /** Platform display hardware; omitted stations use the classic vertical information column. */
  pisLayout?: 'classic' | 'wide';
  /** short stable id used in code */
  id: string;
  /** current official Chinese name */
  name: string;
  /** former name(s), for the info panel */
  formerName?: string;
  /** distance from the previous station in metres (source: wiki-zh), null for the first */
  interM: number | null;
  /** interchange lines (display only) */
  transfers: string[];
  /** planned base dwell in seconds (approximation) */
  dwell: number;
  /** relative passenger demand weight (approximation, 1 = average) */
  demand: number;
  /** tracks served by a side platform (outside the track); every other face is
   *  an island between the two mains. Source: pdf-peixian where the PDF shows
   *  the platform, island otherwise (approximation) */
  sidePlatform?: ('DN' | 'UP')[];
}

/**
 * Stations, west → east. `interM` values are the 站间距 column of the
 * Chinese Wikipedia station table. The 蟠祥路·国家会计学院—国家会展中心 value
 * (1640 m) is derived from the difference between the table's chainage
 * (zero at 蟠祥路·国家会计学院) and the pre-extension chainage (zero at
 * 徐泾东), which differ by a constant 1640 m; the official extension length
 * is quoted as "约1.67 km". Summing the table gives 61 941 m to the eastern
 * terminus versus 61 940 m in the table (1 m rounding).
 */
export const STATIONS: StationData[] = [
  { id: 'PXL', name: '蟠祥路·国家会计学院', interM: null, transfers: [], dwell: 20, demand: 0.35, pisLayout: 'wide' },
  { id: 'GJH', name: '国家会展中心', formerName: '徐泾东', interM: 1640, transfers: ['17'], dwell: 20, demand: 0.7, pisLayout: 'wide' },
  { id: 'HQZ', name: '虹桥火车站', interM: 1842, transfers: ['10', '17', '机场联络线', '国铁'], dwell: 25, demand: 1.6 },
  { id: 'HQ2', name: '虹桥2号航站楼', interM: 690, transfers: ['10', '机场联络线'], dwell: 20, demand: 1.0 },
  { id: 'SHR', name: '淞虹路', interM: 5921, transfers: [], dwell: 20, demand: 0.8 },
  { id: 'BXJ', name: '北新泾', interM: 1367, transfers: [], dwell: 20, demand: 0.9 },
  { id: 'WNL', name: '威宁路', interM: 1260, transfers: [], dwell: 20, demand: 0.9 },
  { id: 'LSG', name: '娄山关路', interM: 1661, transfers: ['15'], dwell: 20, demand: 1.1 },
  { id: 'ZSG', name: '中山公园', interM: 1618, transfers: ['3', '4'], dwell: 25, demand: 1.5 },
  { id: 'JSL', name: '江苏路', interM: 1466, transfers: ['11'], dwell: 20, demand: 1.2 },
  { id: 'JAS', name: '静安寺', interM: 1425, transfers: ['7', '14'], dwell: 25, demand: 1.5 },
  { id: 'NJX', name: '南京西路', interM: 1490, transfers: ['12', '13'], dwell: 25, demand: 1.5 },
  { id: 'RMG', name: '人民广场', interM: 1330, transfers: ['1', '8'], dwell: 25, demand: 2.0 },
  { id: 'NJD', name: '南京东路', interM: 1125, transfers: ['10'], dwell: 25, demand: 1.6 },
  { id: 'LJZ', name: '陆家嘴', interM: 1834, transfers: ['14'], dwell: 25, demand: 1.6 },
  { id: 'PDN', name: '浦东南路', formerName: '东昌路', interM: 1367, transfers: ['14'], dwell: 20, demand: 1.0 },
  { id: 'SJD', name: '世纪大道', interM: 1245, transfers: ['4', '6', '9'], dwell: 25, demand: 2.0 },
  { id: 'KJG', name: '上海科技馆', interM: 1810, transfers: [], dwell: 20, demand: 0.8 },
  { id: 'SJG', name: '世纪公园', interM: 1454, transfers: [], dwell: 20, demand: 0.8 },
  { id: 'LYL', name: '龙阳路', interM: 1100, transfers: ['7', '16', '18', '磁浮'], dwell: 25, demand: 1.4 },
  { id: 'ZJG', name: '张江高科', interM: 2940, transfers: [], dwell: 20, demand: 1.2 },
  { id: 'JKL', name: '金科路', interM: 1393, transfers: [], dwell: 20, demand: 0.9 },
  { id: 'GLL', name: '广兰路', interM: 2055, transfers: [], dwell: 20, demand: 1.0, sidePlatform: ['DN'] },
  { id: 'TZ', name: '唐镇', interM: 3393, transfers: [], dwell: 20, demand: 0.9 },
  { id: 'CXZ', name: '创新中路', interM: 1788, transfers: [], dwell: 20, demand: 0.5, sidePlatform: ['DN', 'UP'] },
  { id: 'HXD', name: '华夏东路', interM: 2100, transfers: [], dwell: 20, demand: 0.6 },
  { id: 'CS', name: '川沙', interM: 2756, transfers: [], dwell: 20, demand: 0.8, sidePlatform: ['DN', 'UP'] },
  { id: 'LKL', name: '凌空路', interM: 2595, transfers: [], dwell: 20, demand: 0.4, sidePlatform: ['DN', 'UP'] },
  { id: 'YDD', name: '远东大道', interM: 3070, transfers: [], dwell: 20, demand: 0.3 },
  { id: 'HTS', name: '海天三路', interM: 5918, transfers: [], dwell: 20, demand: 0.3 },
  { id: 'PDA', name: '浦东1号2号航站楼', formerName: '浦东国际机场', interM: 2287, transfers: ['磁浮', '机场联络线'], dwell: 20, demand: 0.9, sidePlatform: ['DN', 'UP'] },
];

/** English station names as on the platform screens (Shanghai Metro sign style, approximation) */
export const STATION_EN: Record<string, string> = {
  PXL: 'Panxiang Rd. • SNAI', GJH: 'National Exhibition and Convention Center', HQZ: 'Hongqiao Railway Station',
  HQ2: 'Hongqiao Airport Terminal 2', SHR: 'Songhong Rd.', BXJ: 'Beixinjing', WNL: 'Weining Rd.', LSG: 'Loushanguan Rd.',
  ZSG: 'Zhongshan Park', JSL: 'Jiangsu Rd.', JAS: "Jing'an Temple", NJX: 'West Nanjing Rd.', RMG: "People's Square",
  NJD: 'East Nanjing Rd.', LJZ: 'Lujiazui', PDN: 'South Pudong Rd.', SJD: 'Century Avenue', KJG: 'Shanghai Science & Technology Museum',
  SJG: 'Century Park', LYL: 'Longyang Rd.', ZJG: 'Zhangjiang Hi-Tech Park', JKL: 'Jinke Rd.', GLL: 'Guanglan Rd.', TZ: 'Tangzhen',
  CXZ: 'Middle Chuangxin Rd.', HXD: 'East Huaxia Rd.', CS: 'Chuansha', LKL: 'Lingkong Rd.', YDD: 'Yuandong Ave.',
  HTS: 'Haitian 3rd Rd.', PDA: 'Pudong Airport Terminal 1&2',
};

/** Station chainage (platform centre) in metres from 蟠祥路·国家会计学院. */
export function stationChainages(): number[] {
  const out: number[] = [];
  let c = 0;
  for (const s of STATIONS) {
    if (s.interM !== null) c += s.interM;
    out.push(c);
  }
  return out;
}

export const LINE_INFO = {
  name: '上海轨道交通2号线',
  shortName: '2号线',
  color: 0x8cc220,
  colorCss: '#8cc220',
  /** 8-car A-type train length (m) — 02A05 etc. ~185 m over couplers (approx). */
  trainLength: 186,
  /** platform length used for drawing/berths (approx) */
  platformLength: 190,
  maxSpeedKmh: 80,
  /** Rated 2480: Shanghai planning research tables; crush 3200 is a simulation assumption (D29). */
  capacity: 2480,
  crushCapacity: 3200,
  /** total fleet size: 100 trains, see FLEET */
  fleet: 100,
};

/**
 * Line 2 fleet by type with the real train numbers (sources: wiki-02a01,
 * wiki-02a02, wiki-02a03-04, china-emu-02a05, whb-100th). The older types
 * are numbered in the 4-digit form (0201), 02A05 in the 5-digit form (02086).
 * All types are 8-car A-type trains with an 80 km/h maximum operating speed
 * (the sim uses one performance model for all of them).
 */
export const FLEET_TYPES: { type: string; from: number; to: number; digits: 4 | 5; source: string }[] = [
  { type: '02A01', from: 1, to: 16, digits: 4, source: 'wiki-02a01' },
  { type: '02A02', from: 33, to: 53, digits: 4, source: 'wiki-02a02' },
  { type: '02A03', from: 54, to: 69, digits: 4, source: 'wiki-02a03-04' },
  { type: '02A04', from: 70, to: 85, digits: 4, source: 'wiki-02a03-04' },
  { type: '02A05', from: 86, to: 116, digits: 5, source: 'china-emu-02a05' },
];

/** every train of the fleet in number order: { no: '0201' | '02086', type } */
export const FLEET: { no: string; type: string; n: number }[] = FLEET_TYPES.flatMap((ft) =>
  Array.from({ length: ft.to - ft.from + 1 }, (_, i) => {
    const n = ft.from + i;
    return { no: ft.digits === 5 ? `02${String(n).padStart(3, '0')}` : `02${String(n).padStart(2, '0')}`, type: ft.type, n };
  }));

/** fleet entry for a train number, or undefined */
export function fleetEntry(no: string): { no: string; type: string; n: number } | undefined {
  return FLEET.find((f) => f.no === no);
}

/**
 * 上行 / 下行 convention used throughout the UI. The real Shanghai Metro
 * labelling for Line 2 is not stated in the sources; here 下行 = eastbound
 * (towards 浦东1号2号航站楼), 上行 = westbound (approximation).
 */
export const DIRECTIONS = {
  DN: { label: '下行', towards: '往浦东1号2号航站楼', prefix: 'X' },
  UP: { label: '上行', towards: '往蟠祥路·国家会计学院', prefix: 'S' },
} as const;

// ---------------------------------------------------------------------------
// Track layout (APPROXIMATIONS — real positions of switches, crossovers,
// turnback tracks and sidings are not public)
// ---------------------------------------------------------------------------

export type CrossoverKind = '/' | '\\';

export interface CrossoverDef {
  /** station index the crossover belongs to (for naming) */
  station: number;
  /** offset of crossover centre from the station centre (m, + = east) */
  offset: number;
  kind: CrossoverKind;
}

/** a stub track's far end runs on into a depot (出入段线) */
export interface LeadDef {
  /** depot id (LAYOUT.depots) */
  depot: string;
  /** entry-only / exit-only conversion track; omitted = both ways */
  flow?: 'in' | 'out';
}

export interface SidingDef {
  id: string;
  name: string;
  station: number;
  /** direction the stub runs from its attached end towards its buffer */
  side: 'west' | 'east';
  /** signed offset of the attached end from the station centre (m, + = east);
   *  the turnout(s) on the main line lie 40 m back from it */
  at: number;
  length: number;
  /** mains the stub is connected to: both through a Y (default) or one turnout */
  connect?: 'both' | 'UP' | 'DN';
  /** schematic lane: between the mains (default), the upper / lower half of
   *  that space (paired stubs), or outside a main along the platform */
  lane?: SidingLane;
  /** usable for reversing (default true); storage-only sidings set false */
  turnback?: boolean;
  /** the stub is a depot lead: instead of a buffer it runs on into the yard */
  lead?: LeadDef;
  /** a second turnout on the stub, `at` m from its attached end, with a
   *  connector running on to `main` (龙阳路: middle track → UP main) */
  link?: { main: 'UP' | 'DN'; at: number };
}

export type SidingLane = 'mid' | 'midUP' | 'midDN' | 'outUP' | 'outDN';

/** one of the two tracks behind a double Y */
export interface PairStubDef {
  id: string;
  name: string;
  length: number;
  turnback?: boolean;
  lead?: LeadDef;
}

/**
 * Two middle tracks joined to both mains by a double Y with a diamond
 * crossing (双Y形道岔＋菱形交叉, the PDF's common end-of-platform layout): a
 * turnout on each main leads to a splitting turnout, each splitting turnout
 * reaches both middle tracks, and the two crossing legs cross on a diamond.
 * Either middle track is reachable from either main; UP → upper and DN →
 * lower can be used at the same time.
 */
export interface PairDef {
  id: string;
  station: number;
  /** direction the middle tracks run from the junction */
  side: 'west' | 'east';
  /** signed offset of the start of the middle tracks from the station centre (m);
   *  the main-line turnouts lie 80 m back from it */
  at: number;
  /** [upper (UP side), lower (DN side)] */
  stubs: [PairStubDef, PairStubDef];
}

/**
 * Middle track between the mains joined at both ends to both mains through a
 * Y (待避/存车线). With `platform` it runs past an island platform shared with
 * the UP main, and small-loop trains reverse at that platform (广兰路).
 */
export interface LoopDef {
  id: string;
  name: string;
  station: number;
  /** offsets of the west and east Y from the station centre (m) */
  west: number;
  east: number;
  platform?: boolean;
}

export interface TailDef {
  station: number;
  side: 'west' | 'east';
  /** usable tail length beyond the last switch */
  length: number;
  /** scissors crossover between the platform and the tails (default true);
   *  without one the mains just run on to buffers */
  scissors?: boolean;
  /** usable for reversing (default true) */
  turnback?: boolean;
}

export interface DepotDef {
  id: string;
  name: string;
  short: string;
  /** station the depot leads join the line at */
  station: number;
  stablingTracks: number;
  /** 【假设】能力按用户决定及配线图 V2025.26.2 建模；检修库不占停车列位。 */
  work: { daily: boolean; monthly: boolean; overhaul: boolean };
  capacity: number;
  /** seconds from leaving a stabling track to reaching the transfer-track gate */
  exitTime: number;
  source: string;
}

export const LAYOUT = {
  /** terminal tail tracks (站后尾轨). Layout per the 配线图 PDF, see docs/layout-pdf.md */
  tails: [
    // 蟠祥路: the mains run on past the double Y to buffers (storage, no scissors;
    // trains reverse in the two middle tracks)
    { station: 0, side: 'west', length: 465, scissors: false, turnback: false },
    // 航站楼: scissors right behind the platform, both mains on to buffers.
    // Assumed usable rescue length: two 186 m consists plus stopping margin.
    { station: 30, side: 'east', length: 450 },
  ] as TailDef[],
  /** two middle tracks behind a double Y (蟠祥路, 国家会展中心, 淞虹路, 上海科技馆) */
  // (PXL: 420 m, model value — holds a coupled rescue pair clear of the throat)
  pairs: [
    { id: 'PXL', station: 0, side: 'west', at: -205, stubs: [
      { id: 'PXL1', name: '蟠祥路1道折返线', length: 420 },
      { id: 'PXL2', name: '蟠祥路2道折返线', length: 420 },
    ] },
    { id: 'GJH', station: 1, side: 'west', at: -205, stubs: [
      { id: 'GJH1', name: '国家会展中心1道尽头线', length: 400 },
      { id: 'GJH2', name: '国家会展中心2道尽头线', length: 400 },
    ] },
    // the two 北翟路 出入段线, both ways: 1道 runs straight onto the UP main,
    // 2道 onto the DN main (the diamond reaches the other one). They double as
    // the 淞虹路 turnback tracks.
    { id: 'SHR', station: 4, side: 'west', at: -205, stubs: [
      { id: 'SHR1', name: '淞虹路1道（出入段线）', length: 260, lead: { depot: 'BZL' } },
      { id: 'SHR2', name: '淞虹路2道（出入段线）', length: 260, lead: { depot: 'BZL' } },
    ] },
    { id: 'KJG', station: 17, side: 'east', at: 205, stubs: [
      { id: 'KJG1', name: '上海科技馆1道折返线', length: 350 },
      { id: 'KJG2', name: '上海科技馆2道折返线', length: 350 },
    ] },
  ] as PairDef[],
  /** stub sidings (尽头线) and single depot leads */
  sidings: [
    { id: 'WNL', name: '威宁路存车线', station: 6, side: 'west', at: 110, length: 300, connect: 'UP', lane: 'outUP', turnback: false },
    { id: 'RMG', name: '人民广场存车线', station: 12, side: 'east', at: -110, length: 300, connect: 'DN', lane: 'outDN', turnback: false },
    // 龙阳路: middle track behind a Y off both mains; a connector climbs from it
    // to the UP main, so eastbound trains reach the depot leads on the UP main
    { id: 'LYL', name: '龙阳路折返线', station: 19, side: 'east', at: 170, length: 400, link: { main: 'UP', at: 120 } },
    { id: 'LYD1', name: '龙阳路入段线', station: 19, side: 'east', at: 490, length: 300, connect: 'UP', lane: 'outUP', turnback: false, lead: { depot: 'LYD', flow: 'in' } },
    { id: 'LYD2', name: '龙阳路出段线', station: 19, side: 'east', at: 640, length: 300, connect: 'UP', lane: 'outUP', turnback: false, lead: { depot: 'LYD', flow: 'out' } },
    // 远东大道: the middle track behind a Y is a 川沙 lead (it passes the UP
    // main on a flyover); the exit lead leaves the UP main
    // two-way: the only lead that reaches the DN main
    { id: 'YDD1', name: '远东大道出入段线', station: 28, side: 'east', at: 170, length: 300, lead: { depot: 'CSD' } },
    { id: 'YDD2', name: '远东大道出段线', station: 28, side: 'east', at: 230, length: 240, connect: 'UP', lane: 'outUP', turnback: false, lead: { depot: 'CSD', flow: 'out' } },
    // 海天三路: middle stub west of the platform behind a Y (PDF; not in earlier notes)
    { id: 'HTS', name: '海天三路尽头线', station: 29, side: 'west', at: -170, length: 300 },
  ] as SidingDef[],
  loops: [
    { id: 'GLL', name: '广兰路中间线', station: 22, west: -170, east: 170, platform: true },
    { id: 'CXZ', name: '创新中路中间线', station: 24, west: -170, east: 170 },
  ] as LoopDef[],
  /** single crossovers (渡线); a scissors is a '/' and a '\' next to each other */
  crossovers: [
    // 虹桥火车站: none — the PDF draws none (it does draw minor ones such as
    // 威宁路 / 凌空路); trains for the 虹桥 hub turn at 国家会展中心
    { station: 6, offset: 215, kind: '/' },
    // 中山公园: scissors right behind the platform (towards 江苏路)
    { station: 8, offset: 175, kind: '/' },
    { station: 8, offset: 295, kind: '\\' },
    { station: 12, offset: -215, kind: '/' },
    { station: 27, offset: -215, kind: '\\' },
  ] as CrossoverDef[],
  depots: [
    {
      id: 'BZL', name: '北翟路车辆段', short: '北翟路', station: 4,
      work: { daily: true, monthly: true, overhaul: true },
      stablingTracks: 14, capacity: 36, exitTime: 240, source: 'wiki-depots（接轨淞虹路，淞虹路西北）; pdf-peixian（两条出入段线在淞虹路站台西端经双Y接两正线）',
    },
    {
      id: 'LYD', name: '龙阳路车辆段', short: '龙阳路', station: 19,
      work: { daily: true, monthly: true, overhaul: false },
      stablingTracks: 12, capacity: 24, exitTime: 240, source: 'wiki-depots（接轨龙阳路，龙阳路东北）; pdf-peixian（出入段线接上行正线）',
    },
    {
      id: 'CSD', name: '川沙停车场', short: '川沙', station: 28,
      work: { daily: true, monthly: false, overhaul: false },
      stablingTracks: 8, capacity: 32, exitTime: 200, source: 'wiki-depots（接轨远东大道，远东大道东）; pdf-peixian',
    },
  ] as DepotDef[],
  /** ZC (zone controller) / TBTC control areas, by station index boundaries */
  zones: [
    { id: 'ZC1', name: 'ZC1 蟠祥路—娄山关路', fromStation: 0, toStation: 7 },
    { id: 'ZC2', name: 'ZC2 中山公园—浦东南路', fromStation: 8, toStation: 15 },
    { id: 'ZC3', name: 'ZC3 世纪大道—广兰路', fromStation: 16, toStation: 22 },
    { id: 'ZC4', name: 'ZC4 唐镇—浦东1号2号航站楼', fromStation: 23, toStation: 30 },
  ],
  /** maximum plain-line axle-counter section length (m) */
  maxSectionLength: 450,
};

/**
 * Permanent speed restrictions (km/h) by chainage range, both tracks.
 * Line maximum is 80 km/h (source: china-emu-02a05); local restrictions
 * below are approximations for curves / river crossing / terminal approach.
 */
export const SPEED_LIMITS: { from: number; to: number; kmh: number; reason: string }[] = [
  { from: -1000, to: 250, kmh: 55, reason: '终点站区域' },
  { from: 3200, to: 3800, kmh: 60, reason: '虹桥枢纽曲线' },
  { from: 14800, to: 15500, kmh: 65, reason: '中山公园站曲线' },
  { from: 17200, to: 17800, kmh: 65, reason: '静安寺曲线' },
  { from: 22500, to: 23400, kmh: 70, reason: '南京东路—陆家嘴（越江段）' },
  { from: 23400, to: 25600, kmh: 65, reason: '越江隧道及陆家嘴曲线' },
  { from: 30900, to: 31500, kmh: 65, reason: '龙阳路站曲线' },
  { from: 61650, to: 63000, kmh: 55, reason: '终点站区域' },
];

/** diverging speeds (km/h) — approximations for 9号 / 12号 turnouts */
export const TURNOUT_SPEEDS = {
  crossover: 35,
  siding: 30,
  depot: 25,
  tail: 40,
};

// ---------------------------------------------------------------------------
// Operations (published anchors + approximations)
// ---------------------------------------------------------------------------

export const OPERATIONS = {
  /** 【假设】均衡修简化：任何有列检能力的车场过夜即列检；正线过夜不算。
   * 交接资料：列检不超过15天、月检不超过3个月；月检计划60天、占库1天。
   * 交接来源：02A05首批23列（2025-02至2026-12）架修招标、解放日报2026-09-25均衡修报道；同时1列、30天为模拟假设。
   * 累计里程只显示，不据此停用；检修库不占停车列位（D112）。 */
  maintenance: { dailyLimit: 15, monthlyPeriod: 60, monthlyLimit: 90, monthlyDays: 1, overhaulDays: 30, overhaulCount: 1 },
  /** 【假设】每个方向的站间区间最多一列；过江段同样取一列。 */
  intervalTrainLimits: STATIONS.slice(0, -1).map((s, i) => ({ from: s.id, to: STATIONS[i + 1].id, limit: 1 })),
  /** 【假设】全天训练故障预算、相对权重与大部件故障日概率；不是实测故障率。 */
  randomFaults: {
    levels: [{ count: 4, majorProbability: .1 }, { count: 8, majorProbability: .25 }, { count: 15, majorProbability: .5 }],
    crowdWindows: [[7*3600,9.5*3600],[17*3600,19.5*3600]],
    kinds: [
      {kind:'door',weight:5,scope:'passenger',vehicle:true,minLevel:1},
      {kind:'psd',weight:5,scope:'passenger',minLevel:1},
      {kind:'pecu',weight:5,scope:'passenger',minLevel:1},
      {kind:'surge',weight:4,scope:'peak',minLevel:1},
      {kind:'trainComm',weight:4,scope:'passenger',vehicle:true,minLevel:1},
      {kind:'trainDto',weight:3,scope:'passenger',vehicle:true,minLevel:1},
      {kind:'switch',weight:1,scope:'all',minLevel:2},
      {kind:'axle',weight:1,scope:'all',minLevel:2},
      {kind:'signal',weight:1,scope:'all',minLevel:2},
      {kind:'zcFail',weight:.5,scope:'all',minLevel:3},
      {kind:'wind',weight:.5,scope:'all',minLevel:3},
      {kind:'rain',weight:.5,scope:'all',minLevel:3},
    ] as {kind:string;weight:number;scope:'passenger'|'peak'|'all';vehicle?:boolean;minLevel:number}[],
    majorKinds: ['traction','brake'],
  },
  /** published: first train from 蟠祥路·国家会计学院 05:25 */
  firstWestTerminusDep: 5 * 3600 + 25 * 60,
  /** published: first westbound from 浦东1号2号航站楼 06:00 */
  firstEastTerminusDep: 6 * 3600,
  /** published: last 蟠祥路 → 浦东1号2号航站楼 21:57 */
  lastBigEastboundDep: 21 * 3600 + 57 * 60,
  /** published: last 蟠祥路 → 广兰路 22:42 */
  lastLateEastboundDep: 22 * 3600 + 42 * 60,
  /** published: last westbound departure from 浦东1号2号航站楼 22:30 */
  lastBigWestboundDep: 22 * 3600 + 30 * 60,
  /** published arrival, checked independently of the origin departure */
  lastBigWestboundArrival: 24 * 3600 + 5 * 60,
  /** reference headways (late 2025): core 2'30", outer ≈3'45" average */
  peakCoreHeadway: 150,
  /** minimum turnback (arrival → departure) at each terminal (approx) */
  // GLL reverses on its middle-track platform (配线图 PDF): a change of ends
  // on the platform without a run into a tail.
  minTurnback: { PXL: 240, PDA: 240, SHR: 240, GLL: 100 } as Record<string, number>,
  /** platform turnback track: minimum time from one turning train's departure
   *  to the next turning train's arrival on the same track (s). The leaving
   *  train must clear the shared west throat before the next entry route
   *  sets, and the next train then runs over the turnout at about 25 km/h.
   *  【假设】 from the simulator (2026-10-15), real values are not published:
   *  turns 68 s and 90 s apart run clean with the next train arriving at
   *  speed; the D72 morning plan's 40 s gaps lost about 60 s per turn,
   *  and once queued (next train standing at the signal) a cycle took 3'30". */
  platformTurnClear: { GLL: 60 } as Record<string, number>,
  /** Direct passenger retirement boundaries, from the depot portal topology.
   * A daily circulation chooses homes within the yards' balanced quotas. */
  depotReturns: [
    { depot: 'BZL', dir: 'UP', station: 'SHR' },
    { depot: 'LYD', dir: 'DN', station: 'LYL' },
    // 用户决定：通常直接回库，服务需要时先到机场，再折返远东大道入库。
    // 【假设】收车后的服务间隔不超过所跨原图最大间隔的两倍，随当日原图变化。
    { depot: 'CSD', dir: 'DN', station: 'YDD', service: { terminal: 'PDA', intervalMultiplier: 2 } },
  ] as { depot: string; dir: 'UP' | 'DN'; station: string; service?: { terminal: string; intervalMultiplier: number } }[],
  /** 【假设】八列正线过夜车：端站留开班所需车，存车泊位依配线图。 */
  overnightStabling: [
    { station: 'PXL', count: 2, departure: 'DN', kind: 'terminal' },
    { station: 'PDA', count: 1, departure: 'UP', kind: 'terminal' },
    { station: 'GLL', count: 1, departure: 'UP', kind: 'platform', track: 'turnback' },
    { station: 'GLL', count: 1, departure: 'DN', kind: 'platform' },
    { station: 'KJG', count: 2, departure: 'UP', kind: 'origin', origin: 'LYL', nightAfter: 21 * 3600 + 40 * 60 },
    { station: 'CXZ', count: 1, departure: 'DN', kind: 'feeder', nightAfter: 22 * 3600 + 30 * 60 },
  ] as { station: string; count: number; departure: 'UP' | 'DN'; kind: 'terminal' | 'platform' | 'origin' | 'feeder'; origin?: string; track?: 'turnback'; nightAfter?: number }[],
  /** 【假设】平峰热备共用夜间泊位；中途两处各一列，按配线方向进出。 */
  hotStandby: [
    { station: 'PXL', track: 'turnback', berth: 0 },
    { station: 'PDA', track: 'turnback', berth: 0 },
    { station: 'KJG', track: 'turnback', berth: 0, depot: 'BZL', incoming: 'DN' },
    { station: 'CXZ', track: 'storage', berth: 0, depot: 'CSD', incoming: 'UP' },
  ] as { station: string; track: 'turnback' | 'storage'; berth: number; depot?: string; incoming?: 'UP' | 'DN' }[],
  /** a train passing a platform without stopping (跨站/跳停) runs through it at no more than this (km/h) */
  platformPassKmh: 45,
  /** a train entering or leaving a platform it stops at runs at no more than this (km/h) */
  platformStopKmh: 50,
  /** planned run time margin over the minimum ATO run between stations */
  runMargin: 0.16,
  /** ATO with a driver (DTO degraded / ATO operation): change of ends at a
   *  turnback, on top of the unattended DTO reversal (s) 【假设】 */
  atoEndChange: 45,
  /** ATO with a driver: departure after the doors close waits for the driver's
   *  ATO start button (s) 【假设】 */
  atoStartDelay: 3,
};

/**
 * A fixed-time special train run (定点班车 / 加班车): from `from` to `to` at
 * the listed departures, boarding only at `board`, setting down only at
 * `alight` (and at `to`), passing the other stations at the platform pass
 * limit. The train comes from `depotFrom`'s side and goes into `depotTo`.
 */
export interface FixedRun {
  from: string; to: string;
  /** departures from `from` (s since midnight of the service day) */
  departures: number[];
  /** stations where passengers may board (and alight) */
  board: string[];
  /** stations where passengers may only alight */
  alight: string[];
  depotFrom: string; depotTo: string;
}

/**
 * Regular fixed-time trains after the last train (常态末班车后定点班车),
 * published timetable: 虹桥火车站 23:04 / 23:30 → 龙阳路, boarding only at
 * 虹桥火车站 and 虹桥2号航站楼 (two minutes later), set-down only at the listed
 * stations (威宁路 since 2025-12-31), passing the others.
 */
export const HQ_LATE_RUN: FixedRun = {
  from: 'HQZ', to: 'LYL',
  departures: [23 * 3600 + 4 * 60, 23 * 3600 + 30 * 60],
  board: ['HQZ', 'HQ2'],
  alight: ['SHR', 'WNL', 'ZSG', 'JAS', 'RMG', 'SJD'],
  depotFrom: 'BZL', depotTo: 'LYD',
};
export const FIXED_LATE_TRAINS: FixedRun[] = [HQ_LATE_RUN];

// ---------------------------------------------------------------------------
// Environment (APPROXIMATIONS)
// ---------------------------------------------------------------------------

/**
 * Exposed parts: the paired portal symbols between 龙阳路—张江高科 and
 * the portal between 凌空路—远东大道 in pdf-peixian; user correction 2026-10-19.
 * 金科路—凌空路 is underground. The PDF is schematic, not a distance scale.
 * 【假设】first portals K32.7–33.2: about 500 m, consistent with the recorded
 * 25.50 s outside at 60–80 km/h (docs/recordings.md). Eastern portal K52.5;
 * exact portal chainages and the airport ground transition remain approximate.
 */
export const EXPOSED: { from: number; to: number; kind: 'elevated' | 'ground'; name: string }[] = [
  { from: 32700, to: 33200, kind: 'elevated', name: '龙阳路—张江高科 区间露天段' },
  { from: 52500, to: 60900, kind: 'elevated', name: '凌空路—远东大道出洞至海天三路 高架段' },
  { from: 60900, to: 63000, kind: 'ground', name: '浦东1号2号航站楼 地面段' },
];

/** Historical D65 vertical-profile anchors used by the calibrated running
 * model, not surface classifications. Keep them independent of weather
 * exposure: correcting tunnel portals must not silently recalibrate running
 * times. 【假设】heights/grades remain synthetic pending a profile-specific task. */
export const PROFILE_ANCHORS = { elevatedFrom:37400, groundFrom:60900 };

/**
 * Weather restrictions for exposed sections (approximation of typical
 * operating rules): wind level index 1..4 ≈ 7/8/9/≥10 级 (Beaufort), rain = 暴雨.
 * 0 km/h = service suspended on viaducts.
 */
export const WEATHER_RULES = {
  wind: [
    { level: 1, label: '大风蓝色（7级）', kmh: 60, elevatedOnly: true },
    { level: 2, label: '大风黄色（8级）', kmh: 45, elevatedOnly: true },
    { level: 3, label: '大风橙色（9级）', kmh: 25, elevatedOnly: true },
    { level: 4, label: '大风红色（≥10级）', kmh: 0, elevatedOnly: true },
  ],
  rain: { label: '暴雨', kmh: 60, elevatedOnly: false },
};

/**
 * Night engineering possessions (施工封锁): candidate station intervals
 * (west station index; the interval runs to the next station) and the
 * usual time window. Approximation — real 施工计划 are not public.
 */
export const POSSESSIONS = {
  candidates: [5, 6, 9, 13, 17, 20, 23, 24, 26],
  /** possessions active at the start of the operating day, released before the first trains */
  morningUntil: 4 * 3600 + 20 * 60,
  /** late-night window (must finish before the 03:45 day rollover) */
  nightFrom: 24 * 3600 + 50 * 60,
  nightTo: 27 * 3600 + 30 * 60,
};
