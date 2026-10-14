// 写入链路基准：同一份素材，对比
//   A) 直接改写 + 自动备份（v1.7.0 的默认行为）
//   B) 直接改写 + 不备份（v1.8.0 的默认行为）
//   C) 另存为新文件（v1.8.0 新方案）
// 用法: node test/bench-write.mjs [--files 8] [--mb 40] [--rounds 2]
// 跨版本对比时把本文件复制到旧代码树的 test/ 下运行，导入路径不变。
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { performance } from "node:perf_hooks";

import { scanWave } from "../src/wave.js";
import { samplesToTimecode, parseFps } from "../src/timecode.js";
import * as timeReferenceWriteModule from "../src/time-reference-write-controller.js";
import { encodeVoiceLike, writeWavPcm16 } from "./ltc-encode.mjs";

// 旧版本（v1.7.0）没有 saveAsNameFor 导出：另存场景在旧树上自动跳过。
const { createTimeReferenceWriteController, saveAsNameFor } = timeReferenceWriteModule;

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const FILE_COUNT = argValue("files", 8);
const FILE_MB = argValue("mb", 40);
const ROUNDS = argValue("rounds", 2);
const SR = 48000;

// ---------------------------------------------------------------------------
// node:fs 版 FS Access 适配器（与测试同构，close = 临时文件 + rename，同 Chrome）
// ---------------------------------------------------------------------------
class NodeWritable {
  constructor(targetPath, initial) {
    this.targetPath = targetPath;
    this.buffer = initial ? Buffer.from(initial) : Buffer.alloc(0);
    this.closed = false;
  }
  async write(chunk) {
    let bytes, position;
    if (chunk && chunk.type === "write") {
      bytes = Buffer.from(chunk.data instanceof Uint8Array ? chunk.data : new Uint8Array(chunk.data));
      position = Number(chunk.position ?? this.buffer.length);
    } else if (typeof chunk?.arrayBuffer === "function") {
      bytes = Buffer.from(new Uint8Array(await chunk.arrayBuffer()));
      position = this.buffer.length;
    } else {
      throw new Error("unsupported chunk");
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
    const temp = `${this.targetPath}.stream-tmp`;
    writeFileSync(temp, this.buffer);
    renameSync(temp, this.targetPath);
    this.closed = true;
  }
  async abort() {}
}

const fileHandleFor = (path, name) => ({
  kind: "file",
  name,
  async getFile() { return new File([readFileSync(path)], name); },
  async createWritable(options = {}) {
    const initial = options.keepExistingData && existsSync(path) ? readFileSync(path) : null;
    return new NodeWritable(path, initial);
  },
});

const dirHandleFor = dir => ({
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
  async removeEntry(name) { rmSync(join(dir, name), { force: true }); },
});

const stub = (extra = {}) => ({
  disabled: false, value: "25",
  classList: { add() {}, remove() {} },
  textContent: "", ...extra,
});

// ---------------------------------------------------------------------------
// 素材
// ---------------------------------------------------------------------------
function makeFixtures() {
  const srcDir = mkdtempSync(join(tmpdir(), "bench-write-src-"));
  const frames = Math.floor((FILE_MB * 1024 * 1024) / 2); // mono 16-bit
  const records = [];
  for (let i = 0; i < FILE_COUNT; i++) {
    const name = `TAKE01_Tr${i + 1}.WAV`;
    writeWavPcm16(join(srcDir, name), [new Float32Array(frames).fill(0.1)], SR);
    records.push(name);
  }
  return { srcDir, records };
}

async function scanRecords(srcDir, names) {
  const out = [];
  for (const name of names) {
    out.push(await scanWave(fileHandleFor(join(srcDir, name), name), {
      relativePath: `${basename(srcDir)}/${name}`,
      parentPath: basename(srcDir),
      parentHandle: dirHandleFor(srcDir),
    }));
  }
  return out;
}

function makeController(records, previews, extra = {}) {
  const state = { records, previews, lastUndoBatch: null };
  const els = {
    applyBtn: stub(), undoBtn: stub(), exportMetadataBtn: stub(), writeLtcBtn: stub(),
    extractLtcBtn: stub(), extractLtcFallbackBtn: stub(), previewBtn: stub(),
    statusLine: stub(), toast: stub(), fpsInput: stub(), progressOverlay: stub(),
  };
  return createTimeReferenceWriteController({
    els,
    getDirectoryHandle: () => null,
    getRecords: () => state.records,
    setRecords: next => { state.records = next; },
    getPreviews: () => state.previews,
    setPreviews: next => { state.previews = next; },
    getActiveOffset: () => null,
    setActiveOffset: () => {},
    getLastUndoBatch: () => state.lastUndoBatch,
    setLastUndoBatch: next => { state.lastUndoBatch = next; },
    getLtcResults: () => new Map(),
    shouldMuteLtc: () => false,
    setChangedTimeReferences: () => {},
    refreshTakeGroups: () => {},
    offsetInput: { parseOffset: () => 0n, bindEvents() {} },
    recordFpsValue: () => "25",
    recordFpsSource: () => "ui",
    recordFpsDisplay: () => "25",
    fpsSelectLabel: v => v,
    recordFps: () => "25",
    samplesToTimecode,
    confirmWriteChanges: async () => true,
    confirmSoftSyncWrite: async () => true,
    setState() {},
    updateWriteProgress: () => {},
    log: () => {},
    renderRows() {},
    ...extra,
  });
}

const previewOf = record => ({
  ...record,
  newTimeReference: record.oldTimeReference + 48000n * 60n * 10n,
  offset: { label: "+00:00:10:00", frames: 250n },
  sampleOffset: 48000n * 10n,
  fps: parseFps("25"),
});

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------
async function scenarioDirectBackupOn(srcDir, names) {
  const records = await scanRecords(srcDir, names);
  const controller = makeController(records, records.map(previewOf), { shouldBackup: () => true });
  await controller.applyChanges();
}

async function scenarioDirectBackupOff(srcDir, names) {
  const records = await scanRecords(srcDir, names);
  const controller = makeController(records, records.map(previewOf), { shouldBackup: () => false });
  await controller.applyChanges();
}

async function scenarioSaveAs(srcDir, names) {
  if (typeof saveAsNameFor !== "function") {
    console.log("（旧版本无另存为新文件能力，跳过该场景）");
    return;
  }
  const records = await scanRecords(srcDir, names);
  const outDir = mkdtempSync(join(tmpdir(), "bench-write-out-"));
  const controller = makeController(records, records.map(previewOf), {
    confirmWriteChanges: async () => "save-as",
    pickSaveAsTargets: async (items) => {
      const directory = dirHandleFor(outDir);
      const targets = new Map();
      for (const item of items) {
        const name = saveAsNameFor(item.record.name);
        const handle = await directory.getFileHandle(name, { create: true });
        targets.set(item.record.relativePath || item.record.name, { handle, name, parentHandle: directory });
      }
      return targets;
    },
  });
  await controller.applyChanges();
}

const SCENARIOS = [
  ["直接改写+自动备份(v1.7默认)", scenarioDirectBackupOn],
  ["直接改写不备份(v1.8默认)", scenarioDirectBackupOff],
  ["另存为新文件(v1.8新方案)", scenarioSaveAs],
];

// ---------------------------------------------------------------------------
// 跑
// ---------------------------------------------------------------------------
const results = new Map(SCENARIOS.map(([name]) => [name, []]));
for (let round = 0; round < ROUNDS; round++) {
  for (const [name, run] of SCENARIOS) {
    const { srcDir, records: names } = makeFixtures();
    const t0 = performance.now();
    await run(srcDir, names);
    const dt = performance.now() - t0;
    results.get(name).push(dt);
    rmSync(srcDir, { recursive: true, force: true });
  }
}

const totalMB = FILE_COUNT * FILE_MB;
const bestOf = arr => Math.min(...arr);
console.log(`\n素材: ${FILE_COUNT} 个 WAV × ${FILE_MB} MB（mono 48kHz PCM16）= ${totalMB} MB`);
console.log(`每场景跑 ${ROUNDS} 轮取最好成绩\n`);
const base = bestOf(results.get(SCENARIOS[0][0]));
for (const [name] of SCENARIOS) {
  const best = bestOf(results.get(name));
  const perFile = best / FILE_COUNT;
  const gbps = totalMB / 1024 / (best / 1000);
  const speedup = base / best;
  console.log(
    `${name.padEnd(28)} ${best.toFixed(0).padStart(6)} ms  `
    + `(${perFile.toFixed(0).padStart(5)} ms/文件, ${gbps.toFixed(2)} GB/s 处理带宽)  `
    + `vs v1.7默认 ×${speedup.toFixed(2)}`
  );
  console.log(`   各轮: ${results.get(name).map(v => v.toFixed(0)).join(", ")} ms`);
}
