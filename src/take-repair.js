// take 对齐与纠错（阶段 2：把"时长不一致"从不可合变成可合）
//
// 背景与算法出处见 docs/声音合板指南.md「对齐与纠错」一节：
// - GCC-PHAT 互相关（Knapp & Carter 1976）：互功率谱归一化后反变换，峰值位置即采样级时延。
//   实现参考 huangshincheng/rasberry-pi-with-respeaker 的 gcc_phat.py（Apache-2.0），此处用
//   自己的 radix-2 FFT 重写，避免把脚本依赖带进单文件构建。
// - 时钟漂移校正：首尾各测一次偏移，按 Ecasound 文档给的做法算漂移比再线性重采样
//   （salivity.github.io/ecasound/article/aligning-audio-clock-drift-with-ecasound）。
//
// 设计约束和项目既有风格一致：纯函数、无浏览器依赖、可单测；任何不确定一律返回 null，
// 由调用方决定是否使用——这里绝不替用户猜。

// ---------------------------------------------------------------- FFT

function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (inverse ? 2 : -2) * Math.PI / len;
    const stepRe = Math.cos(angle), stepIm = Math.sin(angle);
    for (let start = 0; start < n; start += len) {
      let wRe = 1, wIm = 0;
      for (let k = 0; k < half; k++) {
        const evenRe = re[start + k], evenIm = im[start + k];
        const oddRe = re[start + k + half], oddIm = im[start + k + half];
        const tRe = oddRe * wRe - oddIm * wIm;
        const tIm = oddRe * wIm + oddIm * wRe;
        re[start + k] = evenRe + tRe; im[start + k] = evenIm + tIm;
        re[start + k + half] = evenRe - tRe; im[start + k + half] = evenIm - tIm;
        const nextRe = wRe * stepRe - wIm * stepIm;
        wIm = wRe * stepIm + wIm * stepRe;
        wRe = nextRe;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function nextPow2(value) {
  let n = 1;
  while (n < value) n <<= 1;
  return n;
}

// Hann 窗：抑制截断处的频谱泄漏，否则互相关峰会偏。
function hannWindow(size) {
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  return window;
}

function windowed(signal, offset, size, window) {
  const out = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const value = signal[offset + i] ?? 0;
    out[i] = Number.isFinite(value) ? value * window[i] : 0;
  }
  return out;
}

// ---------------------------------------------------------------- 偏移测量

/**
 * 用 GCC-PHAT 求 target 相对 reference 的采样级时延。
 * 返回 { offsetSamples, polarity, peak }；信号不足以判别时返回 null（调用方必须显式处理）。
 * offsetSamples > 0 表示 target 的这段内容比 reference 晚 offsetSamples 个采样。
 */
export function measureOffset(reference, target, {
  sampleRate = 48000,
  analysisSeconds = 2,
  minCorrelation = 0.12,
  minPeakRatio = 8,
} = {}) {
  if (!reference?.length || !target?.length) return null;
  const size = nextPow2(Math.max(64, Math.floor(sampleRate * analysisSeconds)));
  if (reference.length < size || target.length < size) return null;
  const window = hannWindow(size);

  const refRe = windowed(reference, 0, size, window);
  const refIm = new Float64Array(size);
  const tgtRe = windowed(target, 0, size, window);
  const tgtIm = new Float64Array(size);
  fft(refRe, refIm, false);
  fft(tgtRe, tgtIm, false);

  const crossRe = new Float64Array(size);
  const crossIm = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const prodRe = refRe[i] * tgtRe[i] + refIm[i] * tgtIm[i];
    const prodIm = refIm[i] * tgtRe[i] - refRe[i] * tgtIm[i];
    const magnitude = Math.hypot(prodRe, prodIm);
    // eps 保底：整段静音时不能让 0/0 变成 NaN 污染整条互相关。
    const scale = 1 / (magnitude + 1e-12);
    crossRe[i] = prodRe * scale;
    crossIm[i] = prodIm * scale;
  }
  fft(crossRe, crossIm, true);

  // 在 [-size/2, size/2) 上找峰值——这是循环相关无歧义的全部时延范围。
  // 注意必须包含 lag = 0：完全对齐的素材峰值就落在数组下标 0，漏掉它会让最常见的
  // 「两轨本来就在同一起点」被判成测不出来。
  // R[k] = Σ ref[n+k]·tgt[n] 在 k = -d 处取峰，其中 d 是 target 比 reference 晚的采样数，
  // 所以对外一律报成"target 晚了多少个采样"（正数 = 晚），调用方补静音时不用再取负。
  const half = size >> 1;
  // 注意比较基准：用 Math.abs(bestValue) 做阈值时，初始 -Infinity 的绝对值是 Infinity，
  // 任何真实峰值都超不过它，扫描会永远不命中并一路返回 null。改用独立的绝对值基准。
  let bestLag = 0, bestValue = 0, bestAbs = -1, totalAbs = 0;
  for (let lag = -half; lag < half; lag++) {
    const value = crossRe[(lag + size) % size];
    const absolute = Math.abs(value);
    totalAbs += absolute;
    if (absolute > bestAbs) { bestAbs = absolute; bestValue = value; bestLag = lag; }
  }
  if (!Number.isFinite(bestValue)) return null;
  const peak = bestAbs;
  if (peak < minCorrelation) return null;

  // 峰值突出度：搜索区间有 size 个候选时，纯噪声也能撞出很高的最大值
  // （实测无关素材可达 0.78，和真实匹配的 0.99 靠绝对值根本分不开）。
  // 真正的匹配是一条尖锐的 delta，其余几乎为零；误匹配则是整体抬升的噪声。
  // 所以再要求峰值显著高于整条互相关的平均绝对值。
  const meanAbs = totalAbs / size;
  const peakRatio = meanAbs > 0 ? peak / meanAbs : 0;
  if (peakRatio < minPeakRatio) return null;

  // 抛物线插值取亚采样精度。
  const bestIndex = (bestLag + size) % size;
  const prev = crossRe[(bestIndex - 1 + size) % size];
  const next = crossRe[(bestIndex + 1) % size];
  const denominator = prev - 2 * bestValue + next;
  const shift = denominator !== 0 ? 0.5 * (prev - next) / denominator : 0;
  return {
    offsetSamples: -(bestLag + (Number.isFinite(shift) ? shift : 0)),
    polarity: bestValue < 0 ? -1 : 1,
    peak,
    peakRatio,
  };
}

