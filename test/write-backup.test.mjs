// 写入前备份 / 撤销真实还原 的回归测试。
//
// 这里用 mkdtempSync + 真实临时文件，并且用一个 node:fs 版的 File System Access
// API 适配器（getFileHandle / createWritable / removeEntry）驱动控制器，这样"备份
// 与源字节一致""撤销后音频真的回来了"都是对真实磁盘字节做的断言，而不是对内存
// 替身的断言。createWritable 模拟 Chrome 的"暂存文件 + close() 时 rename 交换"，
// 所以 abort() 不会留下半截文件。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

import { scanWave, readDataView } from "../src/wave.js";
import { samplesToTimecode } from "../src/timecode.js";
import {
  createTimeReferenceWriteController,
  buildBackupPlan,
  backupNameFor,
  backupPendingNameFor,
  isBackupName,
  isBackupPendingName,
  BACKUP_SUFFIX,
  BACKUP_PENDING_SUFFIX,
} from "../src/time-reference-write-controller.js";
import { encodeLtcAudio, encodeVoiceLike, writeWavPcm16 } from "./ltc-encode.mjs";

const SR = 48000;
// 与 index.html 的 WAV_SUFFIX 保持一致：备份必须不能被导入器当成一个 take。
const WAV_SUFFIX = /\.(wav|wave)$/i;
const BAK_SUFFIX_RE = new RegExp(`${BACKUP_SUFFIX}$`, "i");

// --------------------------------------------------------------------------
// node:fs 版 File System Access API 适配器
// --------------------------------------------------------------------------

class NodeWritable {
  constructor(targetPath, hooks, initial) {
    this.targetPath = targetPath;
    this.hooks = hooks;
    // 真实 createWritable({ keepExistingData: true }) 会把原文件内容预置进流里。
    this.buffer = initial ? Buffer.from(initial) : Buffer.alloc(0);
    this.closed = false;
    this.aborted = false;
    this.writeCount = 0;
  }
  async write(chunk) {
    if (this.closed || this.aborted) throw new Error("stream is closed");
    this.writeCount++;
    await this.hooks.onWrite?.(this, this.writeCount, this.targetPath);
    let bytes;
    let position;
    if (chunk && chunk.type === "write") {
      bytes = Buffer.from(chunk.data instanceof Uint8Array ? chunk.data : new Uint8Array(chunk.data));
      position = Number(chunk.position ?? this.buffer.length);
    } else if (typeof chunk?.arrayBuffer === "function") {
      // 真实实现接受 Blob / ArrayBufferView / ArrayBuffer 作为整体写入
      bytes = Buffer.from(new Uint8Array(await chunk.arrayBuffer()));
      position = this.buffer.length;
    } else {
      throw new Error(`unsupported writable chunk: ${Object.prototype.toString.call(chunk)}`);
    }
    const end = position + bytes.length;
    if (end > this.buffer.length) {
      const next = Buffer.alloc(end);
      this.buffer.copy(next);
      this.buffer = next;
    }
    bytes.copy(this.buffer, position);
  }
  async truncate(size) { this.buffer = this.buffer.subarray(0, size); }
  async close() {
    if (this.aborted) throw new Error("stream is aborted");
    const temp = `${this.targetPath}.stream-tmp`;
    writeFileSync(temp, this.buffer);
    renameSync(temp, this.targetPath);
    this.closed = true;
  }
  async abort() { this.aborted = true; }
}

function fileHandleFor(path, name, hooks = {}) {
  return {
    kind: "file",
    name,
    async getFile() { return new File([readFileSync(path)], name); },
    async createWritable(options = {}) {
      const initial = options.keepExistingData && existsSync(path) ? readFileSync(path) : null;
      return new NodeWritable(path, hooks, initial);
    },
  };
}

