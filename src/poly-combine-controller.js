import {
  safeWaveBaseName,
  validateCombineGroup,
  writeCombinedPolyToWritable,
} from "./wave-combine.js";
import { POLY_EXPORT_PROFILES, polyExportProfile } from "./poly-export-profiles.js";
import { syncWorkflowText, syncPackageManifest } from "./sync-workflow.js";
import { recordKey, shortGroupLabel } from "./grouping.js";

export function createPolyCombineController({
  els,
  combineEligibleGroups,
  confirmCombinePoly,
  getPreviews,
  getLtcResults,
  shouldMuteLtc,
  groupLabel,
  getFpsValue,
  getExportOptions,
  setCombinedPolyKeys,
  setState,
  updateWriteProgress,
  log,
  renderRows,
}) {
  let configuredOptions = { profile: "resolve" };

  function setExportOptions(options = {}) {
    polyExportProfile(options.profile || "resolve");
    configuredOptions = { ...options };
  }

  function downloadWorkflow(result) {
    const text = syncWorkflowText(result, { fpsValue: getFpsValue?.(), referenceName: result.referenceName }) + "\r\n【机器可读清单】\r\n" + JSON.stringify(syncPackageManifest(result, { fpsValue: getFpsValue?.() }), null, 2);
    const url = URL.createObjectURL(new Blob(["\uFEFF", text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = result.name.replace(/\.wav$/i, "_合板说明.txt");
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function saveSidecars(directory, result) {
    const stem = result.name.replace(/\.wav$/i, "");
    const options = { fpsValue: getFpsValue?.(), referenceName: result.referenceName };
    for (const [name, text] of [[`${stem}_合板说明.txt`, "\uFEFF" + syncWorkflowText(result, options)], [`${stem}_channels.json`, JSON.stringify(syncPackageManifest(result, options), null, 2)]]) {
      const handle = await directory.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      try { await writable.write(new Blob([text], { type: "text/plain;charset=utf-8" })); await writable.close(); }
      catch (error) { await writable.abort?.().catch(() => {}); throw error; }
    }
  }

  function optionsForGroup(groupRecords, options) {
    const keys = new Set(groupRecords.flatMap(record => Array.from({ length: record.channels }, (_, channel) => `${recordKey(record)}:${channel}`)));
    const next = { ...options };
    for (const name of ["selectedSourceChannels", "excludedSourceChannels", "ltcSourceChannels", "mutedSourceChannels"]) {
      if (options[name]) next[name] = new Set([...options[name]].filter(key => keys.has(key)));
    }
    return next;
  }

  function previewMapForGroups(groups) {
    const previews = getPreviews?.() || [];
    const previewMap = new Map(previews.map(preview => [recordKey(preview), preview]));
    const groupKeys = new Set(groups.flatMap(([, groupRecords]) => groupRecords.map(record => recordKey(record))));
    const hasPreviewTimecode = previews.some(preview => groupKeys.has(recordKey(preview)) && preview.newTimeReference !== undefined);
    return { previewMap, hasPreviewTimecode };
  }

  function ltcMapForGroups(groups) {
    const ltcResults = getLtcResults?.() || new Map();
    const groupRecords = groups.flatMap(([, records]) => records);
    const hasLtcTimecode = groupRecords.length > 0 && groupRecords.every(record => {
      const ltc = ltcResults.get(recordKey(record));
      return ltc?.ok && ltc.newTimeReference !== undefined && ltc.newTimeReference !== null;
    });
    return { ltcMap: ltcResults, hasLtcTimecode };
  }

  function recordsWithPreviewTimecode(groups, previewMap) {
    return groups.map(([key, groupRecords]) => {
      const nextRecords = groupRecords.map(record => {
        const preview = previewMap.get(recordKey(record));
        if (!preview || preview.newTimeReference === undefined) {
          throw new Error(`${groupLabel(record)}: 这个分轨没有当前时码预览，不能用预览时码合成 Poly`);
        }
        return {
          ...record,
          oldTimeReference: preview.newTimeReference,
          _combineFpsValue: preview.fpsValue || preview.fps?.value || getFpsValue?.(),
          ixmlInfo: preview.ixmlInfo || record.ixmlInfo,
        };
      });
      const first = nextRecords[0]?.oldTimeReference;
      if (!nextRecords.every(record => record.oldTimeReference === first)) {
        throw new Error(`${groupLabel(nextRecords[0])}: 同一 take 的预览后起始时码不一致，不能合成 Poly`);
      }
      return [key, nextRecords];
    });
  }

  function recordsWithLtcTimecode(groups, ltcMap) {
    return groups.map(([key, groupRecords]) => {
      const nextRecords = groupRecords.map(record => {
        const ltc = ltcMap.get(recordKey(record));
        if (!ltc?.ok || ltc.newTimeReference === undefined || ltc.newTimeReference === null) {
          throw new Error(`${groupLabel(record)}: 这个分轨没有可用的 LTC 时码，不能用 LTC 时码合成 Poly`);
        }
        return {
          ...record,
          oldTimeReference: ltc.newTimeReference,
          _combineFpsValue: ltc.fpsValue || ltc.fps?.value || getFpsValue?.(),
        };
      });
      const first = nextRecords[0]?.oldTimeReference;
      if (!nextRecords.every(record => record.oldTimeReference === first)) {
        throw new Error(`${groupLabel(nextRecords[0])}: 同一 take 的 LTC 起始时码不一致，不能合成 Poly`);
      }
      return [key, nextRecords];
    });
  }

  function mutedLtcChannelsForGroups(groups, ltcMap) {
    const muted = new Set();
    for (const [, groupRecords] of groups) {
      for (const record of groupRecords) {
        const ltc = ltcMap.get(recordKey(record));
        if (ltc?.ok && ltc.sourceRecord && ltc.channelIndex !== undefined && ltc.channelIndex !== null) {
          muted.add(`${recordKey(ltc.sourceRecord)}:${ltc.channelIndex}`);
        }
      }
    }
    return muted;
  }

  async function writeCombinedPolyFile(key, groupRecords, exportOptions, progressBase = 0, progressTotal = 1) {
    if (!("showSaveFilePicker" in window)) throw new Error("当前浏览器不支持直接保存 Poly WAV；请使用 Chrome / Edge");
    const groupName = safeWaveBaseName(shortGroupLabel(key));
    const handle = await window.showSaveFilePicker({
      suggestedName: `${groupName}_Poly.WAV`,
      types: [{
        description: "Wave Audio",
        accept: { "audio/wav": [".wav"] },
      }],
    });
    const writable = await handle.createWritable();
    return writeCombinedPolyToWritable(key, groupRecords, writable, handle.name, {
      progressBase,
      progressTotal,
      fallbackFpsValue: getFpsValue?.(),
      ...exportOptions,
      groupLabel,
      onProgress: updateWriteProgress,
    });
  }

  async function writeCombinedPolyToDirectory(directory, key, groupRecords, exportOptions, progressBase = 0, progressTotal = 1) {
    const groupName = safeWaveBaseName(shortGroupLabel(key));
    const outputName = `${groupName}_Poly.WAV`;
    const handle = await directory.getFileHandle(outputName, { create: true });
    const writable = await handle.createWritable();
    return writeCombinedPolyToWritable(key, groupRecords, writable, outputName, {
      progressBase,
      progressTotal,
      fallbackFpsValue: getFpsValue?.(),
      ...exportOptions,
      groupLabel,
      onProgress: updateWriteProgress,
    });
  }

  async function combinePolyFiles(overrides = {}) {
    const groups = combineEligibleGroups();
    if (!groups.length) throw new Error("没有识别到可合并的分轨 take");
    if (groups.length > 1 && !("showDirectoryPicker" in window)) {
      throw new Error("当前浏览器不支持批量选择输出目录；请使用 Chrome / Edge，或逐个保存");
    }
    const exportOptions = { ...configuredOptions, ...(await getExportOptions?.(groups) || {}), ...overrides };
    const profile = polyExportProfile(exportOptions.profile || "resolve");
    const knownSourceKeys = new Set(groups.flatMap(([, records]) => records.flatMap(record => Array.from({ length: record.channels }, (_, channel) => `${recordKey(record)}:${channel}`))));
    for (const name of ["selectedSourceChannels", "excludedSourceChannels", "ltcSourceChannels"]) {
      for (const key of exportOptions[name] || []) if (!knownSourceKeys.has(key)) throw new Error(`输出通道不存在：${key}`);
    }
    const { previewMap, hasPreviewTimecode } = previewMapForGroups(groups);
    const { ltcMap, hasLtcTimecode } = ltcMapForGroups(groups);
    const muteLtc = hasLtcTimecode && shouldMuteLtc?.() !== false;
    const choice = await confirmCombinePoly(groups, { hasPreviewTimecode, hasLtcTimecode, muteLtc, profile: profile.id, ltcPolicy: profile.ltcPolicy });
    if (!choice) return;
    const groupsToWrite = choice === "preview"
      ? recordsWithPreviewTimecode(groups, previewMap)
      : choice === "ltc"
        ? recordsWithLtcTimecode(groups, ltcMap)
        : groups;
    const mutedSourceChannels = muteLtc ? mutedLtcChannelsForGroups(groups, ltcMap) : new Set();
    const policies = new Map(groupsToWrite.map(([key, records]) => [key, optionsForGroup(records, {
      ...exportOptions, profile: profile.id,
      mutedSourceChannels: profile.id === "archive" ? mutedSourceChannels : new Set(),
      ltcSourceChannels: exportOptions.ltcSourceChannels || (muteLtc ? mutedSourceChannels : new Set()),
    })]));
    for (const [key, records] of groupsToWrite) validateCombineGroup(records, { ...policies.get(key), groupLabel });
    // Reference audio is deliberately explicit: the first channel might be LTC, room tone, or silent.
    if (exportOptions.referenceSourceChannel) {
      if (groupsToWrite.length !== 1) throw new Error("参考通道目前需逐 take 显式选择；请一次导出一个 take");
      const plan = validateCombineGroup(groupsToWrite[0][1], policies.get(groupsToWrite[0][0]));
      if (!plan.tracks.some(track => `${recordKey(track.record)}:${track.channelIndex}` === exportOptions.referenceSourceChannel)) throw new Error("SyncRef 必须选择主 Poly 中保留的有效节目通道，不能是被排除的 LTC");
    }
    const outputNames = groupsToWrite.map(([key]) => `${safeWaveBaseName(shortGroupLabel(key))}_Poly.WAV`.toLowerCase());
    if (new Set(outputNames).size !== outputNames.length) throw new Error("不同目录的 take 将产生同名 Poly；为避免覆盖，请分批导出或先区分 take 名称");
    let batchDirectory = null;
    if (groupsToWrite.length > 1) {
      try {
        batchDirectory = await window.showDirectoryPicker({ mode: "readwrite" });
      } catch (error) {
        if (error.name === "AbortError") return;
        throw new Error("无法使用这个输出文件夹。Chrome 不允许网页直接写入某些受保护的常用文件夹（如“下载”“文稿”“桌面”本身）；请在其中新建并选择一个子文件夹，例如 Downloads/AudioTCChange_Poly。");
      }
    }

    setState("合并中", "warn");
    els.combinePolyBtn.disabled = true;
    els.statusLine.textContent = "Combining split tracks...";
    updateWriteProgress("正在合并 Poly…", "", 0, groupsToWrite.length);
    els.progressOverlay.classList.add("show");

    const results = [];
    try {
      for (let i = 0; i < groupsToWrite.length; i++) {
        const [key, groupRecords] = groupsToWrite[i];
        updateWriteProgress("正在合并 Poly…", shortGroupLabel(key), i, groupsToWrite.length);
        const result = groupsToWrite.length > 1
          ? await writeCombinedPolyToDirectory(batchDirectory, key, groupRecords, policies.get(key), i, groupsToWrite.length)
          : await writeCombinedPolyFile(key, groupRecords, policies.get(key), i, groupsToWrite.length);
        if (exportOptions.referenceSourceChannel) {
          try {
            const refName = result.name.replace(/\.wav$/i, "_SyncRef.WAV");
            const handle = await window.showSaveFilePicker({ suggestedName: refName, types: [{ description: "Mono sync reference", accept: { "audio/wav": [".wav"] } }] });
            await writeCombinedPolyToWritable(key, groupRecords, await handle.createWritable(), handle.name, {
              ...policies.get(key), selectedSourceChannels: new Set([exportOptions.referenceSourceChannel]),
              onProgress: updateWriteProgress, fallbackFpsValue: getFpsValue?.(),
            });
            result.referenceName = handle.name;
          } catch (error) { log(`SyncRef WARN: ${error.message}; 主 Poly 已保存`); }
        }
        try { if (batchDirectory) await saveSidecars(batchDirectory, result); else downloadWorkflow(result); }
        catch (error) { log(`Sync guide WARN: ${error.message}; Poly 已保存，可从 docs/声音合板指南.md 查看说明`); }
        if (result.clippedSamples || result.invalidSamples) log(`Poly WARN: ${result.name}: PCM24 转换削波 ${result.clippedSamples} samples，非有限值 ${result.invalidSamples}；请使用原始 float 或降低增益`);
        results.push(result);
        updateWriteProgress("正在合并 Poly…", result.name, i + 1, groupsToWrite.length);
      }
      const stateLabel = choice === "preview" || choice === "ltc" ? "已更改并合并" : "已合并";
      setState(stateLabel);
      const allRecordKeys = new Set(
        groupsToWrite.flatMap(([, groupRecords]) => groupRecords.map(record => recordKey(record)))
      );
      setCombinedPolyKeys(allRecordKeys);
      renderRows();
      els.statusLine.textContent = `Poly 合并完成：${results.length} 个文件`;
      const timecodeNote = choice === "preview"
        ? "; used preview timecode"
        : choice === "ltc"
          ? "; used LTC timecode"
          : "";
      const muteNote = mutedSourceChannels.size ? profile.ltcPolicy === "exclude" ? "; excluded confirmed LTC channels" : profile.id === "archive" ? "; muted LTC track" : "; retained LTC" : "";
      log(`Combine Poly OK: ${results.map(result => `${result.name} (${result.channels}ch)`).join(", ")}${timecodeNote}${muteNote}`);
      els.toast.textContent = `✅ Poly 合并完成 — ${results.length} 个文件`;
      els.toast.classList.add("show");
      setTimeout(() => els.toast.classList.remove("show"), 4500);
      return results;
    } finally {
      els.progressOverlay.classList.remove("show");
      updateWriteProgress("正在写入…", "", 0, groupsToWrite.length || 1);
      els.combinePolyBtn.disabled = combineEligibleGroups().length === 0;
    }
  }

  return {
    combinePolyFiles,
    setExportOptions,
    profiles: POLY_EXPORT_PROFILES,
  };
}
