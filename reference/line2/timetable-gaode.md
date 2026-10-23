# 高德到站表：来源、格式与车数口径

按D125，只参考各时段开行车数；官方首末班及间隔优先，运行时分/停站/等级以现场录音和PIS证据为主。过去用高德分钟标定区间时分的分析已退出现行依据，历史理由见D80–D81、D120–D125。

## 来源与采集

用户10/15截图为初始参考；下列正式文本来自手机高德到站时刻表UI XML采集（非OCR）。每份文件头记录抓取时刻、日型、方向、行数和完整性；数据日期不是承诺未来仍有效的运营日。

DN往东、UP往西。方向标签“开往蟠祥路/机场”不区分实际交路，不能据此认定始发、终到或车底接续。每一行是到站整分钟，用户说明约有±30秒偏差；不能由相邻分钟差恢复秒级纯运行。

|文件|头部抓取时间|记录行数|
|---|---|---:|
|[世纪公园-DN-weekday.txt](timetable-gaode/世纪公园-DN-weekday.txt)|2026-10-16 01:07:47 +08:00 星期五|293|
|[世纪公园-UP-weekday.txt](timetable-gaode/世纪公园-UP-weekday.txt)|2026-10-16 01:14:22 +08:00 星期五|287|
|[凌空路-DN-weekday.txt](timetable-gaode/凌空路-DN-weekday.txt)|2026-10-19 19:36:32 +08:00 星期一|304|
|[凌空路-UP-weekday.txt](timetable-gaode/凌空路-UP-weekday.txt)|2026-10-19 19:22:05 +08:00 星期一|277|
|[创新中路-DN-weekday.txt](timetable-gaode/创新中路-DN-weekday.txt)|2026-10-15 22:58:10 +08:00 星期四|253|
|[创新中路-UP-weekday.txt](timetable-gaode/创新中路-UP-weekday.txt)|2026-10-15 22:51:45 +08:00 星期四|241|
|[北新泾-DN-weekday.txt](timetable-gaode/北新泾-DN-weekday.txt)|2026-10-16 00:14:30 +08:00 星期五|264|
|[北新泾-UP-weekday.txt](timetable-gaode/北新泾-UP-weekday.txt)|2026-10-16 00:20:34 +08:00 星期五|298|
|[唐镇-DN-weekday.txt](timetable-gaode/唐镇-DN-weekday.txt)|2026-10-16 00:40:17 +08:00 星期五|325|
|[唐镇-UP-weekday.txt](timetable-gaode/唐镇-UP-weekday.txt)|2026-10-16 00:47:38 +08:00 星期五|344|
|[川沙-DN-weekday.txt](timetable-gaode/川沙-DN-weekday.txt)|2026-10-15 23:11:11 +08:00 星期四|304|
|[川沙-UP-weekday.txt](timetable-gaode/川沙-UP-weekday.txt)|2026-10-15 23:04:48 +08:00 星期四|241|
|[广兰路-DN-weekday.txt](timetable-gaode/广兰路-DN-weekday.txt)|2026-10-15 21:33:10 +08:00 星期四|238|
|[广兰路-UP-weekday.txt](timetable-gaode/广兰路-UP-weekday.txt)|2026-10-15 21:26:22 +08:00 星期四|262|
|[张江高科-DN-weekday.txt](timetable-gaode/张江高科-DN-weekday.txt)|2026-10-16 00:55:04 +08:00 星期五|282|
|[张江高科-UP-weekday.txt](timetable-gaode/张江高科-UP-weekday.txt)|2026-10-16 01:01:32 +08:00 星期五|277|
|[浦东1号2号航站楼-DN-weekday.txt](timetable-gaode/浦东1号2号航站楼-DN-weekday.txt)|2026-10-19 19:08:05 +08:00 星期一|304|
|[浦东1号2号航站楼-UP-weekday.txt](timetable-gaode/浦东1号2号航站楼-UP-weekday.txt)|2026-10-19 18:54:15 +08:00 星期一|277|
|[海天三路-DN-weekday.txt](timetable-gaode/海天三路-DN-weekday.txt)|2026-10-15 23:30:23 +08:00 星期四|304|
|[海天三路-UP-weekday.txt](timetable-gaode/海天三路-UP-weekday.txt)|2026-10-15 23:23:28 +08:00 星期四|265|
|[淞虹路-DN-weekday.txt](timetable-gaode/淞虹路-DN-weekday.txt)|2026-10-16 01:32:20 +08:00 星期五|251|
|[淞虹路-UP-weekday.txt](timetable-gaode/淞虹路-UP-weekday.txt)|2026-10-16 01:25:04 +08:00 星期五|267|
|[虹桥2号航站楼-DN-weekday.txt](timetable-gaode/虹桥2号航站楼-DN-weekday.txt)|2026-10-16 00:27:19 +08:00 星期五|256|
|[虹桥2号航站楼-UP-weekday.txt](timetable-gaode/虹桥2号航站楼-UP-weekday.txt)|2026-10-16 00:33:16 +08:00 星期五|302|
|[蟠祥路·国家会计学院-DN-weekday.txt](timetable-gaode/蟠祥路·国家会计学院-DN-weekday.txt)|2026-10-16 01:45:28 +08:00 星期五|247|
|[蟠祥路·国家会计学院-UP-weekday.txt](timetable-gaode/蟠祥路·国家会计学院-UP-weekday.txt)|2026-10-16 01:37:47 +08:00 星期五|268|
|[远东大道-DN-weekday.txt](timetable-gaode/远东大道-DN-weekday.txt)|2026-10-15 22:44:44 +08:00 星期四|304|
|[远东大道-UP-weekday.txt](timetable-gaode/远东大道-UP-weekday.txt)|2026-10-15 22:01:24 +08:00 星期四|279|
|[金科路-DN-weekday.txt](timetable-gaode/金科路-DN-weekday.txt)|2026-10-15 21:48:32 +08:00 星期四|278|
|[金科路-UP-weekday.txt](timetable-gaode/金科路-UP-weekday.txt)|2026-10-15 21:41:22 +08:00 星期四|271|

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
