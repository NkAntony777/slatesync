// 波形同步：把 ISO 与摄影机原始声按波形对上。
//
// ## 为什么用包络，不用原始波形
//
// ISO 与摄影机原始声是同一现场的不同麦克风：波形细节必然不同（麦位不同、
// 频响不同，摄影机侧还过了 AGC / 降噪 / 压缩）。原始波形的互相关没有共同结构
// 可比，强行算出来的峰多半是频谱差异的产物。
//
// 真正被两路共同保留下来的信息是**能量包络**：谁在什么时候说话、有没有动作、
// 什么时候安静下来。包络去均值后形状一致，互相关才有意义。
//
// ## 输出为什么要做成那个形状
//
// 输出与 src/take-repair.js 的测量结果同形状（offsetSamples / ratio / polarity），
// 于是它能直接喂给现有的对齐修复管线：
//
//   matchWaveform → planFromMeasurement → 补白 / 重采样 / 极性 → 房间声 / 交叉淡化
//
// LTC 路径与波形路径因此**共用同一套下游**，区别只在于"偏移量从哪来"：
// LTC 是硬同步（置信度天然最高），波形是估出来的（必须给置信度）。
//
// ## 两条必须说清的边界
//
// - **波形同步给的是"某一刻"的偏移。** 录音机与摄影机的晶振不同，长时间会漂。
//   波形同步解决的是"起点对不上"，持续漂移仍然要靠 LTC（两端都有时码）来管。
// - **匹不准就不给结果。** 置信度不达门槛时返回 null，由调用方如实报告，
//   绝不硬凑一个偏移量——这与 LTC 的零误锁红线是同一条原则。
//
// ## 置信度由三件事决定
//
// - 段一致率：多个独立片段算出的偏移是否落在同一个值上；
// - 峰值突出度：最高峰比次高峰高多少（次高峰在最高峰邻域之外取）；
// - 片段能量：只有"响"的片段才拿来比，安静片段的信噪比不足以定位置。

/** 波形同步的默认参数。 */
export const WAVEFORM_SYNC_DEFAULTS = Object.freeze({
  // 参考里取多长的片段来比。片段越长越稳，但遇到"这段内容在别处也出现过"就越容易错。
  segmentSeconds: 2,
  // 片段之间的步进。
  segmentHopSeconds: 0.5,
  // 最多取多少个片段（按能量从高到低）。
  maxSegments: 12,
  // 包络的跳进步长与窗长（毫秒）。20/40 ms 是常见的语音包络参数。
  envelopeHopMs: 20,
  envelopeWindowMs: 40,
  // 精化阶段的包络步长与搜索半径（毫秒）。
  fineHopMs: 1,
  fineRadiusMs: 40,
  // 片段能量的相对下限：太安静的片段不拿来定位置。
  minSegmentEnergy: 1e-3,
  // 峰值突出度下限：最高峰 / 次高峰。1.35 意味着最高峰要比次高峰高 35%。
  minProminence: 1.35,
  // 段一致率下限。
  minAgreement: 0.55,
  // 允许多大的偏移（采样）。0 = 不限。
  maxOffsetSamples: 0,
});

/**
 * 能量包络：对平方信号做滑窗均方根，再按跳步降采样。
 *
 * 输出的长度约为 (samples.length - window) / hop + 1。
 */
export function computeEnvelope(samples, { sampleRate = 48000, hopMs = 20, windowMs = 40 } = {}) {
  if (!samples?.length) return new Float32Array(0);
  const hop = Math.max(1, Math.round(sampleRate * hopMs / 1000));
  const window = Math.max(hop, Math.round(sampleRate * windowMs / 1000));
  if (samples.length < window) return new Float32Array(0);
  const count = Math.floor((samples.length - window) / hop) + 1;
  const out = new Float32Array(count);
  let sum = 0;
  // 用"下一个写入位置"而不是"距离上次写入多久"：
  // 后者在第一次写入之前就被减成负数，之后再也不会回到 0，包络会全零。
  let nextWrite = window - 1;
  let writeIndex = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
    if (i >= window) {
      const old = samples[i - window];
      sum -= old * old;
    }
    if (i === nextWrite) {
      out[writeIndex++] = Math.sqrt(Math.max(0, sum) / window);
      nextWrite += hop;
    }
  }
  return out;
}

