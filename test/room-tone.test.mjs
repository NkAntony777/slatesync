// 房间声（room tone）与等功率交叉淡化的纯函数核心（src/room-tone.js）
//
// 这层只做算术，不碰文件也不碰音频设备，所以判据可以写得非常硬：
// 每一条都是"输入 → 期望输出"的精确断言，而不是"听起来对不对"。
// 写入层的落地在 test/repair-fill-apply.test.mjs。

import test from "node:test";
import assert from "node:assert/strict";

import {
  ROOM_TONE_DEFAULTS,
  buildSeamlessLoop,
  equalPowerGains,
  evaluateToneCandidate,
  findQuietestSpan,
  meanOf,
  peakOf,
  planCrossfadeRegions,
  rmsOf,
  toneSampleAt,
} from "../src/room-tone.js";

const ramp = length => Float32Array.from({ length }, (_, index) => index / 4096);
const sine = (length, amplitude, frequencyHz, sampleRate = 48000) =>
  Float32Array.from({ length }, (_, index) => amplitude * Math.sin(2 * Math.PI * frequencyHz * index / sampleRate));

test("T1 rmsOf / peakOf：空输入按 0，数值与定义一致", () => {
  assert.equal(rmsOf(null), 0);
  assert.equal(rmsOf(new Float32Array(0)), 0);
  assert.equal(peakOf(new Float32Array(0)), 0);
  const constant = new Float32Array([0.5, -0.5, 0.5, -0.5]);
  assert.ok(Math.abs(rmsOf(constant) - 0.5) < 1e-9);
  assert.ok(Math.abs(peakOf(constant) - 0.5) < 1e-9);
  // 斜坡的 RMS 有闭式解：sqrt((1/n)·Σ(i/4096)²)
  const sloped = ramp(64);
  let expected = 0;
  for (const value of sloped) expected += value * value;
  expected = Math.sqrt(expected / 64);
  assert.ok(Math.abs(rmsOf(sloped) - expected) < 1e-12);
});

test("T2 findQuietestSpan：找出能量最低的连续窗口", () => {
  const blocks = [0.5, 0.4, 0.02, 0.03, 0.6, 0.01, 0.5];
  const span = findQuietestSpan(blocks, 2);
  assert.ok(span);
  // 各窗口的能量和：0.41 / 0.1604 / 0.0013 / 0.3609 / 0.3601 / 0.2501。
  // 最低的是 [2,4)（0.02²+0.03²）。注意 0.01²+0.5² 更大——
  // 一块极静配一块很响，绝不是好候选，这正是不用 dB 平均的理由。
  assert.deepEqual([span.start, span.end], [2, 4]);
  // 窗口比序列还长时退化成整段。
  const whole = findQuietestSpan(blocks, 99);
  assert.deepEqual([whole.start, whole.end], [0, blocks.length]);
  // 空输入不抛错。
  assert.equal(findQuietestSpan([], 4), null);
  assert.equal(findQuietestSpan(null, 4), null);
});

test("T3 buildSeamlessLoop：接缝处变成素材内部的自然步进", () => {
  const length = 512, fade = 64;
  const template = ramp(length);
  const loop = buildSeamlessLoop(template, fade);
  assert.equal(loop.length, length - fade);
  // 关键性质：循环回绕点（末尾 → 开头）的跳变，和素材内部的步进一样。
  // 没做无缝处理时这里是 (L-1)/4096 的巨大台阶。
  const step = 1 / 4096;
  assert.ok(Math.abs((loop[0] - loop[loop.length - 1]) - step) < 1e-6,
    `回绕跳变应当是自然步进 ${step}，实测 ${loop[0] - loop[loop.length - 1]}`);
  // 淡出区本身也是连续的：相邻采样之间不该出现比自然步进大得多的跳变。
  for (let i = 1; i < loop.length; i++) {
    assert.ok(Math.abs(loop[i] - loop[i - 1]) < 0.02,
      `第 ${i} 帧出现台阶：${loop[i - 1]} → ${loop[i]}`);
  }
  // 淡化长度不能超过素材长度的一半，否则素材会被吃掉一半。
  assert.equal(buildSeamlessLoop(template, template.length).length, Math.floor(template.length / 2));
  assert.equal(buildSeamlessLoop(null, 8), null);
  assert.equal(buildSeamlessLoop(new Float32Array(0), 8), null);
});

