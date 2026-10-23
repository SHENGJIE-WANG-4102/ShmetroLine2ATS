import { LINE } from '../data/current';
/**
 * Help / onboarding overlay for non-experts: a short guided tour on the
 * first run (pages), plus reference pages for controls, colours and a
 * glossary of the signalling terms used on screen. F1 / “?” reopens it.
 */
import { h, clear } from './dom';
import { loadPref, savePref } from './layout';

interface Page { title: string; body: () => HTMLElement }

const sw = (color: string, text: string) => h('li', {}, h('span', { class: 'sw', style: `background:${color}` }), text);
const kb = (k: string) => h('b', { class: 'kbd' }, k);

const PAGES: Page[] = [
  {
    title: `欢迎：你是${LINE.branding.shortName}的行车调度员`,
    body: () => h('div', {},
      h('p', {}, LINE.ui.helpIntro),
      h('h3', {}, '屏幕分区'),
      h('ul', {},
        h('li', {}, h('b', {}, '顶部状态栏'), '：时钟与仿真速率、系统名称、各 ZC 区域的信号级别（CBTC/TBTC）、今日客流与正点率等指标、报警计数；右端「设置」菜单含界面缩放、声音（二级菜单）、运营日、诊断导出、帮助。'),
        h('li', {}, h('b', {}, '线路总览（主区）'), '：全线轨道示意图，折成多行；车次窗显示每列车。滚轮缩放、拖动平移。'),
        h('li', {}, h('b', {}, '运行图（下方条带）'), '：灰蓝细线为计划，彩色粗线为实际运行轨迹（绿=正点，黄=晚点2–5分，橙=晚点>5分）。'),
        h('li', {}, h('b', {}, '右侧栏'), '：报警（有报警时展开闪烁）、来电（司机/车站的无线和电话）、详情与命令、列车表、事件、教员、回放。'),
      ),
      h('p', { class: 'hint' }, '提示：本页可随时按 F1 或右上角“?”重新打开。'),
    ),
  },
  {
    title: '基本操作：先选中，再下命令',
    body: () => h('div', {},
      h('ol', {},
        h('li', {}, '在图上点击任意对象（列车车次窗、信号机、道岔、区段、站台、车站名、车辆段），右侧“详情”页显示它的状态和可用命令。'),
        h('li', {}, '点击命令按钮会弹出确认框；安全相关命令（如计轴预复位、引导进路、封锁/解封、切换TBTC）需要', h('b', {}, '二次确认'), '，按钮位置会互换以防误点。'),
        h('li', {}, '点击', h('b', {}, '车站名'), '再点“打开车站图”，进入该站联锁界面：先点功能按钮（排列进路、定位/反位、单锁、封锁…），再点设备。'),
        h('li', {}, '点击', h('b', {}, '车辆段'), '方框打开车场图：每股停车线上停放的车辆号、计划出段、回段途中的列车。'),
        h('li', {}, '报警行可点击：自动确认并在图上定位。来电必须在倒计时内应答，否则会有后果（列车停车等待、乘客滞留、司机自行处置等）。'),
      ),
      h('h3', {}, '视图'),
      h('ul', {},
        h('li', {}, '总览只显示调度需要的信息；信号机编号、区段编号、公里标在放大后出现，或用工具栏的“图层”按钮强制显示。'),
        h('li', {}, '工具栏“运行图”可切换为条带 / 隐藏 / 最大化。'),
        h('li', {}, '设置 → 界面缩放调整界面整体缩放（75%–200%），设置会被记住。'),
      ),
    ),
  },
  {
    title: '颜色与符号',
    body: () => h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:20px' },
      h('div', {},
        h('h3', {}, '轨道区段'),
        h('ul', { style: 'list-style:none;padding:0' },
          sw('#3a4c60', '空闲'), sw('#3b5a4d', '自动通过进路锁闭'), sw('#46d47c', '人工/ARS 进路锁闭'),
          sw('#60758c', 'CBTC 列车占用（正常）'), sw('#ff9a3c', '计轴占用（非通信车，需注意）'), sw('#ff4040', '故障占用（报警）'),
          sw('#ffd400', '预复位待压道 / 临时限速（黄色虚线）'), sw('#b07cff', '封锁 / 施工封锁（紫色斜线）'), sw('#5cc8ff', '大风/暴雨限速（蓝色虚线）')),
      ),
      h('div', {},
        h('h3', {}, '列车车次窗'),
        h('ul', {},
          h('li', {}, '“表号-车次”，边框：灰=正点，黄=晚点2–5分，橙=晚点>5分，红=故障/紧急制动。'),
          h('li', {}, '标记：', h('b', {}, '扣'), ' 扣车，', h('b', {}, 'T'), ' 后备TBTC，', h('b', {}, '×'), ' 通信中断，', h('b', {}, 'EB'), ' 紧急制动，', h('b', {}, '人CM/人RM'), ' 人工驾驶，', h('b', {}, "+N'"), ' 晚点N分。'),
          h('li', {}, '底部细条为满载率（蓝→黄→橙）。灰色车次 = 非载客（出入段、回段）。'),
        ),
        h('h3', {}, '信号机'),
        h('ul', {},
          h('li', {}, 'CBTC 区域内列车按移动授权运行，信号机多为灭灯/禁止，总览中以暗色小圈显示，不刷红。'),
          h('li', {}, '后备模式（TBTC）区域内信号机按实际颜色显示。红叉闪烁 = 信号机故障。'),
        ),
        h('h3', {}, '红色'),
        h('p', {}, '红色只用于故障与报警。看到红色，先处理它。'),
      ),
    ),
  },
  {
    title: '跟踪列车与人工驾驶',
    body: () => h('div', {},
      h('p', {}, 'ATO驾驶：接管后，关门锁闭且发车条件满足时，同时按住 F 和 G 启动；提前按无效。'),
      h('p', {}, 'CM速度表的黄色三角和“推荐”是同一ATO控制器此刻给出的参考速度，包含区间预算、运行等级、限速和停车制动；它不代替司机手柄，红色“最大”仍为允许速度。'),
      h('p', {}, '换向器：L 前、K 零、J 后，只能零速操作；CM过标≤5米可自行退行，超过5米须调度同意。退行限速5km/h，退回停车点停稳后开门。'),
      h('p', {}, LINE.ui.helpDmi),
      h('p', {}, '选中列车 → “人工驾驶 CM” 或 “RM”，即可由你驾驶（自动驾驶 AM 随时可恢复）：'),
      h('ul', { class: 'keys' },
        h('li', {}, kb('Z'), ' / ', kb('↑'), '  加牵引 / 缓解制动（P1–P4）'),
        h('li', {}, kb('Q'), ' / ', kb('↓'), '  加制动 / 减牵引（B1–B7）'),
        h('li', {}, kb('S'), '  手柄回中立位 N（惰行）'),
        h('li', {}, kb('E'), '  紧急制动'),
        h('li', {}, kb('Y'), ' 右侧车门　', kb('U'), ' 左侧车门（再按一次关闭）。CM、RM 都只在停准后给站台侧门使能（DMI 车门图标旁绿色箭头）；RM 下站台门不联动，由站务人员操作 PSL。车门未全部关闭不能牵引'),
        h('li', {}, '线上有 CM/RM 列车（人工驾驶或降级）时仿真速率最高 5×，快进会在此时停止；同一时间只能人工驾驶一列车'),
        h('li', {}, '也可直接点击 DMI 下方手柄档位，或在手柄上滚动滚轮。'),
      ),
      h('p', {}, 'ATP 始终监督：超过允许速度立即紧急制动（计安全违章）。RM 模式限速 25 km/h、目视行车。进站对标停车按停车误差评分（±0.3 m 满分，±0.5 m 合格，过标 15 m 内退行，再远越站）。'),
    ),
  },
  {
    title: '教员模式、回放与其它',
    body: () => h('div', {},
      h('ul', {},
        h('li', {}, h('b', {}, '教员'), LINE.ui.helpScenarios),
        h('li', {}, h('b', {}, '回放'), '页：每分钟自动存档（保留2小时）。“回退”从过去某一刻重新处置；“回放”按原命令重演，期间下任何命令即接管。A/B 级报警自动生成书签。'),
        h('li', {}, h('b', {}, 'PIS'), '：选中车站或站台可预览站台乘客信息屏：第一班列车倒计时与终点站；第二、三班每20秒轮换；时间日期与站名每3秒轮换；下方滚动通告。'),
        h('li', {}, h('b', {}, '环境'), LINE.ui.helpEnvironment),
      ),
      h('h3', {}, '快捷键'),
      h('ul', { class: 'keys' },
        h('li', {}, kb('空格'), ' 暂停/继续　', kb('1'), '–', kb('7'), ' 仿真速率　', kb('+'), ' / ', kb('-'), ' 缩放示意图　', kb('0'), ' 全览'),
        h('li', {}, kb('Esc'), ' 取消选择/跟踪/返回总览　', kb('M'), ' 静音　', kb('F1'), ' 帮助　', kb('Ctrl'), '+', kb('+'), ' / ', kb('-'), ' 界面缩放'),
        h('li', {}, '车站图功能键：', kb('Q'), ' 选择 ', kb('R'), ' 排列进路 ', kb('G'), ' 引导 ', kb('C'), ' 取消进路 ', kb('N'), ' / ', kb('V'), ' 定位/反位 ', kb('L'), ' 单锁 ', kb('B'), ' 封锁 ', kb('U'), ' 区故解 ', kb('X'), ' 预复位'),
      ),
    ),
  },
  {
    title: '术语表',
    body: () => h('div', { style: 'columns:2;column-gap:40px' },
      ...([
        ['ATS', '列车自动监控：中央调度系统，自动排列进路（ARS）、运行调整。'],
        ['CBTC', '基于通信的列车控制：车地无线通信，移动闭塞，列车间隔最小。'],
        ['TBTC / 后备模式', '基于轨道电路/计轴的点式后备：固定闭塞，凭信号机行车，间隔变大。'],
        ['ZC', '区域控制器：给 CBTC 列车计算移动授权；ZC 故障时该区域降级。'],
        ['DTO', '有人值守的列车自动运行（正常模式）：自动停站、开关门、发车，终点站无人折返。'],
        ['AM / CM / RM', 'ATO自动驾驶（司机值守，CBTC下为DTO的降级模式，TBTC后备下为常态）/ ATP 监督下人工驾驶 / 限制人工驾驶（≤25 km/h，目视）。AM 折返时司机换端约多45秒，发车需司机按 ATO 启动按钮。'],
        ['EB', '紧急制动。'],
        ['移动授权 MA', '列车被允许走行到的终点（前车尾部、未开放信号机、封锁区段…）。'],
        ['进路', '始端信号机到终端信号机之间、道岔已锁定的一条通路。'],
        ['自动通过进路', '正线直通进路：列车通过后自动重新开放。'],
        ['引导进路', '不检查区段空闲的进路，开放引导信号（红+白），列车 RM 目视通过。'],
        ['单锁 / 封锁', '单锁：道岔锁在当前位置不能转换；封锁：不能排列经过它的进路。'],
        ['失表', '道岔失去位置表示（尖轨不密贴或故障），经过它的进路不能办理。'],
        ['钩锁', '现场人员用钩锁器把道岔固定在某一位置，之后可办引导进路通过。'],
        ['计轴 / 预复位', '计轴设备数轴判断区段占用；故障后预复位，首列车压道出清后恢复。'],
        ['区故解', '区段故障解锁：解除故障后残留的进路锁闭。'],
        ['扣车 / 跳停', '让列车在站停住不发车 / 让列车不停某站通过（通过站台限速45 km/h）。上下行站台都跳停即为封站：出入口关闭，不再进客。'],
        ['站台门互锁解除', '站台门故障不能关闭时，解除站台门与发车的联锁，列车可发车。'],
        ['TSR', '临时限速。'],
        ['ESP', '站台紧急停车按钮：按下后列车不能进出该站台。'],
        ['PECU', '车厢乘客紧急报警（对讲）装置。'],
        ['表号 / 车次', '表号：一列车全天的运用编号；车次：本趟运营的编号。'],
        ['大/小交路', '大交路全程运行；小交路在中途站折返，高峰时加密中心城区。'],
        ['施工封锁 / 销点', '夜间维修作业占用区间；作业完毕销点后才能开通运营。'],
      ] as [string, string][]).map(([k, v]) => h('p', { style: 'break-inside:avoid;margin:0 0 12px' }, h('b', { style: 'color:#fff' }, k), '　', v)),
    ),
  },
];

