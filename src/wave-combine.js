import { LITTLE, ds64ChunkData, isIeeeFloat, readDataView, waveFileHeader } from "./wave.js";
import { readAudioSample, writeSilenceSample } from "./wave-audio.js";
import { applyPolyExportPolicy, sourceTrackKey } from "./poly-export-profiles.js";
import { parseFps } from "./timecode.js";
import {
  combineSortValue,
  genericTrackNumber,
  isZoomLrFile,
  recordKey,
  recordLabel,
  shortGroupLabel,
  zoomTrackNumbers,
} from "./grouping.js";
import {
  chunkHeader,
  ixmlTimestampParts,
  writeAsciiFixed,
  writeAsciiPadded,
  writeAsciiPaddedMultiline,
} from "./wave-time-reference.js";
import { equalPowerGains, planCrossfadeRegions, toneSampleAt } from "./room-tone.js";
import {
  BEXT_LOUDNESS_ABSENT,
  applyLoudnessToBext,
  axmlLoudnessText,
  createChannelLoudnessMeter,
  loudnessToBextFields,
} from "./loudness.js";

export function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function trackNameForSource(record, channelIndex) {
  if (isZoomLrFile(record)) return channelIndex === 0 ? "TrL" : "TrR";
  const tracks = zoomTrackNumbers(record);
  const track = tracks[channelIndex] ?? tracks[0];
  if (track !== undefined) return `Tr${track}`;
  return record.channels === 1 ? record.name.replace(/\.[^.]+$/, "") : `A${channelIndex + 1}`;
}

export function sourceChannelIndex(record, channelIndex) {
  if (isZoomLrFile(record)) return channelIndex + 1;
  const tracks = zoomTrackNumbers(record);
  const track = tracks[channelIndex] ?? tracks[0];
  if (track !== undefined) return track + 2;
  // 单声道分轨此前一律返回 1，iXML 里所有通道号都一样。通用序号让它落到真实轨道号上。
  const generic = genericTrackNumber(record);
  if (generic !== null) return generic;
  return channelIndex + 1;
}

export function combineTrackPlan(groupRecords) {
  const sorted = [...groupRecords].sort((a, b) => {
    const value = combineSortValue(a) - combineSortValue(b);
    if (value) return value;
    return recordLabel(a).localeCompare(recordLabel(b));
  });
  const tracks = [];
  for (const record of sorted) {
    for (let channelIndex = 0; channelIndex < record.channels; channelIndex++) {
      tracks.push({
        record,
        channelIndex,
        channelName: trackNameForSource(record, channelIndex),
        channelIndexValue: sourceChannelIndex(record, channelIndex),
      });
    }
  }
  return tracks;
}

export function validateCombineGroup(groupRecords, options = {}) {
  const groupLabel = options.groupLabel || recordLabel;
  if (!groupRecords.length) throw new Error("没有可合并的分轨文件");
  const first = groupRecords[0];
  if (![1, 3, 65534].includes(first.audioFormat)) throw new Error("Poly 只支持 PCM/IEEE Float 音频");
  if (!first.sampleRate || first.blockAlign <= 0 || first.durationSamples <= 0n) throw new Error("音频采样率、块对齐或时长无效");
  for (const record of groupRecords) {
    if (record.audioFormat !== first.audioFormat) throw new Error(`${recordLabel(record)}: 音频格式和其他分轨不同`);
    if (record.sampleRate !== first.sampleRate) throw new Error(`${recordLabel(record)}: 采样率和其他分轨不同`);
    if (record.bitsPerSample !== first.bitsPerSample) throw new Error(`${recordLabel(record)}: 位深和其他分轨不同`);
    if (record.oldTimeReference !== first.oldTimeReference) throw new Error(`${recordLabel(record)}: 起始 TimeReference 和其他分轨不同`);
  }
  const durations = groupRecords.map(record => record.durationSamples);
  const minDuration = durations.reduce((min, value) => value < min ? value : min, durations[0]);
  const maxDuration = durations.reduce((max, value) => value > max ? value : max, durations[0]);
  // "分轨时长不同"本来是硬拦：合板要求逐样本对齐，长度不一致没法直接交错写。
  // 但调用方显式开了对齐/纠错并指定参考轨时，时长不一致正是要修的东西，
  // 这时输出长度取参考轨，其余轨按各自的修正计划对齐进来（缺失的部分补静音）。
  // 没指定参考轨就仍按原规矩拒绝——以哪条轨为准是人的决定，这里绝不替用户挑一条最长的。
  const repairFrames = repairOutputFrames(groupRecords, options);
  if (maxDuration !== minDuration && repairFrames === null) throw new Error(`${groupLabel(first)}: 分轨时长不同，暂不自动裁切或补静音`);
  const durationSamples = repairFrames === null ? minDuration : BigInt(repairFrames);
  const allTracks = combineTrackPlan(groupRecords);
  const policy = applyPolyExportPolicy(allTracks, options);
  const tracks = policy.tracks;
  const sourceBytesPerSample = first.bitsPerSample / 8;
  const encoding = options.encoding || policy.profile.encoding;
  if (!new Set(["source", "pcm24"]).has(encoding)) throw new Error(`不支持的输出编码：${encoding}`);
  const outputRecord = encoding === "pcm24"
    ? { ...first, audioFormat: 1, fmtTag: 1, isFloat: false, bitsPerSample: 24 }
    : first;
  const bytesPerSample = outputRecord.bitsPerSample / 8;
  if (!Number.isInteger(sourceBytesPerSample) || !Number.isInteger(bytesPerSample)) throw new Error(`${groupLabel(first)}: 不支持 ${first.bitsPerSample} bit 合并`);
  const blockAlign = tracks.length * bytesPerSample;
  const dataSize = Number(durationSamples) * blockAlign;
  if (!Number.isSafeInteger(dataSize)) throw new Error(`${groupLabel(first)}: 合并后的 data 过大`);
  if (tracks.length > 65535 || blockAlign > 65535 || first.sampleRate * blockAlign > 0xffffffff) throw new Error("输出 WAV 通道数/字节率超出格式上限");
  return { first, outputRecord, tracks, excludedTracks: policy.excluded, profile: policy.profile, encoding, sourceBytesPerSample, bytesPerSample, blockAlign, durationSamples, dataSize, clippedSamples: 0, invalidSamples: 0 };
}

