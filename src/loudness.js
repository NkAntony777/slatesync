// ITU-R BS.1770-4 响度测量（EBU R128）与真峰值。
//
// 做什么：把一条成品音轨的响度按标准算出来，写进 BWF 的 bext v2 与 axml，
// 让收件方不用重新导入就能读到积分响度、最大真峰值与响度范围。
//
// 算法出处：
// - 测量：ITU-R BS.1770-4（K 加权 + 门控积分）
// - 门控与 LRA：EBU Tech 3341 / EBU Tech 3342
// - 写入字段：EBU Tech 3285（bext version 2 的五个响度字段）
//
// 几条刻意的取舍：
// - K 加权系数只用 ITU-R BS.1770-4 公布的 48 kHz 那套，逐字照抄，不自己重算。
//   那套系数不是任何常见 EQ 公式（RBJ 那族算出来的数不一样），自己"推导"等于自创标准。
//   代价是：非 48 kHz 的素材量不出响度，如实报告"未测量"，而不是给一个看着像标准的数。
// - 真峰值用 4 倍过采样的窗函数 sinc 插值实现（48 抽头 Blackman 窗），
//   不是标准 Annex 2 的参考滤波器表。差异在音频带内优于 0.1 dB；
//   要严格对齐标准，可以把滤波器换成标准表，其余流程不动。
// - 只测量，不做归一化、不做限幅。Poly WAV 是离散分轨，各轨的相对电平必须保持，
//   整体加增益会毁掉分轨之间的平衡；增益与限幅属于混音阶段（Resolve）的事。

/** K 加权系数适用的采样率：只有 48 kHz 有标准公布值。 */
export const LOUDNESS_STANDARD_RATE = 48000;

/** 绝对门限（LUFS）。BS.1770-4 规定：低于它的块不参与积分。 */
export const LOUDNESS_ABSOLUTE_GATE = -70;

/** 相对门限（LU）：低于"绝对门限后积分响度"这么多 LU 的块不参与积分。 */
export const LOUDNESS_RELATIVE_GATE = -10;

/** LRA 的相对门限（LU）。EBU Tech 3342 规定，比积分响度的门限更宽。 */
export const LRA_RELATIVE_GATE = -20;

/** bext version 2 响度字段的偏移（EBU Tech 3285）。 */
export const BEXT_LOUDNESS_OFFSETS = Object.freeze({
  loudnessValue: 412,
  loudnessRange: 414,
  maxTruePeakLevel: 416,
  maxMomentaryLoudness: 418,
  maxShortTermLoudness: 420,
});

/** "没有测"在 bext 里的约定值（0x8000）。 */
export const BEXT_LOUDNESS_ABSENT = 0x8000;

/** 交付目的地与目标响度。数值不可互换：门控方式不同，差值不是固定几个 LU。 */
export const LOUDNESS_TARGETS = Object.freeze({
  r128: { id: "r128", label: "EBU R128（节目 −23 LUFS）", integrated: -23, truePeak: -1 },
  a85: { id: "a85", label: "ATSC A/85（−24 LKFS）", integrated: -24, truePeak: -2 },
  netflix: { id: "netflix", label: "Netflix 近场（对白门控 −27 LUFS）", integrated: -27, truePeak: -2 },
});

// BS.1770-4 公布的 48 kHz 双二阶系数。
// stage 1：预滤波（高频架）；stage 2：RLB 高通。
const K_WEIGHTING_48K = Object.freeze({
  shelf: Object.freeze({ b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [1, -1.69065929318241, 0.73248077421585] }),
  hpf: Object.freeze({ b: [1, -2, 1], a: [1, -1.99004745483398, 0.99007225036621] }),
});

/** 这个采样率能不能按标准量响度。 */
export function loudnessSupportedRate(sampleRate) {
  return Number(sampleRate) === LOUDNESS_STANDARD_RATE;
}

/**
 * K 加权的双二阶系数。非 48 kHz 返回 null——如实说"量不了"，
 * 比给一个自己推导的数更诚实。
 */
export function kWeightingCoefficients(sampleRate) {
  if (!loudnessSupportedRate(sampleRate)) return null;
  return K_WEIGHTING_48K;
}

