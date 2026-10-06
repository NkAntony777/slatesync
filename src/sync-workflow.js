import { polyExportProfile } from "./poly-export-profiles.js";
import { renderAcceptanceChecklistText } from "./acceptance-checklist.js";

// 合板说明 sidecar 的最终文本。
//
// 既有正文（syncWorkflowText）+ 交付验收清单（acceptance-checklist.js）用 "\r\n" 连接：
// 两个模块各自 join("\r\n")，所以这里必须显式补一个分隔，不能靠数组 join。
// 验收清单不是可选装饰——它把 docs/声音合板指南.md 的交付检查清单变成可勾选的东西，
// 工具只判定文件层事实，"目标软件里还要做什么" 全靠它。
//
// BOM：调用方负责在整篇文本最前面放 \uFEFF（记事本读 UTF-8 中文需要）。
// 这里不给清单再加一次，否则文件中段会出现一个 U+FEFF 字符。
export function syncGuideText(result, options = {}) {
  const base = syncWorkflowText(result, options);
  const checklist = options.checklist || null;
  if (!checklist) return base;
  const text = renderAcceptanceChecklistText(checklist);
  return text ? `${base}\r\n${text}` : base;
}

export function syncWorkflowText(result, options = {}) {
  const profile = polyExportProfile(result.profile || options.profile || "resolve");
  const lines = [
    "Audio TC Change — 声音合板交付说明", "",
    `方案：${profile.label}（文件策略，不代表厂商认证）`,
    `文件：${result.name}`, `音频：${result.sampleRate} Hz / ${result.bitsPerSample} bit / ${result.channels} 通道`,
    `长度：${result.durationSamples} samples`, `起始时间码：${options.startTimecode || "以文件 bext/iXML TimeReference 为准"}`,
    `帧率：${options.fpsValue || "导入前核对摄影机及录音帧率，不能仅看项目帧率"}`, "",
    "【输出通道映射】",
    ...result.tracks.map(track => `${track.outputChannel}. ${track.name} ← ${track.source} / 源通道 ${track.sourceChannel}`),
    "", "【排除通道】",
    ...(result.excludedTracks.length ? result.excludedTracks.map(track => `${track.source} / 源通道 ${track.sourceChannel}：${track.reason}`) : ["无；未自动删除静音、小电平、L/R 混音或独立麦克风轨"]),
    "", "【多余音轨的三个不同来源】",
    "1. LTC 技术轨：清洁方案只移除已确认的 LTC 通道，不把空通道留在 Poly 内。未做 LTC 检测时不能靠文件名猜测。",
    "2. 录音机 L/R 混音与独立麦克风 ISO：可能是相同声音的不同版本，不等于文件损坏；不要全部同时叠加播放。需要裁减时显式选择输出通道。",
    "3. 摄影机原始音轨：Resolve 勾选 Retain embedded audio 会额外保留这些轨，不能靠改 WAV 删除摄影机音轨。", "",
    "【DaVinci Resolve 20 合板方案】",
    "1. 新建测试项目并先备份源素材；设置与摄影机一致的时间线帧率，确认 23.976/24、29.97/30 及 DF/NDF 不混淆。",
    "2. 仅导入匹配的视频和此 Poly；不要同时导入同一 take 的原始分轨、旧 Poly 和 SyncRef 作为待合板音频。",
    "3. 多通道在本机默认导入为 Adaptive，2ch 为 Stereo，不能假设会自动分成 Mono。检查 Clip Attributes > Audio：节目轨按 Mono 离散映射，通道 1→1、2→2…；不要把麦克风通道误设为 5.1/7.1。",
    "4. 时码可靠时，选视频和 Poly > Auto Sync Audio > Synchronize Using: Timecode。",
    "5. 不需要摄影机参考声时关闭 Retain embedded audio；需要保留时打开，但接受额外摄影机轨。按需求保留视频元数据。",
    "6. 无可信共同时码时选择 Waveform，Comparison channel 选择有对白/拍板声的节目轨；绝不要选择 LTC 或静音轨。",
    "7. 波形同步要求摄影机有相同现场声音。仅有 LTC、静音或不同现场声无法保证波形自动同步。",
    "8. 成功同步后再剪入时间线，逐条试听需要的麦克风，检查开头拍板、中段和末尾是否漂移；不要同时播放 L/R 与全部 ISO。",
    "9. 单点能对上、末尾对不上属于时钟/帧率/漂移问题；单个 TimeReference 偏移不能修复持续漂移。", "",
  ];
  if (profile.id === "sidus") lines.push(
    "【Sidus TC Sync】",
    "本方案保留 LTC 音频用于时码读取，不把 LTC 当节目声。先让时码工具读取正确声道，再将成功结果制作成 Resolve 清洁 Poly。",
    "Sidus 的具体版本、许可与输入格式尚未实测；不能把 BWF 元数据导入能力等同于 LTC 音轨解码能力。", "",
  );
  if (profile.reference) lines.push(
    `【${profile.label} 波形合板】`,
    "主 Poly 是制作母版；显式选择有现场共同声音的通道生成独立 mono SyncRef，用于低通道数波形比较。",
    "SyncRef 是辅助文件，不是新增的制作轨。不得把 SyncRef 与同一 take 的主 Poly 都当成独立录音一起合板。",
    "XML 往返必须保持母版文件路径/通道对应关系；先做单 take 试验再批量。参考文件不能自动替代软件里的母版关联。",
    "Syncaila 的目标工作流是从剪辑软件导出 XML/FCPXML、同步并返回 XML，再回到剪辑软件，不是任意 WAV 直接导入即完成合板。",
    "PluralEyes/Sidus/Syncaila 尚未在本机实测；独立参考轨与 PCM24 只降低格式和信号选择风险，不承诺软件兼容认证。", "",
  );
  if (options.referenceName) lines.push(`辅助参考：${options.referenceName}；比较声道：${options.referenceChannel || "见通道映射"}`, "");
  if (result.clippedSamples || result.invalidSamples) lines.push(
    `【需复核】转 PCM24 出现 ${result.clippedSamples} 个超范围样本、${result.invalidSamples} 个非有限样本。`,
    "源文件未被修改；32-bit float 超过 0 dBFS 时转定点会削波，先调低增益或使用 archive 原始编码方案。", "",
  );
  lines.push(
    "【验证范围】",
    "本工具可检查 WAV chunk、通道数、iXML、时码一致性及通道样本；这不等于目标软件端实测。",
    "Resolve 20.3.3.10 本地手册第 21 章（PDF 第 445–453 页）是此操作说明依据。",
    "2026-10-05 已完成 Resolve 本地合成素材导入与时码/波形同步验证；报告 test/artifacts/resolve/resolve-report.json。真实素材仍需逐 take 验收。",
    "合板验收：通道映射正确、无 LTC 噪声、无意外参考轨、起始/中段/结束同步、无持续漂移。", "",
  );
  return lines.join("\r\n");
}

export function syncPackageManifest(result, options = {}) {
  return { schema: "audio-tc-sync-package/v1", generatedAt: new Date().toISOString(),
    ...result, durationSamples: String(result.durationSamples),
    fpsValue: options.fpsValue || null, startTimecode: options.startTimecode || null,
    referenceName: options.referenceName || null, validation: "format-tested; application verification required" };
}
