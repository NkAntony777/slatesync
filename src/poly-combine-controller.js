import {
  combineTrackPlan,
  safeWaveBaseName,
  validateCombineGroup,
  writeCombinedPolyToWritable,
} from "./wave-combine.js";
import { POLY_EXPORT_PROFILES, applyPolyExportPolicy, polyExportProfile } from "./poly-export-profiles.js";
import { planRepairsForTracks } from "./repair-planner.js";
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

const BATCH_STAGE_LABELS = { timecode: "时码准备", validate: "预校验", write: "写入" };

/**
 * 一次批量合并的成败汇总。纯函数：不碰 DOM、不读文件。
 *
 * 批量作业里"坏一个就整批陪葬"是直接的产出损失——20 个 take 坏 1 个，结果可能是 0 个文件。
 * 所以每个 take 单独记账（见 combinePolyFiles 里的 outcomes），最后一次性告诉用户
 * 成功几个、失败几个、失败的是谁、为什么失败。
 *
 * failures 里每一项都带齐了阶段 3b 渲染一份失败清单所需的字段（takeKey / takeLabel /
 * name / stage / stageLabel / message），渲染层不该再回头去猜"这是哪个 take"。
 * statusText / toastText / countText 是三处 UI 共用的文案，避免各处各写一套措辞。
 */
export function summarizeBatchOutcomes(outcomes = []) {
  const entries = (Array.isArray(outcomes) ? outcomes : []).filter(Boolean);
  const failures = entries.filter(entry => !entry.ok).map(entry => {
    const raw = entry.message ?? entry.error?.message ?? entry.error;
    return {
      takeKey: String(entry.takeKey ?? ""),
      takeLabel: String(entry.takeLabel || entry.takeKey || ""),
      name: String(entry.name || ""),
      stage: String(entry.stage || "write"),
      stageLabel: BATCH_STAGE_LABELS[entry.stage] || BATCH_STAGE_LABELS.write,
      message: raw === undefined || raw === null || raw === "" ? "未知原因" : String(raw),
    };
  });
  const succeeded = entries.length - failures.length;
  const countText = `成功 ${succeeded} 个 / 失败 ${failures.length} 个`;
  // 状态行/toast 只放得下一条，完整清单交给日志面板，所以这里只点名第一个失败。
  const failureLines = failures.map(item => `${item.takeLabel}（${item.name || item.takeKey} · ${item.stageLabel}）：${item.message}`);
  const firstFailure = failureLines.length ? failureLines[0] : "";
  const moreFailures = failures.length > 1 ? `（还有 ${failures.length - 1} 个，详见日志）` : "";
  return {
    total: entries.length,
    succeeded,
    failed: failures.length,
    hasFailures: failures.length > 0,
    failures,
    countText,
    failureLines,
    // 阶段 3b 的失败清单可以直接铺 failureLines，或整块贴进日志面板的 failureText。
    failureText: failureLines.join("\n"),
    // 全成功时与改动前逐字相同：顺利路径的界面不该因为这次修复而换措辞。
    statusText: failures.length ? `Poly 合并完成：${countText} — ${firstFailure}${moreFailures}` : `Poly 合并完成：${succeeded} 个文件`,
    toastText: failures.length ? `⚠️ Poly 合并完成 — ${countText} — ${firstFailure}${moreFailures}` : `✅ Poly 合并完成 — ${succeeded} 个文件`,
  };
}

