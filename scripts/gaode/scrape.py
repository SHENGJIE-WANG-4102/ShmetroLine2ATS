#!/usr/bin/env python3
"""高德到站表。依赖 Python >=3.10 标准库、Android SDK adb。

只在高德内操作；原始 XML 放 work/，不保存截图。先在手机打开所选线路页面。
用法见同目录 README.md。UP=往西，DN=往东，与 src/data/current.ts 一致。
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "work" / "gaode-scrape"
OUT = None
PACKAGE = "com.autonavi.minimap"
HOUR = re.compile(r"^(\d{2}):00[-–](\d{2}):00$")
ARRIVAL = re.compile(r"^(\d{2}:\d{2})\s*到站$")
ENDS = {}
DEFAULT_PRIORITY = ["北新泾", "虹桥2号航站楼", "唐镇", "张江高科", "世纪公园", "世纪大道", "海天三路"]
PRIORITY = DEFAULT_PRIORITY.copy()
LINE_ID = "2"
LINE_TITLE = ""
LINE_ROWS = None


def configure_line(line):
    """Read the selected line's canonical TypeScript data once per process."""
    global LINE_ID, LINE_TITLE, LINE_ROWS, ENDS, OUT, PRIORITY
    if not re.fullmatch(r"[A-Za-z0-9_-]+", line):
        raise ValueError("非法线路标识")
    npx = shutil.which("npx")
    if not npx:
        raise RuntimeError("找不到 npx，无法读取线路数据")
    env = dict(os.environ, ATS_LINE=line)
    result = subprocess.run([npx, "tsx", "scripts/gaode/line-data.ts"], cwd=ROOT,
                            env=env, capture_output=True, text=True, encoding="utf-8", check=True)
    data = json.loads(result.stdout)
    rows = data["firstLast"]
    if len(rows) < 2:
        raise ValueError("首末班表不足以确定线路端点")
    LINE_ID = line
    LINE_TITLE = "地铁" + data["name"]
    LINE_ROWS = {r["station"]: tuple(r[k] for k in ("firstE", "firstW", "lastE", "lastW", "lastG")) for r in rows}
    ENDS = {"UP": rows[0]["station"], "DN": rows[-1]["station"]}
    OUT = ROOT / (data.get("directory") or f"reference/line{line}/timetable-gaode")
    PRIORITY = DEFAULT_PRIORITY.copy() if line == "2" else []  # Other lines select evidence stations explicitly.


configure_line(os.environ.get("ATS_LINE", "2"))


def local_now():
    # Windows 未安装 tzdata 时仍按上海的固定 UTC+8 记录，不依赖主机时区。
    from datetime import timedelta, timezone
    return datetime.now(timezone(timedelta(hours=8)))


def bounds(node):
    values = list(map(int, re.findall(r"\d+", node.get("bounds", ""))))
    if len(values) != 4:
        raise ValueError("界面节点缺少 bounds")
    return values


def texts(root):
    return [n.get("text", "") for n in root.iter("node") if n.get("text")]


def minutes(value):
    h, m = map(int, value.split(":"))
    if not 0 <= h <= 29 or not 0 <= m < 60:
        raise ValueError(f"非法时刻：{value}")
    return h * 60 + m


def service_time(value):
    # 【假设】凌晨 00–03 点属于前一运营日，按官方表的 24:xx 表示。
    h, m = map(int, value.split(":"))
    minutes(value)
    return f"{h + 24 if h < 4 else h:02}:{m:02}"


def arrivals(root):
    return {service_time(m[1]) for s in texts(root) if (m := ARRIVAL.fullmatch(s))}


def official_rows():
    if LINE_ROWS is None:
        configure_line(os.environ.get("ATS_LINE", "2"))
    return LINE_ROWS


def validate(station, direction, values):
    errors, warnings = [], []
    if not values:
        return ["没有到站记录"], warnings
    nums = [minutes(v) for v in values]
    if any(b <= a for a, b in zip(nums, nums[1:])):
        errors.append("时刻没有严格递增或有重复")
    row = official_rows()[station]
    first = row[1] if direction == "UP" else row[0]
    # 广兰路以西东行须包括晚间小交路；广兰路本身的 lastG 是终到到达，
    # 不能继续往东上车，不属于该站东行上车表。其东行末班按机场方向 lastE。
    last = row[3] if direction == "UP" else (row[2] if station == "广兰路" else
           max((v for v in (row[2], row[4]) if v), key=minutes))
    for name, actual, expected in (("首班", values[0], first), ("末班", values[-1], last)):
        delta = minutes(actual) - minutes(expected)
        if delta:
            message = f"{name} {actual} / 官方 {expected}，相差 {delta:+} min"
            (warnings if abs(delta) == 1 else errors).append(message)
    return errors, warnings


def read_table(path):
    values = [s.strip() for s in path.read_text(encoding="utf-8").splitlines() if s.strip() and not s.startswith("#")]
    station, direction, day = path.stem.rsplit("-", 2)
    return station, direction, day, values


