import { LITTLE, ds64ChunkData, readDataView, waveFileHeader } from "./wave.js";
import { readAudioSample, writeSilenceSample } from "./wave-audio.js";
import { applyPolyExportPolicy, sourceTrackKey } from "./poly-export-profiles.js";
import { parseFps } from "./timecode.js";
import {
  combineSortValue,
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
  if (maxDuration !== minDuration) throw new Error(`${groupLabel(first)}: 分轨时长不同，暂不自动裁切或补静音`);
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
  const dataSize = Number(minDuration) * blockAlign;
  if (!Number.isSafeInteger(dataSize)) throw new Error(`${groupLabel(first)}: 合并后的 data 过大`);
  if (tracks.length > 65535 || blockAlign > 65535 || first.sampleRate * blockAlign > 0xffffffff) throw new Error("输出 WAV 通道数/字节率超出格式上限");
  return { first, outputRecord, tracks, excludedTracks: policy.excluded, profile: policy.profile, encoding, sourceBytesPerSample, bytesPerSample, blockAlign, durationSamples: minDuration, dataSize, clippedSamples: 0, invalidSamples: 0 };
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
  view.setUint16(346, 1, LITTLE);
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

export function pcm24Sample(view, offset, sample, stats = {}) {
  if (!Number.isFinite(sample)) { stats.invalidSamples = (stats.invalidSamples || 0) + 1; sample = 0; }
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

export async function writeCombinedData(writable, state, plan, progressBase, progressTotal, onProgress = null) {
  const { first, outputRecord, tracks, bytesPerSample, sourceBytesPerSample, blockAlign, durationSamples, dataSize } = plan;
  const mutedSourceChannels = plan.mutedSourceChannels || new Set();
  await writable.write({ type: "write", position: state.position, data: chunkHeader("data", dataSize) });
  state.position += 8;
  const framesPerChunk = Math.max(1, Math.floor((4 * 1024 * 1024) / blockAlign));
  let framesDone = 0n;

  while (framesDone < durationSamples) {
    const framesLeft = durationSamples - framesDone;
    const framesThisChunk = Number(framesLeft < BigInt(framesPerChunk) ? framesLeft : BigInt(framesPerChunk));
    const sourceBuffers = new Map();
    const sourceViews = new Map();
    for (const track of tracks) {
      if (sourceBuffers.has(recordKey(track.record))) continue;
      const bytesToRead = framesThisChunk * track.record.blockAlign;
      const position = track.record.dataOffset + Number(framesDone) * track.record.blockAlign;
      const sourceView = await readDataView(track.record.file, position, bytesToRead);
      sourceBuffers.set(recordKey(track.record), new Uint8Array(sourceView.buffer));
      sourceViews.set(recordKey(track.record), sourceView);
    }

    const out = new Uint8Array(framesThisChunk * blockAlign);
    const outView = new DataView(out.buffer);
    for (let frame = 0; frame < framesThisChunk; frame++) {
      for (let outTrack = 0; outTrack < tracks.length; outTrack++) {
        const track = tracks[outTrack];
        const source = sourceBuffers.get(recordKey(track.record));
        const sourceOffset = frame * track.record.blockAlign + track.channelIndex * sourceBytesPerSample;
        const destOffset = frame * blockAlign + outTrack * bytesPerSample;
        const sourceChannelKey = `${recordKey(track.record)}:${track.channelIndex}`;
        if (mutedSourceChannels.has(sourceChannelKey)) {
          writeSilenceSample(outView, destOffset, outputRecord);
        } else if (plan.encoding === "pcm24") {
          pcm24Sample(outView, destOffset, readAudioSample(sourceViews.get(recordKey(track.record)), sourceOffset, track.record), plan);
        } else {
          out.set(source.subarray(sourceOffset, sourceOffset + bytesPerSample), destOffset);
        }
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
  const groupName = safeWaveBaseName(shortGroupLabel(key));
  const sourceInfo = combineSourceInfo(groupRecords, { fallbackFpsValue: options.fallbackFpsValue });
  const state = { position: 0 };
  const bext = bextChunkDataForCombine(plan.first, sourceInfo, plan.tracks);
  const ixml = new TextEncoder().encode(ixmlTextForCombine(plan.first, sourceInfo, plan.tracks));
  const fmt = fmtChunkDataForCombine(plan.outputRecord, plan.tracks.length, plan.blockAlign);
  const fact = plan.outputRecord.isFloat || plan.outputRecord.audioFormat === 3 ? new Uint8Array(4) : null;
  if (fact) new DataView(fact.buffer).setUint32(0, Number(plan.durationSamples > 0xffffffffn ? 0xffffffffn : plan.durationSamples), LITTLE);
  const riffBody =
    4 +
    (8 + bext.byteLength + (bext.byteLength & 1)) +
    (8 + ixml.byteLength + (ixml.byteLength & 1)) +
    (8 + fmt.byteLength + (fmt.byteLength & 1)) +
    (fact ? 12 : 0) +
    (8 + plan.dataSize + (plan.dataSize & 1));
  const useRf64 = riffBody > 0xffffffff;

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
    await writeChunk(writable, state, "bext", bext);
    await writeChunk(writable, state, "iXML", ixml);
    await writeChunk(writable, state, "fmt ", fmt);
    if (fact) await writeChunk(writable, state, "fact", fact);
    await writeCombinedData(writable, state, plan, progressBase, progressTotal, options.onProgress);
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
    excludedTracks: plan.excludedTracks.map(track => ({ source: recordKey(track.record), sourceChannel: track.channelIndex + 1, reason: track.reason })),
    clippedSamples: plan.clippedSamples, invalidSamples: plan.invalidSamples,
  };
}
