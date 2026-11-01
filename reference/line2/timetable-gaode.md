# 高德到站表：来源、格式与车数口径

按D125，只参考各时段开行车数；官方首末班及间隔优先，运行时分/停站/等级以现场录音和PIS证据为主。过去用高德分钟标定区间时分的分析已退出现行依据，历史理由见D80–D81、D120–D125。


<!-- gaode-scrape:start -->
## 手机自动采集汇总

正式时刻以以下文本为准；本页下方原手录保留用于追溯，有覆盖的站点不再以手录缺口为准。
UP 往西、DN 往东；时刻来自 UI XML，非 OCR。方向终点标签不能用来区分交路。

| 车站 | 方向 | 日类型 | 行数 | 首班 | 末班 | 首末班校验 |
|---|---|---|---:|---|---|---|
| [北新泾](../timetable-gaode/北新泾-DN-weekday.txt) | DN | weekday | 264 | 05:42 | 22:59 | 一致 |
| [北新泾](../timetable-gaode/北新泾-DN-weekend.txt) | DN | weekend | 197 | 05:42 | 22:59 | 一致 |
| [北新泾](../timetable-gaode/北新泾-UP-weekday.txt) | UP | weekday | 298 | 05:55 | 23:49 | 一致 |
| [北新泾](../timetable-gaode/北新泾-UP-weekend.txt) | UP | weekend | 242 | 05:55 | 23:49 | 一致 |
| [虹桥2号航站楼](../timetable-gaode/虹桥2号航站楼-DN-weekday.txt) | DN | weekday | 256 | 05:33 | 22:50 | 一致 |
| [虹桥2号航站楼](../timetable-gaode/虹桥2号航站楼-UP-weekday.txt) | UP | weekday | 302 | 06:05 | 23:58 | 一致 |
| [唐镇](../timetable-gaode/唐镇-DN-weekday.txt) | DN | weekday | 325 | 06:04 | 23:04 | 一致 |
| [唐镇](../timetable-gaode/唐镇-UP-weekday.txt) | UP | weekday | 344 | 06:29 | 22:58 | 一致 |
| [张江高科](../timetable-gaode/张江高科-DN-weekday.txt) | DN | weekday | 282 | 06:22 | 23:39 | 一致 |
| [张江高科](../timetable-gaode/张江高科-DN-weekend.txt) | DN | weekend | 230 | 06:22 | 23:39 | 一致 |
| [张江高科](../timetable-gaode/张江高科-UP-weekday.txt) | UP | weekday | 277 | 05:33 | 23:07 | 一致 |
| [张江高科](../timetable-gaode/张江高科-UP-weekend.txt) | UP | weekend | 212 | 05:33 | 23:07 | 一致 |
| [世纪公园](../timetable-gaode/世纪公园-DN-weekday.txt) | DN | weekday | 293 | 06:16 | 23:33 | 一致 |
| [世纪公园](../timetable-gaode/世纪公园-DN-weekend.txt) | DN | weekend | 249 | 06:16 | 23:33 | 一致 |
| [世纪公园](../timetable-gaode/世纪公园-UP-weekday.txt) | UP | weekday | 287 | 05:21 | 23:13 | 一致 |
| [世纪公园](../timetable-gaode/世纪公园-UP-weekend.txt) | UP | weekend | 205 | 05:21 | 23:13 | 一致 |
| [海天三路](../timetable-gaode/海天三路-DN-weekday.txt) | DN | weekday | 304 | 06:31 | 23:30 | 末班 23:30 / 官方 23:28，相差 +2 min |
| [海天三路](../timetable-gaode/海天三路-UP-weekday.txt) | UP | weekday | 265 | 06:03 | 22:32 | 末班 22:32 / 官方 22:33，相差 -1 min |
| [凌空路](../timetable-gaode/凌空路-DN-weekday.txt) | DN | weekday | 304 | 06:19 | 23:17 | 一致 |
| [创新中路](../timetable-gaode/创新中路-DN-weekday.txt) | DN | weekday | 253 | 06:08 | 23:07 | 一致 |
| [川沙](../timetable-gaode/川沙-DN-weekday.txt) | DN | weekday | 304 | 06:15 | 23:14 | 一致 |
| [广兰路](../timetable-gaode/广兰路-DN-weekday.txt) | DN | weekday | 238 | 06:00 | 23:00 | 一致 |
| [浦东1号2号航站楼](../timetable-gaode/浦东1号2号航站楼-DN-weekday.txt) | DN | weekday | 304 | 06:34 | 23:32 | 末班 23:32 / 官方 23:31，相差 +1 min |
| [淞虹路](../timetable-gaode/淞虹路-DN-weekday.txt) | DN | weekday | 251 | 05:40 | 22:57 | 一致 |
| [蟠祥路·国家会计学院](../timetable-gaode/蟠祥路·国家会计学院-DN-weekday.txt) | DN | weekday | 247 | 05:25 | 22:42 | 一致 |
| [远东大道](../timetable-gaode/远东大道-DN-weekday.txt) | DN | weekday | 304 | 06:24 | 23:23 | 末班 23:23 / 官方 23:22，相差 +1 min |
| [金科路](../timetable-gaode/金科路-DN-weekday.txt) | DN | weekday | 278 | 06:25 | 23:42 | 一致 |
| [凌空路](../timetable-gaode/凌空路-UP-weekday.txt) | UP | weekday | 277 | 06:15 | 22:44 | 一致 |
| [创新中路](../timetable-gaode/创新中路-UP-weekday.txt) | UP | weekday | 241 | 06:26 | 22:54 | 一致 |
| [川沙](../timetable-gaode/川沙-UP-weekday.txt) | UP | weekday | 241 | 06:18 | 22:47 | 一致 |
| [广兰路](../timetable-gaode/广兰路-UP-weekday.txt) | UP | weekday | 262 | 05:28 | 23:02 | 一致 |
| [浦东1号2号航站楼](../timetable-gaode/浦东1号2号航站楼-UP-weekday.txt) | UP | weekday | 277 | 06:00 | 22:29 | 末班 22:29 / 官方 22:30，相差 -1 min |
| [淞虹路](../timetable-gaode/淞虹路-UP-weekday.txt) | UP | weekday | 267 | 05:58 | 23:51 | 一致 |
| [蟠祥路·国家会计学院](../timetable-gaode/蟠祥路·国家会计学院-UP-weekday.txt) | UP | weekday | 268 | 06:12 | 24:05 | 一致 |
| [远东大道](../timetable-gaode/远东大道-UP-weekday.txt) | UP | weekday | 279 | 06:10 | 22:38 | 末班 22:38 / 官方 22:40，相差 -2 min |
| [金科路](../timetable-gaode/金科路-UP-weekday.txt) | UP | weekday | 271 | 05:31 | 23:05 | 一致 |

