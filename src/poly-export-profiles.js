// A preset is a file/workflow policy, not a claim of vendor certification.
export const POLY_EXPORT_PROFILES = Object.freeze({
  resolve: Object.freeze({ id: "resolve", label: "DaVinci Resolve", encoding: "pcm24", ltcPolicy: "exclude", reference: false }),
  sidus: Object.freeze({ id: "sidus", label: "Sidus TC Sync", encoding: "pcm24", ltcPolicy: "retain", reference: false }),
  pluraleyes: Object.freeze({ id: "pluraleyes", label: "PluralEyes", encoding: "pcm24", ltcPolicy: "exclude", reference: true }),
  syncaila: Object.freeze({ id: "syncaila", label: "Syncaila", encoding: "pcm24", ltcPolicy: "exclude", reference: true }),
  archive: Object.freeze({ id: "archive", label: "保留原始编码", encoding: "source", ltcPolicy: "retain", reference: false }),
});

// 界面文案。用途和 LTC 策略抄自 docs/声音合板指南.md 的方案表，
// 目的是让用户在点"合并"之前就知道这个方案会把 LTC 通道怎么处理——
// 文件名里的 Tr6 之类只是命名线索，真正决定"是不是 LTC"的是检测结果。
export const POLY_PROFILE_HINTS = Object.freeze({
  resolve: Object.freeze({
    usage: "DaVinci Resolve 清洁节目 Poly",
    ltcText: "排除已确认的 LTC 通道",
    encodingText: "多通道离散 PCM24",
  }),
  sidus: Object.freeze({
    usage: "Sidus TC Sync：还需要 LTC 继续读时码",
    ltcText: "保留 LTC 技术通道",
    encodingText: "多通道离散 PCM24",
  }),
  pluraleyes: Object.freeze({
    usage: "PluralEyes：主 Poly + 独立 SyncRef 做波形比较",
    ltcText: "默认排除 LTC",
    encodingText: "多通道离散 PCM24",
  }),
  syncaila: Object.freeze({
    usage: "Syncaila：主 Poly + 独立 SyncRef / XML 交付",
    ltcText: "默认排除 LTC",
    encodingText: "多通道离散 PCM24",
  }),
  archive: Object.freeze({
    usage: "归档：保留来源编码的副本",
    ltcText: "保留 LTC 通道（勾选静音 LTC 轨时会在新文件里静音）",
    encodingText: "保留源编码",
  }),
});

export function polyExportProfile(value = "resolve") {
  const profile = POLY_EXPORT_PROFILES[value];
  if (!profile) throw new Error(`未知 Poly 导出方案：${value}`);
  return profile;
}

/**
 * 给 UI 用的方案列表：profile 本身的字段 + 中文用途/LTC 策略文案。
 * ltcPolicyText 是"这个方案对 LTC 做什么"的一句话说明，不是检测结果；
 * 某个具体通道到底是不是 LTC，仍由 ltcResults 的检测结论决定。
 */
export function polyProfileOptions() {
  return Object.values(POLY_EXPORT_PROFILES).map(profile => ({
    ...profile,
    ...(POLY_PROFILE_HINTS[profile.id] || { usage: "", ltcText: "", encodingText: profile.encoding }),
  }));
}

export function sourceTrackKey(track) {
  return `${track.record.relativePath || track.record.name}:${track.channelIndex}`;
}

export function applyPolyExportPolicy(tracks, options = {}) {
  const profile = polyExportProfile(options.profile || "resolve");
  const ltcChannels = options.ltcSourceChannels || options.mutedSourceChannels || new Set();
  const explicitExclusions = options.excludedSourceChannels || new Set();
  const selected = options.selectedSourceChannels;
  if (selected && !selected.size) throw new Error("没有选择输出音轨");
  const known = new Set(tracks.map(sourceTrackKey));
  for (const key of [...(selected || []), ...explicitExclusions]) {
    if (!known.has(key)) throw new Error(`输出通道不存在：${key}`);
  }
  const excluded = [], kept = [];
  for (const track of tracks) {
    const key = sourceTrackKey(track);
    let reason = explicitExclusions.has(key) ? "用户排除" : selected && !selected.has(key) ? "未选择" : "";
    if (!reason && profile.ltcPolicy === "exclude" && ltcChannels.has(key)) reason = "已确认的 LTC 通道";
    if (reason) excluded.push({ ...track, reason });
    else kept.push({ ...track, sourceChannelIndexValue: track.channelIndexValue, channelIndexValue: kept.length + 1 });
  }
  if (!kept.length) throw new Error("移除 LTC/未选音轨后没有可用的节目音频；请选择有效对白音轨或保留 LTC 方案");
  return { profile, tracks: kept, excluded, ltcChannels };
}
