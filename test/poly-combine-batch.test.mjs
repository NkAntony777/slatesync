// 批量合并的 take 级失败隔离
//
// 改动前：预校验循环里任意一个 take 抛错，整批 0 产出；写入主循环没有 per-take
// try/catch，中途抛错会把后面所有 take 静默丢弃。20 个 take 坏 1 个，实际产出
// 可能是 0 个或 1 个——这是直接的产出损失。
// 改动后：每个 take 独立成败，结束时统一汇报「成功 N 个 / 失败 M 个」。
//
// 这里跑的是真的 combinePolyFiles：注入一个假的输出目录（File System Access
// API 的 getFileHandle / createWritable）就能在 Node 里跑完整条批量路径，
// 字节级输出、sidecar 内容、清单内容都落在假目录里可比对。没有 jsdom
// （工程零运行时依赖），DOM 只用最小 fake：控制器真正碰到的
// statusLine / toast / progressOverlay / combinePolyBtn / progressFile。
//
// 注意 group key 是小写的：detectTakeGroupKeys 用 stem.toLowerCase() 拼 key，
// 所以 shortGroupLabel("take01/take01") === "take01"，产物也叫 take01_Poly.WAV。
//
// 没有覆盖的：showSaveFilePicker 逐 take 弹框的路径（浏览器 API）、真实浏览器
// 的目录授权与覆盖确认弹窗、index.html 的实际渲染。

import test from "node:test";
import assert from "node:assert/strict";

import { audioRecord } from "./helpers.mjs";
import { createPolyCombineController, summarizeBatchOutcomes } from "../src/poly-combine-controller.js";
import { combineEligibleGroupsFor, detectTakeGroupKeys, recordKey } from "../src/grouping.js";

// ============================================================ 假目录 / 假 DOM

class FakeWritable {
  constructor(onWrite = null) {
    this.bytes = new Uint8Array();
    this.closed = false;
    this.aborted = false;
    this.onWrite = onWrite;
  }
  async write(chunk) {
    // 浏览器两种调用都要认：write({ type, position, data }) 和 write(Blob)——
//     saveSidecars 用的正是后者，fake 收不下它的话每次跑都会误报 Sync guide WARN。
    const options = chunk && typeof chunk === "object" && "data" in chunk ? chunk : { position: 0, data: chunk };
    const { position = 0, data } = options;
    if (this.closed || this.aborted) throw new Error("stream is closed");
    if (this.onWrite) await this.onWrite({ position, data });
    // sidecar 走的是 Blob，Poly 走的是 Uint8Array，两种都要落进同一份字节里。
    const bytes = data instanceof Blob
      ? new Uint8Array(await data.arrayBuffer())
      : data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data);
    if (position + bytes.length > this.bytes.length) {
      const next = new Uint8Array(position + bytes.length);
      next.set(this.bytes);
      this.bytes = next;
    }
    this.bytes.set(bytes, position);
  }
  async truncate(size) { this.bytes = this.bytes.slice(0, size); }
  async close() { this.closed = true; }
  async abort() { this.aborted = true; }
}

function diskFull(fileName) {
  const error = new Error(`磁盘空间不足：无法写入 ${fileName}`);
  error.name = "QuotaExceededError";
  return error;
}

function deviceDropped(fileName) {
  const error = new Error(`写入 ${fileName} 时设备掉线`);
  error.name = "NotReadableError";
  return error;
}

/**
 * 假输出目录。
 *  - failFor：getFileHandle 抛错，模拟建不出文件（磁盘满 / 目录只读）。
 *  - failWrite：文件建得出来，写第一笔时抛错，模拟写到一半掉线。
 *  - writeErrors：按文件名指定写失败时抛出的具体 error（用来模拟 AbortError）。
 *  - existing：目录里已经有的文件名，喂给覆盖确认。
 */
