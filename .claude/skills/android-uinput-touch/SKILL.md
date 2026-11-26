---
name: android-uinput-touch
description: 小米/HyperOS 手机上 adb input tap/swipe 报 INJECT_EVENTS 被拒时，用 `adb shell uinput -` 建虚拟触摸屏照样点击滑动（不用插卡、不用开「USB 调试（安全设置）」）。采集高德时刻表等 adb 自动化遇到「Injecting input events requires INJECT_EVENTS」时用。
---

# 小米手机 adb 点不动：用 uinput 虚拟触摸屏

## 症状
`adb shell input tap/swipe` 和 uiautomator2 的点击都报：
`SecurityException: Injecting input events requires ... INJECT_EVENTS`，
日志 `InputManager: Permission Denial: injectInputEvent() from uid=2000`。
`dumpsys package com.android.shell` 里 INJECT_EVENTS 明明是 granted=true：这是小米系统自己加的拦截，对应「USB 调试（安全设置）」，该开关没有 SIM 卡时开不了。截图、`uiautomator dump`、`am start` 不受影响。

## 办法（2026-11-27 在 217c468c 上验证）
Android 自带 `uinput` 命令，shell 用户能用，不需要 INJECT_EVENTS：

1. `adb shell uinput -` 读 stdin 的 JSON 行：先 `register` 一个触摸屏（`ABS_MT_POSITION_X/Y`、`BTN_TOUCH`），等 3 秒让系统认出，再 `inject` 事件、`delay` 毫秒。
2. 事件数组每 3 个数一组 `(type, code, value)`：按下 `3,47,0 3,57,1 3,53,x 3,54,y 3,0,x 3,1,y 1,330,1 0,0,0`；移动 `3,53,x 3,54,y 3,0,x 3,1,y 0,0,0`；抬手 `3,47,0 3,57,-1 1,330,0 0,0,0`（**12 个数**）。
3. 现成封装：同目录 `touch.py`（`UinputTouch.tap/swipe`，命令行也能用）。

## 踩过的坑
- 抬手数组少一个 0 → 系统整组丢弃，看起来「设备注册了、getevent 有按下、界面没反应」。
- 滑动到终点要先停约 160 ms 再抬手，否则列表带惯性滑过头，屏间就没有重叠行。
- 注册后立刻点会丢，等 3 秒；一个进程里只注册一次，批量点击复用同一个进程。
- 坐标范围注册成屏幕实际像素（`wm size`），点击坐标取自 `uiautomator dump` 的 bounds，不要写死别的布局的坐标。
- `uiautomator dump --compressed` 会把大部分文字丢掉，不能用；用 `adb exec-out uiautomator dump /dev/tty`，输出前面有一行 Java 异常和末尾 `UI hierchary dumped` 要截掉（取 `<hierarchy` 到 `</hierarchy>`），比先写 /sdcard 再 cat 快。
- 不要去改系统设置绕开关（`settings put`、`pm grant`）：权限分类器会拦，也不对。
- 手机别拿去干别的；高德要亮屏停在线路页。

## 来源
Codex 2026-10-29 在同一台手机上先发现这条路（会话 `rollout-2026-10-24T00-56-46-…`，设备名 “Gaode capture touchscreen”）；2026-11-27 Line11 会话重做并修了抬手事件长度。