/**
 * 窗口化漂移测量：只吃"头部窗口 + 尾部窗口"两段。
 *
 * 为什么要这一层：measureDrift 要整条 reference 在内存里才能算出 tailStart，
 * 而真实场景里一条 60 分钟的分轨是不该整个读进来的。这里把"哪一段是头、哪一段是尾、
 * 尾段在 reference 的第几个采样"交给调用方，算法本身与整条信号解耦。
 *
 * 返回形状与 measureDrift 一致，便于两条路径共用下游的修复计划逻辑。
 */
export function measureDriftFromWindows({
  referenceHead, targetHead, referenceTail, targetTail,
  tailStart, sampleRate = 48000, analysisSeconds = 2, maxDrift = 0.01,
}) {
  if (!referenceHead?.length || !targetHead?.length || !referenceTail?.length || !targetTail?.length) return null;
  if (!(tailStart > 0) || !Number.isFinite(tailStart)) return null;
  const head = measureOffset(referenceHead, targetHead, { sampleRate, analysisSeconds });
  if (!head) return null;
  const tail = measureOffset(referenceTail, targetTail, { sampleRate, analysisSeconds });
  if (!tail) return null;
  const ratio = 1 - (tail.offsetSamples - head.offsetSamples) / tailStart;
  if (!Number.isFinite(ratio) || Math.abs(ratio - 1) > maxDrift) return null;
  return {
    ratio,
    headOffsetSamples: head.offsetSamples,
    tailOffsetSamples: tail.offsetSamples,
    polarity: head.polarity === tail.polarity ? head.polarity : null,
  };
}

/**
 * 把一次偏移/漂移测量翻译成修复意图。纯算术，不碰音频，所以可以脱离 I/O 单测。
 * measurement 兼容 measureOffset（无 ratio）与 measureDrift 系（有 ratio）的两种形状。
 */
