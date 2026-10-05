# LTC 解码算法路线

## 1. 适用范围与读者

本文记录 SlateSync 的 LTC 解码链路现状、本轮改动与实测收益、以及已知的结构性问题。

| 是 | 不是 |
|---|---|
| 解码器内部结构的维护者文档 | 用户使用指南（见 `README.md`） |
| 性能与调参入口的索引 | 兼容性认证或素材验收结论 |
| 已知缺陷与未决问题的记录 | 未来版本的承诺或路线承诺书 |

文中所有数字分三类标注：**实测**（Windows / Node 24.12.0，本机跑出来的）、**估算**（由实测数据推算）、**计划**（尚未实现）。没有实测支撑的结论不写成结论。

相关文档：数据层验收记录见 [`本次数据层升级验收.md`](本次数据层升级验收.md)，Poly 导出见 [`前端接入-Poly导出方案.md`](前端接入-Poly导出方案.md)。

## 2. 解码链路现状

主线程与 Worker 各持一份等价实现，本文行号默认指主线程 `src/ltc-decoder.js`，Worker 对应位置见第 5 节。

| 阶段 | 位置 | 说明 |
|---|---|---|
| 读取声道 | `src/ltc-decoder.js:111` | 最多取 60 s（`scanSeconds = 60`），整声道物化为 `Float32Array` |
| 高通 120 Hz | `src/ltc-decoder.js:152` | 一阶 RC，去除直流与低频隆隆声 |
| 分析增益 | `src/ltc-signal.js:51` | 仅作用于分析副本；数字静音/直流不放大；原始电平始终保留 |
| 快速否决 | `src/ltc-decoder.js:273` | 按滑动窗统计判定非周期性（对白、音乐、噪声） |
| 半位周期估计 | `src/ltc-decoder.js:327` | 中位数 + 18% 邻域内均值，输出 halfBitSamples / jitter / count |
| 帧率候选排序 | `src/ltc-decoder.js:364` | 用估计出的半位周期反推帧率并重排候选 |
| 逐变体逐窗扫描 | `src/ltc-decoder.js:979` | 3 个变体 × (4 s 窗 / 2 s 跳，`src/ltc-decoder.js:252`) |
| 迟滞过零沿 | `src/ltc-decoder.js:391` | 线性插值定位过零点，保留亚采样精度 |
| 边沿间隔 → bit | `src/ltc-decoder.js:419` | 一阶自适应半位跟踪；记录观测半位均值与抖动 |
| 候选选择 | `src/ltc-decoder.js:882` | 同步字锚定 + 连续帧递增串 + 置信度 |
| 软同步兜底 | `src/ltc-decoder.js:666` | 硬路径全灭且开启增强模式时启用，带 BCD 纠错 |
| 失败归因 | `src/ltc-signal.js:71` | 静音 / 低电平 / 非周期 / 未锁定，各自给建议 |
| 编排 | `src/ltc-controller.js:187` | 先 Worker 快扫，不达标再全量扫 |
| 诊断展示 | `src/ltc-diagnostics.js:107` | 逐声道判定与结构性问题提示 |

变体构成见 `src/ltc-decoder.js:212`：原始 + 两路调理（默认一路为 `interference` profile，带高通 600 Hz、低通 7000 Hz、tanh 驱动 1.2）。

## 3. 本轮改动与实测收益

版本 **1.5.0**（`package.json`、`bwf-timecode-sw.js:1` 的 `CACHE_NAME`）。这次提升是必须的：Service Worker 靠缓存名换版本，不 bump 的话 PWA 用户拿不到新解码器。

| # | 改动 | 位置 | 性质 |
|---|---|---|---|
| 1 | 同步字匹配重写为滚动 16 位整数键，对按位反转封闭的 Set 判成员；连续帧串只从真实同步锚点展开 | `src/ltc-decoder.js:19`、`:42`、`:56`、`:885` | 行为等价 |
| 2 | 与帧率无关的工作上提到 `prepareChannelAnalysis`，按声道算一次 | `src/ltc-decoder.js:972`、`:1095` | 行为等价 |
| 3 | 阈值统一到 `LTC_TUNING`，经 `JSON.stringify` 内联进 Worker | `src/ltc-signal.js:9`、`src/ltc-worker.js:5` | 行为等价 |
| 4 | 迟滞系数统一，估计器与解码器共用一组 | `src/ltc-signal.js:20` | 修正了 `halfBitError` 此前比的是两个不同门限 |
| 5 | 新增时钟漂移修正 | `src/ltc-decoder.js:78`、`:897` | **门控；仅在锁定位置靠后时生效，见 5.2** |
| 6 | 软同步兜底扩展到调理变体，不再只跑原始变体 | `src/ltc-decoder.js:1009` | 行为扩展 |

### 3.1 A/B 实测