/** 去均值并按标准差归一化。包络非负，均值与方差归一后互相关才有可比性。 */
function normalizeEnvelope(envelope) {
  const out = new Float64Array(envelope.length);
  if (!envelope.length) return out;
  let mean = 0;
  for (const value of envelope) mean += value;
  mean /= envelope.length;
  let variance = 0;
  for (const value of envelope) variance += (value - mean) * (value - mean);
  variance /= envelope.length;
  const scale = variance > 0 ? 1 / Math.sqrt(variance) : 0;
  for (let i = 0; i < envelope.length; i++) out[i] = (envelope[i] - mean) * scale;
  return out;
}

/** 抛物线插值：把相关峰的整数位置细化成小数位置。 */
function parabolicPeak(values, index) {
  if (index <= 0 || index >= values.length - 1) return index;
  const left = values[index - 1];
  const center = values[index];
  const right = values[index + 1];
  const denominator = left - 2 * center + right;
  if (denominator === 0) return index;
  const shift = (0.5 * (left - right)) / denominator;
  if (!Number.isFinite(shift) || Math.abs(shift) > 1) return index;
  return index + shift;
}

/**
 * 在目标包络里滑动，找与参考片段最匹配的位置。
 *
 * 返回该位置的相关值、位置本身，以及次高峰（取最高峰邻域之外的最大值）——
 * 次高峰用来算突出度：最高峰和次高峰一样高，说明这段内容在别处也出现过，
 * 位置就不可信。
 */
function searchSegment(referenceSlice, targetEnv, from, to) {
  const length = referenceSlice.length;
  const width = to - from + 1;
  if (width <= 0 || length <= 0) return null;
  const values = new Float64Array(width);
  let best = -Infinity;
  let bestIndex = 0;
  for (let offset = from; offset <= to; offset++) {
    if (offset < 0 || offset + length > targetEnv.length) continue;
    let sum = 0;
    for (let i = 0; i < length; i++) sum += referenceSlice[i] * targetEnv[offset + i];
    values[offset - from] = sum;
    if (sum > best) {
      best = sum;
      bestIndex = offset;
    }
  }
  if (best === -Infinity) return null;
  // 次高峰：排除最高峰左右各 length/2 的邻域。
  const guard = Math.max(1, Math.floor(length / 2));
  let second = -Infinity;
  for (let i = 0; i < width; i++) {
    if (Math.abs(i - (bestIndex - from)) <= guard) continue;
    if (values[i] > second) second = values[i];
  }
  return { best, bestIndex, second, values, from };
}

import { planFromMeasurement } from "./take-repair.js";

/**
 * 把波形匹配的测量结果转成与 take-repair.js 完全同形状的修复计划。
 *
 * 这是"集大成"架构的关键一环：LTC 路径与波形路径产出同一种测量，
 * 下游（补白、重采样、极性、房间声、交叉淡化）就完全共用，
 * 区别只在"偏移量从哪来、置信度多高"。
 */
export function planFromWaveformMatch(match, referenceLength, targetLength) {
  if (!match) return null;
  const plan = planFromMeasurement(referenceLength, targetLength, {
    offsetSamples: match.offsetSamples,
    ratio: match.ratio ?? 1,
    polarity: match.polarity ?? 1,
  });
  if (!plan) return null;
  return { ...plan, confidence: match.confidence ?? null };
}

/**
 * 波形匹配。
 *
 * @param referenceSamples 参考声（摄影机原始声）
 * @param targetSamples    待测声（某条 ISO）
 * @returns 与 planFromMeasurement 同形状的测量，外加 confidence；不可信时返回 null。
 */
export function matchWaveform(referenceSamples, targetSamples, options = {}) {
  return analyzeWaveform(referenceSamples, targetSamples, options).measurement;
}

/**
 * 波形匹配，带完整诊断。
 *
 * 与 matchWaveform 的区别只在于：匹不准时**不丢信息**。
 * 返回 null 是对的，但"为什么没匹上"也得说得出口——
 * 界面与日志要能告诉用户"没匹上是内容不相关还是片段太少"，
 * 而不是只留一句"没同步上"。
 *
 * @returns { measurement, confidence, reason }
 */
