// Analysis-only gain. Never write this data back to the source file.
// Kept self-contained so the exact same function can run inside a Blob Worker.

// Single source of truth for every decoder threshold. Previously these were
// hardcoded in 5+ places across ltc-decoder.js / ltc-worker.js / ltc-diagnostics.js,
// which let the half-bit *estimator* and the half-bit *decoder* drift onto
// different decision thresholds. LTC_WORKER_CODE inlines this object verbatim,
// so main-thread and Worker arithmetic cannot diverge.
export const LTC_TUNING = {
  // Signal-level gates: a channel below these is not worth scanning.
  peakFloor: 0.035,
  p2pFloor: 0.07,
  // Sliding-window rejection of aperiodic material (dialogue, music, noise).
  edgeIntervalMin: 800,
  edgePlausibleMin: 700,
  edgePlausibleRatio: 0.72,
  // Hysteresis for zero-crossing detection. One shared set of coefficients is
  // used by the estimator and by the decoder so halfBitError compares like
  // with like; `floor` is the absolute deadband for very quiet material.
  hysteresis: { p2p: 0.06, rms: 0.14, floor: 0.004 },
  // Half-bit-period plausibility bounds, as multiples of the nominal half bit.
  minFps: 23.976,
  maxFps: 120,
  minHalfScale: 0.45,
  maxHalfScale: 2.4,
  // Half-bit error gates.
  halfBitError: { definitive: 0.00025, high: 0.0025, medium: 0.008, halfScoreSpan: 0.006 },
  // Quality tiers.
  quality: {
    highRank: 3, mediumRank: 2, lowRank: 1,
    highConfidence: 0.82, highFrames: 6, highReject: 0.08,
    mediumConfidence: 0.62, mediumFrames: 3, mediumReject: 0.2,
    lowSoftFrames: 4,
  },
  // Soft (error-correcting) sync path.
  soft: {
    frameMarginMin: 0.62,
    clusterMarginRun: 0.64,
    clusterMarginSolo: 0.72,
    syncErrorWeight: 0.65,
    syncPenaltyMax: 1.25,
    syncScoreScale: 4,
    maxErrors: 2,
    digitCostMax: 2,
    digitErrorsMax: 5,
    maxRunFrames: 6,
  },
  // Analysis-only normalisation.
  analysis: { rmsFloor: 1e-6, p2pFloor: 2e-6, gainCap: 8192, gainTargetPeak: 0.35, conditioningGainCap: 80 },
};

export function normalizeLtcAnalysisSignal(data, tuning = LTC_TUNING) {
  const root = tuning || LTC_TUNING;
  const T = root.analysis;
  let min = Infinity, max = -Infinity, sum = 0;
  for (const sample of data) {
    if (!Number.isFinite(sample)) return { data, analysisGain: 1, invalidSamples: true };
    min = Math.min(min, sample); max = Math.max(max, sample); sum += sample * sample;
  }
  if (!data.length) return { data, analysisGain: 1 };
  const peak = Math.max(Math.abs(min), Math.abs(max));
  const rms = Math.sqrt(sum / data.length);
  // Do not amplify digital silence, DC, or signals below a usable noise floor.
  if (rms < T.rmsFloor || max - min < T.p2pFloor || (peak >= root.peakFloor && max - min >= root.p2pFloor)) {
    return { data, analysisGain: 1 };
  }
  const gain = Math.min(T.gainCap, T.gainTargetPeak / Math.max(peak, T.rmsFloor));
  const normalized = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) normalized[i] = data[i] * gain;
  return { data: normalized, analysisGain: gain };
}

export function ltcFailureSummary(report = [], error = null) {
  if (error) return { code: "scan-error", message: `LTC 检测出错：${error.message || error}`, suggestion: "检查文件格式和音频完整性后重试" };
  const channels = report.flatMap(attempt => attempt.channelReports || []);
  const peak = Math.max(0, ...channels.map(channel => channel.peak || 0));
  const level = peak > 0 ? `${(20 * Math.log10(peak)).toFixed(1)} dBFS` : "无有效信号";
  if (channels.length && peak < LTC_TUNING.analysis.rmsFloor) return { code: "silent", message: "未检测到 LTC：已扫描音轨接近静音", suggestion: "确认 LTC 接入并录到了正确的声道；数字静音无法通过增益恢复" };
  if (channels.length && peak < LTC_TUNING.peakFloor) return { code: "low-level", message: `未锁定 LTC：原始峰值 ${level}，已尝试分析增益`, suggestion: "提高时码器输出/录音输入电平，确认没有混入对白；增益不能恢复被量化或噪声淹没的信息" };
  const reasons = new Set(channels.map(channel => channel.rejectReason));
  if (reasons.has("aperiodic") || reasons.has("few-ltc-edges")) return { code: "not-periodic", message: "未锁定 LTC：未找到足够连续、稳定的时码边沿", suggestion: "确认所选声道是 LTC 而非对白/音乐，并检查干扰、断续或削波" };
  return { code: "no-lock", message: `未锁定 LTC：没有足够连续的有效时码帧${channels.length ? `（峰值 ${level}）` : ""}`, suggestion: "核对帧率与 DF/NDF、LTC 声道及录制长度；可增强识别后人工复核，不要直接写入猜测结果" };
}
