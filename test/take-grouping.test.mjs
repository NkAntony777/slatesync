// take 分组（src/grouping.js 的通用分轨规则）
//
// 分组是合板率的第一道闸门：分不出来就永远进不了后面的检查。这里钉死两件事，
// 缺一不可——
//   1) 常见录音机的分轨命名要能成组（Sound Devices MixPre / Tascam / 通用数字后缀 / 单侧 LR 对）；
//   2) 成组必须比"看起来像"更严：take 序列、多声道 Poly、日期尾巴都不能被误合并。
//
// 现实依据：Sound Devices MixPre-3 用户手册「文件命名」一节说明单声道文件名
// 由「场景名 + take 号 + 轨道序号」构成，官方示例就是 S01T01_1.WAV 这类形态；
// 旧规则只认 _Tr/_Ch/_LR，MixPre 素材在本项目里合板率恒为 0。

import test from "node:test";
import assert from "node:assert/strict";

import {
  combineSortValue,
  detectTakeGroupKeys,
  genericTrackNumber,
  hasSplitTrackNamePattern,
  recordsByGroupFor,
  combineEligibleGroupsFor,
} from "../src/grouping.js";
import { sourceChannelIndex, trackNameForSource, writeCombinedPolyToWritable } from "../src/wave-combine.js";
import { MemoryWritable, audioRecord } from "./helpers.mjs";

const BASE = {
  channels: 1,
  sampleRate: 48000,
  bitsPerSample: 24,
  audioFormat: 1,
  durationSamples: 2880000n, // 60s @48k
  oldTimeReference: 0n,
};

function rec(spec) {
  const { name, ...over } = typeof spec === "string" ? { name: spec } : spec;
  return { ...BASE, ...over, name, relativePath: `FOLDER01/${name}`, parentPath: "FOLDER01" };
}

// 只统计真正被识别为 take 的分组。recordsByGroupFor 会把未分组的记录按自身 key 兜底成组，
// 所以不能直接用它判断"有没有成组"——那样未分组会算成 size 1，把"没合上"读成"合上了"。
function takeGroupSizes(records) {
  const keys = detectTakeGroupKeys(records);
  const sizes = new Map();
  for (const record of records) {
    const key = keys.get(record.relativePath);
    if (key) sizes.set(key, (sizes.get(key) || 0) + 1);
  }
  return sizes;
}

function biggestGroupSize(records) {
  const sizes = takeGroupSizes(records);
  return sizes.size ? Math.max(...sizes.values()) : 0;
}

test("G1 常见录音机的分轨命名都能成组", () => {
  const cases = {
    "Sound Devices MixPre-3 官方示例": ["S01T01_1.WAV", "S01T01_2.WAV", "S01T01_3.WAV"],
    "MixPre-3 无场景名": ["T01_1.wav", "T01_2.wav", "T01_3.wav"],
    "麦克风名 + 数字": ["Boom_1.wav", "Boom_2.wav", "XLR1.wav", "XLR2.wav", "MIC_1.WAV", "MIC_2.WAV"],
    "单侧 LR 对（旧规则完全漏掉）": ["Mix_L.wav", "Mix_R.wav", "CAM_A_L.wav", "CAM_A_R.wav"],
    "Take-A 序号": ["TAKE01_A001.wav", "TAKE01_A002.wav", "TAKE01_A003.wav"],
    "Zoom 显式轨道标记": ["ZOOM0001_Tr1.WAV", "ZOOM0001_Tr2.WAV", "ZOOM0001_Tr6.WAV"],
    "显式 CH 标记": ["0001_CH1.wav", "0001_CH2.wav"],
  };
  for (const [label, names] of Object.entries(cases)) {
    assert.ok(biggestGroupSize(names.map(rec)) >= 2, `${label} 应当成组`);
  }
});

