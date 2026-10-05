import { ltcFailureSummary } from "./ltc-signal.js";
const STANDARD_RATES = [
  { value: "23.976", rate: 24000 / 1001 },
  { value: "24", rate: 24 },
  { value: "25", rate: 25 },
  { value: "29.97", rate: 30000 / 1001 },
  { value: "30", rate: 30 },
  { value: "48", rate: 48 },
  { value: "50", rate: 50 },
  { value: "59.94", rate: 60000 / 1001 },
  { value: "60", rate: 60 },
  { value: "96", rate: 96 },
  { value: "100", rate: 100 },
  { value: "119.88", rate: 120000 / 1001 },
  { value: "120", rate: 120 },
];

const LTC_BITS_PER_FRAME = 80;
const BIPHASE_HALVES_PER_BIT = 2;

export function dbfs(value) {
  if (!Number.isFinite(value) || value <= 0) return "-∞";
  const db = 20 * Math.log10(value);
  return db <= -99 ? "-∞" : db.toFixed(1);
}

export function secondsOf(samples, sampleRate) {
  if (!Number.isFinite(samples) || !sampleRate) return 0;
  return samples / sampleRate;
}

export function impliedFpsFromHalfBit(halfBitSamples, sampleRate) {
  if (!halfBitSamples || !sampleRate) return null;
  return sampleRate / (halfBitSamples * LTC_BITS_PER_FRAME * BIPHASE_HALVES_PER_BIT);
}

export function nearestStandardFps(implied) {
  if (!implied) return null;
  let best = null;
  for (const entry of STANDARD_RATES) {
    const error = Math.abs(entry.rate - implied) / entry.rate;
    if (!best || error < best.error) best = { ...entry, error };
  }
  return best;
}

function channelKey(record, channelIndex) {
  return `${record.relativePath || record.name}#${channelIndex}`;
}

function collectChannels(report) {
  const channels = new Map();
  for (const attempt of report || []) {
    for (const info of attempt.channelReports || []) {
      const key = channelKey(attempt.record, info.channelIndex);
      const existing = channels.get(key);
      if (existing && existing.pass === "full" && attempt.pass === "fast") continue;
      channels.set(key, {
        ...info,
        pass: attempt.pass,
        record: attempt.record,
        recordName: attempt.record?.name || "",
      });
    }
  }
  return Array.from(channels.values());
}

function appendUnscannedChannels(channels, groupRecords, report) {
  const scanned = new Set((report || []).map(attempt => attempt.record));
  for (const record of groupRecords || []) {
    if (scanned.has(record)) continue;
    for (let i = 0; i < (record.channels || 1); i++) {
      channels.push({
        record,
        recordName: record.name || "",
        channelIndex: i,
        channelLabel: `${i + 1}`,
        rejectReason: null,
        scanned: false,
        pass: "none",
        candidateCount: 0,
      });
    }
  }
  return channels;
}

function collectCandidates(report) {
  const out = [];
  for (const attempt of report || []) {
    for (const candidate of attempt.candidates || []) {
      out.push({ ...candidate, record: attempt.record, recordName: attempt.record?.name || "" });
    }
  }
  return out;
}

const REJECT_TEXT = {
  "level": "电平过低/接近无声",
  "window-level": "滤波后电平过低",
  "short": "文件太短",
  "few-ltc-edges": "信号边沿太少，不像 LTC",
  "aperiodic": "信号无周期脉冲特征（普通音频/噪声）",
};

export function channelVerdict(info) {
  if (!info || info.pass === "none") return { code: "unscanned", label: "未扫描", detail: "已在其他轨找到 LTC 或未检测" };
  if (info.candidateCount > 0) return { code: "ltc", label: "含 LTC 候选", detail: "" };
  if (info.rejectReason) {
    return {
      code: info.rejectReason,
      label: REJECT_TEXT[info.rejectReason] || info.rejectReason,
      detail: `峰值 ${dbfs(info.peak)} dBFS`,
    };
  }
  if (info.scanned) return { code: "scanned-fail", label: "已扫描但未锁定", detail: `峰值 ${dbfs(info.peak)} dBFS` };
  return { code: "skipped", label: "未深扫", detail: `峰值 ${dbfs(info.peak)} dBFS` };
}

