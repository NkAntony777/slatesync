// 波形同步（src/waveform-sync.js）
//
// 这里造的是真实场景的合成版：ISO 与摄影机原始声是**同一现场的不同麦克风**——
// 波形细节不同（麦位、频响、摄影机侧还过了压缩），只有能量包络是共通的。
// 所以测试用的目标信号是"参考经过另一支麦 + 时移 + 加噪"，而不是原样复制。

import test from "node:test";
import assert from "node:assert/strict";

import { computeEnvelope, matchWaveform, planFromWaveformMatch } from "../src/waveform-sync.js";

const SR = 48000;

/** 32 位整数运算的伪随机数：低 8 位不能用（乘积超出双精度会被抹平，序列会有周期结构）。 */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 类语音：成串的滤波噪声，中间有静音。包络有明确的"谁在什么时候说话"结构。 */
function speechLike(frames, seed = 7) {
  const random = mulberry32(seed);
  const out = new Float32Array(frames);
  let position = 0;
  while (position < frames) {
    const burst = Math.round(SR * (0.15 + random() * 0.45));
    const gap = Math.round(SR * (0.05 + random() * 0.25));
    const level = 0.2 + random() * 0.6;
    for (let i = 0; i < burst && position < frames; i++, position++) {
      // 一阶低通的噪声，模拟语音的频谱形状
      const white = random() * 2 - 1;
      out[position] = white * level;
    }
    position += gap;
  }
  return out;
}

/** 另一支麦：一阶低通 + 一点点高通，频谱与参考明显不同。 */
function differentMic(signal, { lowpass = 0.25, highpass = 0.02 } = {}) {
  const out = new Float32Array(signal.length);
  let low = 0;
  let high = 0;
  for (let i = 0; i < signal.length; i++) {
    low += lowpass * (signal[i] - low);
    high += highpass * (low - high);
    out[i] = high;
  }
  return out;
}

/** 把信号往后挪 shift 个采样（目标的内容因此在文件里出现在后面）。 */
function shiftLater(signal, shift) {
  const out = new Float32Array(signal.length);
  out.set(signal.subarray(0, Math.max(0, signal.length - shift)), shift);
  return out;
}

test("S1 包络：长度、跳步与静音段的处理", () => {
  const samples = new Float32Array(SR);
  samples.fill(0.5, 0, SR / 2);
  const envelope = computeEnvelope(samples, { sampleRate: SR, hopMs: 20, windowMs: 40 });
  assert.equal(envelope.length, Math.floor((SR - 1920) / 960) + 1);
  // 前半段是恒定 0.5：包络也该是 0.5。
  assert.ok(Math.abs(envelope[0] - 0.5) < 1e-6, `恒定段的包络应当是 0.5，实测 ${envelope[0]}`);
  // 后半段是静音：包络是 0。
  assert.equal(envelope[envelope.length - 1], 0, "静音段的包络应当是 0");
  assert.equal(computeEnvelope(new Float32Array(0)).length, 0);
});

test("S2a 无麦克风差异时精度到采样级：算法本身是准的", () => {
  const reference = speechLike(SR * 12, 11);
  const shift = 3711;   // 约 77 ms
  const target = shiftLater(reference, shift);
  const result = matchWaveform(reference, target, { sampleRate: SR });
  assert.ok(result, "应当匹得出偏移");
  // offsetSamples 的约定：正数 = target 的内容在文件里出现在后面。
  assert.ok(Math.abs(result.offsetSamples - shift) < 8,
    `应当精确找回 ${shift} 采样，实测 ${result.offsetSamples}（差 ${result.offsetSamples - shift}）`);
  assert.equal(result.ratio, 1);
  assert.equal(result.polarity, 1);
  assert.ok(result.confidence.segments >= 3, "应当用了多个片段");
  assert.ok(result.confidence.agreement >= 0.55, `段一致率应当够：${result.confidence.agreement}`);
});

