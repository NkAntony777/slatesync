import {
  fpsLabel,
  normalizeTimeReference,
  parseFps,
  samplesForRate,
} from "./timecode.js";
import { scanWave } from "./wave.js";
import { muteLtcChannel as muteLtcChannelAudio } from "./wave-audio.js";
import {
  verifyIxmlTimeReference,
  writeTimeReference,
} from "./wave-time-reference.js";
import {
  formatDuration,
  manifestCsv as buildManifestCsv,
} from "./metadata-export.js";
import {
  recordKey,
  recordLabel,
} from "./grouping.js";

// ---------------------------------------------------------------------------
// 写入前备份（撤销名副其实）
//
// 背景：撤销原本只把 TimeReference 元数据写回去。而"写入 LTC 时码"这条路径会
// 顺手把 LTC 通道静音——音频被就地抹掉，元数据撤销救不回来，文件体积再大也
// 无法还原。因此这里在**任何原地修改源 WAV 之前**先在源文件同目录留一份字节
// 完全一致的副本，撤销时把整个文件的内容复制回去。
//
// 备份命名：`<原名>.bak`（例如 `ZOOM0001_Tr6.WAV` → `ZOOM0001_Tr6.WAV.bak`）
//   1. 由源文件名直接追加得到，不解析扩展名，所以带点号的素材名也不会歧义，
//      名字完全可预测，撤销时能反推出源文件名。
//   2. 刻意**不**以 .wav/.wave 结尾。导入侧按 `WAV_SUFFIX = /\.(wav|wave)$/i`
//      过滤（见 index.html 的 WAV_SUFFIX 与 src/file-import.js 的 addDirectory），
//      如果备份叫 `X.WAV.bak.wav`，下次重新导入同一文件夹时备份会被当成一个
//      假的分轨 take 混进列表，用户可能反过来往备份里写时码。用 `.bak` 结尾
//      可以让导入器直接忽略它。
//   3. 不会和本工具自己产出的文件冲突：合板输出是 `<组名>_Poly.WAV` /
//      `<组名>_SyncRef.WAV`，边车文件是 `_合板说明.txt` / `_channels.json`，
//      清单是 `timecode_fix_manifest_*.csv`，都不以 `.bak` 结尾。
//
// 原子性：File System Access API 没有 rename/move，无法做"临时文件 + rename"。
// 所以改用**完成标记（commit marker）**作为等价手段：
//   1. 先写 `<备份名>.pending` 标记文件（很小，内容是源文件名和字节数）；
//   2. 再把源文件字节流式复制进 `<备份名>`；
//   3. 校验落盘字节数 == 源字节数；
//   4. 删除 `.pending` 标记 —— 到这一步备份才算"完整可用"。
// 读侧永远把"`.bak` 存在且没有同名 `.pending`"当作有效的唯一判据，所以中途
// 崩溃留下的半截 `.bak` 不会被当成有效备份使用（撤销会直接报错而不是拿垃圾
// 覆盖源文件），用户也能一眼看到旁边有个 `.pending` 说明上次没写完。
// 另外 Chrome 的 createWritable 本身就是"暂存文件 + close() 时交换"的语义，
// 标记文件是跨实现的安全网，不增加任何额外 I/O。
//
// 已存在备份的策略：**刷新（覆盖）**，不跳过、不询问。
//   跳过的后果是撤销会退回到更早的状态，把两次写入之间的改动悄悄丢掉——
//   那才是真的丢数据。刷新则让备份始终等于"本次写入前的状态"，正是撤销应该
//   回到的那个点。刷新同样走上面的标记流程，中途失败也不会毁掉上一份好备份之外
//   的任何东西（源文件仍未被修改）。
// ---------------------------------------------------------------------------

export const BACKUP_SUFFIX = ".bak";
export const BACKUP_PENDING_SUFFIX = ".pending";

const BACKUP_COPY_CHUNK = 8 * 1024 * 1024;

export function backupNameFor(sourceName) {
  return `${sourceName}${BACKUP_SUFFIX}`;
}

export function backupPendingNameFor(backupName) {
  return `${backupName}${BACKUP_PENDING_SUFFIX}`;
}

export function isBackupName(name) {
  return typeof name === "string" && name.toLowerCase().endsWith(BACKUP_SUFFIX);
}

