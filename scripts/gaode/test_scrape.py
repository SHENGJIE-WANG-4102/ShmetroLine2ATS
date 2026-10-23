"""离线解析、校验和翻页测试；不连接手机，不使用真实位置 XML。"""
import contextlib
from datetime import datetime, timezone, timedelta
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

import scrape


def screen(lines):
    root = ET.Element("hierarchy")
    scroll = ET.SubElement(root, "node", scrollable="true", bounds="[0,100][1000,2000]")
    destination = next((s for s in lines if s.startswith("开往")), "开往蟠祥路·国家会计学院")
    for i, text in enumerate(lines):
        parent = scroll
        if scrape.ARRIVAL.fullmatch(text):
            parent = ET.SubElement(scroll, "node", **{"class": "android.view.ViewGroup",
                                   "clickable": "true", "bounds": f"[20,{130+i*100}][900,{230+i*100}]"})
            ET.SubElement(parent, "node", text=destination, bounds=f"[500,{150+i*100}][900,{200+i*100}]")
        ET.SubElement(parent, "node", text=text, bounds=f"[20,{150+i*100}][400,{200+i*100}]")
    return root


class FakeDevice:
    def __init__(self, screens):
        self.screens = screens
        self.index = 0

    def dump(self):
        return self.screens[self.index]

    def tap(self, node):
        self.index = min(self.index+1, len(self.screens)-1)

    def swipe(self, node, **kwargs):
        self.index = min(self.index+1, len(self.screens)-1)