def manual_difference(station, direction, values):
    if LINE_ID != "2" or direction != "UP" or station not in ("虹桥2号航站楼", "张江高科"):
        return []
    source = (ROOT / "reference/line2/timetable-gaode.md").read_text(encoding="utf-8")
    section = re.search(r"^## " + re.escape(station) + r" 往西[^\n]*\n(.*?)(?=^## |\Z)", source, re.M | re.S)
    if not section:
        return []
    manual = set()
    for line in section[1].splitlines():
        cells = line.split("|")
        if line.startswith("|") and len(cells) > 3:
            manual |= set(re.findall(r"\b\d{2}:\d{2}\b", cells[2]))
    if not manual:
        return []
    actual = set(values)
    if station == "张江高科":
        # 原手录只覆盖这两个时间窗；其余时刻是补缺，不是手录出错。
        actual = {v for v in actual if minutes(v) <= minutes("08:21") or minutes(v) >= minutes("22:00")}
    missing, added = sorted(manual-actual, key=minutes), sorted(actual-manual, key=minutes)
    result = []
    if missing:
        result.append("原手录有、自动表无：" + " ".join(missing))
    if added:
        result.append("原手录覆盖窗内新增：" + " ".join(added))
    return result or ["与原手录覆盖窗一致"]


def hourly_differences(tables):
    result = []
    order = list(official_rows())
    for direction in ENDS:
        for day in ("weekday", "weekend"):
            group = sorted((t for t in tables if t[1:3] == (direction, day)), key=lambda t: order.index(t[0]))
            for a, b in zip(group, group[1:]):
                # 【假设】同小时相差 >=5 且超过较大值的 25% 提示复查。
                # 跨小时运行、区间始终发本就会造成差异，此提示不是漏行判定。
                differences = [f"{h}点 {a[3][h]}/{b[3][h]}" for h in sorted(a[3].keys() | b[3].keys())
                               if abs(a[3][h] - b[3][h]) >= 5 and
                               abs(a[3][h] - b[3][h]) > max(a[3][h], b[3][h]) * .25]
                if differences:
                    result.append(f"{a[0]} / {b[0]} {direction} {day}: " + ", ".join(differences))
    return result


def sampled_groups(tables):
    order = list(official_rows())
    for direction in ENDS:
        for day in ("weekday", "weekend"):
            group = sorted((t for t in tables if t[1:3] == (direction, day)),
                           key=lambda t: order.index(t[0]), reverse=direction == "UP")
            if group:
                yield direction, day, group


def sandwich_differences(tables):
    """同方向、同小时，比上下游相邻采样站各少至少3班即报警。"""
    result = []
    for direction, day, group in sampled_groups(tables):
        for a, b, c in zip(group, group[1:], group[2:]):
            hours = sorted(a[3].keys() | b[3].keys() | c[3].keys())
            for hour in hours:
                if min(a[3][hour], c[3][hour]) - b[3][hour] >= 3:
                    result.append(f"{direction} {day} {hour}点 {a[0]}→{b[0]}→{c[0]}："
                                  f"{a[3][hour]}/{b[3][hour]}/{c[3][hour]}班")
    return result


def sandwich_trains(tables):
    """复用保序一对一配对；列出两端可配、本站在所有最优解均不可配的时刻。

    【假设】日内运行时分用共同连续5分钟段的时差众数代表，±1分钟。
    官方共同终点末班差只限制±2分钟相位窗口；无唯一样本明确跳过，
    不把其他班次错配成同一列车。没有车号，结果始终是复查候选。
    """
    from match_trains import estimate_lag, match_trains, clock
    result, diagnostics = [], []
    rows = official_rows()
    for direction, day, group in sampled_groups(tables):
        estimates = {}
        for a, b in zip(group, group[1:]):
            column = 3 if direction == "UP" else 2
            anchor = minutes(rows[b[0]][column]) - minutes(rows[a[0]][column])
            try:
                estimate = estimate_lag(list(map(minutes, a[3])), list(map(minutes, b[3])), anchor)
            except ValueError as exc:
                diagnostics.append(f"{a[0]}→{b[0]} {direction} {day}：无法估计，{exc}")
                continue
            estimates[a[0], b[0]] = estimate["minutes"]
            diagnostics.append(f"{a[0]}→{b[0]} {direction} {day}：时差众数 {estimate['minutes']} min，"
                               f"样本分布 {estimate['histogram']}；配对 ±1 min")
        for a, b, c in zip(group, group[1:], group[2:]):
            if (a[0], b[0]) not in estimates or (b[0], c[0]) not in estimates:
                continue
            ab, bc = estimates[a[0], b[0]], estimates[b[0], c[0]]
            up, middle, down = [list(map(minutes, t[3])) for t in (a, b, c)]
            # 两段各±1分钟，跨本站的总误差可达±2分钟。
            ac = match_trains(up, down, ab + bc, tolerance=2)
            am = match_trains(up, middle, ab)
            alternative_up = {t for candidates in am.alternatives.values() for t in candidates}
            endpoint_options = {}
            for endpoint, upstreams in ac.alternatives.items():
                for upstream in upstreams:
                    endpoint_options.setdefault(upstream, []).append(endpoint)
            for t in am.only_upstream:
                u = ac.upstream_to_downstream.get(t)
                if u is None or t in alternative_up:
                    continue
                # 密集时段不把择一最优配对当成唯一同车证据。
                alternatives = ac.alternatives[u]
                result.append({"direction": direction, "day": day,
                               "upstream": a[0], "station": b[0], "downstream": c[0],
                               "upstream_time": clock(t), "expected_time": clock(t + ab),
                               "reverse_expected_time": clock(u - bc), "downstream_time": clock(u),
                               "upstream_lag": ab, "downstream_lag": bc,
                               "ambiguous_endpoints": (len(alternatives) != 1 or
                                                       len(endpoint_options.get(t, [])) != 1),
                               "nearby_middle": [clock(v) for v in middle if abs(v-t-ab) <= 1]})
    return result, diagnostics


