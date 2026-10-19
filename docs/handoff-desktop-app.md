# 交接：打包成桌面 app，一键启动

用户要的是：不开命令行、不输网址，双击桌面图标就能打开模拟器。只给用户自己用，不发布。

## 做法（已定）

用 Tauri 2 包现有的 Vite 前端。本机已有 Rust（cargo 1.97）、VS 生成工具、WebView2（155），不用另装运行时。前端代码不用改，`vite.config.ts` 已经是 `base: './'`。

1. 新建 `src-tauri/`，用官方的 Vite 集成：
   - `beforeDevCommand: npm run dev`、`devUrl: http://localhost:5173`；
   - `beforeBuildCommand: npm run build`、`frontendDist: ../dist`。
   - `@tauri-apps/cli` 加进 devDependencies。Rust 侧只要最小的 `main.rs`，不加业务逻辑。
2. 窗口设置：
   - 标题「上海地铁2号线 ATS 模拟器」，启动时最大化，最小尺寸按现在页面不出横向滚动条来定；
   - 关闭窗口就退出进程，不常驻托盘。
3. 图标：自己画一个简单的 SVG（绿色 2 号线圆标加白色「2」就行），用 `npx tauri icon` 生成各尺寸。不要用上海地铁官方标志。
4. `package.json` 加两个脚本：
   - `app:dev`：`tauri dev`；
   - `app:build`：`tauri build`。只要 release exe，不要安装包，用 `--no-bundle` 或 `bundle.active: false`。
5. 一键启动：新增 `scripts/app-shortcut.ps1`。它在桌面建一个快捷方式，名字「2号线ATS」，指向 `src-tauri/target/release/` 下的 exe，图标用 exe 自带的。
   - 以后更新只要重新跑一遍 `npm run app:build`，快捷方式不用重建。
   - exe 名字用英文，比如 `line2-ats.exe`，避免路径编码问题。
6. `.gitignore` 加上 `/src-tauri/target/` 和 `/src-tauri/gen/`。`Cargo.lock` 要入库。

## 启动流程和启动速度

- **启动流程**：打开 app 就直接弹出「运营日设置」对话框，让用户选几号、几点开始，选完才开始生成运行图。不要先自动开一个默认的运营日。网页版行为不变。
  - 开局对话框里新增的随机故障、教员事件两项在 `docs/handoff-day-randomness.md` 里，不在这个任务的范围内。
- **启动速度**：先量，再优化。分段记下冷启动的耗时，写进汇报，改前改后各一份：
  1. 双击到窗口出现；
  2. 窗口出现到对话框可以操作；
  3. 点「开始」到运行图生成完；
  4. 运行图生成完到预热推演结束、画面开始走。
  - 只优化量出来最慢的那一两段。运行图生成大约 4 s，这一段不许为了变快而改变结果：改前改后的 `trips` 和 `blocks` 哈希必须一致。
  - 加载期间要有进度提示，显示当前在哪一步，不能只有一块黑屏。
- **界面**：这次只做启动对话框和加载画面，让它们像个正式的 app。主界面其他地方不动，用户点名的显示问题在 `docs/handoff-display-fixes.md` 里另做。

## 必须在 app 里验证的几件事

浏览器里能用、WebView2 里不一定能用的东西，逐条在打包出来的 exe 里检查，不要只跑 `app:dev`：

- **Web Worker**：仿真在 worker 里跑（`worker: { format: 'es' }`）。确认 exe 里时钟会走，120× 不卡。
- **声音**：`public/sounds/` 下的切片会跟着 `dist` 打进 exe，这是给用户自己用的，可以。确认车内广播、站台广播和 VVVF 都能播。WebView2 的自动播放策略可能要求先有用户操作，沿用现在的音频解锁逻辑，别绕过它。
- **IndexedDB**：`src/sim/warmupCache.ts` 用 IndexedDB 缓存预热检查点。确认第二次启动时命中缓存。
- **localStorage**：界面设置关掉 app 再打开要还在。
- **导出诊断**：`src/ui/store.ts:154` 用 `<a download>` 导出 `line2-diagnostics-*.json`。
  - WebView2 下如果点了没反应，或者文件不知道存到了哪里，就改成 Tauri 的保存对话框（`plugin-dialog` 加 `plugin-fs`）。
  - 只在 Tauri 环境下走这条路，网页版保持原样。判断用 `'__TAURI_INTERNALS__' in window` 这类官方方式，同一件事只写一处。
- **字体**：`@fontsource/jetbrains-mono` 是本地打包的，确认没有去外网取资源。CSP 保持默认的严格设置，哪条被拦了就只放开哪条。
- **开发者工具**：release 版关掉；`app:dev` 里可以开。

## 完成标准

- `npm run app:build` 成功，产出 exe；`npx tsc --noEmit` 干净。
- 双击桌面快捷方式能打开 app，进入后仿真正常运行。
- 上面「必须验证」每一条都给出结论：通过、改了什么、或者没法自动验证。没法自动验证的列出来，写清楚用户自己要点哪里、看什么。
- 网页版 `npm run dev` 行为不变。

## 不要做的

- 不改 `src/sim/` 下的任何东西，不碰运行图和仿真逻辑。
- 不做安装包、自动更新、代码签名，也不把 exe 或音频放进仓库。
- 不加托盘、开机自启、全局快捷键这些用户没要的功能。
- 不跑 `npm test`、soak、simday。
- 代码、注释、文档里不写任何 AI 模型名称。

## 汇报

按 AGENTS.md 的格式写。另外附上这几项：

- exe 的路径和大小；
- 冷启动到出画面大概几秒；
- 用户第一次要执行的命令：先 `npm install`，再 `npm run app:build`，最后跑快捷方式脚本。
- README 里加一小节「桌面版」，写这三步。