export function ixmlFieldValue(record, tag) {
  return record.ixmlInfo?.fields?.[tag]?.value || "";
}

export function commonValue(recordsToCheck, getter) {
  const values = recordsToCheck
    .map(getter)
    .filter(value => value !== null && value !== undefined && value !== "");
  if (!values.length) return "";
  return values.every(value => value === values[0]) ? values[0] : "";
}

export function commonValueState(recordsToCheck, getter) {
  const values = recordsToCheck
    .map(getter)
    .filter(value => value !== null && value !== undefined && value !== "");
  if (!values.length) return { value: "", hasValues: false, conflict: false };
  const value = values[0];
  return {
    value: values.every(item => item === value) ? value : "",
    hasValues: true,
    conflict: !values.every(item => item === value),
  };
}

export function ixmlFpsMetadataForValue(value) {
  if (!value) return { timecodeRate: "", timecodeFlag: "" };
  const fps = parseFps(value);
  const rate = fps.rate || fps;
  return {
    timecodeRate: `${rate.n}/${rate.d}`,
    timecodeFlag: fps.drop ? "DF" : "NDF",
  };
}

export function combineBextDescription(sourceInfo, tracks) {
  const lines = ["zNOTE=Combined by Audio TC Change"];
  if (sourceInfo.scene) lines.unshift(`zSCENE=${sourceInfo.scene}`);
  if (sourceInfo.take) lines.splice(sourceInfo.scene ? 1 : 0, 0, `zTAKE=${sourceInfo.take}`);
  for (const track of tracks) {
    lines.push(`zTRK${track.channelIndexValue}=${track.channelName}`);
  }
  return lines.join("\r\n");
}

export function combineSourceInfo(groupRecords, options = {}) {
  const chosenFpsValues = [...new Set(groupRecords.map(record => record._combineFpsValue).filter(Boolean))];
  if (chosenFpsValues.length > 1) throw new Error("同一 take 的输出时码帧率不一致，不能合并");
  const chosenFps = chosenFpsValues.length ? ixmlFpsMetadataForValue(chosenFpsValues[0]) : null;
  const timecodeRate = commonValueState(groupRecords, record => record.ixmlInfo?.timecodeRate?.value || "");
  const timecodeFlag = commonValueState(groupRecords, record => record.ixmlInfo?.timecodeFlag?.value || "");
  const fallbackFps = !timecodeRate.hasValues && !timecodeRate.conflict
    ? ixmlFpsMetadataForValue(options.fallbackFpsValue)
    : null;
  return {
    project: commonValue(groupRecords, record => ixmlFieldValue(record, "PROJECT")),
    scene: commonValue(groupRecords, record => ixmlFieldValue(record, "SCENE")),
    take: commonValue(groupRecords, record => ixmlFieldValue(record, "TAKE")),
    tape: commonValue(groupRecords, record => ixmlFieldValue(record, "TAPE")),
    timecodeRate: chosenFps?.timecodeRate || timecodeRate.value || fallbackFps?.timecodeRate || "",
    timecodeFlag: chosenFps?.timecodeFlag || (timecodeRate.conflict ? "" : timecodeFlag.value || fallbackFps?.timecodeFlag || ""),
    originationDate: commonValue(groupRecords, record => record.bextInfo?.originationDate || ""),
    originationTime: commonValue(groupRecords, record => record.bextInfo?.originationTime || ""),
  };
}

export function bextChunkDataForCombine(baseRecord, sourceInfo, tracks) {
  const data = new Uint8Array(858);
  const view = new DataView(data.buffer);
  writeAsciiPaddedMultiline(data, 0, 256, combineBextDescription(sourceInfo, tracks));
  writeAsciiPadded(data, 256, 32, "Audio TC Change");
  writeAsciiPadded(data, 288, 32, "AudioTCChangeCombine");
  writeAsciiFixed(data, 320, 10, sourceInfo.originationDate);
  writeAsciiFixed(data, 330, 8, sourceInfo.originationTime);
  view.setBigUint64(338, baseRecord.oldTimeReference, LITTLE);
  // version 2：多了五个响度字段（EBU Tech 3285）。
  // UMID（348–411）留全零：本工具不生产实体标识，凭空造一个比不填更糟。
  view.setUint16(346, 2, LITTLE);
  // 响度字段先写"没测"（0x8000），量完再回填。
  view.setInt16(412, BEXT_LOUDNESS_ABSENT, true);
  view.setUint16(414, 0, true);
  view.setInt16(416, BEXT_LOUDNESS_ABSENT, true);
  view.setInt16(418, BEXT_LOUDNESS_ABSENT, true);
  view.setInt16(420, BEXT_LOUDNESS_ABSENT, true);
  return data;
}

/**
 * chna chunk（EBU Tech 3285 补充件 / BW64 的通道分配）。
 *
 * Poly WAV 的全部价值是"第 N 通道就是第 N 支麦克风"，而这个信息原本只存在于
 * iXML 的 TRACK_LIST 里——那是旧世界的写法。chna 是它的现代等价物，
 * Resolve、Pro Tools 以及所有按 BW64 读 ADM 的工具都认。
 *
 * 离散分轨没有对应的标准扬声器位置，speaker label 用 0xFFFF（未定义），
 * 真正的身份放在轨道名里。
 */
export function chnaChunkDataForCombine(tracks) {
  const data = new Uint8Array(2 + tracks.length * 80);
  const view = new DataView(data.buffer);
  view.setUint16(0, tracks.length, LITTLE);
  tracks.forEach((track, index) => {
    const base = 2 + index * 80;
    view.setUint16(base, index + 1, LITTLE);   // 轨道号（1 起）
    view.setUint16(base + 2, 0xffff, LITTLE);   // 扬声器标签：未定义（离散分轨）
    writeAsciiFixed(data, base + 4, 12, "");    // 扬声器标签的 ASCII 名
    writeAsciiFixed(data, base + 16, 64, track.channelName ?? "");
  });
  return data;
}

export function ixmlOptionalLine(tag, value) {
  return value ? `\t<${tag}>${xmlEscape(value)}</${tag}>` : null;
}