export function analyzeWaveform(referenceSamples, targetSamples, options = {}) {
  const config = { ...WAVEFORM_SYNC_DEFAULTS, ...options };
  const sampleRate = Number(config.sampleRate) || 48000;
  if (!referenceSamples?.length || !targetSamples?.length) {
    return { measurement: null, confidence: null, reason: "no-signal" };
  }
  const refEnv = computeEnvelope(referenceSamples, {
    sampleRate, hopMs: config.envelopeHopMs, windowMs: config.envelopeWindowMs,
  });
  const tgtEnv = computeEnvelope(targetSamples, {
    sampleRate, hopMs: config.envelopeHopMs, windowMs: config.envelopeWindowMs,
  });
  // 精化阶段要更细的包络。读盘那层一趟就能算出两种分辨率；
  // 这里直接给原始采样，所以顺手把精细包络也准备好。
  const fine = {
    ref: computeEnvelope(referenceSamples, {
      sampleRate, hopMs: config.fineHopMs, windowMs: config.envelopeWindowMs,
    }),
    tgt: computeEnvelope(targetSamples, {
      sampleRate, hopMs: config.fineHopMs, windowMs: config.envelopeWindowMs,
    }),
  };
  return analyzeWaveformEnvelopes(refEnv, tgtEnv, { ...config, fine });
}

/**
 * 直接按包络匹配。
 *
 * 分出来是因为读盘那层要流式地算包络（整条轨读不进内存），
 * 算出来的包络直接喂进来，不必再把原始采样留在手上。
 */
