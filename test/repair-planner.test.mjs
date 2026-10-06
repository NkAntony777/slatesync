// 对齐修复的读盘规划 + 控制器接线
//
// 这里验证的是"修得出来"和"修不了也不惹事"两件事：
//   - 时长不一致的 take 在开启修复后应当真的能合出 Poly（此前直接被 validateCombineGroup 拦下）
//   - 默认关闭时行为一字不变
//   - 读不到、测不出、选错基准轨都只跳过自己，不打断整批

import test from "node:test";
import assert from "node:assert/strict";

import { audioRecord } from "./helpers.mjs";
import { planRepairsForTracks, trackFrameCount } from "../src/repair-planner.js";
import { combineTrackPlan } from "../src/wave-combine.js";
import { sourceTrackKey } from "../src/poly-export-profiles.js";
import { createPolyCombineController } from "../src/poly-combine-controller.js";
import { combineEligibleGroupsFor, detectTakeGroupKeys } from "../src/grouping.js";
import { scanWave } from "../src/wave.js";

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
const SR = 8000;
const PLAN = { sampleRate: SR, analysisSeconds: 0.05, tailGuardSeconds: 0.05 };

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function speechLike(frames, seed) {
  const random = mulberry32(seed);
  const out = new Float32Array(frames);
  let envelope = 0;
  for (let i = 0; i < frames; i++) {
    if (i % 97 === 0) envelope = 0.2 + 0.8 * random();
    out[i] = (random() * 2 - 1) * envelope * 0.5;
  }
  return out;
}

async function record(name, channels, parentPath = "FOLDER01") {
  const built = await audioRecord(name, channels, { sampleRate: SR, bits: 16 });
  return { ...built, name, relativePath: `${parentPath}/${name}`, parentPath };
}

test("P1 晚开机的分轨能算出补静音计划", async () => {
  const reference = speechLike(2000, 3);
  const late = reference.subarray(160); // target[k] = reference[k + 160]
  const records = await Promise.all([
    record("S01T01_1.wav", [reference]),
    record("S01T01_2.wav", [late]),
  ]);
  const tracks = combineTrackPlan(records);
  const result = await planRepairsForTracks(tracks, "", PLAN);

  assert.ok(result.plans.size, "应当为晚开机的分轨算出计划");
  const plan = result.plans.get(sourceTrackKey(tracks[1]));
  assert.ok(plan, "键必须与 sourceTrackKey 一致");
  assert.ok(Math.abs(plan.leadSamples - 160) < 40, `leadSamples=${plan.leadSamples}`);
  assert.ok(Math.abs(plan.padSamples - 160) < 40, `padSamples=${plan.padSamples}`);
  assert.equal(result.outputSamples, 2000);
  assert.equal(result.referenceKey, sourceTrackKey(tracks[0]));
});

test("P2 完全一致的 take 不产出任何计划", async () => {
  const reference = speechLike(2000, 5);
  const records = await Promise.all([
    record("T_1.wav", [reference]),
    record("T_2.wav", [reference]),
  ]);
  const result = await planRepairsForTracks(combineTrackPlan(records), "", PLAN);
  assert.equal(result.plans.size, 0, "没有要改的就不要挂计划");
  assert.ok(result.skipped.length, "应当说明为什么跳过");
});

test("P3 显式指定基准轨", async () => {
  const reference = speechLike(2000, 7);
  const late = reference.subarray(160);
  const records = await Promise.all([
    record("T_1.wav", [late]),
    record("T_2.wav", [reference]),
  ]);
  const tracks = combineTrackPlan(records);
  const wanted = sourceTrackKey(tracks[1]);
  const result = await planRepairsForTracks(tracks, wanted, PLAN);
  assert.equal(result.referenceKey, wanted);
  assert.ok(result.plans.get(sourceTrackKey(tracks[0])), "未选中的那条才需要修正");
  assert.equal(result.plans.has(wanted), false, "基准轨自己不挂计划");
});

test("P4 选不出基准轨 / 空输入都不抛错", async () => {
  assert.doesNotThrow(() => trackFrameCount(null));
  assert.equal(trackFrameCount(null), 0);
  const empty = await planRepairsForTracks([], "", PLAN);
  assert.equal(empty.plans.size, 0);
  assert.equal(empty.referenceKey, "");
  const nullish = await planRepairsForTracks(null, "", PLAN);
  assert.equal(nullish.plans.size, 0);
  const records = await Promise.all([record("X_1.wav", [speechLike(2000, 9)]), record("X_2.wav", [speechLike(2000, 11)])]);
  const tracks = combineTrackPlan(records);
  const missing = await planRepairsForTracks(tracks, "不存在的轨:9", PLAN);
  assert.equal(missing.plans.size, 0, "基准轨不存在就不修");
});

test("P5 默认关闭：时长不一致的 take 仍然被拦下", async () => {
  const reference = speechLike(1200, 13);
  const records = await Promise.all([
    record("D1_1.wav", [reference]),
    record("D1_2.wav", [reference.subarray(0, 1000)]),
  ]);
  const groups = combineEligibleGroupsFor(records, detectTakeGroupKeys(records));
  assert.equal(groups.length, 0, "时长不等长默认不进合板");
});