function dirHandleFor(dir, hooks = {}) {
  return {
    kind: "directory",
    name: basename(dir),
    async getFileHandle(name, options = {}) {
      await hooks.onGetFileHandle?.(name, options);
      const path = join(dir, name);
      if (!existsSync(path)) {
        if (!options.create) {
          const error = new Error(`${name} not found`);
          error.name = "NotFoundError";
          throw error;
        }
        writeFileSync(path, Buffer.alloc(0));
      }
      return fileHandleFor(path, name, hooks);
    },
    async removeEntry(name) {
      await hooks.onRemoveEntry?.(name);
      rmSync(join(dir, name), { force: true });
    },
  };
}

function fsError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

// --------------------------------------------------------------------------
// 控制器测试环境
// --------------------------------------------------------------------------

const stub = (extra = {}) => ({
  disabled: false,
  value: "25",
  classList: { add() {}, remove() {} },
  textContent: "",
  ...extra,
});

function makeEnv(records, {
  ltcResults = new Map(),
  previews = [],
  shouldBackup,
  shouldMuteLtc = () => true,
  confirmWriteChanges = async () => true,
  confirmSoftSyncWrite = async () => true,
  directoryHandle = null,
} = {}) {
  const logs = [];
  const state = { records, previews, ltcResults, lastUndoBatch: null, changed: new Map(), activeOffset: null };
  const progress = [];
  const els = {
    applyBtn: stub(), undoBtn: stub(), exportMetadataBtn: stub(),
    writeLtcBtn: stub(), extractLtcBtn: stub(), extractLtcFallbackBtn: stub(),
    previewBtn: stub(), statusLine: stub(), toast: stub(), fpsInput: stub(),
    progressOverlay: stub(),
  };
  const controller = createTimeReferenceWriteController({
    els,
    getDirectoryHandle: () => directoryHandle,
    getRecords: () => state.records,
    setRecords: next => { state.records = next; },
    getPreviews: () => state.previews,
    setPreviews: next => { state.previews = next; },
    getActiveOffset: () => state.activeOffset,
    setActiveOffset: next => { state.activeOffset = next; },
    getLastUndoBatch: () => state.lastUndoBatch,
    setLastUndoBatch: next => { state.lastUndoBatch = next; },
    getLtcResults: () => state.ltcResults,
    shouldMuteLtc,
    ...(shouldBackup === undefined ? {} : { shouldBackup }),
    setChangedTimeReferences: next => { state.changed = next; },
    refreshTakeGroups: () => {},
    offsetInput: { parseOffset: () => 0n, bindEvents() {} },
    recordFpsValue: () => "25",
    recordFpsSource: () => "ui",
    recordFpsDisplay: () => "25",
    fpsSelectLabel: v => v,
    recordFps: () => "25",
    samplesToTimecode,
    confirmWriteChanges,
    confirmSoftSyncWrite,
    setState() {},
    updateWriteProgress: (label, detail, done, total) => { progress.push([label, detail, done, total]); },
    log: message => { logs.push(message); },
    renderRows() {},
  });
  return { controller, state, els, logs, progress };
}

async function recordIn(dir, name, { withDirectory = true, channels, sampleRate = SR } = {}) {
  const track = channels ?? [encodeVoiceLike({ sampleRate, durationSeconds: 1 })];
  writeWavPcm16(join(dir, name), track, sampleRate);
  return scanWave(fileHandleFor(join(dir, name), name), {
    relativePath: `${basename(dir)}/${name}`,
    parentPath: basename(dir),
    parentHandle: withDirectory ? dirHandleFor(dir) : null,
  });
}

// 大于 BACKUP_COPY_CHUNK (8MB) 的素材，用来真正跑多块分片复制路径。
async function largeRecordIn(dir, name, { withDirectory = true, frames = 5_000_000 } = {}) {
  const track = [new Float32Array(frames).fill(0.25)];
  writeWavPcm16(join(dir, name), track, SR);
  return scanWave(fileHandleFor(join(dir, name), name), {
    relativePath: `${basename(dir)}/${name}`,
    parentPath: basename(dir),
    parentHandle: withDirectory ? dirHandleFor(dir) : null,
  });
}

const tempDir = () => mkdtempSync(join(tmpdir(), "slatesync-backup-"));

