// 房间声（room tone）提取、补白与等功率交叉淡化的纯计算核心。
//
// 为什么要有这一层：把补白从"写数字静音"换成"写现场房间声"是合板成品质感的分水岭。
// 人耳把绝对静音读成"掉轨"而不是"安静"——行业做法是拿现场专门录的房间声去填坑，
// 并在接缝处做等功率交叉淡化。出处见 docs/合板方案调研与算法升级建议.md 的 P0-1 / P0-2。
//
// 设计约束与仓库其余纯数据层一致：
// - 纯函数：不碰 DOM / 浏览器 API / 文件系统，可被 node --test 直接调用；
// - 绝不抛错：畸形输入只产出 null 或降级值，由调用方决定要不要用；
// - 绝不猜：判据不足就说判据不足，绝不用低置信结果去改音频。
//   这一条与 LTC 的"零误锁"红线同源：宁可留一段静音，也不填一段错的房间声。

/** 房间声与交叉淡化的默认参数。改这里，不要在调用方写死。 */
export const ROOM_TONE_DEFAULTS = Object.freeze({
  // 扫描阶段每块读多少秒用来估 RMS。
  blockSeconds: 0.5,
  // 扫描步长（秒）。步长大于块长意味着只读文件的一部分——一条 60 分钟的 ISO
  // 不该整条读进内存。代价是候选区间的估计有偏差，所以读出候选后还要复测。
  scanStrideSeconds: 1.0,
  // 每块实际读多少秒来估电平。抽样本来就是估计，候选区读出来还会复测，
  // 所以这里可以只读一小段：扫描的 I/O 直接降到十分之一。
  sampleSeconds: 0.1,
  // 房间声模板的目标长度（秒）。够长就不必循环补白，循环本身就是可听的重复。
  toneSeconds: 4.0,
  // 短于这个长度的候选直接判为不可用。
  minToneSeconds: 0.5,
  // 低于此电平（-60 dBFS）视为数字静音，不是房间声——补它等于什么都没补。
  silenceFloor: 0.001,
  // 候选区必须比整轨最响的一块至少低这么多 dB，否则它多半不是"安静区"而是别的。
  minDropDb: 12,
  // 波峰因数上限。房间声是噪声样的，波峰因数有界；一段带呼吸的低语音不是。
  maxCrest: 12,
  // 直流占比上限。直流偏置不是房间声：拿它补白等于在接缝处加一个台阶，
  // 还白白吃掉动态余量。噪声样的房间声均值接近 0。
  maxDcRatio: 0.5,
  // 模板自身循环时的交叉淡化长度（秒）。模板比补白长时根本用不到。
  loopCrossfadeSeconds: 0.25,
  // 内容与补白之间接缝的交叉淡化长度（秒）。
  crossfadeSeconds: 0.02,
});

/** 一段样本的 RMS。空数组按 0 处理。 */
export function rmsOf(samples) {
  if (!samples?.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** 一段样本的均值。用来判直流偏置。 */
export function meanOf(samples) {
  if (!samples?.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i];
  return sum / samples.length;
}

/** 一段样本的绝对峰值。 */
export function peakOf(samples) {
  if (!samples?.length) return 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i]);
    if (value > peak) peak = value;
  }
  return peak;
}

/**
 * 在逐块 RMS 序列里找能量最低的连续窗口。
 *
 * 用能量和（不是 dB 平均）比较：dB 平均会被极安静的块把整个窗口拉下来，
 * 于是"一块极静 + 一块很响"会误判成好区间，而那恰恰是最糟的候选。
 *
 * 返回 { start, end, rms }，start/end 是块下标（左闭右开）。
 */
export function findQuietestSpan(blockRms, windowBlocks = 1) {
  const values = Array.isArray(blockRms) ? blockRms.filter(value => Number.isFinite(value)) : [];
  const count = values.length;
  if (!count) return null;
  const width = Math.max(1, Math.min(Math.floor(windowBlocks) || 1, count));
  let sum = 0;
  for (let i = 0; i < width; i++) sum += values[i] * values[i];
  let best = { start: 0, end: width, rms: Math.sqrt(sum / width) };
  for (let i = width; i < count; i++) {
    sum += values[i] * values[i] - values[i - width] * values[i - width];
    const rms = Math.sqrt(sum / width);
    if (rms < best.rms) best = { start: i - width + 1, end: i + 1, rms };
  }
  return best;
}

/**
 * 把一段连续素材做成可以无缝循环的模板。
 *
 * 做法是经典的"交叉淡化循环"：把模板的头 F 个采样与尾 F 个采样等功率交叉淡化，
 * 拼在前面，循环长度缩成 L - F。这样：
 *   - 原来的接缝（尾 -> 头）被这 F 个采样的交叉淡化取代，不再有阶跃；
 *   - 新的首尾接缝落在模板中段相邻的两个采样上，本来就连续。
 *
 * 公式：out[j] = T[j]·sin(θ) + T[X+j]·cos(θ)，θ 从 0 走到 π/2，X = L - F。
 * 于是 out[0] = T[X]（纯尾）、out[F-1] = T[F-1]（纯头）、out[F..X) = T 原样。
 * 首尾相接时 out[X-1] = T[X-1] -> out[0] = T[X]，正好是 T 内部的相邻关系。
 */
export function buildSeamlessLoop(template, crossfadeSamples = 0) {
  if (!template?.length) return null;
  const fade = Math.max(0, Math.min(Math.floor(crossfadeSamples), Math.floor(template.length / 2)));
  const length = template.length - fade;
  if (length <= 0) return null;
  const out = new Float32Array(length);
  out.set(template.subarray(0, length), 0);
  if (fade > 0) {
    for (let j = 0; j < fade; j++) {
      const theta = (fade === 1 ? 1 : j / (fade - 1)) * (Math.PI / 2);
      out[j] = template[j] * Math.sin(theta) + template[length + j] * Math.cos(theta);
    }
  }
  return out;
}