function fakeDirectory({ name = "输出目录", failFor = [], failWrite = [], writeErrors = {}, existing = [] } = {}) {
  const files = new Map();
  const opened = [];
  const present = new Set(existing);
  const errors = new Map(Object.entries(writeErrors));
  for (const fileName of failWrite) errors.set(fileName, deviceDropped(fileName));
  return {
    name,
    files,
    opened,
    readBytes: fileName => files.get(fileName)?.bytes,
    polyNames: () => [...files.keys()].filter(fileName => fileName.endsWith("_Poly.WAV")).sort(),
    async getFileHandle(fileName, options = {}) {
      const known = present.has(fileName) || files.has(fileName);
      if (!known) {
        // 覆盖确认阶段的存在性探测：文件不存在是正常结果，绝不能顺手把文件建出来。
        if (!options.create) {
          const missing = new Error(`not found: ${fileName}`);
          missing.name = "NotFoundError";
          throw missing;
        }
        if (failFor.includes(fileName)) throw diskFull(fileName);
        files.set(fileName, { bytes: new Uint8Array() });
        opened.push(fileName);
      }
      const writeError = errors.get(fileName);
      const file = files.get(fileName);
      return {
        name: fileName,
        async createWritable() {
          const writable = new FakeWritable(writeError ? () => { throw writeError; } : null);
          // close 才是"写盘"：真实文件系统在 close 时才把内容交给文件，
          // fake 必须照做，否则读回来永远是一个 0 字节的空壳。
          writable.close = async () => { writable.closed = true; if (file) file.bytes = writable.bytes; };
          return writable;
        },
      };
    },
  };
}

function fakeEls() {
  return {
    combinePolyBtn: { disabled: false },
    statusLine: { textContent: "" },
    toast: { textContent: "", classList: { add() {}, remove() {} } },
    progressOverlay: { shown: false, classList: { add() {}, remove() {} } },
    progressLabel: { textContent: "" },
    progressFile: { textContent: "" },
    progressPct: { textContent: "" },
    progressFill: { style: { width: "" } },
  };
}

async function silent(frames) {
  return new Float64Array(frames);
}

/**
 * 一个 take 的分轨组。
 * timeReferences 可以逐条给不同的 TimeReference，用来构造"时长一致、分组合法，
 * 但 validateCombineGroup 会拒绝"的 take（起始时码对不齐）。
 */
async function take(prefix, { frames = 240, tracks = 2, timeReferences = [], sampleRate = 48000 } = {}) {
  const records = [];
  for (let i = 1; i <= tracks; i++) {
    const name = `${prefix}_Tr${i}.wav`;
    const record = await audioRecord(name, [await silent(frames)], {
      sampleRate,
      bits: 16,
      timeReference: timeReferences[i - 1] ?? 172800000n,
    });
    records.push({ ...record, parentPath: prefix, relativePath: name, name });
  }
  return records;
}

// 两个 harness 共用的默认注入项；groups / els / 目录 / 记账都在各自 harness 里覆盖。
const el = {
  confirmCombinePoly: async () => "ok",
  getFpsValue: () => "25",
  setCombinedPolyKeys: () => {},
  setState: () => {},
  updateWriteProgress: () => {},
  log: () => {},
  renderRows: () => {},
};

/**
 * 搭一个只靠注入的控制器：输出目录、确认框、日志、进度、状态全是 stub，
 * 落盘落在 fakeDirectory 里。除了 directory 之外不需要任何浏览器 API。
 */
async function harness({ records, directory, choice = "ok", overwrite = true }) {
  const groups = combineEligibleGroupsFor(records, detectTakeGroupKeys(records));
  const els = fakeEls();
  const logs = [];
  const progress = [];
  const states = [];
  const combinedKeys = [];
  const controller = createPolyCombineController({
    ...el,
    els,
    combineEligibleGroups: () => groups,
    confirmCombinePoly: async () => choice,
    getOutputDirectory: async () => directory,
    requestOverwrite: async () => overwrite,
    setCombinedPolyKeys: keys => combinedKeys.push(keys),
    setState: (text, kind) => states.push({ text, kind }),
    updateWriteProgress: (label, fileText, done, total) => progress.push({ label, fileText, done, total }),
    log: line => logs.push(line),
  });
  return { controller, groups, els, logs, progress, states, combinedKeys };
}

/** 用户关掉文件夹选择框时的控制器：没有任何输出目录可用。 */
async function cancelHarness({ records }) {
  const groups = combineEligibleGroupsFor(records, detectTakeGroupKeys(records));
  const els = fakeEls();
  const logs = [];
  const states = [];
  const combinedKeys = [];
  const controller = createPolyCombineController({
    ...el,
    els,
    combineEligibleGroups: () => groups,
    getOutputDirectory: async () => null,
    pickOutputDirectory: async () => null,
    setCombinedPolyKeys: keys => combinedKeys.push(keys),
    setState: (text, kind) => states.push({ text, kind }),
    log: line => logs.push(line),
  });
  return { controller, els, logs, states, combinedKeys };
}