test("T4 toneSampleAt：按帧位置取样，超出长度自动循环，小数位置线性插值", () => {
  const loop = Float32Array.from([0, 1, 2, 3]);
  assert.equal(toneSampleAt(loop, 0), 0);
  assert.equal(toneSampleAt(loop, 1), 1);
  assert.equal(toneSampleAt(loop, 4), 0, "整数长度应当回到开头");
  assert.equal(toneSampleAt(loop, -1), 3, "负位置按取模处理");
  assert.equal(toneSampleAt(loop, 0.5), 0.5, "小数位置应当线性插值");
  assert.equal(toneSampleAt(null, 3), 0, "没有模板就返回静音，不抛错");
});

test("T5 equalPowerGains：全程恒定功率，两端严格互补", () => {
  const length = 64;
  for (let position = 0; position <= length; position++) {
    const { a, b } = equalPowerGains(position, length);
    assert.ok(Math.abs(a * a + b * b - 1) < 1e-12, `第 ${position} 帧功率不是 1：${a * a + b * b}`);
  }
  const first = equalPowerGains(0, length);
  const last = equalPowerGains(length, length);
  assert.ok(Math.abs(first.a - 1) < 1e-12 && Math.abs(first.b) < 1e-12);
  assert.ok(Math.abs(last.a) < 1e-12 && Math.abs(last.b - 1) < 1e-12);
  // 越界位置被夹住，不外推。
  assert.deepEqual(equalPowerGains(-5, length), first);
  assert.deepEqual(equalPowerGains(length * 3, length), last);
  // 长度为 0 时退化成"只有 A"，不做除零。
  assert.deepEqual(equalPowerGains(0, 0), { a: 1, b: 0 });
});

test("T6 evaluateToneCandidate：三道闸门缺一不可", () => {
  const base = { candidateRms: 0.01, candidatePeak: 0.04, loudestRms: 0.5 };
  // 1) 不是数字静音
  const silent = evaluateToneCandidate({ ...base, candidateRms: 1e-6 });
  assert.equal(silent.usable, false);
  assert.equal(silent.reason, "digital-silence");
  // 2) 相对整轨最响的一块足够安静（0.5 → 0.01 是 34 dB）
  const ok = evaluateToneCandidate(base);
  assert.equal(ok.usable, true);
  assert.equal(ok.reason, "ok");
  assert.ok(ok.dropDb > 30);
  // 不够安静：只低 6 dB
  const loud = evaluateToneCandidate({ ...base, loudestRms: 0.02 });
  assert.equal(loud.usable, false);
  assert.equal(loud.reason, "not-quiet-enough");
  // 3) 噪声样：波峰因数过高说明这是一段带呼吸的低语音，不是底噪
  const speech = evaluateToneCandidate({ ...base, candidatePeak: 0.5 });
  assert.equal(speech.usable, false);
  assert.equal(speech.reason, "not-noise-like");
  // requireDrop 关掉之后，只剩"不是数字静音 + 噪声样"两道闸门
  const relaxed = evaluateToneCandidate({ ...base, loudestRms: 0.02, requireDrop: false });
  assert.equal(relaxed.usable, true);
  // 空候选直接判不可用。
  assert.equal(evaluateToneCandidate({}).usable, false);
  assert.equal(evaluateToneCandidate({ candidateRms: 0 }).usable, false);
});