每小时班次数及站间差异：运行 `python scripts/gaode/scrape.py validate`。
相邻采样站的小时差异可能来自跨小时行车或区间始终发，不能直接当成漏抓或补造车次。

**小时差异复查提示**（前后数字对应站名顺序，非漏行判定）：

- 蟠祥路·国家会计学院 / 虹桥2号航站楼 UP weekday: 08点 21/14, 09点 21/13, 10点 21/15, 11点 14/20, 12点 12/17, 14点 12/21, 15点 12/21, 16点 12/22, 21点 13/19
- 虹桥2号航站楼 / 淞虹路 UP weekday: 11点 20/11, 14点 21/14, 15点 21/12, 16点 22/15, 20点 19/14
- 淞虹路 / 北新泾 UP weekday: 08点 15/25, 09点 17/25, 10点 15/22, 19点 14/20, 20点 14/20
- 北新泾 / 世纪公园 UP weekday: 10点 22/16, 23点 11/3
- 世纪公园 / 张江高科 UP weekday: 06点 14/9
- 张江高科 / 金科路 UP weekday: 07点 23/17, 08点 23/10, 09点 24/16, 13点 12/19, 16点 13/20, 22点 12/17
- 金科路 / 广兰路 UP weekday: 08点 10/20
- 广兰路 / 唐镇 UP weekday: 07点 16/24, 09点 16/22, 10点 15/22, 12点 12/18, 13点 16/22, 14点 15/23, 15点 13/22, 21点 13/20, 22点 14/22
- 唐镇 / 创新中路 UP weekday: 10点 22/15, 11点 17/12, 12点 18/12, 13点 22/12, 14点 23/12, 15点 22/12, 16点 20/12, 17点 23/13, 21点 20/14, 22点 22/12
- 川沙 / 凌空路 UP weekday: 15点 12/17, 16点 13/22, 19点 13/19
- 凌空路 / 远东大道 UP weekday: 12点 16/22, 14点 14/21, 16点 22/14
- 远东大道 / 海天三路 UP weekday: 12点 22/13, 14点 21/15
- 北新泾 / 世纪公园 UP weekend: 06点 12/7, 09点 15/10, 23点 8/3
- 世纪公园 / 张江高科 UP weekend: 09点 10/15
- 蟠祥路·国家会计学院 / 虹桥2号航站楼 DN weekday: 20点 13/19
- 虹桥2号航站楼 / 淞虹路 DN weekday: 19点 18/13, 20点 19/13
- 淞虹路 / 北新泾 DN weekday: 07点 16/24, 08点 16/24
- 北新泾 / 世纪公园 DN weekday: 06点 17/12, 18点 14/20, 19点 13/20, 20点 14/20, 23点 0/8
- 世纪公园 / 张江高科 DN weekday: 22点 16/11
- 张江高科 / 金科路 DN weekday: 06点 11/6
- 金科路 / 广兰路 DN weekday: 07点 20/10, 08点 24/12, 09点 24/15, 13点 12/19, 18点 20/14, 19点 20/13, 23点 6/1
- 广兰路 / 唐镇 DN weekday: 07点 10/19, 08点 12/21, 09点 15/23, 12点 12/21, 15点 14/21, 17点 14/20, 18点 14/20, 19点 13/20
- 唐镇 / 创新中路 DN weekday: 07点 19/13, 12点 21/13, 13点 18/11, 14点 18/12, 15点 21/12, 17点 20/12
- 创新中路 / 川沙 DN weekday: 13点 11/17, 14点 12/19, 15点 12/20, 16点 13/20, 17点 12/19, 22点 13/19
- 川沙 / 凌空路 DN weekday: 06点 11/6, 18点 16/25
- 凌空路 / 远东大道 DN weekday: 18点 25/16
- 海天三路 / 浦东1号2号航站楼 DN weekday: 06点 8/3, 13点 17/12, 18点 17/25
- 北新泾 / 世纪公园 DN weekend: 07点 8/15, 08点 8/15, 09点 8/15, 12点 9/15, 20点 10/15, 21点 10/15, 23点 0/5
- 世纪公园 / 张江高科 DN weekend: 12点 15/10