function logText(logs) {
  return logs.join("\n");
}

function decode(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

// ============================================================ 纯函数

test("summarizeBatchOutcomes 汇总成功/失败计数并点名失败 take 与原因", () => {
  const summary = summarizeBatchOutcomes([
    { ok: true, takeKey: "sd/take01", takeLabel: "take01", name: "take01_Poly.WAV" },
    { ok: false, takeKey: "sd/take02", takeLabel: "take02", name: "take02_Poly.WAV", stage: "write", message: "磁盘空间不足" },
  ]);
  assert.equal(summary.total, 2);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.hasFailures, true);
  assert.equal(summary.countText, "成功 1 个 / 失败 1 个");
  // 阶段 3b 渲染失败清单需要的字段一个都不能少，也不能再靠渲染层去猜。
  assert.deepEqual(Object.keys(summary.failures[0]).sort(),
    ["message", "name", "stage", "stageLabel", "takeKey", "takeLabel"]);
  assert.equal(summary.failures[0].stageLabel, "写入");
  assert.match(summary.failureText, /take02/);
  assert.match(summary.failureText, /take02_Poly\.WAV/);
  assert.match(summary.failureText, /磁盘空间不足/);
});

test("全成功时汇总文案与改动前逐字一致，不给顺利路径换措辞", () => {
  const summary = summarizeBatchOutcomes([
    { ok: true, takeKey: "sd/take01", takeLabel: "take01", name: "take01_Poly.WAV" },
    { ok: true, takeKey: "sd/take02", takeLabel: "take02", name: "take02_Poly.WAV" },
  ]);
  assert.equal(summary.hasFailures, false);
  assert.deepEqual(summary.failures, []);
  assert.equal(summary.succeeded, 2);
  assert.equal(summary.statusText, "Poly 合并完成：2 个文件");
  assert.equal(summary.toastText, "✅ Poly 合并完成 — 2 个文件");
  assert.doesNotMatch(summary.statusText, /失败/);
});

test("预校验阶段的失败标成「预校验」，与写入阶段区分得开", () => {
  const summary = summarizeBatchOutcomes([
    { ok: false, takeKey: "sd/a", takeLabel: "a", name: "a_Poly.WAV", stage: "validate", message: "分轨时长不同" },
    { ok: false, takeKey: "sd/b", takeLabel: "b", name: "b_Poly.WAV", stage: "write", message: "设备掉线" },
  ]);
  assert.deepEqual(summary.failures.map(item => item.stage), ["validate", "write"]);
  assert.deepEqual(summary.failures.map(item => item.stageLabel), ["预校验", "写入"]);
  // 状态行只放得下一条：点名第一个失败，并说明还有几个在日志里。
  assert.match(summary.statusText, /成功 0 个 \/ 失败 2 个/);
  assert.match(summary.statusText, /a（a_Poly\.WAV · 预校验）：分轨时长不同/);
  assert.match(summary.statusText, /还有 1 个，详见日志/);
  assert.equal(summary.failureLines.length, 2);
});

test("summarizeBatchOutcomes 对畸形输入降级而不是抛错", () => {
  // 不是数组（null / 字符串 / 数字）一律当作"这批没有 take"，不能凭空造出一个失败。
  for (const input of [null, undefined, "nope", 42, { takes: null }]) {
    const summary = summarizeBatchOutcomes(input);
    assert.equal(summary.total, 0, `${JSON.stringify(input)} 应当被当成空批次`);
    assert.equal(summary.hasFailures, false);
  }
  // 数组里的空位不算 take；但没有显式 ok 的条目一律算失败——
  // 漏标成功绝不能被静默认成成功。
  assert.equal(summarizeBatchOutcomes([null, undefined]).total, 0);
  assert.equal(summarizeBatchOutcomes([{}]).failed, 1);
  // 原因缺失时不能出现 "undefined"，得给出可读的兜底。
  assert.equal(summarizeBatchOutcomes([{ ok: false }]).failures[0].message, "未知原因");
  assert.equal(summarizeBatchOutcomes([{ ok: false, error: new Error("炸了") }]).failures[0].message, "炸了");
  assert.equal(summarizeBatchOutcomes([{ ok: false, message: "" }]).failures[0].message, "未知原因");
  assert.equal(summarizeBatchOutcomes([]).hasFailures, false);
  assert.equal(summarizeBatchOutcomes([]).statusText, "Poly 合并完成：0 个文件");
});