async function ltcStereoRecord(dir, name) {
  const ltc = encodeLtcAudio({ sampleRate: SR, fps: 25, startTc: "01:23:45:00", durationSeconds: 2, amplitude: 0.5 });
  const voice = encodeVoiceLike({ sampleRate: SR, durationSeconds: 2 });
  return recordIn(dir, name, { channels: [voice, ltc.data] });
}

function channelEnergy(file, record, channelIndex) {
  return readDataView(file, record.dataOffset, record.dataSize)
    .then(view => {
      let peak = 0;
      const bytes = record.bitsPerSample / 8;
      for (let frame = 0; frame < Number(record.durationSamples); frame++) {
        const value = view.getInt16(frame * record.blockAlign + channelIndex * bytes, true);
        if (Math.abs(value) > Math.abs(peak)) peak = value;
      }
      return peak;
    });
}

// --------------------------------------------------------------------------
// 命名：清晰、可预测、且不会被导入器当成 take
// --------------------------------------------------------------------------

test("backup naming is predictable, WAV-invisible and _Poly-safe", () => {
  assert.equal(backupNameFor("ZOOM0001_Tr6.WAV"), "ZOOM0001_Tr6.WAV.bak");
  assert.equal(backupPendingNameFor("ZOOM0001_Tr6.WAV.bak"), "ZOOM0001_Tr6.WAV.bak.pending");
  assert.equal(isBackupName("ZOOM0001_Tr6.WAV.bak"), true);
  assert.equal(isBackupPendingName("ZOOM0001_Tr6.WAV.bak.pending"), true);
  assert.equal(isBackupName("ZOOM0001_Tr6.WAV.bak.pending"), false);
  assert.equal(isBackupPendingName("ZOOM0001_Tr6.WAV.bak"), false);

  // 关键：不能以 .wav/.wave 结尾，否则重新导入文件夹时会被当成假 take。
  assert.equal(WAV_SUFFIX.test(backupNameFor("ZOOM0001_Tr6.WAV")), false);
  // 不能和工具自己产出的合板/边车文件撞名。
  for (const produced of ["ZOOM0001_Poly.WAV", "ZOOM0001_SyncRef.WAV", "ZOOM0001_channels.json", "ZOOM0001_合板说明.txt", "timecode_fix_manifest_20260101_000000.csv"]) {
    assert.equal(isBackupName(produced), false, produced);
  }
  assert.notEqual(backupNameFor("ZOOM0001_Tr6.WAV"), "ZOOM0001_Poly.WAV");
});

// --------------------------------------------------------------------------
// 1. 备份内容与源字节一致
// --------------------------------------------------------------------------

test("write creates a byte-identical sibling .bak before touching the source", async () => {
  const dir = tempDir();
  const sourcePath = join(dir, "ZOOM0001_Tr1.WAV");
  const record = await recordIn(dir, "ZOOM0001_Tr1.WAV");
  const originalBytes = readFileSync(sourcePath);

  const newTimeReference = 98765432100n;
  const { controller, state } = makeEnv([record], {
    previews: [{ ...record, newTimeReference, timeReferenceOffset: null }],
  });

  await controller.applyChanges();

  const backupPath = join(dir, backupNameFor("ZOOM0001_Tr1.WAV"));
  assert.ok(existsSync(backupPath), "backup should exist next to the source");
  assert.deepEqual(readFileSync(backupPath), originalBytes, "backup must be byte-identical to the pre-write source");
  assert.notDeepEqual(readFileSync(sourcePath), originalBytes, "the source itself must have changed");

  // 没有留下半成品标记
  assert.equal(existsSync(join(dir, backupPendingNameFor(backupNameFor("ZOOM0001_Tr1.WAV")))), false);
  // 备份能作为合法 WAV 独立打开
  const backupRecord = await scanWave(fileHandleFor(backupPath, "ZOOM0001_Tr1.WAV.bak"));
  assert.equal(backupRecord.channels, 1);
  assert.equal(backupRecord.oldTimeReference, record.oldTimeReference);

  // undoBatch 记住了备份，撤销才能真的还原
  assert.equal(state.lastUndoBatch.length, 1);
  assert.equal(state.lastUndoBatch[0].backup.name, "ZOOM0001_Tr1.WAV.bak");
  assert.equal(state.lastUndoBatch[0].backup.size, originalBytes.length);
  assert.equal(state.lastUndoBatch[0].oldTimeReference, record.oldTimeReference, "undo still knows the old metadata");
});

