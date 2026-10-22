# 录音现场对照

只分析文件，不播放声音、不上传录音，也不修改运营模型或运行图。

依赖本机已有的 Node/tsx、Python 3.10+、numpy、scipy、ffmpeg。新录音的报站定位可复用本地语音识别缓存，需要 faster-whisper；没有本地缓存就输出低置信度的关门音／站序候选，不自动下载。

```powershell
npx tsx scripts/audio/field-calibration.ts --input "D:/录音/新录音.wav" --from "蟠祥路·国家会计学院" --direction DN --clock 21:45 --out work/field-calibration/new
```

- `--from` 是录音开始时的本站／刚离开的站；DN 往机场、UP 往西。`--clock` 是原文件开始的近似钟点，不是首个起动事件的钟点；支持 HH:MM:SS、跨午夜的 24:xx–27:xx。
- `--offset 秒数` 只忽略文件前段，所有事件仍用原文件秒数，钟点仍以原文件开头为准。
- 输出只能放仓库的已忽略 `work/` 子目录。原件、PCM、可能含乘客的识别文本和所有中间结果不入库。
- `comparison.md` 是逐区间表；`comparison.json` 含置信度、谱峰、现场与模型差值；`model.json` 含真实门、到发、最终ATO目标、巡航预算采样、峰值、调速比例和停车距离缺失比例。
- 高德只输出到→到候选（均值／n／标准误），不冒充发→发或纯运行。整分钟量化、错班和系统误差不在标准误里。
- 语音识别只定站名和搜索窗，起停靠频谱；未核验的新录音保留低置信度和 `review-required`，漏站留空。已知旧文件按源路径和时长检查复用已审事件／报站窗；`--automatic` 强制走新录音路径。这两种验证不能混称为盲测精度。
- 声学谱峰没有同步车速标定时，`speedKmh` 返回 null。稳定载波／谐波不是已标定速度。
- 模型是种子7、干轨、200人、无前车的独立区间，真实门、ARS、制动和调速均开启；不代表现场的跟车情境。每次实跑恢复同一检查点。

```powershell
# 完整跑旧三批录音与全线双向五时段的受控模型
npx tsx scripts/audio/field-calibration.ts --existing --out work/field-calibration
# 只测音频与高德，输出模型空值（即使目录里有旧缓存）
npx tsx scripts/audio/field-calibration.ts --input "D:/录音/新录音.wav" --from 唐镇 --direction DN --clock 22:00 --out work/field-calibration/new --no-model
# 显式指定已存在的本地识别目录，不会自动下载
# ... --recognizer "D:/本地识别目录"
# 输入/生产源码/探针参数改变时自动失效；也可强制重跑模型
# ... --refresh-model
python scripts/audio/test-field-calibration.py
npx vitest run tests/field-calibration.test.ts
```

旧样本分析结论、测量精度和采集清单见 [2026年10月报告](../../docs/field-calibration-2026-10.md)。
