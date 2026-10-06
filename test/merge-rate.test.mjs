// 合板率总览（src/merge-rate.js）
//
// 这个功能要消灭的黑箱是：状态栏只说"识别到 18 个分轨 take"，却没人说得清这 18 个里
// 现在能合出几个 Poly、剩下的是被什么卡住的。所以这里钉死三件事：
//   1) 计数口径：wavCount / takeCount / eligibleCount / rate 的定义与自洽（可合 + 被卡 = 总数）；
//   2) 归因正确：时长 / 采样率 / 位深 / 格式 / 起始时码，各自落到自己的原因上，
//      且一个 take 只归一个主因（否则按原因计数会和被卡总数对不上）；
//   3) 绝不抛错：空输入、单文件、畸形 record 只能产出空统计，不能把导入流程带崩。
//
// 另外钉住状态栏文案的确切措辞——它是纯函数拼出来的，不必起浏览器就能断言。

import test from "node:test";
import assert from "node:assert/strict";

import {
  MERGE_REASON_LABELS,
  MERGE_REASONS,
  formatMergeRateSummary,
  summarizeMergeRate,
} from "../src/merge-rate.js";
import { detectTakeGroupKeys } from "../src/grouping.js";

const BASE = {
  channels: 1,
  sampleRate: 48000,
  bitsPerSample: 24,
  audioFormat: 1,
  durationSamples: 2880000n, // 60s @48k
  oldTimeReference: 0n,
};

function rec(name, extra = {}) {
  return { ...BASE, name, relativePath: `FOLDER01/${name}`, parentPath: "FOLDER01", ...extra };
}

/** 走显式轨道标记（ZOOMxxxx_TrN）：这类命名不经过通用规则的"单声道 + 1% 时长容差"守卫，
 *  才能构造出真正会被 detectTakeGroupKeys 认成 take、又被某项元数据卡住的素材。 */
function take(prefix, count, overrides = []) {
  return Array.from({ length: count }, (_, index) => rec(`${prefix}_Tr${index + 1}.WAV`, overrides[index] || {}));
}

function reasonCounts(summary) {
  const counts = new Map();
  for (const item of summary.blocked) counts.set(item.reason, (counts.get(item.reason) || 0) + 1);
  return counts;
}

// ---------------------------------------------------------------- 1. 全部可合

test("M1 全部可合：rate = 1，blocked 为空", () => {
  // 两种命名各一个 take：通用分轨规则（MixPre 形态）和 Zoom 显式标记，都应当算 1 个可合 take。
  const records = [
    ...take("ZOOM0001", 3),
    rec("S01T01_1.WAV"),
    rec("S01T01_2.WAV"),
    rec("S01T01_3.WAV"),
  ];
  const summary = summarizeMergeRate(records, detectTakeGroupKeys(records));
  assert.equal(summary.wavCount, 6);
  assert.equal(summary.takeCount, 2);
  assert.equal(summary.eligibleCount, 2);
  assert.deepEqual(summary.blocked, []);
  assert.equal(summary.rate, 1);
});

// ---------------------------------------------------------------- 2. 时长不一致

test("M2 时长不一致：归到时长，rate 正确", () => {
  const records = [
    ...take("ZOOM0001", 2, [{}, { durationSamples: 1440000n }]),
    rec("S01T01_1.WAV"),
    rec("S01T01_2.WAV"),
  ];
  const summary = summarizeMergeRate(records, detectTakeGroupKeys(records));
  assert.equal(summary.takeCount, 2);
  assert.equal(summary.eligibleCount, 1);
  assert.equal(summary.rate, 0.5);
  assert.equal(summary.blocked.length, 1);
  assert.equal(summary.blocked[0].reason, MERGE_REASON_LABELS[MERGE_REASONS.DURATION]);
  assert.equal(summary.blocked[0].code, "duration-mismatch");
  assert.equal(summary.blocked[0].label, "ZOOM0001");
  // 自洽性：可合 + 被卡必须正好等于总数，否则状态栏的按原因计数没法对账。
  assert.equal(summary.eligibleCount + summary.blocked.length, summary.takeCount);
  assert.ok(summary.blocked[0].detail.length > 0, "被卡原因要带得上人话的解释");
});