test("S2b 另一支麦 + 底噪：误差在一帧之内，可用", () => {
  const reference = speechLike(SR * 12, 11);
  const shift = 3711;
  const target = shiftLater(differentMic(reference, { lowpass: 0.3 }), shift);
  const random = mulberry32(99);
  for (let i = 0; i < target.length; i++) target[i] += (random() * 2 - 1) * 0.002;

  const result = matchWaveform(reference, target, { sampleRate: SR });
  assert.ok(result, "应当匹得出偏移");
  // 另一支麦的低通会带来几毫秒的群延迟，包络法补偿不了它。
  // 一帧（25 fps 下 20 ms = 960 采样）是这类方法在本场景下的合理精度要求。
  assert.ok(Math.abs(result.offsetSamples - shift) < SR * 0.02,
    `应当落在一帧内（${SR * 0.02} 采样），实测 ${result.offsetSamples}（差 ${result.offsetSamples - shift}）`);
  assert.ok(result.confidence.agreement >= 0.55, `段一致率应当够：${result.confidence.agreement}`);
});

test("S3 波形匹配：方向相反时偏移也是负的", () => {
  const reference = speechLike(SR * 12, 23);
  const shift = -5233;   // 目标的内容在文件里出现得更早
  const shifted = new Float32Array(reference.length);
  shifted.set(reference.subarray(-shift), 0);
  const target = differentMic(shifted, { lowpass: 0.28 });
  const result = matchWaveform(reference, target, { sampleRate: SR });
  assert.ok(result);
  assert.ok(Math.abs(result.offsetSamples - shift) < SR * 0.002,
    `应当找回 ${shift} 采样，实测 ${result.offsetSamples}`);
});

test("S4 匹不准就不给结果：无关素材不硬凑一个偏移", () => {
  const reference = speechLike(SR * 10, 31);
  const random = mulberry32(41);
  const noise = new Float32Array(SR * 10);
  for (let i = 0; i < noise.length; i++) noise[i] = (random() * 2 - 1) * 0.3;
  assert.equal(matchWaveform(reference, noise, { sampleRate: SR }), null,
    "无关素材应当返回 null，而不是硬凑一个偏移");
});

test("S5 重复内容会让置信度掉下来，而不是给出高置信的错误结果", () => {
  // 同一段内容反复出现：任何位置都"对得上"，真正的不确定来自内容本身而不是算法。
  const chunk = speechLike(SR * 2, 53);
  const repeated = new Float32Array(chunk.length * 4);
  for (let i = 0; i < 4; i++) repeated.set(chunk, i * chunk.length);
  const target = differentMic(repeated, { lowpass: 0.3 });
  const result = matchWaveform(chunk, target, { sampleRate: SR });
  if (result) {
    assert.ok(result.confidence.level !== "high",
      `重复内容不该给出高置信度：${JSON.stringify(result.confidence)}`);
  }
});

test("S5b 波形测量能直接转成修复计划：与 LTC 路径共用同一套下游", () => {
  const reference = speechLike(SR * 12, 11);
  const shift = 3711;
  const target = shiftLater(differentMic(reference, { lowpass: 0.3 }), shift);
  const match = matchWaveform(reference, target, { sampleRate: SR });
  assert.ok(match);
  const plan = planFromWaveformMatch(match, reference.length, target.length);
  assert.ok(plan, "应当转得出修复计划");
  assert.ok(Math.abs(plan.leadSamples + shift) < SR * 0.02, "leadSamples=" + plan.leadSamples);
  assert.equal(plan.driftRatio, 1);
  assert.equal(plan.polarity, 1);
  assert.ok(plan.padSamples > 0, "目标比参考晚开机，应当要补白");
  assert.ok(plan.confidence, "置信度要跟着计划一起走");
  assert.ok(plan.confidence.segments >= 3);
  assert.equal(planFromWaveformMatch(null, reference.length, target.length), null, "匹不上就没有计划");
});

test("S6 素材太短或为空时返回 null，不抛错", () => {
  assert.equal(matchWaveform(new Float32Array(0), new Float32Array(SR)), null);
  assert.equal(matchWaveform(new Float32Array(SR), new Float32Array(0)), null);
  assert.equal(matchWaveform(new Float32Array(100), new Float32Array(100)), null);
  assert.doesNotThrow(() => matchWaveform(new Float32Array(1000), new Float32Array(1000), { sampleRate: SR }));
});