**夹心检查**（同方向、同小时，本站比上下游相邻采样站各少至少 3 班；只报警，不补车次）：

- UP weekday 12点 浦东1号2号航站楼→海天三路→远东大道：16/13/22班
- UP weekday 17点 浦东1号2号航站楼→海天三路→远东大道：15/12/15班
- UP weekday 18点 浦东1号2号航站楼→海天三路→远东大道：19/15/19班
- UP weekday 16点 海天三路→远东大道→凌空路：17/14/22班
- UP weekday 19点 凌空路→川沙→创新中路：19/13/16班
- UP weekday 13点 唐镇→广兰路→金科路：22/16/19班
- UP weekday 16点 唐镇→广兰路→金科路：20/15/20班
- UP weekday 22点 唐镇→广兰路→金科路：22/14/17班
- UP weekday 08点 广兰路→金科路→张江高科：20/10/23班
- UP weekday 22点 金科路→张江高科→世纪公园：17/12/15班
- UP weekday 20点 北新泾→淞虹路→虹桥2号航站楼：20/14/19班
- UP weekday 22点 北新泾→淞虹路→虹桥2号航站楼：15/12/16班
- UP weekday 09点 淞虹路→虹桥2号航站楼→蟠祥路·国家会计学院：17/13/21班
- UP weekday 18点 淞虹路→虹桥2号航站楼→蟠祥路·国家会计学院：16/12/16班
- UP weekend 08点 张江高科→世纪公园→北新泾：15/11/15班
- UP weekend 09点 张江高科→世纪公园→北新泾：15/10/15班
- UP weekend 13点 张江高科→世纪公园→北新泾：15/12/15班
- UP weekend 17点 张江高科→世纪公园→北新泾：15/12/15班
- DN weekday 07点 虹桥2号航站楼→淞虹路→北新泾：20/16/24班
- DN weekday 07点 金科路→广兰路→唐镇：20/10/19班
- DN weekday 08点 金科路→广兰路→唐镇：24/12/21班
- DN weekday 09点 金科路→广兰路→唐镇：24/15/23班
- DN weekday 18点 金科路→广兰路→唐镇：20/14/20班
- DN weekday 19点 金科路→广兰路→唐镇：20/13/20班
- DN weekday 20点 金科路→广兰路→唐镇：19/16/21班
- DN weekday 06点 唐镇→创新中路→川沙：12/8/11班
- DN weekday 11点 唐镇→创新中路→川沙：16/12/15班
- DN weekday 13点 唐镇→创新中路→川沙：18/11/17班
- DN weekday 14点 唐镇→创新中路→川沙：18/12/19班
- DN weekday 15点 唐镇→创新中路→川沙：21/12/20班
- DN weekday 16点 唐镇→创新中路→川沙：16/13/20班
- DN weekday 17点 唐镇→创新中路→川沙：20/12/19班
- DN weekday 21点 唐镇→创新中路→川沙：20/17/20班
- DN weekday 22点 唐镇→创新中路→川沙：17/13/19班
- DN weekday 18点 创新中路→川沙→凌空路：19/16/25班
- DN weekday 06点 川沙→凌空路→远东大道：11/6/10班
- DN weekday 13点 川沙→凌空路→远东大道：17/14/18班
- DN weekday 21点 川沙→凌空路→远东大道：20/17/21班