function structuralIssues(groupRecords) {
  const issues = [];
  if (!groupRecords || groupRecords.length < 2) return issues;
  const durations = groupRecords.map(record => Number(record.durationSamples) / record.sampleRate);
  const min = Math.min(...durations);
  const max = Math.max(...durations);
  if (max - min > 0.02) {
    issues.push({
      severity: "error",
      code: "duration-mismatch",
      title: "分轨时长不一致",
      detail: `最短 ${min.toFixed(2)}s，最长 ${max.toFixed(2)}s，差 ${(max - min).toFixed(2)}s；这样的 take 无法合并为 Poly WAV`,
      suggestions: [
        "检查该 take 是否有分轨文件缺失、被中断或未完整拷贝",
        "确认所有分轨确实属于同一个 take（文件名主干应一致）",
      ],
    });
  }
  const formats = new Set(groupRecords.map(record => `${record.sampleRate}/${record.bitsPerSample}/${record.audioFormat}`));
  if (formats.size > 1) {
    issues.push({
      severity: "error",
      code: "format-mismatch",
      title: "分轨音频参数不一致",
      detail: `同组文件采样率/位深/格式不同（${Array.from(formats).join("、")}），无法直接合并`,
      suggestions: ["检查是否混入了其他录音批次或其他设备的文件"],
    });
  }
  const noBext = groupRecords.filter(record => !record._video && record.hasBext === false);
  if (noBext.length) {
    issues.push({
      severity: "info",
      code: "no-bext",
      title: "部分文件缺少 bext chunk",
      detail: `${noBext.map(record => record.name).join("、")} 没有 Broadcast Wave 扩展块`,
      suggestions: ["不影响：写入时码时会自动补建 bext chunk"],
    });
  }
  return issues;
}

function describeChannelProblems(channels) {
  const lines = [];
  for (const info of channels) {
    const verdict = channelVerdict(info);
    lines.push(`${info.recordName} ch${info.channelLabel}：${verdict.label}（${verdict.detail || "无电平"}）`);
  }
  return lines;
}

