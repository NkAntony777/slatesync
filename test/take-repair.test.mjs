// take 对齐与纠错（src/take-repair.js）
//
// 这是把「时长不一致」从不可合变成可合的核心算法，所以测试全部用合成信号做**定量**校验：
// 偏移误差、漂移比误差都要卡到具体阈值，而不是只断言"返回了对象"。
// 算法出处（GCC-PHAT / 首尾漂移测量）写在 src/take-repair.js 头部注释里。

import test from "node:test";
import assert from "node:assert/strict";

import { measureOffset, measureDrift, planTrackRepair } from "../src/take-repair.js";

const SR = 8000;
const opts = { sampleRate: SR, analysisSeconds: 1 };

// mulberry32：全程 32 位整数运算。不能用 state * 1103515245 这种写法——乘积约 2.4e18
// 远超双精度的 2^53，低 8 位会被抹成 0，不同种子生成出来的序列实际是相关的，
// 拿它当"无关素材"会得到假阳性，进而把阈值调歪。
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 有宽带瞬态的类语音信号：带包络的噪声，互相关上比纯音更容易定位。
function makeSignal(length, seed = 1) {
  const random = mulberry32(seed);
  const out = new Float32Array(length);
  let envelope = 0;
  for (let i = 0; i < length; i++) {
    if (i % 480 === 0) envelope = 0.2 + 0.8 * random();
    out[i] = (random() * 2 - 1) * envelope;
  }
  return out;
}

function delay(signal, samples) {
  const out = new Float32Array(signal.length);
  out.set(signal.subarray(0, signal.length - samples), samples);
  return out;
}

// 线性插值重采样，模拟时钟偏快/偏慢。
function resample(signal, ratio) {
  const out = new Float32Array(Math.round(signal.length * ratio));
  for (let i = 0; i < out.length; i++) {
    const position = i / ratio;
    const i0 = Math.floor(position);
    const i1 = Math.min(signal.length - 1, i0 + 1);
    out[i] = signal[i0] * (1 - (position - i0)) + signal[i1] * (position - i0);
  }
  return out;
}

test("R1 偏移测到采样级精度", () => {
  const reference = makeSignal(SR * 6, 7);
  const aligned = measureOffset(reference, reference, opts);
  assert.ok(Math.abs(aligned.offsetSamples) < 1, "完全对齐应当报 0");
  assert.ok(Math.abs(aligned.peak - 1) < 1e-6, `相关峰应当是 1，实测 ${aligned.peak}`);

  const shifted = measureOffset(reference, delay(reference, 137), opts);
  assert.ok(Math.abs(shifted.offsetSamples - 137) < 1, `期望 137，实测 ${shifted.offsetSamples}`);
  assert.equal(shifted.polarity, 1);
});

test("R2 峰值搜索必须覆盖 lag = 0", () => {
  // 回归锁：搜索区间一旦漏掉 0，"两轨本来就在同一起点"这种最常见情况会被判成测不出来。
  const reference = makeSignal(SR * 4, 11);
  assert.ok(measureOffset(reference, reference, opts) !== null);
});

test("R3 峰值扫描的初始基准不能是 -Infinity", () => {
  // Math.abs(-Infinity) === Infinity，用它当阈值会让任何真实峰值都超不过，
  // 整条流程一路返回 null。这条用例就是为了钉死比较基准。
  const reference = makeSignal(SR * 4, 13);
  for (const minCorrelation of [1e-9, 0.12, 0.9]) {
    assert.ok(measureOffset(reference, reference, { ...opts, minCorrelation }) !== null,
      `minCorrelation=${minCorrelation} 时不该返回 null`);
  }
});

test("R4 极性反接能被识别出来", () => {
  const reference = makeSignal(SR * 4, 17);
  const inverted = Float32Array.from(reference, value => -value);
  const result = measureOffset(reference, inverted, opts);
  assert.equal(result.polarity, -1);
  assert.ok(Math.abs(result.offsetSamples) < 1, "反接只翻极性，不改变时延");
});

test("R5 素材不足或不可判别时返回 null，绝不硬给一个偏移", () => {
  const reference = makeSignal(SR * 6, 19);
  assert.equal(measureOffset(new Float32Array(0), reference, opts), null);
  assert.equal(measureOffset(reference, new Float32Array(SR), opts), null, "短于分析窗口");
  assert.equal(measureOffset(reference, new Float32Array(SR * 6), opts), null, "整段静音");
  assert.equal(measureOffset(reference, makeSignal(SR * 6, 999), opts), null, "毫无关系的两段素材");
  const noisy = measureOffset(reference, makeSignal(SR * 6, 4242), { ...opts, minCorrelation: 0.12 });
  assert.ok(noisy === null || noisy.peak < 0.12);
});

test("R6 首尾两测得出时钟漂移比", () => {
  const reference = makeSignal(SR * 12, 23);
  const epsilon = 0.0008; // 时钟快 0.08%
  const result = measureDrift(reference, resample(reference, 1 + epsilon), opts);
  assert.ok(result, "应当测出漂移");
  assert.ok(Math.abs(result.ratio - (1 - epsilon)) < 2e-4, `ratio=${result.ratio}`);
  // 尾部的偏移应约为 epsilon × tailStart，符号为正表示 target 越走越靠后。
  assert.ok(result.tailOffsetSamples > result.headOffsetSamples);
});