export function isBackupPendingName(name) {
  return typeof name === "string" && name.toLowerCase().endsWith(`${BACKUP_SUFFIX}${BACKUP_PENDING_SUFFIX}`);
}

function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function isNotFoundError(error) {
  return error?.name === "NotFoundError";
}

/**
 * 纯函数：算一次"即将写入"会备份多少东西，交给 UI 在写入前告诉用户
 * 文件数和字节数（RF64 大文件可能是几个 GB，翻倍复制不是小开销）。
 * 字节数来自最后一次 scanWave 得到的 file.size，是估算值。
 */
export function buildBackupPlan(records, { enabled = true } = {}) {
  const seen = new Set();
  const backupNames = [];
  const unbackedRecords = [];
  let totalBytes = 0;

  for (const record of records || []) {
    if (!record || record._meta || record._video) continue;
    if (typeof record.fileHandle?.createWritable !== "function") continue;
    const name = record.name;
    if (seen.has(name)) continue;
    seen.add(name);
    if (!record.parentHandle) {
      unbackedRecords.push(recordLabel(record));
      continue;
    }
    backupNames.push(backupNameFor(name));
    totalBytes += Number(record.file?.size) || 0;
  }

  const on = Boolean(enabled);
  return {
    enabled: on,
    fileCount: on ? backupNames.length : 0,
    totalBytes: on ? totalBytes : 0,
    totalBytesText: on ? formatBytes(totalBytes) : "0 B",
    backupNames: on ? backupNames : [],
    // 备份开着但拿不到父目录句柄时，这些文件没法在源目录里落备份。
    unbackedRecords,
  };
}

async function writeTextFile(handle, text) {
  const writable = await handle.createWritable();
  try {
    await writable.write(new Blob([text], { type: "text/plain;charset=utf-8" }));
    await writable.close();
  } catch (error) {
    try { await writable.abort(); } catch { /* 已经失败，流状态不可知 */ }
    throw error;
  }
}

async function safeRemove(directory, name) {
  try {
    await directory.removeEntry(name);
    return true;
  } catch {
    return false;
  }
}