function undetectedIssues({ report, groupRecords, detectError, fpsValue, fpsLabel }) {
  const issues = [];
  const channels = collectChannels(report);
  const candidates = collectCandidates(report);
  if (!detectError && channels.length && channels.every(info => (info.peak || 0) < 0.035)) {
    const failure = ltcFailureSummary(report);
    issues.push({ severity: "error", code: failure.code, title: failure.message,
      detail: "已尝试分析增益但未能稳定锁帧；不把猜测结果写入文件", suggestions: [failure.suggestion] });
  }

  if (detectError) {
    issues.push({
      severity: "error",
      code: "scan-error",
      title: "检测过程出错",
      detail: detectError,
      suggestions: ["文件可能损坏或格式不支持，尝试用其他工具检查该文件"],
    });
  }

  if (!channels.length) {
    issues.push({
      severity: "error",
      code: "not-scanned",
      title: "未能扫描音频",
      detail: "该组没有可分析的音轨数据",
      suggestions: ["确认文件是有效的 WAV/视频文件", "重新载入素材再试"],
    });
    return issues;
  }

  if (candidates.length) {
    const best = candidates.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
    issues.push({
      severity: "warn",
      code: "weak-candidates",
      title: "有疑似 LTC 信号但未通过稳定性校验",
      detail: `最好结果：${best.recordName} ch${best.channelLabel} ${best.timecode} @${best.fpsLabel || best.fpsValue}，置信度 ${Math.round((best.confidence || 0) * 100)}%，仅锁定 ${best.lockedFrames} 帧`,
      suggestions: [
        "选中该 take 后点「增强识别选中项」用兜底算法重试",
        "信号可能存在中断/干扰，若重试仍失败需人工核对",
      ],
    });
  }

  const silent = channels.filter(info => ["level", "window-level", "short"].includes(info.rejectReason) || (info.peak || 0) < 0.02);
  const clipped = channels.filter(info => (info.clippedRatio || 0) > 0.01);
  const estimated = channels.filter(info => info.halfBitEstimate);
  const scannedNoLock = channels.filter(info => info.scanned && !info.candidateCount && !info.rejectReason);
  const notLtc = channels.filter(info => info.rejectReason === "aperiodic" && !info.halfBitEstimate);
  const sparse = channels.filter(info => info.rejectReason === "few-ltc-edges");

  if (silent.length === channels.length) {
    issues.push({
      severity: "error",
      code: "all-silent",
      title: "所有轨道都没有可用 LTC 信号",
      detail: `全部 ${channels.length} 个声道电平过低或无声：${describeChannelProblems(channels).join("；")}`,
      suggestions: [
        "确认时码器在拍摄时已接入并正常工作（该 take 可能根本没录到 TC 轨）",
        "若现场确实没录 TC：用「偏移时间码」按场记/打板手动校正，或导出手动合板",
      ],
    });
  } else if (estimated.length) {
    const coverage = info => {
      const durSamples = Number(info.record?.durationSamples || 0);
      const windowLen = Math.min(4 * (info.record?.sampleRate || 48000), durSamples || Infinity);
      return info.halfBitEstimate.count * info.halfBitEstimate.halfBitSamples / Math.max(1, windowLen);
    };
    const reliable = estimated.filter(info =>
      info.halfBitEstimate.jitter <= 0.05 && info.halfBitEstimate.count >= 1500 && coverage(info) >= 0.35
    );
    const noisy = estimated.filter(info => !reliable.includes(info));
    for (const info of reliable) {
      const sampleRate = info.record?.sampleRate;
      const implied = impliedFpsFromHalfBit(info.halfBitEstimate.halfBitSamples, sampleRate);
      const nearest = nearestStandardFps(implied);
      if (nearest && nearest.error < 0.08 && nearest.rate <= 60) {
        issues.push({
          severity: "warn",
          code: "near-standard-fps",
          title: `${info.recordName} ch${info.channelLabel} 有周期性信号，接近 ${nearest.value}fps LTC`,
          detail: `实测码率约 ${implied?.toFixed(3)}fps（与 ${nearest.value} 差 ${(nearest.error * 100).toFixed(1)}%），但未能稳定解码${fpsValue && nearest.value !== fpsValue.replace("df", "") ? `；注意当前界面帧率为 ${fpsLabel || fpsValue}` : ""}`,
          suggestions: [
            `将左上角帧率切换为 ${nearest.value} 后重新提取`,
            "或选中该 take 使用「增强识别选中项」",
            "检查该轨电平是否过低/削波",
          ],
        });
      } else {
        issues.push({
          severity: "warn",
          code: "non-standard-periodic",
          title: `${info.recordName} ch${info.channelLabel} 有周期信号但不符合标准 LTC 帧率`,
          detail: `实测码率约 ${implied?.toFixed(3)}fps，与所有标准帧率偏差 >8%（抖动 ${(info.halfBitEstimate.jitter * 100).toFixed(1)}%）`,
          suggestions: [
            "可能是变速/降级导出的音频，或非 LTC 周期信号（如电机嗡嗡声）",
            "若文件经过转码/变调，需要原始录音文件",
          ],
        });
      }
    }
    if (!reliable.length && noisy.length) {
      issues.push({
        severity: "info",
        code: "unstable-periodic",
        title: "存在周期信号但抖动过大，不像稳定 LTC",
        detail: noisy.map(info => `${info.recordName} ch${info.channelLabel}（抖动 ${(info.halfBitEstimate.jitter * 100).toFixed(0)}%）`).join("、"),
        suggestions: ["更像普通音频/噪声——确认 TC 实际接入了哪一路"],
      });
    }
    if (!reliable.length) {
      issues.push({
        severity: "error",
        code: "no-ltc-content",
        title: "没有找到可信的 LTC 特征信号",
        detail: describeChannelProblems(channels.slice(0, 8)).join("；"),
        suggestions: [
          "确认时码器当时接的是哪一路输入",
          "若这批素材没有录 TC：改用「偏移时间码」按打板点手动校正",
        ],
      });
    }
  } else if (scannedNoLock.length) {
    issues.push({
      severity: "warn",
      code: "scanned-no-lock",
      title: "信号疑似 LTC 但解码失败",
      detail: describeChannelProblems(scannedNoLock).join("；"),
      suggestions: [
        "选中该 take 点「增强识别选中项」用兜底算法重试",
        "若仍失败：电平可能过低或信号失真，检查原始 TC 轨",
      ],
    });
  } else {
    issues.push({
      severity: "error",
      code: "no-ltc-content",
      title: "没有找到 LTC 特征信号",
      detail: `${describeChannelProblems(channels.slice(0, 8)).join("；")}${channels.length > 8 ? ` 等 ${channels.length} 轨` : ""}`,
      suggestions: [
        "这些轨听起来是普通音频——确认时码器当时接的是哪一路输入",
        "ZOOM H8 上 TC 常接在输入 5/6 或 LR 轨；检查该 take 文件夹是否遗漏了 TC 轨文件",
        "若这批素材没有录 TC：改用「偏移时间码」按打板点手动校正",
      ],
    });
  }

  if (clipped.length) {
    issues.push({
      severity: "warn",
      code: "clipped-signal",
      title: "部分轨信号削波",
      detail: `${clipped.map(info => `${info.recordName} ch${info.channelLabel}`).join("、")} 出现削波（|s|>0.98 占比 ${(Math.max(...clipped.map(info => info.clippedRatio)) * 100).toFixed(1)}%）`,
      suggestions: ["削波会压平 LTC 翻转沿导致解码失败——录音时降低时码器输出电平"],
    });
  }
  if (notLtc.length && silent.length && silent.length < channels.length) {
    issues.push({
      severity: "info",
      code: "mixed-channels",
      title: "部分轨是普通音频、部分轨静默",
      detail: `${silent.length} 轨静默，${notLtc.length} 轨为非周期信号`,
      suggestions: ["如果时码器确认接过但全部 take 都无 LTC，可能录到了错误的输入或线路电平被压掉"],
    });
  }
  if (sparse.length && !estimated.length) {
    issues.push({
      severity: "info",
      code: "sparse-signal",
      title: "部分轨信号边沿太少",
      detail: sparse.map(info => `${info.recordName} ch${info.channelLabel}`).join("、"),
      suggestions: ["LTC 需要持续不断的信号——检查 TC 轨是否只录到了开头一小段"],
    });
  }
  return issues;
}