class ScrapeTest(unittest.TestCase):
    def test_only_arrivals_not_group_or_official_times(self):
        root = screen(["05:00-06:00", "首05:55 末23:49", "05:55到站", "05:55到站", "00:05到站"])
        self.assertEqual(scrape.arrivals(root), {"05:55", "24:05"})

    def test_east_last_includes_guanglan_service(self):
        errors, warnings = scrape.validate("北新泾", "DN", ["05:42", "22:14", "22:59"])
        self.assertEqual((errors, warnings), ([], []))
        errors, _ = scrape.validate("北新泾", "DN", ["05:42", "22:14"])
        self.assertIn("末班", errors[0])

    def test_midnight_official(self):
        self.assertEqual(scrape.validate("虹桥火车站", "UP", ["06:07", "24:00"]), ([], []))

    def test_one_minute_is_reported_not_silent(self):
        errors, warnings = scrape.validate("北新泾", "UP", ["05:56", "23:49"])
        self.assertEqual(errors, [])
        self.assertIn("+1 min", warnings[0])

    def test_duplicates_and_reversal_fail(self):
        for values in (["05:55", "05:55", "23:49"], ["05:55", "06:10", "06:00", "23:49"]):
            errors, _ = scrape.validate("北新泾", "UP", values)
            self.assertTrue(errors)

    def test_empty_fails(self):
        self.assertTrue(scrape.validate("北新泾", "UP", [])[0])

    def test_summary_preserves_manual_and_is_idempotent(self):
        official = scrape.official_rows()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            out = root / "reference/timetable-gaode"
            out.mkdir(parents=True)
            target = root / "reference/line2/timetable-gaode.md"
            target.parent.mkdir(parents=True)
            target.write_text("# 时刻表\n\n原来源说明\n\n## 原手录\n\n05:55\n", encoding="utf-8")
            (out / "北新泾-UP-weekday.txt").write_text("# 测试来源\n05:55\n23:49\n", encoding="utf-8")
            with patch.object(scrape, "ROOT", root), patch.object(scrape, "OUT", out), \
                    patch.object(scrape, "validate", return_value=([], [])), \
                    patch.object(scrape, "official_rows", return_value=official):
                scrape.update_summary()
                once = target.read_text(encoding="utf-8")
                scrape.update_summary()
                self.assertEqual(target.read_text(encoding="utf-8"), once)
                self.assertIn("## 原手录\n\n05:55", once)
                self.assertIn("| 2 | 05:55 | 23:49 | 一致 |", once)
                self.assertEqual(once.count("<!-- gaode-scrape:start -->"), 1)

    def test_manual_comparison_excludes_unrecorded_midday(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "reference/line2").mkdir(parents=True)
            (root / "reference/line2/timetable-gaode.md").write_text(
                "## 张江高科 往西（往蟠祥路）\n| 05 | 05:33 05:39 |\n| 22 | 22:03 23:07 |\n", encoding="utf-8")
            with patch.object(scrape, "ROOT", root):
                result = scrape.manual_difference("张江高科", "UP", ["05:33", "05:35", "12:00", "22:03", "23:07"])
                self.assertEqual(result, ["原手录有、自动表无：05:39", "原手录覆盖窗内新增：05:35"])

    def test_overlap_expansion_and_two_stationary_screens(self):
        initial = screen(["上车站：北新泾", "05:00-06:00"])
        opened = screen(["上车站：北新泾", "05:00-06:00", "05:55到站", "开往蟠祥路·国家会计学院"])
        final = screen(["05:00-06:00", "05:55到站", "06:00-07:00", "06:05到站", "开往蟠祥路·国家会计学院"])
        device = FakeDevice([initial, opened, final])
        now = datetime(2026, 10, 15, 12, tzinfo=timezone(timedelta(hours=8)))
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(scrape, "WORK", Path(temp)), \
                patch.object(scrape, "OUT", Path(temp)), \
                patch.object(scrape, "rewind", return_value=initial), \
                patch.object(scrape, "local_now", return_value=now), \
                patch.object(scrape.time, "sleep"), \
                patch.object(scrape, "validate", return_value=([], [])), \
                contextlib.redirect_stdout(io.StringIO()):
            path = scrape.capture(device, "北新泾", "UP", "weekday")
            self.assertEqual(scrape.read_table(path)[3], ["05:55", "06:05"])

    def test_swallowed_header_click_is_retried(self):
        initial = screen(["上车站：北新泾", "05:00-06:00", "06:00-07:00"])
        opened = screen(["上车站：北新泾", "05:00-06:00", "05:55到站", "06:00-07:00", "06:05到站", "开往蟠祥路·国家会计学院"])

        class SwallowedDevice(FakeDevice):
            taps = 0

            def tap(self, node):
                self.taps += 1
                if self.taps > 1:
                    super().tap(node)

            def swipe(self, node, **kwargs):
                if self.taps > 1:
                    super().swipe(node, **kwargs)

        device = SwallowedDevice([initial, opened])
        now = datetime(2026, 10, 15, 12, tzinfo=timezone(timedelta(hours=8)))
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(scrape, "WORK", Path(temp)), patch.object(scrape, "OUT", Path(temp)), \
                patch.object(scrape, "rewind", return_value=initial), \
                patch.object(scrape, "local_now", return_value=now), patch.object(scrape.time, "sleep"), \
                patch.object(scrape, "validate", return_value=([], [])), \
                contextlib.redirect_stdout(io.StringIO()):
            path = scrape.capture(device, "北新泾", "UP", "weekday")
            self.assertEqual(scrape.read_table(path)[3], ["05:55", "06:05"])
            self.assertEqual(device.taps, 2)

    def test_edge_header_is_moved_into_view_before_opening(self):
        edge = screen(["上车站：北新泾", "05:00-06:00"])
        list(edge.iter("node"))[-1].set("bounds", "[20,1980][900,2000]")
        centered = screen(["上车站：北新泾", "05:00-06:00"])
        opened = screen(["上车站：北新泾", "05:00-06:00", "05:55到站", "06:00-07:00", "06:05到站", "开往蟠祥路·国家会计学院"])

        class EdgeDevice(FakeDevice):
            def swipe(self, node, **kwargs):
                if self.index == 0 and kwargs.get("fraction", 1) >= .2:
                    raise AssertionError("不能整屏跨过未读的边缘小时标题")
                super().swipe(node, **kwargs)

        device = EdgeDevice([edge, centered, opened])
        now = datetime(2026, 10, 15, 12, tzinfo=timezone(timedelta(hours=8)))
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(scrape, "WORK", Path(temp)), patch.object(scrape, "OUT", Path(temp)), \
                patch.object(scrape, "rewind", return_value=edge), \
                patch.object(scrape, "local_now", return_value=now), patch.object(scrape.time, "sleep"), \
                patch.object(scrape, "validate", return_value=([], [])), \
                contextlib.redirect_stdout(io.StringIO()):
            path = scrape.capture(device, "北新泾", "UP", "weekday")
            self.assertEqual(scrape.read_table(path)[3], ["05:55", "06:05"])

    def test_tail_header_opens_without_spare_space_below(self):
        initial = screen(["上车站：北新泾", "05:00-06:00"])
        list(initial.iter("node"))[-1].set("bounds", "[20,1910][900,1975]")
        opened = screen(["上车站：北新泾", "05:00-06:00", "05:55到站", "05:59到站", "开往蟠祥路·国家会计学院"])

        class TailDevice(FakeDevice):
            def swipe(self, node, **kwargs):
                if self.index == 0:
                    return  # 表尾无额外滚动空间；连续不动后才证明最后一组折叠。
                super().swipe(node, **kwargs)

        now = datetime(2026, 10, 15, 12, tzinfo=timezone(timedelta(hours=8)))
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(scrape, "WORK", Path(temp)), patch.object(scrape, "OUT", Path(temp)), \
                patch.object(scrape, "rewind", return_value=initial), \
                patch.object(scrape, "local_now", return_value=now), patch.object(scrape.time, "sleep"), \
                patch.object(scrape, "validate", return_value=([], [])), \
                contextlib.redirect_stdout(io.StringIO()):
            path = scrape.capture(TailDevice([initial, opened]), "北新泾", "UP", "weekday")
            self.assertEqual(scrape.read_table(path)[3], ["05:55", "05:59"])

    def test_wrong_direction_never_published(self):
        root = screen(["上车站：北新泾", "05:00-06:00", "05:55到站", "开往浦东1号2号航站楼"])
        with patch.object(scrape, "rewind", return_value=root):
            with self.assertRaisesRegex(RuntimeError, "方向不符"):
                scrape.capture(FakeDevice([root]), "北新泾", "UP", "weekday")

    def test_workday_cannot_be_saved_as_weekend(self):
        now = datetime(2026, 10, 15, 12, tzinfo=timezone(timedelta(hours=8)))
        with patch.object(scrape, "local_now", return_value=now):
            with self.assertRaisesRegex(RuntimeError, "另一日类型"):
                scrape.capture(FakeDevice([]), "北新泾", "UP", "weekend")

    def test_sandwich_threshold_and_direction_order(self):
        from collections import Counter
        tables = [(s, "DN", "weekday", Counter({"18": n, "19": n}))
                  for s, n in [("虹桥2号航站楼", 18), ("北新泾", 14), ("世纪公园", 20)]]
        result = scrape.sandwich_differences(tables)
        self.assertEqual(len(result), 2)
        self.assertIn("虹桥2号航站楼→北新泾→世纪公园", result[0])
        tables[1][3]["18"] = 16  # 只少2班不报警。
        tables[1][3]["19"] = 15  # 恰好少3班报警。
        result = scrape.sandwich_differences(tables)
        self.assertEqual(len(result), 1)
        self.assertIn("19点", result[0])
        reverse = [(s, "UP", day, counts) for s, _, day, counts in tables]
        self.assertIn("世纪公园→北新泾→虹桥2号航站楼", scrape.sandwich_differences(reverse)[0])
        self.assertEqual(scrape.sandwich_differences([tables[0], tables[1],
                         ("世纪公园", "DN", "weekend", tables[2][3])]), [])

    def test_stable_read_rejects_gap_even_with_correct_first_and_last(self):
        first = screen(["上车站：北新泾", "05:00-06:00", "05:42到站", "05:47到站", "开往浦东1号2号航站楼"])
        last = screen(["22:00-23:00", "22:54到站", "22:59到站", "开往浦东1号2号航站楼"])
        device = FakeDevice([first, last])
        with patch.object(scrape, "rewind", return_value=first):
            with self.assertRaisesRegex(RuntimeError, "缺少重叠行"):
                scrape.read_expanded(device, "北新泾", "DN", 20)

    def test_stable_read_does_not_use_expansion_values(self):
        root = screen(["上车站：北新泾", "05:00-06:00", "05:55到站", "05:59到站", "开往蟠祥路·国家会计学院"])
        with patch.object(scrape, "rewind", return_value=root), contextlib.redirect_stdout(io.StringIO()):
            values, groups, labels, pages = scrape.read_expanded(FakeDevice([root]), "北新泾", "UP", 20)
        self.assertEqual(values, ["05:55", "05:59"])
        self.assertEqual(pages[0]["row_nodes"], 2)
        self.assertEqual(pages[0]["hour_counts"], {"05": 2})
        self.assertEqual(pages[0]["layout_audit"]["complete_row_containers"], 2)

    def test_layout_row_without_arrival_fails_instead_of_silent_skip(self):
        root = screen(["05:00-06:00", "05:55到站"])
        scroll = scrape.table_scroll(root)
        empty = ET.SubElement(scroll, "node", **{"class": "android.view.ViewGroup",
                              "clickable": "true", "bounds": "[20,500][900,620]"})
        ET.SubElement(empty, "node", text="开往蟠祥路·国家会计学院", bounds="[500,520][900,580]")
        with self.assertRaisesRegex(RuntimeError, "行容器与 dump 到站行数不一致"):
            scrape.row_layout_audit(scroll)

    def test_stable_read_rejects_duplicate_nodes_and_collapsed_hour(self):
        for lines, error in [(["05:00-06:00", "05:55到站", "05:55到站"], "重复到站节点"),
                             (["05:00-06:00", "05:55到站", "06:00-07:00"], "小时标题不完整"),
                             (["05:00-06:00", "05:55到站", "展开更多"], "展开更多")]:
            root = screen(lines)
            with patch.object(scrape, "rewind", return_value=root), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, error):
                    scrape.read_expanded(FakeDevice([root]), "北新泾", "UP", 20)

    def test_two_reentries_must_agree_before_publishing(self):
        data = {"station": "北新泾", "direction": "DN", "day": "weekday", "groups": ["05:00-06:00"],
                "values": ["05:42"], "independent_runs": 1}
        for second, should_publish in [(dict(data), True), (dict(data, values=["05:43"]), False)]:
            with tempfile.TemporaryDirectory() as temp, patch.object(scrape, "WORK", Path(temp)), \
                    patch.object(scrape, "OUT", Path(temp)), \
                    patch.object(scrape, "select_station") as station, \
                    patch.object(scrape, "select_direction") as direction, \
                    patch.object(scrape, "capture", side_effect=[dict(data), second]) as capture, \
                    patch.object(scrape, "publish_capture", return_value=Path(temp)/"published.txt") as publish, \
                    contextlib.redirect_stdout(io.StringIO()):
                if should_publish:
                    scrape.verified_capture(object(), "北新泾", "DN", "weekday")
                    self.assertEqual(publish.call_args.args[0]["independent_runs"], 2)
                else:
                    with self.assertRaisesRegex(RuntimeError, "不一致"):
                        scrape.verified_capture(object(), "北新泾", "DN", "weekday")
                    publish.assert_not_called()
                self.assertEqual(station.call_count, 2)
                self.assertEqual(direction.call_count, 2)
                self.assertTrue(all(c.kwargs["publish"] is False for c in capture.call_args_list))

    def test_sandwich_train_lists_specific_missing_time(self):
        def times(offset):
            return [f"{(660+i*5+offset)//60:02}:{(660+i*5+offset)%60:02}" for i in range(14)]
        up, middle, down = times(0), times(8), times(40)
        missing = middle.pop(4)
        tables = [(s, "DN", "weekday", values) for s, values in
                  [("虹桥2号航站楼", up), ("北新泾", middle), ("世纪公园", down)]]
        candidates, diagnostics = scrape.sandwich_trains(tables)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["expected_time"], missing)
        self.assertEqual(candidates[0]["upstream_time"], "11:20")
        self.assertEqual(candidates[0]["downstream_time"], "12:00")
        self.assertFalse(candidates[0]["ambiguous_endpoints"])
        self.assertEqual(candidates[0]["nearby_middle"], [])
        self.assertEqual(len(diagnostics), 2)

    def test_compare_reports_every_added_and_removed_minute(self):
        with tempfile.TemporaryDirectory() as temp:
            baseline, current = Path(temp)/"old", Path(temp)/"new"
            baseline.mkdir()
            current.mkdir()
            name = "北新泾-DN-weekday.txt"
            (baseline/name).write_text("# 旧日期\n05:42\n18:00\n22:59\n", encoding="utf-8")
            (current/name).write_text("# 新日期\n05:42\n18:01\n18:03\n22:59\n", encoding="utf-8")
            output = io.StringIO()
            with patch.object(scrape, "OUT", current), contextlib.redirect_stdout(output):
                scrape.compare_tables(baseline, "weekday")
            self.assertIn("3→4行；新增 18:01 18:03；删除 18:00", output.getvalue())

    def test_two_segment_tolerance_accumulates_without_reusing_endpoints(self):
        from match_trains import clock
        up = [660+i*5 for i in range(20)]
        middle, down = [v+8 for v in up], [v+40 for v in up]
        middle.pop(10)
        down[10] += 2  # 两段均偏1分钟，端点相差2分钟仍应列为候选。
        tables = [(s, "DN", "weekday", list(map(clock, values))) for s, values in
                  [("虹桥2号航站楼", up), ("北新泾", middle), ("世纪公园", down)]]
        candidates, _ = scrape.sandwich_trains(tables)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["expected_time"], "11:58")
        self.assertEqual(candidates[0]["reverse_expected_time"], "12:00")
        self.assertEqual(candidates[0]["downstream_time"], "12:32")

    def test_no_train_candidates_when_lag_has_no_evidence(self):
        tables = [(s, "DN", "weekday", ["11:00", "11:03"]) for s in
                  ["虹桥2号航站楼", "北新泾", "世纪公园"]]
        candidates, diagnostics = scrape.sandwich_trains(tables)
        self.assertEqual(candidates, [])
        self.assertEqual(sum("无法估计" in s for s in diagnostics), 2)

    def test_device_session_lock_prevents_interleaved_navigation(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(scrape, "WORK", Path(temp)):
            first, second = scrape.Device(), scrape.Device()
            try:
                with patch.object(first, "run", return_value="device"):
                    first.connected()
                with patch.object(second, "run", return_value="device") as run:
                    with self.assertRaisesRegex(RuntimeError, "另一采集进程占用手机"):
                        second.connected()
                    run.assert_not_called()
                    first.session_lock.close()
                    first.session_lock = None
                    second.connected()
                    run.assert_called_once_with("get-state")
            finally:
                for device in (first, second):
                    if getattr(device, "session_lock", None):
                        device.session_lock.close()

    def test_horizontal_swipe_uses_displayed_station_order(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(scrape, "WORK", Path(temp)):
            device = scrape.Device()
            root = ET.Element("hierarchy")
            carousel = ET.SubElement(root, "node", **{"class": "SpringHorizontalScrollView",
                                     "bounds": "[0,100][1000,300]"})
            a = ET.SubElement(carousel, "node", text="北新泾", bounds="[100,100][300,200]")
            b = ET.SubElement(carousel, "node", text="淞虹路", bounds="[500,100][700,200]")
            device.last_root = root
            with patch.object(device, "run") as run, patch.object(scrape.time, "sleep"):
                device.swipe(carousel, horizontal=True, reverse=True)
                coords = run.call_args.args[3:7]
                self.assertGreater(int(coords[0]), int(coords[2]))
                a.set("text", "淞虹路")
                b.set("text", "北新泾")
                device.swipe(carousel, horizontal=True, reverse=True)
                coords = run.call_args.args[3:7]
                self.assertLess(int(coords[0]), int(coords[2]))

    def test_clipped_open_header_does_not_hide_collapsed_final_hour(self):
        edge = screen(["21:00-22:00", "21:57到站", "22:00-23:00"])
        next(n for n in edge.iter("node") if n.get("text")=="21:00-22:00").set("bounds", "[20,100][400,107]")
        opened = screen(["21:00-22:00", "21:57到站", "22:00-23:00", "22:00到站", "22:59到站"])

        class BottomDevice(FakeDevice):
            taps = 0

            def tap(self, node):
                self.taps += 1
                self.asserted_title = node.get("text")
                super().tap(node)

            def swipe(self, node, **kwargs):
                if kwargs.get("reverse"):
                    raise AssertionError("21点已经有行，不能为其截断标题回滑而藏住22点")
                # 已到底，滑动不再移动；必须展开22点。

        device = BottomDevice([edge, opened])
        with patch.object(scrape.time, "sleep"), contextlib.redirect_stdout(io.StringIO()):
            groups, _ = scrape.expand_groups(device, "北新泾", "UP", 20)
        self.assertEqual(groups, {"21:00-22:00", "22:00-23:00"})
        self.assertEqual(device.asserted_title, "22:00-23:00")
        self.assertEqual(device.taps, 1)


if __name__ == "__main__":
    unittest.main()