// ============================================================ 写入阶段隔离

test("中间的 take 写盘失败时，前面的照常写出，后面的继续写", async () => {
  const records = [
    ...(await take("take01")),
    ...(await take("take02")),
    ...(await take("take03")),
  ];
  const directory = fakeDirectory({ failFor: ["take02_Poly.WAV"] });
  const { controller, els, logs, progress, states } = await harness({ records, directory });

  const results = await controller.combinePolyFiles();

  // 前后两个 take 都在；坏的那个既没有 Poly，也没有半截 sidecar。
  assert.deepEqual(results.map(item => item.name), ["take01_Poly.WAV", "take03_Poly.WAV"]);
  assert.deepEqual(directory.polyNames(), ["take01_Poly.WAV", "take03_Poly.WAV"]);
  assert.ok(directory.readBytes("take01_Poly.WAV").length > 0);
  assert.ok(directory.readBytes("take03_Poly.WAV").length > 0);
  assert.deepEqual(directory.opened.filter(name => name.startsWith("take02")), []);
  // 失败是用户看得见的：状态行、toast、日志三处都点名了 take 与原因。
  assert.match(els.statusLine.textContent, /成功 2 个 \/ 失败 1 个/);
  assert.match(els.statusLine.textContent, /take02/);
  assert.match(els.statusLine.textContent, /磁盘空间不足/);
  assert.match(els.toast.textContent, /成功 2 个 \/ 失败 1 个/);
  assert.match(logText(logs), /Combine Poly WARN: take02: 磁盘空间不足/);
  assert.match(logText(logs), /Combine Poly DONE: 成功 2 个 \/ 失败 1 个/);
  assert.deepEqual(states[states.length - 1], { text: "部分已合并", kind: "warn" });
  // 进度条照旧推进到总数：坏 take 占住自己的槽位，不会让进度停在原地。
  assert.deepEqual(
    progress.filter(item => item.label === "正在合并 Poly…" && item.fileText.includes("失败"))
      .map(item => [item.done, item.total]),
    [[2, 3]],
  );
  assert.deepEqual(progress[progress.length - 1], { label: "正在写入…", fileText: "", done: 0, total: 3 });
});

test("写到一半失败（可写流报错）和建不出文件一样被隔离", async () => {
  const records = [...(await take("take01")), ...(await take("take02"))];
  const directory = fakeDirectory({ failWrite: ["take02_Poly.WAV"] });
  const { controller, els, logs } = await harness({ records, directory });

  const results = await controller.combinePolyFiles();

  assert.deepEqual(results.map(item => item.name), ["take01_Poly.WAV"]);
  assert.match(els.statusLine.textContent, /成功 1 个 \/ 失败 1 个/);
  assert.match(logText(logs), /take02: 写入 take02_Poly\.WAV 时设备掉线/);
  // abort 掉的可写流不该把半截内容当成完整 Poly。
  assert.ok(directory.readBytes("take02_Poly.WAV").length < directory.readBytes("take01_Poly.WAV").length);
});

test("只有写成功的 take 被标记成已合并，失败 take 保留重试入口", async () => {
  const records = [
    ...(await take("take01")),
    ...(await take("take02")),
    ...(await take("take03")),
  ];
  const directory = fakeDirectory({ failFor: ["take02_Poly.WAV"] });
  const { controller, combinedKeys } = await harness({ records, directory });

  await controller.combinePolyFiles();

  assert.deepEqual([...combinedKeys[0]].sort(), ["take01_Tr1.wav", "take01_Tr2.wav", "take03_Tr1.wav", "take03_Tr2.wav"]);
});

test("全部 take 都失败时不谎报成功，返回空结果并说清失败数", async () => {
  const records = [...(await take("take01")), ...(await take("take02"))];
  const directory = fakeDirectory({ failFor: ["take01_Poly.WAV", "take02_Poly.WAV"] });
  const { controller, els, states, combinedKeys } = await harness({ records, directory });

  const results = await controller.combinePolyFiles();

  assert.deepEqual(results, []);
  assert.deepEqual(directory.polyNames(), []);
  assert.match(els.statusLine.textContent, /成功 0 个 \/ 失败 2 个/);
  assert.match(els.statusLine.textContent, /还有 1 个，详见日志/);
  assert.doesNotMatch(els.statusLine.textContent, /个文件/);
  assert.deepEqual(states[states.length - 1], { text: "合并失败", kind: "warn" });
  assert.deepEqual([...combinedKeys[0]], []);
});