// --------------------------------------------------------------------------
// 2. 备份失败 -> 源文件完全没被修改
// --------------------------------------------------------------------------

test("backup failure aborts the write and leaves the source untouched", async () => {
  const dir = tempDir();
  const sourcePath = join(dir, "ZOOM0002_Tr2.WAV");
  const record = await recordIn(dir, "ZOOM0002_Tr2.WAV");
  const originalBytes = readFileSync(sourcePath);

  const hooks = {
    onGetFileHandle(name) {
      if (BAK_SUFFIX_RE.test(name)) {
        throw fsError("QuotaExceededError", "disk full while writing the backup");
      }
    },
  };
  // 让 records 用的目录句柄带上会失败的 hooks
  const failing = { ...record, parentHandle: dirHandleFor(dir, hooks) };
  const { controller, state } = makeEnv([failing], {
    previews: [{ ...failing, newTimeReference: 555n }],
  });

  await assert.rejects(controller.applyChanges(), (error) => {
    // 错误必须可操作：说清是哪个文件、备份写到哪里、为什么失败、怎么办
    assert.match(error.message, /ZOOM0002_Tr2\.WAV/);
    assert.match(error.message, /ZOOM0002_Tr2\.WAV\.bak/);
    assert.match(error.message, /disk full/);
    assert.match(error.message, /源文件未被修改/);
    assert.match(error.message, /磁盘剩余空间|关闭备份开关/);
    return true;
  });

  assert.deepEqual(readFileSync(sourcePath), originalBytes, "source must be byte-identical after a failed backup");
  assert.equal(existsSync(join(dir, backupNameFor("ZOOM0002_Tr2.WAV"))), false, "no partial .bak may survive");
  assert.equal(state.lastUndoBatch, null, "a failed write must not arm undo");
});

test("mid-copy backup failure leaves no usable backup and never opens the source", async () => {
  const dir = tempDir();
  const sourcePath = join(dir, "ZOOM0003_Tr3.WAV");
  // 素材大于 8MB 分片，所以备份确实是"分多次写"，第 2 块失败即中途崩溃。
  const record = await largeRecordIn(dir, "ZOOM0003_Tr3.WAV");
  const originalBytes = readFileSync(sourcePath);
  assert.ok(originalBytes.length > 8 * 1024 * 1024);

  const hooks = {
    onWrite(_stream, count, targetPath) {
      // 只打断备份流；源文件的写入根本没机会发生。
      if (BAK_SUFFIX_RE.test(targetPath) && count === 2) throw fsError("QuotaExceededError", "no space left on device");
    },
  };
  const failing = { ...record, parentHandle: dirHandleFor(dir, hooks) };
  const { controller } = makeEnv([failing], { previews: [{ ...failing, newTimeReference: 777n }] });

  await assert.rejects(controller.applyChanges(), (error) => {
    assert.match(error.message, /备份失败/);
    assert.match(error.message, /no space left on device/);
    return true;
  });
  assert.deepEqual(readFileSync(sourcePath), originalBytes);
  assert.equal(existsSync(join(dir, backupNameFor("ZOOM0003_Tr3.WAV"))), false);
  assert.equal(existsSync(join(dir, backupPendingNameFor(backupNameFor("ZOOM0003_Tr3.WAV")))), false);
});

test("multi-chunk backup of a >8MB file is still byte-identical and restorable", async () => {
  const dir = tempDir();
  const name = "ZOOM0003B_Tr3.WAV";
  const sourcePath = join(dir, name);
  const record = await largeRecordIn(dir, name);
  const originalBytes = readFileSync(sourcePath);
  assert.ok(originalBytes.length > 8 * 1024 * 1024, "fixture must span several copy chunks");

  const { controller } = makeEnv([record], { previews: [{ ...record, newTimeReference: 31337n }] });
  await controller.applyChanges();
  assert.deepEqual(readFileSync(join(dir, backupNameFor(name))), originalBytes);
  assert.notDeepEqual(readFileSync(sourcePath), originalBytes);

  await controller.undoLastWrite();
  assert.deepEqual(readFileSync(sourcePath), originalBytes, "multi-chunk restore must be byte-exact");
});

