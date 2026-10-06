// 对齐/纠错在写入层的落地（src/wave-combine.js 的 repair 通道）
//
// take-repair.test.mjs 证明"测得准"，这里证明"写下去的位置对"：
// planTrackRepair 给的意图（补多少静音 / 丢多少开头 / 重采样多少 / 是否反接）必须
// 在 PCM 搬运层被逐采样执行。回归锁那条用例最关键——不传 repair 时输出必须和改动前
// 逐字节相同，否则等于悄悄改了所有既有导出。

import test from "node:test";
import assert from "node:assert/strict";

import { audioRecord, MemoryWritable } from "./helpers.mjs";
import { readAudioSample } from "../src/wave-audio.js";
import { scanWave } from "../src/wave.js";
import { combineRepairKey, validateCombineGroup, writeCombinedPolyToWritable } from "../src/wave-combine.js";
import { planTrackRepair } from "../src/take-repair.js";

// 每帧给一个可辨认的值：定位错一个采样，断言会立刻炸出来。
// 1/4096 的步长在 16 bit 下正好是 8 个量化单位，往返转换完全无损。
const ramp = length => Float32Array.from({ length }, (_, index) => index / 4096);
const silent = length => new Float32Array(length);

// 按写入层的约定造漂移素材：driftRatio = r 时输出第 n 帧取 B[n / r]，
// 所以 B[i] 必须等于 A[i * r]。写入层用线性插值，这里也用同一套插值，
// 素材本身是线性斜坡，插值结果应当逐采样精确。
// 多留一帧：输出最后一帧的插值要往后借一个采样，否则会退化成取最后一个采样。
function driftTarget(A, r) {
  const B = new Float32Array(Math.round(A.length / r) + 1);
  for (let i = 0; i < B.length; i++) {
    const position = i * r, i0 = Math.floor(position), frac = position - i0;
    const i1 = Math.min(A.length - 1, i0 + 1);
    B[i] = A[i0] * (1 - frac) + A[i1] * frac;
  }
  return B;
}

function delay(signal, samples) {
  const out = new Float32Array(signal.length + samples);
  out.set(signal, samples);
  return out;
}

// mulberry32：全程 32 位整数运算。state * 1103515245 那种写法乘积约 2.4e18，
// 远超双精度 2^53，低位会被抹平，生成出来的"噪声"其实带周期结构，
// 拿去当素材会让互相关出现假峰（test/take-repair.test.mjs 里踩过同一个坑）。
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 宽带素材上"逐采样相等"会因为测量误差差一两个采样而误报失败，
// 而合板真正要保证的性质是"波形对上了、且对在零延迟附近"。
// 所以这里用归一化互相关的峰值位置来判定对齐。
function bestAlignmentLag(output, reference, maxLag = 8) {
  let lag = null, score = -Infinity;
  for (let candidate = -maxLag; candidate <= maxLag; candidate++) {
    let dot = 0, outEnergy = 0, refEnergy = 0;
    for (let i = 0; i < output.length; i++) {
      const j = i + candidate;
      if (j < 0 || j >= reference.length) continue;
      dot += output[i] * reference[j];
      outEnergy += output[i] * output[i];
      refEnergy += reference[j] * reference[j];
    }
    const value = dot / Math.sqrt((outEnergy * refEnergy) || 1);
    if (value > score) { score = value; lag = candidate; }
  }
  return { lag, score };
}

const keyOf = record => combineRepairKey({ record, channelIndex: 0 });

async function combine(records, options = {}) {
  const writable = new MemoryWritable();
  // archive 保留源编码（16 bit 整 PCM）：修正后的采样走的是"浮点往返再写回"那条路，
  // 逐字节断言才有意义。pcm24 分支另有用例覆盖。
  const result = await writeCombinedPolyToWritable("TAKE01", records, writable, "test_Poly.WAV", {
    profile: "archive", fallbackFpsValue: "25", ...options,
  });
  const file = new File([writable.bytes], "test_Poly.WAV");
  const parsed = await scanWave({ getFile: async () => file });
  const view = new DataView(await file.slice(parsed.dataOffset).arrayBuffer());
  const sample = (frame, channel) => readAudioSample(view, frame * parsed.blockAlign + channel * (parsed.blockAlign / parsed.channels), parsed);
  return { result, parsed, bytes: writable.bytes, sample, view };
}