test("T7 planCrossfadeRegions：只在真有补白的那一端给窗口，且窗口不重叠", () => {
  // 头补白：内容从 96 开始，输出到 512 结束 → 头部有窗口，尾部没有。
  const head = planCrossfadeRegions({ contentStart: 96, contentEnd: 512, outputSamples: 512, crossfadeSamples: 32 });
  assert.ok(head.head);
  assert.deepEqual([head.head.start, head.head.end], [96, 128]);
  assert.equal(head.tail, null, "尾部没有补白就不该有尾部窗口");
  // 头补白 + 尾补白：两端都有窗口
  const both = planCrossfadeRegions({ contentStart: 96, contentEnd: 400, outputSamples: 512, crossfadeSamples: 32 });
  assert.deepEqual([both.head.start, both.head.end], [96, 128]);
  assert.deepEqual([both.tail.start, both.tail.end], [368, 400]);
  // 完全没有补白：两个窗口都没有
  const none = planCrossfadeRegions({ contentStart: 0, contentEnd: 512, outputSamples: 512, crossfadeSamples: 32 });
  assert.equal(none.head, null);
  assert.equal(none.tail, null);
  // 内容比两个窗口还短：窗口按内容长度的一半收窄，绝不重叠
  const short = planCrossfadeRegions({ contentStart: 10, contentEnd: 30, outputSamples: 100, crossfadeSamples: 32 });
  assert.equal(short.samples, 10);
  assert.ok(short.head.end <= short.tail.start, "两个窗口不得重叠");
  // 交叉淡化长度为 0 时不产生任何窗口
  const none2 = planCrossfadeRegions({ contentStart: 96, contentEnd: 400, outputSamples: 512, crossfadeSamples: 0 });
  assert.equal(none2.head, null);
  assert.equal(none2.tail, null);
});

test("T8 直流偏置不算房间声：没有交流成分的东西补进去只会是个台阶", () => {
  // 一段真实噪声的波峰因数有界（这里用 300 Hz 正弦近似宽带噪声的统计特征）。
  const tone = sine(480, 0.1, 300);
  const quality = evaluateToneCandidate({
    candidateRms: rmsOf(tone), candidatePeak: peakOf(tone), candidateMean: meanOf(tone), loudestRms: 1,
  });
  assert.equal(quality.usable, true);
  assert.ok(quality.dcRatio < 0.01, "正弦的直流占比应当接近 0");
  // 常数直流不是房间声：波峰因数是 1（看起来"干净"），但均值等于 RMS。
  const dc = new Float32Array(480).fill(0.1);
  const dcQuality = evaluateToneCandidate({
    candidateRms: rmsOf(dc), candidatePeak: peakOf(dc), candidateMean: meanOf(dc), loudestRms: 1,
  });
  assert.equal(dcQuality.usable, false, "直流不该被当成房间声");
  assert.equal(dcQuality.reason, "dc-offset");
  // 直流偏置很小的噪声仍然可用：轻微偏置不构成拒绝理由。
  const slightlyOff = Float32Array.from(tone, value => value + 0.01);
  const okQuality = evaluateToneCandidate({
    candidateRms: rmsOf(slightlyOff), candidatePeak: peakOf(slightlyOff), candidateMean: meanOf(slightlyOff), loudestRms: 1,
  });
  assert.equal(okQuality.usable, true);
});

test("T9 默认参数不会悄悄把默认行为改掉", () => {
  assert.equal(ROOM_TONE_DEFAULTS.crossfadeSeconds, 0.02);
  assert.ok(ROOM_TONE_DEFAULTS.toneSeconds >= ROOM_TONE_DEFAULTS.minToneSeconds);
  assert.ok(ROOM_TONE_DEFAULTS.loopCrossfadeSeconds > 0);
  assert.ok(ROOM_TONE_DEFAULTS.silenceFloor > 0, "静音地板必须是正数，否则整条轨都能当房间声");
});
