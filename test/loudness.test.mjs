// ITU-R BS.1770-4 响度测量（src/loudness.js）
//
// 这里的锚点不是"我算出来是多少"，而是标准给的数：
// EBU Tech 3341 的测试集里，1 kHz 正弦在双声道各 −23 dBFS 峰值时的
// 积分响度是 −23.0 LUFS。这个值同时钉住了四件事——K 加权系数、−0.691 的常数、
// 门控积分的流程、以及通道权重的加法。单通道时同样的信号是 −26.0 LUFS。
//
// EBU 的测试集文件本身不重新分发，这里用等价的合成信号复现同一条件。

import test from "node:test";
import assert from "node:assert/strict";

import {
  BEXT_LOUDNESS_ABSENT,
  BEXT_LOUDNESS_OFFSETS,
  LOUDNESS_STANDARD_RATE,
  axmlLoudnessText,
  createChannelLoudnessMeter,
  createLoudnessMeter,
  gatedIntegratedLoudness,
  kWeightingCoefficients,
  loudnessRange,
  loudnessSupportedRate,
  loudnessToBextFields,
} from "../src/loudness.js";

const SR = LOUDNESS_STANDARD_RATE;
const TOLERANCE = 0.1;

/** 峰值 −23 dBFS 的 1 kHz 正弦。 */
const AMPLITUDE_23_DBFS = Math.pow(10, -23 / 20);

function sine(frames, amplitude, frequencyHz, sampleRate = SR) {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = amplitude * Math.sin(2 * Math.PI * frequencyHz * i / sampleRate);
  return out;
}

/** 双二阶在指定频率上的幅度响应（dB），直接由系数算出，不借模块里的实现。 */
function biquadMagnitudeDb(coefficients, frequencyHz, sampleRate = SR) {
  const w = 2 * Math.PI * frequencyHz / sampleRate;
  const c = Math.cos(w);
  const s = Math.sin(w);
  const { b, a } = coefficients;
  const nr = (b[0] + b[1] * c + b[2] * (2 * c * c - 1)) ** 2 + (b[1] * s + b[2] * (2 * s * c)) ** 2;
  const dr = (1 + a[1] * c + a[2] * (2 * c * c - 1)) ** 2 + (a[1] * s + a[2] * (2 * s * c)) ** 2;
  return 10 * Math.log10(nr / dr);
}

test("L1 K 加权系数逐字等于 BS.1770-4 公布值，且 1 kHz 处增益自洽", () => {
  const coefficients = kWeightingCoefficients(SR);
  assert.ok(coefficients);
  assert.deepEqual(coefficients.shelf.b, [1.53512485958697, -2.69169618940638, 1.19839281085285]);
  assert.deepEqual(coefficients.shelf.a, [1, -1.69065929318241, 0.73248077421585]);
  assert.deepEqual(coefficients.hpf.b, [1, -2, 1]);
  assert.deepEqual(coefficients.hpf.a, [1, -1.99004745483398, 0.99007225036621]);
  // 1 kHz 处的总增益：标准里的 −0.691 常数就是冲它去的。
  const gain = biquadMagnitudeDb(coefficients.shelf, 1000) + biquadMagnitudeDb(coefficients.hpf, 1000);
  assert.ok(Math.abs(gain - 0.6977) < 0.001, `1 kHz 处增益应当是 +0.6977 dB，实测 ${gain}`);
  // 低频被 RLB 高通压下去，高频被预滤波架起来。
  assert.ok(biquadMagnitudeDb(coefficients.shelf, 10) + biquadMagnitudeDb(coefficients.hpf, 10) < -20);
  assert.ok(biquadMagnitudeDb(coefficients.shelf, 10000) + biquadMagnitudeDb(coefficients.hpf, 10000) > 3);
});