test("a backup whose commit marker cannot be removed aborts the write", async () => {
  const dir = tempDir();
  const sourcePath = join(dir, "ZOOM0003C_Tr1.WAV");
  const record = await recordIn(dir, "ZOOM0003C_Tr1.WAV");
  const originalBytes = readFileSync(sourcePath);

  // 标记删不掉 -> 备份无法被识别为有效 -> 继续写就会造成"再也撤销不回来"，必须中止。
  const hooks = {
    onRemoveEntry(name) {
      if (isBackupPendingName(name)) throw fsError("NoModificationAllowedError", "marker is locked");
    },
  };
  const failing = { ...record, parentHandle: dirHandleFor(dir, hooks) };
  const { controller, state } = makeEnv([failing], { previews: [{ ...failing, newTimeReference: 4321n }] });

  await assert.rejects(controller.applyChanges(), (error) => {
    assert.match(error.message, /备份失败/);
    assert.match(error.message, /无法删除完成标记/);
    assert.match(error.message, /源文件未被修改/);
    return true;
  });
  assert.deepEqual(readFileSync(sourcePath), originalBytes);
  assert.equal(state.lastUndoBatch, null);
  assert.equal(existsSync(join(dir, backupNameFor("ZOOM0003C_Tr1.WAV"))), false);
});

test("a record without a parent directory handle is refused before any write", async () => {
  const dir = tempDir();
  const sourcePath = join(dir, "ZOOM0004_Tr4.WAV");
  const record = await recordIn(dir, "ZOOM0004_Tr4.WAV", { withDirectory: false });
  const originalBytes = readFileSync(sourcePath);
  assert.equal(record.parentHandle, null);

  const { controller } = makeEnv([record], { previews: [{ ...record, newTimeReference: 999n }] });
  await assert.rejects(controller.applyChanges(), (error) => {
    assert.match(error.message, /无法定位源文件所在目录/);
    assert.match(error.message, /选择文件夹/);
    return true;
  });
  assert.deepEqual(readFileSync(sourcePath), originalBytes);
});

// --------------------------------------------------------------------------
// 3. 撤销真的把被静音的音频救回来
// --------------------------------------------------------------------------

test("undo restores the muted LTC audio byte-for-byte, not just the metadata", async () => {
  const dir = tempDir();
  const name = "ZOOM0005_Tr6.WAV";
  const sourcePath = join(dir, name);
  const record = await ltcStereoRecord(dir, name);
  const originalBytes = readFileSync(sourcePath);
  const originalLtcPeak = await channelEnergy(record.file, record, 1);
  assert.ok(Math.abs(originalLtcPeak) > 1000, "fixture should have audible LTC on channel 2");

  const newTimeReference = 172800000n + 48000n * 10n;
  const ltc = {
    ok: true,
    newTimeReference,
    channelIndex: 1,
    channelLabel: "Tr6",
    sourceRecord: record,
    status: "pending",
    statusText: "",
  };
  const ltcResults = new Map([[record.relativePath, ltc]]);
  const { controller, state } = makeEnv([record], { ltcResults });

  await controller.writeLtcTimecode();

  // 写入 + 静音之后：第 2 轨（索引 1）应该已经变成静音
  const afterWrite = await scanWave(fileHandleFor(sourcePath, name));
  assert.equal(afterWrite.oldTimeReference, newTimeReference, "time reference was written");
  const mutedPeak = await channelEnergy(await fileHandleFor(sourcePath, name).getFile(), afterWrite, 1);
  assert.equal(mutedPeak, 0, "LTC channel must actually be muted by the write path");
  assert.ok(state.lastUndoBatch.length === 1 && state.lastUndoBatch[0].backup, "undo batch must reference the backup");

  // 撤销
  await controller.undoLastWrite();

  // 关键断言：音频回来了，而且整个文件与写入前逐字节一致
  const restoredBytes = readFileSync(sourcePath);
  assert.deepEqual(restoredBytes, originalBytes, "undo must restore the full file bytes, not only metadata");
  const restored = await scanWave(fileHandleFor(sourcePath, name));
  const restoredPeak = await channelEnergy(await fileHandleFor(sourcePath, name).getFile(), restored, 1);
  assert.equal(restoredPeak, originalLtcPeak, "the muted LTC audio must come back with its exact original samples");
  assert.ok(Math.abs(restoredPeak) > 1000);
  assert.equal(restored.oldTimeReference, record.oldTimeReference, "metadata is reverted too");
  assert.equal(state.lastUndoBatch, null);

  // 备份保留：撤销之后它仍然是源文件之外唯一的一份原始内容
  assert.ok(existsSync(join(dir, backupNameFor(name))), "backup must be kept after undo");
});

