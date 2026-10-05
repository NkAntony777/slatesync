// A preset is a file/workflow policy, not a claim of vendor certification.
export const POLY_EXPORT_PROFILES = Object.freeze({
  resolve: Object.freeze({ id: "resolve", label: "DaVinci Resolve", encoding: "pcm24", ltcPolicy: "exclude", reference: false }),
  sidus: Object.freeze({ id: "sidus", label: "Sidus TC Sync", encoding: "pcm24", ltcPolicy: "retain", reference: false }),
  pluraleyes: Object.freeze({ id: "pluraleyes", label: "PluralEyes", encoding: "pcm24", ltcPolicy: "exclude", reference: true }),
  syncaila: Object.freeze({ id: "syncaila", label: "Syncaila", encoding: "pcm24", ltcPolicy: "exclude", reference: true }),
  archive: Object.freeze({ id: "archive", label: "保留原始编码", encoding: "source", ltcPolicy: "retain", reference: false }),
});

export function polyExportProfile(value = "resolve") {
  const profile = POLY_EXPORT_PROFILES[value];
  if (!profile) throw new Error(`未知 Poly 导出方案：${value}`);
  return profile;
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