test("L2 EBU 参考值：双声道各 −23 dBFS 的 1 kHz 正弦 = −23.0 LUFS", () => {
  const frames = SR * 5;
  const signal = sine(frames, AMPLITUDE_23_DBFS, 1000);
  const meter = createLoudnessMeter({ sampleRate: SR, channels: 2 });
  for (let i = 0; i < frames; i++) meter.pushFrame([signal[i], signal[i]]);
  const result = meter.finish();
  assert.equal(result.supported, true);
  assert.ok(Math.abs(result.combined - -23) < TOLERANCE, `合并积分响度应当是 −23.0 LUFS，实测 ${result.combined}`);
  // 单通道同样的信号是 −26.0 LUFS（少一个通道的能量）。
  const single = result.channels[0];
  assert.ok(Math.abs(single.integrated - -26) < TOLERANCE, `单通道应当是 −26.0 LUFS，实测 ${single.integrated}`);
  // 瞬时与短时的最大值都应当贴近积分值（恒定信号）。
  assert.ok(Math.abs(single.maxMomentary - -26) < TOLERANCE);
  assert.ok(Math.abs(single.maxShortTerm - -26) < TOLERANCE);
});

test("L3 门控：低于相对门限的安静段不参与积分", () => {
  const frames = SR * 8;
  const loud = sine(frames, AMPLITUDE_23_DBFS, 1000);
  // 后半段降到 −60 dBFS：高于绝对门限（−70），但低于相对门限，应当被排除。
  const quietScale = Math.pow(10, -60 / 20) / AMPLITUDE_23_DBFS;
  const meter = createChannelLoudnessMeter({ sampleRate: SR });
  for (let i = 0; i < frames; i++) {
    const scale = i < frames / 2 ? 1 : quietScale;
    meter.push(loud[i] * scale);
  }
  const result = meter.finish();
  // 前半段的单通道值是 −26 LUFS；若安静段被算进去，结果会明显偏低。
  assert.ok(Math.abs(result.integrated - -26) < 0.5,
    `安静段应当被相对门限排除，积分应当贴近 −26 LUFS，实测 ${result.integrated}`);
});

test("L4 真峰值能抓到采样点之间的峰", () => {
  const frames = SR * 2;
  // 采样率是频率的 3 倍：采样点落在 0°/120°/240°，最大采样值只有 0.866 倍，
  // 真正的峰落在两个采样之间——这正是采样峰值会漏掉的那一类。
  const frequency = SR / 3;
  const amplitude = 0.5;
  const signal = sine(frames, amplitude, frequency);
  const meter = createChannelLoudnessMeter({ sampleRate: SR });
  for (const value of signal) meter.push(value);
  const result = meter.finish();
  let samplePeak = 0;
  for (const value of signal) samplePeak = Math.max(samplePeak, Math.abs(value));
  const samplePeakDb = 20 * Math.log10(samplePeak);
  const truePeakDb = result.truePeak;
  assert.ok(truePeakDb > samplePeakDb + 1.0,
    `真峰值应当明显高于采样峰值：${truePeakDb} vs ${samplePeakDb}`);
  // 真峰值应当精确等于信号的实际幅度（0.5 → −6.02 dBFS）。
  assert.ok(Math.abs(truePeakDb - 20 * Math.log10(amplitude)) < 0.1,
    `真峰值应当贴近 ${20 * Math.log10(amplitude)} dBFS，实测 ${truePeakDb}`);
});

test("L4b 真峰值在 1 kHz–20 kHz 上都精确，不随频率漂移", () => {
  const amplitude = 0.5;
  const expected = 20 * Math.log10(amplitude);
  for (const frequency of [1000, 8000, 12000, 16000, 18000, 20000]) {
    const meter = createChannelLoudnessMeter({ sampleRate: SR });
    for (let n = 0; n < SR; n++) meter.push(amplitude * Math.sin(2 * Math.PI * frequency * n / SR));
    const result = meter.finish();
    assert.ok(Math.abs(result.truePeak - expected) < 0.05,
      `${frequency} Hz 的真峰值应当是 ${expected} dBFS，实测 ${result.truePeak}`);
  }
});