export function ixmlTextForCombine(baseRecord, sourceInfo, tracks) {
  const parts = ixmlTimestampParts(baseRecord.oldTimeReference);
  const trackXml = tracks.map((track, index) => [
    "\t\t<TRACK>",
    `\t\t\t<CHANNEL_INDEX>${track.channelIndexValue}</CHANNEL_INDEX>`,
    `\t\t\t<INTERLEAVE_INDEX>${index + 1}</INTERLEAVE_INDEX>`,
    `\t\t\t<NAME>${xmlEscape(track.channelName)}</NAME>`,
    "\t\t</TRACK>",
  ].join("\r\n")).join("\r\n");
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<BWFXML>",
    "\t<IXML_VERSION>1.5</IXML_VERSION>",
    ixmlOptionalLine("PROJECT", sourceInfo.project),
    ixmlOptionalLine("SCENE", sourceInfo.scene),
    ixmlOptionalLine("TAKE", sourceInfo.take),
    ixmlOptionalLine("TAPE", sourceInfo.tape),
    "\t<SPEED>",
    sourceInfo.timecodeRate ? `\t\t<TIMECODE_RATE>${xmlEscape(sourceInfo.timecodeRate)}</TIMECODE_RATE>` : null,
    sourceInfo.timecodeFlag ? `\t\t<TIMECODE_FLAG>${xmlEscape(sourceInfo.timecodeFlag)}</TIMECODE_FLAG>` : null,
    `\t\t<TIMESTAMP_SAMPLE_RATE>${baseRecord.sampleRate}</TIMESTAMP_SAMPLE_RATE>`,
    `\t\t<TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI>${parts.hi}</TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI>`,
    `\t\t<TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO>${parts.lo}</TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO>`,
    "\t</SPEED>",
    "\t<TRACK_LIST>",
    `\t\t<TRACK_COUNT>${tracks.length}</TRACK_COUNT>`,
    trackXml,
    "\t</TRACK_LIST>",
    "</BWFXML>",
    "",
  ].filter(line => line !== null).join("\r\n");
}

export function fmtChunkDataForCombine(baseRecord, channels, blockAlign) {
  const isFloat = baseRecord.isFloat || baseRecord.audioFormat === 3;
  // >2 production channels are discrete microphone channels, not surround speakers.
  const extensible = channels > 2 || baseRecord.audioFormat === 65534;
  const data = new Uint8Array(extensible ? 40 : isFloat ? 18 : 16);
  const view = new DataView(data.buffer);
  view.setUint16(0, extensible ? 65534 : isFloat ? 3 : 1, LITTLE);
  view.setUint16(2, channels, LITTLE);
  view.setUint32(4, baseRecord.sampleRate, LITTLE);
  view.setUint32(8, baseRecord.sampleRate * blockAlign, LITTLE);
  view.setUint16(12, blockAlign, LITTLE);
  view.setUint16(14, baseRecord.bitsPerSample, LITTLE);
  if (extensible) {
    view.setUint16(16, 22, LITTLE);
    view.setUint16(18, baseRecord.bitsPerSample, LITTLE);
    view.setUint32(20, 0, LITTLE); // unspecified/discrete; do not invent 5.1/7.1 assignments
    data.set([isFloat ? 3 : 1, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113], 24);
  }
  return data;
}

/**
 * 写一个 24 bit 整 PCM 采样。
 *
 * 位深下降时要抖动：32 bit 浮点或 32 bit 整数转 24 bit 是有损的，
 * 直接取整（截断）会在安静段落产生可闻的量化台阶——那是"数字静音的近亲"，
 * 听起来像底噪忽大忽小。TPDF 抖动（两个均匀随机之和）把截断误差摊成平稳的噪声，
 * 代价是噪声底比理论值高约 3 dB。
 *
 * 抖动用确定性 PRNG 而不是 Math.random()：抖动本身是随机的，
 * 但同一份素材每次导出应当得到同样的字节，否则"可复现"这条就没了。
 */
export function pcm24Sample(view, offset, sample, stats = {}) {
  if (!Number.isFinite(sample)) { stats.invalidSamples = (stats.invalidSamples || 0) + 1; sample = 0; }
  const ditherAmount = Number(stats.ditherAmount) || 0;
  if (ditherAmount > 0) {
    stats.ditherState = (Math.imul(Number(stats.ditherState) >>> 0, 1664525) + 1013904223) >>> 0;
    const first = stats.ditherState;
    stats.ditherState = (Math.imul(stats.ditherState, 1664525) + 1013904223) >>> 0;
    const second = stats.ditherState;
    // 两个 [0,1) 均匀随机之和减 1：峰峰值正好一个 LSB 的 TPDF 抖动。
    const tpdf = (first >>> 8) / 16777216 + (second >>> 8) / 16777216 - 1;
    sample += tpdf * ditherAmount;
  }
  if (sample < -1 || sample > 1) stats.clippedSamples = (stats.clippedSamples || 0) + 1;
  const value = Math.max(-8388608, Math.min(8388607, Math.round(Math.max(-1, Math.min(1, sample)) * 8388608)));
  view.setUint8(offset, value & 255);
  view.setUint8(offset + 1, (value >> 8) & 255);
  view.setUint8(offset + 2, (value >> 16) & 255);
}

export function safeWaveBaseName(value) {
  return String(value || "combined")
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "combined";
}

export async function writeChunk(writable, state, id, data) {
  await writable.write({ type: "write", position: state.position, data: chunkHeader(id, data.byteLength) });
  state.position += 8;
  await writable.write({ type: "write", position: state.position, data });
  state.position += data.byteLength;
  if (data.byteLength & 1) {
    await writable.write({ type: "write", position: state.position, data: new Uint8Array([0]) });
    state.position += 1;
  }
}

// ---------------------------------------------------------------- 对齐/纠错接线
//
// planTrackRepair（src/take-repair.js）只给"意图"，真正的补静音、丢 pre-roll、重采样在这里执行。
// 三件事都必须显式开启：调用方不传 options.repair 时，每条轨走的是原来那条纯字节拷贝路径，
// 输出与改动前逐字节一致。任何"要不要修"的判断权都留给测量侧和调用方，写入层不自己猜。

// 修正计划挂在轨道上的键，和 selectedSourceChannels / ltcSourceChannels 用的是同一套 sourceTrackKey。
export function combineRepairKey(track) {
  return sourceTrackKey(track);
}