def report(paths):
    if not paths:
        print("没有正式时刻文本可校验", flush=True)
        return True
    tables, value_tables = [], []
    failed = False
    for path in paths:
        station, direction, day, values = read_table(path)
        errors, warnings = validate(station, direction, values)
        counts = Counter(v[:2] for v in values)
        print(f"{path.name}: {len(values)} 行 {values[0] if values else '-'}–{values[-1] if values else '-'} "
              f"{'FAIL' if errors else 'PASS'}", flush=True)
        print("  小时班次数 " + " ".join(f"{h}:{counts[h]}" for h in sorted(counts)), flush=True)
        for item in errors + warnings:
            print("  " + item, flush=True)
        for item in manual_difference(station, direction, values):
            print("  " + item, flush=True)
        failed |= bool(errors)
        tables.append((station, direction, day, counts))
        value_tables.append((station, direction, day, values))
    for item in hourly_differences(tables):
        print("  复查提示 " + item, flush=True)
    for item in sandwich_differences(tables):
        print("  夹心报警 " + item, flush=True)
    candidates, diagnostics = sandwich_trains(value_tables)
    for item in diagnostics:
        print("  逐车时分 " + item, flush=True)
    for r in candidates:
        status = "两端配对有歧义" if r["ambiguous_endpoints"] else "两端配对唯一"
        if r["nearby_middle"]:
            status += "；本站附近有行但一对一容量不足，并非明确空窗"
        print(f"  逐车复查 {r['direction']} {r['day']} {r['upstream']} {r['upstream_time']} → "
              f"{r['station']} 推定{r['expected_time']}±1 / 下游反推{r['reverse_expected_time']}±1 → "
              f"{r['downstream']} {r['downstream_time']}（{status}）", flush=True)
    return failed


def update_summary():
    """只替换带标记的自动汇总区，原手录内容保留供差异复核。"""
    target = ROOT / f"reference/line{LINE_ID}/timetable-gaode.md"
    source = target.read_text(encoding="utf-8") if target.exists() else f"# {LINE_TITLE}高德到站时刻表\n"
    if not list(OUT.glob("*.txt")):
        raise RuntimeError("没有正式采集文本，保留现有汇总")
    begin, end = "<!-- gaode-scrape:start -->", "<!-- gaode-scrape:end -->"
    rows = [begin, "## 手机自动采集汇总", "",
            ("正式时刻以以下文本为准；本页下方原手录保留用于追溯，有覆盖的站点不再以手录缺口为准。"
             if LINE_ID == "2" else "正式时刻以以下文本为准。"),
            "UP 往西、DN 往东；时刻来自 UI XML，非 OCR。方向终点标签不能用来区分交路。", "",
            "| 车站 | 方向 | 日类型 | 行数 | 首班 | 末班 | 首末班校验 |", "|---|---|---|---:|---|---|---|"]
    tables, differences = [], []
    for path in sorted(OUT.glob("*.txt"), key=lambda p: (PRIORITY.index(read_table(p)[0]) if read_table(p)[0] in PRIORITY else 99, read_table(p)[1:3])):
        station, direction, day, values = read_table(path)
        errors, warnings = validate(station, direction, values)
        status = "；".join(errors + warnings) or "一致"
        rows.append(f"| [{station}](timetable-gaode/{path.name}) | {direction} | {day} | {len(values)} | {values[0]} | {values[-1]} | {status} |")
        tables.append((station, direction, day, Counter(v[:2] for v in values)))
        differences += [f"{station} {direction} {day}：{s}" for s in manual_difference(station, direction, values)]
    rows += ["", "每小时班次数及站间差异：运行 `python scripts/gaode/scrape.py validate`。",
             "相邻采样站的小时差异可能来自跨小时行车或区间始终发，不能直接当成漏抓或补造车次。", "",
             "**小时差异复查提示**（前后数字对应站名顺序，非漏行判定）：", ""]
    rows += ["- " + s for s in hourly_differences(tables)] or ["- 当前没有达到提示阈值的差异。"]
    rows += ["", "**夹心检查**（同方向、同小时，本站比上下游相邻采样站各少至少 3 班；只报警，不补车次）：", ""]
    rows += ["- " + s for s in sandwich_differences(tables)] or ["- 当前没有达到提示阈值的差异。"]
    rows += ["", "逐车复查也由 `validate` 打印具体上游时刻、本站推定时刻和下游时刻。",
             "运行时分取共同连续 5 分钟段时差的唯一众数，按 ±1 min 保序一对一匹配；无样本或相位不明会明确提示。",
             "当前缺少车号，所有匹配只用于复查；小时标题未显示总班数，完整性另查行容器计数、逐屏重叠及复读一致性，具体复读方式见各文件头。"]
    if differences:
        rows += ["", "**与原手录覆盖窗对比**：", ""] + ["- " + s for s in differences]
    rows += [end]
    block = "\n".join(rows)
    if begin in source and end in source:
        source = source[:source.index(begin)] + block + source[source.index(end)+len(end):]
    else:
        pos = source.find("\n## ")
        source = source[:pos] + "\n\n" + block + "\n" + source[pos:] if pos >= 0 else source + "\n\n" + block + "\n"
    target.write_text(source, encoding="utf-8")


