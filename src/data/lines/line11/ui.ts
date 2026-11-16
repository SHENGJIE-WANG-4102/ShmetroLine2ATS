import type { LineUiData } from '../../ui';
import { LINE14_UI } from '../line14/ui';

/** 11号线界面文案。DMI 按 11A02 实拍（青绿底，tealPanel）；站台 PIS 用 2 号线普通站台的横屏
 * （用户决定 2026-11-14）。DMI 告警字样沿用 14 号线【假设】。故障处置说明按本线司机驾驶、无 TBTC 后备写，
 * 只写仿真里真会发生的处置（不沿用 14 号线随车人员/FAM 或 2 号线 TBTC/DTO 的说法）；没列的用通用司机版。 */
export const LINE11_UI: LineUiData = {
  ...LINE14_UI,
  dmiStyle: 'tealPanel', pisStyle: 'landscape',
  documentTitle: '上海轨道交通11号线 ATS 中央监视',
  bootTitle: '上海轨道交通11号线 · ATS 中央监视',
  desktopTitle: '上海轨道交通11号线 ATS 模拟器',
  headerTitle: '上海轨道交通11号线列车自动监控系统',
  headerSubtitle: 'ATS · OCC 行车调度 · CBTC / ATO 有人驾驶',
  lineNameEn: 'Line 11', pisColorCss: '#871c2b', preferencePrefix: 'ats11',
  tripNumber: { prefix: '11', source: 'duty', digits: 3 },
  environmentTitle: '环境（11号线）',
  helpIntro: '嘉定北—迪士尼主线、花桥—上海赛车场支线在嘉定新城汇入，40座车站；CBTC/ATO 有人驾驶，曹杨路司机换班。',
  helpDmi: '跟踪列车可查看 DMI。表盘按 11号线最高 100 km/h，显示实际、目标和最大速度。',
  helpScenarios: '暂无预设教员场景。可设置随机故障难度、手动注入故障和天气。',
  helpEnvironment: '11号线嘉定段、迪士尼段有高架/地面，但缺逐段实拍，暂按全地下处理【假设】。',
  holidayNotice: { eve: '', day: '', returning: '', suffix: '。法定节假日按双休日图运行【假设】。' },
  stationNameLines: {
    '上海汽车城': ['上海', '汽车城'], '上海赛车场': ['上海', '赛车场'], '嘉定新城': ['嘉定', '新城'],
    '东方体育中心': ['东方', '体育中心'], '上海游泳馆': ['上海', '游泳馆'], '上海西站': ['上海', '西站'],
    '康新公路': ['康新', '公路'],
  },
  transferColors: {
    '1': 0xe3002b, '2': 0x8cc220, '3': 0xfcd600, '4': 0x461d84, '6': 0xd40068, '8': 0x0094d8,
    '9': 0x87caed, '10': 0xc6afd4, '12': 0x007a60, '13': 0xe999c0, '14': 0x626020, '15': 0xbca886,
    '18': 0xc4984f, '苏州11': 0x8a8b8c,
  },
  pisRouteBadges: {},
  faultProcedures: {
    trainComm: '后果：车地通信中断，CBTC移动授权丢失，列车紧急制动停车。本线没有TBTC后备。处置：司机停稳报告OCC，原地等待车地通信恢复；恢复后同意缓解紧急制动，列车回到CBTC继续运行。',
    zcFail: '后果：故障区域内CBTC列车失去移动授权，紧急制动停车，后续列车在区域外停车。本线没有TBTC后备，不能切换后备系统。处置：司机停稳报告OCC，原地等待ZC修复重启；修复后区域自动恢复CBTC，同意缓解紧急制动后继续运行。',
    trainAto: '后果：车载ATO功能故障，列车不能自动驾驶，制动停车后司机转ATPM人工驾驶，载客运行至终点站退出运营。处置：确认司机已转ATPM；故障修复后停站时恢复自动驾驶，取消终点站退出运营。',
    psdLink: '后果：车门与站台门不能联动，由车站人员在PSL开关站台门，每次开/关约多耗时15秒；列车仍按ATO运行。处置：通知车站PSL操作；修复后自动恢复联动。',
  },
  overviewWidth: 9000, // 【假设】ATS 概览画布尺寸，仅布局用途
  overviewRows: 4, // 用户决定（2026-11-14）：全线总览画成 4 排
};