async function tryGetFileHandle(directory, name) {
  try {
    return await directory.getFileHandle(name);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

/**
 * 分块复制。每次 await 都让出事件循环，所以几个 GB 的备份也不会把 UI 卡死到
 * 浏览器被杀。写完返回实际复制的字节数。
 */
async function copyFileInto(sourceFile, writable, onProgress) {
  let copied = 0;
  while (copied < sourceFile.size) {
    const end = Math.min(copied + BACKUP_COPY_CHUNK, sourceFile.size);
    const data = new Uint8Array(await sourceFile.slice(copied, end).arrayBuffer());
    await writable.write({ type: "write", position: copied, data });
    copied += data.byteLength;
    await onProgress?.(copied, sourceFile.size);
  }
  return copied;
}

function backupFailureMessage(record, backupName, error) {
  const directoryText = record.parentPath ? `${record.parentPath}/` : "";
  const reason = error?.message ? String(error.message) : String(error);
  return [
    `${recordLabel(record)}: 备份失败，源文件未被修改。`,
    `备份目标：${directoryText}${backupName}`,
    `原因：${reason}`,
    "本次写入已中止，不会留下改了一半的源文件。",
    "请确认该目录可写、磁盘剩余空间足够（RF64 大文件需要等量的额外空间），",
    "或关闭备份开关后再写入（此时撤销只能回写元数据，无法恢复被静音的音频）。",
  ].join(" ");
}

export function createTimeReferenceWriteController({
  els,
  getDirectoryHandle,
  getRecords,
  setRecords,
  getPreviews,
  setPreviews,
  getActiveOffset,
  setActiveOffset,
  getLastUndoBatch,
  setLastUndoBatch,
  getLtcResults,
  shouldMuteLtc,
  // 可选：() => boolean。默认开启（安全默认）。关掉后撤销退回到只回写元数据。
  shouldBackup,
  setChangedTimeReferences,
  refreshTakeGroups,
  offsetInput,
  recordFpsValue,
  recordFpsSource,
  recordFpsDisplay,
  fpsSelectLabel,
  recordFps,
  samplesToTimecode,
  confirmWriteChanges,
  confirmSoftSyncWrite,
  setState,
  updateWriteProgress,
  log,
  renderRows,
}) {
  function backupEnabled() {
    return shouldBackup?.() !== false;
  }

  function writePlan() {
    return buildBackupPlan(getRecords(), { enabled: backupEnabled() });
  }

  /**
   * 判断某个备份当前是否"完整可用"。判据就是上面定义的标记文件约定：
   * .bak 存在 + 同名 .pending 不存在。返回 { ok, reason, handle, size }。
   */
  async function inspectBackup(backup) {
    if (!backup) return { ok: false, reason: "no-backup" };
    let directory;
    let handle;
    try {
      directory = backup.directory;
      handle = await tryGetFileHandle(directory, backup.name);
    } catch (error) {
      return { ok: false, reason: `unreadable: ${error?.message || error}` };
    }
    if (!handle) return { ok: false, reason: "missing" };
    let pending = null;
    try {
      pending = await tryGetFileHandle(directory, backupPendingNameFor(backup.name));
    } catch (error) {
      return { ok: false, reason: `unreadable: ${error?.message || error}` };
    }
    if (pending) return { ok: false, reason: "incomplete", handle };
    let size = 0;
    try {
      size = (await handle.getFile()).size;
    } catch (error) {
      return { ok: false, reason: `unreadable: ${error?.message || error}` };
    }
    return { ok: true, handle, size };
  }

  /**
   * 在源文件同目录写一份字节一致的完整副本。任何一步失败都会清理掉半成品
   * 并抛出可操作的错误——因为它一定发生在任何源文件写入之前，所以调用方
   * 直接把异常抛出去就等于"中止写入，源文件分毫未动"。
   */
  async function createBackupFor(record, onProgress) {
    const backupName = backupNameFor(record.name);
    const pendingName = backupPendingNameFor(backupName);
    const directory = record.parentHandle;
    const sourceFile = await record.fileHandle.getFile();
    const sourceSize = sourceFile.size;
    const markerText = `SlateSync 备份进行中（写完后这个文件会被自动删除）\nsource: ${record.name}\nsize: ${sourceSize} bytes\n`;

    let writable = null;
    try {
      // 1. 先立标记：只要 .pending 还在，下游就不认这个 .bak。
      await writeTextFile(await directory.getFileHandle(pendingName, { create: true }), markerText);

      // 2. 备份已存在时直接刷新，保证撤销回到的是"本次写入前"而不是更早的状态。
      const handle = await directory.getFileHandle(backupName, { create: true });
      writable = await handle.createWritable();
      const copied = await copyFileInto(sourceFile, writable, (done, total) =>
        onProgress?.(done, total));
      await writable.close();
      writable = null;

      // 3. 校验落盘大小，磁盘满/静默截断都会在这里被挡住。
      const writtenSize = (await handle.getFile()).size;
      if (writtenSize !== sourceSize || copied !== sourceSize) {
        throw new Error(`备份字节数不符：期望 ${sourceSize}，实际 ${writtenSize}`);
      }

      // 4. 提交：删掉标记，备份从此可用。删不掉就必须中止写入——否则撤销会
      //    因为标记还在而拒绝使用这份好备份，写出去就再也撤销不回来了。
      if (!await safeRemove(directory, pendingName)) {
        throw new Error(`无法删除完成标记 ${pendingName}，备份无法被识别为有效`);
      }
      log(`Backup OK: ${record.name} -> ${backupName} (${formatBytes(sourceSize)})`);
      return { name: backupName, directory, handle, size: sourceSize, sourceName: record.name };
    } catch (error) {
      if (writable) {
        try { await writable.abort(); } catch { /* 流已损坏，尽力而为 */ }
      }
      await safeRemove(directory, pendingName);
      await safeRemove(directory, backupName);
      throw new Error(backupFailureMessage(record, backupName, error));
    }
  }

  /**
   * 备份一批即将被原地修改的源文件。返回 recordKey -> 备份信息 的映射。
   * 备份关闭时返回 null（撤销会自动退回只回写元数据的老路径）。
   */
  async function createBackupsFor(records, { total = records.length } = {}) {
    if (!backupEnabled()) {
      log("Backup: disabled by shouldBackup() — undo will only revert metadata.");
      return null;
    }

    // 先整体体检：有任何一条拿不到父目录句柄就立刻失败，不要留下一堆没用的备份。
    const missing = records.filter(record => !record.parentHandle);
    if (missing.length) {
      throw new Error([
        `${missing.map(record => recordLabel(record)).join("、")}: 无法定位源文件所在目录，不能创建可恢复的备份（${backupNameFor(missing[0].name)}）。`,
        "为避免写出撤销不回来的文件，本次写入已中止，源文件未被修改。",
        "请用“选择文件夹”导入素材（拖入单个文件拿不到目录句柄），或关闭备份开关后再写入。",
      ].join(" "));
    }

    const plan = buildBackupPlan(records, { enabled: true });
    log(`Backup: ${plan.fileCount} file(s), ${plan.totalBytesText} to copy (${plan.backupNames.slice(0, 4).join(", ")}${plan.backupNames.length > 4 ? ", …" : ""})`);

    const results = new Map();
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const key = recordKey(record);
      if (results.has(key)) continue;
      updateWriteProgress("正在备份原始文件…", recordLabel(record), i, total);
      const backup = await createBackupFor(record, (done, bytes) =>
        updateWriteProgress("正在备份原始文件…", `${recordLabel(record)} (${Math.round((done / bytes) * 100)}%)`, i, total));
      results.set(key, backup);
      updateWriteProgress("正在备份原始文件…", recordLabel(record), i + 1, total);
    }
    return results;
  }

  /**
   * 用备份把源文件的完整字节内容写回去——被静音的 LTC 音频在这里真的回来了。
   */
  async function restoreFileFromBackup(item, backupState, progressBase, progressTotal) {
    const backupFile = await backupState.handle.getFile();
    const writable = await item.fileHandle.createWritable();
    let copied = 0;
    try {
      copied = await copyFileInto(backupFile, writable, (done, bytes) => {
        const ratio = progressBase + (done / Math.max(1, bytes));
        updateWriteProgress("正在撤销…", `${item.name} (${Math.round((done / bytes) * 100)}%)`, ratio, progressTotal);
      });
      // 源文件在写入时可能被塞进 bext chunk 变大了，必须截回备份的原始长度。
      await writable.truncate(backupFile.size);
      await writable.close();
    } catch (error) {
      try { await writable.abort(); } catch { /* 保留原始错误 */ }
      throw new Error(`${item.name}: 从备份恢复失败（${error?.message || error}）`);
    }

    const restoredSize = (await item.fileHandle.getFile()).size;
    if (copied !== backupFile.size || restoredSize !== backupFile.size) {
      throw new Error(`${item.name}: 从备份恢复后字节数不符（期望 ${backupFile.size}，实际 ${restoredSize}）`);
    }
    return restoredSize;
  }

  async function refreshRecordsFromHandles() {
    const current = getRecords();
    const refreshed = await Promise.all(current.map(record => {
      if (record._meta || record._video) return record;
      return scanWave(record.fileHandle, {
        relativePath: record.relativePath,
        parentPath: record.parentPath,
        parentHandle: record.parentHandle,
      });
    }));
    setRecords(refreshed);
    refreshTakeGroups();
  }

  async function runPreview() {
    els.applyBtn.disabled = true;
    setPreviews([]);
    setActiveOffset(null);
    renderRows();
    setState("预览中", "warn");
    els.statusLine.textContent = "Calculating shifted timecode...";

    const records = getRecords();
    const fallbackFps = parseFps(els.fpsInput.value);
    if (!records.length) throw new Error("请拖入文件夹或音频文件");

    const nextPreviews = [];
    let firstOffset = null;
    for (const record of records) {
      const fpsValue = recordFpsValue(record);
      const fps = parseFps(fpsValue);
      const offset = offsetInput.parseOffset(els.offsetInput.value, fps);
      if (!firstOffset) firstOffset = offset;
      const sampleOffset = samplesForRate(offset, record.sampleRate);
      const newTimeReference = normalizeTimeReference(record.oldTimeReference + sampleOffset, record.sampleRate);
      const oldStartTc = samplesToTimecode(record.oldTimeReference, record.sampleRate, fps, { wrapDay: true });
      const newStartTc = samplesToTimecode(newTimeReference, record.sampleRate, fps, { wrapDay: true });
      const oldEndTc = samplesToTimecode(record.oldTimeReference + record.durationSamples, record.sampleRate, fps, { wrapDay: true });
      const newEndTc = samplesToTimecode(newTimeReference + record.durationSamples, record.sampleRate, fps, { wrapDay: true });
      nextPreviews.push({
        ...record,
        offset,
        sampleOffset,
        fps,
        fpsValue,
        fpsSource: recordFpsSource(record),
        fpsDisplay: recordFpsDisplay(record),
        newTimeReference,
        oldStartTc,
        newStartTc,
        oldEndTc,
        newEndTc,
        duration: formatDuration(record.durationSamples, record.sampleRate),
      });
    }

    setPreviews(nextPreviews);
    setActiveOffset(firstOffset);
    renderRows();
    els.applyBtn.disabled = false;
    const allMeta = nextPreviews.every(p => p._meta || p._video);
    if (allMeta) {
      els.applyBtn.disabled = true;
      setState("可导出");
      els.statusLine.textContent = `${nextPreviews.length} 个视频元数据已生成修改预览，可直接导出 ALE/CSV`;
    } else {
      setState("可写入");
      els.statusLine.textContent = `${nextPreviews.length} 个文件已生成修改预览`;
    }
    log(`Preview OK: ${nextPreviews.length} files, per-file FPS from iXML where available, UI fallback ${fpsLabel(fallbackFps)}`);
  }

  async function writeManifestToFolder() {
    const directoryHandle = getDirectoryHandle();
    if (!directoryHandle) return null;
    const now = new Date();
    const stamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      "_",
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join("");
    const handle = await directoryHandle.getFileHandle(`timecode_fix_manifest_${stamp}.csv`, { create: true });
    const writable = await handle.createWritable();
    await writable.write(new Blob([buildManifestCsv(getPreviews(), {
      fpsSelectLabel,
      recordFps,
      recordFpsSource,
      recordFpsValue,
      recordLabel,
      samplesToTimecode,
    })], { type: "text/csv;charset=utf-8" }));
    await writable.close();
    return handle.name;
  }

  async function muteLtcChannel(record, channelIndex, writable, progressBase, progressTotal) {
    return muteLtcChannelAudio(record, channelIndex, writable, progressBase, progressTotal, updateWriteProgress);
  }

  async function writeLtcTimecode() {
    const records = getRecords();
    const ltcResults = getLtcResults();
    const writableItems = records
      .map(record => ({ record, ltc: ltcResults.get(recordKey(record)) }))
      .filter(item => item.ltc?.ok && !item.record._meta && !item.record._video && item.record.fileHandle?.createWritable);
    if (!writableItems.length) throw new Error("没有可写入的 LTC 识别结果");

    // 兜底算法（软同步）结果不与普通结果合并确认：它们无法交叉验证，且实测出现过
    // 读出错误时码的情况。必须先逐条看过要写入的具体时码。
    const softItems = writableItems.filter(item => item.ltc?.requiresConfirmation);
    if (softItems.length) {
      const softOk = await confirmSoftSyncWrite(softItems);
      if (!softOk) return;
    }

    const muteLtc = shouldMuteLtc?.() !== false;
    const ok = await confirmWriteChanges(writableItems.length, muteLtc);
    if (!ok) return;

    setState("LTC写入中", "warn");
    els.writeLtcBtn.disabled = true;
    els.extractLtcBtn.disabled = true;
    els.applyBtn.disabled = true;
    els.undoBtn.disabled = true;
    els.statusLine.textContent = "Writing LTC timecode...";
    updateWriteProgress("正在写入 LTC…", "", 0, writableItems.length);
    els.progressOverlay.classList.add("show");

    const undoBatch = writableItems.map(({ record }) => ({
      fileHandle: record.fileHandle,
      name: record.name,
      relativePath: record.relativePath,
      parentPath: record.parentPath,
      parentHandle: record.parentHandle,
      sampleRate: record.sampleRate,
      timeReferenceOffset: record.timeReferenceOffset,
      oldTimeReference: record.oldTimeReference,
      ixmlInfo: record.ixmlInfo,
      backup: null,
    }));

    try {
      // 先备份再动源文件。备份失败会在这里抛出，源文件一个字节都还没改过。
      const backups = await createBackupsFor(writableItems.map(({ record }) => record), {
        total: writableItems.length,
      });
      undoBatch.forEach((item, index) => {
        item.backup = backups?.get(recordKey(writableItems[index].record)) || null;
      });

      for (let i = 0; i < writableItems.length; i++) {
        const { record, ltc } = writableItems[i];
        const isSource = recordKey(record) === recordKey(ltc.sourceRecord);
        updateWriteProgress("正在写入 LTC…", recordLabel(record), i, writableItems.length);
        await writeTimeReference(record, ltc.newTimeReference);
        if (isSource && muteLtc) {
          const freshForMute = await scanWave(record.fileHandle, {
            relativePath: record.relativePath,
            parentPath: record.parentPath,
            parentHandle: record.parentHandle,
          });
          const writable = await record.fileHandle.createWritable({ keepExistingData: true });
          try {
            await muteLtcChannel(freshForMute, ltc.channelIndex, writable, i + 0.2, writableItems.length);
          } finally {
            await writable.close();
          }
        }
        ltc.ok = false;
        ltc.status = "ok";
        ltc.statusText = isSource
          ? muteLtc
            ? `已写入；第 ${ltc.channelLabel} 轨已静音`
            : `已写入；第 ${ltc.channelLabel} 轨未静音`
          : `已写入；LTC来自 ${ltc.sourceRecord.name}`;
        updateWriteProgress("正在写入 LTC…", record.name, i + 1, writableItems.length);
      }

      updateWriteProgress("正在校验…", "校验 LTC 写入结果", writableItems.length, writableItems.length);
      for (const { record, ltc } of writableItems) {
        const fresh = await scanWave(record.fileHandle);
        if (fresh.oldTimeReference !== ltc.newTimeReference) {
          throw new Error(`${recordLabel(record)}: LTC 写入校验失败`);
        }
        verifyIxmlTimeReference(fresh, ltc.newTimeReference, recordLabel(record));
      }

      setLastUndoBatch(undoBatch);
      els.undoBtn.disabled = false;
      setPreviews([]);
      setActiveOffset(null);
      els.applyBtn.disabled = true;
      setChangedTimeReferences(new Map(writableItems.map(({ record, ltc }) => [recordKey(record), ltc.newTimeReference])));
      await refreshRecordsFromHandles();
      renderRows();
      setState("已更改");
      const backupNote = undoBatch[0]?.backup ? `；已备份 ${undoBatch.filter(item => item.backup).length} 个文件（.bak，可完整撤销）` : "";
      els.statusLine.textContent = `LTC 写入完成：${writableItems.length} 个文件${backupNote}`;
      log(`LTC Write OK: ${writableItems.length} files${backupNote ? `; backup ${undoBatch.filter(item => item.backup).length}` : "; no backup"}`);
      els.toast.textContent = `✅ LTC 写入完成 — ${writableItems.length} 个文件`;
      els.toast.classList.add("show");
      setTimeout(() => els.toast.classList.remove("show"), 4500);
    } finally {
      els.progressOverlay.classList.remove("show");
      updateWriteProgress("正在写入…", "", 0, writableItems.length || 1);
      els.extractLtcBtn.disabled = getRecords().length === 0;
      els.writeLtcBtn.disabled = !Array.from(getLtcResults().values()).some(result => {
        const record = result?.record;
        return result?.ok && record && !record._meta && !record._video && record.fileHandle?.createWritable;
      });
      els.undoBtn.disabled = !getLastUndoBatch();
    }
  }

  async function applyChanges() {
    const previews = getPreviews();
    if (!previews.length) throw new Error("没有可写入的预览");
    const wavPreviews = previews.filter(p => !p._meta && !p._video);
    const metaPreviews = previews.filter(p => p._meta || p._video);

    if (!wavPreviews.length && !metaPreviews.length) throw new Error("没有可应用的预览");

    // For metadata-only: just apply virtually (update changedTimeReferences, clear previews)
    if (!wavPreviews.length) {
      setChangedTimeReferences(new Map(metaPreviews.map(p => [recordKey(p), p.newTimeReference])));
      setPreviews([]);
      setActiveOffset(null);
      els.applyBtn.disabled = true;
      els.undoBtn.disabled = true;
      els.exportMetadataBtn.disabled = false;
      setState("可导出");
      els.statusLine.textContent = `${metaPreviews.length} 个元数据已应用偏移，可导出为 ALE/CSV`;
      renderRows();
      log(`Metadata Apply OK: ${metaPreviews.length} clips (virtual)`);
      return;
    }

    // Mix of WAV + metadata: write WAV files, virtual-apply metadata
    const ok = await confirmWriteChanges(wavPreviews.length);
    if (!ok) return;

    const appliedPreviews = wavPreviews.slice();
    setState("写入中", "warn");
    els.applyBtn.disabled = true;
    els.undoBtn.disabled = true;
    els.statusLine.textContent = "Writing...";
    const undoBatch = appliedPreviews.map(preview => ({
      fileHandle: preview.fileHandle,
      name: preview.name,
      relativePath: preview.relativePath,
      parentPath: preview.parentPath,
      parentHandle: preview.parentHandle,
      sampleRate: preview.sampleRate,
      timeReferenceOffset: preview.timeReferenceOffset,
      oldTimeReference: preview.oldTimeReference,
      ixmlInfo: preview.ixmlInfo,
      backup: null,
    }));

    const total = appliedPreviews.length + metaPreviews.length;
    updateWriteProgress("正在写入…", "", 0, total);
    els.progressOverlay.classList.add("show");

    try {
      // 先备份再动源文件。备份失败会在这里抛出，源文件一个字节都还没改过。
      const backups = await createBackupsFor(appliedPreviews, { total });
      undoBatch.forEach((item, index) => {
        item.backup = backups?.get(recordKey(appliedPreviews[index])) || null;
      });

      for (let i = 0; i < appliedPreviews.length; i++) {
        const preview = appliedPreviews[i];
        updateWriteProgress("正在写入…", preview.name, i, total);
        await writeTimeReference(preview, preview.newTimeReference);
        updateWriteProgress("正在写入…", preview.name, i + 1, total);
      }

      updateWriteProgress("正在校验…", "校验写入结果", total, total);

      for (const preview of appliedPreviews) {
        const fresh = await scanWave(preview.fileHandle);
        if (fresh.oldTimeReference !== preview.newTimeReference) {
          throw new Error(`${preview.name}: 校验失败`);
        }
        verifyIxmlTimeReference(fresh, preview.newTimeReference, preview.name);
      }

      let manifestName = null;
      try {
        updateWriteProgress("正在保存清单…", getDirectoryHandle() ? "生成 CSV manifest" : "已跳过清单", total, total);
        manifestName = await writeManifestToFolder();
      } catch (error) {
        log(`Manifest WARN: ${error.message}`);
      }

      const allChanged = new Map(appliedPreviews.map(preview => [recordKey(preview), preview.newTimeReference]));
      for (const mp of metaPreviews) {
        allChanged.set(recordKey(mp), mp.newTimeReference);
      }

      setLastUndoBatch(undoBatch);
      els.undoBtn.disabled = false;
      setChangedTimeReferences(allChanged);
      setPreviews([]);
      setActiveOffset(null);
      await refreshRecordsFromHandles();
      renderRows();
      setState("已更改");
      const extra = metaPreviews.length ? ` + ${metaPreviews.length} 元数据` : "";
      const backupCount = undoBatch.filter(item => item.backup).length;
      const backupNote = backupCount ? `；已备份 ${backupCount} 个文件（.bak，可完整撤销）` : "";
      els.statusLine.textContent = manifestName
        ? `写入完成${extra}；清单：${manifestName}${backupNote}`
        : `写入完成${extra}${backupNote}`;
      log(`Write OK: ${appliedPreviews.length} files${metaPreviews.length ? ` + ${metaPreviews.length} metadata` : ""}${manifestName ? `; ${manifestName}` : ""}${backupCount ? `; backup ${backupCount}` : "; no backup"}`);

      els.toast.textContent = manifestName
        ? `✅ 写入完成 — ${appliedPreviews.length} 个文件，已保存清单`
        : `✅ 写入完成 — ${appliedPreviews.length} 个文件`;
      els.toast.classList.add("show");
      setTimeout(() => els.toast.classList.remove("show"), 4500);
    } finally {
      els.progressOverlay.classList.remove("show");
      updateWriteProgress("正在写入…", "", 0, total || 1);
      els.undoBtn.disabled = !getLastUndoBatch();
    }
  }

  async function undoLastWrite() {
    const lastUndoBatch = getLastUndoBatch();
    if (!lastUndoBatch) throw new Error("没有可撤销的写入记录");

    setState("撤销中", "warn");
    els.applyBtn.disabled = true;
    els.undoBtn.disabled = true;
    els.statusLine.textContent = "Undoing...";
    updateWriteProgress("正在撤销…", "", 0, lastUndoBatch.length);
    els.progressOverlay.classList.add("show");

    try {
      // 先判定每个条目的备份能不能用。存在半截备份（.pending 还在）时直接报错，
      // 绝不拿它去覆盖源文件——那样会把唯一还能救回来的内容也毁掉。
      const states = [];
      for (let i = 0; i < lastUndoBatch.length; i++) {
        const item = lastUndoBatch[i];
        states.push({ item, state: await inspectBackup(item.backup) });
      }

      let restoredFromBackup = 0;
      for (let i = 0; i < states.length; i++) {
        const { item, state } = states[i];
        updateWriteProgress("正在撤销…", item.name, i, lastUndoBatch.length);

        if (item.backup && !state.ok) {
          if (state.reason === "incomplete") {
            throw new Error([
              `${item.name}: 备份 ${item.backup.name} 不完整（存在 ${backupPendingNameFor(item.backup.name)} 标记，说明上次备份没写完）。`,
              "为避免用半截备份覆盖源文件，撤销已中止，源文件未被修改。",
              "请删除该 .bak 与 .pending 后重新写入，或手动从别处的副本恢复。",
            ].join(" "));
          }
          log(`Undo WARN: ${item.name}: backup unusable (${state.reason}); falling back to metadata-only revert.`);
        }

        if (state.ok) {
          const currentSize = (await item.fileHandle.getFile()).size;
          if (currentSize !== state.size) {
            log(`Undo WARN: ${item.name}: size ${currentSize} differs from backup ${state.size}; source may have been edited outside SlateSync. Restoring from backup anyway.`);
          }
          // 完整字节恢复：被静音的 LTC 音频在这里回来。
          await restoreFileFromBackup(item, state, i, lastUndoBatch.length);
          restoredFromBackup++;
        } else {
          // 没有可用备份（例如备份开关关过）：退回只回写元数据的老行为。
          await writeTimeReference(item, item.oldTimeReference);
        }
        updateWriteProgress("正在撤销…", item.name, i + 1, lastUndoBatch.length);
      }

      updateWriteProgress("正在校验…", "校验撤销结果", lastUndoBatch.length, lastUndoBatch.length);
      for (const item of lastUndoBatch) {
        const fresh = await scanWave(item.fileHandle);
        if (fresh.oldTimeReference !== item.oldTimeReference) {
          throw new Error(`${item.name}: 撤销校验失败`);
        }
        verifyIxmlTimeReference(fresh, item.oldTimeReference, item.name);
      }

      setLastUndoBatch(null);
      setPreviews([]);
      setActiveOffset(null);
      setChangedTimeReferences(new Map());
      await refreshRecordsFromHandles();
      renderRows();
      setState("已撤销");
      const metadataOnly = lastUndoBatch.length - restoredFromBackup;
      const note = restoredFromBackup === lastUndoBatch.length
        ? `已撤销：${restoredFromBackup} 个文件从 .bak 完整还原（含被静音的音频）`
        : restoredFromBackup
          ? `已撤销：${restoredFromBackup} 个从 .bak 完整还原，${metadataOnly} 个仅回写元数据`
          : "已撤销上一次写入，显示已刷新";
      els.statusLine.textContent = note;
      els.toast.textContent = restoredFromBackup ? `↩ 撤销完成 — ${restoredFromBackup} 个文件已完整还原` : "↩ 撤销完成";
      els.toast.classList.add("show");
      setTimeout(() => els.toast.classList.remove("show"), 3500);
      // 备份保留不删：撤销后它仍是源文件之外唯一的一份原始内容，删掉等于把用户
      // 的安全网拿走。代价是磁盘占用，需要时由用户自己清理 .bak。
      log(`Undo OK: ${restoredFromBackup}/${lastUndoBatch.length} restored from backup; backups kept.`);
    } finally {
      els.progressOverlay.classList.remove("show");
      updateWriteProgress("正在写入…", "", 0, 1);
      els.undoBtn.disabled = !getLastUndoBatch();
    }
  }

  return {
    applyChanges,
    refreshRecordsFromHandles,
    runPreview,
    undoLastWrite,
    writeLtcTimecode,
    // --- 新增（纯增量，原有导出全部保留、签名未变）---
    backupEnabled,
    writePlan,
  };
}