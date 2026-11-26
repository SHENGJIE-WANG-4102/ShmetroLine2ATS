#!/usr/bin/env python3
"""用 adb 的 `uinput -` 在手机上建一个虚拟触摸屏并发触摸（不需要 INJECT_EVENTS）。

用法（库）：
    from touch import UinputTouch
    t = UinputTouch(adb=r"D:\\Codex\\PlatformTools\\adb.exe", serial="217c468c", width=1080, height=2340)
    t.tap(540, 1200); t.swipe(540, 1800, 540, 900, ms=600); t.close()
命令行：python touch.py tap X Y | swipe X1 Y1 X2 Y2 [MS]   （--adb 路径 --serial 序号 --size 1080x2340）
"""
from __future__ import annotations

import argparse
import json
import subprocess
import time


class UinputTouch:
    def __init__(self, adb="adb", serial=None, width=1080, height=2340):
        self.w, self.h = width, height
        self.base = [adb] + (["-s", serial] if serial else [])
        info = lambda m: {"value": 0, "minimum": 0, "maximum": m, "fuzz": 0, "flat": 0, "resolution": 0}
        cfg = {"id": 1, "command": "register", "name": "ATS capture touchscreen", "vid": 1234, "pid": 5678,
               "bus": "usb",
               "configuration": [{"type": 100, "data": [1, 3]}, {"type": 101, "data": [330]},
                                 {"type": 103, "data": [0, 1, 47, 53, 54, 57]}, {"type": 110, "data": [1]}],
               "abs_info": [{"code": a, "info": info(b)} for a, b in
                            [(0, width - 1), (1, height - 1), (47, 9), (53, width - 1), (54, height - 1),
                             (57, 65535)]]}
        self.p = subprocess.Popen(self.base + ["shell", "uinput", "-"], stdin=subprocess.PIPE,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True)
        self._send(cfg)
        time.sleep(3)  # 注册后要等系统认出新设备，否则头几次触摸丢失

    def _send(self, obj):
        self.p.stdin.write(json.dumps(obj) + chr(10))
        self.p.stdin.flush()

    def _inject(self, events):
        self._send({"id": 1, "command": "inject", "events": events})

    def _delay(self, ms):
        self._send({"id": 1, "command": "delay", "duration": ms})

    def gesture(self, x1, y1, x2, y2, ms):
        # 每个事件是 (type, code, value) 三个数；抬手那组必须是 12 个数（少一个 0 系统会整组丢掉）。
        self._inject([3, 47, 0, 3, 57, 1, 3, 53, x1, 3, 54, y1, 3, 0, x1, 3, 1, y1, 1, 330, 1, 0, 0, 0])
        steps = max(1, int(ms / 30))
        for i in range(1, steps + 1):
            x, y = round(x1 + (x2 - x1) * i / steps), round(y1 + (y2 - y1) * i / steps)
            self._delay(30)
            self._inject([3, 53, x, 3, 54, y, 3, 0, x, 3, 1, y, 0, 0, 0])
        self._delay(160)  # 在终点停稳再抬手，否则列表会带惯性继续滑
        self._inject([3, 53, x2, 3, 54, y2, 3, 0, x2, 3, 1, y2, 0, 0, 0])
        self._delay(60)
        self._inject([3, 47, 0, 3, 57, -1, 1, 330, 0, 0, 0, 0])
        time.sleep(ms / 1000 + .15)

    def tap(self, x, y):
        self.gesture(int(x), int(y), int(x), int(y), 90)

    def swipe(self, x1, y1, x2, y2, ms=600):
        self.gesture(int(x1), int(y1), int(x2), int(y2), ms)

    def close(self):
        self.p.stdin.close()
        self.p.wait(timeout=10)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["tap", "swipe"])
    ap.add_argument("args", type=int, nargs="+")
    ap.add_argument("--adb", default="adb")
    ap.add_argument("--serial")
    ap.add_argument("--size", default="1080x2340")
    a = ap.parse_args()
    w, h = map(int, a.size.split("x"))
    t = UinputTouch(a.adb, a.serial, w, h)
    try:
        t.tap(*a.args[:2]) if a.action == "tap" else t.swipe(*a.args)
    finally:
        t.close()


if __name__ == "__main__":
    main()
