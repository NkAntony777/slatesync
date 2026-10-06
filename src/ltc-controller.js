import { ltcFailureSummary } from "./ltc-signal.js";
import {
  fpsLabel,
  parseFps,
} from "./timecode.js";
import { readDataView } from "./wave.js";
import {
  ltcScanPriority,
  ltcScanRecords,
  recordKey,
  shortGroupLabel,
} from "./grouping.js";
import {
  LTC_WORKER_CODE,
  WorkerPool,
} from "./ltc-worker.js";
import { createLtcDecoder } from "./ltc-decoder.js";

export function createLtcController({
  els,
  getRecords,
  getLtcResults,
  setLtcResults,
  getLtcReports,
  setLtcReports,
  recordsByGroup,
  groupLabel,
  fpsSelectLabel,
  setFpsValue,
  // 可选：per-take 覆盖 store（src/take-fps.js）。不注入时全部回落到 els.fpsInput.value，
  // 与改动前完全一致。
  takeFps = null,
  samplesToTimecode,
  defaultDisplayFps,
  confirmLtcFpsMismatch,
  setState,
  updateWriteProgress,
  log,
  renderRows,
  renderDiagnostics,
}) {
  const ltcWorkerPool = window.Worker
    ? new WorkerPool(LTC_WORKER_CODE, Math.max(2, Math.min((navigator.hardwareConcurrency || 4) - 1, 6)))
    : null;

  function globalFpsValue() {
    return els.fpsInput.value;
  }

  /** 解码候选帧率：下拉框全部选项 + 该 take 的帧率值（保证覆盖值一定被尝试）。 */
  function candidateFpsValuesForFpsValue(fpsValue) {
    const values = Array.from(els.fpsInput.options).map(option => option.value);
    if (fpsValue && !values.includes(fpsValue)) values.unshift(fpsValue);
    return values;
  }

  const decoder = createLtcDecoder({
    readDataView,
    // 解码器按无参调用这两个回调；带 take 提示时返回该 take 的值，否则就是全局值。
    candidateFpsValues: takeHint => candidateFpsValuesForFpsValue(takeHint?.fpsValue || ""),
    defaultFpsValue: takeHint => resolveTakeFpsValue(takeHint) || globalFpsValue(),
    fpsSelectLabel,
  });

  /**
   * 某个 take 实际该用的帧率值：per-take 覆盖 > 全局界面选择。
   * takeHint 可以是 takeKey，也可以是 { takeKey, fpsValue }。
   */
  function resolveTakeFpsValue(takeHint) {
    const takeKey = typeof takeHint === "string" ? takeHint : takeHint?.takeKey;
    const explicit = typeof takeHint === "string" ? "" : takeHint?.fpsValue || "";
    if (explicit) return explicit;
    if (!takeKey) return globalFpsValue();
    return takeFps?.resolveFpsValueForTake?.(takeKey, globalFpsValue()) || globalFpsValue();
  }

  /** 单个 take 的解码候选帧率（per-take 覆盖排在最前）。 */
  function takeCandidateFpsValues(takeKey) {
    return candidateFpsValuesForFpsValue(resolveTakeFpsValue(takeKey));
  }

  /** 单个 take 的帧率：给 detectLtcForTake 用的 (fps, fpsValue) 二元组。 */
  function takeFpsPair(takeKey) {
    const fpsValue = resolveTakeFpsValue(takeKey);
    return { fps: parseFps(fpsValue), fpsValue };
  }

  function ltcStartTimecode(result, record) {
    if (result?.newTimeReference == null || !record) return result?.timecode || "";
    return samplesToTimecode(result.newTimeReference, record.sampleRate, result.fps || defaultDisplayFps(), { wrapDay: true });
  }

  function ltcStatusText(result, record, fps) {
    if (!result?.ok || result.newTimeReference == null) return result?.statusText || "待检测";
    const dropNote = result.dropMismatch ? " · DF标记不符" : "";
    const gainNote = result.analysisGain > 1 ? ` · 低电平增益 +${(20 * Math.log10(result.analysisGain)).toFixed(0)}dB` : "";
    const qualityNote = result.qualityLabel ? ` · 质量${result.qualityLabel}` : "";
    const sourceName = result.sourceRecord?.name || "已检测";
    const sourceChannel = `channel ${result.channelLabel}`;
    const fpsNote = `(${result.fpsLabel || fpsLabel(result.fps || fps)})`;
    const isSource = result.sourceRecord && recordKey(record) === recordKey(result.sourceRecord);
    return isSource
      ? `${fpsNote}${sourceChannel} · ${Math.round(result.confidence * 100)}%${qualityNote}${gainNote}${dropNote}`
      : `链接自 ${sourceName} · ${sourceChannel} · ${Math.round(result.confidence * 100)}%${qualityNote}${gainNote}${dropNote}`;
  }

  function reviveWorkerLtcResult(result) {
    if (!result) return null;
    const reviveOne = item => {
      if (!item) return null;
      return {
        ...item,
        frames: BigInt(item.frames),
        newTimeReference: BigInt(item.newTimeReference),
        fps: parseFps(item.fpsValue),
        fpsLabel: fpsSelectLabel(item.fpsValue),
      };
    };
    return {
      ...result,
      best: reviveOne(result.best),
      preferred: reviveOne(result.preferred),
      results: (result.results || []).map(reviveOne),
    };
  }

  async function detectLtcAutoWorker(record, fps, scanSeconds = null, options = {}) {
    const sampleLimit = scanSeconds == null
      ? record.durationSamples
      : BigInt(Math.max(record.sampleRate * scanSeconds, record.sampleRate));
    const maxSamples = Number(record.durationSamples < sampleLimit ? record.durationSamples : sampleLimit);
    const bytesToRead = Math.min(record.dataSize, maxSamples * record.blockAlign);
    const buffer = await record.file.slice(record.dataOffset, record.dataOffset + bytesToRead).arrayBuffer();
    const preferredValue = fps.value || globalFpsValue();
    const values = [
      preferredValue,
      ...decoder.candidateFpsValues({ fpsValue: preferredValue }).filter(value => value !== preferredValue),
    ];
    const result = await ltcWorkerPool.run({
      buffer,
      preferredValue,
      values,
      record: {
        name: record.name,
        sampleRate: record.sampleRate,
        channels: record.channels,
        bitsPerSample: record.bitsPerSample,
        audioFormat: record.audioFormat,
        isFloat: Boolean(record.isFloat || record.audioFormat === 3),
        blockAlign: record.blockAlign,
      },
      allowSoftSync: options.allowSoftSync === true,
    }, [buffer]);
    const revived = reviveWorkerLtcResult(result);
    if (revived) revived.scanSeconds = scanSeconds;
    return revived;
  }

  function summarizeAttempt(record, auto, error, pass) {
    const slim = item => ({
      fpsValue: item.fpsValue,
      fpsLabel: item.fpsLabel,
      timecode: item.timecode,
      confidence: item.confidence,
      qualityRank: item.qualityRank,
      qualityLabel: item.qualityLabel,
      lockedFrames: item.lockedFrames,
      halfBitError: item.halfBitError,
      rejectRatio: item.rejectRatio,
      dropMismatch: item.dropMismatch,
      reverse: item.reverse,
      sampleOffset: item.sampleOffset,
      windowStart: item.windowStart,
      windowEnd: item.windowEnd,
      channelIndex: item.channelIndex,
      channelLabel: item.channelLabel,
      softSync: Boolean(item.softSync),
      requiresConfirmation: Boolean(item.requiresConfirmation),
    });
    return {
      record,
      pass,
      error: error ? (error.message || String(error)) : null,
      channelReports: auto?.channelReports || [],
      rejectedChannels: auto?.rejectedChannels || [],
      candidates: (auto?.results || []).map(slim),
      best: auto?.best ? slim(auto.best) : null,
      preferred: auto?.preferred ? slim(auto.preferred) : null,
    };
  }

  function isHighQualityFastLtc(auto) {
    return decoder.isHighQualityCandidate(auto?.best);
  }

  function tagLtcAutoResult(auto, flags) {
    if (!auto) return auto;
    for (const result of [auto.best, auto.preferred, ...(auto.results || [])]) {
      if (result) Object.assign(result, flags);
    }
    return auto;
  }

  async function detectLtcFast(record, fps) {
    if (!ltcWorkerPool) return null;
    const fast = await detectLtcAutoWorker(record, fps, 5, { allowSoftSync: false });
    return tagLtcAutoResult(fast, { fastScan: true });
  }

  async function detectLtcFull(record, fps, options = {}) {
    const allowSoftSync = options.allowSoftSync === true;
    if (!ltcWorkerPool) return decoder.detectAuto(record, fps, { allowSoftSync });
    const full = await detectLtcAutoWorker(record, fps, null, { allowSoftSync });
    return tagLtcAutoResult(full, {
      fullFileScan: true,
      manualFallback: allowSoftSync,
    });
  }

  async function detectLtcAuto(record, fps, options = {}) {
    const allowSoftSync = options.allowSoftSync === true;
    if (ltcWorkerPool) {
      const fast = await detectLtcFast(record, fps);
      if (isHighQualityFastLtc(fast)) {
        return fast;
      }
      return tagLtcAutoResult(await detectLtcFull(record, fps, options), {
        fastFallback: Boolean(fast?.best || fast?.rejectedChannels?.length),
      });
    }
    return decoder.detectAuto(record, fps, { allowSoftSync });
  }

  function shouldPromptForAutoFps(auto, currentValue) {
    if (!auto.best || auto.best.fpsValue === currentValue) return false;
    if (auto.best.halfBitError > 0.008) return false;
    const current = auto.preferred;
    if (!current) return true;
    if ((auto.best.qualityRank || 0) > (current.qualityRank || 0)) return true;
    return current.halfBitError - auto.best.halfBitError > 0.00035;
  }

  function selectedLtcResult(auto, fpsValue) {
    return auto.best?.fpsValue === fpsValue ? auto.best : auto.preferred;
  }

  function bestTakeAttempt(attempts, fpsValue, allowFpsPrompt) {
    let detectError = null;
    const candidates = [];

    for (const attempt of attempts) {
      if (attempt.error) {
        detectError = attempt.error;
        continue;
      }
      const { record, auto } = attempt;
      if (shouldPromptForAutoFps(auto, fpsValue) && allowFpsPrompt) {
        return {
          fpsMismatch: {
            record,
            auto,
            currentValue: fpsValue,
            detectedValue: auto.best.fpsValue,
            detectedTimecode: auto.best.timecode,
          },
          detectError,
        };
      }

      const result = selectedLtcResult(auto, fpsValue);
      if (result) candidates.push({ record, result });
    }

    candidates.sort((a, b) => decoder.compareResults(a.result, b.result));
    const best = candidates[0];
    return {
      detected: best ? { ...best.result, sourceRecord: best.record } : null,
      detectError,
    };
  }

  async function detectLtcForTake(takeKey, groupRecords, fps, fpsValue, allowFpsPrompt, options = {}) {
    const scanRecords = ltcScanRecords(groupRecords);
    const scanPasses = [
      scanRecords.filter(record => ltcScanPriority(record) === 0),
      scanRecords.filter(record => ltcScanPriority(record) === 1),
      scanRecords.filter(record => ltcScanPriority(record) >= 2),
    ].filter(pass => pass.length);

    let detectError = null;
    const report = [];
    if (ltcWorkerPool) {
      const fastAttempts = [];
      for (const record of scanRecords) {
        let attempt;
        try {
          attempt = { record, auto: await detectLtcFast(record, fps), error: null };
        } catch (error) {
          attempt = { record, auto: null, error };
        }
        fastAttempts.push(attempt);
        report.push(summarizeAttempt(attempt.record, attempt.auto, attempt.error, "fast"));
      }

      const fastResult = bestTakeAttempt(fastAttempts, fpsValue, allowFpsPrompt);
      if (fastResult.fpsMismatch) return { takeKey, groupRecords, ...fastResult, report };
      if (fastResult.detected && decoder.isHighQualityCandidate(fastResult.detected)) {
        return {
          takeKey,
          groupRecords,
          detected: { ...fastResult.detected, groupKey: takeKey },
          detectError,
          report,
        };
      }
      if (fastResult.detectError) detectError = fastResult.detectError;
    }

    for (const pass of scanPasses) {
      const attempts = [];
      for (const record of pass) {
        try {
          attempts.push({
            record,
            auto: ltcWorkerPool
              ? await detectLtcFull(record, fps, options)
              : await detectLtcAuto(record, fps, options),
            error: null,
          });
        } catch (error) {
          attempts.push({ record, auto: null, error });
        }
        report.push(summarizeAttempt(record, attempts[attempts.length - 1].auto, attempts[attempts.length - 1].error, "full"));
        const partial = bestTakeAttempt(attempts, fpsValue, allowFpsPrompt);
        if (partial.fpsMismatch) return { takeKey, groupRecords, ...partial, report };
        if (partial.detected && decoder.isHighQualityCandidate(partial.detected)) {
          return {
            takeKey,
            groupRecords,
            detected: { ...partial.detected, groupKey: takeKey },
            detectError,
            report,
          };
        }
      }
      const result = bestTakeAttempt(attempts, fpsValue, allowFpsPrompt);
      if (result.fpsMismatch) return { takeKey, groupRecords, ...result, report };
      if (result.detectError) detectError = result.detectError;
      if (result.detected) return {
        takeKey,
        groupRecords,
        detected: { ...result.detected, groupKey: takeKey },
        detectError,
        report,
      };
    }

    return { takeKey, groupRecords, detected: null, detectError, report };
  }

  async function extractLtcFromFiles(options = {}) {
    const selectedKeys = options.selectedRecordKeys;
    const records = getRecords();
    if (!records.length) throw new Error("请先拖入 WAV 或视频文件");
    let fpsValue = globalFpsValue();
    let allowFpsPrompt = true;
    const allowSoftSync = options.allowSoftSync === true;

    while (true) {
      const fps = parseFps(fpsValue);
      const allGroups = Array.from(recordsByGroup().entries());
      const groups = selectedKeys?.size
        ? allGroups.filter(([, groupRecords]) => groupRecords.some(record => selectedKeys.has(recordKey(record))))
        : allGroups;
      if (!groups.length) throw new Error("没有找到可增强识别的选中素材");
      let restartWithFps = null;
      if (!selectedKeys?.size) {
        setLtcResults(new Map());
        setLtcReports?.(new Map());
      }
      els.writeLtcBtn.disabled = true;
      setState("LTC检测中", "warn");
      els.statusLine.textContent = allowSoftSync
        ? "正在对选中素材启用兜底模式读取 LTC；低质量结果请人工确认..."
        : "正在按文件/take 从音频波形读取 LTC...";
      updateWriteProgress("正在检测 LTC…", "", 0, groups.length);
      els.progressOverlay.classList.add("show");

      try {
        const preflightResults = new Map();
        if (allowFpsPrompt && !allowSoftSync && groups.length > 1) {
          updateWriteProgress("正在确认 LTC 帧率…", shortGroupLabel(groups[0]?.[0] || "根目录"), 0, groups.length);
          for (let i = 0; i < groups.length; i++) {
            const [takeKey, groupRecords] = groups[i];
            const take = takeFpsPair(takeKey);
            const probe = await detectLtcForTake(takeKey, groupRecords, take.fps, take.fpsValue, allowFpsPrompt, { allowSoftSync: false });
            if (probe.fpsMismatch) {
              els.progressOverlay.classList.remove("show");
              const useAuto = await confirmLtcFpsMismatch({
                currentValue: probe.fpsMismatch.currentValue,
                detectedValue: probe.fpsMismatch.detectedValue,
                detectedTimecode: probe.fpsMismatch.detectedTimecode,
                group: groupLabel(probe.groupRecords[0]),
              });
              allowFpsPrompt = false;

              if (useAuto) {
                restartWithFps = probe.fpsMismatch.detectedValue;
                setFpsValue(restartWithFps);
                break;
              }

              els.progressOverlay.classList.add("show");
              break;
            }
            preflightResults.set(takeKey, probe);
            if (probe.detected) break;
          }
        }

        if (restartWithFps) {
          fpsValue = restartWithFps;
          continue;
        }

        const takeConcurrency = Math.max(2, Math.min(ltcWorkerPool?.workers.length || 2, 6));
        for (let i = 0; i < groups.length; i += takeConcurrency) {
          const batch = groups.slice(i, i + takeConcurrency);
          updateWriteProgress("正在检测 LTC…", shortGroupLabel(batch[0]?.[0] || "根目录"), i, groups.length);
          const batchResults = await Promise.all(batch.map(([takeKey, groupRecords]) => {
            const cached = preflightResults.get(takeKey);
            if (cached) return cached;
            const take = takeFpsPair(takeKey);
            return detectLtcForTake(takeKey, groupRecords, take.fps, take.fpsValue, allowFpsPrompt, { allowSoftSync });
          }));

          const mismatch = batchResults.find(result => result.fpsMismatch);
          if (mismatch && allowFpsPrompt) {
            els.progressOverlay.classList.remove("show");
            const useAuto = await confirmLtcFpsMismatch({
              currentValue: mismatch.fpsMismatch.currentValue,
              detectedValue: mismatch.fpsMismatch.detectedValue,
              detectedTimecode: mismatch.fpsMismatch.detectedTimecode,
              group: groupLabel(mismatch.groupRecords[0]),
            });
            allowFpsPrompt = false;

            if (useAuto) {
              restartWithFps = mismatch.fpsMismatch.detectedValue;
              setFpsValue(restartWithFps);
              break;
            }

            els.progressOverlay.classList.add("show");
            i = -takeConcurrency;
            continue;
          }

          const ltcResults = getLtcResults();
          const ltcReports = getLtcReports?.() || new Map();
          for (const { takeKey, groupRecords, detected, detectError, report } of batchResults) {
            if (report) ltcReports.set(takeKey, { groupRecords, report, detected, detectError, label: groupLabel(groupRecords[0]) });
            if (detected) {
              for (const record of groupRecords) {
                const startTimecode = samplesToTimecode(detected.newTimeReference, record.sampleRate, detected.fps || fps, { wrapDay: true });
                const result = {
                  ...detected,
                  record,
                  ok: true,
                  status: "ok",
                  startTimecode,
                  sourceTimecode: detected.timecode,
                };
                result.statusText = ltcStatusText(result, record, fps);
                ltcResults.set(recordKey(record), result);
              }
              const dropNote = detected.dropMismatch ? " · DF标记与当前设置不符" : "";
              const logStartTc = samplesToTimecode(detected.newTimeReference, groupRecords[0].sampleRate, detected.fps || fps, { wrapDay: true });
              const scanMode = detected.fastScan ? "fast" : detected.fullFileScan ? "full-file" : "full";
              log(`LTC OK: ${groupLabel(groupRecords[0])} -> start ${logStartTc}, source frame ${detected.timecode} @ ${detected.sampleOffset} samples, ${detected.fpsLabel || fpsLabel(fps)}${dropNote}, source ${detected.sourceRecord.name}, ${detected.lockedFrames} frames, ${scanMode}, quality ${detected.qualityLabel}, half error ${(detected.halfBitError * 100).toFixed(3)}%, confidence ${Math.round(detected.confidence * 100)}%`);
            } else {
              const failure = ltcFailureSummary(report, detectError);
              for (const record of groupRecords) {
                ltcResults.set(recordKey(record), {
                  ok: false,
                  status: detectError ? "err" : "warn",
                  statusText: failure.message,
                  failureCode: failure.code,
                  suggestion: failure.suggestion,
                });
              }
              log(detectError
                ? `LTC ERROR: ${groupLabel(groupRecords[0])}: ${detectError.message}`
                : `LTC MISS: ${groupLabel(groupRecords[0])}: ${failure.message}；${failure.suggestion}`);
            }
          }

          updateWriteProgress("正在检测 LTC…", shortGroupLabel(batch[batch.length - 1]?.[0] || "根目录"), Math.min(i + batch.length, groups.length), groups.length);
          renderRows();
          renderDiagnostics?.(ltcReports, { fpsValue });
        }

        if (restartWithFps) {
          fpsValue = restartWithFps;
          continue;
        }

        const ltcResults = getLtcResults();
        const okGroups = new Set(Array.from(ltcResults.values()).filter(result => result.ok).map(result => result.groupKey));
        const okFiles = Array.from(ltcResults.values()).filter(result => result.ok).length;
        const writableOkFiles = Array.from(ltcResults.values()).filter(result => {
          const record = result.record;
          return result.ok && record && !record._meta && !record._video && record.fileHandle?.createWritable;
        }).length;
        const lowQualityGroups = new Set(Array.from(ltcResults.values()).filter(result => result.ok && result.qualityRank === 1).map(result => result.groupKey));
        const softGroups = new Set(Array.from(ltcResults.values()).filter(result => result.ok && result.requiresConfirmation).map(result => result.groupKey));
        setState(okGroups.size ? (writableOkFiles ? "LTC可写入" : "LTC可导出") : "未检测到LTC", okGroups.size ? "ok" : "warn");
        els.statusLine.textContent = okGroups.size
          ? `已检测到 ${okGroups.size} 个文件/take 的 LTC；${writableOkFiles ? `可写入 ${writableOkFiles} 个 WAV，` : ""}可导出 ${okFiles} 条元数据${lowQualityGroups.size ? `；${lowQualityGroups.size} 个低质量请人工确认` : ""}${softGroups.size ? `；${softGroups.size} 个兜底结果写入前需逐条核对` : ""}`
          : "没有检测到可用的 LTC";
        renderRows();
        break;
      } finally {
        els.progressOverlay.classList.remove("show");
        updateWriteProgress("正在写入…", "", 0, groups.length || 1);
      }
    }
  }

  return {
    extractLtcFromFiles,
    ltcStartTimecode,
    ltcStatusText,
    resolveTakeFpsValue,
    takeCandidateFpsValues,
  };
}