逐车复查也由 `validate` 打印具体上游时刻、本站推定时刻和下游时刻。
运行时分取共同连续 5 分钟段时差的唯一众数，按 ±1 min 保序一对一匹配；无样本或相位不明会明确提示。
当前缺少车号，所有匹配只用于复查；小时标题未显示总班数，完整性另查行容器计数、逐屏重叠及复读一致性，具体复读方式见各文件头。
<!-- gaode-scrape:end -->

## 来源与采集

用户10/15截图为初始参考；下列正式文本来自手机高德到站时刻表UI XML采集（非OCR）。每份文件头记录抓取时刻、日型、方向、行数和完整性；数据日期不是承诺未来仍有效的运营日。

DN往东、UP往西。方向标签“开往蟠祥路/机场”不区分实际交路，不能据此认定始发、终到或车底接续。每一行是到站整分钟，用户说明约有±30秒偏差；不能由相邻分钟差恢复秒级纯运行。

|文件|头部抓取时间|记录行数|
|---|---|---:|
|[世纪公园-DN-weekday.txt](../timetable-gaode/世纪公园-DN-weekday.txt)|2026-10-16 01:07:47 +08:00 星期五|293|
|[世纪公园-UP-weekday.txt](../timetable-gaode/世纪公园-UP-weekday.txt)|2026-10-16 01:14:22 +08:00 星期五|287|
|[凌空路-DN-weekday.txt](../timetable-gaode/凌空路-DN-weekday.txt)|2026-10-19 19:36:32 +08:00 星期一|304|
|[凌空路-UP-weekday.txt](../timetable-gaode/凌空路-UP-weekday.txt)|2026-10-19 19:22:05 +08:00 星期一|277|
|[创新中路-DN-weekday.txt](../timetable-gaode/创新中路-DN-weekday.txt)|2026-10-15 22:58:10 +08:00 星期四|253|
|[创新中路-UP-weekday.txt](../timetable-gaode/创新中路-UP-weekday.txt)|2026-10-15 22:51:45 +08:00 星期四|241|
|[北新泾-DN-weekday.txt](../timetable-gaode/北新泾-DN-weekday.txt)|2026-10-16 00:14:30 +08:00 星期五|264|
|[北新泾-UP-weekday.txt](../timetable-gaode/北新泾-UP-weekday.txt)|2026-10-16 00:20:34 +08:00 星期五|298|
|[唐镇-DN-weekday.txt](../timetable-gaode/唐镇-DN-weekday.txt)|2026-10-16 00:40:17 +08:00 星期五|325|
|[唐镇-UP-weekday.txt](../timetable-gaode/唐镇-UP-weekday.txt)|2026-10-16 00:47:38 +08:00 星期五|344|
|[川沙-DN-weekday.txt](../timetable-gaode/川沙-DN-weekday.txt)|2026-10-15 23:11:11 +08:00 星期四|304|
|[川沙-UP-weekday.txt](../timetable-gaode/川沙-UP-weekday.txt)|2026-10-15 23:04:48 +08:00 星期四|241|
|[广兰路-DN-weekday.txt](../timetable-gaode/广兰路-DN-weekday.txt)|2026-10-15 21:33:10 +08:00 星期四|238|
|[广兰路-UP-weekday.txt](../timetable-gaode/广兰路-UP-weekday.txt)|2026-10-15 21:26:22 +08:00 星期四|262|
|[张江高科-DN-weekday.txt](../timetable-gaode/张江高科-DN-weekday.txt)|2026-10-16 00:55:04 +08:00 星期五|282|
|[张江高科-UP-weekday.txt](../timetable-gaode/张江高科-UP-weekday.txt)|2026-10-16 01:01:32 +08:00 星期五|277|
|[浦东1号2号航站楼-DN-weekday.txt](../timetable-gaode/浦东1号2号航站楼-DN-weekday.txt)|2026-10-19 19:08:05 +08:00 星期一|304|
|[浦东1号2号航站楼-UP-weekday.txt](../timetable-gaode/浦东1号2号航站楼-UP-weekday.txt)|2026-10-19 18:54:15 +08:00 星期一|277|
|[海天三路-DN-weekday.txt](../timetable-gaode/海天三路-DN-weekday.txt)|2026-10-15 23:30:23 +08:00 星期四|304|
|[海天三路-UP-weekday.txt](../timetable-gaode/海天三路-UP-weekday.txt)|2026-10-15 23:23:28 +08:00 星期四|265|
|[淞虹路-DN-weekday.txt](../timetable-gaode/淞虹路-DN-weekday.txt)|2026-10-16 01:32:20 +08:00 星期五|251|
|[淞虹路-UP-weekday.txt](../timetable-gaode/淞虹路-UP-weekday.txt)|2026-10-16 01:25:04 +08:00 星期五|267|
|[虹桥2号航站楼-DN-weekday.txt](../timetable-gaode/虹桥2号航站楼-DN-weekday.txt)|2026-10-16 00:27:19 +08:00 星期五|256|
|[虹桥2号航站楼-UP-weekday.txt](../timetable-gaode/虹桥2号航站楼-UP-weekday.txt)|2026-10-16 00:33:16 +08:00 星期五|302|
|[蟠祥路·国家会计学院-DN-weekday.txt](../timetable-gaode/蟠祥路·国家会计学院-DN-weekday.txt)|2026-10-16 01:45:28 +08:00 星期五|247|
|[蟠祥路·国家会计学院-UP-weekday.txt](../timetable-gaode/蟠祥路·国家会计学院-UP-weekday.txt)|2026-10-16 01:37:47 +08:00 星期五|268|
|[远东大道-DN-weekday.txt](../timetable-gaode/远东大道-DN-weekday.txt)|2026-10-15 22:44:44 +08:00 星期四|304|
|[远东大道-UP-weekday.txt](../timetable-gaode/远东大道-UP-weekday.txt)|2026-10-15 22:01:24 +08:00 星期四|279|
|[金科路-DN-weekday.txt](../timetable-gaode/金科路-DN-weekday.txt)|2026-10-15 21:48:32 +08:00 星期四|278|
|[金科路-UP-weekday.txt](../timetable-gaode/金科路-UP-weekday.txt)|2026-10-15 21:41:22 +08:00 星期四|271|