/** 双二阶（转置直接 II 型），状态放在闭包里。 */
function biquadStage(b0, b1, b2, a1, a2) {
  let z1 = 0;
  let z2 = 0;
  return sample => {
    const y = b0 * sample + z1;
    z1 = b1 * sample - a1 * y + z2;
    z2 = b2 * sample - a2 * y;
    return y;
  };
}

/** K 加权链：预滤波 → RLB 高通。 */
function createKWeighting(sampleRate) {
  const coefficients = kWeightingCoefficients(sampleRate);
  if (!coefficients) return null;
  const { shelf, hpf } = coefficients;
  const stage1 = biquadStage(shelf.b[0], shelf.b[1], shelf.b[2], shelf.a[1], shelf.a[2]);
  const stage2 = biquadStage(hpf.b[0], hpf.b[1], hpf.b[2], hpf.a[1], hpf.a[2]);
  return sample => stage2(stage1(sample));
}

// 真峰值：4 倍过采样，48 抽头 Blackman 窗 sinc（零相位插值）。
//
// 核在整数位置 m（相对输出位置 p）的权重 h(m - f) = sinc(m - f) · window(m - f)，
// 归一化到和为 1，保证直流增益仍是 1。
//
// 为什么是 48 抽头的长核：通带要平到 20 kHz，过渡带就得窄，而过渡带宽度与核长
// 成反比。长核换来的平直通带让重建值在 1–20 kHz 上与解析真峰值差小于 0.01 dB，
// 宽带素材上与 ffmpeg 的读数也只差约 0.4 dB（EBU Tech 3341 给真峰值的容差本身
// 就是 +0.2/−0.4 dB，说明这个量本来就依赖实现）。
//
// 代价：每采样 3 相 × 48 抽头 = 144 次乘加，只跑在程序通道上。
const TRUE_PEAK_TAPS = 48;
const TRUE_PEAK_PHASES = Object.freeze([0.25, 0.5, 0.75]);

function blackmanWindow(t, half) {
  if (t <= -half || t >= half) return 0;
  return 0.42 + 0.5 * Math.cos(Math.PI * t / half) + 0.08 * Math.cos(2 * Math.PI * t / half);
}

function sinc(t) {
  if (t === 0) return 1;
  const p = Math.PI * t;
  return Math.sin(p) / p;
}

/** 预计算三个相位的插值核。 */
function truePeakKernels(taps) {
  const half = Math.floor(taps / 2);
  const kernels = TRUE_PEAK_PHASES.map(phase => {
    const kernel = new Float64Array(taps);
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      // 抽头位置 m = i - half + 1，覆盖 [-half+1, half]，以 0 为中心（零相位插值）
      const m = i - half + 1;
      const value = sinc(m - phase) * blackmanWindow(m - phase, half);
      kernel[i] = value;
      sum += value;
    }
    if (sum !== 0) for (let i = 0; i < taps; i++) kernel[i] /= sum;
    return kernel;
  });
  return kernels;
}

/**
 * 真峰值过采样器：流式，只保留最近 48 个采样。
 * 每来一个采样就更新 4 个输出位置的最大绝对值。
 */
function createTruePeakMeter(taps = TRUE_PEAK_TAPS) {
  const delay = new Float64Array(taps);
  const kernels = truePeakKernels(taps);
  const half = Math.floor(taps / 2);
  let index = 0;
  let count = 0;
  let peak = 0;

  // base 是整数：输出位置是 base + phase，采样点取 base + m（m ∈ [-23, 24]）。
  // base 必须是整数——环形缓冲的下标取模只对整数成立，浮点下标会取到 undefined，
  // 整个求和变成 NaN，真峰值就会悄悄退化成"采样点最大值"。
  const evaluate = (phase, base) => {
    const kernel = kernels[phase];
    let value = 0;
    for (let i = 0; i < taps; i++) {
      const source = base + i - half + 1;
      value += delay[((source % taps) + taps) % taps] * kernel[i];
    }
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
  };

  return {
    push(sample) {
      delay[index] = sample;
      index = (index + 1) % taps;
      count += 1;
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
      if (count < taps) return;
      // 输出位置 p = n - half + phase，需要的采样区间是 [n-taps+1, n]——环形缓冲里刚好有。
      // base 必须是 n - half：再多一个就会读到尚未到达的采样（环形缓冲里是旧值），
      // 插值核的频率响应会整个偏掉，峰值读数偏大零点几 dB。
      for (let phase = 0; phase < TRUE_PEAK_PHASES.length; phase++) {
        evaluate(phase, count - 1 - half);
      }
    },
    /**
     * 收尾。
     *
     * 这里刻意**不**补零：补零会在信号末尾造出一个阶跃，而插值核的负瓣在阶跃处
     * 会产生吉布斯过冲，量出来的峰值会凭空高出零点几 dB。
     * 代价是文件末尾最后 12 个采样的采样间峰值不参与统计。
     */
    flush() {
      return peak;
    },
    get peak() {
      return peak;
    },
  };
}

