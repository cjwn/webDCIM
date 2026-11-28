# OUTPUTWebViewer 项目规则与开发偏好

本项目是本地 / 局域网摄影照片库浏览与选片工具（Node.js 零构建架构，支持 RAW+JPG 成组浏览、RAW 实时显影、1:1 人脸清晰度评估与峰值对焦）。

## 1. 目录与模块分工
- `server.js`：HTTP 路由、文件扫描与索引缓存、缩略图/视频转码、静态资源服务（`/`、`/styles.css`、`/js/*`）。
- `lib/rawdev.js`：RAW 16-bit 线性显影（Windows `dcraw_emu` / macOS `CIRAWFilter`）与两级溢出检查。
- `lib/sharpness.js`：原生 1:1 边缘宽度清晰度分析 + 离线 YuNet 人脸/眼部检测（`models/face_detection_yunet_2023mar.onnx`，MIT 协议）。
- `lib/trash.js`：跨平台移入废纸篓/回收站（macOS `/usr/bin/trash`，Windows 自动编译 `cache/win-trash.exe`）。
- `public/index.html` + `public/styles.css` + `public/js/`：
  - `app.js`：工具函数、全局状态、服务端轮询、总览与网格渲染、路由历史。
  - `lightbox.js`：大图灯箱、视频播放、EXIF 开关、`transform` 缩放/平移/全屏与大分辨率 `renderScale` 固化。
  - `sharpness.js`：清晰度开关、服务端 `/api/sharpness` 联动与 1:1 遮罩峰值对焦（含人脸四角框）。
  - `rawdev.js`：RAW 曝光/暗部/高光与溢出检查控件。
  - `modals.js`：目录切换弹窗、0ms 乐观删除队列与废纸篓弹窗、全局快捷键与启动引导。
- `tools/`：Windows 原生托盘源码 `TrayApp.cs`、macOS `rawdev.swift`、内嵌 `libraw/`。
- `cache/`：运行时产物与缓存（均已 gitignore，含缩略图、配置、审计日志 `server.log`、编译缓存）。

## 2. 工程与设计偏好
- **零构建原则**：前端保持原生 HTML / CSS / JS（`<script defer>` 按序加载），不引入 Webpack / Vite / React 等构建链。
- **可选依赖兜底**：`sharp`、`onnxruntime-node`、`serialport` 等均放 `package.json` 的 `optionalDependencies`，缺失时必须优雅降级而不阻断启动。
- **双端兼容（Windows & macOS）**：任何改动不得破坏 macOS 支持（`CIRAWFilter`、`start.command`、`/usr/bin/trash`、Safari 触控板捏合与双指平移）；本地状态持久化与路径处理均须跨平台。
- **保持仓库整洁**：不在项目目录遗留临时测试脚本或多余 `.bat`/`.vbs`；一次性验证脚本写到外部 scratch 目录；非必要不随意拆分无意义的零碎文件，但也避免单文件过度膨胀。
- **UI 细节**：
  - 暗色专业摄影工具风格，紧凑克制，侧栏按钮与文字注重视觉对齐（如 `.kv-btn` 通过负左边距让内部文字与上方标签严格左对齐）。
  - 耗时操作（如 EXIF、清晰度）尽量做成可开关且记住偏好的控件，未开启时零开销，不拖慢快速切图。
  - 局域网访问默认只读（删除、系统目录选择等敏感操作仅限本机 `isLocalRequest`）。

## 3. 快捷键台账（新增快捷键前务必核对）
- **大图灯箱（`#lb` 打开、无弹窗时）**：
  - `←` / `→`：上一张 / 下一张
  - `F`：全屏切换
  - `D`：收藏/取消收藏当前照片（无弹窗时生效，与 `#delModal` 的 `D` 确认删除互不冲突）
  - `Space`：套用/撤回上次 RAW 提亮参数（有 RAW 时）
  - `G`：RAW 溢出检查开关（有 RAW 时）
  - `P`：峰值对焦开关（非视频）
  - `Backspace` / `Delete`：打开移入回收站确认弹窗（仅本机）
  - `Esc`：关闭灯箱
  - *注意*：`keydown` 必须先检查焦点是否在 `INPUT` / `TEXTAREA` / `contentEditable` 内，避免输入时误触发快捷键。
- **删除确认弹窗（`#delModal` 打开时）**：
  - `D`：确认全部移入回收站（仅在 `#delModal` 显示期间生效，与灯箱正常浏览态互不冲突）
  - `Esc`：取消关闭弹窗

## 4. 关键避坑清单
- **高像素原图缩放黑块（A7R5 61MP `9504×6336`）**：禁止给灯箱 `<img>` 或 `#lbPeakCanvas` 加 `will-change: transform` 或常驻 `translate3d`；保持 `lightbox.js` 中 `lbSettleScale` 在缩放停稳后把实际倍率（`≤ 1`）固化到布局宽高。
- **缓存版本同步**：修改 `/api/rawdev` 或 `/api/sharpness` 输出算法后，务必同步递增前端请求里的 `&v=` 参数（及服务端缓存 key），防止浏览器命中旧的 24h 强缓存。
- **Windows 文件占用**：删除前必须先 `releaseFileHandles`，且 Windows 上 `sharp.cache({ files: 0 })` + 读入 Buffer 再喂 `sharp`，避免 `0x80270027` 文件被占用错误。
- **Windows PowerShell 5.1**：`.ps1` 文件与 `cache/server.log` 须使用 UTF-8 BOM；命令行避免使用 `&&` 与易被转义的复杂 `node -e`。
- **生效方式提示**：只改 `public/` 前端文件时无需重启服务（静态路由带 `no-cache`，刷新浏览器即生效）；改动 `server.js` 或 `lib/` 时提醒用户在系统托盘右键点「重启服务」。
- **沟通风格**：中文简洁回答，先给结论再列要点，所有文件引用使用可点击的 `file://` 链接；改动后务必做语法检查与实测验证。