test("metadata-only undo still works when backups were never made", async () => {
  const dir = tempDir();
  const name = "ZOOM0006_Tr6.WAV";
  const sourcePath = join(dir, name);
  const record = await ltcStereoRecord(dir, name);
  const newTimeReference = 42n * 48000n;

  const ltcResults = new Map([[record.relativePath, {
    ok: true,
    newTimeReference,
    channelIndex: 1,
    channelLabel: "Tr6",
    sourceRecord: record,
  }]]);
  const { controller } = makeEnv([record], { ltcResults, shouldBackup: () => false });

  await controller.writeLtcTimecode();
  assert.equal(existsSync(join(dir, backupNameFor(name))), false, "disabled backup must not create any file");
  assert.equal(existsSync(join(dir, backupPendingNameFor(backupNameFor(name)))), false);

  await controller.undoLastWrite();
  const restored = await scanWave(fileHandleFor(sourcePath, name));
  assert.equal(restored.oldTimeReference, record.oldTimeReference, "metadata revert must still happen");
  // 音频仍然是静音的 —— 这正是"备份关掉后撤销名不副实"的已知代价，行为不变。
  const peak = await channelEnergy(await fileHandleFor(sourcePath, name).getFile(), restored, 1);
  assert.equal(peak, 0);
});

test("backup is refreshed, never skipped, when a stale .bak already exists", async () => {
  const dir = tempDir();
  const name = "ZOOM0007_Tr1.WAV";
  const sourcePath = join(dir, name);
  const backupPath = join(dir, backupNameFor(name));
  const record = await recordIn(dir, name);
  const originalBytes = readFileSync(sourcePath);
  // 上一轮留下的、已经过期的备份
  writeFileSync(backupPath, Buffer.from("stale backup from an older session"));

  const { controller } = makeEnv([record], { previews: [{ ...record, newTimeReference: 12345n }] });
  await controller.applyChanges();

  assert.deepEqual(readFileSync(backupPath), originalBytes,
    "an existing backup must be refreshed to the current pre-write state, not skipped or kept stale");
});

test("an incomplete backup (stray .pending) makes undo refuse instead of restoring garbage", async () => {
  const dir = tempDir();
  const name = "ZOOM0008_Tr1.WAV";
  const sourcePath = join(dir, name);
  const record = await recordIn(dir, name);
  const writtenBytes = () => readFileSync(sourcePath);

  const { controller, state } = makeEnv([record], { previews: [{ ...record, newTimeReference: 246810n }] });
  await controller.applyChanges();
  const afterWrite = writtenBytes();

  // 模拟上次备份崩在中间：.bak 在，.pending 也在 -> 下游不认这份备份
  writeFileSync(join(dir, backupPendingNameFor(backupNameFor(name))), "source=ZOOM0008_Tr1.WAV\n");

  await assert.rejects(controller.undoLastWrite(), (error) => {
    assert.match(error.message, /不完整/);
    assert.match(error.message, /\.pending/);
    assert.match(error.message, /源文件未被修改/);
    return true;
  });
  assert.deepEqual(writtenBytes(), afterWrite, "a refused undo must not modify the source");
  assert.ok(state.lastUndoBatch, "undo state must survive a refused undo so the user can retry");
});