test("成功 take 的字节、sidecar 与清单在隔离前后完全一致", async () => {
  const records = [
    ...(await take("take01")),
    ...(await take("take02")),
    ...(await take("take03")),
  ];
  // 干净跑一遍：三个 take 全成功。
  const clean = fakeDirectory();
  await (await harness({ records, directory: clean })).controller.combinePolyFiles();
  // 再跑一遍：中途坏一个。
  const broken = fakeDirectory({ failFor: ["take02_Poly.WAV"] });
  await (await harness({ records, directory: broken })).controller.combinePolyFiles();

  assert.deepEqual(clean.polyNames(), ["take01_Poly.WAV", "take02_Poly.WAV", "take03_Poly.WAV"]);
  assert.deepEqual(broken.polyNames(), ["take01_Poly.WAV", "take03_Poly.WAV"]);
  // 清单里有 generatedAt 时间戳，两次运行必然差几秒：抹掉它再比内容。
  const stripStamp = text => text.replace(/"generatedAt": "[^"]*"/g, '"generatedAt": "<时间戳>"');
  for (const [fileName, file] of clean.files) {
    if (fileName.startsWith("take02")) continue;
    assert.ok(broken.files.has(fileName), `${fileName} 应该在隔离后仍然写出`);
    if (fileName.endsWith(".WAV")) {
      // 音频产物必须逐字节相同：失败分支不许改动任何一个 sample。
      assert.deepEqual([...broken.readBytes(fileName)], [...file.bytes], `${fileName} 的字节必须与全成功时一致`);
      continue;
    }
    assert.equal(stripStamp(decode(broken.readBytes(fileName))), stripStamp(decode(file.bytes)),
      `${fileName} 的内容必须与全成功时一致（除时间戳外）`);
  }
});

// ============================================================ 预校验隔离

test("预校验失败的 take 被跳过，通过校验的 take 照常写出", async () => {
  // take02 的两条分轨 TimeReference 错开：分组合法（时长一致），但 validateCombineGroup 会拒绝它。
  const records = [
    ...(await take("take01")),
    ...(await take("take02", { timeReferences: [172800000n, 999999999n] })),
    ...(await take("take03")),
  ];
  const directory = fakeDirectory();
  const { controller, els, logs } = await harness({ records, directory });

  const results = await controller.combinePolyFiles();

  assert.deepEqual(results.map(item => item.name), ["take01_Poly.WAV", "take03_Poly.WAV"]);
  assert.deepEqual(directory.polyNames(), ["take01_Poly.WAV", "take03_Poly.WAV"]);
  assert.match(els.statusLine.textContent, /成功 2 个 \/ 失败 1 个/);
  assert.match(els.statusLine.textContent, /take02/);
  assert.match(els.statusLine.textContent, /预校验/);
  assert.match(logText(logs), /Combine Poly PRECHECK WARN: take02/);
  assert.match(logText(logs), /起始 TimeReference 和其他分轨不同/);
  // 预校验失败绝不能去建那个空文件：getFileHandle({ create: true }) 会留下 0 字节垃圾。
  assert.deepEqual(directory.opened.filter(name => name.startsWith("take02")), []);
});

test("第一个 take 就预校验失败时，后面的 take 照样写出", async () => {
  const records = [
    ...(await take("take01", { timeReferences: [172800000n, 999999999n] })),
    ...(await take("take02")),
  ];
  const directory = fakeDirectory();
  const { controller, els } = await harness({ records, directory });

  const results = await controller.combinePolyFiles();

  assert.deepEqual(results.map(item => item.name), ["take02_Poly.WAV"]);
  assert.deepEqual(directory.polyNames(), ["take02_Poly.WAV"]);
  assert.match(els.statusLine.textContent, /成功 1 个 \/ 失败 1 个/);
});

