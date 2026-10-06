import {
  safeWaveBaseName,
  validateCombineGroup,
  writeCombinedPolyToWritable,
} from "./wave-combine.js";
import { POLY_EXPORT_PROFILES, polyExportProfile } from "./poly-export-profiles.js";
import { syncGuideText, syncPackageManifest } from "./sync-workflow.js";
import { buildAcceptanceChecklist } from "./acceptance-checklist.js";
import { takeHealthScopeForCombine } from "./confirm-flows.js";
import { recordKey, shortGroupLabel } from "./grouping.js";

// 合板输出的文件名是 UI 和写入之间的契约：界面上要显示"会写成什么"，
// 写入前也要拿同一个名字去目标目录里查同名文件，所以放在这里导出而不是各处拼。
export function polyOutputNameFor(takeKey) {
  return `${safeWaveBaseName(shortGroupLabel(takeKey))}_Poly.WAV`;
}

export function polyReferenceOutputNameFor(outputName) {
  return String(outputName || "").replace(/\.wav$/i, "_SyncRef.WAV");
}

export function polySidecarNamesFor(outputName) {
  const stem = String(outputName || "").replace(/\.wav$/i, "");
  return [`${stem}_合板说明.txt`, `${stem}_channels.json`];
}

/** 计划要写的文件名里，哪些已经存在于目标目录（按文件系统大小写不敏感比对）。 */
export function partitionCollidingNames(plannedNames, existingNames) {
  const existing = new Set(Array.from(existingNames || [], name => String(name).toLowerCase()));
  const collisions = [];
  const fresh = [];
  const seen = new Set();
  for (const name of plannedNames || []) {
    const lower = String(name).toLowerCase();
    if (existing.has(lower)) collisions.push(name);
    else if (seen.has(lower)) collisions.push(name);
    else fresh.push(name);
    seen.add(lower);
  }
  return { collisions, fresh };
}