export function planFromMeasurement(referenceLength, targetLength, measurement) {
  if (!measurement) return null;
  const offsetSamples = measurement.headOffsetSamples ?? measurement.offsetSamples;
  if (!Number.isFinite(offsetSamples)) return null;
  const ratio = Number.isFinite(measurement.ratio) ? measurement.ratio : 1;
  const lead = -Math.round(offsetSamples);
  const length = Math.round(targetLength * ratio);
  // target 的有效内容占据输出的 [lead, lead + length) 这段帧区间，
  // 头部 [0, lead) 和尾部 [lead + length, referenceLength) 都没有源数据，需要补静音。
  // 写入层在越界处本来就会写静音，这里的 pad 只是把"要补多少"如实报出来。
  const headPad = Math.max(0, lead);
  const tailPad = Math.max(0, referenceLength - (lead + length));
  return {
    startSamples: Math.round(offsetSamples),
    leadSamples: lead,
    driftRatio: ratio,
    polarity: measurement.polarity ?? null,
    // skipSamples 是 lead 的推论，不是另一个独立修正量——wave-combine 取样时
    // 再减一次就会把 pre-roll 扣两遍。它只用于报告与一致性校验。
    skipSamples: Math.min(length, Math.max(0, -lead)),
    padSamples: headPad + tailPad,
    headPadSamples: headPad,
    tailPadSamples: tailPad,
    trimSamples: Math.max(0, lead + length - referenceLength),
    // 1e-5 = 0.001%。低于这个量级的是测量噪声不是时钟偏差：拿它去重采样整条轨
    // 只会白白损失音质，却换不来任何对齐收益。
    needsResample: Math.abs(ratio - 1) > 1e-5,
    needsOffset: Math.abs(lead) > 0.5,
  };
}

/**
 * 测量 target 相对 reference 的时钟漂移。
 * 做法：在头部与尾部各取一段互相关，得到两处偏移；两次偏移之差除以参考轨跨度即相对漂移。
 * 只有两处都测得出来才返回结果——一段测不出来就说明素材本身不足以支撑判断，返回 null。
 */
export function measureDrift(reference, target, {
  sampleRate = 48000,
  analysisSeconds = 2,
  tailGuardSeconds = 1,
  maxDrift = 0.01, // 1% 以内视为同一台机器的正常偏差，超过则不自动纠
} = {}) {
  // 窗口长度必须和 measureOffset 内部补齐后的 FFT 尺寸一致，否则切片比它要的短，
  // 头段会永远因为"长度不足"被判成测不出来。
  const windowSize = nextPow2(Math.max(64, Math.floor(sampleRate * analysisSeconds)));
  const span = reference.length - windowSize * 2 - Math.floor(sampleRate * tailGuardSeconds);
  if (span <= 0) return null;
  const tailStart = windowSize + span;
  if (target.length < tailStart + windowSize) return null;

  // 尾部窗口整体挪到 reference 的 tailStart 处；两边同一起点测量，测出的就是
  // 「reference 第 tailStart 个采样对应 target 的第几个采样」，差值即相对漂移。
  return measureDriftFromWindows({
    referenceHead: reference,
    targetHead: target,
    referenceTail: reference.subarray(tailStart, tailStart + windowSize),
    targetTail: target.subarray(tailStart, tailStart + windowSize),
    tailStart,
    sampleRate,
    analysisSeconds,
    maxDrift,
  });
}

// ---------------------------------------------------------------- 修复计划

/**
 * 针对一条 take 里某条分轨算出修正参数。测不出偏移时返回 null（无需修复）。
 * 返回值是"意图"，实际重采样/补静音由 wave-combine 执行，这样这里可以脱离 I/O 单测。
 *
 * 推导：设 target[k] = reference[k + lead]，lead 是 target 在下标空间里的"前导量"。
 * 对齐后输出第 n 帧要取 target[n - lead]，所以 target 的有效内容落在输出的
 * [max(0, lead), lead + length) 这段帧区间里。据此：
 *   lead > 0 → target 是 reference 去掉开头后的切片，即那台机器**晚开录**，前面补静音
 *   lead < 0 → target 开头多录了 pre-roll，那段在 reference 起点之前，丢掉
 *   length > reference.length - lead → 尾部多出来的内容要裁（默认只报告不真裁）
 * startSamples 沿用 measureOffset 的原始测量值（= -lead），方便和偏移报告对照。
 */
export function planTrackRepair(reference, target, options = {}) {
  const drift = measureDrift(reference, target, options);
  const offset = drift ?? measureOffset(reference, target, options);
  return planFromMeasurement(reference.length, target.length, offset);
}