test("M3 时长读不出来（畸形 BigInt）也算被卡，不抛错", () => {
  // grouping.js 的 hasExactSameDuration 直接 BigInt(record.durationSamples)，
  // 这里是本模块必须替它兜住的崩溃点。
  const records = take("ZOOM0001", 2, [{}, { durationSamples: "不是数字" }]);
  const summary = summarizeMergeRate(records, detectTakeGroupKeys(records));
  assert.equal(summary.takeCount, 1);
  assert.equal(summary.eligibleCount, 0);
  assert.equal(summary.rate, 0);
  assert.equal(summary.blocked.length, 1);
  assert.equal(summary.blocked[0].reason, MERGE_REASON_LABELS[MERGE_REASONS.DURATION]);
});

// ---------------------------------------------------------------- 3. 音频参数与时码

test("M4 采样率 / 位深 / 音频格式 / 起始时码：各自归类", () => {
  const cases = [
    {
      title: "采样率不一致",
      overrides: [{}, { sampleRate: 44100 }],
      reason: MERGE_REASONS.SAMPLE_RATE,
      code: "sample-rate-mismatch",
    },
    {
      title: "位深不一致",
      overrides: [{}, { bitsPerSample: 16 }],
      reason: MERGE_REASONS.BIT_DEPTH,
      code: "bit-depth-mismatch",
    },
    {
      title: "音频格式不一致",
      overrides: [{}, { audioFormat: 3 }],
      reason: MERGE_REASONS.AUDIO_FORMAT,
      code: "audio-format-mismatch",
    },
    {
      title: "起始时码不一致",
      overrides: [{}, { oldTimeReference: 48000n }],
      reason: MERGE_REASONS.TIMECODE_MISMATCH,
      code: "start-timeref-mismatch",
    },
    {
      title: "起始时码全缺",
      overrides: [{ oldTimeReference: null }, { oldTimeReference: null }],
      reason: MERGE_REASONS.TIMECODE_MISSING,
      code: "timecode-source-missing",
    },
    {
      title: "部分分轨缺时码",
      overrides: [{}, { oldTimeReference: null }],
      reason: MERGE_REASONS.TIMECODE_MISSING,
      code: "timecode-source-incomplete",
    },
  ];
  for (const item of cases) {
    const records = take("ZOOM0001", 2, item.overrides);
    const summary = summarizeMergeRate(records, detectTakeGroupKeys(records));
    assert.equal(summary.takeCount, 1, `${item.title}：应当被认成一个 take`);
    assert.equal(summary.eligibleCount, 0, `${item.title}：不应算作可合`);
    assert.equal(summary.rate, 0, `${item.title}：rate 应当是 0`);
    assert.equal(summary.blocked.length, 1, `${item.title}：应当恰好一条被卡记录`);
    assert.equal(summary.blocked[0].code, item.code, `${item.title}：code 不对`);
    assert.equal(summary.blocked[0].reason, MERGE_REASON_LABELS[item.reason], `${item.title}：reason 不对`);
  }
});

test("M5 一个 take 踩多个坑时只归一个主因，计数仍然对得上", () => {
  // 采样率和时长同时不对：按"先修格式层"的优先级报采样率，时长那条仍由体检面板逐条列。
  const records = take("ZOOM0001", 2, [{ sampleRate: 44100 }, { sampleRate: 48000, durationSamples: 1440000n }]);
  const summary = summarizeMergeRate(records, detectTakeGroupKeys(records));
  assert.equal(summary.takeCount, 1);
  assert.equal(summary.eligibleCount, 0);
  assert.equal(summary.blocked.length, 1, "同一个 take 只能在状态栏里占一行");
  assert.equal(summary.blocked[0].reason, MERGE_REASON_LABELS[MERGE_REASONS.SAMPLE_RATE]);
});

test("M6 多个 take 的原因分布", () => {
  const records = [
    ...take("ZOOM0001", 2),
    ...take("ZOOM0002", 2, [{}, { durationSamples: 1440000n }]),
    ...take("ZOOM0003", 2, [{}, { oldTimeReference: 48000n }]),
    rec("S01T01_1.WAV"),
    rec("S01T01_2.WAV"),
    rec("S01T01_3.WAV"),
  ];
  const summary = summarizeMergeRate(records, detectTakeGroupKeys(records));
  assert.equal(summary.takeCount, 4);
  assert.equal(summary.eligibleCount, 2);
  assert.equal(summary.rate, 0.5);
  assert.deepEqual(reasonCounts(summary), new Map([
    [MERGE_REASON_LABELS[MERGE_REASONS.DURATION], 1],
    [MERGE_REASON_LABELS[MERGE_REASONS.TIMECODE_MISMATCH], 1],
  ]));
  // 按登记优先级排（时长在时码之前），不是按文件名排。
  assert.deepEqual(summary.blocked.map(item => item.label), ["ZOOM0002", "ZOOM0003"]);
});