// planTrackRepair 返回值的形状照抄一份，保证接线吃的就是真实字段名。
const plan = ({ leadSamples = 0, skipSamples = 0, driftRatio = 1, polarity = 1, trimSamples = 0 }) => ({
  startSamples: -leadSamples,
  leadSamples,
  skipSamples: Math.max(0, skipSamples),
  padSamples: Math.max(0, leadSamples),
  driftRatio,
  polarity,
  trimSamples,
  needsResample: Math.abs(driftRatio - 1) > 1e-5,
  needsOffset: Math.abs(leadSamples) > 0.5,
});

async function twoTrackTake(frames, second) {
  return Promise.all([
    audioRecord("TAKE01_Tr1.WAV", [ramp(frames)]),
    audioRecord("TAKE01_Tr2.WAV", [second]),
  ]);
}

test("A1 回归锁：不传 repair / 开关关闭 / 计划为空，输出逐字节不变", async () => {
  const records = await twoTrackTake(64, ramp(64));
  const plain = await combine(records);
  assert.ok(plain.bytes.byteLength > 0);
  assert.equal(plain.result.repairs, undefined, "默认返回值里不该多出修正字段");

  const variants = [
    { repair: { enabled: false, plans: { [keyOf(records[0])]: plan({ leadSamples: 7 }) } } },
    { repair: { plans: { [keyOf(records[0])]: plan({ leadSamples: 7 }) } } }, // 缺 enabled 视为关闭
    { repair: { enabled: true, plans: {} } },
    // 计划存在但什么都不改：照样不许动一个字节。
    { repair: { enabled: true, plans: { [keyOf(records[0])]: plan({}), [keyOf(records[1])]: plan({}) } } },
  ];
  for (const options of variants) {
    const variant = await combine(records, options);
    assert.deepEqual([...variant.bytes], [...plain.bytes], "修正开关必须是逐字节惰性的");
    assert.deepEqual(variant.result.tracks, plain.result.tracks);
  }
});

test("A2 晚开机：头部补正确长度的静音，内容落在正确位置", async () => {
  const frames = 512, late = 96;
  const reference = ramp(frames);
  // 晚开机 late 个采样 = target 是 reference 去掉开头的切片，尾部仍然对齐。
  const lateStart = reference.subarray(late);
  const records = await twoTrackTake(frames, lateStart);
  assert.notEqual(records[0].durationSamples, records[1].durationSamples, "这个场景必须是分轨时长不同的");

  const { result, parsed, sample } = await combine(records, {
    repair: { enabled: true, referenceKey: keyOf(records[0]), plans: { [keyOf(records[1])]: plan({ leadSamples: late }) } },
  });
  assert.equal(result.durationSamples, BigInt(frames), "输出长度取参考轨");
  assert.equal(parsed.blockAlign / parsed.channels, 2);
  for (let frame = 0; frame < frames; frame++) {
    assert.equal(sample(frame, 0), reference[frame], `参考轨第 ${frame} 帧不应被改动`);
    const expected = frame < late ? 0 : lateStart[frame - late];
    assert.ok(Math.abs(sample(frame, 1) - expected) < 1 / 32768, `第 ${frame} 帧：期望 ${expected}，实测 ${sample(frame, 1)}`);
  }
  assert.equal(result.repairs.length, 1);
  assert.equal(result.repairs[0].outputChannel, 2);
  assert.equal(result.repairs[0].sourceKey, keyOf(records[1]));
  assert.equal(result.repairs[0].leadSamples, late);
  assert.equal(result.repairs[0].padSamples, late);
  assert.equal(result.repairs[0].skipSamples, 0);
  assert.equal(result.repairs[0].resampled, false);
  assert.equal(result.repairs[0].polarity, 1);
  assert.equal(result.repairs[0].trimApplied, false, "裁尾只报告不执行");
});