export function openHelp(root: HTMLElement, startPage = 0) {
  let page = startPage;
  const title = h('span', {});
  const step = h('span', { class: 'steps' });
  const body = h('div', { class: 'modal-b' });
  const prev = h('button', { class: 'btn', onclick: () => go(page - 1) }, '上一页');
  const next = h('button', { class: 'btn primary', onclick: () => (page < PAGES.length - 1 ? go(page + 1) : close()) }, '下一页');
  const back = h('div', { class: 'modal-back help-back' });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'ArrowRight') go(page + 1);
    else if (e.key === 'ArrowLeft') go(page - 1);
  };
  const close = () => {
    savePref('helpSeen', true);
    window.removeEventListener('keydown', onKey, true);
    back.remove();
  };
  const tabs = h('div', { class: 'help-tabs' });
  const go = (p: number) => {
    page = Math.max(0, Math.min(PAGES.length - 1, p));
    title.textContent = PAGES[page].title;
    clear(body);
    body.append(PAGES[page].body());
    clear(step);
    PAGES.forEach((_, i) => step.append(h('span', { class: `dot ${i === page ? 'on' : ''}` })));
    prev.disabled = page === 0;
    next.textContent = page === PAGES.length - 1 ? '开始使用' : '下一页';
    Array.from(tabs.children).forEach((c, i) => c.classList.toggle('on', i === page));
  };
  ['欢迎', '基本操作', '颜色', '驾驶', '教员/回放', '术语'].forEach((t, i) => tabs.append(h('div', { class: 'tab', onclick: () => go(i) }, t)));
  back.append(h('div', { class: 'modal wide help' },
    h('div', { class: 'modal-h' }, title, h('span', { style: 'flex:1' }), step),
    tabs,
    body,
    h('div', { class: 'modal-f' }, h('button', { class: 'btn', style: 'margin-right:auto', onclick: close }, '关闭'), prev, next)));
  window.addEventListener('keydown', onKey, true);
  root.append(back);
  go(page);
  return close;
}

export function helpSeen(): boolean {
  return loadPref('helpSeen', false);
}