// ---------------------------------------------------------------- 4. 空统计

test("M7 没有 take 时 rate 是 null，不是 NaN", () => {
  // 单个文件永远构不成 take（分轨 take 至少要两条）。
  const summary = summarizeMergeRate([rec("S01T01_1.WAV")], detectTakeGroupKeys([rec("S01T01_1.WAV")]));
  assert.equal(summary.wavCount, 1);
  assert.equal(summary.takeCount, 0);
  assert.equal(summary.eligibleCount, 0);
  assert.equal(summary.rate, null);
  assert.ok(!Number.isNaN(summary.rate));
  assert.deepEqual(summary.blocked, []);
});

test("M8 空输入返回全 0 统计", () => {
  const empty = summarizeMergeRate([], new Map());
  assert.deepEqual(empty, { wavCount: 0, takeCount: 0, eligibleCount: 0, blocked: [], rate: null });
  assert.equal(formatMergeRateSummary(empty), "", "没有 take 时状态栏不该多出这半句");
});

test("M9 视频音轨和元数据记录不计入 WAV", () => {
  const records = [
    ...take("ZOOM0001", 2),
    { ...rec("A001_C001.mov"), _video: true },
    { ...rec("clip.ale"), _meta: true },
  ];
  const summary = summarizeMergeRate(records, detectTakeGroupKeys(records));
  assert.equal(summary.wavCount, 2, "_video / _meta 不能被当成 WAV 算进合板率");
  assert.equal(summary.takeCount, 1);
});

// ---------------------------------------------------------------- 5. 畸形输入不抛错

test("M10 畸形 record 不抛错，只产出空统计", () => {
  const malformed = [
    null,
    undefined,
    "ZOOM0001_Tr1.WAV",
    42,
    {},
    { name: null, relativePath: null },
    // 这一对刻意让时长/采样率/时码各用一种类型：值相同就该判为一致，类型不同不该被当成不一致。
    rec("ZOOM0001_Tr1.WAV", { durationSamples: 2880000n, sampleRate: 48000, oldTimeReference: 0n }),
    rec("ZOOM0001_Tr2.WAV", { durationSamples: "2880000", sampleRate: "48000", oldTimeReference: "0" }),
  ];
  const summary = summarizeMergeRate(malformed);
  // 只有非对象项（null/undefined/字符串/数字）被剔除；字段全空的对象仍是 WAV 记录
  // （它确实是扫出来的记录），这样口径才和 file-import.js 的 wavRecords 一致。
  assert.equal(summary.wavCount, 4);
  assert.equal(summary.takeCount, 1);
  assert.equal(summary.eligibleCount, 1, `字符串/BigInt 混用不该制造差异：${JSON.stringify(summary.blocked)}`);
  assert.deepEqual(summary.blocked, []);
  assert.equal(summary.rate, 1);
});

test("M10b 时长等字段为 null 时只产出统计，不抛错", () => {
  const malformed = [
    rec("ZOOM0001_Tr1.WAV", { durationSamples: null, sampleRate: null, bitsPerSample: undefined, oldTimeReference: undefined }),
    rec("ZOOM0001_Tr2.WAV", { durationSamples: undefined, sampleRate: undefined, bitsPerSample: undefined, oldTimeReference: undefined }),
  ];
  const summary = summarizeMergeRate(malformed);
  assert.equal(summary.takeCount, 1);
  assert.equal(summary.eligibleCount, 0);
  assert.equal(summary.rate, 0);
  assert.equal(summary.blocked.length, 1);
});

test("M11 非数组 / 非 Map 的入参也不抛错", () => {
  for (const bad of [null, undefined, "abc", 7, {}]) {
    const summary = summarizeMergeRate(bad, bad);
    assert.equal(summary.takeCount, 0);
    assert.equal(summary.rate, null);
    assert.deepEqual(summary.blocked, []);
  }
  // 传了非 Map 的分组结果时退回自算，而不是让 .get 崩掉。
  const records = take("ZOOM0001", 2);
  assert.equal(summarizeMergeRate(records, ["FOLDER01/ZOOM0001"]).takeCount, 1);
});

test("M12 不给分组结果时自己算一遍，和 detectTakeGroupKeys 一致", () => {
  const records = [...take("ZOOM0001", 2), rec("S01T01_1.WAV"), rec("S01T01_2.WAV")];
  const auto = summarizeMergeRate(records);
  const explicit = summarizeMergeRate(records, detectTakeGroupKeys(records));
  assert.deepEqual(auto, explicit);
});