test("R7 漂移测量在素材不够时宁可不给结果", () => {
  const reference = makeSignal(SR * 12, 29);
  // 装不下「头段 + 尾段 + 尾部保护」，就不该硬凑一个数出来。
  assert.equal(measureDrift(reference.subarray(0, SR * 2), resample(reference, 1.0008).subarray(0, SR * 2), opts), null);
  assert.equal(measureDrift(reference, makeSignal(SR * 12, 777), opts), null);
});

test("R8 超出可信范围的漂移不自动纠", () => {
  const reference = makeSignal(SR * 12, 31);
  // 时钟快 5%，远超 1% 上限：多半是素材根本不是同一次录音，不该当成漂移去改。
  const result = measureDrift(reference, resample(reference, 1.05), { ...opts, maxDrift: 0.01 });
  assert.equal(result, null);
});

test("R9 晚开机 → 头部补静音，且尾部不静默裁切", () => {
  const reference = makeSignal(SR * 6, 37);
  const startSamples = SR / 2;
  // 晚开机 d 个采样：target[k] = reference[k + d]，也就是 target 是 reference 去掉开头的切片。
  const target = reference.subarray(startSamples);

  const plan = planTrackRepair(reference, target, opts);
  assert.ok(plan, "应当能测出偏移");
  // target 是 reference 去掉开头的切片 → 那台机器晚开录 → 前面补静音。
  assert.ok(Math.abs(plan.leadSamples - startSamples) < 50, `leadSamples=${plan.leadSamples}`);
  assert.ok(Math.abs(plan.padSamples - startSamples) < 50, `padSamples=${plan.padSamples}`);
  assert.equal(plan.skipSamples, 0, "晚开机没有需要丢掉的开头");
  // 偏移测量本身有几十个采样的误差，裁切量会跟着抖一点，所以按容差断言而不是按 0 断言。
  assert.ok(plan.trimSamples <= 50, `trimSamples=${plan.trimSamples}`);
  assert.equal(plan.needsResample, false, "0.001% 以下属于测量噪声，不该触发重采样");
  assert.equal(plan.needsOffset, true);
});

test("R9c 真的有时钟偏差时才要求重采样", () => {
  const reference = makeSignal(SR * 12, 67);
  const plan = planTrackRepair(reference, resample(reference, 1.001), opts);
  assert.ok(plan, "应当能测出偏移");
  assert.ok(plan.needsResample, "0.1% 的时钟偏差必须触发重采样");
  assert.ok(Math.abs(plan.driftRatio - 0.999) < 2e-4, `driftRatio=${plan.driftRatio}`);
});

test("R9b 提前开机（有 pre-roll）→ 丢掉开头，不补静音", () => {
  const reference = makeSignal(SR * 6, 61);
  const startSamples = SR / 2;
  // 提前开机：target 在 reference 开录之前就录了 startSamples 个采样（这里填静音模拟）。
  const target = new Float32Array(reference.length + startSamples);
  target.set(reference, startSamples);

  const plan = planTrackRepair(reference, target, opts);
  assert.ok(plan, "应当能测出偏移");
  assert.ok(Math.abs(plan.leadSamples + startSamples) < 50, `leadSamples=${plan.leadSamples}`);
  assert.ok(Math.abs(plan.skipSamples - startSamples) < 50, `skipSamples=${plan.skipSamples}`);
  assert.equal(plan.padSamples, 0, "提前开机没有需要补的静音");
  assert.equal(plan.trimSamples, 0);
});

test("R10 内容比参考轨长时报告裁切量，但由调用方决定是否真的裁", () => {
  const full = makeSignal(SR * 8, 71);
  const reference = full.subarray(0, SR * 4);
  const target = full.subarray(0, SR * 6);
  const plan = planTrackRepair(reference, target, opts);
  assert.ok(plan, "应当能测出偏移");
  assert.ok(plan.trimSamples > 0, `应当报告需要裁掉多少，实测 ${plan.trimSamples}`);
  assert.equal(plan.padSamples, 0);
});

test("R11 已经对齐的轨不需要任何修复", () => {
  const reference = makeSignal(SR * 6, 47);
  const plan = planTrackRepair(reference, reference, opts);
  assert.ok(plan);
  assert.deepEqual(
    { pad: plan.padSamples, skip: plan.skipSamples, trim: plan.trimSamples },
    { pad: 0, skip: 0, trim: 0 },
  );
  assert.equal(plan.needsResample, false);
  assert.equal(plan.needsOffset, false);
});

test("R12 畸形输入不抛错", () => {
  const reference = makeSignal(SR * 4, 53);
  const junk = new Float32Array(SR * 4);
  for (let i = 0; i < junk.length; i++) junk[i] = i % 7 === 0 ? Number.NaN : 0;
  for (const run of [
    () => measureOffset(null, reference, opts),
    () => measureOffset(reference, null, opts),
    () => measureDrift(reference, new Float32Array(0), opts),
    () => planTrackRepair(reference, junk, opts),
    () => planTrackRepair(new Float32Array(0), new Float32Array(0), opts),
  ]) assert.doesNotThrow(run);
});