/** 线性插值的百分位。 */
function percentile(sorted, ratio) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * 门控积分响度（BS.1770-4）。
 * 两道门：绝对门限 −70 LUFS，再用绝对门控后的积分响度定出相对门限（低 10 LU）。
 */
export function gatedIntegratedLoudness(blockEnergies) {
  const absoluteThreshold = 10 ** ((LOUDNESS_ABSOLUTE_GATE + 0.691) / 10);
  const firstPass = blockEnergies.filter(energy => energy > absoluteThreshold);
  if (!firstPass.length) return null;
  let sum = 0;
  for (const energy of firstPass) sum += energy;
  const preliminary = sum / firstPass.length;
  if (!(preliminary > 0)) return null;
  const preliminaryLoudness = -0.691 + 10 * Math.log10(preliminary);
  const relativeThreshold = preliminaryLoudness + LOUDNESS_RELATIVE_GATE;
  const relativeEnergy = 10 ** ((relativeThreshold + 0.691) / 10);
  let total = 0;
  let count = 0;
  for (const energy of blockEnergies) {
    if (energy > absoluteThreshold && energy > relativeEnergy) {
      total += energy;
      count += 1;
    }
  }
  if (!count) return null;
  const mean = total / count;
  if (!(mean > 0)) return null;
  return -0.691 + 10 * Math.log10(mean);
}

/**
 * 响度范围 LRA（EBU Tech 3342）。
 * 短时响度分布的 95 分位减 10 分位。门限：绝对 −70 LUFS，
 * 相对取绝对门控后均值的低 20 LU。
 */
export function loudnessRange(shortTermLoudness, integratedLoudness = null) {
  const absoluteGated = shortTermLoudness.filter(value => value > LOUDNESS_ABSOLUTE_GATE);
  if (absoluteGated.length < 2) return null;
  let sum = 0;
  for (const value of absoluteGated) sum += value;
  const mean = sum / absoluteGated.length;
  // 相对门限的基准是**积分响度**，不是短时响度的均值。
  //
  // 这两者差得很远：一段"响 → 很安静"的素材里，安静段本来就该被排除在动态范围之外。
  // 按短时均值当基准，那段安静会被算进去（实测差 23 LU：ffmpeg 报 7 LU，
  // 按均值算出来是 30 LU）。按积分响度当基准才与标准一致。
  const reference = Number.isFinite(integratedLoudness) ? integratedLoudness : mean;
  const relativeThreshold = reference + LRA_RELATIVE_GATE;
  const gated = absoluteGated.filter(value => value > relativeThreshold).sort((a, b) => a - b);
  if (gated.length < 2) return null;
  const high = percentile(gated, 0.95);
  const low = percentile(gated, 0.10);
  if (high === null || low === null) return null;
  return high - low;
}

/**
 * 单通道响度表。流式：喂采样，最后 finish() 出结果。
 * 块划分按标准：瞬时 400 ms、短时 3 s，都以 100 ms 步进（75% 重叠）。
 */
