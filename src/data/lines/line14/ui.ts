import type { LineUiData } from '../../ui';

/** 文案依据14号线DMI/PIS实拍及用户决定；线路色取全网配线PDF14号线色块RGB 98/96/32。 */
export const LINE14_UI: LineUiData = {
  documentTitle: '上海轨道交通14号线 ATS 中央监视',
  bootTitle: '上海轨道交通14号线 · ATS 中央监视',
  desktopTitle: '上海轨道交通14号线 ATS 模拟器',
  headerTitle: '上海轨道交通14号线列车自动监控系统',
  headerSubtitle: 'ATS · OCC 行车调度 · CBTC / FAM 全自动运行',
  lineNameEn: 'Line 14', pisColorCss: '#626020', preferencePrefix: 'ats14',
  dmiStyle: 'statusGrid', pisStyle: 'column', dmiSpeedWarning: 'target',
  tripNumber: { prefix: '14', source: 'duty', digits: 3 },
  environmentTitle: '环境（全地下正线）',
  faultProcedures: {
    trainComm: '后果：车地通信中断，CBTC移动授权丢失，列车紧急制动。处置：随车人员停稳报告OCC，获得缓解授权后先关门，再按接管步骤转RM限速驾驶；通信与CBTC恢复后按恢复步骤申请FAM。本线没有TBTC后备。',
    zcFail: '后果：故障区域内CBTC授权不可用，列车受ATP防护停车。处置：随车人员报告OCC，停稳后按接管步骤转RM；修复并恢复CBTC后再申请FAM。本线没有TBTC后备，不能切换TBTC代替处置。',
    trainUto: '后果：车载全自动功能不可用，CBTC正常时由随车人员接管ATPM。处置：先关门锁紧，完成报告OCC、钥匙、FAM开关归0、手柄制动、模式确认；OCC可远程复位，成功后按恢复步骤升回FAM，失败后运行至终点退出服务或安排回段。',
    psdLink: '后果：车门与站台门联动失效。处置：车站人员在PSL操作站台门并确认，列车保持FAM；每次开关门等待车站完成确认，修复后恢复联动。',
    trainFail: '后果：列车故障停车。处置：随车人员报告OCC并进行车上处置；可恢复时等待恢复，不能恢复时按来电申请组织救援，避免后车进入故障列车占用区段。',
    traction: '后果：切除牵引单元后加速能力下降。处置：随车人员报告OCC，按故障状态选择继续至终点退出服务、前方站清客回段或留待夜间检修；可自行恢复时等待车载复位。',
    door: '后果：车门无法关闭锁紧，列车不能发车。处置：随车人员处理并隔离故障车门；不能隔离时本站清客、锁闭车门回段或等候检修。放行仍须满足车门和站台门安全条件。',
    brake: '后果：制动不缓解，列车暂不能发车。处置：随车人员尝试恢复；恢复失败时按故障程度切除并限速、终点退出服务、前方站清客回段，或申请救援。',
    pecu: '后果：车内紧急对讲触发，随车人员向OCC报告。处置：按来电判断是否区间停车或进前方站处理，未应答时按既有紧急处置流程停车。',
  },
  helpIntro: '封浜—桂桥路，31座建成车站，龙居路未开通；全地下，常态FAM全自动运行。监视列车、处置设备与客流故障，随车人员按OCC授权接管。',
  helpDmi: '跟踪列车可查看DMI。表盘0–90 km/h，分别显示实际、目标和最大速度；目标距离采用非线性刻度。实际超过目标速度显示速度警告。模式列包含ATP、ATO和FAM，底部显示车号与车次号。随车人员接管须先关门，再完成报OCC、插钥匙、模式开关归0、手柄制动和模式确认；CBTC正常可用ATPM，失联降级RM。',
  helpScenarios: '暂无预设教员场景。可设置随机故障难度、手动注入故障和天气；UTO车载故障由随车人员接管，可由OCC远程复位。',
  helpEnvironment: '正线全地下，外界风雨不直接改变隧道限速；隧道湿滑可全年随机触发进站冲标，由随车人员转RM按5 km/h退回对标。',
  holidayNotice: { eve: '国庆前夜：20:00起豫园站封站跳停至运营结束。', day: '天：16:00起豫园站封站跳停至运营结束', returning: '', suffix: '。法定节假日按双休日图运行【假设】，封站日期按官方公告。' },
  stationNameLines: { '一大会址·黄陂南路': ['一大会址·', '黄陂南路'], '浦东足球场': ['浦东', '足球场'] },
  transferColors: { '1': 0xe3002b, '2': 0x8cc220, '3': 0xfcd600, '4': 0x461d84, '6': 0xd40068, '7': 0xed6f00, '8': 0x0094d8, '9': 0x87caed, '10': 0xc6afd4, '11': 0x871c2b, '13': 0xe999c0, '14': 0x626020, '15': 0xbca886, '18': 0xc4984f },
  overviewWidth: 7200, // 【假设】ATS概览画布尺寸，仅布局用途
};