test("预校验与写入两个阶段各有一次失败时，清单逐条列出，计数仍然对得上", async () => {
  const records = [
    ...(await take("take01")),
    ...(await take("take02", { timeReferences: [172800000n, 999999999n] })),
    ...(await take("take03")),
    ...(await take("take04")),
  ];
  const directory = fakeDirectory({ failFor: ["take04_Poly.WAV"] });
  const { controller, els, logs } = await harness({ records, directory });

  const results = await controller.combinePolyFiles();

  assert.deepEqual(results.map(item => item.name), ["take01_Poly.WAV", "take03_Poly.WAV"]);
  assert.match(els.statusLine.textContent, /成功 2 个 \/ 失败 2 个/);
  assert.match(els.statusLine.textContent, /take02.*预校验/);
  assert.match(logText(logs), /Combine Poly PRECHECK WARN: take02: .*起始 TimeReference 和其他分轨不同/);
  assert.match(logText(logs), /Combine Poly WARN: take04: 磁盘空间不足/);
  assert.match(logText(logs), /Combine Poly DONE: 成功 2 个 \/ 失败 2 个/);
  // 成功 take 的清单不该包含失败 take。
  assert.doesNotMatch(logText(logs), /Combine Poly OK:.*take02/);
});

// ============================================================ 不该被改掉的既有语义

test("回归锁：不同目录的同名 Poly 仍然是整批阻断，不是部分成功", async () => {
  const records = [
    ...(await take("A/take01")),
    ...(await take("B/take01")),
    ...(await take("take09")),
  ];
  const directory = fakeDirectory();
  const { controller, els, logs } = await harness({ records, directory });

  await assert.rejects(() => controller.combinePolyFiles(), /产生同名 Poly/);
  assert.deepEqual(directory.polyNames(), [], "同名冲突时不该写出任何文件");
  assert.deepEqual(directory.opened, [], "冲突判定在写盘之前，不该打开任何文件");
  assert.doesNotMatch(els.statusLine.textContent, /合并完成/);
  assert.doesNotMatch(logText(logs), /Combine Poly/);
});

test("同名 Poly 冲突仍按全部计划名字判定，哪怕其中一个预校验失败", async () => {
  const records = [
    ...(await take("A/take01")),
    ...(await take("B/take01", { timeReferences: [172800000n, 999999999n] })),
  ];
  const directory = fakeDirectory();
  const { controller } = await harness({ records, directory });

  await assert.rejects(() => controller.combinePolyFiles(), /产生同名 Poly/);
  assert.deepEqual(directory.polyNames(), []);
});

test("取消选输出目录时干净退出：不写盘、不报成功、不标记任何 take", async () => {
  const records = [...(await take("take01")), ...(await take("take02"))];
  const { controller, els, logs, states, combinedKeys } = await cancelHarness({ records });

  const results = await controller.combinePolyFiles();

  assert.equal(results, undefined);
  assert.deepEqual(states, [], "取消时不该进入「合并中」");
  assert.deepEqual(combinedKeys, [], "取消时不该标记任何 take 已合并");
  assert.equal(els.combinePolyBtn.disabled, false, "取消后按钮要回到可用状态");
  assert.doesNotMatch(els.statusLine.textContent, /合并完成/);
  assert.doesNotMatch(logText(logs), /Combine Poly/);
});

test("用户主动关掉保存框（AbortError）仍然整批退出，不被算成 take 失败", async () => {
  const records = [...(await take("take01")), ...(await take("take02"))];
  const abort = new Error("The user aborted a request.");
  abort.name = "AbortError";
  const directory = fakeDirectory({ writeErrors: { "take01_Poly.WAV": abort } });
  const { controller, logs } = await harness({ records, directory });

  await assert.rejects(() => controller.combinePolyFiles(), /aborted/);
  // 取消不走"记账成功"：没有 Combine Poly OK，也没有把取消说成 take 失败。
  assert.doesNotMatch(logText(logs), /Combine Poly WARN/, "取消不是 take 失败，不该进失败清单");
  assert.doesNotMatch(logText(logs), /Combine Poly OK/);
  // 文件名可能已经被 getFileHandle({create:true}) 建出来，但内容必须是空的——
  // 半截 WAV 才是真正的伤害。
  assert.deepEqual(directory.opened, ["take01_Poly.WAV"]);
  assert.equal(directory.readBytes("take01_Poly.WAV").length, 0);
});