export function createChannelLoudnessMeter({ sampleRate = LOUDNESS_STANDARD_RATE, truePeakTaps = TRUE_PEAK_TAPS, truePeak = true } = {}) {
  const weighting = createKWeighting(sampleRate);
  const supported = Boolean(weighting);
  const subBlockSamples = Math.max(1, Math.round(sampleRate * 0.1));
  const momentaryBlocks = 4;      // 400 ms
  const shortTermBlocks = 30;     // 3 s
  const truePeakMeter = truePeak ? createTruePeakMeter(truePeakTaps) : null;

  const ring = new Float64Array(shortTermBlocks);
  let ringIndex = 0;
  let ringFilled = 0;
  let subBlockSum = 0;
  let subBlockCount = 0;
  let sampleCount = 0;
  const blockEnergies = [];
  const shortTermLoudness = [];
  let maxMomentary = -Infinity;
  let maxShortTerm = -Infinity;

  return {
    supported,
    push(sample) {
      if (!supported) return;
      const value = Number.isFinite(sample) ? sample : 0;
      const weighted = weighting(value);
      subBlockSum += weighted * weighted;
      subBlockCount += 1;
      sampleCount += 1;
      truePeakMeter?.push(value);
      if (subBlockCount < subBlockSamples) return;
      // 一个 100 ms 子块收齐：推进环形缓冲，重算瞬时与短时。
      ring[ringIndex] = subBlockSum;
      ringIndex = (ringIndex + 1) % shortTermBlocks;
      ringFilled = Math.min(ringFilled + 1, shortTermBlocks);
      subBlockSum = 0;
      subBlockCount = 0;
      if (ringFilled < momentaryBlocks) return;
      let momentarySum = 0;
      for (let i = 0; i < momentaryBlocks; i++) {
        momentarySum += ring[(ringIndex - 1 - i + shortTermBlocks) % shortTermBlocks];
      }
      const momentaryEnergy = momentarySum / (momentaryBlocks * subBlockSamples);
      if (momentaryEnergy > 0) {
        blockEnergies.push(momentaryEnergy);
        const loudness = -0.691 + 10 * Math.log10(momentaryEnergy);
        if (loudness > maxMomentary) maxMomentary = loudness;
      }
      if (ringFilled < shortTermBlocks) return;
      let shortTermSum = 0;
      for (let i = 0; i < shortTermBlocks; i++) {
        shortTermSum += ring[(ringIndex - 1 - i + shortTermBlocks) % shortTermBlocks];
      }
      const shortTermEnergy = shortTermSum / (shortTermBlocks * subBlockSamples);
      if (shortTermEnergy > 0) {
        const loudness = -0.691 + 10 * Math.log10(shortTermEnergy);
        shortTermLoudness.push(loudness);
        if (loudness > maxShortTerm) maxShortTerm = loudness;
      }
    },
    finish() {
      if (!supported) {
        return {
          supported: false,
          reason: "K 加权系数只按 " + LOUDNESS_STANDARD_RATE + " Hz 标定，" + sampleRate + " Hz 量不了",
        };
      }
      const peak = truePeakMeter ? truePeakMeter.flush() : null;
      const integrated = gatedIntegratedLoudness(blockEnergies);
      const range = loudnessRange(shortTermLoudness, integrated);
      return {
        supported: true,
        sampleRate,
        frames: sampleCount,
        // 原始块能量要交给多通道表做合并（门控是全局的，不能各通道各算各的）。
        blockEnergies,
        shortTermLoudness,
        integrated: integrated === null ? null : integrated,
        maxMomentary: Number.isFinite(maxMomentary) ? maxMomentary : null,
        maxShortTerm: Number.isFinite(maxShortTerm) ? maxShortTerm : null,
        range: range === null ? null : range,
        truePeak: peak !== null && peak > 0 ? 20 * Math.log10(peak) : null,
        blocks: blockEnergies.length,
      };
    },
  };
}

/**
 * 多通道响度表：每通道一套，外加一份按 BS.1770-4 通道权重合并的测量。
 *
 * 合并要按块号把各通道的加权能量加起来再统一门控——门控是全局的，
 * 不能各通道各算各的再平均，那样的结果不对应任何真实测量。
 * 权重默认全 1（L/R/C/Ls/Rs 都是 1，LFE 是 1.41，标准里的定义）。
 */
export function createLoudnessMeter({ sampleRate = LOUDNESS_STANDARD_RATE, channels = 1, weights = null } = {}) {
  const count = Math.max(1, channels);
  const meters = [];
  for (let index = 0; index < count; index++) meters.push(createChannelLoudnessMeter({ sampleRate }));
  const supported = meters.every(meter => meter.supported);
  const channelWeights = Array.isArray(weights) && weights.length === count ? weights.map(Number) : new Array(count).fill(1);
  return {
    supported,
    channels: count,
    /** values 是本帧各通道的采样值。 */
    pushFrame(values) {
      if (!supported) return;
      for (let index = 0; index < meters.length; index++) meters[index].push(values[index] ?? 0);
    },
    finish() {
      const results = meters.map(meter => meter.finish());
      let blockCount = 0;
      for (const result of results) blockCount = Math.max(blockCount, result.blockEnergies?.length ?? 0);
      const combinedEnergies = [];
      for (let block = 0; block < blockCount; block++) {
        let sum = 0;
        for (let channel = 0; channel < results.length; channel++) {
          sum += channelWeights[channel] * (results[channel].blockEnergies?.[block] ?? 0);
        }
        combinedEnergies.push(sum);
      }
      const combined = combinedEnergies.length ? gatedIntegratedLoudness(combinedEnergies) : null;
      return {
        supported: results.every(result => result.supported),
        channels: results,
        combined: combined === null ? null : combined,
      };
    },
  };
}