// --------------------------------------------------------------------------
// 4. 成本：开关 + 计划
// --------------------------------------------------------------------------

test("shouldBackup is opt-out and defaults to on", async () => {
  const dir = tempDir();
  const name = "ZOOM0009_Tr1.WAV";
  const record = await recordIn(dir, name);

  const on = makeEnv([record], { previews: [{ ...record, newTimeReference: 1n }] });
  assert.equal(on.controller.backupEnabled(), true);
  assert.equal(on.controller.writePlan().fileCount, 1);
  assert.ok(on.controller.writePlan().totalBytes > 0);

  const off = makeEnv([record], { shouldBackup: () => false });
  assert.equal(off.controller.backupEnabled(), false);
  assert.equal(off.controller.writePlan().fileCount, 0);
  assert.equal(off.controller.writePlan().totalBytes, 0);
});

test("buildBackupPlan reports file count, byte cost and records without a directory", async () => {
  const dir = tempDir();
  const withDir = await recordIn(dir, "ZOOM0010_Tr1.WAV");
  const withoutDir = await recordIn(dir, "ZOOM0010_Tr2.WAV", { withDirectory: false });
  const meta = { name: "clip.mov", _meta: true };
  const video = { name: "clip.mp4", _video: true };

  const plan = buildBackupPlan([withDir, withoutDir, meta, video, withDir], { enabled: true });
  assert.equal(plan.enabled, true);
  assert.equal(plan.fileCount, 1, "metadata/video are never backed up, duplicates collapse");
  assert.equal(plan.totalBytes, withDir.file.size);
  assert.match(plan.totalBytesText, /\d/);
  assert.deepEqual(plan.backupNames, [backupNameFor("ZOOM0010_Tr1.WAV")]);
  assert.deepEqual(plan.unbackedRecords, [withoutDir.relativePath]);

  const off = buildBackupPlan([withDir, withoutDir], { enabled: false });
  assert.equal(off.fileCount, 0);
  assert.equal(off.totalBytes, 0);
  assert.deepEqual(off.backupNames, []);
});

// --------------------------------------------------------------------------
// 5. 既有导出与确认弹窗签名保持不变
// --------------------------------------------------------------------------

test("controller still exports the same callables index.html wires up", async () => {
  const dir = tempDir();
  const record = await recordIn(dir, "ZOOM0011_Tr1.WAV");
  const { controller } = makeEnv([record]);
  for (const name of ["applyChanges", "refreshRecordsFromHandles", "runPreview", "undoLastWrite", "writeLtcTimecode", "backupEnabled", "writePlan"]) {
    assert.equal(typeof controller[name], "function", name);
  }

  // confirmWriteChanges 仍然是 (count, includesLtcMute) 这个签名
  const freshLtc = record => new Map([[record.relativePath, {
    ok: true,
    newTimeReference: 7n,
    channelIndex: 0,
    channelLabel: "Tr1",
    sourceRecord: record,
  }]]);
  const confirms = [];
  const ltcEnv = makeEnv([record], {
    ltcResults: freshLtc(record),
    confirmWriteChanges: async (count, includesLtcMute) => { confirms.push([count, includesLtcMute]); return true; },
  });
  await ltcEnv.controller.writeLtcTimecode();
  assert.deepEqual(confirms, [[1, true]], "confirmWriteChanges(count, includesLtcMute) signature preserved");

  // 没有静音时第二个参数是 false，签名行为不变（writeLtcTimecode 会把 ok 置 false，所以要新的 ltc 对象）
  const softConfirms = [];
  const softEnv = makeEnv([record], {
    ltcResults: freshLtc(record),
    shouldMuteLtc: () => false,
    confirmWriteChanges: async (count, includesLtcMute) => { softConfirms.push([count, includesLtcMute]); return true; },
  });
  await softEnv.controller.writeLtcTimecode();
  assert.deepEqual(softConfirms, [[1, false]]);
});