## 文件格式与维护

- UTF-8文本，`#`开头为来源/完整性说明；其余逐行 `HH:MM`。
- 00–03点归前一运营日，写成24:xx–27:xx，不重排成当天首班。
- 不用等差补行，不把相邻站小时差直接判成漏抓；跨时段传播和交路会影响局部计数。
- 数据检查工具：`python scripts/gaode/scrape.py validate`。原始文本与采集头为依据，本页不再维护另一份首末班分钟表。

## 可信列与15分钟比较

`scripts/gaode-compare.ts` 现用工作日五列：北新泾UP、世纪公园UP/DN、张江高科UP/DN。其余列不是全面校验目标；虹桥2号航站楼UP午间、北新泾DN晚段等有邻站矛盾。东段川沙、凌空路、远东大道、海天三路、浦东1号2号航站楼整体仅参考，不计不合格或验收。

时间窗06:00–11:00、16:00–23:30，每15分钟半开区间计数。计划侧取可上客、非取消、非终到的载客停站，按 `floor(arr/60)` 入格；高德侧直接数对应分钟行。CLI按 `|计划−高德|≥2` 计不合格，并输出总绝对差。D123允许北新泾UP06:30格在单测保留3列差，这个例外不从CLI总不合格格数里扣掉。

```powershell
npx tsx scripts/gaode-compare.ts
npx tsx scripts/gaode-compare.ts --table 北新泾,世纪公园,张江高科
```

`--baseline 文件.json` 可读分析副本中的 `trips`；它只是计数工具，不证明该副本满足首末班、车底接续和进路容量。时分建议与数据质量边界见[现场分析](../docs/field/bottom-up-runtime-2026-10.md)。