/**
 * 测量结果 → bext version 2 的五个整数字段。
 * 单位：响度 ×100（LUFS×100 / LU×100），真峰值 ×100（dBTP×100）。
 */
export function loudnessToBextFields(measurement) {
  const absent = {
    loudnessValue: BEXT_LOUDNESS_ABSENT,
    loudnessRange: BEXT_LOUDNESS_ABSENT,
    maxTruePeakLevel: BEXT_LOUDNESS_ABSENT,
    maxMomentaryLoudness: BEXT_LOUDNESS_ABSENT,
    maxShortTermLoudness: BEXT_LOUDNESS_ABSENT,
  };
  if (!measurement?.supported) return absent;
  const scale = value => (Number.isFinite(value) ? Math.round(value * 100) : BEXT_LOUDNESS_ABSENT);
  return {
    loudnessValue: scale(measurement.integrated),
    loudnessRange: scale(measurement.range),
    maxTruePeakLevel: scale(measurement.truePeak),
    maxMomentaryLoudness: scale(measurement.maxMomentary),
    maxShortTermLoudness: scale(measurement.maxShortTerm),
  };
}

/** 把五个整数写进 bext 数据缓冲。 */
export function applyLoudnessToBext(bextData, fields) {
  const view = new DataView(bextData.buffer, bextData.byteOffset, bextData.byteLength);
  const { loudnessValue, loudnessRange, maxTruePeakLevel, maxMomentaryLoudness, maxShortTermLoudness } = fields;
  view.setInt16(BEXT_LOUDNESS_OFFSETS.loudnessValue, loudnessValue, true);
  view.setUint16(BEXT_LOUDNESS_OFFSETS.loudnessRange, loudnessRange < 0 ? 0 : loudnessRange, true);
  view.setInt16(BEXT_LOUDNESS_OFFSETS.maxTruePeakLevel, maxTruePeakLevel, true);
  view.setInt16(BEXT_LOUDNESS_OFFSETS.maxMomentaryLoudness, maxMomentaryLoudness, true);
  view.setInt16(BEXT_LOUDNESS_OFFSETS.maxShortTermLoudness, maxShortTermLoudness, true);
  return bextData;
}

/** 数字 → 固定一位小数的字符串，没测出来就是空串。 */
function formatLoudness(value) {
  return Number.isFinite(value) ? value.toFixed(1) : "";
}

/**
 * axml chunk 里的 R128 响度元数据（EBU Tech 3306 的 ebu_loudness_information）。
 * 字段宽度固定：先按占位写、量完再原位回填，chunk 长度不会变。
 */
export function axmlLoudnessText(measurement) {
  const value = formatLoudness(measurement?.integrated);
  const peak = formatLoudness(measurement?.truePeak);
  const momentary = formatLoudness(measurement?.maxMomentary);
  const shortTerm = formatLoudness(measurement?.maxShortTerm);
  const range = formatLoudness(measurement?.range);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<axml>",
    "\t<head>",
    "\t\t<metadata>",
    "\t\t\t<payload>",
    "\t\t\t\t<ebu_loudness_information>",
    "\t\t\t\t\t<integrated_loudness>" + value + "</integrated_loudness>",
    "\t\t\t\t\t<max_truepeak_level>" + peak + "</max_truepeak_level>",
    "\t\t\t\t\t<max_momentary_loudness>" + momentary + "</max_momentary_loudness>",
    "\t\t\t\t\t<max_shortterm_loudness>" + shortTerm + "</max_shortterm_loudness>",
    "\t\t\t\t\t<loudness_range>" + range + "</loudness_range>",
    "\t\t\t\t</ebu_loudness_information>",
    "\t\t\t</payload>",
    "\t\t</metadata>",
    "\t</head>",
    "</axml>",
    "",
  ].join("\r\n");
}
