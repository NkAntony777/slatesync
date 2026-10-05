# Poly 导出方案：前端接入接口

本次改动不修改 `index.html` / `src/style.css` / `src/diagnostics-panel.js`，避免与前端 agent 冲突。

现有合并按钮无需改动，默认走 `resolve` 方案，勾选原有静音 LTC 选项时清洁方案会移除已确认的 LTC 技术通道。选择其他软件/通道的 UI 可通过以下接口接入，**目前未新增方案选择控件**。

## 控制器可选项

```js
const controller = createPolyCombineController({
  // 保持现有依赖参数
  getExportOptions: () => ({
    profile: "resolve", // resolve | sidus | pluraleyes | syncaila | archive
    // 通道 key = record.relativePath（或 name） + ":" + 0-based channelIndex
    // 不传 selection 则保留全部节目通道，不会自动删除 LR 混音或静音轨。
    selectedSourceChannels: new Set([
      "FOLDER01/ZOOM0001_Tr1.WAV:0",
      "FOLDER01/ZOOM0001_Tr2.WAV:0",
    ]),
    // excludedSourceChannels: new Set([...]),
    // 批量合并应使用成功 LTC 结果推导出的通道；不要靠 Tr6 文件名猜测。
    // ltcSourceChannels: new Set([...]),
    // 单 take 可另存 mono SyncRef，必须选择主 Poly 中保留的节目通道。
    // referenceSourceChannel: "FOLDER01/ZOOM0001_Tr1.WAV:0",
  }),
});

// 也可更新默认配置，或单次传参数：
controller.setExportOptions({ profile: "sidus" });
await controller.combinePolyFiles({ profile: "syncaila" });
```

- `controller.profiles` 提供选项标签与编码策略。
- `combinePolyFiles()` 返回结果数组，包括通道来源、排除原因、PCM24 削波/无效样本数。
- 指定通道 key 不存在时会拒绝，不会静默忽略拼写错误。
- 批量只输出某些通道时，每个 take 至少要有一个被选中的有效节目通道。
- Sidus 方案保留 LTC；Resolve/PluralEyes/Syncaila 清洁方案移除已确认的 LTC 通道。
- Archive 方案保留来源编码；原有静音选项会按旧规则静音，不物理移除。
- 输出 PCM24 不改变采样率；不会假装自动重采样。Float 超过 0 dBFS 会在转换统计里告警，应先降低增益或使用 Archive。

## 交付说明

批量选择输出目录时同时写入 `_合板说明.txt` 和 `_channels.json`。

单文件保存时浏览器下载 `_合板说明.txt`（文末含 JSON 通道清单）；浏览器可能拦截自动下载，静态指南在 `docs/声音合板指南.md`，输出不能因为 sidecar 下载失败被误报为未保存。

确认弹窗的 copy 已调整为“移除已确认 LTC”，请将原有勾选项 tooltip 中“合并 Poly 会静音”改为“清洁方案移除已确认 LTC”，不要再承诺所有方案都会静音。

## LTC 诊断

`ltcResults` 失败项增加 `failureCode` / `suggestion`，`statusText` 已是中文原因。成功项增加 `analysisGain` / `rawPeak`；报告 channelReports 也含分析增益，原始峰值/RMS 保留。

现有状态文案会显示低电平增益。`ltc-diagnostics.js` 已生成恢复低电平的 warning issue；无需在面板里重复计算或直接放大源素材。

## 必须避免的文案

- 不写“所有软件完美兼容”；Resolve 只完成本地合成素材实测，另外三个软件尚未实测。
- 不写“自动去除全部无用音轨”；静音、小电平、LR 与 ISO 不能代表没用。
- 不写“选择第 1 轨即可波形同步”；必须确定这轨录到与摄影机相同的现场声音。
- 不写“Poly 自动成为多条 Mono 轨”；Resolve 本机默认导入 Adaptive/Stereo，需要 Clip Attributes 的 Mono 映射。
