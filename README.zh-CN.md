# 上海地铁2号线 ATS 模拟器

[English](README.md) · [简体中文](README.zh-CN.md)

TypeScript/Vite 编写的2号线运营仿真，包含OCC总览、车站联锁和列车运行。界面为简体中文，覆盖蟠祥路·国家会计学院至浦东1号2号航站楼31站，支持浏览器与Tauri桌面版。

## 运行

```bash
npm install
npm run dev
npm run build
npm run preview
```

开发地址 `http://localhost:5173`。`build` 检查类型并生成 `dist/`，`preview` 预览该构建。浏览器默认从工作日07:40开始；`?t=04:00` 可指定仿真时刻。桌面版先显示运营日设置。

Windows桌面构建需要Rust、Visual Studio C++生成工具与WebView2：

```powershell
npm run app:dev
npm run app:build
powershell -ExecutionPolicy Bypass -File scripts/app-shortcut.ps1
```

`app:build` 生成 `src-tauri/target/release/line2-ats.exe`，不制作安装包。更新源码后重新构建，已打开的旧exe不会自动更新；桌面快捷方式只需建立一次。

## 调度和驾驶

- 总览与车站图显示列车、进路、信号机、道岔、区段、站台及车场。选中对象办理命令，列车表、计划/实际运行图和报警列表可定位对象。
- 工作日/双休日运行图包含大小交路、出入段、折返、过夜车与热备。可办理扣车、跳停、退出服务、加开和恢复，配有调度通话、故障、天气、教员场景及评分。
- 列控以CBTC为主、TBTC后备。跟踪列车显示DMI；DTO/AM自动运行，可接管AM操作ATO启动，也可接管CM/RM人工驾驶。
- 详情页选中的列车，各模式都有站台近景、对标和发车倒计时。DEP与计时器共用ATS发车时钟，扣车显示H。见[设计决定](docs/design-decisions.md)D128。
- CM显示黄色推荐速度标记及实际/推荐/允许数字。推荐复用ATO目标、区间预算、运行等级、限速与制动计算，实际牵引仍由手柄控制；AM/DTO/RM不显示该推荐。
- 人工过标沿本车最近走过的路径退行：≤5m可自行退，更长须调度同意。拒绝时显示真实原因并走现有过标请示；完成到站后清理旧退行状态，避免切模式后牵引被封锁。
- 区间预算调速使用完整停车任务距离（D126）及路径静态限速积分ETA（D127）。安全防护仍用原扫描，临时限速、天气、前车和移动授权继续约束实际运行。

|操作|作用|
|---|---|
|空格 / 1–7|暂停 / 仿真速率；自动运行支持1×–120×|
|滚轮 / 拖动|线路视图缩放 / 平移|
|F1 / M|帮助 / 应用内声音开关|
|Z或↑ / Q或↓|加牵引或缓解制动 / 加制动或减牵引|
|S / E|手柄中立 / 紧急制动|
|Y / U|右门 / 左门；再按一次关闭|
|L / K / J|换向器前 / 零 / 后，仅零速可操作|
|F + G|已接管AM满足发车条件后，同时按住ATO启动双按钮|

提前按ATO启动不锁存。线上有CM/RM车时速率最高5×。CM按停车窗和站台侧给门使能；RM目视运行、站台门由站务操作PSL。命令条件与故障处置详见帮助页。

## 诊断与本地声音

调度命令和驾驶输入进入日志，可随诊断原样回放。检查点及连续运营日搬运在跨午夜时保留物理世界；报告卡车时，诊断导出比只有截图更容易复现。

报站、门动作、警示蜂鸣和底噪来自本地素材。音频不入库：切片放 `public/sounds/`，原件与私有分析放忽略的 `work/`，乘客转写不入库。分析只读文件，不播放、不上传，不自动下载语音识别模型。

```powershell
npx tsx scripts/audio/field-calibration.ts --existing --prepare-only
npx tsx scripts/audio/field-calibration.ts --input "work/recordings/19.56威宁路~淞虹路.mp4" --from 威宁路 --direction UP --clock 19:56 --out work/bottom-up-runtime/new-video --no-model
python scripts/audio/test-field-calibration.py
```

新增录音看[分析入口](scripts/audio/README-field.md)，来源、门声测量与PIS实拍看[现场资料索引](docs/field/README.md)。公开仓库不含全部本地声音成品。

## 依据与当前限制

运行图依据按D125排序：

1. [官方首末班、末班后定点班车及运行间隔](src/data/firstlast.ts)。
2. [用户录音和PIS实拍](docs/field/README.md)：用于运行、停站时分与车速观察；PIS倒计时是预测，不是实到。
3. [高德采集](reference/line2/timetable-gaode.md)：只参考可信列每15分钟车数，不拿整分钟读数定区间时分、停站或等级。

拓扑、纵坡、车辆性能、客流和运营流程仍有注明的近似，不构成真实铁路运营系统。随机运行仍会遇到回段等待环；D128小批对照未新增类型，但在既有环处提前停止，未跑到第二天，不能据此声称整日安全回归全绿。

[自下而上的时分分析](docs/field/bottom-up-runtime-2026-10.md)中，60个方向区间有40个具备完整门声候选，22个有较强证据；其中富余和停站规则只是建议，没有改现行运行图参数。详见[设计决定](docs/design-decisions.md)、[配线建模](docs/layout-pdf.md)、[信号模型](docs/signalling-model.md)和[线路/车辆研究](reference/line2/Shanghai_Metro_Line2_Profile_and_Rolling_Stock_Research.md)。

## 定向验证

```powershell
npx tsc --noEmit
npx vitest run tests/driver.test.ts tests/dmi.test.ts tests/stopview.test.ts
```

按改动选择测试文件。改运行图还须做两种日型计划校验、官方首末班及高德车数对比。仓库约束和完整验证要求见 [AGENTS.md](AGENTS.md)。

## 授权

AGPL-3.0，见 [LICENSE](LICENSE)。PIS七段数字字体使用keshikan的DSEG7 Classic，SIL Open Font License 1.1，见[字体授权](src/ui/assets/fonts/DSEG-LICENSE.txt)。