test("A3 提前开机的 pre-roll：跳过头部后内容与参考轨逐采样对齐", async () => {
  const frames = 512, early = 96;
  const reference = ramp(frames);
  const records = await twoTrackTake(frames, delay(reference, early));
  const { result, sample } = await combine(records, {
    repair: { enabled: true, referenceKey: keyOf(records[0]), plans: { [keyOf(records[1])]: plan({ leadSamples: -early, skipSamples: early }) } },
  });
  assert.equal(result.durationSamples, BigInt(frames), "输出长度仍取参考轨，不被更长的分轨撑开");
  for (let frame = 0; frame < frames; frame++) {
    assert.ok(Math.abs(sample(frame, 1) - reference[frame]) < 1 / 32768,
      `pre-roll 应当整段丢掉：第 ${frame} 帧期望 ${reference[frame]}，实测 ${sample(frame, 1)}`);
  }
  assert.equal(result.repairs[0].skipSamples, early);
  assert.equal(result.repairs[0].padSamples, 0, "提前开机没有需要补的静音");
});

test("A4 两轨极性反接：polarity -1 逐采样取反", async () => {
  const frames = 256;
  const reference = ramp(frames);
  const inverted = Float32Array.from(reference, value => -value);
  const records = await twoTrackTake(frames, inverted);
  const { result, sample, parsed, view } = await combine(records, {
    repair: { enabled: true, plans: { [keyOf(records[1])]: plan({ polarity: -1 }) } },
  });
  for (let frame = 0; frame < frames; frame++) {
    const expected = Math.round(reference[frame] * 32768);
    const negated = Math.round(-inverted[frame] * 32768);
    // 16 bit 整数 PCM 的取反必须是精确往返：直接比字节，不比浮点。
    assert.equal(view.getInt16(frame * parsed.blockAlign, true), expected, `参考轨第 ${frame} 帧不应被改动`);
    assert.equal(view.getInt16(frame * parsed.blockAlign + parsed.blockAlign / parsed.channels, true), negated,
      `第 ${frame} 帧应当逐字节取反`);
    assert.equal(sample(frame, 0), reference[frame]);
  }
  assert.equal(result.repairs[0].polarity, -1);
  assert.equal(result.repairs[0].polarityFlipped, true);
  assert.equal(result.repairs[0].leadSamples, 0);
  assert.equal(result.repairs[0].driftRatio, 1);
});

test("A5 时钟漂移：重采样后总长度与内容位置符合预期", async () => {
  const frames = 512, driftRatio = 0.99;
  const reference = ramp(frames);
  const drifted = driftTarget(reference, driftRatio); // 比参考轨长（时钟慢）
  const records = await twoTrackTake(frames, drifted);
  const { result, parsed, sample } = await combine(records, {
    repair: { enabled: true, referenceKey: keyOf(records[0]), plans: { [keyOf(records[1])]: plan({ driftRatio }) } },
  });
  assert.equal(result.durationSamples, BigInt(frames), "重采样把轨长拉回参考轨长度");
  assert.equal(parsed.dataSize, frames * parsed.blockAlign);
  for (let frame = 0; frame < frames; frame++) {
    // 目标轨先被量化成 16 bit，插值又要重新量化一次，容差给到 2 个量化单位。
    assert.ok(Math.abs(sample(frame, 1) - reference[frame]) < 2 / 32768,
      `重采样后第 ${frame} 帧期望 ${reference[frame]}，实测 ${sample(frame, 1)}`);
  }
  assert.equal(result.repairs[0].resampled, true);
  assert.equal(result.repairs[0].driftRatio, driftRatio);
  assert.equal(result.repairs[0].leadSamples, 0);
});