function detectedIssues({ detected, record, fpsValue, channels }) {
  const issues = [];
  if (detected.analysisGain > 1) {
    issues.push({
      severity: "warn", code: "recovered-low-level", title: "低电平 LTC 已通过分析增益恢复",
      detail: `原始峰值 ${dbfs(detected.rawPeak)} dBFS；仅分析增益 +${(20 * Math.log10(detected.analysisGain)).toFixed(1)} dB，源音频未放大`,
      suggestions: ["与拍板/摄影机时码交叉复核后再写入", "后续录制提高 LTC 输出或输入电平；增益不能改善原始信噪比"],
    });
  }

  const sampleRate = record?.sampleRate || detected.sourceRecord?.sampleRate || 48000;
  const sourceInfo = (channels || []).find(info =>
    info.record === detected.sourceRecord && info.channelIndex === detected.channelIndex
  ) || (channels || []).find(info => info.channelIndex === detected.channelIndex);
  const confidence = detected.confidence || 0;
  const rank = detected.qualityRank || 1;

  if (rank <= 1 || confidence < 0.6) {
    issues.push({
      severity: "warn",
      code: "low-quality",
      title: "识别质量低，结果需要人工复核",
      detail: `置信度 ${Math.round(confidence * 100)}%，连续锁定 ${detected.lockedFrames} 帧${detected.softSync ? "（兜底算法）" : ""}`,
      suggestions: [
        "选中该 take 用「增强识别选中项」复核",
        "与场记单/其他机位时码交叉核对后再写入",
        "若 TC 电平太低，下一 take 提高时码器输出电平",
      ],
    });
  }
  if (detected.dropMismatch) {
    issues.push({
      severity: "warn",
      code: "drop-mismatch",
      title: "LTC 的 DF/NDF 标记与所选帧率不符",
      detail: `音轨里的 drop-frame 标志位与 ${fpsValue || "?"} 设置不一致`,
      suggestions: [
        "确认摄影机与时码器的 DF/NDF 设置一致，否则与视频合板会差帧",
        "以摄影机/时码器实际输出为准选择帧率",
      ],
    });
  }
  if (detected.fpsValue && fpsValue && detected.fpsValue !== fpsValue) {
    issues.push({
      severity: "info",
      code: "fps-autodetected",
      title: `LTC 实际帧率识别为 ${detected.fpsLabel || detected.fpsValue}`,
      detail: `与界面所选 ${fpsValue} 不同（已自动采用检测结果）`,
      suggestions: ["确认该帧率与摄影机一致"],
    });
  }
  const ltcStart = secondsOf(detected.sampleOffset, sampleRate);
  if (ltcStart > 1) {
    issues.push({
      severity: "info",
      code: "late-start",
      title: `LTC 信号在文件第 ${ltcStart.toFixed(1)} 秒才出现`,
      detail: "文件开头没有 TC 信号；已用该位置倒推出文件起始时码",
      suggestions: [
        "现场 TC 中途才接入属正常情况",
        "若开头就应有时码，检查该结果是否正确（可能在噪声上误锁）",
      ],
    });
  }
  if ((detected.rejectRatio || 0) > 0.1) {
    issues.push({
      severity: "warn",
      code: "noisy-signal",
      title: "信号中无效边沿比例偏高",
      detail: `约 ${Math.round(detected.rejectRatio * 100)}% 的边沿无法归入码流（干扰/噪声较多）`,
      suggestions: ["检查 TC 线材屏蔽与时码器输出质量"],
    });
  }
  if ((detected.observedJitter || 0) > 0.1) {
    issues.push({
      severity: "warn",
      code: "jitter",
      title: "LTC 码元时序抖动偏大",
      detail: `抖动 ${(detected.observedJitter * 100).toFixed(1)}%，码率不稳`,
      suggestions: ["可能是模拟链路不稳或信号经过变速处理"],
    });
  }
  const diagPeak = detected.diagnostics?.peak;
  if (diagPeak !== undefined && diagPeak < 0.1) {
    issues.push({
      severity: "warn",
      code: "weak-level",
      title: "LTC 信号电平偏低",
      detail: `峰值仅 ${dbfs(diagPeak)} dBFS，解码余量小`,
      suggestions: ["下次录音提高时码器输出电平（建议 −20 ~ −10 dBFS）"],
    });
  }
  const clipRatio = detected.diagnostics?.clippedRatio ?? sourceInfo?.clippedRatio;
  if (clipRatio !== undefined && clipRatio > 0.01) {
    issues.push({
      severity: "warn",
      code: "clipped-decode",
      title: "LTC 信号存在削波",
      detail: `削波样本占比 ${(clipRatio * 100).toFixed(1)}%`,
      suggestions: ["降低时码器输出电平或录音增益"],
    });
  }
  if (detected.reverse) {
    issues.push({
      severity: "info",
      code: "reverse",
      title: "LTC 以反方向解码",
      detail: "信号按反向比特流解出（极性反转不影响结果，但值得记录）",
      suggestions: ["若合板结果反相/偏移，检查该轨链路"],
    });
  }
  return issues;
}