test("G2 Zoom 既有行为一字不变", () => {
  const records = ["ZOOM0001_Tr1.WAV", "ZOOM0001_Tr2.WAV", "ZOOM0001_Tr6.WAV", "ZOOM0001_LR.WAV"].map(rec);
  const keys = detectTakeGroupKeys(records);
  // ZOOM0001_LR 与 Tr 同组是改动前就有的行为（老规则同样走 PAIRED_LR 正则），这里锁住它。
  for (const name of ["ZOOM0001_Tr1.WAV", "ZOOM0001_Tr2.WAV", "ZOOM0001_Tr6.WAV", "ZOOM0001_LR.WAV"]) {
    assert.equal(keys.get(`FOLDER01/${name}`), "FOLDER01/ZOOM0001");
  }
  const sorted = [...records].sort((a, b) => combineSortValue(a) - combineSortValue(b));
  assert.deepEqual(sorted.map(record => record.name), [
    "ZOOM0001_LR.WAV", "ZOOM0001_Tr1.WAV", "ZOOM0001_Tr2.WAV", "ZOOM0001_Tr6.WAV",
  ]);
  // 显式轨道标记不走通用序号，排序值必须与改动前一致（LR=0, Tr1=11, Tr2=12, Tr6=16）。
  assert.deepEqual(records.map(combineSortValue).sort((a, b) => a - b), [0, 11, 12, 16]);
  assert.equal(genericTrackNumber(rec("ZOOM0001_Tr2.WAV")), null);
});

test("G3 take 序列不会被误合并成 Poly", () => {
  // TAKE01 / TAKE02 的主干就是 take 计数器本身，成组等于把两次录音焊成一个 Poly。
  const cases = {
    "TAKE 序列": ["TAKE01.wav", "TAKE02.wav"],
    "Clip 序列": ["Clip01.wav", "Clip02.wav"],
    "单字母 T 序列": ["T01.wav", "T02.wav"],
    "音轨序号冲突": ["X_1.wav", "X_1 (1).wav"],
    "无稳定主干": ["001.wav", "002.wav"],
    // (?<![0-9]) 之后整段 8 位日期不再被从中间切开。
    "日期尾巴": ["MIC_20260106.wav", "MIC_20260107.wav"],
  };
  for (const [label, names] of Object.entries(cases)) {
    assert.equal(biggestGroupSize(names.map(rec)), 0, `${label} 不应成组`);
  }
});

test("G4 元数据不佐证时，猜出来的分组一律不放行", () => {
  const names = ["Boom_1.wav", "Boom_2.wav"];
  // 时码都在且不同 = 两次不同录音的直接证据，不能再退回时长判据。
  const differentRef = names.map((name, i) => rec({ name, oldTimeReference: BigInt(i * 96000) }));
  assert.equal(biggestGroupSize(differentRef), 0);
  // 采样率不一致，说明不是同一套录音设置。
  assert.equal(biggestGroupSize([rec({ name: names[0] }), rec({ name: names[1], sampleRate: 44100 })]), 0);
  // 位深不一致同理。
  assert.equal(biggestGroupSize([rec({ name: names[0] }), rec({ name: names[1], bitsPerSample: 16 })]), 0);
  // 通用规则只服务单声道分轨；多声道更可能是 take 本身或混音成品。
  const poly = [rec({ name: "ZOOM0001.WAV", channels: 2 }), rec({ name: "ZOOM0002.WAV", channels: 2 })];
  assert.equal(biggestGroupSize(poly), 0);
  // 时长差超过 1% 时不再算「像同一次录音」。
  const far = [rec({ name: "C_1.wav" }), rec({ name: "C_2.wav", durationSamples: 2880000n * 2n })];
  assert.equal(biggestGroupSize(far), 0);
  // 1% 以内的时长差放行——留给对齐/纠错阶段处理，不在这里硬拦。
  const near = [rec({ name: "D_1.wav" }), rec({ name: "D_2.wav", durationSamples: 2880000n + 1000n })];
  assert.equal(biggestGroupSize(near), 2);
});

