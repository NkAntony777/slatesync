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

  const plans = new Map();
  const skipped = [];
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
    const plan = planFromMeasurement(referenceFrames, windowsForTrack.frames, fallback);
    if (!plan) { skipped.push({ key, reason: "测不出偏移" }); continue; }
    // 什么都不用改就不挂计划，让这条轨继续走原字节拷贝路径。
    // "对齐但提前停录"这种没有偏移、没有漂移、却短了一截的轨也算要改——
    // 它正是时长不一致里最常见的一类，尾部得补静音才算真修上。
    const needsWork = plan.needsResample || plan.needsOffset || plan.polarity === -1 || plan.padSamples > 0;
    if (!needsWork) {
      skipped.push({ key, reason: "无需修正" });
      continue;
    }
    plans.set(key, plan);
  }

  return {
    referenceKey: keyOf(reference),
    outputSamples: referenceFrames,
    plans,
    skipped,
    referenceMatched: Boolean(matched),
  };
}