test("L5 非 48 kHz 如实报告量不了，不给一个看着像标准的数", () => {
  assert.equal(loudnessSupportedRate(48000), true);
  assert.equal(loudnessSupportedRate(44100), false);
  assert.equal(loudnessSupportedRate(96000), false);
  assert.equal(kWeightingCoefficients(44100), null);
  const meter = createChannelLoudnessMeter({ sampleRate: 44100 });
  meter.push(0.5);
  const result = meter.finish();
  assert.equal(result.supported, false);
  assert.match(result.reason, /48/);
  // 写进 bext 的就是"没测"的约定值。
  const fields = loudnessToBextFields(result);
  assert.equal(fields.loudnessValue, BEXT_LOUDNESS_ABSENT);
});

test("L6 静音量不出响度，不报一个假的数", () => {
  const meter = createChannelLoudnessMeter({ sampleRate: SR });
  for (let i = 0; i < SR * 2; i++) meter.push(0);
  const result = meter.finish();
  assert.equal(result.integrated, null);
  assert.equal(result.truePeak, null);
  const fields = loudnessToBextFields(result);
  assert.equal(fields.loudnessValue, BEXT_LOUDNESS_ABSENT);
});

test("L7 bext version 2 的字段：偏移与单位", () => {
  const measurement = {
    supported: true,
    integrated: -23.4,
    range: 5.2,
    truePeak: -1.3,
    maxMomentary: -20.1,
    maxShortTerm: -18.7,
  };
  const fields = loudnessToBextFields(measurement);
  assert.equal(fields.loudnessValue, -2340);
  assert.equal(fields.loudnessRange, 520);
  assert.equal(fields.maxTruePeakLevel, -130);
  assert.equal(fields.maxMomentaryLoudness, -2010);
  assert.equal(fields.maxShortTermLoudness, -1870);
  // 偏移必须是 EBU Tech 3285 的那五个，且落在 602 字节固定区之内。
  assert.deepEqual(Object.values(BEXT_LOUDNESS_OFFSETS), [412, 414, 416, 418, 420]);
  assert.ok(Math.max(...Object.values(BEXT_LOUDNESS_OFFSETS)) + 2 <= 602);
});

test("L8 axml 里的响度字段按 EBU Tech 3306 的结构写", () => {
  const text = axmlLoudnessText({
    supported: true, integrated: -23.4, truePeak: -1.3, maxMomentary: -20.1, maxShortTerm: -18.7, range: 5.2,
  });
  assert.match(text, /<ebu_loudness_information>/);
  assert.match(text, /<integrated_loudness>-23\.4<\/integrated_loudness>/);
  assert.match(text, /<max_truepeak_level>-1\.3<\/max_truepeak_level>/);
  assert.match(text, /<loudness_range>5\.2<\/loudness_range>/);
  // 没测出来的字段留空，而不是写 0（0 会被读成"0 LUFS"，那是错的）。
  const empty = axmlLoudnessText({ supported: false });
  assert.match(empty, /<integrated_loudness><\/integrated_loudness>/);
});

test("L9 门控积分与 LRA 的边界行为", () => {
  // 全是低于绝对门限的块：量不出来。
  assert.equal(gatedIntegratedLoudness([1e-12, 1e-13]), null);
  assert.equal(gatedIntegratedLoudness([]), null);
  // 只有一个块时也算得出来。
  const single = gatedIntegratedLoudness([0.01]);
  assert.ok(Math.abs(single - (-0.691 + 10 * Math.log10(0.01))) < 1e-9);
  // LRA：数据点不足时返回 null。
  assert.equal(loudnessRange([]), null);
  assert.equal(loudnessRange([-30]), null);
  // LRA：两个相差 10 LU 的水平应当量出 10 LU。
  const values = [];
  for (let i = 0; i < 50; i++) values.push(-30);
  for (let i = 0; i < 50; i++) values.push(-20);
  const range = loudnessRange(values);
  assert.ok(Math.abs(range - 10) < 0.5, `LRA 应当是 10 LU，实测 ${range}`);
});
