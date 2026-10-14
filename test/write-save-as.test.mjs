// "另存为新文件"写入方案 + 强制备份提醒 的回归测试。
//
// 复用 write-backup.test.mjs 的 node:fs 版 File System Access API 适配思路：
// 真实临时文件 + 对真实磁盘字节断言。"另存为新文件"的核心承诺是——
// 原文件从头到尾不被打开写入，新文件字节级一致且已写入新时码。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, renameSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

import { scanWave, readDataView } from "../src/wave.js";
import { samplesToTimecode, parseFps } from "../src/timecode.js";
import {
  createTimeReferenceWriteController,
  saveAsNameFor,
  SAVE_AS_SUFFIX,
} from "../src/time-reference-write-controller.js";
import { createConfirmFlows } from "../src/confirm-flows.js";
import { encodeLtcAudio, encodeVoiceLike, writeWavPcm16 } from "./ltc-encode.mjs";

const SR = 48000;

// --------------------------------------------------------------------------
// node:fs 版 File System Access API 适配器（与 write-backup.test.mjs 同构）
// --------------------------------------------------------------------------

class NodeWritable {
  constructor(targetPath, hooks, initial) {
    this.targetPath = targetPath;
    this.hooks = hooks;
    this.buffer = initial ? Buffer.from(initial) : Buffer.alloc(0);
    this.closed = false;
    this.aborted = false;
  }
  async write(chunk) {
    if (this.closed || this.aborted) throw new Error("stream is closed");
    let bytes;
    let position;
    if (chunk && chunk.type === "write") {
      bytes = Buffer.from(chunk.data instanceof Uint8Array ? chunk.data : new Uint8Array(chunk.data));
      position = Number(chunk.position ?? this.buffer.length);
    } else if (typeof chunk?.arrayBuffer === "function") {
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

function fileHandleFor(path, name) {
  return {
    kind: "file",
    name,
    async getFile() { return new File([readFileSync(path)], name); },
    async createWritable(options = {}) {
      const initial = options.keepExistingData && existsSync(path) ? readFileSync(path) : null;
      return new NodeWritable(path, {}, initial);
    },
  };
}

function dirHandleFor(dir) {
  return {
    kind: "directory",
    name: basename(dir),
    async getFileHandle(name, options = {}) {
      const path = join(dir, name);
      if (!existsSync(path)) {
        if (!options.create) {
          const error = new Error(`${name} not found`);
          error.name = "NotFoundError";
          throw error;
        }
        writeFileSync(path, Buffer.alloc(0));
      }
      return fileHandleFor(path, name);
    },
    async removeEntry(name) {
      rmSync(join(dir, name), { force: true });
    },
  };
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
  pickSaveAsTargets,
  directoryHandle = null,
} = {}) {
  const state = { records, previews, ltcResults, lastUndoBatch: null, changed: new Map(), activeOffset: null };
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
    ...(pickSaveAsTargets === undefined ? {} : { pickSaveAsTargets }),
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
    confirmSoftSyncWrite: async () => true,
    setState() {},
    updateWriteProgress: () => {},
    log: () => {},
    renderRows() {},
  });
  return { controller, state, els };
}

async function recordIn(dir, name, { channels, sampleRate = SR, withDirectory = true } = {}) {
  const track = channels ?? [encodeVoiceLike({ sampleRate, durationSeconds: 1 })];
  writeWavPcm16(join(dir, name), track, sampleRate);
  return scanWave(fileHandleFor(join(dir, name), name), {
    relativePath: `${basename(dir)}/${name}`,
    parentPath: basename(dir),
    parentHandle: withDirectory ? dirHandleFor(dir) : null,
  });
}

const tempDir = () => mkdtempSync(join(tmpdir(), "slatesync-saveas-"));

async function ltcStereoRecord(dir, name) {
  const ltc = encodeLtcAudio({ sampleRate: SR, fps: 25, startTc: "01:23:45:00", durationSeconds: 2, amplitude: 0.5 });
  const voice = encodeVoiceLike({ sampleRate: SR, durationSeconds: 2 });
  return recordIn(dir, name, { channels: [voice, ltc.data] });
}

