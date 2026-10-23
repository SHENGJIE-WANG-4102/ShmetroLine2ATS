import type { FirstLastRow, OfficialHeadway } from '../../types';
export type { FirstLastRow, OfficialHeadway } from '../../types';
import type { FixedRun } from './line2';

/**
 * Official Line 2 timetable data, all from the same service.shmetro.com page
 * (screenshots supplied by the user): first / last trains, the regular
 * fixed-time trains after the last train, and the published headways. Highest
 * priority source for the plan (D125).
 *
 * Line 2 published first / last trains per station (2号线首末班车时刻表),
 * as shown on 2026-10-14, re-checked 2026-10-22. Departure times at each station; the terminal rows marked 到达 are
 * arrivals. Times after midnight are written past 24:00 (次00:05 → 24:05).
 * '' = no such service at that station.
 *
 * Field check the same evening (platform PIS at 江苏路 / 世纪大道) showed the
 * same first / last times. Used as the calibration target for run times and
 * the first / last-train plan (task: run-time recalibration).
 */



const T: [string, string, string, string, string, string][] = [
  ['蟠祥路·国家会计学院', '05:25', '06:12', '21:57', '24:05', '22:42'],
  ['国家会展中心', '05:28', '06:10', '22:00', '24:03', '22:45'],
  ['虹桥火车站', '05:31', '06:07', '22:03', '24:00', '22:48'],
  ['虹桥2号航站楼', '05:33', '06:05', '22:05', '23:58', '22:50'],
  ['淞虹路', '05:40', '05:58', '22:12', '23:51', '22:57'],
  ['北新泾', '05:42', '05:55', '22:14', '23:49', '22:59'],
  ['威宁路', '05:44', '05:53', '22:16', '23:46', '23:01'],
  ['娄山关路', '05:47', '05:50', '22:19', '23:44', '23:04'],
  ['中山公园', '05:50', '05:47', '22:22', '23:41', '23:07'],
  ['江苏路', '05:52', '05:44', '22:24', '23:38', '23:09'],
  ['静安寺', '05:55', '05:41', '22:27', '23:35', '23:12'],
  ['南京西路', '05:58', '05:39', '22:30', '23:32', '23:15'],
  ['人民广场', '06:01', '05:37', '22:33', '23:30', '23:18'],
  ['南京东路', '06:03', '05:34', '22:35', '23:27', '23:20'],
  ['陆家嘴', '06:06', '05:31', '22:38', '23:24', '23:23'],
  ['浦东南路', '06:08', '05:29', '22:40', '23:21', '23:25'],
  ['世纪大道', '06:11', '05:27', '22:43', '23:19', '23:28'],
  ['上海科技馆', '06:14', '05:24', '22:45', '23:16', '23:31'],
  ['世纪公园', '06:16', '05:21', '22:48', '23:13', '23:33'],
  ['龙阳路', '06:18', '05:20', '22:50', '23:11', '23:35'],
  ['张江高科', '06:22', '05:33', '22:54', '23:07', '23:39'],
  ['金科路', '06:25', '05:31', '22:56', '23:05', '23:42'],
  ['广兰路', '06:00', '05:28', '23:00', '23:02', '23:44'],
  ['唐镇', '06:04', '06:29', '23:04', '22:58', ''],
  ['创新中路', '06:08', '06:26', '23:07', '22:54', ''],
  ['华夏东路', '06:11', '06:23', '23:10', '22:51', ''],
  ['川沙', '06:15', '06:18', '23:14', '22:47', ''],
  ['凌空路', '06:19', '06:15', '23:17', '22:44', ''],
  ['远东大道', '06:24', '06:10', '23:22', '22:40', ''],
  ['海天三路', '06:31', '06:03', '23:28', '22:33', ''],
  ['浦东1号2号航站楼', '06:34', '06:00', '23:31', '22:30', ''],
];

export const FIRST_LAST: FirstLastRow[] = T.map(([station, firstE, firstW, lastE, lastW, lastG]) => ({ station, firstE, firstW, lastE, lastW, lastG }));

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

/**
 * Published headways (2号线列车运行间隔), as shown on 2026-10-22. Seconds;
 * a [min, max] pair where only a range is published. `from`/`to` are clock
 * times 'HH:MM'; null = 其他时段 (all hours outside the named periods).
 * Sections are station-to-station stretches of the line.
 */


const WHOLE = ['蟠祥路·国家会计学院', '浦东1号2号航站楼'] as const;
const OTHER = [300, 600] as const;

export const OFFICIAL_HEADWAYS: Record<'weekday' | 'weekend', OfficialHeadway[]> = {
  weekday: [
    { name: '早高峰', from: '07:30', to: '10:00', sections: [['蟠祥路·国家会计学院', '淞虹路', 225], ['淞虹路', '广兰路', 150], ['广兰路', '浦东1号2号航站楼', 225]] },
    { name: '平峰', from: '10:00', to: '17:00', sections: [[...WHOLE, 300]] },
    { name: '晚高峰', from: '17:00', to: '20:30', sections: [['蟠祥路·国家会计学院', '淞虹路', 270], ['淞虹路', '广兰路', 180], ['广兰路', '浦东1号2号航站楼', 270]] },
    { name: '其他时段', from: null, to: null, sections: [[...WHOLE, OTHER]] },
  ],
  weekend: [
    { name: '高峰时段', from: '08:30', to: '20:30', sections: [[...WHOLE, 240]] },
    { name: '其他时段', from: null, to: null, sections: [[...WHOLE, OTHER]] },
  ],
};