function repairLookup(repair) {
  const plans = repair?.plans;
  if (plans instanceof Map) return key => plans.get(key) ?? null;
  if (Array.isArray(plans)) {
    // 数组形式 { sourceKey, ...plan }：界面状态/JSON 里最容易直接传进来的形状。
    const byKey = new Map();
    for (const entry of plans) {
      const key = entry?.sourceKey ?? entry?.key;
      if (typeof key === "string") byKey.set(key, entry);
    }
    return key => byKey.get(key) ?? null;
  }
  if (plans && typeof plans === "object") return key => plans[key] ?? null;
  return () => null;
}

/**
 * 把一段淡化区间的等功率增益预计算成表。
 * 写入的热路径每帧每轨都要用这两个值，而曲线是固定的——
 * 预计算一次，运行时只剩一次数组索引。
 */
function crossfadeGainTable(region) {
  if (!region) return null;
  const length = Math.max(1, region.end - region.start);
  const a = new Float32Array(length);
  const b = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    const gains = equalPowerGains(index, length);
    a[index] = gains.a;
    b[index] = gains.b;
  }
  return { start: region.start, end: region.end, a, b };
}

function normalizeTrackRepair(input, context = {}) {
  if (!input || typeof input !== "object") return null;
  // needsOffset / needsResample 是 planTrackRepair 自己定的门槛（|lead| > 0.5、|ratio-1| > 1e-5）。
  // 调用方已经判过"不值得改"，这里就必须真的不改，否则会绕过那道门槛白白损失音质。
  const lead = input.needsOffset === false ? 0 : Number(input.leadSamples ?? 0);
  const skip = input.needsOffset === false ? 0 : Number(input.skipSamples ?? 0);
  const ratio = input.needsResample === false ? 1 : Number(input.driftRatio ?? 1);
  const polarity = Number(input.polarity) === -1 ? -1 : 1;
  // 畸形参数按"不修正"处理：合板是批量作业，为一条坏轨中断整个 take 不划算。
  // driftRatio 必须为正——非正数不是"可以不重采样"，而是这份计划本身不可信。
  if (![lead, skip, ratio].every(Number.isFinite) || ratio <= 0 || skip < 0) return null;
  const leadSamples = lead;
  // skipSamples 只做校验和报告：pre-roll 的排除已经由 lead 的映射覆盖（见 repairSourcePosition），
  // 写在这里是为了留痕"这条轨丢了多少开头"，以及拦住符号搞反的计划。
  const skipSamples = skip;
  // 正 lead（晚开机）却还要丢开头是自相矛盾的：planTrackRepair 只在 lead < 0 时才给 skipSamples。
  // 出现这种组合多半是调用方把符号搞反了，宁可整份计划作废，也不半信半疑地执行。
  if (leadSamples >= 0 && skipSamples > 0) return null;
  const driftRatio = ratio;
  // 亚采样偏移：leadExact 是精确的小数时延，leadFraction 是它相对整数部分的小数。
  // 老计划没有这两个字段，退化成 0，行为与改动前逐样本一致。
  const leadExact = Number.isFinite(Number(input.leadExact)) ? Number(input.leadExact) : leadSamples;
  const leadFraction = Number.isFinite(Number(input.leadFraction)) ? Number(input.leadFraction) : leadExact - leadSamples;
  // 亚采样修正单独一档：它不改变对齐的整数部分，只把小数那部分真正用上。
  const needsSubSample = input.needsSubSample === false ? false : Math.abs(leadFraction) >= 0.05;
  // 什么都不改的轨不挂 repair，让它继续走字节拷贝路径：
  // 于是"开了开关但某轨无需修正"和"没开开关"在输出上完全一样。
  if (leadSamples === 0 && skipSamples === 0 && driftRatio === 1 && polarity === 1 && !needsSubSample) return null;
  // 内容区：真实内容在输出帧上占据的区间，补白区是它前后剩下的部分。
  const outputSamples = Number(context.outputSamples);
  const contentStart = Number.isFinite(Number(input.contentStart))
    ? Math.max(0, Math.round(Number(input.contentStart)))
    : Math.max(0, leadSamples);
  // contentEnd 拿不到时不能退成 contentStart（那等于"内容区是空的"，整条轨都会变成补白）。
  // 退成输出长度，甚至退成无穷：内容到底在哪结束，由"源还读不读得到"来判定，
  // 那才是真正可靠的边界。
  const contentEnd = Number.isFinite(Number(input.contentEnd))
    ? Math.max(contentStart, Math.round(Number(input.contentEnd)))
    : (Number.isSafeInteger(outputSamples) && outputSamples > 0 ? outputSamples : Number.POSITIVE_INFINITY);
  // 交叉淡化窗口：只有真的存在补白区的那一端才给窗口。
  const regions = context.crossfade?.enabled === true
    ? planCrossfadeRegions({ contentStart, contentEnd, outputSamples, crossfadeSamples: context.crossfade.samples })
    : { head: null, tail: null, samples: 0, contentStart, contentEnd };
  // 淡化增益预计算成表：原来每个采样、每条轨都要算两次 cos/sin，
  // 一条 60 分钟的轨就是上亿次超越函数调用，纯属浪费——曲线是固定的。
  const crossfade = {
    head: crossfadeGainTable(regions.head),
    tail: crossfadeGainTable(regions.tail),
    samples: regions.samples,
    contentStart: regions.contentStart,
    contentEnd: regions.contentEnd,
  };
  // 房间声模板由读盘那层准备好挂进计划；没找到可信片段时就是 null，
  // 此时补白退回数字静音——宁可安静，也不用一段错的底噪。
  const tone = input.roomTone;
  const roomTone = context.roomTone?.enabled === true && tone?.loop?.length
    ? {
        loop: tone.loop,
        rms: Number.isFinite(Number(tone.rms)) ? Number(tone.rms) : null,
        startFrame: Number.isFinite(Number(tone.startFrame)) ? Number(tone.startFrame) : null,
      }
    : null;
  return {
    leadSamples,
    leadExact,
    leadFraction,
    skipSamples,
    driftRatio,
    polarity,
    needsSubSample,
    contentStart,
    contentEnd,
    crossfade,
    roomTone,
  };
}