function channelPeak(file, record, channelIndex) {
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

/** runPreview 产出的预览形状：补上 manifest 需要的 offset/sampleOffset/fps 字段。 */
const previewOf = (record, newTimeReference) => ({
  ...record,
  newTimeReference,
  offset: { label: "+00:00:00:00", frames: 0n },
  sampleOffset: 0n,
  fps: parseFps("25"),
});

/** 在输出目录里为每个 item 建 `_TCfix` 目标文件，返回 pickSaveAsTargets 的结果。 */
async function targetsIn(outDir, items) {
  const directory = dirHandleFor(outDir);
  const targets = new Map();
  for (const item of items) {
    const name = saveAsNameFor(item.record.name);
    const handle = await directory.getFileHandle(name, { create: true });
    targets.set(item.record.relativePath || item.record.name, { handle, name, parentHandle: directory });
  }
  return targets;
}

// --------------------------------------------------------------------------
// 命名
// --------------------------------------------------------------------------

test("save-as naming inserts _TCfix before extension and stays import-safe", () => {
  assert.equal(saveAsNameFor("ZOOM0001_Tr1.WAV"), `ZOOM0001_Tr1${SAVE_AS_SUFFIX}.WAV`);
  assert.equal(saveAsNameFor("take.1.WAV"), `take.1${SAVE_AS_SUFFIX}.WAV`);
  assert.equal(saveAsNameFor("noext"), `noext${SAVE_AS_SUFFIX}`);
  // 不与合板/边车产物撞名，且仍以 .wav 结尾可被导入。
  assert.notEqual(saveAsNameFor("ZOOM0001_Tr1.WAV"), "ZOOM0001_Poly.WAV");
  assert.ok(/\.wav$/i.test(saveAsNameFor("ZOOM0001_Tr1.WAV")));
});

// --------------------------------------------------------------------------
// 确认弹窗契约：强制备份勾选 + 另存按钮
// --------------------------------------------------------------------------

test("confirmWriteChanges forces a backup ack and offers the save-as option", async () => {
  const seen = [];
  const { confirmWriteChanges } = createConfirmFlows({
    showConfirmDialog: async (options) => { seen.push(options); return true; },
    fpsSelectLabel: v => v,
  });
  assert.equal(await confirmWriteChanges(3), true);
  assert.equal(seen.length, 1);
  const options = seen[0];
  assert.equal(typeof options.requireAck, "string");
  assert.match(options.requireAck, /备份/);
  assert.equal(options.altResult, "save-as");
  assert.match(options.altText, /另存为新文件/);
  assert.match(options.confirmText, /直接改写/);
  assert.match(options.copy, /方式一/);
  assert.match(options.copy, /方式二/);

  // 静音场景同样覆盖
  seen.length = 0;
  await confirmWriteChanges(2, true);
  assert.match(seen[0].copy, /静音/);
});

// --------------------------------------------------------------------------
// applyChanges · 另存为新文件
// --------------------------------------------------------------------------

test("applyChanges save-as writes _TCfix copies and leaves sources byte-identical", async () => {
  const srcDir = tempDir();
  const outDir = tempDir();
  const name = "ZOOM0101_Tr1.WAV";
  const sourcePath = join(srcDir, name);
  const record = await recordIn(srcDir, name);
  const originalBytes = readFileSync(sourcePath);

  const newTimeReference = 98765432100n;
  const { controller, state } = makeEnv([record], {
    previews: [previewOf(record, newTimeReference)],
    shouldBackup: () => false,
    confirmWriteChanges: async () => "save-as",
    pickSaveAsTargets: items => targetsIn(outDir, items),
  });

  await controller.applyChanges();

  // 原文件一字节未动，且没有 .bak
  assert.deepEqual(readFileSync(sourcePath), originalBytes, "source must remain byte-identical");
  assert.equal(existsSync(join(srcDir, `${name}.bak`)), false);

  // 新文件存在、字节数一致、时码已写入
  const outName = saveAsNameFor(name);
  const outPath = join(outDir, outName);
  assert.ok(existsSync(outPath), "new file should exist in the output directory");
  const outRecord = await scanWave(fileHandleFor(outPath, outName));
  assert.equal(outRecord.oldTimeReference, newTimeReference, "new file must carry the new time reference");
  assert.equal(outRecord.durationSamples, record.durationSamples);

  // 清单写进输出目录，并标注 原名 → 新名
  const manifests = readdirSync(outDir).filter(f => /^timecode_fix_manifest_.*\.csv$/.test(f));
  assert.equal(manifests.length, 1, "manifest should be written to the shared output directory");
  const manifestText = readFileSync(join(outDir, manifests[0]), "utf8");
  assert.match(manifestText, new RegExp(`${name.replace(".", "\\.")} → ${outName.replace(".", "\\.")}`));

  // 另存不动原文件：没有可撤销的内容，不武装 undo
  assert.equal(state.lastUndoBatch, null);
  // 预览已清空
  assert.equal(state.previews.length, 0);
});

test("applyChanges save-as cancels cleanly when the user aborts the picker", async () => {
  const srcDir = tempDir();
  const name = "ZOOM0102_Tr1.WAV";
  const sourcePath = join(srcDir, name);
  const record = await recordIn(srcDir, name);
  const originalBytes = readFileSync(sourcePath);

  const { controller } = makeEnv([record], {
    previews: [previewOf(record, 42n)],
    confirmWriteChanges: async () => "save-as",
    pickSaveAsTargets: async () => null,
  });

  await controller.applyChanges();
  assert.deepEqual(readFileSync(sourcePath), originalBytes);
});

test("applyChanges save-as without a picker implementation raises an actionable error", async () => {
  const srcDir = tempDir();
  const name = "ZOOM0103_Tr1.WAV";
  const record = await recordIn(srcDir, name);
  const originalBytes = readFileSync(join(srcDir, name));

  const { controller } = makeEnv([record], {
    previews: [previewOf(record, 42n)],
    confirmWriteChanges: async () => "save-as",
  });
  await assert.rejects(controller.applyChanges(), /另存为新文件/);
  assert.deepEqual(readFileSync(join(srcDir, name)), originalBytes);
});

// --------------------------------------------------------------------------
// writeLtcTimecode · 另存为新文件（含 LTC 静音只发生在副本内）
// --------------------------------------------------------------------------

test("writeLtcTimecode save-as mutes LTC only inside the copy", async () => {
  const srcDir = tempDir();
  const outDir = tempDir();
  const name = "ZOOM0104_Tr6.WAV";
  const sourcePath = join(srcDir, name);
  const record = await ltcStereoRecord(srcDir, name);
  const originalBytes = readFileSync(sourcePath);
  const originalLtcPeak = await channelPeak(await fileHandleFor(sourcePath, name).getFile(), record, 1);
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
  const { controller, state } = makeEnv([record], {
    ltcResults: new Map([[record.relativePath, ltc]]),
    shouldMuteLtc: () => true,
    confirmWriteChanges: async () => "save-as",
    pickSaveAsTargets: items => targetsIn(outDir, items),
  });

  await controller.writeLtcTimecode();

  // 原文件：字节一致、LTC 未静音、时码未变
  assert.deepEqual(readFileSync(sourcePath), originalBytes, "source must remain byte-identical");
  const sourceAfter = await scanWave(fileHandleFor(sourcePath, name));
  assert.equal(sourceAfter.oldTimeReference, record.oldTimeReference);
  const sourcePeak = await channelPeak(await fileHandleFor(sourcePath, name).getFile(), sourceAfter, 1);
  assert.equal(sourcePeak, originalLtcPeak, "LTC in the source must NOT be muted");

  // 新文件：新时码 + LTC 已静音
  const outName = saveAsNameFor(name);
  const outPath = join(outDir, outName);
  const outRecord = await scanWave(fileHandleFor(outPath, outName));
  assert.equal(outRecord.oldTimeReference, newTimeReference);
  const outPeak = await channelPeak(await fileHandleFor(outPath, outName).getFile(), outRecord, 1);
  assert.equal(outPeak, 0, "LTC channel must be muted inside the copy");

  // 结果状态文案提示了新文件名
  assert.match(ltc.statusText, /原文件未修改/);
  assert.match(ltc.statusText, new RegExp(outName.replace(".", "\\.")));
  // 不武装 undo
  assert.equal(state.lastUndoBatch, null);
});

// --------------------------------------------------------------------------
// 直接改写路径回归（决策 true，备份关闭）
// --------------------------------------------------------------------------

test("direct rewrite still works with backups off and no save-as picker involved", async () => {
  const srcDir = tempDir();
  const name = "ZOOM0105_Tr1.WAV";
  const sourcePath = join(srcDir, name);
  const record = await recordIn(srcDir, name);
  const originalBytes = readFileSync(sourcePath);

  const newTimeReference = 555n;
  let pickerCalled = false;
  const { controller, state } = makeEnv([record], {
    previews: [previewOf(record, newTimeReference)],
    shouldBackup: () => false,
    confirmWriteChanges: async () => true,
    pickSaveAsTargets: async () => { pickerCalled = true; return new Map(); },
  });

  await controller.applyChanges();

  assert.equal(pickerCalled, false, "save-as picker must not be consulted on the direct path");
  assert.notDeepEqual(readFileSync(sourcePath), originalBytes, "direct rewrite must modify the source");
  const fresh = await scanWave(fileHandleFor(sourcePath, name));
  assert.equal(fresh.oldTimeReference, newTimeReference);
  // 无备份时撤销仍是元数据级，但 batch 要存在
  assert.ok(state.lastUndoBatch);
  assert.equal(state.lastUndoBatch[0].backup, null);
});