/** 单个 take 的失败记录。字段与 summarizeBatchOutcomes 产出的 failures 一一对应。 */
function takeFailure(takeKey, stage, error) {
  const raw = error?.message ?? error;
  return {
    ok: false,
    takeKey,
    takeLabel: shortGroupLabel(takeKey),
    name: polyOutputNameFor(takeKey),
    stage,
    message: raw === undefined || raw === null || raw === "" ? "未知原因" : String(raw),
  };
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

  // 逐 take 套用时码，失败的 take 收集起来而不是抛断整批。
  // 旧写法是 map 一次跑完，任何一个 take 缺时码就会让另外 19 个能写的 take 一起陪葬——
  // 和写入循环/预校验的"逐个成败"语义对不上，这里统一成同一套。
  function collectTimecodeGroups(groups, apply) {
    const kept = [];
    const failures = [];
    for (const [key, groupRecords] of groups) {
      try {
        kept.push([key, apply(groupRecords)]);
      } catch (error) {
        failures.push(takeFailure(key, "timecode", error));
      }
    }
    return { groups: kept, failures };
  }

  function previewTimecodeRecords(groupRecords, previewMap) {
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
    return nextRecords;
  }

  function ltcTimecodeRecords(groupRecords, ltcMap) {
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
    return nextRecords;
  }

  function recordsWithPreviewTimecode(groups, previewMap) {
    return collectTimecodeGroups(groups, groupRecords => previewTimecodeRecords(groupRecords, previewMap));
  }

  function recordsWithLtcTimecode(groups, ltcMap) {
    return collectTimecodeGroups(groups, groupRecords => ltcTimecodeRecords(groupRecords, ltcMap));
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
    const prepared = choice === "preview"
      ? recordsWithPreviewTimecode(groups, previewMap)
      : choice === "ltc"
        ? recordsWithLtcTimecode(groups, ltcMap)
        : { groups, failures: [] };
    // groupsToWrite 只含时码准备成功的 take；被刷掉的那些在 outcomes 里记成 "时码准备" 失败，
    // 用户仍然看得到"这一批里到底是哪几个没写出来"，而不是被一个异常整体带偏。
    const groupsToWrite = prepared.groups;
    const timecodeFailures = prepared.failures;
    const mutedSourceChannels = muteLtc ? mutedLtcChannelsForGroups(groups, ltcMap) : new Set();
    const policies = new Map(groupsToWrite.map(([key, records]) => [key, optionsForGroup(records, {
      ...exportOptions, profile: profile.id,
      mutedSourceChannels: profile.id === "archive" ? mutedSourceChannels : new Set(),
      ltcSourceChannels: exportOptions.ltcSourceChannels || (muteLtc ? mutedSourceChannels : new Set()),
    })]));

    // 对齐修复默认关闭（用户没勾就是没有 repair 字段）。开启后逐 take 现算：
    // 读头尾两段窗口 → 测偏移与漂移 → 把计划挂进该 take 的 policy。
    // 必须在预校验之前做完——时长不一致正是 validateCombineGroup 会抛的那一项，
    // 修复计划要先在案，才谈得上放行。任何一个 take 测不出来就跳过它自己，
    // 既不打断整批，也不拿低置信结果去改音频。
    if (exportOptions.repair?.enabled) {
      for (const [key, records] of groupsToWrite) {
        const policy = policies.get(key);
        let tracks = null;
        try { tracks = applyPolyExportPolicy(combineTrackPlan(records), policy).tracks; }
        catch (error) { log(`Repair WARN: ${shortGroupLabel(key)}: ${error.message}；该 take 不做对齐修复`); continue; }
        try {
          const planned = await planRepairsForTracks(tracks, exportOptions.repair.referenceKey || "", {
            sampleRate: Number(records[0]?.sampleRate) || 48000,
          });
          if (!planned.plans.size) {
            log(`Repair: ${shortGroupLabel(key)} 无需对齐修正（或测不出可靠偏移），按原样合并`);
            continue;
          }
          if (!planned.referenceMatched) {
            log(`Repair: ${shortGroupLabel(key)} 里没有你指定的基准轨，已自动改用 ${planned.referenceKey}`);
          }
          policies.set(key, { ...policy, repair: {
            enabled: true,
            referenceKey: planned.referenceKey,
            outputSamples: planned.outputSamples,
            plans: planned.plans,
          } });
          const summaryText = [...planned.plans.values()].map(plan =>
            `${plan.padSamples ? `补 ${plan.padSamples}` : ""}${plan.skipSamples ? `丢 ${plan.skipSamples}` : ""}${plan.needsResample ? ` 重采样 ${plan.driftRatio.toFixed(6)}` : ""}${plan.polarity === -1 ? " 极性反接" : ""}`
          ).join("；");
          log(`Repair: ${shortGroupLabel(key)} 以 ${planned.referenceKey} 为基准修正 ${planned.plans.size} 条分轨（${summaryText}）`);
        } catch (error) {
          log(`Repair WARN: ${shortGroupLabel(key)}: ${error?.message || error}；该 take 不做对齐修复`);
        }
      }
    }

    // 预校验改成"逐个收集"而不是"第一个错就整批中断"：批量导出里 1 个坏 take
    // 不该带走另外 19 个已经能写出的 take。这里只记账、不抛断——
    // 失败的 take 到写入循环里会被跳过并进失败清单，其余 take 照常落盘。
    const precheckFailures = new Map();
    for (const [key, records] of groupsToWrite) {
      try { validateCombineGroup(records, { ...policies.get(key), groupLabel }); }
      catch (error) {
        precheckFailures.set(key, error?.message ? String(error.message) : String(error));
        log(`Combine Poly PRECHECK WARN: ${shortGroupLabel(key)}: ${error?.message || error}；这个 take 会被跳过，其余 take 继续`);
      }
    }
    // Reference audio is deliberately explicit: the first channel might be LTC, room tone, or silent.
    if (exportOptions.referenceSourceChannel) {
      if (groupsToWrite.length !== 1) throw new Error("参考通道目前需逐 take 显式选择；请一次导出一个 take");
      // 预校验已经判失败的 take 不在这里再校验一次：同一个错会重新抛出来，
      // 又把"这个 take 失败"变回"整批 0 产出"。SyncRef 的通道检查留给用户重试这一批时再做。
      if (!precheckFailures.has(groupsToWrite[0][0])) {
        const plan = validateCombineGroup(groupsToWrite[0][1], policies.get(groupsToWrite[0][0]));
        if (!plan.tracks.some(track => `${recordKey(track.record)}:${track.channelIndex}` === exportOptions.referenceSourceChannel)) throw new Error("SyncRef 必须选择主 Poly 中保留的有效节目通道，不能是被排除的 LTC");
      }
    }
    // 同名 Poly 仍然是整批阻断（避免静默覆盖），而且刻意覆盖"计划写出的全部名字"，
    // 不因为某个 take 预校验失败就缩小范围：冲突是写盘前的计划问题，
    // 失败的 take 用户随时会重试，那时它照样会撞名。
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
    // 每个 take 一条成败记录（成功与失败都在这里），末尾一次性汇总给用户。
    const outcomes = [];
    const succeededKeys = new Set();
    // 时码阶段就被刷掉的 take 不进写入循环，直接进失败清单，保证"成功 + 失败 = 本批 take 总数"。
    outcomes.push(...timecodeFailures);
    if (timecodeFailures.length) {
      log(`Combine Poly TIMECODE WARN: ${timecodeFailures.length} 个 take 因时码不可用被跳过，其余 take 继续合并`);
    }
    try {
      for (let i = 0; i < groupsToWrite.length; i++) {
        const [key, groupRecords] = groupsToWrite[i];
        updateWriteProgress("正在合并 Poly…", shortGroupLabel(key), i, groupsToWrite.length);
        const precheckFailure = precheckFailures.get(key);
        // 失败的 take 同样占住自己的进度槽位：done/total 照旧是"处理完几个"，
        // 进度条不会因为一个坏 take 而卡在原地。
        let progressFile = `${shortGroupLabel(key)} 失败`;
        if (precheckFailure) {
          // 预校验失败的 take 刻意不落盘：走输出目录时 getFileHandle({ create: true })
          // 会先建出一个空文件，再在 writeCombinedPolyToWritable 里失败，白留 0 字节文件。
          outcomes.push(takeFailure(key, "validate", precheckFailure));
        } else {
          try {
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
            outcomes.push({ ok: true, takeKey: key, takeLabel: shortGroupLabel(key), name: result.name });
            succeededKeys.add(key);
            progressFile = result.name;
          } catch (error) {
            // 用户主动关掉保存框是"退出这次导出"，不是这个 take 失败：保持原来的抛出行为，
            // 让 guarded 去显示这句话，而不是把它算成一次可重试的失败。
            if (error?.name === "AbortError") throw error;
            outcomes.push(takeFailure(key, "write", error));
            log(`Combine Poly WARN: ${shortGroupLabel(key)}: ${error?.message || error}；已跳过这个 take，其余 take 继续`);
          }
        }
        updateWriteProgress("正在合并 Poly…", progressFile, i + 1, groupsToWrite.length);
      }
      const summary = summarizeBatchOutcomes(outcomes);
      const stateLabel = choice === "preview" || choice === "ltc" ? "已更改并合并" : "已合并";
      // 有失败时状态词要说实话：只剩"已合并"等于把"少写了 take"报成正常完成。
      if (summary.hasFailures) setState(results.length ? "部分已合并" : "合并失败", "warn");
      else setState(stateLabel);
      // 只有真正写出去的 take 才标记为已合并：失败的 take 若也被打标，
      // 界面会以为它已经有 Poly，用户想重试时反而找不到入口。
      const allRecordKeys = new Set(
        groupsToWrite
          .filter(([key]) => succeededKeys.has(key))
          .flatMap(([, groupRecords]) => groupRecords.map(record => recordKey(record)))
      );
      setCombinedPolyKeys(allRecordKeys);
      renderRows();
      const timecodeNote = choice === "preview"
        ? "; used preview timecode"
        : choice === "ltc"
          ? "; used LTC timecode"
          : "";
      const muteNote = mutedSourceChannels.size ? profile.ltcPolicy === "exclude" ? "; excluded confirmed LTC channels" : profile.id === "archive" ? "; muted LTC track" : "; retained LTC" : "";
      // 全批失败时 results 是空的，这条 OK 日志会变成一句空话——没写出文件就不说 OK。
      if (results.length) log(`Combine Poly OK: ${results.map(result => `${result.name} (${result.channels}ch)`).join(", ")}${timecodeNote}${muteNote}`);
      // 逐个 take 的失败原因在各自的位置已经打过 WARN，这里只交代总数，
      // 免得用户在日志里翻两遍同一件事。
      log(`Combine Poly DONE: ${summary.countText}`);
      // 状态行/toast 只装得下第一个失败，完整清单（含是哪个 take、哪个阶段、什么原因）
      // 必须落进日志面板，否则批量失败时用户无从知道少写了哪几个。
      if (summary.hasFailures) log(`Combine Poly FAILED:\n${summary.failureText}`);

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

      els.statusLine.textContent = `${summary.statusText}${acceptanceNote}`;
      els.toast.textContent = `${summary.toastText}${acceptanceNote}`;
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