test("M13 同一个入参重复调用结果稳定（不依赖 Map 遍历顺序之外的东西）", () => {
  const records = [
    ...take("ZOOM0001", 2, [{}, { durationSamples: 1440000n }]),
    ...take("ZOOM0002", 2, [{}, { sampleRate: 44100 }]),
  ];
  const keys = detectTakeGroupKeys(records);
  assert.deepEqual(summarizeMergeRate(records, keys), summarizeMergeRate(records, keys));
});

// ---------------------------------------------------------------- 6. 状态栏文案

test("M14 文案：全可合 / 部分可合 / 全都卡住", () => {
  const all = summarizeMergeRate([...take("ZOOM0001", 2), rec("S01T01_1.WAV"), rec("S01T01_2.WAV")]);
  assert.equal(formatMergeRateSummary(all), "，识别到 2 个分轨 take（全部可合）");

  const some = summarizeMergeRate([
    ...take("ZOOM0001", 2),
    ...take("ZOOM0002", 2, [{}, { durationSamples: 1440000n }]),
    ...take("ZOOM0003", 2, [{}, { oldTimeReference: 48000n }]),
  ]);
  assert.equal(formatMergeRateSummary(some), "，识别到 3 个分轨 take（可合 1 个，时长不一致 1 个，起始时码不一致 1 个）");

  const none = summarizeMergeRate([...take("ZOOM0001", 2, [{}, { sampleRate: 44100 }])]);
  assert.equal(formatMergeRateSummary(none), "，识别到 1 个分轨 take（暂时一个都合不了：采样率不一致 1 个）");
});

test("M15 文案能直接拼成状态栏那句「已载入 N 个 WAV…」", () => {
  const records = [
    ...take("ZOOM0001", 2),
    ...take("ZOOM0002", 2, [{}, { durationSamples: 1440000n }]),
  ];
  const summary = summarizeMergeRate(records, detectTakeGroupKeys(records));
  const parts = [];
  if (summary.wavCount) parts.push(`${summary.wavCount} 个 WAV${formatMergeRateSummary(summary)}`);
  assert.equal(
    `已载入 ${parts.join(" + ")}；可偏移预览或从音轨提取 LTC`,
    "已载入 4 个 WAV，识别到 2 个分轨 take（可合 1 个，时长不一致 1 个）；可偏移预览或从音轨提取 LTC",
  );
});

test("M16 文案对残缺入参保持体面，不打印 NaN/undefined", () => {
  assert.equal(formatMergeRateSummary(null), "");
  assert.equal(formatMergeRateSummary({}), "");
  assert.equal(formatMergeRateSummary({ takeCount: 2, eligibleCount: 2, blocked: [] }), "，识别到 2 个分轨 take（全部可合）");
  assert.equal(
    formatMergeRateSummary({ takeCount: 2, eligibleCount: 1, blocked: null }),
    "，识别到 2 个分轨 take（可合 1 个，其余 1 个待体检确认）",
  );
  // 数量多于 3 类原因时折叠，状态行放不下十种原因；同数时保持原因优先级（采样率 > 位深 > 格式 > 时长）。
  const many = summarizeMergeRate([
    ...take("ZOOM0001", 2, [{}, { sampleRate: 44100 }]),
    ...take("ZOOM0002", 2, [{}, { bitsPerSample: 16 }]),
    ...take("ZOOM0003", 2, [{}, { audioFormat: 3 }]),
    ...take("ZOOM0004", 2, [{}, { durationSamples: 1440000n }]),
  ]);
  assert.equal(
    formatMergeRateSummary(many),
    "，识别到 4 个分轨 take（暂时一个都合不了：采样率不一致 1 个，位深不一致 1 个，音频格式不一致 1 个，共 4 类问题）",
  );
});

test("M17 文案里的原因计数之和等于被卡总数", () => {
  const summary = summarizeMergeRate([
    ...take("ZOOM0001", 2),
    ...take("ZOOM0002", 2, [{}, { durationSamples: 1440000n }]),
    ...take("ZOOM0003", 2, [{}, { sampleRate: 44100 }]),
    ...take("ZOOM0004", 2, [{}, { bitsPerSample: 16 }]),
  ]);
  const text = formatMergeRateSummary(summary);
  // 只数括号里的数字（"识别到 N 个分轨 take" 那个 N 不参与对账）。
  const inside = text.slice(text.indexOf("（"));
  const total = [...inside.matchAll(/(\d+) 个/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  // 括号里是"可合 1 个" + 各原因计数，合计应与 take 总数吻合。
  assert.equal(total, summary.takeCount);
  assert.match(text, /可合 1 个/);
});