基线 = git HEAD `a876403`，对工作区；同进程、同素材、Windows / Node 24.12.0，60 s / 48 kHz / 单声道。**实测**。

| 素材 | 基线 | 当前 | 加速 | 解码结果一致 |
|---|---|---|---|---|
| 干净 25 fps | 4761 ms | 2010 ms | 2.37x | 是 |
| 弱信号 25 fps | 3687 ms | 1204 ms | 3.06x | 是 |
| 对白（负样本） | 6585 ms | 1950 ms | 3.38x | 是 |
| 干净 23.976 | 598 ms | 649 ms | 0.92x | 是 |

23.976 一行是**持平**，不是提速。该行基线只有 598 ms，候选帧率先命中即早退（`src/ltc-decoder.js:998`），同步字匹配的成本本就没成为瓶颈，收益自然接近零且略负。结论只覆盖这 4 个合成素材与本机环境，不外推到所有素材。

### 3.2 改动前开销分布

60 s 素材、25 fps、单次解码约 1.4 s。**实测**。

| 环节 | 耗时 | 占总耗时 |
|---|---|---|
| `chooseCandidate` | 1010 ms | ~72% |
| `channelVariants` | 286 ms | ~20% |
| `readChannel` | 244 ms | ~17% |
| `findEdges` | 57 ms | ~4% |
| `decodeBits` | 29 ms | ~2% |

每 60 s 素材 `hasSync` 被调用 **1,474,476 次**——这正是第 1 项改动的靶子。改动 1 消掉了绝大多数调用，但 `hasSync` 本身没有删除：`src/ltc-decoder.js:797` 仍是字符串实现，仍被 `frameAt` 在每个已锚定的起点上再验一次（`src/ltc-decoder.js:822`），以及软路径 `src/ltc-decoder.js:591`。调用次数已从"每个 bit 偏移"降到"每个真实同步锚点"，量级不再是瓶颈。

## 4. 阈值与调参入口

调参只动 `src/ltc-signal.js:9` 的 `LTC_TUNING` 一个对象。Worker 模板用 `JSON.stringify(LTC_TUNING)` 内联（`src/ltc-worker.js:5`），两侧算术不会分叉。

| 组 | 控什么 | 调高 / 调低的效果 |
|---|---|---|
| `peakFloor` / `p2pFloor` | 值得一扫的最小信号电平 | 调高更省时，会漏掉更弱的 LTC |
| `edgeInterval*` | 非周期素材的滑动窗否决 | 调松放行对白/音乐，代价是扫描时间 |
| `hysteresis` | 过零沿迟滞，**估计器与解码器共用** | 调高更抗噪，弱信号边沿会漏检 |
| `minFps` / `maxFps`、`min/maxHalfScale` | 半位周期的合理范围 | 范围越宽候选越多、越慢 |
| `halfBitError` | 高/中质量档的半位误差门限 | 直接影响质量分级与早退 |
| `quality` | 高/中档的置信度、帧数、误码率 | 调高更保守，会增加扫描时间 |
| `soft` | 软同步纠错强度（容错 bit 数、BCD 代价） | 调大更宽松，可能接受假帧 |
| `analysis` | 分析增益上限与目标峰值 | 只影响分析副本，不改源文件 |

**本轮已收口**：控制器曾有一份自己的质量门限。`src/ltc-controller.js` 的 `isHighQualityFastLtc` 把 `3 / 6 / 0.0025 / 0.08 / 0.82` 全部写死，`isHighQualityCandidate` 也曾写死其中四项，只有一项读 `T.quality.highConfidence`——改 `LTC_TUNING.quality` 不会同步影响快扫早退。现已改为 `isHighQualityFastLtc` 直接委托 `decoder.isHighQualityCandidate`，两个副本合并为一处；`qualityFor` 的三个 rank 也一并改读 `T.quality.*`。

## 5. 已知结构性问题

### 5.1 Worker 手工复制（最高优先级）

`src/ltc-worker.js:3` 的 `LTC_WORKER_CODE` 模板字符串里手抄了整套解码器，并把 `timecode.js` 的 BigInt/分数助手与 `wave-audio.js` 的采样读取内联重写（`parseFps:63`、`fpsRate:85`、`timecodeToFrames:93`、`framesToSamples:102`、`normalizeTimeReference:105`、`frameDigitsFor:110`、`timecodeSeparator:111`、`readAudioSample:112`）。

代价是每次改解码逻辑都要改两处，只改一处就产生主线程与 Worker 行为分叉——本轮第 4 项改动（迟滞系数）在这之前正是这样漂移的。`LTC_TUNING` 已用内联解决，但算法主体没有防漂移手段。

### 5.2 时钟漂移：门控机制，只在特定条件下生效

这是本文最需要说清楚的一项。