test("G5 时长差在 1% 以内可以成组，但合板仍要求严格等长", () => {
  // 分组放宽 ≠ 合板放宽：hasExactSameDuration 是合板前的硬门槛，语义保持不变。
  const records = [rec({ name: "E_1.wav" }), rec({ name: "E_2.wav", durationSamples: 2880000n + 1000n })];
  const keys = detectTakeGroupKeys(records);
  assert.equal(keys.size, 2, "应当成组");
  assert.equal(combineEligibleGroupsFor(records, keys).length, 0, "时长不等长时仍不得进入合板");
  const equal = [rec({ name: "F_1.wav" }), rec({ name: "F_2.wav" })];
  assert.equal(combineEligibleGroupsFor(equal, detectTakeGroupKeys(equal)).length, 1);
});

test("G6 通用序号决定排序与 iXML 通道号", () => {
  const names = ["S01T01_10.WAV", "S01T01_2.WAV", "S01T01_1.WAV"];
  const records = names.map(rec);
  // 纯名字排序会把 10 排在 2 前面，通道顺序就错了。
  const sorted = [...records].sort((a, b) => combineSortValue(a) - combineSortValue(b));
  assert.deepEqual(sorted.map(record => record.name), ["S01T01_1.WAV", "S01T01_2.WAV", "S01T01_10.WAV"]);
  assert.equal(sourceChannelIndex(rec("S01T01_3.WAV"), 0), 3);
  assert.equal(sourceChannelIndex(rec("Mix_L.wav"), 0), 1);
  assert.equal(sourceChannelIndex(rec("Mix_R.wav"), 0), 2);
  // 通道名仍保留原始文件名主干，便于回溯到卡里的文件。
  assert.equal(trackNameForSource(rec("Boom_1.wav"), 0), "Boom_1");
});

test("G7 单侧 LR 的 L/R 序号不能取错捕获组", () => {
  // (.*?) 是第 1 组、[lr] 是第 2 组；取错组会让两条轨都变成序号 2。
  assert.equal(genericTrackNumber(rec("Mix_L.wav")), 1);
  assert.equal(genericTrackNumber(rec("Mix_R.wav")), 2);
  assert.equal(genericTrackNumber(rec("CAM_A_L.wav")), 1);
  // 序号相同的两条会被 unique 检查拦下，所以这里必须真的拿到 1/2 两个不同值。
  assert.equal(biggestGroupSize([rec("Mix_L.wav"), rec("Mix_R.wav")]), 2);
});

test("G8 畸形与空输入不抛错", () => {
  for (const records of [[], [rec("A_1.wav")], [rec("A_1.wav"), { ...rec("A_2.wav"), durationSamples: "x" }]]) {
    assert.doesNotThrow(() => detectTakeGroupKeys(records));
  }
  assert.equal(hasSplitTrackNamePattern({ name: "plain.wav" }), false);
  assert.equal(hasSplitTrackNamePattern({}), false);
});

test("G9 MixPre 风格命名能真的合出 Poly，通道号写对 iXML", async () => {
  const channels = [0.25, -0.5, 0.75].map(value => new Float32Array(64).fill(value));
  const records = await Promise.all([
    audioRecord("S01T01_1.WAV", [channels[0]]),
    audioRecord("S01T01_2.WAV", [channels[1]]),
    audioRecord("S01T01_3.WAV", [channels[2]]),
  ]);
  const withPaths = records.map(record => ({ ...record, relativePath: `FOLDER01/${record.name}`, parentPath: "FOLDER01" }));
  const keys = detectTakeGroupKeys(withPaths);
  assert.equal(new Set([...keys.values()]).size, 1, "三个分轨应当归入同一个 take");

  const writable = new MemoryWritable();
  const result = await writeCombinedPolyToWritable("S01T01", withPaths, writable, "S01T01_Poly.WAV", { fallbackFpsValue: "25" });
  assert.equal(result.channels, 3);

  const text = new TextDecoder().decode(writable.bytes);
  const indexList = [...text.matchAll(/<CHANNEL_INDEX>(\d+)<\/CHANNEL_INDEX>/g)].map(match => Number(match[1]));
  assert.deepEqual(indexList, [1, 2, 3], "iXML 通道号应来自通用序号，而不是全部退化成 1");
});