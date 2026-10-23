import type { OtherLastTrain } from '../../types';
export type { OtherLastTrain } from '../../types';
/**
 * Other lines' last trains at the Line 2 interchanges (换乘末班车), D63.
 *
 * Source: the stations' published timetables of 2026-09-28 (summary
 * supplied by the user, via 地铁通 MetroMan): the last departure of each
 * service from the interchange, Monday–Thursday and Sunday, with the later
 * Friday / Saturday times (周五、周六延时) where a line runs late. A service's
 * last train is taken to arrive half a minute before it departs.
 *
 * Walking times between the platforms (min) are our own approximations:
 * cross-platform or short same-station transfers 3–4 min, long ones 5–6,
 * the maglev and the out-of-station transfers (出站换乘: 国家会展中心 17号线,
 * 浦东南路 14号线) 8–10.
 */



const T = (h: number, m: number) => (h < 4 ? h + 24 : h) * 3600 + m * 60;
const W = (min: number) => min * 60;

export const OTHER_LAST_TRAINS: OtherLastTrain[] = [
  { station: 'GJH', line: '17', toward: '西岑', dep: T(23, 3), walk: W(10) },
  { station: 'GJH', line: '17', toward: '虹桥火车站', dep: T(23, 13), walk: W(10) },
  { station: 'HQZ', line: '10', toward: '基隆路', dep: T(22, 30), friSat: T(0, 0), walk: W(4) },
  { station: 'HQZ', line: '17', toward: '西岑', dep: T(23, 0), walk: W(4) },
  { station: 'HQ2', line: '10', toward: '虹桥火车站', dep: T(23, 41), friSat: T(0, 56), walk: W(4) },
  { station: 'HQ2', line: '10', toward: '基隆路', dep: T(22, 31), friSat: T(0, 1), walk: W(4) },
  { station: 'HQ2', line: '机场联络线', toward: '浦东机场', dep: T(22, 0), walk: W(6) },
  { station: 'LSG', line: '15', toward: '紫竹高新区', dep: T(22, 56), walk: W(3) },
  { station: 'LSG', line: '15', toward: '顾村公园', dep: T(23, 10), walk: W(3) },
  { station: 'ZSG', line: '3', toward: '江杨北路', dep: T(22, 52), walk: W(4) },
  { station: 'ZSG', line: '3', toward: '上海南站', dep: T(23, 35), walk: W(4) },
  { station: 'ZSG', line: '4', toward: '外圈', dep: T(23, 31), walk: W(4) },
  { station: 'ZSG', line: '4', toward: '内圈', dep: T(22, 42), walk: W(4) },
  { station: 'JSL', line: '11', toward: '嘉定北', dep: T(23, 16), walk: W(3) },
  { station: 'JSL', line: '11', toward: '花桥', dep: T(23, 11), walk: W(3) },
  { station: 'JSL', line: '11', toward: '迪士尼', dep: T(22, 57), walk: W(3) },
  { station: 'JAS', line: '7', toward: '美兰湖', dep: T(23, 3), friSat: T(0, 33), walk: W(6) },
  { station: 'JAS', line: '7', toward: '花木路', dep: T(23, 0), friSat: T(0, 29), walk: W(6) },
  { station: 'JAS', line: '14', toward: '桂桥路', dep: T(22, 58), walk: W(6) },
  { station: 'JAS', line: '14', toward: '封浜', dep: T(23, 8), walk: W(6) },
  { station: 'NJX', line: '12', toward: '金海路', dep: T(23, 4), walk: W(6) },
  { station: 'NJX', line: '12', toward: '七莘路', dep: T(23, 13), walk: W(6) },
  { station: 'NJX', line: '13', toward: '张江路', dep: T(23, 4), friSat: T(0, 34), walk: W(6) },
  { station: 'NJX', line: '13', toward: '金运路', dep: T(23, 12), friSat: T(0, 22), walk: W(6) },
  { station: 'RMG', line: '1', toward: '富锦路', dep: T(23, 1), friSat: T(0, 29), walk: W(5) },
  { station: 'RMG', line: '1', toward: '莘庄', dep: T(23, 5), friSat: T(0, 35), walk: W(5) },
  { station: 'RMG', line: '8', toward: '市光路', dep: T(23, 6), friSat: T(0, 36), walk: W(5) },
  { station: 'RMG', line: '8', toward: '沈杜公路', dep: T(23, 0), friSat: T(0, 30), walk: W(5) },
  { station: 'NJD', line: '10', toward: '航中路', dep: T(23, 4), walk: W(3) },
  { station: 'NJD', line: '10', toward: '新江湾城', dep: T(22, 57), walk: W(3) },
  { station: 'NJD', line: '10', toward: '虹桥火车站', dep: T(23, 9), friSat: T(0, 24), walk: W(3) },
  { station: 'NJD', line: '10', toward: '基隆路', dep: T(23, 4), friSat: T(0, 34), walk: W(3) },
  { station: 'LJZ', line: '14', toward: '桂桥路', dep: T(23, 9), walk: W(5) },
  { station: 'LJZ', line: '14', toward: '封浜', dep: T(22, 58), walk: W(5) },
  { station: 'PDN', line: '14', toward: '桂桥路', dep: T(23, 11), walk: W(8) },
  { station: 'PDN', line: '14', toward: '封浜', dep: T(22, 56), walk: W(8) },
  { station: 'SJD', line: '4', toward: '外圈', dep: T(23, 0), walk: W(4) },
  { station: 'SJD', line: '4', toward: '内圈', dep: T(23, 13), walk: W(4) },
  { station: 'SJD', line: '6', toward: '东方体育中心', dep: T(23, 8), walk: W(4) },
  { station: 'SJD', line: '6', toward: '港城路', dep: T(22, 57), walk: W(4) },
  { station: 'SJD', line: '9', toward: '上海松江站', dep: T(22, 59), friSat: T(0, 4), walk: W(4) },
  { station: 'SJD', line: '9', toward: '曹路', dep: T(23, 47), friSat: T(0, 57), walk: W(4) },
  { station: 'LYL', line: '7', toward: '美兰湖', dep: T(22, 33), friSat: T(0, 3), walk: W(6) },
  { station: 'LYL', line: '7', toward: '花木路', dep: T(23, 32), friSat: T(1, 1), walk: W(6) },
  { station: 'LYL', line: '16', toward: '滴水湖', dep: T(22, 30), walk: W(6) },
  { station: 'LYL', line: '18', toward: '航头', dep: T(23, 0), walk: W(6) },
  { station: 'LYL', line: '18', toward: '康文路', dep: T(22, 57), walk: W(6) },
  { station: 'LYL', line: '磁浮', toward: '浦东机场', dep: T(21, 40), walk: W(8) },
  { station: 'PDA', line: '机场联络线', toward: '虹桥2号航站楼', dep: T(22, 15), walk: W(6) },
  { station: 'PDA', line: '磁浮', toward: '龙阳路', dep: T(21, 42), walk: W(8) },
];