| 项 | 值 | 位置 |
|---|---|---|
| 最少半位观测数 | 20,000（约 125 帧） | `src/ltc-decoder.js:81` |
| 触发修正的最小位移 | 0.25 帧 | `src/ltc-decoder.js:83` |
| 死区 / 上限 | 500 ppm / 10000 ppm | `src/ltc-decoder.js:79`、`:80` |

**实测证据表明它在实际素材上不动作**：

| 场景 | `driftPpm` | 终点时码误差（采样） | 结论 |
|---|---|---|---|
| 30 分钟素材，0 / 100 / 500 / -200 ppm | 0 | 不修正时本就 0.00–0.01 帧 | 无事可做，正确地不动作 |
| LTC 从第 15 分钟才出现 | 0 | — | 前段静音无时钟参考，够不到 20,000 次观测 |
| **均匀时钟偏移 2000 ppm + 头部信号丢失** | **-1895** | **未修正 2070 → 修正后 110（0.057 帧）** | **生效，误差降约 19 倍** |
| 均匀时钟偏移 3000 ppm，首窗即高质量锁定（第 81 帧） | 0 | 468（0.24 帧） | 无基线，保持亚帧 |

**触发条件**：解码器命中第一个高质量锁定就早退（`src/ltc-decoder.js:998`）。锁定若发生在开头一两秒，观测数远达不到 20,000，机制不动作——这是正确的，误差本来就小。真正需要修正的是**锁定位置很靠后**的情形，而那要求扫描继续深入：例如素材头部存在信号丢失（断续、干扰），`consecutiveRun` 无法凑满 12 帧连续串，扫描不会早退，跟踪器因而持续累积观测。`test/ltc-drift.test.mjs` 构造的正是这一类素材。

**定性**：这是一个**安全门控机制**。边沿定位本身带 ±0.5 采样量化误差，若无第二道门限，它会把 20 个采样量级的编码器舍入噪声"修正"成真实误差（开发过程中确实发生过一次 21 采样的误修正）。两道门限——累积观测数 ≥ 20,000、且修正量 > 0.25 帧——保证**无漂移素材的输出与未修正算法逐位一致**，这一点由测试固定。

**仍未覆盖**：上面的生效证据来自**合成的均匀时钟偏移**。真实录音机的偏移来源更复杂（晶振温漂导致的非线性变化、时码器与录音机之间的双端偏差），且未在真实素材上验证。因此本文不把漂移修正计入常规解码精度，只在锁定位置靠后且素材头部不干净时视为有效。

**真要做，需要付出什么**：

| 方案 | 代价 |
|---|---|
| 推迟锁定，直到积累足够长的基线 | 直接与"尽早返回结果"冲突；快扫 5 s 的低延迟体验会崩 |
| 全程跟踪的 PLL / 逐窗更新标称半位 | 改动 `decodeBits` 与候选评分的状态模型；阈值需重新标定，行为变更需重新验收 |
| 改为"锁定后按扫描位置外推"的线性模型 | 仍需足够观测；只能覆盖线性漂移，对温度引起的非线性变化无效 |

在真实素材上验证之前，本文档不把漂移修正计入常规解码精度；它只在第 5.2 节列出的条件下作为有效补偿。

### 5.3 内存随文件长度增长

| 路径 | 行为 | 位置 |
|---|---|---|
| Worker 全量扫描（**生产主路径**） | `scanSeconds` 为 `null` 时按 `record.durationSamples` 读**整个文件**进 `ArrayBuffer` 并 transfer | `src/ltc-controller.js:90`、`:95`、`:180` |
| Worker 侧 `readChannel` | 把整个 buffer 物化为 `Float32Array` | `src/ltc-worker.js:128`、`:133` |
| 主线程回退路径 | 每声道最多 60 s | `src/ltc-decoder.js:111`、`:113` |

即：快扫 5 s（`src/ltc-controller.js:173`）不达标就整文件读入内存。48 kHz / 24-bit / 双声道素材每分钟约 17 MB（**估算**，按 `sampleRate × blockAlign × 60` 计算），再加上 `readChannel` 之后高通副本、`normalizeLtcAnalysisSignal` 的增益副本、以及 `channelVariants` 各自的高通/低通/tanh 副本，同一时刻会有数份整声道 `Float32Array` 并存。超长素材与 RF64 属于内存受限场景，**尚未实测**。

### 5.4 解码耗时不是文件长度的单调函数

耗时由"找到第一个高质量锁定"决定（`src/ltc-decoder.js:998` 早退），而质量档门限（`src/ltc-decoder.js:850`）与早退耦合：LTC 在文件开头时几秒内结束；LTC 出现在很晚、或始终拿不到高质量锁定时，要扫完整个扫描区。所以"60 s 素材"与"3 小时素材"不能按长度外推耗时。

## 6. 后续路线