test("A6 修正信息可追溯，且裁尾只报告", async () => {
  const frames = 256, late = 40, extra = 40;
  const reference = ramp(frames);
  // 晚开录 late，尾部又多录了 extra：那台机器两头都比参考轨多，尾巴那截是真实录音。
  const target = new Float32Array(frames - late + extra);
  target.set(reference.subarray(late));
  const records = await twoTrackTake(frames, target);
  const { result, sample } = await combine(records, {
    repair: { enabled: true, referenceKey: keyOf(records[0]), plans: { [keyOf(records[1])]: { ...plan({ leadSamples: late }), trimSamples: extra } } },
  });
  const report = result.repairs;
  assert.equal(report.length, 1);
  assert.deepEqual(Object.keys(report[0]).sort(), [
    "driftRatio", "leadSamples", "name", "outputChannel", "padSamples", "polarity", "polarityFlipped",
    "resampled", "skipSamples", "source", "sourceChannel", "sourceKey", "trimApplied", "trimSamples",
  ]);
  assert.equal(report[0].name, "Tr2");
  assert.equal(report[0].source, "TAKE01_Tr2.WAV");
  assert.equal(report[0].sourceChannel, 1);
  assert.equal(report[0].padSamples, late);
  assert.equal(report[0].trimSamples, extra);
  assert.equal(report[0].trimApplied, false, "裁掉的是真实录音，只报告不执行");
  assert.equal(result.durationSamples, BigInt(frames), "尾部多出来的 extra 不该把输出撑长");
  for (let frame = 0; frame < frames; frame++) {
    const expected = frame < late ? 0 : reference[frame];
    assert.ok(Math.abs(sample(frame, 1) - expected) < 1 / 32768, `第 ${frame} 帧：期望 ${expected}，实测 ${sample(frame, 1)}`);
  }
  // 恢复用键：和 selectedSourceChannels 同一套 sourceTrackKey。
  assert.equal(report[0].sourceKey, "TAKE01_Tr2.WAV:0");
});

test("A7 修正参数直接来自 planTrackRepair 的测量结果", async () => {
  const SR = 8000, frames = SR * 3, late = 800;
  const random = mulberry32(20260106);
  // 带包络的宽带噪声：互相关上比纯音更容易定位峰值。
  const reference = Float32Array.from({ length: frames }, (_, i) => (random() * 2 - 1) * (i % 480 === 0 ? 0.2 + 0.8 * random() : 0.4));
  const target = delay(reference, late);
  const measured = planTrackRepair(reference, target, { sampleRate: SR, analysisSeconds: 1 });
  assert.ok(measured, "测量侧应当给出计划");
  // target 是 reference 前面多录了 late 个采样的切片 → lead 为负、skip 为正（提前开机的 pre-roll）。
  assert.ok(Math.abs(measured.leadSamples + late) < 4, `leadSamples=${measured.leadSamples}`);
  assert.ok(Math.abs(measured.skipSamples - late) < 4, `skipSamples=${measured.skipSamples}`);

  const records = await Promise.all([
    audioRecord("TAKE01_Tr1.WAV", [reference]),
    audioRecord("TAKE01_Tr2.WAV", [target]),
  ]);
  const { result, sample } = await combine(records, {
    repair: { enabled: true, referenceKey: keyOf(records[0]), plans: { [keyOf(records[1])]: measured } },
  });
  assert.equal(result.repairs[0].leadSamples, measured.leadSamples);
  const out = Float32Array.from({ length: frames }, (_, frame) => sample(frame, 1));
  const alignment = bestAlignmentLag(out, reference);
  assert.ok(Math.abs(alignment.lag) <= 2, `峰值落在 lag=${alignment.lag}，没有对齐到零延迟附近`);
  assert.ok(alignment.score > 0.99, `归一化互相关只有 ${alignment.score}`);
});