class Device:
    def __init__(self, adb=None, serial=None):
        fallback = ROOT / "work/gaode-tools/platform-tools/adb.exe"
        self.adb = adb or shutil.which("adb") or (str(fallback) if fallback.exists() else "adb")
        self.base = [self.adb] + (["-s", serial] if serial else [])
        WORK.mkdir(parents=True, exist_ok=True)

    def run(self, *args, timeout=30):
        p = subprocess.run(self.base + list(args), capture_output=True, timeout=timeout)
        if p.returncode:
            raise RuntimeError(p.stderr.decode("utf-8", errors="replace"))
        return p.stdout.decode("utf-8", errors="replace")

    def connected(self):
        # 一个 adb server 可以同时接受多个客户端；必须另外锁住整次采集，
        # 不能只锁 dump，否则另一个进程会在滑动与读取之间切站。
        if not getattr(self, "session_lock", None):
            lock = (WORK / "device-session.lock").open("a+b")
            try:
                if os.fstat(lock.fileno()).st_size == 0:
                    lock.write(b"0")
                    lock.flush()
                lock.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                lock.close()
                raise RuntimeError("另一采集进程占用手机，未执行导航或 dump") from None
            self.session_lock = lock  # 进程退出时由操作系统释放；不删除他人文件。
        result = self.run("get-state").strip()
        if result != "device":
            raise RuntimeError(f"USB 调试尚未就绪：{result}")

    def dump(self):
        for attempt in range(4):
            try:
                result = self.run("shell", "uiautomator", "dump", "/sdcard/window-gaode.xml", timeout=20)
                if "dumped to:" not in result:
                    raise RuntimeError("界面未静止或 dump 失败，重试，不能读取旧 XML")
                content = self.run("shell", "cat", "/sdcard/window-gaode.xml")
                root = ET.fromstring(content)
                packages = {n.get("package") for n in root.iter("node") if n.get("package")}
                if PACKAGE not in packages:
                    raise RuntimeError("当前不是高德，停止操作")
                apps = [n.get("package") for n in root.iter("node") if n.get("package") and
                        n.get("package") not in ("com.android.systemui", "com.miui.home")]
                if apps and apps[-1] != PACKAGE:
                    raise RuntimeError("高德被其他应用遮住，停止操作")
                # 不把位置、账号信息输出到终端；只在 ignore 的目录保留最近一屏。
                (WORK / "ui.xml").write_text(content, encoding="utf-8")
                if getattr(self, "audit_dir", None):
                    self.audit_page += 1
                    (self.audit_dir / f"{self.audit_page:04}.xml").write_text(content, encoding="utf-8")
                self.last_root = root
                return root
            except (ET.ParseError, subprocess.TimeoutExpired, RuntimeError):
                if attempt == 3:
                    raise
                time.sleep(1)

    def tap(self, node):
        x1, y1, x2, y2 = bounds(node)
        self.run("shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2))
        time.sleep(.25)

    def back(self):
        self.run("shell", "input", "keyevent", "4")
        time.sleep(.3)

    def expand_panel(self, root):
        titles = [n for n in root.iter("node") if n.get("text") == LINE_TITLE]
        if titles:
            x1, y1, x2, y2 = bounds(titles[0])
            if y1 > 700:
                self.run("shell", "input", "swipe", str((x1+x2)//2), str((y1+y2)//2),
                         str((x1+x2)//2), str(y1//4), "600")
                time.sleep(.4)
                return self.dump()
        return root

    def swipe(self, node, horizontal=False, reverse=False, fraction=.33):
        x1, y1, x2, y2 = bounds(node)
        if horizontal:
            # 线路列表可能随方向反排；以当前站名的实际左右次序决定手势。
            root = getattr(self, "last_root", None)
            if root is not None:
                carousels = [n for n in root.iter("node") if "Horizontal" in n.get("class", "")]
                order = list(official_rows())
                visible = sorted((bounds(n)[0], order.index(n.get("text")))
                                 for n in carousels[-1].iter("node") if n.get("text") in order) if carousels else []
                if len(visible) > 1 and visible[0][1] > visible[-1][1]:
                    reverse = not reverse
            a, b = (int(x1 + (x2-x1)*.85), (y1+y2)//2), (int(x1 + (x2-x1)*.2), (y1+y2)//2)
        else:
            a, b = ((x1+x2)//2, int(y1+(y2-y1)*.88)), ((x1+x2)//2, int(y1+(y2-y1)*(.88-fraction)))
        if reverse:
            a, b = b, a
        # 慢滑降低松手后的惯性，保留相邻屏的重叠行。
        self.run("shell", "input", "swipe", *map(str, (*a, *b)), "1000")
        time.sleep(.25)


def table_scroll(root):
    candidates = [n for n in root.iter("node") if n.get("scrollable") == "true" and
                  any(HOUR.fullmatch(s) or ARRIVAL.fullmatch(s) for s in texts(n))]
    if not candidates:
        raise RuntimeError("没有找到时刻表滚动区域")
    return candidates[-1]


def rewind(device):
    previous = None
    for _ in range(100):
        root = device.dump()
        scroll = table_scroll(root)
        signature = [(n.get("text"), n.get("bounds")) for n in scroll.iter("node") if n.get("text")]
        if signature == previous:
            return root
        previous = signature
        device.swipe(scroll, reverse=True)
    raise RuntimeError("回到表头超过滚动上限")


def check_identity(root, station, direction):
    lines = texts(root)
    stations = {s for s in lines if s.startswith("上车站：")}
    if stations and stations != {f"上车站：{station}"}:
        raise RuntimeError(f"采集时上车站被切换：预期 {station}")
    labels = {s for s in texts(table_scroll(root)) if s.startswith("开往")}
    if labels and labels != {"开往" + ENDS[direction]}:
        raise RuntimeError(f"方向不符或混入其他方向：{sorted(labels)}")
    return labels


def row_layout_audit(scroll):
    """按布局中的行容器计数，再独立核对到站文字；边缘截断行只参与重叠。"""
    parents = {child: node for node in scroll.iter("node") for child in node}
    bodies = set()
    for node in scroll.iter("node"):
        if ARRIVAL.fullmatch(node.get("text", "")):
            row = parents.get(node)
            if row is None or row.get("clickable") != "true":
                raise RuntimeError("到站行容器结构不明，不能完成布局行数与 XML 计数复核")
            bodies.add(parents[row])
    top, bottom = bounds(scroll)[1::2]
    counts = Counter()
    checked = 0
    for body in bodies:
        for row in body:
            if row.get("class") != "android.view.ViewGroup" or row.get("clickable") != "true":
                continue
            _, y1, _, y2 = bounds(row)
            lines = texts(row)
            # 小时标题、分隔线不是列车行。
            if any(HOUR.fullmatch(s) for s in lines) or y2-y1 < 35:
                continue
            if y1 <= top or y2 >= bottom:
                continue
            entries = [service_time(m[1]) for s in lines if (m := ARRIVAL.fullmatch(s))]
            destinations = [s for s in lines if s.startswith("开往")]
            if len(entries) != 1 or len(destinations) != 1:
                raise RuntimeError("标题下的完整行容器与 dump 到站行数不一致，未覆盖正式文本")
            checked += 1
            counts[entries[0][:2]] += 1
    return {"complete_row_containers": checked, "parsed_arrival_rows": sum(counts.values()),
            "hour_counts": dict(counts)}


def ui_times_increasing(values):
    """允许UI按自然日把00点组放表头；运营日转写后仍保留原始顺序证据。"""
    nums = [minutes(v) for v in values]
    civil = [v % (24 * 60) for v in nums]
    return (all(b > a for a, b in zip(nums, nums[1:])) or
            all(b > a for a, b in zip(civil, civil[1:])))


def read_expanded(device, station, direction, max_pages, *, reverse=False, rewind_first=True):
    """布局稳定后独立完整读取；默认回表头，也可从表底反向读取，不混入展开遍。"""
    root = rewind(device) if rewind_first else device.dump()
    values, groups, labels = set(), set(), set()
    previous, stationary, previous_values = None, 0, set()
    pages = []
    for page in range(max_pages):
        if page:
            root = device.dump()
        scroll = table_scroll(root)
        labels |= check_identity(root, station, direction)
        lines = texts(scroll)
        row_values = [service_time(m[1]) for s in lines if (m := ARRIVAL.fullmatch(s))]
        page_values = set(row_values)
        if len(row_values) != len(page_values):
            raise RuntimeError("同一屏有重复到站节点，不能以去重掩盖行数差异")
        if not ui_times_increasing(row_values):
            raise RuntimeError("屏内到站行不是严格递增，不能排序掩盖错误")
        if previous_values and page_values and not previous_values & page_values:
            raise RuntimeError("翻页缺少重叠行，本遍作废，未覆盖正式文本")
        if page_values:
            previous_values = page_values
        values |= page_values
        headers = [s for s in lines if HOUR.fullmatch(s)]
        groups.update(headers)
        if any("展开更多" in s or "查看更多" in s for s in lines):
            raise RuntimeError("稳定读取时仍有展开更多，必须先展开，未覆盖正式文本")
        # 双重计数：逐个到站节点数，与本屏按小时解析出的记录数一致；
        # 当前 UI 小时标题不显示总班数，不能把此计数冒充页面给出的总数。
        counts = Counter(v[:2] for v in row_values)
        layout = row_layout_audit(scroll)
        pages.append({"page": page, "headers": headers, "rows": row_values,
                      "row_nodes": len(row_values), "hour_counts": dict(counts), "layout_audit": layout})
        signature = [(n.get("text"), n.get("bounds")) for n in scroll.iter("node") if n.get("text")]
        stationary = stationary + 1 if signature == previous else 0
        if stationary >= 2:
            break
        previous = signature
        if page % 10 == 0:
            print(f"{station} {direction}: 独立读取{page}屏，{len(values)}行", flush=True)
        if reverse:
            device.swipe(scroll, reverse=True)
        else:
            device.swipe(scroll)
    else:
        raise RuntimeError("独立读取超过翻页上限，未覆盖正式文本")
    ordered = sorted(values, key=minutes)
    counts = Counter(v[:2] for v in ordered)
    expected_hours = set(range(minutes(ordered[0])//60, minutes(ordered[-1])//60+1)) if ordered else set()
    normalized = {minutes(service_time(s[:5]))//60 for s in groups}
    if expected_hours != normalized:
        raise RuntimeError(f"小时标题不完整：缺{sorted(expected_hours-normalized)}；多{sorted(normalized-expected_hours)}")
    for group in groups:
        h = service_time(group[:5])[:2]
        if not counts[h]:
            raise RuntimeError(f"小时分组 {group} 没有到站行，不能视为已展开")
        print(f"{station} {direction}: 分组 {group} / 独立 XML {counts[h]}行", flush=True)
    return ordered, groups, labels, pages


def publish_capture(data):
    station, direction, day = (data[k] for k in ("station", "direction", "day"))
    ordered, labels, warnings = (data[k] for k in ("values", "labels", "warnings"))
    now = datetime.fromisoformat(data["captured_at"])
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{station}-{direction}-{day}.txt"
    header = [f"# 抓取日期：{now:%Y-%m-%d %H:%M:%S} +08:00 星期{'一二三四五六日'[now.weekday()]}",
              f"# 上车站：{station}；方向：{direction}；方向标签原文：{next(iter(labels))}",
              f"# 日类型：{day}；行数：{len(ordered)}；来源：高德到站时刻表 UI XML（非 OCR）",
              "# 运营日：凌晨 00–03 点记为 24:xx–27:xx；只含到站记录，不推断交路。"]
    if data.get("independent_runs") == 2:
        header.append("# 完整性：两次从线路页重新进入；全部小时展开后独立读取；1/3屏滑动逐屏重叠；两遍逐分钟一致。")
    elif data.get("independent_runs") == 1 and "expansion_audits" in data:
        header.append("# 完整性：全部小时展开后单次独立完整读取；1/3屏滑动逐屏重叠；布局行数与到站节点核对通过。")
    if warnings:
        header.append("# 校验提示：" + "; ".join(warnings))
    path.write_text("\n".join(header + ordered) + "\n", encoding="utf-8")
    print(f"已保存 {path.name}: {len(ordered)}行 {ordered[0]}–{ordered[-1]}", flush=True)
    return path


def expand_groups(device, station, direction, max_pages):
    """只做展开和布局核对；到表底后再独立读取，不将本阶段的时刻带出。"""
    groups, audits, seen_hours = set(), [], set()
    previous, stationary = None, 0
    for page in range(max_pages):
        root = device.dump()
        scroll = table_scroll(root)
        check_identity(root, station, direction)
        lines = texts(scroll)
        seen_hours.update(v[:2] for v in arrivals(scroll))
        headers = [n for n in scroll.iter("node") if HOUR.fullmatch(n.get("text", ""))]
        groups.update(n.get("text") for n in headers)
        audits.append({"page": page, "headers": [n.get("text") for n in headers],
                       "layout_audit": row_layout_audit(scroll)})
        more = [n for n in scroll.iter("node") if any(
            s in n.get("text", "") for s in ("展开更多", "查看更多"))]
        if more:
            device.tap(more[-1])
            previous, stationary = None, 0
            continue
        pending = []
        for node in headers:
            title = node.get("text")
            index = lines.index(title)
            # 底边的单个标题不能证明折叠；相邻小时标题之间无行才可确定。
            if (index+1 < len(lines) and HOUR.fullmatch(lines[index+1]) and
                    bounds(node)[3]-bounds(node)[1] >= 35):
                pending.append(node)
        if pending:
            # 从下往上展开，同屏上方的标题坐标不会被下方展开移走。
            for node in reversed(pending):
                device.tap(node)
            time.sleep(.5)
            previous, stationary = None, 0
            continue
        # 已有该小时的行，顶部截断标题无须再往回找；否则会与底部末小时来回弹动。
        partial = [n for n in headers if bounds(n)[3]-bounds(n)[1] < 35 and
                   service_time(n.get("text")[:5])[:2] not in seen_hours]
        if partial:
            # A clipped final header can have zero text bounds while its own
            # clickable row is visible at the bottom. Open that row, then
            # scroll to its contents instead of endlessly trying to scroll past
            # the collapsed end of the list.
            node = partial[0]
            if bounds(node) == [0, 0, 0, 0] and lines[-1] == node.get("text"):
                parents = {child: parent for parent in scroll.iter() for child in parent}
                target = node
                while target in parents and target is not scroll:
                    target = parents[target]
                    x1, y1, x2, y2 = bounds(target)
                    if (target.get("clickable") == "true" and texts(target) == [node.get("text")]
                            and x2 > x1 and y2-y1 >= 20 and y2 == bounds(scroll)[3]):
                        device.tap(target)
                        time.sleep(.5)
                        device.swipe(scroll)
                        previous, stationary = None, 0
                        break
                else:
                    target = None
                if target is not None and target is not scroll:
                    continue
            # Some Android UI trees retain offscreen titles with zero bounds.
            # Infer their side from their order relative to visible table rows.
            x1, y1, x2, y2 = bounds(partial[0])
            if x2 > x1 and y2 > y1:
                near_top = y1 < bounds(scroll)[1]+20
            else:
                visible = [lines.index(n.get("text")) for n in scroll.iter("node")
                           if n.get("text") and (HOUR.fullmatch(n.get("text")) or ARRIVAL.fullmatch(n.get("text")))
                           and bounds(n)[2] > bounds(n)[0] and bounds(n)[3] > bounds(n)[1]]
                near_top = bool(visible) and lines.index(partial[0].get("text")) < min(visible)
            device.swipe(scroll, reverse=near_top, fraction=.12)
            continue
        signature = [(n.get("text"), n.get("bounds")) for n in scroll.iter("node") if n.get("text")]
        stationary = stationary+1 if signature == previous else 0
        if stationary >= 2:
            if headers and not any(ARRIVAL.fullmatch(s) and s[:2] == headers[-1].get("text")[:2]
                                   for s in lines):
                device.tap(headers[-1])
                previous, stationary = None, 0
                continue
            unread = [g for g in groups if service_time(g[:5])[:2] not in seen_hours]
            if unread:
                raise RuntimeError(f"展开收尾仍有未读小时：{sorted(unread)}，未覆盖正式文本")
            return groups, audits
        previous = signature
        if page % 10 == 0:
            print(f"{station} {direction}: 展开{page}屏，见到{len(groups)}小时", flush=True)
        device.swipe(scroll)
    raise RuntimeError("展开超过翻页上限，未覆盖正式文本")


def capture(device, station, direction, day, max_pages=500, publish=True):
    now = local_now()
    if (day == "weekend") != (now.weekday() >= 5):
        raise RuntimeError("高德此页面未提供日期选择；不能把今天的数据标成另一日类型")
    audit_dir = WORK / "runs" / f"{station}-{direction}-{day}-{now:%Y%m%d-%H%M%S-%f}"
    audit_dir.mkdir(parents=True, exist_ok=True)
    device.audit_dir, device.audit_page = audit_dir, 0
    root = rewind(device)
    if f"上车站：{station}" not in texts(root):
        raise RuntimeError(f"上车站不匹配，预期 {station}")
    groups, expansion_audits = expand_groups(device, station, direction, max_pages)
    # 所有小时展开后已在表底；从空集合反向完整读取，省去无采集用途的回卷。
    # 这是本次独立读取；另一遍仍须退出页面重新进入，不能拿展开阶段拼接。
    ordered, read_groups, labels, pages = read_expanded(
        device, station, direction, max_pages, reverse=True, rewind_first=False)
    if groups != read_groups:
        raise RuntimeError(f"展开遍与独立读取的小时分组不一致：{sorted(groups ^ read_groups)}")
    errors, warnings = validate(station, direction, ordered)
    # 除首末班外，整段小时缺失也不能当完整数据入库。
    expected_hours = set(range(minutes(ordered[0])//60, minutes(ordered[-1])//60+1)) if ordered else set()
    absent = expected_hours - {minutes(v)//60 for v in ordered}
    if absent:
        errors.append(f"整小时没有记录：{sorted(absent)}")
    if not labels:
        errors.append("独立读取没有方向标签")
    data = {"station": station, "direction": direction, "day": day, "values": ordered,
            "captured_at": now.isoformat(), "independent_runs": 1,
            "groups": sorted(groups), "labels": sorted(labels), "errors": errors, "warnings": warnings,
            "hour_counts": dict(Counter(v[:2] for v in ordered)), "pages": pages,
            "expansion_audits": expansion_audits}
    (audit_dir / "result.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    if errors:
        raise RuntimeError("采集保留在 work/，未覆盖正式文本：" + "; ".join(errors))
    device.audit_dir = None
    if publish:
        (WORK / f"{station}-{direction}-{day}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return publish_capture(data)
    return data


def verified_capture(device, station, direction, day):
    """两次均重新进入；不一致时两遍证据留 work/，正式文件不变。"""
    runs = []
    for attempt in (1, 2):
        print(f"{station} {direction}: 从线路页重新进入，第{attempt}/2次", flush=True)
        select_station(device, station)
        select_direction(device, direction)
        runs.append(capture(device, station, direction, day, publish=False))
    a, b = (set(r["values"]) for r in runs)
    if a != b or runs[0]["groups"] != runs[1]["groups"]:
        raise RuntimeError("两次重新进入结果不一致，不覆盖正式文本："
                           f"仅第一遍 {sorted(a-b, key=minutes)}；仅第二遍 {sorted(b-a, key=minutes)}")
    data = runs[1]
    data["independent_runs"] = 2
    (WORK / f"{station}-{direction}-{day}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    path = OUT / f"{station}-{direction}-{day}.txt"
    old = set(read_table(path)[3]) if path.exists() else set()
    print(f"{path.name}: 对旧文本新增 {' '.join(sorted(b-old, key=minutes)) or '无'}；"
          f"删除 {' '.join(sorted(old-b, key=minutes)) or '无'}", flush=True)
    data["difference_from_previous"] = {"added": sorted(b-old, key=minutes), "removed": sorted(old-b, key=minutes)}
    (WORK / f"{station}-{direction}-{day}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return publish_capture(data)


def compare_tables(baseline, day):
    """只比基线点名的文件；不混入其他对话的新表，不把日期变动算时刻差异。"""
    old_paths = {p.name: p for p in baseline.glob(f"*-{day}.txt")}
    if not old_paths:
        raise RuntimeError(f"基线目录没有时刻文本：{baseline}")
    current = {p.name: p for p in OUT.glob(f"*-{day}.txt")}
    for name in sorted(old_paths):
        old = set(read_table(old_paths[name])[3]) if name in old_paths else set()
        new = set(read_table(current[name])[3]) if name in current else set()
        added, removed = sorted(new-old, key=minutes), sorted(old-new, key=minutes)
        print(f"{name}: {len(old)}→{len(new)}行；新增 {' '.join(added) or '无'}；删除 {' '.join(removed) or '无'}", flush=True)
    if current.keys() - old_paths.keys():
        print(f"另有 {len(current.keys()-old_paths.keys())} 份无本轮基线的新表，不计入重抓差异。", flush=True)


def select_direction(device, direction):
    root = device.dump()
    candidates = []
    for n in root.iter("node"):
        ts = texts(n)
        if n.get("clickable") == "true" and len(ts) == 2 and set(ts) == set(ENDS.values()):
            if ts[-1] == ENDS[direction]:
                candidates.append(n)
    if not candidates:
        raise RuntimeError("找不到时刻表方向标签，停止导航")
    device.tap(candidates[-1])
    time.sleep(1)


def select_station(device, station):
    root = device.dump()
    if any(s.startswith("上车站：") or HOUR.fullmatch(s) or ARRIVAL.fullmatch(s) for s in texts(root)):
        device.back()
        root = device.dump()
    root = device.expand_panel(root)
    previous, stationary = None, 0
    target_index = list(official_rows()).index(station)
    for _ in range(50):
        carousels = [n for n in root.iter("node") if n.get("scrollable") == "true" and
                     "Horizontal" in n.get("class", "")]
        if not carousels:
            raise RuntimeError(f"找不到 {LINE_TITLE}站点横向列表")
        carousel = carousels[-1]
        nodes = [n for n in carousel.iter("node") if n.get("text") == station]
        if nodes:
            # 页面上方同名文字可能是目的地，须实际点击列表中的目标站。
            device.tap(nodes[-1])
            time.sleep(1)
            root = device.dump()
            # 站点切换后的 AJX 动画可能吞掉第一次点击；只在仍处于线路页时重试。
            for attempt in range(3):
                tabs = [n for n in root.iter("node") if n.get("text") == "到站时刻表"]
                if not tabs:
                    raise RuntimeError("找不到到站时刻表入口")
                device.tap(tabs[0])
                time.sleep(1)
                root = device.dump()
                if f"上车站：{station}" in texts(root):
                    return
                if any(s.startswith("上车站：") for s in texts(root)):
                    raise RuntimeError("打开了其他站的表，停止操作")
            else:
                raise RuntimeError("切站失败")
        visible = texts(carousel)
        indices = [i for i, name in enumerate(official_rows()) if name in visible or any(name in s for s in visible)]
        if not indices:
            raise RuntimeError("无法识别站点列表")
        signature = visible
        stationary = stationary + 1 if signature == previous else 0
        if stationary >= 2:
            raise RuntimeError("站点横向列表没有继续滚动")
        previous = signature
        gesture = ET.Element("node", bounds=carousel.get("bounds"))
        x1, y1, x2, y2 = bounds(carousel)
        images = [bounds(n) for n in carousel.iter("node") if n.get("class") == "android.widget.ImageView"]
        if images:
            y2 = min(b[3] for b in images)
            gesture.set("bounds", f"[{x1},{y1}][{x2},{y2}]")
        device.swipe(gesture, horizontal=True, reverse=target_index < min(indices))
        root = device.dump()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["inspect", "capture", "batch", "validate", "summary", "diff"])
    parser.add_argument("--adb")
    parser.add_argument("--serial")
    parser.add_argument("--line", default=os.environ.get("ATS_LINE", "2"))
    parser.add_argument("--station")
    parser.add_argument("--direction", choices=list(ENDS))
    parser.add_argument("--day", choices=["weekday", "weekend"], default="weekday")
    parser.add_argument("--optional", action="store_true")
    parser.add_argument("--resume", action="store_true", help="跳过今天已保存且校验通过的表")
    parser.add_argument("--baseline", type=Path, help="diff 使用的旧文本目录；须在重抓前复制保留")
    args = parser.parse_args()
    if args.line != LINE_ID:
        configure_line(args.line)
    if args.station and args.station not in official_rows():
        parser.error(f"不属于 {LINE_TITLE} 的车站：{args.station}")
    if args.command == "batch" and not args.station and not PRIORITY:
        parser.error("请用 --station 指定采集站")
    if args.command == "diff":
        if not args.baseline:
            parser.error("diff 要求 --baseline 旧文本目录")
        compare_tables(args.baseline, args.day)
        return
    if args.command == "summary":
        update_summary()
        return
    if args.command == "validate":
        raise SystemExit(int(report(sorted(OUT.glob(f"*-{args.day}.txt")))))
    device = Device(args.adb, args.serial)
    device.connected()
    if args.command == "inspect":
        root = device.dump()
        # inspect 只打印时刻表，不打印背景地图和其他应用内容。
        scroll = table_scroll(root)
        for n in scroll.iter("node"):
            if n.get("text"):
                print(n.get("text"), n.get("bounds"))
    elif args.command == "capture":
        if not args.station or not args.direction:
            parser.error("capture 要求 --station 和 --direction")
        verified_capture(device, args.station, args.direction, args.day)
        update_summary()
    else:
        stations = [args.station] if args.station else PRIORITY[:7 if args.optional else 5]
        for station in stations:
            for direction in ([args.direction] if args.direction else list(ENDS)):
                existing = OUT / f"{station}-{direction}-{args.day}.txt"
                if args.resume and existing.exists():
                    content = existing.read_text(encoding="utf-8")
                    if (content.startswith(f"# 抓取日期：{local_now():%Y-%m-%d}") and
                            "# 完整性：两次从线路页重新进入" in content and
                            not validate(station, direction, read_table(existing)[3])[0]):
                        print(f"跳过今天已通过校验的 {existing.name}", flush=True)
                        continue
                verified_capture(device, station, direction, args.day)
                update_summary()
        report(sorted(OUT.glob(f"*-{args.day}.txt")))


if __name__ == "__main__":
    main()