export function analyzeWaveformEnvelopes(refEnv, tgtEnv, options = {}) {
  const config = { ...WAVEFORM_SYNC_DEFAULTS, ...options };
  const sampleRate = Number(config.sampleRate) || 48000;
  if (!refEnv?.length || !tgtEnv?.length) {
    return { measurement: null, confidence: null, reason: "no-signal" };
  }
  const segmentLength = Math.max(2, Math.round(config.segmentSeconds * 1000 / config.envelopeHopMs));
  if (refEnv.length < segmentLength * 2 || tgtEnv.length < segmentLength) {
    return { measurement: null, confidence: null, reason: "too-short" };
  }

  const refNorm = normalizeEnvelope(refEnv);
  const tgtNorm = normalizeEnvelope(tgtEnv);

  // 参考里的候选片段：按能量从高到低取前 N 个，且彼此不重叠。
  const segmentHop = Math.max(1, Math.round(config.segmentHopSeconds * 1000 / config.envelopeHopMs));
  const candidates = [];
  for (let start = 0; start + segmentLength <= refNorm.length; start += segmentHop) {
    let energy = 0;
    for (let i = 0; i < segmentLength; i++) energy += refNorm[start + i] * refNorm[start + i];
    energy = Math.sqrt(energy / segmentLength);
    if (energy < config.minSegmentEnergy) continue;
    candidates.push({ start, energy });
  }
  if (!candidates.length) {
    return { measurement: null, confidence: null, reason: "no-quiet-segment" };
  }
  candidates.sort((a, b) => b.energy - a.energy);

  // 逐片段在目标里找位置。偏移有上限时按上限裁剪搜索范围。
  const maxOffset = config.maxOffsetSamples > 0
    ? Math.round(config.maxOffsetSamples / sampleRate * 1000 / config.envelopeHopMs)
    : 0;
  const observations = [];
  for (const candidate of candidates) {
    if (observations.length >= config.maxSegments) break;
    const slice = refNorm.subarray(candidate.start, candidate.start + segmentLength);
    let from = 0;
    let to = tgtNorm.length - segmentLength;
    if (maxOffset > 0) {
      from = Math.max(0, candidate.start - maxOffset);
      to = Math.min(to, candidate.start + maxOffset);
    }
    if (to < from) continue;
    const hit = searchSegment(slice, tgtNorm, from, to);
    if (!hit) continue;
    observations.push({
      referenceStart: candidate.start,
      targetStart: hit.bestIndex,
      offset: hit.bestIndex - candidate.start,
      value: hit.best,
      second: hit.second,
      energy: candidate.energy,
    });
  }
  if (!observations.length) {
    return { measurement: null, confidence: null, reason: "no-observation" };
  }

  // 共识取**众数**而不是中位数。
  //
  // 有些片段在目标那侧根本没有对应内容（目标比参考早开机时，参考开头的一段就属这类），
  // 它们只能落到别处去。这些离群点会把中位数拖走，众数才是真正一致的那一簇。
  const tolerance = Math.max(1, Math.round(segmentLength / 4));
  const clusters = [];
  for (const item of observations) {
    let cluster = clusters.find(entry => Math.abs(entry.center - item.offset) <= tolerance);
    if (!cluster) {
      cluster = { center: item.offset, items: [] };
      clusters.push(cluster);
    }
    cluster.items.push(item);
  }
  clusters.sort((a, b) => b.items.length - a.items.length);
  const best = clusters[0];
  const agreed = best.items;
  const median = agreed.map(item => item.offset).sort((a, b) => a - b)[Math.floor(agreed.length / 2)];
  const agreement = agreed.length / observations.length;

  // 突出度：一致的那几段里"最高峰 / 次高峰"的中位数。
  const prominences = agreed
    .filter(item => Number.isFinite(item.second) && item.second > 0)
    .map(item => item.value / item.second)
    .sort((a, b) => a - b);
  const prominence = prominences.length ? prominences[Math.floor(prominences.length / 2)] : 0;

  const confidence = {
    segments: observations.length,
    agreed: agreed.length,
    agreement,
    prominence,
    score: Math.max(0, Math.min(1, agreement * Math.min(1, prominence / 2))),
    level: agreement >= 0.8 && prominence >= 2 ? "high"
      : agreement >= config.minAgreement && prominence >= config.minProminence ? "medium" : "low",
  };
  // 判据是两条证据的**组合**，不是两条各自独立的硬门槛。
  //
  // 一致率：多段独立片段是否指向同一个位置。
  // 突出度：单段的最高峰比次高峰高多少（内容是否在别处也出现过）。
  //
  // 多段高度一致时，次高峰的威胁就小了：真出现"同一段内容反复出现"，
  // 各段会挑到不同的重复位置，一致率自己会掉下来。所以高一致率可以放宽突出度，
  // 否则"目标比参考早开机、参考开头一段在目标里没有对应内容"这种正常场景会被误杀。
  const prominenceOk = prominence >= config.minProminence || agreement >= 0.9;
  if (agreement < config.minAgreement || !prominenceOk) {
    return {
      measurement: null,
      confidence,
      reason: agreement < config.minAgreement ? "low-agreement" : "low-prominence",
    };
  }

  // 精化：用更细的包络在共识位置附近再找一次，把精度从 20 ms 提到 1 ms 量级。
  const fineHopMs = config.fineHopMs;
  let offsetSamples = median * config.envelopeHopMs / 1000 * sampleRate;
  // 没有精细包络就只能停在粗分辨率（20 ms）——这时也不假装自己更准。
  const fineRef = config.fine?.ref ? normalizeEnvelope(config.fine.ref) : new Float32Array(0);
  const fineTgt = config.fine?.tgt ? normalizeEnvelope(config.fine.tgt) : new Float32Array(0);
  if (fineRef.length && fineTgt.length) {
    const fineLength = Math.max(2, Math.round(config.segmentSeconds * 1000 / fineHopMs));
    const fineSegmentStart = Math.round(observations[0].referenceStart * config.envelopeHopMs / fineHopMs);
    const start = Math.max(0, Math.min(fineRef.length - fineLength, fineSegmentStart));
    if (start + fineLength <= fineRef.length && fineTgt.length > fineLength) {
      const radius = Math.max(1, Math.round(config.fineRadiusMs / fineHopMs));
      // 中心是目标里的**绝对位置**：片段起点 + 位移。
      // 漏掉片段起点就会在目标的开头附近乱找，得到的还是粗结果。
      const centre = fineSegmentStart + Math.round(median * config.envelopeHopMs / fineHopMs);
      const hit = searchSegment(
        fineRef.subarray(start, start + fineLength), fineTgt,
        Math.max(0, centre - radius), Math.min(fineTgt.length - fineLength, centre + radius),
      );
      if (hit && hit.best > 0) {
        const peak = parabolicPeak(hit.values, hit.bestIndex - hit.from);
        const fineOffset = (hit.from + peak - start) * fineHopMs / 1000 * sampleRate;
        // 精化结果必须仍在共识附近，否则说明共识本身不稳，保留粗结果并降低置信度。
        const coarse = median * config.envelopeHopMs / 1000 * sampleRate;
        if (Math.abs(fineOffset - coarse) <= config.fineRadiusMs / 1000 * sampleRate * 2) {
          offsetSamples = fineOffset;
        } else {
          confidence.level = "low";
        }
      }
    }
  }

  // offsetSamples 的约定与 take-repair.js 一致：正数表示"target 的内容在文件里
  // 出现在后面"，也就是 target 比 reference 早开机（多出一段 pre-roll）。
  return {
    measurement: {
      offsetSamples: Math.round(offsetSamples),
      ratio: 1,
      polarity: 1,
      confidence,
    },
    confidence,
    reason: "ok",
  };
}