test("A8 畸形修正参数与畸形 record 都不抛错，且退回未修正行为", async () => {
  const frames = 128;
  const records = await twoTrackTake(frames, ramp(frames));
  const plain = await combine(records);
  const junk = [
    { leadSamples: Number.NaN },
    { leadSamples: Number.POSITIVE_INFINITY },
    { driftRatio: "abc" },
    { driftRatio: 0 },
    { driftRatio: -1 },
    { leadSamples: 8, skipSamples: -8, driftRatio: 0.999 },
    { leadSamples: 8, needsOffset: false, driftRatio: 1.01, needsResample: false }, // 门槛判"不值得改"
    "not-an-object",
    42,
    null,
  ];
  for (const bad of junk) {
    const { result, bytes } = await combine(records, {
      repair: { enabled: true, plans: { [keyOf(records[0])]: bad } },
    });
    assert.deepEqual([...bytes], [...plain.bytes], `畸形计划 ${JSON.stringify(bad)} 不该改变输出`);
    assert.deepEqual(result.repairs, [], `畸形计划 ${JSON.stringify(bad)} 不该被登记成修正`);
  }
  // 计划容器本身畸形：数组、Map、空引用都要能安全穿过。
  const containers = [
    [null, 42, { sourceKey: "TAKE01_Tr1.WAV" }],
    new Map([[keyOf(records[1]), plan({ polarity: -1 })]]),
    { plans: "nope" },
    {},
  ];
  for (const plans of containers) {
    await assert.doesNotReject(async () => combine(records, { repair: { enabled: true, plans } }));
  }
  // dataOffset 是 NaN 的 record：validateCombineGroup 不看这个字段，写入层必须自己兜住
  // （整轨静音），不能把 NaN 位置甩给 Blob.slice 或取样偏移。
  const brokenOffset = [{ ...records[0], dataOffset: Number.NaN }, records[1]];
  const salvaged = await combine(brokenOffset, { repair: { enabled: true, referenceKey: keyOf(records[1]) } });
  assert.ok(salvaged.bytes.byteLength > 0);
  for (let frame = 0; frame < 128; frame++) assert.equal(salvaged.sample(frame, 0), 0, "读不出源的轨应当整轨静音");
  // 时长是字符串这种畸形：必须以明确的错误拒绝并 abort 掉输出流，而不是崩溃。
  await assert.rejects(async () => combine([{ ...records[0], durationSamples: "not-a-number" }, records[1]], { repair: { enabled: true } }), /时长|无效|过大/);
});

test("A9 时长不一致的门槛：只有显式给出参考轨才放行", async () => {
  const records = await Promise.all([
    audioRecord("TAKE01_Tr1.WAV", [ramp(100)]),
    audioRecord("TAKE01_Tr2.WAV", [ramp(140)]),
  ]);
  assert.throws(() => validateCombineGroup(records), /时长不同/);
  assert.throws(() => validateCombineGroup(records, { repair: { enabled: true } }), /时长不同/);
  assert.throws(() => validateCombineGroup(records, { repair: { enabled: false, referenceKey: keyOf(records[0]) } }), /时长不同/);
  // 参考轨找不到时同样不猜：退回严格等长，而不是默默挑一条最长的轨当基准。
  assert.throws(() => validateCombineGroup(records, { repair: { enabled: true, referenceKey: "missing:0" } }), /时长不同/);
  assert.equal(validateCombineGroup(records, { repair: { enabled: true, referenceKey: keyOf(records[0]) } }).durationSamples, 100n);
  assert.equal(validateCombineGroup(records, { repair: { enabled: true, outputSamples: 140 } }).durationSamples, 140n);
});

test("A10 pcm24 编码下修正同样生效", async () => {
  const frames = 256, late = 64;
  const reference = ramp(frames);
  const records = await twoTrackTake(frames, reference.subarray(late));
  const { result, sample } = await combine(records, {
    profile: "resolve",
    repair: { enabled: true, referenceKey: keyOf(records[0]), plans: { [keyOf(records[1])]: plan({ leadSamples: late }) } },
  });
  assert.equal(result.bitsPerSample, 24);
  for (let frame = 0; frame < frames; frame++) {
    // 源是 16 bit、输出是 24 bit，量化步长差 256 倍：容差按源的 1 个量化单位算。
    assert.ok(Math.abs(sample(frame, 0) - reference[frame]) < 1 / 32768, `参考轨第 ${frame} 帧不应被改动`);
    const expected = frame < late ? 0 : reference[frame];
    assert.ok(Math.abs(sample(frame, 1) - expected) < 1 / 32768, `第 ${frame} 帧：期望 ${expected}，实测 ${sample(frame, 1)}`);
  }
});
