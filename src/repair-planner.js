// 从真实文件里读出对齐测量需要的两段窗口，喂给 src/take-repair.js。
//
// 为什么要单独一层：measureDrift 要整条 reference 都在内存里才能定出尾窗位置，
// 而一条 60 分钟的 ISO 分轨不该整个读进来。这里只读头部和尾部各一段——
// 互相关和漂移测量本来就只需要这两个窗口。
//
// 全部错误一律收敛成"这条轨测不出来"（plans 里没有它），绝不抛出去打断整批合并：
// 修不了就按原样合，和用户看到"这条没修上"是同一种结果，不该让整个 take 陪葬。

import { measureDriftFromWindows, measureOffset, planFromMeasurement } from "./take-repair.js";
import { sourceTrackKey } from "./poly-export-profiles.js";
import { readAudioSample } from "./wave-audio.js";
import { readDataView } from "./wave.js";
import {
  ROOM_TONE_DEFAULTS,
  buildSeamlessLoop,
  evaluateToneCandidate,
  findQuietestSpan,
  meanOf,
  peakOf,
  rmsOf,
} from "./room-tone.js";
import { WAVEFORM_SYNC_DEFAULTS, analyzeWaveformEnvelopes, computeEnvelope } from "./waveform-sync.js";

function nextPow2(value) {
  let n = 1;
  while (n < value) n <<= 1;
  return n;
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** 源文件一共多少帧。读不到就退化成 0，交给上层决定跳过。 */
export function trackFrameCount(record) {
  const frames = Number(record?.durationSamples);
  if (Number.isSafeInteger(frames) && frames > 0) return frames;
  return 0;
}

/**
 * 读一个 track 的一条通道的头/尾窗口，解码成 Float32Array。
 * 读不到（文件缺失、blockAlign 非法、长度越界）返回 null 而不是抛错。
 */
export async function readTrackWindows(track, { windowSize, tailStart, tailGuard, sampleRate }) {
  const record = track.record;
  const frames = trackFrameCount(record);
  const blockAlign = Number(record.blockAlign);
  if (!frames || !Number.isFinite(blockAlign) || blockAlign <= 0 || !record.file) return null;
  const bytesPerSample = blockAlign / Number(record.channels || 1);
  const readFrames = Math.min(windowSize, frames);

  const decode = async (startFrame) => {
    const count = Math.min(windowSize, frames - startFrame);
    if (count < windowSize) return null; // 尾部窗口不足，宁可不测
    const view = await readDataView(record.file, record.dataOffset + startFrame * blockAlign, count * blockAlign);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = readAudioSample(view, i * blockAlign + track.channelIndex * bytesPerSample, record);
    return out;
  };

  const head = await decode(0);
  if (!head) return null;
  const tailStartFrame = clampInt(tailStart, 0, Math.max(0, frames - windowSize));
  const tail = tailStartFrame > tailGuard ? await decode(tailStartFrame) : null;
  return { head, tail, tailStartFrame, frames, sampleRate };
}

/**
 * 在一条轨里找最安静的一段，当房间声素材用。
 *
 * 做法分两步：先按块抽样估电平（只读文件的一部分——一条 60 分钟的 ISO 不该整条
 * 读进内存），找能量最低的连续窗口；再把那一段完整读出来复测。扫描是抽样的，
 * 复测才是判据：抽样说"这儿最安静"，不等于这段真的能用。
 *
 * 判据在 evaluateToneCandidate 里：不是数字静音、足够安静、噪声样。
 * 任何一条不过就如实返回不可用，绝不拿勉强的素材去改音频。
 */
export async function readQuietestRegion(track, {
  sampleRate = 48000,
  blockSeconds = ROOM_TONE_DEFAULTS.blockSeconds,
  scanStrideSeconds = ROOM_TONE_DEFAULTS.scanStrideSeconds,
  sampleSeconds = ROOM_TONE_DEFAULTS.sampleSeconds,
  toneSeconds = ROOM_TONE_DEFAULTS.toneSeconds,
  silenceFloor = ROOM_TONE_DEFAULTS.silenceFloor,
  minDropDb = ROOM_TONE_DEFAULTS.minDropDb,
  maxCrest = ROOM_TONE_DEFAULTS.maxCrest,
  requireDrop = true,
} = {}) {
  const record = track?.record;
  const frames = trackFrameCount(record);
  const blockAlign = Number(record?.blockAlign);
  const dataOffset = Number(record?.dataOffset);
  if (!frames || !Number.isFinite(blockAlign) || blockAlign <= 0 || !record.file || !Number.isFinite(dataOffset)) return null;
  const channels = Math.max(1, Number(record.channels) || 1);
  const bytesPerSample = blockAlign / channels;
  const blockFrames = Math.max(1, Math.floor(sampleRate * blockSeconds));
  const strideFrames = Math.max(blockFrames, Math.floor(sampleRate * scanStrideSeconds));
  // 每块只读一小段来估电平：抽样本来就是估计，候选区读出来还会复测。
  // 全读的话一条 60 分钟的 ISO 要扫掉半个文件（几百 MB），只读一小段能降到十分之一。
  const estimateFrames = Math.max(1, Math.min(blockFrames, Math.floor(sampleRate * sampleSeconds)));
  const minToneFrames = Math.floor(sampleRate * ROOM_TONE_DEFAULTS.minToneSeconds);

  const decode = async (startFrame, count) => {
    const view = await readDataView(record.file, dataOffset + startFrame * blockAlign, count * blockAlign);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = readAudioSample(view, i * blockAlign + track.channelIndex * bytesPerSample, record);
    return out;
  };

  const blockRms = [];
  let loudestRms = 0;
  let totalEnergy = 0;
  let totalFrames = 0;
  for (let start = 0; start + blockFrames <= frames; start += strideFrames) {
    let samples = null;
    try { samples = await decode(start, estimateFrames); } catch { break; }
    const rms = rmsOf(samples);
    blockRms.push(rms);
    if (rms > loudestRms) loudestRms = rms;
    totalEnergy += rms * rms * estimateFrames;
    totalFrames += estimateFrames;
  }
  if (!blockRms.length) return null;

  // 找出最安静的那一块。扫描是抽样的：块与块之间还有没读过的区间，
  // 所以"最安静的一块"是唯一位置精确的连续区间——从它开始读才是真的从那儿读。
  const span = findQuietestSpan(blockRms, 1);
  if (!span) return null;
  const quietestStart = span.start * strideFrames;

  // 两个候选，从长到短试：
  //   长候选 = 从最安静块开始的一整段（素材更足，不必循环补白）；
  //   短候选 = 就是最安静的那一块（长候选若跨进了没扫过的响素材，会被判据否掉，退回它）。
  const toneFrames = Math.floor(sampleRate * toneSeconds);
  const attempts = [
    { startFrame: quietestStart, count: Math.min(toneFrames, frames - quietestStart) },
    { startFrame: quietestStart, count: Math.min(blockFrames, frames - quietestStart) },
  ];
  let lastFailure = null;
  for (const attempt of attempts) {
    if (attempt.count < minToneFrames) continue;
    let template = null;
    try { template = await decode(attempt.startFrame, attempt.count); } catch { continue; }
    const candidateRms = rmsOf(template);
    const candidatePeak = peakOf(template);
    const candidateMean = meanOf(template);
    const quality = evaluateToneCandidate({
      candidateRms, candidatePeak, candidateMean, loudestRms, silenceFloor, minDropDb, maxCrest, requireDrop,
    });
    if (!quality.usable) {
      lastFailure = { usable: false, reason: quality.reason, dropDb: quality.dropDb, crest: quality.crest, rms: candidateRms };
      continue;
    }
    const loop = buildSeamlessLoop(template, Math.floor(sampleRate * ROOM_TONE_DEFAULTS.loopCrossfadeSeconds));
    if (!loop?.length) {
      lastFailure = { usable: false, reason: "template-too-short" };
      continue;
    }
    return {
      usable: true,
      loop,
      rms: candidateRms,
      peak: candidatePeak,
      startFrame: attempt.startFrame,
      samples: template.length,
      dropDb: quality.dropDb,
      crest: quality.crest,
    };
  }
  return lastFailure ?? { usable: false, reason: "too-short" };
}

/**
 * 流式读一条轨的能量包络。
 *
 * 整条读进来会占几十兆内存（一小时 48 kHz 单声道就是 6900 万个采样），
 * 而包络只要 50 Hz——每 960 个采样才留一个。所以分块读、算完就扔。
 *
 * 跨块时要把上一块末尾的窗口尾巴带过来，否则包络会在块边界断成两截；
 * 带过来之后还要跳过已经算过的那几个窗口，保证全局的窗口起点步进不乱。
 */
export async function readTrackEnvelope(track, {
  sampleRate = 48000,
  hopMs = WAVEFORM_SYNC_DEFAULTS.envelopeHopMs,
  windowMs = WAVEFORM_SYNC_DEFAULTS.envelopeWindowMs,
  maxSeconds = 0,
  fineHopMs = WAVEFORM_SYNC_DEFAULTS.fineHopMs,
} = {}) {
  const record = track?.record;
  const frames = trackFrameCount(record);
  const blockAlign = Number(record?.blockAlign);
  const dataOffset = Number(record?.dataOffset);
  if (!frames || !Number.isFinite(blockAlign) || blockAlign <= 0 || !Number.isFinite(dataOffset)) return null;
  const limit = maxSeconds > 0 ? Math.min(frames, Math.floor(maxSeconds * sampleRate)) : frames;
  const hop = Math.max(1, Math.round(sampleRate * hopMs / 1000));
  const window = Math.max(hop, Math.round(sampleRate * windowMs / 1000));
  const bytesPerSample = blockAlign / Math.max(1, Number(record.channels) || 1);
  const channelOffset = (Number(track.channelIndex) || 0) * bytesPerSample;
  const chunkFrames = Math.max(window + hop, Math.floor((4 * 1024 * 1024) / blockAlign / hop) * hop);
  const carryLength = window - 1 + hop;

  const fineHop = Math.max(1, Math.round(sampleRate * fineHopMs / 1000));
  const parts = [];
  const fineParts = [];
  let carry = new Float64Array(0);
  let nextWindowStart = 0;
  let nextFineWindowStart = 0;
  for (let offset = 0; offset < limit; offset += chunkFrames) {
    const count = Math.min(chunkFrames, limit - offset);
    let view = null;
    try {
      view = await readDataView(record.file, dataOffset + offset * blockAlign, count * blockAlign);
    } catch {
      break;
    }
    const chunk = new Float64Array(carry.length + count);
    chunk.set(carry, 0);
    for (let i = 0; i < count; i++) {
      chunk[carry.length + i] = readAudioSample(view, i * blockAlign + channelOffset, record);
    }
    const chunkStart = offset - carry.length;
    const envelope = computeEnvelope(chunk, { sampleRate, hopMs, windowMs });
    const firstIndex = Math.max(0, Math.ceil((nextWindowStart - chunkStart) / hop));
    if (firstIndex < envelope.length) parts.push(envelope.subarray(firstIndex));
    nextWindowStart = chunkStart + envelope.length * hop;
    // 精细包络在同一次读盘里顺手算出来：精化阶段要 1 ms 分辨率，
    // 再读一遍文件不值得，而块已经在内存里了。
    const fine = computeEnvelope(chunk, { sampleRate, hopMs: fineHopMs, windowMs });
    const fineFirst = Math.max(0, Math.ceil((nextFineWindowStart - chunkStart) / fineHop));
    if (fineFirst < fine.length) fineParts.push(fine.subarray(fineFirst));
    nextFineWindowStart = chunkStart + fine.length * fineHop;
    carry = chunk.subarray(Math.max(0, chunk.length - carryLength));
  }
  if (!parts.length) return null;
  const join = (list) => {
    let size = 0;
    for (const part of list) size += part.length;
    const out = new Float32Array(size);
    let at = 0;
    for (const part of list) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  };
  return { coarse: join(parts), fine: join(fineParts) };
}

/**
 * 用波形把一批分轨对到参考声上。
 *
 * 与对齐修复里那条 GCC-PHAT 路径的区别：GCC-PHAT 靠原始波形找共同结构，
 * 只在"同一支麦、同一次录音"时成立；这里是靠**能量包络**，
 * 所以"同一现场、不同麦克风"（摄影机原始声对 ISO、ADR 场次对现场场次）也能对上。
 *
 * 逐轨独立判断：匹不上的那条如实给出 reason，不拖累别的轨。
 *
 * @returns Map<sourceTrackKey, { offsetSamples, confidence, reason }>
 */
export async function matchWaveformOffsets(tracks, reference, options = {}) {
  const results = new Map();
  if (!reference) return results;
  const sampleRate = Number(options.sampleRate) || Number(reference.record?.sampleRate) || 48000;
  const maxSeconds = Number(options.maxSeconds) || 0;
  const referenceEnvelopes = await readTrackEnvelope(reference, { sampleRate, maxSeconds });
  if (!referenceEnvelopes?.coarse?.length) return results;
  for (const track of tracks || []) {
    if (!track || track === reference) continue;
    const targetEnvelopes = await readTrackEnvelope(track, { sampleRate, maxSeconds });
    if (!targetEnvelopes?.coarse?.length) {
      results.set(sourceTrackKey(track), { offsetSamples: null, confidence: null, reason: "read-failed" });
      continue;
    }
    const analysis = analyzeWaveformEnvelopes(referenceEnvelopes.coarse, targetEnvelopes.coarse, {
      ...options,
      sampleRate,
      fine: { ref: referenceEnvelopes.fine, tgt: targetEnvelopes.fine },
    });
    const offsetSamples = analysis.measurement?.offsetSamples ?? null;
    results.set(sourceTrackKey(track), {
      usable: analysis.reason === "ok" && offsetSamples !== null,
      offsetSamples,
      confidence: analysis.confidence,
      reason: analysis.reason,
    });
  }
  return results;
}

/**
 * 为一个 take 里的所有轨道算出修复计划。
 *
 * @param tracks        combineTrackPlan(groupRecords) 的产物
 * @param referenceKey  基准轨的 sourceTrackKey；空串表示自动取第一条
 * @returns { referenceKey, outputSamples, plans: Map<sourceTrackKey, plan>, skipped: [...] }
 */
export async function planRepairsForTracks(tracks, referenceKey = "", {
  sampleRate = 48000,
  analysisSeconds = 2,
  tailGuardSeconds = 1,
  maxDrift = 0.01,
  // 交叉淡化与房间声补白：两者都默认关闭，由调用方显式打开。
  crossfade = null,
  roomTone = null,
  // 波形对齐：{ enabled, reference, maxSeconds }。
  // reference 是一条参考声（通常是摄影机原始声）。开启后逐轨试匹配，
  // 置信度达标才用它的偏移；不达标就照旧走原来的测量，并把原因记进报告。
  waveform = null,
} = {}) {
  const usable = (tracks || []).filter(track => trackFrameCount(track.record) > 0);
  if (!usable.length) return { referenceKey: "", outputSamples: 0, plans: new Map(), skipped: [], referenceMatched: false };

  // 键必须和 poly-export-profiles 的 sourceTrackKey 完全一致，否则写入层找不到对应计划。
  const keyOf = sourceTrackKey;
  const matched = referenceKey ? usable.find(track => keyOf(track) === referenceKey) : null;
  // 基准轨下拉给的是"所有 take 的并集"，用户为 A take 挑的轨在 B take 上本来就对不上。
  // 这里退回自动（第一条可用轨）而不是整批不修：修 B take 的时长不一致仍然有价值，
  // referenceMatched 标记会一路带到日志，让"这次用的不是你挑的那条"这件事说得出口。
  const reference = matched ?? usable[0];
  if (!reference) return { referenceKey: "", outputSamples: 0, plans: new Map(), skipped: [], referenceMatched: false };

  const referenceFrames = trackFrameCount(reference.record);
  const sampleRateOfReference = Number(reference.record.sampleRate) || sampleRate;
  // 短素材也要能修：分析窗口与尾部保护按素材长度等比缩小，而不是一句"太短测不了"就放弃。
  // 真实分轨通常几分钟，默认窗口够用；这里只是不让极端短的文件把整条路堵死。
  // 约束是「头窗 + 间隔 + 尾窗」三段必须装得下——头尾窗一样长，间隔就是尾部保护。
  const guardSamples = Math.min(Math.floor(sampleRateOfReference * tailGuardSeconds), Math.floor(referenceFrames / 4));
  const fits = seconds => Math.floor(sampleRateOfReference * seconds) * 2 + guardSamples <= referenceFrames;
  let effectiveSeconds = analysisSeconds;
  while (effectiveSeconds > 0.02 && !fits(effectiveSeconds)) effectiveSeconds /= 2;
  if (!fits(effectiveSeconds)) {
    return { referenceKey: "", outputSamples: 0, plans: new Map(), skipped: [], referenceMatched: false };
  }
  const windowSize = nextPow2(Math.max(64, Math.floor(sampleRateOfReference * effectiveSeconds)));
  const tailStart = Math.max(windowSize, referenceFrames - windowSize - guardSamples);
  const tailGuard = guardSamples;
  const analysis = { sampleRate: sampleRateOfReference, analysisSeconds: effectiveSeconds, maxDrift };

  const windows = new Map();
  for (const track of usable) {
    try {
      windows.set(keyOf(track), await readTrackWindows(track, {
        windowSize, tailStart, tailGuard, sampleRate: sampleRateOfReference,
      }));
    } catch {
      windows.set(keyOf(track), null); // 读不到就当这条测不了
    }
  }

  const referenceWindows = windows.get(keyOf(reference));
  if (!referenceWindows) return { referenceKey: "", outputSamples: 0, plans: new Map(), skipped: [], referenceMatched: false };

  // 波形匹配先跑一遍：它的结果要喂给下面的测量选择。
  const waveformMatches = waveform?.enabled === true && waveform.reference
    ? await matchWaveformOffsets(usable, waveform.reference, {
        sampleRate: sampleRateOfReference,
        maxSeconds: waveform.maxSeconds,
      })
    : new Map();

  const plans = new Map();
  const skipped = [];
  const roomToneReports = [];
  const waveformReports = [];
  // 指定的房间声来源：所有轨共用同一份底噪。
  //
  // 各轨各找各的最安静段有个实际问题——互不相关的噪声叠在一起并不相干，
  // 房间声会随轨数起伏，而不是一个稳定的声场。现场专门录的 room tone
  // 之所以要"一条轨、大家共用"，就是为了这个。
  //
  // 指定来源时跳"比整轨最响低 12 dB"那道闸门：一条专门的房间声轨整体就很安静，
  // 拿它跟自己的平均值比没有意义。判据里"不是数字静音""噪声样""不是直流"仍然有效。
  let sharedTone = null;
  const toneSourceKey = typeof roomTone?.sourceKey === "string" ? roomTone.sourceKey : "";
  if (roomTone?.enabled === true && toneSourceKey) {
    const sourceTrack = usable.find(track => keyOf(track) === toneSourceKey);
    if (sourceTrack) {
      const region = await readQuietestRegion(sourceTrack, {
        ...roomTone, sampleRate: sampleRateOfReference, requireDrop: false,
      });
      if (region?.usable) {
        sharedTone = { loop: region.loop, rms: region.rms, startFrame: region.startFrame };
        roomToneReports.push({
          key: toneSourceKey, usable: true, shared: true, rms: region.rms, startFrame: region.startFrame,
        });
      } else {
        roomToneReports.push({ key: toneSourceKey, usable: false, shared: true, reason: region?.reason || "unreadable" });
      }
    } else {
      roomToneReports.push({ key: toneSourceKey, usable: false, shared: true, reason: "本 take 里没有这条轨" });
    }
  }
  for (const track of usable) {
    const key = keyOf(track);
    if (key === keyOf(reference)) continue;
    const windowsForTrack = windows.get(key);
    if (!windowsForTrack) { skipped.push({ key, reason: "无法读取音频窗口" }); continue; }
    const drift = windowsForTrack.tail
      ? measureDriftFromWindows({
        referenceHead: referenceWindows.head,
        targetHead: windowsForTrack.head,
        referenceTail: referenceWindows.tail,
        targetTail: windowsForTrack.tail,
        tailStart,
        ...analysis,
      })
      : null;
    const fallback = drift ?? measureOffset(referenceWindows.head, windowsForTrack.head, analysis);
    // 波形匹配达标就用它的偏移，不达标照旧用原来的测量。
    // 两条路都保留在报告里：用户要能看出这条轨的偏移到底是谁给的、信不信。
    const waveformMatch = waveformMatches.get(key) || null;
    const waveformUsable = Boolean(waveformMatch && waveformMatch.reason === "ok" && waveformMatch.offsetSamples !== null);
    const measurement = waveformUsable
      ? { offsetSamples: waveformMatch.offsetSamples, ratio: 1, polarity: 1 }
      : fallback;
    if (waveformMatch) {
      waveformReports.push({
        key,
        usable: waveformUsable,
        reason: waveformMatch.reason,
        offsetSamples: waveformMatch.offsetSamples,
        confidence: waveformMatch.confidence,
      });
    }
    const plan = planFromMeasurement(referenceFrames, windowsForTrack.frames, measurement);
    if (!plan) { skipped.push({ key, reason: "测不出偏移" }); continue; }
    // 什么都不用改就不挂计划，让这条轨继续走原字节拷贝路径。
    // "对齐但提前停录"这种没有偏移、没有漂移、却短了一截的轨也算要改——
    // 它正是时长不一致里最常见的一类，尾部得补静音才算真修上。
    const needsWork = plan.needsResample || plan.needsOffset || plan.needsSubSample
      || plan.polarity === -1 || plan.padSamples > 0;
    if (!needsWork) {
      skipped.push({ key, reason: "无需修正" });
      continue;
    }
    // 房间声：只有真的要补白的轨才需要找素材——没有洞就没有要填的东西。
    let tone = null;
    if (roomTone?.enabled === true && plan.padSamples > 0) {
      // 每条要补白的轨都要扫一次：既是为了各轨各找时拿素材，
      // 也是为了共用底噪时量到本轨自己的噪声底（补白区的底噪要和内容里那条齐平，
      // 否则接缝处会听出"底噪换了一层"）。
      const region = await readQuietestRegion(track, { ...roomTone, sampleRate: sampleRateOfReference });
      if (region?.usable) {
        if (sharedTone) {
          // 共用底噪 + 宽带电平校正，限幅 ±6 dB：超过这个量就不是"底噪差了一点"，
          // 而是两处根本不是同一个空间的声场，该换素材而不是硬拉增益。
          const raw = sharedTone.rms > 0 ? region.rms / sharedTone.rms : 1;
          const gain = Math.max(0.5, Math.min(2, raw));
          tone = { loop: sharedTone.loop, rms: sharedTone.rms, startFrame: sharedTone.startFrame, gain };
          roomToneReports.push({
            key, usable: true, shared: true, gain, ownRms: region.rms, sharedRms: sharedTone.rms,
          });
        } else {
          tone = { loop: region.loop, rms: region.rms, startFrame: region.startFrame, gain: 1 };
          roomToneReports.push({
            key, usable: true, rms: region.rms, dropDb: region.dropDb, crest: region.crest, startFrame: region.startFrame,
          });
        }
      } else {
        roomToneReports.push({ key, usable: false, reason: region?.reason || "unreadable" });
      }
    }
    plans.set(key, {
      ...plan,
      roomTone: tone ?? undefined,
      ...(waveformMatch ? { waveform: waveformMatch } : {}),
    });
  }

  return {
    referenceKey: keyOf(reference),
    outputSamples: referenceFrames,
    plans,
    skipped,
    roomToneReports,
    waveformReports,
    referenceMatched: Boolean(matched),
  };
}