/**
 * 从无缝模板里按任意（可以是小数的）帧位置取样，位置取模循环。
 * 小数位置做线性插值，免得补白本身带来额外的量化台阶。
 */
export function toneSampleAt(loop, frame) {
  if (!loop?.length) return 0;
  const length = loop.length;
  const position = ((frame % length) + length) % length;
  const index = Math.floor(position);
  const fraction = position - index;
  const current = loop[index];
  const next = loop[(index + 1) % length];
  return current * (1 - fraction) + next * fraction;
}

/**
 * 等功率交叉淡化的两个增益。
 *
 * 等增益（线性互补）在中点总增益是 0 dB，但人耳的响度感知是对数的，
 * 于是中点出现一个可闻的功率凹陷——对白轨这等于凭空开了一个洞。
 * 等功率（cos/sin 互补）在整个过渡里保持感知响度恒定，是行业对白的默认选择。
 *
 * position 从 0 到 length：0 时 a=1/b=0，length 时 a=0/b=1。
 */
export function equalPowerGains(position, length) {
  if (!(length > 0)) return { a: 1, b: 0 };
  const ratio = Math.max(0, Math.min(1, position / length));
  const theta = ratio * (Math.PI / 2);
  return { a: Math.cos(theta), b: Math.sin(theta) };
}

/**
 * 判一段候选素材能不能当房间声用。
 *
 * 三道闸门，缺一不可：
 * 1. 不是数字静音——否则补它等于没补；
 * 2. 足够安静（相对整轨最响的一块至少低 minDropDb）——否则多半不是安静区；
 * 3. 噪声样（波峰因数不超过 maxCrest）——一段带呼吸的低语音过不了这道。
 *
 * 任何一道不过都返回 usable:false 和一个可读的 reason，由调用方如实报告，
 * 绝不"差不多就行"地拿去改音频。
 */
export function evaluateToneCandidate({
  candidateRms,
  candidatePeak,
  candidateMean,
  loudestRms,
  silenceFloor = ROOM_TONE_DEFAULTS.silenceFloor,
  minDropDb = ROOM_TONE_DEFAULTS.minDropDb,
  maxCrest = ROOM_TONE_DEFAULTS.maxCrest,
  maxDcRatio = ROOM_TONE_DEFAULTS.maxDcRatio,
  requireDrop = true,
} = {}) {
  if (!Number.isFinite(candidateRms) || candidateRms <= 0) {
    return { usable: false, reason: "empty", dropDb: null, crest: null };
  }
  if (candidateRms < silenceFloor) {
    return { usable: false, reason: "digital-silence", dropDb: null, crest: null };
  }
  const crest = Number.isFinite(candidatePeak) && candidatePeak > 0 ? candidatePeak / candidateRms : Infinity;
  if (crest > maxCrest) {
    return { usable: false, reason: "not-noise-like", dropDb: null, crest };
  }
  // 直流偏置：均值相对 RMS 太大，说明这段几乎没有交流成分——不是房间声。
  const dcRatio = Number.isFinite(candidateMean) ? Math.abs(candidateMean) / candidateRms : 0;
  if (dcRatio > maxDcRatio) {
    return { usable: false, reason: "dc-offset", dropDb: null, crest, dcRatio };
  }
  let dropDb = null;
  if (Number.isFinite(loudestRms) && loudestRms > 0) {
    dropDb = 20 * Math.log10(loudestRms / candidateRms);
    if (requireDrop && dropDb < minDropDb) {
      return { usable: false, reason: "not-quiet-enough", dropDb, crest };
    }
  }
  return { usable: true, reason: "ok", dropDb, crest, dcRatio };
}

/**
 * 算内容区与补白区的边界，以及两端的交叉淡化窗口。
 *
 * 内容区是 [contentStart, contentEnd)（输出帧）。头尾两个淡化窗口都不得越界，
 * 也不得互相重叠：内容太短时按比例缩短，宁可不淡化也不让同一段内容被淡出两次。
 *
 * 只有真的存在补白区的那一端才给窗口——没有补白就没有接缝，硬加一个淡入
 * 只会让本来完好的轨凭空多一次起音变化。
 */
export function planCrossfadeRegions({
  contentStart,
  contentEnd,
  outputSamples,
  crossfadeSamples,
} = {}) {
  const start = Math.max(0, Math.round(Number(contentStart) || 0));
  const rawEnd = Math.round(Number(contentEnd) || 0);
  // 内容区末尾拿不准（无穷大）就不给窗口：不知道内容到哪结束，
  // 就没法保证淡化窗口不会伸进补白里去。
  const end = Math.max(start, Number.isFinite(rawEnd) ? rawEnd : start);
  // 输出总长拿不准时，尾部有没有补白就无从判断，于是只可能给头部窗口。
  const limit = Number.isSafeInteger(Number(outputSamples)) && Number(outputSamples) > 0
    ? Number(outputSamples)
    : end;
  if (!(end > start)) return { head: null, tail: null, samples: 0, contentStart: start, contentEnd: end };
  const wanted = Math.max(0, Math.round(Number(crossfadeSamples) || 0));
  const samples = Math.min(wanted, Math.floor((end - start) / 2));
  if (samples < 1) return { head: null, tail: null, samples: 0, contentStart: start, contentEnd: end };
  const head = start > 0 ? { start, end: Math.min(end, start + samples) } : null;
  const tail = end < limit ? { start: Math.max(start, end - samples), end } : null;
  return { head, tail, samples, contentStart: start, contentEnd: end };
}