/** 查目标目录里哪些计划文件名已存在。拿不准的错误直接抛给调用方决定。 */
export async function existingOutputNames(directory, names) {
  const existing = new Set();
  if (!directory) return existing;
  for (const name of names || []) {
    try {
      await directory.getFileHandle(name);
      existing.add(name);
    } catch (error) {
      if (error?.name === "NotFoundError") continue;
      throw error;
    }
  }
  return existing;
}

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
  // 可选：返回一个已授权的输出目录句柄（有记住的目录时省掉每次的文件夹选择）
  getOutputDirectory,
  // 可选：让用户挑输出目录。返回句柄；返回 null 表示用户取消。
  pickOutputDirectory,
  // 可选：目标目录里已有同名文件时询问是否覆盖。返回 false 表示中止。
  requestOverwrite,
  // 可选：() => describeDroppedTakes(...) 的结果，用于把没被合并的 take 告诉用户
  describeDroppedTakeGroups,
  // 可选：() => 体检视图模型（confirm-flows.js 的 buildTakeHealthViewModel 结果），
  // 用于在合并确认框里点名"这次会出错的 take"。不注入则确认框不含体检内容。
  getTakeHealthView,
  // 可选：() => 该 take 的体检 findings，供验收清单的 take-health-clear 项使用。
  getTakeHealthFindings,
  // 可选：合并完成后弹出可勾选的验收面板。返回的 checklist 已带 needsHuman 统计。
  showAcceptanceChecklist,
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

  /**
   * 为一次合并结果建验收清单。buildAcceptanceChecklist 需要 profile / 参考声道 /
   * take 归属，这些都只有这里知道；healthFindings 拿不到就传 undefined ——
   * 那一项会降级为 manual 而不是崩掉，这是模块自己的契约。
   */
  function checklistFor(result, extra = {}) {
    try {
      return buildAcceptanceChecklist(result, {
        profile: extra.profileId,
        referenceName: result.referenceName,
        referenceChannel: extra.referenceSourceChannel || "",
        takeKey: extra.takeKey || "",
        healthFindings: extra.takeKey ? getTakeHealthFindings?.(extra.takeKey) : undefined,
      });
    } catch (error) {
      log(`Acceptance checklist WARN: ${error?.message || error}；已跳过验收清单`);
      return null;
    }
  }

  function downloadWorkflow(result, checklist = null) {
    const text = syncGuideText(result, { fpsValue: getFpsValue?.(), referenceName: result.referenceName, checklist })
      + "\r\n【机器可读清单】\r\n" + JSON.stringify(syncPackageManifest(result, { fpsValue: getFpsValue?.() }), null, 2);
    const url = URL.createObjectURL(new Blob(["\uFEFF", text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = result.name.replace(/\.wav$/i, "_合板说明.txt");
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function saveSidecars(directory, result, checklist = null) {
    const [guideName, manifestName] = polySidecarNamesFor(result.name);
    const options = { fpsValue: getFpsValue?.(), referenceName: result.referenceName, checklist };
    for (const [name, text] of [[guideName, "\uFEFF" + syncGuideText(result, options)], [manifestName, JSON.stringify(syncPackageManifest(result, options), null, 2)]]) {
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
    const handle = await window.showSaveFilePicker({
      suggestedName: polyOutputNameFor(key),
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
    const outputName = polyOutputNameFor(key);
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

  /**
   * 决定这次输出往哪儿写。返回 { directory, cancelled }：
   *   - directory 非空：所有 take（含单个 take）都直接写进这个目录，不再逐个弹保存框
   *   - directory 为空 + cancelled=false：没有可用的目录，回退到 showSaveFilePicker
   *   - cancelled=true：用户主动取消，整次导出中止
   * 记住的目录优先，这样 20 个 take 只会在第一次问一次文件夹。
   */
  async function resolveOutputDirectory(count) {
    if (getOutputDirectory) {
      try {
        const remembered = await getOutputDirectory();
        if (remembered) return { directory: remembered, cancelled: false };
      } catch (error) {
        log(`Output directory WARN: ${error?.message || error}；改为临时选择`);
      }
    }
    if (count <= 1) return { directory: null, cancelled: false };
    if (pickOutputDirectory) {
      return { directory: (await pickOutputDirectory()) || null, cancelled: true };
    }
    if (!("showDirectoryPicker" in window)) {
      throw new Error("当前浏览器不支持批量选择输出目录；请使用 Chrome / Edge，或逐个保存");
    }
    try {
      return { directory: await window.showDirectoryPicker({ mode: "readwrite" }), cancelled: false };
    } catch (error) {
      if (error?.name === "AbortError") return { directory: null, cancelled: true };
      throw new Error("无法使用这个输出文件夹。Chrome 不允许网页直接写入某些受保护的常用文件夹（如“下载”“文稿”“桌面”本身）；请在其中新建并选择一个子文件夹，例如 Downloads/AudioTCChange_Poly，或在「输出配置」里记住一个子目录。");
    }
  }

  /** 目标目录里已有同名文件时先问一句，不静默截断。 */
  async function confirmOverwriteForDirectory(directory, plannedNames, profileLabel) {
    let existing = new Set();
    try {
      existing = await existingOutputNames(directory, plannedNames);
    } catch (error) {
      // 读不了目录就没法问"要不要覆盖"，这时静默继续就等于回到改动前的静默截断。
      // 直接中止并把原因说清楚，比让用户事后发现文件被覆盖要好。
      throw new Error(`无法读取输出文件夹的内容，没法确认会不会覆盖同名文件（${error?.message || error}）。为避免静默覆盖，本次导出已中止；请换一个输出文件夹重试。`);
    }
    const { collisions } = partitionCollidingNames(plannedNames, existing);
    if (!collisions.length) return true;
    if (!requestOverwrite) {
      log(`Overwrite WARN: ${collisions.join(", ")} 已存在且没有覆盖确认流程，将被覆盖`);
      return true;
    }
    log(`Overwrite ASK: ${collisions.join(", ")}`);
    return Boolean(await requestOverwrite(collisions, { profileLabel }));
  }

  async function combinePolyFiles(overrides = {}) {
    const groups = combineEligibleGroups();
    if (!groups.length) throw new Error("没有识别到可合并的分轨 take");
    const exportOptions = { ...configuredOptions, ...(await getExportOptions?.(groups) || {}), ...overrides };
    const profile = polyExportProfile(exportOptions.profile || "resolve");
    const knownSourceKeys = new Set(groups.flatMap(([, records]) => records.flatMap(record => Array.from({ length: record.channels }, (_, channel) => `${recordKey(record)}:${channel}`))));
    for (const name of ["selectedSourceChannels", "excludedSourceChannels", "ltcSourceChannels"]) {
      for (const key of exportOptions[name] || []) if (!knownSourceKeys.has(key)) throw new Error(`输出通道不存在：${key}`);
    }
    const { previewMap, hasPreviewTimecode } = previewMapForGroups(groups);
    const { ltcMap, hasLtcTimecode } = ltcMapForGroups(groups);
    const muteLtc = hasLtcTimecode && shouldMuteLtc?.() !== false;
    const droppedTakes = describeDroppedTakeGroups?.() || null;
    const rememberedDirectory = getOutputDirectory ? await getOutputDirectory().catch(() => null) : null;
    const choice = await confirmCombinePoly(groups, {
      hasPreviewTimecode,
      hasLtcTimecode,
      muteLtc,
      profile: profile.id,
      ltcPolicy: profile.ltcPolicy,
      droppedTakes,
      takeHealth: takeHealthScopeForCombine(getTakeHealthView?.(), groups),
      channelSummary: exportOptions.channelSummary || "",
      referenceSourceChannel: exportOptions.referenceSourceChannel || "",
      hasRememberedDirectory: Boolean(rememberedDirectory),
      outputDestinationLabel: rememberedDirectory
        ? `已记住的文件夹 <strong>${rememberedDirectory.name || "输出目录"}</strong>`
        : groups.length > 1 ? "本次会让你选一个输出文件夹" : "逐个选择保存位置",
    });
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
    const outputNames = groupsToWrite.map(([key]) => polyOutputNameFor(key).toLowerCase());
    if (new Set(outputNames).size !== outputNames.length) throw new Error("不同目录的 take 将产生同名 Poly；为避免覆盖，请分批导出或先区分 take 名称");
    const { directory: outputDirectory, cancelled } = await resolveOutputDirectory(groupsToWrite.length);
    if (cancelled) return;
    if (outputDirectory) {
      const plannedNames = groupsToWrite.map(([key]) => polyOutputNameFor(key));
      if (exportOptions.referenceSourceChannel) plannedNames.push(polyReferenceOutputNameFor(plannedNames[0]));
      if (!await confirmOverwriteForDirectory(outputDirectory, plannedNames, profile.label)) return;
    }

    setState("合并中", "warn");
    els.combinePolyBtn.disabled = true;
    els.statusLine.textContent = "Combining split tracks...";
    updateWriteProgress("正在合并 Poly…", "", 0, groupsToWrite.length);
    els.progressOverlay.classList.add("show");

    const results = [];
    const checklists = [];
    try {
      for (let i = 0; i < groupsToWrite.length; i++) {
        const [key, groupRecords] = groupsToWrite[i];
        updateWriteProgress("正在合并 Poly…", shortGroupLabel(key), i, groupsToWrite.length);
        const result = outputDirectory
          ? await writeCombinedPolyToDirectory(outputDirectory, key, groupRecords, policies.get(key), i, groupsToWrite.length)
          : await writeCombinedPolyFile(key, groupRecords, policies.get(key), i, groupsToWrite.length);
        if (exportOptions.referenceSourceChannel) {
          try {
            const refName = polyReferenceOutputNameFor(result.name);
            // 有目录时 SyncRef 直接落在同一目录，省掉一次保存框，也和主 Poly 待在一起。
            const handle = outputDirectory
              ? await outputDirectory.getFileHandle(refName, { create: true })
              : await window.showSaveFilePicker({ suggestedName: refName, types: [{ description: "Mono sync reference", accept: { "audio/wav": [".wav"] } }] });
            await writeCombinedPolyToWritable(key, groupRecords, await handle.createWritable(), outputDirectory ? refName : handle.name, {
              ...policies.get(key), selectedSourceChannels: new Set([exportOptions.referenceSourceChannel]),
              onProgress: updateWriteProgress, fallbackFpsValue: getFpsValue?.(),
            });
            result.referenceName = outputDirectory ? refName : handle.name;
          } catch (error) { log(`SyncRef WARN: ${error.message}; 主 Poly 已保存`); }
        }
        // 清单必须在写 sidecar 之前建好：它要进 _合板说明.txt，不能等面板。
        const checklist = checklistFor(result, {
          profileId: profile.id,
          referenceSourceChannel: exportOptions.referenceSourceChannel,
          takeKey: key,
        });
        try { if (outputDirectory) await saveSidecars(outputDirectory, result, checklist); else downloadWorkflow(result, checklist); }
        catch (error) { log(`Sync guide WARN: ${error.message}; Poly 已保存，可从 docs/声音合板指南.md 查看说明`); }
        if (result.clippedSamples || result.invalidSamples) log(`Poly WARN: ${result.name}: PCM24 转换削波 ${result.clippedSamples} samples，非有限值 ${result.invalidSamples}；请使用原始 float 或降低增益`);
        results.push(result);
        if (checklist) checklists.push({ result, takeKey: key, checklist });
        updateWriteProgress("正在合并 Poly…", result.name, i + 1, groupsToWrite.length);
      }
      const stateLabel = choice === "preview" || choice === "ltc" ? "已更改并合并" : "已合并";
      setState(stateLabel);
      const allRecordKeys = new Set(
        groupsToWrite.flatMap(([, groupRecords]) => groupRecords.map(record => recordKey(record)))
      );
      setCombinedPolyKeys(allRecordKeys);
      renderRows();
      const timecodeNote = choice === "preview"
        ? "; used preview timecode"
        : choice === "ltc"
          ? "; used LTC timecode"
          : "";
      const muteNote = mutedSourceChannels.size ? profile.ltcPolicy === "exclude" ? "; excluded confirmed LTC channels" : profile.id === "archive" ? "; muted LTC track" : "; retained LTC" : "";
      log(`Combine Poly OK: ${results.map(result => `${result.name} (${result.channels}ch)`).join(", ")}${timecodeNote}${muteNote}`);

      // 验收面板。批量导出时每个 take 各有一份清单，面板逐份显示——
      // 只给最后一份会让"已经合了但没验收"的 take 消失。
      let acceptanceSummary = null;
      if (checklists.length) {
        try { acceptanceSummary = showAcceptanceChecklist?.(checklists) ?? null; } catch (error) { log(`Acceptance panel WARN: ${error?.message || error}`); }
      }
      const needsHuman = acceptanceSummary?.needsHuman ?? 0;
      const failCount = acceptanceSummary?.fail ?? 0;
      const acceptanceNote = needsHuman
        ? `；还有 ${needsHuman} 项需要你人工确认`
        : failCount ? `；有 ${failCount} 项发现问题` : "";

      els.statusLine.textContent = `Poly 合并完成：${results.length} 个文件${acceptanceNote}`;
      els.toast.textContent = `✅ Poly 合并完成 — ${results.length} 个文件${acceptanceNote}`;
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