export function buildTakeDiagnostics({ takeKey, label, groupRecords, report, detected, detectError, fpsValue, fpsLabel, samplesToTimecode }) {
  const issues = structuralIssues(groupRecords);
  const channels = appendUnscannedChannels(collectChannels(report), groupRecords, report);
  const summary = {
    takeKey,
    label,
    detected: null,
    issues,
    channels,
    status: "pending",
    headline: "未检测",
  };

  if (detected) {
    const record = groupRecords?.[0] || detected.sourceRecord;
    const startTc = detected.startTimecode
      || (samplesToTimecode && detected.newTimeReference != null
        ? samplesToTimecode(detected.newTimeReference, record?.sampleRate || 48000, detected.fps, { wrapDay: true })
        : "");
    summary.detected = detected;
    summary.headline = `起始TC ${startTc || detected.timecode} · ${detected.fpsLabel || fpsValue || ""} · 置信度 ${Math.round((detected.confidence || 0) * 100)}% · 质量${detected.qualityLabel || "?"}`;
    summary.status = (detected.qualityRank || 1) <= 1 ? "warn" : "ok";
    issues.push(...detectedIssues({ detected, record, fpsValue, channels }));
  } else {
    summary.status = "fail";
    issues.push(...undetectedIssues({ report, groupRecords, detectError, fpsValue, fpsLabel }));
  }

  if (issues.some(issue => issue.severity === "error")) summary.status = "fail";
  else if (issues.some(issue => issue.severity === "warn") && summary.status === "ok") summary.status = "warn";

  if (!detected && !issues.length) summary.headline = "未检测到 LTC";
  return summary;
}

export function buildAllDiagnostics({ reportsMap, fpsValue, fpsLabel, groupLabelFor, samplesToTimecode }) {
  const out = [];
  for (const [takeKey, entry] of reportsMap) {
    out.push(buildTakeDiagnostics({
      takeKey,
      label: entry.label || groupLabelFor?.(entry.groupRecords?.[0]) || takeKey,
      groupRecords: entry.groupRecords,
      report: entry.report,
      detected: entry.detected,
      detectError: entry.detectError,
      fpsValue,
      fpsLabel,
      samplesToTimecode,
    }));
  }
  const rank = { fail: 0, warn: 1, pending: 2, ok: 3 };
  out.sort((a, b) => (rank[a.status] - rank[b.status]) || a.label.localeCompare(b.label));
  return out;
}
