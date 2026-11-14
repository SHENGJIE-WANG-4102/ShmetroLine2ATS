import type { LineUiData } from '../../ui';
import { LINE14_UI } from '../line14/ui';

/** 11号线界面文案。【假设】没有逐站 DMI/PIS 实拍，屏型、告警字样和设备处置文案沿用
 * 14 号线同一套通用模板；只把线路名、颜色、换乘信息换成 11 号线的。见汇报“继承的占位”。 */
export const LINE11_UI: LineUiData = {
  ...LINE14_UI,
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
  overviewWidth: 9000, // 【假设】ATS 概览画布尺寸，仅布局用途
};