test("P6 开启修复：时长不一致的 take 真的合出了 Poly", async () => {
  const reference = speechLike(1200, 17);
  const records = await Promise.all([
    record("E1_1.wav", [reference]),
    record("E1_2.wav", [reference.subarray(0, 1000)]),
  ]);
  // 手动放行：修复正是为了让这一类 take 能合，UI 侧把它交给 repair 开关处理。
  const groups = [["FOLDER01/E1", records]];
  const written = [];
  const blobs = new Map();
  const controller = createPolyCombineController({
    confirmCombinePoly: async () => "ok",
    combineEligibleGroups: () => groups,
    confirmMetadataFpsMismatch: async () => true,
    getExportOptions: async () => ({ repair: { enabled: true, referenceKey: "" } }),
    getOutputDirectory: async () => ({
      getFileHandle: async (name) => {
        written.push(name);
        // 按 position 写，与 File System Access 的语义一致，才能把乱序写还原成字节流。
        let buffer = new Uint8Array(0);
        blobs.set(name, () => buffer);
        return {
          createWritable: async () => ({
            write: async ({ position = 0, data }) => {
              const bytes = new Uint8Array(data instanceof Uint8Array ? data : data.buffer);
              if (position + bytes.length > buffer.length) {
                const grown = new Uint8Array(position + bytes.length);
                grown.set(buffer);
                buffer = grown;
              }
              buffer.set(bytes, position);
            },
            truncate: async () => {},
            close: async () => {},
            abort: async () => {},
          }),
        };
      },
    }),
    requestOverwrite: async () => true,
    setCombinedPolyKeys: () => {},
    setState: () => {},
    updateWriteProgress: () => {},
    renderRows: () => {},
    log: () => {},
    els: fakeEls(),
  });

  const results = await controller.combinePolyFiles();
  assert.equal(results.length, 1, "开启修复后这个 take 应当合出来");
  // getFileHandle 在覆盖探测与真正写入时各调一次，所以按去重后的名字断言。
  assert.deepEqual([...new Set(written.filter(name => /\.wav$/i.test(name)))], ["E1_Poly.WAV"]);

  // 产物必须是两通道、且等长于参考轨——修复的产出长度由 outputSamples 决定。
  const polyBytes = blobs.get("E1_Poly.WAV")();
  const parsed = await scanWave({ getFile: async () => new File([polyBytes], "x.wav") });
  assert.equal(parsed.channels, 2);
  assert.equal(parsed.durationSamples, 1200n, "输出长度应当等于基准轨长度");
});

test("P7 修复读盘失败只跳过自己，不打断整批", async () => {
  const reference = speechLike(1200, 19);
  const good = await record("F1_1.wav", [reference]);
  const broken = await record("F1_2.wav", [reference.subarray(0, 1000)]);
  const brokenRecord = { ...broken, file: null, fileHandle: null }; // 模拟读不到
  const records = [good, brokenRecord];
  const groups = [["FOLDER01/F1", records]];
  const logs = [];
  const controller = createPolyCombineController({
    confirmCombinePoly: async () => "ok",
    combineEligibleGroups: () => groups,
    getExportOptions: async () => ({ repair: { enabled: true, referenceKey: "" } }),
    getOutputDirectory: async () => null,
    requestOverwrite: async () => true,
    setCombinedPolyKeys: () => {},
    setState: () => {},
    updateWriteProgress: () => {},
    renderRows: () => {},
    log: line => logs.push(line),
    els: fakeEls(),
  });
  await assert.doesNotReject(() => controller.combinePolyFiles());
  assert.ok(logs.some(line => /Repair/.test(line)), "应当留下 repair 相关日志");
});

test("P8 畸形输入不抛错", async () => {
  for (const run of [
    () => planRepairsForTracks(null, "", PLAN),
    () => planRepairsForTracks([], "", PLAN),
    () => planRepairsForTracks([{ record: null }], "", PLAN),
    () => planRepairsForTracks([{ record: { channels: 0, blockAlign: 0 } }], "", PLAN),
  ]) await assert.doesNotReject(run);
});
test("P9 指定的基准轨在本 take 里不存在时退回自动，并如实标记", async () => {
  const reference = speechLike(2000, 23);
  const late = reference.subarray(160);
  const records = await Promise.all([
    record("G_1.wav", [late]),
    record("G_2.wav", [reference]),
  ]);
  const tracks = combineTrackPlan(records);
  // 模拟"基准轨是另一个 take 的轨"：key 存在但不在本 take 里。
  const foreign = "OTHER_TAKE/9_9.wav:0";
  const result = await planRepairsForTracks(tracks, foreign, PLAN);
  assert.equal(result.referenceMatched, false, "应当标明指定的基准轨没命中");
  assert.ok(result.referenceKey, "仍然要给出一条可用的基准轨");
  assert.equal(result.plans.size, 1, "退回自动后照常修正其余分轨");

  const hit = await planRepairsForTracks(tracks, sourceTrackKey(tracks[1]), PLAN);
  assert.equal(hit.referenceMatched, true);
});
