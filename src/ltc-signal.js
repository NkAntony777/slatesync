// Analysis-only gain. Never write this data back to the source file.
// Kept self-contained so the exact same function can run inside a Blob Worker.
export function normalizeLtcAnalysisSignal(data) {
  let min = Infinity, max = -Infinity, sum = 0;
  for (const sample of data) {
    if (!Number.isFinite(sample)) return { data, analysisGain: 1, invalidSamples: true };
    min = Math.min(min, sample); max = Math.max(max, sample); sum += sample * sample;
  }
  if (!data.length) return { data, analysisGain: 1 };
  const peak = Math.max(Math.abs(min), Math.abs(max));
  const rms = Math.sqrt(sum / data.length);
  // Do not amplify digital silence, DC, or signals below a usable noise floor.
  if (rms < 1e-6 || max - min < 2e-6 || (peak >= 0.035 && max - min >= 0.07)) {
    return { data, analysisGain: 1 };
  }
  const gain = Math.min(8192, 0.35 / Math.max(peak, 1e-6));
  const normalized = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) normalized[i] = data[i] * gain;
  return { data: normalized, analysisGain: gain };
}

export function ltcFailureSummary(report = [], error = null) {
  if (error) return { code: "scan-error", message: `LTC 检测出错：${error.message || error}`, suggestion: "检查文件格式和音频完整性后重试" };
  const channels = report.flatMap(attempt => attempt.channelReports || []);
  const peak = Math.max(0, ...channels.map(channel => channel.peak || 0));
  const level = peak > 0 ? `${(20 * Math.log10(peak)).toFixed(1)} dBFS` : "无有效信号";
  if (channels.length && peak < 1e-6) return { code: "silent", message: "未检测到 LTC：已扫描音轨接近静音", suggestion: "确认 LTC 接入并录到了正确的声道；数字静音无法通过增益恢复" };
  if (channels.length && peak < 0.035) return { code: "low-level", message: `未锁定 LTC：原始峰值 ${level}，已尝试分析增益`, suggestion: "提高时码器输出/录音输入电平，确认没有混入对白；增益不能恢复被量化或噪声淹没的信息" };
  const reasons = new Set(channels.map(channel => channel.rejectReason));
  if (reasons.has("aperiodic") || reasons.has("few-ltc-edges")) return { code: "not-periodic", message: "未锁定 LTC：未找到足够连续、稳定的时码边沿", suggestion: "确认所选声道是 LTC 而非对白/音乐，并检查干扰、断续或削波" };
  return { code: "no-lock", message: `未锁定 LTC：没有足够连续的有效时码帧${channels.length ? `（峰值 ${level}）` : ""}`, suggestion: "核对帧率与 DF/NDF、LTC 声道及录制长度；可增强识别后人工复核，不要直接写入猜测结果" };
}