/**
 * 把修正计划挂到 plan.tracks 上，返回可追溯的修正报告数组。
 * 未开启（repair.enabled !== true）时返回 null 且不动任何轨道。
 */
export function enableTrackRepairs(tracks, repair) {
  if (!repair || repair.enabled !== true) return null;
  const lookup = repairLookup(repair);
  const reports = [];
  tracks.forEach((track, index) => {
    // 先按精确的 sourceTrackKey 找，找不到再回退到 recordKey——
    // 整条文件共用一份计划的用法（多声道文件）不必为每个声道重复登记。
    const input = lookup(sourceTrackKey(track)) ?? lookup(recordKey(track.record));
    const normalized = normalizeTrackRepair(input, {
      outputSamples: repair.outputSamples,
      crossfade: repair.crossfade,
      roomTone: repair.roomTone,
    });
    if (!normalized) return;
    track.repair = normalized;
    const trim = Number(input.trimSamples);
    reports.push({
      outputChannel: index + 1,
      name: track.channelName,
      source: recordKey(track.record),
      sourceChannel: track.channelIndex + 1,
      sourceKey: sourceTrackKey(track),
      leadSamples: normalized.leadSamples,
      // 补静音不是单独一遍写入：源下标算成负的那些帧自动落到"越界写静音"这条路上，
      // 所以实际补的量就是 max(0, lead)。
      padSamples: Math.max(0, normalized.leadSamples),
      skipSamples: normalized.skipSamples,
      driftRatio: normalized.driftRatio,
      resampled: normalized.driftRatio !== 1,
      polarity: normalized.polarity,
      polarityFlipped: normalized.polarity === -1,
      trimSamples: Number.isFinite(trim) ? Math.max(0, Math.round(trim)) : 0,
      // 只报告不执行：裁掉的是真实录音，必须由人在界面上显式选择后才该消失。
      trimApplied: false,
      // 亚采样修正：整数偏移之外的小数部分，写入层用线性插值真正用上。
      subSampleOffset: normalized.leadFraction,
      // 接缝处做了等功率交叉淡化（只在真有补白区的那一端）。
      crossfadeApplied: Boolean(normalized.crossfade.head || normalized.crossfade.tail),
      // 房间声补白是否真的用上了：没找到可信片段时为 false，补白退回数字静音。
      roomToneApplied: Boolean(normalized.roomTone),
      roomToneRms: normalized.roomTone?.rms ?? null,
    });
  });
  return reports;
}

/**
 * 输出长度（帧）只能由调用方显式给：repair.referenceKey（与 sourceTrackKey 同一套键）
 * 或 repair.outputSamples。两者都没有时返回 null，合板维持"必须严格等长"的老规矩。
 */
function repairOutputFrames(groupRecords, options) {
  const repair = options?.repair;
  if (!repair || repair.enabled !== true) return null;
  const explicit = Number(repair.outputSamples);
  if (Number.isSafeInteger(explicit) && explicit > 0) return explicit;
  const referenceKey = typeof repair.referenceKey === "string" ? repair.referenceKey : "";
  if (!referenceKey) return null;
  for (const record of groupRecords) {
    for (let channelIndex = 0; channelIndex < record.channels; channelIndex++) {
      if (sourceTrackKey({ record, channelIndex }) !== referenceKey) continue;
      const frames = Number(record.durationSamples);
      return Number.isSafeInteger(frames) && frames > 0 ? frames : null;
    }
  }
  return null;
}

// 输出第 n 帧 → 源文件第几帧。
// planTrackRepair 的约定是 target[k] = reference[k + lead]，所以对齐后输出第 n 帧取 target[n - lead]：
//   lead > 0（晚开机）→ n - lead 为负 → 越界 → 自动补上静音；
//   lead < 0（提前开机的 pre-roll）→ n - lead 越过了 target 的开头 → pre-roll 自然被排除。
// 关键：skipSamples 是 max(0, -lead) 的推论，上面的映射已经把这段排除掉了，
// 写入层绝不能再减一次——那会把 pre-roll 扣两遍，偏移量正好差一个 pre-roll。
// lead 活在源帧域（measureOffset 量的是原始 target 的时延），
// 而重采样比 driftRatio = 输出帧数 / 源帧数，换算回源帧域要除以它。
function repairSourcePosition(outputFrame, repair) {
  // leadExact 是带小数部分的精确时延；没有这个字段的老计划退回到整数 lead。
  // 小数那部分正是"两台设备时钟一致、只差零点几拍"这种常见场景下唯一能拿到的精度。
  const lead = Number.isFinite(repair.leadExact) ? repair.leadExact : repair.leadSamples;
  return (outputFrame - lead) / repair.driftRatio;
}