test("SyncRef / 同步说明这类既有 WARN 不会被误记成 take 失败", async () => {
  const records = [...(await take("take01")), ...(await take("take02"))];
  // sidecar 写不进去但主 Poly 已落盘：按既有语义这是 WARN，不是 take 失败。
  const directory = fakeDirectory({
    failFor: ["take01_Poly_合板说明.txt", "take01_Poly_channels.json", "take02_Poly_合板说明.txt", "take02_Poly_channels.json"],
  });
  const { controller, els, logs } = await harness({ records, directory });

  const results = await controller.combinePolyFiles();

  assert.deepEqual(results.map(item => item.name), ["take01_Poly.WAV", "take02_Poly.WAV"]);
  assert.match(els.statusLine.textContent, /Poly 合并完成：2 个文件/);
  assert.doesNotMatch(els.statusLine.textContent, /失败/);
  assert.equal(logs.filter(line => line.startsWith("Combine Poly WARN:")).length, 0);
  assert.equal(logs.filter(line => line.startsWith("Sync guide WARN:")).length, 2);
});

test("覆盖确认被拒绝时整批中止，不会静默截断已有文件", async () => {
  const records = [...(await take("take01")), ...(await take("take02"))];
  const directory = fakeDirectory({ existing: ["take02_Poly.WAV"] });
  const { controller, els, logs } = await harness({ records, directory, overwrite: false });

  const results = await controller.combinePolyFiles();

  assert.equal(results, undefined);
  assert.deepEqual(directory.polyNames(), [], "拒绝覆盖时不写出任何新文件");
  assert.match(logText(logs), /Overwrite ASK: take02_Poly\.WAV/);
  assert.doesNotMatch(els.statusLine.textContent, /合并完成/);
});

test("已有同名文件且确认覆盖时照常全部写出（成功路径未被失败隔离波及）", async () => {
  const records = [...(await take("take01")), ...(await take("take02"))];
  const directory = fakeDirectory({ existing: ["take02_Poly.WAV"] });
  const { controller, els, logs } = await harness({ records, directory, overwrite: true });

  const results = await controller.combinePolyFiles();

  assert.deepEqual(results.map(item => item.name), ["take01_Poly.WAV", "take02_Poly.WAV"]);
  assert.match(els.statusLine.textContent, /Poly 合并完成：2 个文件/);
  assert.match(els.toast.textContent, /✅ Poly 合并完成 — 2 个文件/);
  assert.match(logText(logs), /Combine Poly DONE: 成功 2 个 \/ 失败 0 个/);
});

test("畸形输入不抛未捕获异常：没有可合并的 take 仍然是明确的报错", async () => {
  const solo = await audioRecord("LONELY.wav", [await silent(240)], { sampleRate: 48000, bits: 16 });
  const records = [{ ...solo, parentPath: "", relativePath: "LONELY.wav", name: "LONELY.wav" }];
  const directory = fakeDirectory();
  const { controller } = await harness({ records, directory });

  await assert.rejects(() => controller.combinePolyFiles(), /没有识别到可合并的分轨 take/);
  assert.deepEqual(directory.polyNames(), []);
});
test("时码准备失败的 take 只跳过自己，其余 take 照常合并", async () => {
  // 旧写法是 map 一次跑完：任何一个 take 缺 LTC 就让整批陪葬。这里锁住"逐个成败"。
  const records = [
    ...await take("take01"),
    ...await take("take02"),
    ...await take("take03"),
  ].map(record => ({ ...record, parentPath: "", relativePath: record.name, name: record.name }));

  // take02 的分轨一条 LTC 都没有，其余两个 take 时码齐全。
  const ltcResults = new Map();
  for (const record of records) {
    if (!record.name.startsWith("take02")) {
      ltcResults.set(recordKey(record), { ok: true, newTimeReference: 172800000n, fpsValue: "25" });
    }
  }

  const directory = fakeDirectory();
  const groups = combineEligibleGroupsFor(records, detectTakeGroupKeys(records));
  const logs = [];
  const controller = createPolyCombineController({
    ...el,
    els: fakeEls(),
    combineEligibleGroups: () => groups,
    confirmCombinePoly: async () => "ltc",
    getOutputDirectory: async () => directory,
    requestOverwrite: async () => true,
    getLtcResults: () => ltcResults,
    log: line => logs.push(line),
  });

  const results = await controller.combinePolyFiles();
  assert.equal(results.length, 2, "take02 缺 LTC，另外两个 take 仍应产出");
  assert.deepEqual(directory.polyNames().sort(), ["take01_Poly.WAV", "take03_Poly.WAV"]);
  assert.match(logText(logs), /Combine Poly DONE: .* 2 .* \/ .* 1 /);
  assert.match(logText(logs), /take02/);
  assert.match(logText(logs), /LTC/);
});