| 优先级 | 事项 | 为什么 | 风险 | 如何验证 |
|---|---|---|---|---|
| P0 | 构建期由共享模块生成 Worker 主体，消灭手工复制 | 第 5.1 节；本轮已出现过的分叉就是征兆 | 大重构，不应与行为变更混在一次提交里 | 现有 26 项回归全绿 + 新增"主线程与 Worker 对同一素材输出逐字段一致"的一致性测试 |
| ~~P1~~ | ~~收敛控制器里残留的硬编码质量门限到 `LTC_TUNING`~~ **已完成** | 本轮实测发现：改 `LTC_TUNING.quality` 原本不影响快扫早退 | 已收口：`isHighQualityFastLtc` 委托 `decoder.isHighQualityCandidate` | 已验证：26 项回归 + 26 项集成检查全绿 |
| P1 | 在**真实录音机**上验证漂移修正，并把触发条件暴露给用户 | 第 5.2 节；合成素材已证明生效（2070→110 采样），真实晶振温漂是非线性的 | 中：不改算法，但要真实素材与温漂样本 | 真实录音机长素材对比修正前后终点时码；诊断面板显示 `driftPpm` 与是否已修正 |
| P2 | 分块/流式扫描，降全量扫描的内存占用 | 第 5.3 节 | 中；跨块边沿与窗边界会引入新错误模式 | 大文件内存峰值对比 + 解码结果与整读路径逐字段一致 |
| P2 | 残余 `hasSync` 改为整数键判定 | 第 3.2 节；当前已非瓶颈 | 低 | 基准不回退 |
| P3 | 逐帧标注边沿质量，支撑人工复核 UI | 目前置信度是标量 | 低 | 诊断面板展示可读 |

P0 刻意推迟：它体量大，且应该单独一轮、单独验收，避免和行为变更捆绑后无法判断是谁引入的回退。

## 7. 验证方法与门禁

| 命令 | 实测结果（Windows / Node 24.12.0） |
|---|---|
| `node --test test/ltc-low-level.test.mjs test/poly-compatibility.test.mjs` | 26 通过 / 0 失败 |
| `node test/run-tests.mjs` | 26 项检查通过 |

性能基线来自 A/B 对比：同进程、同素材，基线取 git HEAD `a876403`，对比当前工作区，素材为 60 s / 48 kHz / 单声道，涵盖干净 25 fps、弱信号 25 fps、对白负样本、干净 23.976。**这一组数字已测得并记录在第 3.1 节，不需要每次提交重跑。**

CI（`.github/workflows/ci.yml`）：

| 位置 | 内容 |
|---|---|
| `.github/workflows/ci.yml:26` | `node --test`，含 `ltc-low-level` / `poly-compatibility` / `ltc-parity` / `ltc-performance` / `ltc-drift` |
| `.github/workflows/ci.yml:28` | `node test/run-tests.mjs` |
| `.github/workflows/ci.yml:30` | 手工 `workflow_dispatch` + `run_bench` 开关，跑 `node test/bench-ltc.mjs` |

基准不进每次 CI：单次要分钟级。只在 `workflow_dispatch` 且勾选 `run_bench` 时运行。`ltc-parity` / `ltc-performance` / `ltc-drift` 与基准脚本均为本轮新增。

**未覆盖**：所有真实拍摄素材、所有设备、全部帧率、真实 >4 GB RF64、长素材漂移的最终结论，以及 Sidus / PluralEyes / Syncaila 的软件端往返。不要把上述任何一项写成"完美兼容"或"所有素材已验证"。

## 8. 不可解边界

分析增益不是万能的。以下情况无论怎么调参都恢复不了：

| 情况 | 为什么不可解 | 现有行为 |
|---|---|---|
| 信号已被量化到零 | 位深阶段信息已丢失，后级无中生有 | 归类 `silent`，`src/ltc-signal.js:76` |
| LTC 被噪声完全淹没 | 边沿位置已不可辨，调阈值只是放大噪声 | 归类 `low-level`，`src/ltc-signal.js:77` |
| 硬削波 | 削平后波形与正弦的边沿对称性被破坏，同步字判据失效 | 统计 `clippedRatio`（`src/ltc-decoder.js:131`）并在诊断中提示 |
| 断续/中断的 LTC | 连续帧递增串建立不起来 | 归类 `not-periodic`，`src/ltc-signal.js:79` |
| 帧率与 DF/NDF 不符 | 帧号语义不符，`strictDrop` 直接拒绝 | 允许放宽重试并标 `dropMismatch`（`src/ltc-decoder.js:1103`） |

这些是信息层面的缺失，不是算力或调参问题。`src/ltc-signal.js:71` 的失败归因存在的意义就是把它们区分开，让用户拿到可执行的建议，而不是一个笼统的"未检测到"。