// 源文件里到底有多少帧。畸形 record（没有时长、没有 file）退化成 0，
// 结果是整条轨写静音——宁可静默也不抛未捕获异常打断整个 take。
function sourceFrameLimit(record) {
  const frames = Number(record?.durationSamples);
  if (Number.isSafeInteger(frames) && frames > 0) return frames;
  const blockAlign = Number(record?.blockAlign);
  const available = Number(record?.file?.size) - Number(record?.dataOffset);
  if (Number.isSafeInteger(available) && Number.isFinite(blockAlign) && blockAlign > 0) return Math.max(0, Math.floor(available / blockAlign));
  return 0;
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// 只在必须改动采样值时用（重采样或取反），所以走浮点往返：
// 整数 PCM 的取反靠 Math.round(sample × 2^bits) 回到原字节，不会凭空多出误差。
function writeSourceSample(view, offset, sample, record) {
  const value = Number.isFinite(sample) ? sample : 0;
  if (isIeeeFloat(record) && record.bitsPerSample === 32) { view.setFloat32(offset, value, LITTLE); return; }
  if (isIeeeFloat(record) && record.bitsPerSample === 64) { view.setFloat64(offset, value, LITTLE); return; }
  if (record.bitsPerSample === 8) { view.setUint8(offset, clampInt(Math.round(value * 128) + 128, 0, 255)); return; }
  if (record.bitsPerSample === 16) { view.setInt16(offset, clampInt(Math.round(value * 32768), -32768, 32767), LITTLE); return; }
  if (record.bitsPerSample === 24) {
    const pcm = clampInt(Math.round(value * 8388608), -8388608, 8388607);
    view.setUint8(offset, pcm & 255);
    view.setUint8(offset + 1, (pcm >> 8) & 255);
    view.setUint8(offset + 2, (pcm >> 16) & 255);
    return;
  }
  if (record.bitsPerSample === 32) { view.setInt32(offset, clampInt(Math.round(value * 2147483648), -2147483648, 2147483647), LITTLE); return; }
  throw new Error(`${record.name}: 不支持 ${record.bitsPerSample} bit 音频`);
}

export async function writeCombinedData(writable, state, plan, progressBase, progressTotal, onProgress = null) {
  const { first, outputRecord, tracks, bytesPerSample, sourceBytesPerSample, blockAlign, durationSamples, dataSize } = plan;
  const mutedSourceChannels = plan.mutedSourceChannels || new Set();
  // 有没有被修正的轨。一条都没有被修正时，读取窗口和取样公式都退回原来那条纯拷贝路径。
  const hasRepair = tracks.some(track => track.repair);
  // 响度表：每条输出通道一套。K 加权与块能量很便宜，真峰值贵（每采样上百次乘加），
  // 所以只有程序通道算真峰值，其余通道只要积分响度。
  const loudnessEnabled = plan.loudness?.enabled !== false;
  const programIndex = Number.isInteger(plan.programChannelIndex) ? plan.programChannelIndex : 0;
  const meters = loudnessEnabled
    ? tracks.map((_, index) => createChannelLoudnessMeter({
        sampleRate: plan.first.sampleRate,
        truePeak: index === programIndex,
      }))
    : null;
  // 同一文件的多条轨必须共享一次读取。原来靠 recordKey 去重、默认按第一条轨的窗口读，
  // 这里改成显式分组：同一文件里不同轨的修正参数可以不同，窗口要按并集算。
  const recordGroups = [];
  const groupByKey = new Map();
  for (const track of tracks) {
    const key = recordKey(track.record);
    let group = groupByKey.get(key);
    if (!group) {
      group = { key, record: track.record, tracks: [] };
      groupByKey.set(key, group);
      recordGroups.push(group);
    }
    group.tracks.push(track);
  }
  await writable.write({ type: "write", position: state.position, data: chunkHeader("data", dataSize) });
  state.position += 8;
  const framesPerChunk = Math.max(1, Math.floor((4 * 1024 * 1024) / blockAlign));
  let framesDone = 0n;

  while (framesDone < durationSamples) {
    const framesLeft = durationSamples - framesDone;
    const framesThisChunk = Number(framesLeft < BigInt(framesPerChunk) ? framesLeft : BigInt(framesPerChunk));
    const frameBase = Number(framesDone);
    const sourceBuffers = new Map();
    const sourceViews = new Map();
    const windowStarts = new Map();
    const windowFrames = new Map();
    for (const group of recordGroups) {
      const limit = sourceFrameLimit(group.record);
      let start = frameBase, end = frameBase + framesThisChunk;
      if (hasRepair) {
        start = Number.POSITIVE_INFINITY, end = Number.NEGATIVE_INFINITY;
        for (const track of group.tracks) {
          // 没修正的轨仍然按整段对齐读取，它的需求把窗口下限钉在 frameBase 上。
          const from = track.repair ? repairSourcePosition(frameBase, track.repair) : frameBase;
          const to = track.repair ? repairSourcePosition(frameBase + framesThisChunk - 1, track.repair) : frameBase + framesThisChunk - 1;
          start = Math.min(start, Math.floor(from), Math.floor(to));
          // 窗口右端是开区间：要盖住最后一个被用到的采样，插值还要再往后借一个。
          // 未修正的轨 to = frameBase + framesThisChunk - 1，ceil(to) + 1 正好等于
          // frameBase + framesThisChunk，和改动前读的长度逐字节一致。
          end = Math.max(end, Math.ceil(to) + 1);
        }
      }
      const dataOffset = Number(group.record.dataOffset);
      const blockAlign = Number(group.record.blockAlign);
      // 读不出源的 record（没有 file、dataOffset 或 blockAlign 不是有限数）：窗口长度归零，
      // 整条轨落到"越界写静音"上。宁可交一条静音轨，也不把 NaN 位置甩给取样偏移。
      const readable = group.record.file && Number.isFinite(dataOffset) && Number.isFinite(blockAlign) && blockAlign > 0;
      // 窗口必须夹在源文件真实长度内：Blob.slice 越界只会静默返回短数据，
      // 之后按完整帧算偏移就会读到别的轨甚至别的 chunk。
      const startFrame = readable ? Math.max(0, Math.min(Math.floor(start), limit)) : 0;
      const frames = readable ? Math.max(0, Math.min(Math.ceil(end), limit) - startFrame) : 0;
      const sourceView = readable ? await readDataView(group.record.file, dataOffset + startFrame * blockAlign, frames * blockAlign) : new DataView(new ArrayBuffer(0));
      sourceBuffers.set(group.key, new Uint8Array(sourceView.buffer));
      sourceViews.set(group.key, sourceView);
      windowStarts.set(group.key, startFrame);
      windowFrames.set(group.key, frames);
    }

    const out = new Uint8Array(framesThisChunk * blockAlign);
    const outView = new DataView(out.buffer);
    for (let frame = 0; frame < framesThisChunk; frame++) {
      for (let outTrack = 0; outTrack < tracks.length; outTrack++) {
        const track = tracks[outTrack];
        const key = recordKey(track.record);
        const sourceChannelKey = `${key}:${track.channelIndex}`;
        const destOffset = frame * blockAlign + outTrack * bytesPerSample;
        if (mutedSourceChannels.has(sourceChannelKey)) {
          writeSilenceSample(outView, destOffset, outputRecord);
          // 静音通道也要喂一次：每条通道的表必须每帧收到一个值，否则块边界会错位。
          meters?.[outTrack]?.push(0);
          continue;
        }
        const repair = track.repair;
        const outputFrame = frameBase + frame;
        let position = repair ? repairSourcePosition(outputFrame, repair) : outputFrame;
        // 亚采样边界：位置落在源起点前不足一个采样时，夹到源的第一帧。
        // 不夹的话，一个 0.37 采样的偏移会让第一帧被判成越界——内容被整整挪走一帧，
        // 还凭空多出一帧补白，亚采样修正就变成了"偏移一帧"。
        if (position < 0 && position > -1) position = 0;
        const frameIndex = Math.floor(position);
        const view = sourceViews.get(key);
        const startFrame = windowStarts.get(key);
        const windowEnd = startFrame + windowFrames.get(key);
        const inWindow = Boolean(view) && frameIndex >= startFrame && frameIndex < windowEnd;
        if (!repair) {
          // 越界（源比输出短）一律写静音，和静音通道走同一个出口。
          if (!inWindow) {
            writeSilenceSample(outView, destOffset, outputRecord);
            continue;
          }
          const sourceOffset = (frameIndex - startFrame) * track.record.blockAlign + track.channelIndex * sourceBytesPerSample;
          const sample = readAudioSample(view, sourceOffset, track.record);
          meters?.[outTrack]?.push(sample);
          if (plan.encoding === "pcm24") pcm24Sample(outView, destOffset, sample, plan);
          else out.set(sourceBuffers.get(key).subarray(sourceOffset, sourceOffset + bytesPerSample), destOffset);
          continue;
        }
        // 内容区是真实内容，补白区是它前后剩下的部分：默认整帧要么是内容，要么是补白。
        const inContent = outputFrame >= repair.contentStart && outputFrame < repair.contentEnd;
        let contentGain = inContent ? 1 : 0;
        let fillGain = inContent ? 0 : 1;
        // 等功率交叉淡化（P0-2）：接缝处把内容与补白等功率混合，感知响度全程恒定。
        // 等增益（线性互补）在中点会有可闻的功率凹陷，恰好在需要无缝的地方挖了个洞。
        const crossfade = repair.crossfade;
        const headFade = crossfade?.head;
        const tailFade = crossfade?.tail;
        if (headFade && outputFrame >= headFade.start && outputFrame < headFade.end) {
          const offset = outputFrame - headFade.start;
          contentGain = headFade.b[offset];
          fillGain = headFade.a[offset];
        } else if (tailFade && outputFrame >= tailFade.start && outputFrame < tailFade.end) {
          const offset = outputFrame - tailFade.start;
          contentGain = tailFade.a[offset];
          fillGain = tailFade.b[offset];
        }
        // 源读不到却落在内容区：那是录音提前断了，按补白处理，别在中间留一个洞。
        if (contentGain > 0 && !inWindow) {
          contentGain = 0;
          fillGain = 1;
        }
        let value = 0;
        if (contentGain > 0) {
          const sourceOffset = (frameIndex - startFrame) * track.record.blockAlign + track.channelIndex * sourceBytesPerSample;
          const sample = readAudioSample(view, sourceOffset, track.record);
          value = sample;
          // 小数偏移的线性插值：原来只在重采样时插值，纯偏移（driftRatio === 1）
          // 的小数部分被白白丢掉——那正是亚采样对齐唯一能派上用场的地方。
          const fraction = position - frameIndex;
          if (fraction > 0) {
            const nextIndex = Math.min(frameIndex + 1, windowEnd - 1);
            const nextOffset = (nextIndex - startFrame) * track.record.blockAlign + track.channelIndex * sourceBytesPerSample;
            const next = nextIndex === frameIndex ? sample : readAudioSample(view, nextOffset, track.record);
            value = sample * (1 - fraction) + next * fraction;
          }
          if (repair.polarity === -1) value = -value;
          value *= contentGain;
        }
        if (fillGain > 0 && repair.roomTone?.loop?.length) {
          // 房间声模板取自原始轨，极性要与内容保持一致。
          let tone = toneSampleAt(repair.roomTone.loop, outputFrame);
          if (repair.polarity === -1) tone = -tone;
          // 电平对齐：补白区的底噪应当与内容里那条底噪齐平，否则接缝处会听出
          // "底噪换了一层"。各轨各找时模板本来就取自本轨，天然齐平；
          // 共用一份底噪时按各轨自己的噪声底做一次宽带校正（限幅 ±6 dB）。
          value += tone * fillGain * (repair.roomTone.gain ?? 1);
        }
        meters?.[outTrack]?.push(value);
        if (plan.encoding === "pcm24") pcm24Sample(outView, destOffset, value, plan);
        else writeSourceSample(outView, destOffset, value, outputRecord);
      }
    }

    await writable.write({ type: "write", position: state.position, data: out });
    state.position += out.byteLength;
    framesDone += BigInt(framesThisChunk);
    onProgress?.("正在合并 Poly…", recordLabel(first), progressBase + Number(framesDone) / Number(durationSamples), progressTotal);
  }
  if (dataSize & 1) {
    await writable.write({ type: "write", position: state.position, data: new Uint8Array([0]) });
    state.position += 1;
  }
  return meters ? meters.map(meter => meter.finish()) : null;
}

export async function writeCombinedPolyToWritable(key, groupRecords, writable, outputName, options = {}) {
  const progressBase = options.progressBase ?? 0;
  const progressTotal = options.progressTotal ?? 1;
  let plan;
  try { plan = validateCombineGroup(groupRecords, options); }
  catch (error) {
    if (typeof writable.abort === "function") await writable.abort().catch(() => {});
    throw error;
  }
  // Clean profiles physically exclude confirmed LTC; archive preserves old mute behavior.
  plan.mutedSourceChannels = plan.profile.id === "archive" ? options.mutedSourceChannels || new Set() : new Set();
  // 响度：默认开启。它只测量、只写元数据，不改动任何采样。
  plan.loudness = { enabled: options.loudness?.enabled !== false, target: options.loudness?.target || "r128" };
  // 抖动：只有位深真的下降时才需要。
  // 16 bit → 24 bit 是升位，不抖；24 bit → 24 bit 不抖；
  // 32 bit 整数或浮点 → 24 bit 是降位，必须抖，否则安静段落有量化台阶。
  const sourceBits = Number(plan.first.bitsPerSample);
  const sourceIsFloat = Boolean(plan.first.isFloat || plan.first.audioFormat === 3);
  plan.ditherAmount = plan.encoding === "pcm24" && (sourceIsFloat || sourceBits > 24) ? 1 / 8388608 : 0;
  plan.ditherState = 0x9e3779b9;
  // 程序通道 = 第一个不是已确认 LTC 的输出通道。响度字段写的是它的读数：
  // Poly 是分轨素材，整体节目响度要到混音阶段（Resolve）才算，
  // 这里报的是这一条节目轨自己的电平，各轨之间也各有各的读数。
  const programChannelIndex = plan.tracks.findIndex(track =>
    !plan.mutedSourceChannels.has(`${recordKey(track.record)}:${track.channelIndex}`));
  plan.programChannelIndex = programChannelIndex >= 0 ? programChannelIndex : 0;
  // 对齐/纠错默认关闭：只有调用方显式传 repair.enabled 才会按修正计划改写每条轨。
  const repairs = enableTrackRepairs(plan.tracks, options.repair);
  const groupName = safeWaveBaseName(shortGroupLabel(key));
  const sourceInfo = combineSourceInfo(groupRecords, { fallbackFpsValue: options.fallbackFpsValue });
  const state = { position: 0 };
  const bext = bextChunkDataForCombine(plan.first, sourceInfo, plan.tracks);
  const ixml = new TextEncoder().encode(ixmlTextForCombine(plan.first, sourceInfo, plan.tracks));
  const chna = chnaChunkDataForCombine(plan.tracks);
  const fmt = fmtChunkDataForCombine(plan.outputRecord, plan.tracks.length, plan.blockAlign);
  const fact = plan.outputRecord.isFloat || plan.outputRecord.audioFormat === 3 ? new Uint8Array(4) : null;
  if (fact) new DataView(fact.buffer).setUint32(0, Number(plan.durationSamples > 0xffffffffn ? 0xffffffffn : plan.durationSamples), LITTLE);
  // axml 里装响度，量完才写得出，所以它的长度只能先按最宽的取值估。
  // 真正的 RIFF 长度在最后按实际位置回填，这里只用来判断要不要走 RF64。
  const axmlEstimate = new TextEncoder().encode(axmlLoudnessText({
    integrated: -999.9, truePeak: -999.9, maxMomentary: -999.9, maxShortTerm: -999.9, range: 999.9,
  })).byteLength;
  const riffBody =
    4 +
    (8 + bext.byteLength + (bext.byteLength & 1)) +
    (8 + ixml.byteLength + (ixml.byteLength & 1)) +
    (8 + chna.byteLength + (chna.byteLength & 1)) +
    (8 + fmt.byteLength + (fmt.byteLength & 1)) +
    (fact ? 12 : 0) +
    (8 + plan.dataSize + (plan.dataSize & 1)) +
    (8 + axmlEstimate + (axmlEstimate & 1));
  const useRf64 = riffBody > 0xffffffff;

  let measurements = null;
  let programMeasurement = null;
  try {
    await writable.write({
      type: "write",
      position: 0,
      data: waveFileHeader(useRf64 ? "RF64" : "RIFF", useRf64 ? 0xffffffff : 0),
    });
    state.position = 12;
    let ds64Pos = null;
    if (useRf64) {
      ds64Pos = state.position;
      const placeholder = new Uint8Array(36);
      placeholder.set([0x64, 0x73, 0x36, 0x34], 0);
      new DataView(placeholder.buffer).setUint32(4, 28, LITTLE);
      await writable.write({ type: "write", position: state.position, data: placeholder });
      state.position += placeholder.byteLength;
    }
    // bext 的数据段起点：chunk 头占 8 字节。响度是量完才知道的，
    // 所以先按"没测"写出去，量完再原位回填（定位写在 RIFF 长度回填里已经用过）。
    const bextOffset = state.position + 8;
    await writeChunk(writable, state, "bext", bext);
    await writeChunk(writable, state, "iXML", ixml);
    await writeChunk(writable, state, "chna", chna);
    await writeChunk(writable, state, "fmt ", fmt);
    if (fact) await writeChunk(writable, state, "fact", fact);
    measurements = await writeCombinedData(writable, state, plan, progressBase, progressTotal, options.onProgress);
    // 响度回填 bext version 2 的五个字段，并把同一组数写进 axml（放在 data 之后）。
    programMeasurement = measurements?.[plan.programChannelIndex] ?? null;
    if (measurements) {
      applyLoudnessToBext(bext, loudnessToBextFields(programMeasurement));
      await writable.write({ type: "write", position: bextOffset, data: bext });
      const axml = new TextEncoder().encode(axmlLoudnessText(programMeasurement));
      await writeChunk(writable, state, "axml", axml);
    }
    const riffSize = state.position - 8;
    if (useRf64) {
      await writable.write({
        type: "write",
        position: ds64Pos + 8,
        data: ds64ChunkData({
          riffSize,
          dataSize: plan.dataSize,
          sampleCount: plan.durationSamples,
        }),
      });
    } else {
      if (riffSize > 0xffffffff) throw new Error(`${groupName}: 合并后超过 RIFF 4GB 限制`);
      const sizePatch = new Uint8Array(4);
      new DataView(sizePatch.buffer).setUint32(0, riffSize, LITTLE);
      await writable.write({ type: "write", position: 4, data: sizePatch });
    }
    await writable.truncate(state.position);
  } catch (error) {
    if (typeof writable.abort === "function") await writable.abort().catch(() => {});
    else await writable.close().catch(() => {});
    throw error;
  }
  await writable.close();
  return {
    name: outputName, channels: plan.tracks.length, durationSamples: plan.durationSamples, sampleRate: plan.first.sampleRate,
    bitsPerSample: plan.outputRecord.bitsPerSample, profile: plan.profile.id,
    tracks: plan.tracks.map((track, index) => ({ outputChannel: index + 1, name: track.channelName, source: recordKey(track.record), sourceChannel: track.channelIndex + 1, sourceKey: sourceTrackKey(track) })),
    // 只有开了修正才带这个字段：默认路径的返回结构保持原样，别的模块不会看到多出来的键。
    ...(repairs ? { repairs } : null),
    // 响度读数：每条输出通道一份，外加程序通道的汇总。
    ...(measurements ? {
      loudness: {
        programChannel: plan.programChannelIndex + 1,
        program: programMeasurement,
        channels: measurements,
        target: plan.loudness.target,
      },
    } : null),
    excludedTracks: plan.excludedTracks.map(track => ({ source: recordKey(track.record), sourceChannel: track.channelIndex + 1, reason: track.reason })),
    clippedSamples: plan.clippedSamples, invalidSamples: plan.invalidSamples,
  };
}
